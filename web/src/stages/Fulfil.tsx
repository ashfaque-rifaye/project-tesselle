import { Check, FastForward, PackageCheck } from "lucide-react";
import { media } from "../api";
import { Banner, ProgressBox } from "../components/ui";
import { RouteBar } from "../components/Viz";
import type { StageCtx } from "./ctx";

export default function Fulfil({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const order = state.order;
  if (!order) return <div className="empty">No order yet - approve a quote first.</div>;
  const current = order.milestones.find((m) => m.state === "current");
  const evidence = order.milestones.find((m) => m.evidence)?.evidence;

  const advance = (sample_decision?: string) =>
    ctx.act("Updating", `/api/projects/${pid}/order/advance`, { sample_decision: sample_decision ?? null },
      sample_decision === "revise" ? "Revision requested - production stays paused" : "Milestone updated");

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">08 · Fulfil</div>
          <h2>Following order {order.order_ref}</h2>
          <p>Only relevant stages, estimates marked as estimates, and who must act next. A sample rejection returns to revision - it never authorises production.</p>
        </div>
        <span className="chip amber">Sandbox order</span>
      </div>
      <div className="card pad">
        <RouteBar from="Approved" to="Accepted" value={order.milestones.filter((m) => m.state === "done").length / Math.max(1, order.milestones.length - 1)}
          note={`${order.seller_name} · ${current ? `next: ${current.label}` : "complete"}`} />
      </div>
      <Banner tone="ink">Milestones here are simulated for the demonstration - not real logistics.</Banner>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="card pad">
          <div className="timeline">
            {order.milestones.map((m) => (
              <div key={m.key} className={`tl-item ${m.state}`}>
                <div className="tl-dot">{m.state === "done" ? <Check /> : null}</div>
                <div>
                  <div className={m.state === "current" ? "strong" : ""}>{m.label}</div>
                  <div className="tiny muted">{m.state === "current" ? `Next action: ${m.actor === "customer" ? "you" : m.actor}` : m.actor}</div>
                </div>
                <div className="tiny muted">{m.state === "done" ? "done" : `est. ${new Date(m.estimate).toLocaleDateString()}`}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="section">
          {current?.key === "sample_review" ? (
            <div className="card pad section">
              <h3>Review the sample</h3>
              {evidence && <img src={media(evidence)} alt="Sample evidence" style={{ borderRadius: 12 }} />}
              <span className="chip teal">Sample evidence · simulated image for brief v{order.brief_version}</span>
              <div className="small">Check it against your approved brief before production starts.</div>
              <div className="row">
                <button className="btn primary" disabled={!!busy} onClick={() => advance("approve")}><PackageCheck size={15} /> Approve sample</button>
                <button className="btn" disabled={!!busy} onClick={() => advance("revise")}>Ask for a revision</button>
              </div>
            </div>
          ) : current?.key === "acceptance_review" ? (
            <div className="card pad section">
              <h3>Delivered - check it against your brief</h3>
              <div className="small">Delivery confirmation is not acceptance. Use the checklist you approved.</div>
              <button className="btn teal" onClick={() => ctx.go("accept")}>Open delivery check</button>
            </div>
          ) : (
            <div className="card pad section">
              <h3>Next milestone: {current?.label || "complete"}</h3>
              <div className="small muted">Nothing needs you right now. In the demo, simulate the seller's progress:</div>
              {current && (
                <button className="btn" disabled={!!busy} onClick={() => advance()}>
                  <FastForward size={15} /> Simulate: {current.label} done
                </button>
              )}
            </div>
          )}
          <ProgressBox lines={lines} busy={!!busy} />
          <div className="card pad col small">
            <h4>Approved reference</h4>
            <div>{order.title} · {order.seller_name}</div>
            <div className="muted">Brief v{order.brief_version} · {order.specs.width_cm}×{order.specs.depth_cm}×{order.specs.height_cm} cm · {order.specs.material}</div>
            {order.unresolved.length > 0 && <div className="muted">Still unknown at approval: {order.unresolved.join(", ")}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
