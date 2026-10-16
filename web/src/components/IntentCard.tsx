import { AlertTriangle, ArrowRight, Ban, CircleHelp, Lock, Smartphone } from "lucide-react";
import { inr } from "../api";
import type { ProjectState, Stage } from "../types";
import { Gauge } from "./Viz";

/** MissionLock inspector: how intact the customer's intent is, the one next decision, and every
 *  must-have with its live status. */
export default function IntentCard({ state, onGo, onHandoff }: { state: ProjectState; onGo: (s: Stage) => void; onHandoff: () => void }) {
  const b = state.briefs[state.briefs.length - 1];
  const nd = state.next_decision;
  const activeQuote = [...state.quotes].filter((q) => q.status === "active").sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
  const approvedV = state.project.approved_brief_version;
  const changedSinceApproval = approvedV != null && b && b.version !== approvedV;

  const musts = b?.requirements.filter((r) => r.kind === "must") || [];
  const blockedIds = new Set((activeQuote?.deviations || []).filter((d) => d.decision === "pending" && d.severity === "blocked").map((d) => d.requirement_id));
  const checking = musts.filter((r) => r.status === "needs_checking").length;
  const blocked = musts.filter((r) => blockedIds.has(r.id)).length;
  const locked = musts.length - checking - blocked;
  const tone = blocked ? "red" : checking || !b?.confirmed ? "amber" : "volt";
  const status = !b ? "No brief yet" : blocked ? "A seller change is blocked" : checking ? "Some sizes need checking" : b.confirmed ? "Protected by MissionLock" : "Draft - confirm to lock";

  return (
    <aside className="intent" aria-label="MissionLock brief">
      <div className="intent-head">
        <div className="row between">
          <h4>MissionLock</h4>
          {b && <span className={`chip ${b.confirmed ? "teal" : "amber"}`}>v{b.version} · {b.confirmed ? "Confirmed" : "Draft"}</span>}
        </div>
        <div className="title">{b?.title || state.project.title}</div>
        {b?.purpose && <div className="small muted clamp2">{b.purpose}</div>}
        {changedSinceApproval && <span className="chip amber" style={{ alignSelf: "flex-start" }}><AlertTriangle /> Changed since your last approval</span>}
      </div>

      {b && (
        <div className="gauge-card well">
          <h4>Intent integrity</h4>
          <Gauge value={musts.length ? locked / musts.length : 0} tone={tone}>
            <b>{locked}<small>/{musts.length}</small></b>
            <span>{status}</span>
          </Gauge>
        </div>
      )}

      {!b && (
        <div className="gauge-card well">
          <h4>Intent integrity</h4>
          <Gauge value={0} tone="volt"><b style={{ color: "var(--muted)" }}>-</b><span>Nothing locked yet</span></Gauge>
          <div className="tiny muted" style={{ textAlign: "center", padding: "6px 8px 0", lineHeight: 1.5 }}>
            Share an inspiration and confirm the brief - every must-have you lock is guarded here, and no seller change can touch it without your decision.
          </div>
        </div>
      )}

      {nd && (
        <div className="next-card frost">
          <div className="k">Up next</div>
          <div className="t">{nd.title}</div>
          <div className="d">{nd.detail}</div>
          <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
            <button className="btn go" onClick={() => onGo(nd.stage)}>Go <ArrowRight size={14} /></button>
            <button className="btn" onClick={onHandoff}><Smartphone size={14} /> Continue on my phone</button>
          </div>
        </div>
      )}

      {b && (
        <>
          <div className="tiles">
            <div className="tile"><div className="k">Target</div><div className="v">{b.budget.target_inr ? inr(b.budget.target_inr) : "-"}</div><div className="s">flexible</div></div>
            <div className="tile"><div className="k">Limit</div><div className="v">{b.budget.limit_inr ? inr(b.budget.limit_inr) : "-"}</div><div className="s">must</div></div>
            <div className="tile"><div className="k">City</div><div className="v">{b.delivery.region?.split(",")[0] || "-"}</div><div className="s">{b.delivery.desired_by || "any date"}</div></div>
          </div>

          <div className="col">
            <h4 style={{ padding: "0 4px" }}>Must stay the same</h4>
            <div className="req-list">
              {musts.map((r) => {
                const dev = activeQuote?.deviations.find((d) => d.requirement_id === r.id && d.decision === "pending" && d.severity === "blocked");
                const st = dev ? "bad" : r.status === "needs_checking" ? "warn" : "";
                return (
                  <div key={r.id} className={`req must ${b.changed_ids.includes(r.id) ? "changed" : ""}`}>
                    <span className={`lock-ic ${st}`}>{dev ? <Ban /> : r.status === "needs_checking" ? <CircleHelp /> : <Lock />}</span>
                    <div className="grow">
                      <div>{r.label}</div>
                      <div className="meta">
                        {dev ? <span style={{ color: "var(--red-ink)" }}>Unmet by {activeQuote?.seller_name}'s quote ({dev.proposed})</span>
                          : r.status === "needs_checking" ? "Needs checking" : "Locked"}
                        {b.changed_ids.includes(r.id) && " · changed in this version"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="col">
            <h4 style={{ padding: "0 4px" }}>Flexible</h4>
            <div className="flex-chips">
              {b.requirements.filter((r) => r.kind === "flexible").map((r) => (
                <span key={r.id} className={`chip ${b.changed_ids.includes(r.id) ? "sky" : ""}`}>{r.label}</span>
              ))}
              {!b.requirements.some((r) => r.kind === "flexible") && <span className="small muted">None</span>}
            </div>
          </div>

          {b.unknowns.some((u) => u.status === "open") && (
            <div className="col">
              <h4 style={{ padding: "0 4px" }}>Needs checking</h4>
              {b.unknowns.filter((u) => u.status === "open").map((u) => (
                <div key={u.id} className="req">
                  <span className="lock-ic warn"><CircleHelp /></span><div>{u.question}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
