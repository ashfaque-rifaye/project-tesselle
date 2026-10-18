import { useState } from "react";
import { Camera, Check, Eye, ImagePlus, RefreshCw, ShoppingBag, Sparkles, Undo2, Wand2 } from "lucide-react";
import { media } from "../api";
import MicButton from "../components/MicButton";
import { ProgressStrip } from "../components/ui";
import type { Concept } from "../types";
import { brief as currentBrief, usePrimary, type StageCtx } from "./ctx";

const openCapture = (what: string) => window.dispatchEvent(new CustomEvent("tsl:capture", { detail: { kind: "space", what } }));

/** One idea's picture with a dot on each new product Gemini added (catalogue style). */
function IdeaPicture({ c, big, before }: { c: Concept; big?: boolean; before?: boolean }) {
  const [on, setOn] = useState<number | null>(null);
  return (
    <div className={`idea-pic ${big ? "big" : ""}`}>
      <img src={media(before && c.base_path ? c.base_path : c.image_path)} alt={c.idea?.title || c.caption} />
      {!before && (c.spots || []).map((s) => (
        <button key={s.index} className={`idea-dot ${on === s.index ? "on" : ""}`} style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}
          onMouseEnter={() => setOn(s.index)} onMouseLeave={() => setOn(null)} onClick={(e) => { e.stopPropagation(); setOn(on === s.index ? null : s.index); }}
          aria-label={s.name}><i />{(big || on === s.index) && <span>{s.name}</span>}</button>
      ))}
      <span className="idea-badge">{before ? <><Camera size={11} /> Your photo, as it is</> : c.in_photo ? <><Sparkles size={11} /> Your photo + new products</> : <><Sparkles size={11} /> Idea · illustration</>}</span>
    </div>
  );
}

/** See ideas: Gemini looks at the customer's photo and draws 2-3 different ways to get what they want - their
 *  things stay exactly as they are, only new products are added - each listing the products it needs.
 *  Redraw one with a change, or shop it: Tesselle finds those exact products in real stores. */
