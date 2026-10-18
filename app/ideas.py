"""See ideas: before searching, Gemini proposes two or three different ways to get what the customer wants.

* With a photo of their space (or the item), each idea is drawn INTO THAT PHOTO: everything they already
  have stays exactly where it is - same objects, walls, light and framing - and only the new things are
  added. Without a photo, each idea is drawn from the brief.
* Every idea lists the products it needs. Gemini locates each new product in the picture, so the idea is
  tagged like a catalogue page before anything is bought.
* Choosing an idea searches real stores for exactly those products (one search per product, each checked
  against the requirements that apply to it) and places the real products into the customer's photo as a
  shoppable picture. Redrawing with a change ("make it narrower") updates the idea and its product list.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator, Optional

from google.genai import types
from pydantic import BaseModel, Field

from . import gemini, store
from .models import now_iso

log = logging.getLogger(__name__)


class IdeaItem(BaseModel):
    name: str = Field(description="Short product name a store would use, e.g. 'Wall pegboard', 'Slim desk organiser', 'Olive cargo trousers'.")
    why: str = Field(description="At most 10 words: what it does for the customer.")


class Idea(BaseModel):
    title: str = Field(description="2-5 words, e.g. 'Go vertical', 'Wall-mounted calm', 'Rugged field look'.")
    pitch: str = Field(description="One sentence, at most 22 words: what changes and why it works for them.")
    items: list[IdeaItem] = Field(description="1-3 NEW products to buy for this idea, most important first.")
    placement: str = Field(description="Where the new things go, e.g. 'on the bare wall above the desk, left of the window'.")
    tweaks: list[str] = Field(description="3 short changes the customer might ask for, e.g. 'Make it narrower', 'Darker wood', 'Add a lamp'.")


class IdeaSet(BaseModel):
    ideas: list[Idea] = Field(description="Distinct ideas - different approaches, not colour variants of one.")


class Spot(BaseModel):
    index: int
    box_2d: list[int] = Field(description="[ymin, xmin, ymax, xmax] normalised to 0-1000.")


class Spots(BaseModel):
    items: list[Spot]


IDEAS_PROMPT = """You are the design agent of a shopping assistant in India. Propose {n} genuinely different ideas
for how the customer could get what they want, each built from 1-3 real, commonly sold products.
Rules:
- If a photo is attached, it shows what they ALREADY have. Every idea keeps all of it - you only ADD products,
  placed where they would fit and be used. Never suggest replacing, repainting or removing their things.
- Respect every must-have in the brief (sizes, budget, colours, no-drilling rules).
- Products must be things Indian online stores sell (Amazon.in, Flipkart, IKEA India, Pepperfry, Myntra...).
- Plain words, no jargon. Different approaches, not three colour variants of one idea."""


def _musts(brief) -> str:
    return "; ".join(r.label for r in brief.requirements if r.kind == "must") or "none stated"


async def _base_photo(pid: str) -> Optional[tuple[tuple[bytes, str], str, str]]:
    """The customer's own photo to draw into: the latest space or item photo (never a generated image or a person)."""
    project = await store.get_project(pid) or {}
    insp = project.get("inspiration") or {}
    photos = [p for p in insp.get("photos") or [] if p.get("kind") in ("space", "item", "inspiration")]
    path, kind = (photos[-1]["path"], photos[-1]["kind"]) if photos else (insp.get("image_path"), "space")
    if not path or (not photos and insp.get("generated_image")):
        return None
    try:
        return await store.download_media(path), path, kind
    except Exception as e:
        log.info("base photo unavailable: %s", e)
        return None


def _image_prompt(brief, idea: Idea, has_photo: bool, instruction: str = "") -> str:
    things = "; ".join(f"{i.name}" for i in idea.items)
    extra = f" The customer asked: \"{instruction}\"." if instruction else ""
    if has_photo:
        return ("Edit this photo of the customer's own space. Keep EVERYTHING already in it exactly as it is: the same objects in "
                "the same places, the same walls, colours, light, camera angle and framing. Do not remove, move, restyle, "
                f"tidy or replace anything. ONLY ADD these new products: {things} - {idea.placement}.{extra} The new products "
                f"must look like real products you can buy, at a believable size for the space ({_musts(brief)}). "
                "Photorealistic, natural light. No text, labels, logos or people.")
    return (f"Photorealistic photo of this idea for '{brief.title}': {idea.title} - {idea.pitch} It shows exactly these products "
            f"together: {things}, {idea.placement}.{extra} Must-haves: {_musts(brief)}. Realistic Indian home or setting, natural "
            "light, products clearly visible. No text, labels, logos or people.")


async def _locate(image: bytes, mime: str, names: list[str]) -> list[dict[str, Any]]:
    try:
        out, _ = await asyncio.wait_for(gemini.generate_structured(Spots, [
            types.Part.from_bytes(data=image, mime_type=mime),
            "New products that were added to this picture:\n" + "\n".join(f"{i}: {n}" for i, n in enumerate(names)),
            "For each one you can see, return its index and bounding box. Skip ones that are not visible.",
        ], purpose="idea-locator", fast=True), 15)
    except Exception as e:
        log.info("idea locate skipped: %s", e)
        return []
    spots = []
    for s in out.items:
        if 0 <= s.index < len(names) and len(s.box_2d) == 4:
            y0, x0, y1, x1 = [max(0, min(1000, v)) for v in s.box_2d]
            spots.append({"index": s.index, "name": names[s.index], "x": round((x0 + x1) / 2000, 4), "y": round((y0 + y1) / 2000, 4)})
    return spots


