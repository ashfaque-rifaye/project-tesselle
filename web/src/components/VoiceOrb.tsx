import { useCallback, useEffect, useRef, useState } from "react";
import { Check, History, Loader2, MessageCircle, MicOff, Pause, Play, X } from "lucide-react";
import { ago, get, media, ownerKey, wsBase } from "../api";
import type { Line, ProjectState, Stage, VoiceTurn } from "../types";
import { AssistantPanel } from "./Assistant";

export type Mode = "off" | "connecting" | "listening" | "thinking" | "speaking" | "working" | "error";

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

export interface Done { label: string; ok: boolean }

/** Gemini Live, in the browser: 16 kHz mic in, 24 kHz voice out, captions and tool events. Screen moves
 *  the agent asks for are held until it finishes its turn, then made once - so the page doesn't flick
 *  between steps while it works. Reconnects by itself and the server resumes the same conversation. */
export function useLiveVoice(pid: string, view: Stage, on: { navigate: (s: Stage | "back") => void; refresh: () => void; busy?: (l: Line | null) => void },
  opts: { camera?: boolean } = {}) {
  const [mode, setMode] = useState<Mode>("off");
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [tool, setTool] = useState<string | null>(null);
  const [done, setDone] = useState<Done[]>([]);
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
  const wanted = useRef(false);
  const retries = useRef(0);
  const pendingNav = useRef<Stage | "back" | null>(null);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const speaking = () => !!outCtx.current && nextT.current > outCtx.current.currentTime + 0.05;

  const flushNav = useCallback((delay: number) => {
    if (navTimer.current) clearTimeout(navTimer.current);
    navTimer.current = setTimeout(() => {
      const s = pendingNav.current;
      pendingNav.current = null;
      if (s) cb.current.navigate(s);
    }, delay);
  }, []);

  const teardown = useCallback(() => {
    try { ws.current?.send(JSON.stringify({ type: "end" })); } catch { /* closed */ }
    const s = ws.current;
    ws.current = null;
    s?.close();
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    micCtx.current?.close().catch(() => {});
    micCtx.current = null;
    sources.current.forEach((x) => { try { x.stop(); } catch { /* ended */ } });
    sources.current.clear();
    outCtx.current?.close().catch(() => {});
    outCtx.current = null;
    nextT.current = 0;
  }, []);

  const stop = useCallback(() => {
    wanted.current = false;
    teardown();
    setMode("off");
    setTool(null);
    cb.current.busy?.(null);
    if (pendingNav.current) flushNav(0);
  }, [teardown, flushNav]);

  useEffect(() => () => { wanted.current = false; teardown(); }, [teardown]);
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

  const start = useCallback(async (resume = false) => {
    wanted.current = true;
    setError(null);
    if (!resume) { setHeard(""); setSaid(""); setDone([]); }
    setMode("connecting");
    try {
      const demo = window.__tslDemo;
      const media = demo ? null : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      stream.current = media;
      const mic = new AudioContext();
      micCtx.current = mic;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await mic.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(mic, "tsl-mic");
      if (media) mic.createMediaStreamSource(media).connect(node);
      const out = new AudioContext({ sampleRate: 24000 });
      outCtx.current = out;
      const an = out.createAnalyser();
      an.fftSize = 256;
      an.connect(out.destination);
      analyser.current = an;
      if (demo) { demo.attach({ mic, node, out, analyser: an }); demo.speaking = speaking; }

      const sock = new WebSocket(`${wsBase()}/api/projects/${pid}/live`);
      sock.binaryType = "arraybuffer";
      ws.current = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: "hello", stage: viewRef.current, key: ownerKey(), camera: !!opts.camera }));
      sock.onmessage = (m) => {
        if (m.data instanceof ArrayBuffer) {
          play(m.data);
          setMode("speaking");
          return;
        }
        const ev = JSON.parse(m.data);
        if (ev.type === "ready") { setMode("listening"); retries.current = 0; }
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
          if (pendingNav.current) flushNav(400);
        } else if (ev.type === "tool") {
          setTool(ev.label);
          setMode("working");
          cb.current.busy?.({ agent: "Voice agent", message: ev.label });
        } else if (ev.type === "navigate") {
          // Held until the agent finishes talking, then one smooth move to the last step it asked for.
          pendingNav.current = ev.stage;
          flushNav(2200);
        } else if (ev.type === "capture") {
          window.dispatchEvent(new CustomEvent("tsl:capture", { detail: { kind: ev.kind, what: ev.what } }));
        } else if (ev.type === "state") {
          setTool(null);
          setDone((d) => [...d, { label: (ev.name && TOOL_DONE[ev.name]) || "Done", ok: ev.ok !== false }].slice(-4));
          cb.current.busy?.(null);
          cb.current.refresh();
        } else if (ev.type === "error") {
          setError(ev.message);
          setMode("error");
        } else if (ev.type === "reconnect") {
          // The session is about to time out: reopen it - the server resumes the same conversation.
          teardown();
          if (wanted.current) setTimeout(() => start(true), 300);
        }
      };
      sock.onclose = () => {
        if (ws.current !== sock) return;
        teardown();
        if (wanted.current && retries.current < 3) {
          retries.current += 1;
          setMode("connecting");
          setTimeout(() => start(true), 800 * retries.current);
        } else {
          stop();
        }
      };
      sock.onerror = () => {
        if (retries.current >= 2) setError("Couldn't reach the voice agent - check your connection, or type instead.");
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
  }, [pid, stop, teardown, flushNav, opts.camera]); // eslint-disable-line

  useEffect(() => { if (window.__tslDemo) window.__tslDemo.mode = mode; }, [mode]);
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

  const sendText = (text: string, system = false) =>
    ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify({ type: "text", text, system }));
  const sendFrame = (jpeg: string) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify({ type: "frame", jpeg }));

  return { mode, heard, said, who, tool, done, error, start: () => start(false), stop, level, outLevel, sendText, sendFrame, setError };
}

