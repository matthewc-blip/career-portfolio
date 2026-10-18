"""Reads a business's own public home page (only where robots.txt allows) so the first email can mention something true about them.
Private and internal addresses are never fetched, and redirects are re-checked."""
import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser

UA = "OutreachAgent/1.0 (+https://github.com/your-name/outreach-agent)"
MAX_BYTES = 300_000


def _public_host(host):
    try:
        for fam, _, _, _, sa in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(sa[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                return False
        return True
    except (socket.gaierror, ValueError, OSError):
        return False


class _Guard(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        p = urllib.parse.urlparse(newurl)
        if p.scheme not in ("http", "https") or not _public_host(p.hostname or ""):
            raise urllib.error.URLError("redirect to a non-public address")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_Guard)


def _get(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,text/plain;q=0.8"})
    with _opener.open(req, timeout=timeout) as r:
        ctype = r.headers.get("content-type", "")
        return r.read(MAX_BYTES).decode(r.headers.get_content_charset() or "utf-8", "replace"), ctype


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self.desc, self.heads, self.parts, self._skip, self._in = "", "", [], [], 0, ""
        self.links = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style", "noscript", "svg", "template"):
            self._skip += 1
        elif tag == "a" and a.get("href") and len(self.links) < 60:
            self.links.append(a["href"])
        elif tag == "meta" and (a.get("name") or "").lower() == "description":
            self.desc = (a.get("content") or "")[:300]
        elif tag in ("title", "h1", "h2"):
            self._in = tag

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg", "template") and self._skip:
            self._skip -= 1
        elif tag == self._in:
            self._in = ""

    def handle_data(self, data):
        t = " ".join(data.split())
        if not t or self._skip:
            return
        if self._in == "title":
            self.title += t
        elif self._in in ("h1", "h2") and len(self.heads) < 8:
            self.heads.append(t[:120])
        self.parts.append(t)


PAGE_WORDS = re.compile(r"about|our-?story|who-?we|team|people|attorneys?|lawyers?|services?|practice|what-?we-?do|areas?|specialt|company|firm|industries|locations?", re.I)
SKIP_WORDS = re.compile(r"blog|news|login|signin|sign-in|cart|privacy|terms|careers|jobs|\.(pdf|jpg|png|zip)$", re.I)


def _more_pages(root, base_path, links, limit=2):
    """Up to two more pages from the same site that say what the business does (about, services, team)."""
    seen, out = {base_path.rstrip("/") or "/"}, []
    for href in links:
        p = urllib.parse.urlparse(urllib.parse.urljoin(root + (base_path or "/"), href))
        if p.scheme not in ("http", "https") or "%s://%s" % (p.scheme, p.netloc) != root:
            continue
        path = p.path or "/"
        key = path.rstrip("/") or "/"
        if key in seen or SKIP_WORDS.search(path) or not PAGE_WORDS.search(path):
            continue
        seen.add(key)
        out.append(path)
        if len(out) >= limit:
            break
    return out


def read_site(url, timeout=6):
    """Returns {status: read|blocked|failed, title, description, headings, text}. Never raises."""
    out = {"status": "failed", "title": "", "description": "", "headings": [], "text": ""}
    try:
        u = urllib.parse.urlparse(url if "//" in url else "http://" + url)
        if u.scheme not in ("http", "https") or not u.hostname or not _public_host(u.hostname):
            return out
        root = "%s://%s" % (u.scheme, u.netloc)
        rp = urllib.robotparser.RobotFileParser()
        try:
            body, _ = _get(root + "/robots.txt", timeout)
            rp.parse(body.splitlines())
        except urllib.error.HTTPError as e:
            # No robots.txt (404) means everything is allowed; a login wall (401/403) means stay out.
            rp.parse(["User-agent: *", "Disallow: /"] if e.code in (401, 403) else [])
        except Exception:
            rp.parse([])
        if not rp.can_fetch(UA, root + (u.path or "/")):
            out["status"] = "blocked"
            return out
        html, ctype = _get(root + (u.path or "/"), timeout)
        if "html" not in ctype.lower() and "<html" not in html[:2000].lower():
            return out
        p = _Text()
        p.feed(html)
        text = re.sub(r"\s+", " ", " ".join(p.parts)).strip()[:2500]
        heads = list(p.heads)
        # More research: the about / services / team pages say far more than a home page does. Same site only, robots.txt respected.
        for path in _more_pages(root, u.path or "/", p.links):
            try:
                if not rp.can_fetch(UA, root + path):
                    continue
                h2, c2 = _get(root + path, timeout)
                if "html" not in c2.lower() and "<html" not in h2[:2000].lower():
                    continue
                q = _Text()
                q.feed(h2)
                t2 = re.sub(r"\s+", " ", " ".join(q.parts)).strip()
                text += " || PAGE %s: %s" % (path[:60], t2[:1100])
                heads += q.heads[:4]
            except Exception:
                continue
        out.update(status="read", title=p.title[:160], description=p.desc, headings=heads[:12], text=text[:4600])
    except Exception:
        pass
    return out
