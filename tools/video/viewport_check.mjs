// Screenshot key pages at several viewport sizes: node viewport_check.mjs <base> <outDir> <pid>
import { chromium } from "playwright";
const [base, out, pid] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
for (const [w, h, tag, mobile] of [[1600, 900, "1600", false], [1920, 1080, "1920", false], [390, 844, "m", true]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", tag, e.message));
  await p.goto(base + "/", { waitUntil: "networkidle" }); await p.waitForTimeout(5200);
  await p.screenshot({ path: `${out}/vp-home-${tag}.png` });
  await p.goto(`${base}/p/${pid}/compare`, { waitUntil: "networkidle" }); await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}/vp-ws-${tag}.png` });
  if (mobile) { await p.goto(`${base}/m/${pid}`, { waitUntil: "networkidle" }); await p.waitForTimeout(3000); await p.screenshot({ path: `${out}/vp-phone-${tag}.png` }); }
  await ctx.close();
}
await b.close();
console.log("done");
