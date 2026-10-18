import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { ArrowUpRight, Banknote, Check, ChevronLeft, ClipboardPaste, Loader2, Lock, MapPin, MousePointer2, Search, ShoppingCart, Smartphone, Sparkles, X } from "lucide-react";
import { img, inr, media } from "../api";
import type { Order } from "../types";
import { favicon } from "./ui";

type Screen = "open" | "product" | "cart" | "address" | "payment" | "review";
const FLOW: { screen: Screen; log: (o: Order, pin: string) => string; ms: number }[] = [
  { screen: "open", log: (o) => `Opened ${o.seller_name} in the phone browser`, ms: 1500 },
  { screen: "product", log: (o) => `Found the product page: ${o.title.slice(0, 48)}`, ms: 2100 },
  { screen: "cart", log: (o) => `Added ${o.qty || 1} to the cart`, ms: 1900 },
  { screen: "address", log: (_, pin) => `Set delivery to PIN ${pin || "your PIN code"}`, ms: 1900 },
  { screen: "payment", log: () => "Chose cash on delivery (where the store offers it)", ms: 2100 },
  { screen: "review", log: () => "Ready - waiting for you to place the order", ms: 0 },
];

/** The checkout agent at work, in a phone: it opens the store, finds the product, adds it to the cart, sets the
 *  delivery PIN and picks cash on delivery, then stops at "Place order" - that one tap is yours, on the store,
 *  in your own signed-in session (Tesselle never signs in to your store account or sees payment details). */
