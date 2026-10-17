"""Tesselle assistant: the voice and chat agent that guides the customer and drives the app.

* Google ADK LlmAgent on Gemini (Vertex AI) with function tools that call the same guarded services
  as the UI buttons - "set my budget to 3,000", "find options", "add the IKEA one to my picks" or
  "take me to the replies" take the same path as a click. Tools that move the flow return a
  `navigate` hint the UI follows. The same tools power the real-time voice agent (app.live).
* Agent Platform Sessions (VertexAiSessionService) keep one conversation per project, so phone,
  glasses and desktop continue the same thread.
* Agent Platform Memory Bank (VertexAiMemoryBankService) remembers durable preferences across
  projects ("I rent, so no drilling"); PreloadMemoryTool injects them into each turn.
* Sending messages, calling businesses and placing orders need the customer's explicit "yes" in the
  conversation (confirmed=true), and payment always happens on the store - never by the agent.
  A seller's change to a must-have is never accepted by the agent.
"""

from __future__ import annotations

import asyncio
import contextvars
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
         "replies": "compare", "picks": "approve", "choose": "approve", "orders": "fulfil", "track": "fulfil",
         "delivery check": "accept"}
# Set per request: whether this browser holds the owner key (needed to send from the owner's inbox or phone line).
OWNER_OK: contextvars.ContextVar[bool] = contextvars.ContextVar("owner_ok", default=False)
PUBLIC_BASE: contextvars.ContextVar[str] = contextvars.ContextVar("public_base", default="")


def _pid(tool_context: ToolContext) -> str:
    return tool_context.state["project_id"]


async def _brief_or_none(pid: str):
    return await store.get_brief(pid)


NO_BRIEF = {"ok": False, "error": "There is no brief yet. Call start_brief with everything the customer said they want first."}


async def get_project_status(tool_context: ToolContext) -> dict:
    """Returns the brief (requirements with ids, budget, city, PIN code, open questions), the options found,
    picks, orders, messages, replies and the next step. Call this before changing anything."""
    state = await store.full_state(_pid(tool_context))
    brief = state["briefs"][-1] if state["briefs"] else None
    routes = state.get("routes") or {}
    return {
        "project_title": state["project"]["title"],
        "brief": brief and {
            "version": brief["version"], "confirmed": brief["confirmed"], "title": brief["title"], "purpose": brief["purpose"],
            "requirements": [{k: r.get(k) for k in ("id", "label", "kind", "attribute", "op", "value_num", "value_list", "status")}
                             for r in brief["requirements"]],
            "budget": brief["budget"], "delivery": brief["delivery"],
            "open_questions": [{"id": u["id"], "question": u["question"]} for u in brief["unknowns"] if u["status"] == "open"],
        },
        "options": routes and {"headline": routes.get("narrative", {}).get("headline"),
                               "items": [{"name": e["name"], "seller": e["seller_name"], "kind": "made to order" if e["route"] == "make" else "store",
                                          "verdict": e["verdict"], "price_inr": e["price_inr"]} for e in routes.get("entries", [])[:10]]},
        "picks": [{"title": c["title"], "seller": c["seller_name"], "qty": c["qty"]} for c in state.get("cart") or []],
        "orders": [{"title": o["title"], "seller": o["seller_name"], "status": o.get("status")} for o in state.get("orders") or []],
        "messages": [{"to": r["name"], "channel": r.get("channel"), "status": r["status"]} for q in state["requests"] for r in q["recipients"]],
        "replies": [{"seller": q["seller_name"], "readiness": q["readiness"], "status": q["status"]} for q in state["quotes"]],
        "notes": [n["text"][:120] for n in state.get("notes") or []][:5],
        "next_step": services.next_decision(state),
        "screen": tool_context.state.get("screen"),
        "steps_you_can_open": list(STEPS),
    }


async def go_to_step(step: str, tool_context: ToolContext) -> dict:
    """Opens a step on the customer's screen. step is one of: start, brief, visualise, options, reach out,
    replies, picks, orders, delivery check - or "back" for the previous step."""
    s = step.lower().strip()
    if s == "back":
        return {"ok": True, "navigate": "back"}
    key = STEPS.get(s)
    if not key:
        return {"ok": False, "error": "Unknown step. Use one of: " + ", ".join(STEPS)}
    return {"ok": True, "navigate": key}


