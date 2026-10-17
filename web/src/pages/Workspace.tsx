import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Activity, Check, HelpCircle, Loader2, PanelLeftClose, PanelLeftOpen, PlayCircle, RefreshCw, Smartphone } from "lucide-react";
import { ago } from "../api";
import ActivityDrawer from "../components/ActivityDrawer";
import Assistant from "../components/Assistant";
import BriefPanel from "../components/BriefPanel";
import Island, { EdgeGlow } from "../components/Island";
import { ChangeLens, HandoffModal } from "../components/Modals";
import NextBar from "../components/NextBar";
import Pilot from "../components/Pilot";
import { Logo, Modal } from "../components/ui";
import { useGo } from "../nav";
import Accept from "../stages/Accept";
import Approve from "../stages/Approve";
import Clarify from "../stages/Clarify";
import Compare from "../stages/Compare";
import { STAGE_LABEL, type Primary, type StageCtx } from "../stages/ctx";
import Fulfil from "../stages/Fulfil";
import Inspire from "../stages/Inspire";
import Request from "../stages/Request";
import Routes from "../stages/Routes";
import Visualise from "../stages/Visualise";
import type { Line, Stage } from "../types";
import { useProject } from "../useProject";

export const STAGES: Stage[] = ["inspire", "clarify", "visualise", "routes", "request", "compare", "approve", "fulfil", "accept"];

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
  const [params, setParams] = useSearchParams();
  const go$ = useGo();
  const { state, error, busy, lines, act, streamAct, remoteChange, setState, load } = useProject(pid);
  const [handoff, setHandoff] = useState(false);
  const [lensV, setLensV] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [activity, setActivity] = useState(false);
  const [rail, setRail] = useState(() => { try { return localStorage.getItem("tsl.rail") === "1"; } catch { return false; } });
  const [primary, setPrimaryState] = useState<Omit<Primary, "onClick"> | null>(null);
  const primaryClick = useRef<(() => void) | null>(null);
  const [asstLine, setAsstLine] = useState<Line | null>(null);
  const [pilot, setPilot] = useState(false);

  const setPrimary = useCallback((p: Primary | null) => {
    primaryClick.current = p?.onClick || null;
    setPrimaryState((prev) => {
      if (!p) return prev ? null : prev;
      if (prev && prev.label === p.label && prev.disabled === p.disabled && prev.hint === p.hint) return prev;
      return { label: p.label, disabled: p.disabled, icon: p.icon, hint: p.hint };
    });
  }, []);

  const view: Stage = (stage as Stage) || state?.project.stage || "inspire";
  const reachedIdx = STAGES.indexOf(state?.project.stage || "inspire");

  useEffect(() => { if (state) document.title = `${state.project.title} · Tesselle`; }, [state?.project.title]); // eslint-disable-line
  useEffect(() => { try { localStorage.setItem("tsl.rail", rail ? "1" : "0"); } catch { /* ignore */ } }, [rail]);
  useEffect(() => {
    if (state && params.get("autoplay") === "1" && state.project.demo) {
      setPilot(true);
      params.delete("autoplay");
      setParams(params, { replace: true });
    }
  }, [state?.project.id]); // eslint-disable-line
  useEffect(() => {
    const h = () => setActivity(true);
    const p = () => setPilot(true);
    window.addEventListener("tsl:activity", h);
    window.addEventListener("tsl:pilot", p);
    return () => { window.removeEventListener("tsl:activity", h); window.removeEventListener("tsl:pilot", p); };
  }, []);

  if (error) return <Loading><div className="small muted" style={{ textAlign: "center" }}>{error}</div><a className="btn" href="/">Back to projects</a></Loading>;
  if (!state || !pid) return <Loading><div className="row small muted"><Loader2 size={16} className="spin" color="var(--volt)" /> Opening your project...</div></Loading>;

  const go = (s: Stage, query = "") => go$(`/p/${pid}/${s}${query ? `?${query}` : ""}`);
  const ctx: StageCtx = { state, pid, busy, lines, act, streamAct, go, setPrimary, params };
  const pct = Math.round(((reachedIdx + (state.order?.delivery_check?.outcome ? 1 : 0)) / STAGES.length) * 100);
  const fill = reachedIdx / (STAGES.length - 1);
  const islandBusy = busy || (asstLine ? "Assistant" : null);
  const islandLines = asstLine && !busy ? [asstLine] : lines;

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
      <div className={`app ${rail ? "rail-open" : "rail-closed"}`}>
        <nav className="sidebar glass" aria-label="Steps">
          <div className="side-top">{rail ? <Logo /> : <Logo small />}</div>
          {rail && (
            <div className="proj-pill well">
              <div className="row between">
                <span className="chip volt"><span className="dot live" /> {STAGE_LABEL[STAGES[reachedIdx]]}</span>
                <span className="mono muted" style={{ fontSize: 11 }}>{pct}%</span>
              </div>
              <div className="t">{state.project.title}</div>
              <div className="meter"><i style={{ width: `${Math.max(4, pct)}%` }} /></div>
              <div className="tiny muted">Saved {ago(state.project.updated_at)}</div>
            </div>
          )}
          <div className="track">
            <div className="track-line"><i style={{ height: `${fill * 100}%` }} /></div>
            {STAGES.map((s, i) => {
              const done = i < reachedIdx;
              const current = i === reachedIdx;
              return (
                <button key={s} className={`rail-item ${view === s ? "active" : ""} ${done ? "done" : ""} ${current ? "current" : ""}`}
                  disabled={i > reachedIdx} onClick={() => go(s)} aria-current={view === s ? "step" : undefined} title={STAGE_LABEL[s]}>
                  <span className="rail-dot">{done ? <Check strokeWidth={3} /> : i + 1}</span>
                  {rail && <span>{STAGE_LABEL[s]}</span>}
                  {rail && <span className="st">{done ? "Done" : current ? "Now" : ""}</span>}
                </button>
              );
            })}
          </div>
          {rail && state.briefs.length > 1 && (
            <div className="side-section">
              <h4>Brief versions</h4>
              {[...state.briefs].reverse().map((v) => (
                <button key={v.version} className="version-item" onClick={() => setLensV(v.version)}>
                  <span className="v">v{v.version}</span>
                  <span className="grow"><span className="clamp2">{v.change_summary}</span><span className="tiny muted">{ago(v.created_at)}</span></span>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="main">
          <header className="toolbar">
            <button className="btn sm ghost icon-btn" onClick={() => setRail(!rail)} aria-label={rail ? "Hide steps" : "Show steps"} title={rail ? "Hide steps" : "Show steps"}>
              {rail ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            </button>
            <Island state={state} busy={islandBusy} lines={islandLines} />
            {remoteChange && <span className="chip amber"><RefreshCw /> Updated on your phone</span>}
            {state.project.demo && !pilot && (
              <button className="btn sm light" onClick={() => setPilot(true)} data-pilot="watch"><PlayCircle size={15} /> Watch it run</button>
            )}
            <button className="btn sm ghost icon-btn" onClick={() => setHandoff(true)} aria-label="Continue on my phone" title="Continue on my phone"><Smartphone size={16} /></button>
            <button className="round-ic" onClick={() => setActivity(true)} aria-label={`Activity: ${state.events.length} steps`} title="Activity">
              <Activity size={16} /><span className="badge">{state.events.length}</span>
            </button>
            <button className="btn sm ghost icon-btn" onClick={() => setHelp(true)} aria-label="Help"><HelpCircle size={16} /></button>
          </header>

          <main className="ws-center">
            <div className="center-inner">{body}</div>
          </main>

          <NextBar nd={state.next_decision} view={view} primary={primary} onPrimary={() => primaryClick.current?.()} busy={busy}
            go={(s) => go(s)} onPhone={() => setHandoff(true)} />
        </div>

        <aside className="inspector glass" data-pilot="brief-panel">
          <BriefPanel ctx={ctx} />
        </aside>
      </div>

      <Assistant pid={pid} view={view} onState={(s) => { setState(s); load(); }} onNavigate={(s) => go(s)} onBusy={setAsstLine} />
      <EdgeGlow on={!!islandBusy} />
      {pilot && <Pilot go={(s) => go(s)} onEnd={() => setPilot(false)} openActivity={() => setActivity(true)} />}
      {activity && <ActivityDrawer events={state.events} onClose={() => setActivity(false)} />}
      {handoff && <HandoffModal state={state} onClose={() => setHandoff(false)} />}
      {lensV !== null && <ChangeLens briefs={state.briefs} version={lensV} onClose={() => setLensV(null)} />}
      {help && (
        <Modal onClose={() => setHelp(false)}>
          <h2 style={{ fontSize: 26 }}>How Tesselle works</h2>
          <div className="small col" style={{ gap: 10, lineHeight: 1.6 }}>
            <div><b>Bottom bar:</b> the one next step - always visible. <b>Right:</b> your brief - change anything, any time. <b>Top:</b> what the Gemini agents are doing right now. <b>Bottom-right:</b> the assistant - tap and talk.</div>
            <div><b>Must-haves</b> are kept unless you agree to change them. A seller can propose; only you decide.</div>
            <div className="muted">Results come from real stores and makers found live on the web. Tesselle never pays, orders or sends messages for you.</div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={() => setHelp(false)}>Got it</button></div>
        </Modal>
      )}
    </>
  );
}
