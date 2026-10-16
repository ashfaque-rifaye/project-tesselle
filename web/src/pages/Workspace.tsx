import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Check, HelpCircle, Loader2, RefreshCw, Smartphone, Store } from "lucide-react";
import { ago } from "../api";
import BottomPanel from "../components/BottomPanel";
import DemoGuide from "../components/DemoGuide";
import IntentCard from "../components/IntentCard";
import Island, { EdgeGlow } from "../components/Island";
import { ChangeLens, HandoffModal } from "../components/Modals";
import { Logo, Modal, useToast } from "../components/ui";
import { useGo } from "../nav";
import Accept from "../stages/Accept";
import Approve from "../stages/Approve";
import Clarify from "../stages/Clarify";
import Compare from "../stages/Compare";
import type { StageCtx } from "../stages/ctx";
import Fulfil from "../stages/Fulfil";
import Inspire from "../stages/Inspire";
import Request from "../stages/Request";
import Routes from "../stages/Routes";
import Visualise from "../stages/Visualise";
import type { Stage } from "../types";
import { useProject } from "../useProject";

export const STAGES: { key: Stage; label: string }[] = [
  { key: "inspire", label: "Inspire" },
  { key: "clarify", label: "Clarify" },
  { key: "visualise", label: "Visualise" },
  { key: "routes", label: "Explore routes" },
  { key: "request", label: "Request offers" },
  { key: "compare", label: "Compare & refine" },
  { key: "approve", label: "Approve" },
  { key: "fulfil", label: "Fulfil" },
  { key: "accept", label: "Accept & resolve" },
];

function Loading({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="glass" style={{ padding: "22px 26px", borderRadius: 28, display: "flex", flexDirection: "column", gap: 14, alignItems: "center", minWidth: 280 }}>
        <Logo />
        {children}
      </div>
    </div>
  );
}

