import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Calendar, Camera, Check, CircleHelp, History, Lock, NotebookPen, Pencil, Plus, RefreshCw, Share2, Trash2, Undo2, Wallet, X } from "lucide-react";
import { ago, inr, media } from "../api";
import type { StageCtx } from "../stages/ctx";
import type { Brief, Requirement } from "../types";
import { FacetIcon, ROUTE_LABEL } from "./icons";
import LocationField from "./LocationField";
import MicButton from "./MicButton";

/** Ask the shell to open the capture sheet (QR code to the phone, upload, webcam). */
export const openCapture = (kind = "space", what = "") => window.dispatchEvent(new CustomEvent("tsl:capture", { detail: { kind, what } }));

/** Requirements that just changed (from any device or the voice agent) glow for a moment, so you can
 *  see what moved without the screen jumping anywhere. */
function useFresh(b?: Brief): Set<string> {
  const prev = useRef<Map<string, string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!b) return;
    const now = new Map(b.requirements.map((r) => [r.id, `${r.label}|${r.kind}|${r.status}`]));
    now.set("_budget", JSON.stringify(b.budget));
    now.set("_place", JSON.stringify(b.delivery));
    if (prev.current) {
      const changed = [...now].filter(([k, v]) => prev.current!.get(k) !== v).map(([k]) => k);
      if (changed.length) {
        setFresh(new Set(changed));
        const t = setTimeout(() => setFresh(new Set()), 2600);
        prev.current = now;
        return () => clearTimeout(t);
      }
    }
    prev.current = now;
  }, [b]);
  return fresh;
}

