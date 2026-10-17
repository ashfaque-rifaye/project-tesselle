import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Camera, Check, Glasses, ImagePlus, Loader2, Smartphone, Video, X } from "lucide-react";
import { stream } from "../api";
import type { ProjectState } from "../types";
import { openStream, snapshot } from "./CameraCapture";
import { useToast } from "./ui";

const KIND: Record<string, string> = { space: "your space", inspiration: "an inspiration", item: "the item", person: "you", receipt: "the receipt" };
const isPhone = () => window.matchMedia("(max-width: 760px)").matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

/** "Show me": the voice agent (or the brief panel) asks for a photo. On a computer the sheet shows a QR
 *  code - scan it and the phone's camera opens on this project; on a phone the camera opens right here.
 *  Upload and the webcam work too. When the photo lands (from any device) the sheet closes by itself and
 *  the voice agent is told what the photo shows. */
export default function CaptureSheet({ state, kind, what, onClose, onState }: {
  state: ProjectState; kind: string; what: string; onClose: () => void; onState: (s?: ProjectState | null) => void;
}) {
  const pid = state.project.id;
  const toast = useToast();
  const [qr, setQr] = useState("");
  const [cam, setCam] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const live = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const before = useRef((state.project.inspiration?.photos || []).length);
  const phone = isPhone();
  const url = `${window.location.origin}/c/${pid}?kind=${encodeURIComponent(kind)}${what ? `&what=${encodeURIComponent(what)}` : ""}`;

  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: "#0B1618", light: "#EEF5F2" } }).then(setQr).catch(() => {});
  }, [url]);
  useEffect(() => () => live.current?.getTracks().forEach((t) => t.stop()), []);

  // A photo sent from the phone (or the glasses) arrives through the normal project sync.
  const photos = state.project.inspiration?.photos || [];
  useEffect(() => {
    if (photos.length > before.current) {
      const p = photos[photos.length - 1];
      finish(p.caption || "Photo added", p.observations || [], p.source || "your phone");
    }
  }, [photos.length]); // eslint-disable-line

  function finish(caption: string, seen: string[], from: string) {
    setDone(caption);
    before.current = Number.MAX_SAFE_INTEGER;
    window.dispatchEvent(new CustomEvent("tsl:voice-note", {
      detail: `(The customer added a photo of ${KIND[kind] || kind} from ${from}: ${caption}. ${seen.length ? "It shows: " + seen.join("; ") + "." : ""} `
        + "Mention one useful thing you see, ask to confirm any size before saving it, then carry on.)",
    }));
    setTimeout(onClose, 1600);
  }

  async function send(blob: Blob, name: string, source: string) {
    setBusy("Reading your photo");
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("note", what);
    fd.append("source", source);
    fd.append(blob.type.startsWith("video/") ? "video" : "image", blob, name);
    try {
      let res: { photo?: string; seen?: string[] } = {};
      const s = await stream(`/api/projects/${pid}/photo`, fd, (e) => {
        const ev = e as unknown as { type: string; photo?: { photo?: string; seen?: string[] } };
        if (ev.type === "result" && ev.photo) res = ev.photo;
      });
      onState(s);
      finish(res.photo || "Photo added", res.seen || [], source);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(null);
    }
  }

  async function startCam() {
    try {
      const s = await openStream(phone ? "environment" : "user", false);
      live.current = s;
      setCam(true);
      setTimeout(() => { if (video.current) video.current.srcObject = s; }, 30);
    } catch {
      toast("Camera permission was declined - upload a photo instead.", true);
    }
  }

  return (
    <div className="capture-sheet" role="dialog" aria-label="Add a photo">
      <div className="cap-card glass">
        <div className="row between">
          <span className="chip volt"><Camera /> Show Tesselle {KIND[kind] || kind}</span>
          <button className="btn sm ghost icon-btn" onClick={onClose} aria-label="Skip"><X size={16} /></button>
        </div>
        {what && <div className="cap-what">{what}</div>}
        {done ? (
          <div className="cap-done"><span><Check size={22} /></span><b>{done}</b><span className="small muted">Added to your project</span></div>
        ) : busy ? (
          <div className="cap-done"><Loader2 className="spin" size={22} /><span className="small">{busy}...</span></div>
        ) : cam ? (
          <div className="cap-cam">
            <video ref={video} autoPlay playsInline muted />
            <div className="row" style={{ justifyContent: "center", gap: 8 }}>
              <button className="btn primary" onClick={async () => { if (video.current) await send(await snapshot(video.current), "camera.jpg", phone ? "phone camera" : "webcam"); }}>
                <Camera size={16} /> Take photo
              </button>
              <button className="btn ghost" onClick={() => { live.current?.getTracks().forEach((t) => t.stop()); setCam(false); }}>Back</button>
            </div>
          </div>
        ) : (
          <div className={`cap-body ${phone ? "phone" : ""}`}>
            {!phone && (
              <div className="cap-qr">
                {qr ? <img src={qr} alt="QR code - scan with your phone to take the photo" /> : <Loader2 className="spin" />}
                <div className="col" style={{ gap: 4 }}>
                  <b className="small"><Smartphone size={13} /> Scan with your phone</b>
                  <span className="tiny muted">The camera opens on this project. The photo appears here as soon as you take it.</span>
                  <span className="tiny muted"><Glasses size={12} /> On MetaGlass: say "share to Tesselle", or open glasses mode.</span>
                </div>
              </div>
            )}
            <div className="cap-actions">
              <button className="btn" onClick={startCam}><Video size={15} /> {phone ? "Open camera" : "Use webcam"}</button>
              <button className="btn" onClick={() => file.current?.click()}><ImagePlus size={15} /> Upload</button>
              <input ref={file} type="file" accept="image/*,video/*" capture={phone ? "environment" : undefined} hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f, f.name, phone ? "phone" : "upload"); }} />
              <button className="btn ghost" onClick={() => {
                window.dispatchEvent(new CustomEvent("tsl:voice-note", { detail: "(The customer skipped the photo. Carry on without it.)" }));
                onClose();
              }}>Skip for now</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
