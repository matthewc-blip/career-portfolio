// Free on-page SEO basics checker. Fetches one public page (safely), reads what is actually in the HTML,
// and reports plain-English findings. It checks technical basics only: it does not know rankings or traffic,
// and the score is never presented as a prediction of either.
const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");

const UA = "FreeSEOTools/1.0 (+https://github.com/matthewc-blip/free-seo-resume-tools)";
const MAX_BYTES = 1500000, TIMEOUT_MS = 8000, MAX_REDIRECTS = 4;

/* ---------- safe fetching (no private networks, validated at connect time) ---------- */
function ipv4ToInt(ip) { return ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }
const V4_BLOCKED = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]];
function blockedV4(ip) {
  // Test-only: lets the test suite fetch from 127.0.0.1. Never active unless NODE_ENV is "test".
  if (process.env.NODE_ENV === "test" && process.env.SEO_CHECKER_ALLOW_LOOPBACK === "1" && ip.startsWith("127.")) return false;
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => { const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (n & mask) === (ipv4ToInt(base) & mask); });
}
function blockedIp(ip) {
  if (net.isIPv4(ip)) return blockedV4(ip);
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blockedV4(mapped[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); return blockedV4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
    return l === "::" || l === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(l) || l.startsWith("64:ff9b") || l.startsWith("2001:db8");
  }
  return true;
}
// Used as the socket's `lookup`, so the address that was checked is the address that is connected to.
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs || []).filter((a) => !blockedIp(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(Object.assign(new Error("blocked"), { code: "EBLOCKED" }));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function normalizeUrl(input) {
  let s = String(input || "").trim();
  if (!s || s.length > 300) throw userErr("Enter your website address, like example.com.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { throw userErr("That doesn't look like a website address."); }
  if (!["http:", "https:"].includes(u.protocol)) throw userErr("Only http and https addresses can be checked.");
  if (u.username || u.password) throw userErr("Remove the login details from the address.");
  if (u.port && !["80", "443"].includes(u.port)) throw userErr("Only standard web ports can be checked.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) { if (blockedIp(host)) throw userErr("That address can't be checked."); }
  else if (!host.includes(".") || /\.(local|localhost|internal|lan|home|corp|test|invalid)$/i.test(host)) throw userErr("Enter a public website address, like example.com.");
  u.hash = "";
  return u;
}
function userErr(message) { return Object.assign(new Error(message), { user: true }); }

function fetchOnce(u, opts = {}) {
  const { maxBytes = MAX_BYTES, timeout = TIMEOUT_MS } = opts;
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const started = Date.now();
    const req = lib.request(u, { method: "GET", lookup: safeLookup, timeout, headers: { "User-Agent": (opts && opts.ua) || UA, Accept: "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5", "Accept-Encoding": "identity" } }, (res) => {
      const chunks = []; let size = 0, done = false;
      const finish = (truncated) => { if (done) return; done = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - started, bytes: size, truncated }); };
      res.on("data", (c) => { size += c.length; if (size <= maxBytes) chunks.push(c); else { finish(true); req.destroy(); } });
      res.on("end", () => finish(false));
      res.on("error", () => finish(false));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })));
    req.on("error", reject);
    req.end();
  });
}

async function safeFetch(startUrl, opts) {
  let u = startUrl; const hops = [];
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await fetchOnce(u, opts);
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      let next;
      try { next = new URL(r.headers.location, u); } catch { throw userErr("The site redirected to an invalid address."); }
      hops.push({ from: u.href, to: next.href, status: r.status });
      next.hash = "";
      u = normalizeUrl(next.href);
      continue;
    }
    return { ...r, finalUrl: u, hops };
  }
  throw userErr("The site redirected too many times.");
}

