import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Loader2, Mic, MicOff, X } from "lucide-react";
import { ownerKey, wsBase } from "../api";
import type { Line, ProjectState, Stage } from "../types";
import { AssistantPanel } from "./Assistant";

type Mode = "off" | "connecting" | "listening" | "thinking" | "speaking" | "working" | "error";

const WORKLET = `
class TslMic extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.acc = 0; this.sum = 0; this.cnt = 0; this.out = new Int16Array(640); this.n = 0; this.e = 0; this.k = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]; this.e += v * v; this.k++;
      this.sum += v; this.cnt++; this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        let s = this.sum / this.cnt; this.sum = 0; this.cnt = 0;
        s = Math.max(-1, Math.min(1, s * 1.4));
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.out.length) {
          this.port.postMessage({ pcm: this.out.buffer.slice(0), level: Math.sqrt(this.e / this.k) });
          this.n = 0; this.e = 0; this.k = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("tsl-mic", TslMic);
`;

/** Gemini Live, in the browser: 16 kHz mic in, 24 kHz voice out, captions and tool events. */
function useLiveVoice(pid: string, view: Stage, on: { navigate: (s: Stage | "back") => void; refresh: () => void; busy?: (l: Line | null) => void }) {
  const [mode, setMode] = useState<Mode>("off");
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [tool, setTool] = useState<string | null>(null);
  const [who, setWho] = useState<"you" | "agent">("agent");
  const [error, setError] = useState<string | null>(null);
  const level = useRef(0);
  const ws = useRef<WebSocket | null>(null);
  const micCtx = useRef<AudioContext | null>(null);
  const outCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const sources = useRef(new Set<AudioBufferSourceNode>());
  const nextT = useRef(0);
  const turnFresh = useRef({ heard: true, said: true });
  const cb = useRef(on);
  cb.current = on;
  const viewRef = useRef(view);

  const speaking = () => !!outCtx.current && nextT.current > outCtx.current.currentTime + 0.05;

  const stop = useCallback(() => {
    try { ws.current?.send(JSON.stringify({ type: "end" })); } catch { /* closed */ }
    ws.current?.close();
    ws.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    micCtx.current?.close().catch(() => {});
    micCtx.current = null;
    sources.current.forEach((s) => { try { s.stop(); } catch { /* ended */ } });
    sources.current.clear();
    outCtx.current?.close().catch(() => {});
    outCtx.current = null;
    nextT.current = 0;
    setMode("off");
    setTool(null);
    cb.current.busy?.(null);
  }, []);

  useEffect(() => () => stop(), [stop]);
  useEffect(() => {
    viewRef.current = view;
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "view", stage: view }));
  }, [view]);

  const play = (buf: ArrayBuffer) => {
    const ctx = outCtx.current;
    if (!ctx || !analyser.current) return;
    const i16 = new Int16Array(buf);
    const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    const ab = ctx.createBuffer(1, f.length, 24000);
    ab.copyToChannel(f, 0);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(analyser.current);
    const t = Math.max(ctx.currentTime + 0.03, nextT.current);
    src.start(t);
    nextT.current = t + ab.duration;
    sources.current.add(src);
    src.onended = () => sources.current.delete(src);
  };

  const start = useCallback(async () => {
    setError(null);
    setHeard("");
    setSaid("");
    setMode("connecting");
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      stream.current = media;
      const mic = new AudioContext();
      micCtx.current = mic;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await mic.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(mic, "tsl-mic");
      mic.createMediaStreamSource(media).connect(node);
      const out = new AudioContext({ sampleRate: 24000 });
      outCtx.current = out;
      const an = out.createAnalyser();
      an.fftSize = 256;
      an.connect(out.destination);
      analyser.current = an;

      const sock = new WebSocket(`${wsBase()}/api/projects/${pid}/live`);
      sock.binaryType = "arraybuffer";
      ws.current = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: "hello", stage: viewRef.current, key: ownerKey() }));
      sock.onmessage = (m) => {
        if (m.data instanceof ArrayBuffer) {
          play(m.data);
          setMode("speaking");
          return;
        }
        const ev = JSON.parse(m.data);
        if (ev.type === "ready") setMode("listening");
        else if (ev.type === "heard") {
          if (turnFresh.current.heard) { setHeard(""); turnFresh.current.heard = false; }
          setHeard((h) => (h + ev.text).slice(-220));
          setWho("you");
          turnFresh.current.said = true;
          if (!speaking()) setMode("thinking");
        } else if (ev.type === "said") {
          if (turnFresh.current.said) { setSaid(""); turnFresh.current.said = false; }
          setSaid((s) => (s + ev.text).slice(-260));
          setWho("agent");
          turnFresh.current.heard = true;
        } else if (ev.type === "interrupted") {
          sources.current.forEach((s) => { try { s.stop(); } catch { /* ended */ } });
          sources.current.clear();
          nextT.current = 0;
          setMode("listening");
        } else if (ev.type === "turn") {
          turnFresh.current = { heard: true, said: true };
        } else if (ev.type === "tool") {
          setTool(ev.label);
          setMode("working");
          cb.current.busy?.({ agent: "Voice agent", message: ev.label });
        } else if (ev.type === "navigate") {
          cb.current.navigate(ev.stage);
        } else if (ev.type === "state") {
          setTool(null);
          cb.current.busy?.(null);
          cb.current.refresh();
        } else if (ev.type === "error") {
          setError(ev.message);
          setMode("error");
        } else if (ev.type === "reconnect") {
          setError("The voice session timed out - tap the orb to continue.");
        }
      };
      sock.onclose = () => {
        if (ws.current === sock) {
          stop();
        }
      };
      sock.onerror = () => {
        setError("Couldn't reach the voice agent - check your connection, or type instead.");
      };
      node.port.onmessage = (e) => {
        const { pcm, level: lv } = e.data as { pcm: ArrayBuffer; level: number };
        level.current = level.current * 0.6 + lv * 0.4;
        // While Tesselle is talking, only pass the mic through when you clearly speak over it (barge-in).
        if (speaking() && lv < 0.06) return;
        if (sock.readyState === WebSocket.OPEN) sock.send(pcm);
      };
    } catch (e) {
      stop();
      setError((e as Error).name === "NotAllowedError" ? "Microphone permission was declined." : "Voice isn't available on this device - type instead.");
      setMode("error");
    }
  }, [pid, stop]);

  // Keep the visual state honest as audio drains.
  useEffect(() => {
    if (mode !== "speaking") return;
    const t = setInterval(() => { if (!speaking()) setMode(tool ? "working" : "listening"); }, 200);
    return () => clearInterval(t);
  }, [mode, tool]);

  const outLevel = () => {
    const an = analyser.current;
    if (!an) return 0;
    const d = new Uint8Array(an.frequencyBinCount);
    an.getByteTimeDomainData(d);
    let s = 0;
    for (let i = 0; i < d.length; i++) { const v = (d[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / d.length);
  };

  const sendText = (text: string) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify({ type: "text", text }));

  return { mode, heard, said, who, tool, error, start, stop, level, outLevel, sendText, setError };
}

