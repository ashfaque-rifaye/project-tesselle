import { useState } from "react";
import { Minus, Package, Plus, ShieldCheck, ShoppingBag, Trash2 } from "lucide-react";
import { img, inr, media } from "../api";
import { Banner, ProgressStrip, favicon } from "../components/ui";
import type { CartItem } from "../types";
import { brief as currentBrief, usePrimary, type StageCtx } from "./ctx";

const ACK_TEXT: Record<string, string> = {
  check_on_store: "I'll check the details marked below on the store page before paying",
  confirm_with_seller: "I'll confirm the details marked below with the maker before paying",
  unresolved_charges: "I understand some charges aren't known yet",
};

function PickCard({ c, ctx }: { c: CartItem; ctx: StageCtx }) {
  const { pid, busy } = ctx;
  const photo = c.image_path ? media(c.image_path) : c.image_url ? img(c.image_url) : "";
  return (
    <div className="card pick">
      <div className="pick-img">{photo ? <img src={photo} alt="" referrerPolicy="no-referrer" /> : <img className="fav" src={favicon(c.seller_id || "", 64)} alt="" />}</div>
      <div className="grow col" style={{ gap: 6 }}>
        <div className="row" style={{ gap: 6 }}><img className="store-fav" src={favicon(c.seller_id || "")} alt="" /><span className="tiny muted">{c.seller_name} · {c.kind === "maker" ? "made for you" : "store"}</span></div>
        <div className="strong clamp2">{c.title}</div>
        {Object.values(c.needs || {}).map((n, i) => <div key={i} className="tiny" style={{ color: "var(--amber-ink)" }}>• {n}</div>)}
        <div className="row between wrap" style={{ gap: 8 }}>
          <div className="qty">
            <button disabled={!!busy || c.qty <= 1} onClick={() => ctx.act("Updating", `/api/projects/${pid}/cart/${c.id}`, { qty: c.qty - 1 })} aria-label="One less"><Minus size={13} /></button>
            <span>{c.qty}</span>
            <button disabled={!!busy || c.qty >= 20} onClick={() => ctx.act("Updating", `/api/projects/${pid}/cart/${c.id}`, { qty: c.qty + 1 })} aria-label="One more"><Plus size={13} /></button>
          </div>
          <span className="num" style={{ fontSize: 20 }}>{c.price_inr != null ? inr(c.price_inr * c.qty) : "Price on request"}</span>
          <button className="btn sm ghost" disabled={!!busy} onClick={() => ctx.act("Removing", `/api/projects/${pid}/cart/${c.id}`, { remove: true }, "Removed from your picks")}>
            <Trash2 size={13} /> Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/** Your picks: one or more options (from stores and makers), each cleared by the fit checker. Placing the
 *  order hands each one to the checkout agent; payment always happens on the store. */
export default function Approve({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines, params } = ctx;
  const b = currentBrief(state);
  const cart = state.cart || [];
  const orders = (state.orders || []).filter((o) => o.status !== "cancelled");
  const [acks, setAcks] = useState<string[]>([]);
  const [blockers, setBlockers] = useState<string[]>([]);
  const needed = Array.from(new Set(cart.flatMap((c) => Object.keys(c.needs || {}))));
  const total = cart.reduce((a, c) => a + (c.price_inr || 0) * c.qty, 0);
  const unknownPrice = cart.some((c) => c.price_inr == null);
  const pending = params.get("entry") || params.get("quote");
  const pendingEntry = pending && !cart.some((c) => c.entry_id === pending || c.quote_id === pending)
    ? state.routes?.entries.find((e) => e.item_id === params.get("entry")) : undefined;

  async function place() {
    setBlockers([]);
    try {
      const s = await ctx.act("Preparing your orders", `/api/projects/${pid}/orders`, { acknowledgements: acks }, "Orders prepared - the checkout agent is ready");
      const first = (s?.orders || []).filter((o) => o.status !== "cancelled" && o.checkout?.url && o.milestones.some((m) => m.key === "ordered" && m.state === "current")).slice(-1)[0];
      ctx.go("fulfil", first ? `agent=${first.id}` : "");
    } catch (e) {
      setBlockers(((e as { details?: string[] }).details) || []);
    }
  }

  usePrimary(ctx, cart.length
    ? { label: `Place order${cart.length > 1 ? "s" : ""}`, onClick: place, disabled: needed.some((n) => !acks.includes(n)), icon: <ShoppingBag size={16} />,
        hint: needed.some((n) => !acks.includes(n)) ? "Tick the boxes above first" : "The checkout agent fills each store cart - you only authorise payment" }
    : orders.length
      ? { label: "See your orders", onClick: () => ctx.go("fulfil"), icon: <Package size={16} />, hint: "Or add more options to your picks" }
      : { label: "Pick options", onClick: () => ctx.go("routes"), hint: "Add one or more options from the Options step" });

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Shop &amp; pick · Review &amp; order</div>
          <h2>{cart.length ? `${cart.length} pick${cart.length > 1 ? "s" : ""}, ready to order` : orders.length ? "All ordered" : "Nothing picked yet"}</h2>
          <p>Mix stores and makers. Every pick was checked against your brief{b ? ` (v${b.version})` : ""}; the checkout agent prepares each order and you authorise payment on the store.</p>
        </div>
        <button className="btn sm" onClick={() => ctx.go("routes")}><Plus size={14} /> Add more</button>
      </div>

      {pendingEntry && (
        <div className="card pad row between wrap" style={{ gap: 10 }}>
          <div className="small"><b>{pendingEntry.name}</b> <span className="muted">· {pendingEntry.seller_name}</span></div>
          <button className="btn sm primary" disabled={!!busy} onClick={() => ctx.act("Adding", `/api/projects/${pid}/cart`, { entry_id: pendingEntry.item_id }, "Added to your picks").catch(() => {})}>
            <Plus size={14} /> Add to picks</button>
        </div>
      )}

      {cart.map((c) => <PickCard key={c.id} c={c} ctx={ctx} />)}

      {cart.length > 0 && (
        <div className="card pad section">
          <div className="row between"><span className="small muted">Known total ({cart.reduce((a, c) => a + c.qty, 0)} items)</span>
            <span className="num" style={{ fontSize: 28 }}>{inr(total)}{unknownPrice ? <span className="tiny muted"> + items priced on request</span> : null}</span></div>
          <div className="tiny muted">Delivery charges are shown at each store's checkout.</div>
          {needed.map((k) => (
            <label key={k} className="check" data-pilot="ack-wrap">
              <input type="checkbox" data-pilot="ack" checked={acks.includes(k)} onChange={() => setAcks(acks.includes(k) ? acks.filter((x) => x !== k) : [...acks, k])} />
              <span>{ACK_TEXT[k] || k}</span>
            </label>
          ))}
          {blockers.length > 0 && <div className="label-banner red"><ShieldCheck /><div><b>Not yet:</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{blockers.map((x, i) => <li key={i}>{x}</li>)}</ul></div></div>}
        </div>
      )}

      {!cart.length && orders.length > 0 && (
        <Banner tone="teal"><Package size={14} /> {orders.length} order{orders.length > 1 ? "s" : ""} prepared - see Orders to finish them, or add more picks.</Banner>
      )}
      {!cart.length && !orders.length && !pendingEntry && <div className="empty"><ShoppingBag size={28} /><div>Add options from the Options step - from one store or several, ready-made or made for you.</div></div>}
      <ProgressStrip lines={lines} busy={!!busy} />
    </div>
  );
}
