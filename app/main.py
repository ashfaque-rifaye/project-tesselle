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

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import channels, config, gemini, identity, live, phone, services, store
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
    allow_headers=["Content-Type", "X-Visitor-Id", "X-Owner-Key", "X-Device"],
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


PUBLIC_API = os.environ.get("TESSELLE_PUBLIC_API", "https://tesselle-448771854429.asia-southeast1.run.app")
# Webhooks may be pointed at the Cloud Run address or the Firebase Hosting site (which forwards /api to it).
PUBLIC_BASES = (PUBLIC_API, "https://project-tesselle.web.app", "https://project-tesselle.firebaseapp.com")


def _ndjson(gen: AsyncIterator[dict[str, Any]], pid: Optional[str] = None, label: str = "") -> StreamingResponse:
    """Stream agent progress as NDJSON, with a heartbeat every 5 s so long Gemini calls never leave a
    silent connection for proxies or browsers to drop. With a project id, the latest progress line is also
    published to the project's live status so the customer's other devices show the same work."""

    def line(ev: dict[str, Any]) -> str:
        return json.dumps(ev, ensure_ascii=False, default=str) + "\n"

    async def body():
        queue: asyncio.Queue = asyncio.Queue()

        async def pump() -> None:
            try:
                if pid:
                    await services.set_live(pid, label or "Working", None, None)
                async for ev in gen:
                    if pid and ev.get("type") in ("progress", "tool") and ev.get("message"):
                        await services.set_live(pid, label or "Working", ev.get("agent"), ev["message"])
                    await queue.put(("ev", ev))
            except services.ServiceError as e:
                await queue.put(("ev", {"type": "error", "message": str(e), "details": e.details}))
            except gemini.BudgetExceeded as e:
                await queue.put(("ev", {"type": "error", "message": str(e)}))
            except Exception as e:  # never leave the UI hanging on a broken stream
                log.exception("stream failed")
                await queue.put(("ev", {"type": "error", "message": f"Something went wrong: {type(e).__name__}. Nothing was sent or committed."}))
            finally:
                if pid:
                    await services.set_live(pid, None)
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
async def list_projects(x_visitor_id: Optional[str] = Header(None), archived: bool = False):
    owner = _visitor(x_visitor_id)
    projects = [p for p in await store.list_projects(owner) if bool(p.get("archived")) == archived]
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
    return {"rev": p.get("rev", 0), "stage": p.get("stage"), "view": p.get("view"), "live": p.get("live")}


class ProjectEdit(BaseModel):
    title: Optional[str] = None
    purpose: Optional[str] = None
    archived: Optional[bool] = None


@app.post("/api/projects/{pid}/edit")
async def edit_project(pid: str, body: ProjectEdit):
    await services.edit_project(pid, body.title, body.purpose, body.archived)
    return await _state(pid)


class ViewBody(BaseModel):
    stage: str
    device: str = "desktop"
    kind: str = ""
    scroll: Optional[float] = None
    busy: Optional[str] = None


@app.post("/api/projects/{pid}/view")
async def set_view(pid: str, body: ViewBody):
    await services.set_view(pid, body.stage, body.device, body.scroll, body.busy, body.kind)
    return {"ok": True}


@app.post("/api/projects/{pid}/photo")
async def add_photo(
    pid: str,
    kind: str = Form("space"),
    note: str = Form(""),
    source: str = Form("phone"),
    image: Optional[UploadFile] = File(None),
    video: Optional[UploadFile] = File(None),
):
    """A photo from the QR capture page, the webcam or the glasses: stored and read into the project."""
    img, vid = await _media(image, video)
    if not (img or vid):
        raise services.ServiceError("Add a photo or a short clip.")

    async def gen():
        yield {"type": "progress", "agent": "Brief agent", "message": f"Reading your photo of the {kind}"}
        if img:
            res = await services.add_photo(pid, img, kind=kind, note=note, source=source[:40])
        else:
            await services.start_from_inspiration(pid, text=note, video=vid, consent_photo=True, source=source[:40]) \
                if await store.get_brief(pid) is None else None
            res = {"ok": True, "photo": "Video clip"}
        yield {"type": "progress", "agent": "Brief agent", "message": "Added: " + (res.get("photo") or res.get("title") or "photo")}
        yield {"type": "result", "photo": res, "state": await _state(pid)}

    return _ndjson(gen(), pid, "Brief agent")


