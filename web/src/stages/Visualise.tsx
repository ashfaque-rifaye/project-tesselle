import { useState } from "react";
import { Crosshair, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { media } from "../api";
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
  const [dismissed, setDismissed] = useState<string[]>([]);

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

  usePrimary(ctx, !selected
    ? { label: "Draw a concept", onClick: () => generate(""), disabled: !b?.confirmed, icon: <Sparkles size={16} />, hint: "Optional: see the idea first - or skip to real options" }
    : instruction
      ? { label: "Redraw", onClick: () => generate(), icon: <Sparkles size={16} />, hint: "Apply your change to the concept" }
      : { label: "Find real options", onClick: () => ctx.go("routes"), icon: <Search size={16} />, hint: "Happy with the idea? Search real stores and makers" });

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Visualise</div>
          <h2>See it before you look for it</h2>
          <p>An illustration to help you decide - never an offer. Tap the picture to point at what to change.</p>
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
          {selected.effects.filter((e) => !dismissed.includes(selected.id + e.suggestion)).map((e, i) => (
            <div key={i} className="label-banner amber">
              <ShieldCheck />
              <div className="grow">
                <b>This change may affect your brief.</b> {e.suggestion} Your brief hasn't changed.
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn sm" onClick={() => ctx.go("clarify")}>Review brief</button>
                  <button className="btn sm ghost" onClick={() => setDismissed([...dismissed, selected.id + e.suggestion])}>Keep it as is</button>
                </div>
              </div>
            </div>
          ))}
          <div className="refine glass">
            <div className="row wrap" style={{ gap: 6 }}>
              {pin && <span className="chip volt clickable" onClick={() => setPin(null)}><Crosshair /> Area marked <X /></span>}
              {QUICK.map((q) => <button key={q} className="chip clickable" onClick={() => setInstruction(q)}>{q}</button>)}
            </div>
            <input className="input" data-pilot="refine-input" placeholder={pin ? "What should change in the marked area?" : "Describe a change, e.g. 'make the pen cup shorter'"}
              value={instruction} onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => e.key === "Enter" && instruction && generate()} />
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
      <ProgressStrip lines={lines} busy={!!busy} />
    </div>
  );
}
