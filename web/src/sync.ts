import { deviceId, post } from "./api";

/** What this device shows - the step, how far down it is scrolled and any action it is running - is
 *  shared with the project, so the phone, the laptop and the glasses mirror each other and a device
 *  opened later continues from the same place. One small debounced write per change. */
interface Local { pid?: string; stage?: string; scroll?: number | null; busy?: string | null }
let cur: Local = {};
let timer: ReturnType<typeof setTimeout> | null = null;
export let lastPostAt = "";

export const deviceKind = () => (/^\/g\//.test(window.location.pathname) ? "glasses" : window.innerWidth < 760 ? "phone" : "desktop");

export function syncView(pid: string, patch: Local, delay = 250) {
  if (cur.pid !== pid) cur = { pid };
  Object.assign(cur, patch);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!cur.stage || !cur.pid) return;
    lastPostAt = new Date().toISOString();
    post(`/api/projects/${cur.pid}/view`, { stage: cur.stage, device: deviceId(), kind: deviceKind(), scroll: cur.scroll ?? null, busy: cur.busy ?? null })
      .catch(() => {});
  }, delay);
}

/** The element that scrolls the current step: the centre column on a computer, the page on a phone. */
export function scroller(): HTMLElement {
  const c = document.querySelector<HTMLElement>(".ws-center");
  if (c && c.scrollHeight > c.clientHeight + 4 && getComputedStyle(c).overflowY !== "visible") return c;
  return (document.scrollingElement as HTMLElement) || document.documentElement;
}

export function scrollFraction(): number {
  const el = scroller();
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? Math.round((el.scrollTop / max) * 1000) / 1000 : 0;
}

export function scrollToFraction(f: number) {
  const el = scroller();
  const max = el.scrollHeight - el.clientHeight;
  if (max > 0) el.scrollTo({ top: f * max, behavior: "smooth" });
}
