import { useEffect, useMemo, useState } from "react";
import { CircleHelp, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { media } from "../api";
import { Banner, KindChip, ProgressBox, ReqStatusChip, sourceLabel } from "../components/ui";
import type { Brief, Requirement } from "../types";
import { brief as currentBrief, type StageCtx } from "./ctx";

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "req";
}

export default function Clarify({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const b = currentBrief(state);
  const [draft, setDraft] = useState<Brief | null>(b);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [newLabel, setNewLabel] = useState("");
  const [newKind, setNewKind] = useState<"must" | "flexible">("must");

  useEffect(() => setDraft(b), [b?.version, b?.created_at, b?.confirmed]); // eslint-disable-line

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(b), [draft, b]);
  if (!b || !draft) return <div className="empty">Start from an inspiration first.</div>;

  const insp = state.project.inspiration || {};
  const musts = draft.requirements.filter((r) => r.kind === "must");
  const flex = draft.requirements.filter((r) => r.kind === "flexible");
  const blockers = musts.filter((r) => r.status === "needs_checking");

  function updateReq(id: string, patch: Partial<Requirement>) {
    setDraft((d) => d && { ...d, requirements: d.requirements.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  }
  function removeReq(id: string) {
    setDraft((d) => d && { ...d, requirements: d.requirements.filter((r) => r.id !== id) });
  }
  function addReq() {
    if (!newLabel.trim()) return;
    const r: Requirement = { id: slug(newLabel), label: newLabel.trim(), kind: newKind, source: "customer", status: "confirmed", attribute: null, op: "text" };
    setDraft((d) => d && { ...d, requirements: [...d.requirements, r] });
    setNewLabel("");
  }

  async function save() {
    await ctx.act("Saving", `/api/projects/${pid}/brief`, {
      title: draft!.title,
      purpose: draft!.purpose,
      requirements: draft!.requirements,
      budget: draft!.budget,
      delivery: draft!.delivery,
      acceptance_checks: draft!.acceptance_checks,
      summary: "You edited the brief",
    }, b!.confirmed ? `Saved as brief v${b!.version + 1}` : "Draft saved");
  }

  async function confirm() {
    try {
      if (dirty) await save();
      await ctx.act("Confirming", `/api/projects/${pid}/brief/confirm`, {}, "Brief confirmed - you can now visualise it or explore routes");
      ctx.go("visualise");
    } catch {
      /* toast */
    }
  }

  async function answer(uid: string, dontKnow = false) {
    await ctx.act("Recording your answer", `/api/projects/${pid}/unknowns/${uid}`, { answer: answers[uid] || null, dont_know: dontKnow }, "Answer recorded");
  }

  const reqRow = (r: Requirement) => (
    <div key={r.id} className={`req ${r.kind === "must" ? "must" : "flex"}`} style={{ alignItems: "center", gap: 12 }}>
      <div className="grow col" style={{ gap: 4 }}>
        <input className="input sm" value={r.label} onChange={(e) => updateReq(r.id, { label: e.target.value })} aria-label="Requirement" />
        <div className="row wrap" style={{ gap: 6 }}>
          <ReqStatusChip r={r} />
          <span className="chip muted">{sourceLabel(r.source)}</span>
          {r.attribute && r.value_num != null && (
            <span className="row small" style={{ gap: 4 }}>
              <span className="muted">{r.op}</span>
              <input
                className="input sm"
                style={{ width: 72 }}
                type="number"
                value={r.value_num}
                onChange={(e) => updateReq(r.id, { value_num: Number(e.target.value) })}
                aria-label="Value"
              />
              <span className="muted">{r.unit}</span>
            </span>
          )}
          {r.value_list && r.value_list.length > 0 && <span className="tiny muted">{r.op === "not_in" ? "not: " : ""}{r.value_list.join(", ")}</span>}
        </div>
        {r.note && <div className="tiny muted">"{r.note}"</div>}
      </div>
      <div className="col" style={{ gap: 6, alignItems: "flex-end" }}>
        <select className="select input sm" style={{ width: 178 }} value={r.kind} onChange={(e) => updateReq(r.id, { kind: e.target.value as "must" | "flexible" })} aria-label="Kind">
          <option value="must">Must stay the same</option>
          <option value="flexible">Flexible</option>
        </select>
        <div className="row" style={{ gap: 4 }}>
          {r.status === "needs_checking" && (
            <button className="btn sm teal" onClick={() => updateReq(r.id, { status: "confirmed", source: "customer" })}>I measured - confirm</button>
          )}
          <button className="btn ghost sm icon-btn" onClick={() => removeReq(r.id)} aria-label="Remove requirement">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">02 · Clarify</div>
          <h2>Your brief, in your words</h2>
          <p>Confirm what must stay the same. Anything flexible can be traded off later - but only with your approval.</p>
        </div>
        <div className="row">
          <span className={`chip ${b.confirmed ? "teal" : "amber"}`}>Brief v{b.version} · {b.confirmed ? "Confirmed" : "Draft"}</span>
        </div>
      </div>

      <div className="card pad section">
        <div className="grid-2">
          <div className="field">
            <label>Project name</label>
            <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </div>
          <div className="field">
            <label>Purpose - the job it should do</label>
            <input className="input" value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} />
          </div>
        </div>
        {(insp.transcript || insp.image_path || (insp.photo_observations || []).length > 0) && (
          <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
            {insp.image_path && <img src={media(insp.image_path)} alt="Your photo" style={{ width: 150, borderRadius: 10, aspectRatio: "4/3", objectFit: "cover" }} />}
            <div className="col grow">
              {insp.transcript && <div className="small"><b>Voice note:</b> "{insp.transcript}"</div>}
              {(insp.photo_observations || []).length > 0 && (
                <Banner tone="amber">
                  <b>From your photo (unconfirmed):</b> {(insp.photo_observations || []).join(" · ")}
                </Banner>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="section">
          <div className="row between">
            <h3 className="row" style={{ gap: 6 }}><ShieldCheck size={17} /> Must stay the same</h3>
            <span className="small muted">{musts.length}</span>
          </div>
          <div className="req-list">{musts.map(reqRow)}</div>
          <div className="row between">
            <h3>Flexible</h3>
            <span className="small muted">{flex.length}</span>
          </div>
          <div className="req-list">{flex.length ? flex.map(reqRow) : <div className="small muted">No flexible preferences yet.</div>}</div>
          <div className="row">
            <input className="input" placeholder="Add a requirement, e.g. 'Matte finish'" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addReq()} />
            <select className="select" style={{ width: 130 }} value={newKind} onChange={(e) => setNewKind(e.target.value as "must" | "flexible")}>
              <option value="must">Must</option>
              <option value="flexible">Flexible</option>
            </select>
            <button className="btn" onClick={addReq}><Plus size={15} /> Add</button>
          </div>
        </div>

        <div className="section">
          <div className="card pad section">
            <h3>Budget</h3>
            <div className="grid-2">
              <div className="field">
                <label>Target (flexible)</label>
                <input className="input" type="number" value={draft.budget.target_inr ?? ""} placeholder="INR"
                  onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, target_inr: e.target.value ? Number(e.target.value) : null } })} />
              </div>
              <div className="field">
                <label>Absolute limit (must)</label>
                <input className="input" type="number" value={draft.budget.limit_inr ?? ""} placeholder="INR"
                  onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, limit_inr: e.target.value ? Number(e.target.value) : null } })} />
              </div>
            </div>
            <h3>Delivery</h3>
            <div className="grid-2">
              <div className="field">
                <label>City</label>
                <input className="input" value={draft.delivery.region ?? ""} onChange={(e) => setDraft({ ...draft, delivery: { ...draft.delivery, region: e.target.value } })} />
              </div>
              <div className="field">
                <label>Wanted by (optional)</label>
                <input className="input" type="date" value={draft.delivery.desired_by ?? ""} onChange={(e) => setDraft({ ...draft, delivery: { ...draft.delivery, desired_by: e.target.value } })} />
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={draft.delivery.essential} onChange={(e) => setDraft({ ...draft, delivery: { ...draft.delivery, essential: e.target.checked } })} />
              Timing is essential
            </label>
          </div>

          <div className="card pad section">
            <h3 className="row" style={{ gap: 6 }}><CircleHelp size={17} color="var(--amber)" /> Needs checking</h3>
            {b.unknowns.length === 0 && <div className="small muted">No open questions.</div>}
            {b.unknowns.map((u) => (
              <div key={u.id} className="col" style={{ gap: 6 }}>
                <div className="small strong">{u.question}</div>
                <div className="tiny muted">Why it matters: {u.why}</div>
                {u.status === "open" ? (
                  <div className="row">
                    <input className="input sm" placeholder="Your answer" value={answers[u.id] || ""} onChange={(e) => setAnswers({ ...answers, [u.id]: e.target.value })} />
                    <button className="btn sm" disabled={!answers[u.id] || !!busy} onClick={() => answer(u.id)}>Answer</button>
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => answer(u.id, true)}>I don't know</button>
                  </div>
                ) : (
                  <span className={`chip ${u.status === "answered" ? "teal" : "muted"}`}>{u.status === "answered" ? `Answered: ${u.answer}` : "Not known - we'll ask the seller"}</span>
                )}
              </div>
            ))}
          </div>

          <div className="card pad section">
            <h3>Acceptance checks on delivery</h3>
            <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
              {draft.acceptance_checks.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        </div>
      </div>

      <ProgressBox lines={lines} busy={!!busy} />

      {blockers.length > 0 && (
        <Banner tone="amber">
          Confirm or edit these before confirming your brief: {blockers.map((r) => r.label).join("; ")}. Fit claims stay blocked until you do.
        </Banner>
      )}
      <div className="row between">
        <span className="small muted">{b.confirmed ? "Changes now create a new brief version and show which offers may no longer apply." : "This is a draft - nothing is shared yet."}</span>
        <div className="row">
          {dirty && <button className="btn" onClick={save} disabled={!!busy}>Save changes</button>}
          {!b.confirmed ? (
            <button className="btn primary lg" onClick={confirm} disabled={!!busy || blockers.length > 0}>Confirm my brief</button>
          ) : (
            <button className="btn teal lg" onClick={() => ctx.go("visualise")}>Continue to the studio</button>
          )}
        </div>
      </div>
    </div>
  );
}
