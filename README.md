# Project Tesselle

**Imagine it. Keep what matters. Get it made.**

Project Tesselle is a personal commerce agent for the **Retail & Commerce** theme of the Google Cloud AI
Builder Cup 2026. It turns an inspiration — words, a voice note, a photo of your space, a short video, an
AI-imagined concept or a capture from smart glasses — into a clear, versioned brief. It then checks what
can really be **bought, sourced, customised or made**, negotiates with makers, and carries the same
brief through approval, fulfilment and the delivery check.

Its heart is **MissionLock**: language models propose, deterministic code decides. No seller, substitute
or shortcut can silently change a requirement the customer said must stay the same.

| | |
|---|---|
| **Live app (Firebase Hosting)** | https://project-tesselle.web.app |
| **Live app / API (Cloud Run)** | https://tesselle-448771854429.asia-southeast1.run.app |
| **Guided demo** | Open the app → *Launch the guided demo* (about 5 minutes, no sign-up) |

> Demonstration honesty: every seller, price, stock level and maker response is **fictional demo data**
> (maker replies are AI-simulated and labelled); orders are **sandbox** — nothing is bought or shipped.

---

## The story it proves (10 beats)

1. **Inspiration** — a desk photo + "organiser for pens, phone and an A5 notebook… shelf leaves 18 cm… I rent, no drilling… around ₹3,000".
2. **Intent** — Gemini drafts a brief; the customer confirms *Must stay the same* (18 cm max depth, no drilling, pen cup, phone slot, notebook tray) vs *Flexible* (bamboo).
3. **Concept** — a labelled concept render; click-to-pin visual refinements that never silently edit the brief.
4. **Existing stock** — a beautiful bamboo station is **rejected: 22 cm deep**. "No suitable match found in the sources checked."
5. **Maker request** — the customer reviews exactly what the maker receives (no name, no address, no home photo).
6. **Counteroffer** — the maker proposes its standard **20 cm** jig → MissionLock **blocks** it.
7. **Resolution** — customer keeps 18 cm → maker revises the layout at **16 cm**; a small price rise is a flexible decision.
8. **Device handoff** — QR → the phone opens the same pending decision with a spoken recap.
9. **Approval** — exact spec + quote + brief version; idempotent **sandbox** order; stale quotes are blocked.
10. **Aftercare** — Gemini vision checks the delivery photo against the approved acceptance checks ("measure the depth — a photo can't prove 18 cm").

`tools/e2e_storyboard.py <url>` runs all ten beats against a live deployment and asserts every guarantee.

## Gen AI implementation

| Capability | How |
|---|---|
| **Multimodal intake** | ADK `LlmAgent` on **Gemini 3.8 Flash** with a typed output schema; inputs: text, voice (audio), photos, **video**, generated images. Photo-derived sizes are always `needs_checking`. |
| **MissionLock guard** | `app/missionlock.py` — deterministic requirement checks, fit verdicts (*meets / possible with a change / not suitable*), quote deviations, readiness and approval gates. LLMs only *explain* verdicts. |
| **Route explorer** | **ADK 2 graph `Workflow`**: `prepare → (catalog_scout ‖ sourcing_scout ‖ maker_scout) → JoinNode → analyst`. Catalog scout uses **Firestore vector search** over **Gemini embeddings**. |
| **Creative studio** | Gemini (art director agent) writes the prompt; **Gemini image generation** renders/edits concepts, with click-to-pin visual prompting (a teal ring drawn onto the reference image). Flags visual edits that would affect the brief. |
| **Maker negotiation** | AI-simulated fictional maker agent with a capability profile; quotes are tied to a brief version; a **deviation explainer** agent writes decision cards. |
| **Concierge** | Conversational MissionLock agent with function tools (edit requirements, budget, answer questions, refine concept, explore routes, remember preferences) — the same guarded services as the UI buttons. |
| **Memory** | **Agent Platform Sessions** (per-project conversation across devices) and **Agent Platform Memory Bank** (durable preferences such as "I rent — no drilling"), via `PreloadMemoryTool`. |
| **Glasses & phone capture** | Heads-up capture view (live camera, photo/clip, voice question) → `/glance` → Gemini answers about the capture → **Gemini TTS** speaks the reply. Installable PWA with a **share target** so Ray-Ban Meta photos/clips can be shared straight to the agent. |
| **Delivery inspector** | Gemini vision compares the delivery photo with the approved checklist; says what a photo cannot prove. |
| **Recap** | Recap agent + Gemini TTS for "where you left off" on the phone surface. |
| **Evidence trace** | Every agent step is logged with model, latency and tokens in the in-app *Evidence & agent trace*; ADK OpenTelemetry spans go to **Cloud Trace**. |

