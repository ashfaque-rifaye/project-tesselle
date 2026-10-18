"""Project Tesselle operations. Used by the HTTP API and by the voice/chat assistant's ADK tools, so a
button press and a spoken request go through exactly the same guarded code path.

Flow: start (inspiration) -> brief -> visualise (optional) -> find options (real stores + real makers)
-> reach out (messages / calls by the outreach agent) -> replies (read + checked) -> picks (cart) ->
orders (checkout prepared by the agent; the customer authorises payment on the store) -> delivery check.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Literal, Optional
from urllib.parse import quote as urlquote

import httpx
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.api_core import exceptions as gexc
from google.genai import types
from pydantic import BaseModel, Field

from . import gemini, guard, journey, store
from .agents import specialists as sp
from .agents.route_explorer import PROGRESS, route_workflow
from .agents.runtime import run_specialist
from .models import Brief, Budget, Delivery, PriceLine, Quote, Requirement, Specs, Unknown, now_iso

log = logging.getLogger(__name__)

STAGES = ["inspire", "clarify", "visualise", "routes", "request", "compare", "approve", "fulfil", "accept"]

DEMO = {
    "inspiration_text": "I want a compact organiser for my study desk with room for my pens, my phone and an A5 notebook. "
    "The shelf above only leaves 18 cm of depth, and I rent this flat so no drilling. Something warm like bamboo "
    "would be lovely. Around 3,000 rupees, and I can't go above 3,500.",
    "region": "Chennai, Tamil Nadu",
    "desk_photo_path": "demo/desk.png",
}


class ServiceError(Exception):
    def __init__(self, message: str, status: int = 400, details: Optional[list[str]] = None):
        super().__init__(message)
        self.status = status
        self.details = details or []


def _later_stage(current: str, new: str) -> str:
    return new if STAGES.index(new) > STAGES.index(current) else current


async def _advance(pid: str, stage: str) -> None:
    p = await store.get_project(pid)
    if p:
        await store.update_project(pid, stage=_later_stage(p.get("stage", "inspire"), stage))


async def _require_brief(pid: str) -> Brief:
    brief = await store.get_brief(pid)
    if brief is None:
        raise ServiceError("This project has no brief yet - start by telling Tesselle what you want.", 409)
    return brief


def _city(brief: Brief) -> str:
    return (brief.delivery.region or "").split(",")[0].strip()


PIN_RE = re.compile(r"\b([1-9]\d{5})\b")


def _place(brief: Brief) -> str:
    """'Chennai (PIN 600042)' - city plus PIN code when known, for searches and messages."""
    city = _city(brief)
    pin = brief.delivery.pincode
    return f"{city} (PIN {pin})" if city and pin else city or (f"PIN {pin}" if pin else "")


def _split_pin(region: str) -> tuple[str, Optional[str]]:
    m = PIN_RE.search(region or "")
    if not m:
        return (region or "").strip(), None
    return (region[: m.start()] + region[m.end():]).strip(" ,-"), m.group(1)


# =============================================================================================
# Start -> brief
# =============================================================================================


def today_line() -> str:
    """Models don't know today's date; dates without a year ("by 12 December") mean the next one."""
    from datetime import datetime, timedelta, timezone
    d = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    return f"Today is {d:%A %d %B %Y} (India). A date without a year means its next occurrence; write dates as YYYY-MM-DD."


async def start_from_inspiration(
    pid: str,
    *,
    text: str = "",
    region: str = "",
    image: Optional[tuple[bytes, str]] = None,
    audio: Optional[tuple[bytes, str]] = None,
    video: Optional[tuple[bytes, str]] = None,
    image_path: Optional[str] = None,
    source: str = "",
    consent_photo: bool = False,
    use_demo_photo: bool = False,
    pincode: str = "",
) -> Brief:
    parts: list[Any] = []
    region, pin_in_region = _split_pin(region)
    pincode = (pincode or pin_in_region or "").strip()
    generated = False
    if image_path and image is None:
        if not image_path.startswith(f"projects/{pid}/"):
            raise ServiceError("That image does not belong to this project.", 403)
        image = await store.download_media(image_path)
        consent_photo, generated = True, image_path.endswith("/imagined")
    parts.append(today_line())
    if text.strip():
        parts.append("Customer typed:\n" + text.strip())
    if region.strip():
        parts.append(f"Delivery city: {region.strip()}")
    image_path = None
    if use_demo_photo and image is None:
        image, consent_photo = await store.download_media(DEMO["desk_photo_path"]), True
    if image and consent_photo:
        image_path = await store.upload_media(f"projects/{pid}/inspiration", image[0], image[1])
        parts.append(types.Part.from_bytes(data=image[0], mime_type=image[1]))
        if generated:
            parts.append("This image was GENERATED by Gemini from the customer's own words - an inspiration, "
                         "not a real product or their real space. Never derive measurements from it.")
        else:
            parts.append("Photo of the customer's space or inspiration" + (f" (from {source})" if source else "")
                         + ". The customer consented to its use for this project.")
    video_path = None
    if video and consent_photo:
        video_path = await store.upload_media(f"projects/{pid}/inspiration-video", video[0], video[1])
        parts.append(types.Part.from_bytes(data=video[0], mime_type=video[1]))
        parts.append("Short video from the customer" + (f" (from {source})" if source else "")
                     + ". Describe what matters in photo_observations; treat any sizes seen as unconfirmed.")
    if audio:
        parts.append(types.Part.from_bytes(data=audio[0], mime_type=audio[1]))
        parts.append("Voice note from the customer describing what they want.")
    if not parts:
        raise ServiceError("Tell Tesselle what you want - type it, say it, or add a photo.")

    await store.log(pid, "customer", "Shared what they want" + (" with a photo" if image_path else "")
                    + (" and a video" if video_path else "") + (" and a voice note" if audio else "")
                    + (f" from {source}" if source else ""))
    out, stats = await run_specialist(sp.intake_agent, parts, timeout=80 if video else 60, hedge_after=40 if video else 30)
    draft = sp.BriefDraft.model_validate(out)
    if draft.out_of_scope:
        await store.log(pid, "agent:brief_agent", "Can't help with this one", kind="warning",
                        detail=draft.out_of_scope_reason, stats=[stats])
        raise ServiceError(draft.out_of_scope_reason or "Tesselle can't help with this kind of item.", 422)

    brief = Brief(
        version=1,
        title=draft.title,
        purpose=draft.purpose,
        category=draft.category or "general",
        requirements=draft.requirements,
        budget=Budget(target_inr=draft.budget_target_inr, limit_inr=draft.budget_limit_inr),
        delivery=Delivery(region=region or draft.delivery_region or None, pincode=pincode if PIN_RE.fullmatch(pincode or "") else None,
                          desired_by=draft.delivery_desired_by, essential=draft.delivery_essential),
        unknowns=draft.unknowns[:3],
        acceptance_checks=draft.acceptance_checks,
        confirmed=False,
        created_by="agent:brief_agent",
        change_summary="Draft from what you shared - check your must-haves.",
    )
    _prune_questions(brief)
    await store.save_brief(pid, brief)
    await store.update_project(
        pid,
        title=brief.title,
        inspiration={
            "text": text, "image_path": image_path, "video_path": video_path, "source": source or None,
            "generated_image": generated, "transcript": draft.transcript,
            "photo_observations": draft.photo_observations, "had_audio": bool(audio),
        },
    )
    await _advance(pid, "clarify")
    await journey.refresh_layout(pid)
    musts = sum(1 for r in brief.requirements if r.kind == "must")
    await store.log(
        pid, "agent:brief_agent",
        f"Wrote your brief: {musts} must-haves, {len(brief.requirements) - musts} nice-to-haves, {len(brief.unknowns)} questions",
        kind="agent", detail="Gemini read your words" + (", photo" if image_path else "") + (", video" if video_path else "")
        + (" and voice note" if audio else "") + " and turned them into a brief.", stats=[stats],
    )
    return brief


async def imagine(pid: str, prompt: str) -> str:
    """Render an inspiration image from the customer's words (clearly labelled as generated)."""
    if len(prompt.strip()) < 4:
        raise ServiceError("Describe what you imagine in a few words.")
    image, mime, stats = await gemini.generate_image(
        "Photorealistic inspiration image of: " + prompt.strip()
        + ". Natural light, realistic materials and proportions, product clearly visible, no text, no logos, no brand marks.",
        purpose="imagine",
    )
    path = await store.upload_media(f"projects/{pid}/imagined", image, mime)
    await store.log(pid, "agent:design_agent", f"Imagined from your words: \"{prompt.strip()[:80]}\"", kind="agent",
                    detail="Generated with Gemini - an inspiration, not a product.", stats=[stats.as_dict()])
    return path


class BriefPatch(BaseModel):
    title: Optional[str] = None
    purpose: Optional[str] = None
    requirements: Optional[list[Requirement]] = None
    budget: Optional[Budget] = None
    delivery: Optional[Delivery] = None
    acceptance_checks: Optional[list[str]] = None
    summary: Optional[str] = None


def _apply_patch(b: Brief, patch: BriefPatch) -> None:
    for field in ("title", "purpose", "requirements", "budget", "delivery", "acceptance_checks"):
        val = getattr(patch, field)
        if val is not None:
            setattr(b, field, val)


_BRIEF_LOCKS: dict[str, asyncio.Lock] = {}


async def edit_brief(pid: str, patch: BriefPatch, by: str = "customer") -> Brief:
    # The voice agent may change the budget and a requirement at the same moment: apply edits one at a time.
    async with _BRIEF_LOCKS.setdefault(pid, asyncio.Lock()):
        return await _edit_brief(pid, patch, by)


async def _edit_brief(pid: str, patch: BriefPatch, by: str) -> Brief:
    current = await _require_brief(pid)
    if patch.delivery is not None and patch.delivery.region:
        region, pin = _split_pin(patch.delivery.region)
        patch.delivery.region = region or None
        patch.delivery.pincode = patch.delivery.pincode or pin
    if not current.confirmed:
        _apply_patch(current, patch)
        current.created_by = by
        _prune_questions(current)
        await store.save_brief(pid, current)
        await store.log(pid, by, patch.summary or "Edited the draft brief")
        await refresh_questions(pid)
        return current
    brief = await store.new_brief_version(pid, lambda b: (_apply_patch(b, patch), _prune_questions(b)), summary=patch.summary or "You edited the brief.", by=by)
    await store.log(pid, by, f"Brief v{brief.version}: {brief.change_summary}", kind="change")
    await refresh_questions(pid)
    return brief


# ---- Questions: relevant, never repeated -------------------------------------------------------

_Q_TOPICS = {
    "budget": re.compile(r"budget|spend|price range|how much", re.I),
    "place": re.compile(r"\b(city|deliver(ed|y)? to|where .* deliver|location|area)\b", re.I),
    "pincode": re.compile(r"pin ?code|postal|zip", re.I),
}


def _prune_questions(b: Brief) -> None:
    """Close questions the brief already answers (a budget question once a budget is set, etc.)."""
    have = {"budget": bool(b.budget.target_inr or b.budget.limit_inr), "place": bool(b.delivery.region),
            "pincode": bool(b.delivery.pincode)}
    for u in b.unknowns:
        if u.status != "open":
            continue
        for topic, rx in _Q_TOPICS.items():
            if have[topic] and (u.topic == topic or rx.search(u.question)):
                u.status, u.answer = "answered", "Already in your brief"
                break


class QuestionRefresh(BaseModel):
    resolved: list[str] = Field(default_factory=list, description="Ids of open questions the brief now already answers.")
    new_question: Optional[Unknown] = Field(default=None, description="At most one new question, or null.")


async def refresh_questions(pid: str) -> None:
    """After any brief change: refresh the questions and the adaptive panel layout together."""
    await asyncio.gather(_refresh_questions(pid), journey.refresh_layout(pid))


async def _refresh_questions(pid: str) -> None:
    """Close questions the brief now answers, and ask at most one new, relevant question - never one
    that was asked before (in any wording)."""
    brief = await store.get_brief(pid)
    if brief is None:
        return
    open_q = [u for u in brief.unknowns if u.status == "open"]
    if len(brief.unknowns) >= 6 and not open_q:
        return
    try:
        out, _ = await asyncio.wait_for(gemini.generate_structured(QuestionRefresh, [
            "Brief:\n" + brief.model_dump_json(include={"title", "purpose", "requirements", "budget", "delivery"}),
            "Open questions:\n" + json.dumps([{"id": u.id, "question": u.question} for u in open_q], ensure_ascii=False),
            "Every question asked before, answered or not (never repeat or rephrase any of these):\n- "
            + "\n- ".join(u.question for u in brief.unknowns),
            "1) resolved: ids of open questions the brief already answers (e.g. a size question once that size is a "
            "requirement, a budget question once a budget is set). "
            "2) new_question: only if fewer than 2 questions stay open AND the answer would clearly change which products "
            "fit (a missing size limit, a device model, a quantity). Short, plain, with a `topic` key. Otherwise null.",
        ], purpose="question-refresh", fast=True), timeout=8)
    except Exception as e:  # questions are a nicety; never block an edit on them
        log.info("question refresh skipped: %s", e)
        return
    asked = {re.sub(r"\W+", " ", u.question.lower()).strip() for u in brief.unknowns}
    changed = False
    for u in brief.unknowns:
        if u.status == "open" and u.id in out.resolved:
            u.status, u.answer = "answered", "Already in your brief"
            changed = True
    nq = out.new_question
    if nq and sum(1 for u in brief.unknowns if u.status == "open") < 2 and re.sub(r"\W+", " ", nq.question.lower()).strip() not in asked \
            and not any(nq.topic and u.topic == nq.topic for u in brief.unknowns):
        nq.id = f"q{len(brief.unknowns) + 1}-{(nq.topic or 'more')[:20]}"
        nq.status, nq.answer = "open", None
        brief.unknowns.append(nq)
        changed = True
    if changed:
        await store.save_brief(pid, brief)


