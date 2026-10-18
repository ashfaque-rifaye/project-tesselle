"""Shopping agent and maker scout: real listings and real makers, found live on the web.

Both use Gemini on Vertex AI with Grounding with Google Search. Only items that the search results
actually support are kept: each line of the grounded answer is tied to the page(s) it came from
(grounding supports), the redirect is resolved to the real store or maker page, and its preview image
is read from that page. A second, tool-free Gemini call structures the lines into specs that the
deterministic fit checker (app.guard) can verify against the customer's must-haves.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import os
import logging
import re
import time
from datetime import datetime, timezone
from html import unescape as html_unescape
from typing import Any, Literal, Optional
from urllib.parse import urlparse

import httpx
from google.genai import types
from pydantic import BaseModel, Field

from .. import config, gemini, guard
from ..models import Brief, Specs

log = logging.getLogger(__name__)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0.0.0 Safari/537.36")
# Full browser request headers: several Indian stores (e.g. Nykaa) refuse bare requests.
BROWSER_HEADERS = {
    "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-Dest": "document",
    "Upgrade-Insecure-Requests": "1", "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130"', "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}
STORES_IN = ("Amazon.in, Flipkart, IKEA India, Pepperfry, Urban Ladder, Croma, Reliance Digital, Myntra, "
             "Tata CLiQ, Nykaa, FirstCry, Decathlon and brands' own online stores")


# ---- Grounded search ---------------------------------------------------------------------------


async def _grounded_once(c: Any, model_name: str, thinking: Any, prompt: str, purpose: str) -> tuple[str, list[Any], list[Any], dict[str, Any]]:
    started = time.perf_counter()
    resp = await c.aio.models.generate_content(
        model=model_name,
        contents=prompt,
        config=types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())],
            labels=gemini.labels(purpose),
            thinking_config=thinking,
            temperature=0.2,
        ),
    )
    cand = (resp.candidates or [None])[0]
    gm = cand.grounding_metadata if cand else None
    if not gm or not gm.grounding_chunks:
        raise RuntimeError("search returned no sources")
    u = resp.usage_metadata
    stats = {"agent": purpose, "model": model_name, "purpose": purpose,
             "latency_ms": int((time.perf_counter() - started) * 1000),
             "prompt_tokens": getattr(u, "prompt_token_count", None), "output_tokens": getattr(u, "candidates_token_count", None),
             "framework": "Gemini + Grounding with Google Search", "tools": list((gm.web_search_queries or [])[:6])}
    return resp.text or "", list(gm.grounding_chunks), list(gm.grounding_supports or []), stats


async def _grounded(prompt: str, purpose: str) -> tuple[str, list[Any], list[Any], dict[str, Any]]:
    """Hedged grounded search. The fast regional model goes first; if it hasn't answered in 12 s (or came back
    without sources) the primary model starts in parallel, and every failed attempt is replaced by a fresh fast
    attempt while time remains. The first answer with sources wins; the others are cancelled."""
    gemini._guard("llm")

    def fast_try(n: int) -> asyncio.Task:
        p = prompt if n == 0 else "Use Google Search to answer. " + prompt
        return asyncio.create_task(_grounded_once(gemini.fast_client(), config.MODEL_FAST, gemini.fast_thinking(), p, purpose))

    started = time.perf_counter()
    deadline = started + 80
    attempts = 1
    pending = {fast_try(0)}
    primary_started = False
    last: BaseException | None = None
    while pending and time.perf_counter() < deadline:
        wait = 12 if not primary_started else max(1, deadline - time.perf_counter())
        done, pending = await asyncio.wait(pending, timeout=wait, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            if t.exception() is None:
                for other in pending:
                    other.cancel()
                return t.result()
            last = t.exception()
            log.warning("%s: grounded search attempt failed (%s)", purpose, type(last).__name__)
        if not primary_started and (not done or last is not None):
            primary_started = True
            pending.add(asyncio.create_task(_grounded_once(gemini.client(), config.MODEL_REASONING,
                                                           types.ThinkingConfig(thinking_level="low"), prompt, purpose)))
        if done and attempts < 4 and time.perf_counter() - started < 55:
            pending.add(fast_try(attempts))
            attempts += 1
    for t in pending:
        t.cancel()
    raise RuntimeError(f"Web search unavailable ({type(last).__name__ if last else 'timeout'})")


def _lines_with_sources(text: str, chunks: list[Any], supports: list[Any]) -> list[dict[str, Any]]:
    """Split the grounded answer into '|' lines and attach the chunk indices that support each line."""
    raw = text.encode("utf-8")
    out = []
    pos = 0
    for line in text.split("\n"):
        b = line.encode("utf-8")
        start, end = pos, pos + len(b)
        pos = end + 1
        clean = line.strip().strip("*-• ").replace("**", "")
        if clean.count("|") < 2:
            continue
        idx: list[int] = []
        for s in supports:
            seg = s.segment
            if seg is None:
                continue
            s0, s1 = seg.start_index or 0, seg.end_index or 0
            if (s0 < end and s1 > start) or (seg.text and seg.text.strip() and seg.text.strip()[:40] in line):
                idx.extend(i for i in (s.grounding_chunk_indices or []) if i < len(chunks) and i not in idx)
        out.append({"line": clean, "chunks": idx})
    del raw
    return out


def _domain(chunk: Any) -> str:
    web = getattr(chunk, "web", None)
    d = (getattr(web, "domain", None) or getattr(web, "title", None) or "").lower()
    return d.removeprefix("www.")


def _pick_chunk(store: str, idx: list[int], chunks: list[Any]) -> Optional[Any]:
    if not idx:
        return None
    key = re.sub(r"[^a-z0-9]", "", store.lower())
    for i in idx:
        d = re.sub(r"[^a-z0-9]", "", _domain(chunks[i]))
        if key and (key[:6] in d or d.split("com")[0][:6] in key):
            return chunks[i]
    return chunks[idx[0]]


_resolved: dict[str, str] = {}


async def _resolve(h: httpx.AsyncClient, uri: str) -> Optional[str]:
    if uri in _resolved:
        return _resolved[uri]
    try:
        r = await h.get(uri, follow_redirects=False)
        loc = r.headers.get("location") or (str(r.url) if r.status_code < 300 else None)
        if loc:
            _resolved[uri] = loc
        return loc
    except Exception as e:
        log.info("resolve failed: %s", e)
        return None


_META = re.compile(r'<meta[^>]+(?:property|name)=["\'](og:image|og:title|og:site_name|twitter:image)["\'][^>]*content=["\']([^"\']+)', re.I)
_META_REV = re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\'](og:image|og:title|og:site_name|twitter:image)["\']', re.I)
_VAGUE_STORE = re.compile(r"not specified|unknown|unspecified|general search|n/a|various|online store", re.I)


def _store_name(stated: str, url: str, site: Optional[str]) -> str:
    """The store named in the search line if it matches the page's site; otherwise the site's own name."""
    host = urlparse(url).netloc.lower().removeprefix("www.")
    key = re.sub(r"[^a-z0-9]", "", (stated or "").lower().split(" ")[0])
    if stated and not _VAGUE_STORE.search(stated) and key and key[:5] in host.replace("-", "").replace(".", ""):
        return stated
    if site and len(site) <= 40:
        return html_unescape(site.strip())
    return host.split(".")[0].replace("-", " ").title()


_LD = re.compile(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.S | re.I)
_AMAZON_IMG = re.compile(r'"hiRes":"(https://[^"]+)"|data-old-hires="(https://[^"]+)"|"large":"(https://m\.media-amazon\.com/[^"]+)"')
_BAD_IMG = re.compile(r"logo|favicon|sprite|placeholder|default[-_]?(image|og)|og-image|/icons?/|\.svg(\?|$)|blank\.", re.I)


def _ld_product_images(html: str) -> list[str]:
    """Product images from schema.org JSON-LD (most stores publish these for Google Shopping)."""
    out: list[str] = []
    for block in _LD.findall(html)[:15]:
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        stack = [data]
        while stack:
            d = stack.pop()
            if isinstance(d, list):
                stack.extend(d)
                continue
            if not isinstance(d, dict):
                continue
            t = d.get("@type")
            kinds = t if isinstance(t, list) else [t]
            if any(k in ("Product", "ProductGroup", "IndividualProduct", "ProductModel") for k in kinds if isinstance(k, str)):
                img = d.get("image")
                for i in img if isinstance(img, list) else [img]:
                    if isinstance(i, dict):
                        i = i.get("url") or i.get("contentUrl")
                    if isinstance(i, str):
                        out.append(i)
            for key in ("@graph", "hasVariant", "mainEntity", "itemListElement"):
                if key in d:
                    stack.append(d[key])
    return out


_PRICE_META = re.compile(r'<meta[^>]+(?:property|name|itemprop)=["\'](?:product:price:amount|og:price:amount|price)["\'][^>]*content=["\']([\d.,]+)', re.I)


def _ld_price(html: str) -> Optional[float]:
    """The listed price in INR from schema.org offers or price meta tags - what the store tells Google Shopping."""
    for block in _LD.findall(html)[:15]:
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        stack = [data]
        while stack:
            d = stack.pop()
            if isinstance(d, list):
                stack.extend(d)
                continue
            if not isinstance(d, dict):
                continue
            offers = d.get("offers")
            for o in offers if isinstance(offers, list) else [offers]:
                if isinstance(o, dict) and str(o.get("priceCurrency", "INR")).upper() == "INR":
                    p = o.get("price") or o.get("lowPrice")
                    try:
                        v = float(str(p).replace(",", ""))
                        if 10 <= v <= 5_000_000:
                            return v
                    except (TypeError, ValueError):
                        pass
            for key in ("@graph", "hasVariant", "mainEntity", "itemListElement"):
                if key in d:
                    stack.append(d[key])
    m = _PRICE_META.search(html[:400_000])
    if m:
        try:
            return float(m.group(1).replace(",", ""))
        except ValueError:
            return None
    return None


def _abs(img: str, base: str) -> Optional[str]:
    img = html_unescape(img.strip()).replace("\\u002F", "/").replace("\\/", "/")
    if img.startswith("//"):
        img = "https:" + img
    elif img.startswith("/"):
        u = urlparse(base)
        img = f"{u.scheme}://{u.netloc}{img}"
    return img if img.startswith("http") else None


def best_image(html: str, url: str) -> Optional[str]:
    """The product's own photo: JSON-LD product image, then og/twitter image, then store-specific patterns.
    Site logos and favicons are skipped."""
    found: dict[str, str] = {}
    for k, v in _META.findall(html):
        found.setdefault(k.lower(), v)
    for v, k in _META_REV.findall(html):
        found.setdefault(k.lower(), v)
    cands = _ld_product_images(html) + [found.get("og:image") or "", found.get("twitter:image") or ""]
    for m in _AMAZON_IMG.findall(html)[:3]:
        cands += [x for x in m if x]
    clean = [c for c in (_abs(x, url) for x in cands if x) if c]
    good = [c for c in clean if not _BAD_IMG.search(c)]
    return (good or [None])[0]


async def fetch_html(h: httpx.AsyncClient, url: str, limit: int = 1_600_000) -> Optional[str]:
    """Read a page like a browser would (the first ~1.6 MB holds the head tags and product data)."""
    try:
        async with h.stream("GET", url, headers=BROWSER_HEADERS, follow_redirects=True) as r:
            if r.status_code >= 400:
                return None
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                # Enough once the head (og:image) and the first product JSON-LD have arrived.
                if len(buf) > limit or (len(buf) > 250_000 and b"og:image" in buf and b'"Product"' in buf):
                    break
            return buf.decode(r.encoding or "utf-8", errors="replace")
    except Exception as e:
        log.info("page fetch failed for %s: %s", url[:80], type(e).__name__)
        return None


async def _is_image(h: httpx.AsyncClient, url: str) -> bool:
    try:
        async with h.stream("GET", url, headers={"User-Agent": UA, "Accept": "image/*"}, follow_redirects=True) as r:
            return r.status_code == 200 and r.headers.get("content-type", "").startswith("image/")
    except Exception:
        return False


_CDN = {"flipkart": ("flixcart", "flipkart"), "amazon": ("media-amazon", "ssl-images-amazon", "amazon"), "nykaa": ("nykaa",),
        "pepperfry": ("pepperfry",), "ikea": ("ikea",), "myntra": ("myntassets", "myntra"), "urbanladder": ("urbanladder", "ul-assets"),
        "firstcry": ("fcglcdn", "firstcry"), "ajio": ("ajio", "assets-jiocdn"), "tatacliq": ("tatacliq", "tata"), "croma": ("croma",),
        "meesho": ("meesho",), "jiomart": ("jiomart", "jio")}


def _same_store(page: str, img: str) -> bool:
    """A store's product photo lives on the store's own domain or its known image CDN (or a shared Shopify CDN)."""
    ph = urlparse(page).netloc.lower().removeprefix("www.")
    ih = urlparse(img).netloc.lower()
    brand = ph.split(".")[0]
    keys = _CDN.get(brand, (brand,))
    return any(k in ih for k in keys) or "cdn.shopify.com" in ih or ih.endswith(ph)


async def _cached_images(urls: list[str]) -> dict[str, str]:
    from .. import store
    out: dict[str, str] = {}
    for u in urls:
        try:
            snap = await store.db().collection("image_cache").document(hashlib.sha1(u.encode()).hexdigest()).get()
            if snap.exists and (snap.to_dict() or {}).get("image"):
                out[u] = snap.to_dict()["image"]
        except Exception:
            break
    return out


async def _remember_image(url: str, image: str) -> None:
    from .. import store
    try:
        await store.db().collection("image_cache").document(hashlib.sha1(url.encode()).hexdigest()).set(
            {"url": url, "image": image, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    except Exception:
        pass


async def fill_missing_images(entries: list[dict[str, Any]]) -> None:
    """Several Indian marketplaces refuse requests from cloud servers, so a listing can come back without its
    photo. Fill the gaps from a cache of photos found before, then from Microlink (a link-preview service that
    reads the page from its own network). A photo is used only if it is on the store's own image host and is
    not a logo. Every photo found is cached for next time."""
    missing = [e for e in entries if not e.get("image_url") and e.get("url")][:8]
    if not missing:
        for e in entries:
            if e.get("image_url") and e.get("url"):
                await _remember_image(e["url"], e["image_url"])
        return
    cached = await _cached_images([e["url"] for e in missing])
    for e in missing:
        if e["url"] in cached:
            e["image_url"] = cached[e["url"]]
    await _index_images([e for e in missing if not e.get("image_url")])
    sem = asyncio.Semaphore(4)
    async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=6)) as h:
        async def microlink(e: dict[str, Any]) -> None:
            async with sem:
                try:
                    r = await h.get("https://api.microlink.io/", params={"url": e["url"]})
                    img = ((r.json().get("data") or {}).get("image") or {}) if r.status_code == 200 else {}
                    u = img.get("url")
                    if u and _same_store(e["url"], u) and not _BAD_IMG.search(u) and (img.get("width") or 0) >= 200 and (img.get("size") or 0) > 6000:
                        e["image_url"] = u
                except Exception as err:
                    log.info("microlink lookup skipped: %s", type(err).__name__)

        await asyncio.gather(*(microlink(e) for e in missing if not e.get("image_url")))
    for e in entries:
        if e.get("image_url") and e.get("url"):
            await _remember_image(e["url"], e["image_url"])


# ---- Vertex AI Search: Google's own index of Indian stores ----------------------------------------
# A website data store over ~45 Indian retailers (Amazon.in, Flipkart, IKEA India, Myntra, Croma, Nykaa,
# IndiaMART, FirstCry, Decathlon...). Results come from Google's index, so each listing arrives with the
# product photo Google saw - no request to a store that blocks cloud servers.

VAIS_ENGINE = os.environ.get("TESSELLE_SEARCH_ENGINE",
                             f"projects/{config.PROJECT}/locations/global/collections/default_collection/engines/tesselle-search")
_PROMO = re.compile(r"/promos?/|social_share|amazon_logo|/www/\d+/\d+/|banner|sprite|_shopping_\d+x\d+|share[-_]?image|og[-_]?image|ogimage", re.I)
_tok: dict[str, Any] = {"v": None, "at": 0.0}


def _gtoken() -> str:
    import google.auth
    import google.auth.transport.requests

    from .. import identity
    if _tok["v"] and time.time() - _tok["at"] < 2400:
        return _tok["v"]
    creds = identity.credentials()
    if creds is None:
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    _tok.update(v=creds.token, at=time.time())
    return creds.token


def _index_image(d: dict[str, Any]) -> Optional[str]:
    pm = d.get("pagemap") or {}
    mt = (pm.get("metatags") or [{}])[0]
    for u in (mt.get("og:image"), mt.get("twitter:image"), (pm.get("cse_image") or [{}])[0].get("src")):
        if u and u.startswith("http") and not _BAD_IMG.search(u) and not _PROMO.search(u):
            return u
    return None


async def catalog_search(query: str, n: int = 10) -> list[dict[str, Any]]:
    """Product pages from the Vertex AI Search store index: [{url, title, snippet, image}]. Never raises."""
    try:
        tok = await asyncio.to_thread(_gtoken)
        async with httpx.AsyncClient(timeout=12) as h:
            for attempt in range(2):
                r = await h.post(f"https://discoveryengine.googleapis.com/v1/{VAIS_ENGINE}/servingConfigs/default_search:search",
                                 headers={"Authorization": f"Bearer {tok}", "x-goog-user-project": config.PROJECT},
                                 json={"query": query[:300], "pageSize": n})
                if r.status_code == 200:
                    break
                await asyncio.sleep(1.2)
        if r.status_code != 200:
            log.info("catalog search %s: %s", r.status_code, r.text[:200])
            return []
        out = []
        for res in r.json().get("results", []):
            d = (res.get("document") or {}).get("derivedStructData") or {}
            link = d.get("link")
            if not link:
                continue
            snip = " ".join(re.sub(r"<[^>]+>", "", s.get("snippet", "")) for s in d.get("snippets") or [])
            out.append({"url": link, "title": d.get("title") or "", "snippet": snip[:300], "image": _index_image(d)})
        return out
    except Exception as e:
        log.info("catalog search skipped: %s", type(e).__name__)
        return []


async def _catalog_round(b: Brief, city: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Listings from the store index, structured and fit-checked the same way as the grounded search."""
    musts = [r.label for r in b.musts()][:3]
    queries = [f"{b.title} " + " ".join(musts), f"buy {b.title} online India"]
    found = await asyncio.gather(*(catalog_search(q, 10) for q in queries))
    seen: set[str] = set()
    lines = []
    for res in found:
        for x in res:
            key = x["url"].split("?")[0]
            if key in seen or _is_listing_index(x["url"]):
                continue
            seen.add(key)
            lines.append(x)
    lines = lines[:12]
    if not lines:
        return [], []
    structured, s2 = await gemini.generate_structured(
        FoundListings,
        [
            "Brief attribute keys to fill when stated: " + _attr_keys(b),
            "Brief must-haves: " + _musts(b),
            "Store pages found (index: title | store | text):\n" + "\n".join(
                f"{i}: {x['title']} | {urlparse(x['url']).netloc.removeprefix('www.')} | {x['snippet']}" for i, x in enumerate(lines)),
            "Structure each page that is one specific product that could suit the brief (skip accessories or unrelated items). "
            "Use only values stated in its line. Unknown -> null.",
        ],
        purpose="catalog-structurer",
        fast=True,
    )
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    entries = []
    for it in structured.items:
        if it.line < 0 or it.line >= len(lines):
            continue
        x = lines[it.line]
        url = x["url"]
        specs = Specs(width_cm=it.width_cm, depth_cm=it.depth_cm, height_cm=it.height_cm, material=it.material,
                      finish=it.finish, mounting=it.mounting, features=it.features, price_inr=it.price_inr,
                      delivery_days=it.delivery_days, attributes={a.key: a.value for a in it.attributes})
        fit = guard.fit(b, specs, listing=True)
        domain = urlparse(url).netloc.removeprefix("www.")
        entries.append({
            "item_id": "web-" + _hid(url, it.name), "route": "buy", "name": it.name, "description": it.summary,
            "seller_id": domain, "seller_name": _store_name(it.store, url, None), "seller_label": domain, "url": url,
            "image_url": x["image"] or _amazon_image(url), "image_path": None, "source_title": x["title"],
            "specs": specs.model_dump(), "stock": it.availability, "checked_at": now, "price_inr": it.price_inr,
            "shipping_inr": None, "shipping_estimate": False, "unresolved": ["Price, delivery charge and date: see the store page"]
            if it.price_inr is None else ["Delivery charge and date: see checkout"],
            "verdict": fit.verdict, "decisive": fit.decisive, "checks": [c.model_dump() for c in fit.checks], "found_by": "store index",
        })
    return entries, [s2.as_dict()]


