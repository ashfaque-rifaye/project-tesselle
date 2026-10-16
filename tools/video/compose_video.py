"""Compose the submission demo video (<= 3 min) from the real recording.

  * agent-wait spans in the recording are sped up (clearly labelled "sped up") - nothing is faked;
  * a Canva AI intro clip and a closing card are added;
  * narration is generated with Gemini TTS on Vertex AI and placed at each beat;
  * captions are burned in for accessibility.

    python tools/video/compose_video.py tools/logs/video
"""

from __future__ import annotations

import json
import subprocess
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from google.genai import types  # noqa: E402

from app import gemini  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "tools/logs/video")
ROOT = Path(__file__).resolve().parents[2]
INTRO = ROOT / "assets" / "canva" / "canva-promo-sketch-to-bamboo.mp4"
FPS = 30
W, H = 1600, 900
MAX_WAIT = 1.6  # seconds each agent wait occupies in the final cut

NARRATION = {
    "intro": "Most shopping helps you buy what exists. Project Tesselle helps you get what you actually need.",
    "home": "It's a personal commerce agent built on Gemini, Google's Agent Development Kit, and Google Cloud.",
    "inspire": "I start with a photo of my desk and a few words: the shelf leaves eighteen centimetres, I rent, so no drilling, about three thousand rupees.",
    "clarify": "Gemini drafts a brief. MissionLock separates what must stay the same from what is flexible, and I confirm it.",
    "visualise": "The studio renders a concept, clearly labelled as an illustration. I pin an area and refine it, and the brief never changes silently.",
    "routes": "An ADK graph workflow checks every route in parallel, with vector search over Gemini embeddings. This gorgeous bamboo station is rejected: twenty-two centimetres deep.",
    "request": "So I ask a maker. I see exactly what they will receive. No name, no address, no photos of my home.",
    "counteroffer": "The maker proposes its standard twenty-centimetre jig. MissionLock blocks it.",
    "resolution": "I keep eighteen. The maker returns a revised layout that fits. The small price rise is a flexible decision, and it is mine.",
    "handoff": "I can continue on my phone. The same decision follows me, with a spoken recap.",
    "approve": "Approval is precise: one specification, one quote, one brief version. It is a sandbox order, so nothing is bought.",
    "fulfil": "Milestones and sample evidence stay tied to the approved brief.",
    "accept": "After delivery, Gemini vision checks the photo against the checks I approved, and tells me what a photo cannot prove.",
    "trace": "Every agent step is on the record, with model, latency and tokens.",
    "glasses": "And capture can start anywhere, even from smart glasses. Snap it, ask, and Tesselle answers out loud.",
    "outro": "Project Tesselle. Imagine it. Keep what matters. Get it made.",
}

CAPTION_TITLES = {
    "inspire": "1 · Inspiration", "clarify": "2 · Intent", "visualise": "3 · Concept", "routes": "4 · Existing stock",
    "request": "5 · Maker request", "counteroffer": "6 · Counteroffer", "resolution": "7 · Resolution",
    "handoff": "8 · Device handoff", "approve": "9 · Approval", "accept": "10 · Aftercare", "glasses": "Glasses capture",
}


def run(cmd: list[str]) -> None:
    out = Path(cmd[-1])
    if out.suffix == ".mp4" and out.name.startswith("seg") and out.exists() and out.stat().st_size > 0:
        return  # reuse rendered segment
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFMPEG FAILED:", r.stderr[-2000:])
        raise SystemExit(1)


def duration(p: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def tts(key: str, text: str) -> Path:
    p = OUT / f"vo-{key}.wav"
    if p.exists():
        return p
    resp = gemini.client().models.generate_content(
        model="gemini-2.5-flash-tts",
        contents=f"Narrate warmly and confidently, like a product demo, at a natural pace: {text}",
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            labels=gemini.labels("demo-video-voiceover"),
            speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Charon"))),
        ),
    )
    pcm = resp.candidates[0].content.parts[0].inline_data.data
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)
    return p


def ts(t: float) -> str:
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


