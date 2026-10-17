import { useRef } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { useToast } from "./ui";
import { useDictation } from "./voice";

/** Speech-to-text for any field: tap, talk, and your words are typed in as you speak (Gemini
 *  transcribes the recording when the browser has no live speech recognition). */
export default function MicButton({
  value, onChange, small = true, disabled = false, label = "Talk instead of typing",
}: {
  value: string; onChange: (v: string) => void; small?: boolean; disabled?: boolean; label?: string;
}) {
  const toast = useToast();
  const base = useRef("");
  const dict = useDictation((t) => onChange((base.current ? base.current.trimEnd() + " " : "") + t));
  return (
    <button type="button" className={`mic-btn ${small ? "sm" : ""} ${dict.listening ? "on" : ""}`} disabled={disabled || dict.transcribing}
      aria-label={dict.listening ? "Stop" : label} title={dict.listening ? `Listening ${dict.secs}s - tap to stop` : label}
      onClick={() => {
        if (!dict.listening) base.current = value;
        const r = dict.toggle();
        if (r instanceof Promise) r.catch(() => toast("Microphone not available - type instead", true));
      }}>
      {dict.transcribing ? <Loader2 size={14} className="spin" /> : dict.listening ? <Square size={13} /> : <Mic size={small ? 15 : 18} />}
    </button>
  );
}
