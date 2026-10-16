"""Route explorer: an ADK 2.0 graph Workflow that checks every fulfilment route in parallel.

    START -> prepare -> (catalog_scout | sourcing_scout | maker_scout) -> join -> analyst

* catalog_scout  - Firestore vector search (Gemini embeddings) over the sample retailer catalogue,
                   then the MissionLock guard checks each candidate requirement by requirement.
* sourcing_scout - sourcing-partner offers, exposing unknown charges and delivery assumptions.
* maker_scout    - customisation and make-new routes with participating demo makers.
* analyst        - the route_analyst LlmAgent explains the guard's verdicts (it cannot change them).
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from google.adk.workflow import JoinNode, Workflow
from google.cloud.firestore_v1.base_vector_query import DistanceMeasure
from google.cloud.firestore_v1.vector import Vector

from .. import catalog, gemini, missionlock, store
from ..models import Brief, Specs
from .runtime import run_specialist
from .specialists import RouteNarrative, route_analyst

log = logging.getLogger(__name__)

def _brief_query(brief: Brief) -> str:
    reqs = "; ".join(r.label for r in brief.requirements)
    return f"{brief.title}. {brief.purpose}. Requirements: {reqs}"


def _entry(item: dict[str, Any], brief: Brief, relevance: float | None = None) -> dict[str, Any]:
    seller = catalog.SELLERS[item["seller_id"]]
    specs = Specs.model_validate(item.get("specs") or {})
    checked_at = datetime.now(timezone.utc) - timedelta(minutes=item.get("checked_minutes_ago", 0))
    entry: dict[str, Any] = {
        "item_id": item["id"],
        "route": item["route"],
        "name": item["name"],
        "description": item.get("description", ""),
        "seller_id": seller["id"],
        "seller_name": seller["name"],
        "seller_label": seller["label"],
        "image_path": f"catalog/{item['id']}.png",
        "specs": specs.model_dump(),
        "stock": item.get("stock", "unknown"),
        "checked_at": checked_at.isoformat(timespec="minutes"),
        "price_inr": specs.price_inr,
        "shipping_inr": item.get("shipping_inr"),
        "shipping_estimate": bool(item.get("shipping_estimate")),
        "unresolved": list(item.get("unresolved", [])),
        "base_item_id": item.get("base_item_id"),
        "relevance": relevance,
    }
    if item["route"] == "make":
        entry.update(verdict="needs_quote", decisive="No specs are assumed until the maker quotes against your brief.", checks=[])
        return entry
    result = missionlock.fit(brief, specs)
    verdict, decisive = result.verdict, result.decisive
    if entry["stock"] == "out_of_stock":
        if verdict == "meets":
            verdict = "possible_with_change"
        decisive = f"Out of stock - not available for approval. {decisive}"
    if entry["shipping_inr"] is None and item["route"] != "buy":
        entry["unresolved"].append("Delivery not yet confirmed")
    entry.update(verdict=verdict, decisive=decisive, checks=[c.model_dump() for c in result.checks])
    return entry


# ---- Workflow nodes (parameters are bound from session state by name) -------------------------


async def prepare(ctx, project_id: str) -> dict[str, Any]:
    brief = await store.get_brief(project_id)
    if brief is None:
        raise ValueError("No brief to explore.")
    ctx.state["brief"] = brief.model_dump()
    return {"brief_version": brief.version, "requirements": len(brief.requirements)}


async def catalog_scout(brief: dict) -> dict[str, Any]:
    b = Brief.model_validate(brief)
    [vec] = await gemini.embed([_brief_query(b)], purpose="catalog-search")
    query = store.db().collection("catalog").find_nearest(
        vector_field="embedding",
        query_vector=Vector(vec),
        distance_measure=DistanceMeasure.COSINE,
        limit=20,
        distance_result_field="distance",
    )
    entries = []
    async for snap in query.stream():
        d = snap.to_dict()
        item = catalog.ITEMS.get(d["id"])
        if item and item["route"] == "buy":
            entries.append(_entry(item, b, relevance=round(1 - float(d.get("distance", 1.0)), 3)))
    return {"route": "buy", "source": "Sample retailer catalogue (fictional)", "checked": len(entries), "entries": entries}


async def sourcing_scout(brief: dict) -> dict[str, Any]:
    b = Brief.model_validate(brief)
    entries = [_entry(i, b) for i in catalog.ITEMS.values() if i["route"] == "source"]
    return {"route": "source", "source": "Sourcing partner list (fictional)", "checked": len(entries), "entries": entries}


async def maker_scout(brief: dict) -> dict[str, Any]:
    b = Brief.model_validate(brief)
    entries = [_entry(i, b) for i in catalog.ITEMS.values() if i["route"] in ("customise", "make")]
    return {"route": "make", "source": "Participating demo makers (fictional)", "checked": len(entries), "entries": entries}


async def analyst(node_input: dict, brief: dict) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    sources = []
    for out in node_input.values():
        entries.extend(out["entries"])
        sources.append(f"{out['source']}: {out['checked']} checked")
    compact = [
        {
            "item_id": e["item_id"],
            "route": e["route"],
            "name": e["name"],
            "seller": e["seller_name"],
            "verdict": e["verdict"],
            "decisive": e["decisive"],
            "stock": e["stock"],
            "price_inr": e["price_inr"],
            "unresolved": e["unresolved"],
            "unmet_or_unknown": [
                f"{c['label']}: {c['result']}" for c in e.get("checks", []) if c["result"] != "met"
            ],
        }
        for e in entries
    ]
    try:
        narrative, stats = await asyncio.wait_for(
            run_specialist(
                route_analyst,
                [
                    "Confirmed brief:\n" + json.dumps(brief, ensure_ascii=False),
                    "Sources checked: " + "; ".join(sources),
                    "Guard verdicts per option:\n" + json.dumps(compact, ensure_ascii=False),
                ],
            ),
            timeout=75,
        )
        narrative = RouteNarrative.model_validate(narrative).model_dump()
    except Exception as e:  # The verdicts are already decided in code; only the explanation is lost.
        log.warning("route analyst unavailable (%s); using the deterministic summary", e)
        narrative = _fallback_narrative(entries, brief)
        stats = {"agent": "route_analyst", "model": "deterministic fallback", "purpose": "route_analyst", "latency_ms": 0}
    return {"entries": entries, "sources": sources, "narrative": narrative, "stats": stats}


def _fallback_narrative(entries: list[dict[str, Any]], brief: dict) -> dict[str, Any]:
    """A plain, honest summary of the guard's verdicts when the explanation agent can't answer."""
    count = {v: sum(1 for e in entries if e["verdict"] == v) for v in ("meets", "possible_with_change", "not_suitable", "needs_quote")}
    if count["meets"]:
        headline = f"{count['meets']} option{'s' if count['meets'] > 1 else ''} meet every confirmed requirement."
    else:
        headline = "No suitable match found in the sources checked."
    explanation = (
        f"MissionLock checked {len(entries)} options against brief v{brief.get('version', '?')}: {count['meets']} meet it, "
        f"{count['possible_with_change']} would need a change you'd have to approve, {count['not_suitable']} break a must-have, "
        f"and {count['needs_quote']} makers can quote. The route analyst was busy, so this summary comes straight from the guard's verdicts."
    )
    steps = ["Request a quote from a participating maker", "Relax a flexible preference and re-check", "Pause and come back later - the brief is saved"]
    return RouteNarrative(headline=headline, explanation=explanation, item_notes=[], next_steps=steps).model_dump()


join_routes = JoinNode(name="join_routes")

route_workflow = Workflow(
    name="route_explorer",
    edges=[("START", prepare, (catalog_scout, sourcing_scout, maker_scout), join_routes, analyst)],
)

PROGRESS = {
    "prepare": lambda o: f"Loaded your confirmed brief v{o['brief_version']} ({o['requirements']} requirements)",
    "catalog_scout": lambda o: f"Checked {o['checked']} items in the sample retailer catalogue (vector search + guard)",
    "sourcing_scout": lambda o: f"Checked {o['checked']} sourcing-partner offer",
    "maker_scout": lambda o: f"Checked {o['checked']} customise / make routes with demo makers",
    "join_routes": lambda o: "All routes checked - asking the route analyst to explain the verdicts",
    "analyst": lambda o: "Route analysis ready",
}