@app.get("/api/projects/{pid}/voice")
async def voice_turns(pid: str):
    return await store.list_coll(pid, "voice")


@app.get("/api/pincode/{pin}")
async def pincode(pin: str):
    return await services.pincode_lookup(pin)


@app.get("/api/channels")
async def channel_status(x_owner_key: Optional[str] = Header(None)):
    return {**await channels.status(), "owner": await channels.is_owner(x_owner_key)}


async def _owner(key: Optional[str]) -> None:
    if not await channels.is_owner(key):
        raise services.ServiceError("This uses the account owner's inbox or phone line - add the owner key in Settings on this device.", 403)


@app.get("/api/img")
async def image_proxy(u: str):
    """Store product photos through Tesselle (some stores block hotlinking)."""
    got = await services.fetch_image(u)
    if not got:
        raise HTTPException(404)
    return Response(content=got[0], media_type=got[1], headers={"Cache-Control": "public, max-age=86400"})


# ---- Notes ------------------------------------------------------------------------------------


class NoteBody(BaseModel):
    text: Optional[str] = None
    share: Optional[bool] = None
    delete: bool = False


@app.post("/api/projects/{pid}/notes")
async def add_note(pid: str, body: NoteBody):
    await services.add_note(pid, body.text or "", bool(body.share))
    return await _state(pid)


@app.post("/api/projects/{pid}/notes/{nid}")
async def update_note(pid: str, nid: str, body: NoteBody):
    await services.update_note(pid, nid, body.text, body.share, body.delete)
    return await _state(pid)


# ---- Picks and orders -------------------------------------------------------------------------


class CartBody(BaseModel):
    entry_id: Optional[str] = None
    quote_id: Optional[str] = None
    qty: int = 1


@app.post("/api/projects/{pid}/cart")
async def add_to_cart(pid: str, body: CartBody):
    await services.add_to_cart(pid, body.entry_id, body.quote_id, body.qty)
    return await _state(pid)


class CartEdit(BaseModel):
    qty: Optional[int] = None
    remove: bool = False


@app.post("/api/projects/{pid}/cart/{cid}")
async def edit_cart(pid: str, cid: str, body: CartEdit):
    await services.update_cart(pid, cid, body.qty, body.remove)
    return await _state(pid)


class PlaceBody(BaseModel):
    cart_ids: Optional[list[str]] = None
    acknowledgements: list[str] = []


@app.post("/api/projects/{pid}/orders")
async def place_orders(pid: str, body: PlaceBody):
    await services.place_orders(pid, body.cart_ids, body.acknowledgements)
    return await _state(pid)


@app.post("/api/projects/{pid}/orders/{oid}/confirm")
async def confirm_order(pid: str, oid: str, text: str = Form(""), image: Optional[UploadFile] = File(None)):
    img = await _read(image)

    async def gen():
        if text.strip() or img:
            yield {"type": "progress", "agent": "Order tracker", "message": "Reading your order confirmation"}
        o = await services.confirm_order(pid, oid, text, img)
        num = (o.get("confirmation") or {}).get("order_number")
        yield {"type": "progress", "agent": "Order tracker", "message": f"Tracking order {num}" if num else "Marked as ordered"}
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen(), pid, "Order tracker")


@app.post("/api/projects/{pid}/orders/{oid}/cancel")
async def cancel_order(pid: str, oid: str):
    await services.cancel_order(pid, oid)
    return await _state(pid)


@app.get("/api/orders")
async def order_history(x_visitor_id: Optional[str] = Header(None)):
    return await services.order_history(_visitor(x_visitor_id))


@app.post("/api/orders/import")
async def import_orders(x_visitor_id: Optional[str] = Header(None), x_owner_key: Optional[str] = Header(None)):
    owner = _visitor(x_visitor_id)
    await _owner(x_owner_key)
    return _ndjson(services.import_inbox_orders(owner))


# ---- Shoppable visuals --------------------------------------------------------------------------


