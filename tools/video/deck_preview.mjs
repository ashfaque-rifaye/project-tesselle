// Screenshot each deck slide for review: node tools/video/deck_preview.mjs
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto("file:///" + path.join(root, "deck", "deck.html").replace(/\\/g, "/"), { waitUntil: "networkidle" });
await p.waitForTimeout(1200);
let i = 0;
for (const s of await p.locator(".slide").all()) {
  i++;
  await s.screenshot({ path: path.join(root, "tools", "logs", "shots", `deck-${String(i).padStart(2, "0")}.png`) });
}
console.log("slides", i);
await b.close();
