import { useState } from "react";
import { Crosshair, History, Search, ShoppingBag, Sparkles, Undo2, X } from "lucide-react";
import { media } from "../api";
import LookViewer from "../components/LookViewer";
import MicButton from "../components/MicButton";
import { ProgressStrip } from "../components/ui";
import { brief as currentBrief, usePrimary, type StageCtx } from "./ctx";

const QUICK = ["Make it narrower", "Keep this finish", "Remove this compartment", "Make the phone slot wider", "Try a darker colour"];

export default function Visualise({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const b = currentBrief(state);
  const concepts = state.concepts;
  const selected = concepts.find((c) => c.id === state.project.selected_concept_id) || concepts[concepts.length - 1];
  const [instruction, setInstruction] = useState("");
  const [pin, setPin] = useState<[number, number] | null>(null);
  const looks = [...(state.looks || [])].reverse();
  const hasOptions = !!state.routes?.entries.some((e) => e.route === "buy" && e.image_url);

  async function generate(instr = instruction) {
    try {
      await ctx.streamAct("Drawing", `/api/projects/${pid}/concepts`,
        { instruction: instr, parent_id: selected?.id || null, pin_x: pin?.[0] ?? null, pin_y: pin?.[1] ?? null }, "Concept ready");
      setInstruction("");
      setPin(null);
    } catch {
      /* toast */
    }
  }
  async function look() {
    try {
      await ctx.streamAct("Making the picture", `/api/projects/${pid}/looks`, { in_space: true }, "Shoppable picture ready");
    } catch {
      /* toast */
    }
  }

  usePrimary(ctx, !selected
    ? { label: "Draw a concept", onClick: () => generate(""), disabled: !b?.confirmed, icon: <Sparkles size={16} />, hint: "Optional: see the idea first - or skip to real options" }
    : instruction
      ? { label: "Redraw", onClick: () => generate(), icon: <Sparkles size={16} />, hint: "Apply your change to the concept" }
      : { label: "Find real options", onClick: () => ctx.go("routes"), icon: <Search size={16} />, hint: "Happy with the idea? Search real stores and makers" });

  const applied = selected?.applied && !selected.applied.reverted ? selected.applied : null;

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Visualise</div>
          <h2>See it before you buy it</h2>
          <p>A concept from your brief - then, once options are found, the real products in your own space. Tap the picture to point at what to change.</p>
        </div>
        {!selected && <button className="btn ghost sm" onClick={() => ctx.go("routes")}>Skip</button>}
      </div>

      {!selected ? (
        <div className="empty"><Sparkles size={28} /><div>The design agent will draw your idea from the brief.</div></div>
      ) : (
        <div className="section">
          <div className="concept-frame" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPin([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]); }} title="Tap to mark an area">
            <img src={media(selected.image_path)} alt={`Concept: ${selected.caption}`} />
            <span className="badge chip violet">Concept · illustration only</span>
            {pin && <div className="pin" style={{ left: `${pin[0] * 100}%`, top: `${pin[1] * 100}%` }} />}
          </div>
          {applied && (
            <div className="label-banner sky" data-pilot="applied">
              <History />
              <div className="grow">
                <b>Your brief was updated (v{applied.to_version}).</b>
                <div className="col" style={{ gap: 2, marginTop: 4 }}>
                  {applied.changes.map((c) => <div key={c.id} className="small">{c.before ? <>{c.before} → <b>{c.after}</b></> : <>Added <b>{c.after}</b></>}</div>)}
                </div>
              </div>
              <button className="btn sm" onClick={() => ctx.act("Reverting", `/api/projects/${pid}/concepts/${selected.id}/revert`, {}, "Back to what you had")} disabled={!!busy}>
                <Undo2 size={13} /> Revert
              </button>
            </div>
          )}
          <div className="refine glass">
            <div className="row wrap" style={{ gap: 6 }}>
              {pin && <span className="chip volt clickable" onClick={() => setPin(null)}><Crosshair /> Area marked <X /></span>}
              {QUICK.map((q) => <button key={q} className="chip clickable" onClick={() => setInstruction(q)}>{q}</button>)}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <MicButton value={instruction} onChange={setInstruction} label="Say what to change" />
              <input className="input" data-pilot="refine-input" placeholder={pin ? "What should change in the marked area?" : "Describe a change, e.g. 'make the pen cup shorter'"}
                value={instruction} onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => e.key === "Enter" && instruction && generate()} />
            </div>
          </div>
          {concepts.length > 1 && (
            <div className="thumbs">
              {concepts.map((c) => (
                <button key={c.id} className={`thumb ${c.id === selected.id ? "active" : ""}`} onClick={() => ctx.act("Selecting", `/api/projects/${pid}/concepts/${c.id}/select`)}>
                  <img src={media(c.image_path)} alt={c.caption} /><span>{c.caption}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {hasOptions && (
        <div className="card pad section">
          <div className="row between wrap">
            <div><h3>With the real products</h3><div className="small muted">Gemini places the actual options found{state.project.inspiration?.image_path && !state.project.inspiration?.generated_image ? " into your own photo" : ""} - tap a dot to shop it.</div></div>
            <button className="btn sm primary" onClick={look} disabled={!!busy}><ShoppingBag size={14} /> {looks.length ? "Make another" : "Show me"}</button>
          </div>
          {looks[0] && <LookViewer look={looks[0]} busy={!!busy} onAdd={(it) => ctx.act("Adding", `/api/projects/${pid}/cart`, { entry_id: it.entry_id }, "Added to your picks")} />}
        </div>
      )}
      <ProgressStrip lines={lines} busy={!!busy} />
    </div>
  );
}
