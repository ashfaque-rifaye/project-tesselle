"""Real-time voice agent: browser microphone (and camera) <-> Gemini Live (native audio) on Vertex AI.

The browser streams 16 kHz PCM over a WebSocket to Cloud Run; this module relays it to a Gemini Live
session and streams the spoken answer (24 kHz PCM) back, with live captions of both sides. The voice
agent has the same tools as the chat assistant (app.agents.assistant), so it can fill in the brief, run
searches, add picks and open steps while it talks. Tools that take a while run in the background: the
agent says it has started, the screen shows progress, and it speaks the result when it's ready.

* Patient turn-taking: voice activity detection waits for a real pause (about 1.6 s by default) and
  ignores short hesitations, so the customer can finish a thought before Tesselle answers.
* Continuity: Live session resumption handles are saved on the project, and every turn is saved
  (app.voicelog), so turning voice off and on - or moving to another device - continues the same
  conversation instead of starting over.
* Vision: in glasses or camera mode the browser also sends about one JPEG frame a second; Gemini sees
  what the customer sees and can save the current view as a photo of their space or an inspiration.
* Sending, calling and ordering still need the customer's spoken "yes".
"""

from __future__ import annotations

import asyncio
import base64
import functools
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

from . import config, identity, services, store, voicelog
from .agents import assistant as A
from .models import now_iso

log = logging.getLogger(__name__)

LIVE_MODEL = os.environ.get("TESSELLE_LIVE_MODEL", "gemini-live-2.5-flash-native-audio")
LIVE_LOCATION = os.environ.get("TESSELLE_LIVE_LOCATION", "us-central1")
VOICE = os.environ.get("TESSELLE_LIVE_VOICE", "Aoede")
SILENCE_MS = int(os.environ.get("TESSELLE_LIVE_SILENCE_MS", "1600"))
SLOW = {"start_brief", "create_concept", "find_options", "show_look", "draft_messages", "send_messages", "check_replies", "place_order",
        "save_camera_view"}
RESUME_WINDOW_S = 100 * 60


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
        "size, compatible_with, quantity, features; op one of <=, >=, ==, in, not_in, has.",
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
    _fn("ask_for_photo", _doc(A.ask_for_photo), {"kind": _s("string", enum=["space", "inspiration", "item", "person", "receipt"]),
                                                 "what": _s("string")}, ["kind", "what"]),
    _fn("save_camera_view", "Saves what the customer's camera or glasses show right now as a photo for the project (kind: "
        "space, inspiration or item) and reads it into the brief. Only when the camera is on.",
        {"kind": _s("string", enum=["space", "inspiration", "item"]), "note": _s("string")}, ["kind"]),
    _fn("choose_path", _doc(A.choose_path), {"path": _s("string", enum=["buy", "make", "either", "source"])}, ["path"]),
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
Let the customer finish. If what they said sounds unfinished (they trail off, or end on "and", "also", "so"),
stay quiet and keep listening. When they have finished, act: call the tool straight away instead of explaining.
Slow tools (writing the brief, searching, drawing, messaging, ordering) start in the background: say in a few
words that you've started; you'll get an update to speak when done.
Before sending messages, calling businesses or placing an order, say exactly what will happen and wait for a
clear yes. Never read out ids, URLs or long lists - name at most three things.
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
            f"Budget: {b['budget']}. Delivery: {b['delivery']}. Open questions: {b.get('open_questions') or 'none'}.")


def _fresh_handle(project: dict[str, Any]) -> Optional[str]:
    ls = project.get("live_session") or {}
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(ls["at"])).total_seconds()
    except Exception:
        return None
    return ls.get("handle") if age < RESUME_WINDOW_S else None


def _config(system: str, handle: Optional[str]) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE))),
        system_instruction=types.Content(parts=[types.Part(text=system)]),
        tools=[types.Tool(function_declarations=DECLS)],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        context_window_compression=types.ContextWindowCompressionConfig(sliding_window=types.SlidingWindow()),
        session_resumption=types.SessionResumptionConfig(handle=handle),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_LOW,
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                prefix_padding_ms=300,
                silence_duration_ms=SILENCE_MS,
            ),
        ),
    )


