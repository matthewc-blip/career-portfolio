"""Run: python3 -m unittest discover -s tests -v   (from the repo root). Uses a fake Claude on localhost: nothing leaves the machine."""
import json
import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from outreach_agent import cli, lanes, pipeline, site_reader, triggers, writer  # noqa: E402
from outreach_agent.client import Claude, cost_cents  # noqa: E402
from outreach_agent.demo_client import DemoClaude  # noqa: E402

lanes.load()
NOW = datetime(2026, 10, 15, 15, 0, tzinfo=timezone.utc)
PROFILE = {"sender_name": "Jordan Rivera", "business": "Harbor Ledger Co.", "service_area": "Harbor City", "tone": "friendly", "website": "harborledger.example",
           "services": "Bookkeeping: monthly books in QuickBooks Online\nAdvisory: part-time finance help\nWebsite refresh: a fast, clear small-business site", "avoid": ""}
GOOD_WEB = ("Hi Mo, I had a look at how Northside Legal shows up online. A clear, fast website with the basics of local search set up properly, like your Google "
            "profile and page titles, tends to bring in more calls from people already searching nearby. I do small website refreshes for local businesses and can "
            "show you a few quick fixes. Would a short call this week help? Jordan")
GOOD_BOOKS = ("Hi Priya, Bluewave Dental looks like a busy practice, which usually means the books get done late at night or not at all. I do monthly bookkeeping "
              "for small local businesses, usually in QuickBooks Online, and I can catch up anything behind. I can also help with part-time finance planning "
              "and cash flow reporting. Would ten minutes this week be worth it to see if it fits? Jordan")
BOOKS_SOLO = GOOD_BOOKS.replace(" I can also help with part-time finance planning and cash flow reporting.", "")
GOOD_FOLLOW = ("Hi Mo, a different thought after my last note. Most visitors browse on a phone, so a site that loads quickly and makes the next step obvious can "
               "make a real difference to your calls. Happy to send two or three specific ideas. Jordan")
GOOD_REPLY = "Hi Mo, thanks for asking. I will confirm the details and send a short summary by email, and we can set a time that suits you. Jordan"


