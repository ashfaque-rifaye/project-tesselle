import type { ProjectState, Stage, StreamEvent } from "../types";

export interface StageCtx {
  state: ProjectState;
  pid: string;
  busy: string | null;
  lines: string[];
  act: (label: string, url: string, body?: unknown, success?: string) => Promise<ProjectState | null>;
  streamAct: (label: string, url: string, body: unknown, success?: string) => Promise<ProjectState | null>;
  go: (s: Stage) => void;
}

export type { StreamEvent };

export const brief = (s: ProjectState) => (s.briefs.length ? s.briefs[s.briefs.length - 1] : null);