class Companions(BaseModel):
    items: list[str] = Field(description="2-3 short store search queries for products that complete the scene, e.g. 'white desk lamp LED'.")


_PRICE = re.compile(r"(?:₹|Rs\.?|INR)\s?([\d,]{3,9})")


async def companions(b: Brief, exclude: set[str]) -> list[dict[str, Any]]:
    """Real products that go with what is being bought (a lamp and a chair for a desk, a dupatta for a blouse), so the
    shoppable picture is a whole scene, like a catalogue page. Found in the store index, each with its own photo and
    link; they are extras - they don't change the brief and are never checked against its must-haves."""
    try:
        out, _ = await asyncio.wait_for(gemini.generate_structured(Companions, [
            f"The customer is buying: {b.title}. {b.purpose}. Must-haves: {_musts(b)}.",
            "Suggest 2-3 different, inexpensive products that would naturally appear with it in one styled photo and that the "
            "customer might also like (not the same kind of product). Match colours and style. Short Indian-store search queries.",
        ], purpose="companions", fast=True), 10)
    except Exception as e:
        log.info("companions skipped: %s", e)
        return []
    found = await asyncio.gather(*(catalog_search(q + " buy online India", 6) for q in out.items[:3]))
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    entries = []
    for q, res in zip(out.items, found):
        ok = [x for x in res if x["image"] and not _is_listing_index(x["url"]) and x["url"].split("?")[0] not in exclude]
        pick = next((x for x in ok if _serves_india(x["url"])), None) or (ok[0] if ok else None)
        if not pick:
            continue
        exclude.add(pick["url"].split("?")[0])
        m = _PRICE.search(pick["snippet"])
        domain = urlparse(pick["url"]).netloc.removeprefix("www.")
        name = re.split(r"\s[|:-]\s|: Amazon\.in|\| Flipkart", pick["title"])[0].strip()
        name = re.sub(r"^(buy|shop)\s+", "", name, flags=re.I)
        name = re.sub(r"\s+(online|at best price|at lowest price|in india).*$", "", name, flags=re.I).strip()[:90] or q
        entries.append({
            "item_id": "cmp-" + _hid(pick["url"], name), "route": "buy", "name": name, "description": f"Goes with it: {q}",
            "seller_id": domain, "seller_name": _store_name("", pick["url"], None), "seller_label": domain, "url": pick["url"],
            "image_url": pick["image"], "image_path": None, "source_title": pick["title"], "specs": {}, "stock": "unknown",
            "checked_at": now, "price_inr": float(m.group(1).replace(",", "")) if m else None, "shipping_inr": None,
            "shipping_estimate": False, "unresolved": ["Price, delivery charge and date: see the store page"],
            "verdict": "extra", "decisive": "Goes with your pick - not part of your must-haves", "checks": [], "complement": True,
        })
    return entries


