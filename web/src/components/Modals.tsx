import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, Smartphone } from "lucide-react";
import type { Brief, ProjectState } from "../types";
import { Banner, Modal } from "./ui";

export function HandoffModal({ state, onClose }: { state: ProjectState; onClose: () => void }) {
  const url = `${window.location.origin}/m/${state.project.id}`;
  const [qr, setQr] = useState("");
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 260, color: { dark: "#0B1618", light: "#EEF5F2" } }).then(setQr);
  }, [url]);
  return (
    <Modal onClose={onClose}>
      <div className="row"><Smartphone size={20} /><h2 style={{ fontSize: 22 }}>Continue on your phone</h2></div>
      <div className="small muted">Scan to open this exact project on your phone. It mirrors this screen live - open a step here and the phone follows, run an agent there and its progress shows here.</div>
      <div className="row" style={{ justifyContent: "center" }}>{qr && <img src={qr} alt="QR code to open this project on a phone" style={{ width: 220, borderRadius: 24, padding: 10, background: "#EEF5F2" }} />}</div>
      <div className="row">
        <input className="input mono" readOnly value={url} />
        <button className="btn" onClick={() => navigator.clipboard.writeText(url)}><Copy size={14} /> Copy</button>
      </div>
      <Banner>Anyone with this link can open the project. Sending from your inbox or phone line still needs the owner key on that device.</Banner>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <a className="btn" href={`/m/${state.project.id}`} target="_blank" rel="noreferrer">Open phone view here</a>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

function diff(a: Brief, b: Brief) {
  const out: { label: string; before: string; after: string; kind: string }[] = [];
  const am = new Map(a.requirements.map((r) => [r.id, r]));
  const bm = new Map(b.requirements.map((r) => [r.id, r]));
  for (const [id, r] of bm) {
    const o = am.get(id);
    if (!o) out.push({ label: r.label, before: "-", after: `${r.label} (${r.kind})`, kind: "added" });
    else if (o.label !== r.label || o.kind !== r.kind || o.status !== r.status || o.value_num !== r.value_num)
      out.push({ label: r.label, before: `${o.label} (${o.kind}, ${o.status})`, after: `${r.label} (${r.kind}, ${r.status})`, kind: "changed" });
  }
  for (const [id, o] of am) if (!bm.has(id)) out.push({ label: o.label, before: o.label, after: "-", kind: "removed" });
  if (JSON.stringify(a.budget) !== JSON.stringify(b.budget))
    out.push({ label: "Budget", before: `${a.budget.target_inr ?? "-"} / ${a.budget.limit_inr ?? "-"}`, after: `${b.budget.target_inr ?? "-"} / ${b.budget.limit_inr ?? "-"}`, kind: "changed" });
  return out;
}

export function ChangeLens({ briefs, version, onClose, onRestore }: { briefs: Brief[]; version: number; onClose: () => void; onRestore?: (v: number) => void }) {
  const b = briefs.find((x) => x.version === version)!;
  const prev = briefs.find((x) => x.version === version - 1);
  const changes = prev ? diff(prev, b) : [];
  return (
    <Modal onClose={onClose} wide>
      <div className="row between">
        <h2 style={{ fontSize: 22 }}>Brief v{b.version}{prev ? ` vs v${prev.version}` : ""}</h2>
        <span className="chip muted">{new Date(b.created_at).toLocaleString()} · {b.created_by}</span>
      </div>
      <div className="small">{b.change_summary}</div>
      {prev ? (
        changes.length ? (
          <table className="table">
            <thead><tr><th>Change</th><th>Before (v{prev.version})</th><th>After (v{b.version})</th></tr></thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={i}><td><span className={`chip ${c.kind === "removed" ? "red" : c.kind === "added" ? "teal" : "amber"}`}>{c.kind}</span></td><td>{c.before}</td><td className="strong">{c.after}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <div className="small muted">No requirement changes (confirmation or wording only).</div>
      ) : (
        <div className="col small">{b.requirements.map((r) => <div key={r.id}>· {r.label} <span className="muted">({r.kind})</span></div>)}</div>
      )}
      <Banner tone="ink">Previous versions stay reviewable. Restoring one saves it as a new version - nothing is lost.</Banner>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {onRestore && b.version !== briefs[briefs.length - 1].version && <button className="btn" onClick={() => onRestore(b.version)}>Restore v{b.version}</button>}
        <button className="btn primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
