// Email deliverability checks for cold outreach. Nobody can see inside other people's inboxes, so this combines what CAN be measured:
//   1. Authentication (40%): SPF (including the 10-lookup limit), DKIM, DMARC, MX and the Spamhaus domain blocklist, checked live in DNS.
//   2. Sending health (25%): bounce, opt-out and reply rates from your real sends. Mailbox providers judge you on exactly these.
//   3. Content (20%): spam triggers in the wording of one message (shouting, hype words, link-heavy, fake "Re:", shorteners and so on).
//   4. Inbox placement (15%): optional, from seed-inbox tests you run yourself; pass the results in to combine().
// Open tracking is deliberately not used: tracking pixels hurt placement and are unreliable. Replies are the honest signal.
// Score = weighted average of whichever parts you supply. It is an estimate, not a promise of inbox delivery.
const dnsP = require("dns").promises;

const FREE = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "aol.com", "msn.com", "proton.me", "protonmail.com"]);
const SELECTORS = ["google", "selector1", "selector2", "default", "k1", "k2", "s1", "s2", "mail", "dkim", "smtp", "mandrill", "mxvault", "everlytickey1", "zoho", "protonmail"];
const WEIGHTS = { auth: 40, reputation: 25, content: 20, placement: 15 };
const grade = (n) => (n >= 90 ? "A" : n >= 80 ? "B" : n >= 70 ? "C" : n >= 60 ? "D" : "F");
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
let deps = { resolver: dnsP };
const setDeps = (d) => { deps = { ...deps, ...d }; };   // swap the DNS resolver (tests, custom resolvers)

/* ---------- 1. authentication ---------- */
const txt = async (name) => { try { return (await deps.resolver.resolveTxt(name)).map((a) => a.join("")); } catch { return []; } };
async function spfLookups(record, seen = new Set(), depth = 0) {
  // Counts the DNS lookups a receiver must do for this SPF record. The limit is 10; going over makes SPF fail outright.
  let n = 0;
  for (const part of record.split(/\s+/)) {
    const m = part.match(/^[+\-~?]?(include|a|mx|ptr|exists|redirect)(?:[:=](.+))?$/i); if (!m) continue;
    n++;
    const kind = m[1].toLowerCase();
    if ((kind === "include" || kind === "redirect") && m[2] && depth < 5 && !seen.has(m[2])) {
      seen.add(m[2]);
      const rec = (await txt(m[2])).find((r) => /^v=spf1/i.test(r)); if (rec) n += await spfLookups(rec, seen, depth + 1);
    }
  }
  return n;
}
const mk = (key, label, status, points, max, detail, fix = "") => ({ key, label, status, points, max, detail, fix });

