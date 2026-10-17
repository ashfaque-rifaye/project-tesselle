import { useRef, useState } from "react";
import { AlertTriangle, Ban, Check, CheckCircle2, Copy, FlaskConical, ImagePlus, Inbox, Mail, MailSearch, ShieldCheck, Sparkles } from "lucide-react";
import MicButton from "../components/MicButton";
import { useChannels } from "../components/ProjectMenu";
import { ago, inr } from "../api";
import { Banner, ProgressStrip, useToast } from "../components/ui";
import { BigStat } from "../components/Viz";
import type { Deviation, Quote } from "../types";
import { brief as currentBrief, usePrimary, type StageCtx } from "./ctx";

export function knownTotal(q: Quote) {
  const known = q.price_lines.filter((p) => p.amount_inr != null && p.kind !== "unresolved");
  return known.length ? known.reduce((a, p) => a + (p.amount_inr || 0), 0) : null;
}

export function DecisionCardView({ q, d, ctx, compact = false }: { q: Quote; d: Deviation; ctx: StageCtx; compact?: boolean }) {
  const blocked = d.severity === "blocked";
  const card = d.card;
  async function decide(decision: "keep_original" | "accept") {
    try {
      await ctx.streamAct(decision === "keep_original" ? "Keeping your must-have" : "Accepting", `/api/projects/${ctx.pid}/quotes/${q.id}/decision`,
        { deviation_id: d.id, decision }, decision === "keep_original" ? "Kept - reply drafted for the seller" : "Change accepted");
    } catch {
      /* toast */
    }
  }
  return (
    <div className={`decision ${blocked ? "" : "amber"}`}>
      <div className="dhead">
        {blocked ? <Ban size={20} color="var(--red)" /> : <AlertTriangle size={20} color="var(--amber)" />}
        <div className="grow">
          <div className="strong">{card?.title || `${q.seller_name} wants to change something`}</div>
          <div className="tiny muted">{blocked ? "This breaks a must-have - stopped until you decide" : "This changes a nice-to-have - your call"}</div>
        </div>
        <span className={`chip ${blocked ? "red" : "amber"}`}>{blocked ? "Blocked" : "Your call"}</span>
      </div>
      <div className="dbody">
        <div className="side-by-side">
          <div className="sbs-cell keep"><div className="k">{blocked ? "Your must-have" : "Your preference"}</div><div className="v">{d.original}</div></div>
          <span className="vs">VS</span>
          <div className={`sbs-cell prop ${blocked ? "" : "amber"}`}><div className="k">{q.seller_name} offers</div><div className="v">{d.proposed}</div></div>
        </div>
        {!compact && card && <div className="small"><b>If you accept:</b> {card.consequence}</div>}
        {d.decision === "pending" ? (
          <div className="row wrap">
            <button className="btn primary" data-pilot={blocked ? "keep" : "keep-flex"} onClick={() => decide("keep_original")} disabled={!!ctx.busy}>
              <ShieldCheck size={15} /> {card?.keep_label || "Keep mine"}
            </button>
            <button className={`btn ${blocked ? "danger" : ""}`} data-pilot={blocked ? "accept-must" : "accept-flex"} onClick={() => decide("accept")} disabled={!!ctx.busy}>
              {card?.accept_label || "Accept the change"}
            </button>
          </div>
        ) : (
          <span className={`chip ${d.decision === "accepted" ? "amber" : "teal"}`}>{d.decision === "accepted" ? "You accepted this" : "You kept yours"}</span>
        )}
      </div>
    </div>
  );
}

function valueFor(q: Quote, rid: string) {
  const resp = q.responses.find((r) => r.requirement_id === rid);
  const dev = q.deviations.find((d) => d.requirement_id === rid);
  if (dev) return dev.severity === "blocked" ? "unmet" : "unknown";
  if (resp) return ({ achievable: "met", needs_clarification: "unknown", proposed_change: "unknown", not_achievable: "unmet" } as Record<string, string>)[resp.response] || "unknown";
  return "unknown";
}

