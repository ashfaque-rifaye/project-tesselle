import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, ChevronRight, Heart, Home, Loader2, ShoppingCart, Sparkles, Tag, X } from "lucide-react";
import { img, media } from "../api";
import type { Look, LookItem, RouteEntry as Entry } from "../types";
import { favicon } from "./ui";

const rs = (v?: number | null) => (v ? Math.round(v).toLocaleString("en-IN") : null);

function sizeLine(e?: Entry): string {
  const s = e?.specs;
  if (!s) return "";
  const dims = [s.width_cm, s.depth_cm, s.height_cm].filter((x) => x != null);
  return dims.length >= 2 ? `${dims.map((x) => Math.round(x as number)).join("x")} cm` : s.width_cm ? `${Math.round(s.width_cm)} cm wide` : "";
}

/** A look as a catalogue tile: the picture with a tag count, like a store's inspiration gallery. */
export function LookTile({ look, onOpen, fresh }: { look: Look; onOpen: () => void; fresh?: boolean }) {
  const tagged = look.items.filter((i) => i.x != null).length;
  return (
    <button className={`stl-tile ${fresh ? "fresh" : ""}`} onClick={onOpen} aria-label={`Shop the look: ${tagged} products tagged`}>
      <img src={media(look.image_path)} alt="" loading="lazy" />
      <span className="stl-count"><Tag size={13} /> {tagged || look.items.length}</span>
      <span className="stl-open">Shop the look <ChevronRight size={14} /></span>
      {look.kind === "space" && <span className="stl-kind"><Home size={11} /> In your space</span>}
    </button>
  );
}

/** Shop the look, catalogue style: the picture with a dot on every real product Gemini placed; tap a
 *  dot for its name and price; the list on the right adds it to your picks or saves it. */
export function LookModal({ look, entries, inPicks, saved, onAdd, onSave, onTry, onClose, busy }: {
  look: Look; entries: Record<string, Entry>; inPicks: (id: string) => boolean; saved: (it: LookItem) => boolean;
  onAdd: (it: LookItem) => void; onSave: (it: LookItem) => void; onTry?: (it: LookItem) => void; onClose: () => void; busy?: boolean;
}) {
  const first = look.items.findIndex((i) => i.x != null);
  const [active, setActive] = useState<number | null>(first >= 0 ? first : null);
  const [split, setSplit] = useState(55);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const focus = (i: number) => {
    setActive(i);
    list.current?.querySelectorAll(".stl-row")[i]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const a = active !== null ? look.items[active] : null;
  const ae = a ? entries[a.entry_id] : undefined;
  const left = a?.x != null && a.x > 0.62;
  return createPortal(
    <div className="stl-backdrop" onClick={onClose} role="dialog" aria-label="Shop the look">
      <div className="stl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="stl-head">
          <div>
            <h3>{look.kind === "space" ? "In your space" : "Shop the look"}</h3>
            <span>Real products from the stores Tesselle found, placed together by Gemini</span>
          </div>
          <button className="stl-x" onClick={onClose} aria-label="Close"><X size={22} /></button>
        </div>
        <div className="stl-body">
          <div className="stl-pic">
            <img src={media(look.image_path)} alt="Shoppable picture made by Gemini from real product photos" />
            {look.kind === "space" && look.before_path && (
              <>
                <div className="stl-before" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><img src={media(look.before_path)} alt="Your photo" /></div>
                <input className="stl-split" type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="Before and after" />
              </>
            )}
            {look.items.map((it, i) => it.x != null && it.y != null && (
              <button key={it.entry_id} className={`stl-dot ${active === i ? "on" : ""}`} style={{ left: `${it.x * 100}%`, top: `${it.y * 100}%` }}
                onClick={() => (active === i ? setActive(null) : focus(i))} aria-label={it.name}><i /></button>
            ))}
            {a && a.x != null && a.y != null && (
              <div className={`stl-pop ${left ? "left" : ""}`} style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}>
                <div className="grow">
                  <b>{(a.name.split(/[,|-]/)[0] || a.name).trim().slice(0, 34)}</b>
                  <span>{a.seller_name}</span>
                  <div className="stl-price">{rs(a.price_inr) ? <><small>Rs.</small>{rs(a.price_inr)}</> : <small>See price on store</small>}</div>
                </div>
                <button onClick={() => focus(active!)} aria-label="Show in the list"><ChevronRight size={18} /></button>
              </div>
            )}
            <span className="stl-ai"><Sparkles size={11} /> Gemini · real product photos</span>
          </div>
          <div className="stl-list" ref={list}>
            {look.items.map((it, i) => {
              const e = entries[it.entry_id];
              const picked = inPicks(it.entry_id);
              return (
                <div key={it.entry_id} className={`stl-row ${active === i ? "on" : ""}`} onMouseEnter={() => it.x != null && setActive(i)}>
                  <img src={it.image_url ? img(it.image_url) : favicon(it.seller_id || "", 64)} alt="" loading="lazy" />
                  <div className="stl-info">
                    <b>{(it.name.split(/[,|]/)[0] || it.name).trim().slice(0, 40)}</b>
                    <span className="stl-desc">{[e?.description, sizeLine(e)].filter(Boolean).join(", ").slice(0, 90) || it.seller_name}</span>
                    <div className="stl-price">{rs(it.price_inr) ? <><small>Rs.</small>{rs(it.price_inr)}</> : <small>See price on store</small>}</div>
                    <span className="stl-meta">
                      {it.seller_name}
                      {it.url && <a href={it.url} target="_blank" rel="noreferrer">View on store <ArrowUpRight size={11} /></a>}
                      {onTry && <button onClick={() => onTry(it)} disabled={busy}>In my space</button>}
                    </span>
                    {e?.verdict === "not_suitable" && <span className="stl-warn">Doesn't fit your must-haves</span>}
                    {it.complement && <span className="stl-extra">Goes with it · not part of your brief</span>}
                  </div>
                  <div className="stl-acts">
                    <button className={`stl-cart ${picked ? "done" : ""}`} disabled={busy || picked || e?.verdict === "not_suitable"} onClick={() => onAdd(it)}
                      aria-label={picked ? "In your picks" : "Add to picks"} title={picked ? "In your picks" : "Add to picks"}>
                      {busy ? <Loader2 size={18} className="spin" /> : picked ? <Check size={20} /> : <ShoppingCart size={19} />}
                    </button>
                    <button className={`stl-heart ${saved(it) ? "on" : ""}`} onClick={() => onSave(it)} aria-label="Save for later" title="Save to your notes">
                      <Heart size={20} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
