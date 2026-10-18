import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Globe, Hammer, Home, Mail, Phone, Plus, RefreshCw, Search, Send, ShoppingBag, Sparkles, Tag, X } from "lucide-react";
import { ago, img, inr, media } from "../api";
import { LookModal, LookTile } from "../components/ShopTheLook";
import { CheckChip, ProgressStrip, StockChip, VERDICT, favicon } from "../components/ui";
import { FitRing } from "../components/Viz";
import type { LookItem, RouteEntry } from "../types";
import { brief as currentBrief, usePrimary, type StageCtx } from "./ctx";

function storeLogo(e: RouteEntry) {
  return <img className="store-fav" src={favicon(e.seller_id)} alt="" />;
}

function ProductImage({ e }: { e: RouteEntry }) {
  const [step, setStep] = useState(0); // 0: proxied store photo, 1: direct link, 2: store logo
  if (!e.image_url || step >= 2) return <div className="noimg"><img src={favicon(e.seller_id, 128)} alt="" /><span className="tiny muted">No photo on the listing</span></div>;
  return <img src={step === 0 ? img(e.image_url) : e.image_url} alt={e.name} loading="lazy" referrerPolicy="no-referrer" onError={() => setStep(step + 1)} />;
}

function OfferCard({ e, onChoose, onTry, inCart }: { e: RouteEntry; onChoose: () => void; onTry?: () => void; inCart?: boolean }) {
  const met = e.checks.filter((c) => c.result === "met").length;
  const tone = { meets: "volt", possible_with_change: "amber", not_suitable: "red", needs_quote: "sky" }[e.verdict];
  return (
    <div className={`card offer ${e.verdict === "not_suitable" ? "dim" : ""}`}>
      <div className="media">
        <ProductImage e={e} />
        <span className="fit"><FitRing met={met} total={e.checks.length} tone={tone} /></span>
      </div>
      <div className="body">
        <div className="row" style={{ gap: 6 }}>{storeLogo(e)}<span className="tiny muted">{e.seller_name}</span><div className="grow" />{e.item && <span className="chip volt" style={{ margin: 0 }}>{e.item}</span>}<StockChip stock={e.stock} /></div>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div className="name clamp2">{e.name}</div>
          <div className="price">{e.price_inr ? inr(e.price_inr) : "See price"}</div>
        </div>
        <div className={`decisive ${VERDICT[e.verdict].tone}`}>{e.decisive}</div>
        <div className="checks">{e.checks.slice(0, 4).map((c) => <CheckChip key={c.requirement_id} c={c} />)}</div>
        <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
          <a className="btn sm light" href={e.url} target="_blank" rel="noreferrer">View on {e.seller_name.split(" ")[0]} <ArrowUpRight size={13} /></a>
          {e.verdict !== "not_suitable" && (inCart
            ? <span className="chip volt"><Check /> In your picks</span>
            : <button className="btn sm" onClick={onChoose} data-pilot="add-pick"><Plus size={13} /> Add to picks</button>)}
          {onTry && e.image_url && e.verdict !== "not_suitable" && <button className="btn sm ghost" onClick={onTry} title="See it in your own photo"><Home size={13} /> In my space</button>}
        </div>
      </div>
    </div>
  );
}

