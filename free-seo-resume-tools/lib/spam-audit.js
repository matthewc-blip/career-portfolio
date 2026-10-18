// Google spam-policy audit for a whole site. It reads the sitemap (or the home page's links), fetches each page, and scores the
// signals Google's spam policies call out: scaled and near-duplicate content, doorway-style page groups, thin pages, keyword stuffing,
// hidden text and cloaking, review markup and unproven claims, broken indexing signals, and link patterns (link schemes, paid links
// without rel=sponsored, orphan and link-heavy pages).
// This is a heuristic. It cannot see Google's own judgement and nothing here guarantees a result, but every flag points at a page to fix.
// Run it on sites you own or have permission to audit.
const crypto = require("crypto");
const { readPage } = require("./html-scan");
const { normalizeUrl, fetchOnce } = require("./seo-checker");

const UA = "FreeSEOTools-SpamAudit/1.0 (+https://github.com/matthewc-blip/free-seo-resume-tools)";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const dec = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
const STOP = new Set("a an and are as at be but by can for from has have how i if in into is it its of on or our so that the their them then there these they this to us was we were what when which who will with you your not no yes do does did more most one all any each than too very about also just get got".split(" "));
const h32 = (s) => crypto.createHash("md5").update(s).digest().readUInt32LE(0);

function parsePage(path, r, origin) {
  const pg = readPage(r.body || "", origin);
  const words = pg.text.toLowerCase().replace(/[^a-z0-9$%' ]/g, " ").split(/\s+/).filter(Boolean);
  // Keep every third 5-word shingle (chosen by hash, so the same phrase is kept on every page): overlap estimates stay close and memory drops by two thirds.
  const sh = new Set(); for (let k = 0; k + 5 <= words.length; k++) { const h = h32(words.slice(k, k + 5).join(" ")); if (h % 3 === 0) sh.add(h); }
  const uni = new Map(), bi = new Map(); const meaningful = words.filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  for (const w of meaningful) uni.set(w, (uni.get(w) || 0) + 1);
  for (let k = 0; k + 1 < words.length; k++) { const a = words[k], b = words[k + 1]; if (STOP.has(a) || STOP.has(b) || a.length < 3 || b.length < 3) continue; const key = a + " " + b; bi.set(key, (bi.get(key) || 0) + 1); }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
  const [uw, uc] = top(uni), [bw, bc] = top(bi);
  return {
    u: path, status: r.status, title: pg.title, meta: pg.meta, robots: pg.robots, canon: pg.canon, h1s: pg.h1s, words: words.length, sh, text: pg.text.slice(0, 60000), ld: pg.ld, ldBad: pg.ldBad,
    links: pg.links, allLinks: pg.allLinks, ext: pg.ext, hidden: pg.hidden,
    topWord: uw, topWordCount: uc, topWordPct: words.length ? uc / words.length : 0, topPhrase: bw, topPhrasePct: words.length ? (bc * 2) / words.length : 0,
    hash: crypto.createHash("md5").update(words.join(" ")).digest("hex"),
  };
}

// ---------- risky wording ----------
const CLAIMS = [
  [/\b(guarantee[sd]?|guaranteed)\b[^.]{0,40}\b(#1|first page|top of google|rankings?|results|leads|traffic)\b/i, "Promises a search result"],
  [/(?:^|\s)#1\b|\bnumber one\b|\bbest (?:[a-z]+ ){1,3}(?:in|of)\b/i, "Superlative claim (#1 or best)"],
  [/\b(award[- ]winning|top[- ]rated|five[- ]star rated|5[- ]star rated)\b/i, "Unproven award or rating claim"],
  [/★{3,}|\b5(?:\.0)? out of 5\b|\b\d{2,} (?:five[- ]star )?reviews\b/i, "Star or review count in the text"],
  [/\b(?:our|my) (?:happy )?(?:clients|customers) (?:say|love|tell)\b|\bwhat our (?:clients|customers) say\b|\btestimonials?\b/i, "Testimonial wording"],
  [/\b(?:visit|stop by|come to) our [A-Z][A-Za-z .'-]{2,30} (?:office|location|branch|showroom)\b|\bour [A-Z][A-Za-z .'-]{2,30} (?:office|branch) (?:is|at)\b/, "Implies a local office"],
];
// A claim only counts when it is not being denied nearby ("we do not guarantee rankings" is the opposite of a promise).
const NEG = /\b(?:red flags?|beware|avoid|warning signs?|fake|false|nobody|no one|no honest|not|never|no|cannot|can't|can not|won't|without|nor|neither|doesn't|don't|isn't|aren't)\b|n't\b/i;
const QUESTION = /\b(?:can|could|do|does|will|would|is|are) (?:you|we|anyone|anybody|they|he|she|it)\b[^.?!]{0,30}$/i;
const DENY_AFTER = /^[^.]{0,80}voice of people who did not|^[^.]{0,40}\?\s*(?:no\b|nobody|no one|no honest|we cannot|we can't|we do not|we don't)|^[^.]{0,30}\b(?:cannot|can't|is not possible|isn't possible)\b/i;
function claimHit(re, text) { const g = new RegExp(re.source, re.flags.replace("g", "") + "g"); let m; while ((m = g.exec(text))) { const before = text.slice(Math.max(0, m.index - 45), m.index + 4); const after = text.slice(m.index + m[0].length, m.index + m[0].length + 70);
    if (!NEG.test(before) && !QUESTION.test(before) && !DENY_AFTER.test(after)) return text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).replace(/\s+/g, " ").trim(); if (m.index === g.lastIndex) g.lastIndex++; } return ""; }

async function mapLimit(list, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } })); }
const sectionOf = (u) => { const p = u.split("/").filter(Boolean); if (!p.length) return "/"; return p.length === 1 ? "/(top level)" : "/" + p.slice(0, Math.min(2, p.length - 1)).join("/"); };
const mark = (st) => (st === "pass" ? 100 : st === "warn" ? 60 : 20);

