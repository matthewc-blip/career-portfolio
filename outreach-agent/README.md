# outreach-agent

A small, dependency-free Python tool that drafts cold outreach emails with an LLM and refuses to let a bad draft through. It was extracted from a system I run for my own small business, with the business-specific data replaced by fictional examples.

The interesting part is not "call an LLM to write an email". It is everything around the call: deciding *when* to write, fencing untrusted text, validating the output, capping spend, and keeping a human in the loop.

## Try it (no API key, no network)

```
python3 -m outreach_agent demo
python3 -I -m unittest discover -s tests
```

`demo` runs the full pipeline against fictional contacts with an offline stand-in for the model, so you can see every rule fire without spending anything. Python 3.9+ and the standard library only.

To use a real model, set `ANTHROPIC_API_KEY` and run `plan` (see `python3 -m outreach_agent --help`). Model and prices are configurable (`OUTREACH_MODEL`, `OUTREACH_PRICES`).

## What it does

For each contact the pipeline decides what should happen next, then drafts it:

- **First email, follow-ups, check-ins, and replies**, each with its own prompt and rules.
- **Timing** (`triggers.py`): waits between touches, stops after the last follow-up, never nags someone who replied, never has two open drafts for one contact, resumes snoozed contacts on the right day.
- **Reply handling**: classifies an inbound reply (interested, not now, unsubscribe, etc.) and applies fixed rules. An unsubscribe suppresses the contact permanently.
- **Lanes** (`lanes.py`, `examples/lanes.json`): each business category maps to one offer with its own must/ban phrases and allowed angle tags. An email can pitch one thing only.
- **Advisory decision**: for the bookkeeping lane the model must explicitly decide whether the business is large enough for the extra advisory pitch, give a reason, and the email must match the decision.
- **Optional site reading** (`site_reader.py`): fetches the recipient's own homepage so the email can cite a real detail. Respects robots.txt and refuses private, loopback, and link-local addresses (SSRF guard).

## Safety design

| Risk | Control |
| --- | --- |
| Prompt injection from a scraped website or an inbound reply | Recipient-supplied text is wrapped in `<untrusted>` tags and the system prompt says to treat it as data only |
| Hallucinated claims, links, or contact details | Validator allowlists links, emails, and phone numbers to the sender's own; rejects unfilled placeholders |
| Invented history ("as we discussed...") | Rejected unless real earlier messages exist; the model is shown the actual thread |
| Spammy or generic copy | Word-count limits, stock-phrase and exclamation rejection, em-dash removal, no `Re:` subjects, no fake unsubscribe lines |
| Over-promising | Per-lane banned phrases (for example guaranteed rankings) |
| Runaway cost | Per-run budget in cents, enforced between calls; unknown models are priced high; prompt caching for the shared system prompt |
| A rejected draft | The model is shown why and retried once; if it still fails, the contact is reported, not sent |
| Mistakes reaching real people | Nothing is sent. Every output is a draft for a human to approve |

## Layout

```
outreach_agent/
  pipeline.py    plan / rewrite orchestration, concurrency, budget
  writer.py      prompts and the output validator
  triggers.py    what to do next for each contact, reply rules
  lanes.py       JSON-configured offers and rules
  client.py      stdlib Claude client: retries, caching, cost accounting
  site_reader.py robots.txt aware, SSRF-guarded page reader
  demo_client.py offline stand-in model
  cli.py         demo / plan / rewrite commands
examples/        fictional profile, lanes, and contacts
tests/           unit tests using a fake Claude HTTP server on localhost
```

## Notes

All names, businesses, and domains in `examples/` are fictional. The tool drafts only; sending, unsubscribe handling, and compliance with email law (CAN-SPAM and similar) are the operator's responsibility.

MIT licensed.
