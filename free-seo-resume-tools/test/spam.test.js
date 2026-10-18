const test = require("node:test");
const assert = require("node:assert");
const { spamAudit, emailSpam } = require("../lib");
const { readPage } = require("../lib/html-scan");

/* ---------- email: content ---------- */
test("email content: plain note scores well, spammy one is graded F with reasons", () => {
  const good = "Hi {{first_name|there}}, I noticed {{company}} has two locations and no online booking. I build simple booking pages for local shops and could show you one example this week if useful. Would a short call on Thursday work? Sam";
  assert.ok(emailSpam.scoreContent("Booking page for your shop", good).score >= 90);
  const bad = emailSpam.scoreContent("FREE MONEY!!!", "Click here to claim your guaranteed 100% free cash http://bit.ly/x http://1.2.3.4/y http://c.com");
  assert.strictEqual(bad.grade, "F");
  const txt = bad.findings.map((f) => f.text).join(" | ");
  for (const re of [/ALL-CAPS/, /shortener/, /bare IP/, /Spam-style/, /3 links/]) assert.match(txt, re);
  assert.ok(emailSpam.scoreContent("Re: hello", good, { first: true }).findings.some((f) => /fake/i.test(f.text)));
  assert.ok(!emailSpam.scoreContent("Re: hello", good, { first: false }).findings.some((f) => /fake/i.test(f.text)));   // follow-ups may say Re:
});

/* ---------- email: DNS authentication with a fake resolver ---------- */
const fakeDns = (zone) => ({
  resolveTxt: async (n) => { if (!zone.txt[n]) throw Object.assign(new Error("nx"), { code: "ENODATA" }); return zone.txt[n].map((r) => [r]); },
  resolveMx: async (n) => { if (!zone.mx[n]) throw new Error("nx"); return zone.mx[n]; },
  resolveCname: async () => { throw new Error("nx"); },
  resolve4: async (n) => { if (zone.listed && n.startsWith(zone.listed)) return ["127.0.2.2"]; throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); },
});
test("email domain: fully set up domain grades A, bare domain fails the right checks", async () => {
  emailSpam.setDeps({ resolver: fakeDns({ mx: { "good.example": [{ priority: 1, exchange: "mx.google.com" }] }, txt: {
    "good.example": ["v=spf1 include:_spf.google.com -all"], "_spf.google.com": ["v=spf1 ip4:1.2.3.0/24 ~all"],
    "google._domainkey.good.example": ["v=DKIM1; k=rsa; p=ABC"], "_dmarc.good.example": ["v=DMARC1; p=quarantine; rua=mailto:d@good.example"], "_mta-sts.good.example": ["v=STSv1; id=1"] } }) });
  const g = await emailSpam.checkDomain("good.example");
  assert.strictEqual(g.grade, "A");
  emailSpam.setDeps({ resolver: fakeDns({ mx: {}, txt: {} }) });
  const b = await emailSpam.checkDomain("bare.example");
  const st = Object.fromEntries(b.checks.map((c) => [c.key, c.status]));
  assert.deepStrictEqual([st.mx, st.spf, st.dmarc], ["fail", "fail", "fail"]);
  assert.ok(b.score < 60);
  emailSpam.setDeps({ resolver: fakeDns({ mx: { "m.example": [{ priority: 1, exchange: "x" }] }, txt: { "m.example": ["v=spf1 -all", "v=spf1 ~all"] }, listed: "m.example" }) });
  const m = await emailSpam.checkDomain("m.example");
  assert.match(m.checks.find((c) => c.key === "spf").detail, /2 SPF records/);
  assert.strictEqual(m.checks.find((c) => c.key === "dbl").status, "fail");
  assert.strictEqual((await emailSpam.checkDomain("gmail.com")).score, null);     // consumer addresses are not scored
  await assert.rejects(emailSpam.checkDomain("not a domain"));
});
test("email domain: SPF lookup counter follows includes", async () => {
  emailSpam.setDeps({ resolver: fakeDns({ mx: {}, txt: { "a.example": ["v=spf1 include:b.example a mx"], "b.example": ["v=spf1 include:c.example"], "c.example": ["v=spf1 a"] } }) });
  assert.strictEqual(await emailSpam.spfLookups("v=spf1 include:a.example -all"), 6);
});
test("email: sending health and combined score", () => {
  assert.strictEqual(emailSpam.reputationOf({ sent: 10, bounced: 5, optouts: 0, replied: 0 }).score, null);
  assert.strictEqual(emailSpam.reputationOf({ sent: 200, bounced: 1, optouts: 0, replied: 10 }).score, 100);
  const r = emailSpam.reputationOf({ sent: 200, bounced: 12, optouts: 6, replied: 0 });
  assert.ok(r.score <= 30 && r.findings.length >= 2);
  const c = emailSpam.combine({ auth: 100, reputation: null, content: 50, placement: null });
  assert.strictEqual(c.score, Math.round((100 * 40 + 50 * 20) / 60));        // missing parts are left out, not counted as zero
  assert.strictEqual(emailSpam.combine({}).score, null);
  assert.strictEqual(emailSpam.placementScore([{ result: "inbox" }, { result: "spam" }, { result: "?" }]), 50);
});

