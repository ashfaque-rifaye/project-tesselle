// Screenshot every stage of a project at phone and laptop sizes: node qa_stages.mjs <base> <outDir> <pid>
import { chromium } from "playwright";
import fs from "node:fs";
const [base, out, pid] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const stages = ["inspire", "clarify", "visualise", "routes", "request", "compare", "approve", "fulfil", "accept"];
const b = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
for (const [w, h, tag, mobile] of [[390, 844, "m", true], [1280, 800, "l", false]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", tag, e.message));
  await p.goto(base + "/", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(4500);
  await p.screenshot({ path: `${out}/${tag}-00-home.png` });
  let i = 1;
  for (const s of stages) {
    await p.goto(`${base}/p/${pid}/${s}`, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => !document.body.innerText.includes("Opening your project"), null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(2200);
    await p.screenshot({ path: `${out}/${tag}-${String(i++).padStart(2, "0")}-${s}.png` });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) console.log("H-OVERFLOW", tag, s, overflow);
  }
  if (mobile) {
    await p.goto(`${base}/m/${pid}`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(3000);
    await p.screenshot({ path: `${out}/${tag}-99-phone.png` });
  }
  await ctx.close();
}
await b.close();
console.log("done");
