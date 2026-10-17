"""Adaptive brief and journey: the right-hand brief panel and the step rail shape themselves to what is
being bought.

After every brief change Gemini (fast model, structured output) reads the brief and returns a small
layout: the few key facts that matter for this kind of purchase (a saree blouse needs size and occasion,
a charger needs the laptop model and wattage, a sofa needs the door width), how to group the
requirements, and the most likely path - buy ready-made, get it made, either, or source in bulk. The
web app builds the brief panel and the step rail from it, so a gift order, a car part and a bookshelf
each get their own template and their own steps. The layout is advisory display data: requirements
and every fit check stay deterministic.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Literal, Optional

from pydantic import BaseModel, Field

from . import gemini, store

log = logging.getLogger(__name__)

Icon = Literal["ruler", "shirt", "cpu", "car", "gift", "users", "calendar", "palette", "box", "plug", "weight", "sparkles", "home",
               "package", "scissors", "utensils", "heart", "briefcase", "baby", "dog", "bike", "sofa", "lamp", "book", "phone",
               "monitor", "layers", "hash", "map-pin", "wallet", "leaf", "shield", "wrench", "zap", "droplet", "sun"]


class Facet(BaseModel):
    label: str = Field(description="2-3 words, e.g. 'Door width', 'Blouse size', 'Laptop model', 'Guests', 'Print colours'.")
    value: Optional[str] = Field(default=None, description="Short value from the brief, e.g. '76 cm', '36', 'Dell XPS 13 9310', '40'. Null if not known yet.")
    icon: Icon
    requirement_id: Optional[str] = Field(default=None, description="Id of the requirement this fact comes from, if any.")
    ask: Optional[str] = Field(default=None, description="If value is null: the short question that would fill it.")


class Section(BaseModel):
    title: str = Field(description="Heading for a group of requirements, e.g. 'Size & fit', 'Compatibility', 'Look & feel', 'Occasion'.")
    requirement_ids: list[str]


class BriefLayout(BaseModel):
    kind_label: str = Field(description="What this is, 2-4 words, e.g. 'Bedroom furniture', 'Tailored ethnic wear', 'Laptop charger', 'Party return gifts'.")
    icon: Icon
    facets: list[Facet] = Field(description="3 to 6 key facts that decide what fits for THIS kind of purchase, most important first.")
    sections: list[Section] = Field(description="2-4 groups covering every requirement id exactly once.")
    route: Literal["buy", "make", "either", "source"] = Field(
        description="buy = ready-made from stores; make = custom made/tailored/printed by a maker; either = both are sensible; "
        "source = bulk or business quantities from suppliers.")
    route_reason: str = Field(description="One short sentence why, in plain words.")
    maker_word: str = Field(description="Plural word for the businesses that would make or supply it: 'tailors', 'carpenters', 'print shops', 'suppliers', 'sellers'.")
    photo_helps: bool = Field(description="True if a photo of the space, the person, the device or an example would clearly help.")
    photo_prompt: Optional[str] = Field(default=None, description="If photo_helps: what to photograph, e.g. 'the alcove with a tape measure in view'.")
    show_deadline: bool = Field(description="True if a date matters (an event, a trip, a wedding) or the customer gave one.")


PROMPT = """You design the brief panel of a shopping agent for this purchase.
Choose the 3-6 facts that decide whether a product fits THIS purchase (not generic furniture fields):
size and fit for clothes, model and compatibility for electronics or parts, room and measurements for furniture,
quantity and per-unit budget for gifts or bulk, occasion and date for events. Use values only from the brief
(never invent numbers); leave value null and give a short `ask` when a key fact is missing.
Group every requirement id into 2-4 sections with short, specific headings.
Pick the most likely route and the right word for the businesses involved."""


def _sig(brief) -> str:
    raw = json.dumps({"t": brief.title, "c": brief.category, "r": [(r.id, r.label, r.kind) for r in brief.requirements],
                      "b": brief.budget.model_dump(), "d": brief.delivery.model_dump()}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


async def refresh_layout(pid: str, timeout: float = 12) -> Optional[dict]:
    """Recompute the panel layout when the brief changed in a way that matters. Never raises."""
    try:
        brief = await store.get_brief(pid)
        if brief is None:
            return None
        project = await store.get_project(pid) or {}
        old = project.get("layout") or {}
        sig = _sig(brief)
        if old.get("sig") == sig:
            return old
        out, _ = await asyncio.wait_for(gemini.generate_structured(BriefLayout, [
            PROMPT,
            "Brief:\n" + brief.model_dump_json(include={"title", "purpose", "category", "requirements", "budget", "delivery", "unknowns"}),
        ], purpose="brief-layout", fast=True), timeout=timeout)
        ids = {r.id for r in brief.requirements}
        seen: set[str] = set()
        for s in out.sections:
            s.requirement_ids = [i for i in s.requirement_ids if i in ids and not (i in seen or seen.add(i))]
        out.sections = [s for s in out.sections if s.requirement_ids]
        rest = [r.id for r in brief.requirements if r.id not in seen]
        if rest:
            out.sections.append(Section(title="Also", requirement_ids=rest))
        for f in out.facets:
            if f.requirement_id and f.requirement_id not in ids:
                f.requirement_id = None
        layout = {**out.model_dump(), "sig": sig, "brief_version": brief.version}
        await store.update_project(pid, layout=layout)
        return layout
    except Exception as e:  # the panel falls back to the standard template
        log.info("layout refresh skipped: %s", type(e).__name__)
        return None
