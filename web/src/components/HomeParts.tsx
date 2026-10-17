import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight, Ban, Box, Camera, Car, Check, ChefHat, CircleDot, FileText, Gift, Glasses, Mail, MessageCircle, Mic, Package, PackageCheck,
  Phone, Ruler, Search, Shirt, ShoppingBag, Sparkles, Truck, Wand2, Zap, Accessibility,
} from "lucide-react";

/** Things that have to fit - far beyond furniture. Each is a real request the live app can run. */
export const HORIZONS: { key: string; label: string; icon: ReactNode; img: string; ask: string; checks: string[]; path: string }[] = [
  { key: "home", label: "Home", icon: <Ruler />, img: "/media/h/home.jpg", path: "Store or carpenter",
    ask: "A white bookshelf for the 62 cm alcove between my window and door, under ₹8,000, Mumbai 400050",
    checks: ["Width ≤ 62 cm", "White", "Delivers to 400050"] },
  { key: "fashion", label: "Tailoring", icon: <Shirt />, img: "/media/h/fashion.jpg", path: "Tailors",
    ask: "A Kanjeevaram silk blouse stitched by 12 December for my sister's wedding, size 36, Chennai 600042, under ₹4,000",
    checks: ["Size 36", "Ready by 12 Dec", "Matches the saree"] },
  { key: "electronics", label: "Electronics", icon: <Zap />, img: "/media/h/electronics.jpg", path: "Stores",
    ask: "A 65 W USB-C charger that works with my Dell XPS 13 9310, delivered to Bengaluru 560034, under ₹2,500",
    checks: ["Fits XPS 13 9310", "65 W PD", "Under ₹2,500"] },
  { key: "auto", label: "Car parts", icon: <Car />, img: "/media/h/auto.jpg", path: "Stores and fitters",
    ask: "Roof rails that fit a 2023 Hyundai Creta, fitted in Bengaluru 560076, under ₹6,000",
    checks: ["Fits Creta 2023", "Fitting included", "No drilling"] },
  { key: "celebrations", label: "Celebrations", icon: <Gift />, img: "/media/h/celebrations.jpg", path: "Stores and makers",
    ask: "40 return gifts for a 6-year-old's birthday party, under ₹150 each, delivered to Hyderabad 500081 by Saturday",
    checks: ["40 pieces", "≤ ₹150 each", "By Saturday"] },
  { key: "business", label: "Business sourcing", icon: <ShoppingBag />, img: "/media/h/business.jpg", path: "Suppliers",
    ask: "500 jute tote bags with our two-colour logo printed, delivered to Pune 411001 in 3 weeks, about ₹60 a bag",
    checks: ["500 pieces", "2-colour print", "In 3 weeks"] },
  { key: "care", label: "Care & mobility", icon: <Accessibility />, img: "/media/h/care.jpg", path: "Stores",
    ask: "A folding wheelchair under 15 kg that fits in the boot of a Maruti Swift, Pune 411038, under ₹12,000",
    checks: ["Under 15 kg", "Fits a Swift boot", "Folds flat"] },
  { key: "kitchen", label: "Kitchen", icon: <ChefHat />, img: "/media/h/kitchen.jpg", path: "Store or carpenter",
    ask: "A pull-out pantry for the 20 cm gap next to my fridge, 180 cm tall, Delhi 110017, under ₹7,000",
    checks: ["Width ≤ 20 cm", "180 cm tall", "Delivers to 110017"] },
];

type Ev = { tone: "ok" | "bad" | "info" | "run"; icon: ReactNode; text: string };
interface Run { key: string; kind: string; path: string; icon: ReactNode; said: string; facts: string[]; events: Ev[]; outcome: string; note: string }

