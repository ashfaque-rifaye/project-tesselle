"""Project Tesselle API + web app (Cloud Run).

Long-running agent work streams NDJSON progress lines ({"type": "progress" | "tool" | "text" |
"result" | "error"}) so the UI shows honest progress instead of decorative spinners.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, gemini, identity, services, store
from .agents import assistant

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("tesselle")


def _setup_cloud_trace() -> None:
    """Export ADK agent / Gemini spans (with token usage) to Cloud Trace via ADK's OpenTelemetry hooks."""
    if os.environ.get("TESSELLE_CLOUD_TRACE") != "1":
        return
    try:
        import google.auth
        from google.adk.telemetry.google_cloud import get_gcp_exporters, get_gcp_resource
        from google.adk.telemetry.setup import maybe_set_otel_providers
        from opentelemetry.sdk.resources import Resource

        creds = identity.credentials() or google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])[0]
        # Cloud Trace's OTLP endpoint rejects spans whose resource lacks gcp.project_id.
        resource = get_gcp_resource(config.PROJECT).merge(Resource.create({"service.name": "tesselle", "gcp.project_id": config.PROJECT}))
        maybe_set_otel_providers(
            [get_gcp_exporters(enable_cloud_tracing=True, google_auth=(creds, config.PROJECT))], otel_resource=resource
        )
        log.info("Cloud Trace export enabled for project %s", config.PROJECT)
    except Exception as e:  # telemetry must never block serving
        log.warning("Cloud Trace setup skipped: %s", e)


_setup_cloud_trace()

app = FastAPI(title="Project Tesselle", version="2.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://project-tesselle.web.app",
        "https://project-tesselle.firebaseapp.com",
        "https://tesselle-demandfoundry.web.app",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Visitor-Id"],
    max_age=3600,
)

MAX_UPLOAD = 8 * 1024 * 1024
MAX_VIDEO = 20 * 1024 * 1024  # Gemini inline request limit


@app.exception_handler(services.ServiceError)
async def service_error(_: Request, exc: services.ServiceError):
    return JSONResponse({"error": str(exc), "details": exc.details}, status_code=exc.status)


@app.exception_handler(gemini.BudgetExceeded)
async def budget_error(_: Request, exc: gemini.BudgetExceeded):
    return JSONResponse({"error": str(exc)}, status_code=429)


