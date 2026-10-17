import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, Camera, Film, Glasses, ImagePlus, Loader2, Mic, PenLine, PlayCircle, Sparkles, Square, Trash2, Wand2 } from "lucide-react";
import { get, media, post } from "../api";
import CameraCapture, { type Captured } from "../components/CameraCapture";
import LocationField, { rememberPlace } from "../components/LocationField";
import MicButton from "../components/MicButton";
import { ProgressStrip, useToast } from "../components/ui";
import { useDictation } from "../components/voice";
import { usePrimary, type StageCtx } from "./ctx";

type Mode = "describe" | "inspiration" | "space" | "imagine" | "glasses";
interface Media { kind: "photo" | "video"; blob?: Blob; url: string; serverPath?: string; label: string; demo?: boolean }

const EXAMPLES = [
  "A desk organiser that fits under an 18 cm shelf",
  "A Pixel 9 case with a card slot, under ₹1,500",
  "A gardening gift for my dad, under ₹2,000",
  "A cotton kurta in size M for a wedding in 10 days",
  "A replacement charger for a 2020 MacBook Air",
];

const CHOICES: { mode: Mode; icon: JSX.Element; title: string; text: string }[] = [
  { mode: "describe", icon: <PenLine />, title: "Describe it", text: "Type or just talk - your words appear as you speak." },
  { mode: "inspiration", icon: <ImagePlus />, title: "Show a photo or video", text: "Something you saw, liked or want to match." },
  { mode: "space", icon: <Camera />, title: "Use my camera", text: "Show the space or thing it has to fit." },
  { mode: "imagine", icon: <Sparkles />, title: "Imagine it", text: "Describe it and Gemini draws it for you." },
  { mode: "glasses", icon: <Glasses />, title: "From my glasses", text: "Ray-Ban Meta capture, straight to your agent." },
];

