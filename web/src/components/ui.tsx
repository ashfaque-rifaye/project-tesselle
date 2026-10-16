import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Ban,
  Check as CheckMark,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Info,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { Check, Requirement, Verdict } from "../types";

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <Link to="/" className="brand" aria-label="Project Tesselle home">
      <img className="mark" src="/favicon.svg" alt="" />
      <span className="col" style={{ gap: 0 }}>
        <span className="name">Tesselle</span>
        {!small && <span className="sub">Project · MissionLock</span>}
      </span>
    </Link>
  );
}

/* ---------------- Toasts ---------------- */
type Toast = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const show = useCallback((text: string, error = false) => {
    const id = Date.now();
    setToast({ id, text, error });
    setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), error ? 7000 : 4200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.id} className={`toast ${toast.error ? "error" : ""}`} role="status">
          <span className="ti">{toast.error ? <AlertTriangle size={15} /> : <CheckMark size={16} strokeWidth={3} />}</span>
          {toast.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/* ---------------- Honest progress ---------------- */
export function ProgressBox({ lines, busy }: { lines: string[]; busy: boolean }) {
  if (!lines.length && !busy) return null;
  return (
    <div className="progress-box" aria-live="polite">
      {lines.map((l, i) => {
        const live = busy && i === lines.length - 1;
        return (
          <div key={i} className={`progress-line ${live ? "live" : ""}`}>
            {live ? <Loader2 className="spin" color="var(--volt)" /> : <CheckCircle2 color="var(--green)" />}
            {l}
          </div>
        );
      })}
      {busy && !lines.length && (
        <div className="progress-line live">
          <Loader2 className="spin" color="var(--volt)" /> Starting...
        </div>
      )}
      {busy && <div className="tiny muted">You can leave this screen; the result is saved to your project.</div>}
    </div>
  );
}

/* ---------------- Status vocabulary ---------------- */
export function KindChip({ kind }: { kind: "must" | "flexible" }) {
  return kind === "must" ? (
    <span className="chip ink">
      <ShieldCheck /> Must stay the same
    </span>
  ) : (
    <span className="chip muted">Flexible</span>
  );
}

export function ReqStatusChip({ r }: { r: Requirement }) {
  if (r.status === "needs_checking")
    return (
      <span className="chip amber">
        <CircleHelp /> Needs checking
      </span>
    );
  return (
    <span className="chip teal">
      <CheckCircle2 /> Confirmed
    </span>
  );
}

export function sourceLabel(s: Requirement["source"]) {
  return { customer: "You said", photo_estimate: "Estimated from photo", assistant: "Suggested", seller: "Seller change you accepted" }[s];
}

export function CheckIcon({ result, size = 14 }: { result: Check["result"]; size?: number }) {
  if (result === "met") return <CheckCircle2 size={size} color="var(--teal)" aria-label="met" />;
  if (result === "unmet") return <XCircle size={size} color="var(--red)" aria-label="unmet" />;
  return <CircleHelp size={size} color="var(--amber)" aria-label="unknown" />;
}

export function CheckChip({ c }: { c: Check }) {
  return (
    <span className={`check-chip ${c.result}`} title={c.explanation}>
      <CheckIcon result={c.result} size={11} />
      {shortLabel(c.label)}
    </span>
  );
}

export function shortLabel(l: string) {
  return l.length > 28 ? l.slice(0, 26) + "..." : l;
}

export const VERDICT: Record<Verdict, { label: string; tone: string; icon: ReactNode }> = {
  meets: { label: "Meets confirmed requirements", tone: "teal", icon: <CheckCircle2 size={16} color="var(--teal)" /> },
  possible_with_change: { label: "Possible with a change", tone: "amber", icon: <AlertTriangle size={16} color="var(--amber)" /> },
  not_suitable: { label: "Not suitable", tone: "red", icon: <Ban size={16} color="var(--red)" /> },
  needs_quote: { label: "Makers who can quote", tone: "violet", icon: <CircleDashed size={16} color="var(--sky)" /> },
};

export function StockChip({ stock }: { stock: string }) {
  const map: Record<string, [string, string]> = {
    available: ["teal", "Available"],
    low: ["amber", "Low stock"],
    out_of_stock: ["red", "Out of stock"],
    made_to_order: ["violet", "Made to order"],
    unknown: ["muted", "Stock unknown"],
  };
  const [tone, label] = map[stock] || ["muted", stock];
  return <span className={`chip ${tone}`}>{label}</span>;
}

export function Banner({ tone = "violet", children }: { tone?: string; children: ReactNode }) {
  return (
    <div className={`label-banner ${tone === "violet" ? "" : tone}`}>
      <Info />
      <div>{children}</div>
    </div>
  );
}

export function Modal({ onClose, children, wide = false }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="overlay center" onClick={onClose} role="dialog" aria-modal="true">
      <div className={`modal ${wide ? "wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function actorLabel(actor: string): { name: string; tone: string } {
  if (actor === "customer" || actor.startsWith("customer")) return { name: "You", tone: "ink" };
  if (actor.startsWith("agent:")) {
    const a = actor.slice(6);
    const names: Record<string, string> = {
      missionlock_intake: "Intake agent",
      studio_director: "Studio",
      route_explorer: "Route explorer",
      seller_brief_writer: "Request writer",
      missionlock_guard: "MissionLock guard",
      delivery_inspector: "Delivery inspector",
      missionlock: "MissionLock",
    };
    return { name: names[a] || a, tone: a === "missionlock_guard" ? "red" : "volt" };
  }
  if (actor.startsWith("seller:")) return { name: "Seller", tone: "violet" };
  return { name: "System", tone: "muted" };
}
