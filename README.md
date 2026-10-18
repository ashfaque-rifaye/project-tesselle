# Project Tesselle

**One agent for everything that has to fit.**

Project Tesselle is a voice-first shopping agent for the **Retail & Commerce** theme of the Google Cloud AI Builder
Cup 2026, built by team **Mindflayer** (Ashfaque Rifaye, Vasanth Kumar). It is for purchases that have to *fit*: a
space, a device, a person, an occasion or a deadline. A desk organiser for a cramped desk, a blouse by Friday, 500
printed tote bags for an event.

You say it, show it (photo or video), or look at it through simulated smart glasses. Gemini writes a brief of your
must-haves and the facts that decide fit, plans the steps for *this* purchase, draws 2-3 ideas into your own photo,
and finds **real products** in stores that deliver to your PIN code. When nothing ready-made fits, it finds **real
makers**, reads each business's own website for its published email and phone, then **emails them or phones them**
with a real-time AI voice agent that turns the answers into a quote. Every option and quote is checked against your
must-haves by plain code, and nothing changes without your yes. For ready-made picks, the **checkout agent** fills the
store cart with your PIN code and cash on delivery; you place the order. Laptop, phone and glasses stay in sync.

| | |
|---|---|
| **Live app (Firebase Hosting)** | https://project-tesselle.web.app |
| **Live app / API (Cloud Run)** | https://tesselle-448771854429.asia-southeast1.run.app |
| **Demo video (2:54)** | https://project-tesselle.web.app/demo/tesselle-demo.mp4 |
| **Pitch deck (PDF)** | [`deck/Project-Tesselle-Pitch-Deck.pdf`](deck/Project-Tesselle-Pitch-Deck.pdf) |
| **Source code** | https://github.com/ashfaque-rifaye/project-tesselle |
| **Team** | Mindflayer: Ashfaque Rifaye (lead), Vasanth Kumar |

## Try it (no sign-up)

1. Open https://project-tesselle.web.app and tap the voice orb (or type).
2. Try one of these, which we know work end to end:
   - *"I want a compact organiser for my study desk with room for my pens, my phone and an A5 notebook. The shelf
     above only leaves 18 cm of depth and I rent, so no drilling. Around 3,000 rupees, no more than 3,500."*
     Add a photo of the desk when asked, say **"show me ideas"**, then **"shop the second one"**.
   - *"I need 500 jute tote bags with our logo printed in one colour, for an event in Chennai in three weeks."*
     Tesselle plans a sourcing journey: it finds print studios, their published contacts, and drafts the requests.
3. Or press **Watch it run** on the home page: the guided demo drives the real app by itself (about five minutes).
4. **MetaGlass mode** simulates smart glasses with your camera: Gemini Live sees what you see and saves the view.

**Limits, stated up front:** a daily cap limits model and image calls per visitor. Emails and AI phone calls go out
only from a device that holds the owner key, so on the public app you can draft messages but not send them from the
owner's inbox (see [`docs/CHANNELS.md`](docs/CHANNELS.md)). Listings come from live search, so prices and stock can
change; the app says "check the store page". Payment always happens on the store.

---

## The journey

The step rail is **planned per purchase**: after every brief change Gemini decides which steps this purchase needs
(a desk organiser from a store skips "Ask makers"; 500 printed bags go straight to sourcing) and names them for it.

1. **Your idea** - say it, type it, show a photo or video, use the camera, or capture from MetaGlass. Delivery city
   and PIN code from your location (OpenStreetMap), a PIN code (India Post) or a saved place.
2. **What you need** - the brief agent writes must-haves vs nice-to-haves (e.g. "max depth 18 cm", "no drilling")
   and the 3-6 facts that decide fit for this purchase. Sizes seen in a photo stay "measure to confirm". Everything
   is editable, by voice too, at any step; every change is a new version you can revert.
3. **See ideas** - the design agent draws 2-3 ideas into your own photo, keeping everything you already have, and
   tags the new products each idea needs. Redraw by voice, or pick one.
