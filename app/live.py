"""Real-time voice agent: browser microphone <-> Gemini Live (native audio) on Vertex AI.

The browser streams 16 kHz PCM over a WebSocket to Cloud Run; this module relays it to a Gemini Live
session and streams the spoken answer (24 kHz PCM) back, with live captions of both sides. The voice
agent has the same tools as the chat assistant (app.agents.assistant), so it can fill in the brief, run
searches, add picks and open screens while it talks. Tools that take a while (search, drawing) run in
the background: the agent says it has started, the screen shows progress, and it speaks the result
when it's ready. Sending, calling and ordering still need the customer's spoken "yes".
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
from typing import Any, Optional

from fastapi import WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

from . import config, identity, services, store
from .agents import assistant as A

log = logging.getLogger(__name__)

LIVE_MODEL = os.environ.get("TESSELLE_LIVE_MODEL", "gemini-live-2.5-flash-native-audio")
LIVE_LOCATION = os.environ.get("TESSELLE_LIVE_LOCATION", "us-central1")
VOICE = os.environ.get("TESSELLE_LIVE_VOICE", "Aoede")
SLOW = {"start_brief", "create_concept", "find_options", "show_look", "draft_messages", "send_messages", "check_replies", "place_order"}


@functools.lru_cache(maxsize=1)
def live_client() -> genai.Client:
    return genai.Client(vertexai=True, project=config.PROJECT, location=LIVE_LOCATION, credentials=identity.credentials())


def _s(t: str, desc: str = "", **kw: Any) -> dict[str, Any]:
    d: dict[str, Any] = {"type": t}
    if desc:
        d["description"] = desc
    d.update(kw)
    return d


def _fn(name: str, desc: str, props: Optional[dict[str, Any]] = None, required: Optional[list[str]] = None) -> types.FunctionDeclaration:
    schema: dict[str, Any] = {"type": "object", "properties": props or {}}
    if required:
        schema["required"] = required
    return types.FunctionDeclaration(name=name, description=desc, parameters_json_schema=schema)


def _doc(fn) -> str:
    return " ".join((fn.__doc__ or "").split("Args:")[0].split())


DECLS = [
    _fn("get_project_status", _doc(A.get_project_status)),
    _fn("go_to_step", _doc(A.go_to_step), {"step": _s("string")}, ["step"]),
    _fn("start_brief", _doc(A.start_brief), {"description": _s("string"), "city": _s("string"), "pincode": _s("string")}, ["description"]),
    _fn("set_requirement", _doc(A.set_requirement) + " kind is 'must' or 'flexible'; attribute e.g. width_cm, depth_cm, material, "
        "features; op one of <=, >=, ==, in, not_in, has.",
        {"requirement_id": _s("string"), "label": _s("string"), "kind": _s("string"), "attribute": _s("string"), "op": _s("string"),
         "value_num": _s("number"), "value_list": _s("array", items={"type": "string"}), "unit": _s("string")},
        ["requirement_id", "label", "kind"]),
    _fn("remove_requirement", _doc(A.remove_requirement), {"requirement_id": _s("string")}, ["requirement_id"]),
    _fn("set_budget", _doc(A.set_budget), {"target_inr": _s("integer"), "limit_inr": _s("integer")}),
    _fn("set_delivery", _doc(A.set_delivery), {"city": _s("string"), "pincode": _s("string"), "deadline": _s("string")}),
    _fn("rename_project", _doc(A.rename_project), {"title": _s("string")}, ["title"]),
    _fn("answer_open_question", _doc(A.answer_open_question), {"unknown_id": _s("string"), "answer": _s("string"), "dont_know": _s("boolean")},
        ["unknown_id"]),
    _fn("add_note", _doc(A.add_note), {"text": _s("string")}, ["text"]),
    _fn("confirm_brief", _doc(A.confirm_brief)),
    _fn("create_concept", _doc(A.create_concept), {"instruction": _s("string")}, ["instruction"]),
    _fn("find_options", _doc(A.find_options)),
    _fn("show_look", _doc(A.show_look), {"names": _s("array", items={"type": "string"})}),
    _fn("add_to_picks", _doc(A.add_to_picks), {"names": _s("array", items={"type": "string"})}, ["names"]),
    _fn("place_order", _doc(A.place_order), {"confirmed": _s("boolean"), "acknowledge_checks": _s("boolean")}, ["confirmed"]),
    _fn("draft_messages", _doc(A.draft_messages), {"names": _s("array", items={"type": "string"})}),
    _fn("send_messages", _doc(A.send_messages), {"confirmed": _s("boolean")}, ["confirmed"]),
    _fn("check_replies", _doc(A.check_replies)),
    _fn("remember_preference", _doc(A.remember_preference), {"preference": _s("string")}, ["preference"]),
]
FUNCS = {f.__name__: f for f in A.TOOLS}

LIVE_RULES = """
You are speaking live, by voice. Keep every turn to one or two short sentences and sound natural and warm.
Act instead of explaining: when the customer says what they want, call the tool straight away.
Slow tools (writing the brief, searching, drawing, messaging, ordering) start in the background: say
in a few words that you've started and that it shows on screen; you'll get an update to speak when done.
Before sending messages, calling businesses or placing an order, say exactly what will happen and wait
for a clear yes. Never read out ids, URLs or long lists - name at most three things.
"""


class _Ctx:
    """Stands in for ADK's ToolContext: the assistant tools only read state from it."""

    def __init__(self, pid: str, owner: str, screen: str):
        self.state = {"project_id": pid, "owner": owner, "screen": screen}