/** Example runs for the hero console, written like real agent traces (businesses kept generic). */
const RUNS: Run[] = [
  { key: "fashion", kind: "Tailored ethnic wear", path: "Made for you", icon: <Shirt size={15} />,
    said: "I need a Kanjeevaram blouse stitched by 12 December, size 36, here in Chennai.",
    facts: ["Size 36", "Kanjeevaram silk", "By 12 Dec", "PIN 600042"],
    events: [
      { tone: "ok", icon: <FileText />, text: "Brief written · 4 must-haves" },
      { tone: "info", icon: <Search />, text: "6 tailors found near 600042" },
      { tone: "ok", icon: <MessageCircle />, text: "WhatsApp + AI call · saree photo, no phone number" },
      { tone: "bad", icon: <Ban />, text: "A tailor offered 18 Dec · blocked, you decide" },
      { tone: "ok", icon: <Package />, text: "Order placed · cash on delivery" },
    ], outcome: "₹2,400", note: "quoted · ready 9 Dec" },
  { key: "electronics", kind: "Laptop charger", path: "Ready-made", icon: <Zap size={15} />,
    said: "A 65 watt USB-C charger that actually works with my Dell XPS 13 9310.",
    facts: ["XPS 13 9310", "65 W USB-C PD", "≤ ₹2,500", "PIN 560034"],
    events: [
      { tone: "ok", icon: <FileText />, text: "Brief written · compatibility first" },
      { tone: "info", icon: <Search />, text: "14 listings read on 5 stores" },
      { tone: "bad", icon: <Ban />, text: "45 W model · doesn't fit your laptop" },
      { tone: "ok", icon: <Check />, text: "3 fit · delivered to 560034 by Tue" },
      { tone: "ok", icon: <Package />, text: "Cart filled · you confirm, COD" },
    ], outcome: "₹1,899", note: "best fit · 2-day delivery" },
  { key: "business", kind: "Printed tote bags", path: "Bulk sourcing", icon: <ShoppingBag size={15} />,
    said: "Five hundred jute bags with our logo in two colours, in Pune within three weeks.",
    facts: ["500 pcs", "Jute", "2-colour logo", "In 3 weeks"],
    events: [
      { tone: "ok", icon: <FileText />, text: "Brief written · logo attached" },
      { tone: "info", icon: <Search />, text: "5 print shops + 2 suppliers" },
      { tone: "ok", icon: <Mail />, text: "Emails + AI calls · logo, privacy-checked" },
      { tone: "bad", icon: <Ban />, text: "Supplier swapped to cotton · blocked" },
      { tone: "ok", icon: <PackageCheck />, text: "Quote chosen · ₹58 a bag" },
    ], outcome: "₹29,000", note: "for 500 · delivery in 16 days" },
  { key: "home", kind: "Bedroom furniture", path: "Store or carpenter", icon: <Ruler size={15} />,
    said: "A white bookshelf for the gap next to my window - it's 62 centimetres wide.",
    facts: ["≤ 62 cm wide", "White", "≤ ₹8,000", "PIN 400050"],
    events: [
      { tone: "ok", icon: <Camera />, text: "Photo of the alcove read by Gemini" },
      { tone: "info", icon: <Search />, text: "9 listings + 2 carpenters" },
      { tone: "bad", icon: <Ban />, text: "A 70 cm shelf · doesn't fit" },
      { tone: "ok", icon: <Sparkles />, text: "Shown in your room, with hotspots" },
      { tone: "ok", icon: <Truck />, text: "Delivered · photo matches your brief" },
    ], outcome: "₹6,450", note: "fits 60 cm · delivered" },
];

/** The hero console: a live-looking agent run that cycles through very different purchases. */
export function AgentConsole() {
  const [r, setR] = useState(0);
  const [n, setN] = useState(0);
  const run = RUNS[r];
  useEffect(() => {
    const t = setTimeout(() => {
      if (n < run.events.length + 2) setN(n + 1);
      else { setR((r + 1) % RUNS.length); setN(0); }
    }, n === 0 ? 1600 : n > run.events.length ? 2600 : 1250);
    return () => clearTimeout(t);
  }, [n, r, run.events.length]);
  const shown = run.events.slice(0, Math.min(n, run.events.length));
  const pct = Math.min(1, n / run.events.length);
  return (
    <div className="console glass" aria-label="Example agent run">
      <div className="row between">
        <span className="chip volt"><span className="dot live" /> Agent at work</span>
        <span className="tabs-mini">
          {RUNS.map((x, i) => <button key={x.key} className={i === r ? "on" : ""} onClick={() => { setR(i); setN(0); }} aria-label={x.kind}>{x.icon}</button>)}
        </span>
      </div>
      <div className="c-kind"><span className="kind-ic">{run.icon}</span><span><b>{run.kind}</b><span className="tiny muted"> · {run.path}</span></span></div>
      <div className="c-said" key={run.key}>
        <span className="c-wave" aria-hidden="true">{Array.from({ length: 14 }).map((_, i) => <i key={i} style={{ animationDelay: `${i * 0.07}s` }} />)}</span>
        <span>"{run.said}"</span>
      </div>
      <div className="c-facts">{run.facts.map((f, i) => <span key={f} className="c-fact" style={{ animationDelay: `${0.3 + i * 0.12}s` }}>{f}</span>)}</div>
      <div className="c-route"><i style={{ width: `${Math.max(6, pct * 100)}%` }} /><span>Spark</span><span>Doorstep</span></div>
      <div className="c-feed">
        {shown.map((e) => <div key={e.text} className={`ev ${e.tone}`}><span className="ic">{e.icon}</span>{e.text}</div>)}
        {n > 0 && n <= run.events.length && <div className="ev run"><span className="ic"><CircleDot /></span><span className="shimmer-text">Working…</span></div>}
      </div>
      <div className="row between c-foot">
        <div className="price"><b>{n > run.events.length ? run.outcome : "—"}</b><span className="tiny muted">{n > run.events.length ? run.note : "finding the right fit"}</span></div>
        <span className="tiny muted">Example run</span>
      </div>
    </div>
  );
}

