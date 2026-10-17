"""Tesselle assistant: the voice and chat agent that guides the customer and can drive the app.

* Google ADK LlmAgent on Gemini (Vertex AI) with function tools that call the same guarded services
  as the UI buttons - "set my budget to 3,000", "find options" or "take me to the replies" take the
  same path as a click. Tools that move the flow return a `navigate` hint the UI follows.
* Agent Platform Sessions (VertexAiSessionService) keep one conversation per project, so phone,
  glasses and desktop continue the same thread.
* Agent Platform Memory Bank (VertexAiMemoryBankService) remembers durable preferences across
  projects ("I rent, so no drilling"); PreloadMemoryTool injects them into each turn.
* The assistant never pays, orders, sends messages for the customer or accepts a seller's change to
  a must-have: those stay explicit taps by the customer.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import time
from typing import Any, AsyncIterator, Optional

from google.adk.agents import LlmAgent
from google.adk.memory import VertexAiMemoryBankService
from google.adk.memory.memory_entry import MemoryEntry
from google.adk.runners import Runner
from google.adk.sessions import VertexAiSessionService
from google.adk.tools import ToolContext
from google.adk.tools.preload_memory_tool import PreloadMemoryTool
from google.genai import types

from .. import config, gemini, services, store
from ..models import Budget, Delivery, Requirement
from .runtime import gen_config, model

log = logging.getLogger(__name__)
APP_NAME = config.AGENT_ENGINE_ID
STEPS = {"start": "inspire", "brief": "clarify", "visualise": "visualise", "options": "routes", "reach out": "request",
         "replies": "compare", "choose": "approve", "track": "fulfil", "delivery check": "accept"}


def _pid(tool_context: ToolContext) -> str:
    return tool_context.state["project_id"]


async def get_project_status(tool_context: ToolContext) -> dict:
    """Returns the brief (requirements with ids, budget, city, open questions), what was found, replies
    and the next step. Call this before changing anything."""
    state = await store.full_state(_pid(tool_context))
    brief = state["briefs"][-1] if state["briefs"] else None
    routes = state.get("routes") or {}
    return {
        "brief": brief and {
            "version": brief["version"], "confirmed": brief["confirmed"], "title": brief["title"],
            "requirements": [{k: r.get(k) for k in ("id", "label", "kind", "attribute", "op", "value_num", "value_list", "status")}
                             for r in brief["requirements"]],
            "budget": brief["budget"], "delivery": brief["delivery"],
            "open_questions": [{"id": u["id"], "question": u["question"]} for u in brief["unknowns"] if u["status"] == "open"],
        },
        "options": routes and {"headline": routes.get("narrative", {}).get("headline"),
                               "top": [{"name": e["name"], "seller": e["seller_name"], "verdict": e["verdict"], "price_inr": e["price_inr"]}
                                       for e in routes.get("entries", [])[:6]]},
        "replies": [{"seller": q["seller_name"], "readiness": q["readiness"], "status": q["status"]} for q in state["quotes"]],
        "next_step": services.next_decision(state),
        "steps_you_can_open": list(STEPS),
    }


async def go_to_step(step: str, tool_context: ToolContext) -> dict:
    """Opens a step on the customer's screen. step is one of: start, brief, visualise, options,
    reach out, replies, choose, track, delivery check."""
    key = STEPS.get(step.lower().strip())
    if not key:
        return {"ok": False, "error": "Unknown step. Use one of: " + ", ".join(STEPS)}
    return {"ok": True, "navigate": key}


async def set_requirement(requirement_id: str, label: str, kind: str, tool_context: ToolContext,
                          attribute: Optional[str] = None, op: Optional[str] = None, value_num: Optional[float] = None,
                          value_list: Optional[list[str]] = None, unit: Optional[str] = None) -> dict:
    """Adds or updates one requirement exactly as the customer stated it.

    Args:
      requirement_id: existing id to update, or a new kebab-case id.
      label: plain-language label, e.g. "Maximum width 30 cm".
      kind: "must" (cannot change without approval) or "flexible".
      attribute: e.g. depth_cm, width_cm, height_cm, mounting, material, color, size, compatible_with, features.
      op: "<=", ">=", "==", "in", "not_in" or "has".
      value_num: number for <=, >=, ==.
      value_list: lowercase options for in / not_in / has.
      unit: e.g. "cm".
    """
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    req = Requirement(id=requirement_id, label=label, kind="must" if kind == "must" else "flexible", attribute=attribute, op=op,
                      value_num=value_num, value_list=value_list, unit=unit, source="customer", status="confirmed")
    reqs = [r for r in brief.requirements if r.id != requirement_id] + [req]
    updated = await services.edit_brief(pid, services.BriefPatch(requirements=reqs, summary=f"Via assistant: {label} ({req.kind})"),
                                        by="customer (via assistant)")
    return {"ok": True, "brief_version": updated.version, "navigate": "clarify"}


async def remove_requirement(requirement_id: str, tool_context: ToolContext) -> dict:
    """Removes a requirement the customer explicitly asked to drop."""
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    target = brief.req(requirement_id)
    if target is None:
        return {"ok": False, "error": "No such requirement id."}
    updated = await services.edit_brief(pid, services.BriefPatch(requirements=[r for r in brief.requirements if r.id != requirement_id],
                                                                 summary=f"Via assistant: removed '{target.label}'"), by="customer (via assistant)")
    return {"ok": True, "brief_version": updated.version}


async def set_budget(tool_context: ToolContext, target_inr: Optional[int] = None, limit_inr: Optional[int] = None) -> dict:
    """Sets the target budget (flexible) and/or the absolute spending limit (must), in INR."""
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    b = Budget(target_inr=target_inr if target_inr is not None else brief.budget.target_inr,
               limit_inr=limit_inr if limit_inr is not None else brief.budget.limit_inr, share_with_sellers=brief.budget.share_with_sellers)
    updated = await services.edit_brief(pid, services.BriefPatch(budget=b, summary="Via assistant: budget updated"), by="customer (via assistant)")
    return {"ok": True, "brief_version": updated.version}


async def set_delivery(tool_context: ToolContext, city: Optional[str] = None, deadline: Optional[str] = None) -> dict:
    """Sets the delivery city and/or the date it's needed by (ISO yyyy-mm-dd)."""
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    d = Delivery(region=city or brief.delivery.region, desired_by=deadline or brief.delivery.desired_by, essential=brief.delivery.essential)
    updated = await services.edit_brief(pid, services.BriefPatch(delivery=d, summary="Via assistant: delivery updated"), by="customer (via assistant)")
    return {"ok": True, "brief_version": updated.version}


