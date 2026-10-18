"""Contact finder: a business's public email and phone number, from its own website.

The outreach agent reads the seller's home page and the usual contact pages (mailto: and tel: links first,
then addresses in the page text), preferring an address on the business's own domain. If the site lists
none, Gemini with Google Search looks for the contact details the business publishes elsewhere (its
Google Business listing, marketplace profile). Only published business contacts are used.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

import httpx

log = logging.getLogger(__name__)

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?:\+91[\s-]?|\b0)?[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}\b|\+91[\s-]?\d{2,4}[\s-]?\d{6,8}")
PATHS = ["", "/contact", "/contact-us", "/pages/contact", "/pages/contact-us", "/contactus", "/about", "/about-us"]
JUNK = ("example.", "sentry", "wixpress", "domain.com", "email.com", "yourname", "@2x", ".png", ".jpg", ".webp", ".svg", ".gif",
        "godaddy", "noreply", "no-reply", "privacy@", "abuse@", "u003e")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def _domain(url: str) -> str:
    return (urlparse(url if "//" in url else f"https://{url}").hostname or "").removeprefix("www.")


def _emails(html: str, domain: str) -> list[str]:
    found = re.findall(r"mailto:([^\"'?>\s]+)", html, re.I) + EMAIL.findall(html)
    out: list[str] = []
    for e in found:
        e = e.strip().strip(".").lower()
        if any(j in e for j in JUNK) or not EMAIL.fullmatch(e) or e in out:
            continue
        out.append(e)
    root = ".".join(domain.split(".")[-2:])
    return sorted(out, key=lambda e: (not e.split("@")[1].endswith(root), not e.startswith(("sales", "info", "contact", "hello", "orders", "care", "support"))))


def _phones(html: str) -> list[str]:
    tel = re.findall(r"tel:([+\d\s()-]{8,})", html, re.I)
    text = re.sub(r"<[^>]+>", " ", html)
    out: list[str] = []
    for p in tel + PHONE.findall(text):
        digits = re.sub(r"\D", "", p)
        if len(digits) < 10 or len(set(digits)) < 4:
            continue
        num = "+91" + digits[-10:] if len(digits) in (10, 11, 12) else "+" + digits
        if num not in out:
            out.append(num)
    return out


async def _from_site(url: str) -> dict[str, Any]:
    domain = _domain(url)
    if not domain:
        return {}
    base = f"https://{urlparse(url).netloc or domain}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4), follow_redirects=True,
                                 headers={"User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9"}) as h:
        async def get(path: str) -> tuple[str, str]:
            u = urljoin(base, path) if path else url
            try:
                r = await h.get(u)
                return (u, r.text[:600_000]) if r.status_code < 400 and "html" in r.headers.get("content-type", "html") else (u, "")
            except Exception:
                return u, ""
        pages = await asyncio.gather(*(get(p) for p in PATHS))
    for u, html in pages:
        emails = _emails(html, domain)
        if emails:
            phones = next((ph for _, x in pages if (ph := _phones(x))), [])
            return {"email": emails[0], "phone": phones[0] if phones else None, "page": u, "source": "their website"}
    phones = next(((u, ph) for u, x in pages if (ph := _phones(x))), None)
    return {"email": None, "phone": phones[1][0], "page": phones[0], "source": "their website"} if phones else {}


async def _from_search(name: str, domain: str) -> dict[str, Any]:
    from .agents import shopper

    prompt = (f"Find the public business contact email address and phone number of '{name}'" + (f" ({domain})" if domain else "")
              + " in India - from its website, Google Business listing or marketplace profile. Reply with just:\n"
              "Email: <address or none>\nPhone: <number or none>")
    try:
        text, _, _, _ = await asyncio.wait_for(shopper._grounded(prompt, "contact-finder"), 25)
    except Exception as e:
        log.info("contact search skipped: %s", e)
        return {}
    emails, phones = _emails(text, domain), _phones(text)
    if not emails and not phones:
        return {}
    return {"email": emails[0] if emails else None, "phone": phones[0] if phones else None, "page": None, "source": "Google Search"}


async def find(name: str, url: Optional[str]) -> dict[str, Any]:
    """{email, phone, page, source} - whatever the business publishes; {} if nothing was found. Never raises."""
    try:
        got = await asyncio.wait_for(_from_site(url), 20) if url else {}
    except Exception as e:
        log.info("contact page read failed: %s", e)
        got = {}
    if not got.get("email"):
        more = await _from_search(name, _domain(url or ""))
        got = {**more, **{k: v for k, v in got.items() if v}} if more else got
    return got
