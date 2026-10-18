#!/usr/bin/env node
"use strict";
const fs = require("fs");
const { seo, resume, ghost, spamAudit, emailSpam } = require("../lib");
const USAGE = `free-seo-resume-tools

  node bin/cli.js seo <url> [--json]
      On-page SEO basics check for one public page.
  node bin/cli.js resume <resume.txt> [--job <posting.txt>] [--json]
      Resume check (rules, no AI) and, with --job, which posting keywords your resume never says.
  node bin/cli.js ghost <posting.txt> [--company "Name"] [--url <posting url>] [--posted "12 days ago"] [--json]
      Is this job posting likely not a real, open job?
  node bin/cli.js spam-audit <url> [--max 150] [--json]
      Google spam-policy audit of a whole site you own: duplicate and thin pages, doorway groups, hidden text,
      cloaking, review markup, link schemes and more.
  node bin/cli.js email <message.txt> [--subject "..."] [--followup] [--json]
      Spam-trigger grade for one cold email (the first line "Subject: ..." is used if --subject is not given).
  node bin/cli.js domain <yourdomain.com> [--json]
      Email authentication check: SPF, DKIM, DMARC, MX, blocklist.`;

const args = process.argv.slice(2), cmd = args.shift();
const flag = (n) => { const i = args.indexOf("--" + n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n) => { const i = args.indexOf("--" + n); if (i < 0) return false; args.splice(i, 1); return true; };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { console.error("Cannot read " + p); process.exit(2); } };
const mark = { fail: "FIX    ", warn: "IMPROVE", pass: "OK     " };

(async () => {
  const json = bool("json");
  if (cmd === "seo" && args[0]) {
    const r = await seo.check(args[0]);
    return console.log(json ? JSON.stringify(r, null, 2) : seo.reportText(r));
  }
  if (cmd === "resume" && args[0]) {
    const job = flag("job"), text = read(args[0]);
    const r = resume.check(text), k = job ? resume.keywords(text, read(job)) : null;
    if (json) return console.log(JSON.stringify({ check: r, keywords: k }, null, 2));
    console.log(`Resume score: ${r.score}/100 (${r.grade}), ${r.words} words, ${r.bullets} bullets\n`);
    for (const i of r.items) console.log(`[${mark[i.status]}] ${i.label}: ${i.tip}`);
    if (k) console.log(`\nKeyword match: ${k.pct}% (${k.present.length} of ${k.total})\n  Present: ${k.present.join(", ") || "none"}\n  Missing: ${k.missing.join(", ") || "none"}\n  Add a missing word only if it is true for you.`);
    return;
  }
  if (cmd === "ghost" && args[0]) {
    const company = flag("company") || "", url = flag("url") || "", posted = flag("posted") || "";
    const r = ghost.grade({ posting: read(args[0]), company, url, posted });
    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(`Ghost-job risk: ${r.level} (${r.score}/100), ${r.label}`);
    r.reasons.forEach((x) => console.log("  - " + x));
    r.good.forEach((x) => console.log("  + " + x));
    console.log("\nAn estimate from the posting text only. Nobody outside the company can see whether it is truly hiring.");
    return;
  }
  if (cmd === "spam-audit" && args[0]) {
    const max = flag("max");
    const r = await spamAudit.audit(args[0], { max: max ? Number(max) : 150, onProgress: json ? null : (d, t) => process.stderr.write(`\rReading pages ${d}/${t}`) });
    if (!json) process.stderr.write("\n");
    return console.log(json ? JSON.stringify(r, null, 2) : spamAudit.reportText(r));
  }
  if (cmd === "email" && args[0]) {
    let body = read(args[0]), subject = flag("subject");
    const m = /^subject:\s*(.*)\r?\n/i.exec(body); if (m) { if (subject == null) subject = m[1]; body = body.slice(m[0].length); }
    const r = emailSpam.scoreContent(subject || "", body, { first: !bool("followup") });
    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(`Content grade: ${r.grade} (${r.score}/100), ${r.words} words`);
    if (!r.findings.length) console.log("No spam-style problems found.");
    for (const f of r.findings) console.log(`[${f.level === "bad" ? "FIX    " : f.level === "warn" ? "IMPROVE" : "NOTE   "}] ${f.text} ${f.fix}`);
    return;
  }
  if (cmd === "domain" && args[0]) {
    const r = await emailSpam.checkDomain(args[0]);
    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(r.score == null ? `${r.domain}: not scored` : `${r.domain}: ${r.grade} (${r.score}/100)`);
    for (const c of r.checks) console.log(`[${c.status.toUpperCase().padEnd(4)}] ${c.label}: ${c.detail}${c.fix ? "\n        Fix: " + c.fix : ""}`);
    return;
  }
  console.log(USAGE); process.exit(cmd ? 2 : 0);
})().catch((e) => { console.error(e.user ? e.message : "Error: " + e.message); process.exit(1); });