/* ---------- HTML reading (regex-based, deliberately small) ---------- */
const decode = (s) => String(s || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } }).replace(/\s+/g, " ").trim();
function attrs(tag) {
  const out = {}; const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g; let m;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, "").replace(/\/?>$/, "");
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}
// One linear pass over the HTML. The earlier version ran several regexes that rescan to the end of the page for every
// unclosed tag, which is quadratic: a hostile 1.5 MB page froze the whole server for minutes. Nothing here looks back,
// and every search resumes from a cached position, so the work is proportional to the page size.
const MAX_TAGS = 30000, MAX_TAG_LEN = 4000;
function scan(html) {
  const tagList = [], text = [], h1s = [], ldBodies = [];
  let title = "", titleDone = false, h2Count = 0;
  let i = 0, gtAt = -2, h1CloseAt = -2;
  const rawClose = (name, from) => { const re = new RegExp(`</${name}\\b`, "ig"); re.lastIndex = from; const m = re.exec(html); return m ? m.index : -1; };
  const RAW = new Set(["script", "style", "noscript", "svg", "template"]);
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { text.push(html.slice(i)); break; }
    if (lt > i) text.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); if (e < 0) break; i = e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, lt + 40));
    if (!m) { text.push(" "); i = lt + 1; continue; }
    if (gtAt !== -1 && gtAt < lt) gtAt = html.indexOf(">", lt); // -1 means there is no ">" anywhere after this point
    if (gtAt === -1) break;
    if (gtAt - lt > MAX_TAG_LEN) { text.push(" "); i = lt + 1; continue; }
    const name = m[2].toLowerCase(), raw = html.slice(lt, gtAt + 1);
    i = gtAt + 1; text.push(" ");
    if (m[1]) continue; // closing tags are not needed
    if (tagList.length < MAX_TAGS) tagList.push({ name, raw, at: lt });
    if (name === "h2") h2Count++;
    if (name === "title" && !titleDone && lt < 200000) {
      titleDone = true; const e = rawClose("title", i);
      if (e >= 0) { title = decode(html.slice(i, Math.min(e, i + 2000))); i = e; }
    } else if (name === "h1") {
      if (h1CloseAt !== -1 && h1CloseAt < i) h1CloseAt = rawClose("h1", i);
      if (h1CloseAt >= 0 && h1CloseAt - i < 5000 && h1s.length < 50) { const t = decode(html.slice(i, h1CloseAt).replace(/<[^>]+>/g, " ")); if (t) h1s.push(t); }
    } else if (RAW.has(name) && !/\/\s*>$/.test(raw)) {
      const e = rawClose(name, i);
      if (e < 0) break; // an unclosed script or style swallows the rest of the page, as in a browser
      if (name === "script" && /application\/ld\+json/i.test(raw) && ldBodies.length < 40) ldBodies.push(html.slice(i, Math.min(e, i + 200000)));
      i = e;
    }
  }
  return { tagList, text: text.join(" "), title, h1s, h2Count, ldBodies };
}
function jsonLdTypes(bodies) {
  const types = new Set(); let valid = 0, invalid = 0;
  const walk = (o, d = 0) => { if (!o || typeof o !== "object" || d > 12) return; if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1)); const t = o["@type"]; if (t) [].concat(t).forEach((x) => types.add(String(x))); Object.values(o).forEach((v) => typeof v === "object" && walk(v, d + 1)); };
  for (const b of bodies) { try { walk(JSON.parse(b)); valid++; } catch { invalid++; } }
  return { types: [...types], valid, invalid };
}
function parsePage(html) {
  const sc = scan(String(html || ""));
  const by = (n) => sc.tagList.filter((t) => t.name === n);
  const A = (n) => by(n).map((t) => ({ ...attrs(t.raw), __at: t.at }));
  const meta = (key, prop = "name") => { for (const a of A("meta")) if ((a[prop] || "").toLowerCase() === key) return decode(a.content || ""); return null; };
  const bodyText = decode(sc.text);
  const imgs = A("img"), links = A("a"), linkTags = A("link");
  const htmlTag = (by("html")[0] || { raw: "" }).raw;
  const canon = linkTags.find((a) => (a.rel || "").toLowerCase().split(/\s+/).includes("canonical"));
  const icon = linkTags.find((a) => /(^|\s)(shortcut\s+)?icon(\s|$)/i.test(a.rel || ""));
  const scripts = A("script");
  const http = (v) => /^http:\/\//i.test(v || "");
  return {
    title: sc.title,
    description: meta("description"),
    viewport: meta("viewport"),
    robotsMeta: meta("robots") || "",
    ogTitle: meta("og:title", "property"), ogImage: meta("og:image", "property"), ogDesc: meta("og:description", "property"),
    h1s: sc.h1s, h2Count: sc.h2Count,
    words: bodyText ? bodyText.split(" ").length : 0,
    imgs: imgs.length, imgsNoAlt: imgs.filter((a) => a.alt === undefined).length,
    lang: attrs(htmlTag).lang || "",
    canonical: canon ? canon.href || "" : "",
    icon: !!icon,
    ld: jsonLdTypes(sc.ldBodies),
    links: links.length,
    tel: links.some((a) => /^tel:/i.test(a.href || "")),
    mailto: links.some((a) => /^mailto:/i.test(a.href || "")),
    mixed: [...imgs, ...scripts, ...A("iframe"), ...A("source"), ...A("video"), ...A("audio")].filter((a) => http(a.src)).length
      + linkTags.filter((a) => /stylesheet/i.test(a.rel || "") && http(a.href)).length,
    renderBlockingScripts: scripts.filter((a) => a.__at < 200000 && a.src && !("async" in a) && !("defer" in a) && (a.type || "").toLowerCase() !== "module").length,
  };
}

