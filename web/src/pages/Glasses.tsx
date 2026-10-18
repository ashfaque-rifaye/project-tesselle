import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Camera, Check, Eye, Glasses as GlassesIcon, Loader2, Maximize2, Monitor, RefreshCcw, ScanLine, X } from "lucide-react";
import { img, inr, stream } from "../api";
import { openStream, snapshot } from "../components/CameraCapture";
import { FacetIcon } from "../components/icons";
import { OrbGL, useLiveVoice } from "../components/VoiceOrb";
import { syncView } from "../sync";
import { useProject } from "../useProject";

/** MetaGlass mode - a simulation of Tesselle on smart glasses. The phone's rear camera (or a webcam)
 *  stands in for the glasses camera; the live voice agent hears you and, about once a second, sees
 *  what you see (Gemini Live with video frames). The heads-up card shows only what matters - what the
 *  agent heard and said, the key facts of your brief, and the best option so far - and "Save this
 *  view" adds the current frame to the project. Everything appears on your phone and laptop too. */
export default function Glasses() {
  const { pid } = useParams();
  const { state, load, setState } = useProject(pid);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [camError, setCamError] = useState(false);
  const [lens, setLens] = useState(() => window.innerWidth > 760);
  const [saving, setSaving] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const v = useLiveVoice(pid || "", "inspire", { navigate: () => {}, refresh: () => load() }, { camera: true });
  const active = v.mode !== "off" && v.mode !== "error";

  const feed = new URLSearchParams(location.search).get("feed");
  useEffect(() => {
    let cancelled = false;
    if (feed && video.current) {
      video.current.src = feed;
      video.current.loop = true;
      video.current.play().catch(() => {});
      return;
    }
    openStream(facing, false)
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

  // While the agent is listening it also sees: about one small frame a second.
  useEffect(() => {
    if (!active || camError) return;
    const t = setInterval(() => {
      const vid = video.current;
      if (!vid || !vid.videoWidth) return;
      const c = canvas.current || (canvas.current = document.createElement("canvas"));
      const scale = Math.min(1, 640 / vid.videoWidth);
      c.width = Math.round(vid.videoWidth * scale);
      c.height = Math.round(vid.videoHeight * scale);
      c.getContext("2d")!.drawImage(vid, 0, 0, c.width, c.height);
      v.sendFrame(c.toDataURL("image/jpeg", 0.6).split(",")[1]);
    }, 1000);
    return () => clearInterval(t);
  }, [active, camError]); // eslint-disable-line

  // The other devices see that the glasses are on, and what they're doing.
  useEffect(() => {
    if (pid) syncView(pid, { stage: state?.project.stage || "inspire", busy: v.tool ? `MetaGlass: ${v.tool}` : null }, 200);
  }, [pid, v.tool, state?.project.stage]);

  async function saveView() {
    if (!video.current || camError || !pid) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 160);
    setSaving("Saving what you see");
    const fd = new FormData();
    fd.append("kind", "space");
    fd.append("source", "MetaGlass");
    fd.append("image", await snapshot(video.current), "metaglass.jpg");
    try {
      let caption = "Saved";
      const s = await stream(`/api/projects/${pid}/photo`, fd, (e) => {
        const ev = e as unknown as { type: string; photo?: { photo?: string; seen?: string[] } };
        if (ev.type === "result" && ev.photo) {
          caption = ev.photo.photo || caption;
          if (active) v.sendText(`(The customer saved this view as a photo: ${caption}. ${(ev.photo.seen || []).join("; ")})`, true);
        }
      });
      if (s) setState(s);
      setSaving(`Saved: ${caption}`);
    } catch (e) {
      setSaving(`Couldn't save: ${(e as Error).message}`);
    }
    setTimeout(() => setSaving(null), 2600);
  }

  const b = state?.briefs[state.briefs.length - 1];
  const layout = state?.project.layout;
  const best = state?.routes?.entries.find((e) => e.verdict === "meets") || state?.routes?.entries[0];
  const caption = v.error || (v.who === "you" ? v.heard : v.said);

  return (
    <div className={`glasses mg ${lens ? "mg-lens" : ""}`}>
      {camError ? (
        <div className="feed" style={{ position: "absolute", inset: 0, background: "url(/media/hero-sm.jpg) center / cover" }} />
      ) : (
        <video ref={video} className="feed" autoPlay playsInline muted />
      )}
      {flash && <div className="mg-flash" />}
      {lens && (
        <svg className="mg-frame-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path fillRule="evenodd" fill="rgba(2,5,6,0.88)"
            d="M0 0H100V100H0Z M6 44C6 21 14 13 27 13C40 13 47 21 47 44C47 66 39 77 27 77C14 77 6 66 6 44Z M53 44C53 21 60 13 73 13C86 13 94 21 94 44C94 66 86 77 73 77C60 77 53 66 53 44Z" />
          <path fill="none" stroke="rgba(28,28,30,0.95)" strokeWidth="0.9" vectorEffect="non-scaling-stroke"
            d="M6 44C6 21 14 13 27 13C40 13 47 21 47 44C47 66 39 77 27 77C14 77 6 66 6 44Z M53 44C53 21 60 13 73 13C86 13 94 21 94 44C94 66 86 77 73 77C60 77 53 66 53 44Z M47 30Q50 25 53 30" />
        </svg>
      )}
      <div className="vignette" />

      <div className="hud-top">
        <span className="who glass"><GlassesIcon size={16} color="var(--volt)" /> Tesselle · MetaGlass <span className="tiny muted">simulated</span></span>
        <span className="row" style={{ gap: 8 }}>
          <button className="hud-btn sm" onClick={() => setLens(!lens)} aria-label={lens ? "Full view" : "Lens view"} title={lens ? "Full view" : "Lens view"}><Maximize2 size={15} /></button>
          <a className="hud-btn sm" href={`/p/${pid}`} aria-label="Open on desktop" title="Open the project"><Monitor size={15} /></a>
          <a className="hud-btn sm" href="/" aria-label="Exit"><X size={15} /></a>
        </span>
      </div>

      {/* The heads-up card: what you'd see in the corner of the right lens. */}
      <div className="mg-hud" aria-live="polite">
        <div className="mg-status">
          <span className={`mg-dot ${v.mode}`} />
          {v.mode === "off" ? "Tap the orb to talk" : v.mode === "listening" ? (active && !camError ? <><Eye size={11} /> Listening · seeing</> : "Listening")
            : v.mode === "working" ? <><Loader2 size={11} className="spin" /> {v.tool}</> : v.mode}
        </div>
        {caption && <div className={`mg-cap ${v.who}`}>{v.who === "you" ? `"${caption.trim()}"` : caption}</div>}
        {v.done.length > 0 && <div className="mg-done">{v.done.slice(-2).map((d, i) => <span key={i}><Check size={10} /> {d.label}</span>)}</div>}
        {b && (
          <div className="mg-brief">
            <b>{b.title}</b>
            <div className="mg-facts">
              {(layout?.facets || []).filter((f) => f.value).slice(0, 3).map((f) => (
                <span key={f.label}><FacetIcon name={f.icon} size={11} /> {f.value}</span>
              ))}
              {!layout && b.requirements.filter((r) => r.kind === "must").slice(0, 2).map((r) => <span key={r.id}>{r.label}</span>)}
            </div>
          </div>
        )}
        {best && (
          <div className="mg-best">
            {best.image_url && <img src={img(best.image_url)} alt="" />}
            <span className="grow"><span className="tiny muted">Best fit so far</span><span className="small clamp2">{best.name}</span></span>
            {best.price_inr ? <b className="small">{inr(best.price_inr)}</b> : null}
          </div>
        )}
        {saving && <div className="mg-saving small">{saving}</div>}
      </div>

      {!active && (
        <div className="mg-hint glass small">
          Talk and look around: "I need a bookshelf for this gap" - Tesselle sees the space, asks what it can't see, and fills in your brief.
          {camError && <div className="tiny muted" style={{ marginTop: 6 }}>No camera here - open this page on your phone to use its camera as the glasses.</div>}
        </div>
      )}

      <div className="hud-controls glass">
        <button className="hud-btn" onClick={() => setFacing(facing === "environment" ? "user" : "environment")} aria-label="Switch camera" disabled={camError}><RefreshCcw size={18} /></button>
        <button className={`mg-orb ${v.mode}`} onClick={() => (active ? v.stop() : v.start())} aria-label={active ? "Stop" : "Talk to Tesselle"}>
          <OrbGL mode={v.mode} level={v.level} outLevel={v.outLevel} size={78} />
        </button>
        <button className="hud-btn" onClick={saveView} aria-label="Save this view to the project" title="Save this view" disabled={camError || !!saving}>
          {saving ? <Loader2 size={18} className="spin" /> : <Camera size={19} />}
        </button>
      </div>
      {active && !camError && <div className="mg-scan" aria-hidden="true"><ScanLine size={14} /> Gemini sees this view</div>}
    </div>
  );
}
