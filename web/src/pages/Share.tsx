import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Glasses, Loader2, Plus, Send } from "lucide-react";
import { get, post, stream } from "../api";
import { Banner, Logo, ProgressBox, useToast } from "../components/ui";
import type { NextDecision, Project, ProjectState } from "../types";

interface Shared { blob: Blob; url: string; name: string; video: boolean }
interface Card { project: Project; next_decision: NextDecision }

/** Landing page for the PWA share target: photos/clips shared from the phone (e.g. Ray-Ban Meta
 *  captures in the Meta AI app) are handed to the agent - as a new project or into an existing one. */
export default function Share() {
  const nav = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState<Shared[] | null>(null);
  const [note, setNote] = useState("");
  const [projects, setProjects] = useState<Card[]>([]);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      const out: Shared[] = [];
      try {
        const cache = await caches.open("tesselle-share");
        const meta = await cache.match("/shared/meta");
        const m = meta ? await meta.json() : { count: 0, note: "" };
        setNote(m.note || "");
        for (let i = 0; i < m.count; i++) {
          const r = await cache.match(`/shared/${i}`);
          if (!r) continue;
          const blob = await r.blob();
          out.push({ blob, url: URL.createObjectURL(blob), name: decodeURIComponent(r.headers.get("X-Name") || `capture-${i}`), video: blob.type.startsWith("video/") });
        }
      } catch {
        /* no share cache */
      }
      setItems(out);
    })();
    get<Card[]>("/api/projects").then(setProjects).catch(() => {});
  }, []);

  function form(endpoint: "inspiration" | "glance") {
    const fd = new FormData();
    const first = items?.[0];
    if (first) fd.append(first.video ? "video" : "image", first.blob, first.name);
    fd.append("text", note);
    fd.append("source", "smart glasses / phone share");
    if (endpoint === "inspiration") fd.append("consent_photo", "true");
    return fd;
  }

  async function newProject() {
    setBusy(true);
    try {
      const s = await post<ProjectState>("/api/projects", { title: "Shared capture" });
      await stream(`/api/projects/${s.project.id}/inspiration`, form("inspiration"), (e) => e.message && setLines((l) => [...l, e.message!]));
      nav(`/p/${s.project.id}/clarify`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  }

  async function addTo(pid: string) {
    setBusy(true);
    try {
      let audio: string | null = null;
      await stream(`/api/projects/${pid}/glance`, form("glance"), (e) => {
        if (e.message) setLines((l) => [...l, e.message!]);
        const ev = e as unknown as { type: string; reply?: string; audio?: string };
        if (ev.type === "result") { if (ev.reply) setLines((l) => [...l, `MissionLock: ${ev.reply}`]); audio = ev.audio || null; }
      });
      if (audio) new Audio(audio).play().catch(() => {});
      setTimeout(() => nav(`/p/${pid}`), 2500);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  }

  return (
    <>
      <header className="top-float glass" style={{ maxWidth: 720 }}><Logo small /><span className="chip muted">Shared to Tesselle</span></header>
      <div className="seller-wrap" style={{ maxWidth: 720 }}>
        <div className="row"><span className="drop-ic" style={{ width: 48, height: 48 }}><Glasses size={22} /></span><h2>Send this capture to your agent</h2></div>
        {items === null ? <div className="empty"><Loader2 className="spin" /></div> : items.length === 0 ? (
          <div className="empty">Nothing was shared. On your phone, open a photo or clip (for example from the Meta AI app for Ray-Ban Meta glasses), tap Share and choose Tesselle.</div>
        ) : (
          <div className="card pad section">
            {items[0].video ? <video src={items[0].url} controls playsInline style={{ width: "100%", borderRadius: 12 }} /> : <img src={items[0].url} alt="Shared capture" style={{ borderRadius: 12 }} />}
            <div className="tiny muted">{items[0].name}{items.length > 1 ? ` (+${items.length - 1} more - the first is used)` : ""}</div>
            <textarea className="textarea" style={{ minHeight: 70 }} placeholder="Optional: what do you want? e.g. 'something like this but no deeper than 18 cm'" value={note} onChange={(e) => setNote(e.target.value)} />
            <Banner>Used for this project only and never shown to sellers unless you choose to share it.</Banner>
            <ProgressBox lines={lines} busy={busy} />
            <button className="btn primary lg" onClick={newProject} disabled={busy}><Plus size={16} /> Start a new project from this</button>
            {projects.length > 0 && (
              <div className="col">
                <h4>Or add it to a project</h4>
                {projects.slice(0, 6).map((p) => (
                  <button key={p.project.id} className="btn" style={{ justifyContent: "space-between" }} onClick={() => addTo(p.project.id)} disabled={busy}>
                    <span>{p.project.title}</span><span className="row tiny muted" style={{ gap: 6 }}>{p.next_decision.title} <Send size={13} /></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
