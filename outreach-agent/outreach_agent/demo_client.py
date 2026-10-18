"""An offline stand-in for Claude so the pipeline can be run and tested with no API key and no network.

It reads the same prompt the real model gets and answers with plain template emails. The point is the machinery around the model: triggers,
lane rules, validation, retries, spend accounting and the human-review boundary all run exactly as they do against the real API.
"""
import json
import re

from . import lanes


def _field(prompt, label, default=""):
    m = re.search(r"^%s: (.*)$" % re.escape(label), prompt, re.M)
    return m.group(1).strip() if m else default


class DemoClaude:
    model = "demo-offline"

    def configured(self):
        return True

    def ask(self, system, messages, max_tokens=700, tools=None):
        prompt = messages[0]["content"]
        usage = {"in": 1200, "out": 180, "cache_read": 0, "cache_write": 0, "searches": 0}
        if "label it" in system:
            low = re.sub(r"</?untrusted>", "", prompt.split("THEIR REPLY:")[-1]).lower()
            label = ("unsubscribe" if re.search(r"unsubscribe|remove me|stop", low) else "not_interested" if "not interested" in low or "no thanks" in low
                     else "interested" if re.search(r"price|call|yes|tell me more|interested", low) else "other")
            return json.dumps({"label": label, "summary": "They replied: " + low.strip()[:80]}), usage
        recipient = prompt.split("RECIPIENT")[-1].split("HISTORY")[0]
        company = _field(recipient, "Business")
        cat = _field(recipient, "Type (from the map listing)", "business")
        city = _field(recipient, "Location", "your area")
        who = _field(recipient, "Contact person", "")
        sender = _field(prompt, "Name", "Jordan").split(" ")[0]
        greet = ("Hi %s," % who) if who and not who.startswith("No contact") else "Hi,"
        key = lanes.rule_key(cat)
        task = prompt.split("TASK:")[-1][:200]
        advisory = lanes.needs_advisory_decision(cat, "first") and bool(re.search(r"dental|clinic|group|partners", company, re.I))
        out = {"skip": False, "offer": "", "subject": "", "facts": [], "reason": "", "pitch_advisory": False, "advisory_reason": "", "angle": "other"}
        if lanes.needs_advisory_decision(cat, "first"):
            out["pitch_advisory"] = advisory
            out["advisory_reason"] = "The name suggests a multi-provider practice." if advisory else "Nothing shows a team that large."
        if key == "bookkeeping":
            first = ("%s %s looks like a busy %s in %s, which usually means the books get done late at night or not at all. I do monthly bookkeeping "
                     "for small local businesses, usually in QuickBooks Online, and I can catch up anything that has fallen behind. %sWould ten minutes "
                     "this week be worth it to see if it fits? %s") % (greet, company, cat, city, "I can also help with part-time finance planning and cash flow reporting. " if advisory else "", sender)
            follow = "%s a different thought after my last note. Many owners only look at their books when the accountant asks, which makes tax time a scramble. I can do a one-time catch-up first, then keep things current each month. Worth a short call? %s" % (greet, sender)
            out["angle"] = "catch_up_cleanup"
        else:
            first = ("%s I had a look at how %s shows up online. A clear, fast website with the basics of local search set up properly, like your Google "
                     "profile and page titles, tends to bring in more calls from people already searching in %s. I do small website refreshes for local "
                     "businesses and can show you a few quick fixes. Would a short call this week help? %s") % (greet, company, city, sender)
            follow = "%s a different thought after my last note. Most visitors browse on a phone, so a site that loads quickly and makes the next step obvious can make a real difference to your search results and your calls. Happy to send two or three specific ideas. %s" % (greet, sender)
            out["angle"] = "mobile_first"
        out["facts"] = ["%s in %s (listing)" % (cat, city)]
        if "FIRST email" in task:
            out.update(subject=("Books for %s" if key == "bookkeeping" else "A quick idea for %s's website") % company, body=first, reason="Matched the %s lane from the listing type." % key)
        elif "follow-up number" in task:
            out.update(body=follow, reason="New angle for a follow-up.")
        elif "They said earlier" in task:
            out.update(body="%s you told me earlier that now was not the right time, so this is the one check-in I promised myself. If things have changed, I am glad to help, and if not, no reply is needed. %s" % (greet, sender), reason="Polite check-in after a snooze.")
        else:
            out.update(body="%s thanks for the reply. I will confirm the details and send a short summary by email, and we can set a time that suits you for a quick call. %s" % (greet, sender), reason="Answering their reply.")
            out["angle"] = ""
        return json.dumps(out), usage