async def _index_images(missing: list[dict[str, Any]]) -> None:
    """Photos for listings that came back without one: look the product up in the store index by name."""
    async def one(e: dict[str, Any]) -> None:
        host = urlparse(e["url"]).netloc.removeprefix("www.")
        res = await catalog_search(f"{e['name']} {host}", 5)
        key = e["url"].split("?")[0].rstrip("/")
        for x in res:
            if x["image"] and (x["url"].split("?")[0].rstrip("/") == key or (_amazon_asin(x["url"]) and _amazon_asin(x["url"]) == _amazon_asin(e["url"]))):
                e["image_url"] = x["image"]
                return
    await asyncio.gather(*(one(e) for e in missing[:6]))


def _amazon_asin(url: str) -> Optional[str]:
    m = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", url)
    return m.group(1) if m else None


async def _page_meta(h: httpx.AsyncClient, url: str) -> dict[str, Optional[str]]:
    try:
        html = await asyncio.wait_for(fetch_html(h, url), 14)  # a page that trickles bytes can't stall the search
    except asyncio.TimeoutError:
        return {}
    if not html:
        return {}
    found: dict[str, str] = {}
    for k, v in _META.findall(html[:400_000]):
        found.setdefault(k.lower(), v)
    for v, k in _META_REV.findall(html[:400_000]):
        found.setdefault(k.lower(), v)
    return {"image": best_image(html, url), "title": found.get("og:title"), "site": found.get("og:site_name"), "price": _ld_price(html)}


