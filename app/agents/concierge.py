"""MissionLock concierge: the conversational agent in the workspace's bottom panel.

* Google ADK LlmAgent on Gemini (Vertex AI) with function tools that call the same guarded
  services as the UI buttons - a spoken "make it narrower" and a click take the same path.
* Agent Platform Sessions (VertexAiSessionService) keep the conversation per project, so the
  phone and the desktop continue one thread.
* Agent Platform Memory Bank (VertexAiMemoryBankService) remembers durable preferences across
  projects ("I rent, so no drilling"); PreloadMemoryTool injects them into each turn.
* The concierge can never send requests, accept seller changes or approve spending: those are
  explicit, labelled buttons in the UI (blueprint: risk-bearing actions use explicit labels).
"""

from __future__ import annotations

import asyncio
import functools
import json
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

from .. import config, services, store
from ..models import Budget, Requirement
from .runtime import gen_config, model

log = logging.getLogger(__name__)
APP_NAME = config.AGENT_ENGINE_ID


def _pid(tool_context: ToolContext) -> str:
    return tool_context.state["project_id"]


async def get_project_status(tool_context: ToolContext) -> dict:
    """Returns the current brief (requirements with ids, budget, open questions), the selected
    concept, the route results headline and the next decision. Call this before changing anything."""
    pid = _pid(tool_context)
    state = await store.full_state(pid)
    brief = state["briefs"][-1] if state["briefs"] else None
    return {
        "brief": brief and {
            "version": brief["version"],
            "confirmed": brief["confirmed"],
            "requirements": [
                {k: r.get(k) for k in ("id", "label", "kind", "attribute", "op", "value_num", "value_list", "status")}
                for r in brief["requirements"]
            ],
            "budget": brief["budget"],
            "open_questions": [
                {"id": u["id"], "question": u["question"]} for u in brief["unknowns"] if u["status"] == "open"
            ],
        },
        "routes_headline": (state.get("routes") or {}).get("narrative", {}).get("headline"),
        "quotes": [{"seller": q["seller_name"], "readiness": q["readiness"], "status": q["status"]} for q in state["quotes"]],
        "next_decision": services.next_decision(state),
    }


async def set_requirement(
    requirement_id: str,
    label: str,
    kind: str,
    tool_context: ToolContext,
    attribute: Optional[str] = None,
    op: Optional[str] = None,
    value_num: Optional[float] = None,
    value_list: Optional[list[str]] = None,
    unit: Optional[str] = None,
) -> dict:
    """Adds or updates one requirement exactly as the customer stated it in this conversation.

    Args:
      requirement_id: existing id to update, or a new kebab-case id.
      label: plain-language label, e.g. "Maximum width 30 cm".
      kind: "must" (cannot change without approval) or "flexible".
      attribute: depth_cm, width_cm, height_cm, mounting, material, finish, features, delivery_days.
      op: "<=", ">=", "==", "in", "not_in" or "has".
      value_num: number for <=, >=, ==.
      value_list: lowercase options for in / not_in / has.
      unit: e.g. "cm".
    """
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    req = Requirement(id=requirement_id, label=label, kind="must" if kind == "must" else "flexible",
                      attribute=attribute, op=op, value_num=value_num, value_list=value_list, unit=unit,
                      source="customer", status="confirmed")
    reqs = [r for r in brief.requirements if r.id != requirement_id] + [req]
    updated = await services.edit_brief(
        pid, services.BriefPatch(requirements=reqs, summary=f"Via MissionLock chat: {label} ({req.kind})"),
        by="customer (via MissionLock chat)",
    )
    return {"ok": True, "brief_version": updated.version, "confirmed": updated.confirmed}


async def remove_requirement(requirement_id: str, tool_context: ToolContext) -> dict:
    """Removes a requirement the customer explicitly asked to drop."""
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    target = brief.req(requirement_id)
    if target is None:
        return {"ok": False, "error": "No such requirement id."}
    reqs = [r for r in brief.requirements if r.id != requirement_id]
    updated = await services.edit_brief(
        pid, services.BriefPatch(requirements=reqs, summary=f"Via MissionLock chat: removed '{target.label}'"),
        by="customer (via MissionLock chat)",
    )
    return {"ok": True, "brief_version": updated.version}