4. **Shop & pick** - the **shopping agent** finds real listings for the idea's products (Amazon.in, Flipkart, IKEA,
   Pepperfry, brand stores...) and the **maker scout** finds real workshops and made-to-order services near you, in
   parallel. The **fit checker** (plain code) marks each one *fits / check a detail / doesn't fit*. **Shop the look**
   places the real products in your photo with a dot on each that links to its listing. Add picks right here.
5. **Ask makers** (only when needed) - Tesselle reads each maker's own website for its published email and phone,
   and the **outreach agent** writes the request with privacy-scrubbed photos. Per maker: **email**, **WhatsApp**,
   or an **AI phone call**.
6. **Their replies** - email replies and call answers arrive by themselves; the **reply reader** turns each one into
   an offer and the fit checker compares it with your brief. A change to a must-have is **blocked** until you decide.
   After a call, the agent can email the maker the details they asked for.
7. **Review & order** - each pick is cleared by the fit checker; anything unconfirmed needs an explicit tick.
8. **Order** - the **checkout agent** opens the store, fills the cart, sets your PIN code and picks cash on delivery,
   and you place the order. Gemini reads the confirmation into your order history.
9. **Delivery check** - Gemini vision compares a photo of what arrived with the checks you agreed.

## Gen AI implementation

