import type { ProjectState, StreamEvent } from "./types";

const VISITOR_KEY = "df.visitor";

/** On Firebase Hosting (CDN) the API is called directly on Cloud Run so long agent streams are never
 *  buffered or cut by the hosting proxy; on Cloud Run itself the API is same-origin. */
export const API = /\.(web\.app|firebaseapp\.com)$/.test(window.location.hostname)
  ? "https://tesselle-448771854429.asia-southeast1.run.app"
  : "";
const u = (url: string) => (url.startsWith("/api/") ? API + url : url);

export function visitorId(): string {
  try {
    let v = localStorage.getItem(VISITOR_KEY);
    if (!v) {
      v = "v_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      localStorage.setItem(VISITOR_KEY, v);
    }
    return v;
  } catch {
    return "v_ephemeral_" + Math.random().toString(36).slice(2, 12);
  }
}

export class ApiError extends Error {
  details: string[];
  status: number;
  constructor(message: string, status: number, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let details: string[] = [];
    try {
      const j = await res.json();
      msg = j.error || j.detail || msg;
      details = j.details || [];
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status, details);
  }
  return res.json() as Promise<T>;
}

const OWNER_KEY = "tsl.owner";

/** The owner key unlocks sending from the owner's connected inbox and phone line on this device. */
export function ownerKey(): string {
  try { return localStorage.getItem(OWNER_KEY) || ""; } catch { return ""; }
}
export function setOwnerKey(k: string) {
  try { if (k) localStorage.setItem(OWNER_KEY, k.trim()); else localStorage.removeItem(OWNER_KEY); } catch { /* ignore */ }
}

/** A short id for this device, so another device can tell who moved (follow mode). */
export function deviceId(): string {
  try {
    let d = sessionStorage.getItem("tsl.device");
    if (!d) { d = (window.innerWidth < 760 ? "phone-" : "desktop-") + Math.random().toString(36).slice(2, 8); sessionStorage.setItem("tsl.device", d); }
    return d;
  } catch { return "device"; }
}

export function headers(json = true): HeadersInit {
  const h: Record<string, string> = { "X-Visitor-Id": visitorId() };
  const k = ownerKey();
  if (k) h["X-Owner-Key"] = k;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

export async function get<T>(url: string): Promise<T> {
  return handle<T>(await fetch(u(url), { headers: headers(false) }));
}

export async function post<T>(url: string, body?: unknown): Promise<T> {
  return handle<T>(await fetch(u(url), { method: "POST", headers: headers(), body: JSON.stringify(body ?? {}) }));
}

/** POST and read an NDJSON progress stream. Returns the final project state if the stream had one. */
export async function stream(
  url: string,
  body: unknown,
  onEvent: (e: StreamEvent) => void,
): Promise<ProjectState | null> {
  const isForm = body instanceof FormData;
  const res = await fetch(u(url), {
    method: "POST",
    headers: isForm ? headers(false) : headers(),
    body: isForm ? (body as FormData) : JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.body) {
    await handle(res);
    return null;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final: ProjectState | null = null;
  let error: StreamEvent | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as StreamEvent;
      if (ev.state) final = ev.state;
      if (ev.type === "error") error = ev;
      onEvent(ev);
    }
  }
  if (error) throw new ApiError(error.message || "Something went wrong", 500, error.details || []);
  return final;
}

export const media = (path?: string | null) => (path ? `${API}/api/media/${path}` : "");

/** Store product photos go through Tesselle's image proxy (some stores block hotlinking). */
export const img = (url?: string | null) => (url ? `${API}/api/img?u=${encodeURIComponent(url)}` : "");

/** WebSocket base for the live voice agent. */
export const wsBase = () => (API || window.location.origin).replace(/^http/, "ws");

export const inr = (v?: number | null) =>
  v === null || v === undefined ? "Not yet known" : "₹" + Math.round(v).toLocaleString("en-IN");

export function ago(iso?: string): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
