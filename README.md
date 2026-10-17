# Project Tesselle

**One agent for everything that has to fit.**

Project Tesselle is a personal shopping agent for the **Retail & Commerce** theme of the Google Cloud AI Builder
Cup 2026 - built for purchases that have to *fit*: a space, a device, a person, an occasion or a deadline.

Just talk to it - a **real-time voice agent (Gemini Live)** fills in the brief, searches, adds picks and moves
through the steps while it talks back - or use words, a photo, a short video, an AI-imagined picture or a capture
from smart glasses. Gemini agents turn that into a brief you can edit (and revert) at any time, search **real
stores** and **real makers** that deliver to your PIN code, check every option against your must-haves, show the
real products together - even inside a photo of your own room - with IKEA-style shoppable hotspots, **email or
phone makers for you** (with privacy-scrubbed photos), read their replies, and stop any seller change to a
must-have until *you* decide. Several picks become several orders: the **checkout agent** fills the store cart and
pre-enters your PIN code, you authorise payment, and the **order tracker** keeps your order history.

| | |
|---|---|
| **Live app (Firebase Hosting)** | https://project-tesselle.web.app |
| **Live app / API (Cloud Run)** | https://tesselle-448771854429.asia-southeast1.run.app |
| **Source code** | https://github.com/ashfaque-rifaye/project-tesselle |
| **Pitch deck** | [`deck/Project-Tesselle-Pitch-Deck.pdf`](deck/Project-Tesselle-Pitch-Deck.pdf) |
| **Guided demo** | Open the app → *Launch the guided demo* - it runs itself, live (about 8 minutes) |

> Honesty: listings and makers come from **live web search** and link to their real pages; prices and stock can
> change, so the app says "check the store page". Payment always happens on the store - Tesselle never sees or
> enters payment details. Messages and calls go out only after the customer confirms, and only from a device that
> holds the owner key (see [`docs/CHANNELS.md`](docs/CHANNELS.md)). The "practice reply" in the demo is written by
> Gemini and labelled as such - it never pretends to be a real business.

---

## The journey

1. **Start** - tap the voice orb and say it, or pick a way: describe it (type or talk - words appear as you
   speak), show a photo or video, use the camera, imagine it with Gemini (also by voice), or capture from MetaGlass
   Meta glasses. Delivery city **and PIN code** from your location (OpenStreetMap), a PIN code (India Post) or a
   saved place.
2. **Your brief** - the brief agent writes must-haves vs nice-to-haves (e.g. "max depth 18 cm", "no drilling");
   sizes seen in a photo stay "measure to confirm". Everything is editable in the side panel or by voice, at any step.
3. **Visualise** (optional) - a labelled concept; tap the picture to point at what to change. A visual edit that
   changes a size or material updates the brief and says exactly what changed, with one-tap **Revert**.
4. **Options** - the **shopping agent** finds real listings (IKEA, Flipkart, Amazon.in, Pepperfry, brand stores...)
   and the **maker scout** finds real workshops and made-to-order services near you. The **fit checker** (plain code)
   marks each one *fits / check a detail / doesn't fit*; a short summary says what was found.
   **Shop the look** composes the real products (from their real photos) into one picture - in your own room if you
   shared a photo - and Gemini locates each one, so every hotspot links to its listing. **In my space** edits your own
   photo to show one product in place (before / after).
5. **Reach out** (only when asking makers) - the **outreach agent** writes each message with privacy-scrubbed photos;
   pick a channel per maker - **email** from your connected inbox, an **AI phone call** by the call agent, or
   **WhatsApp** - and send from Tesselle.
6. **Replies** - email replies and call answers arrive by themselves (or paste / screenshot one); the **reply
   reader** extracts the offer and the fit checker compares it with your brief. A change to a must-have (e.g. a
   20 cm jig for an 18 cm shelf) is **blocked** until you decide; keeping it drafts your follow-up.
7. **Your picks** - add several options from different stores and makers; quantities; each pick is cleared by the
   fit checker; anything unconfirmed needs an explicit tick.
8. **Orders** - the **checkout agent** prepares each purchase: an Amazon cart with every Amazon pick, a pre-filled
   Shopify checkout (PIN code entered), or the product page with steps. You authorise payment on the store, paste
   the confirmation, and Gemini reads the order number and delivery date into your **order history** (which can also
   import store order emails from your inbox). "Changed my mind" cancels an order before delivery.
9. **Delivery check** - Gemini vision compares a photo with the checks you agreed, and says what a photo can't prove.

The steps adapt to what you do (buying from a store skips Reach out and Replies), each one says what it holds, and
**Back** is always on the bottom bar.

`tools/e2e_storyboard.py <url>` runs the journey against a deployment and asserts the guarantees.

## Gen AI implementation

