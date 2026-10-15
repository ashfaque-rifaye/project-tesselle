import { useState } from "react";
import { Check, Map, X } from "lucide-react";
import type { ProjectState, Stage } from "../types";

export const BEATS: { title: string; proves: string; stage: Stage; done: (s: ProjectState, h: boolean) => boolean }[] = [
  { title: "Inspiration", proves: "Capture a desk photo and describe the organiser", stage: "inspire", done: (s) => s.briefs.length > 0 },
  { title: "Intent", proves: "Confirm 18 cm depth, no drilling and the budget", stage: "clarify", done: (s) => s.briefs.some((b) => b.confirmed) },
  { title: "Concept", proves: "Refine a labelled visualisation", stage: "visualise", done: (s) => s.concepts.length > 0 },
  { title: "Existing stock", proves: "A beautiful item is rejected: 22 cm deep", stage: "routes", done: (s) => !!s.routes },
  { title: "Maker request", proves: "Send the approved brief to a demo maker", stage: "request", done: (s) => s.requests.some((r) => r.status !== "draft") },
  { title: "Counteroffer", proves: "Maker proposes 20 cm - MissionLock flags it", stage: "compare", done: (s) => s.quotes.some((q) => q.deviations.some((d) => d.severity === "blocked")) },
  { title: "Resolution", proves: "Revised layout at 18 cm keeps the must-have", stage: "compare", done: (s) => s.quotes.some((q) => q.round > 1 && !q.deviations.some((d) => d.severity === "blocked")) },
  { title: "Device handoff", proves: "Continue the exact quote review on a phone", stage: "compare", done: (_s, h) => h },
  { title: "Approval", proves: "Approve the exact spec - sandbox order", stage: "approve", done: (s) => !!s.order },
  { title: "Aftercare", proves: "Delivery check against the approved brief", stage: "accept", done: (s) => !!s.order?.delivery_check },
];

export default function DemoGuide({ state, onGo, handedOff }: { state: ProjectState; onGo: (s: Stage) => void; handedOff: boolean }) {
  const [open, setOpen] = useState(false);
  const done = BEATS.filter((b) => b.done(state, handedOff)).length;
  return (
    <>
      <button className="btn sm teal guide-fab" onClick={() => setOpen(!open)}>
        <Map size={15} /> Demo guide · {done}/10
      </button>
      {open && (
        <div className="card raised guide">
          <div className="row between">
            <h3>Demonstration storyboard</h3>
            <button className="btn ghost sm icon-btn" onClick={() => setOpen(false)} aria-label="Close guide"><X size={15} /></button>
          </div>
          <div className="tiny muted">All sellers, prices and responses are fictional; orders are sandbox. Follow the beats in order.</div>
          {BEATS.map((b, i) => {
            const ok = b.done(state, handedOff);
            return (
              <div key={i} className={`beat ${ok ? "done" : ""}`}>
                <span className="n">{ok ? <Check size={12} /> : i + 1}</span>
                <div><div className="strong">{b.title}</div><div className="tiny muted">{b.proves}</div></div>
                <button className="btn sm ghost" onClick={() => onGo(b.stage)}>Go</button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