async def answer_open_question(unknown_id: str, tool_context: ToolContext, answer: Optional[str] = None, dont_know: bool = False) -> dict:
    """Records the customer's answer to an open question (or that they don't know)."""
    updated = await services.answer_unknown(_pid(tool_context), unknown_id, answer, dont_know)
    return {"ok": True, "brief_version": updated.version}


async def confirm_brief(tool_context: ToolContext) -> dict:
    """Confirms the brief when the customer says it's right. Fails if a must-have still needs measuring."""
    try:
        b = await services.confirm_brief(_pid(tool_context))
    except services.ServiceError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "brief_version": b.version, "navigate": "routes"}


async def create_concept(instruction: str, tool_context: ToolContext) -> dict:
    """Draws a labelled concept image (first one, or a variation like "make the phone slot wider"). ~20 s.
    A visual edit never changes the brief by itself."""
    pid = _pid(tool_context)
    project = await store.get_project(pid)
    concept = await services.generate_concept(pid, instruction=instruction, parent_id=project.get("selected_concept_id"))
    return {"ok": True, "caption": concept["caption"], "brief_effects": concept["effects"], "navigate": "visualise"}


async def find_options(tool_context: ToolContext) -> dict:
    """Searches real stores and real makers that deliver to the customer (~30-60 s) and checks each
    option against the brief."""
    result = None
    async for ev in services.explore_routes(_pid(tool_context)):
        if ev["type"] == "result":
            result = ev["routes"]
    return {"headline": result["narrative"]["headline"], "counts": {k: len(v) for k, v in result["groups"].items()}, "navigate": "routes"}


async def draft_messages(tool_context: ToolContext, names: Optional[list[str]] = None) -> dict:
    """Drafts messages to makers or sellers from the options found (by business name; default: the
    top makers). The customer sends them themselves."""
    pid = _pid(tool_context)
    routes = await store.get(pid, "routes", "latest")
    if not routes:
        return {"ok": False, "error": "Find options first."}
    entries = routes["entries"]
    if names:
        wanted = [n.lower() for n in names]
        picked = [e["item_id"] for e in entries if any(w in e["seller_name"].lower() or w in e["name"].lower() for w in wanted)]
    else:
        picked = [e["item_id"] for e in entries if e["route"] == "make"][:2]
    if not picked:
        return {"ok": False, "error": "No matching business in the options."}
    req = await services.draft_outreach(pid, picked)
    return {"ok": True, "drafted_for": req["seller_names"], "navigate": "request"}