async function checkDomain(domain, { host = "" } = {}) {
  domain = String(domain || "").toLowerCase().trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw Object.assign(new Error("Enter a domain like example.com."), { user: true });
  if (FREE.has(domain)) return { domain, free: true, score: null, grade: "–", checks: [mk("free", "Consumer address", "warn", 0, 0, `${domain} authenticates mail for you, so there is nothing to set up here.`, "Cold email from a free address is capped hard and can get the whole account locked. Use a domain you own (a Google Workspace or Microsoft 365 mailbox on it) for outreach.")] };
  const checks = [];
  // mail records
  let mx = []; try { mx = await deps.resolver.resolveMx(domain); } catch { /* none */ }
  checks.push(mx.length ? mk("mx", "Mail records (MX)", "pass", 5, 5, `Mail for ${domain} goes to ${mx.sort((a, b) => a.priority - b.priority)[0].exchange}.`) : mk("mx", "Mail records (MX)", "fail", 0, 5, "No MX records, so replies and bounces can't reach you.", "Add the MX records your email provider gives you."));
  // SPF
  const spfs = (await txt(domain)).filter((r) => /^v=spf1(\s|$)/i.test(r));
  if (!spfs.length) checks.push(mk("spf", "SPF", "fail", 0, 25, "No SPF record. Receivers can't tell which servers may send for you.", "Add a TXT record on your domain, for example: v=spf1 include:_spf.google.com ~all (Google) or v=spf1 include:spf.protection.outlook.com ~all (Microsoft)."));
  else if (spfs.length > 1) checks.push(mk("spf", "SPF", "fail", 5, 25, `${spfs.length} SPF records found. Only one is allowed; having several makes SPF fail.`, "Merge them into a single v=spf1 record."));
  else {
    const rec = spfs[0], lookups = await spfLookups(rec), policy = (rec.match(/\s([+\-~?])all\b/) || [])[1];
    let pts = 10; const notes = [];
    if (policy === "-" || policy === "~") { pts += policy === "-" ? 5 : 4; notes.push(policy === "-" ? "strict (-all)" : "soft (~all)"); } else notes.push("no -all/~all at the end");
    if (lookups <= 10) pts += 5; else notes.push(`${lookups} lookups (limit is 10)`);
    const prov = /google|gmail/i.test(host) ? /_spf\.google\.com|googlemail/i : /office365|outlook/i.test(host) ? /spf\.protection\.outlook\.com/i : null;
    if (!prov || prov.test(rec)) pts += 5; else notes.push("doesn't include your sending provider");
    checks.push(mk("spf", "SPF", pts >= 22 ? "pass" : pts >= 15 ? "warn" : "fail", pts, 25, `Found. ${notes.join("; ")}.`, pts >= 22 ? "" : "End the record with ~all (or -all), keep it under 10 lookups, and include your email provider's SPF include."));
  }
  // DKIM (we can only try common selector names)
  let dk = "";
  for (const sel of SELECTORS) {
    const name = `${sel}._domainkey.${domain}`;
    const t = (await txt(name)).find((r) => /v=DKIM1|k=rsa|p=/i.test(r));
    let c = []; if (!t) { try { c = await deps.resolver.resolveCname(name); } catch { /* none */ } }
    if (t || c.length) { dk = sel; break; }
  }
  checks.push(dk ? mk("dkim", "DKIM signing", "pass", 25, 25, `A signing key is published (selector “${dk}”).`) : mk("dkim", "DKIM signing", "warn", 8, 25, "No signing key found on the usual selector names. Yours may use a different name.", "In Google Workspace: Admin console → Apps → Gmail → Authenticate email → generate and publish the key, then Start authentication. In Microsoft 365: Defender → Email authentication → DKIM → enable. Then send a test to Gmail and open Show original to confirm DKIM: PASS."));
  // DMARC
  const dm = (await txt(`_dmarc.${domain}`)).find((r) => /^v=DMARC1/i.test(r));
  if (!dm) checks.push(mk("dmarc", "DMARC", "fail", 0, 30, "No DMARC record. Gmail and Yahoo require one for senders.", `Add a TXT record at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:you@${domain}  (start with p=none, move to quarantine once reports look clean).`));
  else {
    const p = ((dm.match(/;\s*p=(\w+)/i) || [])[1] || "").toLowerCase(), rua = /rua=mailto:/i.test(dm);
    const pts = 15 + (p === "quarantine" || p === "reject" ? 10 : 0) + (rua ? 5 : 0);
    checks.push(mk("dmarc", "DMARC", pts >= 25 ? "pass" : "warn", pts, 30, `Policy p=${p || "?"}${rua ? ", reports on" : ", no report address"}.`, pts >= 25 ? "" : `${p === "none" || !p ? "Once your mail passes SPF and DKIM, tighten to p=quarantine. " : ""}${rua ? "" : "Add rua=mailto:an-address-you-read so you get reports about who is sending as you."}`));
  }
  // blocklist (Spamhaus Domain Blocklist). Answers in 127.255.255.x mean the resolver was refused, not that we're clean.
  try {
    const a = await deps.resolver.resolve4(`${domain}.dbl.spamhaus.org`);
    if (a.some((x) => /^127\.255\.255\./.test(x))) checks.push(mk("dbl", "Domain blocklist (Spamhaus)", "info", 5, 10, "Couldn't check: Spamhaus doesn't answer queries from shared resolvers.", `Check by hand at check.spamhaus.org.`));
    else checks.push(mk("dbl", "Domain blocklist (Spamhaus)", "fail", 0, 10, `${domain} is LISTED (${a[0]}).`, "Stop sending, find out why at check.spamhaus.org, and follow their delisting steps."));
  } catch (e) { checks.push(e && e.code === "ENOTFOUND" || e && e.code === "ENODATA" ? mk("dbl", "Domain blocklist (Spamhaus)", "pass", 10, 10, "Not listed.") : mk("dbl", "Domain blocklist (Spamhaus)", "info", 5, 10, "Couldn't check right now.")); }
  // MTA-STS (encrypted delivery); small bonus, never a blocker
  const sts = (await txt(`_mta-sts.${domain}`)).find((r) => /v=STSv1/i.test(r));
  checks.push(sts ? mk("sts", "Encrypted delivery (MTA-STS)", "pass", 5, 5, "Published.") : mk("sts", "Encrypted delivery (MTA-STS)", "info", 0, 5, "Not set up. Optional; a small trust signal.", ""));
  const score = clamp(checks.reduce((a, c) => a + c.points, 0));
  return { domain, free: false, score, grade: grade(score), checks };
}

