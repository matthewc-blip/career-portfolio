"""Small Claude client for the outreach writer. Standard library only (no pip install needed).

Reads ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL) from the environment, 
The system prompt is sent with cache_control, so when the same sender profile is reused across a batch the repeated part is billed at the cheap
cached rate (Claude only caches prompts above a minimum length, so short prompts simply bill normally).
"""
import json
import os
import time
import urllib.error
import urllib.request

DEFAULT_MODEL = "claude-haiku-4-5"
# Dollars per million tokens: (input, output). Illustrative defaults only: prices change, so override them with the OUTREACH_PRICES env var
# (a JSON object such as {"haiku": [1.0, 5.0]}). Unknown models are billed at the highest listed rate so the spend cap errs on the high side.
PRICES = {"demo": (0.0, 0.0), "haiku": (1.0, 5.0), "sonnet": (3.0, 15.0), "opus": (15.0, 75.0)}
LONG_PROMPT = {}
if os.environ.get("OUTREACH_PRICES"):
    try:
        PRICES.update({k: tuple(v) for k, v in json.loads(os.environ["OUTREACH_PRICES"]).items()})
    except (ValueError, TypeError):
        pass


class ClaudeError(Exception):
    def __init__(self, message, retry=False, fatal=False):
        super().__init__(message)
        self.retry = retry
        self.fatal = fatal  # a bad key or a blocked account: do not keep trying for the rest of the batch


def price_for(model):
    m = (model or "").lower()
    for k, v in PRICES.items():
        if k in m:
            return v
    return max(PRICES.values())


def cost_cents(model, usage):
    """Cost in cents of one call. Cached reads cost 10% of input, cache writes 125%."""
    pin, pout = price_for(model)
    prompt = usage.get("in", 0) + usage.get("cache_read", 0) + usage.get("cache_write", 0)
    for k, v in LONG_PROMPT.items():
        if k in (model or "").lower() and prompt > 100_000:
            pin, pout = v
    fresh = usage.get("in", 0)
    dollars = (fresh * pin + usage.get("cache_write", 0) * pin * 1.25 + usage.get("cache_read", 0) * pin * 0.1 + usage.get("out", 0) * pout) / 1_000_000
    return dollars * 100 + usage.get("searches", 0) * 1.0  # web search tool: $10 per 1,000 searches = 1 cent each


def extract_json(text):
    t = (text or "").strip()
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        raise ClaudeError("Claude did not return JSON.", retry=True)
    try:
        return json.loads(t[a:b + 1])
    except ValueError:
        raise ClaudeError("Claude returned JSON that could not be read.", retry=True)


class Claude:
    def __init__(self, model=None, api_key=None, base_url=None, timeout=60):
        self.model = model or os.environ.get("OUTREACH_MODEL") or DEFAULT_MODEL
        self.key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.base = (base_url or os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com").rstrip("/")
        self.timeout = timeout

    def configured(self):
        return bool(self.key)

    def _once(self, system, messages, max_tokens, tools=None):
        body = {"model": self.model, "max_tokens": max_tokens, "temperature": 0.7,
                "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}], "messages": messages}
        if tools:
            body["tools"] = tools
        req = urllib.request.Request(self.base + "/v1/messages", data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json", "x-api-key": self.key, "anthropic-version": "2023-06-01"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")[:400]
            if e.code in (401, 403):
                raise ClaudeError("Claude rejected the API key. Check ANTHROPIC_API_KEY.", fatal=True)
            if e.code == 429 or e.code >= 500:
                wait = e.headers.get("retry-after") if e.headers else None
                err = ClaudeError("Claude is busy or unavailable (%d)." % e.code, retry=True)
                err.wait = float(wait) if wait and wait.replace(".", "", 1).isdigit() else 0
                raise err
            raise ClaudeError("Claude could not take that request (%d): %s" % (e.code, raw))
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ClaudeError("Could not reach Claude: %s" % e, retry=True)
        text = "".join(c.get("text", "") for c in j.get("content", []) if c.get("type") == "text")
        u = j.get("usage", {}) or {}
        usage = {"in": u.get("input_tokens", 0), "out": u.get("output_tokens", 0),
                 "cache_read": u.get("cache_read_input_tokens", 0), "cache_write": u.get("cache_creation_input_tokens", 0),
                 "searches": ((u.get("server_tool_use") or {}).get("web_search_requests") or 0)}
        return text, usage

    def ask(self, system, messages, max_tokens=700, tools=None):
        """Returns (text, usage). Retries busy/rate-limited answers a couple of times."""
        for i in range(3):
            try:
                return self._once(system, messages, max_tokens, tools)
            except ClaudeError as e:
                if not e.retry or i == 2:
                    raise
                time.sleep(min(8.0, getattr(e, "wait", 0) or 1.5 * (i + 1)))
