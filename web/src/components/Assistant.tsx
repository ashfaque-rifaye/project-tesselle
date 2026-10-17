import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, Volume2, VolumeX, Wrench, X } from "lucide-react";
import { get, stream } from "../api";
import type { Line, ProjectState, Stage } from "../types";
import MicButton from "./MicButton";

type Msg = { role: "customer" | "assistant" | "tool"; text: string };

const SUGGEST = ["What's next?", "Find options for me", "Make the budget 4,000", "Deliver to 560001", "Show me how it would look"];

/** Chat with the same agent the voice orb uses (ADK agent on Gemini with Agent Platform Sessions +
 *  Memory Bank). The mic types your words in - nothing is sent as a recording. */
export function AssistantPanel({
  pid, view, onState, onNavigate, onBusy, onClose, embedded = false,
}: {
  pid: string; view: Stage; onState: (s: ProjectState) => void; onNavigate: (s: Stage | "back") => void;
  onBusy?: (l: Line | null) => void; onClose?: () => void; embedded?: boolean;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [speak, setSpeak] = useState(() => {
    try { return localStorage.getItem("tsl.speak") === "1"; } catch { return false; }
  });
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    get<{ role: string; text: string }[]>(`/api/projects/${pid}/chat`)
      .then((h) => setMsgs(h.map((m) => ({ role: m.role === "customer" ? "customer" : "assistant", text: m.text }))))
      .catch(() => {});
  }, [pid]);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9, behavior: "smooth" }); }, [msgs, busy]);

  async function send(t: string) {
    if (busy || !t.trim()) return;
    setBusy(true);
    setMsgs((m) => [...m, { role: "customer", text: t.trim() }]);
    onBusy?.({ agent: "Assistant", message: "Thinking about what you said" });
    const fd = new FormData();
    fd.append("text", t.trim());
    fd.append("speak", String(speak));
    fd.append("screen", view);
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
      setMsgs((m) => [...m, { role: "assistant", text: `Sorry - ${(e as Error).message} Nothing was changed.` }]);
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

  return (
    <div className={`asst-panel glass ${embedded ? "embedded" : ""}`} role="dialog" aria-label="Chat with Tesselle">
      <div className="asst-head">
        <span className="asst-orb"><Sparkles size={14} /></span>
        <div className="grow">
          <div className="strong small">Chat with Tesselle</div>
          <div className="tiny muted">Same Gemini agent as voice · remembers across devices</div>
        </div>
        <button className="btn sm ghost icon-btn" onClick={() => { const v = !speak; setSpeak(v); try { localStorage.setItem("tsl.speak", v ? "1" : "0"); } catch { /* ignore */ } }}
          aria-label={speak ? "Mute spoken replies" : "Speak replies"} title={speak ? "Spoken replies on" : "Spoken replies off"}>
          {speak ? <Volume2 size={15} /> : <VolumeX size={15} />}
        </button>
        {onClose && <button className="btn sm ghost icon-btn" onClick={onClose} aria-label="Close chat"><X size={15} /></button>}
      </div>
      <div className="asst-log" ref={logRef}>
        {msgs.length === 0 && (
          <div className="asst-empty">
            <div className="small">Type, or tap the mic to dictate. I can change your brief, search, write to makers, add picks and open any step.</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {SUGGEST.map((s) => <button key={s} className="chip clickable" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => m.role === "tool"
          ? <div key={i} className="msg tool"><Wrench size={12} /> {m.text}</div>
          : <div key={i} className={`msg ${m.role === "customer" ? "customer" : "assistant"}`}>{m.text}</div>)}
        {busy && <div className="msg tool"><Loader2 size={12} className="spin" /> Working on it</div>}
      </div>
      <div className="asst-input">
        <MicButton value={text} onChange={setText} small={false} disabled={busy} label="Dictate your message" />
        <input className="input" placeholder="Type or dictate" value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} disabled={busy} aria-label="Message Tesselle" />
        <button className="btn primary icon-btn" onClick={submit} disabled={busy || !text.trim()} aria-label="Send"><Send size={15} /></button>
      </div>
    </div>
  );
}

export default AssistantPanel;
