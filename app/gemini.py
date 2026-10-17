"""Single entry point to Gemini on Vertex AI.

Every model call in Project Tesselle goes through this module so that:
  * the client is always the Vertex AI backend (aiplatform.googleapis.com), never AI Studio;
  * every request carries billing labels (app=tesselle, purpose=<agent>);
  * a daily cost guard bounds usage during the public judging window;
  * latency and token usage are reported back for the in-app agent trace.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import io
import logging
import time
import wave
from dataclasses import dataclass, field
from typing import Any, TypeVar

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

from . import config, identity

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)


IMAGE_FALLBACKS = ["gemini-3.1-flash-image", "gemini-nano-banana-2.1", "gemini-3-pro-image"]


class BudgetExceeded(RuntimeError):
    """Raised when the daily cost guard refuses a model call."""


@functools.lru_cache(maxsize=1)
def client() -> genai.Client:
    c = genai.Client(
        vertexai=True,
        project=config.PROJECT,
        location=config.GEMINI_LOCATION,
        credentials=identity.credentials(),
        http_options=types.HttpOptions(
            # A request that sits in a capacity queue for minutes is worse than a fast, retried failure.
            timeout=90_000,
            retry_options=types.HttpRetryOptions(
                attempts=4, initial_delay=2.0, max_delay=20.0, http_status_codes=[429, 500, 503, 504]
            )
        ),
    )
    api = c._api_client
    base_url = (api._http_options.base_url or "") if api._http_options else ""
    if not api.vertexai or "aiplatform.googleapis.com" not in base_url:
        raise RuntimeError(f"Gemini client is not on Vertex AI (base_url={base_url!r}); refusing to start.")
    return c


@functools.lru_cache(maxsize=1)
def fast_client() -> genai.Client:
    """Regional Vertex client for the fast model (same identity, same billing)."""
    return genai.Client(
        vertexai=True,
        project=config.PROJECT,
        location=config.FAST_LOCATION,
        credentials=identity.credentials(),
        http_options=types.HttpOptions(
            timeout=60_000,
            retry_options=types.HttpRetryOptions(attempts=3, initial_delay=1.0, max_delay=8.0, http_status_codes=[429, 500, 503, 504]),
        ),
    )


def fast_thinking() -> types.ThinkingConfig:
    return types.ThinkingConfig(thinking_budget=0)


def labels(purpose: str) -> dict[str, str]:
    return {"app": "tesselle", "purpose": purpose.replace("_", "-")[:63]}


@dataclass
class CallStats:
    """What one model call cost, surfaced in the evidence/trace panel."""

    model: str
    purpose: str
    latency_ms: int = 0
    prompt_tokens: int = 0
    output_tokens: int = 0
    thought_tokens: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "purpose": self.purpose,
            "latency_ms": self.latency_ms,
            "prompt_tokens": self.prompt_tokens,
            "output_tokens": self.output_tokens,
            "thought_tokens": self.thought_tokens,
            **self.extra,
        }


def _stats(model: str, purpose: str, started: float, usage: Any) -> CallStats:
    s = CallStats(model=model, purpose=purpose, latency_ms=int((time.perf_counter() - started) * 1000))
    if usage is not None:
        s.prompt_tokens = usage.prompt_token_count or 0
        s.output_tokens = usage.candidates_token_count or 0
        s.thought_tokens = usage.thoughts_token_count or 0
    return s


# Guard hook (set by store.py so this module stays free of Firestore imports).
_guard_hook = None


def set_guard_hook(fn) -> None:
    global _guard_hook
    _guard_hook = fn


def _guard(kind: str) -> None:
    if _guard_hook is not None:
        _guard_hook(kind)


async def generate_structured(
    schema: type[T],
    contents: Any,
    *,
    purpose: str,
    system: str | None = None,
    thinking: str = "low",
    temperature: float | None = None,
    fast: bool = False,
) -> tuple[T, CallStats]:
    """Gemini call with a Pydantic response schema (controlled generation).

    fast=True uses the fast regional model directly; otherwise the primary model is tried first and
    the fast model takes over if it is slow or rate-limited."""
    _guard("llm")

    async def call(fast_model: bool) -> tuple[T, CallStats]:
        started = time.perf_counter()
        cfg = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_schema=schema,
            labels=labels(purpose),
            thinking_config=fast_thinking() if fast_model else types.ThinkingConfig(thinking_level=thinking),
            temperature=temperature,
        )
        c, m = (fast_client(), config.MODEL_FAST) if fast_model else (client(), config.MODEL_REASONING)
        resp = await c.aio.models.generate_content(model=m, contents=contents, config=cfg)
        parsed = resp.parsed if isinstance(resp.parsed, schema) else schema.model_validate_json(resp.text)
        return parsed, _stats(m, purpose, started, resp.usage_metadata)

    if fast:
        return await call(True)
    primary = asyncio.create_task(call(False))
    done, _ = await asyncio.wait({primary}, timeout=20)
    if done and primary.exception() is None:
        return primary.result()
    log.warning("%s: primary model slow or unavailable - also asking %s", purpose, config.MODEL_FAST)
    backup = asyncio.create_task(call(True))
    pending = {backup} if done else {primary, backup}
    last: BaseException | None = primary.exception() if done else None
    while pending:
        finished, pending = await asyncio.wait(pending, timeout=90, return_when=asyncio.FIRST_COMPLETED)
        if not finished:
            break
        for t in finished:
            if t.exception() is None:
                for other in pending:
                    other.cancel()
                return t.result()
            last = t.exception()
    for t in pending:
        t.cancel()
    raise last or TimeoutError(f"{purpose}: no model answered")


async def generate_text(
    contents: Any, *, purpose: str, system: str | None = None, thinking: str = "low"
) -> tuple[str, CallStats]:
    _guard("llm")
    started = time.perf_counter()
    resp = await client().aio.models.generate_content(
        model=config.MODEL_REASONING,
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction=system,
            labels=labels(purpose),
            thinking_config=types.ThinkingConfig(thinking_level=thinking),
        ),
    )
    return (resp.text or "").strip(), _stats(config.MODEL_REASONING, purpose, started, resp.usage_metadata)


async def generate_image(
    prompt: str,
    *,
    purpose: str,
    reference_images: list[tuple[bytes, str]] | None = None,
    aspect_ratio: str = "4:3",
    image_size: str | None = None,
) -> tuple[bytes, str, CallStats]:
    """Generate or edit an image with Gemini image generation. Returns (bytes, mime, stats)."""
    _guard("image")
    started = time.perf_counter()
    parts: list[Any] = [types.Part.from_bytes(data=b, mime_type=m) for b, m in (reference_images or [])]
    parts.append(prompt)
    last_error: Exception | None = None
    # Primary image model first; on capacity errors fall back to the other first-party Gemini image models.
    for model in [config.MODEL_IMAGE, *[m for m in IMAGE_FALLBACKS if m != config.MODEL_IMAGE]]:
        try:
            resp = await client().aio.models.generate_content(
                model=model,
                contents=parts,
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE"],
                    labels=labels(purpose),
                    image_config=types.ImageConfig(aspect_ratio=aspect_ratio, image_size=image_size),
                ),
            )
        except genai_errors.APIError as e:
            last_error = e
            if e.code in (429, 503):
                log.warning("image model %s busy (%s); trying fallback", model, e.code)
                continue
            raise
        for cand in resp.candidates or []:
            for part in (cand.content.parts if cand.content else []) or []:
                if part.inline_data and part.inline_data.data:
                    stats = _stats(model, purpose, started, resp.usage_metadata)
                    return part.inline_data.data, part.inline_data.mime_type or "image/png", stats
        last_error = RuntimeError("The image model returned no image (it may have declined the request).")
    raise last_error or RuntimeError("No image model available.")


async def embed(texts: list[str], *, purpose: str = "embedding") -> list[list[float]]:
    _guard("llm")

    # gemini-embedding-2 is multimodal: a list of contents is embedded as ONE input, so each text
    # is embedded separately (in parallel) to get one vector per text.
    async def one(text: str) -> list[float]:
        resp = await client().aio.models.embed_content(
            model=config.MODEL_EMBED,
            contents=text,
            config=types.EmbedContentConfig(output_dimensionality=config.EMBED_DIM),
        )
        return list(resp.embeddings[0].values)

    import asyncio

    return list(await asyncio.gather(*(one(t) for t in texts)))


async def speak(text: str, *, purpose: str = "recap-voice", voice: str = "Kore") -> tuple[str, CallStats]:
    """Gemini TTS -> base64 WAV data URL (24 kHz mono PCM wrapped as WAV)."""
    _guard("llm")
    started = time.perf_counter()
    resp = await client().aio.models.generate_content(
        model=config.MODEL_TTS,
        contents=f"Say calmly and clearly, like a helpful assistant: {text}",
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            labels=labels(purpose),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
                )
            ),
        ),
    )
    pcm = resp.candidates[0].content.parts[0].inline_data.data
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)
    url = "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode()
    return url, _stats(config.MODEL_TTS, purpose, started, resp.usage_metadata)