async def remember_preference(preference: str, tool_context: ToolContext) -> dict:
    """Saves a durable preference the customer asked you to remember for future projects."""
    await memory_service().add_memory(app_name=APP_NAME, user_id=tool_context.state["owner"],
                                      memories=[MemoryEntry(content=types.Content(role="user", parts=[types.Part(text=preference)]))])
    await store.log(_pid(tool_context), "agent:assistant", f"Remembered for next time: {preference}", kind="memory",
                    detail="Saved in Agent Platform Memory Bank, only for you.")
    return {"ok": True}


INSTRUCTION = """
You are Tesselle's assistant: a friendly, efficient guide who helps the customer get exactly what they
want - finding it in real stores, or getting it made. You can see their project and act on it.

How you work:
- Call get_project_status when you need facts. Never guess requirement ids.
- Guide step by step: say what just happened and the one next step. If they say "next", "go on" or
  "do it", do the next step for them when a tool exists (confirm_brief, create_concept, find_options,
  draft_messages) or open the right screen with go_to_step.
- When they state a requirement, record it with set_requirement exactly as stated (must vs nice-to-have
  from their words). Budget -> set_budget. City or deadline -> set_delivery. Never infer measurements.
- If they ask to see something ("show me the options", "open the replies"), use go_to_step.
- You must NOT pay, order, send messages for them or accept a seller's change to a must-have. Tell them
  which button to tap - those stay their decision.
- Remembered preferences may appear in your context. Mention one only when relevant, say it is
  remembered, and ask before applying it.
- Replies are spoken aloud: 1-2 short sentences, plain words, no lists, no markdown.
"""


@functools.lru_cache(maxsize=1)
def session_service() -> VertexAiSessionService:
    return VertexAiSessionService(project=config.PROJECT, location=config.AGENT_ENGINE_LOCATION, agent_engine_id=config.AGENT_ENGINE_ID)


@functools.lru_cache(maxsize=1)
def memory_service() -> VertexAiMemoryBankService:
    return VertexAiMemoryBankService(project=config.PROJECT, location=config.AGENT_ENGINE_LOCATION, agent_engine_id=config.AGENT_ENGINE_ID)


@functools.lru_cache(maxsize=1)
def assistant_agent() -> LlmAgent:
    return LlmAgent(
        name="assistant",
        description="Voice and chat guide that can drive a Project Tesselle project.",
        model=model(),
        instruction=INSTRUCTION,
        tools=[PreloadMemoryTool(), get_project_status, go_to_step, set_requirement, remove_requirement, set_budget, set_delivery,
               answer_open_question, confirm_brief, create_concept, find_options, draft_messages, remember_preference],
        generate_content_config=gen_config("assistant"),
    )


@functools.lru_cache(maxsize=1)
def runner() -> Runner:
    return Runner(app_name=APP_NAME, agent=assistant_agent(), session_service=session_service(), memory_service=memory_service())


TOOL_LABELS = {
    "get_project_status": "Looking at your project",
    "go_to_step": "Opening that for you",
    "set_requirement": "Updating your brief",
    "remove_requirement": "Removing that from your brief",
    "set_budget": "Updating your budget",
    "set_delivery": "Updating delivery",
    "answer_open_question": "Saving your answer",
    "confirm_brief": "Confirming your brief",
    "create_concept": "Drawing a concept (about 20 s)",
    "find_options": "Searching real stores and makers (about a minute)",
    "draft_messages": "Writing messages to makers",
    "remember_preference": "Remembering that for next time",
}


async def _session_id(pid: str, owner: str) -> str:
    project = await store.get_project(pid)
    sid = project.get("assistant_session_id")
    if sid:
        return sid
    s = await session_service().create_session(app_name=APP_NAME, user_id=owner, state={"project_id": pid, "owner": owner})
    await store.update_project(pid, assistant_session_id=s.id)
    return s.id


