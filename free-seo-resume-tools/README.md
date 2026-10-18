# free-seo-resume-tools

Five small, free tools for people who do not want to hand a stranger their website, resume or email list. Plain JavaScript, **no dependencies, no AI, no database**. Nothing is stored or sent anywhere except the one page you ask the SEO checker to fetch.

I built these to run as free tools on my business site and pulled them out as a standalone library and command line.

## Tools

| Tool | What it does |
| --- | --- |
| **SEO basics checker** (`lib/seo-checker.js`) | Fetches one public page and checks about 25 technical on-page basics: title and meta description length, one H1, canonical, noindex, HTTPS, robots.txt, sitemap, viewport, alt text, structured data validity, tap-to-call, social preview, response time. Every failed check says how to fix it in plain English. |
| **Resume check + ATS keyword check** (`lib/resume-check.js`) | Rule-based review of resume text: contact details, length, sections an applicant tracking system can read, bullet points, action verbs, numbers, vague phrases, buzzwords, date consistency, outdated lines. With a job posting, lists the keywords the posting uses that your resume never says. |
| **Google spam-policy audit** (`lib/spam-audit.js`) | Crawls a site you own (sitemap, or the home page's links) and scores the signals Google's spam policies call out: near-duplicate and scaled pages, thin pages, doorway-style page groups, keyword stuffing, hidden text, cloaking (fetches a sample as Googlebot and as a visitor), review markup and unproven claims, broken indexing signals, and **link patterns**: orphan and link-heavy pages, followed paid or affiliate links without `rel="sponsored"`, shorteners and bare-IP links, and site-wide followed links to one outside site. Lists the worst pages with the reason for each. |
| **Email spam grader** (`lib/email-spam.js`) | Grades a cold email's wording (ALL-CAPS, hype words, link shorteners, bare IPs, too many links, fake `Re:`), checks a sending domain's SPF (including the 10-lookup limit), DKIM, DMARC, MX and Spamhaus listing live in DNS, scores sending health from bounce, opt-out and reply rates, and combines them into one weighted score. |
| **Ghost-job checker** (`lib/ghost-job.js`) | Scores how likely a posting is not a real open job from signals in its text: age, "talent pool" wording, closed notices, staffing or confidential employers, missing pay range, entry level asking 5+ years, aggregator links. |

## Honest limits

- The SEO score measures **technical basics only**. It does not know your rankings or traffic and is never a prediction of either.
- The resume check finds common problems that get a resume skipped. It does not write or add anything, and the keyword tool tells you to add a word **only if it is true**.
- The spam audit is a **heuristic**. It cannot see Google's own judgement, and every flag is a page to review, not a verdict. Run it only on sites you own or have permission to audit.
- The email grade is an **estimate** of deliverability. Nobody can see inside other people's inboxes. DKIM can only be found on common selector names, so a miss says "check yours", not "missing".
- The ghost-job result is an **estimate**. Nobody outside a company can see whether it is really hiring, so a Low score is not a promise.

## Use it

Requires Node 18+.

```
git clone https://github.com/matthewc-blip/free-seo-resume-tools
cd free-seo-resume-tools

node bin/cli.js seo example.com
node bin/cli.js resume examples/resume.txt --job examples/posting.txt
node bin/cli.js ghost examples/posting.txt --posted "45 days ago"
node bin/cli.js spam-audit yoursite.com --max 150
node bin/cli.js email examples/cold-email.txt
node bin/cli.js domain yourdomain.com
```

Add `--json` to any command for machine-readable output. As a library:

```js
const { seo, resume, ghost } = require("./lib");
const report = await seo.check("example.com");   // { score, counts, checks: [...] }
resume.check(text);                              // { score, grade, items: [...] }
resume.keywords(resumeText, jobPostingText);     // { present, missing, pct }
ghost.grade({ posting, company, url, posted });  // { score, level, reasons }
await spamAudit.audit("yoursite.com", { max: 150 }); // { score, grade, level, checks, sections, worstPages }
emailSpam.scoreContent(subject, body);           // { score, grade, findings }
await emailSpam.checkDomain("yourdomain.com");   // { score, grade, checks }
emailSpam.combine({ auth, reputation, content, placement });
```

## Engineering notes

- **SSRF-safe fetching.** The SEO checker refuses private, loopback, link-local and carrier-grade-NAT addresses (IPv4, IPv6 and IPv4-mapped IPv6), non-standard ports, and URLs with credentials. The address is validated **at connect time** through a custom socket `lookup`, so DNS rebinding cannot swap in a private address after the check. Redirects are re-validated hop by hop and capped at 4; response size and time are capped.
- **Linear-time HTML reading.** Pages are read in one pass with no backtracking. An earlier regex version let a hostile 1.5 MB page freeze a server for minutes; the tests now feed it nine kinds of malicious input and require each to finish in under 1.5 s.
- **Crawler manners and safety.** The audit uses the same connect-time address validation as the page checker for every request, caps pages (default 150, max 1000), body size and concurrency (3), ignores sitemap entries on other hosts, and refuses to grade a site it could not read. Its own HTML reader is a single linear pass that understands nav/header/footer regions, hidden blocks and anchors, so a hostile page cannot stall a crawl.
- **Testable offline.** The audit takes an injectable `fetch` and the email checks an injectable DNS resolver, so the tests run a fake website and a fake DNS zone with no network.
- **Explainable scoring.** Every check has a weight, a plain-English detail line, and a fix. The score is just weighted arithmetic you can read in the source.

## Tests

```
npm test
```

## License

MIT. Not affiliated with Google or any job board.
