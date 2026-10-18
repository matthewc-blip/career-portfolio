// Free resume check and ATS keyword check. Both are plain rules with no AI, so they cost nothing to run.
// They are estimates: they find common problems that get a resume skipped, and they never write or add anything.
const words = (t) => String(t).split(/\s+/).filter(Boolean);
const VERBS = new Set("achieved administered analyzed answered arranged assembled assisted audited balanced built calculated cared carried cleaned coached collected communicated completed composed conducted contributed controlled coordinated created cut decreased delivered demonstrated designed developed directed distributed documented drove earned edited enforced ensured established evaluated executed expanded filed fixed followed generated greeted guided handled helped hired identified implemented improved increased informed initiated inspected installed instructed interviewed launched led learned maintained managed measured mentored monitored negotiated observed operated opened organized oversaw packed performed planned prepared presented prevented processed produced programmed promoted provided purchased raised received recorded recruited reduced repaired reported researched resolved restocked reviewed scheduled served sold solved sorted staffed started stocked streamlined supervised supported taught tracked trained translated updated used verified volunteered wrote".split(" "));
const WEAK = /\b(responsible for|duties (included|include)|worked on|helped with|various (tasks|duties)|assisted with|in charge of|tasked with|participated in|familiar with)\b/gi;
const FLUFF = /\b(hard[- ]?working|team player|detail[- ]oriented|results[- ]driven|go[- ]getter|self[- ]starter|passionate|synergy|think outside the box|dynamic|motivated individual|people person|excellent communication skills)\b/gi;
const SECTION = { experience: /^(work |professional |relevant )?(experience|employment|work history)\b/im, education: /^education\b|^(education|training) (and|&)/im, skills: /^(technical |core |key )?skills\b|^skills (and|&)/im };
const bulletsOf = (t) => String(t).split("\n").map((l) => l.trim()).filter((l) => /^[-•*·▪●◦‣]\s+/.test(l)).map((l) => l.replace(/^[-•*·▪●◦‣]\s+/, ""));

function check(text) {
  const t = String(text || ""), w = words(t), n = w.length, items = [];
  const bullets = bulletsOf(t);
  const add = (id, label, status, tip, pts) => items.push({ id, label, status, tip, pts });
  const email = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.exec(t), phone = /(\+?1[ -.]?)?\(?\d{3}\)?[ -.]?\d{3}[ -.]?\d{4}/.test(t);
  add("contact", "Contact details", email && phone ? "pass" : email || phone ? "warn" : "fail", email && phone ? "Email and phone are both there." : email ? "Add a phone number." : phone ? "Add an email address." : "Add an email address and phone number at the top.", 12);
  if (email && /\b(sexy|baby|princess|420|xx|hottie|gamer|ninja|cutie|rockstar)\b/i.test(email[0])) add("email", "Professional email", "warn", "Your email address looks informal. Use one built from your name.", 4);
  else add("email", "Professional email", email ? "pass" : "warn", email ? "Your email looks professional." : "No email to check.", 4);
  add("length", "Right length", n >= 180 && n <= 750 ? "pass" : n >= 100 && n <= 950 ? "warn" : "fail", n < 180 ? `Only about ${n} words. Add detail about what you did.` : n > 750 ? `About ${n} words is long. Aim for one page, two at most.` : `About ${n} words. Good.`, 10);
  const secs = Object.entries(SECTION).filter(([, r]) => r.test(t)).map(([k]) => k);
  add("sections", "Clear sections", secs.length >= 3 ? "pass" : secs.length === 2 ? "warn" : "fail", secs.length >= 3 ? "Experience, education and skills are easy to find." : `Use plain headings an applicant tracking system reads: Experience, Education, Skills.${secs.length ? " Missing: " + ["experience", "education", "skills"].filter((x) => !secs.includes(x)).join(", ") + "." : ""}`, 12);
  add("bullets", "Bullet points", bullets.length >= 6 ? "pass" : bullets.length >= 3 ? "warn" : "fail", bullets.length >= 6 ? `${bullets.length} bullets. Good.` : "Describe your work in short bullet points, each starting with what you did.", 10);
  const first = (b) => String(b.split(/\s+/)[0] || "").toLowerCase().replace(/[^a-z]/g, "");
  const strong = bullets.filter((b) => VERBS.has(first(b)) || VERBS.has(first(b).replace(/ed$|d$/, "") + "ed")).length;
  const vr = bullets.length ? strong / bullets.length : 0;
  add("verbs", "Strong action verbs", !bullets.length ? "fail" : vr >= 0.6 ? "pass" : vr >= 0.3 ? "warn" : "fail", !bullets.length ? "No bullets to check." : vr >= 0.6 ? "Most bullets start with an action verb." : `Only ${strong} of ${bullets.length} bullets start with a strong verb like led, built, trained or reduced.`, 10);
  const withNum = bullets.filter((b) => /\d/.test(b)).length, nr = bullets.length ? withNum / bullets.length : 0;
  add("numbers", "Results and numbers", !bullets.length ? "fail" : nr >= 0.3 ? "pass" : nr >= 0.12 ? "warn" : "fail", nr >= 0.3 ? "Plenty of bullets show size or results." : "Few bullets have numbers. Add real ones: how many, how often, how much. Only if true.", 14);
  const weak = (t.match(WEAK) || []).length;
  add("weak", "Specific, not vague", weak === 0 ? "pass" : weak <= 2 ? "warn" : "fail", weak ? `${weak} vague phrase${weak === 1 ? "" : "s"} like "responsible for" or "worked on". Say what you actually did and what happened.` : "No vague filler phrases.", 8);
  const fl = (t.match(FLUFF) || []).length;
  add("fluff", "Proof, not buzzwords", fl === 0 ? "pass" : fl <= 2 ? "warn" : "fail", fl ? `${fl} buzzword${fl === 1 ? "" : "s"} like "hard-working" or "team player". Show it with an example instead.` : "No empty buzzwords.", 6);
  const long = bullets.filter((b) => words(b).length > 32).length;
  add("clarity", "Short bullets", !bullets.length ? "warn" : long === 0 ? "pass" : long <= 2 ? "warn" : "fail", long ? `${long} bullet${long === 1 ? " is" : "s are"} over 32 words. Keep each to one idea.` : "Bullets are short and clear.", 6);
  const me = bullets.filter((b) => /\b(i|my|me)\b/i.test(b)).length;
  add("pronouns", "No \"I\" or \"my\"", me === 0 ? "pass" : "warn", me ? "Drop \"I\" and \"my\" from bullets. Start with the verb." : "Written in standard resume voice.", 3);
  const dates = new Set([/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{4}/i.test(t) && "mon yyyy", /\b\d{1,2}\/\d{4}\b/.test(t) && "m/yyyy", /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t) && "m/d/y"].filter(Boolean));
  add("dates", "Consistent dates", dates.size <= 1 ? "pass" : "warn", dates.size <= 1 ? "Dates use one format." : "Dates are written in more than one style. Pick one, like Jun 2023 - Aug 2024.", 5);
  if (/references (available )?(upon|on) request/i.test(t) || /^objective\b/im.test(t)) add("outdated", "Up to date", "warn", "Remove \"References available on request\" and the old-style Objective. Use a short Summary instead, or nothing.", 3);
  else add("outdated", "Up to date", "pass", "No outdated lines.", 3);
  const total = items.reduce((s, i) => s + i.pts, 0), got = items.reduce((s, i) => s + i.pts * (i.status === "pass" ? 1 : i.status === "warn" ? 0.5 : 0), 0);
  const score = Math.round((100 * got) / total);
  return { score, grade: score >= 85 ? "Strong" : score >= 70 ? "Good" : score >= 50 ? "Needs work" : "Needs a lot of work", items, words: n, bullets: bullets.length };
}