function analyze(pages, extra) {
  const by = new Map(pages.map((p) => [p.u, p]));
  const ok = pages.filter((p) => p.status === 200);
  const risk = new Map(); const reasons = new Map();
  const flag = (u, pts, why) => { risk.set(u, (risk.get(u) || 0) + pts); (reasons.get(u) || reasons.set(u, []).get(u)).push(why); };
  const checks = [];
  const add = (c) => checks.push({ weight: 1, pages: [], count: 0, ...c, pages: (c.pages || []).slice(0, 60) });

  // 1. indexing signals
  { const bad = pages.filter((p) => p.status !== 200), noidx = ok.filter((p) => /noindex/i.test(p.robots)), canonBad = ok.filter((p) => p.canon && !p.canon.replace(/\/+$/, "").endsWith(p.u === "/" ? "" : p.u) && p.u !== "/"), noCanon = ok.filter((p) => !p.canon);
    bad.forEach((p) => flag(p.u, 3, `Sitemap URL returns ${p.status || "no response"}`)); noidx.forEach((p) => flag(p.u, 3, "In the sitemap but marked noindex")); canonBad.forEach((p) => flag(p.u, 2, "Canonical points to another URL"));
    const st = bad.length || noidx.length ? "fail" : canonBad.length || noCanon.length ? "warn" : "pass";
    add({ id: "indexing", title: "Indexing signals", status: st, weight: 1.2, count: bad.length + noidx.length + canonBad.length + noCanon.length,
      detail: `${pages.length} sitemap URLs. ${bad.length} not returning 200, ${noidx.length} noindex, ${canonBad.length} with a canonical elsewhere, ${noCanon.length} without a canonical.`,
      why: "A sitemap should list only live, indexable, canonical pages. Mixed signals waste crawl budget and look careless at scale.", fix: "Remove dead or noindex URLs from the sitemap and give every page a self-referencing canonical.",
      pages: [...bad.map((p) => [p.u, `Status ${p.status}`]), ...noidx.map((p) => [p.u, "noindex"]), ...canonBad.map((p) => [p.u, "Canonical elsewhere"]), ...noCanon.map((p) => [p.u, "No canonical"])] });
  }
  // 2. titles, descriptions, headings
  { const dup = (k) => { const m = new Map(); for (const p of ok) { const v = p[k]; if (!v) continue; (m.get(v) || m.set(v, []).get(v)).push(p.u); } return [...m.values()].filter((l) => l.length > 1); };
    const dT = dup("title"), dM = dup("meta"), dH = ok.filter((p) => p.h1s[0]).reduce((m, p) => ((m.get(p.h1s[0]) || m.set(p.h1s[0], []).get(p.h1s[0])).push(p.u), m), new Map()), dHl = [...dH.values()].filter((l) => l.length > 1);
    const noT = ok.filter((p) => p.title.length < 15), longT = ok.filter((p) => p.title.length > 65), noM = ok.filter((p) => !p.meta), longM = ok.filter((p) => p.meta.length > 165), h1bad = ok.filter((p) => p.h1s.length !== 1);
    dT.flat().forEach((u) => flag(u, 3, "Duplicate title")); dM.flat().forEach((u) => flag(u, 2, "Duplicate meta description")); dHl.flat().forEach((u) => flag(u, 2, "Duplicate H1")); noT.forEach((p) => flag(p.u, 2, "Missing or tiny title")); noM.forEach((p) => flag(p.u, 1, "No meta description")); h1bad.forEach((p) => flag(p.u, 1, `${p.h1s.length} H1 tags`));
    const n = dT.length + dM.length + dHl.length; const st = n || noT.length ? "fail" : noM.length || h1bad.length || longT.length + longM.length > ok.length * 0.05 ? "warn" : "pass";
    add({ id: "tags", title: "Titles, descriptions and headings", status: st, weight: 1.2, count: n + noT.length + noM.length + longT.length + longM.length + h1bad.length,
      detail: `${dT.length} duplicate title groups, ${dM.length} duplicate descriptions, ${dHl.length} duplicate H1s. ${noT.length} missing titles, ${noM.length} missing descriptions, ${longT.length} titles over 65 characters, ${longM.length} descriptions over 165, ${h1bad.length} pages without exactly one H1.`,
      why: "Identical titles and headings across many pages are one of the clearest fingerprints of mass-produced pages.", fix: "Give every page a title, description and H1 that names what is specific to that page.",
      pages: [...dT.flat().map((u) => [u, "Duplicate title"]), ...dM.flat().map((u) => [u, "Duplicate description"]), ...dHl.flat().map((u) => [u, "Duplicate H1"]), ...noT.map((p) => [p.u, "Missing title"]), ...h1bad.map((p) => [p.u, `${p.h1s.length} H1 tags`])] });
  }
  // 3. thin content
  { const thin = ok.filter((p) => p.words < 250); const vthin = ok.filter((p) => p.words < 150); thin.forEach((p) => flag(p.u, p.words < 150 ? 3 : 2, `Only ${p.words} words`));
    const share = ok.length ? thin.length / ok.length : 0; const st = vthin.length > 3 || share > 0.05 ? "fail" : thin.length ? "warn" : "pass";
    add({ id: "thin", title: "Thin pages", status: st, count: thin.length, detail: `${thin.length} of ${ok.length} pages have under 250 words (${vthin.length} under 150). Median page is ${[...ok].sort((a, b) => a.words - b.words)[Math.floor(ok.length / 2)]?.words || 0} words.`,
      why: "Pages with little original content, especially in bulk, are treated as low value and can drag down the whole site.", fix: "Add specific, useful content or merge the page into a stronger one. Tool and form pages are fine when they do a real job.", pages: thin.sort((a, b) => a.words - b.words).map((p) => [p.u, `${p.words} words`]) });
  }
  // 4. near-duplicate pages (scaled content)
  const sims = []; let df;
  { df = new Map(); for (const p of ok) for (const s of p.sh) df.set(s, (df.get(s) || 0) + 1);
    // Shingles shared by more than one page (and not on nearly every page) point at candidate pairs; counts are kept one page at a time to keep memory small.
    const cap = Math.max(60, ok.length * 0.06);
    const idx = new Map(); ok.forEach((p, n) => { for (const s of p.sh) { const d = df.get(s); if (d < 2 || d > cap) continue; (idx.get(s) || idx.set(s, []).get(s)).push(n); } });
    const cnt = new Int32Array(ok.length);
    ok.forEach((a, n) => {
      const touched = [];
      for (const s of a.sh) { const l = idx.get(s); if (!l) continue; for (const m of l) if (m > n) { if (cnt[m] === 0) touched.push(m); cnt[m]++; } }
      for (const m of touched) { const c = cnt[m], b = ok[m]; cnt[m] = 0; const j = c / (a.sh.size + b.sh.size - c); if (j > 0.3) sims.push({ a: a.u, b: b.u, j }); }
    });
    sims.sort((x, y) => y.j - x.j);
    const n65 = sims.filter((s) => s.j >= 0.65), n50 = sims.filter((s) => s.j >= 0.5), n40 = sims.filter((s) => s.j >= 0.4);
    n65.forEach((s) => { flag(s.a, 4, `${Math.round(s.j * 100)}% the same as ${s.b}`); flag(s.b, 4, `${Math.round(s.j * 100)}% the same as ${s.a}`); }); n50.filter((s) => s.j < 0.65).forEach((s) => { flag(s.a, 2, `${Math.round(s.j * 100)}% the same as ${s.b}`); flag(s.b, 2, `${Math.round(s.j * 100)}% the same as ${s.a}`); });
    const st = n65.length ? "fail" : n50.length || n40.length > ok.length * 0.08 ? "warn" : "pass";
    add({ id: "dupes", title: "Near-duplicate pages", status: st, weight: 1.6, count: n50.length, detail: `Compared every page with every other. ${n65.length} pairs share 65% or more of their wording, ${n50.length} share 50% or more, ${n40.length} share 40% or more.${sims[0] ? ` Closest pair: ${Math.round(sims[0].j * 100)}%.` : ""}`,
      why: "Google's scaled content abuse policy targets many pages made to look different while saying the same thing. Pages that swap only a place name are the typical case.", fix: "For each flagged pair, replace shared paragraphs with facts that only fit that place or topic, or remove one of the pages.",
      pages: sims.filter((s) => s.j >= 0.4).map((s) => [s.a, `${Math.round(s.j * 100)}% like ${s.b}`]) });
  }
  // 5. large groups of similar pages and doorway risk
  { const groups = new Map(); for (const p of ok) (groups.get(sectionOf(p.u)) || groups.set(sectionOf(p.u), []).get(sectionOf(p.u))).push(p);
    const maxSim = new Map(); for (const s of sims) { maxSim.set(s.a, Math.max(maxSim.get(s.a) || 0, s.j)); maxSim.set(s.b, Math.max(maxSim.get(s.b) || 0, s.j)); }
    const rows = [...groups.entries()].filter(([, l]) => l.length >= 8).map(([g, l]) => ({ g, n: l.length, avgWords: Math.round(l.reduce((a, p) => a + p.words, 0) / l.length), avgMax: l.reduce((a, p) => a + (maxSim.get(p.u) || 0), 0) / l.length }));
    const inGroups = rows.reduce((a, r) => a + r.n, 0), ratio = ok.length ? inGroups / ok.length : 0;
    const bad = rows.filter((r) => r.avgMax > 0.45 || r.avgWords < 300); const st = bad.some((r) => r.avgMax > 0.55 || r.avgWords < 220) ? "fail" : (ratio > 0.7 && rows.length) || bad.length ? "warn" : "pass";
    add({ id: "doorway", title: "Page groups and doorway risk", status: st, weight: 1.6, count: bad.length, detail: `${inGroups} of ${ok.length} pages (${Math.round(ratio * 100)}%) sit in ${rows.length} folders of 8 or more pages (the usual shape of location, service-by-city or product-variation pages)${bad.length ? `; ${bad.map((r) => r.g).join(", ")} look too alike or too short` : ""}.`,
      why: "Doorway pages are many near-identical pages aimed at different places or keywords that funnel to one destination. A site that is mostly template pages draws that review even when each page is honest.", fix: "Keep a page only when it holds facts that matter for that place or topic. Link them from a hub, do not claim offices you do not have, and drop weak ones.",
      pages: rows.sort((a, b) => b.avgMax - a.avgMax).map((r) => [r.g, `${r.n} pages, avg ${r.avgWords} words, avg closest match ${Math.round(r.avgMax * 100)}%`]) });
  }
  // 6. keyword stuffing
  { const prose = ok.filter((p) => p.links.length < 20); const bad = prose.filter((p) => p.words > 120 && p.topWordCount >= 15 && (p.topWordPct > 0.07 || p.topPhrasePct > 0.09)), warn = prose.filter((p) => p.words > 120 && !bad.includes(p) && p.topWordCount >= 10 && (p.topWordPct > 0.055 || p.topPhrasePct > 0.065));
    bad.forEach((p) => flag(p.u, 3, `"${p.topWord}" is ${(p.topWordPct * 100).toFixed(1)}% of the words`)); warn.forEach((p) => flag(p.u, 1, `Heavy repetition of "${p.topWord}"`));
    add({ id: "stuffing", title: "Keyword repetition", status: bad.length ? "fail" : warn.length > 5 ? "warn" : "pass", count: bad.length + warn.length, detail: `${bad.length} pages repeat one word over 7% of their words (or a two-word phrase over 9%). ${warn.length} are borderline: a word over 5.5% or a phrase over 6.5%. Place names on location pages are the usual cause.`,
      why: "Repeating a place or service name far more than natural writing would is keyword stuffing.", fix: "Vary the wording and cut repeated place or service names.", pages: [...bad, ...warn].map((p) => [p.u, `"${p.topWord}" ${(p.topWordPct * 100).toFixed(1)}%, phrase "${p.topPhrase}" ${(p.topPhrasePct * 100).toFixed(1)}%`]) });
  }
  // 7. hidden text and cloaking
  { const hid = ok.filter((p) => p.hidden > 0), cl = extra.cloak.filter((c) => c.diff > 0.08);
    hid.forEach((p) => flag(p.u, 3, "Hidden text in the HTML")); cl.forEach((c) => flag(c.u, 4, `Googlebot sees ${Math.round(c.diff * 100)}% different text`));
    add({ id: "cloak", title: "Hidden text and cloaking", status: hid.length || cl.length ? "fail" : "pass", weight: 1.4, count: hid.length + cl.length, detail: `${hid.length} pages hide text with display:none, zero font size or off-screen positioning. ${extra.cloak.length} pages were fetched as Googlebot and as a visitor, ${cl.length} differed by more than 8%.`,
      why: "Showing search engines text people cannot see, or different pages to crawlers, is a direct spam policy violation.", fix: "Show the same content to everyone. Remove any hidden blocks of text.", pages: [...hid.map((p) => [p.u, `${p.hidden} hidden blocks`]), ...cl.map((c) => [c.u, `${Math.round(c.diff * 100)}% different`])] });
  }
  // 8. reviews, ratings and unproven claims
  { const rev = ok.filter((p) => p.ld.some((t) => /AggregateRating|Review|Rating/.test(t))); rev.forEach((p) => flag(p.u, 4, "Review or rating markup"));
    const cl = []; for (const p of ok) { const hit = []; for (const [re, label] of CLAIMS) { const m = claimHit(re, p.text); if (m) { if (label === "Implies a local office" && extra.ownPlaces && extra.ownPlaces.test(m)) continue; hit.push(`${label}: “…${m}…”`); } } if (hit.length) { cl.push([p.u, hit.join("; ")]); flag(p.u, 2, hit.join("; ")); } }
    add({ id: "claims", title: "Reviews, ratings and unproven claims", status: rev.length ? "fail" : cl.length ? "warn" : "pass", weight: 1.4, count: rev.length + cl.length, detail: `${rev.length} pages carry review or rating markup. ${cl.length} pages use wording such as guarantees, #1 or best, award claims, testimonials or an implied local office.`,
      why: "Self-served review markup, invented testimonials and promises you cannot back up are treated as deceptive. An implied local office in a place you do not have one is a classic local spam flag.", fix: "Remove review markup unless it shows real, third-party reviews you display. Delete superlatives and guarantees. If you work remotely, say so plainly.", pages: [...rev.map((p) => [p.u, "Review or rating markup"]), ...cl] });
  }
  // 9. structured data
  { const bad = ok.filter((p) => p.ldBad); bad.forEach((p) => flag(p.u, 2, "Broken structured data")); const without = ok.filter((p) => !p.ld.length).length;
    add({ id: "schema", title: "Structured data", status: bad.length ? "fail" : "pass", count: bad.length, detail: `${bad.length} pages have JSON-LD that does not parse. ${ok.length - without} pages carry structured data.`, why: "Broken markup is ignored at best, and markup that does not match the page can bring a manual action.", fix: "Fix the JSON, and mark up only what the visible page says.", pages: bad.map((p) => [p.u, "Invalid JSON-LD"]) });
  }
  // 10. internal and outbound links
  { const inbound = new Map(ok.map((p) => [p.u, 0])); for (const p of ok) for (const l of p.allLinks) if (l !== p.u && inbound.has(l)) inbound.set(l, inbound.get(l) + 1);
    const orphans = ok.filter((p) => p.u !== "/" && inbound.get(p.u) === 0); const heavy = ok.filter((p) => p.links.length > 150); const extHeavy = ok.filter((p) => p.ext.length > 8);
    const ext = new Map(); for (const p of ok) for (const e of p.ext) ext.set(e.host, (ext.get(e.host) || 0) + 1);
    const followed = ok.reduce((n, p) => n + p.ext.filter((e) => !/nofollow|sponsored|ugc/.test(e.rel)).length, 0);
    orphans.forEach((p) => flag(p.u, 1, "No links from other pages")); heavy.forEach((p) => flag(p.u, 2, `${p.links.length} links in the content`)); extHeavy.forEach((p) => flag(p.u, 2, `${p.ext.length} outbound links`));
    add({ id: "links", title: "Internal and outbound links", status: heavy.length || extHeavy.length ? "fail" : orphans.length ? "warn" : "pass", count: orphans.length + heavy.length + extHeavy.length, detail: `${orphans.length} pages have no link from any other page. ${heavy.length} pages hold over 150 links, ${extHeavy.length} over 8 outbound links. ${ext.size} outside sites are linked in total (${followed} followed links).`,
      why: "Link-heavy pages and orphaned pages look like link schemes or doorways. Outbound links should be to real sources.", fix: "Link every page from a relevant hub, keep link lists purposeful, and keep outbound links to sources that help the reader.", pages: [...heavy.map((p) => [p.u, `${p.links.length} links`]), ...extHeavy.map((p) => [p.u, `${p.ext.length} outbound`]), ...orphans.map((p) => [p.u, "No inbound content links"])] });
  }
  // 10b. outbound link patterns (Google's link spam policies)
  { const hostPages = new Map(), flaggedLinks = [];
    const SHORT = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|buff\.ly|is\.gd|rebrand\.ly|cutt\.ly)$/i, PAID = /\b(sponsored|advertisement|partner|affiliate|promoted|paid)\b/i;
    for (const p of ok) { const seen = new Set(); for (const e of p.ext) {
      const followed = !/nofollow|sponsored|ugc/i.test(e.rel);
      if (followed && !seen.has(e.host)) { seen.add(e.host); (hostPages.get(e.host) || hostPages.set(e.host, []).get(e.host)).push(p.u); }
      if (SHORT.test(e.host) || /^\d+\.\d+\.\d+\.\d+$/.test(e.host)) flaggedLinks.push([p.u, `Link to ${e.host} (shortener or bare IP)`]);
      else if (followed && PAID.test(e.text)) flaggedLinks.push([p.u, `Followed link labelled “${e.text}” to ${e.host}: paid or affiliate links need rel="sponsored"`]);
    } }
    const sitewide = [...hostPages.entries()].filter(([, l]) => l.length >= Math.max(10, ok.length * 0.25)).sort((a, b) => b[1].length - a[1].length);
    flaggedLinks.forEach(([u, why]) => flag(u, 2, why));
    add({ id: "linkscheme", title: "Outbound links and link schemes", status: flaggedLinks.length ? "fail" : sitewide.length ? "warn" : "pass", weight: 1.2, count: flaggedLinks.length + sitewide.length,
      detail: `${flaggedLinks.length} outbound links look paid, hidden behind a shortener or point to a bare IP. ${sitewide.length} outside sites receive a followed link from a quarter of the site or from 10 or more pages${sitewide.length ? ` (${sitewide.slice(0, 3).map(([h, l]) => `${h} on ${l.length}`).join(", ")})` : ""}.`,
      why: "Google's link spam policy covers buying or selling links that pass ranking credit, large-scale link exchanges, and links placed in bulk. Paid, affiliate and user-submitted links should carry rel=\"sponsored\" or rel=\"ugc\"; a site-wide followed link to one outside site is a common footprint of a link scheme.",
      fix: "Add rel=\"sponsored\" to paid and affiliate links, rel=\"ugc\" to user-submitted ones, and rel=\"nofollow\" to anything you do not vouch for. Replace shorteners with the real address. Remove site-wide links you were paid or asked to place.",
      pages: [...flaggedLinks, ...sitewide.map(([h, l]) => [h, `Followed link on ${l.length} pages`])] });
  }
  // 11. robots and site-wide
  { add({ id: "site", title: "Robots and sitemap", status: extra.robotsOk && extra.sitemapOk ? "pass" : "fail", count: extra.robotsOk && extra.sitemapOk ? 0 : 1, detail: `robots.txt ${extra.robotsOk ? "found and lists the sitemap" : "missing or does not list the sitemap"}. Sitemap holds ${pages.length} URLs${pages.length > 50000 ? " (over the 50,000 limit)" : ""}.`, why: "Search engines need a clean robots.txt and a sitemap that matches the live site.", fix: "Keep Sitemap: in robots.txt and the URL count under 50,000 per file.", pages: [] }); }

  // ---- scoring ----
  const wsum = checks.reduce((a, c) => a + c.weight, 0); const score = Math.round(checks.reduce((a, c) => a + mark(c.status) * c.weight, 0) / wsum);
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  const fails = checks.filter((c) => c.status === "fail").length, warns = checks.filter((c) => c.status === "warn").length;
  const level = fails ? "High" : warns >= 3 ? "Moderate" : "Low";

  // ---- sections ----
  const secs0 = new Map(); for (const p of ok) (secs0.get(sectionOf(p.u)) || secs0.set(sectionOf(p.u), []).get(sectionOf(p.u))).push(p);
  // One-off pages are grouped so the table stays readable.
  const secs = new Map(); for (const [k, l] of secs0) { const key = l.length >= 5 ? k : "Other single pages"; (secs.get(key) || secs.set(key, []).get(key)).push(...l); }
  const maxSim = new Map(); for (const s of sims) { maxSim.set(s.a, Math.max(maxSim.get(s.a) || 0, s.j)); maxSim.set(s.b, Math.max(maxSim.get(s.b) || 0, s.j)); }
  const uniq = (p) => { let n = 0; for (const s of p.sh) if (df.get(s) === 1) n++; return p.sh.size ? n / p.sh.size : 0; };
  const sections = [...secs.entries()].map(([sec, l]) => {
    const worst = Math.max(0, ...l.map((p) => maxSim.get(p.u) || 0)); const avgWords = Math.round(l.reduce((a, p) => a + p.words, 0) / l.length);
    const flagged = l.filter((p) => (risk.get(p.u) || 0) >= 3).length; const pts = (worst >= 0.65 ? 2 : worst >= 0.5 ? 1 : 0) + (avgWords < 250 ? 2 : avgWords < 350 ? 1 : 0) + (flagged / l.length > 0.2 ? 2 : flagged ? 1 : 0);
    return { section: sec, pages: l.length, avgWords, worstOverlap: Math.round(worst * 100), unique: Math.round((l.reduce((a, p) => a + uniq(p), 0) / l.length) * 100), flagged, grade: pts === 0 ? "A" : pts === 1 ? "B" : pts === 2 ? "C" : pts <= 4 ? "D" : "F" };
  }).sort((a, b) => b.pages - a.pages);
  const worstPages = [...risk.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([u, pts]) => ({ u, points: pts, reasons: [...new Set(reasons.get(u))].slice(0, 5) }));
  return { score, grade, level, fails, warns, passes: checks.length - fails - warns, pages: pages.length, words: ok.reduce((a, p) => a + p.words, 0), checks, sections, worstPages, flaggedPages: [...risk.values()].filter((v) => v >= 3).length };
}

