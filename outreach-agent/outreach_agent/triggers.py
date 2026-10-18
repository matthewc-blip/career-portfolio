"""When to write what. No wording lives here: this only decides whether a contact needs a first email, a follow-up, a check-in or nothing,
and what an incoming reply means for the rest of the conversation. Claude does the writing (writer.py).

The conversation is judged from its history, not from a fixed script: how many emails went out, how long ago the last one was, and whether
the other side has said anything since.
"""
from datetime import datetime, timedelta, timezone

DEFAULT_WAIT_DAYS = [4, 7]          # days of silence before follow-up 1, then follow-up 2 (add a third number for another)
SNOOZE_DAYS = 45                    # "not right now" gets one polite check-in after this long
STOP_STATUSES = {"bounced", "unsubscribed", "replied", "done"}

# What a reply means. Node applies the status change; the draft (if any) always waits for a human.
REPLY_RULES = {
    "interested": {"draft": True, "status": "replied"},
    "question": {"draft": True, "status": "replied"},
    "referral": {"draft": True, "status": "replied"},       # "talk to my partner", gives another contact
    "not_now": {"draft": False, "status": "snoozed"},
    "not_interested": {"draft": False, "status": "done", "suppress": True},
    "unsubscribe": {"draft": False, "status": "unsubscribed", "suppress": True},
    "auto": {"draft": False, "status": None},
    "other": {"draft": False, "status": "replied"},         # shown to you, nothing written automatically
}
LABELS = tuple(REPLY_RULES)


def parse_time(v):
    if not v:
        return None
    try:
        t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def clean_waits(waits):
    out = []
    for w in waits or DEFAULT_WAIT_DAYS:
        try:
            n = int(w)
        except (TypeError, ValueError):
            continue
        out.append(max(1, min(60, n)))
    return out[:4] or list(DEFAULT_WAIT_DAYS)


def decide(contact, now, waits=None):
    """Returns {"action": write_first | write_followup | write_checkin | wait | stop, "n": follow-up number, "why": text}."""
    waits = clean_waits(waits)
    st = contact.get("status") or "new"
    step = int(contact.get("step") or 0)
    if contact.get("open_draft"):
        return {"action": "wait", "n": 0, "why": "A draft for this contact is already waiting."}
    if st in STOP_STATUSES:
        return {"action": "stop", "n": 0, "why": "Conversation is %s." % st}
    last = parse_time(contact.get("last_sent_at"))
    if st == "snoozed":
        until = parse_time(contact.get("snooze_until"))
        if until and now >= until:
            return {"action": "write_checkin", "n": 0, "why": "They asked to be contacted later and that time has come."}
        return {"action": "wait", "n": 0, "why": "Waiting until they said to write again.", "until": until.isoformat() if until else None}
    if step == 0:
        return {"action": "write_first", "n": 0, "why": "New contact with no email sent yet."}
    heard = parse_time(contact.get("last_inbound_at"))
    if heard and last and heard >= last:
        return {"action": "wait", "n": 0, "why": "They wrote back after our last email."}
    n = step                               # step 1 sent -> follow-up 1 is next
    if n > len(waits):
        return {"action": "stop", "n": 0, "why": "Every follow-up has been sent."}
    if not last:
        return {"action": "wait", "n": n, "why": "No send time recorded."}
    due = last + timedelta(days=waits[n - 1])
    if now < due:
        return {"action": "wait", "n": n, "why": "Follow-up %d is due %s." % (n, due.date().isoformat()), "until": due.isoformat()}
    return {"action": "write_followup", "n": n, "why": "No reply %d days after email %d." % (waits[n - 1], step)}


def final_followup(n, waits=None):
    return n >= len(clean_waits(waits))


def reply_plan(label):
    return REPLY_RULES.get(label) or REPLY_RULES["other"]
