"""Vertex AI credit-safety smoke test for Project Tesselle.

Makes labelled Gemini calls strictly through Vertex AI (aiplatform.googleapis.com)
on the credit-backed project, so the spend can be traced in Billing reports by label.

Refuses to run if anything could route traffic to the AI Studio endpoint
(generativelanguage.googleapis.com), which the promotional credit does not cover.

Usage:
    python tools/vertex_credit_check.py --calls 1
    python tools/vertex_credit_check.py --calls 60 --interval 5 --model gemini-3.8-flash
    python tools/vertex_credit_check.py --project tesselle-demandfoundry \
        --impersonate tesselle-runtime@tesselle-demandfoundry.iam.gserviceaccount.com
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from google import genai
from google.genai import types

ALLOWED_PROJECTS = {"ai-pro-developer", "tesselle-demandfoundry"}  # both on the credit-backed AI Pro billing account
LOCATION = "global"
LABELS = {"app": "tesselle", "purpose": "credit-check"}
LOG_DIR = Path(__file__).resolve().parent / "logs"

PROMPTS = [
    "In three sentences, explain how a tessellation tiles a plane without gaps.",
    "List five real-world uses of agentic AI in enterprise productivity, one line each.",
    "Summarise the trade-offs between Firestore and Cloud SQL for a hackathon prototype.",
    "Write a 60-word product pitch for an AI tool that turns meeting notes into tasks.",
    "Give a short JSON object describing a fictional customer with name, city and plan.",
]


def guard_against_ai_studio() -> None:
    for var in ("GOOGLE_API_KEY", "GEMINI_API_KEY"):
        if os.environ.get(var):
            sys.exit(f"Refusing to run: {var} is set and could route calls to AI Studio.")


def build_client(project: str, impersonate: str | None) -> genai.Client:
    if project not in ALLOWED_PROJECTS:
        sys.exit(f"Refusing to run: {project!r} is not a known credit-backed project.")
    credentials = None
    if impersonate:
        import google.auth
        from google.auth import impersonated_credentials

        source, _ = google.auth.default()
        credentials = impersonated_credentials.Credentials(
            source_credentials=source,
            target_principal=impersonate,
            target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
    client = genai.Client(vertexai=True, project=project, location=LOCATION, credentials=credentials)
    api = client._api_client
    base_url = (api._http_options.base_url or "") if api._http_options else ""
    if not api.vertexai or "aiplatform.googleapis.com" not in base_url:
        sys.exit(f"Refusing to run: client is not on Vertex AI (base_url={base_url!r}).")
    if api.project != project:
        sys.exit(f"Refusing to run: client project is {api.project!r}, expected {project!r}.")
    who = impersonate or "user ADC"
    print(f"Vertex AI client OK -> {base_url} project={api.project} location={api.location} as={who}")
    return client


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="gemini-3.8-flash")
    parser.add_argument("--calls", type=int, default=1)
    parser.add_argument("--interval", type=float, default=0.0, help="seconds between calls")
    parser.add_argument("--project", default="ai-pro-developer")
    parser.add_argument("--impersonate", help="service account email to call Vertex AI as")
    args = parser.parse_args()

    guard_against_ai_studio()
    client = build_client(args.project, args.impersonate)

    LOG_DIR.mkdir(exist_ok=True)
    log_path = LOG_DIR / f"credit-check-{args.project}-{datetime.now():%Y%m%d-%H%M%S}.jsonl"
    totals = {"ok": 0, "err": 0, "prompt_tokens": 0, "output_tokens": 0, "thought_tokens": 0}

    with log_path.open("w", encoding="utf-8") as log:
        for i in range(args.calls):
            prompt = PROMPTS[i % len(PROMPTS)]
            started = time.perf_counter()
            record = {"ts": datetime.now(timezone.utc).isoformat(), "i": i, "model": args.model}
            try:
                resp = client.models.generate_content(
                    model=args.model,
                    contents=prompt,
                    config=types.GenerateContentConfig(labels=LABELS, max_output_tokens=512),
                )
                usage = resp.usage_metadata
                record.update(
                    ok=True,
                    latency_s=round(time.perf_counter() - started, 2),
                    prompt_tokens=usage.prompt_token_count or 0,
                    output_tokens=usage.candidates_token_count or 0,
                    thought_tokens=usage.thoughts_token_count or 0,
                    model_version=resp.model_version,
                    preview=(resp.text or "")[:80],
                )
                totals["ok"] += 1
                for key in ("prompt_tokens", "output_tokens", "thought_tokens"):
                    totals[key] += record[key]
            except Exception as exc:  # keep going so one 429/503 doesn't end the run
                record.update(ok=False, error=f"{type(exc).__name__}: {str(exc)[:300]}")
                totals["err"] += 1
            log.write(json.dumps(record) + "\n")
            log.flush()
            print(json.dumps(record))
            if args.interval and i < args.calls - 1:
                time.sleep(args.interval)

    print(f"\nTotals: {json.dumps(totals)}")
    print(f"Log: {log_path}")


if __name__ == "__main__":
    main()
