import { useEffect, useRef, useState } from "react";
import { Activity, ChevronDown, Loader2, MessageSquare, Mic, Send, Square, Wrench } from "lucide-react";
import { ago, get, stream } from "../api";
import type { ProjectState } from "../types";
import { actorLabel } from "./ui";

type Msg = { role: "customer" | "missionlock" | "tool"; text: string };

/** Floating dock: a capsule composer to talk to MissionLock, with a glass sheet that rises for the
 *  conversation or the evidence trace of every agent step. */
export default function BottomPanel({ state, onState }: { state: ProjectState; onState: (s: ProjectState) => void }) {
  const [tab, setTab] = useState<"chat" | "trace">("chat");
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pid = state.project.id;

  useEffect(() => {
    get<{ role: Msg["role"]; text: string }[]>(`/api/projects/${pid}/chat`).then(setMsgs).catch(() => {});
  }, [pid]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: 1e9, behavior: "smooth" });
  }, [msgs, tab, open]);

  function show(t: "chat" | "trace") {
    if (open && tab === t) return setOpen(false);
    setTab(t);
    setOpen(true);
  }

  async function send(body: FormData, shown: string) {
    setBusy(true);
    setTab("chat");
    setOpen(true);
    setMsgs((m) => [...m, { role: "customer", text: shown }]);
    let reply = "";
    try {
      const s = await stream(`/api/projects/${pid}/chat`, body, (e) => {
        if (e.type === "tool" && e.message) setMsgs((m) => [...m, { role: "tool", text: e.message! }]);
        if (e.type === "text" && e.text) {
          reply += e.text;
          setMsgs((m) => {
            const last = m[m.length - 1];
            if (last && last.role === "missionlock") return [...m.slice(0, -1), { role: "missionlock", text: reply }];
            return [...m, { role: "missionlock", text: reply }];
          });
        }
      });
      if (s) onState(s);
    } catch (e) {
      setMsgs((m) => [...m, { role: "missionlock", text: `Sorry - ${(e as Error).message}. Nothing was changed.` }]);
    } finally {
      setBusy(false);
    }
  }

  function sendText() {
    if (!text.trim() || busy) return;
    const fd = new FormData();
    fd.append("text", text.trim());
    send(fd, text.trim());
    setText("");
  }

  async function toggleVoice() {
    if (recording) {
      rec.current?.stop();
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(s);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        s.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const fd = new FormData();
        fd.append("audio", new Blob(chunks, { type: r.mimeType || "audio/webm" }), "voice.webm");
        send(fd, "🎙 Voice message");
      };
      r.start();
      rec.current = r;
      setRecording(true);
    } catch {
      alert("Microphone not available - type instead.");
    }
  }

  return (
    <div className="dock">
      {open && (
        <div className="sheet glass" role="region" aria-label={tab === "chat" ? "MissionLock conversation" : "Evidence and agent trace"}>
          <div className="sheet-head">
            <h4>{tab === "chat" ? "MissionLock · one session across your devices" : "Evidence & agent trace"}</h4>
            <div className="grow" />
            <span className="tiny muted hidden-sm">Gemini on Vertex AI · ADK · Agent Platform Sessions + Memory Bank</span>
            <button className="btn ghost sm icon-btn" onClick={() => setOpen(false)} aria-label="Close panel"><ChevronDown size={16} /></button>
          </div>
          {tab === "chat" ? (
            <div className="chat">
              <div className="chat-log" ref={logRef}>
                {msgs.length === 0 && (
                  <div className="small muted">
                    Talk to MissionLock - e.g. "my shelf actually leaves 17 cm", "make the pen cup shorter", or "what's still unknown?".
                    It can update your brief and concepts, but never sends requests or approves spending for you.
                  </div>
                )}
                {msgs.map((m, i) =>
                  m.role === "tool" ? (
                    <div key={i} className="msg tool"><Wrench size={12} /> {m.text}</div>
                  ) : (
                    <div key={i} className={`msg ${m.role}`}>{m.text}</div>
                  ),
                )}
                {busy && <div className="msg tool"><Loader2 size={12} className="spin" /> MissionLock is thinking...</div>}
              </div>
            </div>
          ) : (
            <div className="trace" ref={logRef}>
              {state.events.map((e) => {
                const a = actorLabel(e.actor);
                return (
                  <div key={e.id} className="trace-row">
                    <div className="when">{ago(e.ts)}</div>
                    <div className="who"><span className={`chip ${a.tone}`}>{a.name}</span></div>
                    <div>
                      <div>{e.summary}</div>
                      {e.detail && <div className="tiny muted">{e.detail}</div>}
                      {e.stats?.map((s, i) => (
                        <span key={i} className="stat-pill">
                          {s.agent || s.purpose} · {s.model} · {((s.latency_ms || 0) / 1000).toFixed(1)}s
                          {s.prompt_tokens ? ` · in ${s.prompt_tokens}` : ""}{s.output_tokens ? ` · out ${s.output_tokens}` : ""}{s.thought_tokens ? ` · think ${s.thought_tokens}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="composer glass ai">
        <div className="seg" role="tablist">
          <button className={open && tab === "chat" ? "on" : ""} onClick={() => show("chat")} role="tab" aria-selected={open && tab === "chat"}>
            <MessageSquare /> <span className="lbl">MissionLock</span>
          </button>
          <button className={open && tab === "trace" ? "on" : ""} onClick={() => show("trace")} role="tab" aria-selected={open && tab === "trace"}>
            <Activity /> <span className="lbl">Evidence & agent trace</span> <span className="count">{state.events.length}</span>
          </button>
        </div>
        <button className={`btn icon-btn ${recording ? "rec" : ""}`} onClick={toggleVoice} disabled={busy} aria-label={recording ? "Stop recording" : "Speak"}>
          {recording ? <Square size={15} /> : <Mic size={16} />}
        </button>
        <input className="input" placeholder={recording ? "Listening... press stop when done" : "Ask or tell MissionLock..."} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendText()} disabled={busy || recording}
          onFocus={() => { if (msgs.length) { setTab("chat"); setOpen(true); } }} aria-label="Message MissionLock" />
        <button className="btn primary icon-btn" onClick={sendText} disabled={busy || !text.trim()} aria-label="Send"><Send size={15} /></button>
      </div>
    </div>
  );
}
