import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Camera, Film, Glasses, ImagePlus, Loader2, Mic, PenLine, Share2, Sparkles, Square, Trash2, Wand2 } from "lucide-react";
import { get, media, post } from "../api";
import CameraCapture, { type Captured } from "../components/CameraCapture";
import { Banner, ProgressBox, useToast } from "../components/ui";
import type { StageCtx } from "./ctx";

type Mode = "describe" | "inspiration" | "space" | "imagine" | "glasses";
interface Media { kind: "photo" | "video"; blob?: Blob; url: string; serverPath?: string; label: string }

export default function Inspire({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const toast = useToast();
  const [params] = useSearchParams();
  const insp = state.project.inspiration || {};
  const [mode, setMode] = useState<Mode>((params.get("mode") as Mode) || "describe");
  const [text, setText] = useState(insp.text || "");
  const [region, setRegion] = useState("");
  const [item, setItem] = useState<Media | null>(null);
  const [consent, setConsent] = useState(false);
  const [useDemoPhoto, setUseDemoPhoto] = useState(false);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [camera, setCamera] = useState(false);
  const [imagining, setImagining] = useState(false);
  const [imaginePrompt, setImaginePrompt] = useState("");
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  useEffect(() => { if (mode === "space" && !item) setCamera(true); }, [mode]); // eslint-disable-line

  function pickFile(f: File | null) {
    setUseDemoPhoto(false);
    if (!f) return setItem(null);
    const kind = f.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(f.name) ? "video" : "photo";
    setItem({ kind, blob: f, url: URL.createObjectURL(f), label: kind === "video" ? "Your video" : "Your photo" });
  }

  function onCaptured(c: Captured) {
    setUseDemoPhoto(false);
    setItem({ kind: c.kind, blob: c.blob, url: c.url, label: c.kind === "video" ? "Captured clip" : "Captured photo" });
    setConsent(true);
  }

  async function demoFill() {
    const meta = await get<{ demo: { inspiration_text: string; region: string; desk_photo_path: string } }>("/api/meta");
    setText(meta.demo.inspiration_text);
    setRegion(meta.demo.region);
    setUseDemoPhoto(true);
    setItem({ kind: "photo", url: media(meta.demo.desk_photo_path), label: "Demo desk photo (generated)" });
    setConsent(true);
    setMode("space");
  }

  async function imagine() {
    const prompt = imaginePrompt || text;
    if (prompt.trim().length < 4) return toast("Describe what you imagine first", true);
    setImagining(true);
    try {
      const r = await post<{ image_path: string }>(`/api/projects/${pid}/imagine`, { prompt });
      setUseDemoPhoto(false);
      setItem({ kind: "photo", url: media(r.image_path), serverPath: r.image_path, label: "Imagined with Gemini · concept, not a product" });
      setConsent(true);
      if (!text) setText(prompt);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setImagining(false);
    }
  }

  async function toggleRec() {
    if (recording) return rec.current?.stop();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(s);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        setAudio(new Blob(chunks, { type: (r.mimeType || "audio/webm").split(";")[0] }));
        s.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (timer.current) clearInterval(timer.current);
      };
      r.start();
      rec.current = r;
      setSecs(0);
      setRecording(true);
      timer.current = window.setInterval(() => setSecs((x) => x + 1), 1000);
    } catch {
      toast("Microphone not available - you can type instead.", true);
    }
  }

  async function submit() {
    const fd = new FormData();
    fd.append("text", text);
    fd.append("region", region);
    fd.append("consent_photo", String(consent));
    fd.append("use_demo_photo", String(useDemoPhoto && consent));
    if (item?.serverPath) fd.append("image_path", item.serverPath);
    else if (item?.blob && consent) fd.append(item.kind === "video" ? "video" : "image", item.blob, item.kind === "video" ? "clip.webm" : "photo.jpg");
    if (audio) fd.append("audio", audio, "voice.webm");
    if (mode === "space" && item?.label.startsWith("Captured")) fd.append("source", "live camera");
    try {
      await ctx.streamAct("Reading your inspiration", `/api/projects/${pid}/inspiration`, fd, "Draft brief ready - review what must stay the same");
      ctx.go("clarify");
    } catch {
      /* toast shown */
    }
  }

  const canSubmit = !busy && (text.trim().length > 3 || audio || (item && consent));
  const MODES: [Mode, string, JSX.Element][] = [
    ["describe", "Describe it", <PenLine key="d" />],
    ["inspiration", "Show an inspiration", <ImagePlus key="i" />],
    ["space", "Capture my space", <Camera key="c" />],
    ["imagine", "Imagine it", <Sparkles key="m" />],
    ["glasses", "From my glasses", <Glasses key="g" />],
  ];

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">01 · Inspire</div>
          <h2>What do you wish you could get?</h2>
          <p>Speak, type, show, capture or imagine it. Explore before giving any personal details - we only ask for a city when it affects results.</p>
        </div>
        {state.project.demo && (
          <button className="btn teal" onClick={demoFill} disabled={!!busy}><Wand2 size={16} /> Use the demo inspiration</button>
        )}
      </div>

      <div className="mode-tabs" role="tablist">
        {MODES.map(([k, l, ic]) => (
          <button key={k} className={`mode-tab ${mode === k ? "on" : ""}`} onClick={() => setMode(k)}>{ic} {l}</button>
        ))}
      </div>

      <div className="inspo-grid">
        <div className="card pad section">
          <div className="field">
            <label htmlFor="idea">Your idea, in your own words</label>
            <textarea id="idea" className="textarea" placeholder="e.g. I want an organiser for this desk, with room for my accessories..."
              value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="row wrap">
            <button className={`btn ${recording ? "rec" : ""}`} onClick={toggleRec} disabled={!!busy}>
              {recording ? <Square size={15} /> : <Mic size={16} />}
              {recording ? `Stop recording (${secs}s)` : audio ? "Re-record voice note" : "Record a voice note"}
            </button>
            {audio && !recording && (
              <>
                <audio controls src={URL.createObjectURL(audio)} style={{ height: 34 }} />
                <button className="btn ghost sm" onClick={() => setAudio(null)}><Trash2 size={14} /> Remove</button>
              </>
            )}
          </div>
          <div className="field">
            <label htmlFor="region">Delivery city (optional)</label>
            <input id="region" className="input" placeholder="e.g. Chennai" value={region} onChange={(e) => setRegion(e.target.value)} />
          </div>
        </div>

        <div className="card pad section">
          {mode === "glasses" ? (
            <div className="section">
              <div className="row"><Glasses size={22} color="var(--teal)" /><h3>Capture from smart glasses</h3></div>
              <p className="small" style={{ color: "var(--ink-2)", lineHeight: 1.6 }}>
                Photos and clips from Ray-Ban Meta glasses sync to your phone. Install Tesselle on your phone (Add to Home Screen), then in the
                Meta AI app or your gallery choose <b>Share → Tesselle</b> - the capture goes straight to this agent.
              </p>
              <a className="btn primary" href={`/g/${pid}`}><Glasses size={16} /> Open heads-up capture view</a>
              <button className="btn" onClick={() => fileInput.current?.click()}><Share2 size={15} /> Import a glasses photo or clip</button>
              <Banner>Direct streaming from the glasses' camera needs Meta's native SDK; this prototype uses the share sheet and the phone camera, labelled as such.</Banner>
            </div>
          ) : mode === "imagine" && !item ? (
            <div className="section">
              <div className="row"><Sparkles size={20} color="var(--teal)" /><h3>Imagine it with Gemini</h3></div>
              <textarea className="textarea" style={{ minHeight: 120 }} placeholder="e.g. a low bamboo desk organiser with a phone slot and a tray for an A5 notebook"
                value={imaginePrompt} onChange={(e) => setImaginePrompt(e.target.value)} />
              <button className="btn primary" onClick={imagine} disabled={imagining || !!busy}>
                {imagining ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {imagining ? "Rendering (about 15 s)..." : "Render inspiration"}
              </button>
              <div className="tiny muted">Generated images are inspiration only - never a product listing, and never used to infer measurements.</div>
            </div>
          ) : (
            <div className="drop">
              {item ? (
                <>
                  {item.kind === "video" ? <video src={item.url} autoPlay muted loop playsInline /> : <img src={item.url} alt={item.label} />}
                  <button className="btn sm clear" onClick={() => { setItem(null); setUseDemoPhoto(false); }}><Trash2 size={14} /> Remove</button>
                  <span className={`chip src-tag ${item.serverPath || useDemoPhoto ? "violet" : "teal"}`}>{item.kind === "video" ? <Film /> : <Camera />} {item.label}</span>
                </>
              ) : (
                <>
                  {mode === "space" ? <Camera size={30} color="var(--teal)" /> : <ImagePlus size={30} color="var(--teal)" />}
                  <div className="small">{mode === "space" ? "Photograph or film the space it must fit" : "Add a photo or a short video of something you like"}</div>
                  <div className="row">
                    <button className="btn sm teal" onClick={() => setCamera(true)}><Camera size={14} /> Open camera</button>
                    <button className="btn sm" onClick={() => fileInput.current?.click()}>Upload photo / video</button>
                  </div>
                  <div className="tiny">Videos up to 20 MB - Gemini watches the whole clip.</div>
                </>
              )}
            </div>
          )}
          <input ref={fileInput} type="file" accept="image/*,video/*" hidden onChange={(e) => { pickFile(e.target.files?.[0] || null); if (mode === "glasses") setMode("inspiration"); }} />
          {item && (
            <label className="check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>Use this {item.kind} for this project only. It is <b>not</b> shared with sellers unless you choose to later. A photo or clip can suggest sizes but never confirms them.</span>
            </label>
          )}
        </div>
      </div>

      <ProgressBox lines={lines} busy={!!busy} />

      <div className="row between">
        <span className="small muted"><Sparkles size={13} style={{ verticalAlign: -2 }} /> MissionLock turns this into a brief you confirm. Nothing is searched or sent yet.</span>
        <button className="btn primary lg" onClick={submit} disabled={!canSubmit}>Use this inspiration</button>
      </div>
      {camera && <CameraCapture onClose={() => setCamera(false)} onCapture={onCaptured} />}
    </div>
  );
}
