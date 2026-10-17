import { useRef, useState } from "react";
import { ArrowUpRight, Check, ClipboardPaste, ImagePlus, Loader2, PackageCheck, ShoppingBag, ShoppingCart, Truck, Undo2 } from "lucide-react";
import { img, inr, media } from "../api";
import MicButton from "../components/MicButton";
import { ProgressStrip, favicon } from "../components/ui";
import type { Order } from "../types";
import { usePrimary, type StageCtx } from "./ctx";

const cur = (o: Order) => o.milestones.find((m) => m.state === "current")?.key;

function OrderCard({ o, ctx }: { o: Order; ctx: StageCtx }) {
  const { pid, busy } = ctx;
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const step = cur(o);
  const co = o.checkout;
  const conf = o.confirmation;
  const photo = o.image_path ? media(o.image_path) : o.image_url ? img(o.image_url) : "";

  async function confirm(f?: File) {
    const fd = new FormData();
    fd.append("text", text);
    if (f) fd.append("image", f);
    try {
      await ctx.streamAct("Reading your confirmation", `/api/projects/${pid}/orders/${o.id}/confirm`, fd, "Order tracked");
      setPaste(false);
      setText("");
    } catch { /* toast */ }
  }

  return (
    <div className={`card order-card ${o.status === "cancelled" ? "dim" : ""}`} data-pilot={`order-${o.id}`}>
      <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
        <div className="pick-img">{photo ? <img src={photo} alt="" referrerPolicy="no-referrer" /> : <img className="fav" src={favicon(o.seller_id || "", 64)} alt="" />}</div>
        <div className="grow col" style={{ gap: 4 }}>
          <div className="row between wrap" style={{ gap: 6 }}>
            <span className="tiny muted">{o.seller_name} · {o.order_ref}{o.qty && o.qty > 1 ? ` · qty ${o.qty}` : ""}</span>
            <span className={`chip ${o.status === "cancelled" ? "muted" : step === "ordered" ? "amber" : step === "delivered" ? "sky" : "teal"}`}>
              {o.status === "cancelled" ? "Cancelled" : step === "ordered" ? "To buy" : step === "delivered" ? "On its way" : step === "checked" ? "Arrived" : "Done"}
            </span>
          </div>
          <div className="strong clamp2">{o.title}</div>
          <div className="row" style={{ gap: 10 }}>
            <span className="num" style={{ fontSize: 18 }}>{o.known_total_inr != null ? inr(o.known_total_inr * (o.qty || 1)) : "Price on request"}</span>
            {conf?.order_number && <span className="chip volt">Order {conf.order_number}</span>}
            {conf?.expected_delivery && <span className="chip muted"><Truck /> {conf.expected_delivery}</span>}
          </div>
        </div>
      </div>

      {o.status !== "cancelled" && step === "ordered" && co && (
        <div className="checkout">
          <div className="row" style={{ gap: 8 }}><span className="co-badge"><ShoppingCart size={13} /></span><b className="small">Checkout agent</b>
            <span className="tiny muted">{co.method === "amazon_cart" ? `Amazon cart ready${co.grouped ? ` (${co.grouped} items in one cart)` : ""}` : co.method === "store_checkout" ? "Store checkout pre-filled" : co.method === "maker_confirm" ? "Order with the maker" : "Store page ready"}</span></div>
          <ol className="co-steps">{co.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <div className="row wrap" style={{ gap: 6 }}>
            {co.url && <a className="btn primary sm" href={co.url} target="_blank" rel="noreferrer" data-pilot="checkout"><ShoppingBag size={14} /> {co.label} <ArrowUpRight size={13} /></a>}
            <button className="btn sm" onClick={() => setPaste(!paste)} data-pilot="ordered-it"><ClipboardPaste size={14} /> I've ordered it</button>
          </div>
          {paste && (
            <div className="col" style={{ gap: 6 }}>
              <div className="tiny muted">Paste the store's confirmation (email or SMS) or add a screenshot - Gemini reads the order number and delivery date. Or just save it.</div>
              <textarea className="textarea" style={{ minHeight: 80 }} placeholder="Paste the order confirmation here (optional)" value={text} onChange={(e) => setText(e.target.value)} />
              <div className="row wrap" style={{ gap: 6 }}>
                <MicButton value={text} onChange={setText} label="Say the order number" />
                <button className="btn sm" onClick={() => file.current?.click()} disabled={!!busy}><ImagePlus size={14} /> Screenshot</button>
                <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && confirm(e.target.files[0])} />
                <button className="btn sm primary" disabled={!!busy} onClick={() => confirm()} data-pilot="save-ordered">{busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Save</button>
              </div>
            </div>
          )}
        </div>
      )}

      {o.status !== "cancelled" && (
        <div className="timeline compact">
          {o.milestones.map((m) => (
            <div key={m.key} className={`tl-item ${m.state}`}>
              <div className="tl-dot">{m.state === "done" ? <Check /> : null}</div>
              <div><div className={m.state === "current" ? "strong small" : "small"}>{m.label}</div></div>
              <div />
            </div>
          ))}
        </div>
      )}

      <div className="row wrap" style={{ gap: 6 }}>
        {step === "delivered" && <button className="btn sm primary" disabled={!!busy} onClick={() => ctx.act("Saving", `/api/projects/${pid}/order/advance`, { step: "delivered", order_id: o.id }, "Marked as arrived").then(() => ctx.go("accept", `order=${o.id}`))}><PackageCheck size={14} /> It arrived</button>}
        {step === "checked" && <button className="btn sm primary" onClick={() => ctx.go("accept", `order=${o.id}`)}><PackageCheck size={14} /> Check it</button>}
        {conf?.tracking_url && <a className="btn sm ghost" href={conf.tracking_url} target="_blank" rel="noreferrer"><Truck size={14} /> Track</a>}
        <div className="grow" />
        {o.status !== "cancelled" && (step === "ordered" || step === "delivered") && (
          <button className="btn sm ghost" disabled={!!busy} onClick={() => confirm_cancel(ctx, o)}><Undo2 size={13} /> Changed my mind</button>
        )}
      </div>
    </div>
  );
}

function confirm_cancel(ctx: StageCtx, o: Order) {
  if (!window.confirm(`Cancel ${o.title}? If you already paid, cancel it on ${o.seller_name} too.`)) return;
  ctx.act("Cancelling", `/api/projects/${ctx.pid}/orders/${o.id}/cancel`, {}, "Cancelled - back to your options").catch(() => {});
}

/** Orders: the checkout agent prepares each purchase (store cart filled, PIN code pre-entered where the
 *  store allows); you authorise payment on the store and paste the confirmation; Tesselle tracks it. */
export default function Fulfil({ ctx }: { ctx: StageCtx }) {
  const { state, busy, lines } = ctx;
  const orders = [...(state.orders || [])].sort((a, z) => (a.status === "cancelled" ? 1 : 0) - (z.status === "cancelled" ? 1 : 0));
  const live = orders.filter((o) => o.status !== "cancelled");
  const toBuy = live.filter((o) => cur(o) === "ordered");
  const arriving = live.filter((o) => cur(o) === "delivered");

  usePrimary(ctx, !live.length ? { label: "Pick options", onClick: () => ctx.go("routes") }
    : toBuy.length ? { label: toBuy[0].checkout?.url ? toBuy[0].checkout.label : "I've ordered it", icon: <ShoppingBag size={16} />,
        onClick: () => (toBuy[0].checkout?.url ? window.open(toBuy[0].checkout.url, "_blank") : (document.querySelector('[data-pilot="ordered-it"]') as HTMLElement | null)?.click()),
        hint: `${toBuy.length} to buy - pay on the store, then tap "I've ordered it"` }
    : arriving.length ? { label: "It arrived", icon: <Truck size={16} />, onClick: () => ctx.act("Saving", `/api/projects/${ctx.pid}/order/advance`, { step: "delivered", order_id: arriving[0].id }, "Marked as arrived").then(() => ctx.go("accept", `order=${arriving[0].id}`)), hint: "When it's at your door" }
    : { label: "Check the delivery", onClick: () => ctx.go("accept"), icon: <PackageCheck size={16} />, hint: "Compare it with your brief" });

  if (!orders.length) return <div className="empty"><ShoppingBag size={28} />No orders yet - add options to your picks and place the order.</div>;

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Orders</div>
          <h2>{toBuy.length ? `${toBuy.length} ready to buy` : arriving.length ? "On the way" : "Your orders"}</h2>
          <p>The checkout agent prepared each one. You pay on the store - Tesselle never sees or enters payment details - then it tracks the order here and in your order history.</p>
        </div>
        <a className="btn sm" href="/orders">Order history</a>
      </div>
      <ProgressStrip lines={lines} busy={!!busy} />
      {orders.map((o) => <OrderCard key={o.id} o={o} ctx={ctx} />)}
    </div>
  );
}