def _amazon_image(url: str) -> Optional[str]:
    """Amazon often serves a robot check to servers; its image CDN still has the product photo by ASIN."""
    m = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", url or "")
    return f"https://m.media-amazon.com/images/P/{m.group(1)}.01._SCLZZZZZZZ_.jpg" if m and "amazon." in url else None


def _musts(b: Brief) -> str:
    return "; ".join(r.label for r in b.requirements if r.kind == "must") or "none stated"


def _flex(b: Brief) -> str:
    return "; ".join(r.label for r in b.requirements if r.kind == "flexible") or "none"


def _budget(b: Brief) -> str:
    if b.budget.limit_inr:
        return f"about INR {b.budget.target_inr or b.budget.limit_inr}, never above INR {b.budget.limit_inr}"
    if b.budget.target_inr:
        return f"about INR {b.budget.target_inr}"
    return "not set"


_INDEX = re.compile(r"/(cat|category|categories|collections?|search|s|w|wholesale|browse|shop|c|market)/|/pr\?|[?&](q|k|search|sid)=", re.I)

# Stores known to sell and deliver in India (plus any .in domain). Used to keep results deliverable.
_INDIA_STORES = ("amazon.in", "flipkart.com", "pepperfry.com", "urbanladder.com", "croma.com", "myntra.com",
                 "tatacliq.com", "nykaa.com", "firstcry.com", "meesho.com", "ajio.com", "snapdeal.com", "jiomart.com",
                 "indiamart.com", "woodenstreet.com", "chumbak.com")