class Fake(BaseHTTPRequestHandler):
    bodies, plan = [], {}

    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        Fake.bodies.append(req)
        first, system = req["messages"][0]["content"], req["system"][0]["text"]
        if "label it" in system:
            out = {"label": "interested" if "price" in first.lower() else "not_now", "summary": "They answered."}
        elif "rejected" in req["messages"][-1]["content"] and Fake.plan.get("fix"):
            out = Fake.plan["fix"]
        else:
            task = first.split("TASK:")[1][:60]
            base = {"skip": False, "angle": "other", "offer": "x", "facts": [], "reason": "r", "pitch_advisory": False, "advisory_reason": "Nothing shows a team."}
            if "Type (from the map listing): dentist" in first:
                out = {**base, "subject": "Books for Bluewave" if "FIRST" in task else "", "body": Fake.plan.get("books", GOOD_BOOKS), "pitch_advisory": Fake.plan.get("adv", True), "advisory_reason": "Several providers on the team."}
            elif "FIRST email" in task:
                out = Fake.plan.get("first", {**base, "subject": "A quick idea for your site", "body": GOOD_WEB})
            elif "follow-up number" in task:
                out = {**base, "subject": "", "body": GOOD_FOLLOW}
            else:
                out = {**base, "subject": "", "body": GOOD_REPLY}
        body = json.dumps({"content": [{"type": "text", "text": json.dumps(out)}], "usage": {"input_tokens": 1500, "output_tokens": 200}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)


def contact(**k):
    c = {"id": 1, "email": "mo@law.example", "first_name": "Mo", "company": "Northside Legal", "city": "Harbor City", "category": "lawyer", "website": "", "status": "new", "step": 0, "history": []}
    c.update(k)
    return c


class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        os.environ["ANTHROPIC_API_KEY"] = "test"
        os.environ["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Fake.bodies.clear(); Fake.plan = {}
        self.claude = Claude()

    def test_triggers(self):
        d = triggers.decide
        days = lambda n: (NOW - timedelta(days=n)).isoformat()
        self.assertEqual(d(contact(), NOW)["action"], "write_first")
        self.assertEqual(d(contact(status="active", step=1, last_sent_at=days(2)), NOW)["action"], "wait")
        r = d(contact(status="active", step=1, last_sent_at=days(5)), NOW)
        self.assertEqual((r["action"], r["n"]), ("write_followup", 1))
        self.assertEqual(d(contact(status="active", step=2, last_sent_at=days(6)), NOW)["action"], "wait")       # second wait is 7 days
        self.assertEqual(d(contact(status="active", step=3, last_sent_at=days(30)), NOW)["action"], "stop")      # every follow-up was sent
        for s in ("replied", "bounced", "unsubscribed", "done"):
            self.assertEqual(d(contact(status=s), NOW)["action"], "stop", s)
        self.assertEqual(d(contact(open_draft=True), NOW)["action"], "wait")                                      # one open draft at a time
        self.assertEqual(d(contact(status="active", step=1, last_sent_at=days(9), last_inbound_at=days(1)), NOW)["action"], "wait")   # never nag after a reply
        self.assertEqual(d(contact(status="snoozed", step=1, snooze_until=(NOW + timedelta(days=3)).isoformat()), NOW)["action"], "wait")
        self.assertEqual(d(contact(status="snoozed", step=1, snooze_until=days(1)), NOW)["action"], "write_checkin")
        self.assertEqual(triggers.clean_waits(["x", 0, 99, 5, 6, 7, 8, 9]), [1, 60, 5, 6])

    def test_reply_rules(self):
        self.assertTrue(triggers.reply_plan("interested")["draft"])
        self.assertTrue(triggers.reply_plan("unsubscribe")["suppress"])
        self.assertEqual(triggers.reply_plan("not_now")["status"], "snoozed")
        self.assertFalse(triggers.reply_plan("nonsense")["draft"])

    def test_validate_guardrails(self):
        ok = {"skip": False, "angle": "other", "offer": "x", "subject": "A quick idea for you", "body": GOOD_WEB, "facts": [], "reason": "r"}
        self.assertEqual(writer.validate(ok, "first", PROFILE)["subject"], "A quick idea for you")
        bad = lambda **k: self.assertRaises(Exception, writer.validate, {**ok, **k}, "first", PROFILE)
        bad(body="too short")
        bad(body=GOOD_WEB + " [your name]")
        bad(body=GOOD_WEB + " Visit https://evil.example today")
        bad(body=GOOD_WEB + " Mail me at x@evil.example")
        bad(body=GOOD_WEB + " Call 555-010-0100")
        bad(body=GOOD_WEB + " Great!")
        bad(body=GOOD_WEB + " As we discussed on the phone.")
        bad(subject="Re: hello there")
        bad(body=GOOD_WEB + " We hope this finds you well and love to reach out.")      # stock phrases
        bad(body=GOOD_WEB + " Click unsubscribe below.")
        self.assertIn("harborledger.example", writer.validate({**ok, "body": GOOD_WEB + " More at www.harborledger.example."}, "first", PROFILE)["body"])
        self.assertNotIn("—", writer.validate({**ok, "body": GOOD_WEB.replace(",", " —", 1)}, "first", PROFILE)["body"])
        self.assertEqual(writer.validate({**ok, "body": GOOD_FOLLOW, "subject": "x"}, "followup", PROFILE)["subject"], "")   # follow-ups stay in the thread
        self.assertRaises(Exception, writer.validate, {"skip": True, "reason": "x"}, "followup", PROFILE)

    def test_plan(self):
        hist = [{"dir": "out", "at": (NOW - timedelta(days=5)).isoformat(), "subject": "A quick idea", "body": GOOD_WEB}]
        inp = {"now": NOW.isoformat(), "profile": PROFILE, "cfg": {"budget_cents": 100, "wait_days": [4, 7]}, "contacts": [
            contact(id=1),
            contact(id=2, status="active", step=1, last_sent_at=(NOW - timedelta(days=5)).isoformat(), history=hist),
            contact(id=3, status="active", step=1, last_sent_at=(NOW - timedelta(days=1)).isoformat(), history=hist),
            contact(id=4, status="bounced")],
            "replies": [{"id": 9, "contact": contact(id=5, status="replied", step=1, history=hist), "text": "Yes, what is the price? Can we call?", "at": NOW.isoformat()}]}
        out = pipeline.plan(inp, self.claude)
        self.assertEqual({(d["contact_id"], d["kind"]) for d in out["drafts"]}, {(1, "first"), (2, "followup"), (5, "reply")})
        self.assertEqual({w["contact_id"] for w in out["waiting"]}, {3, 4})
        self.assertEqual(out["classified"][0]["label"], "interested")
        self.assertFalse(out["errors"])
        self.assertGreater(out["usage"]["cents"], 0)
        fu = [b for b in Fake.bodies if "follow-up number 1" in b["messages"][0]["content"]][0]["messages"][0]["content"]
        self.assertIn("WE WROTE on", fu); self.assertIn(GOOD_WEB[:40], fu)                      # the model sees the real earlier email
        rp = [b for b in Fake.bodies if "THEY WROTE" in b["messages"][0]["content"]][0]["messages"][0]["content"]
        self.assertIn("<untrusted>Yes, what is the price", rp)                                     # recipient text is fenced as data
        self.assertEqual(Fake.bodies[0]["system"][0]["cache_control"], {"type": "ephemeral"})     # prompt caching requested

    def test_retry_and_budget(self):
        bad = {"skip": False, "angle": "other", "offer": "x", "subject": "Hi there you", "body": "too short", "facts": [], "reason": ""}
        Fake.plan["first"] = bad
        Fake.plan["fix"] = {**bad, "subject": "A quick idea for you", "body": GOOD_WEB, "reason": "fixed"}
        out = pipeline.plan({"now": NOW.isoformat(), "profile": PROFILE, "cfg": {}, "contacts": [contact()]}, self.claude)
        self.assertEqual(out["drafts"][0]["reason"], "fixed")         # rejected once, shown why, fixed
        Fake.bodies.clear()
        out = pipeline.plan({"now": NOW.isoformat(), "profile": PROFILE, "cfg": {"budget_cents": 0}, "contacts": [contact(), contact(id=2)]}, self.claude)
        self.assertEqual((out["drafts"], len(Fake.bodies)), ([], 0))  # a cap of 0 writes nothing
        out = pipeline.plan({"now": NOW.isoformat(), "profile": PROFILE, "cfg": {"budget_cents": 0.3, "workers": 1}, "contacts": [contact(id=i) for i in range(1, 8)]}, self.claude)
        self.assertTrue(out["budget_hit"] and 0 < len(out["drafts"]) < 7)

    def test_lane_rules(self):
        ok = {"skip": False, "angle": "other", "offer": "x", "subject": "Hello there friend", "facts": [], "reason": "r"}
        v = lambda body, cat, kind="first", **x: writer.validate({**ok, "body": body, **x}, kind, PROFILE, 1, cat)
        self.assertEqual(v(GOOD_WEB, "lawyer")["offer"], "Website refresh")
        with self.assertRaises(Exception): v(GOOD_WEB + " We also do bookkeeping.", "lawyer")            # one lane only
        with self.assertRaises(Exception): v(GOOD_WEB + " We guarantee first page rankings.", "lawyer")   # no promises
        # bookkeeping lane: advisory mention only when the model decides the business is big enough, and the email must match the decision
        r = v(GOOD_BOOKS, "dentist", pitch_advisory=True, advisory_reason="Several providers on the team.")
        self.assertEqual(r["offer"], "Bookkeeping and advisory"); self.assertIn("Advisory pitch: YES", r["reason"])
        r = v(BOOKS_SOLO, "salon", pitch_advisory=False, advisory_reason="One chair, no sign of a team.")
        self.assertEqual(r["offer"], "Bookkeeping")
        with self.assertRaises(Exception): v(GOOD_BOOKS, "salon", pitch_advisory=False, advisory_reason="One chair, no sign of a team.")  # said no, pitched anyway
        with self.assertRaises(Exception): v(BOOKS_SOLO, "dentist", pitch_advisory=True, advisory_reason="Several providers on the team.")  # said yes, left it out
        with self.assertRaises(Exception): v(GOOD_BOOKS, "dentist")                                                                  # no decision given
        with self.assertRaises(Exception): v(GOOD_WEB, "dentist", pitch_advisory=False, advisory_reason="Too small to need one.")    # wrong lane for a dentist
        # a website that was read must supply a real detail
        with self.assertRaises(Exception): writer.validate({**ok, "body": GOOD_WEB}, "first", PROFILE, 1, "lawyer", True)
        self.assertTrue(writer.validate({**ok, "body": GOOD_WEB, "facts": ["Handles estates (their website)"]}, "first", PROFILE, 1, "lawyer", True)["body"])

    def test_angles_and_learning(self):
        good = {"skip": False, "offer": "x", "subject": "A quick idea for you", "body": GOOD_WEB, "facts": [], "reason": "r", "angle": "not_found"}
        self.assertEqual(writer.validate(good, "first", PROFILE)["angle"], "not_found")
        for bad in ("", "made_up", "catch_up_cleanup"):     # a bookkeeping tag is not valid in the web lane
            with self.assertRaises(writer.ClaudeError):
                writer.validate({**good, "angle": bad}, "first", PROFILE)
        L = {"web": {"hints": ["Angle not_found: 4 of 20 replied."], "examples": [{"subject": "Hi Mo", "body": "Short plain note."}]}}
        blk = writer.learning_block(L, "lawyer")
        self.assertIn("not_found", blk); self.assertIn("<untrusted>", blk); self.assertIn("style reference only", blk)
        self.assertEqual(writer.learning_block(L, "dentist"), "")      # other lane gets nothing
        self.assertEqual(writer.learning_block(None, "lawyer"), "")

    def test_skip_and_rewrite(self):
        Fake.plan["first"] = {"skip": True, "offer": "", "subject": "", "body": "", "facts": [], "reason": "National chain with a corporate office."}
        out = pipeline.plan({"now": NOW.isoformat(), "profile": PROFILE, "cfg": {}, "contacts": [contact()]}, self.claude)
        self.assertEqual((out["drafts"], out["skipped"][0]["reason"][:8]), ([], "National"))
        Fake.plan = {}
        r = pipeline.rewrite({"profile": PROFILE, "contact": contact(), "kind": "first", "body": GOOD_WEB, "instruction": "Make it shorter"}, self.claude)
        self.assertEqual(r["draft"]["kind"], "first")
        self.assertIn("Make it shorter", Fake.bodies[-1]["messages"][0]["content"])

    def test_cost(self):
        self.assertAlmostEqual(cost_cents("claude-haiku-4-5", {"in": 1_000_000}), 100)
        self.assertAlmostEqual(cost_cents("claude-haiku-4-5", {"cache_read": 1_000_000}), 10)    # cached reads cost 10% of input
        self.assertGreater(cost_cents("mystery-model", {"in": 1000}), cost_cents("claude-haiku-4-5", {"in": 1000}))   # unknown models err high

    def test_cli_without_key(self):
        os.environ.pop("ANTHROPIC_API_KEY")
        try:
            res = cli.run("plan", {"profile": PROFILE, "contacts": [contact()]})
            self.assertIn("ANTHROPIC_API_KEY", res["fatal"])
        finally:
            os.environ["ANTHROPIC_API_KEY"] = "test"

    def test_site_reader_refuses_private_addresses(self):
        for url in ("http://127.0.0.1/", "http://localhost/", "http://10.0.0.5/admin", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"):
            self.assertEqual(site_reader.read_site(url)["status"], "failed", url)

    def test_demo_runs_offline_and_passes_every_rule(self):
        data = {"now": NOW.isoformat(), "profile": PROFILE, "cfg": {}, "contacts": [contact(id=1), contact(id=2, category="dentist", company="Bluewave Dental", first_name="Priya"),
                contact(id=3, category="salon", company="Sunrise Salon", first_name="")]}
        out = pipeline.plan(data, DemoClaude())
        self.assertEqual(len(out["drafts"]), 3)
        self.assertFalse(out["errors"])
        self.assertEqual(out["usage"]["cents"], 0)


if __name__ == "__main__":
    unittest.main()