/* ---------- 3. content ---------- */
const TRIGGERS = ["free", "guarantee", "guaranteed", "act now", "limited time", "winner", "cash", "$$$", "100%", "click here", "urgent", "risk-free", "no obligation", "earn money", "make money", "buy now", "congratulations", "once in a lifetime", "no cost", "double your", "order now", "special promotion", "no credit check", "increase sales"];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|buff\.ly|is\.gd|rebrand\.ly|cutt\.ly)\//i;
function scoreContent(subject, body, { first = true } = {}) {
  subject = String(subject || ""); body = String(body || "");
  const f = []; let s = 100; const dock = (n, level, text, fix) => { s -= n; f.push({ level, text, fix, points: n }); };
  const plain = body.replace(/\{\{[^}]*\}\}/g, "X"), words = plain.split(/\s+/).filter(Boolean);
  if (subject.length > 60) dock(5, "warn", `Subject is ${subject.length} characters.`, "Keep it under 50 so it isn't cut off and doesn't read like a pitch.");
  if (!subject.trim()) dock(15, "bad", "No subject line.", "Write a short, plain subject.");
  const caps = subject.split(/\s+/).filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w));
  if (caps.length) dock(10, "bad", "Subject has ALL-CAPS words.", "Write it like a normal sentence.");
  if (/!/.test(subject)) dock(5, "warn", "Exclamation mark in the subject.", "Remove it.");
  if (first && /^(re|fwd?):/i.test(subject.trim())) dock(15, "bad", "First email starts with a fake “Re:” or “Fwd:”.", "That is deceptive, it is against the CAN-SPAM rules, and filters punish it. Only follow-ups may say Re:.");
  const hay = (subject + " " + plain).toLowerCase();
  const hit = TRIGGERS.filter((t) => new RegExp("(^|[^a-z])" + t.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)").test(hay));
  if (hit.length) dock(Math.min(20, hit.length * 4), hit.length > 2 ? "bad" : "warn", `Spam-style wording: ${hit.slice(0, 5).join(", ")}.`, "Say it plainly, the way you would to one person.");
  const links = (body.match(/https?:\/\/[^\s)]+/gi) || []);
  if (links.length > 2) dock(10, "warn", `${links.length} links in one email.`, "Use one link at most in a cold email.");
  if (links.some((l) => SHORTENERS.test(l))) dock(15, "bad", "A link shortener (bit.ly and similar).", "Use your real website address; shorteners are a classic spam signal.");
  if (links.some((l) => /^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(l))) dock(15, "bad", "A link to a bare IP address.", "Link to your domain.");
  if ((body.match(/!/g) || []).length > 2) dock(5, "warn", "Several exclamation marks.", "One at most.");
  const shout = words.filter((w) => w.length > 3 && w === w.toUpperCase() && /^[A-Z]+$/.test(w));
  if (shout.length >= 3) dock(8, "warn", "Several ALL-CAPS words.", "Use normal capitalisation.");
  if (words.length < 20) dock(5, "warn", `Only ${words.length} words.`, "Very short emails with a link look automated. Aim for 40 to 120 words.");
  if (words.length > 200) dock(8, "warn", `${words.length} words is long for a cold email.`, "Cut it to the one thing you want them to do.");
  if (!/\{\{\s*(first_name|company|city)/.test(body + subject) && first) dock(5, "info", "No personalisation (name, company or city).", "Use {{first_name|there}} or {{company}} so each email isn't identical.");
  if (/<\s*(html|img|table|a\s)/i.test(body)) dock(10, "warn", "HTML in the message.", "Cold email lands better as plain text.");
  s = clamp(s);
  return { score: s, grade: grade(s), words: words.length, findings: f };
}

/* ---------- 2. sending health ---------- */
function reputationOf({ sent, bounced, optouts, replied }) {
  if (sent < 20) return { score: null, label: "Not enough sending yet (needs 20+ emails)", findings: [], rate: { bounce: 0, optout: 0, reply: 0 } };
  const b = bounced / sent, o = optouts / sent, r = replied / sent;
  const bs = b < 0.01 ? 100 : b < 0.02 ? 85 : b < 0.03 ? 60 : b < 0.05 ? 30 : 0, os = o < 0.005 ? 100 : o < 0.01 ? 85 : o < 0.02 ? 55 : 25;
  const f = [];
  if (b >= 0.02) f.push({ level: b >= 0.05 ? "bad" : "warn", text: `${(b * 100).toFixed(1)}% of emails bounced.`, fix: "Bad addresses damage your reputation fast. Only send to leads with a verified website email, and drop any that bounce." });
  if (o >= 0.01) f.push({ level: o >= 0.02 ? "bad" : "warn", text: `${(o * 100).toFixed(1)}% asked to stop.`, fix: "You're reaching people who don't want it. Tighten who you target and soften the first email." });
  if (r < 0.01 && sent >= 100) f.push({ level: "info", text: "Almost nobody is replying.", fix: "Low replies often mean the mail is landing in spam or the offer isn't landing. Run an inbox placement test." });
  return { score: Math.min(bs, os), label: "", findings: f, rate: { bounce: b, optout: o, reply: r } };
}

const placementScore = (results) => { const r = (results || []).filter((x) => x.result === "inbox" || x.result === "spam"); return r.length ? clamp((r.filter((x) => x.result === "inbox").length / r.length) * 100) : null; };

/* ---------- putting it together ---------- */
function combine(parts) {
  let tot = 0, w = 0; const used = {};
  for (const [k, v] of Object.entries(parts)) if (v != null) { tot += v * WEIGHTS[k]; w += WEIGHTS[k]; used[k] = WEIGHTS[k]; }
  const score = w ? clamp(tot / w) : null;
  return { score, grade: score == null ? "–" : grade(score), weights: WEIGHTS, counted: used };
}

module.exports = { checkDomain, scoreContent, reputationOf, placementScore, combine, spfLookups, setDeps, WEIGHTS, grade };
