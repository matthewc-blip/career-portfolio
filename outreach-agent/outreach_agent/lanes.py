"""What each kind of business is offered ("lanes"). The owner decides who gets which service; Claude writes the words but cannot choose a
different service for a lane, and an email that breaks the lane's rules is rejected before a human ever sees it.

Lanes live in a JSON file (see examples/lanes.json), so the rules are data, not code:

  {"lanes": {"<key>": {"label": ..., "categories": [...], "first": ..., "later": ..., "must": [regex], "ban": regex, "ban_say": ...,
                       "angles": {tag: description}, "advisory": {"pattern": regex, "ask": ...}}},
   "default": "<key>"}

`must` patterns have to appear in a first email, `ban` must not appear in any email. A lane with an "advisory" block makes Claude decide, per
business, whether to add one optional upsell sentence, and the validator then checks the email matches that decision.
"""
import json
import os
import re

_EXAMPLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "examples", "lanes.json")
RULES = {}
CATEGORY = {}
DEFAULT = ""


def load(path=None):
    """Load lanes from a JSON file (defaults to $OUTREACH_LANES, then the bundled example)."""
    global RULES, CATEGORY, DEFAULT
    with open(path or os.environ.get("OUTREACH_LANES") or _EXAMPLE, encoding="utf-8") as f:
        data = json.load(f)
    RULES = {k: dict(v, key=k) for k, v in data["lanes"].items()}
    CATEGORY = {c.lower(): k for k, v in RULES.items() for c in v.get("categories", [])}
    DEFAULT = data.get("default") or next(iter(RULES))
    if DEFAULT not in RULES:
        raise ValueError("default lane %r is not defined" % DEFAULT)
    return RULES


def rule_for(category):
    if not RULES:
        load()
    return RULES[CATEGORY.get((category or "").lower(), DEFAULT)]


def rule_key(category):
    return rule_for(category)["key"]


def needs_advisory_decision(category, kind):
    return bool(rule_for(category).get("advisory")) and kind in ("first", "followup")


def instruction(category, kind):
    r = rule_for(category)
    if kind == "reply":
        return "OFFER RULE: answer only what they asked, using the service notes. Do not add services they did not ask about."
    return "OFFER RULE (fixed by the owner, overrides your own choice of service): " + (r["first"] if kind == "first" else r["later"])


def check(category, kind, body, pitch=None):
    """Returns an error message Claude can act on, or ''."""
    r = rule_for(category)
    if r.get("ban") and re.search(r["ban"], body, re.I):
        return r["ban_say"]
    adv = r.get("advisory")
    if adv:
        mentions = bool(re.search(adv["pattern"], body, re.I))
        if pitch is True and kind == "first" and not mentions:
            return "pitch_advisory is true, so add one short sentence: %s" % adv["ask"]
        if pitch is False and mentions:
            return "pitch_advisory is false, so remove every mention of the advisory service."
    if kind == "first":
        for pat in r.get("must", []):
            if not re.search(pat, body, re.I):
                return "The first email must offer: %s. Mention each one." % r["label"].lower()
    return ""


def label(category, pitch=None):
    r = rule_for(category)
    if pitch and r.get("advisory"):
        return r["advisory"].get("label") or r["label"]
    return r["label"]


def angles(category):
    return rule_for(category)["angles"]


def angle_prompt(category):
    return "ANGLE: set \"angle\" to exactly one of these tags, the one idea this email mainly leans on: " + "; ".join("%s (%s)" % (k, v) for k, v in angles(category).items()) + "."