export default function Workspace() {
  const { pid, stage } = useParams();
  const go$ = useGo();
  const toast = useToast();
  const { state, error, busy, lines, act, streamAct, remoteChange, setState, load } = useProject(pid);
  const [handoff, setHandoff] = useState(false);
  const [handedOff, setHandedOff] = useState(() => {
    try { return localStorage.getItem(`df.handoff.${pid}`) === "1"; } catch { return false; }
  });
  const [lensV, setLensV] = useState<number | null>(null);
  const [help, setHelp] = useState(false);

  const view: Stage = (stage as Stage) || state?.project.stage || "inspire";
  const reachedIdx = STAGES.findIndex((s) => s.key === (state?.project.stage || "inspire"));

  useEffect(() => {
    if (state) document.title = `${state.project.title} · Tesselle`;
  }, [state?.project.title]); // eslint-disable-line

  if (error) return <Loading><div className="small muted" style={{ textAlign: "center" }}>{error}</div><a className="btn" href="/">Back to projects</a></Loading>;
  if (!state || !pid) return <Loading><div className="row small muted"><Loader2 size={16} className="spin" color="var(--volt)" /> Opening your project...</div></Loading>;

  const go = (s: Stage) => go$(`/p/${pid}/${s}`);
  const ctx: StageCtx = { state, pid, busy, lines, act, streamAct, go };
  const b = state.briefs[state.briefs.length - 1];
  const pct = Math.round(((reachedIdx + (state.order?.delivery_check?.outcome ? 1 : 0)) / STAGES.length) * 100);
  const fill = reachedIdx / (STAGES.length - 1);

  function openHandoff() {
    setHandoff(true);
    setHandedOff(true);
    try { localStorage.setItem(`df.handoff.${pid}`, "1"); } catch { /* ignore */ }
  }

  const body = {
    inspire: <Inspire ctx={ctx} />,
    clarify: <Clarify ctx={ctx} />,
    visualise: <Visualise ctx={ctx} />,
    routes: <Routes ctx={ctx} />,
    request: <Request ctx={ctx} />,
    compare: <Compare ctx={ctx} />,
    approve: <Approve ctx={ctx} />,
    fulfil: <Fulfil ctx={ctx} />,
    accept: <Accept ctx={ctx} />,
  }[view];

  return (
    <>
      <div className="app">
        <nav className="sidebar glass" aria-label="Project stages">
          <div style={{ padding: "2px 6px" }}><Logo /></div>

          <div className="proj-pill well">
            <div className="row between">
              <span className="chip volt"><span className="dot live" /> {STAGES[reachedIdx]?.label}</span>
              <span className="mono muted" style={{ fontSize: 11 }}>{pct}%</span>
            </div>
            <div className="t">{state.project.title}</div>
            <div className="meter"><i style={{ width: `${Math.max(4, pct)}%` }} /></div>
            <div className="row between tiny muted">
              <span>{b ? `Brief v${b.version}${b.confirmed ? " · locked" : " · draft"}` : "No brief yet"}</span>
              <span>Saved {ago(state.project.updated_at)}</span>
            </div>
          </div>

          <div className="track">
            <div className="track-line"><i style={{ height: `${fill * 100}%` }} /></div>
            {STAGES.map((s, i) => {
              const reached = i <= reachedIdx;
              const done = i < reachedIdx;
              const current = i === reachedIdx;
              return (
                <button key={s.key} className={`rail-item ${view === s.key ? "active" : ""} ${done ? "done" : ""} ${current ? "current" : ""}`}
                  disabled={!reached} onClick={() => go(s.key)} aria-current={view === s.key ? "step" : undefined}>
                  <span className="rail-dot">{done ? <Check strokeWidth={3} /> : i + 1}</span>
                  <span>{s.label}</span>
                  <span className="st">{done ? "Done" : current ? "Now" : i === reachedIdx + 1 ? "Next" : ""}</span>
                </button>
              );
            })}
          </div>

          {state.briefs.length > 0 && (
            <div className="side-section">
              <h4>Brief versions</h4>
              {[...state.briefs].reverse().map((v) => (
                <button key={v.version} className="version-item" onClick={() => setLensV(v.version)}>
                  <span className="v">v{v.version}</span>
                  <span className="grow"><span className="clamp2">{v.change_summary}</span><span className="tiny muted">{ago(v.created_at)}{v.version === state.project.approved_brief_version ? " · approved" : ""}</span></span>
                </button>
              ))}
            </div>
          )}
          <div className="side-section">
            <h4>Recent activity</h4>
            {state.events.slice(0, 5).map((e) => (
              <div key={e.id} className="version-item" style={{ cursor: "default" }}>
                <span className="grow"><span className="clamp2">{e.summary}</span><span className="tiny muted">{ago(e.ts)}</span></span>
              </div>
            ))}
          </div>
        </nav>

        <div className="main">
          <header className="toolbar">
            <Island state={state} busy={busy} lines={lines} />
            {remoteChange && <span className="chip amber"><RefreshCw /> Updated on another device</span>}
            {state.project.demo && <DemoGuide state={state} onGo={go} handedOff={handedOff} />}
            <a className="btn sm ghost icon-btn hidden-sm" href="/seller/kaveri" target="_blank" rel="noreferrer" aria-label="Seller view" title="Seller view"><Store size={15} /></a>
            <button className="btn sm" onClick={openHandoff}><Smartphone size={14} /> Phone</button>
            <button className="btn sm ghost icon-btn" onClick={() => setHelp(true)} aria-label="Help"><HelpCircle size={16} /></button>
          </header>

          <main className="ws-center">
            <div className="center-inner">{body}</div>
          </main>

          <BottomPanel state={state} onState={(s) => { setState(s); load(); }} />
        </div>

        <aside className="inspector glass">
          <IntentCard state={state} onGo={go} onHandoff={openHandoff} />
        </aside>
      </div>

      <EdgeGlow on={!!busy} />
      {handoff && <HandoffModal state={state} onClose={() => setHandoff(false)} />}
      {lensV !== null && <ChangeLens briefs={state.briefs} version={lensV} onClose={() => setLensV(null)} />}
      {help && (
        <Modal onClose={() => setHelp(false)}>
          <h2 style={{ fontSize: 26 }}>How Tesselle works</h2>
          <div className="small col" style={{ gap: 10, lineHeight: 1.6 }}>
            <div><b>Left:</b> your journey, tracked stage by stage, with brief versions and activity. <b>Centre:</b> the current step. <b>Right:</b> MissionLock - what is locked and the next decision. <b>Top:</b> the live status island shows agents as they work. <b>Bottom:</b> talk to MissionLock or open the evidence trace of every agent.</div>
            <div><b>Must stay the same</b> requirements can only change with your explicit approval; seller proposals never change them silently.</div>
            <div className="muted">Everything commercial in this prototype is fictional or sandbox. AI: Gemini on Vertex AI, Google ADK agents and workflows, Agent Platform Sessions and Memory Bank, Firestore vector search.</div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={() => { setHelp(false); toast("Tip: open the Demo guide for the 10-beat story"); }}>Got it</button></div>
        </Modal>
      )}
    </>
  );
}