async def start_brief(description: str, tool_context: ToolContext, city: Optional[str] = None, pincode: Optional[str] = None) -> dict:
    """Starts the project's brief from what the customer said they want (only when there is no brief yet).
    Pass everything they said in `description`, in their words. ~15 s."""
    pid = _pid(tool_context)
    if await _brief_or_none(pid):
        return {"ok": False, "error": "A brief already exists - change it with set_requirement, set_budget or set_delivery."}
    try:
        b = await services.start_from_inspiration(pid, text=description, region=city or "", pincode=pincode or "", source="voice assistant")
    except services.ServiceError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "title": b.title, "must_haves": [r.label for r in b.musts()],
            "questions": [u.question for u in b.unknowns if u.status == "open"], "navigate": "clarify"}


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
    if brief is None:
        return NO_BRIEF
    req = Requirement(id=requirement_id, label=label, kind="must" if kind == "must" else "flexible", attribute=attribute, op=op,
                      value_num=value_num, value_list=value_list, unit=unit, source="customer", status="confirmed")
    reqs = [r for r in brief.requirements if r.id != requirement_id] + [req]
    updated = await services.edit_brief(pid, services.BriefPatch(requirements=reqs, summary=f"Via assistant: {label} ({req.kind})"),
                                        by="customer (via assistant)")
    return {"ok": True, "brief_version": updated.version}


async def remove_requirement(requirement_id: str, tool_context: ToolContext) -> dict:
    """Removes a requirement the customer explicitly asked to drop."""
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    if brief is None:
        return NO_BRIEF
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
    if brief is None:
        return NO_BRIEF
    b = Budget(target_inr=target_inr if target_inr is not None else brief.budget.target_inr,
               limit_inr=limit_inr if limit_inr is not None else brief.budget.limit_inr, share_with_sellers=brief.budget.share_with_sellers)
    updated = await services.edit_brief(pid, services.BriefPatch(budget=b, summary="Via assistant: budget updated"), by="customer (via assistant)")
    return {"ok": True, "brief_version": updated.version}


async def set_delivery(tool_context: ToolContext, city: Optional[str] = None, pincode: Optional[str] = None, deadline: Optional[str] = None) -> dict:
    """Sets the delivery city, the 6-digit PIN code and/or the date it's needed by (ISO yyyy-mm-dd)."""
    pid = _pid(tool_context)
    brief = await store.get_brief(pid)
    if brief is None:
        return NO_BRIEF
    if pincode and not city:
        try:
            city = (await services.pincode_lookup(pincode))["label"]
        except services.ServiceError:
            pass
    d = Delivery(region=city or brief.delivery.region, pincode=pincode or brief.delivery.pincode,
                 desired_by=deadline or brief.delivery.desired_by, essential=brief.delivery.essential)
    updated = await services.edit_brief(pid, services.BriefPatch(delivery=d, summary="Via assistant: delivery updated"), by="customer (via assistant)")
    return {"ok": True, "brief_version": updated.version, "delivery": updated.delivery.model_dump()}


async def rename_project(title: str, tool_context: ToolContext) -> dict:
    """Renames the project (a label only - the brief's requirements don't change)."""
    await services.edit_project(_pid(tool_context), title=title)
    return {"ok": True}


async def answer_open_question(unknown_id: str, tool_context: ToolContext, answer: Optional[str] = None, dont_know: bool = False) -> dict:
    """Records the customer's answer to an open question (or that they don't know)."""
    try:
        updated = await services.answer_unknown(_pid(tool_context), unknown_id, answer, dont_know)
    except services.ServiceError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "brief_version": updated.version}


async def add_note(text: str, tool_context: ToolContext) -> dict:
    """Saves a note the customer dictates for later ("note: check the colour with my wife")."""
    await services.add_note(_pid(tool_context), text)
    return {"ok": True}


