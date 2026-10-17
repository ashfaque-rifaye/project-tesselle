// Voice orb end-to-end check with a fake microphone: node voice_check.mjs <base> <pid> <speech.wav> <out.png>
// Chrome plays the WAV file as the microphone; the script taps the orb and records what the agent heard,
// said and did.
import { chromium } from "playwright";
const [base, pid, wav, shot] = process.argv.slice(2);
const b = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`, "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
p.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
await p.goto(`${base}/p/${pid}/clarify`, { waitUntil: "domcontentloaded" });
await p.waitForSelector(".vorb-btn", { timeout: 30000 });
await p.waitForTimeout(2500);
await p.click(".vorb-btn");
const seen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 45000) {
  const s = await p.evaluate(() => ({
    mode: document.querySelector(".vorb")?.className || "",
    cap: document.querySelector(".vorb-cap")?.textContent || "",
    path: location.pathname,
  }));
  const k = `${s.mode} | ${s.cap} | ${s.path}`;
  if (!seen.has(k)) { seen.add(k); console.log(((Date.now() - t0) / 1000).toFixed(1), k); }
  await p.waitForTimeout(400);
}
await p.screenshot({ path: shot });
await b.close();
console.log("done");
