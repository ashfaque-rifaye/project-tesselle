import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
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
  Sparkles,
  XCircle,
} from "lucide-react";
import type { Check, Line, Requirement, Verdict } from "../types";

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <Link to="/" className="brand" aria-label="Project Tesselle home">
      <img className="mark" src="/favicon.svg" alt="" />
      {!small && (
        <span className="col" style={{ gap: 0 }}>
          <span className="name">Tesselle</span>
          <span className="sub">Your shopping agent</span>
        </span>
      )}
      {small && <span className="name">Tesselle</span>}
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

/* ---------------- One-line agent status ---------------- */
/** A single line saying what an agent is doing (or just did). Fades away after it finishes. */
export function ProgressStrip({ lines, busy }: { lines: Line[]; busy: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (busy) return setShow(true);
    if (!lines.length) return setShow(false);
    const t = setTimeout(() => setShow(false), 4500);
    return () => clearTimeout(t);
  }, [busy, lines.length]);
  if (!show) return null;
  const last = lines[lines.length - 1];
  return (
    <div className={`strip ${busy ? "busy" : "done"}`} aria-live="polite">
      <span className="strip-ic">{busy ? <Loader2 size={15} className="spin" /> : <CheckMark size={14} strokeWidth={3} />}</span>
      <span className="strip-agent"><Sparkles size={12} /> {last?.agent || "Gemini"}</span>
      <span className="strip-msg">{last?.message || "Starting..."}</span>
    </div>
  );
}
export const ProgressBox = ProgressStrip;

/* ---------------- Status vocabulary ---------------- */
export function KindChip({ kind }: { kind: "must" | "flexible" }) {
  return kind === "must" ? (
    <span className="chip ink"><ShieldCheck /> Must-have</span>
  ) : (
    <span className="chip muted">Nice to have</span>
  );
}

export function ReqStatusChip({ r }: { r: Requirement }) {
  if (r.status === "needs_checking")
    return <span className="chip amber"><CircleHelp /> Measure to confirm</span>;
  return <span className="chip teal"><CheckCircle2 /> Confirmed</span>;
}

export function sourceLabel(s: Requirement["source"]) {
  return { customer: "You said", photo_estimate: "From your photo", assistant: "Suggested", seller: "Seller change you accepted" }[s];
}

export function CheckIcon({ result, size = 14 }: { result: Check["result"]; size?: number }) {
  if (result === "met") return <CheckCircle2 size={size} color="var(--green)" aria-label="fits" />;
  if (result === "unmet") return <XCircle size={size} color="var(--red)" aria-label="doesn't fit" />;
  return <CircleHelp size={size} color="var(--amber)" aria-label="check" />;
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
  meets: { label: "Fits your must-haves", tone: "teal", icon: <CheckCircle2 size={16} color="var(--green)" /> },
  possible_with_change: { label: "Worth a look - check a detail", tone: "amber", icon: <CircleHelp size={16} color="var(--amber)" /> },
  not_suitable: { label: "Doesn't fit", tone: "red", icon: <Ban size={16} color="var(--red)" /> },
  needs_quote: { label: "Can make it for you", tone: "violet", icon: <CircleDashed size={16} color="var(--sky)" /> },
};

export function StockChip({ stock }: { stock: string }) {
  const map: Record<string, [string, string]> = {
    available: ["teal", "In stock"],
    limited: ["amber", "Limited stock"],
    out_of_stock: ["red", "Out of stock"],
    made_to_order: ["violet", "Made to order"],
    unknown: ["muted", "Stock: see store"],
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
      <div className={`modal ${wide ? "wide" : ""}`} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="drawer" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

const AGENTS: Record<string, string> = {
  brief_agent: "Brief agent",
  design_agent: "Design agent", studio_director: "Design agent",
  shopping_agent: "Shopping agent", route_explorer: "Shopping agent",
  outreach_agent: "Outreach agent", seller_brief_writer: "Outreach agent",
  reply_reader: "Reply reader",
  fit_checker: "Fit checker",
  delivery_inspector: "Delivery inspector",
  assistant: "Assistant",
};

export function actorLabel(actor: string): { name: string; tone: string; agent: boolean } {
  if (actor === "customer" || actor.startsWith("customer")) return { name: "You", tone: "ink", agent: false };
  if (actor.startsWith("agent:")) {
    const a = actor.slice(6);
    return { name: AGENTS[a] || a.replace(/_/g, " "), tone: a.includes("guard") || a === "fit_checker" ? "red" : "volt", agent: true };
  }
  if (actor.startsWith("seller:")) return { name: "Seller", tone: "violet", agent: false };
  return { name: "Tesselle", tone: "muted", agent: false };
}

export function favicon(domain: string, size = 64) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}