/* ---------- checks ---------- */
const LOCAL_TYPES = /LocalBusiness|ProfessionalService|Organization|Notary|LegalService|AccountingService|Attorney|Store|Restaurant|Dentist|Physician|HomeAndConstructionBusiness|RealEstateAgent|AutoRepair|Electrician|Plumber/i;
function runChecks(ctx) {
  const { p, finalUrl, resp, robots, sitemap, ms } = ctx;
  const out = [];
  const add = (group, label, status, detail, fix, weight = 1) => out.push({ group, label, status, detail, fix: status === "pass" ? "" : fix, weight });

  // Search appearance
  const tl = p.title.length;
  if (!tl) add("Search appearance", "Page title", "fail", "No title was found.", "Add a <title> that says what the page is and where, like \"Emergency Plumber in Springfield, NJ | Your Business\".", 3);
  else if (tl < 25) add("Search appearance", "Page title", "warn", `Your title is short (${tl} characters): "${p.title}".`, "Use about 50 to 60 characters and include what you do and the town you serve.", 3);
  else if (tl > 65) add("Search appearance", "Page title", "warn", `Your title is ${tl} characters, so Google will likely cut it off.`, "Trim it to about 60 characters and put the important words first.", 3);
  else add("Search appearance", "Page title", "pass", `${tl} characters: "${p.title}".`, "", 3);

  const dl = (p.description || "").length;
  if (!p.description) add("Search appearance", "Meta description", "fail", "No meta description was found.", "Write a 120 to 160 character summary that tells people why to click. Google may rewrite it, but a good one often gets used.", 2);
  else if (dl < 70) add("Search appearance", "Meta description", "warn", `Your description is short (${dl} characters).`, "Aim for 120 to 160 characters with what you offer, where, and a reason to call or book.", 2);
  else if (dl > 175) add("Search appearance", "Meta description", "warn", `Your description is ${dl} characters, so the end will probably be cut off.`, "Trim to about 155 characters and keep the key point first.", 2);
  else add("Search appearance", "Meta description", "pass", `${dl} characters.`, "", 2);

  if (p.h1s.length === 1) add("Search appearance", "One main heading (H1)", "pass", `"${p.h1s[0].slice(0, 90)}"`, "", 2);
  else if (!p.h1s.length) add("Search appearance", "One main heading (H1)", "fail", "No H1 heading was found.", "Add one H1 that says what the page is about, in plain words people would search for.", 2);
  else add("Search appearance", "One main heading (H1)", "warn", `${p.h1s.length} H1 headings were found.`, "Use a single H1 and make the other headings H2 or H3.", 1);

  if (p.canonical) add("Search appearance", "Canonical tag", "pass", "A canonical address is set.", "", 1);
  else add("Search appearance", "Canonical tag", "warn", "No canonical tag was found.", "Add <link rel=\"canonical\"> pointing to the preferred address, so duplicate versions of the page don't split your ranking signals.", 1);

  // Can Google see it
  const noindex = /noindex/i.test(p.robotsMeta) || /noindex/i.test(resp.headers["x-robots-tag"] || "");
  add("Can Google find it", "Allowed to be indexed", noindex ? "fail" : "pass", noindex ? "This page tells search engines not to index it (noindex)." : "No noindex instruction found.", "Remove the noindex tag or header if you want this page to appear in search.", 4);
  add("Can Google find it", "Secure connection (HTTPS)", finalUrl.protocol === "https:" ? "pass" : "fail", finalUrl.protocol === "https:" ? "The page loads over HTTPS." : "The page loads over plain HTTP.", "Install an SSL certificate (most hosts include one free) and redirect all http:// traffic to https://.", 3);
  if (robots.status === "ok") {
    add("Can Google find it", "robots.txt", robots.blocksAll ? "fail" : "pass", robots.blocksAll ? "robots.txt blocks all crawlers from the whole site." : "robots.txt exists and doesn't block the whole site.", "Remove the \"Disallow: /\" line for all user agents unless the site is meant to be hidden.", robots.blocksAll ? 4 : 1);
  } else add("Can Google find it", "robots.txt", "warn", "No robots.txt file was found.", "Add a simple robots.txt that points to your sitemap. It's not required, but it's standard.", 1);
  if (sitemap.status === "ok") add("Can Google find it", "XML sitemap", "pass", "A sitemap was found.", "", 2);
  else add("Can Google find it", "XML sitemap", "warn", "No sitemap was found at /sitemap.xml.", "Publish a sitemap listing your pages and submit it in Google Search Console.", 2);
  add("Can Google find it", "Page loads successfully", resp.status >= 200 && resp.status < 300 ? "pass" : "fail", `The page answered with status ${resp.status}.`, "Fix the error so the page returns a normal 200 response.", 4);
  if (p.lang) add("Can Google find it", "Language declared", "pass", `lang="${p.lang}"`, "", 1);
  else add("Can Google find it", "Language declared", "warn", "The <html> tag has no lang attribute.", "Add lang=\"en\" (or your language) to the <html> tag.", 1);

  // Content
  if (p.words >= 300) add("Content", "Enough text to be useful", "pass", `About ${p.words} words of visible text.`, "", 2);
  else if (p.words >= 150) add("Content", "Enough text to be useful", "warn", `About ${p.words} words of visible text.`, "Thin pages struggle to rank. Add the questions customers actually ask, your service area and what makes you different, in your own words.", 2);
  else add("Content", "Enough text to be useful", "fail", `Only about ${p.words} words of visible text were found.`, "Add real content: what you do, who it's for, where you work, prices or ranges, and answers to common questions. If the page builds its text with scripts, search engines may see less of it.", 2);
  if (p.imgs === 0) add("Content", "Image descriptions (alt text)", "pass", "No images found to describe.", "", 1);
  else if (p.imgsNoAlt === 0) add("Content", "Image descriptions (alt text)", "pass", `All ${p.imgs} ${p.imgs === 1 ? "image has" : "images have"} alt text.`, "", 1);
  else add("Content", "Image descriptions (alt text)", p.imgsNoAlt > p.imgs / 2 ? "fail" : "warn", `${p.imgsNoAlt} of ${p.imgs} ${p.imgs === 1 ? "image has" : "images have"} no alt attribute.`, "Describe each meaningful image in a few words. It helps screen readers and image search.", 1);
  add("Content", "Subheadings (H2)", p.h2Count >= 2 ? "pass" : "warn", `${p.h2Count} H2 subheadings found.`, "Break the page into sections with clear H2 headings so people and search engines can scan it.", 1);

  // Mobile and speed
  add("Mobile and speed", "Mobile viewport tag", p.viewport ? "pass" : "fail", p.viewport ? "The page is set up for mobile screens." : "No viewport tag was found.", "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> so phones don't show a shrunken desktop page. Most searches happen on phones.", 3);
  const kb = Math.round(ctx.htmlBytes / 1024);
  add("Mobile and speed", "Page code size", kb <= 300 ? "pass" : kb <= 800 ? "warn" : "fail", `The HTML is about ${kb} KB.`, "Large pages load slowly on phones. Remove unused code and heavy page-builder bloat.", 1);
  add("Mobile and speed", "Server response", ms <= 1200 ? "pass" : ms <= 3000 ? "warn" : "fail", `The page took about ${(ms / 1000).toFixed(1)} seconds to arrive (measured from our server).`, "Slow responses usually mean cheap hosting, no caching, or a heavy theme. Ask your host about caching or a faster plan.", 2);
  add("Mobile and speed", "Scripts that block loading", p.renderBlockingScripts <= 3 ? "pass" : "warn", p.renderBlockingScripts ? `${p.renderBlockingScripts} scripts load before the page can show.` : "No blocking scripts found in the page head.", "Add defer or async to scripts that aren't needed to show the first screen.", 1);
  if (finalUrl.protocol !== "https:") { /* not applicable on plain HTTP; the HTTPS check covers it */ }
  else if (p.mixed) add("Mobile and speed", "No insecure content", "warn", `${p.mixed} resources are loaded over plain http://.`, "Change those links to https:// so browsers don't show security warnings.", 1);
  else add("Mobile and speed", "No insecure content", "pass", "No insecure resources found.", "", 1);

  // Local and trust
  const localLd = p.ld.types.some((t) => LOCAL_TYPES.test(t));
  add("Local and trust", "Business structured data", localLd ? "pass" : "warn", localLd ? `Structured data found: ${p.ld.types.slice(0, 4).join(", ")}.` : (p.ld.types.length ? `Structured data found (${p.ld.types.slice(0, 3).join(", ")}) but nothing describing a local business.` : "No structured data (JSON-LD) found."), "Add LocalBusiness (or a more specific type) markup with your name, address or service area, phone and hours. It helps Google understand who you are.", 2);
  if (p.ld.invalid) add("Local and trust", "Structured data is valid JSON", "fail", `${p.ld.invalid} structured data block(s) couldn't be read.`, "Fix the syntax errors in your JSON-LD, then test it in Google's Rich Results Test.", 1);
  add("Local and trust", "Tap-to-call phone link", p.tel ? "pass" : "warn", p.tel ? "A tap-to-call phone link was found." : "No tap-to-call link found.", "Make your phone number a tel: link so mobile visitors can call with one tap.", 1);
  add("Local and trust", "Contact method visible", p.tel || p.mailto ? "pass" : "warn", p.tel || p.mailto ? "A phone or email link is on the page." : "No phone or email link found on this page.", "Put a phone number or email link where visitors can see it without searching.", 1);
  add("Local and trust", "Favicon", p.icon ? "pass" : "warn", p.icon ? "A favicon is set." : "No favicon link found.", "Add a small site icon. It shows next to your name in browser tabs and some search results.", 1);

  // Sharing
  const og = !!(p.ogTitle && p.ogImage);
  add("Sharing", "Social preview (Open Graph)", og ? "pass" : "warn", og ? "Title and image are set for link previews." : "Link previews will look plain or empty when the page is shared.", "Add og:title, og:description and og:image tags so shared links show a proper card.", 1);
  return out;
}