async def revert_brief(pid: str, to_version: int, requirement_ids: Optional[list[str]] = None) -> Brief:
    """Restore the brief (or just some requirements) as it was in an earlier version - saved as a new version."""
    current = await _require_brief(pid)
    old = await store.get_brief(pid, to_version)
    if old is None:
        raise ServiceError("That version doesn't exist.", 404)
    if old.version == current.version:
        return current

    def mutate(b: Brief) -> None:
        if requirement_ids:
            olds = {r.id: r for r in old.requirements}
            keep = [r for r in b.requirements if r.id not in requirement_ids]
            b.requirements = keep + [olds[i] for i in requirement_ids if i in olds]
        else:
            b.requirements, b.budget, b.delivery = old.requirements, old.budget, old.delivery
            b.title, b.purpose = old.title, old.purpose

    what = ", ".join(r.label for r in old.requirements if requirement_ids and r.id in requirement_ids) or f"everything as in v{old.version}"
    summary = f"Restored {what}"
    if not current.confirmed:
        mutate(current)
        await store.save_brief(pid, current)
        await store.log(pid, "customer", summary, kind="change")
        return current
    brief = await store.new_brief_version(pid, mutate, summary=summary)
    await store.log(pid, "customer", f"Brief v{brief.version}: {summary}", kind="change")
    return brief


async def confirm_brief(pid: str) -> Brief:
    brief = await _require_brief(pid)
    pending = [r.label for r in brief.musts() if r.status == "needs_checking"]
    if pending:
        raise ServiceError("Measure or edit these first: " + "; ".join(pending), 409, pending)
    if not brief.confirmed:
        brief.confirmed = True
        brief.change_summary = brief.change_summary if brief.version > 1 else "You confirmed your brief."
        await store.save_brief(pid, brief)
    await _advance(pid, "visualise")
    await store.log(pid, "customer", f"Confirmed the brief (v{brief.version})", kind="decision")
    return brief


async def add_requirement_from_text(pid: str, text: str, kind: str) -> Brief:
    """'Max width 30 cm' -> a checkable requirement (Gemini structures it; the customer's words stay the label)."""
    brief = await _require_brief(pid)
    req, _ = await gemini.generate_structured(
        Requirement,
        ["Existing brief:\n" + brief.model_dump_json(include={"title", "requirements"}),
         f"The customer adds this as a {'must-have' if kind == 'must' else 'nice-to-have'}: \"{text.strip()}\"",
         "Return one requirement: a new kebab-case id, their words as the label, kind as given, source 'customer', status "
         "'confirmed', and checkable attribute/op/value when the words allow it."],
        purpose="add-requirement", fast=True,
    )
    req.kind = "must" if kind == "must" else "flexible"
    req.source, req.status = "customer", "confirmed"
    if any(r.id == req.id for r in brief.requirements):
        req.id = f"{req.id}-{len(brief.requirements) + 1}"
    return await edit_brief(pid, BriefPatch(requirements=brief.requirements + [req], summary=f"Added: {req.label}"))


class UnknownResolution(BaseModel):
    requirement: Optional[Requirement] = Field(default=None, description="A new or updated requirement implied by the answer, or null.")


async def answer_unknown(pid: str, unknown_id: str, answer: Optional[str], dont_know: bool) -> Brief:
    brief = await _require_brief(pid)
    target = next((u for u in brief.unknowns if u.id == unknown_id), None)
    if target is None:
        raise ServiceError("That question no longer exists.", 404)
    new_req: Optional[Requirement] = None
    stats = None
    if answer and not dont_know:
        resolution, stats = await gemini.generate_structured(
            UnknownResolution,
            ["Brief:\n" + brief.model_dump_json(), f"Question: {target.question}\nCustomer's answer: {answer}",
             "If the answer states a checkable requirement (e.g. a measurement), return it as a requirement with source "
             "'customer', status 'confirmed'. Reuse an existing id if it updates one. Else null."],
            purpose="unknown-resolver",
        )
        new_req = resolution.requirement

    def mutate(b: Brief) -> None:
        for u in b.unknowns:
            if u.id == unknown_id:
                u.answer = answer if not dont_know else None
                u.status = "dont_know" if dont_know else "answered"
        if new_req is not None:
            b.requirements = [r for r in b.requirements if r.id != new_req.id] + [new_req]

    summary = f"Answered: {target.question}" if not dont_know else f"Not sure yet: {target.question}"
    if brief.confirmed:
        brief = await store.new_brief_version(pid, mutate, summary=summary)
    else:
        mutate(brief)
        await store.save_brief(pid, brief)
    await store.log(pid, "customer", summary + (f" -> added '{new_req.label}'" if new_req else ""),
                    stats=[stats.as_dict()] if stats else None)
    await refresh_questions(pid)
    return await store.get_brief(pid) or brief


# =============================================================================================
# Visualise (design agent)
# =============================================================================================


def _draw_pin(image: bytes, x: float, y: float) -> bytes:
    from PIL import Image, ImageDraw

    im = Image.open(io.BytesIO(image)).convert("RGB")
    w, h = im.size
    r = max(w, h) * 0.07
    cx, cy = x * w, y * h
    d = ImageDraw.Draw(im)
    for k in range(6):
        d.ellipse([cx - r - k, cy - r - k, cx + r + k, cy + r + k], outline=(215, 255, 60))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


async def generate_concept(pid: str, *, instruction: str = "", parent_id: Optional[str] = None,
                           pin: Optional[tuple[float, float]] = None) -> dict[str, Any]:
    brief = await _require_brief(pid)
    refs: list[tuple[bytes, str]] = []
    if parent_id:
        parent = await store.get(pid, "concepts", parent_id)
        if parent:
            data, mime = await store.download_media(parent["image_path"])
            if pin:
                data, mime = _draw_pin(data, pin[0], pin[1]), "image/png"
            refs.append((data, mime))
    prompt_parts = [
        "Brief (v%d):\n%s" % (brief.version, brief.model_dump_json(include={"title", "purpose", "requirements", "budget"})),
        "Customer refinement: " + (instruction or "First concept - show the brief faithfully."),
        "Reference image of the previous concept is attached: " + ("yes" if refs else "no"),
    ]
    if pin:
        prompt_parts.append("The customer marked an area with a ring.")
    direction_raw, s1 = await run_specialist(sp.studio_director, prompt_parts)
    direction = sp.ConceptDirection.model_validate(direction_raw)
    image, mime, s2 = await gemini.generate_image(direction.image_prompt, purpose="studio-concept", reference_images=refs)
    cid = store.new_id("cpt")
    path = await store.upload_media(f"projects/{pid}/concepts/{cid}", image, mime)
    applied = await _apply_visual_effects(pid, brief, direction.brief_effects, instruction) if instruction else None
    concept = {
        "id": cid, "image_path": path, "caption": direction.caption, "instruction": instruction, "parent_id": parent_id,
        "pin": list(pin) if pin else None, "brief_version": brief.version, "prompt": direction.image_prompt,
        "effects": [e.model_dump(exclude={"new_requirement"}) for e in direction.brief_effects], "applied": applied,
        "label": "concept", "created_at": now_iso(),
    }
    await store.put(pid, "concepts", cid, concept)
    await store.update_project(pid, selected_concept_id=cid)
    await _advance(pid, "visualise")
    await store.log(pid, "agent:design_agent", f"Drew a concept: {direction.caption}" + (f" ({instruction})" if instruction else ""),
                    kind="agent", detail="Gemini wrote the art direction and Gemini image generation drew it. It's an illustration, not an offer.",
                    stats=[s1, s2.as_dict()])
    return concept


async def _apply_visual_effects(pid: str, brief: Brief, effects: list[Any], instruction: str) -> Optional[dict[str, Any]]:
    """The customer's own visual edit ('make it 25 cm wide') updates the brief directly; the UI shows exactly
    what changed with a one-tap revert. Returns {from_version, to_version, changes[{id, before, after}]}."""
    reqs = [e.new_requirement for e in effects if getattr(e, "new_requirement", None)]
    if not reqs:
        return None
    before = {r.id: r for r in brief.requirements}
    changes = []
    for r in reqs:
        r.source, r.status = "customer", "confirmed"
        old = before.get(r.id)
        if old and old.label == r.label and old.value_num == r.value_num and old.kind == r.kind:
            continue
        changes.append({"id": r.id, "before": old.label if old else None, "after": r.label, "kind": r.kind})
    if not changes:
        return None
    new_ids = {r.id for r in reqs}

    def mutate(b: Brief) -> None:
        b.requirements = [x for x in b.requirements if x.id not in new_ids] + reqs

    summary = f"From your visual edit \"{instruction[:60]}\": " + "; ".join(
        (f"{c['before']} -> {c['after']}" if c["before"] else f"added {c['after']}") for c in changes)
    if brief.confirmed:
        updated = await store.new_brief_version(pid, mutate, summary=summary, by="customer (visual edit)")
    else:
        mutate(brief)
        updated = await store.save_brief(pid, brief)
    await store.log(pid, "customer", summary, kind="change", detail="Applied from your instruction. You can revert it in one tap.")
    return {"from_version": brief.version if brief.confirmed else updated.version, "to_version": updated.version, "changes": changes,
            "previous": [before[c["id"]].model_dump() for c in changes if c["id"] in before],
            "added": [c["id"] for c in changes if c["id"] not in before], "reverted": False}


async def revert_visual_edit(pid: str, cid: str) -> Brief:
    """Undo the brief change a visual edit made: put back the earlier requirements, drop the added ones."""
    concept = await store.get(pid, "concepts", cid)
    applied = (concept or {}).get("applied")
    if not applied or applied.get("reverted"):
        raise ServiceError("Nothing to revert for this concept.", 409)
    previous = [Requirement.model_validate(r) for r in applied.get("previous") or []]
    drop = set(applied.get("added") or []) | {r.id for r in previous}

    def mutate(b: Brief) -> None:
        b.requirements = [r for r in b.requirements if r.id not in drop] + previous

    summary = "Reverted the visual edit: back to " + ("; ".join(r.label for r in previous) or "the earlier brief")
    current = await _require_brief(pid)
    if current.confirmed:
        brief = await store.new_brief_version(pid, mutate, summary=summary)
    else:
        mutate(current)
        brief = await store.save_brief(pid, current)
    applied["reverted"] = True
    concept["applied"] = applied
    await store.put(pid, "concepts", cid, concept)
    await store.log(pid, "customer", summary, kind="change")
    return brief


async def select_concept(pid: str, cid: str) -> None:
    await store.update_project(pid, selected_concept_id=cid)


# =============================================================================================
# Find options (ADK Workflow: shopping agent + maker scout in parallel)
# =============================================================================================


async def explore_routes(pid: str) -> AsyncIterator[dict[str, Any]]:
    brief = await _require_brief(pid)
    if not brief.confirmed:
        raise ServiceError("Confirm your brief first, so the search matches what you need.", 409)
    city = _city(brief) or "India"
    from .agents import shopper
    idea = ((await store.get_project(pid)) or {}).get("idea")
    shopper.IDEA.set(idea if idea and idea.get("items") else None)
    sessions = InMemorySessionService()
    runner = Runner(app_name="find-options", node=route_workflow, session_service=sessions)
    session = await sessions.create_session(app_name="find-options", user_id="system", state={"project_id": pid})
    msg = types.Content(role="user", parts=[types.Part(text=f"Find options for brief v{brief.version}")])
    result: Optional[dict[str, Any]] = None
    started = datetime.now(timezone.utc)
    yield {"type": "progress", "agent": "Shopping agent", "message": f"Searching real stores that deliver to {city}"
           + (f" for your idea: {', '.join(idea['items'][:3])}" if idea and idea.get("items") else "")}
    yield {"type": "progress", "agent": "Maker scout", "message": f"Looking for makers near {city} who could make it"}
    async for ev in runner.run_async(user_id="system", session_id=session.id, new_message=msg):
        node = getattr(ev, "node_name", None) or ""
        out = getattr(ev, "output", None)
        if out is None or node not in PROGRESS:
            continue
        agent, message = PROGRESS[node](out)
        yield {"type": "progress", "agent": agent, "message": message}
        if node == "advisor":
            result = out
    if result is None:
        raise ServiceError("The search did not finish - please try again.", 500)

    entries = result["entries"]
    # A store's generic share picture (the same image on different products) is not a product photo.
    seen_img: dict[str, set[str]] = {}
    for e in entries:
        if e.get("image_url"):
            seen_img.setdefault(e["image_url"], set()).add((e.get("url") or "").split("?")[0])
    for e in entries:
        if e.get("image_url") and len(seen_img.get(e["image_url"], ())) > 1:
            e["image_url"] = None
    if not entries:
        raise ServiceError("The web search is busy right now - please try again in a minute. " + " ".join(result.get("errors") or []), 503)
    entries.sort(key=lambda e: -(e.get("relevance") or 0))
    groups = {k: [e["item_id"] for e in entries if e["verdict"] == k] for k in ("meets", "possible_with_change", "not_suitable", "needs_quote")}
    routes_doc = {
        "brief_version": brief.version, "checked_at": now_iso(), "city": city, "entries": entries, "groups": groups,
        "sources": result["sources"], "narrative": result["narrative"],
        "duration_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
    }
    await store.put(pid, "routes", "latest", routes_doc)
    await _advance(pid, "routes")
    buy = [e for e in entries if e["route"] == "buy"]
    await store.log(
        pid, "agent:shopping_agent",
        f"Found {len(buy)} listings ({len(groups['meets'])} fit, {len(groups['possible_with_change'])} worth checking) "
        f"and {len(groups['needs_quote'])} makers",
        kind="agent", detail="Gemini searched the web with Google Search grounding; every listing links to its real page. "
        "The fit checker compared each one with your must-haves. " + result["narrative"]["headline"],
        stats=result["stats"],
    )
    yield {"type": "result", "routes": routes_doc}


