import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Inbox, ShieldCheck } from "lucide-react";
import { ago, inr, media } from "../api";
import { Banner, CheckIcon, ProgressBox } from "../components/ui";
import { BigStat } from "../components/Viz";
import type { Brief, Deviation, Quote } from "../types";
import { brief as currentBrief, type StageCtx } from "./ctx";

const READINESS: Record<Quote["readiness"], [string, string]> = {
  ready: ["teal", "Ready to review"],
  needs_clarification: ["amber", "Needs clarification"],
  not_suitable: ["red", "Not suitable as offered"],
};

export function knownTotal(q: Quote) {
  const known = q.price_lines.filter((p) => p.amount_inr != null && p.kind !== "unresolved");
  return known.length ? known.reduce((a, p) => a + (p.amount_inr || 0), 0) : null;
}

export function DecisionCardView({ q, d, ctx, compact = false }: { q: Quote; d: Deviation; ctx: StageCtx; compact?: boolean }) {
  const blocked = d.severity === "blocked";
  const card = d.card;
  async function decide(decision: "keep_original" | "accept") {
    try {
      await ctx.streamAct(decision === "keep_original" ? "Keeping your requirement" : "Accepting change",
        `/api/projects/${ctx.pid}/quotes/${q.id}/decision`, { deviation_id: d.id, decision },
        decision === "keep_original" ? "Kept your requirement - revised quote received" : "Change accepted");
    } catch {
      /* toast */
    }
  }
  return (
    <div className={`decision ${blocked ? "" : "amber"}`}>
      <div className="dhead">
        {blocked ? <Ban size={20} color="var(--red)" /> : <AlertTriangle size={20} color="var(--amber)" />}
        <div className="grow">
          <div className="strong">{card?.title || `${q.seller_name} proposes a change`}</div>
          <div className="tiny muted">
            {blocked ? "Breaks a must-have - MissionLock blocked this quote" : "Changes a flexible preference - needs your decision"} · decision card
          </div>
        </div>
        <span className={`chip ${blocked ? "red" : "amber"}`}>{blocked ? "Blocked" : "Your call"}</span>
      </div>
      <div className="dbody">
        <div className="side-by-side">
          <div className="sbs-cell keep">
            <div className="k">{blocked ? "Must stay the same" : "Your preference"}</div>
            <div className="v">{d.original}</div>
          </div>
          <span className="vs">VS</span>
          <div className={`sbs-cell prop ${blocked ? "" : "amber"}`}>
            <div className="k">{q.seller_name} proposes</div>
            <div className="v">{d.proposed}</div>
          </div>
        </div>
        {!compact && <div className="small"><b>Why:</b> {d.reason}</div>}
        {card && <div className="small"><b>If you accept:</b> {card.consequence}</div>}
        {d.decision === "pending" ? (
          <div className="row wrap">
            <button className="btn primary" onClick={() => decide("keep_original")} disabled={!!ctx.busy}>
              <ShieldCheck size={15} /> {card?.keep_label || "Keep my original requirement"}
            </button>
            <button className={`btn ${blocked ? "danger" : ""}`} onClick={() => decide("accept")} disabled={!!ctx.busy}>
              {card?.accept_label || "Accept this change"}
            </button>
          </div>
        ) : (
          <span className={`chip ${d.decision === "accepted" ? "amber" : "teal"}`}>
            {d.decision === "accepted" ? "You accepted this change" : "You kept your original requirement"}
          </span>
        )}
      </div>
    </div>
  );
}

function valueFor(q: Quote, b: Brief, rid: string) {
  const resp = q.responses.find((r) => r.requirement_id === rid);
  const dev = q.deviations.find((d) => d.requirement_id === rid);
  if (dev) return { ic: dev.severity === "blocked" ? "unmet" : "unknown", text: dev.proposed } as const;
  if (resp) {
    const map: Record<string, "met" | "unknown" | "unmet"> = { achievable: "met", needs_clarification: "unknown", proposed_change: "unknown", not_achievable: "unmet" };
    return { ic: map[resp.response] || "unknown", text: resp.offered || resp.response.replace("_", " ") } as const;
  }
  return { ic: "unknown", text: "Not stated" } as const;
}

