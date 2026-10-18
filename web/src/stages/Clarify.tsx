import { CheckCircle2, CircleHelp, Lock, ShieldCheck, Sparkles } from "lucide-react";
import { media } from "../api";
import { FacetTile } from "../components/BriefPanel";
import { FacetIcon } from "../components/icons";
import { ProgressStrip } from "../components/ui";
import { plannedStages } from "../steps";
import { brief as currentBrief, usePrimary, type StageCtx } from "./ctx";

/** Review the brief Gemini wrote. Editing happens in the brief panel on the right (and by voice). */
export default function Clarify({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const b = currentBrief(state);
  const insp = state.project.inspiration || {};
  const pending = b ? b.requirements.filter((r) => r.kind === "must" && r.status === "needs_checking") : [];
  const layout = state.project.layout;
  const after = plannedStages(state).includes("visualise") ? "visualise" : "routes";

  async function confirm() {
    try {
      await ctx.act("Confirming your brief", `/api/projects/${pid}/brief/confirm`, {}, "Brief confirmed");
      ctx.go(after);
    } catch {
      /* toast */
    }
  }

  usePrimary(ctx, b ? (b.confirmed
    ? { label: "Continue", onClick: () => ctx.go(after), hint: "Confirmed - you can still change anything, any time" }
    : { label: "Confirm brief", onClick: confirm, disabled: pending.length > 0 || !!busy, icon: <ShieldCheck size={16} />,
        hint: pending.length ? `Measure ${pending.length === 1 ? "1 size" : `${pending.length} sizes`} first (tick it on the right)` : "Looks right? Confirm and Tesselle starts looking" })
    : null);

  if (!b) return <div className="empty">Start by telling Tesselle what you want.</div>;
  const musts = b.requirements.filter((r) => r.kind === "must");
  const flex = b.requirements.filter((r) => r.kind === "flexible");

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">{layout?.kind_label || "What you need"}</div>
          <h2>{b.title}</h2>
          <p>{b.purpose}</p>
        </div>
      </div>

      {layout && layout.facets.length > 0 && (
        <div className="card pad params">
          <div className="row between wrap" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8 }}><span className="params-ic"><FacetIcon name={layout.icon} size={15} /></span>
              <b className="small">What decides the fit for {layout.kind_label.toLowerCase()}</b></div>
            <span className="tiny muted">{layout.facets.filter((f) => !f.value).length ? `${layout.facets.filter((f) => !f.value).length} still to tell` : "All set"}</span>
          </div>
          <div className="params-grid">
            {layout.facets.map((f) => (
              <FacetTile key={f.label} icon={f.icon} label={f.label} value={f.value} ask={f.ask} fresh={false} busy={!!busy}
                onAnswer={(v) => ctx.act("Adding to your brief", `/api/projects/${pid}/brief/requirement`, { text: `${f.label}: ${v}`, kind: "must" }, `${f.label} saved`)} />
            ))}
          </div>
          <div className="tiny muted">Gemini chose these for this purchase from what you said{layout.route_reason ? ` - ${layout.route_reason.charAt(0).toLowerCase()}${layout.route_reason.slice(1)}` : "."}</div>
        </div>
      )}

      <div className="card pad understood">
        <div className="row" style={{ gap: 8 }}><Sparkles size={15} color="var(--volt)" /><b className="small">What Gemini understood</b></div>
        <div className="u-grid">
          {musts.map((r) => (
            <div key={r.id} className="u-item must">
              <span className={`lock-ic ${r.status === "needs_checking" ? "warn" : ""}`}>{r.status === "needs_checking" ? <CircleHelp /> : <Lock />}</span>
              <div>
                <div className="strong">{r.label}</div>
                <div className="tiny muted">{r.status === "needs_checking" ? "Seen in your photo - measure to confirm" : "Must-have · kept unless you agree"}</div>
              </div>
            </div>
          ))}
          {flex.map((r) => (
            <div key={r.id} className="u-item">
              <span className="lock-ic" style={{ background: "rgba(255,255,255,.08)", color: "var(--ink-2)" }}><CheckCircle2 /></span>
              <div>
                <div className="strong">{r.label}</div>
                <div className="tiny muted">Nice to have · can be traded off</div>
              </div>
            </div>
          ))}
        </div>
        <div className="tiny muted">Wrong or missing something? Change it on the right, or just tell the assistant.</div>
      </div>

      {(insp.image_path || insp.transcript || (insp.photo_observations || []).length > 0) && (
        <div className="card pad row" style={{ alignItems: "flex-start", gap: 16 }}>
          {insp.image_path && <img src={media(insp.image_path)} alt="What you shared" className="seen-img" />}
          <div className="col grow">
            <b className="small">From what you shared</b>
            {insp.transcript && <div className="small">"{insp.transcript}"</div>}
            {(insp.photo_observations || []).slice(0, 4).map((o, i) => <div key={i} className="small muted">• {o}</div>)}
          </div>
        </div>
      )}
      <ProgressStrip lines={lines} busy={!!busy} />
    </div>
  );
}