export default function Visualise({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const b = currentBrief(state);
  const insp = state.project.inspiration || {};
  const hasPhoto = !!insp.image_path && !insp.generated_image;
  const all = state.concepts;
  const latestBatch = state.project.idea_batch || [...all].reverse().find((c) => c.batch)?.batch;
  const ideas = all.filter((c) => c.idea && (!latestBatch || c.batch === latestBatch));
  const legacy = !ideas.length ? all.filter((c) => !c.idea) : [];
  const shown = ideas.length ? ideas : legacy;
  const selected = shown.find((c) => c.id === state.project.selected_concept_id) || shown[shown.length - 1];
  const [instruction, setInstruction] = useState("");
  const [before, setBefore] = useState(false);
  const chosen = state.project.idea?.concept_id;

  async function draw(instr = "", base?: string) {
    try {
      await ctx.streamAct(base ? "Redrawing" : "Drawing ideas", `/api/projects/${pid}/ideas`, { instruction: instr, base_id: base || null },
        base ? "Redrawn" : "Ideas ready");
      setInstruction("");
    } catch {
      /* toast */
    }
  }
  async function shop(c: Concept) {
    try {
      await ctx.streamAct("Shopping your idea", `/api/projects/${pid}/ideas/${c.id}/use`, {}, "Real products found");
      ctx.go("routes", "look=latest");
    } catch {
      /* toast */
    }
  }
  const select = (c: Concept) => c.id !== selected?.id && ctx.act("Selecting", `/api/projects/${pid}/concepts/${c.id}/select`).catch(() => {});

  usePrimary(ctx, !shown.length
    ? { label: hasPhoto ? "Show me ideas" : "Show me ideas", onClick: () => draw(), disabled: !b?.confirmed, icon: <Sparkles size={16} />,
        hint: hasPhoto ? "Gemini draws 2-3 ideas into your photo - nothing you own changes" : "Gemini draws 2-3 ideas to choose from" }
    : instruction && selected?.idea
      ? { label: "Redraw", onClick: () => draw(instruction, selected.id), icon: <Wand2 size={16} />, hint: `Change "${selected.idea.title}": ${instruction}` }
      : selected?.idea
        ? { label: "Shop this idea", onClick: () => shop(selected), icon: <ShoppingBag size={16} />, hint: `Find ${selected.idea.items.map((i) => i.name).join(", ")} in real stores` }
        : { label: "Find real products", onClick: () => ctx.go("routes"), icon: <ShoppingBag size={16} />, hint: "Search real stores and makers" });

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">See ideas</div>
          <h2>{hasPhoto ? "Ideas for your space" : "Ideas to choose from"}</h2>
          <p>{hasPhoto ? "Gemini looked at your photo and drew a few ways to do it. Everything you already have stays exactly as it is - only the new products are added. Pick one and Tesselle finds those exact products in real stores."
            : "Gemini draws a few different ways to get what you want, each with the products it needs. Add a photo and the ideas are drawn into your own space."}</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {shown.length > 0 && <button className="btn sm" onClick={() => draw()} disabled={!!busy}><RefreshCw size={14} /> New ideas</button>}
          <button className="btn ghost sm" onClick={() => ctx.go("routes")}>Skip</button>
        </div>
      </div>

      {!hasPhoto && (
        <div className="idea-photo card pad">
          <span className="ip-ic"><ImagePlus size={20} /></span>
          <div className="grow">
            <b>Show me {state.project.layout?.photo_prompt || "the space or the item"}</b>
            <div className="small muted">Ideas are then drawn into your own photo, keeping everything you have. Snap it with your phone (QR), a webcam, or upload.</div>
          </div>
          <button className="btn sm primary" onClick={() => openCapture(state.project.layout?.photo_prompt || "the space it's for")}><Camera size={14} /> Add a photo</button>
        </div>
      )}

      {!shown.length ? (
        <div className="idea-empty">
          {busy ? <><span className="spin-ring" /> <div>{lines[lines.length - 1]?.message || "Gemini is drawing your ideas..."}</div></>
            : <><Sparkles size={28} /><div>{hasPhoto ? "Tap \"Show me ideas\" - Gemini draws 2-3 options into your photo." : "Tap \"Show me ideas\" for 2-3 options."}</div>
              <button className="btn primary" onClick={() => draw()} disabled={!b?.confirmed}><Sparkles size={16} /> Show me ideas</button></>}
        </div>
      ) : (
        <>
          <div className="idea-grid">
            {shown.map((c, i) => (
              <div key={c.id} className={`idea-card ${c.id === selected?.id ? "on" : ""}`} onClick={() => select(c)} role="button" tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && select(c)}>
                <IdeaPicture c={c} />
                <div className="idea-body">
                  <div className="row between"><span className="idea-n">Idea {i + 1}</span>{chosen === c.id && <span className="chip volt"><Check /> Shopping this</span>}</div>
                  <b>{c.idea?.title || c.caption}</b>
                  {c.idea && <span className="small muted clamp2">{c.idea.pitch}</span>}
                  {c.idea && <div className="idea-items">{c.idea.items.map((it) => <span key={it.name}>{it.name}</span>)}</div>}
                </div>
              </div>
            ))}
          </div>

          {selected && (
            <div className="idea-detail card pad">
              <div className="idea-detail-pic">
                <IdeaPicture c={selected} big before={before} />
                {selected.in_photo && selected.base_path && (
                  <button className="idea-toggle" onMouseDown={() => setBefore(true)} onMouseUp={() => setBefore(false)} onMouseLeave={() => setBefore(false)}
                    onTouchStart={() => setBefore(true)} onTouchEnd={() => setBefore(false)}><Eye size={13} /> Hold to see your photo</button>
                )}
              </div>
              <div className="idea-side">
                <div className="eyebrow" style={{ margin: 0 }}>{selected.idea ? "This idea" : "Concept"}</div>
                <h3>{selected.idea?.title || selected.caption}</h3>
                {selected.idea && <p className="small muted">{selected.idea.pitch}</p>}
                {selected.idea && (
                  <div className="idea-buy">
                    <span className="tiny muted">What you'd buy</span>
                    {selected.idea.items.map((it, k) => (
                      <div key={it.name} className="idea-buy-row"><span className="ib-n">{k + 1}</span><span className="grow"><b>{it.name}</b><span className="tiny muted">{it.why}</span></span></div>
                    ))}
                  </div>
                )}
                {selected.instruction && <div className="tiny muted"><Undo2 size={11} /> Redrawn: "{selected.instruction}"</div>}
                <div className="refine">
                  <div className="row wrap" style={{ gap: 6 }}>
                    {(selected.idea?.tweaks || ["Make it smaller", "Different colour", "Add a lamp"]).map((q) => (
                      <button key={q} className={`chip clickable ${instruction === q ? "volt" : ""}`} onClick={() => setInstruction(q)}>{q}</button>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <MicButton value={instruction} onChange={setInstruction} label="Say what to change" />
                    <input className="input" placeholder="Or type a change, e.g. 'keep it under the window'" value={instruction}
                      onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => e.key === "Enter" && instruction && selected.idea && draw(instruction, selected.id)} />
                  </div>
                </div>
                <div className="idea-acts">
                  {selected.idea && <button className="btn" disabled={!!busy || !instruction} onClick={() => draw(instruction, selected.id)}><Wand2 size={15} /> Redraw</button>}
                  {selected.idea
                    ? <button className="btn primary" disabled={!!busy} onClick={() => shop(selected)}><ShoppingBag size={15} /> Shop this idea</button>
                    : <button className="btn primary" disabled={!!busy} onClick={() => draw()}><Sparkles size={15} /> Show me ideas</button>}
                </div>
                <span className="tiny muted">Shopping an idea searches real stores for exactly these products and places the real ones into your photo.</span>
              </div>
            </div>
          )}
        </>
      )}
      <ProgressStrip lines={lines} busy={!!busy} />
    </div>
  );
}
