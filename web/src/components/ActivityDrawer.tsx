import { useState } from "react";
import { ChevronDown, Sparkles, User, X } from "lucide-react";
import { ago } from "../api";
import type { ActivityEvent } from "../types";
import { actorLabel, Drawer } from "./ui";

/** "Activity": everything the Gemini agents and you have done on this project, in plain words.
 *  Technical details (model, time, tokens) are one tap away for the curious. */
export default function ActivityDrawer({ events, onClose }: { events: ActivityEvent[]; onClose: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Drawer onClose={onClose}>
      <div className="row between">
        <div>
          <h2 style={{ fontSize: 28 }}>Activity</h2>
          <div className="small muted">What your agents did, step by step.</div>
        </div>
        <button className="btn ghost sm icon-btn" onClick={onClose} aria-label="Close activity"><X size={16} /></button>
      </div>
      <div className="act-list">
        {events.map((e) => {
          const a = actorLabel(e.actor);
          const open = openId === e.id;
          return (
            <div key={e.id} className="act-item">
              <span className={`act-av ${a.agent ? "agent" : ""}`}>{a.agent ? <Sparkles size={13} /> : <User size={13} />}</span>
              <div className="grow">
                <div className="row between" style={{ gap: 8 }}>
                  <span className="strong small">{a.name}{a.agent && <span className="muted" style={{ fontWeight: 500 }}> · Gemini</span>}</span>
                  <span className="tiny muted">{ago(e.ts)}</span>
                </div>
                <div className="small" style={{ marginTop: 2 }}>{e.summary}</div>
                {e.detail && <div className="tiny muted" style={{ marginTop: 3 }}>{e.detail}</div>}
                {e.stats?.length > 0 && (
                  <button className="act-more" onClick={() => setOpenId(open ? null : e.id)}>
                    How it was done <ChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : "none" }} />
                  </button>
                )}
                {open && e.stats?.map((s, i) => (
                  <span key={i} className="stat-pill">
                    {s.agent || s.purpose} · {s.model} · {((s.latency_ms || 0) / 1000).toFixed(1)}s
                    {s.prompt_tokens ? ` · in ${s.prompt_tokens}` : ""}{s.output_tokens ? ` · out ${s.output_tokens}` : ""}
                    {s.framework ? ` · ${s.framework}` : ""}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Drawer>
  );
}