export default function PhoneAgent({ o, city, pin, onClose, onPlaced }: { o: Order; city: string; pin: string; onClose: () => void; onPlaced: () => void }) {
  const [k, setK] = useState(0);
  const [tap, setTap] = useState(false);
  const [qr, setQr] = useState("");
  const url = o.checkout?.url || o.url || "";
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return o.seller_id || o.seller_name; } })();
  const photo = o.image_path ? media(o.image_path) : o.image_url ? img(o.image_url) : "";
  const price = o.known_total_inr != null ? inr(o.known_total_inr * (o.qty || 1)) : "Price on the store";
  const step = FLOW[k];

  useEffect(() => {
    if (!step.ms) return;
    const t1 = setTimeout(() => setTap(true), step.ms - 650);
    const t2 = setTimeout(() => { setTap(false); setK((x) => Math.min(FLOW.length - 1, x + 1)); }, step.ms);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [k]); // eslint-disable-line
  useEffect(() => { if (url) QRCode.toDataURL(url, { margin: 1, width: 168, color: { dark: "#0B1618", light: "#EEF5F2" } }).then(setQr).catch(() => {}); }, [url]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const cta = (label: string, hot: boolean) => <div className={`pa-cta ${hot ? "hot" : ""} ${hot && tap ? "tap" : ""}`}>{label}{hot && <MousePointer2 className="pa-cursor" size={20} />}</div>;

  return createPortal(
    <div className="pa-backdrop" onClick={onClose} role="dialog" aria-label="Checkout agent">
      <div className="pa-wrap" onClick={(e) => e.stopPropagation()}>
        <button className="pa-x" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <div className="pa-phone">
          <div className="pa-notch" />
          <div className="pa-status"><span>9:41</span><span className="pa-agent"><Sparkles size={10} /> Tesselle agent</span></div>
          <div className="pa-url"><Lock size={11} /> {host}{step.screen === "open" && <i className="pa-load" />}</div>
          <div className="pa-screen" key={step.screen}>
            <div className="pa-store"><ChevronLeft size={16} /><img src={favicon(o.seller_id || host)} alt="" /><b>{o.seller_name}</b><Search size={15} /><ShoppingCart size={15} />{k >= 2 && <span className="pa-cartn">{o.qty || 1}</span>}</div>
            {step.screen === "open" && <div className="pa-loading"><Loader2 className="spin" size={22} /> Opening {host}...</div>}
            {step.screen === "product" && (
              <div className="pa-body">
                <div className="pa-img">{photo ? <img src={photo} alt="" referrerPolicy="no-referrer" /> : <img src={favicon(o.seller_id || host, 128)} alt="" />}</div>
                <div className="pa-title">{o.title}</div>
                <div className="pa-price">{price}</div>
                <div className="pa-line"><MapPin size={12} /> Deliver to {city ? city.split(",")[0] : ""} {pin}</div>
                {cta("Add to cart", true)}
              </div>
            )}
            {step.screen === "cart" && (
              <div className="pa-body">
                <div className="pa-h">Cart ({o.qty || 1} item)</div>
                <div className="pa-row">{photo && <img src={photo} alt="" referrerPolicy="no-referrer" />}<span className="grow">{o.title.slice(0, 60)}</span></div>
                <div className="pa-line">Subtotal: <b>{price}</b></div>
                {cta("Proceed to buy", true)}
              </div>
            )}
            {step.screen === "address" && (
              <div className="pa-body">
                <div className="pa-h">Delivery address</div>
                <div className="pa-opt on"><MapPin size={14} /><span className="grow"><b>Your saved address</b><span>{city ? `${city.split(",")[0]} - ` : ""}{pin}</span></span><Check size={14} /></div>
                <div className="pa-note">Your address stays on {o.seller_name} - Tesselle only checks the PIN code.</div>
                {cta("Deliver here", true)}
              </div>
            )}
            {(step.screen === "payment" || step.screen === "review") && (
              <div className="pa-body">
                <div className="pa-h">{step.screen === "payment" ? "Payment method" : "Review your order"}</div>
                {step.screen === "payment" ? (
                  <>
                    {["UPI", "Credit or debit card", "Net banking"].map((m) => <div key={m} className="pa-opt">{m}</div>)}
                    <div className="pa-opt on"><Banknote size={14} /><span className="grow"><b>Cash on delivery</b><span>Pay when it arrives</span></span><Check size={14} /></div>
                    {cta("Use this payment method", true)}
                  </>
                ) : (
                  <>
                    <div className="pa-row">{photo && <img src={photo} alt="" referrerPolicy="no-referrer" />}<span className="grow">{o.title.slice(0, 60)}<b>{price}</b></span></div>
                    <div className="pa-line"><MapPin size={12} /> {pin} · <Banknote size={12} /> Cash on delivery</div>
                    <div className="pa-cta yours">Place your order</div>
                    <div className="pa-note">This tap is yours - on {o.seller_name}, in your own account.</div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="pa-home" />
        </div>

        <div className="pa-side">
          <span className="pa-k"><ShoppingCart size={13} /> Checkout agent</span>
          <h3>{step.screen === "review" ? "Your turn: place the order" : "Getting your order ready"}</h3>
          <ol className="pa-log">
            {FLOW.slice(0, k + 1).map((f, i) => (
              <li key={i} className={i === k && f.ms ? "now" : "done"}>{i === k && f.ms ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {f.log(o, pin)}</li>
            ))}
          </ol>
          {step.screen === "review" ? (
            <div className="col" style={{ gap: 10 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                {url && <a className="btn primary" href={url} target="_blank" rel="noreferrer"><ShoppingCart size={15} /> Place it on {o.seller_name} <ArrowUpRight size={14} /></a>}
                <button className="btn" onClick={onPlaced}><ClipboardPaste size={15} /> I've placed it</button>
              </div>
              {qr && (
                <div className="pa-qr"><img src={qr} alt={`Open the ${o.seller_name} cart on your phone`} />
                  <span className="tiny muted"><Smartphone size={12} /> Or scan to finish in the {o.seller_name} app on your phone, where you're already signed in.</span></div>
              )}
              <span className="tiny muted">Tesselle never signs in to your store account or sees payment details. After you place it, paste the confirmation (or let Tesselle read it from your inbox) and it tracks the delivery. Cancel any time on {o.seller_name}.</span>
            </div>
          ) : <span className="tiny muted">The agent follows {o.seller_name}'s own checkout: product, cart, delivery PIN, then cash on delivery. It stops before the final tap.</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
