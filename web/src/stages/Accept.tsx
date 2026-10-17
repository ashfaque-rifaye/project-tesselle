import { useRef, useState } from "react";
import { Camera, CheckCircle2, CircleHelp, Flag, Home, ImageIcon, XCircle } from "lucide-react";
import { media } from "../api";
import { Banner, ProgressStrip } from "../components/ui";
import { usePrimary, type StageCtx } from "./ctx";

const RESULT: Record<string, { label: string; tone: string; icon: JSX.Element }> = {
  looks_consistent: { label: "Looks right", tone: "teal", icon: <CheckCircle2 size={16} color="var(--green)" /> },
  possible_issue: { label: "Possible issue", tone: "red", icon: <XCircle size={16} color="var(--red)" /> },
  cannot_tell_from_photo: { label: "Can't tell from a photo", tone: "amber", icon: <CircleHelp size={16} color="var(--amber)" /> },
};

export function pickOrder(ctx: StageCtx) {
  const { state, params } = ctx;
  const live = (state.orders || []).filter((o) => o.status !== "cancelled");
  return live.find((o) => o.id === params.get("order")) || live.find((o) => o.id === state.next_decision.order_id)
    || live.find((o) => o.delivery_check && !o.delivery_check.outcome) || state.order;
}

export function DeliveryCheck({ ctx, compact = false }: { ctx: StageCtx; compact?: boolean }) {
  const { pid, busy, lines } = ctx;
  const order = pickOrder(ctx);
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  if (!order) return <div className="empty">Nothing chosen yet.</div>;
  const dc = order.delivery_check;

  async function check(file?: File) {
    const fd = new FormData();
    if (file) fd.append("photo", file);
    else fd.append("use_sample", "true");
    fd.append("order_id", order!.id);
    try {
      await ctx.streamAct("Checking the delivery", `/api/projects/${pid}/delivery-check`, fd, "Delivery checked");
    } catch {
      /* toast */
    }
  }
  const close = (outcome: "accept" | "issue") =>
    ctx.act("Saving", `/api/projects/${pid}/delivery-close`, { outcome, note, order_id: order.id }, outcome === "accept" ? "All done - it matches your brief" : "Problem recorded with the photo");

  return (
    <div className="section">
      {!dc && (
        <div className="card pad section">
          <h3>Checks you agreed before buying</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{order.acceptance_checks.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <div className="row wrap">
            <button className="btn primary" disabled={!!busy} onClick={() => input.current?.click()}><Camera size={15} /> Take a photo of it</button>
            <button className="btn" data-pilot="sample-photo" disabled={!!busy} onClick={() => check()}><ImageIcon size={15} /> Try with a sample photo</button>
            <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} />
          </div>
        </div>
      )}
      <ProgressStrip lines={lines} busy={!!busy} />
      {dc && (
        <div className="card pad section">
          <div className={compact ? "col" : "grid-2"} style={{ alignItems: "start" }}>
            <img src={media(dc.photo_path)} alt="Delivered item" style={{ borderRadius: 16 }} />
            <div className="col">
              <div className="small">{dc.report.summary}</div>
              {dc.report.items.map((it, i) => {
                const r = RESULT[it.result] || RESULT.cannot_tell_from_photo;
                return (
                  <div key={i} className="req" style={{ flexDirection: "column", gap: 4 }}>
                    <div className="row" style={{ gap: 6 }}>{r.icon}<b className="small">{it.check}</b></div>
                    <span className={`chip ${r.tone}`} style={{ alignSelf: "flex-start" }}>{r.label}</span>
                    <div className="tiny">{it.evidence}</div>
                    <div className="tiny muted">How to check: {it.how_to_verify}</div>
                  </div>
                );
              })}
            </div>
          </div>
          {dc.sample && <Banner tone="ink">A sample photo was used to try the check.</Banner>}
          {!dc.outcome ? (
            <div className="col">
              <input className="input" placeholder="Optional note (for a problem: what's wrong?)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row">
                <button className="btn primary" data-pilot="accept-item" disabled={!!busy} onClick={() => close("accept")}><CheckCircle2 size={15} /> Happy with it</button>
                <button className="btn danger" disabled={!!busy} onClick={() => close("issue")}><Flag size={15} /> Report a problem</button>
              </div>
            </div>
          ) : (
            <Banner tone={dc.outcome === "accept" ? "teal" : "amber"}>
              {dc.outcome === "accept" ? "Done - it matches your brief. The record is saved; you can reorder or start something new." : "Problem recorded. Your brief, messages and photo are kept for the seller."}
            </Banner>
          )}
        </div>
      )}
    </div>
  );
}

export default function Accept({ ctx }: { ctx: StageCtx }) {
  const order = pickOrder(ctx);
  const live = (ctx.state.orders || []).filter((o) => o.status !== "cancelled");
  const dc = order?.delivery_check;
  usePrimary(ctx, !dc ? { label: "Try with a sample photo", onClick: () => (document.querySelector('[data-pilot="sample-photo"]') as HTMLElement | null)?.click(), icon: <ImageIcon size={16} />, hint: "Or take a photo of what arrived" }
    : !dc.outcome ? { label: "Happy with it", onClick: () => (document.querySelector('[data-pilot="accept-item"]') as HTMLElement | null)?.click(), icon: <CheckCircle2 size={16} />, hint: "Or report a problem above" }
    : { label: "Start something new", onClick: () => (window.location.href = "/"), icon: <Home size={16} />, hint: "All done" });
  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Delivery check</div>
          <h2>Does it match your brief?</h2>
          <p>Gemini compares a photo with the checks you agreed - and says honestly what a photo can't prove.</p>
        </div>
      </div>
      {live.length > 1 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {live.map((o) => (
            <button key={o.id} className={`chip clickable ${o.id === order?.id ? "volt" : ""}`} onClick={() => ctx.go("accept", `order=${o.id}`)}>
              {o.delivery_check?.outcome ? "✓ " : ""}{o.title.slice(0, 34)}
            </button>
          ))}
        </div>
      )}
      <DeliveryCheck ctx={ctx} />
    </div>
  );
}