async def _routes(pid: str) -> dict[str, Any]:
    r = await store.get(pid, "routes", "latest")
    if not r:
        raise ServiceError("Find options first.", 409)
    return r


# =============================================================================================
# Reach out: the outreach agent messages or calls real makers / sellers for the customer
# =============================================================================================
# Each recipient gets its own channel - email (sent from the customer's connected inbox), a phone call
# by the voice agent, or WhatsApp (opened ready to send, with the photos). Photos go out as privacy-
# scrubbed copies. Only the brief is shared - never the customer's name, phone number or address.


def _channels(contact: dict[str, Any], subject: str, body: str) -> dict[str, Optional[str]]:
    email = (contact or {}).get("email")
    phone = re.sub(r"[^\d+]", "", (contact or {}).get("phone") or "")
    if phone and not phone.startswith("+") and len(phone) == 10:
        phone = "91" + phone
    return {
        "mailto": f"mailto:{email}?subject={urlquote(subject)}&body={urlquote(body)}" if email else None,
        "whatsapp": f"https://wa.me/{phone.lstrip('+')}?text={urlquote(body)}" if phone else None,
        "website": (contact or {}).get("website"),
    }


_PII_TEXT = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+|(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b")


def _clean_text(s: str) -> str:
    """Belt and braces: no email addresses or phone numbers in an outgoing message."""
    return _PII_TEXT.sub("[removed]", s or "")


async def _attachments_for(pid: str) -> list[dict[str, Any]]:
    """What the customer shared and what Gemini drew, as privacy-scrubbed copies ready to attach."""
    from . import visual

    project = await store.get_project(pid) or {}
    srcs: list[tuple[str, str]] = []
    insp = project.get("inspiration") or {}
    if insp.get("image_path"):
        srcs.append((insp["image_path"], "Inspiration (generated by Gemini)" if insp.get("generated_image") else "Photo of my space / inspiration"))
    cid = project.get("selected_concept_id")
    if cid:
        c = await store.get(pid, "concepts", cid)
        if c:
            srcs.append((c["image_path"], f"Concept sketch: {c['caption']}"))
    looks = await store.list_coll(pid, "looks")
    if looks:
        srcs.append((looks[-1]["image_path"], "How it could look"))
    out = []
    for path, label in srcs[:3]:
        try:
            out.append(await visual.shareable_copy(pid, path, label))
        except Exception as e:
            log.warning("attachment skipped (%s): %s", label, e)
    return out


async def draft_outreach(pid: str, entry_ids: list[str], share_budget: bool = True) -> dict[str, Any]:
    brief = await _require_brief(pid)
    routes = await _routes(pid)
    picked = [e for e in routes["entries"] if e["item_id"] in entry_ids]
    if not picked:
        raise ServiceError("Choose at least one maker or seller to contact.")
    attachments = await _attachments_for(pid)
    notes = [n["text"] for n in await store.list_coll(pid, "notes") if n.get("share")]
    shared = {
        "title": brief.title, "purpose": brief.purpose,
        "must_haves": [r.label for r in brief.musts()],
        "nice_to_haves": [r.label for r in brief.requirements if r.kind == "flexible"],
        "budget": brief.budget.model_dump(include={"target_inr", "limit_inr"}) if share_budget else "not shared",
        "delivery_city": _city(brief) or None, "delivery_pin_code": brief.delivery.pincode, "deadline": brief.delivery.desired_by,
        "attached_images": [a["label"] for a in attachments], "customer_notes": notes[:3],
    }
    recipients_in = [{"name": e["seller_name"], "what_they_offer": e["description"],
                      "listing": e["name"] if e["route"] == "buy" else None} for e in picked]
    out, stats = await run_specialist(sp.outreach_writer, [
        "What the customer wants (only these details may be shared):\n" + json.dumps(shared, ensure_ascii=False),
        "Write one message per recipient:\n" + json.dumps(recipients_in, ensure_ascii=False),
        "If images are attached, mention them in one short line (e.g. 'I've attached a photo of the space and a concept sketch').",
    ])
    drafts = sp.OutreachDrafts.model_validate(out).messages
    rid = store.new_id("req")
    ref = "TSL-" + rid[-6:].upper()
    recipients = []
    from . import contacts
    lookups = await asyncio.gather(*(contacts.find(e["seller_name"], e.get("url")) if not (e.get("contact") or {}).get("email")
                                     else _noop() for e in picked))
    for e, got in zip(picked, lookups):
        if got:
            e["contact"] = {**(e.get("contact") or {"website": e.get("url")}),
                            **{k: v for k, v in (("email", got.get("email")), ("phone", got.get("phone"))) if v and not (e.get("contact") or {}).get(k)},
                            "found_on": got.get("source"), "found_page": got.get("page")}
    for e in picked:
        m = next((d for d in drafts if d.recipient.lower()[:12] == e["seller_name"].lower()[:12]), drafts[0] if drafts else None)
        subject = f"{m.subject if m else 'Quote request: ' + brief.title} [{ref}]"
        body = _clean_text(m.body if m else brief.purpose)
        contact = e.get("contact") or {"website": e.get("url")}
        channel = "email" if contact.get("email") else "call" if contact.get("phone") else "email"
        recipients.append({"entry_id": e["item_id"], "name": e["seller_name"], "url": e.get("url"), "contact": contact,
                           "subject": subject, "body": body, "channels": _channels(contact, subject, body), "channel": channel,
                           "attachments": [a["id"] for a in attachments], "status": "draft"})
    req = {"id": rid, "ref": ref, "kind": "outreach", "brief_version": brief.version, "recipients": recipients,
           "seller_names": [r["name"] for r in recipients], "status": "draft", "responses": [], "created_at": now_iso(),
           "shared": shared, "attachments": attachments, "seen_replies": []}
    await store.put(pid, "requests", rid, req)
    await _advance(pid, "request")
    await store.log(pid, "agent:outreach_agent", f"Drafted {len(recipients)} message{'s' if len(recipients) != 1 else ''}"
                    + (f" with {len(attachments)} photo{'s' if len(attachments) != 1 else ''}" if attachments else ""),
                    kind="agent", detail="Only your brief is shared - never your name, number or address. Photos are privacy-checked: "
                    "camera data removed, faces and personal details blurred. " + "; ".join(
                        f"{a['label']}: " + ("blurred " + ", ".join(a['privacy']['blurred']) if a["privacy"]["blurred"] else "nothing personal found")
                        for a in attachments), stats=[stats])
    return req


async def _noop() -> dict[str, Any]:
    return {}


async def find_recipient_contact(pid: str, rid: str, entry_id: str) -> dict[str, Any]:
    """Look up a business's published email and phone (its website first, then Google Search)."""
    from . import contacts

    req = await store.get(pid, "requests", rid)
    r = next((x for x in (req or {}).get("recipients", []) if x["entry_id"] == entry_id), None)
    if r is None:
        raise ServiceError("Recipient not found.", 404)
    got = await contacts.find(r["name"], r.get("url") or (r.get("contact") or {}).get("website"))
    c = dict(r.get("contact") or {})
    if not got:
        c["found_on"] = None  # looked, nothing published
        r["contact"] = c
        await store.put(pid, "requests", rid, req)
        return req
    c.update({k: v for k, v in (("email", got.get("email")), ("phone", got.get("phone"))) if v and not c.get(k)})
    c["found_on"], c["found_page"] = got.get("source"), got.get("page")
    r["contact"] = c
    if c.get("email") and r.get("channel") != "whatsapp":
        r["channel"] = "email"
    r["channels"] = _channels(c, r["subject"], r["body"])
    await store.put(pid, "requests", rid, req)
    await store.log(pid, "agent:outreach_agent", f"Found {r['name']}'s contact details on {got.get('source')}", kind="agent",
                    detail=" · ".join(x for x in (c.get("email"), c.get("phone"), got.get("page")) if x))
    return req


async def use_idea(pid: str, cid: str) -> AsyncIterator[dict[str, Any]]:
    """Shop an idea: search real stores for exactly its products, then place the real ones into the customer's photo."""
    concept = await store.get(pid, "concepts", cid)
    if not concept or not concept.get("idea"):
        raise ServiceError("That idea is no longer here.", 404)
    idea = concept["idea"]
    await store.update_project(pid, selected_concept_id=cid, idea={"concept_id": cid, "title": idea["title"],
                                                                  "items": [i["name"] for i in idea["items"]][:3]})
    await store.log(pid, "customer", f"Chose the idea \"{idea['title']}\"", kind="decision",
                    detail="Products to find: " + ", ".join(i["name"] for i in idea["items"]))
    routes = None
    async for ev in explore_routes(pid):
        if ev["type"] == "result":
            routes = ev["routes"]
        else:
            yield ev
    found = sum(1 for e in (routes or {}).get("entries", []) if e["route"] == "buy" and e["verdict"] in ("meets", "possible_with_change"))
    look = None
    if routes and any(e.get("image_url") for e in routes["entries"] if e["route"] == "buy"):
        yield {"type": "progress", "agent": "Design agent", "message": "Placing the real products into your photo"}
        try:
            look = await make_look(pid)
        except ServiceError as e:
            yield {"type": "progress", "agent": "Design agent", "message": f"Skipped the picture: {e}"}
    yield {"type": "result", "found": found, "look_id": look["id"] if look else None}


class RecipientPatch(BaseModel):
    channel: Optional[Literal["email", "call", "whatsapp"]] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    attachments: Optional[list[str]] = None


async def update_recipient(pid: str, rid: str, entry_id: str, patch: RecipientPatch) -> dict[str, Any]:
    req = await store.get(pid, "requests", rid)
    if not req:
        raise ServiceError("Message not found.", 404)
    r = next((x for x in req["recipients"] if x["entry_id"] == entry_id), None)
    if r is None:
        raise ServiceError("Recipient not found.", 404)
    if patch.channel:
        r["channel"] = patch.channel
    if patch.email is not None:
        if patch.email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", patch.email.strip()):
            raise ServiceError("That email address doesn't look right.")
        r["contact"] = {**(r.get("contact") or {}), "email": patch.email.strip() or None}
    if patch.phone is not None:
        r["contact"] = {**(r.get("contact") or {}), "phone": patch.phone.strip() or None}
    if patch.subject is not None:
        r["subject"] = patch.subject[:200]
    if patch.body is not None:
        r["body"] = _clean_text(patch.body[:4000])
    if patch.attachments is not None:
        known = {a["id"] for a in req.get("attachments") or []}
        r["attachments"] = [a for a in patch.attachments if a in known]
    r["channels"] = _channels(r.get("contact") or {}, r["subject"], r["body"])
    await store.put(pid, "requests", rid, req)
    return req


async def send_outreach(pid: str, rid: str, entry_ids: Optional[list[str]], public_base: str, wa_ok: bool = False, device: bool = False,
                        reply_to: Optional[str] = None) -> AsyncIterator[dict[str, Any]]:
    """The outreach agent sends each message on its chosen channel, right from Tesselle."""
    from . import channels

    req = await store.get(pid, "requests", rid)
    if not req:
        raise ServiceError("Message not found.", 404)
    st = await channels.status()
    atts = {a["id"]: a for a in req.get("attachments") or []}
    targets = [r for r in req["recipients"] if (not entry_ids or r["entry_id"] in entry_ids) and r["status"] in ("draft", "failed")]
    if not targets:
        raise ServiceError("Nothing left to send.", 409)
    for r in targets:
        ch = r.get("channel") or "email"
        if ch == "email" and device:  # sent from the customer's own Gmail (compose window opened on their device)
            r["status"], r["sent_at"], r["error"] = "sent", now_iso(), None
            await store.log(pid, "customer", f"Emailed {r['name']} from their own Gmail", kind="decision",
                            detail=f"Reference {req['ref']} is in the subject, so the reply can be matched.")
            continue
        if ch == "email":
            to = (r.get("contact") or {}).get("email")
            if not to:
                r["status"], r["error"] = "failed", "No email address - add one, or call them instead."
                yield {"type": "progress", "agent": "Outreach agent", "message": f"{r['name']}: no email address"}
                continue
            if not st["email"]:
                r["status"], r["error"] = "failed", "Email sending isn't connected yet."
                yield {"type": "progress", "agent": "Outreach agent", "message": "Email sending isn't connected yet"}
                continue
            yield {"type": "progress", "agent": "Outreach agent", "message": f"Emailing {r['name']}"
                   + (f" with {len(r.get('attachments') or [])} photo(s)" if r.get("attachments") else "")}
            files = []
            for aid in r.get("attachments") or []:
                a = atts.get(aid)
                if a:
                    data, mime = await store.download_media(a["path"])
                    files.append((re.sub(r"[^A-Za-z0-9]+", "-", a["label"]).strip("-")[:40] + ".jpg", data, mime))
            body = r["body"] + ("\n\n--\nSent by Tesselle, an AI shopping agent, for a customer. Just reply to this email to answer.")
            try:
                r["message_id"] = await channels.send_email(to, r["subject"], body, files, reply_to=reply_to)
                r["status"], r["sent_at"], r["error"] = "sent", now_iso(), None
                await store.log(pid, "agent:outreach_agent", f"Emailed {r['name']}" + (f" with {len(files)} photo(s)" if files else ""), kind="agent",
                                detail=f"Sent from your connected inbox. Reference {req['ref']} - replies are read automatically.")
            except Exception as e:
                r["status"], r["error"] = "failed", f"Couldn't send: {type(e).__name__}"
                log.warning("email send failed: %s", e)
        elif ch == "call":
            phone = channels.normalise_phone((r.get("contact") or {}).get("phone") or "")
            if not phone:
                r["status"], r["error"] = "failed", "No phone number - add one, or email them instead."
                continue
            if not st["calls"]:
                r["status"], r["error"] = "failed", "Calling isn't connected yet."
                yield {"type": "progress", "agent": "Call agent", "message": "Calling isn't connected yet"}
                continue
            yield {"type": "progress", "agent": "Call agent", "message": f"Calling {r['name']}"}
            call_id = store.new_id("call")
            call = {"id": call_id, "request_id": rid, "entry_id": r["entry_id"], "name": r["name"], "to": phone, "status": "dialling",
                    "transcript": [], "turns": 0, "created_at": now_iso(), "processed": False,
                    "stream_token": secrets.token_urlsafe(18),  # real-time voice (Twilio Media Streams + Gemini Live)
                    "record": os.environ.get("TESSELLE_RECORD_CALLS") == "1"}  # off unless switched on for a demo; the agent says so
            await store.put(pid, "calls", call_id, call)
            await store.db().collection("call_index").document(call_id).set({"pid": pid})
            try:
                call["twilio_sid"] = await channels.start_call(phone, call_id, public_base)
                await store.put(pid, "calls", call_id, call)
                r["status"], r["call_id"], r["sent_at"], r["error"] = "calling", call_id, now_iso(), None
                await store.log(pid, "agent:call_agent", f"Calling {r['name']} to ask for a quote", kind="agent",
                                detail="The voice agent says it is an AI assistant calling for a customer, asks your questions and "
                                "writes down the answers. Your details are never shared.")
            except Exception as e:
                call["status"] = "failed"
                await store.put(pid, "calls", call_id, call)
                r["status"], r["error"] = "failed", str(e)[:160]
        else:  # whatsapp: sent through Twilio when connected; otherwise opened on the customer's device
            phone = channels.normalise_phone((r.get("contact") or {}).get("phone") or "")
            if st.get("whatsapp") and phone and wa_ok:
                yield {"type": "progress", "agent": "Outreach agent", "message": f"WhatsApp to {r['name']}"
                       + (f" with {len(r.get('attachments') or [])} photo(s)" if r.get("attachments") else "")}
                media = [f"{public_base}/api/media/{atts[a]['path']}" for a in r.get("attachments") or [] if a in atts]
                body = r["body"] + f"\n\n- Sent by Tesselle, an AI shopping agent, for a customer. Just reply here. Ref {req['ref']}"
                try:
                    r["message_id"] = await channels.send_whatsapp(phone, body, media)
                    r["status"], r["sent_at"], r["error"] = "sent", now_iso(), None
                    await store.db().collection("wa_index").document(phone.lstrip("+")).set(
                        {"pid": pid, "request_id": rid, "entry_id": r["entry_id"], "name": r["name"], "at": now_iso()})
                    await store.log(pid, "agent:outreach_agent", f"Sent WhatsApp to {r['name']}" + (f" with {len(media)} photo(s)" if media else ""),
                                    kind="agent", detail="Replies on WhatsApp come straight back into Tesselle and are checked against your brief.")
                except Exception as e:
                    r["status"], r["error"] = "failed", str(e)[:160]
            else:
                r["status"], r["sent_at"] = "sent", now_iso()
                await store.log(pid, "customer", f"Sent the message to {r['name']} on WhatsApp", kind="decision")
    req["status"] = "sent" if any(r["status"] in ("sent", "calling", "called") for r in req["recipients"]) else req["status"]
    req["sent_at"] = req.get("sent_at") or now_iso()
    await store.put(pid, "requests", rid, req)
    yield {"type": "result"}


async def mark_sent(pid: str, rid: str, entry_id: Optional[str] = None) -> dict[str, Any]:
    req = await store.get(pid, "requests", rid)
    if not req:
        raise ServiceError("Message not found.", 404)
    for r in req["recipients"]:
        if entry_id is None or r["entry_id"] == entry_id:
            r["status"] = "sent"
            r["sent_at"] = now_iso()
    req["status"] = "sent"
    req["sent_at"] = req.get("sent_at") or now_iso()
    await store.put(pid, "requests", rid, req)
    names = ", ".join(r["name"] for r in req["recipients"] if r["status"] == "sent")
    await store.log(pid, "customer", f"Sent the message to {names}", kind="decision")
    return req


async def check_replies(pid: str, rid: Optional[str] = None) -> AsyncIterator[dict[str, Any]]:
    """Read new replies to Tesselle's emails from the connected inbox and check each against the brief."""
    from . import channels

    reqs = [r for r in await store.list_coll(pid, "requests") if r.get("ref") and (not rid or r["id"] == rid)]
    found = 0
    for req in reqs:
        yield {"type": "progress", "agent": "Reply reader", "message": f"Checking your inbox for replies to {req['ref']}"}
        try:
            msgs = await channels.find_replies(req["ref"])
        except Exception as e:
            raise ServiceError(f"Couldn't read the inbox: {e}", 503)
        seen = set(req.get("seen_replies") or [])
        for m in msgs:
            if not m.get("message_id") or m["message_id"] in seen:
                continue
            sender = m["from"].lower()
            r = next((x for x in req["recipients"] if (x.get("contact") or {}).get("email") and x["contact"]["email"].lower() in sender), None)
            name = r["name"] if r else email_name(m["from"])
            yield {"type": "progress", "agent": "Reply reader", "message": f"Reading {name}'s reply"}
            img = m["files"][0] if m["files"] else None
            await add_reply(pid, text=m["text"], image=img, request_id=req["id"], seller_name=name, entry_id=r["entry_id"] if r else None)
            seen.add(m["message_id"])
            found += 1
            fresh = await store.get(pid, "requests", req["id"]) or req
            fresh["seen_replies"] = list(seen)
            for x in fresh["recipients"]:
                if r and x["entry_id"] == r["entry_id"]:
                    x["status"] = "replied"
            await store.put(pid, "requests", req["id"], fresh)
    yield {"type": "progress", "agent": "Reply reader", "message": f"{found} new repl{'y' if found == 1 else 'ies'}" if found else "No new replies yet"}
    yield {"type": "result", "found": found}


def email_name(addr: str) -> str:
    import email.utils as eu

    name, a = eu.parseaddr(addr)
    return name or a.split("@")[-1].split(".")[0].title()


# ---- Calls: the voice agent asks a maker for a quote --------------------------------------------


class CallTurn(BaseModel):
    say: str = Field(description="What to say next: one or two short spoken sentences.")
    done: bool = Field(description="True when every question is answered, they declined, or it's time to end politely.")


CALL_RULES = (
    "You are Tesselle's call agent, an AI assistant phoning a small business in India for a customer to get a quote. "
    "Be warm, brief and polite; speak simple English. You already said you are an AI assistant calling for a customer. "
    "Goals, in order: can they make or supply it; can they meet each must-have (ask one at a time); price including any "
    "delivery or extra charges; how long it takes. Never agree to buy, pay or change a must-have - say the customer will "
    "decide and follow up. Never share the customer's name, phone number or address (say the customer will follow up by "
    "email). Don't end until you have asked about the price AND how long it takes - unless they're busy or not interested, "
    "then thank them and end. One question per turn; end after at most 8 questions."
)


async def call_context(pid: str, call_id: str) -> tuple[dict[str, Any], Brief]:
    call = await store.get(pid, "calls", call_id)
    brief = await store.get_brief(pid)
    if not call or not brief:
        raise ServiceError("Call not found.", 404)
    return call, brief


async def call_opening(pid: str, call_id: str) -> str:
    call, brief = await call_context(pid, call_id)
    city = _city(brief) or "India"
    line = (f"Hello! I'm Tesselle, an AI assistant calling on behalf of a customer in {city}. They'd like a quote for "
            f"{brief.title.lower()}. Is this a good time for a few quick questions?")
    call["status"] = "in_progress"
    call["transcript"].append({"who": "agent", "text": line})
    await store.put(pid, "calls", call_id, call)
    return line


async def call_turn(pid: str, call_id: str, heard: str) -> tuple[str, bool]:
    call, brief = await call_context(pid, call_id)
    if heard.strip():
        call["transcript"].append({"who": "them", "text": heard.strip()[:600]})
    call["turns"] = call.get("turns", 0) + 1
    if call["turns"] > 10 or (not heard.strip() and call["turns"] > 2 and not call["transcript"][-1]["text"]):
        out = CallTurn(say="Thank you for your time. The customer will follow up by email. Goodbye!", done=True)
    else:
        try:
            out, _ = await gemini.generate_structured(CallTurn, [
                CALL_RULES,
                "Brief:\n" + brief.model_dump_json(include={"title", "purpose", "requirements", "budget", "delivery"}),
                "Conversation so far:\n" + "\n".join(f"{'You' if t['who'] == 'agent' else 'Business'}: {t['text']}" for t in call["transcript"]),
                "" if heard.strip() else "(They didn't say anything - check if they can hear you, once.)",
            ], purpose="call-agent", fast=True)
        except Exception as e:
            log.warning("call turn failed: %s", e)
            out = CallTurn(say="Sorry, I have to go. The customer will follow up by email. Thank you!", done=True)
    call["transcript"].append({"who": "agent", "text": out.say})
    await store.put(pid, "calls", call_id, call)
    return out.say, out.done


async def finish_call(pid: str, call_id: str, twilio_status: str = "completed") -> None:
    """After the call: the reply reader turns the conversation into a quote the fit checker verifies."""
    call, _ = await call_context(pid, call_id)
    if call.get("processed"):
        return
    call["processed"] = True
    call["status"] = "completed" if twilio_status == "completed" else twilio_status
    await store.put(pid, "calls", call_id, call)
    said = [t for t in call["transcript"] if t["who"] == "them"]
    req = await store.get(pid, "requests", call["request_id"])
    if req:
        for r in req["recipients"]:
            if r["entry_id"] == call["entry_id"]:
                r["status"] = "called" if said else "failed"
                r["error"] = None if said else "No answer"
        await store.put(pid, "requests", call["request_id"], req)
    if not said:
        await store.log(pid, "agent:call_agent", f"{call['name']} didn't answer", kind="agent")
        return
    text = "Phone call transcript:\n" + "\n".join(f"{'Tesselle' if t['who'] == 'agent' else call['name']}: {t['text']}" for t in call["transcript"])
    await add_reply(pid, text=text, request_id=call["request_id"], seller_name=call["name"], entry_id=call["entry_id"])
    await store.log(pid, "agent:call_agent", f"Called {call['name']}: {len(said)} answers noted and checked", kind="agent")
    try:
        await _call_followup(pid, call, text)
    except Exception:
        log.exception("call follow-up failed")


class CallFollowUp(BaseModel):
    send_details: Literal["email", "whatsapp", "none"] = Field(
        description="How the business asked to be sent the details, photos or drawing during the call; 'none' if they didn't ask.")
    address: Optional[str] = Field(default=None, description="The email address or phone number they gave for it, as said; null if none was given.")


def _spoken_email(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    e = re.sub(r"\s+(at|@)\s+", "@", s.strip().lower())
    e = re.sub(r"\s+(dot|\.)\s+", ".", e).replace(" ", "")
    return e if re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", e) else None


async def send_call_followup(pid: str, call_id: str) -> None:
    """The customer taps "Email them the details" after a call: send the brief and photos to the business now."""
    call, _ = await call_context(pid, call_id)
    await _call_followup(pid, call, "", force=True)


async def _call_followup(pid: str, call: dict[str, Any], transcript: str, force: bool = False) -> None:
    """When the business asks for the details by email during the call, the outreach agent sends them straight away -
    the brief and the privacy-checked photos - from the connected inbox."""
    from . import channels

    req = await store.get(pid, "requests", call["request_id"])
    r = next((x for x in (req or {}).get("recipients", []) if x["entry_id"] == call["entry_id"]), None)
    if r is None:
        return
    fu = CallFollowUp(send_details="email") if force else None
    if fu is None:
        fu, _ = await gemini.generate_structured(CallFollowUp, [
        transcript, "Should Tesselle now send the business the details, photos or a drawing in writing? Yes if they asked for them, or if "
        "Tesselle offered or promised to send or follow up with the details (for example 'the customer will follow up by email') and the "
        "business agreed or did not object. Which channel (email unless they asked for WhatsApp), and the address if they said one?",
        ], purpose="call-followup", fast=True)
    if fu.send_details != "email":
        return
    to = _spoken_email(fu.address) or (r.get("contact") or {}).get("email")
    if not to:
        await store.log(pid, "agent:outreach_agent", f"{call['name']} asked for the details by email - add their address to send them", kind="agent")
        return
    if not (await channels.status())["email"]:
        await store.log(pid, "agent:outreach_agent", f"{call['name']} asked for the details by email - connect email sending to send them", kind="agent")
        if force:
            raise ServiceError("Email sending isn't connected yet.", 409)
        return
    atts = {a["id"]: a for a in req.get("attachments") or []}
    files = []
    for aid in r.get("attachments") or []:
        a = atts.get(aid)
        if a:
            data, mime = await store.download_media(a["path"])
            files.append((re.sub(r"[^A-Za-z0-9]+", "-", a["label"]).strip("-")[:40] + ".jpg", data, mime))
    body = (f"Hello {call['name']},\n\nThank you for taking our call just now. As you asked, here are the details for the quote.\n\n"
            + r["body"] + "\n\n--\nSent by Tesselle, an AI shopping agent, for a customer. Just reply to this email to answer.")
    mid = await channels.send_email(to, r["subject"], body, files)
    r["followup"] = {"channel": "email", "to": to, "sent_at": now_iso(), "message_id": mid, "photos": len(files)}
    r.setdefault("contact", {})["email"] = r.get("contact", {}).get("email") or to
    await store.put(pid, "requests", call["request_id"], req)
    await store.log(pid, "agent:outreach_agent", f"Emailed {call['name']} the details after the call, as they asked", kind="agent",
                    detail=f"To {to}" + (f" with {len(files)} photo(s)" if files else "") + f". Reference {req['ref']} - their reply is read automatically.")


# =============================================================================================
# Replies: read a seller's answer, check it, explain any change
# =============================================================================================


def _to_specs(o: sp.OfferedSpecs) -> Specs:
    return Specs(width_cm=o.width_cm, depth_cm=o.depth_cm, height_cm=o.height_cm, material=o.material, finish=o.finish,
                 mounting=o.mounting, features=o.features, attributes={a.key: a.value for a in o.attributes})


async def add_reply(pid: str, *, text: str = "", image: Optional[tuple[bytes, str]] = None, request_id: Optional[str] = None,
                    seller_name: str = "", entry_id: Optional[str] = None, simulated: bool = False,
                    previous: Optional[Quote] = None) -> Quote:
    brief = await _require_brief(pid)
    if not text.strip() and image is None:
        raise ServiceError("Paste the seller's reply or add a screenshot of it.")
    parts: list[Any] = [
        f"Brief v{brief.version} the seller was answering:\n"
        + brief.model_dump_json(include={"version", "title", "purpose", "requirements", "budget", "delivery"}),
        f"Seller: {seller_name or 'unknown'}",
    ]
    if text.strip():
        parts.append("Reply text:\n" + text.strip()[:6000])
    if image:
        parts += [types.Part.from_bytes(data=image[0], mime_type=image[1]), "Screenshot or document of the reply."]
    out, stats = await run_specialist(sp.reply_reader, parts)
    rq = sp.ReadQuote.model_validate(out)
    name = seller_name or rq.seller_name or "Seller"
    valid_until = (datetime.now(timezone.utc) + timedelta(days=rq.validity_days)).isoformat(timespec="seconds") if rq.validity_days else None
    quote = Quote(
        id=store.new_id("qte"), request_id=request_id or "manual", seller_id=entry_id or re.sub(r"[^a-z0-9]+", "-", name.lower())[:40],
        seller_name=name, brief_version=brief.version, round=(previous.round + 1) if previous else 1, title=rq.title,
        message=rq.summary, offered_specs=_to_specs(rq.offered_specs), responses=rq.responses, price_lines=rq.price_lines,
        lead_time_days_min=rq.lead_time_days_min, lead_time_days_max=rq.lead_time_days_max, valid_until=valid_until,
        terms=rq.terms, staged=simulated,
        note="Practice reply written by Gemini so you can try this step - not from a real business." if simulated else None,
    )
    quote.deviations = guard.quote_deviations(brief, quote)
    quote.readiness = guard.readiness(brief, quote)

    async def card_for(dev):
        return await run_specialist(sp.deviation_explainer, [
            "Brief requirement: " + (brief.req(dev.requirement_id).model_dump_json() if brief.req(dev.requirement_id) else dev.requirement_label),
            "Fit checker classification: " + dev.model_dump_json(include={"severity", "kind", "original", "proposed", "reason"}),
            f"Seller: {name}.",
        ])

    cards = await asyncio.gather(*(card_for(d) for d in quote.deviations))
    all_stats = [stats]
    for dev, (raw, st) in zip(quote.deviations, cards):
        dev.card = raw
        all_stats.append(st)
    if previous is not None:
        previous.status = "superseded"
        await store.save_quote(pid, previous)
    await store.save_quote(pid, quote)
    if request_id and request_id != "manual":
        req = await store.get(pid, "requests", request_id)
        if req:
            req["status"] = "responded"
            req["responses"] = (req.get("responses") or []) + [{"seller_name": name, "quote_id": quote.id, "at": now_iso()}]
            await store.put(pid, "requests", request_id, req)
    await _advance(pid, "compare")
    blocked = [d for d in quote.deviations if d.severity == "blocked"]
    await store.log(pid, "agent:reply_reader", f"Read {name}'s reply: {rq.title}", kind="agent",
                    detail=("Practice reply. " if simulated else "") + rq.summary, stats=[all_stats[0]])
    if quote.deviations:
        await store.log(pid, "agent:fit_checker", ("Blocked a change to a must-have: " if blocked else "A change needs your decision: ")
                        + "; ".join(f"{d.requirement_label} -> {d.proposed}" for d in quote.deviations),
                        kind="guard", detail="Checked in code against your brief. A seller can propose, but only you can change a must-have.",
                        stats=all_stats[1:])
    else:
        await store.log(pid, "agent:fit_checker", f"{name}'s reply keeps every must-have", kind="guard")
    return quote


async def simulate_reply(pid: str, request_id: Optional[str] = None, previous: Optional[Quote] = None,
                         decision_text: str = "") -> Quote:
    """A clearly labelled practice reply (Gemini) - lets anyone try the reply step without a real seller."""
    brief = await _require_brief(pid)
    req = await store.get(pid, "requests", request_id) if request_id else None
    seller = "Practice workshop"
    parts = [
        "Customer's brief:\n" + brief.model_dump_json(include={"version", "title", "purpose", "requirements", "budget", "delivery"}),
        f"This is ROUND {(previous.round + 1) if previous else 1}.",
    ]
    if req and req.get("recipients"):
        parts.append("Their message to you:\n" + req["recipients"][0]["body"])
    if previous is not None:
        parts.append("Your previous offer: " + previous.model_dump_json(include={"title", "offered_specs", "price_lines"}))
        parts.append("Customer's answer: " + decision_text)
    out, _ = await run_specialist(sp.reply_simulator, parts)
    text = sp.SimulatedReply.model_validate(out).text
    return await add_reply(pid, text=text, request_id=request_id, seller_name=seller, simulated=True, previous=previous)


async def decide(pid: str, qid: str, deviation_id: str, decision: str) -> AsyncIterator[dict[str, Any]]:
    quote = await store.get_quote(pid, qid)
    if quote is None:
        raise ServiceError("Quote not found.", 404)
    if quote.status != "active":
        raise ServiceError(f"This quote is {quote.status}; open the latest one.", 409)
    dev = next((d for d in quote.deviations if d.id == deviation_id), None)
    if dev is None:
        raise ServiceError("That proposed change no longer exists.", 404)
    brief = await _require_brief(pid)

    if decision == "keep_original":
        dev.decision = "kept_original"
        quote.readiness = guard.readiness(brief, quote)
        yield {"type": "progress", "agent": "Outreach agent", "message": f"Writing a reply asking {quote.seller_name} to keep '{dev.requirement_label}'"}
        question = (dev.card or {}).get("question_for_seller") or f"Can you meet '{dev.requirement_label}'?"
        out, st = await run_specialist(sp.outreach_writer, [
            "Follow-up after a counteroffer. The customer KEEPS this requirement: " + dev.requirement_label,
            f"The seller proposed: {dev.proposed}. Ask: {question}",
            json.dumps([{"name": quote.seller_name}]),
        ])
        msgs = sp.OutreachDrafts.model_validate(out).messages
        if msgs:
            quote.follow_up = {"subject": msgs[0].subject, "body": msgs[0].body}
        await store.save_quote(pid, quote)
        await store.log(pid, "customer", f"Kept '{dev.requirement_label}' - asked {quote.seller_name} for another way", kind="decision",
                        stats=[st])
        yield {"type": "progress", "agent": "Fit checker", "message": f"Kept '{dev.requirement_label}'. Your brief is unchanged."}
        if quote.staged:  # practice run: the practice workshop answers the follow-up too
            yield {"type": "progress", "agent": "Practice reply", "message": "The practice workshop is answering your follow-up"}
            decision_text = f"The customer KEPT '{dev.requirement_label}' and rejected '{dev.proposed}'. {question}"
            new_quote = await simulate_reply(pid, quote.request_id if quote.request_id != "manual" else None, previous=quote,
                                             decision_text=decision_text)
            ok = not any(d.severity == "blocked" for d in new_quote.deviations)
            yield {"type": "progress", "agent": "Fit checker",
                   "message": "New reply keeps every must-have" if ok else "New reply still breaks a must-have"}
        yield {"type": "result", "state": await store.full_state(pid)}
        return

    if decision != "accept":
        raise ServiceError("Unknown decision.")

    if dev.kind == "must" and dev.requirement_id not in ("budget-limit",):
        target = brief.req(dev.requirement_id)
        offered = quote.offered_specs

        def mutate(b: Brief) -> None:
            r = b.req(dev.requirement_id)
            if r is None:
                return
            val = guard._spec_value(offered, r.attribute) if r.attribute else None
            if r.attribute and r.op in ("<=", ">=") and val is not None:
                try:
                    r.value_num = float(val)
                except (TypeError, ValueError):
                    r.kind = "flexible"
                if re.search(r"\d+(?:\.\d+)?", r.label):
                    r.label = re.sub(r"\d+(?:\.\d+)?", f"{r.value_num:g}", r.label, count=1)
            else:
                r.kind = "flexible"
            r.note = f"Changed after accepting {quote.seller_name}'s proposal ({dev.proposed})."
            r.source = "seller"

        new_brief = await store.new_brief_version(pid, mutate, summary=f"You accepted {quote.seller_name}'s change: {dev.requirement_label} -> {dev.proposed}")
        await store.log(pid, "customer", f"Accepted a must-have change - brief v{new_brief.version}", kind="change",
                        detail=f"Before: {target.label if target else dev.original}. After: {dev.proposed}.")
        quote.status = "superseded"
        await store.save_quote(pid, quote)
        relinked = quote.model_copy(deep=True)
        relinked.id = store.new_id("qte")
        relinked.brief_version = new_brief.version
        relinked.status = "active"
        relinked.created_at = now_iso()
        relinked.deviations = guard.quote_deviations(new_brief, relinked)
        for d in relinked.deviations:
            old = next((o for o in quote.deviations if o.id == d.id), None)
            if old and old.card:
                d.card = old.card
        relinked.readiness = guard.readiness(new_brief, relinked)
        await store.save_quote(pid, relinked)
        yield {"type": "progress", "agent": "Fit checker", "message": f"Brief updated to v{new_brief.version}; the quote now matches it."}
    else:
        dev.decision = "accepted"
        quote.readiness = guard.readiness(brief, quote)
        await store.save_quote(pid, quote)
        await store.log(pid, "customer", f"Accepted a nice-to-have change: {dev.requirement_label} -> {dev.proposed}", kind="decision")
        yield {"type": "progress", "agent": "Fit checker", "message": f"Accepted: {dev.proposed}. Your must-haves are unchanged."}
    yield {"type": "result", "state": await store.full_state(pid)}


# =============================================================================================
# Picks (cart) -> orders -> track -> check
# =============================================================================================
# A project can end in several items (a desk AND a pegboard; one from Amazon, one made by a maker).
# The customer adds options to "Your picks"; the fit checker clears each one; placing the order makes
# one order per item. The checkout agent prepares each purchase - Amazon and Shopify carts are filled
# and the delivery PIN code is pre-entered - and the customer only authorises payment on the store.
# A maker's order is confirmed by message. Tesselle never stores or enters payment details.


def _milestones(kind: str, seller: str) -> list[dict[str, Any]]:
    steps = [("chosen", "Chosen", "you"),
             ("ordered", f"Order on {seller}" if kind == "store" else f"Confirm the order with {seller}", "you"),
             ("delivered", "Delivered", "seller"),
             ("checked", "Checked against your brief", "you")]
    return [{"key": k, "label": l, "actor": a, "state": "done" if i == 0 else ("current" if i == 1 else "upcoming")}
            for i, (k, l, a) in enumerate(steps)]


ACK_LABELS = {"check_on_store": "check on the store page", "confirm_with_seller": "confirm with the seller",
              "unresolved_charges": "charges not known yet"}


async def _item_checks(pid: str, brief: Brief, entry_id: Optional[str], quote_id: Optional[str]) -> dict[str, Any]:
    """Everything the fit checker says about one option before it can be ordered."""
    blockers: list[str] = []
    needs: dict[str, str] = {}
    if quote_id:
        quote = await store.get_quote(pid, quote_id)
        if quote is None:
            raise ServiceError("Quote not found.", 404)
        blockers += [b for b in guard.approval_blockers(brief, quote, existing_order=False)]
        unresolved = guard.unresolved_charges(quote)
        if unresolved:
            needs["unresolved_charges"] = "I understand these charges aren't known yet: " + ", ".join(unresolved)
        to_confirm = guard.unconfirmed_musts(brief, quote)
        if to_confirm:
            needs["confirm_with_seller"] = f"I'll confirm these with {quote.seller_name} first: " + "; ".join(to_confirm)
        return {"blockers": blockers, "needs": needs, "kind": "maker", "title": quote.title, "seller_name": quote.seller_name,
                "seller_id": quote.seller_id, "url": None, "image_url": None, "image_path": quote.image_path,
                "price_inr": guard.known_total(quote), "specs": quote.offered_specs.model_dump(), "unresolved": unresolved,
                "entry_id": None, "quote_id": quote_id, "brief_version": quote.brief_version}
    routes = await _routes(pid)
    entry = next((e for e in routes["entries"] if e["item_id"] == entry_id), None)
    if entry is None:
        raise ServiceError("That option is no longer in your results.", 404)
    if routes["brief_version"] != brief.version:
        blockers.append(f"These results were found for brief v{routes['brief_version']}; your brief is now v{brief.version}. Search again first.")
    if entry["verdict"] == "not_suitable":
        blockers.append("This one breaks a must-have: " + entry["decisive"])
    if entry.get("complement"):
        needs["check_on_store"] = "It goes with your pick - I'll check its size and price on the store page"
    unknown = [c["label"] for c in entry.get("checks", []) if c["kind"] == "must" and c["result"] == "unknown"]
    if unknown:
        needs["check_on_store"] = "I'll check these on the store page first: " + "; ".join(unknown)
    return {"blockers": blockers, "needs": needs, "kind": "store" if entry["route"] == "buy" else "maker", "title": entry["name"],
            "seller_name": entry["seller_name"], "seller_id": entry["seller_id"], "url": entry.get("url"),
            "image_url": entry.get("image_url"), "image_path": None, "price_inr": entry.get("price_inr"), "specs": entry.get("specs"),
            "unresolved": entry.get("unresolved") or [], "entry_id": entry_id, "quote_id": None, "brief_version": routes["brief_version"]}


async def add_to_cart(pid: str, entry_id: Optional[str] = None, quote_id: Optional[str] = None, qty: int = 1) -> dict[str, Any]:
    brief = await _require_brief(pid)
    if not brief.confirmed:
        raise ServiceError("Confirm your brief first.", 409)
    info = await _item_checks(pid, brief, entry_id, quote_id)
    if info["blockers"]:
        await store.log(pid, "agent:fit_checker", f"Couldn't add {info['title']} to your picks", kind="guard", detail=" ".join(info["blockers"]))
        raise ServiceError("Not yet - a check needs your attention.", 409, info["blockers"])
    cid = "c_" + _short(entry_id or quote_id or "")
    item = {"id": cid, "qty": max(1, min(int(qty or 1), 20)), "added_at": now_iso(),
            **{k: info[k] for k in ("kind", "title", "seller_name", "seller_id", "url", "image_url", "image_path", "price_inr",
                                    "specs", "unresolved", "entry_id", "quote_id", "brief_version", "needs")}}
    await store.put(pid, "cart", cid, item)
    await _advance(pid, "approve")
    await store.log(pid, "customer", f"Added to picks: {info['title']} ({info['seller_name']})", kind="decision")
    return item


def _short(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())[-16:] or store.new_id("x")[2:]


async def update_cart(pid: str, cid: str, qty: Optional[int] = None, remove: bool = False) -> None:
    item = await store.get(pid, "cart", cid)
    if not item:
        raise ServiceError("That pick is no longer in your list.", 404)
    if remove:
        await store.db().collection("projects").document(pid).collection("cart").document(cid).delete()
        await store.touch(pid)
        await store.log(pid, "customer", f"Removed from picks: {item['title']}", kind="decision")
        return
    item["qty"] = max(1, min(int(qty or 1), 20))
    await store.put(pid, "cart", cid, item)


async def _create_order(pid: str, brief: Brief, info: dict[str, Any], qty: int, idempotency_key: str = "") -> dict[str, Any]:
    key = _short(info.get("entry_id") or info.get("quote_id") or "")
    oid = "ord_" + key
    existing = await store.get(pid, "orders", oid)
    if existing and existing.get("status") != "cancelled":
        return existing
    order = {
        "id": oid, "order_ref": "TSL-" + store.new_id("o")[2:].upper(), "kind": info["kind"], "entry_id": info.get("entry_id"),
        "quote_id": info.get("quote_id"), "seller_name": info["seller_name"], "seller_id": info.get("seller_id"), "url": info.get("url"),
        "image_url": info.get("image_url"), "image_path": info.get("image_path"), "brief_version": brief.version, "title": info["title"],
        "qty": qty, "specs": info.get("specs"), "known_total_inr": info.get("price_inr"), "unresolved": info.get("unresolved") or [],
        "acceptance_checks": brief.acceptance_checks, "idempotency_key": idempotency_key, "status": "to_buy",
        "milestones": _milestones(info["kind"], info["seller_name"]), "checkout": None, "confirmation": None,
        "delivery_check": None, "created_at": now_iso(), "project_title": brief.title,
    }
    order["checkout"] = await prepare_checkout(order, brief)
    await store.put(pid, "orders", oid, order)
    if info.get("quote_id"):
        q = await store.get_quote(pid, info["quote_id"])
        if q:
            q.status = "approved"
            await store.save_quote(pid, q)
    return order


async def place_orders(pid: str, cart_ids: Optional[list[str]] = None, acknowledgements: Optional[list[str]] = None) -> list[dict[str, Any]]:
    """Turn picks into orders. Every pick is re-checked; nothing is paid here."""
    acks = set(acknowledgements or [])
    brief = await _require_brief(pid)
    cart = await store.list_coll(pid, "cart", order="added_at")
    picks = [c for c in cart if not cart_ids or c["id"] in cart_ids]
    if not picks:
        raise ServiceError("Add at least one option to your picks first.", 409)
    blockers: list[str] = []
    infos = []
    for c in picks:
        info = await _item_checks(pid, brief, c.get("entry_id"), c.get("quote_id"))
        blockers += [f"{c['title']}: {b}" for b in info["blockers"]]
        blockers += [f"{c['title']}: {text}" for k, text in info["needs"].items() if k not in acks]
        infos.append((c, info))
    if blockers:
        await store.log(pid, "agent:fit_checker", "Couldn't place the order yet", kind="guard", detail=" ".join(blockers))
        raise ServiceError("Not yet - a check needs your attention.", 409, blockers)
    orders = []
    for c, info in infos:
        orders.append(await _create_order(pid, brief, info, c.get("qty", 1)))
        await store.db().collection("projects").document(pid).collection("cart").document(c["id"]).delete()
    _group_store_carts(orders)
    for o in orders:
        await store.put(pid, "orders", o["id"], o)
    await store.update_project(pid, approved_brief_version=brief.version)
    await _advance(pid, "fulfil")
    names = "; ".join(f"{o['title']} ({o['seller_name']})" for o in orders)
    await store.log(pid, "agent:checkout_agent", f"Prepared {len(orders)} order{'s' if len(orders) != 1 else ''}: {names}", kind="agent",
                    detail="Store carts are filled and your PIN code pre-entered where the store allows it. You authorise payment on "
                    "the store - Tesselle never sees or enters payment details.")
    return orders


async def choose(pid: str, *, entry_id: Optional[str] = None, quote_id: Optional[str] = None,
                 acknowledgements: list[str] | None = None, idempotency_key: str = "") -> dict[str, Any]:
    """One-step pick + order for a single option (used by the guided demo and the assistant)."""
    acknowledgements = acknowledgements or []
    existing = await store.get(pid, "orders", "ord_" + _short(entry_id or quote_id or ""))
    if existing and existing.get("status") != "cancelled":
        return existing  # choosing the same option again is idempotent
    brief = await _require_brief(pid)
    if not brief.confirmed:
        raise ServiceError("Not yet - a check needs your attention.", 409, ["Confirm your brief first."])
    info = await _item_checks(pid, brief, entry_id, quote_id)
    blockers = info["blockers"] + [text for k, text in info["needs"].items() if k not in acknowledgements]
    if blockers:
        await store.log(pid, "agent:fit_checker", "Couldn't choose this yet", kind="guard", detail=" ".join(blockers))
        raise ServiceError("Not yet - a check needs your attention.", 409, blockers)
    order = await _create_order(pid, brief, info, 1, idempotency_key)
    await store.update_project(pid, approved_brief_version=brief.version)
    await _advance(pid, "fulfil")
    await store.log(pid, "customer", f"Chose {info['title']} from {info['seller_name']}", kind="decision",
                    detail="The checkout agent prepared the order; you authorise payment on the store.")
    return order


# ---- Checkout agent ----------------------------------------------------------------------------

_ASIN = re.compile(r"/(?:dp|gp/product|gp/aw/d|d)/([A-Z0-9]{10})(?:[/?]|$)")


def _amazon_asin(url: Optional[str]) -> Optional[str]:
    if not url or "amazon." not in url:
        return None
    m = _ASIN.search(url)
    return m.group(1) if m else None


def _group_store_carts(orders: list[dict[str, Any]]) -> None:
    """Several Amazon picks -> one Amazon cart link with all of them."""
    amz = [o for o in orders if (o.get("checkout") or {}).get("method") == "amazon_cart"]
    if len(amz) < 2:
        return
    q = "&".join(f"ASIN.{i}={o['checkout']['asin']}&Quantity.{i}={o.get('qty', 1)}" for i, o in enumerate(amz, 1))
    link = f"https://www.amazon.in/gp/aws/cart/add.html?{q}"
    for o in amz:
        o["checkout"]["url"] = link
        o["checkout"]["grouped"] = len(amz)


async def prepare_checkout(order: dict[str, Any], brief: Brief) -> dict[str, Any]:
    """The fastest legitimate path to a placed order for this store."""
    qty = order.get("qty", 1)
    pin, city = brief.delivery.pincode, _city(brief)
    if order["kind"] == "maker":
        return {"method": "maker_confirm", "url": order.get("url"), "label": f"Confirm with {order['seller_name']}",
                "steps": [f"Tesselle sends {order['seller_name']} your order confirmation with the agreed brief",
                          "They reply with payment details and a delivery date", "Mark it confirmed here"]}
    url = order.get("url") or ""
    asin = _amazon_asin(url)
    if asin:
        return {"method": "amazon_cart", "asin": asin, "label": "Open my Amazon cart",
                "url": f"https://www.amazon.in/gp/aws/cart/add.html?ASIN.1={asin}&Quantity.1={qty}",
                "steps": [f"Amazon opens with {qty} x {order['title'][:50]} ready to add to your cart",
                          f"Check the delivery PIN is {pin}" if pin else "Check your delivery address", "Place the order and pay on Amazon",
                          "Come back and paste the confirmation - Tesselle tracks it"]}
    shop = await _shopify_variant(url)
    if shop:
        host, variant = shop
        params = {"checkout[shipping_address][country]": "India"}
        if pin:
            params["checkout[shipping_address][zip]"] = pin
        if city:
            params["checkout[shipping_address][city]"] = city
        link = f"https://{host}/cart/{variant}:{qty}?" + "&".join(f"{urlquote(k)}={urlquote(v)}" for k, v in params.items())
        return {"method": "store_checkout", "url": link, "label": "Go to checkout",
                "steps": [f"The store's checkout opens with {qty} x {order['title'][:50]} in the cart",
                          f"Your PIN code {pin} is already filled in" if pin else "Add your delivery address",
                          "Pay on the store's checkout", "Paste the confirmation here - Tesselle tracks it"]}
    return {"method": "product_page", "url": url, "label": f"Open on {order['seller_name'].split(' ')[0]}",
            "steps": [f"Add {qty} to cart on {order['seller_name']}" + (f" - check delivery to PIN {pin}" if pin else ""),
                      "Place the order and pay on the store", "Paste the confirmation here - Tesselle tracks it"]}


async def _shopify_variant(url: str) -> Optional[tuple[str, str]]:
    """Shopify stores publish /products/<handle>.js; its first available variant can go straight to checkout."""
    m = re.match(r"https?://([^/]+)/(?:[a-z-]+/)?products/([^/?#]+)", url or "")
    if not m:
        return None
    host, handle = m.group(1), m.group(2)
    try:
        async with httpx.AsyncClient(timeout=6, headers={"User-Agent": "Mozilla/5.0"}) as h:
            r = await h.get(f"https://{host}/products/{handle}.js")
            if r.status_code != 200 or "variants" not in r.text:
                return None
            variants = r.json().get("variants") or []
            v = next((v for v in variants if v.get("available")), variants[0] if variants else None)
            return (host, str(v["id"])) if v else None
    except Exception:
        return None


class OrderConfirmation(BaseModel):
    is_order_confirmation: bool = Field(description="True only if this is a real order/booking confirmation.")
    store: Optional[str] = None
    order_number: Optional[str] = None
    items: list[str] = Field(default_factory=list)
    total_inr: Optional[float] = None
    order_date: Optional[str] = Field(default=None, description="ISO date.")
    expected_delivery: Optional[str] = Field(default=None, description="ISO date or a short phrase like '3-5 days'.")
    status: Literal["placed", "shipped", "out_for_delivery", "delivered", "cancelled", "unknown"] = "placed"
    tracking_url: Optional[str] = None


async def read_confirmation(text: str = "", image: Optional[tuple[bytes, str]] = None) -> tuple[OrderConfirmation, dict[str, Any]]:
    parts: list[Any] = ["Read this order confirmation (email, SMS or screenshot). Extract only what it states; unknown -> null. "
                        "Never include card numbers, addresses or phone numbers."]
    if text.strip():
        parts.append("Text:\n" + text.strip()[:8000])
    if image:
        parts.append(types.Part.from_bytes(data=image[0], mime_type=image[1]))
    out, stats = await gemini.generate_structured(OrderConfirmation, parts, purpose="order-reader", fast=True)
    return out, stats.as_dict()


async def confirm_order(pid: str, oid: str, text: str = "", image: Optional[tuple[bytes, str]] = None, manual: bool = False) -> dict[str, Any]:
    """'I've ordered it' - optionally with the store's confirmation, which Gemini reads into the order history."""
    order = await _order(pid, oid)
    conf = None
    stats = None
    if text.strip() or image:
        c, stats = await read_confirmation(text, image)
        if not c.is_order_confirmation:
            raise ServiceError("That doesn't look like an order confirmation - paste the store's confirmation email or a screenshot.", 422)
        conf = c.model_dump()
        conf["captured_at"] = now_iso()
    order["confirmation"] = conf or order.get("confirmation") or {"order_number": None, "captured_at": now_iso(), "manual": True}
    order["status"] = "ordered" if not conf or conf.get("status") in ("placed", "unknown") else conf["status"]
    for m in order["milestones"]:
        if m["key"] == "ordered" and m["state"] != "done":
            m["state"], m["done_at"] = "done", now_iso()
        elif m["key"] == "delivered" and m["state"] == "upcoming":
            m["state"] = "current"
    await store.put(pid, "orders", oid, order)
    what = f"Ordered {order['title']} on {order['seller_name']}"
    if conf and conf.get("order_number"):
        what += f" - order {conf['order_number']}"
    await store.log(pid, "customer" if not conf else "agent:order_tracker", what, kind="milestone",
                    detail="Order details read from your confirmation by Gemini." if conf else None, stats=[stats] if stats else None)
    return order


async def cancel_order(pid: str, oid: str) -> dict[str, Any]:
    """Changed your mind: drop an order that hasn't been delivered (cancel it on the store too if you paid)."""
    order = await _order(pid, oid)
    if order.get("status") in ("delivered", "accepted", "issue_open"):
        raise ServiceError("This one was already delivered - report a problem instead.", 409)
    order["status"] = "cancelled"
    order["cancelled_at"] = now_iso()
    await store.put(pid, "orders", oid, order)
    if order.get("quote_id"):
        q = await store.get_quote(pid, order["quote_id"])
        if q and q.status == "approved":
            q.status = "active"
            await store.save_quote(pid, q)
    await store.log(pid, "customer", f"Changed my mind: cancelled {order['title']}", kind="decision",
                    detail="If you already paid, cancel it on the store as well.")
    return order


async def _order(pid: str, oid: Optional[str] = None) -> dict[str, Any]:
    if oid:
        o = await store.get(pid, "orders", oid)
        if o:
            return o
        raise ServiceError("Order not found.", 404)
    orders = [o for o in await store.list_coll(pid, "orders") if o.get("status") != "cancelled"]
    if not orders:
        raise ServiceError("Choose an option first.", 404)
    return orders[-1]


async def advance_order(pid: str, step: Optional[str] = None, order_id: Optional[str] = None) -> dict[str, Any]:
    order = await _order(pid, order_id)
    ms = order["milestones"]
    idx = next((i for i, m in enumerate(ms) if m["state"] == "current"), None)
    if idx is None:
        return order
    cur = ms[idx]
    if step and step != cur["key"]:
        raise ServiceError(f"The next step is: {cur['label']}.", 409)
    cur["state"] = "done"
    cur["done_at"] = now_iso()
    if idx + 1 < len(ms):
        ms[idx + 1]["state"] = "current"
    order["milestones"] = ms
    order["status"] = {"ordered": "ordered", "delivered": "delivered"}.get(cur["key"], order.get("status"))
    await store.put(pid, "orders", order["id"], order)
    if ms[min(idx + 1, len(ms) - 1)]["key"] == "checked":
        await _advance(pid, "accept")
    await store.log(pid, "customer", {"ordered": f"Ordered {order['title']}", "delivered": f"{order['title']} arrived"}.get(cur["key"], cur["label"]),
                    kind="milestone")
    return order


async def _sample_delivery_photo(pid: str, order: dict[str, Any]) -> Optional[tuple[bytes, str]]:
    if order.get("image_url"):
        got = await fetch_image(order["image_url"])
        if got:
            return got
    project = await store.get_project(pid) or {}
    cid = project.get("selected_concept_id")
    if cid:
        c = await store.get(pid, "concepts", cid)
        if c:
            return await store.download_media(c["image_path"])
    # Nothing to reuse: Gemini draws a plausible delivery photo of the chosen item (labelled as a sample).
    try:
        specs = json.dumps(order.get("specs") or {}, ensure_ascii=False)[:600]
        image, mime, _ = await gemini.generate_image(
            f"A realistic smartphone photo of a just-delivered item, unboxed on a table at home: {order.get('title', 'the item')}. "
            f"Details: {specs}. Natural light, no text, no people.", purpose="delivery-sample", aspect_ratio="4:3")
        return image, mime
    except Exception as e:
        log.info("sample photo generation failed: %s", e)
    return None


async def delivery_check(pid: str, photo: Optional[tuple[bytes, str]], use_sample: bool = False, order_id: Optional[str] = None) -> dict[str, Any]:
    order = await _order(pid, order_id)
    if photo is None and use_sample:
        photo = await _sample_delivery_photo(pid, order)
        if photo is None:
            raise ServiceError("No sample photo is available - take a photo of the item.", 409)
    if photo is None:
        raise ServiceError("Add a photo of the delivered item.")
    path = await store.upload_media(f"projects/{pid}/delivery-{order['id']}", photo[0], photo[1])
    brief = await store.get_brief(pid, order["brief_version"])
    out, stats = await run_specialist(sp.delivery_inspector, [
        "Checks agreed before buying:\n- " + "\n- ".join(order["acceptance_checks"]),
        "Chosen item: " + json.dumps({"title": order["title"], "specs": order.get("specs")}, ensure_ascii=False),
        ("Must-haves: " + "; ".join(r.label for r in brief.musts())) if brief else "",
        types.Part.from_bytes(data=photo[0], mime_type=photo[1]),
        "Photo of the delivered item." + (" (Sample photo used to try the check.)" if use_sample else ""),
    ])
    report = sp.InspectionReport.model_validate(out).model_dump()
    order["delivery_check"] = {"photo_path": path, "report": report, "at": now_iso(), "outcome": None, "sample": use_sample}
    for m in order["milestones"]:
        if m["key"] in ("ordered", "delivered") and m["state"] != "done":
            m["state"] = "done"
        if m["key"] == "checked":
            m["state"] = "current"
    order["status"] = "delivered"
    await store.put(pid, "orders", order["id"], order)
    await _advance(pid, "accept")
    await store.log(pid, "agent:delivery_inspector", report["summary"], kind="agent",
                    detail="Gemini compared the photo with the checks you agreed. A photo can't prove everything.", stats=[stats])
    return order


async def close_delivery(pid: str, outcome: str, note: str = "", order_id: Optional[str] = None) -> dict[str, Any]:
    order = await _order(pid, order_id)
    if not order.get("delivery_check"):
        raise ServiceError("Run the delivery check first.", 409)
    order["delivery_check"]["outcome"] = outcome
    order["delivery_check"]["note"] = note
    order["status"] = "accepted" if outcome == "accept" else "issue_open"
    if outcome == "accept":
        for m in order["milestones"]:
            m["state"] = "done"
    await store.put(pid, "orders", order["id"], order)
    await store.log(pid, "customer", "Happy with it - matches the brief" if outcome == "accept"
                    else f"Reported a problem: {note or 'see photo'}", kind="decision")
    return order


# ---- Order history (every project, plus orders found in the connected inbox) -----------------


async def order_history(owner: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in await store.list_projects(owner, limit=60):
        if p.get("archived"):
            continue
        for o in await store.list_coll(p["id"], "orders"):
            o["project_id"], o["project_title"] = p["id"], p.get("title")
            out.append(o)
    out += await store.owner_orders(owner)
    return sorted(out, key=lambda o: (o.get("confirmation") or {}).get("order_date") or o.get("created_at", ""), reverse=True)


async def fetch_image(url: str) -> Optional[tuple[bytes, str]]:
    """Download a store's product image server-side (browser headers; images only, max 6 MB)."""
    if not _public_url(url):
        return None
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8"}) as h:
            r = await h.get(url)
            ctype = r.headers.get("content-type", "").split(";")[0]
            if r.status_code == 200 and ctype.startswith("image/") and len(r.content) < 6_000_000:
                return r.content, ctype
    except Exception as e:
        log.info("image fetch failed: %s", e)
    return None


def _public_url(url: str) -> bool:
    """Only public http(s) hosts - never internal addresses (SSRF guard for the image proxy)."""
    from urllib.parse import urlparse as _up
    try:
        u = _up(url)
    except Exception:
        return False
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https") or not host or "." not in host:
        return False
    if host in ("localhost", "metadata.google.internal") or host.endswith((".internal", ".local", ".localhost")):
        return False
    return not re.fullmatch(r"[\d.]+|\[?[0-9a-f:]+\]?", host)


# =============================================================================================
# Location, speech-to-text
# =============================================================================================


class Place(BaseModel):
    city: str
    region: str = ""
    country: str = ""


GEO_UA = "ProjectTesselle/2.0 (shopping agent; https://project-tesselle.web.app)"


async def locate(lat: float, lng: float) -> dict[str, Any]:
    """City, state and PIN code for the browser's coordinates (OpenStreetMap reverse geocoding; Gemini as a
    fallback for the city). Used only to fill the delivery place - coordinates are never stored."""
    try:
        async with httpx.AsyncClient(timeout=6, headers={"User-Agent": GEO_UA, "Accept-Language": "en"}) as h:
            r = await h.get("https://nominatim.openstreetmap.org/reverse",
                            params={"lat": f"{lat:.5f}", "lon": f"{lng:.5f}", "format": "jsonv2", "zoom": 18, "addressdetails": 1})
            a = r.json().get("address", {}) if r.status_code == 200 else {}
        city = a.get("city") or a.get("town") or a.get("municipality") or a.get("county") or a.get("state_district") or ""
        pin = (a.get("postcode") or "").replace(" ", "")
        if city:
            area = a.get("suburb") or a.get("neighbourhood") or a.get("city_district") or ""
            return {"city": city, "region": a.get("state", ""), "country": a.get("country", ""), "area": area,
                    "pincode": pin if PIN_RE.fullmatch(pin) else None, "label": ", ".join(x for x in (city, a.get("state")) if x)}
    except Exception as e:
        log.info("reverse geocode failed: %s", e)
    place, _ = await gemini.generate_structured(
        Place, [f"Which city or town is at latitude {lat:.3f}, longitude {lng:.3f}? Give the city, state/region and country."],
        purpose="locate", fast=True,
    )
    label = ", ".join(x for x in (place.city, place.region) if x)
    return {"city": place.city, "region": place.region, "country": place.country, "pincode": None, "label": label}


async def pincode_lookup(pin: str) -> dict[str, Any]:
    """India Post PIN code directory: '600042' -> Chennai, Tamil Nadu (and the post-office areas)."""
    if not PIN_RE.fullmatch(pin or ""):
        raise ServiceError("A PIN code has 6 digits.")
    try:
        async with httpx.AsyncClient(timeout=6, headers={"User-Agent": GEO_UA}) as h:
            r = await h.get(f"https://api.postalpincode.in/pincode/{pin}")
            data = r.json()[0] if r.status_code == 200 else {}
        offices = data.get("PostOffice") or []
        if offices:
            o = offices[0]
            city = o.get("District") or o.get("Block") or o.get("Name")
            return {"pincode": pin, "city": city, "region": o.get("State", ""), "areas": [x.get("Name") for x in offices[:6]],
                    "label": ", ".join(x for x in (city, o.get("State")) if x)}
    except Exception as e:
        log.info("pincode lookup failed: %s", e)
    raise ServiceError("Couldn't find that PIN code - check it, or type your city.", 404)


class Transcript(BaseModel):
    text: str


async def transcribe(audio: tuple[bytes, str]) -> str:
    out, _ = await gemini.generate_structured(
        Transcript, [types.Part.from_bytes(data=audio[0], mime_type=audio[1]),
                     "Transcribe this voice note verbatim in its original language. Return only the words spoken."],
        purpose="transcribe", fast=True,
    )
    return out.text.strip()


# =============================================================================================
# Project settings, notes, device sync, shoppable visuals, inbox order history
# =============================================================================================


async def edit_project(pid: str, title: Optional[str] = None, purpose: Optional[str] = None, archived: Optional[bool] = None) -> None:
    project = await store.get_project(pid)
    if project is None:
        raise ServiceError("Project not found.", 404)
    fields: dict[str, Any] = {}
    if title is not None and title.strip():
        fields["title"] = title.strip()[:90]
    if archived is not None:
        fields["archived"] = archived
    if fields:
        await store.update_project(pid, **fields)
    brief = await store.get_brief(pid)
    if brief and (title or purpose is not None):
        # Name and description are labels, not requirements: updated in place, no new brief version.
        if title and title.strip():
            brief.title = title.strip()[:90]
        if purpose is not None:
            brief.purpose = purpose.strip()[:600]
        await store.save_brief(pid, brief)
    what = "Archived the project" if archived else "Restored the project" if archived is False else "Renamed / edited the project"
    await store.log(pid, "customer", what)


async def add_note(pid: str, text: str, share: bool = False) -> dict[str, Any]:
    if not text.strip():
        raise ServiceError("Write or say something first.")
    nid = store.new_id("note")
    note = {"id": nid, "text": text.strip()[:2000], "share": share, "created_at": now_iso(), "updated_at": now_iso()}
    await store.put(pid, "notes", nid, note)
    await store.log(pid, "customer", f"Added a note: {text.strip()[:80]}")
    return note


async def update_note(pid: str, nid: str, text: Optional[str] = None, share: Optional[bool] = None, delete: bool = False) -> None:
    note = await store.get(pid, "notes", nid)
    if not note:
        raise ServiceError("Note not found.", 404)
    if delete:
        await store.db().collection("projects").document(pid).collection("notes").document(nid).delete()
        await store.touch(pid)
        return
    if text is not None:
        note["text"] = text.strip()[:2000]
    if share is not None:
        note["share"] = share
    note["updated_at"] = now_iso()
    await store.put(pid, "notes", nid, note)


async def set_view(pid: str, stage: str, device: str, scroll: Optional[float] = None, busy: Optional[str] = None,
                   kind: str = "") -> None:
    """What each device shows - the step, how far it is scrolled, and any action it is running - so the
    other devices can mirror it, and a device opened later continues from the same place."""
    if stage not in STAGES:
        return
    await store.set_fields(pid, view={"stage": stage, "device": device[:40], "at": now_iso(), "kind": (kind or "")[:12],
                                      "scroll": None if scroll is None else max(0.0, min(1.0, float(scroll))),
                                      "busy": (busy or None) and busy[:80]})


class PhotoRead(BaseModel):
    observations: list[str] = Field(description="2-5 short facts visible in the photo that matter for this brief (materials, "
                                                "colours, rough sizes, fittings, the device model on a label). Sizes are estimates.")
    caption: str = Field(description="Under 10 words, e.g. 'Alcove between window and door'.")


async def add_photo(pid: str, image: tuple[bytes, str], *, kind: str = "space", note: str = "", source: str = "") -> dict[str, Any]:
    """A photo added mid-project - from the phone via the QR code, the webcam, or the glasses camera. It is
    stored with the project, read by Gemini against the brief, and becomes the 'space' photo for looks."""
    kind = kind if kind in ("space", "inspiration", "item", "person", "receipt") else "space"
    brief = await store.get_brief(pid)
    if brief is None:
        b = await start_from_inspiration(pid, text=note, image=image, consent_photo=True, source=source or "photo")
        return {"ok": True, "started_brief": True, "title": b.title, "must_haves": [r.label for r in b.musts()], "navigate": "clarify"}
    path = await store.upload_media(f"projects/{pid}/photos/{store.new_id('ph')}", image[0], image[1])
    read: Optional[PhotoRead] = None
    try:
        read, _ = await asyncio.wait_for(gemini.generate_structured(PhotoRead, [
            types.Part.from_bytes(data=image[0], mime_type=image[1]),
            f"This is a photo of the customer's {kind}" + (f" ({note})" if note else "") + ". Brief:\n"
            + brief.model_dump_json(include={"title", "purpose", "requirements"}),
        ], purpose="photo-read", fast=True), timeout=15)
    except Exception as e:
        log.info("photo read skipped: %s", e)
    project = await store.get_project(pid) or {}
    insp = dict(project.get("inspiration") or {})
    entry = {"path": path, "kind": kind, "note": note[:200], "source": source[:40], "at": now_iso(),
             "caption": read.caption if read else kind.title(), "observations": read.observations if read else []}
    insp["photos"] = list(insp.get("photos") or [])[-7:] + [entry]
    if kind == "space" or not insp.get("image_path"):
        insp["image_path"], insp["generated_image"] = path, False
    await store.update_project(pid, inspiration=insp)
    await store.log(pid, "customer", f"Added a photo of the {kind}" + (f" from {source}" if source else ""), kind="capture",
                    detail="; ".join(entry["observations"])[:400] or None)
    return {"ok": True, "photo": entry["caption"], "seen": entry["observations"],
            "note": "Sizes from a photo are estimates - confirm any measurement with the customer before saving it."}


async def set_live(pid: str, label: Optional[str], agent: Optional[str] = None, message: Optional[str] = None) -> None:
    """What the agents are doing right now, visible on every device (not part of the project revision)."""
    try:
        await store.set_fields(pid, live=None if label is None else {"label": label, "agent": agent, "message": message, "at": now_iso()})
    except Exception as e:
        log.info("live status skipped: %s", e)


async def _space_photo(pid: str) -> Optional[tuple[tuple[bytes, str], str]]:
    project = await store.get_project(pid) or {}
    insp = project.get("inspiration") or {}
    path = insp.get("image_path")
    if path and not insp.get("generated_image"):
        return await store.download_media(path), path
    return None


async def make_look(pid: str, entry_ids: Optional[list[str]] = None, in_space: bool = True) -> dict[str, Any]:
    from . import visual

    routes = await _routes(pid)
    entries = [e for e in routes["entries"] if e["route"] == "buy" and e.get("image_url")]
    if entry_ids:
        entries = [e for e in entries if e["item_id"] in entry_ids]
    else:
        # The best one or two that fit, plus real products that go with them - a whole scene, like a catalogue page.
        fitting = [e for e in entries if e["verdict"] in ("meets", "possible_with_change")]
        per_item: dict[str, dict[str, Any]] = {}
        for e in fitting:
            per_item.setdefault(e.get("item") or "", e)
        main = list(per_item.values())[:3] if len(per_item) > 1 else fitting[:2]
        brief = await _require_brief(pid)
        extras = [e for e in entries if e.get("complement")][:3]
        if len(extras) < 2:
            from .agents import shopper
            extras = await shopper.companions(brief, {e["url"].split("?")[0] for e in routes["entries"] if e.get("url")})
            if extras:
                routes["entries"] = [e for e in routes["entries"] if not e.get("complement")] + extras
                await store.put(pid, "routes", "latest", routes)
        entries = main + extras[: max(0, 5 - len(main))]
    if not entries:
        raise ServiceError("Pick options that have a product photo first.", 409)
    space = await _space_photo(pid) if in_space else None
    try:
        out = await visual.shop_the_look(pid, entries, space[0] if space else None, fetch_image)
    except RuntimeError as e:
        raise ServiceError(str(e), 422)
    look = out["look"]
    found = sum(1 for i in look["items"] if i["x"] is not None)
    await store.log(pid, "agent:design_agent", f"Made a shoppable picture with {len(look['items'])} real products"
                    + (" in your space" if look["in_space"] else ""), kind="agent",
                    detail=f"Gemini composed it from the real product photos and located {found} of them, so each one links to its store page.",
                    stats=[out["stats"]])
    return look


async def try_in_space(pid: str, entry_id: str, photo: Optional[tuple[bytes, str]] = None) -> dict[str, Any]:
    from . import visual

    routes = await _routes(pid)
    entry = next((e for e in routes["entries"] if e["item_id"] == entry_id), None)
    if entry is None:
        raise ServiceError("That option is no longer in your results.", 404)
    if photo:
        path = await store.upload_media(f"projects/{pid}/space-{store.new_id('p')[2:]}", photo[0], photo[1])
        space = (photo, path)
    else:
        space = await _space_photo(pid)
    if not space:
        raise ServiceError("Add a photo of your space first - Tesselle places the product into it.", 409)
    brief = await _require_brief(pid)
    sizes = "; ".join(r.label for r in brief.requirements if r.attribute in ("width_cm", "depth_cm", "height_cm"))
    try:
        out = await visual.try_in_space(pid, entry, space[0], space[1], sizes, fetch_image)
    except RuntimeError as e:
        raise ServiceError(str(e), 422)
    await store.log(pid, "agent:design_agent", f"Showed {entry['name']} in your space", kind="agent",
                    detail="Gemini edited your own photo to place the real product in it - a preview, not a measurement.",
                    stats=[out["stats"]])
    return out["look"]


async def import_inbox_orders(owner: str) -> AsyncIterator[dict[str, Any]]:
    """Order history from the connected inbox: store confirmation emails read by Gemini."""
    from . import channels

    yield {"type": "progress", "agent": "Order tracker", "message": "Looking for order emails from stores in your inbox"}
    try:
        msgs = await channels.find_order_emails()
    except Exception as e:
        raise ServiceError(f"Couldn't read the inbox: {e}", 503)
    known = {o["id"] for o in await store.owner_orders(owner)}
    added = 0
    for m in msgs:
        key = "mail_" + re.sub(r"[^a-z0-9]", "", (m.get("message_id") or "").lower())[-20:]
        if key in known:
            continue
        try:
            c, stats = await read_confirmation(f"From: {m['from']}\nSubject: {m['subject']}\nDate: {m['date']}\n\n{m['text']}")
        except Exception as e:
            log.info("order email skipped: %s", e)
            continue
        if not c.is_order_confirmation:
            continue
        yield {"type": "progress", "agent": "Order tracker", "message": f"{c.store or email_name(m['from'])}: {(c.items or ['an order'])[0][:60]}"}
        await store.put_owner_order(owner, key, {
            "id": key, "source": "inbox", "kind": "store", "title": "; ".join(c.items[:3]) or m["subject"][:90],
            "seller_name": c.store or email_name(m["from"]), "status": c.status, "known_total_inr": c.total_inr,
            "confirmation": {**c.model_dump(), "captured_at": now_iso()}, "created_at": now_iso(), "milestones": [],
        })
        added += 1
    yield {"type": "result", "added": added}


# =============================================================================================
# Next step + recap (cross-device continuity)
# =============================================================================================


def next_decision(state: dict[str, Any]) -> dict[str, Any]:
    """Deterministic 'what do I do next' used by every surface (desktop, phone, assistant)."""
    briefs = state["briefs"]
    brief = briefs[-1] if briefs else None
    quotes = [q for q in state.get("quotes") or [] if q["status"] in ("active", "approved")]
    orders = [o for o in (state.get("orders") or ([state["order"]] if state.get("order") else [])) if o.get("status") != "cancelled"]
    cart = state.get("cart") or []
    if not brief:
        return {"stage": "inspire", "title": "Tell Tesselle what you want", "detail": "Type it, say it, or show a photo.", "cta": "Start"}
    if not brief["confirmed"]:
        n = sum(1 for u in brief["unknowns"] if u["status"] == "open")
        return {"stage": "clarify", "title": "Check your brief", "cta": "Confirm brief",
                "detail": f"Make sure the must-haves are right{f' and answer {n} quick question' + ('s' if n > 1 else '') if n else ''}."}
    if cart:
        n = len(cart)
        return {"stage": "approve", "title": f"Place your order{'s' if n > 1 else ''} ({n} pick{'s' if n > 1 else ''})",
                "detail": "The checkout agent fills the store carts - you only authorise payment.", "cta": "Review picks", "count": n}
    if orders:
        def cur(o: dict[str, Any]) -> Optional[str]:
            return next((m["key"] for m in o["milestones"] if m["state"] == "current"), None)
        to_buy = [o for o in orders if cur(o) == "ordered"]
        if to_buy:
            n = len(to_buy)
            o = to_buy[0]
            return {"stage": "fulfil", "title": f"Buy {n} items" if n > 1 else next(m["label"] for m in o["milestones"] if m["key"] == "ordered"),
                    "detail": "The checkout agent prepared it - you authorise payment on the store, then paste the confirmation.",
                    "cta": "I've ordered it", "order_id": o["id"]}
        review = [o for o in orders if o.get("delivery_check") and not o["delivery_check"].get("outcome")]
        if review:
            return {"stage": "accept", "title": "Accept it or report a problem", "detail": "Review the delivery check.", "cta": "Review", "order_id": review[0]["id"]}
        waiting = [o for o in orders if cur(o) == "delivered"]
        if waiting:
            return {"stage": "fulfil", "title": "Waiting for delivery", "detail": f"{waiting[0]['title']} - mark it when it arrives.",
                    "cta": "It arrived", "order_id": waiting[0]["id"]}
        to_check = [o for o in orders if cur(o) == "checked"]
        if to_check:
            return {"stage": "accept", "title": "Check it against your brief", "detail": "Take a photo of what arrived.", "cta": "Check delivery",
                    "order_id": to_check[0]["id"]}
        return {"stage": "accept", "title": "All done", "detail": "Everything matches your brief. Add more or start something new.", "cta": "Done"}
    active = [q for q in quotes if q["status"] == "active"]
    for q in sorted(active, key=lambda q: q["created_at"], reverse=True):
        pend = [d for d in q["deviations"] if d["decision"] == "pending"]
        if pend:
            d = pend[0]
            return {"stage": "compare", "title": (d.get("card") or {}).get("title") or f"Decide on {d['requirement_label']}",
                    "detail": f"{d['original']} -> {d['proposed']}", "quote_id": q["id"], "deviation_id": d["id"],
                    "severity": d["severity"], "cta": "Decide"}
        if q["readiness"] == "ready":
            return {"stage": "approve", "title": f"Choose {q['seller_name']}'s offer", "detail": "It keeps every must-have.",
                    "quote_id": q["id"], "cta": "Review & choose"}
    reqs = state.get("requests") or []
    if any(r.get("status") == "draft" for r in reqs):
        return {"stage": "request", "title": "Send your messages", "detail": "Messages are ready - Tesselle sends them, or calls, for you.", "cta": "Send"}
    if any(r.get("status") == "sent" for r in reqs):
        return {"stage": "compare", "title": "Waiting for replies", "detail": "Tesselle reads email replies and call answers as they come in.", "cta": "Check replies"}
    routes = state.get("routes")
    if routes and routes.get("brief_version") == brief["version"]:
        n = len(routes["groups"].get("meets", [])) + len(routes["groups"].get("possible_with_change", []))
        return {"stage": "routes", "title": "Pick an option or ask a maker", "detail": routes["narrative"]["headline"],
                "cta": "See options", "count": n}
    if routes and routes.get("brief_version") != brief["version"]:
        return {"stage": "routes", "title": "Search again", "detail": f"Your brief changed to v{brief['version']} - refresh the options.", "cta": "Search again"}
    return {"stage": "routes", "title": "Find real options", "detail": "Search stores and makers that deliver to you.", "cta": "Find options"}


async def recap(pid: str, speak: bool = False) -> dict[str, Any]:
    state = await store.full_state(pid)
    if not state:
        raise ServiceError("Project not found.", 404)
    nd = next_decision(state)
    brief = state["briefs"][-1] if state["briefs"] else None
    summary = {
        "project": state["project"]["title"], "stage": state["project"]["stage"],
        "brief": None if not brief else {"version": brief["version"], "confirmed": brief["confirmed"],
                                         "must_haves": [r["label"] for r in brief["requirements"] if r["kind"] == "must"],
                                         "last_change": brief["change_summary"]},
        "options_found": None if not state.get("routes") else state["routes"]["narrative"]["headline"],
        "replies": [{"seller": q["seller_name"], "readiness": q["readiness"], "status": q["status"]} for q in state["quotes"]],
        "chosen": None if not state["order"] else {"title": state["order"]["title"], "seller": state["order"]["seller_name"],
                                                  "status": state["order"]["status"]},
        "next_step": nd, "recent_activity": [e["summary"] for e in state["events"][:6]],
    }
    out, stats = await run_specialist(sp.recap_agent, ["Project state:\n" + json.dumps(summary, ensure_ascii=False)])
    rec = sp.Recap.model_validate(out).model_dump()
    rec["next_decision"] = nd
    rec["stats"] = [stats]
    if speak:
        rec["audio"], tts = await gemini.speak(rec["spoken"])
        rec["stats"].append(tts.as_dict())
    return rec