def main() -> None:
    tl = json.loads((OUT / "timeline.json").read_text())
    raw = OUT / "raw.webm"
    raw_len = duration(raw)
    # The screencast drops frames under heavy load, so late timestamps run ahead of the video.
    # Correct linearly from the last verified-aligned beat (approve) to the end of the recording.
    drift = tl["end"] - raw_len
    anchor = next((m["t"] for m in tl["marks"] if m["beat"] == "approve"), tl["end"])

    def fix(t: float) -> float:
        return t if t <= anchor or drift <= 0 else t - (t - anchor) * drift / (tl["end"] - anchor)

    for m in tl["marks"]:
        m["t"] = fix(m["t"])
    for w in tl["waits"]:
        w["start"], w["end"] = fix(w["start"]), fix(w["end"])
    tl["end"] = raw_len
    mk = {m["beat"]: m["t"] for m in tl["marks"]}
    order = [m["beat"] for m in tl["marks"]]

    # 1. Cuts (repetitive footage) and agent waits (sped up, labelled).
    cuts = []
    if "home" in mk and "inspire" in mk:
        cuts.append((mk["home"] + 6.5, mk["inspire"] - 0.8))
    sample_end = max((w["end"] for w in tl["waits"] if w["label"] == "sample"), default=None)
    if sample_end and "accept" in mk:
        cuts.append((sample_end + 1.5, mk["accept"] - 0.8))
    waits = [(w["start"], w["end"]) for w in tl["waits"] if w["end"] - w["start"] > MAX_WAIT + 0.3]
    t_start, t_end = mk[order[0]] - 0.3, min(tl["end"], raw_len)
    pts = sorted({t_start, t_end, *[t for c in cuts for t in c], *[t for w in waits for t in w], *mk.values()})
    pts = [t for t in pts if t_start <= t <= t_end]

    def beat_at(t: float) -> str:
        b = order[0]
        for name in order:
            if mk[name] <= t + 1e-6:
                b = name
        return b

    intervals = []  # (a, b, speed, beat)
    for a, b in zip(pts, pts[1:]):
        if b - a < 0.04:
            continue
        mid = (a + b) / 2
        if any(c0 <= mid <= c1 for c0, c1 in cuts):
            continue
        w = next((w for w in waits if w[0] <= mid <= w[1]), None)
        sp = (w[1] - w[0]) / MAX_WAIT if w else 1.0
        intervals.append((a, b, sp, beat_at(a)))

    # 2. Narration durations -> per-beat freeze needed so voice and picture stay in sync.
    vo = {k: duration(tts(k, NARRATION[k])) for k in ["intro", *order] if k in NARRATION}
    vis: dict[str, float] = {}
    for a, b, sp, beat in intervals:
        vis[beat] = vis.get(beat, 0.0) + (b - a) / sp
    deficit = {beat: max(0.0, vo.get(beat, 0.0) + 0.7 - vis.get(beat, 0.0)) for beat in order}
    last_idx = {beat: i for i, (_, _, _, beat) in enumerate(intervals)}

    parts: list[Path] = []
    for i, (a, b, sp, beat) in enumerate(intervals):
        p = OUT / f"seg{i:03d}.mp4"
        vf = f"setpts=(PTS-STARTPTS)/{sp:.4f},fps={FPS},scale={W}:{H}"
        if sp > 1.01:
            vf += (f",drawbox=x=iw-330:y=ih-74:w=300:h=44:color=0x04060b@0.75:t=fill,"
                   f"drawtext=text='Gemini working - sped up x{sp:.0f}':x=w-315:y=h-60:fontsize=19:fontcolor=0x2ef2d0:fontfile='C\:/Windows/Fonts/consola.ttf'")
        if last_idx.get(beat) == i and deficit.get(beat, 0) > 0.05:
            vf += f",tpad=stop_mode=clone:stop_duration={deficit[beat]:.2f}"
        run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(raw), "-an", "-vf", vf,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(p)])
        parts.append(p)

    # 3. Intro (Canva AI clip + title, held long enough for its narration) and outro card.
    intro = OUT / "intro.mp4"
    intro_hold = max(0.0, vo.get("intro", 0) + 0.8 - duration(INTRO))
    run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(INTRO), "-an", "-vf",
         f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},tpad=stop_mode=clone:stop_duration={intro_hold:.2f},"
         "drawbox=x=0:y=0:w=iw:h=230:color=0x04060b@0.55:t=fill,"
         "drawtext=text='Project Tesselle':x=80:y=52:fontsize=74:fontcolor=white:fontfile='C\:/Windows/Fonts/seguisb.ttf',"
         "drawtext=text='Imagine it. Keep what matters. Get it made.':x=84:y=150:fontsize=30:fontcolor=0x2ef2d0:fontfile='C\:/Windows/Fonts/segoeui.ttf',"
         "fade=t=in:st=0:d=0.6",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(intro)])
    outro = OUT / "outro.mp4"
    lines = [
        ("Project Tesselle", 76, "white", 250), ("project-tesselle.web.app", 40, "0x2ef2d0", 360),
        ("Gemini 3.8 Flash · Gemini image, video, embeddings, TTS · Google ADK 2 agents + graph Workflow", 26, "0xc0cad9", 470),
        ("Agent Platform Sessions + Memory Bank · Cloud Run · Firestore vector search · Cloud Storage · Firebase Hosting", 26, "0xc0cad9", 515),
        ("Demo sellers are fictional and AI-simulated; orders are sandbox. Google Cloud AI Builder Cup 2026.", 22, "0x8b98ae", 640),
    ]
    dt = ",".join(f"drawtext=text='{t}':x=(w-text_w)/2:y={y}:fontsize={fs}:fontcolor={c}:fontfile='C\:/Windows/Fonts/segoeui.ttf'" for t, fs, c, y in lines)
    run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x04060b:s={W}x{H}:d=4.5:r={FPS}", "-vf",
         f"{dt},fade=t=in:st=0:d=0.5", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(outro)])

    # 4. Concatenate and compute exact beat start times from the rendered parts.
    lst = OUT / "concat.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in [intro, *parts, outro]))
    body = OUT / "body.mp4"
    run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(body)])
    beat_start: dict[str, float] = {"intro": 0.0}
    acc = duration(intro)
    for p, (_, _, _, beat) in zip(parts, intervals):
        beat_start.setdefault(beat, acc)
        acc += duration(p)
    total = duration(body)

    # 5. Narration at each beat start + burned-in captions.
    placed, srt = [], []
    for key in ["intro", *order]:
        if key not in NARRATION or key not in beat_start:
            continue
        st = beat_start[key] + (0.3 if key == "intro" else 0.25)
        placed.append((OUT / f"vo-{key}.wav", st))
        srt.append((st, st + vo[key], NARRATION[key], CAPTION_TITLES.get(key)))
    final_len = total
    srt_path = OUT / "captions.srt"
    srt_path.write_text("".join(f"{i + 1}\n{ts(s0)} --> {ts(e0)}\n{(t + ' - ') if t else ''}{txt}\n\n" for i, (s0, e0, txt, t) in enumerate(srt)), encoding="utf-8")
    narration = OUT / "narration.wav"
    inputs, filters = [], []
    for i, (wav, st) in enumerate(placed):
        inputs += ["-i", str(wav)]
        filters.append(f"[{i}:a]adelay={int(st * 1000)}|{int(st * 1000)},apad=whole_dur={final_len:.2f}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(placed))) + f"amix=inputs={len(placed)}:normalize=0:duration=longest[aout]"
    run(["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join([*filters, mix]),
         "-map", "[aout]", "-ar", "48000", "-ac", "2", "-t", f"{final_len:.2f}", str(narration)])
    sub = str(srt_path).replace("\\", "/").replace(":", "\:")
    final = OUT / "Project-Tesselle-demo.mp4"
    run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(body), "-i", str(narration),
         "-vf", f"subtitles='{sub}':force_style='FontName=Segoe UI,FontSize=15,PrimaryColour=&H00F8EFE9,BackColour=&H990B0604,BorderStyle=4,Outline=0,Shadow=0,MarginV=26'",
         "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", f"{final_len:.2f}", str(final)])
    print(f"final: {final} ({duration(final):.1f}s); freezes added: "
          + ", ".join(f"{k} +{v:.1f}s" for k, v in deficit.items() if v > 0.05))


if __name__ == "__main__":
    main()
