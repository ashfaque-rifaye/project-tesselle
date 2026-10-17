import { useState } from "react";
import { ArrowUpRight, Plus, Sparkles } from "lucide-react";
import { img, inr, media } from "../api";
import type { Look, LookItem } from "../types";
import { favicon } from "./ui";

/** IKEA-style shoppable picture: dots on each real product Gemini placed; tap one for its store,
 *  price and link. A "try in my space" picture also gets a before / after slider. */
export default function LookViewer({ look, onAdd, busy }: { look: Look; onAdd?: (it: LookItem) => void; busy?: boolean }) {
  const [active, setActive] = useState<number | null>(look.items.findIndex((i) => i.x != null) >= 0 ? look.items.findIndex((i) => i.x != null) : null);
  const [split, setSplit] = useState(50);
  const pinned = look.items.filter((i) => i.x != null && i.y != null);
  return (
    <div className="look">
      <div className="look-stage">
        <div className="look-img">
          <img src={media(look.image_path)} alt="Shoppable picture made by Gemini" />
          {look.kind === "space" && look.before_path && (
            <>
              <div className="look-before" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><img src={media(look.before_path)} alt="Your photo before" /></div>
              <input className="look-split" type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="Before and after" />
              <span className="chip look-tag l">Before</span><span className="chip look-tag r">With it</span>
            </>
          )}
          {look.items.map((it, i) => it.x != null && it.y != null && (
            <button key={it.entry_id} className={`hotspot ${active === i ? "on" : ""}`} style={{ left: `${it.x * 100}%`, top: `${it.y * 100}%` }}
              onClick={() => setActive(active === i ? null : i)} aria-label={it.name}><i /></button>
          ))}
          {active !== null && look.items[active]?.x != null && (
            <div className="hot-card glass" style={{ left: `min(calc(${(look.items[active].x || 0) * 100}% + 18px), calc(100% - 250px))`, top: `max(8px, calc(${(look.items[active].y || 0) * 100}% - 40px))` }}>
              <div className="strong small clamp2">{look.items[active].name}</div>
              <div className="row between"><span className="tiny muted">{look.items[active].seller_name}</span><b>{look.items[active].price_inr ? inr(look.items[active].price_inr) : "See price"}</b></div>
              {look.items[active].url && <a className="tiny" href={look.items[active].url!} target="_blank" rel="noreferrer">View on store <ArrowUpRight size={10} /></a>}
            </div>
          )}
          <span className="chip violet look-badge"><Sparkles /> Gemini · from real product photos</span>
        </div>
        <div className="look-list">
          {look.items.map((it, i) => (
            <div key={it.entry_id} className={`look-row ${active === i ? "on" : ""}`} onMouseEnter={() => it.x != null && setActive(i)}>
              {it.image_url ? <img src={img(it.image_url)} alt="" loading="lazy" /> : <img src={favicon(it.seller_id || "", 64)} alt="" />}
              <div className="grow">
                <div className="small strong clamp2">{it.name}</div>
                <div className="row" style={{ gap: 6 }}><span className="tiny muted">{it.seller_name}</span>{it.x == null && <span className="tiny muted">· not tagged</span>}</div>
                <div className="look-price">{it.price_inr ? inr(it.price_inr) : "See price"}</div>
              </div>
              <div className="col" style={{ gap: 4 }}>
                {it.url && <a className="btn sm ghost icon-btn" href={it.url} target="_blank" rel="noreferrer" aria-label="Open on the store"><ArrowUpRight size={14} /></a>}
                {onAdd && it.verdict !== "not_suitable" && <button className="btn sm icon-btn" disabled={busy} onClick={() => onAdd(it)} aria-label="Add to picks" title="Add to picks"><Plus size={14} /></button>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="tiny muted">{look.note} {pinned.length < look.items.length ? `${pinned.length} of ${look.items.length} tagged in the picture.` : ""}</div>
    </div>
  );
}
