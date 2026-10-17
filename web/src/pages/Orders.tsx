import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Inbox, Loader2, Package, Truck } from "lucide-react";
import { ago, get, img, inr, media, stream } from "../api";
import { SettingsModal, useChannels } from "../components/ProjectMenu";
import { Logo, favicon, useToast } from "../components/ui";
import type { Order } from "../types";

const STATUS: Record<string, [string, string]> = {
  to_buy: ["amber", "To buy"], ordered: ["sky", "Ordered"], placed: ["sky", "Ordered"], shipped: ["sky", "Shipped"], out_for_delivery: ["sky", "Out for delivery"],
  delivered: ["teal", "Delivered"], accepted: ["volt", "Checked"], issue_open: ["red", "Problem reported"], cancelled: ["muted", "Cancelled"], in_progress: ["amber", "To buy"],
};

/** Order history: every order Tesselle prepared (across projects), plus store order emails the order
 *  tracker found in the connected inbox. Stored and kept up to date. */
export default function Orders() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [settings, setSettings] = useState(false);
  const { st } = useChannels();
  const toast = useToast();
  const load = () => get<Order[]>("/api/orders").then(setOrders).catch(() => setOrders([]));
  useEffect(() => { document.title = "Order history · Tesselle"; load(); }, []);

  async function importInbox() {
    if (!st?.owner) return setSettings(true);
    setImporting(true);
    setLines([]);
    try {
      await stream("/api/orders/import", {}, (e) => e.message && setLines((l) => [...l, e.message!]));
      await load();
      toast("Order history updated from your inbox");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setImporting(false);
    }
  }

  const groups: [string, Order[]][] = orders ? [
    ["Open", orders.filter((o) => !["accepted", "cancelled", "delivered"].includes(o.status))],
    ["Delivered", orders.filter((o) => ["accepted", "delivered"].includes(o.status))],
    ["Cancelled", orders.filter((o) => o.status === "cancelled")],
  ] : [];

  return (
    <div className="orders-page">
      <header className="row between wrap" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 12 }}><a className="btn sm ghost icon-btn" href="/" aria-label="Home"><ArrowLeft size={16} /></a><Logo /></div>
        <button className="btn sm" onClick={importInbox} disabled={importing}>
          {importing ? <Loader2 size={14} className="spin" /> : <Inbox size={14} />} Find orders in my inbox
        </button>
      </header>
      <div>
        <div className="eyebrow">Order history</div>
        <h2 style={{ fontFamily: "var(--display)", fontSize: "clamp(30px,4vw,46px)", letterSpacing: "-.035em" }}>Everything you've ordered</h2>
        <p className="muted small">Orders Tesselle prepared in your projects{st?.email ? ", plus store order emails the order tracker found in your inbox" : ""}. Pasting a confirmation on an order keeps its number and delivery date here.</p>
      </div>
      {importing && <div className="strip busy"><span className="strip-ic"><Loader2 size={15} className="spin" /></span><span className="strip-msg">{lines[lines.length - 1] || "Starting..."}</span></div>}
      {orders === null ? <div className="empty"><Loader2 className="spin" /> Loading...</div>
        : !orders.length ? <div className="empty"><Package size={28} />No orders yet. Place one from a project's picks{st?.email ? " - or find past orders in your inbox" : ""}.</div>
        : groups.filter(([, list]) => list.length).map(([name, list]) => (
          <section key={name} className="section">
            <div className="group-head"><h3>{name}</h3><span className="chip muted">{list.length}</span></div>
            <div className="hist-grid">
              {list.map((o) => {
                const [tone, label] = STATUS[o.status] || ["muted", o.status];
                const photo = o.image_path ? media(o.image_path) : o.image_url ? img(o.image_url) : "";
                const c = o.confirmation;
                return (
                  <div key={(o.project_id || "") + o.id} className="card hist">
                    <div className="pick-img">{photo ? <img src={photo} alt="" referrerPolicy="no-referrer" /> : <img className="fav" src={favicon(o.seller_id || o.seller_name, 64)} alt="" />}</div>
                    <div className="grow col" style={{ gap: 4 }}>
                      <div className="row between" style={{ gap: 6 }}><span className="tiny muted">{o.seller_name}{o.source === "inbox" ? " · from your inbox" : ""}</span><span className={`chip ${tone}`}>{label}</span></div>
                      <div className="strong small clamp2">{o.title}</div>
                      <div className="row wrap" style={{ gap: 8 }}>
                        <b>{(c?.total_inr ?? o.known_total_inr) != null ? inr((c?.total_inr ?? o.known_total_inr)!) : ""}</b>
                        {c?.order_number && <span className="tiny muted">#{c.order_number}</span>}
                        {c?.expected_delivery && <span className="tiny muted"><Truck size={11} /> {c.expected_delivery}</span>}
                        <span className="tiny muted">{ago(c?.order_date || o.created_at)}</span>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        {o.project_id && <a className="tiny" href={`/p/${o.project_id}/fulfil`}>{o.project_title || "Open project"} <ArrowUpRight size={10} /></a>}
                        {c?.tracking_url && <a className="tiny" href={c.tracking_url} target="_blank" rel="noreferrer">Track <ArrowUpRight size={10} /></a>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  );
}