export default function Inspire({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const toast = useToast();
  const [params] = useSearchParams();
  const insp = state.project.inspiration || {};
  const [mode, setMode] = useState<Mode | null>((params.get("mode") as Mode) || null);
  const [text, setText] = useState(insp.text || "");
  const [region, setRegion] = useState("");
  const [pincode, setPincode] = useState("");
  const [item, setItem] = useState<Media | null>(null);
  const [camera, setCamera] = useState(false);
  const [imagining, setImagining] = useState(false);
  const [imaginePrompt, setImaginePrompt] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const base = useRef("");
  const dict = useDictation((t, final) => {
    setText((base.current ? base.current + " " : "") + t);
    if (final) base.current = "";
  });

  function pickFile(f: File | null) {
    if (!f) return setItem(null);
    const kind = f.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(f.name) ? "video" : "photo";
    setItem({ kind, blob: f, url: URL.createObjectURL(f), label: kind === "video" ? "Your video" : "Your photo" });
  }

  async function demoPhoto() {
    const meta = await get<{ demo: { desk_photo_path: string } }>("/api/meta");
    setItem({ kind: "photo", url: media(meta.demo.desk_photo_path), label: "Demo desk photo", demo: true });
  }

  async function imagine() {
    const prompt = imaginePrompt || text;
    if (prompt.trim().length < 4) return toast("Describe what you imagine first", true);
    setImagining(true);
    try {
      const r = await post<{ image_path: string }>(`/api/projects/${pid}/imagine`, { prompt });
      setItem({ kind: "photo", url: media(r.image_path), serverPath: r.image_path, label: "Imagined by Gemini - an idea, not a product" });
      if (!text) setText(prompt);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setImagining(false);
    }
  }

  async function submit() {
    const fd = new FormData();
    fd.append("text", text);
    fd.append("region", region);
    fd.append("pincode", pincode);
    fd.append("consent_photo", String(!!item));
    fd.append("use_demo_photo", String(!!item?.demo));
    if (item?.serverPath) fd.append("image_path", item.serverPath);
    else if (item?.blob) fd.append(item.kind === "video" ? "video" : "image", item.blob, item.kind === "video" ? "clip.webm" : "photo.jpg");
    if (dict.audio && !text.trim()) fd.append("audio", dict.audio, "voice.webm");
    if (mode === "space" && item?.label.startsWith("Captured")) fd.append("source", "live camera");
    if (region) rememberPlace(region, "Recent", pincode);
    try {
      await ctx.streamAct("Writing your brief", `/api/projects/${pid}/inspiration`, fd, "Your brief is ready");
      ctx.go("clarify");
    } catch {
      /* toast shown */
    }
  }

  const ready = !busy && (text.trim().length > 3 || !!item || !!dict.audio);
  usePrimary(ctx, mode && mode !== "glasses" ? {
    label: "Create my brief",
    onClick: submit,
    disabled: !ready || dict.listening,
    icon: <Wand2 size={16} />,
    hint: ready ? "Gemini turns this into a brief you can check" : "Describe it, talk, or add a photo",
  } : null);

  if (!mode) {
    return (
      <div className="section">
        <div className="stage-head">
          <div>
            <div className="eyebrow">Start</div>
            <h2>What are you looking for?</h2>
            <p>Anything that has to fit - a space, a device, a person or a date. Pick how you'd like to start.</p>
          </div>
        </div>
        <div className="choice-grid">
          {CHOICES.map((c) => (
            <button key={c.mode} className="glass sheen choice" onClick={() => { setMode(c.mode); if (c.mode === "space") setCamera(true); }} data-pilot={`start-${c.mode}`}>
              <span className="ic">{c.icon}</span>
              <span className="t">{c.title}</span>
              <span className="d">{c.text}</span>
            </button>
          ))}
          {state.project.demo && (
            <button className="glass sheen choice demo" onClick={() => window.dispatchEvent(new Event("tsl:pilot"))}>
              <span className="ic"><PlayCircle /></span>
              <span className="t">Watch Tesselle do it</span>
              <span className="d">The guided demo runs itself, live.</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <button className="back-link" onClick={() => setMode(null)}><ArrowLeft size={14} /> Choose another way</button>
          <h2>{{ describe: "Tell Tesselle what you want", inspiration: "Show what you have in mind", space: "Show where it has to fit", imagine: "Imagine it with Gemini", glasses: "Capture from your glasses" }[mode]}</h2>
        </div>
      </div>

      {mode === "glasses" ? (
        <div className="card pad section">
          <p className="small" style={{ color: "var(--ink-2)", lineHeight: 1.6 }}>
            Photos and clips from Ray-Ban Meta glasses sync to your phone. Install Tesselle on your phone (Add to Home Screen), then in the Meta AI
            app choose <b>Share → Tesselle</b> - the capture goes straight to your agent, and the answer is spoken back.
          </p>
          <div className="row wrap">
            <a className="btn primary" href={`/g/${pid}`}><Glasses size={16} /> Open the heads-up camera</a>
            <button className="btn" onClick={() => { setMode("inspiration"); fileInput.current?.click(); }}><ImagePlus size={15} /> Import a glasses photo or clip</button>
          </div>
        </div>
      ) : (
        <div className="composer-card glass">
          {mode === "imagine" && !item && (
            <div className="col" style={{ gap: 10 }}>
              <div className="idea-box">
                <textarea className="textarea idea" style={{ minHeight: 96 }} placeholder="e.g. a low bamboo desk organiser with a phone slot and a tray for an A5 notebook"
                  value={imaginePrompt} onChange={(e) => setImaginePrompt(e.target.value)} data-pilot="imagine-input" />
                <div className="idea-tools">
                  <MicButton value={imaginePrompt} onChange={setImaginePrompt} disabled={imagining} label="Describe it out loud" />
                  <span className="tiny muted">Talk or type, then let Gemini draw it</span>
                  <div className="grow" />
                  <button className="btn primary sm" onClick={imagine} disabled={imagining || !!busy}>
                    {imagining ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {imagining ? "Drawing (about 15 s)..." : "Imagine it"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {(mode === "inspiration" || mode === "space" || item) && (
            <div className="drop">
              {item ? (
                <>
                  {item.kind === "video" ? <video src={item.url} autoPlay muted loop playsInline /> : <img src={item.url} alt={item.label} />}
                  <button className="btn sm clear" onClick={() => setItem(null)}><Trash2 size={14} /> Remove</button>
                  <span className="chip src-tag">{item.kind === "video" ? <Film /> : <Camera />} {item.label}</span>
                </>
              ) : (
                <>
                  <span className="drop-ic">{mode === "space" ? <Camera size={26} /> : <ImagePlus size={26} />}</span>
                  <div className="small">{mode === "space" ? "Photograph or film the space it must fit" : "Add a photo or a short video"}</div>
                  <div className="row">
                    <button className="btn sm light" onClick={() => setCamera(true)}><Camera size={14} /> Open camera</button>
                    <button className="btn sm" onClick={() => fileInput.current?.click()}>Upload</button>
                  </div>
                  <div className="tiny">Videos up to 20 MB - Gemini watches the whole clip.</div>
                </>
              )}
            </div>
          )}

          <div className="idea-box">
            <textarea id="idea" data-pilot="idea" className="textarea idea" value={text} onChange={(e) => setText(e.target.value)}
              placeholder={mode === "describe" ? "e.g. I need a compact desk organiser for pens, my phone and an A5 notebook. The shelf above leaves 18 cm..." : "Anything to add? e.g. 'like this, but no deeper than 18 cm'"} />
            <div className="idea-tools">
              <button className={`mic-btn sm ${dict.listening ? "on" : ""}`} onClick={() => { base.current = text; dict.toggle(); }} disabled={!!busy}
                aria-label={dict.listening ? "Stop" : "Talk instead of typing"} title={dict.listening ? "Stop" : "Talk - your words appear as you speak"}>
                {dict.listening ? <Square size={14} /> : <Mic size={16} />}
              </button>
              <span className="tiny muted">{dict.listening ? `Listening... ${dict.secs}s` : dict.transcribing ? "Writing down what you said..." : "Talk or type"}</span>
              <div className="grow" />
              {!item && mode === "describe" && <button className="btn sm ghost" onClick={() => fileInput.current?.click()}><ImagePlus size={14} /> Add photo</button>}
              {!item && state.project.demo && <button className="btn sm ghost" data-pilot="demo-photo" onClick={demoPhoto}><Camera size={14} /> Use the demo desk photo</button>}
            </div>
          </div>

          {mode === "describe" && !text && (
            <div className="row wrap" style={{ gap: 6 }}>
              {EXAMPLES.map((e) => <button key={e} className="chip clickable" onClick={() => setText(e)}>{e}</button>)}
            </div>
          )}

          <LocationField value={region} onChange={setRegion} pincode={pincode} onPincode={setPincode} />
          {item && <div className="tiny muted">Your {item.kind} is used for this project only and never shown to sellers unless you choose to.</div>}
        </div>
      )}
      <input ref={fileInput} type="file" accept="image/*,video/*" hidden onChange={(e) => pickFile(e.target.files?.[0] || null)} />
      <ProgressStrip lines={lines} busy={!!busy} />
      {camera && <CameraCapture onClose={() => setCamera(false)} onCapture={(c: Captured) => setItem({ kind: c.kind, blob: c.blob, url: c.url, label: c.kind === "video" ? "Captured clip" : "Captured photo" })} />}
    </div>
  );
}