def _ndjson(gen: AsyncIterator[dict[str, Any]]) -> StreamingResponse:
    """Stream agent progress as NDJSON, with a heartbeat every 5 s so long Gemini calls never leave a
    silent connection for proxies or browsers to drop."""

    def line(ev: dict[str, Any]) -> str:
        return json.dumps(ev, ensure_ascii=False, default=str) + "\n"

    async def body():
        queue: asyncio.Queue = asyncio.Queue()

        async def pump() -> None:
            try:
                async for ev in gen:
                    await queue.put(("ev", ev))
            except services.ServiceError as e:
                await queue.put(("ev", {"type": "error", "message": str(e), "details": e.details}))
            except gemini.BudgetExceeded as e:
                await queue.put(("ev", {"type": "error", "message": str(e)}))
            except Exception as e:  # never leave the UI hanging on a broken stream
                log.exception("stream failed")
                await queue.put(("ev", {"type": "error", "message": f"Something went wrong: {type(e).__name__}. Nothing was sent or committed."}))
            finally:
                await queue.put(("done", None))

        task = asyncio.create_task(pump())
        try:
            while True:
                try:
                    kind, ev = await asyncio.wait_for(queue.get(), timeout=5)
                except asyncio.TimeoutError:
                    yield line({"type": "heartbeat"})
                    continue
                if kind == "done":
                    break
                yield line(ev)
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(body(), media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"})


async def _read(upload: Optional[UploadFile], limit: int = MAX_UPLOAD) -> Optional[tuple[bytes, str]]:
    if upload is None or not upload.filename:
        return None
    data = await upload.read()
    if not data:
        return None
    if len(data) > limit:
        raise services.ServiceError(f"File is larger than {limit // (1024 * 1024)} MB.", 413)
    mime = (upload.content_type or "").split(";")[0]
    if not mime or mime == "application/octet-stream":
        mime = _EXT_MIME.get(os.path.splitext(upload.filename.lower())[1], "application/octet-stream")
    return data, mime


async def _media(*uploads: Optional[UploadFile]) -> tuple[Optional[tuple[bytes, str]], Optional[tuple[bytes, str]]]:
    """Sort uploaded files into (image, video) whatever field they arrived in."""
    image = video = None
    for up in uploads:
        if up is None or not up.filename:
            continue
        peek = (up.content_type or "").split(";")[0] or _EXT_MIME.get(os.path.splitext(up.filename.lower())[1], "")
        f = await _read(up, MAX_VIDEO if peek.startswith("video/") else MAX_UPLOAD)
        if f and f[1].startswith("video/"):
            video = video or f
        elif f:
            image = image or f
    return image, video


async def _state(pid: str) -> dict[str, Any]:
    state = await store.full_state(pid)
    if state is None:
        raise HTTPException(404, "Project not found")
    state["next_decision"] = services.next_decision(state)
    return state


def _visitor(x_visitor_id: Optional[str]) -> str:
    v = (x_visitor_id or "").strip()
    if not v or len(v) > 64:
        raise HTTPException(400, "Missing visitor id")
    return v


# ---- Meta -------------------------------------------------------------------------------------


@app.get("/api/health")
async def health():
    return {"ok": True, "project": config.PROJECT, "model": config.MODEL_REASONING, "vertex": True}


@app.get("/api/meta")
async def meta():
    return {
        "models": {
            "reasoning": config.MODEL_REASONING,
            "fast": config.MODEL_FAST,
            "image": config.MODEL_IMAGE,
            "embedding": config.MODEL_EMBED,
            "tts": config.MODEL_TTS,
        },
        "agent_engine": f"projects/{config.PROJECT}/locations/{config.AGENT_ENGINE_LOCATION}/reasoningEngines/{config.AGENT_ENGINE_ID}",
        "region": config.REGION,
        "demo": services.DEMO,
    }


# ---- Projects ---------------------------------------------------------------------------------


class NewProject(BaseModel):
    title: str = "New project"
    demo: bool = False


@app.post("/api/projects")
async def create_project(body: NewProject, x_visitor_id: Optional[str] = Header(None)):
    owner = _visitor(x_visitor_id)
    title = "Desk organiser - guided demo" if body.demo else (body.title or "New project")
    p = await store.create_project(owner, title, body.demo)
    await store.log(p["id"], "system", "Project created" + (" (guided demo)" if body.demo else ""))
    if body.demo:
        try:
            await assistant.seed_demo_memory(owner)
            await store.log(p["id"], "agent:assistant", "Remembered from an earlier project: you rent (no drilling) and like bamboo",
                            kind="memory", detail="Two preferences saved in Agent Platform Memory Bank for the guided demo profile.")
        except Exception as e:
            log.warning("demo memory seed failed: %s", e)
    return await _state(p["id"])


@app.get("/api/projects")
async def list_projects(x_visitor_id: Optional[str] = Header(None)):
    owner = _visitor(x_visitor_id)
    projects = await store.list_projects(owner)
    out = []
    for p in projects:
        st = await store.full_state(p["id"])
        out.append({"project": p, "next_decision": services.next_decision(st),
                    "brief_version": p.get("brief_version"), "last_event": (st["events"][:1] or [None])[0]})
    return out


@app.get("/api/projects/{pid}")
async def get_project(pid: str):
    return await _state(pid)


@app.get("/api/projects/{pid}/rev")
async def get_rev(pid: str):
    p = await store.get_project(pid)
    if not p:
        raise HTTPException(404)
    return {"rev": p.get("rev", 0), "stage": p.get("stage")}


@app.post("/api/projects/{pid}/inspiration")
async def inspiration(
    pid: str,
    text: str = Form(""),
    region: str = Form(""),
    consent_photo: bool = Form(False),
    use_demo_photo: bool = Form(False),
    image_path: str = Form(""),
    source: str = Form(""),
    image: Optional[UploadFile] = File(None),
    video: Optional[UploadFile] = File(None),
    audio: Optional[UploadFile] = File(None),
):
    img, vid = await _media(image, video)
    voice = await _read(audio)

    async def gen():
        what = ", ".join(x for x in ("your words" if text.strip() else "", "photo" if img or image_path else "", "video" if vid else "",
                                       "voice note" if voice else "") if x) or "what you shared"
        yield {"type": "progress", "agent": "Brief agent", "message": f"Reading {what}"}
        brief = await services.start_from_inspiration(
            pid, text=text, region=region, image=img, audio=voice, video=vid, image_path=image_path or None,
            source=source[:40], consent_photo=consent_photo, use_demo_photo=use_demo_photo,
        )
        musts = sum(1 for r in brief.requirements if r.kind == "must")
        yield {"type": "progress", "agent": "Brief agent", "message": f"Your brief is ready: {musts} must-haves to check"}
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen())