async def ask_for_photo(kind: str, what: str, tool_context: ToolContext) -> dict:
    """Asks the customer for a photo or short video (kind: space, inspiration, item, person or receipt) and
    opens the capture sheet: on a computer it shows a QR code to snap it with their phone (or a MetaGlass),
    plus upload and webcam; on a phone it opens the camera. `what` says what to capture, e.g. "the alcove
    with a tape measure in view". Use it early when a photo would help; the customer may skip it."""
    k = kind if kind in ("space", "inspiration", "item", "person", "receipt") else "space"
    return {"ok": True, "capture": k, "what": what[:160], "note": "The capture sheet is open on their screen. Wait for the photo or a skip."}


async def choose_path(path: str, tool_context: ToolContext) -> dict:
    """Sets how this will most likely be fulfilled, which reshapes the steps on screen: "buy" (ready-made
    from stores), "make" (made, tailored or printed by a maker), "either", or "source" (bulk from suppliers)."""
    p = path if path in ("buy", "make", "either", "source") else "either"
    await store.update_project(_pid(tool_context), plan_route=p)
    return {"ok": True, "path": p}


async def confirm_brief(tool_context: ToolContext) -> dict:
    """Confirms the brief when the customer says it's right. Fails if a must-have still needs measuring or
    the delivery city / PIN code is missing (searches only show sellers that deliver there)."""
    brief = await store.get_brief(_pid(tool_context))
    if brief is None:
        return NO_BRIEF
    if not (brief.delivery.region or brief.delivery.pincode):
        return {"ok": False, "error": "Ask where it should be delivered (city or PIN code) first, then confirm."}
    try:
        b = await services.confirm_brief(_pid(tool_context))
    except services.ServiceError as e:
        return {"ok": False, "error": str(e), "details": e.details}
    return {"ok": True, "brief_version": b.version, "navigate": "routes"}


async def create_concept(instruction: str, tool_context: ToolContext) -> dict:
    """Draws a concept image (first one, or a variation like "make the phone slot wider"). ~20 s.
    If the instruction changes a size or material, the brief is updated and the customer can revert it."""
    pid = _pid(tool_context)
    if await store.get_brief(pid) is None:
        return NO_BRIEF
    project = await store.get_project(pid)
    concept = await services.generate_concept(pid, instruction=instruction, parent_id=project.get("selected_concept_id"))
    return {"ok": True, "caption": concept["caption"], "brief_changes": (concept.get("applied") or {}).get("changes"), "navigate": "visualise"}


async def find_options(tool_context: ToolContext) -> dict:
    """Searches real stores and real makers that deliver to the customer (~30-60 s) and checks each
    option against the brief."""
    result = None
    try:
        async for ev in services.explore_routes(_pid(tool_context)):
            if ev["type"] == "result":
                result = ev["routes"]
    except services.ServiceError as e:
        return {"ok": False, "error": str(e)}
    return {"headline": result["narrative"]["headline"], "counts": {k: len(v) for k, v in result["groups"].items()}, "navigate": "routes"}


def _match(entries: list[dict], names: list[str]) -> list[dict]:
    wanted = [n.lower() for n in names if n]
    return [e for e in entries if any(w in e["seller_name"].lower() or w in e["name"].lower() for w in wanted)]


async def show_look(tool_context: ToolContext, names: Optional[list[str]] = None) -> dict:
    """Makes a shoppable picture: the real products found (by name/store; default the best matches) shown
    together - in the customer's own space photo if they shared one - with clickable hotspots. ~25 s."""
    pid = _pid(tool_context)
    routes = await store.get(pid, "routes", "latest")
    if not routes:
        return {"ok": False, "error": "Find options first."}
    ids = [e["item_id"] for e in _match(routes["entries"], names or [])] if names else None
    try:
        look = await services.make_look(pid, ids)
    except services.ServiceError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "products": [i["name"] for i in look["items"]], "navigate": "routes"}


async def add_to_picks(names: list[str], tool_context: ToolContext) -> dict:
    """Adds options to the customer's picks by product or store name ("the IKEA pegboard"). Several items
    are fine. The fit checker refuses anything that breaks a must-have."""
    pid = _pid(tool_context)
    routes = await store.get(pid, "routes", "latest")
    if not routes:
        return {"ok": False, "error": "Find options first."}
    hits = _match([e for e in routes["entries"] if e["route"] == "buy"], names)
    if not hits:
        return {"ok": False, "error": "No matching option. Say the store or product name as shown on screen."}
    added, refused = [], []
    for e in hits[:4]:
        try:
            item = await services.add_to_cart(pid, entry_id=e["item_id"])
            added.append({"title": item["title"], "to_check_first": list((item.get("needs") or {}).values())})
        except services.ServiceError as err:
            refused.append({"title": e["name"], "why": err.details or [str(err)]})
    return {"ok": bool(added), "added": added, "refused": refused, "navigate": "approve"}