/* ---------- ATS keywords: what the posting uses that the resume never says ---------- */
const STOP = new Set("with that this have from will your their they about into more than also such other which when where what who work working team teams role job position company ability skills skill experience years year required requirements preferred responsibilities include including must able strong excellent good great well need needs needed looking help join make high level within across using used use new our you are the and for not all can may any its has had was were been being per etc plus both each these those them then there here very much many most some own out over under only just like like".split(" "));
const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9+#./ -]/g, " ").split(/\s+/).map((x) => x.replace(/^[.\-/]+|[.\-/]+$/g, "")).filter(Boolean);
const stem = (w) => w.replace(/(ing|ed|es|s|ly)$/i, "");
function keywords(resume, jd) {
  const toks = tokens(jd), uni = new Map(), bi = new Map(), add = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const ok = (w) => w && w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w);
  for (let i = 0; i < toks.length; i++) { if (!ok(toks[i])) continue; add(uni, toks[i]); if (ok(toks[i + 1])) add(bi, toks[i] + " " + toks[i + 1]); }
  const KNOWN = /[+#]|^(excel|sql|python|java|javascript|crm|erp|cpr|osha|hipaa|gaap|quickbooks|salesforce|forklift|ged|cdl|rn|lpn|cna|word|powerpoint|outlook|photoshop|tableau|aws|linux)$/i;
  const picks = [...bi.entries()].filter(([, c]) => c >= 2).sort((x, y) => y[1] - x[1]).map(([k]) => k).slice(0, 10);
  const inPick = (w) => picks.some((p) => p.split(" ").includes(w));
  for (const [k, c] of [...uni.entries()].sort((x, y) => y[1] - x[1])) { if ((c >= 2 || KNOWN.test(k)) && !inPick(k) && !/(ing|ly)$/.test(k) || KNOWN.test(k)) { if (!inPick(k)) picks.push(k); } if (picks.length >= 26) break; }
  const hset = new Set(tokens(resume).map(stem)), rtext = " " + tokens(resume).join(" ") + " ";
  const present = [], missing = [];
  for (const k of picks.slice(0, 24)) { const hit = k.split(" ").every((p) => hset.has(stem(p)) || rtext.includes(" " + p + " ")); (hit ? present : missing).push(k); }
  const total = present.length + missing.length;
  return { present: present.slice(0, 14), missing: missing.slice(0, 14), pct: total ? Math.round((100 * present.length) / total) : null, total };
}

module.exports = { check, keywords };
