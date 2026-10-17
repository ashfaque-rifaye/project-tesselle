import { useEffect, useRef, useState } from "react";
import { Archive, KeyRound, Mail, MoreHorizontal, Package, Pencil, Phone, PhoneOff, Settings, ShieldCheck } from "lucide-react";
import { get, ownerKey, post, setOwnerKey } from "../api";
import type { ProjectState } from "../types";
import MicButton from "./MicButton";
import { Modal, useToast } from "./ui";

interface ChannelStatus { email: boolean; email_address?: string | null; calls: boolean; owner_key_set: boolean; owner: boolean }

export function useChannels(open = true) {
  const [st, setSt] = useState<ChannelStatus | null>(null);
  const reload = () => get<ChannelStatus>("/api/channels").then(setSt).catch(() => setSt(null));
  useEffect(() => { if (open) reload(); }, [open]); // eslint-disable-line
  return { st, reload };
}

/** Owner settings: which channels the agents can use, and the owner key for this device. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { st, reload } = useChannels();
  const [key, setKey] = useState(ownerKey());
  const toast = useToast();
  return (
    <Modal onClose={onClose}>
      <div className="row"><Settings size={20} /><h2 style={{ fontSize: 22 }}>Connections</h2></div>
      <div className="small muted">The outreach agent sends email from your connected inbox and the call agent phones makers for you. Setting these up takes a few minutes - see <b>docs/CHANNELS.md</b>.</div>
      <div className="col" style={{ gap: 8 }}>
        <div className="conn-row"><Mail size={16} /><span className="grow">Email (send + read replies + order emails)</span>
          <span className={`chip ${st?.email ? "teal" : "muted"}`}>{st ? (st.email ? `Connected · ${st.email_address}` : "Not connected") : "..."}</span></div>
        <div className="conn-row">{st?.calls ? <Phone size={16} /> : <PhoneOff size={16} />}<span className="grow">Phone calls by the call agent</span>
          <span className={`chip ${st?.calls ? "teal" : "muted"}`}>{st ? (st.calls ? "Connected" : "Not connected") : "..."}</span></div>
        <div className="conn-row"><ShieldCheck size={16} /><span className="grow">This device can use them</span>
          <span className={`chip ${st?.owner ? "teal" : "amber"}`}>{st ? (st.owner ? "Yes - owner key OK" : "Needs the owner key") : "..."}</span></div>
      </div>
      <label className="col" style={{ gap: 6 }}>
        <span className="small strong"><KeyRound size={13} /> Owner key</span>
        <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the owner key from the setup script" />
        <span className="tiny muted">Stored only in this browser. It stops anyone else who opens the public demo from sending from your inbox or phone line.</span>
      </label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" onClick={async () => { setOwnerKey(key); await reload(); toast(key ? "Owner key saved on this device" : "Owner key removed"); }}>Save</button>
      </div>
    </Modal>
  );
}

/** Project menu: rename, describe, archive, order history, connections. */
export default function ProjectMenu({ state, onState }: { state: ProjectState; onState: (s: ProjectState) => void }) {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [settings, setSettings] = useState(false);
  const b = state.briefs[state.briefs.length - 1];
  const [title, setTitle] = useState(state.project.title);
  const [purpose, setPurpose] = useState(b?.purpose || "");
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  useEffect(() => { const h = () => setSettings(true); window.addEventListener("tsl:settings", h); return () => window.removeEventListener("tsl:settings", h); }, []);

  async function save() {
    setSaving(true);
    try {
      onState(await post<ProjectState>(`/api/projects/${state.project.id}/edit`, { title, purpose: b ? purpose : undefined }));
      toast("Project updated");
      setEdit(false);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }
  async function archive() {
    if (!confirm("Archive this project? You can restore it from your project list.")) return;
    await post(`/api/projects/${state.project.id}/edit`, { archived: true });
    window.location.href = "/#projects";
  }

  return (
    <div className="pmenu" ref={ref}>
      <button className="btn sm ghost icon-btn" onClick={() => setOpen(!open)} aria-label="Project menu" title="Project menu"><MoreHorizontal size={17} /></button>
      {open && (
        <div className="pmenu-pop glass" role="menu">
          <button role="menuitem" onClick={() => { setTitle(state.project.title); setPurpose(b?.purpose || ""); setEdit(true); setOpen(false); }}><Pencil size={14} /> Edit project</button>
          <a role="menuitem" href="/orders"><Package size={14} /> Order history</a>
          <button role="menuitem" onClick={() => { setSettings(true); setOpen(false); }}><Settings size={14} /> Connections & owner key</button>
          <button role="menuitem" className="danger" onClick={archive}><Archive size={14} /> Archive project</button>
        </div>
      )}
      {edit && (
        <Modal onClose={() => setEdit(false)}>
          <h2 style={{ fontSize: 22 }}>Edit project</h2>
          <label className="col" style={{ gap: 6 }}>
            <span className="small strong">Name</span>
            <div className="row" style={{ gap: 6 }}>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
              <MicButton value={title} onChange={setTitle} />
            </div>
          </label>
          {b && (
            <label className="col" style={{ gap: 6 }}>
              <span className="small strong">What it's for</span>
              <div className="row" style={{ gap: 6, alignItems: "flex-start" }}>
                <textarea className="textarea" style={{ minHeight: 90 }} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
                <MicButton value={purpose} onChange={setPurpose} />
              </div>
              <span className="tiny muted">Must-haves, budget and delivery are edited in the brief panel - each change is saved as a version you can restore.</span>
            </label>
          )}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEdit(false)}>Cancel</button>
            <button className="btn primary" disabled={saving || !title.trim()} onClick={save}>Save</button>
          </div>
        </Modal>
      )}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  );
}
