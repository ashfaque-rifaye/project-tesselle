"""Find options: an ADK 2 graph Workflow that searches real stores and real makers in parallel.

    START -> prepare -> (shopping_agent | maker_scout) -> join -> advisor

* shopping_agent - Gemini + Grounding with Google Search finds real listings that deliver to the
                   customer's city; the fit checker (app.guard) verifies each one requirement by
                   requirement; Gemini embeddings rank them by relevance.
* maker_scout    - Gemini + Google Search finds real workshops and made-to-order services that could
                   make it, with their public contact details.
* advisor        - explains the results in short plain-language bullets (it cannot change a verdict).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from google.adk.workflow import JoinNode, Workflow

from .. import store
from ..models import Brief
from .runtime import run_specialist
from .shopper import find_listings, find_makers
from .specialists import RouteNarrative, route_analyst

log = logging.getLogger(__name__)


def _city(brief: Brief) -> str:
    city = (brief.delivery.region or "").split(",")[0].strip()
    pin = brief.delivery.pincode
    return f"{city} (PIN {pin})" if city and pin else city


# ---- Workflow nodes (parameters are bound from session state by name) -------------------------


async def prepare(ctx, project_id: str) -> dict[str, Any]:
    brief = await store.get_brief(project_id)
    if brief is None:
        raise ValueError("No brief to search for.")
    ctx.state["brief"] = brief.model_dump()
    ctx.state["region"] = _city(brief)
    return {"brief_version": brief.version, "musts": len(brief.musts()), "region": _city(brief)}


async def shopping_agent(brief: dict, region: str) -> dict[str, Any]:
    try:
        return await find_listings(Brief.model_validate(brief), region)
    except Exception as e:  # one scout failing must not sink the other
        log.warning("shopping agent failed: %s", e)
        return {"entries": [], "sources": [], "stats": [], "error": "The store search is busy right now."}


async def maker_scout(brief: dict, region: str) -> dict[str, Any]:
    try:
        return await find_makers(Brief.model_validate(brief), region)
    except Exception as e:
        log.warning("maker scout failed: %s", e)
        return {"entries": [], "sources": [], "stats": [], "error": "The maker search is busy right now."}


async def advisor(node_input: dict, brief: dict) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    stats: list[dict[str, Any]] = []
    errors: list[str] = []
    for out in node_input.values():
        entries.extend(out["entries"])
        sources.extend(out["sources"])
        stats.extend(out.get("stats") or [])
        if out.get("error"):
            errors.append(out["error"])
    compact = [
        {"item_id": e["item_id"], "route": e["route"], "name": e["name"], "seller": e["seller_name"], "verdict": e["verdict"],
         "decisive": e["decisive"], "price_inr": e["price_inr"], "stock": e["stock"]}
        for e in entries
    ]
    try:
        narrative, st = await asyncio.wait_for(
            run_specialist(route_analyst, [
                "Brief:\n" + json.dumps({k: brief.get(k) for k in ("title", "purpose", "requirements", "budget", "delivery")}, ensure_ascii=False),
                "Options checked:\n" + json.dumps(compact, ensure_ascii=False),
            ]),
            timeout=60,
        )
        narrative = RouteNarrative.model_validate(narrative).model_dump()
        stats.append(st)
    except Exception as e:  # the verdicts are already decided in code; only the summary is lost
        log.warning("advisor unavailable (%s); using the plain summary", e)
        narrative = _fallback_narrative(entries)
    return {"entries": entries, "sources": sources, "narrative": narrative, "stats": stats, "errors": errors}


def _fallback_narrative(entries: list[dict[str, Any]]) -> dict[str, Any]:
    buy = [e for e in entries if e["route"] == "buy"]
    fits = [e for e in buy if e["verdict"] == "meets"]
    close = [e for e in buy if e["verdict"] == "possible_with_change"]
    makers = [e for e in entries if e["route"] == "make"]
    headline = f"{len(fits)} listing{'s' if len(fits) != 1 else ''} fit every must-have" if fits else "Nothing in stock fits every must-have"
    points = [f"{len(buy)} real listings checked against your must-haves"]
    if close:
        points.append(f"{len(close)} could work once you check a detail on the store page")
    if makers:
        points.append(f"{len(makers)} makers could make it exactly to your brief")
    return {"headline": headline, "points": points, "best_next": "Ask a maker for a quote" if makers and not fits else "Open the best match",
            "item_notes": []}


join_routes = JoinNode(name="join_routes")

route_workflow = Workflow(
    name="find_options",
    edges=[("START", prepare, (shopping_agent, maker_scout), join_routes, advisor)],
)

# Friendly progress lines per node: (agent name, message)
PROGRESS = {
    "prepare": lambda o: ("Brief", f"Using your brief: {o['musts']} must-haves" + (f", delivery to {o['region']}" if o.get("region") else "")),
    "shopping_agent": lambda o: ("Shopping agent", f"Found {len(o['entries'])} real listings and checked each one against your must-haves"),
    "maker_scout": lambda o: ("Maker scout", f"Found {len(o['entries'])} makers who could make it for you"),
    "join_routes": lambda o: ("Fit checker", "Every option checked against your must-haves"),
    "advisor": lambda o: ("Advisor", o["narrative"]["headline"]),
}
