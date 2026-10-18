const test = require("node:test");
const assert = require("node:assert");
const { seo, resume, ghost } = require("../lib");

const PAGE = `<!doctype html><html lang="en"><head><title>Emergency Plumber in Springfield NJ | Acme Plumbing</title>
<meta name="description" content="Licensed plumbers serving Springfield and nearby towns. Same-day repairs, upfront pricing, call or book online today.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://acme.example/"><link rel="icon" href="/f.ico">
<meta property="og:title" content="t"><meta property="og:image" content="i">
<script type="application/ld+json">{"@type":["LocalBusiness","Plumber"]}</script><script type="application/ld+json">{bad</script>
<script src="/a.js"></script><script src="/b.js" defer></script></head>
<body><!-- <h1>hidden</h1> --><h1>Plumber <b>services</b></h1><h2>a</h2><h2>b</h2><p>Hello</p>
<img src="http://x.test/i.png"><img src="/j.png" alt="j"><a href="tel:+15550100">Call</a><script>var a="<h1>no</h1>"</script></body></html>`;

test("seo: reads the page the way a browser would", () => {
  const p = seo.parsePage(PAGE);
  assert.strictEqual(p.title, "Emergency Plumber in Springfield NJ | Acme Plumbing");
  assert.strictEqual(p.h1s.length, 1);                       // ignores comments and script text
  assert.strictEqual(p.h1s[0].replace(/\s+/g, " "), "Plumber services");
  assert.deepStrictEqual([p.h2Count, p.imgs, p.imgsNoAlt, p.tel, p.mailto], [2, 2, 1, true, false]);
  assert.ok(p.ld.types.includes("Plumber") && p.ld.valid === 1 && p.ld.invalid === 1);
  assert.deepStrictEqual([p.mixed, p.renderBlockingScripts], [1, 1]);
});

test("seo: scoring flags the real problems", () => {
  const p = seo.parsePage(PAGE), U = new URL("https://acme.example/");
  const checks = seo.runChecks({ p, finalUrl: U, resp: { status: 200, headers: {} }, robots: { status: "missing" }, sitemap: { status: "missing" }, ms: 400, htmlBytes: 5000 });
  const by = (l) => checks.find((c) => c.label === l);
  assert.strictEqual(by("Page title").status, "pass");
  assert.strictEqual(by("robots.txt").status, "warn");
  assert.strictEqual(by("Structured data is valid JSON").status, "fail");
  assert.ok(seo.scoreOf(checks) > 0 && seo.scoreOf(checks) < 100);
  const noidx = seo.runChecks({ p, finalUrl: U, resp: { status: 200, headers: { "x-robots-tag": "noindex" } }, robots: { status: "ok", blocksAll: true }, sitemap: { status: "ok" }, ms: 400, htmlBytes: 5000 });
  assert.strictEqual(noidx.find((c) => c.label === "Allowed to be indexed").status, "fail");
});

test("seo: hostile pages parse in linear time", () => {
  const N = 1500000;
  const bad = { "unclosed script": "<script ".repeat(N / 8), "unclosed a": "<a ".repeat(N / 3), "many h1": "<h1>".repeat(N / 4), "only <": "<".repeat(N), "huge tag": "<a " + "x".repeat(N), "open comments": "<!--".repeat(N / 4), "open style": "<style>".repeat(N / 7) };
  for (const [k, v] of Object.entries(bad)) { const t = Date.now(); seo.parsePage("<html>" + v); assert.ok(Date.now() - t < 1500, k); }
  assert.strictEqual(seo.parsePage("").words, 0);
  assert.strictEqual(seo.parsePage(null).h1s.length, 0);
});

test("seo: refuses private networks and odd addresses (SSRF guard)", () => {
  for (const u of ["http://127.0.0.1", "https://10.0.0.5/x", "http://169.254.169.254/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "ftp://a.com", "localhost", "http://a.com:8080", "http://u:p@a.com", "intranet.local"])
    assert.throws(() => seo.normalizeUrl(u), u);
  assert.strictEqual(seo.normalizeUrl("example.com").href, "https://example.com/");
  assert.ok(seo.blockedIp("192.168.1.1") && seo.blockedIp("fd00::1") && !seo.blockedIp("93.184.216.34"));
});

const GOOD = `Alex Morgan\nalex@example.com | 555-010-0142\n\nExperience\nOps Coordinator, Pine Supply, Jun 2021 - Present\n- Scheduled 40+ weekly deliveries and cut missed windows by 18 percent\n- Trained 6 new hires on the order system\n- Resolved 25 customer complaints weekly with a 95 percent satisfaction rating\n- Managed inventory counts in Excel and reconciled them against purchase orders\n- Reduced overtime 12 percent by rebuilding the shift calendar\n- Led a 3 person team through a warehouse move\n- Built a tracker that saved 5 hours a week\n- Negotiated 4 vendor contracts\n\nEducation\nB.S. Business, State University, 2020\n\nSkills\nExcel, QuickBooks, scheduling, inventory\n` + "Additional context about the role and the team. ".repeat(14);

test("resume: strong resume scores well, weak one is told why", () => {
  assert.ok(resume.check(GOOD).score >= 80);
  const weak = resume.check("Objective\nI am a hard-working team player.\nResponsible for various tasks. References available on request.\n");
  assert.ok(weak.score < 50);
  const ids = weak.items.filter((i) => i.status !== "pass").map((i) => i.id);
  for (const id of ["contact", "sections", "fluff", "outdated"]) assert.ok(ids.includes(id), id);
  assert.strictEqual(resume.check("").items.find((i) => i.id === "contact").status, "fail");
});

test("resume: keyword gap finds only what the posting asks for", () => {
  const k = resume.keywords("I used Excel and QuickBooks to reconcile inventory.", "Need Excel, QuickBooks and Salesforce. Salesforce admin. Excel reports. Manage vendors and vendors.");
  assert.ok(k.present.includes("excel") && k.missing.includes("salesforce"));
  assert.ok(k.pct > 0 && k.pct < 100);
  assert.strictEqual(resume.keywords("anything", "").pct, null);
});

const NOW = Date.parse("2026-10-18T12:00:00Z");
test("ghost: evergreen, stale, and closed postings are flagged; a fresh direct one is not", () => {
  const bad = ghost.grade({ posting: "We are always hiring and keep your resume on file for future openings.", posted: "75 days ago", now: NOW });
  assert.strictEqual(bad.level, "High");
  assert.ok(ghost.grade({ posting: "Position has been filled.", company: "Acme", now: NOW }).score >= 60);
  const good = ghost.grade({ company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/1", posted: "2026-10-16", pay: "$60,000", posting: "Dispatcher. ".repeat(20) + "Pay $22 per hour. Duties include scheduling drivers and answering calls.", now: NOW });
  assert.strictEqual(good.level, "Low");
  assert.deepStrictEqual([ghost.ageDays("Posted 3 weeks ago", "", NOW), ghost.ageDays("", "Date posted: 2026-10-08", NOW), ghost.ageDays("", "nothing", NOW)], [21, 11, null]);
  assert.ok(ghost.grade({ posting: "Entry level role. Requires 7 years of experience in sales.", company: "A", now: NOW }).reasons.some((r) => /entry level/i.test(r)));
});
