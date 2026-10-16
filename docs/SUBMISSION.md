# Project Tesselle — submission kit (Google Cloud AI Builder Cup 2026)

## Links

| Deliverable | Link / file |
|---|---|
| Live app (Firebase Hosting) | https://project-tesselle.web.app |
| Live app / API (Cloud Run) | https://tesselle-448771854429.asia-southeast1.run.app |
| Pitch deck (PDF) | `deck/Project-Tesselle-Pitch-Deck.pdf` |
| Demo video (≤ 3 min) | `Project-Tesselle-demo.mp4` (upload to YouTube/Drive and paste the link) |
| Public GitHub repo | *(push when ready — see README)* |
| Theme | Retail & Commerce |

## One-line pitch

Project Tesselle is a personal commerce agent that turns any spark — words, a photo, a video or a glance through
smart glasses — into a protected brief, then finds a credible way to buy, source or make it without ever silently
changing what the customer needs.

## Short description (≈150 words)

Shoppers can imagine exactly what they want, but similar-looking products often fail the one requirement that
mattered, and seller counteroffers quietly rewrite intent. Project Tesselle captures inspiration multimodally (voice,
photos, video, Gemini-imagined concepts, smart-glasses captures) and turns it into a versioned MissionLock brief that
the customer confirms. An ADK graph workflow checks buy, source, customise and make routes in parallel using Firestore
vector search over Gemini embeddings; a deterministic guard decides every fit verdict and blocks any seller change to
a must-have (for example a 20 cm counteroffer against an 18 cm shelf), turning it into an explicit decision. The same
brief carries through a precise sandbox approval, fulfilment milestones and a Gemini-vision delivery check.
Agent Platform Sessions and Memory Bank keep the journey continuous across desktop, phone and glasses, with spoken
recaps via Gemini TTS.

## Google Cloud stack used

- **Gemini on Vertex AI / Agent Platform** — Gemini 3.8 Flash (reasoning, multimodal: text, audio, image, video),
  Gemini 3.1 Flash Image (concepts, proposals, sample evidence, imagine-it), Gemini Embedding 2 (catalogue vectors),
  Gemini 2.5 Flash TTS (spoken replies and recaps).
- **Google Agent Development Kit (ADK 2.12)** — nine `LlmAgent`s with typed output schemas and function tools; a graph
  `Workflow` with parallel fan-out and a `JoinNode`; `Runner`; Vertex session and memory services; OpenTelemetry.
- **Agent Platform Agent Runtime** — managed **Sessions** (per-project conversation across devices) and **Memory Bank**
  (durable customer preferences) in asia-southeast1.
- **Cloud Run** — FastAPI backend and web app with streaming agent progress.
- **Firebase Hosting** — CDN front end (https://project-tesselle.web.app).
- **Firestore** — projects, immutable brief versions, quotes, orders, event trace, and **vector search** index.
- **Cloud Storage** — private media bucket.
- **Cloud Build + Artifact Registry** — container builds.
- **Cloud Logging, Cloud Trace, Telemetry API** — operations and ADK agent traces.
- **IAM** — a least-privilege runtime service account; no API keys anywhere.

## Judging criteria map

| Criterion | Where to look |
|---|---|
| Technical merit & Gen AI (40%) | ADK agents + graph workflow, deterministic MissionLock guard, multimodal intake incl. video, Memory Bank, TTS, vector search, in-app evidence trace, Cloud Trace |
| Problem alignment & impact (25%) | Retail & Commerce: unmet demand → structured maker requests; honest no-match outcomes |
| Innovation (25%) | Intent preservation as a first-class, versioned object; seller deviations become customer decisions; glasses-to-agent capture |
| UX (10%) | Liquid-glass "Mist & Volt" design system: cinematic Gemini-generated hero with a refractive Three.js glass gem, Dynamic-Island live agent status, stage tracker, intent-integrity gauge, fit-grade rings, spring View Transitions, phone and glasses surfaces, accessibility labels |

## Honesty notes for judges

All sellers, prices and stock levels are fictional demonstration data; maker responses are AI-simulated and labelled;
orders are sandbox. Smart-glasses capture works through the phone share sheet (PWA share target) and a heads-up
capture view using the phone camera; direct streaming from Ray-Ban Meta requires Meta's native SDK (roadmap).