/** A key fact the layout says matters for this purchase; a missing one can be filled in place. */
export function FacetTile({ icon, label, value, ask, fresh, onAnswer, busy }: { icon: string; label: string; value?: string | null; ask?: string | null;
  fresh: boolean; onAnswer: (v: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  return (
    <div className={`facet ${value ? "" : "missing"} ${fresh ? "flash" : ""}`}>
      <span className="facet-ic"><FacetIcon name={icon} size={13} /></span>
      <span className="facet-k">{label}</span>
      {value ? <span className="facet-v">{value}</span> : open ? (
        <span className="row" style={{ gap: 4 }}>
          <input className="input sm" autoFocus value={v} placeholder={ask || label} onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && v.trim() && (onAnswer(v.trim()), setOpen(false))} />
          <button className="btn sm icon-btn" disabled={!v.trim() || busy} onClick={() => { onAnswer(v.trim()); setOpen(false); }} aria-label="Save"><Check size={13} /></button>
        </span>
      ) : <button className="facet-add" onClick={() => setOpen(true)}>{ask || "Add"}</button>}
    </div>
  );
}

type Change = { kind: "added" | "changed" | "removed" | "budget" | "place"; id?: string; before?: string; after?: string };

/** What differs between the original brief and now - shown as plain changes with an undo each. */
function changesSince(a: Brief, b: Brief): Change[] {
  const out: Change[] = [];
  const am = new Map(a.requirements.map((r) => [r.id, r]));
  const bm = new Map(b.requirements.map((r) => [r.id, r]));
  for (const [id, r] of bm) {
    const o = am.get(id);
    if (!o) out.push({ kind: "added", id, after: r.label });
    else if (o.label !== r.label || o.kind !== r.kind || o.value_num !== r.value_num)
      out.push({ kind: "changed", id, before: `${o.label}${o.kind !== r.kind ? (o.kind === "must" ? " (must)" : " (nice)") : ""}`, after: `${r.label}${o.kind !== r.kind ? (r.kind === "must" ? " (must)" : " (nice)") : ""}` });
  }
  for (const [id, o] of am) if (!bm.has(id)) out.push({ kind: "removed", id, before: o.label });
  const money = (x: Brief) => [x.budget.target_inr ? inr(x.budget.target_inr) : "", x.budget.limit_inr ? `max ${inr(x.budget.limit_inr)}` : ""].filter(Boolean).join(" · ") || "none";
  if (money(a) !== money(b)) out.push({ kind: "budget", before: money(a), after: money(b) });
  const place = (x: Brief) => [x.delivery.region, x.delivery.pincode].filter(Boolean).join(" ") || "not set";
  if (place(a) !== place(b)) out.push({ kind: "place", before: place(a), after: place(b) });
  return out;
}

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
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState<"must" | "flexible" | null>(null);
  const [newText, setNewText] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const fresh = useFresh(b);
  const layout = state.project.layout || null;
  const route = state.project.plan_route || layout?.route || null;
  const photos = state.project.inspiration?.photos || [];
  const spacePhoto = state.project.inspiration?.image_path && !state.project.inspiration?.generated_image ? state.project.inspiration.image_path : null;

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
  const original = state.briefs[0];
  const changes = original && original.version !== b.version ? changesSince(original, b) : [];
  const revert = (ids?: string[]) => ctx.act("Restoring", `/api/projects/${pid}/brief/revert`, { to_version: original.version, requirement_ids: ids || null },
    ids ? "Restored from your original brief" : "Back to your original brief (saved as a new version)");
  const notes = state.notes || [];
  async function addNote() {
    if (!note.trim()) return;
    await ctx.act("Saving your note", `/api/projects/${pid}/notes`, { text: note.trim(), share: false }, "Note saved");
    setNote("");
  }

  const mustRow = (r: Requirement): ReactNode => (
    <div key={r.id} className={`req must ${b.changed_ids.includes(r.id) ? "changed" : ""} ${fresh.has(r.id) ? "flash" : ""}`}>
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
  );
  const flexChip = (r: Requirement): ReactNode => (
    <span key={r.id} className={`chip flexchip ${b.changed_ids.includes(r.id) ? "sky" : ""} ${fresh.has(r.id) ? "flash" : ""}`}>
      {r.label}
      <button title="Make it a must-have" onClick={() => reqs((all) => all.map((x) => (x.id === r.id ? { ...x, kind: "must" } : x)), `${r.label} is now a must-have`)}><ArrowUp size={12} /></button>
      <button title="Remove" onClick={() => reqs((all) => all.filter((x) => x.id !== r.id), `Removed ${r.label}`)}><X size={12} /></button>
    </span>
  );

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
        {layout && (
          <div className="kind-row" title={layout.route_reason}>
            <span className="kind-ic"><FacetIcon name={layout.icon} size={14} /></span>
            <span className="kind-t">{layout.kind_label}</span>
            {route && <span className="chip muted">{ROUTE_LABEL[route]}</span>}
          </div>
        )}
      </div>

      {changes.length > 0 && (
        <div className="changes well" data-pilot="changes">
          <div className="row between">
            <h4><History size={12} /> Changed since your first brief</h4>
            <button className="chip clickable" onClick={() => revert()} disabled={!!busy} title="Go back to the original brief"><Undo2 /> Original</button>
          </div>
          {changes.slice(0, 6).map((c, i) => (
            <div key={i} className="chg">
              <span className={`chg-k ${c.kind}`}>{c.kind === "added" ? "Added" : c.kind === "removed" ? "Removed" : c.kind === "budget" ? "Budget" : c.kind === "place" ? "Delivery" : "Changed"}</span>
              <span className="grow small">{c.kind === "added" ? c.after : c.kind === "removed" ? <s>{c.before}</s> : <>{c.before} <span className="muted">→</span> <b>{c.after}</b></>}</span>
              {c.id && (c.kind === "changed" || c.kind === "removed") && <button className="chg-undo" title="Undo this change" onClick={() => revert([c.id!])} disabled={!!busy}><Undo2 size={12} /></button>}
              {c.id && c.kind === "added" && <button className="chg-undo" title="Remove what was added" onClick={() => reqs((all) => all.filter((x) => x.id !== c.id), `Removed ${c.after}`)} disabled={!!busy}><X size={12} /></button>}
            </div>
          ))}
        </div>
      )}

      {stale && (
        <button className="stale" onClick={() => ctx.go("routes")} disabled={!!busy}>
          <RefreshCw size={14} /> Brief changed - refresh the options
        </button>
      )}

      {layout && layout.facets.length > 0 && (
        <div className="facet-grid" aria-label="Key facts">
          {layout.facets.map((f) => (
            <FacetTile key={f.label} icon={f.icon} label={f.label} value={f.value} ask={f.ask} busy={!!busy}
              fresh={!!f.requirement_id && fresh.has(f.requirement_id)}
              onAnswer={(v) => ctx.act("Adding to your brief", `/api/projects/${pid}/brief/requirement`, { text: `${f.label}: ${v}`, kind: "must" }, `${f.label} saved`)} />
          ))}
        </div>
      )}

      {(photos.length > 0 || spacePhoto || layout?.photo_helps) && (
        <div className="photo-strip">
          {(photos.length ? photos.slice(-4).map((p) => p.path) : spacePhoto ? [spacePhoto] : []).map((p) => (
            <img key={p} src={media(p)} alt="" loading="lazy" />
          ))}
          <button className="photo-add" onClick={() => openCapture("space", layout?.photo_prompt || "")} title="Add a photo from your phone, glasses or camera">
            <Camera size={15} /><span>{photos.length || spacePhoto ? "Add" : layout?.photo_prompt ? "Add a photo" : "Photo"}</span>
          </button>
          {!photos.length && !spacePhoto && layout?.photo_prompt && <span className="tiny muted photo-hint">{layout.photo_prompt}</span>}
        </div>
      )}

      <div className="facts">
        <div className={`fact ${fresh.has("_budget") ? "flash" : ""}`}>
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
        <div className={`fact ${fresh.has("_place") ? "flash" : ""}`}>
          <span className="fk">📍 Deliver to</span>
          {editPlace ? (
            <div className="col" style={{ gap: 6, width: "100%" }}>
              <LocationField value={place} onChange={setPlace} pincode={pin} onPincode={setPin} compact />
              <button className="btn sm" onClick={() => { save({ delivery: { ...b.delivery, region: place || null, pincode: pin || null } }, "Delivery place changed"); setEditPlace(false); }}><Check size={14} /> Save</button>
            </div>
          ) : (
            <button className="fv" onClick={() => { setPlace(b.delivery.region || ""); setPin(b.delivery.pincode || ""); setEditPlace(true); }}>
              {b.delivery.region ? <>{b.delivery.region}{b.delivery.pincode ? <span className="muted"> · {b.delivery.pincode}</span> : <span className="muted"> · add PIN</span>}</> : <span className="muted">Add city and PIN code</span>} <Pencil size={11} />
            </button>
          )}
        </div>
        {(!layout || layout.show_deadline || b.delivery.desired_by) && (
          <div className="fact">
            <span className="fk"><Calendar size={13} /> Needed by</span>
            <input className="date-input" type="date" value={b.delivery.desired_by || ""} aria-label="Needed by"
              onChange={(e) => save({ delivery: { ...b.delivery, desired_by: e.target.value || null } }, "Deadline changed")} />
          </div>
        )}
      </div>

      {layout && layout.sections.length > 0 ? (
        <>
          {layout.sections.map((sec, i) => {
            const rs = sec.requirement_ids.map((id) => b.requirements.find((r) => r.id === id)).filter(Boolean) as Requirement[];
            const extra = i === layout.sections.length - 1 ? b.requirements.filter((r) => !layout.sections.some((s) => s.requirement_ids.includes(r.id))) : [];
            const all = [...rs, ...extra];
            if (!all.length) return null;
            return (
              <div className="col" key={sec.title}>
                <div className="row between" style={{ padding: "0 4px" }}>
                  <h4>{sec.title}</h4>
                  {i === 0 && <button className="chip clickable" onClick={() => setAdding(adding === "must" ? null : "must")}><Plus /> Must-have</button>}
                  {i === 1 && <button className="chip clickable" onClick={() => setAdding(adding === "flexible" ? null : "flexible")}><Plus /> Nice to have</button>}
                </div>
                <div className="req-list">
                  {all.filter((r) => r.kind === "must").map((r) => mustRow(r))}
                </div>
                {all.some((r) => r.kind !== "must") && <div className="flex-chips">{all.filter((r) => r.kind !== "must").map((r) => flexChip(r))}</div>}
              </div>
            );
          })}
          {layout.sections.length === 1 && (
            <div className="row" style={{ padding: "0 4px", gap: 6 }}>
              <button className="chip clickable" onClick={() => setAdding(adding === "flexible" ? null : "flexible")}><Plus /> Nice to have</button>
            </div>
          )}
        </>
      ) : (
        <>
      <div className="col">
        <div className="row between" style={{ padding: "0 4px" }}>
          <h4>Must-haves</h4>
          <button className="chip clickable" onClick={() => setAdding(adding === "must" ? null : "must")}><Plus /> Add</button>
        </div>
        <div className="req-list">
          {musts.map((r) => mustRow(r))}
          {!musts.length && <div className="small muted">No must-haves yet.</div>}
        </div>
      </div>

      <div className="col">
        <div className="row between" style={{ padding: "0 4px" }}>
          <h4>Nice to have</h4>
          <button className="chip clickable" onClick={() => setAdding(adding === "flexible" ? null : "flexible")}><Plus /> Add</button>
        </div>
        <div className="flex-chips">
          {flex.map((r) => flexChip(r))}
          {!flex.length && <span className="small muted">None</span>}
        </div>
      </div>
        </>
      )}
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
                  <MicButton value={answers[u.id] || ""} onChange={(v) => setAnswers({ ...answers, [u.id]: v })} />
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
      <div className="col" data-pilot="notes">
        <h4 style={{ padding: "0 4px" }}><NotebookPen size={12} /> Your notes</h4>
        {notes.map((n) => (
          <div key={n.id} className="note">
            <div className="grow"><div className="small">{n.text}</div><div className="tiny muted">{ago(n.updated_at)}{n.share ? " · shared with makers" : ""}</div></div>
            <button className={`chg-undo ${n.share ? "on" : ""}`} title={n.share ? "Shared with makers - tap to keep private" : "Include in messages to makers"}
              onClick={() => ctx.act("Saving", `/api/projects/${pid}/notes/${n.id}`, { share: !n.share })}><Share2 size={12} /></button>
            <button className="chg-undo" title="Delete note" onClick={() => ctx.act("Deleting", `/api/projects/${pid}/notes/${n.id}`, { delete: true })}><Trash2 size={12} /></button>
          </div>
        ))}
        <div className="add-req">
          <MicButton value={note} onChange={setNote} />
          <input className="input sm" placeholder="Add a note - type or talk" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} />
          <button className="btn sm" onClick={addNote} disabled={!note.trim() || !!busy}>Save</button>
        </div>
      </div>
      <div className="tiny muted" style={{ padding: "0 4px" }}>
        {b.confirmed ? "Change anything, any time - Tesselle saves a new version and re-checks what it found." : "Check this, then confirm. You can change it later."}
      </div>
    </aside>
  );
}
