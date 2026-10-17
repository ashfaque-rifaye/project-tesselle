import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Activity, ArrowUpRight, Camera, Glasses, Home, Loader2, Lock, Mic, Monitor, Signal, Sparkles, Volume2, Wifi } from "lucide-react";
import { ago, get, inr } from "../api";
import Assistant from "../components/Assistant";
import { Logo, ProgressStrip, actorLabel } from "../components/ui";
import { DeliveryCheck } from "../stages/Accept";
import { DecisionCardView, knownTotal } from "../stages/Compare";
import { STAGE_LABEL, type StageCtx } from "../stages/ctx";
import type { Stage } from "../types";
import { useProject } from "../useProject";

interface Recap { headline: string; next_action: string; spoken: string; audio?: string }
type Tab = "home" | "capture" | "assistant" | "activity";

/** The phone app: same project, same next step, same assistant - whatever you do here shows on the
 *  desktop within seconds, and the other way round. Smart-glasses captures arrive here first. */
export default function Phone() {
  const { pid } = useParams();
  const { state, busy, lines, act, streamAct, remoteChange, setState, load } = useProject(pid);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [tab, setTab] = useState<Tab>("home");

  useEffect(() => {
    if (!pid) return;
    get<Recap>(`/api/projects/${pid}/recap`).then(setRecap).catch(() => {});
  }, [pid, state?.next_decision.title]); // eslint-disable-line

  async function listen() {
    setSpeaking(true);
    try {
      const r = await get<Recap>(`/api/projects/${pid}/recap?speak=true`);
      setRecap(r);
      if (r.audio) await new Audio(r.audio).play();
    } finally {
      setSpeaking(false);
    }
  }

  if (!state || !pid) return <div className="phone-wrap"><Loader2 className="spin" /></div>;
  const ctx: StageCtx = { state, pid, busy, lines, act, streamAct, go: (s: Stage) => (window.location.href = `/p/${pid}/${s}`), setPrimary: () => {}, params: new URLSearchParams() };
  const nd = state.next_decision;
  const b = state.briefs[state.briefs.length - 1];
  const quote = nd.quote_id ? state.quotes.find((q) => q.id === nd.quote_id) : undefined;
  const dev = quote && nd.deviation_id ? quote.deviations.find((d) => d.id === nd.deviation_id) : undefined;
  const order = state.order;
  const cur = order?.milestones.find((m) => m.state === "current");
  const top = (state.routes?.entries || []).filter((e) => e.route === "buy" && e.verdict !== "not_suitable").slice(0, 3);
  const tabs: [Tab, JSX.Element, string][] = [
    ["home", <Home size={20} key="h" />, "Home"], ["capture", <Camera size={20} key="c" />, "Capture"],
    ["assistant", <Mic size={20} key="m" />, "Assistant"], ["activity", <Activity size={20} key="a" />, "Activity"],
  ];

  return (
    <div className="phone-wrap">
      <div className="phone" aria-label="Phone app">
        <div className="phone-screen">
          <div className="phone-notch"><b>9:41</b><span /><b className="row" style={{ gap: 5 }}><Signal size={14} /><Wifi size={14} /></b></div>
          <div className="phone-body">
            <div className="row between"><Logo small />{b && <span className="chip muted">v{b.version}</span>}</div>
            {remoteChange && <span className="chip amber">Updated from your computer</span>}

            {tab === "home" && (
              <>
                <div>
                  <div className="tiny muted">{STAGE_LABEL[state.project.stage]}</div>
                  <div style={{ fontFamily: "var(--display)", fontSize: 28, letterSpacing: "-.035em", lineHeight: 1.1 }}>{state.project.title}</div>
                </div>
                <div className="card pad col">
                  <div className="row between"><h4>Where you left off</h4>
                    <button className="btn sm" onClick={listen} disabled={speaking}>{speaking ? <Loader2 size={13} className="spin" /> : <Volume2 size={13} />} Listen</button>
                  </div>
                  {recap ? <div style={{ fontSize: 15, lineHeight: 1.45 }}>{recap.headline}</div> : <div className="small muted"><Loader2 size={12} className="spin" /> Getting your recap...</div>}
                </div>

                {quote && dev && <DecisionCardView q={quote} d={dev} ctx={ctx} compact />}
                {order && cur && cur.key !== "checked" && (
                  <div className="card pad col">
                    <h4>{cur.label}</h4>
                    <div className="small">{order.title} · {order.seller_name}</div>
                    {order.url && <a className="btn light" href={order.url} target="_blank" rel="noreferrer">Open {order.seller_name.split(" ")[0]} <ArrowUpRight size={14} /></a>}
                    <button className="btn primary" disabled={!!busy} onClick={() => act("Saving", `/api/projects/${pid}/order/advance`, { step: cur.key }, "Saved")}>
                      {cur.key === "ordered" ? "I've ordered it" : "It arrived"}
                    </button>
                  </div>
                )}
                {order && nd.stage === "accept" && <DeliveryCheck ctx={ctx} compact />}
                {!dev && !order && nd.stage === "approve" && quote && (
                  <div className="card pad col">
                    <h4>Ready to choose</h4>
                    <div className="strong">{quote.title}</div>
                    <div className="small">{quote.seller_name} · {inr(knownTotal(quote))}</div>
                    <a className="btn primary" href={`/p/${pid}/approve?quote=${quote.id}`}>Review and choose</a>
                  </div>
                )}
                {!dev && !order && nd.stage !== "approve" && (
                  <div className="next-card frost">
                    <div className="k">Next</div>
                    <div className="t">{nd.title}</div>
                    <div className="d">{nd.detail}</div>
                  </div>
                )}
                {top.length > 0 && !order && (
                  <div className="card pad col">
                    <h4>Top options</h4>
                    {top.map((e) => (
                      <a key={e.item_id} className="phone-opt" href={e.url} target="_blank" rel="noreferrer">
                        {e.image_url ? <img src={e.image_url} alt="" referrerPolicy="no-referrer" /> : <span className="noimg-s" />}
                        <span className="grow"><b className="small clamp2">{e.name}</b><span className="tiny muted">{e.seller_name} · {e.price_inr ? inr(e.price_inr) : "see price"}</span></span>
                        <ArrowUpRight size={14} />
                      </a>
                    ))}
                  </div>
                )}
                <ProgressStrip lines={lines} busy={!!busy} />
                {b && (
                  <div className="card pad col">
                    <h4>Must-haves</h4>
                    {b.requirements.filter((r) => r.kind === "must").map((r) => (
                      <div key={r.id} className="row small" style={{ gap: 10 }}><span className="lock-ic"><Lock /></span> {r.label}</div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === "capture" && (
              <>
                <div style={{ fontFamily: "var(--display)", fontSize: 26, letterSpacing: "-.03em" }}>Capture</div>
                <a className="card pad row" style={{ gap: 12, color: "var(--ink)" }} href={`/g/${pid}`}>
                  <span className="drop-ic" style={{ width: 46, height: 46 }}><Camera size={20} /></span>
                  <span><b>Camera</b><div className="tiny muted">Snap or film it - ask out loud - hear the answer</div></span>
                </a>
                <div className="card pad col">
                  <div className="row" style={{ gap: 10 }}><span className="drop-ic" style={{ width: 46, height: 46 }}><Glasses size={20} /></span><b>Ray-Ban Meta glasses</b></div>
                  <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                    <li>Add Tesselle to your Home Screen (Share → Add to Home Screen).</li>
                    <li>Take a photo or clip with your glasses - it syncs to the Meta AI app.</li>
                    <li>In the Meta AI app tap <b>Share → Tesselle</b>. It goes straight to this project.</li>
                  </ol>
                </div>
              </>
            )}

            {tab === "assistant" && (
              <Assistant pid={pid} view={state.project.stage} embedded onState={(s) => { setState(s); load(); }}
                onNavigate={(s) => (window.location.href = `/p/${pid}/${s}`)} />
            )}

            {tab === "activity" && (
              <div className="col" style={{ gap: 8 }}>
                <div style={{ fontFamily: "var(--display)", fontSize: 26, letterSpacing: "-.03em" }}>Activity</div>
                {state.events.slice(0, 20).map((e) => {
                  const a = actorLabel(e.actor);
                  return (
                    <div key={e.id} className="act-item">
                      <span className={`act-av ${a.agent ? "agent" : ""}`}>{a.agent ? <Sparkles size={12} /> : <Activity size={12} />}</span>
                      <div className="grow"><div className="tiny muted">{a.name} · {ago(e.ts)}</div><div className="small">{e.summary}</div></div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="tabbar glass" role="tablist">
            {tabs.map(([k, ic, l]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)} aria-label={l} role="tab" aria-selected={tab === k}>{ic}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="phone-aside">
        <span className="chip violet" style={{ alignSelf: "flex-start" }}>Phone app · shown in a frame on desktop</span>
        <h2>One project, every device.</h2>
        <p className="muted">Decide on the phone, see it on the desktop seconds later. The same assistant remembers you everywhere (Agent Platform Sessions + Memory Bank), and glasses captures land here.</p>
        <a className="btn" href={`/p/${pid}`} style={{ alignSelf: "flex-start" }}><Monitor size={15} /> Open on desktop</a>
        <div className="tiny muted">rev {state.project.rev} · updated {ago(state.project.updated_at)}</div>
      </div>
    </div>
  );
}
