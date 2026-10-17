"""Visual agent: see real products together and in the customer's own space, and keep photos private.

* Shop the look - Gemini image generation composes a scene from the REAL product photos of the options
  found (and the customer's space photo when there is one); Gemini then locates each product in the
  result (2D bounding boxes) so the picture is shoppable: every hotspot links to the real listing.
* Try it in my space - Gemini edits the customer's own photo to place one chosen product in it, with a
  before / after view.
* Privacy scrub - before any photo leaves Tesselle (attachments to sellers), it is re-encoded (camera
  metadata and GPS removed) and Gemini finds faces, documents, screens and addresses, which are blurred.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
from typing import Any, Literal, Optional

from google.genai import types
from pydantic import BaseModel, Field

from . import gemini, store
from .models import now_iso

log = logging.getLogger(__name__)


class Box(BaseModel):
    index: int = Field(description="Index of the product in the list given.")
    box_2d: list[int] = Field(description="[ymin, xmin, ymax, xmax] normalised to 0-1000.")
    confidence: Literal["high", "medium", "low"] = "medium"


class Located(BaseModel):
    items: list[Box]


class PiiRegion(BaseModel):
    kind: Literal["face", "person", "document", "screen", "address", "name", "phone_number", "license_plate", "other"]
    box_2d: list[int] = Field(description="[ymin, xmin, ymax, xmax] normalised to 0-1000.")


class PiiScan(BaseModel):
    regions: list[PiiRegion]


def _jpeg(data: bytes, max_side: int = 1600) -> tuple[bytes, tuple[int, int]]:
    from PIL import Image, ImageOps

    im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    im.thumbnail((max_side, max_side))
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=86, optimize=True)  # no EXIF written: metadata and GPS are gone
    return out.getvalue(), im.size


def _blur(data: bytes, boxes: list[list[int]]) -> bytes:
    from PIL import Image, ImageFilter

    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    for b in boxes:
        if len(b) != 4:
            continue
        y0, x0, y1, x1 = [max(0, min(1000, v)) for v in b]
        box = (int(x0 / 1000 * w), int(y0 / 1000 * h), int(x1 / 1000 * w), int(y1 / 1000 * h))
        if box[2] - box[0] < 4 or box[3] - box[1] < 4:
            continue
        region = im.crop(box).filter(ImageFilter.GaussianBlur(radius=max(8, (box[2] - box[0]) // 8)))
        im.paste(region, box)
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=86)
    return out.getvalue()


async def scrub(data: bytes, mime: str) -> tuple[bytes, str, dict[str, Any]]:
    """Privacy-safe copy of a photo for sharing: metadata removed, faces / documents / addresses blurred."""
    clean, _ = await asyncio.to_thread(_jpeg, data)
    report: dict[str, Any] = {"metadata_removed": True, "blurred": [], "checked_by": "Gemini"}
    try:
        scan, _ = await gemini.generate_structured(PiiScan, [
            types.Part.from_bytes(data=clean, mime_type="image/jpeg"),
            "This photo will be sent to a business. Find anything that could identify the person who took it: faces or "
            "people, documents, letters or parcels with names or addresses, screens showing personal information, phone "
            "numbers, house or flat numbers, vehicle number plates. Return each region's box. Return no regions for "
            "ordinary furniture, rooms or products.",
        ], purpose="privacy-scan", fast=True)
        boxes = [r.box_2d for r in scan.regions]
        if boxes:
            clean = await asyncio.to_thread(_blur, clean, boxes)
        report["blurred"] = [r.kind for r in scan.regions]
    except Exception as e:  # if the scan fails, the photo is not shared
        log.warning("privacy scan failed: %s", e)
        raise RuntimeError("Couldn't check this photo for personal details, so it won't be shared.") from e
    return clean, "image/jpeg", report


async def shareable_copy(pid: str, path: str, label: str) -> dict[str, Any]:
    """Scrubbed copy of a project image, stored once and reused for every message."""
    key = hashlib.sha1(path.encode()).hexdigest()[:12]
    out_path = f"projects/{pid}/outbox/{key}.jpg"
    cached = await store.get(pid, "outbox", key)
    if cached:
        return cached
    data, mime = await store.download_media(path)
    clean, cmime, report = await scrub(data, mime)
    await store.upload_media(out_path, clean, cmime)
    att = {"id": key, "path": out_path, "source": path, "label": label, "privacy": report, "created_at": now_iso()}
    await store.put(pid, "outbox", key, att)
    return att


def _centre(b: list[int]) -> tuple[float, float]:
    y0, x0, y1, x1 = b
    return round((x0 + x1) / 2000, 4), round((y0 + y1) / 2000, 4)


async def _locate(image: bytes, mime: str, names: list[str]) -> list[Box]:
    try:
        out, _ = await gemini.generate_structured(Located, [
            types.Part.from_bytes(data=image, mime_type=mime),
            "Products that should appear in this picture:\n" + "\n".join(f"{i}: {n}" for i, n in enumerate(names)),
            "For each product you can see, return its index and its bounding box. Skip products that are not visible.",
        ], purpose="look-locator", fast=True)
        return [b for b in out.items if 0 <= b.index < len(names) and len(b.box_2d) == 4]
    except Exception as e:
        log.info("locating products failed: %s", e)
        return []


async def shop_the_look(pid: str, entries: list[dict[str, Any]], space: Optional[tuple[bytes, str]], fetch) -> dict[str, Any]:
    """One picture of real options together - in the customer's space if they shared one - with hotspots."""
    imgs = await asyncio.gather(*(fetch(e["image_url"]) for e in entries))
    picked = [(e, im) for e, im in zip(entries, imgs) if im][:4]
    if not picked:
        raise RuntimeError("None of these listings has a product photo Tesselle could read.")
    refs: list[tuple[bytes, str]] = []
    if space:
        refs.append(space)
    refs += [im for _, im in picked]
    listing = "\n".join(f"- Product {i + 1}: {e['name']} (from {e['seller_name']})" for i, (e, _) in enumerate(picked))
    where = ("Edit the FIRST reference photo - the customer's own space - and place these products into it where they would "
             "naturally be used. Keep the room, camera angle and light of that photo." if space else
             "Show them in a bright, realistic home setting where they would naturally be used.")
    prompt = (f"Photorealistic lifestyle photo featuring exactly these real products:\n{listing}\n"
              f"The product reference photos follow{' the space photo' if space else ''}, in the same order. {where} "
              "Reproduce each product faithfully - same shape, colour, material, proportions and details as its reference "
              "photo - so a shopper recognises it. Each product appears once and is clearly visible. No text, labels, logos, "
              "price tags or people.")
    image, mime, stats = await gemini.generate_image(prompt, purpose="shop-the-look", reference_images=refs, aspect_ratio="4:3")
    lid = store.new_id("look")
    path = await store.upload_media(f"projects/{pid}/looks/{lid}", image, mime)
    boxes = await _locate(image, mime, [e["name"] for e, _ in picked])
    items = []
    for i, (e, _) in enumerate(picked):
        b = next((x for x in boxes if x.index == i), None)
        x, y = _centre(b.box_2d) if b else (None, None)
        items.append({"entry_id": e["item_id"], "name": e["name"], "seller_name": e["seller_name"], "seller_id": e.get("seller_id"),
                      "price_inr": e.get("price_inr"), "url": e.get("url"), "image_url": e.get("image_url"),
                      "x": x, "y": y, "box": b.box_2d if b else None, "verdict": e.get("verdict")})
    look = {"id": lid, "kind": "look", "image_path": path, "items": items, "in_space": bool(space), "created_at": now_iso(),
            "note": "Made by Gemini from the real product photos - check exact sizes on each store page."}
    await store.put(pid, "looks", lid, look)
    return {"look": look, "stats": stats.as_dict()}


