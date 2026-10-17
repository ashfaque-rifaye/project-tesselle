import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Circle, Glasses as GlassesIcon, ImageUp, Loader2, Mic, MicOff, Monitor, RefreshCcw, Video, X } from "lucide-react";
import { stream } from "../api";
import { openStream, pickVideoMime, snapshot } from "../components/CameraCapture";
import { useProject } from "../useProject";

/** Glasses mode: a heads-up capture surface. On a phone it uses the rear camera as a stand-in for the
 *  glasses' camera; photos and clips from Ray-Ban Meta arrive via the share sheet or the import button.
 *  Every capture goes to the agent, and the reply is spoken (Gemini TTS) and shown as a HUD caption. */
export default function Glasses() {
  const { pid } = useParams();
  const { state } = useProject(pid);
  const video = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const voiceRef = useRef<MediaRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [camError, setCamError] = useState(false);
  const [clipping, setClipping] = useState(false);
  const [listening, setListening] = useState(false);
  const [voice, setVoice] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Point at your space or an inspiring item. Tap to capture, hold the video button for a clip.");
  const [reply, setReply] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    openStream(facing, true)
      .catch(() => openStream(facing, false))
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        if (video.current) video.current.srcObject = s;
        setCamError(false);
      })
      .catch(() => setCamError(true));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);

  async function send(media: Blob | null, kind: "image" | "video" | null, source = "glasses mode (phone camera)") {
    setBusy(true);
    setReply(null);
    const fd = new FormData();
    fd.append("source", source);
    if (media && kind) fd.append(kind, media, kind === "video" ? "clip.webm" : "capture.jpg");
    if (voice) fd.append("audio", voice, "question.webm");
    try {
      let audio: string | null = null;
      await stream(`/api/projects/${pid}/glance`, fd, (e) => {
        if (e.message) setStatus(e.message);
        const ev = e as unknown as { type: string; reply?: string; audio?: string };
        if (ev.type === "result") {
          setReply(ev.reply || "Saved to your project.");
          audio = ev.audio || null;
        }
      });
      setVoice(null);
      setStatus("Saved to your project - it's on your desktop too.");
      if (audio) new Audio(audio).play().catch(() => {});
    } catch (e) {
      setStatus(`Couldn't send: ${(e as Error).message}. Nothing was changed.`);
    } finally {
      setBusy(false);
    }
  }

  async function capture() {
    if (!video.current || camError) return fileInput.current?.click();
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    const blob = await snapshot(video.current);
    send(blob, "image");
  }

  function toggleClip() {
    if (clipping) return recRef.current?.stop();
    if (!streamRef.current) return;
    const mime = pickVideoMime();
    const r = new MediaRecorder(streamRef.current, mime ? { mimeType: mime, videoBitsPerSecond: 2_000_000 } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      setClipping(false);
      send(new Blob(chunks, { type: (r.mimeType || "video/webm").split(";")[0] }), "video");
    };
    r.start(250);
    recRef.current = r;
    setClipping(true);
    setStatus("Recording a clip - tap again to stop (max 8 s)");
    setTimeout(() => r.state !== "inactive" && r.stop(), 8000);
  }

  async function toggleVoice() {
    if (listening) return voiceRef.current?.stop();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(s);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        s.getTracks().forEach((t) => t.stop());
        setListening(false);
        const b = new Blob(chunks, { type: (r.mimeType || "audio/webm").split(";")[0] });
        setVoice(b);
        setStatus("Question recorded - capture a photo or clip to send it, or tap the mic again to send just the question.");
      };
      r.start();
      voiceRef.current = r;
      setListening(true);
      setStatus("Listening... tap the mic again when you're done");
    } catch {
      setStatus("Microphone not available.");
    }
  }

  const b = state?.briefs[state.briefs.length - 1];
  return (
    <div className="glasses">
      {camError ? (
        <div className="feed" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "url(/media/hero-sm.jpg) center / cover" }}>
          <div style={{ textAlign: "center", maxWidth: 420, padding: 22, borderRadius: 28 }} className="col glass">
            <GlassesIcon size={40} color="var(--volt)" style={{ margin: "0 auto" }} />
            <div className="small">No camera here. Import a photo or clip from your glasses (synced to your phone), or open this page on your phone.</div>
          </div>
        </div>
      ) : (
        <video ref={video} className="feed" autoPlay playsInline muted />
      )}
      {flash && <div style={{ position: "absolute", inset: 0, background: "#fff", opacity: 0.6 }} />}
      <div className="vignette" />
      <div className="hud">
        <div className="reticle"><i /><i /><i /><i />{busy && <div className="scanline" />}</div>
      </div>
      <div className="hud-top">
        <span className="who glass"><GlassesIcon size={16} color="var(--volt)" /> Tesselle · glasses mode</span>
        <span className="row" style={{ gap: 8 }}>
          {b && <span className="chip teal">Brief v{b.version}</span>}
          <a className="hud-btn" style={{ width: 40, height: 40 }} href={`/p/${pid}`} aria-label="Open on desktop"><Monitor size={16} /></a>
          <a className="hud-btn" style={{ width: 40, height: 40 }} href="/" aria-label="Exit"><X size={16} /></a>
        </span>
      </div>
      <div className="hud-bubble glass" aria-live="polite">
        <div className="k">
          {busy ? <><Loader2 size={11} className="spin" style={{ verticalAlign: -1 }} /> GEMINI IS LOOKING</> : reply ? "TESSELLE" : "READY"}
        </div>
        <div>{reply || status}</div>
        {reply && <div className="tiny muted" style={{ marginTop: 6 }}>{status}</div>}
      </div>
      <div className="hud-controls glass">
        <button className={`hud-btn ${listening ? "on" : ""}`} onClick={() => (listening ? toggleVoice() : voice && !busy ? send(null, null) : toggleVoice())}
          aria-label={listening ? "Stop listening" : "Ask by voice"} disabled={busy}>
          {listening ? <MicOff size={20} /> : <Mic size={20} />}
        </button>
        <button className={`hud-btn ${clipping ? "on" : ""}`} onClick={toggleClip} aria-label="Record a clip" disabled={busy || camError}>
          {clipping ? <Circle size={18} color="var(--red)" fill="var(--red)" /> : <Video size={20} />}
        </button>
        <button className={`shutter ${clipping ? "rec" : ""}`} onClick={capture} aria-label="Capture photo" disabled={busy || clipping}><span /></button>
        <button className="hud-btn" onClick={() => fileInput.current?.click()} aria-label="Import from glasses gallery" disabled={busy}><ImageUp size={20} /></button>
        <button className="hud-btn" onClick={() => setFacing(facing === "environment" ? "user" : "environment")} aria-label="Switch camera" disabled={busy || camError}><RefreshCcw size={18} /></button>
      </div>
      <input ref={fileInput} type="file" accept="image/*,video/*" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) send(f, f.type.startsWith("video/") ? "video" : "image", "smart glasses (imported)");
      }} />
    </div>
  );
}
