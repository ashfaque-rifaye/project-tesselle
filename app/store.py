"""Firestore persistence for projects, brief versions, concepts, routes, requests, quotes,
orders and the activity/evidence log. Plus Cloud Storage for media.

Layout (Native mode, asia-southeast1):
  projects/{pid}                      project header (stage, current brief version, rev ...)
  projects/{pid}/briefs/{v}           immutable brief versions (change history)
  projects/{pid}/concepts/{cid}       labelled concept visualisations
  projects/{pid}/routes/latest        last route exploration (buy / source / customise / make)
  projects/{pid}/requests/{rid}       customer-approved seller requests
  projects/{pid}/quotes/{qid}         seller quotes, each tied to one brief version
  projects/{pid}/cart/{cid}           the customer's picks (several items per project)
  projects/{pid}/orders/{oid}         orders prepared by the checkout agent (payment happens on the store)
  projects/{pid}/notes/{nid}          the customer's own notes (typed or dictated)
  projects/{pid}/calls/{cid}          calls the outreach agent made (transcripts)
  projects/{pid}/events/{eid}         activity + agent evidence trace
  owners/{owner}/orders/{oid}         orders found in the customer's connected inbox (order history)

"""

from __future__ import annotations

import asyncio
import functools
import secrets
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from google.cloud import firestore, storage

from . import config, gemini, identity
from .models import Brief, Quote, now_iso


@functools.lru_cache(maxsize=1)
def db() -> firestore.AsyncClient:
    return firestore.AsyncClient(project=config.PROJECT, credentials=identity.credentials())


@functools.lru_cache(maxsize=1)
def bucket() -> storage.Bucket:
    return storage.Client(project=config.PROJECT, credentials=identity.credentials()).bucket(config.MEDIA_BUCKET)


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


# ---- Cost guard -------------------------------------------------------------------------------

_usage: dict[str, int] = defaultdict(int)
_usage_day = {"day": ""}


def _guard(kind: str) -> None:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if _usage_day["day"] != day:
        _usage.clear()
        _usage_day["day"] = day
    _usage[kind] += 1
    cap = config.DAILY_IMAGE_CAP if kind == "image" else config.DAILY_LLM_CALL_CAP
    if _usage[kind] > cap:
        raise gemini.BudgetExceeded(
            f"The public demo reached today's {kind} limit (cost guard for hackathon credits). Try again tomorrow."
        )


gemini.set_guard_hook(_guard)

_visitor_images: dict[str, list[float]] = defaultdict(list)


def visitor_image_allowed(visitor: str) -> bool:
    now = time.time()
    hits = [t for t in _visitor_images[visitor] if now - t < 3600]
    _visitor_images[visitor] = hits
    if len(hits) >= config.VISITOR_IMAGE_CAP_PER_HOUR:
        return False
    hits.append(now)
    return True


# ---- Projects ---------------------------------------------------------------------------------


def _proj(pid: str):
    return db().collection("projects").document(pid)


