import { useRef, useState } from "react";
import { Camera, CheckCircle2, CircleHelp, Flag, ImageIcon, XCircle } from "lucide-react";
import { media } from "../api";
import { Banner, ProgressBox } from "../components/ui";
import type { StageCtx } from "./ctx";

const RESULT: Record<string, { label: string; tone: string; icon: JSX.Element }> = {
  looks_consistent: { label: "Looks consistent", tone: "teal", icon: <CheckCircle2 size={16} color="var(--teal)" /> },
  possible_issue: { label: "Possible issue", tone: "red", icon: <XCircle size={16} color="var(--red)" /> },
  cannot_tell_from_photo: { label: "Can't tell from a photo", tone: "amber", icon: <CircleHelp size={16} color="var(--amber)" /> },
};

export function DeliveryCheck({ ctx, compact = false }: { ctx: StageCtx; compact?: boolean }) {
  const { state, pid, busy, lines } = ctx;
  const order = state.order;
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  if (!order) return <div className="empty">No order yet.</div>;
  const dc = order.delivery_check;

  async function check(file?: File) {
    const fd = new FormData();
    if (file) fd.append("photo", file);
    else fd.append("use_sample", "true");
    try {
      await ctx.streamAct("Checking delivery", `/api/projects/${pid}/delivery-check`, fd, "Delivery check ready");
    } catch {
      /* toast */
    }
  }
  const close = (outcome: "accept" | "issue") =>
    ctx.act("Saving", `/api/projects/${pid}/delivery-close`, { outcome, note }, outcome === "accept" ? "Item accepted against your approved brief" : "Issue recorded with evidence");

  return (
    <div className="section">
      <div className="card pad section">
        <h3>Your acceptance checklist (approved with brief v{order.brief_version})</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {order.acceptance_checks.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
        {!dc && (
          <div className="row wrap">
            <button className="btn primary" disabled={!!busy} onClick={() => input.current?.click()}><Camera size={15} /> Photograph the delivered item</button>
            <button className="btn" disabled={!!busy} onClick={() => check()}><ImageIcon size={15} /> Use the simulated delivery photo</button>
            <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} />
          </div>
        )}
        <ProgressBox lines={lines} busy={!!busy} />
      </div>
      {dc && (
        <div className="card pad section">
          <div className={compact ? "col" : "grid-2"} style={{ alignItems: "start" }}>
            <img src={media(dc.photo_path)} alt="Delivered item" style={{ borderRadius: 12 }} />
            <div className="col">
              <div className="small">{dc.report.summary}</div>
              {dc.report.items.map((it, i) => {
                const r = RESULT[it.result] || RESULT.cannot_tell_from_photo;
                return (
                  <div key={i} className="req" style={{ flexDirection: "column", gap: 4 }}>
                    <div className="row" style={{ gap: 6 }}>{r.icon}<b className="small">{it.check}</b></div>
                    <span className={`chip ${r.tone}`} style={{ alignSelf: "flex-start" }}>{r.label}</span>
                    <div className="tiny">{it.evidence}</div>
                    <div className="tiny muted">How to verify: {it.how_to_verify}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <Banner tone="ink">A photo cannot prove every quality characteristic. You decide - the inspector never accepts on your behalf.</Banner>
          {!dc.outcome ? (
            <div className="col">
              <input className="input" placeholder="Optional note (for an issue: what's wrong?)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row">
                <button className="btn primary" disabled={!!busy} onClick={() => close("accept")}><CheckCircle2 size={15} /> Accept the item</button>
                <button className="btn danger" disabled={!!busy} onClick={() => close("issue")}><Flag size={15} /> Report an issue</button>
              </div>
            </div>
          ) : (
            <Banner tone={dc.outcome === "accept" ? "teal" : "amber"}>
              {dc.outcome === "accept"
                ? "Accepted against your approved brief. The final item record is saved - you can reorder or modify from this spec later, with fresh checks."
                : "Issue recorded. The approved spec, seller messages and your evidence are preserved for review."}
            </Banner>
          )}
        </div>
      )}
    </div>
  );
}

export default function Accept({ ctx }: { ctx: StageCtx }) {
  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">09 · Accept & resolve</div>
          <h2>Delivery check</h2>
          <p>The promise survives checkout: the item is checked against the same criteria you approved before ordering.</p>
        </div>
      </div>
      <DeliveryCheck ctx={ctx} />
    </div>
  );
}
