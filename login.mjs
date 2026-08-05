#!/usr/bin/env node
// Vestiaire Collective login via Webshare proxy + Chromium (handles Cloudflare managed challenge).
// Credentials come ONLY from env vars VC_EMAIL / VC_PASSWORD (or CLI flags). Never from the leaked dump.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { seededUA } from "./ua.js";
import { listProxiesPickable, proxyFromEntry } from "./proxy.js";

// ---------- config ----------
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const EMAIL = opt("email") || process.env.VC_EMAIL || process.env.WEBSHARE_ACCOUNT_EMAIL;
const PASSWORD = opt("password") || process.env.VC_PASSWORD;
const COUNTRY = (opt("country") || process.env.VC_PROXY_COUNTRY || "").toLowerCase();
const HEADFUL = args.includes("--headful") || process.env.VC_HEADFUL === "1";
const DRY = args.includes("--dry");
const FRESH = args.includes("--fresh");
const STATE_FILE = "/home/a3ca4608227d/test/vc-login/vc-state.json";
const PROFILE_FILE = "/home/a3ca4608227d/test/vc-login/vc-profile.json";
const SHOT_DIR = "/tmp/opencode";

if (!EMAIL || !PASSWORD) {
  console.error("VC_EMAIL and VC_PASSWORD must be set (env vars) — they are your OWN account credentials.");
  process.exit(2);
}
if (DRY) console.log("[dry-run] testing the pipeline; login result will not be real.");

// ---------- profile: keep UA + proxy stable per session (less fingerprint churn) ----------
let profile = !FRESH && existsSync(PROFILE_FILE) ? JSON.parse(readFileSync(PROFILE_FILE, "utf8")) : null;
const profileId = profile ? profile.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const userAgent = opt("ua") || profile?.ua || seededUA(profileId);
const LOGIN_URL = "https://us.vestiairecollective.com/login/";

// ---------- proxy candidates ----------
// The WAF blocks the apiv2 email/check call from most data-center IPs, so we
// probe exit IPs and keep the first one that shows the real password step.
const isCustom = Boolean(process.env.VC_PROXY_HOST);
const candidates = isCustom
  ? [{
      server: `http://${process.env.VC_PROXY_HOST}:${process.env.VC_PROXY_PORT}`,
      username: process.env.VC_PROXY_USER,
      password: process.env.VC_PROXY_PASS,
      label: "custom",
    }]
  : listProxiesPickable(COUNTRY).map(proxyFromEntry);
