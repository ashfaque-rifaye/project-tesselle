import { useEffect, type ReactNode } from "react";
import type { Line, ProjectState, Stage, StreamEvent } from "../types";

/** The main action for the current step, shown on the sticky Next bar. */
export interface Primary {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  hint?: string;
}

export interface StageCtx {
  state: ProjectState;
  pid: string;
  busy: string | null;
  lines: Line[];
  act: (label: string, url: string, body?: unknown, success?: string) => Promise<ProjectState | null>;
  streamAct: (label: string, url: string, body: unknown, success?: string) => Promise<ProjectState | null>;
  go: (s: Stage, query?: string) => void;
  setPrimary: (p: Primary | null) => void;
  params: URLSearchParams;
}

export type { StreamEvent };

export const brief = (s: ProjectState) => (s.briefs.length ? s.briefs[s.briefs.length - 1] : null);

/** Register this step's main action on the Next bar (re-registered every render so handlers stay fresh). */
export function usePrimary(ctx: StageCtx, p: Primary | null) {
  useEffect(() => {
    ctx.setPrimary(p);
  });
  useEffect(() => () => ctx.setPrimary(null), []); // eslint-disable-line
}

export const STAGE_LABEL: Record<Stage, string> = {
  inspire: "Your idea",
  clarify: "What you need",
  visualise: "See ideas",
  routes: "Shop & pick",
  request: "Ask makers",
  compare: "Their replies",
  approve: "Review & order",
  fulfil: "Order",
  accept: "Delivery check",
};