async def handle(ws: WebSocket, pid: str, stage: str, owner_ok: bool, public_base: str, camera: bool = False) -> None:
    """Runs one voice session on an accepted WebSocket."""
    project = await store.get_project(pid)
    if project is None:
        await ws.send_json({"type": "error", "message": "Project not found."})
        await ws.close()
        return
    owner = project["owner"]
    view = {"stage": stage or project.get("stage") or "inspire"}
    status, memories, history = await asyncio.gather(A.get_project_status(_Ctx(pid, owner, view["stage"])), _recall(owner), voicelog.recent(pid))
    nd = status["next_step"]
    layout = project.get("layout") or {}
    system = (A.INSTRUCTION + LIVE_RULES + services.today_line() + "\n" +
              f"\nProject: {status['project_title']}. {_brief_line(status)}\nNext step: {nd.get('title')} - {nd.get('detail')}\n"
              + (f"Kind of purchase: {layout.get('kind_label')}; likely path: {layout.get('route')}"
                 + (f"; a photo would help: {layout.get('photo_prompt')}" if layout.get("photo_helps") else "") + ".\n" if layout else "")
              + f"The customer has the '{view['stage']}' screen open.\n"
              + ("The customer's camera (phone or glasses) is on: you see what they see, about one frame a second.\n" if camera else "")
              + ("Remembered about this customer (mention only when relevant):\n- " + "\n- ".join(memories) + "\n" if memories else "")
              + ("\nThe conversation so far in this project (continue it - do not greet again or start over):\n"
                 + voicelog.as_context(history) if history else ""))
    handle_id = _fresh_handle(project)
    A.OWNER_OK.set(owner_ok)
    A.PUBLIC_BASE.set(public_base)
    background: set[asyncio.Task] = set()
    closed = asyncio.Event()
    session_tag = store.new_id("ls")
    last_frame: dict[str, Optional[bytes]] = {"jpeg": None}
    # Turn recording for replay: microphone audio since the last saved user turn, Tesselle's audio this turn.
    rec = {"u": bytearray(), "u_text": "", "a": bytearray(), "a_text": ""}

    async def send(obj: dict[str, Any]) -> None:
        if not closed.is_set():
            try:
                await ws.send_json(obj)
            except Exception:
                closed.set()

    def keep(coro) -> None:
        t = asyncio.create_task(coro)
        background.add(t)
        t.add_done_callback(background.discard)

    def flush_user() -> None:
        if rec["u_text"].strip():
            keep(voicelog.save_turn(pid, "you", rec["u_text"], bytes(rec["u"]), 16000, session_tag))
        rec["u"], rec["u_text"] = bytearray(), ""

    def flush_agent() -> None:
        if rec["a_text"].strip() or len(rec["a"]) > 24000:
            keep(voicelog.save_turn(pid, "agent", rec["a_text"], bytes(rec["a"]), 24000, session_tag))
        rec["a"], rec["a_text"] = bytearray(), ""

    async def connect(h: Optional[str]):
        return live_client().aio.live.connect(model=LIVE_MODEL, config=_config(system, h))

    try:
        cm = await connect(handle_id)
        try:
            session = await cm.__aenter__()
        except Exception as e:
            if not handle_id:
                raise
            log.info("live resume failed (%s) - starting fresh with the saved conversation", type(e).__name__)
            handle_id = None
            cm = await connect(None)
            session = await cm.__aenter__()
        try:
            await send({"type": "ready", "model": LIVE_MODEL, "resumed": bool(handle_id or history)})
            if handle_id or history:
                nudge = ("(The customer turned voice back on. In one short sentence, pick up exactly where you left off - what was "
                         "last done and the next step. Don't greet them from the start.)")
            else:
                nudge = "(The customer just opened voice mode. Greet them in one short sentence and ask what they're looking for.)"
            await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=nudge)]), turn_complete=True)

            async def save_view(kind: str, note: str = "") -> dict[str, Any]:
                if not last_frame["jpeg"]:
                    return {"ok": False, "error": "The camera isn't on. Ask the customer to turn on the camera or use ask_for_photo."}
                try:
                    return await services.add_photo(pid, (last_frame["jpeg"], "image/jpeg"), kind=kind, note=note, source="voice camera")
                except services.ServiceError as e:
                    return {"ok": False, "error": str(e)}

            async def run_tool(fc: types.FunctionCall) -> dict[str, Any]:
                args = dict(fc.args or {})
                label = A.TOOL_LABELS.get(fc.name, fc.name)
                await send({"type": "tool", "name": fc.name, "label": label})
                await services.set_live(pid, "Voice agent", "Voice agent", label)
                try:
                    if fc.name == "save_camera_view":
                        result = await save_view(str(args.get("kind") or "space"), str(args.get("note") or ""))
                    else:
                        fn = FUNCS.get(fc.name)
                        if fn is None:
                            return {"ok": False, "error": "Unknown tool."}
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
                if isinstance(result, dict):
                    if result.get("capture"):
                        await send({"type": "capture", "kind": result["capture"], "what": result.get("what") or ""})
                    nav = result.get("navigate")
                    if nav:
                        if nav != "back":
                            view["stage"] = nav
                        await send({"type": "navigate", "stage": nav, "tool": fc.name})
                await send({"type": "state", "name": fc.name, "ok": not (isinstance(result, dict) and result.get("ok") is False)})
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
                        rec["u"].extend(msg["bytes"])
                        if len(rec["u"]) > 16000 * 2 * 90:
                            del rec["u"][: len(rec["u"]) - 16000 * 2 * 90]
                        await session.send_realtime_input(audio=types.Blob(data=msg["bytes"], mime_type="audio/pcm;rate=16000"))
                    elif msg.get("text"):
                        data = json.loads(msg["text"])
                        kind = data.get("type")
                        if kind == "view" and data.get("stage"):
                            view["stage"] = data["stage"]
                        elif kind == "frame" and data.get("jpeg"):
                            jpeg = base64.b64decode(data["jpeg"])[:600_000]
                            last_frame["jpeg"] = jpeg
                            await session.send_realtime_input(video=types.Blob(data=jpeg, mime_type="image/jpeg"))
                        elif kind == "text" and data.get("text"):
                            text = data["text"][:2000]
                            if not data.get("system"):
                                keep(voicelog.save_turn(pid, "you", text, b"", 16000, session_tag))
                            await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=text)]),
                                                              turn_complete=True)
                        elif kind == "end":
                            break
                closed.set()

            async def downstream() -> None:
                while not closed.is_set():
                    async for msg in session.receive():
                        sc = msg.server_content
                        if sc:
                            if sc.input_transcription and sc.input_transcription.text:
                                rec["u_text"] += sc.input_transcription.text
                                await send({"type": "heard", "text": sc.input_transcription.text})
                            if sc.model_turn:
                                for p in sc.model_turn.parts or []:
                                    if p.inline_data and p.inline_data.data and not closed.is_set():
                                        if rec["u_text"]:
                                            flush_user()
                                        rec["a"].extend(p.inline_data.data)
                                        await ws.send_bytes(p.inline_data.data)
                            if sc.output_transcription and sc.output_transcription.text:
                                if rec["u_text"]:
                                    flush_user()
                                rec["a_text"] += sc.output_transcription.text
                                await send({"type": "said", "text": sc.output_transcription.text})
                            if sc.interrupted:
                                flush_agent()
                                await send({"type": "interrupted"})
                            if sc.turn_complete:
                                flush_agent()
                                await send({"type": "turn"})
                        sru = msg.session_resumption_update
                        if sru and sru.resumable and sru.new_handle:
                            keep(store.set_fields(pid, live_session={"handle": sru.new_handle, "at": now_iso()}))
                        if msg.tool_call:
                            responses = []
                            for fc in msg.tool_call.function_calls or []:
                                if fc.name in SLOW:
                                    keep(slow(fc))
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
        finally:
            flush_user()
            flush_agent()
            try:
                await cm.__aexit__(None, None, None)
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("live session failed")
        await send({"type": "error", "message": f"Voice is unavailable right now ({type(e).__name__}). Try again, or type instead."})
    finally:
        closed.set()
        # Background work (a search the customer asked for, saving the last turns) keeps going and saves to the project.
        if background:
            await asyncio.wait(set(background), timeout=20)
        try:
            await ws.close()
        except Exception:
            pass