if (!isCustom && profile?.proxy) {
  const ip = (profile.proxy.server || "").replace(/^https?:\/\//, "").split(":")[0];
  const idx = candidates.findIndex((c) => c.server.includes(`://${ip}:`));
  if (idx > 0) candidates.unshift(candidates.splice(idx, 1)[0]);
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitOutChallenge(page, maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const t = await page.title().catch(() => "");
    if (!t.toLowerCase().includes("just a moment")) return true;
    await sleep(1500);
  }
  return false;
}

// TrustArc privacy overlay renders as an EMPTY div in headless and blocks clicks.
// Remove it (no consent UI exists to accept) and drop the body scroll-lock classes.
async function dismissPrivacy(page) {
  await page.evaluate(() => {
    const ov = document.querySelector("#privacy-overlay");
    if (ov) ov.remove();
    document.body.classList.remove("tc-modal-open", "scroll-lock");
    document.documentElement.style.overflow = "";
  }).catch(() => {});
}

// Full login attempt through a candidate proxy. Returns a classified result:
//   status "success"          -> logged in, cookies available
//   status "success-already"  -> restored session was already valid
//   status "definitive"       -> account/credentials verdict (stop the loop)
//   status "dry"              -> --dry-run reached the password step
//   status "transient"        -> WAF/network flake, try the next proxy
async function attemptLogin(browser, proxyCfg) {
  const ctx = await browser.newContext({ userAgent, locale: "en-US", viewport: { width: 1366, height: 900 }, proxy: proxyCfg });
  ctx.setDefaultTimeout(25000);
  if (!FRESH && existsSync(STATE_FILE)) {
    await ctx.addCookies(JSON.parse(readFileSync(STATE_FILE, "utf8"))).catch(() => {});
  }
  const page = await ctx.newPage();
  const res = { status: "transient", reason: "", api: null, ctx, page };
  page.on("response", (r) => { if (r.url().includes("/accounts/email/check")) res.api = r.status(); });

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    res.reason = /ERR_HTTP_RESPONSE_CODE_FAILURE/.test(e.message) ? "document-blocked" : (e.message || "").split("\n")[0].slice(0, 80);
    return res;
  }
  if (!(await waitOutChallenge(page))) { res.reason = "cloudflare-unresolved"; return res; }
  await sleep(2500);
  await dismissPrivacy(page);

  const emailInput = page.locator("input[name=email]");
  if (!(await emailInput.count()) || !(await emailInput.first().isVisible().catch(() => false))) {
    const alreadyIn = (await page.locator("[data-cy=user-login]").count()) === 0;
    if (alreadyIn && !/\/login\/?$/.test(new URL(page.url()).pathname)) {
      res.status = "success-already";
      return res;
    }
    res.reason = "no-email-input url=" + page.url().slice(0, 60);
    return res;
  }
  await emailInput.first().fill(EMAIL);
  await dismissPrivacy(page);
  await page.locator("[data-cy=authentication__cta]").click();

  // disambiguate login (password step) vs registration (firstname step)
  const t0 = Date.now();
  let pw = null;
  while (Date.now() - t0 < 15000) {
    if (await page.locator("input[name=firstname]").count()) { res.status = "definitive"; res.reason = "not-registered"; return res; }
    pw = page.locator("input[type=password]:not(#registerPassword)").first();
    if (await pw.isVisible().catch(() => false)) break;
    await sleep(700);
  }
  if (!pw || !(await pw.isVisible().catch(() => false))) { res.reason = "no-password-step"; return res; }

  await pw.fill(PASSWORD);
  if (DRY) { res.status = "dry"; return res; }
  await dismissPrivacy(page);
  await pw.press("Enter").catch(() => {});
  await page.locator("[data-cy=authentication__cta]").click();

  const loggedIn = await page
    .waitForURL((u) => !/\/login\/?$/.test(u.pathname), { timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  await sleep(1500);

  if (!loggedIn) {
    const errText = await page.evaluate(() =>
      [...document.querySelectorAll("[data-cy], [role=alert], [class*=error], [class*=message]")]
        .map((e) => (e.innerText || "").trim())
        .filter((t) => /(incorrect|wrong|invalid|error|fail|not (recogni|found)|unable|try again)/i.test(t))
        .slice(0, 2)
    );
    const joined = errText.join(" | ").toLowerCase();
    if (/incorrect|wrong|invalid|unable to sign in/.test(joined)) {
      res.status = "definitive";
      res.reason = "bad-credentials: " + (errText[0] || "");
    } else {
      res.reason = "no-navigation " + (errText[0] || "");
    }
    return res;
  }

  const stillSignedOut = await page.locator("[data-cy=user-login]").isVisible().catch(() => true);
  if (stillSignedOut) { res.reason = "redirected-but-no-user-menu"; return res; }

  res.status = "success";
  res.url = page.url();
  res.cookies = await ctx.cookies();
  return res;
}

// ---------- run ----------
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: !HEADFUL,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let final = null;
let n = 0;
for (const cand of candidates) {
  n++;
  const r = await attemptLogin(browser, cand);
  const verdict = r.status === "success" ? "SUCCESS" : r.status === "success-already" ? "already-logged-in" : r.reason;
  console.log(`[${n}/${candidates.length}] ${cand.label}: ${verdict}${r.api ? " api=" + r.api : ""}`);
  if (r.status === "success" || r.status === "success-already") { final = r; break; }
  if (r.status === "definitive") {
    await r.ctx.close().catch(() => {});
    const msg = r.reason === "not-registered"
      ? `FAIL: ${EMAIL} is not a registered account (site showed sign-up form).`
      : `FAIL: ${r.reason}`;
    console.log(msg);
    await browser.close();
    process.exit(1);
  }
  if (r.status === "dry") {
    console.log("[dry-run] password step reached and filled — not submitting.");
    await browser.close();
    process.exit(0);
  }
  await r.ctx.close().catch(() => {});
  await sleep(1500);
}

if (!final) {
  console.log("FAIL: no usable proxy completed the login (all transient).");
  await browser.close();
  process.exit(1);
}

const { ctx, page } = final;
profile = { id: profileId, ua: userAgent, proxy: candidates[n - 1] };
writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
console.log(`profile ${profileId.slice(0, 8)} — UA + working proxy locked`);
console.log(`ua   : ${userAgent.slice(0, 90)}`);
console.log(`proxy: ${candidates[n - 1].label}`);
if (COUNTRY) console.log(`country filter: ${COUNTRY}`);

if (final.status === "success") {
  writeFileSync(STATE_FILE, JSON.stringify(final.cookies, null, 2));
  console.log(`SUCCESS: logged in as ${EMAIL}`);
  console.log(`final URL: ${final.url}`);
  console.log(`cookies saved: ${STATE_FILE}`);
} else {
  writeFileSync(STATE_FILE, JSON.stringify(await ctx.cookies(), null, 2));
  console.log(`SUCCESS: restored session still valid (${page.url()})`);
  console.log(`cookies refreshed: ${STATE_FILE}`);
}
await browser.close();
process.exit(0);
