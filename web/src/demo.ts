/** Demo recording mode (off unless the page is opened with ?demo=1): the voice agent hears scripted lines played
 *  into its microphone input instead of a real microphone, and both sides of the conversation are recorded in the
 *  page, each with its wall-clock start time, so a screen recording can be given a clean, in-sync soundtrack.
 *  Normal visitors never touch this code path. */

type Seg = { kind: "user" | "agent"; t0: number; rec: MediaRecorder; chunks: Blob[] };

export interface DemoHooks {
  mode: string;
  speaking: () => boolean;
  attach: (a: { mic: AudioContext; node: AudioWorkletNode; out: AudioContext; analyser: AnalyserNode }) => void;
  say: (url: string) => Promise<{ t0: number; seconds: number }>;
  export: () => Promise<{ kind: string; t0: number; b64: string }[]>;
}

declare global { interface Window { __tslDemo?: DemoHooks } }

export function installDemo() {
  let on = false;
  try {
    if (new URLSearchParams(location.search).get("demo") === "1") sessionStorage.setItem("tsl.demo", "1");
    on = sessionStorage.getItem("tsl.demo") === "1";
  } catch { /* storage blocked */ }
  if (!on) return;
  const segs: Seg[] = [];
  let bus: GainNode | null = null;
  let micCtx: AudioContext | null = null;
  const record = (kind: Seg["kind"], stream: MediaStream) => {
    const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
    const seg: Seg = { kind, t0: performance.timeOrigin + performance.now(), rec, chunks: [] };
    rec.ondataavailable = (e) => e.data.size && seg.chunks.push(e.data);
    rec.start(1000);
    segs.push(seg);
  };
  window.__tslDemo = {
    mode: "off",
    speaking: () => false,
    attach({ mic, node, out, analyser }) {
      micCtx = mic;
      bus = mic.createGain();
      bus.gain.value = 0.6;  // TTS clips run hot; the mic path adds gain of its own
      bus.connect(node);
      // A real microphone never stops streaming; keep the graph live between lines so the silence that ends a turn is sent.
      const room = mic.createConstantSource();
      room.offset.value = 0;
      room.connect(bus);
      room.start();
      const ud = mic.createMediaStreamDestination();
      bus.connect(ud);
      record("user", ud.stream);
      const ad = out.createMediaStreamDestination();
      analyser.connect(ad);
      record("agent", ad.stream);
    },
    async say(url) {
      if (!micCtx || !bus) throw new Error("voice not started");
      const buf = await micCtx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const src = micCtx.createBufferSource();
      src.buffer = buf;
      src.connect(bus);
      const t0 = performance.timeOrigin + performance.now();
      await new Promise<void>((done) => { src.onended = () => done(); src.start(); });
      return { t0, seconds: buf.duration };
    },
    async export() {
      const out = [];
      for (const s of segs) {
        if (s.rec.state !== "inactive") await new Promise<void>((done) => { s.rec.onstop = () => done(); s.rec.stop(); });
        const b = new Blob(s.chunks, { type: "audio/webm" });
        const b64 = await new Promise<string>((r) => { const f = new FileReader(); f.onload = () => r(String(f.result).split(",")[1]); f.readAsDataURL(b); });
        out.push({ kind: s.kind, t0: s.t0, b64 });
      }
      return out;
    },
  };
}
