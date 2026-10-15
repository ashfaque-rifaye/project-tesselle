"""Seed the labelled fictional catalogue: Gemini-rendered product images (Cloud Storage), Gemini
embeddings (Firestore vector field) and the demo desk photo. Idempotent; use --force to re-render.

    TESSELLE_IMPERSONATE=tesselle-runtime@tesselle-demandfoundry.iam.gserviceaccount.com \
      python -m tools.seed_catalog
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google.cloud.firestore_v1.vector import Vector  # noqa: E402

from app import catalog, gemini, store  # noqa: E402


def _exists(path: str) -> bool:
    return store.bucket().blob(path).exists()


async def render(path: str, prompt: str, force: bool, aspect: str = "4:3") -> None:
    if not force and _exists(path):
        print(f"  keep {path}")
        return
    img, mime, stats = await gemini.generate_image(prompt, purpose="catalog-seed", aspect_ratio=aspect)
    await store.upload_media(path, img, mime)
    print(f"  rendered {path} ({stats.latency_ms} ms)")


def item_text(item: dict) -> str:
    s = item.get("specs") or {}
    feats = ", ".join(s.get("features") or [])
    dims = f"{s.get('width_cm')} x {s.get('depth_cm')} x {s.get('height_cm')} cm" if s else ""
    return f"{item['name']}. {item.get('description', '')} Material {s.get('material', '')}. {dims}. Holds: {feats}."


async def main(force: bool) -> None:
    items = list(catalog.ITEMS.values())
    vectors = await gemini.embed([item_text(i) for i in items], purpose="catalog-seed")
    col = store.db().collection("catalog")
    for item, vec in zip(items, vectors):
        await col.document(item["id"]).set(
            {"id": item["id"], "route": item["route"], "name": item["name"], "seller_id": item["seller_id"],
             "embedding": Vector(vec), "demo_data": True}
        )
    print(f"embedded {len(items)} catalogue items")

    sem = asyncio.Semaphore(1)

    async def one(path: str, prompt: str, aspect: str = "4:3") -> None:
        async with sem:
            for attempt in range(6):
                try:
                    await render(path, prompt, force, aspect)
                    return
                except Exception as e:  # transient quota / safety retries
                    print(f"  retry {path}: {e}")
                    await asyncio.sleep(15 * (attempt + 1))

    await asyncio.gather(
        *(one(f"catalog/{i['id']}.png", i["image_prompt"]) for i in items),
        one("demo/desk.png", catalog.DEMO["desk_photo_prompt"], "4:3"),
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    asyncio.run(main(ap.parse_args().force))
