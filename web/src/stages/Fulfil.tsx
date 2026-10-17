import { ArrowUpRight, Check, PackageCheck, ShoppingBag, Truck } from "lucide-react";
import { ProgressStrip } from "../components/ui";
import { RouteBar } from "../components/Viz";
import { usePrimary, type StageCtx } from "./ctx";

/** Follow the chosen option to the door. The customer marks each step - on any device. */
export default function Fulfil({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const order = state.order;
  const current = order?.milestones.find((m) => m.state === "current");
  const advance = (step: string, msg: string) => ctx.act("Saving", `/api/projects/${pid}/order/advance`, { step }, msg);

  usePrimary(ctx, !order ? { label: "Choose an option", onClick: () => ctx.go("approve") }
    : current?.key === "ordered" ? { label: order.kind === "store" ? "I've ordered it" : "I've confirmed the order", onClick: () => advance("ordered", "Marked as ordered"), icon: <ShoppingBag size={16} />,
        hint: order.kind === "store" ? `Buy it on ${order.seller_name}, then tell Tesselle` : `Confirm the order with ${order.seller_name}, then tell Tesselle` }
    : current?.key === "delivered" ? { label: "It arrived", onClick: () => advance("delivered", "Marked as delivered").then(() => ctx.go("accept")), icon: <Truck size={16} />, hint: "When it's at your door" }
    : { label: "Check the delivery", onClick: () => ctx.go("accept"), icon: <PackageCheck size={16} />, hint: "Compare it with your brief" });

  if (!order) return <div className="empty">Nothing chosen yet.</div>;
  const done = order.milestones.filter((m) => m.state === "done").length;

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Track</div>
          <h2>{order.title}</h2>
          <p>{order.seller_name} · chosen for brief v{order.brief_version}. Tesselle never pays for you - you buy directly.</p>
        </div>
        {order.url && <a className="btn light" href={order.url} target="_blank" rel="noreferrer">Open on {order.seller_name.split(" ")[0]} <ArrowUpRight size={14} /></a>}
      </div>
      <div className="card pad">
        <RouteBar from="Chosen" to="Checked" value={(done - 1) / Math.max(1, order.milestones.length - 1)} note={current ? `Next: ${current.label}` : "Complete"} />
      </div>
      <div className="card pad">
        <div className="timeline">
          {order.milestones.map((m) => (
            <div key={m.key} className={`tl-item ${m.state}`}>
              <div className="tl-dot">{m.state === "done" ? <Check /> : null}</div>
              <div>
                <div className={m.state === "current" ? "strong" : ""}>{m.label}</div>
                <div className="tiny muted">{m.state === "current" ? (m.actor === "you" ? "Waiting for you" : "Waiting for the seller") : m.state === "done" ? "Done" : ""}</div>
              </div>
              <div />
            </div>
          ))}
        </div>
      </div>
      <ProgressStrip lines={lines} busy={!!busy} />
    </div>
  );
}