const TOOL_DONE: Record<string, string> = {
  start_brief: "Brief written", set_requirement: "Brief updated", remove_requirement: "Removed", set_budget: "Budget set", set_delivery: "Delivery set",
  rename_project: "Renamed", answer_open_question: "Answer saved", add_note: "Note saved", confirm_brief: "Brief confirmed", create_concept: "Concept drawn",
  find_options: "Options found", show_look: "Look ready", add_to_picks: "Added to picks", place_order: "Orders prepared", draft_messages: "Messages drafted",
  send_messages: "Messages sent", check_replies: "Inbox checked", remember_preference: "Remembered", ask_for_photo: "Camera ready",
  save_camera_view: "Photo saved", choose_path: "Steps shaped", go_to_step: "Opened", get_project_status: "Checked your project",
};

type RGB = [number, number, number];
const PALETTE: Record<Mode, [RGB, RGB, RGB]> = {
  off: [[0.84, 1, 0.24], [0.36, 0.84, 0.78], [0.6, 0.62, 1]],
  connecting: [[0.6, 0.62, 1], [0.39, 0.82, 1], [0.84, 1, 0.24]],
  listening: [[0.84, 1, 0.24], [0.39, 0.82, 1], [0.69, 0.55, 1]],
  thinking: [[0.69, 0.55, 1], [0.39, 0.82, 1], [0.84, 1, 0.24]],
  speaking: [[0.39, 0.82, 1], [0.84, 1, 0.24], [1, 0.7, 0.36]],
  working: [[1, 0.7, 0.36], [0.84, 1, 0.24], [0.39, 0.82, 1]],
  error: [[1, 0.42, 0.42], [1, 0.7, 0.36], [0.6, 0.62, 1]],
};

