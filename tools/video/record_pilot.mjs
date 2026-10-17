// Records the in-app guided demo (it drives itself: live Gemini agents, live web search) for the demo video.
// Writes raw.webm plus timeline.json (caption beats and agent-busy spans, in seconds from the start of the video).
//   node tools/video/record_pilot.mjs <baseUrl> <outDir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [base = "http://127.0.0.1:8080", out = "tools/logs/video"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const W = 1600, H = 900;
const browser = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: out, size: { width: W, height: H } } });
const page = await ctx.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const marks = [], waits = [], errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
marks.push({ beat: "home", t: now(), title: "", text: "" });
await page.getByRole("button", { name: /Launch the guided demo/ }).first().click();
await page.waitForURL(/\/p\/prj_/, { timeout: 60000 });
console.log("project", page.url());

let last = "", busySince = null, seenCard = false;
while (now() < 16 * 60) {
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => ({
    title: document.querySelector(".pilot-card .pc-t")?.textContent || "",
    text: document.querySelector(".pilot-card .pc-d")?.textContent || "",
    card: !!document.querySelector(".pilot-card"),
    busy: !!document.querySelector(".island.busy"),
  })).catch(() => null);
  if (!s) continue;
  if (s.title && s.title !== last) { marks.push({ beat: `b${marks.length}`, t: now(), title: s.title, text: s.text }); last = s.title; console.log(`[${now().toFixed(1)}] ${s.title}`); }
  if (s.busy && busySince === null) busySince = now();
  if (!s.busy && busySince !== null) { waits.push({ start: busySince, end: now() }); busySince = null; }
  if (s.card) seenCard = true;
  if (seenCard && !s.card) break;
}
const end = now();
fs.writeFileSync(path.join(out, "timeline.json"), JSON.stringify({ marks, waits, end, errors }, null, 2));
const video = page.video();
await ctx.close();
await video.saveAs(path.join(out, "raw.webm"));
await browser.close();
console.log("done", end.toFixed(1), "s;", marks.length, "beats;", waits.length, "waits;", errors.length, "errors");