async def set_budget(tool_context: ToolContext, target_inr: Optional[int] = None, limit_inr: Optional[int] = None) -> dict:
    """Sets the target budget (flexible) and/or absolute spending limit (must), in INR."""
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    b = Budget(target_inr=target_inr if target_inr is not None else brief.budget.target_inr,
               limit_inr=limit_inr if limit_inr is not None else brief.budget.limit_inr,
               share_with_sellers=brief.budget.share_with_sellers)
    updated = await services.edit_brief(pid, services.BriefPatch(budget=b, summary="Via MissionLock chat: budget updated"),
                                        by="customer (via MissionLock chat)")
    return {"ok": True, "brief_version": updated.version}


async def answer_open_question(unknown_id: str, tool_context: ToolContext, answer: Optional[str] = None,
                               dont_know: bool = False) -> dict:
    """Records the customer's answer to an open question (or that they don't know)."""
    updated = await services.answer_unknown(_pid(tool_context), unknown_id, answer, dont_know)
    return {"ok": True, "brief_version": updated.version}


async def refine_concept(instruction: str, tool_context: ToolContext) -> dict:
    """Renders a new labelled concept variation from the selected concept, e.g. "make the phone slot wider".
    Takes ~20 seconds. A visual edit never changes the brief by itself."""
    pid = _pid(tool_context)
    project = await store.get_project(pid)
    concept = await services.generate_concept(pid, instruction=instruction, parent_id=project.get("selected_concept_id"))
    return {"ok": True, "caption": concept["caption"], "brief_effects": concept["effects"]}


async def explore_routes(tool_context: ToolContext) -> dict:
    """Checks buy / source / customise / make routes against the confirmed brief (~20-40 s)."""
    result = None
    async for ev in services.explore_routes(_pid(tool_context)):
        if ev["type"] == "result":
            result = ev["routes"]
    return {"headline": result["narrative"]["headline"], "groups": {k: len(v) for k, v in result["groups"].items()}}


async def remember_preference(preference: str, tool_context: ToolContext) -> dict:
    """Saves a durable preference the customer asked you to remember for future projects
    (e.g. "I rent, so never anything that needs drilling"). Only when they ask or clearly state a lasting fact."""
    await memory_service().add_memory(
        app_name=APP_NAME,
        user_id=tool_context.state["owner"],
        memories=[MemoryEntry(content=types.Content(role="user", parts=[types.Part(text=preference)]))],
    )
    await store.log(_pid(tool_context), "agent:missionlock", f"Remembered for future projects: {preference}", kind="memory",
                    detail="Stored in Agent Platform Memory Bank, scoped to this customer.")
    return {"ok": True}


INSTRUCTION = """
You are MissionLock, the customer's intent safeguard inside Project Tesselle. The customer sees one
calm workspace; you are the conversation panel beside it.

How you work:
- Start by calling get_project_status when you need facts. Never guess requirement ids.
- Ask the smallest useful next question and say why it matters. Allow "I don't know".
- When the customer states a requirement, record it with set_requirement exactly as stated
  (must vs flexible from their words). Never infer measurements from photos.
- Use the customer's language: "Must stay the same", "Flexible", "Needs checking".
- If they ask for a visual change, call refine_concept; if it implies a brief change, ask first.
- You may explore routes. You must NOT send seller requests, accept seller changes or approve
  quotes/orders: tell the customer which button to press on screen - those need their explicit,
  labelled approval.
- Remembered preferences from earlier projects may appear in your context. Mention one only when
  it is relevant, say it is remembered, and ask before applying it to this brief.
- Everything commercial in this prototype (sellers, quotes, orders) is fictional demo data or a
  sandbox. Never claim otherwise.
- Be brief: 1-3 sentences, plain text, no markdown headings.
"""


@functools.lru_cache(maxsize=1)
def session_service() -> VertexAiSessionService:
    return VertexAiSessionService(project=config.PROJECT, location=config.AGENT_ENGINE_LOCATION,
                                  agent_engine_id=config.AGENT_ENGINE_ID)


@functools.lru_cache(maxsize=1)
def memory_service() -> VertexAiMemoryBankService:
    return VertexAiMemoryBankService(project=config.PROJECT, location=config.AGENT_ENGINE_LOCATION,
                                     agent_engine_id=config.AGENT_ENGINE_ID)


@functools.lru_cache(maxsize=1)
def concierge_agent() -> LlmAgent:
    return LlmAgent(
        name="missionlock",
        description="Conversational intent safeguard for a Project Tesselle project.",
        model=model(),
        instruction=INSTRUCTION,
        tools=[
            PreloadMemoryTool(),
            get_project_status,
            set_requirement,
            remove_requirement,
            set_budget,
            answer_open_question,
            refine_concept,
            explore_routes,
            remember_preference,
        ],
        generate_content_config=gen_config("concierge"),
    )


