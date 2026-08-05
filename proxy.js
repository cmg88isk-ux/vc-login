// Webshare proxy helpers: load .env, fetch the allocated IP list via the CLI
// and pick one. Also tracks the IP health state used by the VC verify pipeline:
//   vc-blocked.json  -> IPs the target site refuses (WAF/CF), written by
//                       check-proxies.mjs / probe-login-ips.mjs
//   vc-healthy.json  -> IPs that pass the email/check step (probe-login-ips.mjs)
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
// Resolve repo resources (webshare binary, .env) from the module dir first,
// falling back to the parent dir. On this machine the binary/.env live in
// ../bin and ../.env; from a fresh checkout they live at the repo root.
const ROOT = existsSync(`${MODULE_DIR}bin/webshare`) ? MODULE_DIR : fileURLToPath(new URL("../", import.meta.url));
const CLI = `${ROOT}bin/webshare`;
const ENV_FILE = existsSync(`${ROOT}.env`) ? `${ROOT}.env` : `${MODULE_DIR}../.env`;
const BLOCKED_FILE = fileURLToPath(new URL("./vc-blocked.json", import.meta.url));
const HEALTHY_FILE = fileURLToPath(new URL("./vc-healthy.json", import.meta.url));

// Load ../.env so scripts work without manual `source .env`. Existing env wins.
function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const raw of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

function readSet(file) {
  try {
    if (!existsSync(file)) return new Set();
    const d = JSON.parse(readFileSync(file, "utf8"));
    return new Set(Array.isArray(d) ? d : []);
  } catch {
    return new Set();
  }
}

// IPs flagged by the target site (populated by check-proxies.mjs / probe).
export function blockedSet() {
  return readSet(BLOCKED_FILE);
}

// IPs that pass the VC email/check step (populated by probe-login-ips.mjs).
export function healthySet() {
  return readSet(HEALTHY_FILE);
}

// Persist the health state so it survives across runs. IPs move between the
// two sets when the WAF blocks them or they recover (auto reconciliation).
export function saveHealth(healthyIPs, blockedIPs) {
  try {
    writeFileSync(HEALTHY_FILE, JSON.stringify([...healthyIPs].sort(), null, 2));
    writeFileSync(BLOCKED_FILE, JSON.stringify([...blockedIPs].sort(), null, 2));
  } catch {
    // never fatal
  }
}

export function listProxies() {
  const out = execSync(`${CLI} proxies list --json`, {
    env: { ...process.env, WEBSHARE_API_KEY: process.env.WEBSHARE_API_KEY },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

// Proxies known to be healthy (pass email/check) and not blocklisted.
export function healthyProxies() {
  const healthy = healthySet();
  if (!healthy.size) return [];
  const blocked = blockedSet();
  return listProxies().filter((p) => healthy.has(p.proxy_address) && !blocked.has(p.proxy_address));
}

// Candidates for an exit IP: excludes blocklisted, honors the country filter.
export function listProxiesPickable(country = "") {
  const blocked = blockedSet();
  let list = listProxies().filter((p) => !blocked.has(p.proxy_address));
  if (!list.length) list = listProxies();
  if (country) {
    const matches = list.filter((p) => p.country_code.toLowerCase() === country.toLowerCase());
    if (matches.length) list = matches;
  }
  return list;
}

export function proxyFromEntry(p) {
  return {
    server: `http://${p.proxy_address}:${p.port}`,
    username: p.username,
    password: p.password,
    label: `${p.country_code} ${p.proxy_address}:${p.port}`,
  };
}

// Per the Webshare docs, the whole proxy list can only be replaced on demand
// when the plan has on_demand_refreshes_available > 0. The free plan has 0.
export function onDemandRefreshAvailable() {
  try {
    const out = execSync(`${CLI} account --json`, { env: { ...process.env }, encoding: "utf8" });
    return (JSON.parse(out).plan?.on_demand_refreshes_available || 0) > 0;
  } catch {
    return false;
  }
}

// Replaces every proxy IP in the plan (consumes one on-demand refresh).
export function refreshProxyList() {
  execSync(`${CLI} proxies refresh -y`, { env: { ...process.env }, encoding: "utf8" });
}

export function pickProxy(country = "") {
  const pool = listProxiesPickable(country);
  return proxyFromEntry(pool[Math.floor(Math.random() * pool.length)]);
}

// Last-24h usage gauge (free plan = 1 GB/month). Never print the raw API key.
export function bandwidthUsage() {
  try {
    const out = execSync(`${CLI} stats --since 24h --json`, {
      env: { ...process.env },
      encoding: "utf8",
    });
    const d = JSON.parse(out);
    return { totalBytes: d.bandwidth_total || 0, requests: d.requests_total || 0 };
  } catch {
    return { totalBytes: 0, requests: 0 };
  }
}