/* ---------- the crawl ---------- */
const defaultFetch = (href, o) => fetchOnce(normalizeUrl(href), o);
const locs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/g)].map((m) => dec(m[1]));

// opts: max (pages, default 150), concurrency (default 3), fetch(href, {ua, maxBytes, timeout}) -> {status, headers, body}, ownPlaces (RegExp), onProgress(done, total)
async function audit(input, opts = {}) {
  const start = normalizeUrl(input), origin = start.origin, max = Math.max(1, Math.min(Number(opts.max) || 150, 1000));
  const fetch = opts.fetch || defaultFetch;
  const get = async (path, ua, maxBytes = 800000) => { try { const r = await fetch(new URL(path, origin).href, { ua: ua || UA, maxBytes, timeout: 10000 }); return { status: r.status, headers: r.headers || {}, body: r.body || "" }; } catch { return { status: 0, headers: {}, body: "" }; } };
  const robots = await get("/robots.txt");
  const robotsOk = robots.status === 200 && /sitemap:/i.test(robots.body);
  const listed = robots.status === 200 ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]) : [];
  const sitemapUrls = [...new Set([...listed, origin + "/sitemap.xml"])].filter((u) => { try { return new URL(u).origin === origin; } catch { return false; } }).slice(0, 4);
  let urls = [], sitemapOk = false;
  for (const sm of sitemapUrls) {
    const r = await get(sm, UA, 3000000); if (r.status !== 200) continue;
    let found = locs(r.body);
    if (/<sitemapindex/i.test(r.body)) { const kids = found.filter((u) => { try { return new URL(u).origin === origin; } catch { return false; } }).slice(0, 8); found = []; for (const k of kids) { const c = await get(k, UA, 3000000); if (c.status === 200) found.push(...locs(c.body)); } }
    if (found.length) { urls.push(...found); sitemapOk = true; }
    if (urls.length >= max) break;
  }
  const norm = (u) => { try { const x = new URL(u, origin); return x.origin === origin ? x.pathname + x.search : null; } catch { return null; } };
  let fetchPaths = [...new Set(urls.map(norm).filter(Boolean))];
  let discovered = false;
  if (!fetchPaths.length) {   // no usable sitemap: fall back to what the home page links to
    const home = await get("/"); const pg = readPage(home.body, origin);
    fetchPaths = ["/", ...pg.allLinks].filter((x, i, a) => a.indexOf(x) === i); discovered = true;
  }
  fetchPaths = fetchPaths.slice(0, max);
  const pages = new Array(fetchPaths.length); let done = 0;
  await mapLimit(fetchPaths, opts.concurrency || 3, async (p, i) => {
    const r = await get(p);
    const ct = String(r.headers["content-type"] || "");
    pages[i] = !ct || /html|xml|text/i.test(ct) ? parsePage(p.split("?")[0].replace(/\/+$/, "") || "/", r, origin) : null;
    if (pages[i]) pages[i].fetch = p;
    if (opts.onProgress) opts.onProgress(++done, fetchPaths.length);
  });
  const real = pages.filter(Boolean);
  if (!real.some((p) => p.status === 200)) throw Object.assign(new Error("Could not read any pages from that site, so there is nothing to grade. Check the address and that the site is up."), { user: true });
  const sample = real.filter((p) => p.status === 200).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 12)) === 0).slice(0, 12), cloak = [];
  await mapLimit(sample, 3, async (p) => {
    const r = await get(p.fetch, GOOGLEBOT), q = parsePage(p.u, r, origin);
    const a = new Set(p.text.toLowerCase().split(/\s+/)), b = new Set(q.text.toLowerCase().split(/\s+/)); let same = 0; for (const w of a) if (b.has(w)) same++;
    cloak.push({ u: p.u, diff: r.status === 200 ? 1 - same / Math.max(1, Math.max(a.size, b.size)) : 1 });
  });
  const result = analyze(real, { cloak, robotsOk, sitemapOk, ownPlaces: opts.ownPlaces });
  result.site = origin; result.crawled = real.length; result.discoveredFromHome = discovered; result.cloakSample = cloak.length; result.generatedAt = new Date().toISOString();
  return result;
}

function reportText(r) {
  const mark = { fail: "FIX    ", warn: "IMPROVE", pass: "OK     " };
  const out = [`Spam-policy audit for ${r.site}`, `Score ${r.score}/100 (${r.grade}), spam risk ${r.level}. ${r.crawled} pages read${r.discoveredFromHome ? " (no sitemap found; used links from the home page)" : ""}. ${r.passes} checks pass, ${r.warns} to improve, ${r.fails} to fix.`, "", "A heuristic only: it cannot see Google's own judgement.", ""];
  for (const c of r.checks) { out.push(`[${mark[c.status]}] ${c.title}: ${c.detail}`); if (c.status !== "pass") { out.push(`    Why it matters: ${c.why}`, `    Fix: ${c.fix}`); for (const [u, w] of c.pages.slice(0, 5)) out.push(`      ${u}  ${w}`); } }
  if (r.worstPages.length) { out.push("", "Pages to look at first:"); for (const w of r.worstPages.slice(0, 8)) out.push(`  ${w.u} (${w.points} pts): ${w.reasons.join("; ")}`); }
  return out.join("\n");
}

module.exports = { audit, analyze, parsePage, reportText };
