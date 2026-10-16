import { useEffect, useRef, useState } from "react";
import { Ban, Check, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ProjectState } from "../types";

/** Dynamic-Island style live status. Idle: what MissionLock is protecting and what's next.
 *  Busy: expands with the agent's live progress. Done: a brief confirmation, then settles back. */
export default function Island({ state, busy, lines }: { state: ProjectState; busy: string | null; lines: string[] }) {
  const [flash, setFlash] = useState<string | null>(null);
  const prev = useRef<string | null>(busy);

  useEffect(() => {
    const was = prev.current;
    prev.current = busy;
    if (was && !busy) {
      setFlash(was);
      const t = setTimeout(() => setFlash(null), 2400);
      return () => clearTimeout(t);
    }
  }, [busy]);

  const b = state.briefs[state.briefs.length - 1];
  const quote = [...state.quotes].filter((q) => q.status === "active").sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
  const blocked = quote?.deviations.some((d) => d.decision === "pending" && d.severity === "blocked");
  const decision = quote?.deviations.some((d) => d.decision === "pending");
  const musts = b?.requirements.filter((r) => r.kind === "must") || [];

  let cls = "island";
  let orb = <ShieldCheck />;
  let orbCls = "orb";
  let l1: string = state.next_decision.title;
  let l2 = "";
  let end = <span className="pill ok">{b ? `Brief v${b.version}` : "New"}</span>;

  if (busy) {
    cls += " busy";
    orb = <span />;
    l1 = busy;
    l2 = lines[lines.length - 1] || "Starting...";
    end = <span className="wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>;
  } else if (flash) {
    cls += " done";
    orb = <Check strokeWidth={3} />;
    l1 = `${flash} · done`;
    end = <span className="pill ok">Saved</span>;
  } else if (blocked) {
    orbCls += " bad";
    orb = <Ban />;
    l1 = "MissionLock blocked a seller change";
    end = <span className="pill warn">Your call</span>;
  } else if (decision) {
    orbCls += " warn";
    orb = <TriangleAlert />;
    end = <span className="pill warn">Decide</span>;
  } else if (b?.confirmed && musts.length) {
    end = <span className="pill ok">{musts.length} locked</span>;
  }

  return (
    <div className="island-wrap">
      <div className={cls} role="status" aria-live="polite" aria-label="Agent status">
        <span className={orbCls}>{orb}</span>
        <span className="txt">
          <span className="l1">{l1}</span>
          <span className="l2">{l2}</span>
        </span>
        <span className="end">{end}</span>
      </div>
    </div>
  );
}

export function EdgeGlow({ on }: { on: boolean }) {
  return <div className={`edge-glow ${on ? "on" : ""}`} aria-hidden="true" />;
}