export default function Compare({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const toast = useToast();
  const b = currentBrief(state)!;
  const quotes = [...state.quotes].sort((a, z) => z.created_at.localeCompare(a.created_at));
  const active = quotes.filter((q) => q.status === "active" || q.status === "approved");
  const older = quotes.filter((q) => q.status === "superseded");
  const req = [...state.requests].sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
  const names = req ? req.recipients.map((r) => r.name) : [];
  const [seller, setSeller] = useState(names[0] || "");
  const [text, setText] = useState("");
  const [img, setImg] = useState<File | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function read() {
    const fd = new FormData();
    fd.append("text", text);
    fd.append("seller_name", seller);
    if (req) fd.append("request_id", req.id);
    const rec = req?.recipients.find((r) => r.name === seller);
    if (rec) fd.append("entry_id", rec.entry_id);
    if (img) fd.append("image", img);
    try {
      await ctx.streamAct("Reading the reply", `/api/projects/${pid}/replies`, fd, "Reply checked");
      setText("");
      setImg(null);
    } catch {
      /* toast */
    }
  }
  const practice = () => ctx.streamAct("Practice reply", `/api/projects/${pid}/replies/simulate`, { request_id: req?.id || null }, "Practice reply checked").catch(() => {});
  const { st } = useChannels();
  const checkInbox = () => ctx.streamAct("Checking your inbox", `/api/projects/${pid}/replies/check`, {}, "Inbox checked").catch(() => {});
  const pick = (qid: string) => ctx.act("Adding to your picks", `/api/projects/${pid}/cart`, { quote_id: qid }, "Added to your picks").then(() => ctx.go("approve")).catch(() => {});

  const ready = active.find((q) => q.readiness === "ready" && q.status === "active");
  const pending = active.some((q) => q.deviations.some((d) => d.decision === "pending"));
  usePrimary(ctx, ready
    ? { label: `Add ${ready.seller_name}'s offer`, onClick: () => pick(ready.id), icon: <Check size={16} />, hint: "This offer keeps every must-have - it goes to your picks" }
    : pending
      ? { label: "Decide above", onClick: () => document.querySelector(".decision")?.scrollIntoView({ behavior: "smooth", block: "center" }), hint: "A seller wants to change something - you decide" }
      : { label: "Read the reply", onClick: read, disabled: !text.trim() && !img, icon: <Sparkles size={16} />, hint: "Paste a reply or add a screenshot - Gemini checks it" });

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Replies</div>
          <h2>Replies, checked for you</h2>
          <p>Email replies and call answers arrive here by themselves; you can also paste a chat or drop a screenshot. Gemini reads each one and the fit checker compares it with your must-haves.</p>
        </div>
        {st?.email && st.owner && req?.ref && <button className="btn sm" onClick={checkInbox} disabled={!!busy} data-pilot="check-inbox"><MailSearch size={14} /> Check inbox now</button>}
      </div>

      <div className="composer-card glass">
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="small muted">Reply from</span>
          {names.length > 0 ? (
            <select className="select input sm" style={{ width: 220 }} value={seller} onChange={(e) => setSeller(e.target.value)}>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : (
            <input className="input sm" style={{ width: 220 }} placeholder="Seller name" value={seller} onChange={(e) => setSeller(e.target.value)} />
          )}
          <div className="grow" />
          <button className="btn sm ghost" data-pilot="practice" onClick={practice} disabled={!!busy} title="A practice reply written by Gemini - not a real business">
            <FlaskConical size={14} /> Try a practice reply
          </button>
        </div>
        <textarea className="textarea" style={{ minHeight: 90 }} placeholder="Paste their reply here - or tell it what they said on the phone" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row" style={{ gap: 8 }}>
          <MicButton value={text} onChange={setText} label="Say what they told you" />
          <button className="btn sm" onClick={() => file.current?.click()}><ImagePlus size={14} /> {img ? img.name : "Add a screenshot"}</button>
          <input ref={file} type="file" accept="image/*,application/pdf" hidden onChange={(e) => setImg(e.target.files?.[0] || null)} />
        </div>
      </div>
      <ProgressStrip lines={lines} busy={!!busy} />

      {!quotes.length && <div className="empty"><Inbox size={28} /><div>No replies yet. When a seller answers, paste it here - or try a practice reply to see how it works.</div></div>}

      {active.map((q) => {
        const met = b.requirements.filter((r) => valueFor(q, r.id) === "met").length;
        const pend = q.deviations.filter((d) => d.decision === "pending");
        const total = knownTotal(q);
        return (
          <div key={q.id} className="card raised" style={{ overflow: "hidden" }}>
            <div className="row between wrap" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", gap: 8 }}>
              <div>
                <div className="strong">{q.title}</div>
                <div className="tiny muted">{q.seller_name} · reply {q.round} · {ago(q.created_at)}</div>
              </div>
              <div className="row">
                {q.staged && <span className="chip violet"><FlaskConical /> Practice</span>}
                <span className={`chip ${q.readiness === "ready" ? "teal" : q.readiness === "not_suitable" ? "red" : "amber"}`}>
                  {q.readiness === "ready" ? "Keeps every must-have" : q.readiness === "not_suitable" ? "Breaks a must-have" : "Needs your decision"}
                </span>
              </div>
            </div>
            <div className="big-stats" style={{ padding: "16px 18px 0" }}>
              <BigStat n={met} of={b.requirements.length} label="of your needs met" icon={<CheckCircle2 size={13} color="var(--volt)" />} />
              <BigStat n={pend.length} label={pend.length === 1 ? "decision for you" : "decisions for you"} icon={<AlertTriangle size={13} color={pend.length ? "var(--amber)" : "var(--muted)"} />} />
              <BigStat n={total != null ? inr(total) : "-"} label="known price" />
              <BigStat n={q.lead_time_days_min != null ? `${q.lead_time_days_min}-${q.lead_time_days_max}` : "-"} label="days to make" />
            </div>
            <div style={{ padding: 18 }} className="section">
              {q.note && <Banner tone="ink">{q.note}</Banner>}
              <div className="small" style={{ fontStyle: "italic", color: "var(--ink-2)" }}>"{q.message}"</div>
              {q.deviations.map((d) => <DecisionCardView key={d.id} q={q} d={d} ctx={ctx} compact={d.decision !== "pending"} />)}
              {!q.deviations.length && <Banner tone="teal"><b>Nothing changed.</b> This reply keeps every must-have it mentions.</Banner>}
              {(q.to_confirm || []).length > 0 && <Banner tone="amber"><b>Not mentioned in the reply:</b> {q.to_confirm!.join(", ")} - confirm these with {q.seller_name}.</Banner>}
              <table className="table">
                <tbody>
                  {q.price_lines.map((p, i) => (
                    <tr key={i}><td>{p.label}{p.estimate ? <span className="tiny muted"> · estimate</span> : null}</td>
                      <td style={{ textAlign: "right" }}>{p.amount_inr == null ? <span className="chip amber">Not given</span> : inr(p.amount_inr)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {older.filter((q) => q.follow_up).map((q) => (
        <div key={q.id} className="card pad section">
          <div className="row between"><b className="small"><Mail size={14} style={{ verticalAlign: -2 }} /> Your reply to {q.seller_name}</b><span className="tiny muted">drafted by the outreach agent</span></div>
          <div className="mail"><div className="mail-subj">{q.follow_up!.subject}</div><div className="mail-body">{q.follow_up!.body}</div></div>
          <div className="row"><button className="btn sm ghost" onClick={() => { navigator.clipboard.writeText(`${q.follow_up!.subject}\n\n${q.follow_up!.body}`); toast("Copied"); }}><Copy size={14} /> Copy</button></div>
        </div>
      ))}
    </div>
  );
}