class LookBody(BaseModel):
    entry_ids: Optional[list[str]] = None
    in_space: bool = True


@app.post("/api/projects/{pid}/looks")
async def make_look(pid: str, body: LookBody, x_visitor_id: Optional[str] = Header(None)):
    if not store.visitor_image_allowed(_visitor(x_visitor_id)):
        raise services.ServiceError("You've generated a lot of images this hour - please try again shortly (credit guard).", 429)

    async def gen():
        yield {"type": "progress", "agent": "Design agent", "message": "Placing the real products together with Gemini"}
        look = await services.make_look(pid, body.entry_ids, body.in_space)
        yield {"type": "progress", "agent": "Design agent", "message": f"Shoppable picture ready: {len(look['items'])} products tagged"}
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen(), pid, "Design agent")


@app.post("/api/projects/{pid}/looks/space")
async def try_in_space(pid: str, entry_id: str = Form(...), photo: Optional[UploadFile] = File(None), x_visitor_id: Optional[str] = Header(None)):
    if not store.visitor_image_allowed(_visitor(x_visitor_id)):
        raise services.ServiceError("You've generated a lot of images this hour - please try again shortly (credit guard).", 429)
    img = await _read(photo)

    async def gen():
        yield {"type": "progress", "agent": "Design agent", "message": "Placing it in your photo with Gemini"}
        await services.try_in_space(pid, entry_id, img)
        yield {"type": "progress", "agent": "Design agent", "message": "Here's how it could look in your space"}
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen(), pid, "Design agent")


@app.post("/api/projects/{pid}/inspiration")
async def inspiration(
    pid: str,
    text: str = Form(""),
    region: str = Form(""),
    consent_photo: bool = Form(False),
    use_demo_photo: bool = Form(False),
    image_path: str = Form(""),
    source: str = Form(""),
    pincode: str = Form(""),
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
            source=source[:40], consent_photo=consent_photo, use_demo_photo=use_demo_photo, pincode=pincode,
        )
        musts = sum(1 for r in brief.requirements if r.kind == "must")
        yield {"type": "progress", "agent": "Brief agent", "message": f"Your brief is ready: {musts} must-haves to check"}
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen(), pid, "Brief agent")


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


class RevertBody(BaseModel):
    to_version: int
    requirement_ids: Optional[list[str]] = None


@app.post("/api/projects/{pid}/brief/revert")
async def revert_brief(pid: str, body: RevertBody):
    await services.revert_brief(pid, body.to_version, body.requirement_ids)
    return await _state(pid)


@app.post("/api/projects/{pid}/concepts/{cid}/revert")
async def revert_visual(pid: str, cid: str):
    await services.revert_visual_edit(pid, cid)
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

    return _ndjson(gen(), pid, "Design agent")


class IdeasBody(BaseModel):
    instruction: str = ""
    base_id: Optional[str] = None


@app.post("/api/projects/{pid}/ideas")
async def ideas_route(pid: str, body: IdeasBody, x_visitor_id: Optional[str] = Header(None)):
    """2-3 ideas drawn into the customer's photo - or one idea redrawn with their change."""
    if not store.visitor_image_allowed(_visitor(x_visitor_id)):
        raise services.ServiceError("You've generated a lot of images this hour - please try again shortly (credit guard).", 429)
    from . import ideas

    async def gen():
        async for ev in ideas.generate_ideas(pid, instruction=body.instruction.strip()[:300], base_id=body.base_id):
            yield ev
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen(), pid, "Design agent")


@app.post("/api/projects/{pid}/ideas/{cid}/use")
async def use_idea(pid: str, cid: str):
    """Shop an idea: real products for each of its items, then a shoppable picture in the customer's photo."""
    async def gen():
        look_id = None
        async for ev in services.use_idea(pid, cid):
            if ev["type"] == "result":
                look_id = ev.get("look_id")
            else:
                yield ev
        yield {"type": "result", "state": await _state(pid), "look_id": look_id}

    return _ndjson(gen(), pid, "Shopping your idea")


