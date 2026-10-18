import { useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, Loader2, Mail, MessageCircle, Paperclip, Pencil, Phone, Send, ShieldCheck } from "lucide-react";
import { media, setUserEmail, userEmail } from "../api";
import MicButton from "../components/MicButton";
import { useChannels } from "../components/ProjectMenu";
import { ProgressStrip, favicon, useToast } from "../components/ui";
import type { Attachment, Channel, Recipient, SellerRequest } from "../types";
import { usePrimary, type StageCtx } from "./ctx";

const CH: Record<Channel, { icon: JSX.Element; label: string }> = {
  email: { icon: <Mail size={14} />, label: "Email" },
  call: { icon: <Phone size={14} />, label: "AI call" },
  whatsapp: { icon: <MessageCircle size={14} />, label: "WhatsApp" },
};

const STATUS: Record<string, [string, string]> = {
  draft: ["amber", "Ready"], sent: ["teal", "Sent"], calling: ["sky", "Calling..."], called: ["teal", "Called"], replied: ["volt", "Replied"], failed: ["red", "Not sent"],
};

/** Not the owner: the email opens in the visitor's own Gmail, ready to send (photos as links). */
function openGmail(r: Recipient, atts: Attachment[], from: string) {
  const photos = atts.length ? "\n\nPhotos:\n" + atts.map((a) => `${a.label}: ${new URL(media(a.path), window.location.href).href}`).join("\n") : "";
  const q = new URLSearchParams({ view: "cm", fs: "1", authuser: from, to: r.contact?.email || "", su: r.subject, body: r.body + photos });
  window.open(`https://mail.google.com/mail/?${q.toString()}`, "_blank");
}

async function shareWhatsApp(r: Recipient, atts: Attachment[]): Promise<boolean> {
  // Phones: the share sheet sends the message AND the photos to WhatsApp. Desktop: WhatsApp opens with the text.
  try {
    const files = await Promise.all(atts.map(async (a) => {
      const blob = await (await fetch(media(a.path))).blob();
      return new File([blob], `${a.label.replace(/[^A-Za-z0-9]+/g, "-")}.jpg`, { type: "image/jpeg" });
    }));
    const data: ShareData = { text: `${r.subject}\n\n${r.body}`, files };
    if (navigator.canShare?.(data)) {
      await navigator.share(data);
      return true;
    }
  } catch { /* fall back to a link */ }
  if (r.channels.whatsapp) { window.open(r.channels.whatsapp, "_blank"); return true; }
  window.open(`https://wa.me/?text=${encodeURIComponent(`${r.subject}\n\n${r.body}`)}`, "_blank");
  return true;
}