| Agent / capability | How |
|---|---|
| **Voice agent (live)** | **Gemini Live native audio** over a WebSocket on Cloud Run: speech in, speech out, patient turn-taking, session resumption so it continues where you left off on any device, and camera frames (1 per second) in MetaGlass mode. It drives the whole app with **25 tools** - brief edits, budget, PIN code, ideas, shop an idea, shop the look, picks, orders, messages, replies, any step. Slow tools run in the background and it speaks the result. |
| **Brief agent + step planner** | ADK `LlmAgent` on **Gemini 3.8 Flash** with typed output; inputs: text, voice, photos, **video**. A planner lays out the facts that decide fit and the steps for this purchase, with a sanity check in code. |
| **Design agent** | **Gemini image** draws 2-3 ideas into the customer's own photo and lists the products each idea needs; tap or speak to refine. |
| **Shopping agent + maker scout** | **ADK graph `Workflow`**: `prepare → (shopping_agent ‖ maker_scout) → JoinNode → advisor`. Gemini with **Grounding with Google Search** runs in parallel with a **Vertex AI Search** store index over ~45 Indian retailers; every result is tied to its cited page and real product photo, and **Gemini Embedding 2** ranks by relevance. |
| **Fit checker** | `app/guard.py` - deterministic requirement checks, verdicts, quote deviations and choose gates. Models only *explain* verdicts. |
| **Shop the look** | Gemini image composes the real product photos (and the customer's room) into one scene, then Gemini returns each product's bounding box, so every dot links to its listing. |
| **Contact finder** | Reads the business's own contact pages for its published email and phone, falling back to grounded search. |
| **Outreach agent** | Drafts requests and follow-ups; photos are re-encoded (no camera data or GPS) and Gemini finds faces, documents and addresses, which are blurred. |
| **Call agent** | A **real-time phone conversation**: Twilio Media Streams carry the call audio over a WebSocket to Cloud Run, bridged to **Gemini Live**. It says it is an AI assistant calling for a customer, follows the caller's language, asks size, price and lead time, never shares the customer's details, and the transcript becomes a checked quote. |
| **Reply reader** | Turns an email, screenshot or PDF into a structured offer; decision cards explain any change. |
| **Checkout agent + order tracker** | Builds the fastest legitimate checkout per store (multi-item cart links, pre-filled PIN code, cash on delivery) and reads confirmations into the order history. |
| **Assistant (chat) + memory** | The same tools as an ADK agent; **Agent Platform Sessions + Memory Bank** keep one conversation and your preferences across desktop, phone and glasses. |
| **Delivery inspector** | Gemini vision compares a delivery photo with the agreed checklist. |
| **Resilience + observability** | Automatic fallback to **Gemini 2.5 Flash**; hedged grounded search; every agent step in the Activity log with model, latency and tokens; ADK OpenTelemetry spans to **Cloud Trace**. |

Measured on the live app (single runs, 18 Oct 2026): the voice agent answers ~2.5 s after you stop speaking; three
ideas drawn into a photo in ~60 s; 43 real listings for one idea's products in ~80 s; a 2.5-minute live AI phone call
turned into a checked quote. `tools/e2e_storyboard.py <url>` and `tools/e2e_features.py` run the journey against a
deployment and assert the guarantees (brief, search, fit checks, looks, outreach, orders).

## Google Cloud stack

- **Vertex AI / Agent Platform** (`aiplatform.googleapis.com`) - Gemini 3.8 Flash, Gemini 2.5 Flash (fast path and
  fallback), **Gemini Live 2.5 Flash native audio**, **Grounding with Google Search**, Gemini 3.1 Flash Image, Gemini
  2D object detection, Gemini Embedding 2, Gemini 2.5 Flash TTS; Agent Runtime **Sessions** and **Memory Bank**.
- **Vertex AI Search** (Discovery Engine website data store) - the store index over Indian retailers.
- **Google ADK 2.12** - `LlmAgent`s with output schemas and tools, graph `Workflow` with parallel fan-out and
  `JoinNode`, `Runner`, Vertex session and memory services, OpenTelemetry.
- **Cloud Run** - FastAPI + ADK backend, WebSockets for voice, camera and phone calls.
- **Firebase Hosting** - global CDN for the web app.
- **Firestore** - projects, immutable brief versions, options, messages, quotes, calls, live device sync.
- **Cloud Storage** - private media bucket (photos, ideas), served through the API.
- **Secret Manager** - channel credentials and the owner key, read at runtime (never in the repo).
- **Cloud Build + Artifact Registry**, **Cloud Logging + Cloud Trace**.
- **Identity** - one least-privilege runtime service account. **No API keys anywhere**; the app refuses to start if
  Gemini is not on Vertex AI.
- The demo film's music was made with **Lyria** and its narration with **Gemini TTS**.

## Architecture

```
Laptop · Phone · MetaGlass (React web app)        Makers: phone (Twilio) · WhatsApp · email
        │  Firebase Hosting (CDN)                          │
        └──────────────► Cloud Run: FastAPI ◄──────────────┘
                           │  ADK agents + graph Workflow
                           │  Gemini Live bridge (mic, camera, phone audio)
                           │  fit checker (deterministic)
        ┌──────────────────┼──────────────────────┬───────────────────┬──────────────────┐
  Gemini on Vertex AI   Vertex AI Search      Agent Platform        Firestore          Cloud Storage
  (Live, image, TTS,    + Google Search       Sessions +            (state, sync)      (media)
   embeddings)           grounding            Memory Bank
```

## Repository

```
app/                FastAPI app, services, fit checker (guard.py), live voice + phone bridge, Vertex clients
app/agents/         ADK agents (brief, design, shopper + maker scout, advisor, outreach, reply reader,
                    decision writer, recap, inspector, assistant) and the find-options graph Workflow
web/                React + TypeScript + Three.js front end (workspace, phone app, MetaGlass HUD)
deck/               Pitch deck (HTML source and PDF)
tools/              Provisioning, end-to-end tests, channel setup, media tooling
docs/               Hackathon brief, submission kit, channel setup, product blueprint
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
- Sellers receive only the brief - never the customer's name, number or address. Outgoing photos are privacy-scrubbed
  (metadata removed; faces, documents and addresses blurred).
- The call agent says it is an AI assistant. Messages and calls go out only after an explicit confirmation.
- Payment always happens on the store; Tesselle never sees or enters payment details.
- Ideas and practice content are always labelled; a cost guard caps daily model and image calls.

Built by team Mindflayer for the Google Cloud AI Builder Cup 2026 (Hack2Skill).
