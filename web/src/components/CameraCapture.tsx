import { useEffect, useRef, useState } from "react";
import { Camera, Circle, RefreshCcw, Square, X } from "lucide-react";
import { Modal } from "./ui";

export interface Captured {
  blob: Blob;
  kind: "photo" | "video";
  url: string;
}

/** Live camera: snap a photo or record a short clip (max 10 s). Works on phones and laptops. */
export async function openStream(facing: "environment" | "user", audio = false) {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } },
    audio,
  });
}

export function snapshot(video: HTMLVideoElement): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d")!.drawImage(video, 0, 0);
  return new Promise((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.88));
}

export function pickVideoMime() {
  for (const m of ["video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export default function CameraCapture({ onClose, onCapture }: { onClose: () => void; onCapture: (c: Captured) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    openStream(facing, true)
      .catch(() => openStream(facing, false))
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setError("Camera not available on this device or permission was declined. You can upload a photo instead."));
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);

  async function photo() {
    if (!video.current) return;
    const blob = await snapshot(video.current);
    onCapture({ blob, kind: "photo", url: URL.createObjectURL(blob) });
    onClose();
  }

  function clip() {
    if (recording) {
      rec.current?.stop();
      return;
    }
    if (!stream.current) return;
    const mime = pickVideoMime();
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      const blob = new Blob(chunks, { type: (r.mimeType || "video/webm").split(";")[0] });
      setRecording(false);
      onCapture({ blob, kind: "video", url: URL.createObjectURL(blob) });
      onClose();
    };
    r.start(250);
    rec.current = r;
    setRecording(true);
    setSecs(0);
    const t = setInterval(() => {
      setSecs((s) => {
        if (s + 1 >= 10) {
          clearInterval(t);
          r.state !== "inactive" && r.stop();
        }
        return s + 1;
      });
    }, 1000);
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="row between">
        <h2 style={{ fontSize: 22 }}><Camera size={20} style={{ verticalAlign: -3 }} /> Capture</h2>
        <button className="btn ghost sm icon-btn" onClick={onClose} aria-label="Close camera"><X size={16} /></button>
      </div>
      {error ? (
        <div className="empty">{error}</div>
      ) : (
        <div className="cam"><video ref={video} autoPlay playsInline muted /></div>
      )}
      <div className="row between wrap">
        <span className="small muted">Photos and clips are used for this project only. Sizes seen on camera stay "Needs checking" until you measure.</span>
        <div className="row">
          <button className="btn icon-btn" onClick={() => setFacing(facing === "environment" ? "user" : "environment")} aria-label="Switch camera" disabled={recording}>
            <RefreshCcw size={15} />
          </button>
          <button className={`btn ${recording ? "rec" : ""}`} onClick={clip} disabled={!!error}>
            {recording ? <Square size={14} /> : <Circle size={14} color="var(--red)" fill="var(--red)" />} {recording ? `Stop (${secs}s)` : "Record clip"}
          </button>
          <button className="btn primary" onClick={photo} disabled={!!error || recording}><Camera size={15} /> Take photo</button>
        </div>
      </div>
    </Modal>
  );
}