class ImagineBody(BaseModel):
    prompt: str


@app.post("/api/projects/{pid}/imagine")
async def imagine(pid: str, body: ImagineBody, x_visitor_id: Optional[str] = Header(None)):
    if not store.visitor_image_allowed(_visitor(x_visitor_id)):
        raise services.ServiceError("You've generated a lot of images this hour - please try again shortly (credit guard).", 429)
    return {"image_path": await services.imagine(pid, body.prompt)}


class SpeakBody(BaseModel):
    text: str


@app.post("/api/tts")
async def tts(body: SpeakBody):
    audio, _ = await gemini.speak(body.text[:600])
    return {"audio": audio}


@app.post("/api/projects/{pid}/glance")
async def glance(
    pid: str,
    text: str = Form(""),
    source: str = Form("smart glasses"),
    speak: bool = Form(True),
    image: Optional[UploadFile] = File(None),
    video: Optional[UploadFile] = File(None),
    audio: Optional[UploadFile] = File(None),
):
    """Hands-free capture (glasses / phone camera): a photo or clip, optionally with a spoken question.
    Starts the brief if there is none; otherwise the assistant answers about the capture. Replies are spoken."""
    img, vid = await _media(image, video)
    voice = await _read(audio)
    if not (img or vid or voice or text.strip()):
        raise services.ServiceError("Capture a photo or clip, or say something.")

    async def gen():
        state = await store.full_state(pid)
        if state is None:
            raise services.ServiceError("Project not found.", 404)
        reply = ""
        if not state["briefs"]:
            yield {"type": "progress", "agent": "Brief agent", "message": f"Starting your brief from the {source} capture"}
            brief = await services.start_from_inspiration(
                pid, text=text, image=img, video=vid, audio=voice, consent_photo=True, source=source[:40]
            )
            musts = [r.label for r in brief.musts()]
            reply = f"Got it - I've started a brief for {brief.title.lower()}. "
            if musts:
                reply += f"I noted {len(musts)} must-have{'' if len(musts) == 1 else 's'}, like {musts[0].lower()}. "
            if brief.unknowns:
                reply += f"One question: {brief.unknowns[0].question}"
        else:
            what = ("clip" if vid else "photo") if (img or vid) else "question"
            yield {"type": "progress", "agent": "Assistant", "message": f"Looking at your {what}"}
            media = [m for m in (img, vid) if m]
            async for ev in assistant.chat(pid, text.strip(), voice, media=media, source=source[:40]):
                if ev["type"] == "tool":
                    yield {"type": "tool", "message": ev["message"]}
                if ev["type"] == "done":
                    reply = ev.get("reply") or ""
        audio_url = None
        if speak and reply:
            yield {"type": "progress", "agent": "Assistant", "message": "Speaking the answer"}
            try:
                audio_url, _ = await gemini.speak(reply[:600])
            except Exception as e:  # speech is a nicety; the text reply stands
                log.warning("tts failed: %s", e)
        yield {"type": "result", "reply": reply, "audio": audio_url, "state": await _state(pid)}

    return _ndjson(gen())


@app.post("/api/projects/{pid}/brief")
async def edit_brief(pid: str, patch: services.BriefPatch):
    await services.edit_brief(pid, patch)
    return await _state(pid)