function scoreOf(checks) {
  let got = 0, max = 0;
  for (const c of checks) { max += c.weight; got += c.status === "pass" ? c.weight : c.status === "warn" ? c.weight * 0.5 : 0; }
  return max ? Math.round((got / max) * 100) : 0;
}

async function readAux(origin, path, validate) {
  try {
    const r = await safeFetch(new URL(path, origin), { maxBytes: 300000, timeout: 5000 });
    if (r.status !== 200) return { status: "missing" };
    return validate(r.body) ? { status: "ok", body: r.body } : { status: "missing" };
  } catch { return { status: "missing" }; }
}

async function check(input) {
  const start = normalizeUrl(input);
  let resp;
  try { resp = await safeFetch(start); }
  catch (e) {
    if (e.user) throw e;
    if (e.code === "EBLOCKED") throw userErr("That address can't be checked.");
    if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") throw userErr("We couldn't find that website. Check the spelling.");
    if (e.code === "ETIMEOUT" || e.code === "ECONNRESET") throw userErr("The site took too long to answer. Try again in a minute.");
    if (/certificate|SSL|TLS|self.signed|EPROTO/i.test(String(e.code || e.message))) throw userErr("The site's security certificate has a problem, which is itself something to fix.");
    throw userErr("We couldn't load that page.");
  }
  const ctype = String(resp.headers["content-type"] || "");
  if (!/html|xml|text\/plain/i.test(ctype)) throw userErr("That address isn't a web page.");
  const origin = resp.finalUrl.origin;
  const [robotsR, sitemapR] = await Promise.all([
    readAux(origin, "/robots.txt", (b) => /user-agent|sitemap|disallow|allow/i.test(b) && !/<html/i.test(b.slice(0, 500))),
    readAux(origin, "/sitemap.xml", (b) => /<urlset|<sitemapindex/i.test(b)),
  ]);
  let blocksAll = false;
  if (robotsR.status === "ok") {
    let applies = false;
    for (const line of robotsR.body.split(/\r?\n/)) {
      const l = line.replace(/#.*/, "").trim();
      if (/^user-agent\s*:/i.test(l)) applies = /:\s*\*\s*$/.test(l);
      else if (applies && /^disallow\s*:\s*\/\s*$/i.test(l)) blocksAll = true;
    }
  }
  const p = parsePage(resp.body);
  const checks = runChecks({ p, finalUrl: resp.finalUrl, resp, robots: { ...robotsR, blocksAll }, sitemap: sitemapR, ms: resp.ms, htmlBytes: resp.bytes });
  const counts = { pass: 0, warn: 0, fail: 0 };
  checks.forEach((c) => counts[c.status]++);
  return {
    url: resp.finalUrl.href, requested: start.href, redirected: resp.hops.length > 0, score: scoreOf(checks), counts,
    checks: checks.map(({ group, label, status, detail, fix }) => ({ group, label, status, detail, fix })),
    truncated: resp.truncated,
  };
}

// Plain-text report for emails.
function reportText(r) {
  const order = { fail: 0, warn: 1, pass: 2 };
  const mark = { fail: "FIX", warn: "IMPROVE", pass: "OK" };
  const lines = [`Basics check for ${r.url}`, `Score: ${r.score}/100 (${r.counts.pass} passing, ${r.counts.warn} to improve, ${r.counts.fail} to fix)`, "", "This checks technical on-page basics only. It doesn't measure rankings, traffic or content quality.", ""];
  for (const c of [...r.checks].sort((a, b) => order[a.status] - order[b.status])) {
    lines.push(`[${mark[c.status]}] ${c.label}: ${c.detail}`);
    if (c.fix) lines.push(`    How to fix: ${c.fix}`);
  }
  return lines.join("\n");
}

module.exports = { check, normalizeUrl, blockedIp, safeFetch, fetchOnce, parsePage, runChecks, scoreOf, reportText };
