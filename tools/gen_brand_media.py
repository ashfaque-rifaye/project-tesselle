"""Generate the site's cinematic brand imagery with Gemini image generation (Vertex AI, billed to credits).

    python -m tools.gen_brand_media            # all
    python -m tools.gen_brand_media hero desk  # selected

Writes progressive JPEGs to web/public/media/. Every image is labelled in the UI as generated with Gemini.
"""
import asyncio
import io
import sys
from pathlib import Path

from PIL import Image

from app import gemini

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "media"

SHOTS = {
    "hero": (
        "16:9",
        "Cinematic wide photograph at blue hour. A small minimalist glass-walled maker's studio stands in a misty pine "
        "forest; warm amber light glows from inside, where a wooden workbench holds a slim bamboo desk organiser. Dense "
        "teal-grey fog drifts between tall pines, soft volumetric light, dew on moss in the foreground. Muted, desaturated "
        "palette of slate teal, spruce green and fog grey with warm ember-amber window light. The studio sits right of "
        "centre in the lower half; the upper-left third is calm fog and sky with plenty of negative space. Shot on 35mm, "
        "natural, editorial, photorealistic. No people, no text, no logos.",
    ),
    "desk": (
        "4:3",
        "Editorial product photograph: a slim bamboo desk organiser with a phone slot, a short pen cup and an A5 notebook "
        "tray sits on a narrow wall shelf above a desk; the phone is a plain unbranded matte slab shown screen-forward with a dark screen, beside a large window with soft misty morning fog outside. Warm "
        "amber morning light mixes with cool teal-grey daylight. Calm, minimal, muted slate and spruce tones with honey "
        "bamboo. Shallow depth of field, photorealistic. No text, no logos, no people.",
    ),
    "studio": (
        "4:3",
        "Close-up photograph inside a calm woodworking studio at dusk: a craftsperson's hands (no face visible) measure a "
        "bamboo panel with a steel ruler reading 16 cm, next to a pencil sketch of a desk organiser. Warm amber task lamp, "
        "cool misty teal light from a window, wood shavings, shallow depth of field, muted cinematic palette, "
        "photorealistic. No text overlays, no logos.",
    ),
}


async def make(name: str) -> None:
    aspect, prompt = SHOTS[name.removesuffix("-2k")]
    size = "2K" if name.endswith("-2k") else None
    data, mime, stats = await gemini.generate_image(prompt, purpose="brand-media", aspect_ratio=aspect, image_size=size)
    img = Image.open(io.BytesIO(data)).convert("RGB")
    if img.width > 2560:
        img = img.resize((2560, round(img.height * 2560 / img.width)), Image.LANCZOS)
    path = OUT / f"{name}.jpg"
    img.save(path, "JPEG", quality=84, progressive=True, optimize=True)
    print(f"{name}: {img.width}x{img.height} {path.stat().st_size // 1024} KB via {stats.model}")


async def main(names: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for n in names:
        await make(n)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or list(SHOTS)))