class NewRequirementBody(BaseModel):
    text: str
    kind: str = "must"


@app.post("/api/projects/{pid}/brief/requirement")
async def add_requirement(pid: str, body: NewRequirementBody):
    await services.add_requirement_from_text(pid, body.text, body.kind)
    return await _state(pid)


@app.post("/api/projects/{pid}/brief/confirm")
async def confirm_brief(pid: str):
    await services.confirm_brief(pid)
    return await _state(pid)


class AnswerBody(BaseModel):
    answer: Optional[str] = None
    dont_know: bool = False


@app.post("/api/projects/{pid}/unknowns/{uid}")
async def answer_unknown(pid: str, uid: str, body: AnswerBody):
    await services.answer_unknown(pid, uid, body.answer, body.dont_know)
    return await _state(pid)


class ConceptBody(BaseModel):
    instruction: str = ""
    parent_id: Optional[str] = None
    pin_x: Optional[float] = None
    pin_y: Optional[float] = None


@app.post("/api/projects/{pid}/concepts")
async def concept(pid: str, body: ConceptBody, x_visitor_id: Optional[str] = Header(None)):
    if not store.visitor_image_allowed(_visitor(x_visitor_id)):
        raise services.ServiceError("You've generated a lot of concepts this hour - please try again shortly (credit guard).", 429)

    async def gen():
        yield {"type": "progress", "agent": "Design agent", "message": "Sketching the idea" if not body.instruction else f"Changing it: {body.instruction[:60]}"}
        pin = (body.pin_x, body.pin_y) if body.pin_x is not None and body.pin_y is not None else None
        c = await services.generate_concept(pid, instruction=body.instruction, parent_id=body.parent_id, pin=pin)
        yield {"type": "progress", "agent": "Design agent", "message": f"Concept ready: {c['caption']}"}
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen())


@app.post("/api/projects/{pid}/concepts/{cid}/select")
async def select_concept(pid: str, cid: str):
    await services.select_concept(pid, cid)
    return await _state(pid)


@app.post("/api/projects/{pid}/routes/explore")
async def explore(pid: str):
    async def gen():
        async for ev in services.explore_routes(pid):
            if ev["type"] == "result":
                yield {"type": "result", "state": await _state(pid)}
            else:
                yield ev

    return _ndjson(gen())


class OutreachBody(BaseModel):
    entry_ids: list[str]
    share_budget: bool = True


@app.post("/api/projects/{pid}/requests")
async def draft_outreach(pid: str, body: OutreachBody):
    await services.draft_outreach(pid, body.entry_ids, share_budget=body.share_budget)
    return await _state(pid)


class SentBody(BaseModel):
    entry_id: Optional[str] = None


@app.post("/api/projects/{pid}/requests/{rid}/sent")
async def mark_sent(pid: str, rid: str, body: SentBody):
    await services.mark_sent(pid, rid, body.entry_id)
    return await _state(pid)


@app.post("/api/projects/{pid}/replies")
async def add_reply(
    pid: str,
    text: str = Form(""),
    request_id: str = Form(""),
    seller_name: str = Form(""),
    entry_id: str = Form(""),
    image: Optional[UploadFile] = File(None),
):
    img = await _read(image)

    async def gen():
        yield {"type": "progress", "agent": "Reply reader", "message": f"Reading {seller_name or 'the'} reply"}
        q = await services.add_reply(pid, text=text, image=img, request_id=request_id or None, seller_name=seller_name,
                                     entry_id=entry_id or None)
        yield {"type": "progress", "agent": "Fit checker",
               "message": f"{len(q.deviations)} change{'s' if len(q.deviations) != 1 else ''} need your decision" if q.deviations
               else "The reply keeps every must-have"}
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen())


class SimulateBody(BaseModel):
    request_id: Optional[str] = None


@app.post("/api/projects/{pid}/replies/simulate")
async def simulate_reply(pid: str, body: SimulateBody):
    async def gen():
        yield {"type": "progress", "agent": "Practice reply", "message": "Writing a practice reply from a workshop"}
        q = await services.simulate_reply(pid, body.request_id)
        yield {"type": "progress", "agent": "Fit checker",
               "message": f"{len(q.deviations)} change{'s' if len(q.deviations) != 1 else ''} need your decision" if q.deviations
               else "The reply keeps every must-have"}
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen())


