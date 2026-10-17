import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { Link2, Monitor } from "lucide-react";

/** The phone app IS the workspace, in mirror mode: it follows whichever step is open on your computer
 *  (and the other way round), shows the agents' live progress from either device, and has the same voice
 *  agent. On a real phone this opens full screen; on a computer it's shown inside a phone frame. */
export default function Phone() {
  const { pid } = useParams();
  const narrow = window.matchMedia("(max-width: 760px)").matches;
  useEffect(() => {
    if (narrow && pid) window.location.replace(`/p/${pid}?follow=1`);
  }, [narrow, pid]);
  if (narrow || !pid) return null;
  return (
    <div className="phone-wrap">
      <div className="phone" aria-label="Phone app">
        <div className="phone-screen">
          <iframe className="phone-frame" src={`/p/${pid}?follow=1`} title="Tesselle on your phone" allow="microphone; camera; geolocation; clipboard-write" />
        </div>
      </div>
      <div className="phone-aside">
        <span className="chip violet" style={{ alignSelf: "flex-start" }}><Link2 /> Mirror mode</span>
        <h2>One project, every device.</h2>
        <p className="muted">This is the real phone app, live. Open a step on your computer and the phone follows; start an agent on the phone and its progress shows on the computer. The same voice agent and memory (Agent Platform Sessions + Memory Bank) work on both.</p>
        <a className="btn" href={`/p/${pid}`} style={{ alignSelf: "flex-start" }}><Monitor size={15} /> Open on desktop</a>
      </div>
    </div>
  );
}
