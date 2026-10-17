// Runs the in-app guided demo (it drives itself) in headless Chromium and snapshots it.
//   node tools/video/pilot_check.mjs <baseUrl> <outDir> [record]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [base = "http://127.0.0.1:8080", out = "pilot", record = ""] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const W = 1600, H = 900;
const browser = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, ...(record ? { recordVideo: { dir: out, size: { width: W, height: H } } } : {}) });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text().slice(0, 200)));
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await page.getByRole("button", { name: /Launch the guided demo/ }).first().click();
await page.waitForURL(/\/p\/prj_/, { timeout: 60000 });
log("project " + page.url());
let n = 0, lastCap = "", done = false;
while (Date.now() - t0 < 16 * 60 * 1000) {
  await page.waitForTimeout(6000);
  const cap = await page.locator(".pilot-card .pc-t").textContent({ timeout: 1000 }).catch(() => null);
  const still = await page.locator(".pilot-card").count();
  if (cap && cap !== lastCap) { log("caption: " + cap); lastCap = cap; }
  n++;
  await page.screenshot({ path: path.join(out, `p-${String(n).padStart(3, "0")}.png`) });
  if (!still && n > 3) { log("pilot finished (card gone)"); done = true; break; }
}
log("url " + page.url());
fs.writeFileSync(path.join(out, "errors.txt"), errors.join("\n"));
console.log("errors:", errors.length, errors.slice(0, 8));
await ctx.close();
await browser.close();