const PALETTE: Record<Mode, [string, string, string]> = {
  off: ["#d7ff3c", "#7fd8c8", "#9aa7ff"],
  connecting: ["#9aa7ff", "#64d2ff", "#d7ff3c"],
  listening: ["#d7ff3c", "#64d2ff", "#b18cff"],
  thinking: ["#b18cff", "#64d2ff", "#d7ff3c"],
  speaking: ["#64d2ff", "#d7ff3c", "#ffb35c"],
  working: ["#ffb35c", "#d7ff3c", "#64d2ff"],
  error: ["#ff6b6b", "#ffb35c", "#9aa7ff"],
};

/** A living orb: three luminous lobes that breathe when idle, lean in to your voice when listening,
 *  swirl while thinking and pulse with Tesselle's voice when it speaks. */
function OrbCanvas({ mode, level, outLevel, size }: { mode: Mode; level: React.MutableRefObject<number>; outLevel: () => number; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const outRef = useRef(outLevel);
  outRef.current = outLevel;
  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = size * dpr;
    const g = c.getContext("2d")!;
    let raf = 0;
    let amp = 0;
    let spin = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const m = modeRef.current;
      const target = m === "listening" ? Math.min(1, level.current * 9) : m === "speaking" ? Math.min(1, outRef.current() * 7) : m === "thinking" || m === "working" ? 0.35 : m === "connecting" ? 0.25 : 0.08;
      amp += (target - amp) * 0.18;
      spin += m === "thinking" || m === "working" || m === "connecting" ? 0.045 : 0.008 + amp * 0.03;
      const W = c.width;
      const R = W * 0.3;
      g.clearRect(0, 0, W, W);
      g.save();
      g.translate(W / 2, W / 2);
      const [a, b, d] = PALETTE[m];
      // deep glass body first, then the luminous lobes screened over it
      const body = g.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.05);
      body.addColorStop(0, "rgba(14,30,34,0.95)");
      body.addColorStop(1, "rgba(6,14,16,0)");
      g.fillStyle = body;
      g.beginPath();
      g.arc(0, 0, R * 1.05, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = "screen";
      [a, b, d].forEach((col, k) => {
        g.save();
        g.rotate(spin * (k % 2 ? -1 : 1) + (k * Math.PI * 2) / 3);
        g.beginPath();
        const pts = 64;
        for (let i = 0; i <= pts; i++) {
          const th = (i / pts) * Math.PI * 2;
          const wob = Math.sin(th * 3 + t * (1.2 + k * 0.4)) * (0.05 + amp * 0.16) + Math.sin(th * 5 - t * (1.7 + k * 0.3)) * (0.03 + amp * 0.1);
          const r = R * (0.86 + wob + amp * 0.12 + Math.sin(t * 1.3 + k) * 0.02);
          const x = Math.cos(th) * r + Math.cos(t * 0.7 + k * 2) * R * 0.1;
          const y = Math.sin(th) * r + Math.sin(t * 0.9 + k * 2) * R * 0.1;
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        const grad = g.createRadialGradient(-R * 0.25, -R * 0.3, R * 0.05, 0, 0, R * 1.25);
        grad.addColorStop(0, col + "d0");
        grad.addColorStop(0.5, col + "70");
        grad.addColorStop(1, col + "00");
        g.fillStyle = grad;
        g.filter = `blur(${W * 0.012}px)`;
        g.fill();
        g.restore();
      });
      g.globalCompositeOperation = "source-over";
      g.filter = "none";
      // glass core and highlight
      const core = g.createRadialGradient(-R * 0.3, -R * 0.35, 0, 0, 0, R * 0.95);
      core.addColorStop(0, "rgba(255,255,255,0.42)");
      core.addColorStop(0.22, "rgba(255,255,255,0.06)");
      core.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = core;
      g.beginPath();
      g.arc(0, 0, R * 0.95, 0, Math.PI * 2);
      g.fill();
      g.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, level]);
  return <canvas ref={ref} className="orb-canvas" style={{ width: size, height: size }} aria-hidden="true" />;
}