export default function Compare({ ctx }: { ctx: StageCtx }) {
  const { state, busy, lines } = ctx;
  const b = currentBrief(state)!;
  const quotes = [...state.quotes].sort((a, z) => z.created_at.localeCompare(a.created_at));
  const active = quotes.filter((q) => q.status === "active" || q.status === "approved");
  const history = quotes.filter((q) => q.status === "superseded" || q.status === "expired");
  const cols = [...active, ...history].slice(0, 3);

  if (!quotes.length)
    return (
      <div className="section">
        <div className="stage-head"><div><div className="eyebrow">06 · Compare & refine</div><h2>Quote inbox</h2></div></div>
        <ProgressBox lines={lines} busy={!!busy} />
        <div className="empty"><Inbox size={28} /><div>No seller has responded yet. When a quote arrives it appears here, linked to the exact brief version it answers.</div></div>
      </div>
    );

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">06 · Compare & refine</div>
          <h2>Quote inbox</h2>
          <p>Each quote is tied to one brief version. MissionLock checks every requirement - a seller's convenience can't rewrite your intent.</p>
        </div>
      </div>
      <ProgressBox lines={lines} busy={!!busy} />

      {active.map((q) => {
        const pending = q.deviations.filter((d) => d.decision === "pending");
        const [tone, label] = READINESS[q.readiness];
        const total = knownTotal(q);
        const unresolved = q.price_lines.filter((p) => p.amount_inr == null || p.kind === "unresolved");
        const graded = b.requirements.map((r) => valueFor(q, b, r.id));
        const met = graded.filter((g) => g.ic === "met").length;
        return (
          <div key={q.id} className="card raised" style={{ overflow: "hidden" }}>
            <div className="row between wrap" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
              <div className="col" style={{ gap: 2 }}>
                <div className="strong">{q.title}</div>
                <div className="tiny muted">{q.seller_name} · fictional demo maker, AI-simulated response · round {q.round} · {ago(q.created_at)}</div>
              </div>
              <div className="row">
                <span className="chip ink">For brief v{q.brief_version}</span>
                <span className={`chip ${tone}`}>{label}</span>
                {q.status === "approved" && <span className="chip teal">Approved</span>}
              </div>
            </div>
            <div className="big-stats" style={{ padding: "16px 18px 0" }}>
              <BigStat n={met} of={b.requirements.length} label="requirements met" icon={<CheckCircle2 size={13} color="var(--volt)" />} />
              <BigStat n={pending.length} label={pending.length === 1 ? "decision for you" : "decisions for you"} icon={<AlertTriangle size={13} color={pending.length ? "var(--amber)" : "var(--muted)"} />} />
              <BigStat n={total != null ? inr(total) : "-"} label={unresolved.length ? "known + unknown charges" : "known total"} icon={<ShieldCheck size={13} color="var(--green)" />} />
              <BigStat n={q.lead_time_days_min != null ? `${q.lead_time_days_min}-${q.lead_time_days_max}` : "-"} label="days lead time (estimate)" />
            </div>
            <div style={{ padding: 18 }} className="grid-2">
              <div className="section">
                {q.image_path && (
                  <div className="col">
                    <img src={media(q.image_path)} alt="Supplier proposal" style={{ borderRadius: 12, aspectRatio: "4/3", objectFit: "cover" }} />
                    <span className="chip amber">Supplier proposal · AI render of the maker's description</span>
                  </div>
                )}
                <div className="small" style={{ fontStyle: "italic", color: "var(--ink-2)" }}>"{q.message}"</div>
                {q.note && <Banner tone="ink">{q.note}</Banner>}
              </div>
              <div className="section">
                {pending.map((d) => <DecisionCardView key={d.id} q={q} d={d} ctx={ctx} />)}
                {q.deviations.filter((d) => d.decision !== "pending").map((d) => <DecisionCardView key={d.id} q={q} d={d} ctx={ctx} compact />)}
                {!q.deviations.length && (
                  <Banner tone="teal"><b>No deviations.</b> Every must-have in brief v{q.brief_version} is preserved.</Banner>
                )}
                <div className="card">
                  <table className="table">
                    <tbody>
                      {q.price_lines.map((p, i) => (
                        <tr key={i}>
                          <td>{p.label}{p.estimate ? <span className="tiny muted"> · estimate</span> : null}</td>
                          <td style={{ textAlign: "right" }} className={p.amount_inr == null ? "" : "strong"}>
                            {p.amount_inr == null ? <span className="chip amber">Not yet known</span> : inr(p.amount_inr)}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className="strong">Known charges</td>
                        <td style={{ textAlign: "right" }} className="strong">{inr(total)}{unresolved.length ? " + unknown" : ""}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <dl className="kv">
                  <dt>Lead time</dt><dd>{q.lead_time_days_min}-{q.lead_time_days_max} days (seller estimate)</dd>
                  <dt>Valid until</dt><dd>{q.valid_until ? new Date(q.valid_until).toLocaleDateString() : "-"}</dd>
                  <dt>Sample</dt><dd>{q.sample_plan}</dd>
                </dl>
                {q.readiness === "ready" && q.status === "active" && (
                  <button className="btn teal lg" onClick={() => ctx.go("approve")}>
                    Review for approval <ArrowRight size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {cols.length > 0 && (
        <div className="card" style={{ overflowX: "auto" }}>
          <div style={{ padding: "14px 18px 4px" }}><h3>Comparison against brief v{b.version}</h3><div className="tiny muted">Seller estimates are marked; unknown charges are never folded into a misleading total.</div></div>
          <table className="table">
            <thead>
              <tr>
                <th>Requirement</th>
                {cols.map((q) => (
                  <th key={q.id}>{q.seller_name} · R{q.round}<div style={{ textTransform: "none", letterSpacing: 0 }}>{q.status === "superseded" ? "superseded" : READINESS[q.readiness][1]}</div></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.requirements.map((r) => (
                <tr key={r.id}>
                  <td className="rowlabel">{r.label}<div className="tiny muted">{r.kind === "must" ? "Must stay the same" : "Flexible"}</div></td>
                  {cols.map((q) => {
                    const v = valueFor(q, b, r.id);
                    return <td key={q.id}><span className="cell-ic"><CheckIcon result={v.ic} /> {v.text}</span></td>;
                  })}
                </tr>
              ))}
              <tr>
                <td className="rowlabel">Known charges</td>
                {cols.map((q) => <td key={q.id} className="strong">{inr(knownTotal(q))}</td>)}
              </tr>
              <tr>
                <td className="rowlabel">Unresolved charges</td>
                {cols.map((q) => <td key={q.id}>{q.price_lines.filter((p) => p.amount_inr == null || p.kind === "unresolved").map((p) => p.label).join(", ") || "None"}</td>)}
              </tr>
              <tr>
                <td className="rowlabel">Depth offered</td>
                {cols.map((q) => <td key={q.id}>{q.offered_specs.depth_cm != null ? `${q.offered_specs.depth_cm} cm` : "Not stated"}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {history.length > 0 && (
        <details className="card pad">
          <summary className="strong" style={{ cursor: "pointer" }}>Earlier quotes ({history.length}) - kept as history, not available for approval</summary>
          <div className="col" style={{ marginTop: 10 }}>
            {history.map((q) => (
              <div key={q.id} className="row small" style={{ gap: 10 }}>
                <CheckCircle2 size={14} color="var(--faint)" />
                <span className="grow">{q.seller_name} round {q.round}: {q.title} (brief v{q.brief_version})</span>
                <span className="chip muted">{q.status}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
