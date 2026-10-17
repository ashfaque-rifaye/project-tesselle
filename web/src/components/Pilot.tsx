import { useEffect, useRef, useState } from "react";
import { Pause, Play, Sparkles, Square, Volume2, VolumeX } from "lucide-react";
import type { Stage } from "../types";
import { say } from "./voice";

/** Guided demo that runs itself: a visible cursor drives the real app (live Gemini agents, real web
 *  search) through the whole journey while captions - and optionally a Gemini voice - explain each step. */

const DEMO_TEXT =
  "I want a compact organiser for my study desk with room for my pens, my phone and an A5 notebook. The shelf above only leaves 18 cm of depth, and I rent this flat so no drilling. Something warm like bamboo would be lovely. Around 3,000 rupees, and I can't go above 3,500.";

class Stopped extends Error {}

export default function Pilot({ go, onEnd, openActivity }: { go: (s: Stage) => void; onEnd: () => void; openActivity: () => void }) {
  const [caption, setCaption] = useState<{ step: number; title: string; text: string } | null>(null);
  const [paused, setPaused] = useState(false);
  const [voice, setVoice] = useState(true);
  const ctl = useRef({ stopped: false, paused: false, voice: true });
  const cursor = useRef<HTMLDivElement>(null);
  const narration = useRef<Promise<void>>(Promise.resolve());
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => { ctl.current.paused = paused; }, [paused]);
  // Keep the caption centred over the main column (not over the brief panel).
  useEffect(() => {
    const place = () => {
      const c = document.querySelector(".ws-center")?.getBoundingClientRect();
      setLeft(c && c.width > 0 ? c.left + c.width / 2 : null);
    };
    place();
    const t = setInterval(place, 1000);
    addEventListener("resize", place);
    return () => { clearInterval(t); removeEventListener("resize", place); };
  }, []);
  useEffect(() => { ctl.current.voice = voice; }, [voice]);

  useEffect(() => {
    ctl.current.stopped = false;
    run().catch((e) => { if (!(e instanceof Stopped)) console.warn("demo stopped:", e); }).finally(() => onEnd());
    return () => { ctl.current.stopped = true; };
  }, []); // eslint-disable-line

  const sleep = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end || ctl.current.paused) {
      if (ctl.current.stopped) throw new Stopped();
      await new Promise((r) => setTimeout(r, 120));
    }
  };

  async function waitFor(sel: string, timeout = 240000): Promise<HTMLElement> {
    const t0 = Date.now();
    for (;;) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.offsetParent !== null && !(el as HTMLButtonElement).disabled) return el;
      if (Date.now() - t0 > timeout) throw new Error("timeout waiting for " + sel);
      await sleep(250);
    }
  }
  const exists = (sel: string) => !!document.querySelector(sel);
  async function waitPath(re: RegExp, timeout = 240000) {
    const t0 = Date.now();
    while (!re.test(location.pathname)) {
      if (Date.now() - t0 > timeout) throw new Error("timeout waiting for page " + re);
      await sleep(250);
    }
    await sleep(700);
  }
  async function waitIdle(timeout = 400000) {
    const t0 = Date.now();
    let calm = 0;
    while (calm < 4) {
      if (Date.now() - t0 > timeout) throw new Error("timeout waiting for the agents");
      calm = document.querySelector(".island.busy") ? 0 : calm + 1;
      await sleep(300);
    }
  }
  async function moveTo(el: HTMLElement) {
    const r0 = el.getBoundingClientRect();
    if (r0.top < 70 || r0.bottom > innerHeight - 250) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      await sleep(650);
    }
    const r = el.getBoundingClientRect();
    if (cursor.current) {
      cursor.current.style.opacity = "1";
      cursor.current.style.transform = `translate(${r.left + r.width / 2}px, ${r.top + r.height / 2}px)`;
    }
    await sleep(750);
  }
  async function click(sel: string) {
    const el = await waitFor(sel);
    await moveTo(el);
    cursor.current?.classList.add("press");
    await sleep(160);
    cursor.current?.classList.remove("press");
    el.click();
    await sleep(500);
  }
  async function type(sel: string, text: string, cps = 70) {
    const el = (await waitFor(sel)) as HTMLInputElement | HTMLTextAreaElement;
    await moveTo(el);
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    const step = Math.max(1, Math.round(text.length / 90));
    for (let i = 0; i <= text.length; i += step) {
      setter.call(el, text.slice(0, i));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(1000 / cps * step);
    }
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
  }
  async function show(step: number, title: string, text: string, waitVoice = false) {
    await narration.current;
    setCaption({ step, title, text });
    narration.current = ctl.current.voice ? say(text).catch(() => {}) : sleep(Math.min(5200, 1400 + text.length * 30)).catch(() => {});
    if (waitVoice) await narration.current;
  }

  async function run() {
    await sleep(1200);
    await show(1, "Watch Tesselle work", "This demo runs itself on the live app. Gemini agents do every step; real stores and real makers are searched as it happens.", true);

    // 1. Start
    go("inspire");
    await waitPath(/inspire/);
    await click('[data-pilot="start-describe"]');
    await show(1, "Tell it anything", "Start the way you like - words, voice, a photo or a video. Here: a sentence and a photo of the desk.");
    await type('[data-pilot="idea"]', DEMO_TEXT, 110);
    await click('[data-pilot="demo-photo"]');
    await type('[data-pilot="city"]', "Chennai, Tamil Nadu", 40);
    if (exists('[data-pilot="pin"]')) await type('[data-pilot="pin"]', "600042", 12);
    await click('[data-pilot="primary"]');
    await show(2, "The brief agent reads it all", "Gemini reads the words and the photo together, and writes a brief: what must stay the same, and what is just nice to have.");
    await waitPath(/clarify/);
    await waitIdle();

    // 2. Brief
    await show(2, "Your must-haves, kept", "Here is the brief. Every must-have - like the 18 centimetre depth - is kept unless you agree to change it. You can edit any of it, any time, on the right.", true);
    const panel = document.querySelector(".inspector");
    if (panel) panel.scrollTo({ top: 220, behavior: "smooth" });
    await sleep(1500);
    await click('[data-pilot="primary"]');
    await waitIdle();
    await waitPath(/visualise|routes/);

    // 3. Visualise
    if (/visualise/.test(location.pathname)) {
      await show(3, "See it first", "The design agent draws a concept from the brief, so you can picture it. It is clearly labelled as an illustration, never an offer.");
      await click('[data-pilot="primary"]');
      await waitIdle();
      await sleep(1500);
      await click('[data-pilot="primary"]');
      await waitPath(/routes/);
    }

    // 4. Find options
    await show(4, "Searching the real web", "Now the shopping agent and the maker scout search real stores and real makers that deliver to Chennai, using Google Search grounding. Every result links to its real page.");
    await click('[data-pilot="primary"]');
    await waitIdle();
    await waitFor('[data-pilot="headline"]', 60000);
    const headline = document.querySelector('[data-pilot="headline"]')?.textContent || "";
    await show(4, "Checked against your must-haves", `${headline} Each listing was checked against the brief by plain code - a pretty one that is too deep never gets through.`, true);
    const first = document.querySelector(".offer");
    if (first) { first.scrollIntoView({ block: "center", behavior: "smooth" }); await sleep(2200); }
    const makers = document.querySelector('[data-pilot="makers"]');
    if (makers) { makers.scrollIntoView({ block: "start", behavior: "smooth" }); await sleep(1500); }
    await show(5, "Or get it made", "If nothing ready-made fits, real makers can make it exactly. Tesselle writes the message for you.");
    await click('[data-pilot="maker-0"]');
    await click('[data-pilot="primary"]');
    await waitIdle();
    await waitPath(/request/);

    // 5. Reach out
    await show(5, "Messages, written for you", "The outreach agent wrote it, with privacy-checked photos attached - only your brief, never your name or address. Pick email, an AI phone call or WhatsApp for each maker, and Tesselle sends it.", true);
    const seg = document.querySelector(".seg") as HTMLElement | null;
    if (seg) { await moveTo(seg); await sleep(1800); }
    await show(5, "Sending stays with you", "In this public demo nothing is sent to a real business - so let's skip ahead to what happens when a maker replies.");
    await sleep(1500);
    go("compare");
    await waitPath(/compare/);

    // 6. Replies
    await show(6, "Replies get checked", "When a maker replies, paste it or drop a screenshot. Here, a practice reply shows what happens when a seller pushes a change.");
    await click('[data-pilot="practice"]');
    await waitIdle();
    await waitFor('[data-pilot="keep"]', 60000);
    await show(6, "Blocked: a change to a must-have", "The workshop wants a 20 centimetre depth to suit its tools. Your shelf allows 18 - so the fit checker stopped it, and the choice is yours.", true);
    await click('[data-pilot="keep"]');
    await show(7, "You keep it - they find a way", "Tesselle drafts your reply asking them to keep 18 centimetres. The practice workshop comes back with a layout that fits.");
    await waitIdle();
    await sleep(1200);
    if (exists('[data-pilot="accept-flex"]')) {
      await show(7, "Small trade-offs are yours too", "The price went up a little. That only touches a nice-to-have, so you can simply accept it.");
      await click('[data-pilot="accept-flex"]');
      await waitIdle();
    }
    await click('[data-pilot="primary"]');
    await waitPath(/approve/);

    // 7-8. Picks, order and tracking
    await waitIdle();
    await show(8, "Your picks, checked", "The offer goes into your picks - you can add more, from stores and makers. Each one is cleared by the fit checker before ordering.");
    for (const el of Array.from(document.querySelectorAll('[data-pilot="ack"]')) as HTMLElement[]) { await moveTo(el); el.click(); await sleep(300); }
    await click('[data-pilot="primary"]');
    await waitIdle();
    await waitPath(/fulfil/);
    await show(9, "The checkout agent takes over", "For a store, it fills the cart and your PIN code so you only authorise payment. For a maker, you confirm the order - then paste the confirmation and Tesselle tracks it.");
    await click('[data-pilot="ordered-it"]');
    await click('[data-pilot="save-ordered"]');
    await waitIdle();
    await sleep(1200);
    await click('[data-pilot="primary"]');
    await waitIdle();
    await waitPath(/accept/);

    // 9. Delivery check
    await show(10, "Checked on arrival", "The delivery inspector compares a photo with the checks you agreed - and says honestly what a photo cannot prove.");
    await click('[data-pilot="sample-photo"]');
    await waitIdle();
    await waitFor('[data-pilot="accept-item"]', 120000);
    await sleep(2500);
    await click('[data-pilot="accept-item"]');
    await waitIdle();
    openActivity();
    await show(10, "Every step, on the record", "From a sentence and a photo to a checked delivery, with every must-have kept. That's Tesselle.", true);
    await sleep(2500);
  }

  return (
    <>
      <div className="pilot-cursor" ref={cursor} aria-hidden="true" />
      {caption && (
        <div className="pilot-card glass" role="status" aria-live="polite" style={left !== null ? { left } : undefined}>
          <div className="row between" style={{ gap: 8 }}>
            <span className="chip volt"><Sparkles /> Guided demo · step {caption.step} of 10</span>
            <span className="row" style={{ gap: 4 }}>
              <button className="btn sm ghost icon-btn" onClick={() => setVoice(!voice)} aria-label={voice ? "Mute narration" : "Narrate"}>{voice ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>
              <button className="btn sm ghost icon-btn" onClick={() => setPaused(!paused)} aria-label={paused ? "Resume" : "Pause"}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
              <button className="btn sm ghost icon-btn" onClick={() => { ctl.current.stopped = true; onEnd(); }} aria-label="Stop demo"><Square size={13} /></button>
            </span>
          </div>
          <div className="pc-t">{caption.title}</div>
          <div className="pc-d">{caption.text}</div>
          <div className="pc-bar"><i style={{ width: `${caption.step * 10}%` }} /></div>
        </div>
      )}
    </>
  );
}
