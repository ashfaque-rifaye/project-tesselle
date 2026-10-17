"""Replayable voice conversations.

The voice agent's WebSocket already carries both sides of the conversation (16 kHz microphone audio up,
24 kHz Gemini voice down). Each turn is saved as a small WAV in the project's private bucket, with a
tidied transcript: filler words ("um", "uh") and stutters removed from the text, long silences cut and
the level evened out in the audio - nothing re-synthesised, it is still the customer's own voice. The
saved turns also let a new voice session pick up exactly where the last one stopped.
"""

from __future__ import annotations

import array
import io
import logging
import math
import re
import wave
from typing import Any, Optional

from . import store
from .models import now_iso

log = logging.getLogger(__name__)

_FILLERS = re.compile(r"(?<![\w'])(?:u+m+|u+h+m*|e+r+m*|h+m+|m{3,}|m+h+m+|a+h+|e+h+)(?![\w'])[,.]?\s*", re.I)
_REPEAT = re.compile(r"\b(\w+)(?:[\s,]+\1\b)+", re.I)


def tidy_text(text: str) -> str:
    t = _FILLERS.sub("", text or "")
    t = _REPEAT.sub(r"\1", t)
    t = re.sub(r"\s+([,.?!])", r"\1", t)
    t = re.sub(r"([,.?!])\1+", r"\1", t)
    t = re.sub(r"\s{2,}", " ", t).strip(" ,")
    return (t[:1].upper() + t[1:]) if t else t


def tidy_pcm(pcm: bytes, rate: int, gate: float = 0.012, keep_ms: int = 260) -> bytes:
    """Cut silences longer than keep_ms, trim both ends and even out the level (at most 4x gain)."""
    a = array.array("h")
    a.frombytes(pcm[: len(pcm) // 2 * 2])
    n = max(1, rate // 50)  # 20 ms frames
    out = array.array("h")
    quiet, started, tail = 0, False, array.array("h")
    keep = max(1, keep_ms // 20)
    for i in range(0, len(a), n):
        f = a[i:i + n]
        level = math.sqrt(sum(x * x for x in f) / len(f)) / 32768 if len(f) else 0
        if level > gate:
            if quiet:
                out.extend(tail)
            tail = array.array("h")
            quiet, started = 0, True
            out.extend(f)
        elif started:
            quiet += 1
            if quiet <= keep:
                tail.extend(f)
    peak = max((abs(x) for x in out), default=0)
    if peak:
        g = min(4.0, 29000 / peak)
        if g > 1.05:
            out = array.array("h", (int(max(-32768, min(32767, x * g))) for x in out))
    return out.tobytes()


def wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


async def save_turn(pid: str, who: str, text: str, pcm: bytes, rate: int, session: str) -> Optional[dict[str, Any]]:
    """Save one turn (who = 'you' or 'agent'). Text-only turns are kept too (typed messages)."""
    clean = tidy_text(text)
    if not clean and len(pcm) < rate:  # under half a second of audio and nothing said
        return None
    tid = store.new_id("vt")
    doc: dict[str, Any] = {"id": tid, "who": who, "text": clean, "raw_text": (text or "").strip()[:2000], "session": session,
                           "created_at": now_iso(), "audio_path": None, "seconds": 0}
    try:
        if pcm:
            audio = tidy_pcm(pcm, rate) if who == "you" else pcm
            if len(audio) >= rate:  # at least half a second
                doc["seconds"] = round(len(audio) / 2 / rate, 1)
                doc["audio_path"] = await store.upload_media(f"projects/{pid}/voice/{tid}.wav", wav(audio, rate), "audio/wav")
        await store.put(pid, "voice", tid, doc)
        return doc
    except Exception as e:  # replay is a nicety; never break the live conversation
        log.info("voice turn not saved: %s", e)
        return None


async def recent(pid: str, n: int = 16) -> list[dict[str, Any]]:
    turns = await store.list_coll(pid, "voice")
    return turns[-n:]


def as_context(turns: list[dict[str, Any]]) -> str:
    lines = [f"{'Customer' if t['who'] == 'you' else 'You'}: {t['text']}" for t in turns if t.get("text")]
    return "\n".join(lines)[-3500:]
