"""Plan and rewrite pipeline: decides who needs an email, has Claude write it, and reads replies.

Pure functions over plain dicts. They never send mail and never touch a database: the caller supplies contacts (with their email history) and
stores the drafts that come back, so the same code works behind a web app, a cron job or the demo CLI.
"""
import argparse
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from . import triggers, writer
from .client import Claude, ClaudeError, cost_cents
from .site_reader import read_site


class Spend:
    def __init__(self, budget_cents):
        self.budget, self.cents, self.usage, self.lock = float(budget_cents), 0.0, {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0}, threading.Lock()
        self.fatal = None

    def add(self, model, used):
        c = 0.0
        with self.lock:
            for u in used:
                c += cost_cents(model, u)
                for k in self.usage:
                    self.usage[k] += u.get(k, 0)
            self.cents += c
        return c

    def over(self):
        with self.lock:
            return self.cents >= self.budget or self.fatal is not None


def _now(inp):
    t = triggers.parse_time(inp.get("now"))
    return t or datetime.now(timezone.utc)


def plan(inp, claude):
    profile, cfg = inp.get("profile") or {}, inp.get("cfg") or {}
    now, waits = _now(inp), cfg.get("wait_days")
    spend = Spend(cfg.get("budget_cents", 100))
    out = {"drafts": [], "skipped": [], "classified": [], "waiting": [], "errors": [], "budget_hit": False}
    lock = threading.Lock()

    def note_error(who, e):
        with lock:
            out["errors"].append({"who": who, "error": str(e)[:300]})
        if getattr(e, "fatal", False):
            spend.fatal = str(e)

    def do_reply(r):
        if spend.over():
            return
        c = r["contact"]
        try:
            (res, used) = writer.classify(claude, profile, c, r.get("text", ""))
            cents = spend.add(claude.model, used)
            rule = triggers.reply_plan(res["label"])
            item = {"reply_id": r["id"], "contact_id": c["id"], "label": res["label"], "summary": res["summary"], "status": rule["status"], "suppress": bool(rule.get("suppress")), "cents": round(cents, 4)}
            with lock:
                out["classified"].append(item)
            if rule["draft"] and not spend.over():
                hist = list(c.get("history") or [])
                if not any(h.get("dir") == "in" and h.get("body") == r.get("text") for h in hist):
                    hist.append({"dir": "in", "at": r.get("at"), "subject": r.get("subject", ""), "body": r.get("text", "")})
                c2 = {**c, "history": hist}
                d, used2 = writer.write(claude, profile, c2, "reply", 0, None, waits)
                item["cents"] = round(item["cents"] + spend.add(claude.model, used2), 4)
                with lock:
                    out["drafts"].append({"contact_id": c["id"], "kind": "reply", "step": int(c.get("step") or 0), "reply_id": r["id"], "cents": round(item["cents"], 4), **d})
        except ClaudeError as e:
            note_error("reply %s" % r.get("id"), e)

    def do_contact(c):
        if spend.over():
            return
        d = triggers.decide(c, now, waits)
        act = d["action"]
        if act in ("wait", "stop"):
            with lock:
                out["waiting"].append({"contact_id": c["id"], "action": act, "why": d["why"], "until": d.get("until")})
            return
        kind = {"write_first": "first", "write_followup": "followup", "write_checkin": "checkin"}[act]
        try:
            site = None
            if kind == "first" and c.get("website"):
                site = read_site(c["website"])
            value, used = writer.write(claude, profile, c, kind, d["n"], site, waits, learning=inp.get("learning"))
            cents = spend.add(claude.model, used)
            if value.get("skip"):
                with lock:
                    out["skipped"].append({"contact_id": c["id"], "reason": value["reason"], "cents": round(cents, 4)})
                return
            with lock:
                out["drafts"].append({"contact_id": c["id"], "kind": kind, "step": int(c.get("step") or 0), "trigger": d["why"], "site": (site or {}).get("status", ""), "cents": round(cents, 4), **value})
        except ClaudeError as e:
            note_error("contact %s" % c.get("id"), e)

    with ThreadPoolExecutor(max_workers=max(1, min(6, int(cfg.get("workers", 3))))) as ex:
        list(ex.map(do_reply, inp.get("replies") or []))     # replies first: they are the warmest
        list(ex.map(do_contact, inp.get("contacts") or []))
    out["budget_hit"] = spend.cents >= spend.budget
    if spend.fatal:
        out["fatal"] = spend.fatal
    out["usage"] = {**spend.usage, "cents": round(spend.cents, 4), "model": claude.model}
    return out


def rewrite(inp, claude):
    profile, c = inp.get("profile") or {}, inp.get("contact") or {}
    spend = Spend(inp.get("budget_cents", 50))
    kind = inp.get("kind", "first")
    c = {**c, "draft_body": inp.get("body", "")}
    site = read_site(c["website"]) if kind == "first" and c.get("website") else None
    value, used = writer.write(claude, profile, c, kind, int(inp.get("n") or 0), site, (inp.get("cfg") or {}).get("wait_days"), instruction=inp.get("instruction", ""), learning=inp.get("learning"))
    spend.add(claude.model, used)
    return {"draft": {"kind": kind, **value}, "usage": {**spend.usage, "cents": round(spend.cents, 4), "model": claude.model}}
