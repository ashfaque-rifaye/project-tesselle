import { useEffect, useState, type ReactNode } from "react";
import {
  Archive, ArchiveRestore, ArrowRight, Glasses, Laptop, Loader2, Mic, Package, Pencil, PlayCircle, ShieldCheck, Smartphone, X,
} from "lucide-react";
import { ago, get, post } from "../api";
import HeroScene from "../components/HeroScene";
import { AgentConsole, Horizons, Journey, Reel } from "../components/HomeParts";
import { useToast } from "../components/ui";
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

const STACK = [
  ["Voice", "Gemini Live", "Native-audio voice agent that waits for you, sees through the camera and drives the app."],
  ["Model", "Gemini on Vertex AI", "Reasoning, image, audio and video understanding for every agent."],
  ["Agents", "Google ADK 2", "Specialist agents and a parallel graph Workflow."],
  ["Memory", "Agent Platform", "Sessions and Memory Bank across phone, laptop and glasses."],
  ["Search", "Grounding with Google Search", "Real listings and makers that deliver to your PIN code."],
  ["Image", "Gemini 3.1 Flash Image", "Concepts and shoppable pictures of the real products in your room."],
  ["Run", "Cloud Run + Firebase", "Streaming agent progress; scales to zero when idle."],
  ["Ops", "Cloud Trace + Logging", "Every agent step traced end to end."],
];
const CHIPS = ["Gemini Live API", "Gemini on Vertex AI", "ADK Workflow", "Agent Platform Sessions", "Memory Bank", "Grounding with Google Search",
  "Gemini Image", "Cloud Run", "Firebase Hosting", "Cloud Storage", "Firestore", "Secret Manager", "Cloud Trace", "IAM · no API keys"];

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

const ROTATE = ["a sofa that fits the door", "a blouse stitched by Friday", "a charger for your laptop", "500 bags with your logo", "roof rails for your car", "gifts for 40 kids"];

function Rotator() {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % ROTATE.length), 2400); return () => clearInterval(t); }, []);
  return <span className="rotator" aria-live="off"><span key={i}>{ROTATE[i]}</span></span>;
}