def _serves_india(url: str) -> bool:
    u = urlparse(url)
    host, path = u.netloc.lower().removeprefix("www."), u.path.lower()
    if host.endswith(".in") or path.startswith("/in/") or path.startswith("/in-en/"):
        return True
    return any(host == d or host.endswith("." + d) for d in _INDIA_STORES)


def _is_listing_index(url: str) -> bool:
    path = urlparse(url).path + ("?" + urlparse(url).query if urlparse(url).query else "")
    return bool(_INDEX.search(path)) and "/p/" not in path and "/product" not in path and "/dp/" not in path


def _hid(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:10]


# ---- Structuring -------------------------------------------------------------------------------


class AttrValue(BaseModel):
    key: str
    value: str


class FoundListing(BaseModel):
    line: int = Field(description="Index of the source line.")
    name: str
    store: str
    price_inr: Optional[float] = None
    availability: Literal["available", "limited", "made_to_order", "out_of_stock", "unknown"] = "unknown"
    summary: str = Field(description="At most 18 words: what it is and why it might suit.")
    width_cm: Optional[float] = None
    depth_cm: Optional[float] = None
    height_cm: Optional[float] = None
    material: Optional[str] = None
    finish: Optional[str] = None
    mounting: Optional[str] = Field(default=None, description="freestanding | adhesive | clamp | drill | wall-screw, if stated.")
    features: list[str] = Field(default_factory=list, description="Reuse the brief's exact feature words when the listing has them.")
    attributes: list[AttrValue] = Field(default_factory=list, description="Other stated values, keyed by the brief's attribute keys.")
    delivery_days: Optional[float] = None


