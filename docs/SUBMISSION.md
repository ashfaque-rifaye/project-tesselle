# Project Tesselle - submission kit (Google Cloud AI Builder Cup 2026)

## Links

| Deliverable | Link / file |
|---|---|
| Live app (Firebase Hosting) | https://project-tesselle.web.app |
| Live app / API (Cloud Run) | https://tesselle-448771854429.asia-southeast1.run.app |
| Pitch deck (PDF) | `deck/Project-Tesselle-Pitch-Deck.pdf` |
| Demo video (2:54) | https://project-tesselle.web.app/demo/tesselle-demo.mp4 |
| Public GitHub repo | https://github.com/ashfaque-rifaye/project-tesselle |
| Theme | Retail & Commerce |
| Team | Mindflayer: Ashfaque Rifaye (lead), Vasanth Kumar |

## One-line pitch

Project Tesselle is a personal shopping agent for things that have to fit - it turns words, a photo, a video or a
glance through smart glasses into a brief, finds real stores and real makers that deliver to you, and never lets a
seller quietly change what you need.

## Brief description

Tesselle is a voice-first shopping agent for things that have to fit: a desk organiser for a cramped desk, 500 printed tote bags for an event. You say it, show a photo, or look through simulated smart glasses. It writes a brief of your must-haves, plans the steps, draws ideas into your own photo and finds real products from Indian stores that deliver to your PIN. If nothing fits, it finds real makers, emails them and phones them with an AI voice agent that gets a quote. Every option is checked against your must-haves; a checkout agent fills the cart and you place the order.

Google services: Gemini 3 Flash on Vertex AI (briefs, planning, vision); Gemini Live (voice assistant, glasses camera, live phone calls); Gemini image (ideas in your photo, shop the look); Gemini TTS; Vertex AI Search and Grounding with Google Search; ADK multi-agent system with Agent Engine Sessions and Memory Bank; Cloud Run, Firebase Hosting, Firestore, Cloud Storage, Secret Manager, Cloud Build.

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
Gemini and clearly labelled. MetaGlass mode simulates smart glasses with the phone or laptop camera; direct streaming
from real glasses needs the maker's native SDK (roadmap).
