# Project Tesselle

**Imagine it. Keep what matters. Get it made.**

Project Tesselle is a personal shopping agent for the **Retail & Commerce** theme of the Google Cloud AI Builder
Cup 2026 - built for purchases that have to *fit*: a space, a device, a person, an occasion or a deadline.

Tell it what you want in words, a voice note, a photo, a short video, an AI-imagined picture or a capture from
smart glasses. Gemini agents turn that into a brief you can edit at any time, search **real stores** and **real
makers** that deliver to you, check every option against your must-haves, write the messages you send to makers,
read their replies, and stop any seller change to a must-have until *you* decide. The same brief carries through
choosing, tracking and a delivery check.

| | |
|---|---|
| **Live app (Firebase Hosting)** | https://project-tesselle.web.app |
| **Live app / API (Cloud Run)** | https://tesselle-448771854429.asia-southeast1.run.app |
| **Source code** | https://github.com/ashfaque-rifaye/project-tesselle |
| **Pitch deck** | [`deck/Project-Tesselle-Pitch-Deck.pdf`](deck/Project-Tesselle-Pitch-Deck.pdf) |
| **Guided demo** | Open the app → *Launch the guided demo* - it runs itself, live (about 8 minutes) |

> Honesty: listings and makers come from **live web search** and link to their real pages; prices and stock can
> change, so the app says "check the store page". Tesselle never pays, orders or sends messages for you. The
> "practice reply" in the demo is written by Gemini and labelled as such - it never pretends to be a real business.

---

## The journey

1. **Start** - "How do you want to start?": describe it (type or talk - words appear as you speak), show a photo
   or video, use the camera, imagine it with Gemini, or capture from Ray-Ban Meta glasses. Delivery city from your
   location or a saved place.
2. **Your brief** - the brief agent writes must-haves vs nice-to-haves (e.g. "max depth 18 cm", "no drilling");
   sizes seen in a photo stay "measure to confirm". Everything is editable in the side panel or by voice, at any step.
3. **Visualise** (optional) - a labelled concept; tap the picture to point at what to change.
4. **Options** - the **shopping agent** finds real listings (IKEA, Flipkart, Amazon.in, Pepperfry, brand stores...)
   and the **maker scout** finds real workshops and made-to-order services near you. The **fit checker** (plain code)
   marks each one *fits / check a detail / doesn't fit*; a short summary says what was found.
5. **Reach out** - the **outreach agent** writes the message; you send it from Gmail, your mail app or WhatsApp.
6. **Replies** - paste a reply or drop a screenshot; the **reply reader** extracts the offer and the fit checker
   compares it with your brief. A change to a must-have (e.g. a 20 cm jig for an 18 cm shelf) is **blocked** until
   you decide; keeping it drafts your follow-up.
7. **Choose** - one option, one brief version; anything unconfirmed needs an explicit tick.
8. **Track** - buy directly from the seller; mark ordered / arrived from any device.
9. **Delivery check** - Gemini vision compares a photo with the checks you agreed, and says what a photo can't prove.

`tools/e2e_storyboard.py <url>` runs the journey against a deployment and asserts the guarantees.

## Gen AI implementation

| Agent / capability | How |
|---|---|
| **Brief agent** | ADK `LlmAgent` on **Gemini 3.8 Flash**, typed output schema; inputs: text, voice, photos, **video**, generated images. |
| **Shopping agent + maker scout** | **ADK 2 graph `Workflow`**: `prepare → (shopping_agent ‖ maker_scout) → JoinNode → advisor`. Both use **Gemini with Grounding with Google Search**; each result line is tied to its cited page (grounding supports), the redirect is resolved to the real product or maker page, and the page's preview image is used. **Gemini Embedding 2** ranks results by relevance. |
| **Fit checker** | `app/guard.py` - deterministic requirement checks, verdicts, quote deviations and choose gates. LLMs only *explain* verdicts. |
| **Advisor** | Short, plain-language summary (headline, 2-4 bullets, best next step). |
| **Design agent** | Writes the art direction; **Gemini image generation** draws concepts, with tap-to-point refinements. |
| **Outreach agent** | Drafts quote requests and follow-ups the customer sends themselves (only the brief is shared). |
| **Reply reader** | Turns a pasted reply, screenshot or PDF into a structured offer; decision cards explain any change. |
| **Assistant (voice)** | ADK agent with tools that act on the project (edit brief, budget, city, confirm, draw, find options, draft messages) and **navigate the app**; live speech-to-text, spoken replies with **Gemini TTS**; **Agent Platform Sessions + Memory Bank** keep one conversation across desktop, phone and glasses. |
| **Delivery inspector** | Gemini vision compares a delivery photo with the agreed checklist. |
| **Self-running guided demo** | The app drives itself through the real journey (live agents, live web search) with captions and narration. |
| **Resilience** | Primary model with automatic fallback to **Gemini 2.5 Flash** in `asia-southeast1`; hedged grounded search; deterministic summaries if an explainer is slow. |
| **Activity** | Every agent step in plain words, with model/latency/tokens one tap away; ADK OpenTelemetry spans go to **Cloud Trace**. |

