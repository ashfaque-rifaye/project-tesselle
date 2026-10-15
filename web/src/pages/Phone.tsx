import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, Monitor, ShieldCheck, Volume2 } from "lucide-react";
import { get, media } from "../api";
import { Banner, Logo, ProgressBox } from "../components/ui";
import { DeliveryCheck } from "../stages/Accept";
import { DecisionCardView, knownTotal } from "../stages/Compare";
import type { StageCtx } from "../stages/ctx";
import { useProject } from "../useProject";

interface Recap { headline: string; next_action: string; spoken: string; audio?: string }

export default function Phone() {
  const { pid } = useParams();
  const { state, busy, lines, act, streamAct, remoteChange } = useProject(pid);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const rev = state?.project.rev;

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
  const ctx: StageCtx = { state, pid, busy, lines, act, streamAct, go: () => {} };
  const nd = state.next_decision;
  const b = state.briefs[state.briefs.length - 1];
  const quote = nd.quote_id ? state.quotes.find((q) => q.id === nd.quote_id) : undefined;
  const dev = quote && nd.deviation_id ? quote.deviations.find((d) => d.id === nd.deviation_id) : undefined;
  const sampleEvidence = state.order?.milestones.find((m) => m.evidence)?.evidence;

  return (
    <div className="phone-wrap">
      <div className="phone" aria-label="Phone surface">
        <div className="phone-screen">
          <div className="phone-notch"><span /></div>
          <div className="phone-body">
            <div className="row between">
              <Logo small />
              {b && <span className="chip muted">v{b.version}</span>}
            </div>
            {remoteChange && <span className="chip amber">Updated on another device</span>}
            <div>
              <div className="tiny muted">Project</div>
              <div style={{ fontFamily: "var(--display)", fontSize: 21 }}>{state.project.title}</div>
            </div>

            <div className="card pad col">
              <div className="row between"><h4>Where you left off</h4>
                <button className="btn sm" onClick={listen} disabled={speaking}>{speaking ? <Loader2 size={13} className="spin" /> : <Volume2 size={13} />} Listen</button>
              </div>
              {recap ? <div style={{ fontSize: 15, lineHeight: 1.45 }}>{recap.headline}</div> : <div className="small muted"><Loader2 size={12} className="spin" /> Preparing recap...</div>}
            </div>

            {quote && dev && <DecisionCardView q={quote} d={dev} ctx={ctx} compact />}

            {nd.stage === "approve" && quote && (
              <div className="card pad col">
                <h4>Ready for review</h4>
                {quote.image_path && <img src={media(quote.image_path)} alt="Proposal" style={{ borderRadius: 10 }} />}
                <div className="strong">{quote.title}</div>
                <div className="small">{quote.offered_specs.depth_cm} cm deep · {quote.offered_specs.material} · known charges INR {Math.round(knownTotal(quote) || 0).toLocaleString("en-IN")}</div>
                <Banner tone="ink">Approval is a focused review with explicit acknowledgements - open it on a larger screen, or continue on desktop.</Banner>
                <a className="btn primary" href={`/p/${pid}/approve`}>Open the approval review</a>
              </div>
            )}

            {nd.title === "Review the sample" && (
              <div className="card pad col">
                <h4>Sample review</h4>
                {sampleEvidence && <img src={media(sampleEvidence)} alt="Sample evidence" style={{ borderRadius: 10 }} />}
                <span className="chip teal">Simulated sample evidence</span>
                <div className="row">
                  <button className="btn primary" disabled={!!busy} onClick={() => act("Approving sample", `/api/projects/${pid}/order/advance`, { sample_decision: "approve" }, "Sample approved")}>Approve sample</button>
                  <button className="btn" disabled={!!busy} onClick={() => act("Requesting revision", `/api/projects/${pid}/order/advance`, { sample_decision: "revise" }, "Revision requested")}>Revise</button>
                </div>
              </div>
            )}

            {state.order && (nd.stage === "accept") && <DeliveryCheck ctx={ctx} compact />}

            {!dev && nd.stage !== "approve" && nd.stage !== "accept" && nd.title !== "Review the sample" && (
              <div className="next-card">
                <div className="k">Next</div>
                <div className="t">{nd.title}</div>
                <div className="d">{nd.detail}</div>
              </div>
            )}
            <ProgressBox lines={lines} busy={!!busy} />

            {b && (
              <div className="card pad col">
                <h4>Must stay the same</h4>
                {b.requirements.filter((r) => r.kind === "must").map((r) => (
                  <div key={r.id} className="row small" style={{ gap: 8 }}><ShieldCheck size={14} /> {r.label}</div>
                ))}
              </div>
            )}
            <a className="btn" href={`/p/${pid}`}><Monitor size={15} /> Open this project on desktop</a>
            <div className="tiny muted" style={{ textAlign: "center" }}>rev {rev} · same project, same pending decision</div>
          </div>
        </div>
      </div>
      <div className="phone-aside">
        <span className="chip violet">Phone surface · simulated on desktop</span>
        <h2>One clear next action.</h2>
        <p className="muted">The phone opens the exact pending decision with a short recap - spoken aloud with Gemini TTS if you like. Decisions made here appear on the desktop within seconds, without duplicate orders or conflicting approvals.</p>
        <p className="small muted">On a real phone this page fills the screen. Scan the QR code from the desktop's "Continue on my phone".</p>
      </div>
    </div>
  );
}
