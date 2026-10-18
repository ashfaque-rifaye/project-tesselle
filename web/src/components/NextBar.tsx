import { ArrowLeft, ArrowRight, Loader2, Smartphone } from "lucide-react";
import { STAGE_LABEL, type Primary } from "../stages/ctx";
import type { NextDecision, Stage } from "../types";

/** Sticky "what's next" bar at the bottom of every step - always visible, even when scrolled. Back on
 *  the left (changed your mind?), the current step's main action on the right. */
export default function NextBar({
  nd, view, primary, onPrimary, busy, go, onPhone, back, onBack, name = (s) => STAGE_LABEL[s],
}: {
  nd: NextDecision; view: Stage; primary: Omit<Primary, "onClick"> | null; onPrimary: () => void; busy: string | null;
  go: (s: Stage) => void; onPhone: () => void; back: string | null; onBack: () => void; name?: (s: Stage) => string;
}) {
  const elsewhere = nd.stage !== view;
  const label = primary?.label || (elsewhere ? `Go to ${name(nd.stage)}` : nd.cta || "Continue");
  const action = primary ? onPrimary : () => go(nd.stage);
  return (
    <div className="nextbar glass" role="region" aria-label="Next step">
      {back ? (
        <button className="btn sm ghost nb-back" onClick={onBack} title={`Back to ${back}`} aria-label={`Back to ${back}`} data-pilot="back">
          <ArrowLeft size={15} /><span className="hidden-sm">{back}</span>
        </button>
      ) : <span className="nb-dot" />}
      <div className="nb-txt">
        <div className="nb-k">{primary?.hint ? "This step" : elsewhere ? `Next · ${name(nd.stage)}` : "Next"}</div>
        <div className="nb-t">{primary?.hint || nd.title}</div>
        {!primary?.hint && <div className="nb-d">{nd.detail}</div>}
      </div>
      <button className="btn sm ghost icon-btn hidden-sm" onClick={onPhone} title="Continue on my phone" aria-label="Continue on my phone"><Smartphone size={15} /></button>
      <button className="btn primary nb-cta" data-pilot="primary" onClick={action} disabled={!!busy || !!primary?.disabled}>
        {busy ? <Loader2 size={16} className="spin" /> : primary?.icon}
        {busy ? busy : label}
        {!busy && !primary?.icon && <ArrowRight size={16} />}
      </button>
    </div>
  );
}
