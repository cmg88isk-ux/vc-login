#!/usr/bin/env node
// Probe every allocated Webshare IP against the VC login email/check step and
// persist the verdict to vc-healthy.json / vc-blocked.json.
//
// The WAF (Cloudflare + Datadog fingerprint) 403s the apiv2 email/check call
// from most datacenter IPs, so we must know which exit IPs pass BEFORE any
// real verification run. IPs also recover over time — re-run this any time.
//
//   healthy -> apiv2 .../accounts/email/check answered 200 (password step)
//   blocked -> everything else
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { listProxies, saveHealth } from "./proxy.js";
import { probeLoginIp } from "./probe-ip.mjs";

const EMAIL = process.env.VC_EMAIL || "cryptopasserelle@gmail.com";
const DELAY = Number(process.env.VC_DELAY || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const results = [];

for (const p of listProxies()) {
  const r = await probeLoginIp(browser, p, EMAIL);
  results.push(r);
  console.log(`${r.ok ? "OK   " : "FAIL "} ${r.label} -> step=${r.step} api=${r.api} (${r.ms}ms)${r.apiUrl ? " " + r.apiUrl : ""}${r.why ? " " + r.why : ""}`);
  await sleep(DELAY * 1000);
}

await browser.close();

const healthy = results.filter((r) => r.ok).map((r) => r.ip);
const blocked = results.filter((r) => !r.ok).map((r) => r.ip);
saveHealth(healthy, blocked);
writeFileSync("/tmp/opencode/probe-login-ips.json", JSON.stringify(results, null, 2));

console.log(`\n${healthy.length}/${results.length} IPs pass the email/check step`);
console.log("healthy:", healthy.join(", "));
console.log("blocked:", blocked.join(", ") || "(none)");
process.exit(0);