async def create_project(owner: str, title: str, demo: bool) -> dict[str, Any]:
    pid = new_id("prj")
    doc = {
        "id": pid,
        "owner": owner,
        "title": title,
        "demo": demo,
        "stage": "inspire",
        "brief_version": 0,
        "approved_brief_version": None,
        "selected_concept_id": None,
        "inspiration": {},
        "pending_decision": None,
        "rev": 1,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await _proj(pid).set(doc)
    return doc


async def get_project(pid: str) -> Optional[dict[str, Any]]:
    snap = await _proj(pid).get()
    return snap.to_dict() if snap.exists else None


async def update_project(pid: str, **fields: Any) -> None:
    fields["updated_at"] = now_iso()
    fields["rev"] = firestore.Increment(1)
    await _proj(pid).update(fields)


async def touch(pid: str) -> None:
    await update_project(pid)


async def list_projects(owner: str, limit: int = 40) -> list[dict[str, Any]]:
    q = db().collection("projects").where(filter=firestore.FieldFilter("owner", "==", owner)).limit(limit)
    items = [s.to_dict() async for s in q.stream()]
    return sorted(items, key=lambda p: p.get("updated_at", ""), reverse=True)


async def set_fields(pid: str, **fields: Any) -> None:
    """Update without bumping the revision (live status and device view - polled separately)."""
    await _proj(pid).update(fields)


async def owner_orders(owner: str) -> list[dict[str, Any]]:
    coll = db().collection("owners").document(owner).collection("orders")
    return [s.to_dict() async for s in coll.stream()]


async def put_owner_order(owner: str, oid: str, data: dict[str, Any]) -> None:
    await db().collection("owners").document(owner).collection("orders").document(oid).set(data)


# ---- Brief versions ---------------------------------------------------------------------------


async def save_brief(pid: str, brief: Brief) -> Brief:
    await _proj(pid).collection("briefs").document(str(brief.version)).set(brief.model_dump())
    await update_project(pid, brief_version=brief.version, title=brief.title)
    return brief


async def get_brief(pid: str, version: Optional[int] = None) -> Optional[Brief]:
    if version is None:
        p = await get_project(pid)
        if not p or not p.get("brief_version"):
            return None
        version = p["brief_version"]
    snap = await _proj(pid).collection("briefs").document(str(version)).get()
    return Brief.model_validate(snap.to_dict()) if snap.exists else None


async def list_briefs(pid: str) -> list[Brief]:
    out = [Brief.model_validate(s.to_dict()) async for s in _proj(pid).collection("briefs").stream()]
    return sorted(out, key=lambda b: b.version)


async def new_brief_version(
    pid: str,
    mutate: Callable[[Brief], None],
    *,
    summary: str,
    by: str = "customer",
    keep_confirmed: bool = True,
) -> Brief:
    """Copy the current brief, apply `mutate`, store it as version+1. Versions are immutable."""
    current = await get_brief(pid)
    if current is None:
        raise ValueError("Project has no brief yet.")
    nxt = current.model_copy(deep=True)
    mutate(nxt)
    nxt.version = current.version + 1
    nxt.created_at = now_iso()
    nxt.created_by = by
    nxt.change_summary = summary
    before = {r.id: r.model_dump() for r in current.requirements}
    nxt.changed_ids = [r.id for r in nxt.requirements if before.get(r.id) != r.model_dump()]
    if current.budget != nxt.budget:
        nxt.changed_ids.append("budget")
    if not keep_confirmed:
        nxt.confirmed = False
    return await save_brief(pid, nxt)


# ---- Generic sub-collections ------------------------------------------------------------------


async def put(pid: str, coll: str, doc_id: str, data: dict[str, Any]) -> None:
    await _proj(pid).collection(coll).document(doc_id).set(data)
    await touch(pid)


async def get(pid: str, coll: str, doc_id: str) -> Optional[dict[str, Any]]:
    snap = await _proj(pid).collection(coll).document(doc_id).get()
    return snap.to_dict() if snap.exists else None


async def list_coll(pid: str, coll: str, order: str = "created_at") -> list[dict[str, Any]]:
    items = [s.to_dict() async for s in _proj(pid).collection(coll).stream()]
    return sorted(items, key=lambda d: d.get(order, ""))


async def save_quote(pid: str, quote: Quote) -> None:
    await put(pid, "quotes", quote.id, quote.model_dump())


async def get_quote(pid: str, qid: str) -> Optional[Quote]:
    d = await get(pid, "quotes", qid)
    return Quote.model_validate(d) if d else None


async def list_quotes(pid: str) -> list[Quote]:
    return [Quote.model_validate(d) for d in await list_coll(pid, "quotes")]


# ---- Activity / evidence log ------------------------------------------------------------------


async def log(
    pid: str,
    actor: str,
    summary: str,
    *,
    kind: str = "info",
    detail: Optional[str] = None,
    stats: Optional[list[dict[str, Any]]] = None,
) -> None:
    eid = f"{int(time.time() * 1000):013d}_{secrets.token_hex(2)}"
    await _proj(pid).collection("events").document(eid).set(
        {
            "id": eid,
            "ts": now_iso(),
            "actor": actor,
            "kind": kind,
            "summary": summary,
            "detail": detail,
            "stats": stats or [],
        }
    )
    await touch(pid)


async def events(pid: str, limit: int = 80) -> list[dict[str, Any]]:
    q = _proj(pid).collection("events").order_by("id", direction=firestore.Query.DESCENDING).limit(limit)
    return [s.to_dict() async for s in q.stream()]


# ---- Full state for the UI ---------------------------------------------------------------------


def _annotate_quotes(quotes: list[dict[str, Any]], briefs: list[Any]) -> None:
    """Add the must-haves each quote leaves unconfirmed (computed, never stored)."""
    from . import guard
    from .models import Quote as Q
    by_v = {b.version: b for b in briefs}
    for q in quotes:
        b = by_v.get(q.get("brief_version"))
        if b is not None:
            try:
                q["to_confirm"] = guard.unconfirmed_musts(b, Q.model_validate(q))
            except Exception:
                q["to_confirm"] = []


async def full_state(pid: str) -> Optional[dict[str, Any]]:
    project = await get_project(pid)
    if not project:
        return None
    briefs, concepts, requests, quotes, orders, evs, routes, cart, notes, calls, looks = await asyncio.gather(
        list_briefs(pid),
        list_coll(pid, "concepts"),
        list_coll(pid, "requests"),
        list_coll(pid, "quotes"),
        list_coll(pid, "orders"),
        events(pid),
        get(pid, "routes", "latest"),
        list_coll(pid, "cart", order="added_at"),
        list_coll(pid, "notes"),
        list_coll(pid, "calls"),
        list_coll(pid, "looks"),
    )
    _annotate_quotes(quotes, briefs)
    live = [o for o in orders if o.get("status") != "cancelled"]
    return {
        "project": project,
        "briefs": [b.model_dump() for b in briefs],
        "concepts": concepts,
        "routes": routes,
        "requests": requests,
        "quotes": quotes,
        "order": live[-1] if live else None,
        "orders": orders,
        "cart": cart,
        "notes": notes,
        "calls": calls,
        "looks": looks,
        "events": evs,
    }


# ---- Media (Cloud Storage, private bucket; served through the API) ----------------------------


def _compress(data: bytes, content_type: str) -> tuple[bytes, str]:
    """Gemini returns large PNGs; store web-friendly JPEGs (about 10x smaller) for fast pages."""
    if not content_type.startswith("image/") or content_type == "image/gif" or len(data) < 250_000:
        return data, content_type
    try:
        import io

        from PIL import Image

        im = Image.open(io.BytesIO(data)).convert("RGB")
        im.thumbnail((1600, 1600))
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=84, optimize=True, progressive=True)
        return out.getvalue(), "image/jpeg"
    except Exception:
        return data, content_type


async def upload_media(path: str, data: bytes, content_type: str) -> str:
    def _up() -> None:
        nonlocal data, content_type
        data, content_type = _compress(data, content_type)
        blob = bucket().blob(path)
        blob.cache_control = "private, max-age=86400"
        blob.upload_from_string(data, content_type=content_type)

    await asyncio.to_thread(_up)
    return path


async def download_media(path: str) -> tuple[bytes, str]:
    def _down() -> tuple[bytes, str]:
        blob = bucket().blob(path)
        data = blob.download_as_bytes()
        return data, blob.content_type or "application/octet-stream"

    return await asyncio.to_thread(_down)