## Experience design

A liquid-glass design system ("Mist & Volt"): frosted glass over a misty, Gemini-generated forest-studio scene, one
volt accent for the next action, iOS-style status colours (always with text and an icon), capsule controls and
spring motion.

- **Always clear what's next** - a sticky Next bar on every step; the step's main action lives there.
- **See the agents work** - a Dynamic-Island status pill says which Gemini agent is doing what, right now.
- **Your brief, editable everywhere** - budget, city, deadline, must-haves and nice-to-haves, at any step.
- **Calm by default** - a hideable step rail, a round Activity icon, an assistant button in the corner.
- **One project, every device** - phone app (Home, Capture, Assistant, Activity), glasses HUD and the Ray-Ban Meta
  share target all work on the same project in real time.

## Google Cloud stack

- **Vertex AI / Agent Platform** (`aiplatform.googleapis.com`) - Gemini 3.8 Flash, Gemini 2.5 Flash (regional fast path and
  fallback), **Grounding with Google Search**, Gemini 3.1 Flash Image, Gemini Embedding 2, Gemini 2.5 Flash TTS; Agent
  Runtime with **Sessions** and **Memory Bank** (`asia-southeast1`).
- **Google ADK 2.12** - `LlmAgent`s with output schemas and tools, graph `Workflow` with parallel fan-out and `JoinNode`,
  `Runner`, Vertex session & memory services, OpenTelemetry.
- **Cloud Run** - FastAPI + ADK backend and the web app, streaming NDJSON progress.
- **Firebase Hosting** - global CDN for the web app; API calls go straight to Cloud Run.
- **Firestore** - projects, immutable brief versions, options, messages, quotes, choices, activity log.
- **Cloud Storage** - private media bucket, served through the API.
- **Cloud Build + Artifact Registry**, **Cloud Logging + Cloud Trace** (OTLP via the Telemetry API).
- **Identity** - one least-privilege runtime service account. **No API keys anywhere**; the app refuses to start if
  Gemini is not on Vertex AI.

## Architecture

```
Browser (React + Three.js, PWA share target)          Phone app / glasses capture
        │  Firebase Hosting (CDN)                             │
        └──────────────► Cloud Run: FastAPI ◄─────────────────┘
                           │  ADK agents + graph Workflow
                           │  fit checker (deterministic)
        ┌──────────────────┼────────────────────────────┬────────────────────┐
  Vertex AI Gemini   Agent Platform               Firestore             Cloud Storage
  (+ Google Search   Sessions + Memory Bank       (state, versions)     (media)
   grounding, image,
   embeddings, TTS)
```

## Repository

```
app/                FastAPI app, services, fit checker (guard.py), Firestore/Storage, Vertex clients
app/agents/         ADK agents (brief, design, shopper + maker scout, advisor, outreach, reply reader,
                    decision writer, recap, inspector, assistant) and the find-options graph Workflow
web/                React + TypeScript + Three.js front end (workspace, phone app, glasses HUD, share)
tools/              Provisioning, end-to-end test, credit check, brand media, video tooling
docs/               Hackathon brief and the product experience blueprint
```

## Run it

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
TESSELLE_IMPERSONATE=tesselle-runtime@<project>.iam.gserviceaccount.com uvicorn app.main:app --port 8080
cd web && npm install && npm run dev
python tools/provision_agent_platform.py     # Agent Runtime with Sessions + Memory Bank (one-time)
gcloud builds submit --config cloudbuild.yaml && gcloud run deploy tesselle --image .../tesselle/app:<tag>
firebase deploy --only hosting
```

## Responsible design

- Must-haves change only through an explicit decision that creates a new brief version; sellers can propose, never overwrite.
- Every listing links to its real page; prices and stock are labelled "check the store page".
- Unknown charges are never folded into a total; unconfirmed must-haves need an explicit tick before choosing.
- Sellers receive only the brief - never your name, number, address or photos.
- Tesselle never pays, orders or sends messages for you; the assistant can't accept seller changes or choose for you.
- Concept and practice content is always labelled; a cost guard caps daily model and image calls.

Built for the Google Cloud AI Builder Cup 2026 (Hack2Skill).