## Google Cloud stack

- **Vertex AI / Agent Platform** (`aiplatform.googleapis.com`) — Gemini 3.8 Flash, Gemini 3.1 Flash Image (+ first-party fallbacks), Gemini Embedding 2, Gemini 2.5 Flash TTS; Agent Runtime with **Sessions** and **Memory Bank** (`asia-southeast1`).
- **Google ADK 2.12** — `LlmAgent`s with output schemas and tools, graph `Workflow` with parallel fan-out and `JoinNode`, `Runner`, Vertex session & memory services, OpenTelemetry tracing.
- **Cloud Run** — FastAPI + ADK backend and the web app, streaming NDJSON progress (scale-to-zero, capped instances).
- **Firebase Hosting** — global CDN for the web app; API calls go straight to Cloud Run.
- **Firestore** (Native) — projects, immutable brief versions, quotes, orders, event log, and the **vector index** for catalogue search.
- **Cloud Storage** — private media bucket (inspirations, concepts, proposals, evidence), served through the API.
- **Cloud Build + Artifact Registry** — container builds; **Cloud Logging + Cloud Trace** — operations.
- **Identity** — a dedicated runtime service account with least-privilege roles. **No API keys anywhere**; the app refuses to start if Gemini is not on Vertex AI.

## Architecture

```
Browser (React + Three.js, PWA share target)          Phone / glasses capture
        │  Firebase Hosting (CDN)                             │
        └──────────────► Cloud Run: FastAPI ◄─────────────────┘
                           │  ADK agents + graph Workflow
                           │  MissionLock guard (deterministic)
        ┌──────────────────┼───────────────────────────┬────────────────────┐
  Vertex AI Gemini   Agent Platform              Firestore             Cloud Storage
  (text, vision,     Sessions + Memory Bank      (+ vector search)     (media)
   video, image,
   embeddings, TTS)
```

## Repository

```
app/                FastAPI app, services, MissionLock guard, Firestore/Storage, Vertex client
app/agents/         ADK agents (intake, studio, route analyst, maker, deviation, recap, inspector, concierge)
                    and the route-explorer graph Workflow
app/data/           Fictional demonstration catalogue
web/                React + TypeScript + Three.js front end (workspace, phone, glasses, seller, share)
tools/              Provisioning, catalogue seeding, end-to-end storyboard test, credit check, video tooling
docs/               Hackathon brief and the product experience blueprint
```

## Run it

```bash
# Backend (uses your ADC, impersonating the runtime service account)
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
TESSELLE_IMPERSONATE=tesselle-runtime@<project>.iam.gserviceaccount.com uvicorn app.main:app --port 8080
# Front end
cd web && npm install && npm run dev
# One-time setup
python tools/provision_agent_platform.py     # Agent Runtime with Sessions + Memory Bank
python -m tools.seed_catalog                 # Gemini-rendered catalogue + embeddings
# Deploy
gcloud builds submit --config cloudbuild.yaml && gcloud run deploy tesselle --image .../tesselle/app:<tag>
firebase deploy --only hosting
```

## Responsible design

- Concepts, existing products, supplier proposals and samples always carry distinct labels.
- Must-haves can only change through an explicit, labelled decision that creates a new brief version.
- Unknown charges are shown as "Not yet known" and never folded into a misleading total.
- Photos/videos are used only for the project; sellers receive a privacy-filtered brief.
- The concierge cannot send requests, accept seller changes or approve spending.
- A public-demo cost guard caps daily model and image calls.

Built for the Google Cloud AI Builder Cup 2026 (Hack2Skill).
