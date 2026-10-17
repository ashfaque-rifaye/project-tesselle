"""Real-time AI phone calls: Twilio Media Streams <-> Gemini Live (native audio).

When a call connects, Twilio streams the caller's audio (8 kHz mu-law) over a WebSocket to Cloud Run.
This module decodes it, upsamples to 16 kHz and relays it to a Gemini Live session playing Tesselle's
call agent; the spoken answer (24 kHz PCM) is downsampled and encoded back to mu-law for the phone. The
conversation is natural and interruptible - no "press a key" turns. Both sides are transcribed into
the project as the call happens; when it ends, the reply reader turns the transcript into a quote that
the fit checker verifies like any other reply. The agent says it is an AI calling for a customer and
never shares the customer's details.
"""

from __future__ import annotations

import array
import asyncio
import base64
import json
import logging
import time
from typing import Any, Optional

from fastapi import WebSocket, WebSocketDisconnect
from google.genai import types

from . import services, store
from .live import LIVE_MODEL, live_client
from .models import now_iso

log = logging.getLogger(__name__)
CALL_VOICE = "Kore"
MAX_SECONDS = 300

# ---- G.711 mu-law <-> 16-bit PCM (pure Python tables; no audioop in Python 3.13) ----------------
_BIAS, _CLIP = 0x84, 32635
_EXP = [0, 0, 1, 1] + [2] * 4 + [3] * 8 + [4] * 16 + [5] * 32 + [6] * 64 + [7] * 128


def _ulaw_enc(s: int) -> int:
    sign = 0x80 if s < 0 else 0
    s = min(-s if s < 0 else s, _CLIP) + _BIAS
    e = _EXP[(s >> 7) & 0xFF]
    m = (s >> (e + 3)) & 0x0F
    return ~(sign | (e << 4) | m) & 0xFF


def _ulaw_dec(u: int) -> int:
    u = ~u & 0xFF
    e, m = (u >> 4) & 7, u & 0x0F
    s = (((m << 3) + _BIAS) << e) - _BIAS
    return -s if u & 0x80 else s


_DEC = [_ulaw_dec(i) for i in range(256)]
_ENC = bytes(_ulaw_enc(i - 65536 if i >= 32768 else i) for i in range(65536))