async def try_in_space(pid: str, entry: dict[str, Any], space: tuple[bytes, str], space_path: str, brief_sizes: str, fetch) -> dict[str, Any]:
    """The customer's own photo, with the chosen product placed in it (before / after)."""
    product = await fetch(entry["image_url"]) if entry.get("image_url") else None
    if not product:
        raise RuntimeError("This listing has no product photo Tesselle could read - open it on the store page instead.")
    prompt = ("The first image is a photo of the customer's own space. The second image is a real product: "
              f"{entry['name']} from {entry['seller_name']}. Edit the FIRST photo to show this exact product placed where it "
              "would naturally go and be used. Keep everything else in the photo exactly as it is - same objects, camera, "
              "framing and light. Keep the product faithful to its photo (shape, colour, material, details) and at a "
              f"realistic scale for the space{' (' + brief_sizes + ')' if brief_sizes else ''}. Photorealistic. No text or logos.")
    image, mime, stats = await gemini.generate_image(prompt, purpose="try-in-space", reference_images=[space, product], aspect_ratio="4:3")
    lid = store.new_id("look")
    path = await store.upload_media(f"projects/{pid}/looks/{lid}", image, mime)
    boxes = await _locate(image, mime, [entry["name"]])
    b = boxes[0] if boxes else None
    x, y = _centre(b.box_2d) if b else (None, None)
    look = {"id": lid, "kind": "space", "image_path": path, "before_path": space_path, "in_space": True, "created_at": now_iso(),
            "items": [{"entry_id": entry["item_id"], "name": entry["name"], "seller_name": entry["seller_name"],
                       "seller_id": entry.get("seller_id"), "price_inr": entry.get("price_inr"), "url": entry.get("url"),
                       "image_url": entry.get("image_url"), "x": x, "y": y, "box": b.box_2d if b else None, "verdict": entry.get("verdict")}],
            "note": "Your photo, edited by Gemini to show this product - a preview, not a measurement."}
    await store.put(pid, "looks", lid, look)
    return {"look": look, "stats": stats.as_dict()}