class FoundListings(BaseModel):
    items: list[FoundListing]


class FoundMaker(BaseModel):
    line: int
    name: str
    what: str = Field(description="At most 14 words: what they make or customise.")
    location: str = Field(description="City, or 'Online'.")
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None


class FoundMakers(BaseModel):
    items: list[FoundMaker]


def _attr_keys(b: Brief) -> str:
    keys = sorted({r.attribute for r in b.requirements if r.attribute})
    return ", ".join(keys) or "none"


# ---- Public API ----------------------------------------------------------------------------------


class SplitItem(BaseModel):
    name: str = Field(description="Short product name, e.g. 'Study desk'.")
    requirement_ids: list[str] = Field(description="Ids of the brief requirements that apply to this product (shared ones may repeat).")


class ItemSplit(BaseModel):
    items: list[SplitItem] = Field(default_factory=list, description="Empty unless the brief asks for 2+ different products bought separately.")


IDEA: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("idea", default=None)


async def split_items(b: Brief) -> list[tuple[str, Brief]]:
    """A brief can ask for several different things ("a desk and a pegboard", "a blouse and matching bangles").
    Each is searched on its own and checked only against the requirements that apply to it. When the customer
    chose an idea, its products are exactly the items searched for."""
    idea = IDEA.get()
    wanted = [n for n in (idea or {}).get("items") or [] if n][:3]
    if len(b.requirements) < 2 and not wanted:
        return []
    ask = ("Does this shopping brief ask for two or more DIFFERENT products that would be bought as separate items "
           "(e.g. a desk and a pegboard)? If so, list each product with the ids of the requirements that apply to it - shared "
           "ones such as colour or budget style may apply to several. A single product, a set sold together, or one product "
           "with features is NOT several products: return no items.")
    if wanted:
        ask = ("The customer chose an idea that needs exactly these products, bought separately: " + "; ".join(wanted) + ". Return "
               "exactly these as the items, with the same names, each with the ids of the brief requirements that apply to that "
               "product (none is fine - a size meant for one product must not be applied to another).")
    try:
        out, _ = await asyncio.wait_for(gemini.generate_structured(ItemSplit, [
            ask, "Brief:\n" + b.model_dump_json(include={"title", "purpose", "requirements"}),
        ], purpose="item-split", fast=True), 9)
    except Exception as e:
        log.info("item split skipped: %s", e)
        out = ItemSplit(items=[SplitItem(name=n, requirement_ids=[]) for n in wanted])
    if wanted and not out.items:
        out.items = [SplitItem(name=n, requirement_ids=[]) for n in wanted]
    if len(out.items) < (1 if wanted else 2):
        return []
    ids = {r.id for r in b.requirements}
    subs = []
    for it in out.items[:3]:
        reqs = [r for r in b.requirements if r.id in set(it.requirement_ids) & ids]
        subs.append((it.name, b.model_copy(update={"title": it.name, "purpose": f"{it.name} - part of: {b.title}. {b.purpose}",
                                                  "requirements": reqs})))
    return subs