/* ---------- html reader ---------- */
test("html reader: regions, hidden text, anchors, json-ld, and linear time on hostile input", () => {
  const p = readPage(`<html><head><title>T</title><meta name="description" content="d"><meta name="robots" content="noindex"><link rel="canonical" href="/x"><script type="application/ld+json">{"@type":"Review"}</script><script type="application/ld+json">{bad</script></head>
    <body><nav><a href="/nav">n</a><a href="https://nav.example/">n</a></nav><h1>Hi <b>there</b></h1><p>Body</p><a href="/a/?q=1">A</a><a href="https://o.example/x" rel="nofollow">Our partner</a>
    <div style="display:none">${"hidden words ".repeat(10)}</div><footer><a href="/f">f</a></footer></body></html>`, "https://me.example");
  assert.deepStrictEqual([p.title, p.meta, p.robots, p.canon, p.h1s], ["T", "d", "noindex", "/x", ["Hi there"]]);
  assert.deepStrictEqual(p.links, ["/a"]);                                       // content links only
  assert.deepStrictEqual(p.allLinks.sort(), ["/a", "/f", "/nav"]);
  assert.deepStrictEqual(p.ext.map((e) => [e.host, e.rel, e.text]), [["o.example", "nofollow", "Our partner"]]);   // nav link to another site is not content
  assert.strictEqual(p.hidden, 1);
  assert.deepStrictEqual([p.ld, p.ldBad], [["Review"], 1]);
  const N = 1500000;
  for (const [k, v] of Object.entries({ "open nav": "<nav>".repeat(N / 5), "open a": "<a href=x>".repeat(N / 10), "open h1": "<h1>".repeat(N / 4), "open div style": '<div style="display:none">'.repeat(N / 27), "open script": "<script ".repeat(N / 8), "huge tag": "<a " + "x".repeat(N), "open comment": "<!--".repeat(N / 4) })) {
    const t = Date.now(); readPage("<html>" + v, "https://me.example"); assert.ok(Date.now() - t < 2000, k);
  }
});

