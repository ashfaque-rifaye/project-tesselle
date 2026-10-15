import { useEffect, useState } from "react";
import { EyeOff, Lock, Send, ShieldCheck } from "lucide-react";
import { get, inr, media } from "../api";
import { Banner, ProgressBox } from "../components/ui";
import { brief as currentBrief, type StageCtx } from "./ctx";

interface Seller { id: string; name: string; role: string; label: string; capabilities?: string }

export default function Request({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const b = currentBrief(state);
  const req = [...state.requests].reverse()[0];
  const [makers, setMakers] = useState<Seller[]>([]);
  const [chosen, setChosen] = useState<string[]>(["kaveri"]);
  const [includeConcept, setIncludeConcept] = useState(true);
  const [includePhoto, setIncludePhoto] = useState(false);
  const [shareBudget, setShareBudget] = useState(true);

  useEffect(() => {
    get<{ sellers: Seller[] }>("/api/meta").then((m) => setMakers(m.sellers.filter((s) => s.role === "maker")));
  }, []);

  async function prepare() {
    await ctx.act("Preparing request", `/api/projects/${pid}/requests`,
      { seller_ids: chosen, include_concept: includeConcept, include_photo: includePhoto, share_budget: shareBudget }, "Request prepared - nothing sent yet");
  }

  async function send() {
    try {
      await ctx.streamAct("Sending", `/api/projects/${pid}/requests/${req.id}/send`, {}, "Seller response received");
      ctx.go("compare");
    } catch {
      /* toast */
    }
  }

  const draftView = req && req.status === "draft";

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">05 · Request offers</div>
          <h2>Approve what sellers receive</h2>
          <p>Only the approved brief is shared - never your name, contact details or full address. Sellers may decline or propose changes; a proposal never changes your brief by itself.</p>
        </div>
      </div>

      {(!req || !draftView) && !(req && req.status !== "draft") && (
        <div className="card pad section">
          <h3>Who should receive it?</h3>
          <div className="col">
            {makers.map((m) => (
              <label key={m.id} className="check">
                <input type="checkbox" checked={chosen.includes(m.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, m.id] : chosen.filter((x) => x !== m.id))} />
                <span><b>{m.name}</b> <span className="chip violet">{m.label}</span><div className="tiny muted">{m.capabilities}</div></span>
              </label>
            ))}
          </div>
          <div className="divider" />
          <h3>Privacy</h3>
          <label className="check"><input type="checkbox" checked={includeConcept} onChange={(e) => setIncludeConcept(e.target.checked)} /> Include the selected concept image (labelled as a concept)</label>
          <label className="check"><input type="checkbox" checked={includePhoto} onChange={(e) => setIncludePhoto(e.target.checked)} /> Include the photo of my space</label>
          <label className="check"><input type="checkbox" checked={shareBudget} onChange={(e) => setShareBudget(e.target.checked)} /> Share my budget</label>
          <ProgressBox lines={lines} busy={!!busy} />
          <div className="row between">
            <span className="small muted">You'll review the exact request before anything is sent.</span>
            <button className="btn primary" onClick={prepare} disabled={!!busy || !chosen.length || !b?.confirmed}>Prepare request for review</button>
          </div>
        </div>
      )}

      {req && (
        <div className="card raised" style={{ overflow: "hidden" }}>
          <div className="row between" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <div className="row"><Lock size={16} /><h3>What {req.seller_names.join(" and ")} will receive</h3></div>
            <span className={`chip ${req.status === "draft" ? "amber" : "teal"}`}>{req.status === "draft" ? "Not sent" : req.status === "sent" ? "Sent - awaiting response" : "Responded"}</span>
          </div>
          <div style={{ padding: 18 }} className="grid-2">
            <div className="section">
              <div className="small"><span className="chip ink">Brief v{req.brief_version}</span></div>
              <p style={{ lineHeight: 1.6 }}>{req.summary}</p>
              <div className="col" style={{ gap: 6 }}>
                {req.shared.requirements.map((r) => (
                  <div key={r.id} className={`req ${r.kind === "must" ? "must" : "flex"}`}>
                    {r.kind === "must" ? <ShieldCheck className="ic" /> : <span className="ic" />}
                    <div>{r.label} <span className="meta">· {r.kind === "must" ? "must stay the same" : "flexible"}</span></div>
                  </div>
                ))}
              </div>
              {req.questions.length > 0 && (
                <div className="col small">
                  <b>Questions for the maker</b>
                  {req.questions.map((q, i) => <div key={i}>· {q}</div>)}
                </div>
              )}
            </div>
            <div className="section">
              {req.shared.concept_image_path && (
                <div className="col">
                  <img src={media(req.shared.concept_image_path)} alt="Concept shared" style={{ borderRadius: 12 }} />
                  <span className="chip violet">Concept visualisation - not a specification</span>
                </div>
              )}
              <dl className="kv">
                <dt>Budget</dt><dd>{req.shared.budget ? `${inr(req.shared.budget.target_inr)} target · ${inr(req.shared.budget.limit_inr)} limit` : "Not shared"}</dd>
                <dt>Region</dt><dd>{req.shared.delivery_region || "Not shared"}</dd>
                <dt>Photo of space</dt><dd>{req.shared.photo_included ? "Included" : "Not shared"}</dd>
              </dl>
              <div className="label-banner ink">
                <EyeOff />
                <div><b>Not shared:</b> {req.shared.not_shared.join(" · ")}</div>
              </div>
            </div>
          </div>
          {req.status === "draft" && (
            <div style={{ padding: "0 18px 18px" }} className="section">
              <ProgressBox lines={lines} busy={!!busy} />
              <div className="row between">
                <span className="small muted">Sends brief v{req.brief_version} only. Nothing is purchased; sellers' responses are AI-simulated in this demo.</span>
                <button className="btn primary lg" onClick={send} disabled={!!busy}>
                  <Send size={16} /> Send approved request
                </button>
              </div>
            </div>
          )}
          {req.status !== "draft" && (
            <div style={{ padding: "0 18px 18px" }} className="section">
              <ProgressBox lines={lines} busy={!!busy} />
              {req.responses.map((r, i) => (
                <Banner key={i} tone={r.decision === "decline" ? "amber" : "teal"}>
                  <b>{r.seller_name}</b> {r.decision === "decline" ? `declined: ${r.message}` : "sent a quote."}
                </Banner>
              ))}
              {req.responses.length === 0 && <div className="small muted">No seller has responded yet. You can pause - the project is saved.</div>}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn teal" onClick={() => ctx.go("compare")}>Open quote inbox</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
