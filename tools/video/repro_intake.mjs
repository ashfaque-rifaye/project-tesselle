// Diagnose the intake stream in a real browser: logs console, failed requests and toasts as they happen.
import { chromium } from "playwright";
const base = process.argv[2];
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
p.on("console", (m) => log(`console.${m.type()}: ${m.text().slice(0, 200)}`));
p.on("requestfailed", (r) => log(`FAILED ${r.method()} ${r.url().slice(-70)} ${r.failure()?.errorText}`));
p.on("response", (r) => r.url().includes("/inspiration") && log(`response ${r.status()} ${r.url().slice(-40)}`));
p.on("requestfinished", (r) => r.url().includes("/inspiration") && log(`finished ${r.url().slice(-40)}`));
await p.goto(base + "/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
log("home loaded");
await p.getByRole("button", { name: /Launch the guided demo/ }).first().click();
await p.waitForURL(/\/p\/prj_/, { timeout: 30000 });
log("workspace " + p.url());
await p.waitForTimeout(1500);
await p.getByRole("button", { name: /Use the demo inspiration/ }).click();
await p.waitForTimeout(1500);
await p.getByRole("button", { name: /Use this inspiration/ }).click();
log("submitted");
for (let i = 0; i < 45; i++) {
  await p.waitForTimeout(2000);
  const toast = await p.locator(".toast").innerText().catch(() => null);
  if (toast) log("TOAST: " + toast);
  const lines = await p.locator(".progress-line").allInnerTexts().catch(() => []);
  if (i % 5 === 0) log("progress: " + JSON.stringify(lines));
  if (p.url().includes("clarify")) { log("REACHED CLARIFY"); break; }
}
await b.close();
process.exit(0);