| Agent / capability | How |
|---|---|
| **Brief agent** | ADK `LlmAgent` on **Gemini 3.8 Flash**, typed output schema; inputs: text, voice, photos, **video**, generated images. |
| **Shopping agent + maker scout** | **ADK 2 graph `Workflow`**: `prepare → (shopping_agent ‖ maker_scout) → JoinNode → advisor`. The shopping agent runs **Gemini with Grounding with Google Search** in parallel with a **Vertex AI Search** website store over ~45 Indian retailers (Amazon.in, Flipkart, IKEA India, Myntra, Croma, Nykaa, IndiaMART...), whose results arrive with the product photo from Google's index; prices come from each page's schema.org offer. For grounded results, each result line is tied to its cited page (grounding supports), the redirect is resolved to the real product or maker page, and the page's preview image is used. **Gemini Embedding 2** ranks results by relevance. |
| **Fit checker** | `app/guard.py` - deterministic requirement checks, verdicts, quote deviations and choose gates. LLMs only *explain* verdicts. |
| **Advisor** | Short, plain-language summary (headline, 2-4 bullets, best next step). |
| **Design agent** | Writes the art direction; **Gemini image generation** draws concepts, with tap-to-point refinements. |
| **Outreach agent** | Drafts quote requests and follow-ups; sends email from the connected inbox with attachments. Photos are re-encoded (no camera data / GPS) and Gemini finds faces, documents and addresses, which are blurred. |
| **Call agent** | A **real-time phone conversation**: Twilio Media Streams carry the call audio (8 kHz mu-law) over a WebSocket to Cloud Run, bridged to **Gemini Live** - natural, interruptible speech, live transcript. It says it is an AI assistant calling for a customer, asks the must-haves, price and lead time, never shares the customer's details, and the transcript becomes a checked quote. WhatsApp messages (with photos) go out through Twilio and replies flow straight back in. |
| **Adaptive brief + journey** | After every brief change Gemini lays out the panel for *this* purchase - the 3-6 facts that decide fit (blouse size and date; laptop model and wattage; quantity and print colours), how requirements group, and the likely path (buy, made for you, bulk sourcing), which shapes the step rail. |
| **Visual agent** | **Shop the look** (catalogue-style: dots on each product, price cards, add to picks, save): the best options plus companion products from the store index ("goes with it"), Gemini image generation composes the real product photos (and the customer's room photo) into one scene; Gemini then returns each product's bounding box, so the picture is shoppable. **In my space**: edits the customer's own photo to place a product. |
| **Checkout agent + order tracker** | Builds the fastest legitimate checkout per store (Amazon multi-item cart link, Shopify cart permalink with the PIN code pre-filled, or product page + steps); Gemini reads pasted confirmations and inbox order emails into the order history. |
| **Reply reader** | Turns a pasted reply, screenshot or PDF into a structured offer; decision cards explain any change. |
| **Voice agent (live)** | **Gemini Live (native audio, `gemini-live-2.5-flash-native-audio`)** over a WebSocket on Cloud Run: speech in, speech out, patient turn-taking (it waits for a real pause), session resumption plus a saved, replayable conversation so it continues where you left off on any device, and camera frames in MetaGlass mode so it sees what you see. It has the same 20 tools as the chat agent - start/edit the brief, budget, city + PIN, answer questions, notes, confirm, draw, find options, shop the look, add picks, place orders, draft/send messages, check replies, open any step - slow tools run in the background and it speaks the result when ready. |
| **Assistant (chat)** | The same tools as an ADK agent; the mic types your words (no voice notes); **Agent Platform Sessions + Memory Bank** keep one conversation across desktop, phone and glasses. |
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
- **Calm by default** - a hideable, adaptive step rail, a round Activity icon, a living voice orb in the corner.
- **Voice first** - tap the orb (a WebGL shader) and talk; it waits for you to finish, moves the screen once when its
  turn is done, and asks for a photo when one would help (a QR code opens your phone's camera on the project).
  The chat bubble opens the chat; the clock replays the conversation in your own (tidied) voice.
- **One project, every device** - phone, laptop and glasses mirror each other: the step, the scroll position and
  anything running; open the project anywhere and it continues where you left off. **MetaGlass mode** simulates
  smart glasses with the phone camera: a heads-up card, live voice and vision, "save this view".

## Google Cloud stack

- **Vertex AI / Agent Platform** (`aiplatform.googleapis.com`) - Gemini 3.8 Flash, Gemini 2.5 Flash (regional fast path and
  fallback), **Gemini Live 2.5 Flash native audio** (real-time voice agent), **Grounding with Google Search**, Gemini 3.1
  Flash Image (concepts, shop the look, in-my-space edits), Gemini 2D object detection (hotspots, privacy blur), Gemini
  Embedding 2, Gemini 2.5 Flash TTS; Agent Runtime with **Sessions** and **Memory Bank** (`asia-southeast1`).
- **Vertex AI Search** (Discovery Engine, website data store, Enterprise tier) - a store index over Indian retailers for listings with photos.
- **Secret Manager** - the owner's email app password, Twilio credentials and owner key, read at runtime (never in the repo).
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
- Payment always happens on the store; Tesselle never sees or enters payment details. The agents send messages,
  call or prepare orders only after an explicit confirmation, and never accept a seller's change to a must-have.
- Outgoing photos are privacy-scrubbed (metadata removed; faces, documents and addresses blurred) and only the brief
  is shared - never the customer's name, number or address. The call agent says it is an AI assistant.
- Concept and practice content is always labelled; a cost guard caps daily model and image calls.

Built for the Google Cloud AI Builder Cup 2026 (Hack2Skill).