def ulaw8k_to_pcm16k(data: bytes) -> bytes:
    """Phone audio to Gemini's input: decode and upsample 2x (linear)."""
    out = array.array("h")
    prev = _DEC[data[0]] if data else 0
    for b in data:
        cur = _DEC[b]
        out.append((prev + cur) // 2)
        out.append(cur)
        prev = cur
    return out.tobytes()


def pcm24k_to_ulaw8k(data: bytes, carry: list[int]) -> bytes:
    """Gemini's voice to the phone: average every 3 samples (24 kHz -> 8 kHz) and encode."""
    a = array.array("h")
    a.frombytes(data[: len(data) // 2 * 2])
    samples = carry + a.tolist()
    n = len(samples) // 3 * 3
    carry[:] = samples[n:]
    return bytes(_ENC[((samples[i] + samples[i + 1] + samples[i + 2]) // 3) & 0xFFFF] for i in range(0, n, 3))


def twiml_stream(ws_url: str, token: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?><Response><Connect>'
            f'<Stream url="{ws_url}"><Parameter name="token" value="{token}"/></Stream>'
            '</Connect><Hangup/></Response>')


END_CALL = types.FunctionDeclaration(
    name="end_call", description="Ends the call after you have said a short goodbye.",
    parameters_json_schema={"type": "object", "properties": {"reason": {"type": "string"}}})


async def handle(ws: WebSocket, cid: str) -> None:
    """One phone call. Twilio sends 'connected', 'start' (with our token), 'media' frames and 'stop'."""
    sid: Optional[str] = None
    pid: Optional[str] = None
    call: dict[str, Any] = {}
    closed = asyncio.Event()
    ending = asyncio.Event()
    carry: list[int] = []
    pending_save = {"t": 0.0}

    async def save(final: bool = False) -> None:
        if pid and call and (final or time.time() - pending_save["t"] > 3):
            pending_save["t"] = time.time()
            await store.put(pid, "calls", cid, call)

    try:
        # Wait for the start event and check the per-call token.
        while sid is None:
            msg = json.loads(await asyncio.wait_for(ws.receive_text(), 15))
            if msg.get("event") == "start":
                sid = msg["start"]["streamSid"]
                token = (msg["start"].get("customParameters") or {}).get("token", "")
                idx = await store.db().collection("call_index").document(cid).get()
                pid = idx.to_dict().get("pid") if idx.exists else None
                call = (await store.get(pid, "calls", cid) if pid else None) or {}
                if not call or not token or token != call.get("stream_token"):
                    log.warning("call stream rejected for %s", cid)
                    await ws.close()
                    return
        call_ctx, brief = await services.call_context(pid, cid)
        city = services._city(brief) or "India"
        opening = (f"Hello! I'm Tesselle, an AI assistant calling on behalf of a customer in {city}. They'd like a quote for "
                   f"{brief.title.lower()}. Is this a good time for a few quick questions?")
        system = (services.CALL_RULES + "\nYou are on a live phone call; keep each turn to one or two short sentences and let them "
                  "finish speaking. When every question is answered, or they are busy, say a short thank-you and goodbye, then call "
                  "end_call.\nBrief:\n" + brief.model_dump_json(include={"title", "purpose", "requirements", "budget", "delivery"})
                  + f"\nYour first words are exactly: \"{opening}\"")
        cfg = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=CALL_VOICE))),
            system_instruction=types.Content(parts=[types.Part(text=system)]),
            tools=[types.Tool(function_declarations=[END_CALL])],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(automatic_activity_detection=types.AutomaticActivityDetection(
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW, silence_duration_ms=900)),
        )
        call.update(status="in_progress", stream="live", started_at=now_iso(), mode="realtime")
        await save(True)
        await services.set_live(pid, "Call agent", "Call agent", f"On the phone with {call.get('name', 'the business')}")

        async with live_client().aio.live.connect(model=LIVE_MODEL, config=cfg) as session:
            await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=(
                "(The business just picked up the phone. Say your first words now.)"))]), turn_complete=True)
            started = time.time()

            def line(who: str, text: str) -> None:
                t = call.setdefault("transcript", [])
                if t and t[-1]["who"] == who and not t[-1].get("closed"):
                    t[-1]["text"] = (t[-1]["text"] + text)[:1200]
                else:
                    t.append({"who": who, "text": text.strip()})

            async def from_phone() -> None:
                while not closed.is_set():
                    msg = json.loads(await ws.receive_text())
                    ev = msg.get("event")
                    if ev == "media":
                        pcm = ulaw8k_to_pcm16k(base64.b64decode(msg["media"]["payload"]))
                        await session.send_realtime_input(audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000"))
                    elif ev == "mark" and (msg.get("mark") or {}).get("name") == "bye":
                        break
                    elif ev == "stop":
                        break
                    if time.time() - started > MAX_SECONDS and not ending.is_set():
                        ending.set()
                        await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=(
                            "(Time is up: thank them, say goodbye and call end_call.)"))]), turn_complete=True)
                closed.set()

            async def to_phone() -> None:
                while not closed.is_set():
                    async for msg in session.receive():
                        sc = msg.server_content
                        if sc:
                            if sc.model_turn:
                                for p in sc.model_turn.parts or []:
                                    if p.inline_data and p.inline_data.data:
                                        ulaw = pcm24k_to_ulaw8k(p.inline_data.data, carry)
                                        if ulaw:
                                            await ws.send_text(json.dumps({"event": "media", "streamSid": sid,
                                                                           "media": {"payload": base64.b64encode(ulaw).decode()}}))
                            if sc.input_transcription and sc.input_transcription.text:
                                line("them", sc.input_transcription.text)
                            if sc.output_transcription and sc.output_transcription.text:
                                line("agent", sc.output_transcription.text)
                            if sc.interrupted:
                                await ws.send_text(json.dumps({"event": "clear", "streamSid": sid}))
                            if sc.turn_complete:
                                if call.get("transcript"):
                                    call["transcript"][-1]["closed"] = True
                                await save()
                                if ending.is_set():
                                    # Hang up once the goodbye has played on the phone.
                                    await ws.send_text(json.dumps({"event": "mark", "streamSid": sid, "mark": {"name": "bye"}}))
                        if msg.tool_call:
                            for fc in msg.tool_call.function_calls or []:
                                if fc.name == "end_call":
                                    ending.set()
                                    call["end_reason"] = (fc.args or {}).get("reason")
                            await session.send_tool_response(function_responses=[
                                types.FunctionResponse(id=fc.id, name=fc.name, response={"ok": True}) for fc in msg.tool_call.function_calls or []])
                    if closed.is_set():
                        break

            up = asyncio.create_task(from_phone())
            down = asyncio.create_task(to_phone())
            await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
            closed.set()
            for t in (up, down):
                t.cancel()
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    except Exception:
        log.exception("call stream failed")
    finally:
        closed.set()
        if pid and call:
            for t in call.get("transcript") or []:
                t.pop("closed", None)
            call["stream"] = "done"
            await save(True)
            await services.set_live(pid, None)
            try:
                await services.finish_call(pid, cid, "completed")
            except Exception:
                log.exception("finishing call failed")
        try:
            await ws.close()
        except Exception:
            pass
