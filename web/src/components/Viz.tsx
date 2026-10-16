import type { ReactNode } from "react";

const TONE: Record<string, string> = { volt: "var(--volt)", green: "var(--green)", amber: "var(--amber)", red: "var(--red)", sky: "var(--sky)" };

/** Semicircle gauge (iOS-widget style): value 0..1 lit along a thick rounded arc with tick marks. */
export function Gauge({ value, tone = "volt", children }: { value: number; tone?: string; children?: ReactNode }) {
  const r = 84;
  const len = Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const ticks = Array.from({ length: 13 }, (_, i) => {
    const a = Math.PI - (i / 12) * Math.PI;
    return { x1: 110 + Math.cos(a) * 104, y1: 104 - Math.sin(a) * 104, x2: 110 + Math.cos(a) * 110, y2: 104 - Math.sin(a) * 110, on: i / 12 <= v + 0.001 };
  });
  return (
    <div className="gauge" role="img" aria-label={`${Math.round(v * 100)} percent`}>
      <svg viewBox="0 0 220 118">
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={t.on ? TONE[tone] : "rgba(255,255,255,.16)"} strokeWidth="2" strokeLinecap="round" />
        ))}
        <path d={`M ${110 - r} 104 A ${r} ${r} 0 0 1 ${110 + r} 104`} fill="none" stroke="rgba(255,255,255,.09)" strokeWidth="16" strokeLinecap="round" />
        <path className="arc" d={`M ${110 - r} 104 A ${r} ${r} 0 0 1 ${110 + r} 104`} fill="none" stroke={TONE[tone]} strokeWidth="16" strokeLinecap="round"
          strokeDasharray={len} strokeDashoffset={len * (1 - v)} style={{ filter: `drop-shadow(0 0 10px ${TONE[tone]})` }} />
      </svg>
      <div className="read">{children}</div>
    </div>
  );
}

/** A small grade ring: how many of the brief's checks an option meets. */
export function FitRing({ met, total, tone = "volt", label }: { met: number; total: number; tone?: string; label?: string }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const v = total ? met / total : 0;
  return (
    <div className="ring" title={label || `${met} of ${total} checks met`} aria-label={label || `${met} of ${total} checks met`}>
      <svg viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="3.5" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={TONE[tone]} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v)} />
      </svg>
      {total ? <b>{met}<small>/{total}</small></b> : <b style={{ fontSize: 11 }}>?</b>}
    </div>
  );
}

/** Route-style progress: from -> to, with a lit path and a puck. */
export function RouteBar({ from, to, value, note }: { from: string; to: string; value: number; note?: ReactNode }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="route-track">
      <div className="ends">
        <b>{from}</b>
        <span className="tiny muted">{note}</span>
        <b>{to}</b>
      </div>
      <div className="route-bar">
        <i style={{ width: `${v * 100}%` }} />
        <b style={{ left: `${v * 100}%` }} />
      </div>
    </div>
  );
}

export function BigStat({ n, of, label, icon, className = "" }: { n: ReactNode; of?: ReactNode; label: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={`big-stat well ${className}`}>
      <div className="n">{n}{of != null && <small>/{of}</small>}</div>
      <div className="l">{icon}{label}</div>
    </div>
  );
}