async def chat(pid: str, text: str, audio: Optional[tuple[bytes, str]] = None, media: Optional[list[tuple[bytes, str]]] = None,
               source: str = "", speak: bool = False, screen: str = "") -> AsyncIterator[dict[str, Any]]:
    project = await store.get_project(pid)
    if project is None:
        raise services.ServiceError("Project not found.", 404)
    owner = project["owner"]
    sid = await _session_id(pid, owner)
    parts = []
    if screen:
        parts.append(types.Part(text=f"(The customer is looking at the '{screen}' screen.)"))
    if text:
        parts.append(types.Part(text=text))
    if audio:
        parts.append(types.Part.from_bytes(data=audio[0], mime_type=audio[1]))
        parts.append(types.Part(text="(Voice message from the customer.)"))
    for data, mime in media or []:
        parts.append(types.Part.from_bytes(data=data, mime_type=mime))
        kind = "video clip" if mime.startswith("video/") else "photo"
        parts.append(types.Part(text=f"(A {kind} the customer just captured{' with ' + source if source else ''}. "
                                     "Relate it to the brief; sizes seen in it are unconfirmed.)"))
    started = time.perf_counter()
    tok = [0, 0, 0]
    final_text: list[str] = []
    tools_used: list[str] = []
    async for ev in runner().run_async(user_id=owner, session_id=sid, new_message=types.Content(role="user", parts=parts)):
        u = getattr(ev, "usage_metadata", None)
        if u:
            tok[0] += u.prompt_token_count or 0
            tok[1] += u.candidates_token_count or 0
            tok[2] += u.thoughts_token_count or 0
        for p in (ev.content.parts if ev.content and ev.content.parts else []):
            if p.function_call and p.function_call.name in TOOL_LABELS:
                tools_used.append(p.function_call.name)
                yield {"type": "tool", "name": p.function_call.name, "agent": "Assistant", "message": TOOL_LABELS[p.function_call.name]}
            elif p.function_response and isinstance(p.function_response.response, dict):
                nav = p.function_response.response.get("navigate")
                if nav:
                    yield {"type": "ui", "navigate": nav}
            elif p.text and not getattr(p, "thought", False) and ev.author == "assistant":
                final_text.append(p.text)
                yield {"type": "text", "text": p.text}
    reply = "".join(final_text).strip()
    stats = {"agent": "assistant", "model": config.MODEL_REASONING, "latency_ms": int((time.perf_counter() - started) * 1000),
             "prompt_tokens": tok[0], "output_tokens": tok[1], "thought_tokens": tok[2],
             "framework": "ADK LlmAgent + Agent Platform Sessions + Memory Bank", "tools": tools_used}
    what = f"Said: {text[:140]}" if text else ("Spoke to the assistant" if audio else "Shared a capture")
    if media:
        what += f" + {len(media)} capture(s)" + (f" from {source}" if source else "")
    await store.log(pid, "customer", what, kind="chat")
    await store.log(pid, "agent:assistant", reply[:280] or "(no reply)", kind="chat", stats=[stats])
    audio_url = None
    if speak and reply:
        try:
            audio_url, _ = await gemini.speak(reply[:600], purpose="assistant-voice")
        except Exception as e:  # speech is a nicety; the text reply stands
            log.warning("tts failed: %s", e)
    try:
        session = await session_service().get_session(app_name=APP_NAME, user_id=owner, session_id=sid)
        await asyncio.wait_for(memory_service().add_session_to_memory(session), timeout=8)
    except Exception as e:  # memory is best-effort
        log.warning("memory ingest skipped: %s", e)
    yield {"type": "done", "reply": reply, "audio": audio_url, "state": await store.full_state(pid)}


async def history(pid: str) -> list[dict[str, str]]:
    project = await store.get_project(pid)
    sid = project and project.get("assistant_session_id")
    if not sid:
        return []
    s = await session_service().get_session(app_name=APP_NAME, user_id=project["owner"], session_id=sid)
    out = []
    for ev in s.events if s else []:
        for p in (ev.content.parts if ev.content and ev.content.parts else []):
            if p.text and not getattr(p, "thought", False) and not p.text.startswith("(The customer is looking"):
                out.append({"role": "customer" if ev.author == "user" else "assistant", "text": p.text})
    return out


async def seed_demo_memory(owner: str) -> None:
    """For the guided demo profile only: earlier-project preferences the assistant can recall."""
    await memory_service().add_memory(
        app_name=APP_NAME, user_id=owner,
        memories=[MemoryEntry(content=types.Content(role="user", parts=[types.Part(text=t)])) for t in (
            "I rent my flat in Chennai, so I can never drill into walls or furniture.",
            "I prefer warm natural materials like bamboo or light wood over plastic or metal.",
        )],
    )
