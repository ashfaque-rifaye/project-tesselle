"""Google Cloud identity for every client (Vertex AI, Firestore, Cloud Storage, Agent Platform).

On Cloud Run this is the attached service account via the metadata server. Locally, setting
TESSELLE_IMPERSONATE makes the app act as that same service account, so permissions match
production exactly. No keys or API keys are ever used.
"""

from __future__ import annotations

import functools

from . import config


@functools.lru_cache(maxsize=1)
def credentials():
    if not config.IMPERSONATE:
        return None  # Application Default Credentials
    import google.auth
    from google.auth import impersonated_credentials

    source, _ = google.auth.default()
    return impersonated_credentials.Credentials(
        source_credentials=source,
        target_principal=config.IMPERSONATE,
        target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