async def place_order(confirmed: bool, tool_context: ToolContext, acknowledge_checks: bool = False) -> dict:
    """Places the order for everything in the picks: the checkout agent fills the store carts and the
    customer authorises payment on the store. Only call with confirmed=true after the customer said yes
    to the items and total. acknowledge_checks=true only if they agreed to check the listed details."""
    if not confirmed:
        return {"ok": False, "error": "Ask the customer to confirm the items and total first."}
    acks = list(services.ACK_LABELS) if acknowledge_checks else []
    try:
        orders = await services.place_orders(_pid(tool_context), acknowledgements=acks)
    except services.ServiceError as e:
        return {"ok": False, "error": str(e), "details": e.details}
    return {"ok": True, "orders": [{"title": o["title"], "how": o["checkout"]["label"]} for o in orders], "navigate": "fulfil",
            "note": "Each checkout is ready - the customer taps it and pays on the store."}


async def draft_messages(tool_context: ToolContext, names: Optional[list[str]] = None) -> dict:
    """Drafts messages to makers or sellers from the options found (by business name; default: the
    top makers), with privacy-checked photos attached."""
    pid = _pid(tool_context)
    routes = await store.get(pid, "routes", "latest")
    if not routes:
        return {"ok": False, "error": "Find options first."}
    entries = routes["entries"]
    picked = [e["item_id"] for e in _match(entries, names or [])] if names else [e["item_id"] for e in entries if e["route"] == "make"][:2]
    if not picked:
        return {"ok": False, "error": "No matching business in the options."}
    req = await services.draft_outreach(pid, picked)
    return {"ok": True, "drafted_for": [{"name": r["name"], "channel": r["channel"]} for r in req["recipients"]], "navigate": "request"}


async def send_messages(confirmed: bool, tool_context: ToolContext) -> dict:
    """Sends the drafted messages on each recipient's channel (email from the connected inbox, or a phone
    call by the call agent). Only with confirmed=true after the customer said yes."""
    if not confirmed:
        return {"ok": False, "error": "Read out who gets what and ask the customer to confirm first."}
    if not OWNER_OK.get():
        return {"ok": False, "error": "Sending from this device needs the owner key (Settings). Ask the customer to tap Send on screen."}
    pid = _pid(tool_context)
    reqs = await store.list_coll(pid, "requests")
    if not reqs:
        return {"ok": False, "error": "Draft messages first."}
    lines = []
    try:
        async for ev in services.send_outreach(pid, reqs[-1]["id"], None, PUBLIC_BASE.get()):
            if ev.get("message"):
                lines.append(ev["message"])
    except services.ServiceError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "done": lines, "navigate": "request"}


async def check_replies(tool_context: ToolContext) -> dict:
    """Reads new replies to Tesselle's emails from the connected inbox and checks each against the brief."""
    if not OWNER_OK.get():
        return {"ok": False, "error": "Reading the inbox needs the owner key on this device."}
    found = 0
    try:
        async for ev in services.check_replies(_pid(tool_context)):
            if ev["type"] == "result":
                found = ev.get("found", 0)
    except services.ServiceError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "new_replies": found, "navigate": "compare"}


async def remember_preference(preference: str, tool_context: ToolContext) -> dict:
    """Saves a durable preference the customer asked you to remember for future projects."""
    await memory_service().add_memory(app_name=APP_NAME, user_id=tool_context.state["owner"],
                                      memories=[MemoryEntry(content=types.Content(role="user", parts=[types.Part(text=preference)]))])
    await store.log(_pid(tool_context), "agent:assistant", f"Remembered for next time: {preference}", kind="memory",
                    detail="Saved in Agent Platform Memory Bank, only for you.")
    return {"ok": True}


