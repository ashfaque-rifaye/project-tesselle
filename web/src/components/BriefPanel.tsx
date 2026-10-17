import { useState } from "react";
import { ArrowDown, ArrowUp, Calendar, Check, CircleHelp, Lock, Pencil, Plus, RefreshCw, Wallet, X } from "lucide-react";
import { inr } from "../api";
import type { StageCtx } from "../stages/ctx";
import type { Brief, Requirement } from "../types";
import LocationField from "./LocationField";

/** "Your brief": everything Tesselle works from, editable at any step. Edits after confirming save a
 *  new version, and anything found for the old version is flagged so it can be refreshed. */
export default function BriefPanel({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy } = ctx;
  const b: Brief | undefined = state.briefs[state.briefs.length - 1];
  const [editTitle, setEditTitle] = useState(false);
  const [title, setTitle] = useState("");
  const [editBudget, setEditBudget] = useState(false);
  const [target, setTarget] = useState("");
  const [limit, setLimit] = useState("");
  const [editPlace, setEditPlace] = useState(false);
  const [place, setPlace] = useState("");
  const [adding, setAdding] = useState<"must" | "flexible" | null>(null);
  const [newText, setNewText] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});

  if (!b) {
    return (
      <aside className="intent" aria-label="Your brief">
        <div className="intent-head"><h4>Your brief</h4><div className="title">Nothing yet</div></div>
        <div className="well brief-empty">
          <Lock size={22} color="var(--volt)" />
          <div className="small">Tell Tesselle what you want. Your must-haves will appear here - and no seller can change them without asking you.</div>
        </div>
      </aside>
    );
  }

  const save = (body: Record<string, unknown>, summary: string) =>
    ctx.act("Updating your brief", `/api/projects/${pid}/brief`, { ...body, summary }, b.confirmed ? `Saved as brief v${b.version + 1}` : "Brief updated");
  const reqs = (fn: (r: Requirement[]) => Requirement[], summary: string) => save({ requirements: fn(b.requirements) }, summary);
  const musts = b.requirements.filter((r) => r.kind === "must");
  const flex = b.requirements.filter((r) => r.kind === "flexible");
  const stale = state.routes && state.routes.brief_version !== b.version;

  async function add() {
    if (!newText.trim() || !adding) return;
    await ctx.act("Adding to your brief", `/api/projects/${pid}/brief/requirement`, { text: newText.trim(), kind: adding }, "Added to your brief");
    setNewText("");
    setAdding(null);
  }

  return (
    <aside className="intent" aria-label="Your brief">
      <div className="intent-head">
        <div className="row between">
          <h4>Your brief</h4>
          <span className={`chip ${b.confirmed ? "teal" : "amber"}`}>v{b.version} · {b.confirmed ? "Confirmed" : "Draft"}</span>
        </div>
        {editTitle ? (
          <div className="row" style={{ gap: 6 }}>
            <input className="input sm" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (save({ title }, "Renamed"), setEditTitle(false))} />
            <button className="btn sm icon-btn" onClick={() => { save({ title }, "Renamed"); setEditTitle(false); }} aria-label="Save"><Check size={14} /></button>
          </div>
        ) : (
          <button className="title editable" onClick={() => { setTitle(b.title); setEditTitle(true); }}>{b.title} <Pencil size={13} /></button>
        )}
        {b.purpose && <div className="small muted clamp2">{b.purpose}</div>}
      </div>

      {stale && (
        <button className="stale" onClick={() => ctx.go("routes")} disabled={!!busy}>
          <RefreshCw size={14} /> Brief changed - refresh the options
        </button>
      )}

      <div className="facts">
        <div className="fact">
          <span className="fk"><Wallet size={13} /> Budget</span>
          {editBudget ? (
            <span className="row" style={{ gap: 4 }}>
              <input className="input sm" style={{ width: 82 }} placeholder="Target" value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" />
              <input className="input sm" style={{ width: 82 }} placeholder="Max" value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" />
              <button className="btn sm icon-btn" aria-label="Save budget" onClick={() => {
                save({ budget: { target_inr: target ? Number(target) : null, limit_inr: limit ? Number(limit) : null, share_with_sellers: b.budget.share_with_sellers } }, "Budget changed");
                setEditBudget(false);
              }}><Check size={14} /></button>
            </span>
          ) : (
            <button className="fv" onClick={() => { setTarget(String(b.budget.target_inr ?? "")); setLimit(String(b.budget.limit_inr ?? "")); setEditBudget(true); }}>
              {b.budget.target_inr || b.budget.limit_inr ? (
                <>{b.budget.target_inr ? inr(b.budget.target_inr) : "-"}{b.budget.limit_inr ? <span className="muted"> · max {inr(b.budget.limit_inr)}</span> : null}</>
              ) : <span className="muted">Add a budget</span>} <Pencil size={11} />
            </button>
          )}
        </div>
        <div className="fact">
          <span className="fk">📍 Deliver to</span>
          {editPlace ? (
            <div className="col" style={{ gap: 6 }}>
              <LocationField value={place} onChange={setPlace} compact />
              <button className="btn sm" onClick={() => { save({ delivery: { ...b.delivery, region: place || null } }, "Delivery city changed"); setEditPlace(false); }}><Check size={14} /> Save</button>
            </div>
          ) : (
            <button className="fv" onClick={() => { setPlace(b.delivery.region || ""); setEditPlace(true); }}>
              {b.delivery.region || <span className="muted">Add a city</span>} <Pencil size={11} />
            </button>
          )}
        </div>
        <div className="fact">
          <span className="fk"><Calendar size={13} /> Needed by</span>
          <input className="date-input" type="date" value={b.delivery.desired_by || ""} aria-label="Needed by"
            onChange={(e) => save({ delivery: { ...b.delivery, desired_by: e.target.value || null } }, "Deadline changed")} />
        </div>
      </div>

      <div className="col">
        <div className="row between" style={{ padding: "0 4px" }}>
          <h4>Must-haves</h4>
          <button className="chip clickable" onClick={() => setAdding(adding === "must" ? null : "must")}><Plus /> Add</button>
        </div>
        <div className="req-list">
          {musts.map((r) => (
            <div key={r.id} className={`req must ${b.changed_ids.includes(r.id) ? "changed" : ""}`}>
              <span className={`lock-ic ${r.status === "needs_checking" ? "warn" : ""}`}>{r.status === "needs_checking" ? <CircleHelp /> : <Lock />}</span>
              <div className="grow">
                <div>{r.label}</div>
                <div className="meta">{r.status === "needs_checking" ? "From your photo - measure to confirm" : r.note ? `"${r.note}"` : "Kept unless you agree to change it"}</div>
              </div>
              <span className="req-actions">
                {r.status === "needs_checking" && (
                  <button title="I measured it - confirm" onClick={() => reqs((all) => all.map((x) => (x.id === r.id ? { ...x, status: "confirmed", source: "customer" } : x)), `Confirmed ${r.label}`)}><Check size={13} /></button>
                )}
                <button title="Make it a nice-to-have" onClick={() => reqs((all) => all.map((x) => (x.id === r.id ? { ...x, kind: "flexible" } : x)), `${r.label} is now a nice-to-have`)}><ArrowDown size={13} /></button>
                <button title="Remove" onClick={() => reqs((all) => all.filter((x) => x.id !== r.id), `Removed ${r.label}`)}><X size={13} /></button>
              </span>
            </div>
          ))}
          {!musts.length && <div className="small muted">No must-haves yet.</div>}
        </div>
      </div>

      <div className="col">
        <div className="row between" style={{ padding: "0 4px" }}>
          <h4>Nice to have</h4>
          <button className="chip clickable" onClick={() => setAdding(adding === "flexible" ? null : "flexible")}><Plus /> Add</button>
        </div>
        <div className="flex-chips">
          {flex.map((r) => (
            <span key={r.id} className={`chip flexchip ${b.changed_ids.includes(r.id) ? "sky" : ""}`}>
              {r.label}
              <button title="Make it a must-have" onClick={() => reqs((all) => all.map((x) => (x.id === r.id ? { ...x, kind: "must" } : x)), `${r.label} is now a must-have`)}><ArrowUp size={12} /></button>
              <button title="Remove" onClick={() => reqs((all) => all.filter((x) => x.id !== r.id), `Removed ${r.label}`)}><X size={12} /></button>
            </span>
          ))}
          {!flex.length && <span className="small muted">None</span>}
        </div>
      </div>

      {adding && (
        <div className="add-req">
          <input className="input sm" autoFocus placeholder={adding === "must" ? "e.g. Max width 30 cm" : "e.g. Matte finish"} value={newText}
            onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="btn sm primary" onClick={add} disabled={!newText.trim() || !!busy}>Add</button>
        </div>
      )}

      {b.unknowns.some((u) => u.status === "open") && (
        <div className="col">
          <h4 style={{ padding: "0 4px" }}>Quick questions</h4>
          {b.unknowns.filter((u) => u.status === "open").map((u) => (
            <div key={u.id} className="req q">
              <span className="lock-ic warn"><CircleHelp /></span>
              <div className="grow col" style={{ gap: 6 }}>
                <div>{u.question}</div>
                <div className="row" style={{ gap: 4 }}>
                  <input className="input sm" placeholder="Your answer" value={answers[u.id] || ""} onChange={(e) => setAnswers({ ...answers, [u.id]: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && answers[u.id] && ctx.act("Saving your answer", `/api/projects/${pid}/unknowns/${u.id}`, { answer: answers[u.id] }, "Answer saved")} />
                  <button className="btn sm" disabled={!answers[u.id] || !!busy}
                    onClick={() => ctx.act("Saving your answer", `/api/projects/${pid}/unknowns/${u.id}`, { answer: answers[u.id] }, "Answer saved")}>Save</button>
                  <button className="btn sm ghost" disabled={!!busy}
                    onClick={() => ctx.act("Saving", `/api/projects/${pid}/unknowns/${u.id}`, { dont_know: true }, "Skipped")}>Skip</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="tiny muted" style={{ padding: "0 4px" }}>
        {b.confirmed ? "Change anything, any time - Tesselle saves a new version and re-checks what it found." : "Check this, then confirm. You can change it later."}
      </div>
    </aside>
  );
}
