"""Runtime configuration. Everything here is non-secret; identity comes from the Cloud Run
service account (or ADC / impersonation locally), never from API keys."""

import os

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "tesselle-demandfoundry")
REGION = os.environ.get("TESSELLE_REGION", "asia-southeast1")

# Gemini is always reached through Vertex AI / Agent Platform (aiplatform.googleapis.com) so usage
# bills to the project's billing account and its credits. See docs/gcp/GCP_SETUP.md.
GEMINI_LOCATION = os.environ.get("TESSELLE_GEMINI_LOCATION", "global")
MODEL_REASONING = os.environ.get("TESSELLE_MODEL", "gemini-3.8-flash")
MODEL_IMAGE = os.environ.get("TESSELLE_IMAGE_MODEL", "gemini-3.1-flash-image")
MODEL_EMBED = os.environ.get("TESSELLE_EMBED_MODEL", "gemini-embedding-2")
MODEL_TTS = os.environ.get("TESSELLE_TTS_MODEL", "gemini-2.5-flash-tts")
# Fast regional model: grounded web search, structuring, and automatic fallback when the primary
# model is slow or rate-limited. Served from the same region as Cloud Run.
MODEL_FAST = os.environ.get("TESSELLE_FAST_MODEL", "gemini-2.5-flash")
FAST_LOCATION = os.environ.get("TESSELLE_FAST_LOCATION", "asia-southeast1")
EMBED_DIM = 768

# Agent Platform runtime that hosts the assistant's Sessions + Memory Bank
# (created by tools/provision_agent_platform.py).
AGENT_ENGINE_ID = os.environ.get("TESSELLE_AGENT_ENGINE_ID", "2548870263324278784")
AGENT_ENGINE_LOCATION = os.environ.get("TESSELLE_AGENT_ENGINE_LOCATION", REGION)

MEDIA_BUCKET = os.environ.get("TESSELLE_MEDIA_BUCKET", "tesselle-demandfoundry-media")

# Local development only: impersonate the production service account so local runs use the
# exact same identity and permissions as Cloud Run.
IMPERSONATE = os.environ.get("TESSELLE_IMPERSONATE")

# Cost guard for the public judging window: generous for a demo, bounded for credits.
DAILY_LLM_CALL_CAP = int(os.environ.get("TESSELLE_DAILY_LLM_CAP", "4000"))
DAILY_IMAGE_CAP = int(os.environ.get("TESSELLE_DAILY_IMAGE_CAP", "400"))
VISITOR_IMAGE_CAP_PER_HOUR = int(os.environ.get("TESSELLE_VISITOR_IMAGE_CAP", "20"))

STATIC_DIR = os.environ.get(
    "TESSELLE_STATIC_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "dist"),
)
