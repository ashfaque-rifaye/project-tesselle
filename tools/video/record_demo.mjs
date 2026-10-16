// Records a real walkthrough of the live app (the 10-beat storyboard + glasses capture) with Playwright.
// Writes raw.webm and timeline.json (beat marks + agent-wait spans) for compose_video.py.
//   node tools/video/record_demo.mjs <baseUrl> <outDir> <fakeCamera.y4m>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [base = "https://project-tesselle.web.app", out = "video-out", fakeCam = ""] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const W = 1600, H = 900;

const args = ["--use-gl=angle", "--ignore-gpu-blocklist", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
if (fakeCam) args.push(`--use-file-for-fake-video-capture=${fakeCam}`);
const browser = await chromium.launch({ args });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: out, size: { width: W, height: H } }, permissions: ["camera", "microphone"] });

// Visible cursor + click ripple (Playwright recordings have no cursor).
await ctx.addInitScript(() => {
  const mk = () => {
    if (document.getElementById("__cursor")) return;
    const c = document.createElement("div");
    c.id = "__cursor";
    Object.assign(c.style, { position: "fixed", left: "0px", top: "0px", width: "22px", height: "22px", borderRadius: "50%", border: "2px solid #d7ff3c", background: "rgba(215,255,60,.18)", boxShadow: "0 0 14px rgba(215,255,60,.75)", zIndex: 2147483647, pointerEvents: "none", transform: "translate(-50%,-50%)", transition: "width .12s, height .12s" });
    document.documentElement.appendChild(c);
    document.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    document.addEventListener("mousedown", () => { c.style.width = "34px"; c.style.height = "34px"; }, true);
    document.addEventListener("mouseup", () => { c.style.width = "22px"; c.style.height = "22px"; }, true);
  };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", mk) : mk();
});

const page = await ctx.newPage();
const t0 = Date.now();
const timeline = { marks: [], waits: [] };
const now = () => (Date.now() - t0) / 1000;
const mark = (beat) => { timeline.marks.push({ beat, t: now() }); console.log(`[${now().toFixed(1)}] ${beat}`); };
const hold = (s) => page.waitForTimeout(s * 1000);
let pos = { x: W / 2, y: H / 2 };

async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  // Keep targets clear of the floating chat dock and the top bar.
  const moved = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top >= 70 && r.bottom <= innerHeight - 150) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }).catch(() => false);
  if (moved) await page.waitForTimeout(700);
  const b = await locator.boundingBox();
  if (!b) return null;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y, { steps: 22 });
  pos = { x, y };
  return { x, y };
}
async function click(locator, pause = 0.5) {
  await locator.waitFor({ state: "visible", timeout: 60000 });
  const p = await moveTo(locator);
  await hold(0.35);
  if (p) { await page.mouse.down(); await page.mouse.up(); } else await locator.click();
  await hold(pause);
}
async function agentWait(label, fn) {
  const s = now();
  await fn();
  timeline.waits.push({ label, start: s, end: now() });
}
async function smoothScroll(sel, to, ms = 1400) {
  await page.evaluate(([sel, to, ms]) => new Promise((res) => {
    const el = sel ? document.querySelector(sel) : document.scrollingElement;
    const from = el.scrollTop, t1 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t1) / ms); el.scrollTop = from + (to - from) * (1 - Math.pow(1 - k, 3)); k < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  }), [sel, to, ms]);
}
const center = ".ws-center";
async function waitPath(re, opts = {}) {
  const timeout = opts.timeout ?? 60000;
  const t1 = Date.now();
  while (Date.now() - t1 < timeout) {
    if (re.test(page.url())) return;
    await page.waitForTimeout(250);
  }
  throw new Error("waitPath timeout for " + re);
}
const btn = (name) => page.getByRole("button", { name }).first();