class DecisionBody(BaseModel):
    deviation_id: str
    decision: str  # keep_original | accept


@app.post("/api/projects/{pid}/quotes/{qid}/decision")
async def decision(pid: str, qid: str, body: DecisionBody):
    async def gen():
        async for ev in services.decide(pid, qid, body.deviation_id, body.decision):
            if ev["type"] == "result":
                yield {"type": "result", "state": await _state(pid)}
            else:
                yield ev

    return _ndjson(gen())


class ChooseBody(BaseModel):
    entry_id: Optional[str] = None
    quote_id: Optional[str] = None
    idempotency_key: str = ""
    acknowledgements: list[str] = []


@app.post("/api/projects/{pid}/choose")
async def choose(pid: str, body: ChooseBody):
    await services.choose(pid, entry_id=body.entry_id, quote_id=body.quote_id, acknowledgements=body.acknowledgements,
                          idempotency_key=body.idempotency_key)
    return await _state(pid)


class AdvanceBody(BaseModel):
    step: Optional[str] = None


@app.post("/api/projects/{pid}/order/advance")
async def advance(pid: str, body: AdvanceBody):
    await services.advance_order(pid, body.step)
    return await _state(pid)


@app.post("/api/projects/{pid}/delivery-check")
async def delivery_check(pid: str, use_sample: bool = Form(False), photo: Optional[UploadFile] = File(None)):
    async def gen():
        yield {"type": "progress", "agent": "Delivery inspector", "message": "Comparing the photo with the checks you agreed"}
        await services.delivery_check(pid, await _read(photo), use_sample=use_sample)
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen())


class CloseBody(BaseModel):
    outcome: str  # accept | issue
    note: str = ""


@app.post("/api/projects/{pid}/delivery-close")
async def delivery_close(pid: str, body: CloseBody):
    await services.close_delivery(pid, body.outcome, body.note)
    return await _state(pid)


@app.get("/api/projects/{pid}/recap")
async def recap(pid: str, speak: bool = False):
    return await services.recap(pid, speak=speak)


@app.post("/api/projects/{pid}/chat")
async def chat(
    pid: str,
    text: str = Form(""),
    speak: bool = Form(False),
    screen: str = Form(""),
    audio: Optional[UploadFile] = File(None),
    image: Optional[UploadFile] = File(None),
    video: Optional[UploadFile] = File(None),
):
    a = await _read(audio)
    img, vid = await _media(image, video)
    if not text.strip() and not a and not img and not vid:
        raise services.ServiceError("Say or type something.")
    return _ndjson(assistant.chat(pid, text.strip(), a, media=[m for m in (img, vid) if m], speak=speak, screen=screen[:40]))


@app.get("/api/projects/{pid}/chat")
async def chat_history(pid: str):
    return await assistant.history(pid)


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    a = await _read(audio)
    if not a:
        raise services.ServiceError("No audio received.")
    return {"text": await services.transcribe(a)}


class LocateBody(BaseModel):
    lat: float
    lng: float


@app.post("/api/locate")
async def locate(body: LocateBody):
    return await services.locate(body.lat, body.lng)


# ---- Media ------------------------------------------------------------------------------------


@app.get("/api/media/{path:path}")
async def media(path: str):
    if not path.startswith(("projects/", "demo/")) or ".." in path:
        raise HTTPException(404)
    try:
        data, ctype = await store.download_media(path)
    except Exception:
        raise HTTPException(404)
    return Response(content=data, media_type=ctype, headers={"Cache-Control": "public, max-age=86400, immutable"})


# ---- Web app (built React SPA) ---------------------------------------------------------------

if os.path.isdir(config.STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(config.STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        candidate = os.path.join(config.STATIC_DIR, full_path)
        if full_path and os.path.isfile(candidate) and ".." not in full_path:
            return FileResponse(candidate)
        return FileResponse(os.path.join(config.STATIC_DIR, "index.html"), headers={"Cache-Control": "no-cache"})
