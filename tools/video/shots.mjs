// Visual QA: capture screenshots of key screens with headless Chromium.
//   node tools/video/shots.mjs <baseUrl> <outDir> [projectId]
import { chromium } from "playwright";

const [base = "http://127.0.0.1:8080", out = "shots", pid] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

async function shot(path, name, wait = 2500, fn) {
  await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
  if (fn) await fn();
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log("shot", name);
}

await shot("/", "01-home", 3000);
await shot("/", "02-home-scrolled", 1500, async () => { await page.mouse.wheel(0, 1000); await page.waitForTimeout(1500); });
await shot("/", "03-home-mid", 1500, async () => { await page.mouse.wheel(0, 2200); await page.waitForTimeout(1500); });
for (const [y, n] of [[1150, "04-home-dash"], [3000, "05-home-devices"], [3900, "06-home-stack"]]) {
  await shot("/", n, 1200, async () => { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(400); await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(1600); });
}
if (pid) {
  for (const s of ["inspire", "clarify", "visualise", "routes", "request", "compare", "approve", "fulfil", "accept"]) {
    await shot(`/p/${pid}/${s}`, `p-${s}`, 2500);
  }
  await shot(`/m/${pid}`, "phone", 4000);
  await shot(`/g/${pid}`, "glasses", 2000);
}
await browser.close();
