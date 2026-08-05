#!/usr/bin/env node
// Polite crawler for vestiairecollective.com reusing the login session.
// Anti-ban: sticky UA+proxy profile, random human delays, proxy rotation +
// exponential backoff on 403/429, Cloudflare challenge handling.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pickProxy } from "./proxy.js";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const URLs = args.filter((a) => a.startsWith("http"));
const DELAY_MIN = Number(opt("delay-min") || process.env.VC_DELAY_MIN || 4);
const DELAY_MAX = Number(opt("delay-max") || process.env.VC_DELAY_MAX || 9);
const COUNTRY = opt("country") || process.env.VC_PROXY_COUNTRY || "";
const SELECTOR = opt("selector") || "";
const HEADFUL = args.includes("--headful");
const STATE_FILE = "/home/a3ca4608227d/test/vc-login/vc-state.json";
const PROFILE_FILE = "/home/a3ca4608227d/test/vc-login/vc-profile.json";

if (!URLs.length) {
  console.error("usage: node scrape.mjs <url>... [--selector .css] [--delay-min 4] [--delay-max 9] [--country us]");
  process.exit(2);
}
if (!existsSync(PROFILE_FILE)) {
  console.error("no profile yet — run login.mjs first to establish a session.");
  process.exit(2);
}

const profile = JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
const { ua } = profile;
const cookies = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);

async function waitOutChallenge(page, maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const t = await page.title().catch(() => "");
    if (!t.toLowerCase().includes("just a moment")) return true;
    await sleep(1500);
  }
  return false;
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: !HEADFUL,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let proxy = profile.proxy;
let attempt = 0;
let context = null;
async function makeContext() {
  context = await browser.newContext({
    userAgent: ua,
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    proxy,
  });
  if (cookies.length) await context.addCookies(cookies);
  return context;
}
await makeContext();

const results = [];
for (const url of URLs) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const t0 = Date.now();
  let ok = false;
  for (let retries = 0; retries < 3 && !ok; retries++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const status = resp ? resp.status() : 0;
      await waitOutChallenge(page);
      await page.waitForTimeout(1200);
      if (status === 403 || status === 429) throw new Error(`HTTP ${status}`);
      ok = true;
      const data = await page.evaluate(
        ([sel]) => {
          const schemaEl = document.querySelector("[data-cy^='product-schema-']");
          let product;
          if (schemaEl) {
            try {
              const s = JSON.parse(schemaEl.innerText);
              const o = s.offers || {};
              product = {
                name: s.name,
                brand: s.brand?.name,
                sku: s.sku,
                category: s.category,
                color: s.color,
                material: s.material,
                description: s.description,
                price: o.price,
                currency: o.priceCurrency,
                condition: (o.itemCondition || "").replace("https://schema.org/", ""),
                availability: (o.availability || "").replace("https://schema.org/", ""),
                seller: o.seller?.name,
                sellerUrl: o.seller?.url,
                image: s.image?.contentUrl || s.image,
                url: s["@id"],
              };
            } catch {}
          }
          return {
            url: location.href,
            title: document.title,
            h1: (document.querySelector("h1")?.innerText || "").trim().slice(0, 120),
            product,
            text: (sel && document.querySelector(sel)?.innerText) || undefined,
            snippet: (document.body?.innerText || "").slice(0, 300).replace(/\n+/g, " | "),
          };
        },
        [SELECTOR]
      );
      data.status = status;
      results.push({ target: url, ok: true, ms: Date.now() - t0, ...data });
      console.log(`OK   ${status} ${url} — ${data.title.slice(0, 60)} (${Date.now() - t0}ms)`);
      if (data.product) console.log(`     ${data.product.brand || "?"} | ${data.product.name || "?"} | ${data.product.price} ${data.product.currency}`);
    } catch (e) {
      console.log(`RETRY ${attempt + 1} ${url} — ${e.message.split("\n")[0]}`);
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      // rotate proxy + backoff (2s, 4s, 8s …)
      const wait = Math.min(1000 * 2 ** (attempt + 1), 15000);
      attempt++;
      console.log(`  rotate proxy -> ${(proxy = pickProxy(COUNTRY)).label} | backoff ${wait}ms`);
      await sleep(wait);
      await makeContext();
      break; // new page next loop iteration
    }
  }
  if (ok) await page.close().catch(() => {});
  const d = jitter();
  console.log(`  ... pause ${d.toFixed(1)}s`);
  await sleep(d * 1000);
}

writeFileSync("/tmp/opencode/scrape_results.json", JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${URLs.length} fetched | full JSON in /tmp/opencode/scrape_results.json`);
await browser.close();
process.exit(0);
