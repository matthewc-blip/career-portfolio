// One-pass, linear-time HTML reader for the spam audit. It tracks just enough structure (nav/header/footer regions, hidden
// blocks, anchors) to answer the audit's questions, and never looks back, so a hostile page cannot make it quadratic.
const decode = (s) => String(s || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } }).replace(/\s+/g, " ").trim();
function attrs(tag) {
  const out = {}; const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g; let m;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, "").replace(/\/?>$/, "");
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}
const RAW = new Set(["script", "style", "noscript", "svg", "template"]);
const REGION = new Set(["header", "footer", "nav"]);
const HIDE_TAGS = new Set(["div", "span", "p", "section", "ul", "li", "a"]);
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?\b|text-indent\s*:\s*-\d{3,}|left\s*:\s*-\d{4,}/i;
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "source", "area", "base", "col", "embed", "wbr", "param", "track"]);
const MAX_TAGS = 200000, MAX_TAG_LEN = 4000, MAX_LINKS = 5000;

function readPage(html, origin) {
  html = String(html || "");
  const out = { title: "", meta: "", robots: "", canon: "", h1s: [], ld: [], ldBodies: [], links: [], allLinks: [], ext: [], hidden: 0 };
  const text = [];
  let title = "", titleDone = false, h1 = null, skip = null, hid = null, ext = null, tags = 0;
  let i = 0, gtAt = -2;
  const rawClose = (name, from) => { const re = new RegExp(`</${name}\\b`, "ig"); re.lastIndex = from; const m = re.exec(html); return m ? m.index : -1; };
  const path = (u) => u.split("#")[0].split("?")[0].replace(/\/+$/, "") || "/";
  const feed = (t) => {
    if (!skip) text.push(t);
    if (h1 && h1.n < 5000) { h1.buf.push(t); h1.n += t.length; }
    if (hid && hid.n < 20000) { hid.buf.push(t); hid.n += t.length; }
    if (ext && ext.n < 200) { ext.buf.push(t); ext.n += t.length; }
  };
  const closeHid = () => { if (hid && decode(hid.buf.join(" ")).length > 60) out.hidden++; hid = null; };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { feed(html.slice(i)); break; }
    if (lt > i) feed(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); if (e < 0) break; i = e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, lt + 40));
    if (!m) { feed(" "); i = lt + 1; continue; }
    if (gtAt !== -1 && gtAt < lt) gtAt = html.indexOf(">", lt);
    if (gtAt === -1) break;
    if (gtAt - lt > MAX_TAG_LEN) { feed(" "); i = lt + 1; continue; }
    const name = m[2].toLowerCase(), raw = html.slice(lt, gtAt + 1), closing = !!m[1];
    i = gtAt + 1; feed(" ");
    if (++tags > MAX_TAGS) break;
    if (closing) {
      if (name === "h1" && h1) { const t = decode(h1.buf.join(" ")); if (t && out.h1s.length < 50) out.h1s.push(t); h1 = null; }
      if (name === "a" && ext) { ext.entry.text = decode(ext.buf.join(" ")).slice(0, 120); ext = null; }
      if (skip && name === skip.name && --skip.depth <= 0) skip = null;
      if (hid && name === hid.name && --hid.depth <= 0) closeHid();
      continue;
    }
    const selfClose = /\/\s*>$/.test(raw) || VOID.has(name);
    const needAttrs = name === "a" || name === "meta" || name === "link" || name === "script" || HIDE_TAGS.has(name) || name === "html";
    const a = needAttrs ? attrs(raw) : null;
    if (skip && name === skip.name && !selfClose) skip.depth++;
    else if (!skip && REGION.has(name) && !selfClose) skip = { name, depth: 1 };
    if (hid && name === hid.name && !selfClose) hid.depth++;
    else if (!hid && HIDE_TAGS.has(name) && a && HIDDEN_STYLE.test(a.style || "") && !selfClose) hid = { name, depth: 1, buf: [], n: 0 };
    if (name === "title" && !titleDone) {
      titleDone = true; const e = rawClose("title", i);
      if (e >= 0) { title = decode(html.slice(i, Math.min(e, i + 2000))); i = e; }
    } else if (name === "h1" && !selfClose) { h1 = { buf: [], n: 0 };
    } else if (name === "meta" && a) {
      const k = (a.name || "").toLowerCase();
      if (k === "description" && !out.meta) out.meta = decode(a.content || "");
      else if (k === "robots" && !out.robots) out.robots = decode(a.content || "");
    } else if (name === "link" && a) {
      if (/(^|\s)canonical(\s|$)/i.test(a.rel || "") && !out.canon) out.canon = a.href || "";
    } else if (name === "a" && a && a.href !== undefined) {
      const href = String(a.href).trim();
      if (href && !href.startsWith("#") && !/^(mailto:|tel:|sms:|javascript:)/i.test(href) && out.allLinks.length < MAX_LINKS) {
        let internal = null, host = null;
        if (href.startsWith("/") && !href.startsWith("//")) internal = path(href);
        else { try { const u = new URL(href, origin); if (u.origin === origin) internal = path(u.pathname); else if (/^https?:$/.test(u.protocol)) host = u.hostname.replace(/^www\./, ""); } catch { /* bad url */ } }
        if (internal) { out.allLinks.push(internal); if (!skip) out.links.push(internal); }
        else if (host && !skip) { const entry = { host, href: href.slice(0, 300), rel: a.rel || "", text: "" }; out.ext.push(entry); ext = { entry, buf: [], n: 0 }; }
      }
    } else if (RAW.has(name) && !selfClose) {
      const e = rawClose(name, i);
      if (e < 0) break;
      if (name === "script" && a && /application\/ld\+json/i.test(a.type || "") && out.ldBodies.length < 40) out.ldBodies.push(html.slice(i, Math.min(e, i + 200000)));
      i = e;
    }
  }
  closeHid();
  out.title = title;
  out.text = decode(text.join(" "));
  out.links = [...new Set(out.links)]; out.allLinks = [...new Set(out.allLinks)];
  let bad = 0;
  const walk = (o, d = 0) => { if (!o || typeof o !== "object" || d > 12) return; if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1)); if (o["@type"]) out.ld.push([].concat(o["@type"]).join(",")); Object.values(o).forEach((v) => typeof v === "object" && walk(v, d + 1)); };
  for (const b of out.ldBodies) { try { walk(JSON.parse(b)); } catch { bad++; } }
  out.ldBad = bad; delete out.ldBodies;
  return out;
}
module.exports = { readPage, decode };