const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uT; uniform float uAmp; uniform float uSpin; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 tis(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.); const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.; vec4 s1=floor(b1)*2.+1.; vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 nr=tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=nr.x; p1*=nr.y; p2*=nr.z; p3*=nr.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.); m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
mat3 rY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
void main(){
  vec2 uv=(gl_FragCoord.xy*2.-uRes)/min(uRes.x,uRes.y);
  float R=.6+uAmp*.07+sin(uT*1.3)*.008;
  float r=length(uv);
  vec3 glowCol=mix(uA,uB,.5+.5*sin(uT*.5));
  float g=exp(-max(r-R,0.)*8.)*(.18+uAmp*.6);
  if(r>=R){ gl_FragColor=vec4(glowCol*g,g*.85); return; }
  float z=sqrt(max(0.,1.-(r*r)/(R*R)));
  vec3 n=vec3(uv/R,z);
  vec3 q=rY(uSpin)*rX(uSpin*.55)*n;
  float t=uT*(.22+uAmp*.8);
  float n1=snoise(q*1.5+vec3(0.,t,t*.3));
  float n2=snoise(q*3.2-vec3(t*.6,-t*.2,t*.4)+n1*.7);
  float f=.5+.5*n1; float h=.5+.5*n2;
  vec3 base=mix(uA,uB,smoothstep(.15,.85,f));
  base=mix(base,uC,smoothstep(.5,.95,h)*.85);
  float fil=pow(1.-abs(n2),10.)*(.45+uAmp*1.5);
  vec3 inner=base*(.18+.7*pow(z,.8))+fil*mix(uB,vec3(1.),.4);
  vec3 core=vec3(.015,.04,.05);
  vec3 col=mix(core,inner,.35+.65*smoothstep(.0,.9,f*.6+h*.4+uAmp*.3));
  float fres=pow(1.-z,2.6);
  col+=mix(uC,vec3(1.),.35)*fres*.95;
  vec3 L=normalize(vec3(-.45,.6,.65));
  col+=pow(max(dot(reflect(-L,n),vec3(0.,0.,1.)),0.),40.)*.9;
  col+=pow(max(dot(reflect(-normalize(vec3(.5,-.6,.6)),n),vec3(0.,0.,1.)),0.),18.)*.12*uB;
  float edge=smoothstep(R,R-.015,r);
  gl_FragColor=vec4(col*edge+glowCol*g*(1.-edge),max(edge,g*.85));
}`;

/** The orb: a small sphere of moving light rendered in a WebGL shader - fluid colour inside, a glass
 *  rim and highlight. It breathes when idle, leans in to your voice, swirls while thinking and pulses
 *  with Tesselle's voice. Falls back to a soft CSS orb without WebGL. */
export function OrbGL({ mode, level, outLevel, size }: { mode: Mode; level: React.MutableRefObject<number>; outLevel: () => number; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const outRef = useRef(outLevel);
  outRef.current = outLevel;
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = Math.round(size * dpr);
    const gl = c.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true });
    if (!gl) { setFallback(true); return; }
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"));
    const fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) { setFallback(true); return; }
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = U("uRes"), uT = U("uT"), uAmp = U("uAmp"), uSpin = U("uSpin"), uA = U("uA"), uB = U("uB"), uC = U("uC");
    gl.uniform2f(uRes, c.width, c.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const cols = PALETTE[modeRef.current].map((x) => [...x]) as [number[], number[], number[]];
    let amp = 0, spin = 0, raf = 0;
    const t0 = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const m = modeRef.current;
      const target = m === "listening" ? Math.min(1, level.current * 9) : m === "speaking" ? Math.min(1, outRef.current() * 7)
        : m === "thinking" || m === "working" ? 0.32 : m === "connecting" ? 0.22 : 0.06;
      amp += (target - amp) * 0.16;
      spin += reduced ? 0.002 : m === "thinking" || m === "working" || m === "connecting" ? 0.028 : 0.006 + amp * 0.02;
      const goal = PALETTE[m];
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) cols[k][j] += (goal[k][j] - cols[k][j]) * 0.06;
      gl.viewport(0, 0, c.width, c.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uT, reduced ? t * 0.2 : t);
      gl.uniform1f(uAmp, amp);
      gl.uniform1f(uSpin, spin);
      gl.uniform3fv(uA, cols[0]);
      gl.uniform3fv(uB, cols[1]);
      gl.uniform3fv(uC, cols[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, level]);
  if (fallback) return <span className={`orb-fallback ${mode}`} style={{ width: size * 0.62, height: size * 0.62 }} aria-hidden="true" />;
  return <canvas ref={ref} className="orb-canvas" style={{ width: size, height: size }} aria-hidden="true" />;
}

const MODE_LABEL: Record<Mode, string> = {
  off: "Talk", connecting: "Connecting", listening: "Listening", thinking: "Thinking", speaking: "Speaking", working: "Working", error: "Paused",
};

/** The conversation, replayable: every turn in the customer's own (tidied) voice and Tesselle's. */
export function Conversation({ pid, onClose }: { pid: string; onClose: () => void }) {
  const [turns, setTurns] = useState<VoiceTurn[] | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<VoiceTurn[]>([]);
  useEffect(() => {
    get<VoiceTurn[]>(`/api/projects/${pid}/voice`).then(setTurns).catch(() => setTurns([]));
    return () => { audio.current?.pause(); };
  }, [pid]);
  const play = (t: VoiceTurn) => {
    if (!t.audio_path) return;
    audio.current?.pause();
    const a = new Audio(media(t.audio_path));
    audio.current = a;
    setPlaying(t.id);
    a.onended = () => {
      const next = queue.current.shift();
      if (next) play(next);
      else setPlaying(null);
    };
    a.play().catch(() => setPlaying(null));
  };
  const playAll = () => {
    const withAudio = (turns || []).filter((t) => t.audio_path);
    queue.current = withAudio.slice(1);
    if (withAudio[0]) play(withAudio[0]);
  };
  const pause = () => { queue.current = []; audio.current?.pause(); setPlaying(null); };
  return (
    <div className="convo glass" role="dialog" aria-label="Conversation">
      <div className="row between">
        <b>Conversation</b>
        <span className="row" style={{ gap: 6 }}>
          {turns && turns.some((t) => t.audio_path) && (playing
            ? <button className="btn sm" onClick={pause}><Pause size={13} /> Pause</button>
            : <button className="btn sm primary" onClick={playAll}><Play size={13} /> Play all</button>)}
          <button className="btn sm ghost icon-btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </span>
      </div>
      <div className="tiny muted">Your words tidied (no "um"s, long pauses cut) - still your own voice.</div>
      <div className="convo-list">
        {turns === null ? <div className="small muted"><Loader2 size={13} className="spin" /> Loading...</div>
          : !turns.length ? <div className="small muted">Nothing yet - tap the orb and talk.</div>
            : turns.map((t) => (
              <div key={t.id} className={`turn ${t.who} ${playing === t.id ? "playing" : ""}`}>
                <span className="who">{t.who === "you" ? "You" : "Tesselle"}</span>
                <span className="grow small">{t.text || <i className="muted">(voice)</i>}</span>
                {t.audio_path && <button className="chg-undo" onClick={() => (playing === t.id ? pause() : play(t))} aria-label="Play">
                  {playing === t.id ? <Pause size={12} /> : <Play size={12} />}</button>}
                <span className="tiny muted when">{ago(t.created_at)}</span>
              </div>
            ))}
      </div>
    </div>
  );
}

/** Voice-first agent, bottom-right. Tap the orb and just talk: Tesselle fills in your brief, searches,
 *  adds picks and moves on when it's ready, waiting for you to finish speaking. The bubble opens the chat;
 *  the clock replays the conversation. */
export default function VoiceOrb({
  pid, view, onNavigate, onState, onBusy, size = 58, autoStart = false,
}: {
  pid: string; view: Stage; onNavigate: (s: Stage | "back") => void; onState: (s?: ProjectState) => void; onBusy?: (l: Line | null) => void; size?: number;
  autoStart?: boolean;
}) {
  const [chat, setChat] = useState(false);
  const [convo, setConvo] = useState(false);
  const v = useLiveVoice(pid, view, { navigate: onNavigate, refresh: () => onState(), busy: onBusy });
  const active = v.mode !== "off" && v.mode !== "error";
  useEffect(() => { if (autoStart) v.start(); }, []); // eslint-disable-line
  useEffect(() => {
    const h = (e: Event) => {
      const t = (e as CustomEvent<string>).detail;
      if (active && t) v.sendText(t);
      else setChat(true);
    };
    const note = (e: Event) => { const t = (e as CustomEvent<string>).detail; if (active && t) v.sendText(t, true); };
    window.addEventListener("tsl:assistant", h);
    window.addEventListener("tsl:voice-note", note);
    return () => { window.removeEventListener("tsl:assistant", h); window.removeEventListener("tsl:voice-note", note); };
  });
  const caption = v.error || (v.who === "you" ? v.heard : v.said) || (v.mode === "listening" ? "I'm listening - take your time." : "");
  const showCard = (active || !!v.error) && (!!caption || !!v.tool || v.done.length > 0);
  return (
    <>
      {chat && (
        <AssistantPanel pid={pid} view={view} onClose={() => setChat(false)} onBusy={onBusy}
          onState={(s) => onState(s)} onNavigate={(s) => onNavigate(s)} />
      )}
      {convo && <Conversation pid={pid} onClose={() => setConvo(false)} />}
      <div className={`vorb ${v.mode}`} data-pilot="assistant">
        {showCard && (
          <div className="vorb-cap glass" aria-live="polite">
            {(v.tool || v.done.length > 0) && (
              <div className="vorb-work">
                {v.done.slice(-3).map((d, i) => <span key={i} className={`vw-done ${d.ok ? "" : "bad"}`}>{d.ok ? <Check size={10} /> : <X size={10} />} {d.label}</span>)}
                {v.tool && <span className="vw-now"><Loader2 size={11} className="spin" /> {v.tool}</span>}
              </div>
            )}
            {caption && <span className={`vorb-txt ${v.who}`}>{v.who === "you" && !v.error ? `"${caption.trim()}"` : caption}</span>}
            {v.error && <button className="vorb-x" onClick={() => v.setError(null)} aria-label="Dismiss"><X size={12} /></button>}
          </div>
        )}
        <div className="vorb-dock glass">
          <button className="vorb-mini" onClick={() => setConvo(!convo)} aria-label="Replay the conversation" title="Replay the conversation"><History size={15} /></button>
          {active ? (
            <button className="vorb-mini" onClick={v.stop} aria-label="End voice" title="End voice"><MicOff size={15} /></button>
          ) : (
            <button className="vorb-mini" onClick={() => setChat(!chat)} aria-label={chat ? "Close chat" : "Chat instead"} title={chat ? "Close chat" : "Chat instead"}><MessageCircle size={15} /></button>
          )}
          <button className="vorb-btn" onClick={() => (active ? v.stop() : v.start())} aria-label={active ? "Stop talking to Tesselle" : "Talk to Tesselle"}
            title={active ? MODE_LABEL[v.mode] : "Talk to Tesselle"}>
            <OrbGL mode={v.mode} level={v.level} outLevel={v.outLevel} size={size} />
          </button>
          <span className="vorb-state">{MODE_LABEL[v.mode]}</span>
        </div>
      </div>
    </>
  );
}