export default function Hub() {
  const go = useGo();
  const toast = useToast();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [archived, setArchived] = useState<Card[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const reload = () => get<Card[]>("/api/projects").then(setCards).catch(() => setCards([]));
  async function rename(id: string) {
    if (!newName.trim()) return setRenaming(null);
    await post(`/api/projects/${id}/edit`, { title: newName.trim() }).catch((e) => toast((e as Error).message, true));
    setRenaming(null);
    reload();
  }
  async function archive(id: string, on: boolean) {
    await post(`/api/projects/${id}/edit`, { archived: on }).catch((e) => toast((e as Error).message, true));
    reload();
    if (archived) get<Card[]>("/api/projects?archived=true").then(setArchived).catch(() => {});
    toast(on ? "Archived - restore it any time below" : "Restored");
  }
  useReveal();

  useEffect(() => {
    document.title = "Project Tesselle - one agent for everything that has to fit";
    get<Card[]>("/api/projects").then(setCards).catch(() => setCards([]));
  }, []);

  async function create(label: string, path: (id: string) => string, demo = false) {
    setCreating(label);
    try {
      const s = await post<ProjectState>("/api/projects", { demo, title: "New project" });
      go(path(s.project.id));
    } catch (e) {
      toast((e as Error).message, true);
      setCreating(null);
    }
  }
  const spin = (l: string, icon: ReactNode) => (creating === l ? <Loader2 size={16} className="spin" /> : icon);
  const talk = () => create("talk", (id) => `/p/${id}/inspire?voice=1`);
  const demo = () => create("demo", (id) => `/p/${id}/inspire?autoplay=1`, true);

  return (
    <div className="home v6">
      <Intro />

      <section className="hero">
        <div className="hero-frame">
          <div className="hero-fallback" />
          <HeroScene />
          <video className="hero-loop" src="/media/v/brand.mp4" autoPlay muted loop playsInline aria-hidden="true"
            onError={(e) => ((e.target as HTMLVideoElement).style.display = "none")} />
          <div className="gem-glow hidden-sm" />
          <div className="mist" />
          <div className="hero-shade" />
          <div className="hero-rim" />

          <nav className="hero-nav">
            <a href="/" className="brand" aria-label="Project Tesselle home">
              <img className="mark" src="/favicon.svg" alt="" />
              <span className="col" style={{ gap: 0 }}><span className="name">Tesselle</span><span className="sub">Your shopping agent</span></span>
            </a>
            <div className="links glass">
              <a href="#horizons">What it finds</a><a href="#reel">See it work</a><a href="#how">How it works</a><a href="#devices">Devices</a><a href="#stack">Google stack</a>
            </div>
            <button className="btn sm light" onClick={demo} disabled={!!creating}>{spin("demo", <PlayCircle size={14} />)} Guided demo</button>
          </nav>

          <div className="hero-copy">
            <span className="eyebrow-pill glass"><span className="dot" /> Voice-first shopping agent · India</span>
            <h1>
              <span><Words text="One agent for" delay={FIRST_VISIT ? 1.9 : 0.15} /></span>
              <span className="l2"><Words text="everything that" delay={FIRST_VISIT ? 2.1 : 0.35} /></span>
              <span><Words text="has to fit." delay={FIRST_VISIT ? 2.3 : 0.55} /></span>
            </h1>
            <div className="hero-rot">Ask for <Rotator /></div>
          </div>

          <div className="hero-bottom">
            <p>
              Say it, show it, or look at it through your glasses. Tesselle writes the brief, searches real stores, messages and calls real makers,
              orders it - cash on delivery where offered - and checks what arrives. Your must-haves never change without your yes.
            </p>
            <div className="cta">
              <button className="btn primary lg" onClick={talk} disabled={!!creating}>{spin("talk", <Mic size={17} />)} Start talking</button>
              <button className="btn lg" onClick={demo} disabled={!!creating}>{spin("demo", <PlayCircle size={16} />)} Watch it run</button>
              <button className="btn lg ghost" onClick={() => create("glasses", (id) => `/g/${id}`)} disabled={!!creating}>{spin("glasses", <Glasses size={17} />)} MetaGlass mode</button>
            </div>
            <div className="tiny muted">No sign-up · real stores and makers, found live · works on phone, laptop and glasses together</div>
          </div>

          <AgentConsole />
        </div>
      </section>

      <section className="home-section" id="horizons">
        <span className="eyebrow-pill glass reveal"><span className="dot" /> 01 · What it finds</span>
        <h2 className="reveal">Not just furniture. <span className="soft-text">Anything with a size, a model, a date or a quantity.</span></h2>
        <p className="lede reveal">Each card is a real request. Tap "Try this" and the live agents start on it - the brief, the right questions and the steps shape themselves to what you're buying.</p>
        <Horizons busy={creating} onTry={(ask, key) => create(key, (id) => `/p/${id}/inspire?q=${encodeURIComponent(ask)}`)} />
      </section>

      <section className="home-section" id="reel">
        <span className="eyebrow-pill glass reveal"><span className="dot" /> 02 · See it work</span>
        <h2 className="reveal">From a sentence <span className="soft-text">to something at your door that fits.</span></h2>
        <Reel />
      </section>

      <section className="home-section" id="how">
        <span className="eyebrow-pill glass reveal"><span className="dot" /> 03 · How it works</span>
        <h2 className="reveal">Tracked like a shipment, <span className="soft-text">from spark to doorstep.</span></h2>
        <p className="lede reveal">Language models propose; deterministic code decides. Every checkpoint has an owner, and a seller's change to a must-have stops until you decide.</p>
        <Journey />
      </section>

      <section className="home-section" id="devices">
        <span className="eyebrow-pill glass reveal"><span className="dot" /> 04 · Phone, laptop, MetaGlass</span>
        <h2 className="reveal">One project, <span className="soft-text">mirrored on every screen.</span></h2>
        <div className="dev-grid reveal">
          {[
            { ic: <Laptop />, t: "Laptop", d: "The full workspace. Scan a QR code when Tesselle asks for a photo - your phone's camera opens on the same project." },
            { ic: <Smartphone />, t: "Phone", d: "Scroll, tap or talk - the laptop follows along live, loading states included. Close it and pick up exactly where you left off." },
            { ic: <Glasses />, t: "MetaGlass", d: "Look and talk. The voice agent sees what you see, answers in your ear and saves the view to your project. Simulated with your phone camera." },
          ].map((c) => (
            <div key={c.t} className="glass sheen dev-card"><span className="ic">{c.ic}</span><b>{c.t}</b><span className="small muted">{c.d}</span></div>
          ))}
        </div>
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
          <span className="row" style={{ gap: 8 }}>
            <a className="btn sm" href="/orders"><Package size={14} /> Order history</a>
            <button className="btn sm ghost" onClick={() => get<Card[]>("/api/projects?archived=true").then(setArchived).catch(() => setArchived([]))}><Archive size={14} /> Archived</button>
          </span>
        </div>
        {cards === null ? (
          <div className="empty"><Loader2 className="spin" /> Loading...</div>
        ) : cards.length === 0 ? (
          <div className="empty reveal">No projects on this device yet. Launch the guided demo to see the full journey in about five minutes.
            <button className="btn primary" onClick={demo} disabled={!!creating}><PlayCircle size={15} /> Launch the guided demo</button>
          </div>
        ) : (
          <div className="proj-grid">
            {cards.map((c) => (
              <div key={c.project.id} className="card proj-card" onClick={() => renaming !== c.project.id && go(`/p/${c.project.id}`)}>
                <div className="row between" style={{ gap: 6 }}>
                  {renaming === c.project.id ? (
                    <input className="input sm" autoFocus value={newName} onClick={(e) => e.stopPropagation()} onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && rename(c.project.id)} onBlur={() => rename(c.project.id)} />
                  ) : <span className="strong" style={{ fontFamily: "var(--display)", fontSize: 17, letterSpacing: "-.02em" }}>{c.project.title}</span>}
                  <span className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
                    {c.brief_version ? <span className="chip muted">v{c.brief_version}</span> : null}
                    <button className="btn sm ghost icon-btn" title="Rename" aria-label="Rename project" onClick={() => { setRenaming(c.project.id); setNewName(c.project.title); }}><Pencil size={13} /></button>
                    <button className="btn sm ghost icon-btn" title="Archive" aria-label="Archive project" onClick={() => archive(c.project.id, true)}><Archive size={13} /></button>
                  </span>
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

      {archived && (
        <section className="home-section">
          <div className="row between"><span className="eyebrow-pill glass"><span className="dot" /> Archived</span><button className="btn sm ghost" onClick={() => setArchived(null)}><X size={14} /> Hide</button></div>
          {!archived.length ? <div className="small muted">Nothing archived.</div> : (
            <div className="proj-grid">
              {archived.map((c) => (
                <div key={c.project.id} className="card proj-card">
                  <span className="strong">{c.project.title}</span>
                  <div className="small muted clamp2">{c.last_event?.summary}</div>
                  <button className="btn sm" onClick={() => archive(c.project.id, false)}><ArchiveRestore size={14} /> Restore</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <footer className="home-footer">
        Project Tesselle · Google Cloud AI Builder Cup 2026 · Retail &amp; Commerce<br />
        Listings and makers come from live web search. Tesselle prepares orders and messages; you confirm every order and payment. Footage and photos made with Google Flow; scenery with Gemini.
      </footer>
    </div>
  );
}
