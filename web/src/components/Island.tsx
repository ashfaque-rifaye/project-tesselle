import { useEffect, useRef, useState } from "react";
import { Ban, Check, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import type { Line, ProjectState } from "../types";

/** Dynamic-Island style live status. Busy: which Gemini agent is working and exactly what it's doing.
 *  Done: a short confirmation. Idle: the one next step. */
export default function Island({ state, busy, lines }: { state: ProjectState; busy: string | null; lines: Line[] }) {
  const [flash, setFlash] = useState<Line | null>(null);
  const prev = useRef<string | null>(busy);
  const lastLine = useRef<Line | null>(null);
  lastLine.current = lines[lines.length - 1] || lastLine.current;

  useEffect(() => {
    const was = prev.current;
    prev.current = busy;
    if (was && !busy) {
      setFlash(lastLine.current || { message: `${was} - done` });
      const t = setTimeout(() => setFlash(null), 2600);
      return () => clearTimeout(t);
    }
  }, [busy]);

  const b = state.briefs[state.briefs.length - 1];
  const quote = [...state.quotes].filter((q) => q.status === "active").sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
  const blocked = quote?.deviations.some((d) => d.decision === "pending" && d.severity === "blocked");
  const decision = quote?.deviations.some((d) => d.decision === "pending");
  const musts = b?.requirements.filter((r) => r.kind === "must") || [];
  const last = lines[lines.length - 1];

  let cls = "island";
  let orb = <ShieldCheck />;
  let orbCls = "orb";
  let l1: string = state.next_decision.title;
  let l2 = "";
  let end = <span className="pill ok">{b ? `Brief v${b.version}` : "New"}</span>;

  if (busy) {
    cls += " busy";
    orb = <span />;
    l1 = last?.agent ? `${last.agent} · Gemini` : busy;
    l2 = last?.message || `${busy}...`;
    end = <span className="wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>;
  } else if (flash) {
    cls += " done";
    orb = <Check strokeWidth={3} />;
    l1 = flash.agent ? `${flash.agent} · done` : "Done";
    l2 = flash.message;
    end = <span className="pill ok"><Sparkles size={11} /> Gemini</span>;
  } else if (blocked) {
    orbCls += " bad";
    orb = <Ban />;
    l1 = "A seller wants to change a must-have";
    end = <span className="pill warn">Your call</span>;
  } else if (decision) {
    orbCls += " warn";
    orb = <TriangleAlert />;
    end = <span className="pill warn">Decide</span>;
  } else if (b?.confirmed && musts.length) {
    end = <span className="pill ok">{musts.length} must-haves kept</span>;
  }

  return (
    <div className="island-wrap">
      <div className={cls + (flash && !busy ? " two" : "")} role="status" aria-live="polite" aria-label="What Tesselle is doing">
        <span className={orbCls}>{orb}</span>
        <span className="txt">
          <span className="l1">{l1}</span>
          {l2 && <span className="l2">{l2}</span>}
        </span>
        <span className="end">{end}</span>
      </div>
    </div>
  );
}

export function EdgeGlow({ on }: { on: boolean }) {
  return <div className={`edge-glow ${on ? "on" : ""}`} aria-hidden="true" />;
}
