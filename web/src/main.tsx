import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { installDemo } from "./demo";

installDemo();
import { ToastProvider } from "./components/ui";
import "./styles.css";
import "./shell.css";
import "./v4.css";
import "./v5.css";
import "./home6.css";
import "./stl.css";
import "./v7.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

// Liquid-glass sheen: glass surfaces catch the light where the pointer is.
document.addEventListener(
  "pointermove",
  (e) => {
    const el = (e.target as Element | null)?.closest?.(".card, .glass.sheen, .widget") as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  },
  { passive: true },
);

// PWA: installable app + share target for photos/clips from the phone or smart glasses.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
