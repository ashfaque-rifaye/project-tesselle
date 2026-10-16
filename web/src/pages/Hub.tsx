import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, Ban, Camera, CheckCircle2, Glasses, ImagePlus, Loader2, Mic, PlayCircle, ShieldCheck, Sparkles, Store,
} from "lucide-react";
import { ago, get, media, post } from "../api";
import TessellationField from "../components/TessellationField";
import { Logo, useToast } from "../components/ui";
import type { NextDecision, Project, ProjectState } from "../types";

interface Card { project: Project; next_decision: NextDecision; brief_version: number; last_event?: { summary: string; ts: string } | null }

const STACK = [
  "Gemini 3.8 Flash", "Gemini image generation", "Gemini video + vision", "Gemini embeddings", "Gemini TTS",
  "Google ADK 2 · agents + graph Workflow", "Agent Platform Sessions", "Agent Platform Memory Bank",
  "Cloud Run", "Firestore + vector search", "Cloud Storage", "Firebase Hosting", "Cloud Build", "Artifact Registry", "Cloud Logging & Trace",
];

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.15 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  });
}

export default function Hub() {
  const nav = useNavigate();
  const toast = useToast();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [hasPromo, setHasPromo] = useState(false);
  const promo = useRef<HTMLVideoElement>(null);
  useReveal();

  useEffect(() => {
    document.title = "Project Tesselle - imagine it, keep what matters, get it made";
    get<Card[]>("/api/projects").then(setCards).catch(() => setCards([]));
    fetch("/media/promo.mp4", { method: "HEAD" }).then((r) => setHasPromo(r.ok && (r.headers.get("content-type") || "").includes("video"))).catch(() => {});
  }, []);

  async function create(demo: boolean, label: string, next: string = "inspire") {
    setCreating(label);
    try {
      const s = await post<ProjectState>("/api/projects", { demo, title: "New project" });
      nav(next === "glasses" ? `/g/${s.project.id}` : `/p/${s.project.id}/inspire${next !== "inspire" ? `?mode=${next}` : ""}`);
    } catch (e) {
      toast((e as Error).message, true);
      setCreating(null);
    }
  }

  return (
    <div className="home">
      <TessellationField />
      <nav className="home-nav">
        <Logo />
        <div className="grow" />
        <a className="btn sm ghost hidden-sm" href="/seller/kaveri"><Store size={14} /> Seller workspace</a>
        <button className="btn sm primary" onClick={() => create(true, "demo")} disabled={!!creating}>
          {creating === "demo" ? <Loader2 size={14} className="spin" /> : <PlayCircle size={14} />} Guided demo
        </button>
      </nav>

      <section className="home-hero">
        <div className="kicker"><span className="dot" /> Project Tesselle · personal commerce agent</div>
        <h1>
          Imagine it.<br />Keep what matters.<br /><span className="grad-text">Get it made.</span>
        </h1>
        <p className="lede">
          Show Tesselle a photo, a voice note or what your smart glasses just saw. It turns that spark into a clear brief, checks what can
          really be bought, sourced or made - and <b>MissionLock</b> makes sure no seller, substitute or shortcut quietly changes what you asked for.
        </p>
        <div className="hero-cta">
          <button className="btn primary lg" onClick={() => create(true, "demo")} disabled={!!creating}>
            {creating === "demo" ? <Loader2 size={17} className="spin" /> : <PlayCircle size={17} />} Launch the guided demo
          </button>
          <button className="btn lg" onClick={() => create(false, "new")} disabled={!!creating}>
            {creating === "new" ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} Start my own project
          </button>
          <button className="btn lg ghost" onClick={() => create(false, "glasses", "glasses")} disabled={!!creating}>
            <Glasses size={17} /> Glasses mode
          </button>
        </div>
        <div className="hero-meta">No sign-up · demo sellers are fictional · orders are sandbox - nothing is bought</div>
        <div className="hero-stats">
          <div><b className="grad-text">9</b><span>specialist agents</span></div>
          <div><b className="grad-text">4</b><span>fulfilment routes</span></div>
          <div><b className="grad-text">5</b><span>ways to capture</span></div>
          <div><b className="grad-text">0</b><span>silent changes</span></div>
        </div>
      </section>

      <section className="home-section">
        <div className="reveal"><div className="eyebrow">01 · Capture anything</div></div>
        <h2 className="reveal">Start from whatever you have - <span className="grad-text">words, a glance, a frame of video.</span></h2>
        <div className="capture-grid reveal">
          {[
            { ic: <Mic />, t: "Speak it", d: "A voice note in your own words. Gemini hears what must not change.", go: () => create(false, "Speak it", "describe") },
            { ic: <Camera />, t: "Capture your space", d: "Live camera. Sizes from a photo stay 'Needs checking' until you measure.", go: () => create(false, "Capture your space", "space") },
            { ic: <ImagePlus />, t: "Show an inspiration", d: "A photo, screenshot or a short video clip of something you love.", go: () => create(false, "Show an inspiration", "inspiration") },
            { ic: <Sparkles />, t: "Imagine it", d: "Describe it and Gemini renders it - clearly labelled as a concept.", go: () => create(false, "Imagine it", "imagine") },
            { ic: <Glasses />, t: "From your glasses", d: "Share a Ray-Ban Meta photo or clip to Tesselle, or open the heads-up capture view.", go: () => create(false, "From your glasses", "glasses") },
          ].map((c) => (
            <button key={c.t} className="card capture-card" onClick={c.go} disabled={!!creating}>
              <span className="ic">{creating && creating === c.t ? <Loader2 className="spin" /> : c.ic}</span>
              <span className="t">{c.t}</span>
              <span className="d">{c.d}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-section">
        <div className="lock-demo">
          <div className="holo reveal">
            <img src="/media/glasses-life.jpg" alt="A shopper wearing smart glasses scanning a bamboo desk organiser" />
            <span className="tag chip violet">Illustration · generated with Canva AI</span>
          </div>
          <div className="section reveal">
            <div className="eyebrow">Glasses mode</div>
            <h2>Glance. Ask. <span className="grad-text">Hear it back.</span></h2>
            <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, maxWidth: 520 }}>
              Spot something in a shop? Capture it with your glasses or phone and ask "something like this, but no deeper than 18 cm?".
              Gemini looks, MissionLock checks it against your brief, and the answer is spoken back - while sizes it can't see stay "Needs checking".
            </p>
            <div className="row wrap">
              <button className="btn primary" onClick={() => create(false, "From your glasses", "glasses")} disabled={!!creating}><Glasses size={16} /> Open glasses mode</button>
              <span className="chip">Ray-Ban Meta → Share → Tesselle</span>
            </div>
          </div>
        </div>
      </section>

      <section className="home-section">
        <div className="reveal"><div className="eyebrow">02 · One journey, one brief</div></div>
        <h2 className="reveal">From spark to doorstep without losing <span className="grad-text">the requirements that mattered.</span></h2>
        <div className="journey reveal">
          {[
            ["Inspire", "Multimodal intake turns your spark into a versioned brief."],
            ["Lock intent", "You confirm what must stay the same. MissionLock guards it."],
            ["Explore routes", "Buy, source, customise or make - checked requirement by requirement."],
            ["Negotiate", "Makers quote; every proposed change becomes your decision."],
            ["Approve & verify", "Exact spec, sandbox order, delivery checked against the brief."],
          ].map(([t, d], i) => (
            <div key={t} className="jstep">
              <div className="n"><span>0{i + 1}</span></div>
              <div className="t">{t}</div>
              <div className="d">{d}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="home-section">
        <div className="lock-demo">
          <div className="section reveal">
            <div className="eyebrow">03 · MissionLock</div>
            <h2>A seller can propose. <span className="grad-text">Only you can change your mind.</span></h2>
            <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, maxWidth: 520 }}>
              Language models propose; deterministic code decides. Every fit verdict, quote deviation and approval gate is checked against the
              brief you confirmed - so a 22 cm beauty never sneaks past your 18 cm shelf.
            </p>
            <div className="card raised" style={{ overflow: "hidden", maxWidth: 520 }}>
              <div className="row" style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
                <Ban size={18} color="var(--red)" /><b className="small grow">Maker proposes 20 cm depth</b><span className="chip red">Blocked</span>
              </div>
              <div className="side-by-side" style={{ padding: 14 }}>
                <div className="sbs-cell keep"><div className="k">Must stay the same</div><div className="v">18 cm max</div></div>
                <div className="sbs-cell prop"><div className="k">Proposed</div><div className="v">20 cm</div></div>
              </div>
              <div className="row small" style={{ padding: "0 14px 14px", gap: 8 }}><CheckCircle2 size={15} color="var(--teal)" /> Kept 18 cm → maker revised the layout at 16 cm</div>
            </div>
          </div>
          <div className="holo reveal">
            {hasPromo ? (
              <video ref={promo} src="/media/promo.mp4" autoPlay muted loop playsInline />
            ) : (
              <img src={media("catalog/kaveri-make-new.png")} alt="A maker's bench with a bamboo organiser in progress" />
            )}
            <span className="tag chip violet">{hasPromo ? "Promo · generated with Canva AI" : "Illustration · generated with Gemini"}</span>
          </div>
        </div>
      </section>

      <section className="home-section">
        <div className="reveal"><div className="eyebrow">04 · Built on Google Cloud</div></div>
        <h2 className="reveal">Gemini agents on Vertex AI, <span className="grad-text">orchestrated with ADK.</span></h2>
        <div className="stack-wall reveal">{STACK.map((s) => <span key={s} className="chip"><ShieldCheck /> {s}</span>)}</div>
      </section>

      <section className="home-section" id="projects">
        <div className="row between reveal"><div className="eyebrow">05 · Your projects</div>{cards && cards.length > 0 && <span className="tiny muted">Decisions first</span>}</div>
        {cards === null ? (
          <div className="empty"><Loader2 className="spin" /> Loading...</div>
        ) : cards.length === 0 ? (
          <div className="empty reveal">No projects on this device yet. Launch the guided demo to see the full journey in about five minutes.
            <button className="btn primary" onClick={() => create(true, "demo")} disabled={!!creating}><PlayCircle size={15} /> Launch the guided demo</button>
          </div>
        ) : (
          <div className="proj-grid">
            {cards.map((c) => (
              <div key={c.project.id} className="card proj-card" onClick={() => nav(`/p/${c.project.id}`)}>
                <div className="row between">
                  <span className="strong">{c.project.title}</span>
                  {c.brief_version ? <span className="chip muted">v{c.brief_version}</span> : null}
                </div>
                <div className="small"><span className="muted">What changed:</span> {c.last_event?.summary || "Created"}</div>
                <div className="next-card" style={{ padding: 11 }}>
                  <div className="k">Next</div>
                  <div className="t" style={{ fontSize: 14 }}>{c.next_decision.title}</div>
                  <div className="d">{c.next_decision.detail}</div>
                </div>
                <div className="row between tiny muted"><span>{c.project.demo ? "Guided demo" : "Project"}</span><span>Updated {ago(c.project.updated_at)} <ArrowRight size={12} style={{ verticalAlign: -2 }} /></span></div>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="home-footer">
        Project Tesselle · Google Cloud AI Builder Cup 2026 · Retail &amp; Commerce. Demonstration data is fictional; no real supplier responses, payments, reservations or deliveries.
      </footer>
    </div>
  );
}
