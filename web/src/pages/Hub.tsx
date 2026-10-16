import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight, ArrowUpRight, Ban, Camera, Check, Glasses, ImagePlus, Loader2, Lock, Mic, PackageCheck, PlayCircle, ShieldCheck,
  Sparkles, Store, X,
} from "lucide-react";
import { ago, get, post } from "../api";
import HeroScene from "../components/HeroScene";
import { useToast } from "../components/ui";
import { BigStat, Gauge, RouteBar } from "../components/Viz";
import { useGo } from "../nav";
import type { NextDecision, Project, ProjectState } from "../types";

interface Card { project: Project; next_decision: NextDecision; brief_version: number; last_event?: { summary: string; ts: string } | null }

const FIRST_VISIT = (() => {
  try {
    if (sessionStorage.getItem("tsl.intro")) return false;
    sessionStorage.setItem("tsl.intro", "1");
    return true;
  } catch {
    return false;
  }
})();

const STORY: { tone: string; icon: ReactNode; text: string; pct: number }[] = [
  { tone: "info", icon: <Camera />, text: "Desk photo and voice note captured", pct: 0.12 },
  { tone: "ok", icon: <Lock />, text: "Brief confirmed · 4 must-haves locked", pct: 0.26 },
  { tone: "bad", icon: <X />, text: "Atelier station is 22 cm deep · rejected", pct: 0.44 },
  { tone: "bad", icon: <Ban />, text: "Maker proposes 20 cm · blocked", pct: 0.6 },
  { tone: "ok", icon: <Check />, text: "Kept 18 cm · layout revised to 16 cm", pct: 0.8 },
  { tone: "ok", icon: <PackageCheck />, text: "Sandbox order approved · delivery checked", pct: 1 },
];

const STACK = [
  ["Model", "Gemini 3.8 Flash", "Reasoning plus image, audio and video understanding."],
  ["Image", "Gemini 3.1 Flash Image", "Concepts, maker proposals and this page's scenery."],
  ["Agents", "Google ADK 2", "Nine specialist agents and a parallel graph Workflow."],
  ["Memory", "Agent Platform", "Sessions and Memory Bank across every device."],
  ["Search", "Firestore vectors", "Gemini Embedding 2 over the sample catalogue."],
  ["Voice", "Gemini TTS", "Spoken replies, recaps and glasses answers."],
  ["Run", "Cloud Run + Firebase", "Streaming agent progress on a global CDN."],
  ["Ops", "Cloud Trace + Logging", "Every agent step traced end to end."],
];
const CHIPS = ["Gemini on Vertex AI", "ADK Workflow · JoinNode", "Agent Platform Sessions", "Memory Bank", "Firestore vector search", "Gemini Embedding 2",
  "Gemini TTS", "Cloud Run", "Firebase Hosting", "Cloud Storage", "Cloud Build", "Artifact Registry", "Cloud Trace", "IAM · no API keys"];

function useReveal() {
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.12 });
    document.querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
    return () => io.disconnect();
  });
}