export default function Routes({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const b = currentBrief(state);
  const routes = state.routes;
  const [picked, setPicked] = useState<string[]>([]);
  const [showNo, setShowNo] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [tryFor, setTryFor] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const spaceInput = useRef<HTMLInputElement>(null);
  const stale = routes && b && routes.brief_version !== b.version;
  const cart = state.cart || [];
  const inCart = (id: string) => cart.some((c) => c.entry_id === id);
  const looks = [...(state.looks || [])].reverse();
  const hasSpace = !!state.project.inspiration?.image_path && !state.project.inspiration?.generated_image;

  const addPick = (id: string) => ctx.act("Adding to your picks", `/api/projects/${pid}/cart`, { entry_id: id }, "Added to your picks").catch(() => {});
  const [openLook, setOpenLook] = useState<string | null>(() => ctx.params.get("look") === "latest" ? (state.looks || []).slice(-1)[0]?.id || null : null);
  const entryMap = Object.fromEntries((routes?.entries || []).map((e) => [e.item_id, e]));
  const savedNote = (it: LookItem) => (state.notes || []).some((n) => n.text.includes(it.name.slice(0, 40)));
  const saveItem = (it: LookItem) => savedNote(it) ? null
    : ctx.act("Saving", `/api/projects/${pid}/notes`, { text: `Saved: ${it.name.slice(0, 80)} - ${it.seller_name}${it.price_inr ? ` ${inr(it.price_inr)}` : ""}${it.url ? ` ${it.url}` : ""}`, share: false }, "Saved to your notes").catch(() => {});
  async function shopLook(open = true) {
    try {
      const s = await ctx.streamAct("Making the picture", `/api/projects/${pid}/looks`, { in_space: true }, "Shoppable picture ready");
      const latest = s?.looks?.[s.looks.length - 1];
      if (open && latest) setOpenLook(latest.id);
    } catch {
      /* toast */
    }
  }
  async function tryInSpace(entryId: string, file?: File) {
    const fd = new FormData();
    fd.append("entry_id", entryId);
    if (file) fd.append("photo", file);
    try {
      const s = await ctx.streamAct("Placing it in your space", `/api/projects/${pid}/looks/space`, fd, "Here it is in your space");
      const latest = s?.looks?.[s.looks.length - 1];
      if (latest) setOpenLook(latest.id);
    } catch {
      /* toast */
    }
  }
  const onTry = (id: string) => (hasSpace ? tryInSpace(id) : (setTryFor(id), spaceInput.current?.click()));

  async function explore() {
    try {
      await ctx.streamAct("Searching", `/api/projects/${pid}/routes/explore`, {}, "Options found");
    } catch {
      /* toast */
    }
  }
  async function message() {
    try {
      await ctx.act("Writing messages", `/api/projects/${pid}/requests`, { entry_ids: picked }, "Messages ready to send");
      ctx.go("request");
    } catch {
      /* toast */
    }
  }

  const entries = routes?.entries || [];
  const buy = entries.filter((e) => e.route === "buy");
  const good = buy.filter((e) => e.verdict === "meets").concat(buy.filter((e) => e.verdict === "possible_with_change"));
  const no = buy.filter((e) => e.verdict === "not_suitable");
  const makers = entries.filter((e) => e.route === "make");
  const best = buy.find((e) => e.verdict === "meets");
  const items = [...new Set(buy.map((e) => e.item).filter(Boolean))] as string[];

  // Once options are found, style them into a shoppable picture by itself (once per search).
  useEffect(() => {
    if (!routes || stale || looks.length || busy || good.filter((e) => e.image_url).length < 1 || state.project.demo) return;
    const key = `tsl.look.${pid}.${routes.checked_at}`;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { return; }
    shopLook(false);
  }, [routes?.checked_at]); // eslint-disable-line

  usePrimary(ctx, !routes || stale
    ? { label: stale ? "Search again" : "Find options", onClick: explore, disabled: !b?.confirmed, icon: <Search size={16} />,
        hint: b?.confirmed ? `Search real stores and makers${b.delivery.region ? ` that deliver to ${b.delivery.region.split(",")[0]}${b.delivery.pincode ? ` ${b.delivery.pincode}` : ""}` : ""}` : "Confirm your brief first" }
    : picked.length
      ? { label: `Message ${picked.length} maker${picked.length > 1 ? "s" : ""}`, onClick: message, icon: <Send size={16} />, hint: "Tesselle writes it and sends it for you" }
      : cart.length
        ? { label: `Order ${cart.length} pick${cart.length > 1 ? "s" : ""}`, onClick: () => ctx.go("approve"), icon: <ShoppingBag size={16} />, hint: "Add more here, or review and order" }
        : best
          ? { label: "Add the best match", onClick: () => addPick(best.item_id), icon: <Plus size={16} />, hint: `${best.name} fits every must-have` }
          : { label: "Pick makers to message", onClick: () => document.querySelector('[data-pilot="makers"]')?.scrollIntoView({ behavior: "smooth" }), icon: <Hammer size={16} />, hint: "Nothing ready-made fits yet - a maker can make it exactly" });

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Shop &amp; pick</div>
          <h2>{state.project.idea ? `Shop "${state.project.idea.title}"` : "Real products for you"}</h2>
          <p>From real stores and makers{routes?.city ? ` that deliver to ${routes.city}` : ""} - each one checked against your must-haves. Pick what you like and order it from here.</p>
        </div>
        <div className="row" style={{ gap: 8, position: "relative" }}>
          {routes && (
            <button className={`ai-why-btn ${why ? "on" : ""}`} onClick={() => setWhy(!why)} aria-expanded={why} data-pilot="headline">
              <Sparkles size={15} /> How I picked these
            </button>
          )}
          {routes && !stale && <button className="btn sm" onClick={explore} disabled={!!busy}><RefreshCw size={14} /> Search again</button>}
          {routes && why && (
            <div className="ai-why glass" role="dialog" aria-label="How Tesselle picked these">
              <div className="row between"><span className="ai-why-k"><Sparkles size={13} /> Tesselle's take</span>
                <button className="stl-x2" onClick={() => setWhy(false)} aria-label="Close"><X size={15} /></button></div>
              <b className="ai-why-h">{good.length ? `${good.length} good option${good.length > 1 ? "s" : ""}${new Set(good.map((e) => e.seller_name)).size > 1 ? ` from ${new Set(good.map((e) => e.seller_name)).size} stores` : ""}${makers.length ? `, plus ${makers.length} maker${makers.length > 1 ? "s" : ""} who can make it to measure` : ""}` : routes.narrative.headline}</b>
              <ul className="sum-points">{(routes.narrative.points || []).map((pt, i) => <li key={i}><Check size={13} /> {pt}</li>)}</ul>
              <div className="ai-why-k" style={{ marginTop: 4 }}>How it was done</div>
              <div className="tiny muted">Searched {routes.sources.length} real stores and makers{routes.city ? ` that deliver to ${routes.city}` : ""} with Google Search and Vertex AI Search, read each product page, and checked every listing against your must-haves. Checked {ago(routes.checked_at)}; prices and stock can change - the store page has the final word.</div>
              <div className="ai-why-k" style={{ marginTop: 4 }}>What you can do</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {good.some((e) => e.image_url) && <button className="btn sm primary" onClick={() => { setWhy(false); if (looks.length) setOpenLook(looks[0].id); else shopLook(); }}><ShoppingBag size={13} /> Shop the look</button>}
                {best && !inCart(best.item_id) && <button className="btn sm" onClick={() => { setWhy(false); addPick(best.item_id); }}><Plus size={13} /> Add the best match</button>}
                {makers.length > 0 && <button className="btn sm" onClick={() => { setWhy(false); document.querySelector('[data-pilot="makers"]')?.scrollIntoView({ behavior: "smooth" }); }}><Hammer size={13} /> Ask a maker</button>}
              </div>
              <button className="chip clickable" onClick={() => setShowSources(!showSources)}><Globe /> Sources checked ({routes.sources.length}) <ChevronDown size={12} /></button>
              {showSources && (
                <div className="ai-why-src">
                  {routes.sources.map((src, i) => (
                    <a key={i} className="src-row" href={`https://${src.domain}`} target="_blank" rel="noreferrer">
                      <img src={favicon(src.domain)} alt="" /> <span className="grow">{src.name}</span> <span className="tiny muted">{src.kind === "store" ? "store" : "maker"}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ProgressStrip lines={lines} busy={!!busy} />

      {!routes && !busy && (
        <div className="empty">
          <Search size={28} />
          <div>The shopping agent searches real stores, the maker scout finds people who could make it, and every result is checked against your brief.</div>
        </div>
      )}

      {routes && (
        <>
          {stale && <div className="label-banner amber">Found for brief v{routes.brief_version}; your brief is now v{b?.version}. Search again to refresh.</div>}
          {cart.length > 0 && (
            <div className="picks-tray glass">
              <div className="pt-imgs">{cart.slice(0, 4).map((c) => <img key={c.id} src={c.image_path ? media(c.image_path) : c.image_url ? img(c.image_url) : favicon(c.seller_id || "", 64)} alt="" referrerPolicy="no-referrer" />)}</div>
              <div className="grow"><b>Your picks · {cart.length}</b><div className="tiny muted clamp2">{cart.map((c) => c.title).join(" · ")}</div></div>
              <span className="num">{cart.some((c) => c.price_inr == null) ? "" : inr(cart.reduce((a, c) => a + (c.price_inr || 0) * c.qty, 0))}</span>
              <button className="btn primary sm" onClick={() => ctx.go("approve")}><ShoppingBag size={14} /> Review &amp; order</button>
            </div>
          )}

          {good.some((e) => e.image_url) && (
            <div className="look-hero">
              {looks[0] ? (
                <button className="lh-pic" onClick={() => setOpenLook(looks[0].id)} aria-label="Shop the look">
                  <img src={media(looks[0].image_path)} alt="Your shoppable picture" />
                  {looks[0].items.filter((i) => i.x != null).map((i) => <span key={i.entry_id} className="lh-dot" style={{ left: `${(i.x || 0) * 100}%`, top: `${(i.y || 0) * 100}%` }} />)}
                  <span className="lh-badge"><Tag size={13} /> {looks[0].items.filter((i) => i.x != null).length || looks[0].items.length} real products tagged</span>
                </button>
              ) : (
                <div className="lh-pic pending">{busy === "Making the picture" || busy === "Shopping your idea" ? <><span className="spin-ring" /> Gemini is placing the real products {hasSpace ? "into your photo" : "together"}...</>
                  : <><ShoppingBag size={26} /> See the real products {hasSpace ? "in your own photo" : "together"}</>}</div>
              )}
              <div className="lh-side">
                <span className="lh-k"><Sparkles size={13} /> Shop the look</span>
                <h3>{hasSpace ? "The real products, in your space" : "The real products, styled together"}</h3>
                <p className="small muted">Every dot is a real listing from a store that delivers to you. Tap one to see it, add it to your picks or save it - like a catalogue page.</p>
                <div className="row wrap" style={{ gap: 8 }}>
                  <button className="btn primary" onClick={() => (looks[0] ? setOpenLook(looks[0].id) : shopLook())} disabled={!!busy} data-pilot="shop-look">
                    <ShoppingBag size={15} /> {looks[0] ? "Shop the look" : "Make the picture"} <ChevronRight size={15} />
                  </button>
                  {looks[0] && <button className="btn sm ghost" onClick={() => shopLook()} disabled={!!busy}><RefreshCw size={13} /> Another</button>}
                </div>
                {looks.length > 1 && <div className="stl-tiles mini">{looks.slice(1, 4).map((l) => <LookTile key={l.id} look={l} onOpen={() => setOpenLook(l.id)} />)}</div>}
              </div>
            </div>
          )}
          {openLook && looks.find((l) => l.id === openLook) && (
            <LookModal look={looks.find((l) => l.id === openLook)!} entries={entryMap} inPicks={inCart} saved={savedNote} busy={!!busy}
              onAdd={(it) => addPick(it.entry_id)} onSave={saveItem} onTry={(it) => onTry(it.entry_id)} onClose={() => setOpenLook(null)} />
          )}

          <div className="group-head"><h3>Available now</h3><span className="chip muted">{good.length}</span></div>
          {good.length ? (
            items.length > 1 ? (
              <div className="col" style={{ gap: 16 }}>
                {items.map((it) => {
                  const mine = good.filter((e) => e.item === it);
                  return (
                    <div key={it} className="col" style={{ gap: 8 }}>
                      <div className="row" style={{ gap: 8 }}><span className="chip volt">{it}</span><span className="tiny muted">{mine.length ? `${mine.length} that fit` : "Nothing ready-made fits yet - ask a maker"}</span></div>
                      {mine.length > 0 && <div className="offer-grid">{mine.map((e) => <OfferCard key={e.item_id} e={e} inCart={inCart(e.item_id)} onChoose={() => addPick(e.item_id)} onTry={() => onTry(e.item_id)} />)}</div>}
                    </div>
                  );
                })}
              </div>
            ) : <div className="offer-grid">{good.map((e) => <OfferCard key={e.item_id} e={e} inCart={inCart(e.item_id)} onChoose={() => addPick(e.item_id)} onTry={() => onTry(e.item_id)} />)}</div>
          ) : <div className="small muted">Nothing in stock fits your must-haves right now.</div>}
          <input ref={spaceInput} type="file" accept="image/*" hidden onChange={(ev) => { const f = ev.target.files?.[0]; if (f && tryFor) tryInSpace(tryFor, f); ev.target.value = ""; }} />

          {no.length > 0 && (
            <>
              <button className="group-head toggle" onClick={() => setShowNo(!showNo)}>
                <h3>Doesn't fit</h3><span className="chip muted">{no.length}</span><ChevronDown size={14} style={{ transform: showNo ? "rotate(180deg)" : "none" }} />
              </button>
              {showNo && <div className="offer-grid">{no.map((e) => <OfferCard key={e.item_id} e={e} onChoose={() => {}} />)}</div>}
            </>
          )}

          <div className="group-head" data-pilot="makers"><h3>Get it made</h3><span className="chip muted">{makers.length}</span>
            <span className="tiny muted">Tick the ones to ask - Tesselle writes, emails or calls them for you</span></div>
          <div className="maker-grid">
            {makers.map((e, i) => {
              const on = picked.includes(e.item_id);
              return (
                <label key={e.item_id} className={`card maker ${on ? "on" : ""}`} data-pilot={`maker-${i}`}>
                  <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((x) => x !== e.item_id) : [...picked, e.item_id])} />
                  <span className="mk-logo"><img src={favicon(e.seller_id)} alt="" /></span>
                  <div className="grow">
                    <div className="strong">{e.name}</div>
                    <div className="tiny muted">{e.seller_label} · {e.description}</div>
                    <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
                      <a className="tiny" href={e.url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}><Globe size={11} /> Website</a>
                      {e.contact?.email && <span className="tiny"><Mail size={11} /> {e.contact.email}</span>}
                      {e.contact?.phone && <span className="tiny"><Phone size={11} /> {e.contact.phone}</span>}
                    </div>
                  </div>
                  <span className={`tick ${on ? "on" : ""}`}><Check size={14} strokeWidth={3} /></span>
                </label>
              );
            })}
            {!makers.length && <div className="small muted">No makers found this time - try searching again.</div>}
          </div>
        </>
      )}
    </div>
  );
}