async def _draw(pid: str, brief, idea: Idea, base: Optional[tuple[tuple[bytes, str], str, str]], batch: str,
                instruction: str = "", parent_id: Optional[str] = None, ref: Optional[tuple[bytes, str]] = None) -> dict[str, Any]:
    refs = [ref] if ref else [base[0]] if base else []
    try:
        image, mime, stats = await gemini.generate_image(_image_prompt(brief, idea, bool(refs), instruction), purpose="idea-concept",
                                                         reference_images=refs, aspect_ratio="4:3")
    except Exception as e:
        if not refs:
            raise
        log.info("photo edit declined (%s); drawing from the brief", e)
        image, mime, stats = await gemini.generate_image(_image_prompt(brief, idea, False, instruction), purpose="idea-concept",
                                                         aspect_ratio="4:3")
        refs = []
    cid = store.new_id("cpt")
    path = await store.upload_media(f"projects/{pid}/concepts/{cid}", image, mime)
    spots = await _locate(image, mime, [i.name for i in idea.items])
    concept = {
        "id": cid, "image_path": path, "caption": idea.title, "instruction": instruction, "parent_id": parent_id,
        "brief_version": brief.version, "effects": [], "applied": None, "label": "idea", "batch": batch,
        "idea": idea.model_dump(), "spots": spots, "in_photo": bool(refs), "base_path": base[1] if base and refs else None,
        "created_at": now_iso(),
    }
    await store.put(pid, "concepts", cid, concept)
    return {"concept": concept, "stats": stats.as_dict()}


async def generate_ideas(pid: str, *, instruction: str = "", base_id: Optional[str] = None, n: int = 3) -> AsyncIterator[dict[str, Any]]:
    """Two or three ideas drawn into the customer's photo (or one idea redrawn with their change)."""
    from .services import ServiceError, _advance, _require_brief

    brief = await _require_brief(pid)
    base = await _base_photo(pid)
    parent = await store.get(pid, "concepts", base_id) if base_id else None
    brief_json = brief.model_dump_json(include={"title", "purpose", "requirements", "budget"})
    batch = store.new_id("b")
    if parent and parent.get("idea"):
        # Redraw one idea with the customer's change: update the idea (and its products), then redraw it.
        yield {"type": "progress", "agent": "Design agent", "message": f"Changing \"{parent['idea']['title']}\": {instruction[:60]}"}
        old = Idea.model_validate(parent["idea"])
        parts = [f"Brief:\n{brief_json}", f"Current idea:\n{old.model_dump_json()}",
                 f"The customer wants this change: \"{instruction}\". Return ONE updated idea - change only what they asked, keep the rest, "
                 "and update the product list if the change needs different products."]
        if base:
            parts.insert(0, types.Part.from_bytes(data=base[0][0], mime_type=base[0][1]))
        out, _ = await gemini.generate_structured(IdeaSet, [IDEAS_PROMPT.format(n=1), *parts], purpose="idea-redraw", fast=True)
        if not out.ideas:
            raise ServiceError("The design agent couldn't apply that change - try saying it differently.", 422)
        prev = await store.download_media(parent["image_path"])
        res = await _draw(pid, brief, out.ideas[0], base, parent.get("batch") or batch, instruction, parent["id"],
                          ref=base[0] if base else prev)
        await store.update_project(pid, selected_concept_id=res["concept"]["id"])
        await store.log(pid, "agent:design_agent", f"Redrew \"{out.ideas[0].title}\" ({instruction[:60]})", kind="agent",
                        detail="Your own photo stays as it is - only the new products change.", stats=[res["stats"]])
        yield {"type": "progress", "agent": "Design agent", "message": f"Redrawn: {out.ideas[0].title}"}
        return

    yield {"type": "progress", "agent": "Design agent",
           "message": "Looking at your photo and your brief" if base else "Reading your brief for ideas"}
    parts: list[Any] = [IDEAS_PROMPT.format(n=n), f"Brief:\n{brief_json}"]
    if instruction:
        parts.append(f"The customer also said: \"{instruction}\"")
    if base:
        parts.insert(0, types.Part.from_bytes(data=base[0][0], mime_type=base[0][1]))
        parts.append("The attached photo is what they already have - keep all of it.")
    out, s1 = await gemini.generate_structured(IdeaSet, parts, purpose="ideas", fast=True)
    ideas = out.ideas[:n]
    if not ideas:
        raise ServiceError("The design agent couldn't come up with ideas - add a detail to your brief and try again.", 422)
    for i, idea in enumerate(ideas):
        yield {"type": "progress", "agent": "Design agent", "message": f"Idea {i + 1}: {idea.title} - {', '.join(x.name for x in idea.items)}"}
    yield {"type": "progress", "agent": "Design agent",
           "message": "Drawing them into your photo - nothing you own is changed" if base else "Drawing each idea"}
    results = await asyncio.gather(*(_draw(pid, brief, idea, base, batch, instruction) for idea in ideas), return_exceptions=True)
    made = [r for r in results if not isinstance(r, Exception)]
    for r in results:
        if isinstance(r, Exception):
            log.warning("idea drawing failed: %s", r)
    if not made:
        raise ServiceError("The image model is busy right now - please try again in a minute.", 503)
    await store.update_project(pid, selected_concept_id=made[0]["concept"]["id"], idea_batch=batch)
    await _advance(pid, "visualise")
    await store.log(pid, "agent:design_agent", f"Suggested {len(made)} ideas: " + "; ".join(r["concept"]["caption"] for r in made),
                    kind="agent", detail=("Drawn into your own photo - everything you already have is kept; only the new products are added. "
                                          if base else "Drawn from your brief. ") + "Each idea lists the real products it needs.",
                    stats=[s1.as_dict(), *[r["stats"] for r in made]])
    yield {"type": "progress", "agent": "Design agent", "message": f"{len(made)} ideas ready - pick one to shop it"}