TOOLS = [get_project_status, go_to_step, start_brief, set_requirement, remove_requirement, set_budget, set_delivery,
         rename_project, answer_open_question, add_note, ask_for_photo, choose_path, confirm_brief, create_concept, find_options, show_look, add_to_picks,
         place_order, draft_messages, send_messages, check_replies, remember_preference]

INSTRUCTION = """
You are Tesselle: the customer's shopping agent. You find what they want in real stores, or get it made
by real makers, and you drive the whole app for them - by voice or chat.

How you work:
- Call get_project_status when you need facts. Never guess ids or names.
- If there is no brief yet, call start_brief with everything they said (their words, city, PIN code).
- Do the work, don't describe buttons: record requirements (set_requirement, must vs nice-to-have from their
  words), budget (set_budget), city / PIN code / deadline (set_delivery), answers (answer_open_question),
  notes (add_note). Never infer measurements they didn't give.
- Follow the journey in order and never skip ahead on your own:
  1) Understand: start_brief, then ask the one or two facts that decide what fits (a size, a model, a quantity,
     the occasion) - one question at a time. If a photo would help (of the space, the item, an example), offer
     it early with ask_for_photo; they can skip. Note whether they want it ready-made, made for them, or in
     bulk (choose_path).
  2) Make sure you know where it is delivered (city or PIN code) before confirming. Read back the must-haves
     and confirm_brief only when they agree.
  3) Then offer a concept picture (create_concept) when it is being made or they want to see it, and search
     (find_options). Then picks and ordering, or messages to makers.
  If they say "next", "go on" or "do it", do the next step in that order.
- The brief panel on screen updates live, so small edits need no screen change. Use go_to_step only when the
  step really changes, or when they ask ("back" goes to the previous step).
- Sending messages, calling businesses and placing orders: first say exactly what will happen (who, which
  channel, which items and the total) and wait for a clear "yes"; then call with confirmed=true. Payment is
  always done by the customer on the store - you never pay. Never accept a seller's change to a must-have.
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
        description="Voice and chat agent that drives a Project Tesselle project.",
        model=model(),
        instruction=INSTRUCTION,
        tools=[PreloadMemoryTool(), *TOOLS],
        generate_content_config=gen_config("assistant"),
    )


@functools.lru_cache(maxsize=1)
def runner() -> Runner:
    return Runner(app_name=APP_NAME, agent=assistant_agent(), session_service=session_service(), memory_service=memory_service())


TOOL_LABELS = {
    "get_project_status": "Looking at your project",
    "go_to_step": "Opening that for you",
    "start_brief": "Writing your brief (about 15 s)",
    "set_requirement": "Updating your brief",
    "remove_requirement": "Removing that from your brief",
    "set_budget": "Updating your budget",
    "set_delivery": "Updating delivery",
    "rename_project": "Renaming the project",
    "answer_open_question": "Saving your answer",
    "add_note": "Saving your note",
    "confirm_brief": "Confirming your brief",
    "create_concept": "Drawing a concept (about 20 s)",
    "find_options": "Searching real stores and makers (about a minute)",
    "show_look": "Making a shoppable picture (about 25 s)",
    "add_to_picks": "Adding to your picks",
    "place_order": "Preparing your orders",
    "draft_messages": "Writing messages to makers",
    "send_messages": "Sending your messages",
    "check_replies": "Checking your inbox for replies",
    "remember_preference": "Remembering that for next time",
    "ask_for_photo": "Opening the camera and QR code",
    "save_camera_view": "Saving what your camera sees",
    "choose_path": "Shaping your steps",
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
               source: str = "", speak: bool = False, screen: str = "", owner_ok: bool = False, public_base: str = "") -> AsyncIterator[dict[str, Any]]:
    project = await store.get_project(pid)
    if project is None:
        raise services.ServiceError("Project not found.", 404)
    owner = project["owner"]
    sid = await _session_id(pid, owner)
    OWNER_OK.set(owner_ok)
    PUBLIC_BASE.set(public_base)
    if audio and not text:
        # Speech is turned into words first, so the conversation (and the screen) shows what was said.
        text = await services.transcribe(audio)
        audio = None
        yield {"type": "heard", "text": text}
        if not text:
            raise services.ServiceError("Sorry, I didn't catch that - try again.")
    parts = [types.Part(text=f"({services.today_line()})")]
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
