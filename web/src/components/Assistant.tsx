import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Send, Sparkles, Square, Volume2, VolumeX, Wrench, X } from "lucide-react";
import { get, stream } from "../api";
import type { Line, ProjectState, Stage } from "../types";
import { useDictation } from "./voice";

type Msg = { role: "customer" | "assistant" | "tool"; text: string };

const SUGGEST = ["What's next?", "Find options for me", "Make the budget 4,000", "Deliver to Bengaluru", "Take me to the replies"];

/** Voice-first assistant (ADK agent on Gemini with Agent Platform Sessions + Memory Bank). Tap and talk -
 *  your words appear as you speak - or type. It can change the brief, run steps and open screens. */
export default function Assistant({
  pid, view, onState, onNavigate, onBusy, embedded = false,
}: {
  pid: string; view: Stage; onState: (s: ProjectState) => void; onNavigate: (s: Stage) => void;
  onBusy?: (l: Line | null) => void; embedded?: boolean;
}) {
  const [open, setOpen] = useState(embedded);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);
  const [speak, setSpeak] = useState(() => {
    try { return localStorage.getItem("tsl.speak") !== "0"; } catch { return true; }
  });
  const logRef = useRef<HTMLDivElement>(null);
  const finalRef = useRef("");
  const dict = useDictation((t, final) => {
    setLive(t);
    if (final) finalRef.current = t;
  });

  useEffect(() => {
    get<{ role: string; text: string }[]>(`/api/projects/${pid}/chat`)
      .then((h) => setMsgs(h.map((m) => ({ role: m.role === "customer" ? "customer" : "assistant", text: m.text }))))
      .catch(() => {});
  }, [pid]);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9, behavior: "smooth" }); }, [msgs, live, open]);
  useEffect(() => {
    const h = (e: Event) => {
      setOpen(true);
      const t = (e as CustomEvent<string>).detail;
      if (t) send(t);
    };
    window.addEventListener("tsl:assistant", h);
    return () => window.removeEventListener("tsl:assistant", h);
  }); // eslint-disable-line

  // When the recording stops, send what was said.
  const wasListening = useRef(false);
  useEffect(() => {
    if (wasListening.current && !dict.listening) {
      const said = (finalRef.current || live).trim();
      const audio = dict.audio;
      setTimeout(() => {
        if (said) send(said);
        else if (audio) send("", audio);
        setLive("");
        finalRef.current = "";
      }, 150);
    }
    wasListening.current = dict.listening;
  }, [dict.listening]); // eslint-disable-line

  async function send(t: string, audio?: Blob | null) {
    if (busy || (!t.trim() && !audio)) return;
    setOpen(true);
    setBusy(true);
    setMsgs((m) => [...m, { role: "customer", text: t.trim() || "🎙 Voice message" }]);
    onBusy?.({ agent: "Assistant", message: "Thinking about what you said" });
    const fd = new FormData();
    fd.append("text", t.trim());
    fd.append("speak", String(speak));
    fd.append("screen", view);
    if (audio) fd.append("audio", audio, "voice.webm");
    let reply = "";
    let audioUrl: string | null = null;
    try {
      const s = await stream(`/api/projects/${pid}/chat`, fd, (e) => {
        if (e.type === "tool" && e.message) {
          setMsgs((m) => [...m, { role: "tool", text: e.message! }]);
          onBusy?.({ agent: "Assistant", message: e.message });
        }
        if (e.type === "ui" && e.navigate) onNavigate(e.navigate);
        if (e.type === "text" && e.text) {
          reply += e.text;
          setMsgs((m) => {
            const last = m[m.length - 1];
            if (last && last.role === "assistant") return [...m.slice(0, -1), { role: "assistant", text: reply }];
            return [...m, { role: "assistant", text: reply }];
          });
        }
        if (e.type === "done") audioUrl = e.audio || null;
      });
      if (s) onState(s);
      if (audioUrl && speak) new Audio(audioUrl).play().catch(() => {});
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", text: `Sorry - ${(e as Error).message}. Nothing was changed.` }]);
    } finally {
      setBusy(false);
      onBusy?.(null);
    }
  }

  function submit() {
    if (!text.trim()) return;
    send(text);
    setText("");
  }

  const panel = (
    <div className={`asst-panel glass ${embedded ? "embedded" : ""}`} role="dialog" aria-label="Assistant">
      <div className="asst-head">
        <span className="asst-orb"><Sparkles size={14} /></span>
        <div className="grow">
          <div className="strong small">Assistant</div>
          <div className="tiny muted">Gemini agent · remembers across your devices</div>
        </div>
        <button className="btn sm ghost icon-btn" onClick={() => { const v = !speak; setSpeak(v); try { localStorage.setItem("tsl.speak", v ? "1" : "0"); } catch { /* ignore */ } }}
          aria-label={speak ? "Mute spoken replies" : "Speak replies"} title={speak ? "Spoken replies on" : "Spoken replies off"}>
          {speak ? <Volume2 size={15} /> : <VolumeX size={15} />}
        </button>
        {!embedded && <button className="btn sm ghost icon-btn" onClick={() => setOpen(false)} aria-label="Close assistant"><X size={15} /></button>}
      </div>
      <div className="asst-log" ref={logRef}>
        {msgs.length === 0 && (
          <div className="asst-empty">
            <div className="small">Tap the mic and tell me what you need - I can change your brief, search, write to makers and take you to any step.</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {SUGGEST.map((s) => <button key={s} className="chip clickable" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => m.role === "tool"
          ? <div key={i} className="msg tool"><Wrench size={12} /> {m.text}</div>
          : <div key={i} className={`msg ${m.role === "customer" ? "customer" : "assistant"}`}>{m.text}</div>)}
        {dict.listening && <div className="msg customer live">{live || "Listening..."}</div>}
        {dict.transcribing && <div className="msg tool"><Loader2 size={12} className="spin" /> Writing down what you said</div>}
        {busy && <div className="msg tool"><Loader2 size={12} className="spin" /> Working on it</div>}
      </div>
      <div className="asst-input">
        <button className={`mic-btn ${dict.listening ? "on" : ""}`} onClick={() => { const r = dict.toggle(); if (r instanceof Promise) r.catch(() => alert("Microphone not available - type instead.")); }} disabled={busy}
          aria-label={dict.listening ? "Stop and send" : "Talk to the assistant"}>
          {dict.listening ? <Square size={16} /> : <Mic size={18} />}
        </button>
        <input className="input" placeholder={dict.listening ? `Listening... ${dict.secs}s - tap to send` : "Type or tap the mic"} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} disabled={busy || dict.listening} aria-label="Message the assistant" />
        <button className="btn primary icon-btn" onClick={submit} disabled={busy || !text.trim()} aria-label="Send"><Send size={15} /></button>
      </div>
    </div>
  );

  if (embedded) return panel;
  return (
    <>
      {open && panel}
      <button className={`asst-fab ${dict.listening ? "listening" : ""} ${busy ? "busy" : ""}`} data-pilot="assistant"
        onClick={() => (open ? setOpen(false) : setOpen(true))} aria-label={open ? "Hide assistant" : "Open assistant"} title="Assistant">
        {busy ? <Loader2 size={22} className="spin" /> : <Mic size={22} />}
        <span className="fab-ring" />
      </button>
    </>
  );
}