/** The use-case gallery: one tap starts the real agent on that request. */
export function Horizons({ onTry, busy }: { onTry: (ask: string, key: string) => void; busy: string | null }) {
  return (
    <div className="horizons">
      {HORIZONS.map((h, i) => (
        <article key={h.key} className="hz reveal" style={{ transitionDelay: `${(i % 4) * 0.06}s` }}>
          <div className="hz-img"><img src={h.img} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0")} /><span className="hz-tag">{h.icon}{h.label}</span></div>
          <div className="hz-body">
            <p className="hz-ask">"{h.ask}"</p>
            <div className="hz-checks">{h.checks.map((c) => <span key={c}><Check size={11} /> {c}</span>)}</div>
            <div className="row between">
              <span className="tiny muted">{h.path}</span>
              <button className="btn sm light" onClick={() => onTry(h.ask, h.key)} disabled={!!busy}>{busy === h.key ? "Starting…" : <>Try this <ArrowRight size={13} /></>}</button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

const CHAPTERS: { key: string; title: string; caption: string; clip: string; poster: string; ui: ReactNode }[] = [
  { key: "speak", title: "Say it", caption: "Talk the way you would to a friend. Tesselle waits for you to finish, then fills in the brief.",
    clip: "/media/v/voice.mp4", poster: "/media/h/home.jpg",
    ui: <div className="r-ui r-voice"><span className="r-orb" /><div><div className="tiny muted">You</div>"A bookshelf for this gap - it's 62 cm."</div></div> },
  { key: "see", title: "Show it", caption: "Look through MetaGlass or your phone. Gemini sees the space, sizes stay 'measure to confirm'.",
    clip: "/media/v/glasses.mp4", poster: "/media/h/home.jpg",
    ui: <div className="r-ui r-hud"><span className="tiny" style={{ color: "var(--volt)" }}><Glasses size={11} /> METAGLASS · SEEING</span><div>Alcove between window and door · about 60 cm</div></div> },
  { key: "brief", title: "Kept in a brief", caption: "Your must-haves are locked. Nothing changes them without your yes.",
    clip: "/media/v/brand.mp4", poster: "/media/h/fashion.jpg",
    ui: <div className="r-ui r-brief"><b>Bookshelf · alcove</b><span><Ruler size={11} /> ≤ 62 cm</span><span>White</span><span>₹8,000</span><span>400050</span></div> },
  { key: "reach", title: "Asks the makers", caption: "WhatsApp, email or a real AI phone call - with your photos, and without your number.",
    clip: "/media/v/maker.mp4", poster: "/media/h/business.jpg",
    ui: <div className="r-ui r-msg"><span className="tiny muted"><MessageCircle size={11} /> WhatsApp · from Tesselle</span><div>Hello! Could you make a white shelf 60 cm wide? Photo attached. Delivery to 400050.</div></div> },
  { key: "call", title: "Calls for you", caption: "The call agent asks price and lead time, then writes the answer back to your brief.",
    clip: "/media/v/call.mp4", poster: "/media/h/fashion.jpg",
    ui: <div className="r-ui r-call"><span className="tiny" style={{ color: "#8fdcff" }}><Phone size={11} /> AI CALL · 1:42</span><div>"₹2,400, ready on the 9th." <Check size={12} color="var(--volt)" /> fits your date</div></div> },
  { key: "order", title: "Orders it", caption: "The checkout agent fills the cart - cash on delivery where the store offers it. You confirm.",
    clip: "/media/v/bulk.mp4", poster: "/media/h/business.jpg",
    ui: <div className="r-ui r-order"><span className="tiny muted"><Box size={11} /> Checkout agent</span><div><b>₹6,450</b> · cash on delivery · arriving Thu</div></div> },
  { key: "arrive", title: "Checks what arrives", caption: "Snap a photo at the door - Gemini compares it with your brief before you accept.",
    clip: "/media/v/delivery.mp4", poster: "/media/h/home.jpg",
    ui: <div className="r-ui r-check"><PackageCheck size={14} color="var(--volt)" /> Matches your brief · 4 of 4 must-haves</div> },
];

/** The capability reel: real-world moments, each with the part of Tesselle that does the work. */
export function Reel() {
  const [i, setI] = useState(0);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const vids = useRef<(HTMLVideoElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.3 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setI((i + 1) % CHAPTERS.length), 7000);
    vids.current.forEach((v, k) => {
      if (!v) return;
      if (k === i) { v.currentTime = 0; v.play().catch(() => {}); } else v.pause();
    });
    return () => clearTimeout(t);
  }, [i, visible]);
  const c = CHAPTERS[i];
  return (
    <div className="reel" ref={ref}>
      <div className="reel-frame">
        {CHAPTERS.map((ch, k) => (
          <video key={ch.key} ref={(el) => (vids.current[k] = el)} className={k === i ? "on" : ""} src={ch.clip} poster={ch.poster} muted playsInline loop preload="metadata"
            onError={(e) => ((e.target as HTMLVideoElement).removeAttribute("src"))} />
        ))}
        <div className="reel-shade" />
        <div className="reel-copy" key={c.key}>
          <span className="eyebrow-pill glass"><span className="dot" /> {String(i + 1).padStart(2, "0")} · {c.title}</span>
          <p>{c.caption}</p>
        </div>
        <div className="reel-ui" key={`${c.key}-ui`}>{c.ui}</div>
        <span className="chip muted reel-tag"><Wand2 /> Footage made with Google Flow · UI from the live app</span>
      </div>
      <div className="reel-chapters" role="tablist">
        {CHAPTERS.map((ch, k) => (
          <button key={ch.key} role="tab" aria-selected={k === i} className={k === i ? "on" : k < i ? "done" : ""} onClick={() => setI(k)}>
            <i><b style={{ animationDuration: k === i && visible ? "7s" : "0s" }} /></i>{ch.title}
          </button>
        ))}
      </div>
    </div>
  );
}

const STEPS: { icon: ReactNode; t: string; agent: string; tech: string }[] = [
  { icon: <Mic />, t: "Say, show, glance", agent: "Voice agent", tech: "Gemini Live" },
  { icon: <FileText />, t: "Brief", agent: "Brief agent", tech: "Gemini · ADK" },
  { icon: <Sparkles />, t: "Concept", agent: "Design agent", tech: "Gemini Image" },
  { icon: <Search />, t: "Search", agent: "Shopping agent + maker scout", tech: "Grounding with Search" },
  { icon: <MessageCircle />, t: "Reach out", agent: "Outreach + call agent", tech: "Gmail · WhatsApp · Twilio" },
  { icon: <Ban />, t: "Replies", agent: "Fit checker", tech: "Deterministic rules" },
  { icon: <Package />, t: "Order", agent: "Checkout agent", tech: "Store carts · COD" },
  { icon: <PackageCheck />, t: "Delivered", agent: "Delivery check", tech: "Gemini vision" },
];

/** The journey as a shipment tracker: every checkpoint, and which agent owns it. */
export function Journey() {
  return (
    <div className="journey glass reveal">
      <div className="j-line"><i /></div>
      {STEPS.map((s, k) => (
        <div key={s.t} className="j-step" style={{ animationDelay: `${k * 0.12}s` }}>
          <span className="j-ic">{s.icon}</span>
          <b>{s.t}</b>
          <span className="small">{s.agent}</span>
          <span className="tiny muted">{s.tech}</span>
        </div>
      ))}
    </div>
  );
}
