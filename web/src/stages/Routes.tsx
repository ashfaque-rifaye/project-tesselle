import { useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Globe, Hammer, Mail, Phone, RefreshCw, Search, Send, Sparkles } from "lucide-react";
import { ago, inr } from "../api";
import { CheckChip, ProgressStrip, StockChip, VERDICT, favicon } from "../components/ui";
import { FitRing } from "../components/Viz";
import type { RouteEntry } from "../types";
import { brief as currentBrief, usePrimary, type StageCtx } from "./ctx";

function storeLogo(e: RouteEntry) {
  return <img className="store-fav" src={favicon(e.seller_id)} alt="" />;
}

function OfferCard({ e, onChoose }: { e: RouteEntry; onChoose: () => void }) {
  const met = e.checks.filter((c) => c.result === "met").length;
  const tone = { meets: "volt", possible_with_change: "amber", not_suitable: "red", needs_quote: "sky" }[e.verdict];
  return (
    <div className={`card offer ${e.verdict === "not_suitable" ? "dim" : ""}`}>
      <div className="media">
        {e.image_url ? <img src={e.image_url} alt={e.name} loading="lazy" referrerPolicy="no-referrer" onError={(ev) => ((ev.target as HTMLImageElement).style.display = "none")} />
          : <div className="noimg"><img src={favicon(e.seller_id, 128)} alt="" /></div>}
        <span className="fit"><FitRing met={met} total={e.checks.length} tone={tone} /></span>
      </div>
      <div className="body">
        <div className="row" style={{ gap: 6 }}>{storeLogo(e)}<span className="tiny muted">{e.seller_name}</span><div className="grow" /><StockChip stock={e.stock} /></div>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div className="name clamp2">{e.name}</div>
          <div className="price">{e.price_inr ? inr(e.price_inr) : "See price"}</div>
        </div>
        <div className={`decisive ${VERDICT[e.verdict].tone}`}>{e.decisive}</div>
        <div className="checks">{e.checks.slice(0, 4).map((c) => <CheckChip key={c.requirement_id} c={c} />)}</div>
        <div className="row" style={{ gap: 6, marginTop: 2 }}>
          <a className="btn sm light" href={e.url} target="_blank" rel="noreferrer">View on {e.seller_name.split(" ")[0]} <ArrowUpRight size={13} /></a>
          {e.verdict !== "not_suitable" && <button className="btn sm" onClick={onChoose}>Choose</button>}
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
  const stale = routes && b && routes.brief_version !== b.version;

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

  usePrimary(ctx, !routes || stale
    ? { label: stale ? "Search again" : "Find options", onClick: explore, disabled: !b?.confirmed, icon: <Search size={16} />,
        hint: b?.confirmed ? `Search real stores and makers${b.delivery.region ? ` that deliver to ${b.delivery.region.split(",")[0]}` : ""}` : "Confirm your brief first" }
    : picked.length
      ? { label: `Message ${picked.length} maker${picked.length > 1 ? "s" : ""}`, onClick: message, icon: <Send size={16} />, hint: "Tesselle writes it - you send it" }
      : best
        ? { label: "Choose the best match", onClick: () => ctx.go("approve", `entry=${best.item_id}`), icon: <Check size={16} />, hint: `${best.name} fits every must-have` }
        : { label: "Pick makers to message", onClick: () => document.querySelector('[data-pilot="makers"]')?.scrollIntoView({ behavior: "smooth" }), icon: <Hammer size={16} />, hint: "Nothing ready-made fits yet - a maker can make it exactly" });

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Options</div>
          <h2>Real options for you</h2>
          <p>From real stores and makers{routes?.city ? ` that deliver to ${routes.city}` : ""} - each one checked against your must-haves.</p>
        </div>
        {routes && !stale && <button className="btn sm" onClick={explore} disabled={!!busy}><RefreshCw size={14} /> Search again</button>}
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
          <div className="card pad summary">
            <div className="row between wrap" style={{ gap: 8 }}>
              <h3 className="sum-h" data-pilot="headline">{routes.narrative.headline}</h3>
              <span className="tiny muted">Checked {ago(routes.checked_at)}</span>
            </div>
            <ul className="sum-points">
              {(routes.narrative.points || []).map((p, i) => <li key={i}><Sparkles size={13} /> {p}</li>)}
            </ul>
            {routes.narrative.best_next && <div className="sum-next"><b>Suggested next:</b> {routes.narrative.best_next}</div>}
            <div className="row" style={{ gap: 6, position: "relative" }}>
              <button className="chip clickable" onClick={() => setShowSources(!showSources)}><Globe /> Sources checked ({routes.sources.length}) <ChevronDown size={12} /></button>
              <span className="tiny muted">Live web search with Google · prices and stock can change - check the store page</span>
              {showSources && (
                <div className="sources-pop glass">
                  {routes.sources.map((s, i) => (
                    <a key={i} className="src-row" href={`https://${s.domain}`} target="_blank" rel="noreferrer">
                      <img src={favicon(s.domain)} alt="" /> <span className="grow">{s.name}</span> <span className="tiny muted">{s.kind === "store" ? "store" : "maker"}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="group-head"><h3>Available now</h3><span className="chip muted">{good.length}</span></div>
          {good.length ? (
            <div className="offer-grid">{good.map((e) => <OfferCard key={e.item_id} e={e} onChoose={() => ctx.go("approve", `entry=${e.item_id}`)} />)}</div>
          ) : <div className="small muted">Nothing in stock fits your must-haves right now.</div>}

          {no.length > 0 && (
            <>
              <button className="group-head toggle" onClick={() => setShowNo(!showNo)}>
                <h3>Doesn't fit</h3><span className="chip muted">{no.length}</span><ChevronDown size={14} style={{ transform: showNo ? "rotate(180deg)" : "none" }} />
              </button>
              {showNo && <div className="offer-grid">{no.map((e) => <OfferCard key={e.item_id} e={e} onChoose={() => {}} />)}</div>}
            </>
          )}

          <div className="group-head" data-pilot="makers"><h3>Get it made</h3><span className="chip muted">{makers.length}</span>
            <span className="tiny muted">Tick the ones to message - Tesselle writes it, you send it</span></div>
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
