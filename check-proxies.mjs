#!/usr/bin/env node
// Health-check every allocated Webshare IP against the VC home page.
// Useful to know which exit IPs are usable / not flagged.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { listProxies } from "./proxy.js";
import { randomUA } from "./ua.js";

const DELAY = Number(process.env.VC_DELAY || 3);
const HOME = "https://us.vestiairecollective.com/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const proxies = listProxies();
const out = [];

for (const p of proxies) {
  const proxy = {
    server: `http://${p.proxy_address}:${p.port}`,
    username: p.username,
    password: p.password,
  };
  const ctx = await browser.newContext({
    userAgent: randomUA(),
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    proxy,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const t0 = Date.now();
  try {
    const resp = await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 30000 });
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      const t = await page.title().catch(() => "");
      if (!t.toLowerCase().includes("just a moment")) break;
      await sleep(1200);
    }
    const title = await page.title().catch(() => "");
    const challenged = title.toLowerCase().includes("just a moment");
    const ok = !challenged && resp && resp.status() === 200;
    console.log(`${ok ? "OK  " : "FAIL"} ${p.country_code} ${p.proxy_address}:${p.port} -> ${challenged ? "blocked (challenge)" : (resp ? resp.status() : "?")} ${title.slice(0, 45)} (${Date.now() - t0}ms)`);
    out.push({ ...p, ok, challenged, status: resp ? resp.status() : 0, title, ms: Date.now() - t0 });
  } catch (e) {
    console.log(`ERR  ${p.country_code} ${p.proxy_address}:${p.port} -> ${e.message.split("\n")[0].slice(0, 60)}`);
    out.push({ ...p, ok: false, challenged: true, status: 0, title: "", ms: Date.now() - t0, error: e.message.split("\n")[0] });
  }
  await ctx.close().catch(() => {});
  await sleep(DELAY * 1000);
}

writeFileSync("/tmp/opencode/proxy_check.json", JSON.stringify(out, null, 2));
const ok = out.filter((o) => o.ok).length;
const blocked = out.filter((o) => !o.ok).map((o) => o.proxy_address);
writeFileSync(new URL("./vc-blocked.json", import.meta.url), JSON.stringify([...new Set(blocked)], null, 2));
console.log(`\n${ok}/${out.length} proxies usable`);
if (blocked.length) console.log(`blocklisted ${blocked.length} IP(s): ${blocked.join(", ")} (saved to vc-blocked.json)`);
await browser.close();
process.exit(0);
