import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { inr, media } from "../api";
import { Banner, ProgressBox } from "../components/ui";
import { brief as currentBrief, type StageCtx } from "./ctx";
import { knownTotal } from "./Compare";

export default function Approve({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const b = currentBrief(state)!;
  const quote = useMemo(
    () => [...state.quotes].filter((q) => q.status === "active" || q.status === "approved").sort((a, z) => z.created_at.localeCompare(a.created_at))[0],
    [state.quotes],
  );
  const [ackUnknown, setAckUnknown] = useState(false);
  const [ackSandbox, setAckSandbox] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  const idem = useMemo(() => `${pid}-${quote?.id}-${Date.now()}`, [pid, quote?.id]);

  if (!quote) return <div className="empty">No quote to approve yet.</div>;
  const unresolved = quote.price_lines.filter((p) => p.amount_inr == null || p.kind === "unresolved");
  const accepted = quote.deviations.filter((d) => d.decision === "accepted");
  const approved = quote.status === "approved" || !!state.order;
  const ready = quote.readiness === "ready" && quote.brief_version === b.version;

  async function approve() {
    setBlockers([]);
    try {
      await ctx.act("Approving", `/api/projects/${pid}/approve`,
        { quote_id: quote.id, idempotency_key: idem, acknowledgements: ackUnknown ? ["unresolved_charges"] : [] },
        "Sandbox order created - no money moved");
      ctx.go("fulfil");
    } catch (e) {
      setBlockers(((e as { details?: string[] }).details) || []);
    }
  }

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">07 · Approve</div>
          <h2>Review the exact commitment</h2>
          <p>A focused review, not a celebratory shortcut. This approves one specification and one quote, for one brief version.</p>
        </div>
      </div>

      <Banner tone="amber"><b>Sandbox.</b> Approving creates a sandbox order. No money moves and no real seller is committed - the seller is a fictional, AI-simulated demo maker.</Banner>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="card pad section">
          {quote.image_path && <img src={media(quote.image_path)} alt="Chosen design" style={{ borderRadius: 12, aspectRatio: "4/3", objectFit: "cover" }} />}
          <div className="strong">{quote.title}</div>
          <div className="tiny muted">{quote.seller_name} · round {quote.round} · quote for brief v{quote.brief_version}</div>
          <dl className="kv">
            <dt>Dimensions</dt><dd>{quote.offered_specs.width_cm} × {quote.offered_specs.depth_cm} × {quote.offered_specs.height_cm} cm (W×D×H)</dd>
            <dt>Material</dt><dd>{quote.offered_specs.material} {quote.offered_specs.finish ? `· ${quote.offered_specs.finish}` : ""}</dd>
            <dt>Holds</dt><dd>{quote.offered_specs.features.join(", ")}</dd>
            <dt>Mounting</dt><dd>{quote.offered_specs.mounting}</dd>
            <dt>Lead time</dt><dd>{quote.lead_time_days_min}-{quote.lead_time_days_max} days (estimate)</dd>
            <dt>Sample</dt><dd>{quote.sample_plan}</dd>
            <dt>Valid until</dt><dd>{quote.valid_until ? new Date(quote.valid_until).toLocaleDateString() : "-"}</dd>
          </dl>
          {quote.terms.length > 0 && (
            <div className="col small"><b>Seller terms</b>{quote.terms.map((t, i) => <div key={i}>· {t}</div>)}</div>
          )}
        </div>

        <div className="section">
          <div className="card pad section">
            <h3>Confirmed essentials - brief v{b.version}</h3>
            {b.requirements.filter((r) => r.kind === "must").map((r) => {
              const dev = quote.deviations.find((d) => d.requirement_id === r.id && d.decision !== "accepted");
              return (
                <div key={r.id} className="req must">
                  {dev ? <AlertTriangle className="ic" color="var(--red)" /> : <CheckCircle2 className="ic" color="var(--teal)" />}
                  <div>{r.label}{dev && <div className="meta" style={{ color: "var(--red)" }}>Unmet: {dev.proposed}</div>}</div>
                </div>
              );
            })}
            {accepted.length > 0 && (
              <>
                <h4>Compromises you accepted</h4>
                {accepted.map((d) => <div key={d.id} className="req flex"><span className="ic" /><div>{d.requirement_label}: {d.proposed}</div></div>)}
              </>
            )}
          </div>

          <div className="card">
            <table className="table">
              <tbody>
                {quote.price_lines.map((p, i) => (
                  <tr key={i}><td>{p.label}{p.estimate ? <span className="tiny muted"> · estimate</span> : null}</td>
                    <td style={{ textAlign: "right" }}>{p.amount_inr == null ? <span className="chip amber">Not yet known</span> : inr(p.amount_inr)}</td></tr>
                ))}
                <tr><td className="strong">Total known price</td><td style={{ textAlign: "right" }} className="strong">{inr(knownTotal(quote))}</td></tr>
              </tbody>
            </table>
          </div>

          {!approved && (
            <div className="card pad section">
              {unresolved.length > 0 && (
                <label className="check">
                  <input type="checkbox" checked={ackUnknown} onChange={(e) => setAckUnknown(e.target.checked)} />
                  <span>I understand these charges are not yet known: <b>{unresolved.map((u) => u.label).join(", ")}</b>. Any new charge will need my renewed review.</span>
                </label>
              )}
              <label className="check">
                <input type="checkbox" checked={ackSandbox} onChange={(e) => setAckSandbox(e.target.checked)} />
                <span>I understand this is a sandbox order for a demonstration - nothing is paid or shipped.</span>
              </label>
              {blockers.length > 0 && (
                <div className="label-banner red"><ShieldCheck /><div><b>MissionLock blocked this approval:</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{blockers.map((x, i) => <li key={i}>{x}</li>)}</ul></div></div>
              )}
              {!ready && <Banner tone="amber">This quote isn't ready: a must-have is unmet or a change still needs your decision.</Banner>}
              <ProgressBox lines={lines} busy={!!busy} />
              <button className="btn primary lg block" onClick={approve}
                disabled={!!busy || !ackSandbox || (unresolved.length > 0 && !ackUnknown)}>
                <ShieldCheck size={17} /> Approve this specification and quote (sandbox - no money moves)
              </button>
            </div>
          )}
          {approved && <Banner tone="teal"><b>Approved.</b> Sandbox order {state.order?.order_ref}. Changes from here need a new decision, never a hidden update.</Banner>}
        </div>
      </div>
    </div>
  );
}