function RecipientCard({ ctx, req, r, owner, wa }: { ctx: StageCtx; req: SellerRequest; r: Recipient; owner: boolean; wa: boolean }) {
  const { pid, busy } = ctx;
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(r.body);
  const [email, setEmail] = useState(r.contact?.email || "");
  const [phone, setPhone] = useState(r.contact?.phone || "");
  const channel: Channel = r.channel || "email";
  const atts = (req.attachments || []).filter((a) => (r.attachments || []).includes(a.id));
  const call = (ctx.state.calls || []).find((c) => c.id === r.call_id);
  const base = `/api/projects/${pid}/requests/${req.id}/recipients/${r.entry_id}`;
  const patch = (b: object, msg?: string) => ctx.act("Saving", base, b, msg);
  const missing = channel === "email" ? !r.contact?.email : channel === "call" ? !r.contact?.phone : false;
  const done = ["sent", "calling", "called", "replied"].includes(r.status);

  async function send() {
    if (channel === "whatsapp" && !(wa && owner)) {
      await shareWhatsApp(r, atts);
      await ctx.streamAct("Saving", `/api/projects/${pid}/requests/${req.id}/send`, { entry_ids: [r.entry_id], via_device: true }, `Sent to ${r.name} on WhatsApp`).catch(() => {});
      return;
    }
    if (channel === "email" && !owner) {
      const from = userEmail() || window.prompt("Your Gmail address - the email opens there, ready to send, and replies come to you:") || "";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return toast("Add your email address to send it from your Gmail.", true);
      setUserEmail(from);
      openGmail(r, atts, from);
      await ctx.streamAct("Saving", `/api/projects/${pid}/requests/${req.id}/send`, { entry_ids: [r.entry_id], via_device: true }, `Opened in your Gmail - press Send there`).catch(() => {});
      return;
    }
    if (!owner) {
      toast("AI calls go out from the owner's phone line - this needs the owner key on this device (menu → Connections).", true);
      window.dispatchEvent(new Event("tsl:settings"));
      return;
    }
    await ctx.streamAct(channel === "call" ? "Calling" : "Sending", `/api/projects/${pid}/requests/${req.id}/send`, { entry_ids: [r.entry_id], reply_to: userEmail() || null },
      channel === "call" ? `Calling ${r.name}` : `Sent to ${r.name}`).catch(() => {});
  }

  return (
    <div className="card msg-card">
      <div className="row between wrap" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="mk-logo"><img src={favicon(r.url ? new URL(r.url).hostname : r.name)} alt="" /></span>
          <div>
            <div className="strong">{r.name}</div>
            {r.url && <a className="tiny" href={r.url} target="_blank" rel="noreferrer">{new URL(r.url).hostname.replace("www.", "")} <ArrowUpRight size={10} /></a>}
          </div>
        </div>
        <span className={`chip ${STATUS[r.status]?.[0] || "muted"}`}>{r.status === "calling" && <Loader2 className="spin" />}{STATUS[r.status]?.[1] || r.status}</span>
      </div>

      {!done && (
        <div className="seg" role="radiogroup" aria-label={`How to reach ${r.name}`}>
          {(Object.keys(CH) as Channel[]).map((c) => (
            <button key={c} role="radio" aria-checked={channel === c} className={channel === c ? "on" : ""} disabled={!!busy}
              onClick={() => channel !== c && patch({ channel: c })}>{CH[c].icon} {CH[c].label}</button>
          ))}
        </div>
      )}

      {!done && (channel === "email" || channel === "call" || channel === "whatsapp") && (
        <div className="row wrap" style={{ gap: 6 }}>
          {channel === "email" && <input className="input sm" style={{ maxWidth: 280 }} placeholder="Their email" value={email} onChange={(e) => setEmail(e.target.value)}
            onBlur={() => email !== (r.contact?.email || "") && patch({ email })} />}
          {(channel === "call" || channel === "whatsapp") && <input className="input sm" style={{ maxWidth: 220 }} placeholder="Their phone number" value={phone} onChange={(e) => setPhone(e.target.value)}
            onBlur={() => phone !== (r.contact?.phone || "") && patch({ phone })} inputMode="tel" />}
          {missing && <span className="tiny muted"><AlertTriangle size={11} /> Add their {channel === "email" ? "email" : "number"} (from their website)</span>}
        </div>
      )}

      {channel === "call" && !done ? (
        <div className="mail">
          <div className="mail-subj"><Phone size={13} /> The call agent will:</div>
          <div className="mail-body">Say it's an AI assistant calling for a customer, ask whether they can make it and meet each must-have, ask the price with delivery and the lead time - then write the answers down for the fit checker. Your name and number are never shared.</div>
        </div>
      ) : (
        <div className="mail">
          <div className="mail-subj">{r.subject}</div>
          {editing ? (
            <div className="col" style={{ gap: 6 }}>
              <textarea className="textarea" style={{ minHeight: 160 }} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="row" style={{ gap: 6 }}>
                <MicButton value={body} onChange={setBody} label="Dictate changes" />
                <button className="btn sm primary" onClick={() => patch({ body }, "Message updated").then(() => setEditing(false))}>Save</button>
                <button className="btn sm ghost" onClick={() => { setBody(r.body); setEditing(false); }}>Cancel</button>
              </div>
            </div>
          ) : <div className="mail-body">{r.body}</div>}
        </div>
      )}

      {atts.length > 0 || (req.attachments || []).length > 0 ? (
        <div className="atts">
          {(req.attachments || []).map((a) => {
            const on = (r.attachments || []).includes(a.id);
            return (
              <button key={a.id} className={`att ${on ? "on" : ""}`} disabled={done || !!busy} title={on ? "Attached - tap to remove" : "Tap to attach"}
                onClick={() => patch({ attachments: on ? (r.attachments || []).filter((x) => x !== a.id) : [...(r.attachments || []), a.id] })}>
                <img src={media(a.path)} alt={a.label} />
                <span className="att-l">{on ? <Paperclip size={10} /> : null} {a.label}</span>
                <span className="att-p" title={a.privacy.blurred.length ? `Blurred: ${a.privacy.blurred.join(", ")}` : "Nothing personal found; camera data removed"}>
                  <ShieldCheck size={10} /> {a.privacy.blurred.length ? `${a.privacy.blurred.length} blurred` : "Private"}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {call && call.transcript.length > 0 && (
        <div className="call-log">
          {call.transcript.slice(-8).map((t, i) => <div key={i} className={`msg ${t.who === "agent" ? "assistant" : "customer"}`}><b>{t.who === "agent" ? "Tesselle" : r.name}:</b> {t.text}</div>)}
        </div>
      )}
      {r.error && r.status === "failed" && <div className="tiny" style={{ color: "var(--amber-ink)" }}><AlertTriangle size={11} /> {r.error}</div>}

      {!done && (
        <div className="row wrap" style={{ gap: 6 }}>
          <button className="btn sm primary" disabled={!!busy || missing && channel !== "whatsapp"} onClick={send} data-pilot="send-one">
            {CH[channel].icon} {channel === "call" ? `Call ${r.name.split(" ")[0]}` : channel === "whatsapp" ? (wa && owner ? "Send WhatsApp" : "Open in WhatsApp") : owner ? "Send email" : "Send from my Gmail"}
          </button>
          {channel !== "call" && !editing && <button className="btn sm ghost" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>}
          <div className="grow" />
          <button className="btn sm ghost" disabled={!!busy} onClick={() => ctx.act("Saving", `/api/projects/${pid}/requests/${req.id}/sent`, { entry_id: r.entry_id }, `Marked as sent to ${r.name}`)}
            title="If you contacted them some other way"><Check size={13} /> I sent it myself</button>
        </div>
      )}
    </div>
  );
}

/** The outreach agent's messages: each maker gets the channel you choose - an email from your inbox, an AI
 *  phone call, or WhatsApp - with privacy-checked photos. Mix and match, then send from here. */
export default function Request({ ctx }: { ctx: StageCtx }) {
  const { state, pid, busy, lines } = ctx;
  const toast = useToast();
  const req = [...state.requests].sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
  const { st } = useChannels();
  const owner = !!st?.owner;
  const pending = req ? req.recipients.filter((r) => r.status === "draft" || r.status === "failed") : [];
  const wa = !!st?.whatsapp;
  const direct = pending.filter((r) => (r.channel || "email") !== "whatsapp" || (wa && owner));

  async function sendAll() {
    if (!owner) {
      toast("Send each message below - emails open in your own Gmail; AI calls need the owner key.", true);
      document.querySelector('[data-pilot="send-one"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    await ctx.streamAct("Sending", `/api/projects/${pid}/requests/${req.id}/send`, { entry_ids: direct.map((r) => r.entry_id), reply_to: userEmail() || null }, "Messages on their way").catch(() => {});
  }

  usePrimary(ctx, !req
    ? { label: "Pick makers", onClick: () => ctx.go("routes"), hint: "Choose who to ask on the Options step" }
    : direct.length
      ? { label: `Send ${direct.length === 1 ? "it" : `all ${direct.length}`}`, onClick: sendAll, icon: <Send size={16} />, hint: "Emails go from your inbox; calls are made by the call agent" }
      : pending.length
        ? { label: "Open in WhatsApp", onClick: () => (document.querySelector('[data-pilot="send-one"]') as HTMLElement | null)?.click(), icon: <MessageCircle size={16} />, hint: "Sends the message and photos" }
        : { label: "See replies", onClick: () => ctx.go("compare"), hint: "Replies and call answers are checked as they come in" });

  if (!req) return <div className="empty"><Send size={28} />Pick makers or sellers on the Options step and Tesselle writes, emails or calls them for you.</div>;

  return (
    <div className="section">
      <div className="stage-head">
        <div>
          <div className="eyebrow">Reach out</div>
          <h2>Messages, ready to go</h2>
          <p>Choose how to reach each one - email, an AI phone call or WhatsApp - and send from here. Only your brief is shared; photos are checked for anything personal first.</p>
        </div>
      </div>
      <EmailBar owner={owner} connected={st?.email_address || null} />
      {st && (!st.email || !st.calls || !owner) && (
        <div className="label-banner ink">
          <ShieldCheck />
          <div className="grow small">
            {!st.email || !st.calls ? <>{!st.email && "Email sending"}{!st.email && !st.calls && " and "}{!st.calls && "AI calls"} {(!st.email && !st.calls) ? "aren't" : "isn't"} connected yet. </> : null}
            {!owner && "On this device, sending from the owner's inbox or phone line needs the owner key. "}WhatsApp works on any device.
          </div>
          <button className="btn sm" onClick={() => window.dispatchEvent(new Event("tsl:settings"))}>Connections</button>
        </div>
      )}
      <ProgressStrip lines={lines} busy={!!busy} />
      {req.recipients.map((r) => <RecipientCard wa={wa} key={r.entry_id} ctx={ctx} req={req} r={r} owner={owner} />)}
      {req.ref && <div className="tiny muted">Reference {req.ref} - replies to these emails are read and checked automatically.</div>}
    </div>
  );
}


/** Every sender is asked for their own email: replies come back to them. The owner's device sends from the
 *  connected inbox; anyone else's emails open in their own Gmail, ready to send. */
function EmailBar({ owner, connected }: { owner: boolean; connected: string | null }) {
  const [v, setV] = useState(userEmail());
  const [edit, setEdit] = useState(!userEmail() && !owner);
  const save = () => { setUserEmail(v); setEdit(false); };
  return (
    <div className="email-bar well">
      <Mail size={15} />
      {edit ? (
        <>
          <span className="small">Your Gmail address</span>
          <input className="input sm" style={{ maxWidth: 260 }} type="email" placeholder="you@gmail.com" value={v} onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()} />
          <button className="btn sm" onClick={save} disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)}><Check size={13} /> Save</button>
          <span className="tiny muted">{owner ? "Replies are copied to you." : "Emails open in your Gmail, ready to send; replies come to you."}</span>
        </>
      ) : (
        <>
          <span className="small grow">{owner && connected ? <>Sent from your connected inbox <b>{connected}</b>{v ? <> · replies copied to <b>{v}</b></> : null}</>
            : v ? <>Emails open in your Gmail (<b>{v}</b>), ready to send</> : "Add your email so replies come to you"}</span>
          <button className="btn sm ghost" onClick={() => setEdit(true)}><Pencil size={12} /> {v ? "Change" : "Add"}</button>
        </>
      )}
    </div>
  );
}
