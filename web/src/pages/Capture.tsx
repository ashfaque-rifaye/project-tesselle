import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Camera, Check, ImagePlus, Loader2, RefreshCcw, X } from "lucide-react";
import { stream } from "../api";
import { openStream, snapshot } from "../components/CameraCapture";
import { Logo } from "../components/ui";

/** Opened from the QR code on the computer: the phone's camera, pointed at what Tesselle asked to see.
 *  The photo goes straight into the project and the computer (and the voice agent) pick it up. */
export default function Capture() {
  const { pid } = useParams();
  const [params] = useSearchParams();
  const kind = params.get("kind") || "space";
  const what = params.get("what") || "";
  const video = useRef<HTMLVideoElement>(null);
  const live = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [camErr, setCamErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ caption: string; seen: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (sent) return;
    let stop = false;
    openStream(facing, false).then((s) => {
      if (stop) return s.getTracks().forEach((t) => t.stop());
      live.current = s;
      if (video.current) video.current.srcObject = s;
      setCamErr(false);
    }).catch(() => setCamErr(true));
    return () => { stop = true; live.current?.getTracks().forEach((t) => t.stop()); };
  }, [facing, sent]);

  async function send(blob: Blob, name: string) {
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("note", what);
    fd.append("source", "phone (QR)");
    fd.append(blob.type.startsWith("video/") ? "video" : "image", blob, name);
    try {
      let res = { caption: "Photo added", seen: [] as string[] };
      await stream(`/api/projects/${pid}/photo`, fd, (e) => {
        const ev = e as unknown as { type: string; photo?: { photo?: string; seen?: string[] } };
        if (ev.type === "result" && ev.photo) res = { caption: ev.photo.photo || "Photo added", seen: ev.photo.seen || [] };
      });
      setSent(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cap-page">
      <div className="cap-top"><Logo small /><span className="small">Show Tesselle {kind === "space" ? "your space" : `the ${kind}`}</span></div>
      {sent ? (
        <div className="cap-sent glass">
          <span className="ok"><Check size={26} /></span>
          <h3>{sent.caption}</h3>
          {sent.seen.length > 0 && <ul>{sent.seen.slice(0, 4).map((s) => <li key={s} className="small">{s}</li>)}</ul>}
          <div className="small muted">It's on your computer now. Sizes from a photo stay "measure to confirm".</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setSent(null)}><Camera size={15} /> Another photo</button>
            <a className="btn ghost" href={`/p/${pid}?follow=1`}>Open the project</a>
          </div>
        </div>
      ) : (
        <>
          <div className="cap-view">
            {camErr ? <div className="small muted" style={{ padding: 30, textAlign: "center" }}>Camera not available - upload a photo instead.</div>
              : <video ref={video} autoPlay playsInline muted />}
            {what && <div className="cap-hint glass small">{what}</div>}
            {busy && <div className="cap-busy"><Loader2 className="spin" /> Sending to your project...</div>}
          </div>
          {err && <div className="small" style={{ color: "var(--red)", textAlign: "center" }}><X size={13} /> {err}</div>}
          <div className="cap-bar">
            <button className="round-ic" onClick={() => file.current?.click()} aria-label="Upload from gallery"><ImagePlus size={20} /></button>
            <button className="shutter" disabled={busy || camErr} aria-label="Take photo"
              onClick={async () => { if (video.current) await send(await snapshot(video.current), "phone.jpg"); }} />
            <button className="round-ic" onClick={() => setFacing(facing === "environment" ? "user" : "environment")} aria-label="Switch camera"><RefreshCcw size={20} /></button>
            <input ref={file} type="file" accept="image/*,video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f, f.name); }} />
          </div>
        </>
      )}
    </div>
  );
}
