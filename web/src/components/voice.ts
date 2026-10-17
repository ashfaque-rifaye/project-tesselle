import { useCallback, useEffect, useRef, useState } from "react";
import { API, headers } from "../api";

type Rec = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

function speechRecognition(): Rec | null {
  const W = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  const C = W.SpeechRecognition || W.webkitSpeechRecognition;
  return C ? new C() : null;
}

/** Talk-to-type: records the voice note AND shows the words live as you speak (browser speech
 *  recognition). If live recognition isn't available, Gemini transcribes the recording when you stop. */
export function useDictation(onText: (text: string, final: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [secs, setSecs] = useState(0);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const sr = useRef<Rec | null>(null);
  const timer = useRef<number | null>(null);
  const finalText = useRef("");
  const gotLive = useRef(false);
  const cb = useRef(onText);
  cb.current = onText;

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const r = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    finalText.current = "";
    gotLive.current = false;
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: (r.mimeType || "audio/webm").split(";")[0] });
      setAudio(blob);
      setListening(false);
      if (timer.current) clearInterval(timer.current);
      if (!gotLive.current && blob.size > 2000) {
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "voice.webm");
          const res = await fetch(`${API}/api/transcribe`, { method: "POST", headers: headers(false), body: fd });
          if (res.ok) cb.current((await res.json()).text, true);
        } finally {
          setTranscribing(false);
        }
      }
    };
    r.start();
    rec.current = r;
    const s = speechRecognition();
    if (s) {
      s.continuous = true;
      s.interimResults = true;
      s.lang = navigator.language || "en-IN";
      s.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finalText.current += res[0].transcript + " ";
          else interim += res[0].transcript;
        }
        gotLive.current = true;
        cb.current((finalText.current + interim).trim(), false);
      };
      s.onerror = () => {};
      s.onend = () => {};
      try { s.start(); } catch { /* ignore */ }
      sr.current = s;
    }
    setSecs(0);
    setListening(true);
    timer.current = window.setInterval(() => setSecs((x) => x + 1), 1000);
  }, []);

  const stop = useCallback(() => {
    try { sr.current?.stop(); } catch { /* ignore */ }
    if (gotLive.current) cb.current(finalText.current.trim(), true);
    rec.current?.stop();
  }, []);

  return { listening, secs, audio, setAudio, transcribing, start, stop, toggle: () => (listening ? stop() : start()) };
}

/** Speak a short line: Gemini TTS through the API, falling back to the device voice. */
export async function say(text: string, useGemini = true): Promise<void> {
  if (!text) return;
  if (useGemini) {
    try {
      const res = await fetch(`${API}/api/tts`, { method: "POST", headers: headers(), body: JSON.stringify({ text }) });
      if (res.ok) {
        const { audio } = await res.json();
        await new Promise<void>((resolve) => {
          const a = new Audio(audio);
          a.onended = () => resolve();
          a.onerror = () => resolve();
          a.play().catch(() => resolve());
        });
        return;
      }
    } catch { /* fall through */ }
  }
  if ("speechSynthesis" in window) {
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}