const MODE_LABEL: Record<Mode, string> = {
  off: "Tap to talk", connecting: "Connecting", listening: "Listening", thinking: "Thinking", speaking: "Speaking", working: "Working", error: "Voice paused",
};

/** Voice-first agent, bottom-right. Tap the orb and just talk: Tesselle fills in your brief, searches,
 *  adds picks and opens each step while it talks back (Gemini Live). The keyboard opens the chat. */
export default function VoiceOrb({
  pid, view, onNavigate, onState, onBusy, size = 62,
}: {
  pid: string; view: Stage; onNavigate: (s: Stage | "back") => void; onState: (s?: ProjectState) => void; onBusy?: (l: Line | null) => void; size?: number;
}) {
  const [chat, setChat] = useState(false);
  const v = useLiveVoice(pid, view, { navigate: onNavigate, refresh: () => onState(), busy: onBusy });
  const active = v.mode !== "off" && v.mode !== "error";
  useEffect(() => {
    const h = (e: Event) => {
      const t = (e as CustomEvent<string>).detail;
      if (active && t) v.sendText(t);
      else setChat(true);
    };
    window.addEventListener("tsl:assistant", h);
    return () => window.removeEventListener("tsl:assistant", h);
  });
  const caption = v.error || (v.who === "you" ? v.heard : v.said) || (v.mode === "listening" ? "I'm listening - tell me what you need." : "");
  return (
    <>
      {chat && (
        <AssistantPanel pid={pid} view={view} onClose={() => setChat(false)} onBusy={onBusy}
          onState={(s) => onState(s)} onNavigate={(s) => onNavigate(s)} />
      )}
      <div className={`vorb ${v.mode}`} data-pilot="assistant">
        {(active || v.error) && (caption || v.tool) && (
          <div className="vorb-cap glass" aria-live="polite">
            {v.tool && <span className="vorb-tool"><Loader2 size={11} className="spin" /> {v.tool}</span>}
            {caption && <span className={`vorb-txt ${v.who}`}>{v.who === "you" && !v.error ? `"${caption.trim()}"` : caption}</span>}
            {v.error && <button className="vorb-x" onClick={() => v.setError(null)} aria-label="Dismiss"><X size={12} /></button>}
          </div>
        )}
        <div className="vorb-col">
          {active ? (
            <button className="vorb-mini" onClick={v.stop} aria-label="End voice" title="End voice"><MicOff size={14} /></button>
          ) : (
            <button className="vorb-mini" onClick={() => setChat(!chat)} aria-label={chat ? "Close chat" : "Type instead"} title={chat ? "Close chat" : "Type instead"}><Keyboard size={14} /></button>
          )}
          <button className="vorb-btn" onClick={() => (active ? v.stop() : v.start())} aria-label={active ? "Stop talking to Tesselle" : "Talk to Tesselle"}
            title={active ? MODE_LABEL[v.mode] : "Talk to Tesselle"}>
            <OrbCanvas mode={v.mode} level={v.level} outLevel={v.outLevel} size={size + 26} />
            {!active && <span className="vorb-ic"><Mic size={18} /></span>}
          </button>
          <span className="vorb-state">{MODE_LABEL[v.mode]}</span>
        </div>
      </div>
    </>
  );
}