async def find_listings(b: Brief, region: str) -> dict[str, Any]:
    subs = await split_items(b)
    if not subs:
        return await _find_listings_one(b, region)
    outs = await asyncio.gather(*(_find_listings_one(sub, region) for _, sub in subs), return_exceptions=True)
    entries, sources, stats = [], [], []
    for (name, _), out in zip(subs, outs):
        if isinstance(out, Exception):
            log.warning("search for %s failed: %s", name, out)
            continue
        for e in out["entries"]:
            e["item"] = name
            e["description"] = f"{name}: {e.get('description') or ''}".strip()
        entries += out["entries"]
        sources += [s for s in out["sources"] if s not in sources]
        stats += out["stats"]
    return {"entries": entries, "sources": sources, "stats": stats, "items": [n for n, _ in subs]}


async def _find_listings_one(b: Brief, region: str) -> dict[str, Any]:
    city = region or "India"
    want = f"They want: {b.title}. {b.purpose}\nMust-haves: {_musts(b)}\nNice to have: {_flex(b)}\nBudget: {_budget(b)}\n"
    fmt = ("List up to 8 specific listings that are available now, closest to the must-haves first. One line each, exactly:\n"
           "Product name | Store | Price in INR | Stated size or key specs | Availability\n"
           "Only include products you actually found. Never invent products, prices or sizes.")
    prompt = (
        f"Search the web for real product listings that a shopper in {city} can buy online now and have delivered there.\n{want}"
        f"Check well-known stores that deliver to {city}, such as {STORES_IN}. Skip stores that do not ship to India.\n"
        f"Give individual product pages, not category or search pages.\n{fmt}"
    )
    (entries, stats), (catalog, cstats) = await asyncio.gather(_listing_round(b, city, prompt, "shopping-agent"), _catalog_round(b, city))
    known = {e["url"].split("?")[0] for e in entries}
    entries += [e for e in catalog if e["url"].split("?")[0] not in known]
    stats += cstats
    if sum(_serves_india(e["url"]) and not _is_listing_index(e["url"]) for e in entries) < 3:
        # Too few deliverable results: search Indian marketplaces directly and merge.
        prompt2 = (
            f"Search Amazon.in, Flipkart, IKEA India, Pepperfry and other Indian online stores for individual product pages a "
            f"shopper in {city} can order today - one specific product per line, never a category or search page.\n{want}"
            f"Only stores that deliver in India.\n{fmt}"
        )
        more, stats2 = await _listing_round(b, city, prompt2, "shopping-agent-india")
        known = {e["url"] for e in entries}
        entries += [e for e in more if e["url"] not in known]
        stats += stats2
    return await _finish(b, city, entries, stats)


