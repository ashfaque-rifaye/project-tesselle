import { useState } from "react";
import { ArrowUpRight, Check, Copy, Globe, Mail, MessageCircle, Send } from "lucide-react";
import { ProgressStrip, favicon, useToast } from "../components/ui";
import { usePrimary, type StageCtx } from "./ctx";

/** Messages the outreach agent wrote - the customer sends them from their own email or WhatsApp. */
export default function Request({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const toast = useToast();
  const req = [...state.requests].sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
  const [copied, setCopied] = useState<string | null>(null);

  async function markAll() {
    try {
      await ctx.act("Saving", `/api/projects/${pid}/requests/${req.id}/sent`, {}, "Marked as sent");
      ctx.go("compare");
    } catch {
      /* toast */
    }
  }

  usePrimary(ctx, !req
    ? { label: "Pick makers", onClick: () => ctx.go("routes"), hint: "Choose who to message on the Options step" }
    : req.status === "draft"
      ? { label: "I've sent them", onClick: markAll, icon: <Check size={16} />, hint: "Send from your email or WhatsApp, then tell Tesselle" }
      : { label: "Add their reply", onClick: () => ctx.go("compare"), hint: "When they answer, paste the reply - Tesselle checks it" });

  if (!req) return <div className="empty"><Send size={28} />Pick makers or sellers on the Options step and Tesselle writes the messages for you.</div>;

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Reach out</div>
          <h2>Messages, ready to send</h2>
          <p>Only your brief is shared - never your name, number or address. Tesselle never sends anything for you.</p>
        </div>
      </div>
      <ProgressStrip lines={lines} busy={!!busy} />
      {req.recipients.map((r) => (
        <div key={r.entry_id} className="card msg-card">
          <div className="row between wrap" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 10 }}>
              <span className="mk-logo"><img src={favicon(r.url ? new URL(r.url).hostname : r.name)} alt="" /></span>
              <div>
                <div className="strong">{r.name}</div>
                {r.url && <a className="tiny" href={r.url} target="_blank" rel="noreferrer">{new URL(r.url).hostname.replace("www.", "")} <ArrowUpRight size={10} /></a>}
              </div>
            </div>
            <span className={`chip ${r.status === "sent" ? "teal" : "amber"}`}>{r.status === "sent" ? "Sent" : "Ready to send"}</span>
          </div>
          <div className="mail">
            <div className="mail-subj">{r.subject}</div>
            <div className="mail-body">{r.body}</div>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {r.channels.gmail && <a className="btn sm light" href={r.channels.gmail} target="_blank" rel="noreferrer"><Mail size={14} /> Open in Gmail</a>}
            {r.channels.mailto && <a className="btn sm" href={r.channels.mailto}><Mail size={14} /> Email app</a>}
            {r.channels.whatsapp && <a className="btn sm" href={r.channels.whatsapp} target="_blank" rel="noreferrer"><MessageCircle size={14} /> WhatsApp</a>}
            {r.channels.website && <a className="btn sm ghost" href={r.channels.website} target="_blank" rel="noreferrer"><Globe size={14} /> Contact page</a>}
            <button className="btn sm ghost" onClick={() => { navigator.clipboard.writeText(`${r.subject}\n\n${r.body}`); setCopied(r.entry_id); toast("Message copied"); }}>
              <Copy size={14} /> {copied === r.entry_id ? "Copied" : "Copy"}
            </button>
            <div className="grow" />
            {r.status !== "sent" && (
              <button className="btn sm" disabled={!!busy} onClick={() => ctx.act("Saving", `/api/projects/${pid}/requests/${req.id}/sent`, { entry_id: r.entry_id }, `Marked as sent to ${r.name}`)}>
                <Check size={14} /> Mark sent
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
