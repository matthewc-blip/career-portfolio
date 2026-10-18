// Ghost job check: how likely is it that a posting is not a real, open job? No AI and no cost, just signals in the posting text
// and its metadata. This is an estimate: nobody outside the company can see whether it is really hiring, so the result says
// "risk" and lists the reasons, and a Low score is not a promise.
const DAY = 86400e3;
const EVERGREEN = /\b(talent (pool|community|network)|future (opportunit|opening|role|position)|pipeline of|build(ing)? (a )?(pipeline|bench)|always (hiring|looking|accepting)|continuous(ly)? (hiring|recruit)|evergreen|general application|ongoing (hiring|recruit)|not (currently )?(hiring|have an? open)|may (become|be) available|keep your resume on file|join our (talent|network))\b/i;
const CLOSED = /\b(no longer (accepting|available)|position (has been |is )?(filled|closed)|(job|posting|role|position) (is )?(closed|expired|no longer)|this (job|position|posting) (has )?expired|applications? (are )?closed|not accepting applications)\b/i;
const STAFFING = /\b(our client|on behalf of (our|a) client|staffing|recruiting (agency|firm)|talent solutions|confidential (company|client|employer)|a (leading|top|fortune) .{0,25} (client|company) (is|has)|direct hire for)\b/i;
const MULTI = /\b(multiple (openings|positions|locations|roles)|various locations|several (openings|positions)|openings? in multiple|many (openings|positions)|hiring (for )?\d+ )\b/i;
const REPOST = /\b(re-?posted|reposting|updated posting|re-?opened)\b/i;
const PAY = /(\$\s?\d[\d,.]*\s?(k\b|\/|per|an hour|hourly|annually|a year)|\$\s?\d{2,3},\d{3}|\b\d{2,3}k\s?(-|to)\s?\d{2,3}k\b|salary range|pay range|compensation range|hourly rate|per hour|\/hr)/i;
const DIRECT = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|jobvite\.com|bamboohr\.com|breezy\.hr|recruitee\.com|paylocity\.com|paycomonline\.net|taleo\.net|successfactors\.(com|eu)|oraclecloud\.com|governmentjobs\.com|usajobs\.gov)$/i;
const AGGREGATOR = /(^|\.)(adzuna\.[a-z.]+|jooble\.[a-z.]+|talent\.com|jobrapido\.com|neuvoo\.com|careerjet\.[a-z.]+|learn4good\.com|simplyhired\.com|lensa\.com|jobs2careers\.com|bebee\.com|recruit\.net|whatjobs\.com)$/i;

// "Posted 12 days ago", "30+ days ago", "Posted on Sep 3, 2026", "2026-08-14". Returns days old, or null.
function ageDays(posted, text, now = Date.now()) {
  const direct = Date.parse(String(posted || ""));
  if (Number.isFinite(direct) && direct > 0 && direct < now + DAY) return Math.max(0, Math.round((now - direct) / DAY));
  const t = String(posted || "") + " " + String(text || "").slice(0, 4000);
  let m = /(\d{1,3})\s*\+?\s*(day|week|month)s?\s+ago/i.exec(t);
  if (m) { const n = Number(m[1]); return Math.round(n * (/^day/i.test(m[2]) ? 1 : /^week/i.test(m[2]) ? 7 : 30)); }
  if (/posted\s+(today|just now)|just posted|\b(today|yesterday)\b.{0,12}posted|posted\s+yesterday/i.test(t)) return /yesterday/i.test(t) ? 1 : 0;
  m = /\b(?:posted|date posted|listed|published)(?: on)?[:\s]+([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(t);
  if (m) { const d = Date.parse(m[1]); if (Number.isFinite(d) && d < now + DAY) return Math.max(0, Math.round((now - d) / DAY)); }
  return null;
}

function grade({ title = "", company = "", posting = "", url = "", posted = "", pay = "", closed = false, now = Date.now() } = {}) {
  const text = String(posting || ""), all = `${title}\n${text}`;
  const bad = [], good = []; let pts = 0;
  const add = (n, why) => { pts += n; bad.push(why); };
  const days = ageDays(posted, text, now);
  if (days == null) add(6, "No posting date is shown, so you cannot tell how old it is.");
  else if (days >= 60) add(35, `Posted about ${days} days ago. Jobs open this long are often not actively being filled.`);
  else if (days >= 30) add(22, `Posted about ${days} days ago.`);
  else if (days >= 15) add(8, `Posted about ${days} days ago.`);
  else good.push(days <= 1 ? "Posted in the last day." : `Posted about ${days} days ago.`);
  if (closed || CLOSED.test(all)) add(60, "The page says the job is closed or no longer accepting applications.");
  if (EVERGREEN.test(all)) add(30, "The wording describes a talent pool or future openings, not one open job.");
  if (STAFFING.test(all)) add(12, "Posted through a staffing or confidential employer. These are sometimes collecting resumes.");
  if (MULTI.test(all)) add(8, "Lists multiple openings or locations at once.");
  if (REPOST.test(all)) add(12, "Marked as reposted or reopened.");
  if (!String(company || "").trim() || /^(confidential|not given|unknown)$/i.test(String(company).trim())) add(10, "The employer is not named.");
  if (!PAY.test(text) && !String(pay || "").trim()) add(6, "No pay range is listed. Some states require one.");
  else good.push("Lists a pay range.");
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 40) add(10, "Very little detail about the work or requirements.");
  const entry = /\b(entry[- ]level|junior|no experience|recent graduate|new grad|intern(ship)?)\b/i.test(all);
  const yrs = [...all.matchAll(/(\d{1,2})\s*\+?\s*(?:or more )?years?(?: of)?(?: (?:relevant|related|professional|work|hands-on))? experience/gi)].map((x) => Number(x[1])).filter((n) => n <= 30);
  if (entry && yrs.some((n) => n >= 5)) add(12, "Called entry level but asks for 5 or more years of experience.");
  let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch (e) {}
  if (host && DIRECT.test(host)) good.push("Hosted on the employer's own application system.");
  else if (host && AGGREGATOR.test(host)) add(6, "Comes from a job aggregator, not the employer. Find the original posting before you apply.");
  const score = Math.max(0, Math.min(100, pts));
  const level = score >= 50 ? "High" : score >= 25 ? "Medium" : "Low";
  return { score, level, label: level === "High" ? "Likely ghost" : level === "Medium" ? "Some doubts" : "Looks real", reasons: bad.slice(0, 5), good: good.slice(0, 3), age: days };
}

module.exports = { grade, ageDays };
