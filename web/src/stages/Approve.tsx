import { useMemo, useState } from "react";
import { ArrowUpRight, Check, CheckCircle2, CircleHelp, ShieldCheck, XCircle } from "lucide-react";
import { inr, media } from "../api";
import { Banner, ProgressStrip, favicon } from "../components/ui";
import { brief as currentBrief, usePrimary, type StageCtx } from "./ctx";
import { knownTotal } from "./Compare";

/** Choose one option for one brief version. Tesselle never pays or orders - the customer buys directly. */
export default function Approve({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines, params } = ctx;
  const b = currentBrief(state)!;
  const entries = state.routes?.entries || [];
  const order = state.order;
  const quoteId = order ? order.quote_id || "" : params.get("quote") || state.next_decision.quote_id || "";
  const entryId = order ? order.entry_id || "" : params.get("entry") || "";
  const quote = state.quotes.find((q) => q.id === quoteId && (order || q.status === "active" || q.status === "approved"))
    || (!entryId && !order ? state.quotes.filter((q) => q.status === "active").find((q) => q.readiness === "ready") : undefined);
  const entry = !quote ? entries.find((e) => e.item_id === entryId) || (!order ? entries.find((e) => e.route === "buy" && e.verdict === "meets") : undefined) : undefined;
  const [acks, setAcks] = useState<string[]>([]);
  const [blockers, setBlockers] = useState<string[]>([]);
  const idem = useMemo(() => `${pid}-${quote?.id || entry?.item_id}-${Date.now()}`, [pid, quote?.id, entry?.item_id]);
  const chosen = !!order;

  const unknownMusts = entry ? entry.checks.filter((c) => c.kind === "must" && c.result === "unknown") : [];
  const unresolved = quote ? quote.price_lines.filter((p) => p.amount_inr == null || p.kind === "unresolved") : [];
  const toConfirm = quote?.to_confirm || [];
  const needed = [...(unknownMusts.length ? ["check_on_store"] : []), ...(unresolved.length ? ["unresolved_charges"] : []),
    ...(toConfirm.length ? ["confirm_with_seller"] : [])];

  async function choose() {
    setBlockers([]);
    try {
      await ctx.act("Saving your choice", `/api/projects/${pid}/choose`,
        { entry_id: entry?.item_id || null, quote_id: quote?.id || null, idempotency_key: idem, acknowledgements: acks }, "Chosen - now buy it directly");
      ctx.go("fulfil");
    } catch (e) {
      setBlockers(((e as { details?: string[] }).details) || []);
    }
  }

  usePrimary(ctx, chosen
    ? { label: "Track it", onClick: () => ctx.go("fulfil"), hint: "You've chosen - follow it to your door" }
    : { label: "Choose this", onClick: choose, disabled: !(quote || entry) || needed.some((n) => !acks.includes(n)), icon: <ShieldCheck size={16} />,
        hint: needed.some((n) => !acks.includes(n)) ? "Tick the boxes above first" : "One option, one brief version - no payment happens here" });

  if (!quote && !entry && !order) return <div className="empty">Nothing to choose yet - pick an option or accept a reply first.</div>;
  const title = quote ? quote.title : entry ? entry.name : order!.title;
  const seller = quote ? quote.seller_name : entry ? entry.seller_name : order!.seller_name;
  const price = quote ? knownTotal(quote) : entry ? entry.price_inr : order!.known_total_inr;
  const img = quote?.image_path ? media(quote.image_path) : entry?.image_url || order?.image_url || undefined;
  const toggle = (k: string) => setAcks(acks.includes(k) ? acks.filter((x) => x !== k) : [...acks, k]);

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Choose</div>
          <h2>{chosen ? "Your choice" : "Ready to choose?"}</h2>
          <p>{chosen ? `Chosen for brief v${order!.brief_version}. Buy it directly from ${order!.seller_name}, then track it here.`
            : "Check it once more against your brief. Tesselle never pays or orders for you - you buy directly from the seller."}</p>
        </div>
      </div>
      <div className="choose-grid">
        <div className="card pad section">
          {img ? <img src={img} alt={title} className="choose-img" referrerPolicy="no-referrer" /> : null}
          <div className="row" style={{ gap: 8 }}>{entry && <img className="store-fav" src={favicon(entry.seller_id)} alt="" />}<span className="small muted">{seller}</span></div>
          <div style={{ fontFamily: "var(--display)", fontSize: 22, letterSpacing: "-.03em", lineHeight: 1.2 }}>{title}</div>
          <div className="row between"><span className="num" style={{ fontSize: 30 }}>{price != null ? inr(price) : "Price on request"}</span>
            {(entry?.url || order?.url) && <a className="btn sm light" href={(entry?.url || order?.url)!} target="_blank" rel="noreferrer">Open on {seller.split(" ")[0]} <ArrowUpRight size={13} /></a>}</div>
        </div>
        <div className="card pad section">
          <h3>Against your brief (v{b.version})</h3>
          {(entry ? entry.checks : !quote ? [] : b.requirements.filter((r) => r.kind === "must").map((r) => {
            const dev = quote!.deviations.find((d) => d.requirement_id === r.id && d.decision !== "accepted");
            const unconf = (quote!.to_confirm || []).includes(r.label);
            return { requirement_id: r.id, label: r.label, kind: r.kind, result: dev && dev.severity === "blocked" ? "unmet" : unconf ? "unknown" : "met",
              explanation: dev ? dev.proposed : unconf ? "Not mentioned in the reply - confirm with the seller" : "Confirmed in the reply" };
          })).map((c) => (
            <div key={c.requirement_id} className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
              {c.result === "met" ? <CheckCircle2 size={16} color="var(--green)" /> : c.result === "unmet" ? <XCircle size={16} color="var(--red)" /> : <CircleHelp size={16} color="var(--amber)" />}
              <div><b>{c.label}</b><div className="tiny muted">{c.explanation}</div></div>
            </div>
          ))}
          {!chosen && unknownMusts.length > 0 && (
            <label className="check" data-pilot="ack-wrap">
              <input type="checkbox" data-pilot="ack" checked={acks.includes("check_on_store")} onChange={() => toggle("check_on_store")} />
              <span>I'll check these on the store page before buying: <b>{unknownMusts.map((c) => c.label).join(", ")}</b></span>
            </label>
          )}
          {!chosen && toConfirm.length > 0 && (
            <label className="check">
              <input type="checkbox" data-pilot="ack" checked={acks.includes("confirm_with_seller")} onChange={() => toggle("confirm_with_seller")} />
              <span>I'll confirm these with {seller} before ordering: <b>{toConfirm.join(", ")}</b></span>
            </label>
          )}
          {!chosen && unresolved.length > 0 && (
            <label className="check">
              <input type="checkbox" data-pilot="ack" checked={acks.includes("unresolved_charges")} onChange={() => toggle("unresolved_charges")} />
              <span>I understand these charges aren't known yet: <b>{unresolved.map((u) => u.label).join(", ")}</b></span>
            </label>
          )}
          {blockers.length > 0 && <div className="label-banner red"><ShieldCheck /><div><b>Not yet:</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{blockers.map((x, i) => <li key={i}>{x}</li>)}</ul></div></div>}
          {chosen && <Banner tone="teal"><Check size={14} /> Chosen. Next: buy it directly from {state.order?.seller_name}.</Banner>}
        </div>
      </div>
      <ProgressStrip lines={lines} busy={!!busy} />
    </div>
  );
}