async def _recall(owner: str) -> list[str]:
    try:
        res = await asyncio.wait_for(A.memory_service().search_memory(app_name=A.APP_NAME, user_id=owner, query="customer preferences"), 5)
        out = []
        for m in res.memories[:6]:
            for p in (m.content.parts or []):
                if p.text:
                    out.append(p.text[:200])
        return out
    except Exception as e:
        log.info("memory recall skipped: %s", e)
        return []


def _brief_line(status: dict[str, Any]) -> str:
    b = status.get("brief")
    if not b:
        return "No brief yet - the project is empty."
    musts = [r["label"] for r in b["requirements"] if r["kind"] == "must"]
    return (f"Brief v{b['version']} ({'confirmed' if b['confirmed'] else 'draft'}): {b['title']}. Must-haves: {'; '.join(musts) or 'none'}. "
            f"Budget: {b['budget']}. Delivery: {b['delivery']}.")


async def handle(ws: WebSocket, pid: str, stage: str, owner_ok: bool, public_base: str) -> None:
    """Runs one voice session on an accepted WebSocket."""
    project = await store.get_project(pid)
    if project is None:
        await ws.send_json({"type": "error", "message": "Project not found."})
        await ws.close()
        return
    owner = project["owner"]
    view = {"stage": stage or project.get("stage") or "inspire"}
    status = await A.get_project_status(_Ctx(pid, owner, view["stage"]))
    memories = await _recall(owner)
    nd = status["next_step"]
    system = (A.INSTRUCTION + LIVE_RULES +
              f"\nProject: {status['project_title']}. {_brief_line(status)}\nNext step: {nd.get('title')} - {nd.get('detail')}\n"
              f"The customer has the '{view['stage']}' screen open.\n"
              + ("Remembered about this customer (mention only when relevant):\n- " + "\n- ".join(memories) if memories else ""))
    cfg = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE))),
        system_instruction=types.Content(parts=[types.Part(text=system)]),
        tools=[types.Tool(function_declarations=DECLS)],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        context_window_compression=types.ContextWindowCompressionConfig(sliding_window=types.SlidingWindow()),
    )
    A.OWNER_OK.set(owner_ok)
    A.PUBLIC_BASE.set(public_base)
    background: set[asyncio.Task] = set()
    closed = asyncio.Event()

    async def send(obj: dict[str, Any]) -> None:
        if not closed.is_set():
            try:
                await ws.send_json(obj)
            except Exception:
                closed.set()

    try:
        async with live_client().aio.live.connect(model=LIVE_MODEL, config=cfg) as session:
            await send({"type": "ready", "model": LIVE_MODEL})
            await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=(
                "(The customer just opened voice mode. Greet them in one short sentence and offer the next step.)"))]), turn_complete=True)

            async def run_tool(fc: types.FunctionCall) -> dict[str, Any]:
                fn = FUNCS.get(fc.name)
                if fn is None:
                    return {"ok": False, "error": "Unknown tool."}
                args = dict(fc.args or {})
                await send({"type": "tool", "name": fc.name, "label": A.TOOL_LABELS.get(fc.name, fc.name)})
                await services.set_live(pid, "Voice agent", "Voice agent", A.TOOL_LABELS.get(fc.name, fc.name))
                try:
                    result = await fn(tool_context=_Ctx(pid, owner, view["stage"]), **args)
                except TypeError as e:
                    result = {"ok": False, "error": f"Bad arguments: {e}"}
                except services.ServiceError as e:
                    result = {"ok": False, "error": str(e), "details": e.details}
                except Exception as e:
                    log.exception("live tool %s failed", fc.name)
                    result = {"ok": False, "error": f"{type(e).__name__}"}
                finally:
                    await services.set_live(pid, None)
                nav = result.get("navigate") if isinstance(result, dict) else None
                if nav:
                    view["stage"] = nav if nav != "back" else view["stage"]
                    await send({"type": "navigate", "stage": nav})
                await send({"type": "state"})
                return result

            async def slow(fc: types.FunctionCall) -> None:
                result = await run_tool(fc)
                summary = json.dumps(result, ensure_ascii=False, default=str)[:1500]
                try:
                    await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=(
                        f"(Update: '{fc.name}' finished: {summary}. Tell the customer the result in one or two short sentences "
                        "and offer the next step.)"))]), turn_complete=True)
                except Exception as e:
                    log.info("could not deliver tool result: %s", e)

            async def upstream() -> None:
                while not closed.is_set():
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        break
                    if msg.get("bytes"):
                        await session.send_realtime_input(audio=types.Blob(data=msg["bytes"], mime_type="audio/pcm;rate=16000"))
                    elif msg.get("text"):
                        data = json.loads(msg["text"])
                        if data.get("type") == "view" and data.get("stage"):
                            view["stage"] = data["stage"]
                        elif data.get("type") == "text" and data.get("text"):
                            await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=data["text"][:2000])]),
                                                              turn_complete=True)
                        elif data.get("type") == "end":
                            break
                closed.set()

            async def downstream() -> None:
                while not closed.is_set():
                    async for msg in session.receive():
                        sc = msg.server_content
                        if sc:
                            if sc.model_turn:
                                for p in sc.model_turn.parts or []:
                                    if p.inline_data and p.inline_data.data and not closed.is_set():
                                        await ws.send_bytes(p.inline_data.data)
                            if sc.input_transcription and sc.input_transcription.text:
                                await send({"type": "heard", "text": sc.input_transcription.text})
                            if sc.output_transcription and sc.output_transcription.text:
                                await send({"type": "said", "text": sc.output_transcription.text})
                            if sc.interrupted:
                                await send({"type": "interrupted"})
                            if sc.turn_complete:
                                await send({"type": "turn"})
                        if msg.tool_call:
                            responses = []
                            for fc in msg.tool_call.function_calls or []:
                                if fc.name in SLOW:
                                    t = asyncio.create_task(slow(fc))
                                    background.add(t)
                                    t.add_done_callback(background.discard)
                                    responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={
                                        "ok": True, "status": "started in the background - it shows on screen; you'll get an update"}))
                                else:
                                    responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=await run_tool(fc)))
                            await session.send_tool_response(function_responses=responses)
                        if msg.go_away:
                            await send({"type": "reconnect"})
                    if closed.is_set():
                        break

            up = asyncio.create_task(upstream())
            down = asyncio.create_task(downstream())
            done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
            closed.set()
            for t in pending:
                t.cancel()
            for t in done:
                if t.exception() and not isinstance(t.exception(), (WebSocketDisconnect, asyncio.CancelledError)):
                    log.warning("live session ended: %r", t.exception())
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("live session failed")
        await send({"type": "error", "message": f"Voice is unavailable right now ({type(e).__name__}). Try again, or type instead."})
    finally:
        closed.set()
        # Background work (e.g. a search the customer asked for) keeps going and saves to the project.
        try:
            await ws.close()
        except Exception:
            pass
