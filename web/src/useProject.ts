import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get, post, stream } from "./api";
import type { Line, Project, ProjectState, StreamEvent } from "./types";

export interface Remote { view?: Project["view"]; live?: Project["live"] }
import { useToast } from "./components/ui";

/** Loads a project, keeps it fresh across devices (cheap rev polling), and runs actions with
 *  honest progress lines. Every surface (desktop, phone, glasses) uses this one hook. */
export function useProject(pid: string | undefined) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [remoteChange, setRemoteChange] = useState(false);
  const [remote, setRemote] = useState<Remote>({});
  const rev = useRef(0);
  const localAction = useRef(false);
  const toast = useToast();

  const apply = useCallback((s: ProjectState | null) => {
    if (s) {
      rev.current = s.project.rev;
      setState(s);
    }
  }, []);

  const load = useCallback(async () => {
    if (!pid) return;
    try {
      apply(await get<ProjectState>(`/api/projects/${pid}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [pid, apply]);

  useEffect(() => {
    load();
  }, [load]);

  // Cross-device continuity: poll the revision counter; refetch when another surface changed it.
  useEffect(() => {
    if (!pid) return;
    const t = setInterval(async () => {
      if (document.hidden || localAction.current) return;
      try {
        const r = await get<{ rev: number; view?: Project["view"]; live?: Project["live"] }>(`/api/projects/${pid}/rev`);
        setRemote((old) => (JSON.stringify(old) === JSON.stringify({ view: r.view, live: r.live }) ? old : { view: r.view, live: r.live }));
        if (r.rev !== rev.current && rev.current !== 0) {
          await load();
          setRemoteChange(true);
          setTimeout(() => setRemoteChange(false), 6000);
        }
      } catch {
        /* offline: keep the last known state */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [pid, load]);

  const run = useCallback(
    async (label: string, fn: (onEvent: (e: StreamEvent) => void) => Promise<ProjectState | null>, success?: string) => {
      setBusy(label);
      setLines([]);
      localAction.current = true;
      const revBefore = rev.current;
      const recover = async () => {
        // The server saves every step, so a dropped connection is recovered from the saved project state.
        const fresh = pid ? await get<ProjectState>(`/api/projects/${pid}`).catch(() => null) : null;
        if (fresh && fresh.project.rev !== revBefore) {
          apply(fresh);
          return fresh;
        }
        return null;
      };
      try {
        let s = await fn((e) => {
          if ((e.type === "progress" || e.type === "tool") && e.message) setLines((l) => [...l, { agent: e.agent, message: e.message! }]);
        });
        if (!s) s = await recover();
        apply(s);
        if (success) toast(success);
        return s;
      } catch (e) {
        if (!(e instanceof ApiError)) {
          const fresh = await recover();
          if (fresh) {
            if (success) toast(success);
            return fresh;
          }
        }
        const err = e as ApiError;
        const msg = err.details?.length ? `${err.message} ${err.details.join(" ")}` : err.message;
        toast(msg, true);
        await load();
        throw e;
      } finally {
        localAction.current = false;
        setBusy(null);
      }
    },
    [apply, load, toast, pid],
  );

  const act = useCallback(
    (label: string, url: string, body?: unknown, success?: string) =>
      run(label, async () => post<ProjectState>(url, body), success),
    [run],
  );

  const streamAct = useCallback(
    (label: string, url: string, body: unknown, success?: string) =>
      run(label, (onEvent) => stream(url, body, onEvent), success),
    [run],
  );

  return { state, error, busy, lines, setLines, load, act, streamAct, remoteChange, remote, setState: apply };
}
