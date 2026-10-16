// Capture deck screenshots from the live app (with a fake camera for glasses mode) and print deck/deck.html to PDF.
//   node tools/video/deck_build.mjs <baseUrl> <projectId> <fakeCam.y4m>
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [base, pid, cam] = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const img = path.join(root, "deck", "img");
const args = ["--use-gl=angle", "--ignore-gpu-blocklist", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
if (cam) args.push(`--use-file-for-fake-video-capture=${cam}`);
const browser = await chromium.launch({ args });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ["camera", "microphone"] });
const page = await ctx.newPage();

async function shot(url, name, prep) {
  await page.goto(base + url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Opening your project"), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (prep) await prep();
  await page.screenshot({ path: path.join(img, name) });
  console.log("shot", name);
}

if (pid) {
  await shot("/", "home.png");
  await shot(`/p/${pid}/clarify`, "clarify.png");
  await shot(`/p/${pid}/routes`, "routes.png", async () => {
    await page.evaluate(() => { const c = document.querySelector(".ws-center"); const g = document.querySelectorAll(".group-head")[1]; if (c && g) c.scrollTop = g.offsetTop - 40; });
    await page.waitForTimeout(1500);
  });
  await shot(`/p/${pid}/compare`, "compare.png", async () => {
    await page.evaluate(() => { const c = document.querySelector(".ws-center"); const d = [...document.querySelectorAll(".card.raised")].pop(); if (c && d) c.scrollTop = d.offsetTop - 20; });
    await page.waitForTimeout(1200);
  });
  await shot(`/g/${pid}`, "glasses.png", async () => { await page.waitForTimeout(2500); });
}

// Print the deck.
const deck = await ctx.newPage();
await deck.goto("file:///" + path.join(root, "deck", "deck.html").replace(/\\/g, "/"), { waitUntil: "networkidle" });
await deck.waitForTimeout(1500);
await deck.pdf({ path: path.join(root, "deck", "Project-Tesselle-Pitch-Deck.pdf"), width: "1600px", height: "900px", printBackground: true });
console.log("pdf written");
await browser.close();