/* ---------- spam audit on an in-memory site ---------- */
const FILLER = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${i % 37}x`).join(" ");
function site(kind) {
  const pages = {}, sm = [];
  const add = (path, html) => { pages[path] = html; sm.push(path); };
  const wrap = (title, meta, h1, body, extra = "") => `<html lang="en"><head><title>${title}</title><meta name="description" content="${meta}"><link rel="canonical" href="https://t.example${extra}"></head><body><nav><a href="/">Home</a></nav><h1>${h1}</h1>${body}</body></html>`;
  add("/", wrap("Home page of the test site", "A real test site about many things", "Home", `<p>${FILLER(320, "home")}</p>` + Array.from({ length: 12 }, (_, i) => `<a href="/guides/g${i}">Guide ${i}</a>`).join(" ") + `<a href="/c0">c0</a>`, "/"));
  for (let i = 0; i < 12; i++) add(`/guides/g${i}`, wrap(`Guide number ${i} on a unique topic`, `Distinct description for guide ${i} with enough characters`, `Guide ${i}`, `<p>${FILLER(380, "g" + i)}</p><a href="/">Home</a>`, `/guides/g${i}`));
  if (kind === "spammy") {
    const tpl = (city) => `<p>We offer the best plumbing services in ${city}. Our ${city} plumbers are ready to help with plumbing in ${city}. ${FILLER(60, "same")} Call now for plumbing in ${city}.</p>`;
    for (let i = 0; i < 10; i++) add(`/plumber-in-city${i}`, wrap("Plumber near you", "Plumbing services near you", "Plumber near you", tpl("City" + i)));
    add("/reviews", wrap("Reviews page of the test site", "What people say about the test site and why", "Reviews", `<script type="application/ld+json">{"@type":"AggregateRating","ratingValue":5}</script><p>${FILLER(300, "rev")} We are award-winning and guaranteed #1 on Google.</p>`, "/reviews"));
    add("/links", wrap("Partner links of the test site", "A page of partner links for the test site", "Links", `<p>${FILLER(300, "lnk")}</p><a href="https://bit.ly/x">Sponsored deal</a><a href="https://casino.example/">Our partner</a>`, "/links"));
    add("/hidden", wrap("Hidden text page of the test site", "A page that hides some text from visitors ok", "Hidden", `<p>${FILLER(300, "hid")}</p><div style="display:none">${FILLER(40, "stuff")} cheap plumber cheap plumber</div>`, "/hidden"));
    for (let i = 0; i < 3; i++) pages["/guides/g" + i] = pages["/guides/g" + i].replace(/<a href="\/">Home<\/a>/, `<a href="https://casino.example/p${i}">best</a>`);
  }
  return { pages, sitemap: `<urlset>${sm.map((p) => `<url><loc>https://t.example${p}</loc></url>`).join("")}<url><loc>https://elsewhere.example/x</loc></url></urlset>`, kind };
}
const fetcher = (s, { cloak } = {}) => async (href, o = {}) => {
  const u = new URL(href);
  const html = { "content-type": "text/html" };
  if (u.pathname === "/robots.txt") return { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nSitemap: https://t.example/sitemap.xml\n" };
  if (u.pathname === "/sitemap.xml") return { status: 200, headers: { "content-type": "application/xml" }, body: s.sitemap };
  let b = s.pages[u.pathname];
  if (b === undefined) return { status: 404, headers: html, body: "not found" };
  if (cloak && /Googlebot/.test(o.ua) && u.pathname.startsWith("/guides/g1")) b = b.replace(/g1\d*x/g, "seoseoseo");
  return { status: 200, headers: html, body: b };
};

test("spam audit: a spammy site is flagged on the right checks", async () => {
  const r = await spamAudit.audit("https://t.example", { fetch: fetcher(site("spammy")), max: 200 });
  const st = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
  assert.strictEqual(st.dupes, "fail");
  assert.strictEqual(st.doorway, "fail");
  assert.strictEqual(st.cloak, "fail");                 // hidden text
  assert.strictEqual(st.claims, "fail");                // AggregateRating markup
  assert.strictEqual(st.linkscheme, "fail");            // shortener + followed "Sponsored" link
  assert.ok(["F", "D"].includes(r.grade) && r.level === "High");
  assert.strictEqual(r.crawled, 26);                    // off-site <loc> ignored
  assert.ok(r.worstPages.some((w) => w.u === "/plumber-in-city3"));
  assert.match(spamAudit.reportText(r), /Spam-policy audit for https:\/\/t\.example/);
});
test("spam audit: a clean site passes, and cloaking is caught by the Googlebot fetch", async () => {
  const clean = await spamAudit.audit("https://t.example", { fetch: fetcher(site("clean")), max: 200 });
  const bad = clean.checks.filter((c) => c.status === "fail").map((c) => c.id);
  assert.deepStrictEqual(bad, []);
  assert.ok(clean.score >= 85);
  const cl = await spamAudit.audit("https://t.example", { fetch: fetcher(site("clean"), { cloak: true }), max: 200 });
  assert.strictEqual(cl.checks.find((c) => c.id === "cloak").status, "fail");
});
test("spam audit: respects the page cap, falls back to home-page links, refuses private addresses", async () => {
  const s = site("clean"); s.sitemap = "";
  const noMap = async (href, o) => (new URL(href).pathname === "/sitemap.xml" ? { status: 404, headers: {}, body: "" } : fetcher(s)(href, o));
  const r = await spamAudit.audit("https://t.example", { fetch: noMap, max: 5 });
  assert.strictEqual(r.crawled, 5);
  assert.strictEqual(r.discoveredFromHome, true);
  assert.strictEqual(r.checks.find((c) => c.id === "site").status, "fail");
  await assert.rejects(spamAudit.audit("http://127.0.0.1"));
  await assert.rejects(spamAudit.audit("http://169.254.169.254/"));
});

test("spam audit: an unreachable site is an error, not a grade", async () => {
  await assert.rejects(spamAudit.audit("https://t.example", { fetch: async () => { throw new Error("down"); } }), /Could not read any pages/);
});
