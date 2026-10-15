"""One-off: re-encode existing large PNG media in the bucket as progressive JPEG (same paths)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import store  # noqa: E402

for prefix in ("catalog/", "demo/"):
    for blob in store.bucket().list_blobs(prefix=prefix):
        if blob.content_type == "image/png" and blob.size > 250_000:
            data, ctype = store._compress(blob.download_as_bytes(), "image/png")
            blob.cache_control = "public, max-age=86400"
            blob.upload_from_string(data, content_type=ctype)
            print(f"{blob.name}: {blob.size // 1024} KB -> {len(data) // 1024} KB")
