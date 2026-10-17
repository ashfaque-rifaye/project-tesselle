"""Compose the submission demo video (<= 3 min) from a recording of the self-running guided demo.

  * the footage is the real app: live Gemini agents and live web search (tools/video/record_pilot.mjs);
  * time while agents work is sped up and labelled "sped up" - nothing is faked;
  * each on-screen demo caption is narrated with Gemini TTS on Vertex AI;
  * an intro and a closing card are added.

    python tools/video/compose_pilot.py tools/logs/video
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
FPS, W, H = 30, 1600, 900
WAIT_SHOWN = 2.2   # seconds each agent wait occupies in the final cut
MAX_SPEED = 2.6    # cap for speeding up ordinary (non-waiting) footage
FONT = "C\\:/Windows/Fonts/segoeui.ttf"
FONT_B = "C\\:/Windows/Fonts/seguisb.ttf"

INTRO_VO = "Shopping for something that has to fit? Meet Tesselle - a personal shopping agent built with Gemini and Google Cloud."
HOME_VO = "This is the live app. The guided demo runs itself - real agents, real web search, nothing pre-recorded."
OUTRO_VO = "Tesselle. Imagine it. Keep what matters. Get it made."


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFMPEG FAILED:", " ".join(cmd)[:400], "\n", r.stderr[-2000:])
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
        contents=f"Narrate warmly and clearly, like a friendly product demo, at a brisk natural pace: {text}",
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


def _ts(t: float) -> str:
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


def esc(t: str) -> str:
    return t.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")


def main() -> None:
    tl = json.loads((OUT / "timeline.json").read_text(encoding="utf-8"))
    raw = OUT / "raw.webm"
    raw_len = duration(raw)
    scale = min(1.0, raw_len / tl["end"]) if tl["end"] > 0 else 1.0  # screencast can drop frames under load
    marks = [dict(m, t=m["t"] * scale) for m in tl["marks"]]
    waits = [(w["start"] * scale, w["end"] * scale) for w in tl["waits"] if w["end"] - w["start"] > WAIT_SHOWN + 0.4]
    end = min(raw_len, tl["end"] * scale)

    # Beats: home (trimmed), then each demo caption until the next.
    beats = []
    for i, m in enumerate(marks):
        a = m["t"] if i else max(0.3, m["t"] - 1.0)  # home: start once the page (and its 3D scene) has loaded
        b = marks[i + 1]["t"] if i + 1 < len(marks) else end
        vo_text = HOME_VO if i == 0 else m["text"]
        beats.append({"key": f"b{i:02d}", "a": a, "b": b, "vo": vo_text, "title": m["title"]})
    for bt in beats:
        bt["vo_len"] = duration(tts(bt["key"], bt["vo"])) if bt["vo"] else 0.0

    # Plan each beat: waits squeezed to WAIT_SHOWN; ordinary footage sped up (capped) so the beat ~ its narration.
    pieces = []  # (a, b, speed, is_wait, beat_key)
    for bt in beats:
        pts = sorted({bt["a"], bt["b"], *[t for w in waits for t in w if bt["a"] < t < bt["b"]]})
        segs = []
        for a, b in zip(pts, pts[1:]):
            if b - a < 0.05:
                continue
            mid = (a + b) / 2
            w = next((w for w in waits if w[0] <= mid <= w[1]), None)
            segs.append((a, b, w is not None))
        wait_time = sum(WAIT_SHOWN * (b - a) / (w[1] - w[0]) for a, b, iw in segs if iw for w in [next(w for w in waits if w[0] <= (a + b) / 2 <= w[1])])
        plain = sum(b - a for a, b, iw in segs if not iw)
        target = max(bt["vo_len"] + 0.9, wait_time + 1.2)
        sp = max(1.0, min(MAX_SPEED, plain / max(0.6, target - wait_time))) if plain > 0 else 1.0
        bt["shown"] = wait_time + plain / sp
        bt["pad"] = max(0.0, bt["vo_len"] + 0.6 - bt["shown"])
        for a, b, iw in segs:
            if iw:
                w = next(w for w in waits if w[0] <= (a + b) / 2 <= w[1])
                pieces.append((a, b, (w[1] - w[0]) / WAIT_SHOWN, True, bt["key"]))
            else:
                pieces.append((a, b, sp, False, bt["key"]))

    est = sum(bt["shown"] + bt["pad"] for bt in beats)
    print(f"raw {raw_len:.0f}s -> body about {est:.0f}s over {len(beats)} beats")

    parts: list[Path] = []
    last_of_beat = {k: i for i, (*_, k) in enumerate(pieces)}
    pad_of = {bt["key"]: bt["pad"] for bt in beats}
    for i, (a, b, sp, iw, key) in enumerate(pieces):
        p = OUT / f"seg{i:03d}.mp4"
        vf = f"setpts=(PTS-STARTPTS)/{sp:.4f},fps={FPS},scale={W}:{H}"
        if iw and sp > 1.5:
            vf += (f",drawbox=x=iw-380:y=ih-150:w=350:h=44:color=0x0b1618@0.78:t=fill,"
                   f"drawtext=text='Gemini working - sped up x{sp:.0f}':x=w-366:y=h-137:fontsize=20:fontcolor=0xd7ff3c:fontfile='{FONT}'")
        if last_of_beat.get(key) == i and pad_of.get(key, 0) > 0.05:
            vf += f",tpad=stop_mode=clone:stop_duration={pad_of[key]:.2f}"
        run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(raw), "-an", "-vf", vf,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(p)])
        parts.append(p)

    # Intro: Canva AI promo clip (if present) or the Gemini-generated hero, with the title.
    intro = OUT / "intro.mp4"
    intro_vo = tts("intro", INTRO_VO)
    hold = duration(intro_vo) + 0.9
    title = (f"drawbox=x=0:y=0:w=iw:h=230:color=0x0b1618@0.55:t=fill,"
             f"drawtext=text='Project Tesselle':x=80:y=52:fontsize=74:fontcolor=white:fontfile='{FONT_B}',"
             f"drawtext=text='Your shopping agent for things that have to fit':x=84:y=150:fontsize=30:fontcolor=0xd7ff3c:fontfile='{FONT}',"
             "fade=t=in:st=0:d=0.6")
    if INTRO.exists():
        extra = max(0.0, hold - duration(INTRO))
        run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(INTRO), "-an", "-t", f"{hold:.2f}", "-vf",
             f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},tpad=stop_mode=clone:stop_duration={extra:.2f},{title}",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(intro)])
    else:
        run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-t", f"{hold:.2f}", "-i", str(ROOT / "web/public/media/hero.jpg"), "-vf",
             f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},{title}",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(intro)])

    outro = OUT / "outro.mp4"
    outro_vo = tts("outro", OUTRO_VO)
    lines = [
        ("Project Tesselle", 76, "white", 250, FONT_B), ("project-tesselle.web.app", 40, "0xd7ff3c", 360, FONT),
        ("Gemini 3.8 Flash + Grounding with Google Search · Gemini image, embeddings, TTS · Google ADK agents + graph Workflow", 24, "0xcdd9d6", 470, FONT),
        ("Agent Platform Sessions + Memory Bank · Cloud Run · Firestore · Cloud Storage · Firebase Hosting", 24, "0xcdd9d6", 512, FONT),
        ("Real stores and makers from live web search. Tesselle never pays, orders or sends messages for you.", 22, "0x92a6a4", 640, FONT),
    ]
    dt = ",".join(f"drawtext=text='{esc(t)}':x=(w-text_w)/2:y={y}:fontsize={fs}:fontcolor={c}:fontfile='{f}'" for t, fs, c, y, f in lines)
    run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-t", f"{max(4.5, duration(outro_vo) + 1.5):.2f}", "-i", str(ROOT / "deck/img/bg-blur.jpg"), "-vf",
         f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},{dt},fade=t=in:st=0:d=0.5",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(outro)])

    # Concatenate; narration placed at each beat's start in the rendered timeline.
    lst = OUT / "concat.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in [intro, *parts, outro]))
    body = OUT / "body.mp4"
    run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(body)])
    starts: dict[str, float] = {}
    acc = duration(intro)
    for p, (*_, key) in zip(parts, pieces):
        starts.setdefault(key, acc)
        acc += duration(p)
    total = duration(body)
    placed = [(intro_vo, 0.3), (outro_vo, acc + 0.4)]
    placed += [(OUT / f"vo-{bt['key']}.wav", starts[bt["key"]] + 0.2) for bt in beats if bt["vo"] and bt["key"] in starts]
    # Captions file (for the video host) from the same narration lines.
    texts = {intro_vo: INTRO_VO, outro_vo: OUTRO_VO, **{OUT / f"vo-{bt['key']}.wav": bt["vo"] for bt in beats if bt["vo"]}}
    cues = sorted((st, st + duration(w), texts[w]) for w, st in placed)
    (OUT / "captions.srt").write_text("".join(f"{i + 1}\n{_ts(a)} --> {_ts(b)}\n{t}\n\n" for i, (a, b, t) in enumerate(cues)), encoding="utf-8")
    inputs, filters = [], []
    for i, (wav, st) in enumerate(placed):
        inputs += ["-i", str(wav)]
        filters.append(f"[{i}:a]adelay={int(st * 1000)}|{int(st * 1000)},apad=whole_dur={total:.2f}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(placed))) + f"amix=inputs={len(placed)}:normalize=0:duration=longest[aout]"
    narration = OUT / "narration.wav"
    run(["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join([*filters, mix]),
         "-map", "[aout]", "-ar", "48000", "-ac", "2", "-t", f"{total:.2f}", str(narration)])
    final = OUT / "Project-Tesselle-demo.mp4"
    run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(body), "-i", str(narration), "-map", "0:v", "-map", "1:a",
         "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
         "-movflags", "+faststart", "-t", f"{total:.2f}", str(final)])
    print(f"final: {final} ({duration(final):.1f}s)")


if __name__ == "__main__":
    main()
