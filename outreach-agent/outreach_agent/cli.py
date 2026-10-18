"""Command line: `python -m outreach_agent demo` runs everything offline on the bundled examples.

  python -m outreach_agent demo                              (no API key, no network)
  python -m outreach_agent plan --in input.json --out out.json [--demo]
  python -m outreach_agent rewrite --in input.json --out out.json

`plan` input: {"profile": {...}, "contacts": [...], "replies": [...], "cfg": {"budget_cents": 100, "wait_days": [4, 7], "model": "..."}}.
"""
import argparse
import json
import os
import sys

from . import lanes, pipeline
from .client import Claude, ClaudeError
from .demo_client import DemoClaude

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "examples")


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def run(command, data, use_demo=False):
    claude = DemoClaude() if use_demo else Claude()
    if not use_demo and not claude.configured():
        return {"fatal": "ANTHROPIC_API_KEY is not set (use --demo to run offline).", "drafts": [], "classified": [], "skipped": [], "waiting": [], "errors": [], "usage": {"cents": 0}}
    if (data.get("cfg") or {}).get("model") and not use_demo:
        claude.model = data["cfg"]["model"]
    try:
        return pipeline.plan(data, claude) if command == "plan" else pipeline.rewrite(data, claude)
    except ClaudeError as e:
        return {"fatal": str(e), "drafts": [], "classified": [], "skipped": [], "waiting": [], "errors": [], "usage": {"cents": 0}}


def show(res):
    for d in res.get("drafts", []):
        print("\n--- %s (contact %s) | %s | %s" % (d["kind"].upper(), d["contact_id"], d.get("offer", ""), d.get("angle") or "-"))
        if d.get("subject"):
            print("Subject:", d["subject"])
        print(d["body"])
        print("Why:", d.get("reason", ""))
    for w in res.get("waiting", []):
        print("\n[no email] contact %s: %s" % (w["contact_id"], w["why"]))
    for s in res.get("skipped", []):
        print("\n[skipped] contact %s: %s" % (s["contact_id"], s["reason"]))
    for c in res.get("classified", []):
        print("\n[reply read] %s: %s -> %s" % (c["label"], c["summary"], c["status"]))
    print("\nSpend: %.4f cents (model %s). Every draft above waits for a human to approve it." % (res.get("usage", {}).get("cents", 0), res.get("usage", {}).get("model", "")))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="outreach_agent", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["demo", "plan", "rewrite"])
    ap.add_argument("--in", dest="inp")
    ap.add_argument("--out")
    ap.add_argument("--lanes", help="path to a lanes JSON file (default: examples/lanes.json)")
    ap.add_argument("--demo", action="store_true", help="use the offline stand-in instead of the Claude API")
    a = ap.parse_args(argv)
    lanes.load(a.lanes)
    if a.command == "demo":
        data = {"now": "2026-10-15T15:00:00Z", "profile": _load(os.path.join(HERE, "profile.json")), "contacts": _load(os.path.join(HERE, "contacts.json")),
                "replies": [{"id": 1, "contact": {"id": 5, "email": "pat@x.example", "first_name": "Pat", "company": "Bluewave Dental", "category": "dentist", "status": "replied", "step": 1,
                             "history": [{"dir": "out", "at": "2026-10-10T14:00:00Z", "subject": "Books for Bluewave Dental", "body": "Hi Pat, short note about monthly bookkeeping. Jordan"}]},
                             "text": "Yes, tell me more and what would the price be? Can we call tomorrow?", "at": "2026-10-15T12:00:00Z", "subject": "Re: Books for Bluewave Dental"}],
                "cfg": {"budget_cents": 50, "wait_days": [4, 7]}}
        show(run("plan", data, use_demo=True))
        return 0
    if not a.inp or not a.out:
        ap.error("--in and --out are required")
    res = run(a.command, _load(a.inp), a.demo)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2)
    return 0