try {
  // ---- Home ----
  await page.goto(base, { waitUntil: "networkidle" });
  mark("home");
  await page.mouse.move(W * 0.45, H * 0.6, { steps: 30 });
  await hold(3.5);
  await page.mouse.move(W * 0.62, H * 0.42, { steps: 40 });
  await hold(3);
  await smoothScroll(null, 900, 2200); await hold(2.5);
  await smoothScroll(null, 0, 1500); await hold(0.8);

  // ---- 1. Inspiration ----
  await click(btn(/Launch the guided demo/));
  await waitPath(/\/p\/prj_/, { timeout: 60000 });
  const pid = page.url().match(/prj_[a-z0-9]+/)[0];
  timeline.pid = pid;
  await hold(1.5);
  mark("inspire");
  await click(btn(/Use the demo inspiration/), 2.5);
  await moveTo(page.locator("#idea"));
  await hold(3);
  await click(btn(/Use this inspiration/));
  await agentWait("intake", () => waitPath(/clarify/, { timeout: 180000 }));
  await hold(1.2);

  // ---- 2. Intent ----
  mark("clarify");
  await hold(2);
  await smoothScroll(center, 420, 1800); await hold(2.5);
  await smoothScroll(center, 900, 1500); await hold(1.5);
  await click(btn(/Confirm my brief/));
  await agentWait("confirm", () => waitPath(/visualise/, { timeout: 60000 }));
  await hold(1);

  // ---- 3. Concept ----
  mark("visualise");
  await click(btn(/Render a concept/));
  await agentWait("concept", () => page.locator(".concept-frame img").waitFor({ timeout: 180000 }));
  await page.waitForFunction(() => { const i = document.querySelector(".concept-frame img"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 60000 });
  await hold(1);
  const frame = page.locator(".concept-frame");
  const fb = await frame.boundingBox();
  if (fb) { await page.mouse.move(fb.x + fb.width * 0.62, fb.y + fb.height * 0.45, { steps: 25 }); await page.mouse.down(); await page.mouse.up(); }
  await hold(1.2);
  await page.getByPlaceholder(/What should change|Describe a change/).fill("Make the phone slot a little wider");
  await hold(1.2);
  await click(btn(/Render variation/));
  await agentWait("refine", () => page.locator(".thumbs .thumb").nth(1).waitFor({ timeout: 180000 }));
  await hold(3.5);

  // ---- 4. Existing stock ----
  await click(btn(/Explore fulfilment routes/));
  await waitPath(/routes/);
  mark("routes");
  await click(btn(/^Explore fulfilment routes$/));
  await agentWait("routes", () => page.locator(".offer-grid").first().waitFor({ timeout: 180000 }));
  await hold(3);
  const atelier = page.locator(".offer", { hasText: "Atelier Bamboo Desk Station" });
  await atelier.scrollIntoViewIfNeeded();
  await hold(0.8);
  await click(atelier, 3.5);
  await click(btn(/^Close$/), 0.8);

  // ---- 5. Maker request ----
  mark("request");
  await click(btn(/Request a quote from Kaveri Woodcraft/));
  await agentWait("request-draft", () => page.getByText(/What Kaveri Woodcraft will receive/).waitFor({ timeout: 120000 }));
  await hold(1);
  await smoothScroll(center, 380, 1600); await hold(3.5);
  await click(btn(/Send approved request/));
  await agentWait("maker-round-1", () => waitPath(/compare/, { timeout: 240000 }));
  await page.locator(".decision").first().waitFor({ timeout: 60000 });
  await hold(1);

  // ---- 6. Counteroffer ----
  mark("counteroffer");
  await page.locator(".decision").first().scrollIntoViewIfNeeded();
  await hold(5);

  // ---- 7. Resolution ----
  mark("resolution");
  await click(page.locator(".decision .btn.primary").first());
  // Scoped to the quote card: the status island also mentions "round 2" while the maker works.
  await agentWait("maker-round-2", () => page.locator(".ws-center").getByText(/response · round 2/).first().waitFor({ timeout: 240000 }));
  await page.waitForFunction(() => !document.querySelector(".island.busy"), null, { timeout: 120000 }).catch(() => {});
  await hold(2.5);
  const amber = page.locator(".decision.amber .dbody .btn:not(.primary)").first();
  if (await amber.isVisible().catch(() => false)) {
    await amber.scrollIntoViewIfNeeded(); await hold(2.5);
    await click(amber);
    await agentWait("accept-flexible", () => page.getByRole("button", { name: /Review for approval/ }).waitFor({ timeout: 60000 }));
  }
  await hold(2.5);

  // ---- 8. Device handoff ----
  mark("handoff");
  await click(page.getByRole("button", { name: /^Phone$/ }), 3.5);
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(30, H - 30);
  await hold(0.5);
  await page.goto(`${base}/m/${pid}`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Where you left off/).waitFor();
  await agentWait("recap", () => page.waitForFunction(() => !document.body.innerText.includes("Preparing recap"), null, { timeout: 60000 }));
  await hold(5);

  // ---- 9. Approval ----
  await page.goto(`${base}/p/${pid}/approve`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Review the exact commitment/).waitFor({ timeout: 60000 });
  mark("approve");
  await hold(2);
  await smoothScroll(center, 500, 1600); await hold(1.5);
  for (const cb of await page.locator(".ws-center input[type=checkbox]").all()) { await click(cb, 0.4); }
  await click(btn(/Approve this specification and quote/));
  await agentWait("approve", () => waitPath(/fulfil/, { timeout: 60000 }));
  await hold(2);

  // ---- 10. Fulfilment + aftercare ----
  mark("fulfil");
  for (let i = 0; i < 10; i++) {
    if (await page.getByRole("button", { name: /Open delivery check/ }).isVisible().catch(() => false)) break;
    if (await page.getByRole("button", { name: /Approve sample/ }).isVisible().catch(() => false)) {
      await hold(2.5);
      await click(btn(/Approve sample/));
      await agentWait("sample", () => hold(1.2));
      continue;
    }
    const sim = page.getByRole("button", { name: /Simulate:/ });
    await sim.waitFor({ timeout: 120000 });
    await click(sim, 0.2);
    await agentWait("milestone", () => page.waitForFunction(() => !document.querySelector(".progress-box"), null, { timeout: 120000 }).catch(() => {}));
    await hold(0.6);
  }
  await click(btn(/Open delivery check/));
  await waitPath(/accept/);
  mark("accept");
  await hold(1.5);
  await click(btn(/Use the simulated delivery photo/));
  await agentWait("inspector", () => page.getByRole("button", { name: /Accept the item/ }).waitFor({ timeout: 180000 }));
  await hold(1);
  await smoothScroll(center, 520, 1800); await hold(5);
  await click(btn(/Accept the item/), 2.5);

  // ---- Evidence trace ----
  mark("trace");
  await click(page.getByRole("tab", { name: /Evidence & agent trace/ }), 4.5);

  // ---- Glasses ----
  await page.goto(`${base}/g/${pid}`, { waitUntil: "domcontentloaded" });
  mark("glasses");
  await hold(3);
  await click(page.getByRole("button", { name: /Capture photo/ }));
  await agentWait("glance", () => page.getByText(/^MISSIONLOCK$/).waitFor({ timeout: 180000 }));
  await hold(7);

  // ---- Outro on home ----
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await hold(1);
  mark("outro");
  await page.mouse.move(W * 0.75, H * 0.4, { steps: 40 });
  await hold(6);
} catch (e) {
  console.error("RECORDING ERROR:", e.message);
  await page.screenshot({ path: path.join(out, "error.png") }).catch(() => {});
} finally {
  timeline.end = now();
  const video = page.video();
  await ctx.close();
  const p = await video.path();
  fs.renameSync(p, path.join(out, "raw.webm"));
  fs.writeFileSync(path.join(out, "timeline.json"), JSON.stringify(timeline, null, 2));
  await browser.close();
  console.log("saved", path.join(out, "raw.webm"));
}
