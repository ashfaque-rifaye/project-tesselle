# Project Tesselle - submission kit (Google Cloud AI Builder Cup 2026)

## Links

| Deliverable | Link / file |
|---|---|
| Live app (Firebase Hosting) | https://project-tesselle.web.app |
| Live app / API (Cloud Run) | https://tesselle-448771854429.asia-southeast1.run.app |
| Pitch deck (PDF) | `deck/Project-Tesselle-Pitch-Deck.pdf` |
| Demo video (2:42) | `submission/Project-Tesselle-demo.mp4` + `submission/Project-Tesselle-demo-captions.srt` (upload to YouTube/Drive and paste the link) |
| Public GitHub repo | https://github.com/ashfaque-rifaye/project-tesselle |
| Theme | Retail & Commerce |

## One-line pitch

Project Tesselle is a personal shopping agent for things that have to fit - it turns words, a photo, a video or a
glance through smart glasses into a brief, finds real stores and real makers that deliver to you, and never lets a
seller quietly change what you need.

## Short description (about 150 words)

Shoppers know exactly what they need, but similar-looking products often miss the one thing that mattered, and
seller counteroffers quietly rewrite requirements. Project Tesselle captures what you want multimodally (voice with
live speech-to-text, photos, video, Gemini-imagined concepts, Ray-Ban Meta captures) and Gemini agents turn it into a
brief you can edit and revert at any step - or you just talk to a real-time Gemini Live voice agent that fills it in
and drives the app. An ADK graph workflow runs a shopping agent and a maker scout in parallel using Gemini with
Grounding with Google Search, returning real listings and makers that deliver to your PIN code, each checked against
your must-haves by deterministic code. Gemini composes the real products into your own room photo with shoppable
hotspots. The outreach agent emails or phones makers with privacy-scrubbed photos; a reply reader checks the answers
and blocks any change to a must-have until you decide. Several picks become several orders the checkout agent
prepares, and an order tracker keeps your history.

## Google Cloud stack used

- **Gemini on Vertex AI / Agent Platform** - Gemini 3.8 Flash (reasoning; text, audio, image, video), Gemini 2.5 Flash
  (regional fast path and automatic fallback), **Gemini Live 2.5 Flash native audio** (real-time voice agent with tools),
  **Grounding with Google Search** (real listings and makers), Gemini 3.1 Flash Image (concepts, imagine-it, shop the
  look, in-my-space edits), Gemini 2D detection (shoppable hotspots, privacy blur), Gemini Embedding 2 (relevance
  ranking), Gemini 2.5 Flash TTS.
- **Secret Manager** - outreach channel credentials and the owner key, read at runtime.
- **Google Agent Development Kit (ADK 2.12)** - ten `LlmAgent`s with typed outputs and function tools; a graph `Workflow`
  with parallel fan-out and a `JoinNode`; `Runner`; Vertex session and memory services; OpenTelemetry.
- **Agent Platform Agent Runtime** - managed **Sessions** (one conversation per project across devices) and **Memory
  Bank** (durable preferences) in asia-southeast1.
- **Cloud Run** - FastAPI backend and web app with streaming agent progress.
- **Firebase Hosting** - CDN front end.
- **Firestore** - projects, immutable brief versions, options, messages, quotes, choices, activity.
- **Cloud Storage** - private media bucket.
- **Cloud Build + Artifact Registry** - container builds.
- **Cloud Logging, Cloud Trace, Telemetry API** - operations and ADK agent traces.
- **IAM** - a least-privilege runtime service account; no API keys anywhere.

## Judging criteria map

| Criterion | Where to look |
|---|---|
| Technical merit & Gen AI (40%) | ADK agents + graph workflow, grounded web search tied to cited pages, deterministic fit checker, Gemini Live voice agent with 20 tools, shoppable image generation + detection, privacy-scrubbing vision, call agent, checkout agent, Memory Bank, embeddings ranking, model fallback, Cloud Trace |
| Problem alignment & impact (25%) | Retail & Commerce: real options that fit, real makers when nothing fits, honest "nothing fits" outcomes |
| Innovation (25%) | Intent preservation as a versioned object; seller changes become customer decisions; glasses-to-agent capture; a demo that runs itself |
| UX (10%) | Liquid-glass design, one clear next step, editable brief everywhere, live agent status, phone app, accessibility labels |

## Honesty notes for judges

Listings and makers come from live web search and link to their real pages; prices and stock can change. Payment
always happens on the store (the checkout agent fills carts and pre-enters the PIN code; it never handles payment).
Emails and calls go out only after an explicit confirmation and only from a device holding the owner key, so the public
demo cannot send from the owner's inbox; WhatsApp opens ready to send. The practice reply used in the guided demo is written by
Gemini and clearly labelled. Smart-glasses capture works through the phone share sheet (PWA share target) and a
heads-up capture view; direct streaming from Ray-Ban Meta needs Meta's native SDK (roadmap).
