"""Shopping agent and maker scout: real listings and real makers, found live on the web.

Both use Gemini on Vertex AI with Grounding with Google Search. Only items that the search results
actually support are kept: each line of the grounded answer is tied to the page(s) it came from
(grounding supports), the redirect is resolved to the real store or maker page, and its preview image
is read from that page. A second, tool-free Gemini call structures the lines into specs that the
deterministic fit checker (app.guard) can verify against the customer's must-haves.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Literal, Optional
from urllib.parse import urlparse

import httpx
from google.genai import types
from pydantic import BaseModel, Field

from .. import config, gemini, guard
from ..models import Brief, Specs

log = logging.getLogger(__name__)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0 Safari/537.36")
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
    """Hedged grounded search: the fast regional model first; if it hasn't answered in 12 s the primary
    model starts in parallel and the first good answer wins (the other is cancelled)."""
    gemini._guard("llm")
    fast = asyncio.create_task(_grounded_once(gemini.fast_client(), config.MODEL_FAST, gemini.fast_thinking(), prompt, purpose))
    tasks = {fast}
    done, _ = await asyncio.wait(tasks, timeout=12)
    if not done or fast.exception() is not None:
        tasks.add(asyncio.create_task(_grounded_once(gemini.client(), config.MODEL_REASONING,
                                                     types.ThinkingConfig(thinking_level="low"), prompt, purpose)))
    last: BaseException | None = None
    deadline = time.perf_counter() + 90
    pending = set(tasks)
    while pending and time.perf_counter() < deadline:
        done, pending = await asyncio.wait(pending, timeout=max(1, deadline - time.perf_counter()), return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            if t.exception() is None:
                for other in pending:
                    other.cancel()
                return t.result()
            last = t.exception()
            log.warning("%s: grounded search attempt failed (%s)", purpose, type(last).__name__)
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


_META = re.compile(r'<meta[^>]+(?:property|name)=["\'](og:image|og:title|twitter:image)["\'][^>]*content=["\']([^"\']+)', re.I)
_META_REV = re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\'](og:image|og:title|twitter:image)["\']', re.I)


async def _page_meta(h: httpx.AsyncClient, url: str) -> dict[str, Optional[str]]:
    try:
        r = await h.get(url, follow_redirects=True)
        if r.status_code >= 400:
            return {}
        html = r.text[:600_000]
        found: dict[str, str] = {}
        for k, v in _META.findall(html):
            found.setdefault(k.lower(), v)
        for v, k in _META_REV.findall(html):
            found.setdefault(k.lower(), v)
        img = found.get("og:image") or found.get("twitter:image")
        if img and img.startswith("//"):
            img = "https:" + img
        return {"image": img if img and img.startswith("http") else None, "title": found.get("og:title")}
    except Exception:
        return {}


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


_INDEX = re.compile(r"/(cat|category|categories|collections?|search|s|w|wholesale|browse|shop|c|market)/|[?&](q|k|search)=", re.I)

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


async def find_listings(b: Brief, region: str) -> dict[str, Any]:
    city = region or "India"
    prompt = (
        f"Search the web for real product listings that a shopper in {city} can buy online now and have delivered there.\n"
        f"They want: {b.title}. {b.purpose}\nMust-haves: {_musts(b)}\nNice to have: {_flex(b)}\nBudget: {_budget(b)}\n"
        f"Check well-known stores that deliver to {city}, such as {STORES_IN}. Skip stores that do not ship to India.\n"
        "Give individual product pages, not category or search pages.\n"
        "List up to 8 specific listings that are available now, closest to the must-haves first. One line each, exactly:\n"
        "Product name | Store | Price in INR | Stated size or key specs | Availability\n"
        "Only include products you actually found. Never invent products, prices or sizes."
    )
    text, chunks, supports, stats = await _grounded(prompt, "shopping-agent")
    lines = [l for l in _lines_with_sources(text, chunks, supports) if l["chunks"]][:10]
    if not lines:
        return {"entries": [], "sources": [], "stats": [stats]}

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
    async with httpx.AsyncClient(timeout=7, headers={"User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9"}) as h:
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
                          finish=it.finish, mounting=it.mounting, features=it.features, price_inr=it.price_inr,
                          delivery_days=it.delivery_days, attributes={a.key: a.value for a in it.attributes})
            fit = guard.fit(b, specs, listing=True)
            verdict, decisive = fit.verdict, fit.decisive
            if it.availability == "out_of_stock":
                verdict = "not_suitable" if verdict == "not_suitable" else "possible_with_change"
                decisive = f"Out of stock right now. {decisive}"
            domain = urlparse(url).netloc.removeprefix("www.")
            return {
                "item_id": "web-" + _hid(url, it.name), "route": "buy", "name": it.name, "description": it.summary,
                "seller_id": domain, "seller_name": it.store, "seller_label": domain, "url": url,
                "image_url": meta.get("image"), "image_path": None, "source_title": getattr(chunk.web, "title", None),
                "specs": specs.model_dump(), "stock": it.availability, "checked_at": now, "price_inr": it.price_inr,
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
    # Prefer real product pages: drop category / search pages when enough product pages were found.
    products = [e for e in entries if not _is_listing_index(e["url"])]
    if len(products) >= 3:
        entries = products
    # Keep it deliverable: stores that serve India first; others only if too few were found, and flagged.
    local = [e for e in entries if _serves_india(e["url"])]
    if len(local) >= 3:
        entries = local
    for e in entries:
        if not _serves_india(e["url"]):
            e["unresolved"] = [f"May not deliver to {city} - check the store page"] + e["unresolved"]
    await _rank(b, entries)
    sources = sorted({(e["seller_name"], e["seller_label"]) for e in entries})
    return {"entries": entries, "sources": [{"name": n, "domain": d, "kind": "store"} for n, d in sources],
            "stats": [stats, s2.as_dict()]}


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