@functools.lru_cache(maxsize=1)
def runner() -> Runner:
    return Runner(app_name=APP_NAME, agent=concierge_agent(), session_service=session_service(),
                  memory_service=memory_service())


TOOL_LABELS = {
    "get_project_status": "Reading your project",
    "set_requirement": "Updating your brief",
    "remove_requirement": "Removing a requirement",
    "set_budget": "Updating your budget",
    "answer_open_question": "Recording your answer",
    "refine_concept": "Rendering a concept variation (about 20 s)",
    "explore_routes": "Checking buy, source and make routes",
    "remember_preference": "Saving to Memory Bank",
}


async def _session_id(pid: str, owner: str) -> str:
    project = await store.get_project(pid)
    sid = project.get("concierge_session_id")
    if sid:
        return sid
    s = await session_service().create_session(app_name=APP_NAME, user_id=owner,
                                               state={"project_id": pid, "owner": owner})
    await store.update_project(pid, concierge_session_id=s.id)
    return s.id


async def chat(
    pid: str,
    text: str,
    audio: Optional[tuple[bytes, str]] = None,
    media: Optional[list[tuple[bytes, str]]] = None,
    source: str = "",
) -> AsyncIterator[dict[str, Any]]:
    project = await store.get_project(pid)
    if project is None:
        raise services.ServiceError("Project not found.", 404)
    owner = project["owner"]
    sid = await _session_id(pid, owner)
    parts = []
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
    final_text = []
    tools_used = []
    async for ev in runner().run_async(user_id=owner, session_id=sid, new_message=types.Content(role="user", parts=parts)):
        u = getattr(ev, "usage_metadata", None)
        if u:
            tok[0] += u.prompt_token_count or 0
            tok[1] += u.candidates_token_count or 0
            tok[2] += u.thoughts_token_count or 0
        for p in (ev.content.parts if ev.content and ev.content.parts else []):
            if p.function_call and p.function_call.name in TOOL_LABELS:
                tools_used.append(p.function_call.name)
                yield {"type": "tool", "name": p.function_call.name, "message": TOOL_LABELS[p.function_call.name]}
            elif p.text and not getattr(p, "thought", False) and ev.author == "missionlock":
                final_text.append(p.text)
                yield {"type": "text", "text": p.text}
    reply = "".join(final_text).strip()
    stats = {"agent": "missionlock", "model": config.MODEL_REASONING, "latency_ms": int((time.perf_counter() - started) * 1000),
             "prompt_tokens": tok[0], "output_tokens": tok[1], "thought_tokens": tok[2],
             "framework": "ADK LlmAgent + Agent Platform Sessions + Memory Bank", "tools": tools_used}
    what = f"Said: {text[:140]}" if text else ("Sent a voice message" if audio else "Shared a capture")
    if media:
        what += f" + {len(media)} capture(s)" + (f" from {source}" if source else "")
    await store.log(pid, "customer", what, kind="chat")
    await store.log(pid, "agent:missionlock", reply[:280] or "(no reply)", kind="chat", stats=[stats])
    # Let Memory Bank extract durable preferences from this conversation (server-side, async).
    try:
        session = await session_service().get_session(app_name=APP_NAME, user_id=owner, session_id=sid)
        await asyncio.wait_for(memory_service().add_session_to_memory(session), timeout=8)
    except Exception as e:  # memory is best-effort; the conversation already succeeded
        log.warning("memory ingest skipped: %s", e)
    yield {"type": "done", "reply": reply, "state": await store.full_state(pid)}


async def history(pid: str) -> list[dict[str, str]]:
    project = await store.get_project(pid)
    sid = project and project.get("concierge_session_id")
    if not sid:
        return []
    s = await session_service().get_session(app_name=APP_NAME, user_id=project["owner"], session_id=sid)
    out = []
    for ev in s.events if s else []:
        for p in (ev.content.parts if ev.content and ev.content.parts else []):
            if p.text and not getattr(p, "thought", False):
                out.append({"role": "customer" if ev.author == "user" else "missionlock", "text": p.text})
    return out


async def seed_demo_memory(owner: str) -> None:
    """For the guided demo profile only: earlier-project preferences the concierge can recall."""
    await memory_service().add_memory(
        app_name=APP_NAME,
        user_id=owner,
        memories=[
            MemoryEntry(content=types.Content(role="user", parts=[types.Part(text=t)]))
            for t in (
                "I rent my flat in Chennai, so I can never drill into walls or furniture.",
                "I prefer warm natural materials like bamboo or light wood over plastic or metal.",
            )
        ],
    )