@app.post("/api/projects/{pid}/calls/{cid}/followup")
async def call_followup(pid: str, cid: str, x_owner_key: Optional[str] = Header(None)):
    await _owner(x_owner_key)
    await services.send_call_followup(pid, cid)
    return await _state(pid)


@app.post("/api/projects/{pid}/requests/{rid}/recipients/{eid}/find")
async def find_contact(pid: str, rid: str, eid: str):
    await services.find_recipient_contact(pid, rid, eid)
    return await _state(pid)


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

    return _ndjson(gen(), pid, "Searching")


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


@app.post("/api/projects/{pid}/requests/{rid}/recipients/{eid}")
async def update_recipient(pid: str, rid: str, eid: str, patch: services.RecipientPatch):
    await services.update_recipient(pid, rid, eid, patch)
    return await _state(pid)


class SendBody(BaseModel):
    via_device: bool = False
    reply_to: Optional[str] = None
    entry_ids: Optional[list[str]] = None


@app.post("/api/projects/{pid}/requests/{rid}/send")
async def send_outreach(pid: str, rid: str, body: SendBody, x_owner_key: Optional[str] = Header(None)):
    req = await store.get(pid, "requests", rid)
    picked = [r for r in (req or {}).get("recipients", []) if not body.entry_ids or r["entry_id"] in body.entry_ids]
    if any(r.get("channel") == "call" for r in picked) or (not body.via_device and any(r.get("channel") == "email" for r in picked)):
        await _owner(x_owner_key)

    wa_ok = not body.via_device and await channels.is_owner(x_owner_key)

    async def gen():
        async for ev in services.send_outreach(pid, rid, body.entry_ids, PUBLIC_API, wa_ok=wa_ok, device=body.via_device,
                                               reply_to=body.reply_to):
            if ev["type"] == "result":
                yield {"type": "result", "state": await _state(pid)}
            else:
                yield ev

    return _ndjson(gen(), pid, "Outreach agent")


@app.post("/api/projects/{pid}/replies/check")
async def check_replies(pid: str, x_owner_key: Optional[str] = Header(None)):
    await _owner(x_owner_key)

    async def gen():
        async for ev in services.check_replies(pid):
            if ev["type"] == "result":
                yield {"type": "result", "state": await _state(pid)}
            else:
                yield ev

    return _ndjson(gen(), pid, "Reply reader")


# ---- Phone calls: Twilio webhooks ----------------------------------------------------------------


async def _twilio(request: Request, cid: str) -> tuple[str, dict[str, str]]:
    form = {k: str(v) for k, v in (await request.form()).items()}
    url = f"{PUBLIC_API}{request.url.path}"
    if not await channels.valid_signature(url, form, request.headers.get("X-Twilio-Signature", "")):
        raise HTTPException(403, "Bad signature")
    idx = await store.db().collection("call_index").document(cid).get()
    if not idx.exists:
        raise HTTPException(404)
    return idx.to_dict()["pid"], form


@app.post("/api/calls/{cid}/voice")
async def call_voice(cid: str, request: Request):
    pid, _ = await _twilio(request, cid)
    call = await store.get(pid, "calls", cid) or {}
    if call.get("stream_token"):  # real-time conversation through Gemini Live
        ws_url = PUBLIC_API.replace("https://", "wss://") + f"/api/calls/{cid}/stream"
        return Response(phone.twiml_stream(ws_url, call["stream_token"]), media_type="application/xml")
    line = await services.call_opening(pid, cid)
    return Response(channels.twiml_say_gather(line, f"{PUBLIC_API}/api/calls/{cid}/turn"), media_type="application/xml")


@app.post("/api/calls/{cid}/turn")
async def call_turn(cid: str, request: Request):
    pid, form = await _twilio(request, cid)
    say, done = await services.call_turn(pid, cid, form.get("SpeechResult", ""))
    if done:
        return Response(channels.twiml_say_hangup(say), media_type="application/xml")
    return Response(channels.twiml_say_gather(say, f"{PUBLIC_API}/api/calls/{cid}/turn"), media_type="application/xml")