function Intro() {
  const [n, setN] = useState(0);
  const [gone, setGone] = useState(!FIRST_VISIT);
  useEffect(() => {
    if (gone) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 1300);
      setN(Math.round(100 * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const done = setTimeout(() => setGone(true), 2600);
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, []); // eslint-disable-line
  if (gone) return null;
  return (
    <div className="intro" aria-hidden="true">
      <div className="frame" />
      <div className="word"><img src="/favicon.svg" width={30} height={30} alt="" /> Project Tesselle</div>
      <div className="count">{n}%</div>
    </div>
  );
}

function Words({ text, delay }: { text: string; delay: number }) {
  return <>{text.split(" ").map((w, i) => <i key={i} style={{ animationDelay: `${delay + i * 0.08}s` }}>{w}&nbsp;</i>)}</>;
}

/** The hero's live mission card - a looping, labelled replay of the demo story. */
function MissionCard({ onLaunch, busy }: { onLaunch: () => void; busy: boolean }) {
  const [step, setStep] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s >= STORY.length + 1 ? 1 : s + 1)), 1900);
    return () => clearInterval(t);
  }, []);
  const shown = STORY.slice(0, Math.min(step, STORY.length));
  const pct = shown[shown.length - 1].pct;
  return (
    <div className="mission glass">
      <div className="row between">
        <span className="chip volt"><span className="dot live" /> MissionLock · live replay</span>
        <span className="chip muted">v3</span>
      </div>
      <div>
        <div className="ttl">Bamboo desk organiser</div>
        <div className="tiny muted" style={{ marginTop: 4 }}>Kaveri Woodcraft · make route · Chennai</div>
      </div>
      <div className="two">
        <div className="cell"><div className="k">Depth</div><div className="v"><Lock size={13} color="var(--volt)" /> ≤ 18 cm</div></div>
        <div className="cell"><div className="k">Budget</div><div className="v">₹6,500 target</div></div>
      </div>
      <RouteBar from="Spark" to="Doorstep" value={pct} note={`${Math.round(pct * 100)}%`} />
      <div className="feed" aria-live="off">
        {shown.slice(-3).map((e) => (
          <div key={e.text} className={`ev ${e.tone}`}><span className="ic">{e.icon}</span>{e.text}</div>
        ))}
      </div>
      <div className="row between">
        <div className="price"><b>₹5,890</b><span className="tiny muted">known · sandbox</span></div>
        <button className="btn light sm" onClick={onLaunch} disabled={busy}>Try this journey <ArrowRight size={14} /></button>
      </div>
    </div>
  );
}

