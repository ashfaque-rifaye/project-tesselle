import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Activity, Check, HelpCircle, Link2, Loader2, Lock, PanelLeftClose, PanelLeftOpen, PlayCircle, RefreshCw, Smartphone } from "lucide-react";
import { ago, deviceId, post } from "../api";
import ActivityDrawer from "../components/ActivityDrawer";
import BriefPanel from "../components/BriefPanel";
import Island, { EdgeGlow } from "../components/Island";
import { ChangeLens, HandoffModal } from "../components/Modals";
import NextBar from "../components/NextBar";
import Pilot from "../components/Pilot";
import ProjectMenu from "../components/ProjectMenu";
import VoiceOrb from "../components/VoiceOrb";
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
import { ORDER, buildSteps, prevStep, type StepInfo } from "../steps";
import type { Line, Stage } from "../types";
import { useProject } from "../useProject";

export const STAGES: Stage[] = ORDER;

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

const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

export default function Workspace() {
  const { pid, stage } = useParams();
  const [params, setParams] = useSearchParams();
  const go$ = useGo();
  const { state, error, busy, lines, act, streamAct, remoteChange, remote, setState, load } = useProject(pid);
  const [handoff, setHandoff] = useState(false);
  const [lensV, setLensV] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [activity, setActivity] = useState(false);
  const [rail, setRail] = useState(() => { try { return localStorage.getItem("tsl.rail") === "1"; } catch { return false; } });
  const [primary, setPrimaryState] = useState<Omit<Primary, "onClick"> | null>(null);
  const primaryClick = useRef<(() => void) | null>(null);
  const [asstLine, setAsstLine] = useState<Line | null>(null);
  const [pilot, setPilot] = useState(false);
  const [tip, setTip] = useState<StepInfo | null>(null);
  const [follow, setFollow] = useState(() => {
    if (params.get("follow") === "1") return true;
    try { const v = localStorage.getItem("tsl.follow"); return v === null ? isPhone() : v === "1"; } catch { return isPhone(); }
  });
  const lastNav = useRef<string>(new Date().toISOString());

  const setPrimary = useCallback((p: Primary | null) => {
    primaryClick.current = p?.onClick || null;
    setPrimaryState((prev) => {
      if (!p) return prev ? null : prev;
      if (prev && prev.label === p.label && prev.disabled === p.disabled && prev.hint === p.hint) return prev;
      return { label: p.label, disabled: p.disabled, icon: p.icon, hint: p.hint };
    });
  }, []);

  const view: Stage = (stage as Stage) || state?.project.stage || "inspire";

  useEffect(() => { if (state) document.title = `${state.project.title} · Tesselle`; }, [state?.project.title]); // eslint-disable-line
  useEffect(() => { try { localStorage.setItem("tsl.rail", rail ? "1" : "0"); } catch { /* ignore */ } }, [rail]);
  useEffect(() => { try { localStorage.setItem("tsl.follow", follow ? "1" : "0"); } catch { /* ignore */ } }, [follow]);
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

  // Tell the other devices which step is open here (they mirror it in follow mode).
  useEffect(() => {
    if (!pid || !state) return;
    lastNav.current = new Date().toISOString();
    const t = setTimeout(() => post(`/api/projects/${pid}/view`, { stage: view, device: deviceId() }).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [pid, view, !!state]); // eslint-disable-line
  // Follow mode: when another device opens a step, open it here too.
  useEffect(() => {
    const v = remote.view;
    if (!follow || !v || !pid || v.device === deviceId() || v.stage === view) return;
    if (v.at <= lastNav.current) return;
    go$(`/p/${pid}/${v.stage}${params.get("follow") ? "?follow=1" : ""}`);
  }, [remote.view?.at, follow]); // eslint-disable-line

  if (error) return <Loading><div className="small muted" style={{ textAlign: "center" }}>{error}</div><a className="btn" href="/">Back to projects</a></Loading>;
  if (!state || !pid) return <Loading><div className="row small muted"><Loader2 size={16} className="spin" color="var(--volt)" /> Opening your project...</div></Loading>;

  const keep = params.get("follow") ? "follow=1" : "";
  const go = (s: Stage | "back", query = "") => {
    if (s === "back") {
      const p = prevStep(buildSteps(state), view);
      if (p) go$(`/p/${pid}/${p}${keep ? `?${keep}` : ""}`);
      return;
    }
    const q = [query, keep].filter(Boolean).join("&");
    go$(`/p/${pid}/${s}${q ? `?${q}` : ""}`);
  };
  const ctx: StageCtx = { state, pid, busy, lines, act, streamAct, go, setPrimary, params };
  const steps = buildSteps(state);
  const doneN = steps.filter((x) => x.status === "done" || x.status === "skipped").length;
  const pct = Math.round((doneN / steps.length) * 100);
  const fill = Math.max(0, steps.findIndex((x) => x.stage === state.next_decision.stage)) / Math.max(1, steps.length - 1);
  const back = prevStep(steps, view);
  const otherLive = !busy && remote.live && remote.live.message ? { agent: remote.live.agent || remote.live.label, message: remote.live.message } : null;
  const islandBusy = busy || (asstLine ? "Assistant" : null) || (otherLive ? "Working" : null);
  const islandLines = asstLine && !busy ? [asstLine] : otherLive ? [otherLive] : lines;

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
                <span className="chip volt"><span className="dot live" /> {STAGE_LABEL[state.next_decision.stage]}</span>
                <span className="mono muted" style={{ fontSize: 11 }}>{pct}%</span>
              </div>
              <div className="t">{state.project.title}</div>
              <div className="meter"><i style={{ width: `${Math.max(4, pct)}%` }} /></div>
              <div className="tiny muted">Saved {ago(state.project.updated_at)}</div>
            </div>
          )}
          <div className="track">
            <div className="track-line"><i style={{ height: `${fill * 100}%` }} /></div>
            {steps.map((st, i) => {
              const locked = st.status === "locked";
              return (
                <button key={st.stage} className={`rail-item ${view === st.stage ? "active" : ""} ${st.status}`}
                  onClick={() => (locked ? setTip(tip?.stage === st.stage ? null : st) : (setTip(null), go(st.stage)))}
                  aria-current={view === st.stage ? "step" : undefined} data-tip={`${st.label} · ${st.sub}`}
                  aria-label={`${st.label}: ${st.sub}${locked ? " (not yet)" : ""}`}>
                  <span className="rail-dot">{st.status === "done" ? <Check strokeWidth={3} /> : locked ? <Lock size={11} /> : i + 1}</span>
                  {rail && (
                    <span className="rail-txt">
                      <span>{st.label}</span>
                      <span className="rail-sub">{st.sub}</span>
                    </span>
                  )}
                  {rail && <span className="st">{st.status === "now" ? "Now" : st.status === "skipped" ? "Skipped" : st.status === "optional" ? "Optional" : ""}</span>}
                </button>
              );
            })}
          </div>
          {tip && (
            <div className="rail-tip glass" role="note">
              <b>{tip.label}</b>
              <span>{tip.why}</span>
              <span className="tiny muted">Opens after: {STAGE_LABEL[state.next_decision.stage]} - {state.next_decision.title}</span>
              <button className="btn sm" onClick={() => { setTip(null); go(state.next_decision.stage); }}>Go to what's next</button>
            </div>
          )}
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
            {remoteChange && <span className="chip amber hidden-sm"><RefreshCw /> Updated on another device</span>}
            {state.project.demo && !pilot && (
              <button className="btn sm light" onClick={() => setPilot(true)} data-pilot="watch"><PlayCircle size={15} /> Watch it run</button>
            )}
            <button className={`btn sm ghost icon-btn ${follow ? "on" : ""}`} onClick={() => setFollow(!follow)} aria-pressed={follow}
              title={follow ? "Mirroring your other device - tap to stop" : "Mirror my other device"} aria-label="Mirror my other device"><Link2 size={16} /></button>
            <button className="btn sm ghost icon-btn hidden-sm" onClick={() => setHandoff(true)} aria-label="Continue on my phone" title="Continue on my phone"><Smartphone size={16} /></button>
            <button className="round-ic" onClick={() => setActivity(true)} aria-label={`Activity: ${state.events.length} steps`} title="Activity">
              <Activity size={16} /><span className="badge">{state.events.length}</span>
            </button>
            <button className="btn sm ghost icon-btn hidden-sm" onClick={() => setHelp(true)} aria-label="Help"><HelpCircle size={16} /></button>
            <ProjectMenu state={state} onState={setState} />
          </header>

          <main className="ws-center">
            <div className="center-inner">{body}</div>
          </main>

          <NextBar nd={state.next_decision} view={view} primary={primary} onPrimary={() => primaryClick.current?.()} busy={busy}
            go={(s) => go(s)} onPhone={() => setHandoff(true)} back={back ? STAGE_LABEL[back] : null} onBack={() => go("back")} />
        </div>

        <aside className="inspector glass" data-pilot="brief-panel">
          <BriefPanel ctx={ctx} />
        </aside>
      </div>

      <VoiceOrb pid={pid} view={view} onState={(s) => { if (s) setState(s); load(); }} onNavigate={(s) => go(s)} onBusy={setAsstLine} />
      <EdgeGlow on={!!islandBusy} />
      {pilot && <Pilot go={(s) => go(s)} onEnd={() => setPilot(false)} openActivity={() => setActivity(true)} />}
      {activity && <ActivityDrawer events={state.events} onClose={() => setActivity(false)} />}
      {handoff && <HandoffModal state={state} onClose={() => setHandoff(false)} />}
      {lensV !== null && <ChangeLens briefs={state.briefs} version={lensV} onClose={() => setLensV(null)}
        onRestore={(v) => act("Restoring", `/api/projects/${pid}/brief/revert`, { to_version: v }, `Restored brief v${v} as a new version`).then(() => setLensV(null))} />}
      {help && (
        <Modal onClose={() => setHelp(false)}>
          <h2 style={{ fontSize: 26 }}>How Tesselle works</h2>
          <div className="small col" style={{ gap: 10, lineHeight: 1.6 }}>
            <div><b>Talk to it:</b> tap the orb (bottom-right) and just say what you want - Tesselle fills in your brief, searches, adds picks and opens each step while it talks. The keyboard next to it opens the chat.</div>
            <div><b>Steps (left):</b> they adapt to what you do - buying from a store skips messaging makers. Tap a step to open it; a locked one tells you what it does. <b>Back</b> is on the bottom bar.</div>
            <div><b>Bottom bar:</b> the one next step. <b>Right:</b> your brief and notes - change anything, any time; every change is a version you can restore.</div>
            <div><b>Must-haves</b> are kept unless you agree to change them. A seller can propose; only you decide.</div>
            <div className="muted">Results come from real stores and makers found live on the web. The checkout agent fills store carts; you always authorise payment on the store.</div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={() => setHelp(false)}>Got it</button></div>
        </Modal>
      )}
    </>
  );
}
