import { AlertTriangle, ArrowRight, CircleHelp, ShieldCheck, Smartphone, XCircle } from "lucide-react";
import { inr } from "../api";
import type { ProjectState, Stage } from "../types";

export default function IntentCard({ state, onGo, onHandoff }: { state: ProjectState; onGo: (s: Stage) => void; onHandoff: () => void }) {
  const b = state.briefs[state.briefs.length - 1];
  const nd = state.next_decision;
  const activeQuote = [...state.quotes].filter((q) => q.status === "active").sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
  const approvedV = state.project.approved_brief_version;
  const changedSinceApproval = approvedV != null && b && b.version !== approvedV;

  return (
    <aside className="intent" aria-label="MissionLock brief">
      <div className="intent-head">
        <div className="row between">
          <h4>MissionLock brief</h4>
          {b && <span className={`chip ${b.confirmed ? "teal" : "amber"}`}>v{b.version} · {b.confirmed ? "Confirmed" : "Draft"}</span>}
        </div>
        <div className="title">{b?.title || state.project.title}</div>
        {b?.purpose && <div className="small muted">{b.purpose}</div>}
        {changedSinceApproval && <span className="chip amber"><AlertTriangle /> Changed since your last approval</span>}
      </div>

      {nd && (
        <div className="next-card">
          <div className="k">Next decision</div>
          <div className="t">{nd.title}</div>
          <div className="d">{nd.detail}</div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn go" onClick={() => onGo(nd.stage)}>Go <ArrowRight size={14} /></button>
            <button className="btn" onClick={onHandoff}>
              <Smartphone size={14} /> Continue on my phone
            </button>
          </div>
        </div>
      )}

      {b && (
        <>
          <div className="col">
            <h4>Must stay the same</h4>
            <div className="req-list">
              {b.requirements.filter((r) => r.kind === "must").map((r) => {
                const dev = activeQuote?.deviations.find((d) => d.requirement_id === r.id && d.decision === "pending" && d.severity === "blocked");
                return (
                  <div key={r.id} className={`req must ${b.changed_ids.includes(r.id) ? "changed" : ""}`}>
                    {dev ? <XCircle className="ic" color="var(--red)" /> : r.status === "needs_checking" ? <CircleHelp className="ic" color="var(--amber)" /> : <ShieldCheck className="ic" color="var(--ink)" />}
                    <div className="grow">
                      <div>{r.label}</div>
                      <div className="meta">
                        {dev ? <span style={{ color: "var(--red)" }}>Unmet by {activeQuote?.seller_name}'s quote ({dev.proposed})</span>
                          : r.status === "needs_checking" ? "Needs checking" : "Confirmed"}
                        {b.changed_ids.includes(r.id) && " · changed in this version"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="col">
            <h4>Flexible</h4>
            <div className="req-list">
              {b.requirements.filter((r) => r.kind === "flexible").map((r) => (
                <div key={r.id} className={`req flex ${b.changed_ids.includes(r.id) ? "changed" : ""}`}>
                  <span className="ic" />
                  <div>{r.label}</div>
                </div>
              ))}
              {!b.requirements.some((r) => r.kind === "flexible") && <div className="small muted">None</div>}
            </div>
          </div>
          <dl className="kv">
            <dt>Target</dt><dd>{b.budget.target_inr ? inr(b.budget.target_inr) : "-"} <span className="tiny muted">flexible</span></dd>
            <dt>Limit</dt><dd>{b.budget.limit_inr ? inr(b.budget.limit_inr) : "-"} <span className="tiny muted">must</span></dd>
            <dt>Delivery</dt><dd>{b.delivery.region || "Not set"}{b.delivery.desired_by ? ` by ${b.delivery.desired_by}` : ""}</dd>
          </dl>
          {b.unknowns.some((u) => u.status === "open") && (
            <div className="col">
              <h4>Needs checking</h4>
              {b.unknowns.filter((u) => u.status === "open").map((u) => (
                <div key={u.id} className="req" style={{ borderLeft: "3px solid var(--amber)" }}>
                  <CircleHelp className="ic" color="var(--amber)" /><div>{u.question}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
