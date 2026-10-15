import { useState } from "react";
import { ArrowRight, Crosshair, ImageIcon, ShieldCheck, Sparkles, X } from "lucide-react";
import { media } from "../api";
import { Banner, ProgressBox } from "../components/ui";
import { brief as currentBrief, type StageCtx } from "./ctx";

const QUICK = ["Make it narrower", "Keep this finish", "Remove this compartment", "Make the phone slot wider", "Try a darker bamboo"];

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
      await ctx.streamAct(
        "Rendering concept",
        `/api/projects/${pid}/concepts`,
        { instruction: instr, parent_id: selected?.id || null, pin_x: pin?.[0] ?? null, pin_y: pin?.[1] ?? null },
        "New concept rendered",
      );
      setInstruction("");
      setPin(null);
    } catch {
      /* toast */
    }
  }

  function onImageClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setPin([(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height]);
  }

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">03 · Visualise</div>
          <h2>Creative studio</h2>
          <p>Explore the idea freely. Concepts are illustrations - they are never presented as something you can buy.</p>
        </div>
        <button className="btn teal" onClick={() => ctx.go("routes")} disabled={!b?.confirmed}>
          Explore fulfilment routes <ArrowRight size={16} />
        </button>
      </div>

      {!selected ? (
        <div className="empty">
          <ImageIcon size={30} />
          <div>Render a first concept from your confirmed brief - or skip straight to checking what exists.</div>
          <div className="row">
            <button className="btn primary" onClick={() => generate("")} disabled={!!busy || !b?.confirmed}>
              <Sparkles size={16} /> Render a concept
            </button>
            <button className="btn" onClick={() => ctx.go("routes")}>Skip to routes</button>
          </div>
          <ProgressBox lines={lines} busy={!!busy} />
        </div>
      ) : (
        <div className="studio">
          <div className="section">
            <div className="concept-frame" onClick={onImageClick} title="Click to mark an area">
              <img src={media(selected.image_path)} alt={`Concept: ${selected.caption}`} />
              <span className="badge chip violet">Concept visualisation · illustrative only</span>
              {pin && <div className="pin" style={{ left: `${pin[0] * 100}%`, top: `${pin[1] * 100}%` }} />}
            </div>
            <Banner>
              <b>{selected.caption}.</b> Availability and feasibility not confirmed. Generated for brief v{selected.brief_version}
              {selected.instruction ? ` · refinement: "${selected.instruction}"` : ""}.
            </Banner>
            {selected.effects
              .filter((e) => !dismissed.includes(selected.id + e.suggestion))
              .map((e, i) => (
                <div key={i} className="label-banner amber">
                  <ShieldCheck />
                  <div className="grow">
                    <b>This visual edit may affect your brief.</b> {e.suggestion} Your brief has not changed.
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn sm" onClick={() => ctx.go("clarify")}>Review in brief</button>
                      <button className="btn sm ghost" onClick={() => setDismissed([...dismissed, selected.id + e.suggestion])}>Keep brief as is</button>
                    </div>
                  </div>
                </div>
              ))}

            <div className="card pad section">
              <div className="row between">
                <h3>Refine</h3>
                {pin ? (
                  <span className="chip teal clickable" onClick={() => setPin(null)}>
                    <Crosshair /> Area marked <X />
                  </span>
                ) : (
                  <span className="small muted">Tip: click the image to mark an area</span>
                )}
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {QUICK.map((q) => (
                  <button key={q} className="chip clickable" onClick={() => setInstruction(q)}>{q}</button>
                ))}
              </div>
              <div className="row">
                <input
                  className="input"
                  placeholder={pin ? "What should change in the marked area?" : "Describe a change, e.g. 'keep this finish, make the pen cup shorter'"}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && instruction && generate()}
                />
                <button className="btn primary" disabled={!instruction || !!busy} onClick={() => generate()}>
                  <Sparkles size={15} /> Render variation
                </button>
              </div>
              <ProgressBox lines={lines} busy={!!busy} />
            </div>

            {concepts.length > 1 && (
              <div className="thumbs">
                {concepts.map((c) => (
                  <button key={c.id} className={`thumb ${c.id === selected.id ? "active" : ""}`}
                    onClick={() => ctx.act("Selecting", `/api/projects/${pid}/concepts/${c.id}/select`)}>
                    <img src={media(c.image_path)} alt={c.caption} />
                    <span>{c.caption}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="section">
            <div className="card pad section">
              <h4>Pinned requirements</h4>
              <div className="small muted">Confirmed requirements stay visible beside every concept.</div>
              {b?.requirements.filter((r) => r.kind === "must").map((r) => (
                <div key={r.id} className="req must"><ShieldCheck className="ic" color="var(--ink)" /><div>{r.label}</div></div>
              ))}
              {b?.requirements.filter((r) => r.kind === "flexible").map((r) => (
                <div key={r.id} className="req flex"><div className="ic" /><div>{r.label} <span className="meta">· flexible</span></div></div>
              ))}
            </div>
            <div className="card pad col small">
              <h4>Four visual states</h4>
              <div><span className="chip violet">Concept</span> illustrative only</div>
              <div><span className="chip">Existing product</span> a real listing, with source</div>
              <div><span className="chip amber">Supplier proposal</span> a seller's offered design</div>
              <div><span className="chip teal">Approved sample</span> evidence for a brief version</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
