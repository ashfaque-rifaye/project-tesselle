import { useState } from "react";
import { ArrowRight, RefreshCw, Search, Send } from "lucide-react";
import { ago, inr, media } from "../api";
import { Banner, CheckChip, CheckIcon, Drawer, ProgressBox, StockChip, VERDICT } from "../components/ui";
import type { RouteEntry, Verdict } from "../types";
import { brief as currentBrief, type StageCtx } from "./ctx";

type Lens = "all" | "buy" | "source" | "customise" | "make";
const LENSES: [Lens, string][] = [["all", "All routes"], ["buy", "Buy existing"], ["source", "Source elsewhere"], ["customise", "Customise"], ["make", "Make new"]];
const ORDER: Verdict[] = ["meets", "possible_with_change", "needs_quote", "not_suitable"];

export default function Routes({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const b = currentBrief(state);
  const routes = state.routes;
  const [lens, setLens] = useState<Lens>("all");
  const [open, setOpen] = useState<RouteEntry | null>(null);
  const stale = routes && b && routes.brief_version !== b.version;

  async function explore() {
    try {
      await ctx.streamAct("Exploring routes", `/api/projects/${pid}/routes/explore`, {}, "Routes checked against your brief");
    } catch {
      /* toast */
    }
  }

  async function askMaker(sellerId: string) {
    await ctx.act("Preparing request", `/api/projects/${pid}/requests`, { seller_ids: [sellerId], include_concept: true, include_photo: false, share_budget: true },
      "Request prepared - review what the seller will receive");
    ctx.go("request");
  }

  const entries = (routes?.entries || []).filter((e) => lens === "all" || e.route === lens);
  const notes = Object.fromEntries((routes?.narrative.item_notes || []).map((n) => [n.item_id, n.note]));

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">04 · Explore routes</div>
          <h2>Buy, source, customise or make</h2>
          <p>Every route is checked against the same confirmed brief, requirement by requirement. A similar-looking product is not automatically a suitable one.</p>
        </div>
        {routes && (
          <button className="btn" onClick={explore} disabled={!!busy}>
            <RefreshCw size={15} /> Re-check
          </button>
        )}
      </div>

      {!routes && (
        <div className="empty">
          <Search size={28} />
          <div>Check the sample retailer, a sourcing partner and participating makers against brief v{b?.version}.</div>
          <button className="btn primary lg" onClick={explore} disabled={!!busy || !b?.confirmed}>Explore fulfilment routes</button>
          {!b?.confirmed && <div className="small">Confirm your brief first.</div>}
        </div>
      )}
      <ProgressBox lines={lines} busy={!!busy} />

      {routes && (
        <>
          {stale && <Banner tone="amber">These results were checked against brief v{routes.brief_version}. Your brief is now v{b?.version} - re-check before relying on them.</Banner>}
          <div className="card pad section">
            <div className="row between wrap">
              <h3 style={{ fontFamily: "var(--display)", fontSize: 20, fontWeight: 500 }}>{routes.narrative.headline}</h3>
              <span className="small muted">Checked {ago(routes.checked_at)} · {(routes.duration_ms / 1000).toFixed(1)} s</span>
            </div>
            <p className="small" style={{ color: "var(--ink-2)" }}>{routes.narrative.explanation}</p>
            <div className="row wrap" style={{ gap: 6 }}>
              {routes.sources.map((s) => <span key={s} className="chip muted">{s}</span>)}
            </div>
            <Banner>Sample catalogue: every seller, price and stock level here is fictional demonstration data. A stock observation is not a reservation.</Banner>
          </div>

          <div className="lens" role="tablist" aria-label="Fulfilment lens">
            {LENSES.map(([k, l]) => (
              <button key={k} className={lens === k ? "on" : ""} onClick={() => setLens(k)}>{l}</button>
            ))}
          </div>

          {ORDER.map((v) => {
            const items = entries.filter((e) => e.verdict === v);
            if (!items.length) {
              if (v === "meets" && lens === "all")
                return (
                  <div key={v} className="group-head">
                    {VERDICT[v].icon}
                    <h3>{VERDICT[v].label}</h3>
                    <span className="small muted">- no suitable match found in the sources checked</span>
                  </div>
                );
              return null;
            }
            return (
              <div key={v} className="section">
                <div className="group-head">
                  {VERDICT[v].icon}
                  <h3>{VERDICT[v].label}</h3>
                  <span className="chip muted">{items.length}</span>
                </div>
                <div className="offer-grid">
                  {items.map((e) => (
                    <div key={e.item_id} className={`card offer ${v === "not_suitable" ? "dim" : ""}`} onClick={() => setOpen(e)}>
                      <img src={media(e.image_path)} alt={e.name} loading="lazy" />
                      <div className="body">
                        <div className="row between" style={{ alignItems: "flex-start" }}>
                          <div className="name">{e.name}</div>
                          <div className="strong small" style={{ whiteSpace: "nowrap" }}>{e.price_inr ? inr(e.price_inr) : "Quote needed"}</div>
                        </div>
                        <div className="tiny muted">{e.seller_name} · {e.seller_label}</div>
                        <div className={`decisive ${VERDICT[v].tone}`}>{e.decisive}</div>
                        {notes[e.item_id] && <div className="tiny muted">{notes[e.item_id]}</div>}
                        <div className="checks">{e.checks.map((c) => <CheckChip key={c.requirement_id} c={c} />)}</div>
                        <div className="row wrap" style={{ gap: 6 }}>
                          <StockChip stock={e.stock} />
                          <span className="chip muted">{e.route}</span>
                          {e.unresolved.length > 0 && <span className="chip amber">{e.unresolved.length} unknown charge{e.unresolved.length > 1 ? "s" : ""}</span>}
                        </div>
                        {e.route === "make" && (
                          <button className="btn sm teal" onClick={(ev) => { ev.stopPropagation(); askMaker(e.seller_id); }} disabled={!!busy}>
                            <Send size={14} /> Request a quote from {e.seller_name}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {routes.narrative.next_steps.length > 0 && (
            <div className="card pad col">
              <h4>Your options from here</h4>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {routes.narrative.next_steps.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </>
      )}

      {open && (
        <Drawer onClose={() => setOpen(null)}>
          <div className="row between">
            <span className={`chip ${VERDICT[open.verdict].tone}`}>{VERDICT[open.verdict].label}</span>
            <button className="btn ghost sm" onClick={() => setOpen(null)}>Close</button>
          </div>
          <img src={media(open.image_path)} alt={open.name} style={{ borderRadius: 12, aspectRatio: "4/3", objectFit: "cover" }} />
          <div>
            <h2 style={{ fontSize: 22 }}>{open.name}</h2>
            <div className="small muted">{open.seller_name} · {open.seller_label}</div>
          </div>
          <span className="chip">{open.route === "make" ? "Maker route" : "Existing product (sample listing)"}</span>
          <p className="small">{open.description}</p>
          <div className="card">
            <table className="table">
              <thead><tr><th>Requirement</th><th>Result</th></tr></thead>
              <tbody>
                {open.checks.map((c) => (
                  <tr key={c.requirement_id}>
                    <td className="rowlabel">{c.label}<div className="tiny muted">{c.kind === "must" ? "Must stay the same" : "Flexible"}</div></td>
                    <td><span className="cell-ic"><CheckIcon result={c.result} /> {c.explanation}</span></td>
                  </tr>
                ))}
                {!open.checks.length && <tr><td colSpan={2} className="small muted">No specs are assumed until the maker quotes against your brief.</td></tr>}
              </tbody>
            </table>
          </div>
          <dl className="kv">
            <dt>Price</dt><dd>{inr(open.price_inr)}</dd>
            <dt>Shipping</dt><dd>{open.shipping_inr === null || open.shipping_inr === undefined ? "Delivery not yet confirmed" : `${inr(open.shipping_inr)}${open.shipping_estimate ? " (estimate)" : ""}`}</dd>
            <dt>Unknown charges</dt><dd>{open.unresolved.length ? open.unresolved.join(", ") : "None stated"}</dd>
            <dt>Stock</dt><dd><StockChip stock={open.stock} /> <span className="tiny muted">observed {ago(open.checked_at)}, not reserved</span></dd>
            {open.specs.delivery_days != null && (<><dt>Delivery</dt><dd>~{open.specs.delivery_days} days (seller estimate)</dd></>)}
          </dl>
          {open.route === "make" ? (
            <button className="btn teal" onClick={() => { setOpen(null); askMaker(open.seller_id); }}>
              Request a quote <ArrowRight size={15} />
            </button>
          ) : (
            <Banner tone="ink">To buy, the seller's final commercial terms would need confirming first. In this demo, the story continues with a maker request.</Banner>
          )}
        </Drawer>
      )}
    </div>
  );
}
