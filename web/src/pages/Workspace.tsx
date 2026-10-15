import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Check, HelpCircle, Loader2, RefreshCw, Save, Smartphone, Store } from "lucide-react";
import { ago } from "../api";
import BottomPanel from "../components/BottomPanel";
import DemoGuide from "../components/DemoGuide";
import IntentCard from "../components/IntentCard";
import { ChangeLens, HandoffModal } from "../components/Modals";
import { Logo, Modal, useToast } from "../components/ui";
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

const STAGES: { key: Stage; label: string }[] = [
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

export default function Workspace() {
  const { pid, stage } = useParams();
  const nav = useNavigate();
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

  if (error) return <div className="hub"><Logo /><div className="empty">{error}<a className="btn" href="/">Back to projects</a></div></div>;
  if (!state || !pid) return <div className="hub"><Logo /><div className="empty"><Loader2 className="spin" /> Opening your project...</div></div>;

  const go = (s: Stage) => nav(`/p/${pid}/${s}`);
  const ctx: StageCtx = { state, pid, busy, lines, act, streamAct, go };
  const b = state.briefs[state.briefs.length - 1];

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
      <header className="topbar">
        <Logo small />
        <span className="sep hidden-sm" />
        <span className="project-name hidden-sm">{state.project.title}</span>
        {b && <span className="chip muted hidden-sm">Brief v{b.version}</span>}
        <span className="chip teal hidden-sm">{STAGES.find((s) => s.key === state.project.stage)?.label}</span>
        {remoteChange && <span className="chip amber"><RefreshCw /> Updated on another device</span>}
        <div className="grow" />
        <span className="tiny muted hidden-sm"><Save size={12} style={{ verticalAlign: -2 }} /> Saved {ago(state.project.updated_at)}</span>
        {state.project.demo && <DemoGuide state={state} onGo={go} handedOff={handedOff} />}
        <a className="btn sm ghost hidden-sm" href="/seller/kaveri" target="_blank" rel="noreferrer"><Store size={14} /> Seller view</a>
        <button className="btn sm" onClick={openHandoff}><Smartphone size={14} /> Phone</button>
        <button className="btn sm ghost icon-btn" onClick={() => setHelp(true)} aria-label="Help"><HelpCircle size={16} /></button>
      </header>

      <div className="ws">
        <nav className="ws-left" aria-label="Project stages">
          <div className="rail">
            {STAGES.map((s, i) => {
              const reached = i <= reachedIdx;
              const done = i < reachedIdx;
              return (
                <button key={s.key} className={`rail-item ${view === s.key ? "active" : ""} ${done ? "done" : ""} ${i === reachedIdx ? "current" : ""}`}
                  disabled={!reached} onClick={() => go(s.key)}>
                  <span className="rail-dot">{done ? <Check /> : i + 1}</span>
                  {s.label}
                </button>
              );
            })}
          </div>
          {state.briefs.length > 0 && (
            <div className="left-section">
              <h4>Brief versions</h4>
              {[...state.briefs].reverse().map((v) => (
                <button key={v.version} className="version-item" onClick={() => setLensV(v.version)}>
                  <span className="v">v{v.version}</span>
                  <span className="grow">{v.change_summary}<div className="tiny muted">{ago(v.created_at)}{v.version === state.project.approved_brief_version ? " · approved" : ""}</div></span>
                </button>
              ))}
            </div>
          )}
          <div className="left-section">
            <h4>Recent activity</h4>
            {state.events.slice(0, 6).map((e) => (
              <div key={e.id} className="version-item" style={{ cursor: "default" }}>
                <span className="grow"><span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{e.summary}</span><div className="tiny muted">{ago(e.ts)}</div></span>
              </div>
            ))}
          </div>
        </nav>

        <main className="ws-center">
          <div className="center-inner">{body}</div>
        </main>

        <div className="ws-right">
          <IntentCard state={state} onGo={go} onHandoff={openHandoff} />
        </div>

        <div className="ws-bottom">
          <BottomPanel state={state} onState={(s) => { setState(s); load(); }} />
        </div>
      </div>

      {handoff && <HandoffModal state={state} onClose={() => setHandoff(false)} />}
      {lensV !== null && <ChangeLens briefs={state.briefs} version={lensV} onClose={() => setLensV(null)} />}
      {help && (
        <Modal onClose={() => setHelp(false)}>
          <h2 style={{ fontSize: 22 }}>How Tesselle works</h2>
          <div className="small col">
            <div><b>Left:</b> stages, brief versions and activity. <b>Centre:</b> the current step. <b>Right:</b> your MissionLock brief and the next decision. <b>Bottom:</b> talk to MissionLock, or inspect the evidence trace of every agent.</div>
            <div><b>Must stay the same</b> requirements can only change with your explicit approval; seller proposals never change them silently.</div>
            <div>Everything commercial in this prototype is fictional or sandbox. AI: Gemini on Vertex AI, Google ADK agents and workflows, Agent Platform Sessions and Memory Bank, Firestore vector search.</div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={() => { setHelp(false); toast("Tip: open the Demo guide for the 10-beat story"); }}>Got it</button></div>
        </Modal>
      )}
    </>
  );
}