@app.post("/api/calls/{cid}/status")
async def call_status(cid: str, request: Request):
    pid, form = await _twilio(request, cid)
    status = form.get("CallStatus", "completed")
    call = await store.get(pid, "calls", cid) or {}
    if status in ("completed", "busy", "no-answer", "failed", "canceled") and call.get("stream") != "live":
        await services.finish_call(pid, cid, status)
    return {"ok": True}


@app.websocket("/api/calls/{cid}/stream")
async def call_stream(ws: WebSocket, cid: str):
    """Twilio Media Streams: the phone call's audio, both ways (checked with the per-call token)."""
    await ws.accept()
    await phone.handle(ws, cid)


@app.post("/api/whatsapp/inbound")
async def whatsapp_inbound(request: Request):
    """A seller's WhatsApp reply: matched to the project by their number and read like any other reply."""
    form = {k: str(v) for k, v in (await request.form()).items()}
    sig = request.headers.get("X-Twilio-Signature", "")
    if not any([await channels.valid_signature(f"{base}/api/whatsapp/inbound", form, sig) for base in PUBLIC_BASES]):
        raise HTTPException(403, "Bad signature")
    num = form.get("From", "").replace("whatsapp:", "").lstrip("+")
    idx = await store.db().collection("wa_index").document(num).get()
    if not idx.exists:
        return Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', media_type="application/xml")
    ref = idx.to_dict()
    img = await channels.twilio_media(form["MediaUrl0"]) if form.get("NumMedia", "0") != "0" and form.get("MediaUrl0") else None

    async def read() -> None:
        try:
            await services.add_reply(ref["pid"], text=form.get("Body", ""), image=img, request_id=ref["request_id"],
                                     seller_name=ref["name"], entry_id=ref["entry_id"])
        except Exception:
            log.exception("whatsapp reply failed")

    asyncio.create_task(read())
    return Response('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Thank you! Tesselle has passed this to the customer.'
                    '</Message></Response>', media_type="application/xml")


# ---- Voice agent (Gemini Live) --------------------------------------------------------------------

LIVE_ORIGINS = ("https://project-tesselle.web.app", "https://project-tesselle.firebaseapp.com", PUBLIC_API,
                "http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:8080", "http://localhost:8080")


@app.websocket("/api/projects/{pid}/live")
async def live_voice(ws: WebSocket, pid: str):
    origin = ws.headers.get("origin", "")
    if origin and origin not in LIVE_ORIGINS:
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except Exception:
        await ws.close(code=1008)
        return
    owner_ok = await channels.is_owner(hello.get("key"))
    await live.handle(ws, pid, str(hello.get("stage") or ""), owner_ok, PUBLIC_API, camera=bool(hello.get("camera")))


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
    order_id: Optional[str] = None


@app.post("/api/projects/{pid}/order/advance")
async def advance(pid: str, body: AdvanceBody):
    await services.advance_order(pid, body.step, body.order_id)
    return await _state(pid)


@app.post("/api/projects/{pid}/delivery-check")
async def delivery_check(pid: str, use_sample: bool = Form(False), order_id: str = Form(""), photo: Optional[UploadFile] = File(None)):
    async def gen():
        yield {"type": "progress", "agent": "Delivery inspector", "message": "Comparing the photo with the checks you agreed"}
        await services.delivery_check(pid, await _read(photo), use_sample=use_sample, order_id=order_id or None)
        yield {"type": "result", "state": await _state(pid)}

    return _ndjson(gen(), pid, "Delivery inspector")


class CloseBody(BaseModel):
    outcome: str  # accept | issue
    note: str = ""
    order_id: Optional[str] = None


@app.post("/api/projects/{pid}/delivery-close")
async def delivery_close(pid: str, body: CloseBody):
    await services.close_delivery(pid, body.outcome, body.note, body.order_id)
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
    x_owner_key: Optional[str] = Header(None),
):
    a = await _read(audio)
    img, vid = await _media(image, video)
    if not text.strip() and not a and not img and not vid:
        raise services.ServiceError("Say or type something.")
    owner_ok = await channels.is_owner(x_owner_key)
    return _ndjson(assistant.chat(pid, text.strip(), a, media=[m for m in (img, vid) if m], speak=speak, screen=screen[:40],
                                  owner_ok=owner_ok, public_base=PUBLIC_API), pid, "Assistant")


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
