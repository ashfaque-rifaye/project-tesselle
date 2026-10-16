// Render the PWA icons (maskable: full-bleed background, gem inside the safe zone) from the brand mark.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gem = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 10 40 44" width="100%" height="100%"><g stroke="#0a1416" stroke-width="1.1" stroke-linejoin="round"><path d="M32 12 49.3 22 32 32Z" fill="#f2ffc4"/><path d="M49.3 22v20L32 32Z" fill="#d7ff3c"/><path d="M49.3 42 32 52V32Z" fill="#a9d11e"/><path d="M32 52 14.7 42 32 32Z" fill="#7f9f12"/><path d="M14.7 42V22L32 32Z" fill="#c3f02a"/><path d="M14.7 22 32 12v20Z" fill="#e6ff8f"/></g></svg>`;
const b = await chromium.launch();
for (const size of [192, 512]) {
  const p = await (await b.newContext({ viewport: { width: size, height: size } })).newPage();
  await p.setContent(`<body style="margin:0"><div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#2a4a4f,#0a1416 70%)"><div style="width:${size * 0.5}px;height:${size * 0.55}px;filter:drop-shadow(0 ${size / 40}px ${size / 16}px rgba(215,255,60,.35))">${gem}</div></div></body>`);
  await p.screenshot({ path: path.join(root, "web", "public", "icons", `icon-${size}.png`) });
  console.log("icon", size);
}
await b.close();
