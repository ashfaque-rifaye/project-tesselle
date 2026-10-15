"""Shared ADK plumbing: the Vertex-backed Gemini model, labelled generation configs, and helpers to
run one-shot specialist agents (in-memory sessions) or the persistent MissionLock concierge
(Agent Platform Sessions + Memory Bank)."""

from __future__ import annotations

import functools
import time
from typing import Any, Optional

from google.adk.agents import LlmAgent
from google.adk.models.google_llm import Gemini
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from .. import config, gemini


def model() -> Gemini:
    # Pass our own Vertex client so ADK can never fall back to an AI Studio key.
    return Gemini(model=config.MODEL_REASONING, client=gemini.client())


def gen_config(purpose: str, thinking: str = "low", temperature: Optional[float] = None) -> types.GenerateContentConfig:
    return types.GenerateContentConfig(
        labels=gemini.labels(purpose),
        thinking_config=types.ThinkingConfig(thinking_level=thinking),
        temperature=temperature,
    )


@functools.lru_cache(maxsize=1)
def _scratch_sessions() -> InMemorySessionService:
    return InMemorySessionService()


def _usage_from_event(ev: Any) -> tuple[int, int, int]:
    u = getattr(ev, "usage_metadata", None)
    if not u:
        return 0, 0, 0
    return (u.prompt_token_count or 0, u.candidates_token_count or 0, u.thoughts_token_count or 0)


async def run_specialist(
    agent: LlmAgent,
    parts: list[types.Part | str],
    *,
    state: Optional[dict[str, Any]] = None,
    purpose: Optional[str] = None,
) -> tuple[Any, dict[str, Any]]:
    """Run a single-turn ADK specialist agent and return (output, stats).

    The agent must declare `output_key`; with an `output_schema` the output is a dict.
    """
    gemini._guard("llm")
    sessions = _scratch_sessions()
    runner = Runner(app_name="tesselle-specialists", agent=agent, session_service=sessions)
    session = await sessions.create_session(app_name="tesselle-specialists", user_id="system", state=state or {})
    content = types.Content(
        role="user", parts=[types.Part(text=p) if isinstance(p, str) else p for p in parts]
    )
    started = time.perf_counter()
    p_tok = o_tok = t_tok = 0
    async for ev in runner.run_async(user_id="system", session_id=session.id, new_message=content):
        a, b, c = _usage_from_event(ev)
        p_tok, o_tok, t_tok = p_tok + a, o_tok + b, t_tok + c
    final = await sessions.get_session(app_name="tesselle-specialists", user_id="system", session_id=session.id)
    await sessions.delete_session(app_name="tesselle-specialists", user_id="system", session_id=session.id)
    output = final.state.get(agent.output_key) if final else None
    stats = {
        "agent": agent.name,
        "model": config.MODEL_REASONING,
        "purpose": purpose or agent.name,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "prompt_tokens": p_tok,
        "output_tokens": o_tok,
        "thought_tokens": t_tok,
        "framework": "ADK LlmAgent",
    }
    if output is None:
        raise RuntimeError(f"Agent {agent.name} produced no output.")
    return output, stats