export default function Hub() {
  const go = useGo();
  const toast = useToast();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const promo = useRef<HTMLVideoElement>(null);
  useReveal();

  useEffect(() => {
    document.title = "Project Tesselle - imagine it, keep what matters, get it made";
    get<Card[]>("/api/projects").then(setCards).catch(() => setCards([]));
  }, []);

  async function create(demo: boolean, label: string, next: string = "inspire") {
    setCreating(label);
    try {
      const s = await post<ProjectState>("/api/projects", { demo, title: "New project" });
      go(next === "glasses" ? `/g/${s.project.id}` : `/p/${s.project.id}/inspire${next !== "inspire" ? `?mode=${next}` : ""}`);
    } catch (e) {
      toast((e as Error).message, true);
      setCreating(null);
    }
  }
  const spin = (l: string, icon: ReactNode) => (creating === l ? <Loader2 size={16} className="spin" /> : icon);

  return (
    <div className="home">
      <Intro />

      <section className="hero">
        <div className="hero-frame">
          <div className="hero-fallback" />
          <HeroScene />
          <div className="gem-glow hidden-sm" />
          <div className="mist" />
          <div className="hero-shade" />
          <div className="hero-rim" />

          <nav className="hero-nav">
            <a href="/" className="brand" aria-label="Project Tesselle home">
              <img className="mark" src="/favicon.svg" alt="" />
              <span className="col" style={{ gap: 0 }}><span className="name">Tesselle</span><span className="sub">Project · MissionLock</span></span>
            </a>
            <div className="links glass">
              <a href="#capture">Capture</a><a href="#missionlock">MissionLock</a><a href="#glasses">Glasses</a><a href="#devices">Continuity</a><a href="#stack">Google stack</a>
            </div>
            <a className="btn sm ghost hidden-sm" href="/seller/kaveri"><Store size={14} /> Seller</a>
            <button className="btn sm light" onClick={() => create(true, "demo")} disabled={!!creating}>{spin("demo", <PlayCircle size={14} />)} Guided demo</button>
          </nav>

          <div className="hero-copy">
            <h1>
              <span><Words text="Imagine it." delay={FIRST_VISIT ? 1.9 : 0.15} /></span>
              <span className="l2"><Words text="Keep what matters." delay={FIRST_VISIT ? 2.1 : 0.35} /></span>
              <span><Words text="Get it made." delay={FIRST_VISIT ? 2.4 : 0.6} /></span>
            </h1>
          </div>

          <div className="hero-bottom">
            <p>
              Show Tesselle a photo, a voice note or a glance through your glasses. It turns the spark into a brief you confirm, checks what can
              really be bought, sourced or made - and <b>MissionLock</b> makes sure nothing quietly changes what you asked for.
            </p>
            <div className="cta">
              <button className="btn primary lg" onClick={() => create(true, "demo")} disabled={!!creating}>{spin("demo", <PlayCircle size={17} />)} Launch the guided demo</button>
              <button className="btn lg" onClick={() => create(false, "new")} disabled={!!creating}>{spin("new", <Sparkles size={16} />)} Start my own project</button>
              <button className="btn lg ghost" onClick={() => create(false, "glasses", "glasses")} disabled={!!creating}><Glasses size={17} /> Glasses mode</button>
            </div>
            <div className="tiny muted">No sign-up · demo sellers are fictional · orders are sandbox - nothing is bought</div>
          </div>

          <MissionCard onLaunch={() => create(true, "demo")} busy={!!creating} />
          <span className="chip muted hero-tag" style={{ background: "rgba(4,10,12,.45)" }}><Sparkles /> Scene generated with Gemini</span>
        </div>
      </section>

      <section className="home-section" id="capture">
        <span className="eyebrow-pill glass reveal"><span className="dot" /> 01 · Capture anything</span>
        <h2 className="reveal">Start from whatever you have. <span className="soft-text">Words, a glance, a frame of video.</span></h2>
        <div className="widgets reveal">
          {[
            { ic: <Mic />, t: "Speak it", d: "A voice note in your own words. Gemini hears what must not change.", go: () => create(false, "Speak it", "describe") },
            { ic: <Camera />, t: "Capture your space", d: "Live camera. Sizes from a photo stay 'Needs checking' until you measure.", go: () => create(false, "Capture your space", "space") },
            { ic: <ImagePlus />, t: "Show an inspiration", d: "A photo, screenshot or a short clip of something you love.", go: () => create(false, "Show an inspiration", "inspiration") },
            { ic: <Sparkles />, t: "Imagine it", d: "Describe it and Gemini renders it - clearly labelled as a concept.", go: () => create(false, "Imagine it", "imagine") },
            { ic: <Glasses />, t: "From your glasses", d: "Share a Ray-Ban Meta capture to Tesselle, or open the heads-up view.", go: () => create(false, "From your glasses", "glasses") },
          ].map((c) => (
            <button key={c.t} className="glass sheen widget" onClick={c.go} disabled={!!creating}>
              <span className="ic">{creating === c.t ? <Loader2 className="spin" /> : c.ic}</span>
              <span className="go"><ArrowUpRight size={15} /></span>
              <span className="t">{c.t}</span>
              <span className="d">{c.d}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-section" id="missionlock">
        <span className="eyebrow-pill glass reveal"><span className="dot" /> 02 · MissionLock</span>
        <h2 className="reveal">Tracked, not trusted. <span className="soft-text">Every seller change becomes your decision.</span></h2>
        <p className="lede reveal">Language models propose; deterministic code decides. Each fit verdict, quote deviation and approval gate is checked against the brief you confirmed - and shown to you like a live shipment.</p>
        <div className="dash reveal">
          <div className="dash-main glass">
            <div className="row between wrap">
              <div className="col" style={{ gap: 2 }}>
                <span className="tiny muted">Project</span>
                <span style={{ fontFamily: "var(--display)", fontSize: 22, letterSpacing: "-.03em" }}>Bamboo desk organiser</span>
              </div>
              <div className="row"><span className="chip teal"><ShieldCheck /> Brief v3 · confirmed</span><span className="chip volt"><span className="dot live" /> Tracking</span></div>
            </div>
            <RouteBar from="Spark" to="Doorstep" value={0.78} note="Kaveri Woodcraft · make route · ETA 9-12 days" />
            <div className="big-stats">
              <BigStat n="12" of="12" label="checks met" icon={<Check size={13} color="var(--volt)" />} />
              <BigStat n="1" label="counteroffer blocked" icon={<Ban size={13} color="var(--red)" />} />
              <BigStat n="0" label="silent changes" icon={<Lock size={13} color="var(--volt)" />} />
              <BigStat n="3" label="brief versions" icon={<ShieldCheck size={13} color="var(--green)" />} />
            </div>
            <div className="decision" style={{ animation: "none" }}>
              <div className="dhead">
                <Ban size={20} color="var(--red)" />
                <div className="grow"><div className="strong">Maker proposes a 20 cm depth</div><div className="tiny muted">Breaks a must-have · MissionLock blocked this quote</div></div>
                <span className="chip red">Blocked</span>
              </div>
              <div className="dbody">
                <div className="side-by-side">
                  <div className="sbs-cell keep"><div className="k">Must stay the same</div><div className="v">18 cm max</div></div>
                  <span className="vs">VS</span>
                  <div className="sbs-cell prop"><div className="k">Proposed</div><div className="v">20 cm</div></div>
                </div>
                <div className="row small" style={{ gap: 8 }}><Check size={15} color="var(--volt)" /> You kept 18 cm - the maker revised the layout at 16 cm.</div>
              </div>
            </div>
          </div>
          <div className="dash-side">
            <div className="glass gauge-card">
              <h4>Intent integrity</h4>
              <Gauge value={1}><b>4<small>/4</small></b><span>must-haves locked</span></Gauge>
            </div>
            <div className="photo-card">
              <img src="/media/studio.jpg" alt="A maker measuring a bamboo panel at 16 cm" style={{ aspectRatio: "auto", height: "100%", minHeight: 260 }} />
              <div className="hud-float glass">
                <div className="row between"><b className="small">Revised at 16 cm</b><span className="chip volt">Kept</span></div>
                <div className="tiny muted" style={{ marginTop: 4 }}>Illustration generated with Gemini</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="home-section" id="glasses">
        <div className="split">
          <div className="photo-card reveal">
            <img src="/media/glasses-life.jpg" alt="A shopper wearing smart glasses looking at a bamboo desk organiser" />
            <div className="hud-float glass">
              <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".14em", color: "var(--volt)", marginBottom: 6 }}>MISSIONLOCK · SPOKEN</div>
              <div className="small">That one looks about 22 cm deep - over your 18 cm shelf. I can look for a slimmer maker option.</div>
            </div>
            <span className="chip muted media-tag" style={{ top: 12, bottom: "auto" }}>Illustration · Canva AI</span>
          </div>
          <div className="section reveal">
            <span className="eyebrow-pill glass"><span className="dot" /> 03 · Glasses mode</span>
            <h2 style={{ fontSize: "clamp(34px,4.4vw,60px)" }}>Glance. Ask. <span className="soft-text">Hear it back.</span></h2>
            <p className="lede">
              Spot something in a shop? Capture it with your glasses or phone and ask "something like this, but no deeper than 18 cm?". Gemini looks,
              MissionLock checks it against your brief, and the answer is spoken back - while sizes it can't see stay "Needs checking".
            </p>
            <div className="row wrap">
              <button className="btn primary" onClick={() => create(false, "From your glasses", "glasses")} disabled={!!creating}><Glasses size={16} /> Open glasses mode</button>
              <span className="chip">Ray-Ban Meta → Share → Tesselle</span>
            </div>
          </div>
        </div>
      </section>

      <section className="home-section" id="devices">
        <span className="eyebrow-pill glass reveal"><span className="dot" /> 04 · Continuity</span>
        <h2 className="reveal">Start on your Mac. <span className="soft-text">Decide on your iPhone.</span></h2>
        <p className="lede reveal">Agent Platform Sessions and Memory Bank carry one conversation across desktop, phone and glasses. The phone opens the exact pending decision, with a spoken recap.</p>
        <div className="devices reveal">
          <div className="mac">
            <div className="mac-bar"><i /><i /><i /><span>project-tesselle.web.app</span></div>
            <video ref={promo} src="/media/promo.mp4" poster="/media/desk.jpg" autoPlay muted loop playsInline aria-label="Promo: from sketch to bamboo organiser" />
          </div>
          <div className="iphone">
            <div className="scr">
              <div className="island-s" />
              <img src="/media/desk.jpg" alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "brightness(.55) blur(1px)" }} />
              <div style={{ position: "absolute", inset: "54px 12px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="glass" style={{ padding: 14, borderRadius: 24 }}>
                  <h4>Where you left off</h4>
                  <div className="small" style={{ marginTop: 6 }}>Kaveri revised the layout at 16 cm. One change needs you.</div>
                </div>
                <div className="decision amber" style={{ animation: "none", borderRadius: 24 }}>
                  <div className="dbody" style={{ padding: 14, gap: 10 }}>
                    <div className="strong small">Budget target ₹6,500 → ₹6,900</div>
                    <div className="row" style={{ gap: 6 }}><span className="btn sm primary">Keep mine</span><span className="btn sm">Accept</span></div>
                  </div>
                </div>
                <div className="glass" style={{ marginTop: "auto", height: 56, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "space-around" }}>
                  <ShieldCheck size={20} color="var(--volt)" /><Camera size={20} color="var(--muted)" /><Mic size={20} color="var(--muted)" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <span className="tiny muted reveal">Promo clip generated with Canva AI · iPhone screen is an illustration of the phone surface.</span>
      </section>

      <section className="home-section" id="stack">
        <span className="eyebrow-pill glass reveal"><span className="dot" /> 05 · Built on Google Cloud</span>
        <h2 className="reveal">Gemini agents on Vertex AI, <span className="soft-text">orchestrated with ADK.</span></h2>
        <div className="stack-grid reveal">
          {STACK.map(([k, t, d]) => (
            <div key={t} className="glass sheen stack-tile"><span className="k">{k}</span><span className="t">{t}</span><span className="d">{d}</span></div>
          ))}
        </div>
        <div className="marquee reveal"><div>{[...CHIPS, ...CHIPS].map((c, i) => <span key={i} className="chip"><ShieldCheck /> {c}</span>)}</div></div>
      </section>

      <section className="home-section" id="projects">
        <div className="row between reveal">
          <span className="eyebrow-pill glass"><span className="dot" /> 06 · Your projects</span>
          {cards && cards.length > 0 && <span className="tiny muted">Decisions first</span>}
        </div>
        {cards === null ? (
          <div className="empty"><Loader2 className="spin" /> Loading...</div>
        ) : cards.length === 0 ? (
          <div className="empty reveal">No projects on this device yet. Launch the guided demo to see the full journey in about five minutes.
            <button className="btn primary" onClick={() => create(true, "demo")} disabled={!!creating}><PlayCircle size={15} /> Launch the guided demo</button>
          </div>
        ) : (
          <div className="proj-grid">
            {cards.map((c) => (
              <div key={c.project.id} className="card proj-card" onClick={() => go(`/p/${c.project.id}`)}>
                <div className="row between">
                  <span className="strong" style={{ fontFamily: "var(--display)", fontSize: 17, letterSpacing: "-.02em" }}>{c.project.title}</span>
                  {c.brief_version ? <span className="chip muted">v{c.brief_version}</span> : null}
                </div>
                <div className="small muted clamp2">{c.last_event?.summary || "Created"}</div>
                <div className="next-card frost" style={{ padding: 13 }}>
                  <div className="k">Next</div>
                  <div className="t" style={{ fontSize: 14.5 }}>{c.next_decision.title}</div>
                </div>
                <div className="row between tiny muted"><span>{c.project.demo ? "Guided demo" : "Project"}</span><span>Updated {ago(c.project.updated_at)} <ArrowRight size={12} style={{ verticalAlign: -2 }} /></span></div>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="home-footer">
        Project Tesselle · Google Cloud AI Builder Cup 2026 · Retail &amp; Commerce<br />
        Demonstration data is fictional; no real supplier responses, payments, reservations or deliveries. Scenery generated with Gemini; promo media with Canva AI.
      </footer>
    </div>
  );
}