async def _listing_round(b: Brief, city: str, prompt: str, purpose: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    text, chunks, supports, stats = await _grounded(prompt, purpose)
    lines = [l for l in _lines_with_sources(text, chunks, supports) if l["chunks"]][:10]
    if not lines:
        return [], [stats]

    structured, s2 = await gemini.generate_structured(
        FoundListings,
        [
            "Brief attribute keys to fill when stated: " + _attr_keys(b),
            "Brief must-haves: " + _musts(b),
            "Listings found (index: line):\n" + "\n".join(f"{i}: {l['line']}" for i, l in enumerate(lines)),
            "Structure each listing. Use only values stated in its line. Unknown -> null.",
        ],
        purpose="listing-structurer",
        fast=True,
    )
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    async with httpx.AsyncClient(timeout=httpx.Timeout(10, connect=5), headers={"User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9"}) as h:
        async def build(it: FoundListing) -> Optional[dict[str, Any]]:
            if it.line < 0 or it.line >= len(lines):
                return None
            chunk = _pick_chunk(it.store, lines[it.line]["chunks"], chunks)
            if chunk is None or not getattr(chunk, "web", None):
                return None
            url = await _resolve(h, chunk.web.uri)
            if not url:
                return None
            meta = await _page_meta(h, url)
            specs = Specs(width_cm=it.width_cm, depth_cm=it.depth_cm, height_cm=it.height_cm, material=it.material,
                          finish=it.finish, mounting=it.mounting, features=it.features, price_inr=it.price_inr or meta.get("price"),
                          delivery_days=it.delivery_days, attributes={a.key: a.value for a in it.attributes})
            fit = guard.fit(b, specs, listing=True)
            verdict, decisive = fit.verdict, fit.decisive
            if it.availability == "out_of_stock":
                verdict = "not_suitable" if verdict == "not_suitable" else "possible_with_change"
                decisive = f"Out of stock right now. {decisive}"
            domain = urlparse(url).netloc.removeprefix("www.")
            return {
                "item_id": "web-" + _hid(url, it.name), "route": "buy", "name": it.name, "description": it.summary,
                "seller_id": domain, "seller_name": _store_name(it.store, url, meta.get("site")), "seller_label": domain, "url": url,
                "image_url": meta.get("image") or _amazon_image(url), "image_path": None, "source_title": getattr(chunk.web, "title", None),
                "specs": specs.model_dump(), "stock": it.availability, "checked_at": now, "price_inr": specs.price_inr,
                "shipping_inr": None, "shipping_estimate": False, "unresolved": ["Delivery charge and date: see checkout"],
                "verdict": verdict, "decisive": decisive, "checks": [c.model_dump() for c in fit.checks],
            }

        built = await asyncio.gather(*(build(it) for it in structured.items))
    entries = []
    seen = set()
    for e in built:
        if e and e["url"] not in seen:
            seen.add(e["url"])
            entries.append(e)
    return entries, [stats, s2.as_dict()]


async def _finish(b: Brief, city: str, entries: list[dict[str, Any]], stats: list[dict[str, Any]]) -> dict[str, Any]:
    # Prefer real product pages: drop category / search pages when enough product pages were found.
    products = [e for e in entries if not _is_listing_index(e["url"])]
    if products:
        entries = products
    else:
        for e in entries:
            e["unresolved"] = ["This link is a store's list of products - pick one there"] + e["unresolved"]
    # Keep it deliverable: stores that serve India first; others only if too few were found, and flagged.
    local = [e for e in entries if _serves_india(e["url"])]
    if len(local) >= 3:
        entries = local
    for e in entries:
        if not _serves_india(e["url"]):
            e["unresolved"] = [f"May not deliver to {city} - check the store page"] + e["unresolved"]
    await asyncio.gather(_rank(b, entries), fill_missing_images(entries))
    # Drop look-alikes that are clearly a different kind of product (far below the best match).
    rel = [e["relevance"] for e in entries if e.get("relevance") is not None]
    if rel:
        close = [e for e in entries if e.get("relevance") is None or e["relevance"] >= max(rel) - 0.12]
        if len(close) >= 2:
            entries = close
    sources = sorted({(e["seller_name"], e["seller_label"]) for e in entries})
    return {"entries": entries, "sources": [{"name": n, "domain": d, "kind": "store"} for n, d in sources], "stats": stats}


async def find_makers(b: Brief, region: str) -> dict[str, Any]:
    city = region or "India"
    prompt = (
        f"Search the web for real businesses that could custom-make or customise this for a customer in {city}: "
        f"{b.title}. {b.purpose}\nMust-haves: {_musts(b)}\n"
        f"Look for workshops, artisans, custom manufacturers and made-to-order online services that deliver to {city} "
        "(local businesses in or near the city first, then online services such as Etsy or IndiaMART sellers).\n"
        "List up to 6 businesses. One line each, exactly:\n"
        "Business name | What they make | City or Online | Public contact exactly as published (website, email or phone)\n"
        "Only include businesses you actually found. Never invent contact details."
    )
    text, chunks, supports, stats = await _grounded(prompt, "maker-scout")
    lines = [l for l in _lines_with_sources(text, chunks, supports) if l["chunks"]][:8]
    if not lines:
        return {"entries": [], "sources": [], "stats": [stats]}
    structured, s2 = await gemini.generate_structured(
        FoundMakers,
        ["Businesses found (index: line):\n" + "\n".join(f"{i}: {l['line']}" for i, l in enumerate(lines)),
         "Structure each business. Copy contact details exactly as written; unknown -> null."],
        purpose="maker-structurer",
        fast=True,
    )
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    async with httpx.AsyncClient(timeout=7, headers={"User-Agent": UA}) as h:
        async def build(m: FoundMaker) -> Optional[dict[str, Any]]:
            if m.line < 0 or m.line >= len(lines):
                return None
            chunk = _pick_chunk(m.name, lines[m.line]["chunks"], chunks)
            if chunk is None or not getattr(chunk, "web", None):
                return None
            url = await _resolve(h, chunk.web.uri)
            if not url:
                return None
            meta = await _page_meta(h, url)
            domain = urlparse(url).netloc.removeprefix("www.")
            return {
                "item_id": "maker-" + _hid(url, m.name), "route": "make", "name": m.name, "description": m.what,
                "seller_id": domain, "seller_name": m.name, "seller_label": m.location, "url": url,
                "image_url": meta.get("image"), "image_path": None, "source_title": getattr(chunk.web, "title", None),
                "contact": {"email": m.email, "phone": m.phone, "website": m.website or url},
                "specs": Specs().model_dump(), "stock": "made_to_order", "checked_at": now, "price_inr": None,
                "shipping_inr": None, "shipping_estimate": False, "unresolved": [],
                "verdict": "needs_quote", "decisive": "Makes things like this - can quote against your brief.", "checks": [],
            }

        built = await asyncio.gather(*(build(m) for m in structured.items))
    entries, seen = [], set()
    for e in built:
        if e and e["url"] not in seen:
            seen.add(e["url"])
            entries.append(e)
    return {"entries": entries, "sources": [{"name": e["seller_name"], "domain": e["seller_id"], "kind": "maker"} for e in entries],
            "stats": [stats, s2.as_dict()]}


async def _rank(b: Brief, entries: list[dict[str, Any]]) -> None:
    """Semantic relevance to the brief with Gemini embeddings (used to order cards within a verdict)."""
    if not entries:
        return
    try:
        query = f"{b.title}. {b.purpose}. " + "; ".join(r.label for r in b.requirements)
        vecs = await gemini.embed([query] + [f"{e['name']}. {e['description']}" for e in entries], purpose="relevance")
        q = vecs[0]
        qn = sum(x * x for x in q) ** 0.5 or 1.0
        for e, v in zip(entries, vecs[1:]):
            vn = sum(x * x for x in v) ** 0.5 or 1.0
            e["relevance"] = round(sum(a * c for a, c in zip(q, v)) / (qn * vn), 3)
    except Exception as e:  # ranking is a nicety
        log.info("relevance ranking skipped: %s", e)
