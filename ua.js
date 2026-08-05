// User-agent pool helper. Pool built from the pzb Browsers.json gist,
// random-useragent dataset, and a fresh-version generator (see build-pool.mjs).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const pool = JSON.parse(readFileSync(new URL("./user-agents.json", import.meta.url), "utf8"));

const isDesktop = (u) => !/Mobile|Android|iPhone|iPad|CriOS|FxiOS/i.test(u);
const isChromium = (u) => /Chrome\/\d+/i.test(u) && !/Edg\//i.test(u);
const desktop = pool.filter(isDesktop);
const desktopChromium = desktop.filter(isChromium);
const desktopOther = desktop.filter((u) => !isChromium(u));
const mobile = pool.filter((u) => !isDesktop(u));

// weighted pick: 70% modern desktop (prefer chromium line), 30% mobile
export function pickUA(seed) {
  const arr = (Math.random() < 0.7 ? desktopChromium : Math.random() < 0.5 ? desktopOther : mobile) || desktop;
  return arr[Math.floor(Math.random() * arr.length)] || pool[0];
}

export function randomUA() {
  return pickUA();
}

// deterministic UA for a given profile id -> sticky fingerprint per session
export function seededUA(seed) {
  const h = createHash("md5").update(String(seed)).digest();
  const list = h[0] % 10 < 7 ? desktopChromium : h[1] % 10 < 5 ? desktopOther : mobile;
  return list[h[2] % list.length];
}

// deterministic MODERN DESKTOP CHROMIUM UA — safest against CF/fingerprint
// checks and the least likely to be flagged on the VC login flow.
export function seededDesktopUA(seed) {
  const h = createHash("md5").update(String(seed)).digest();
  return desktopChromium[h[2] % desktopChromium.length];
}

// Fresh desktop-Chromium UA per check, generated to match the real engine:
// the major version is pinned to the installed /usr/bin/chromium so the
// sec-ch-ua client hints (which the browser sends from its true version) stay
// consistent with the UA string. OS platform + patch/build vary per call, and
// the last few UAs are not repeated immediately.
const ENGINE_MAJOR = "151"; // matches /usr/bin/chromium 151.0.7922.71
const UA_OS = [
  { ua: "Windows NT 10.0; Win64; x64", platform: "Win32" },
  { ua: "Windows NT 10.0; Win64; x64", platform: "Win32" },
  { ua: "Windows NT 10.0; WOW64", platform: "Win32" },
  { ua: "Macintosh; Intel Mac OS X 10_15_7", platform: "MacIntel" },
  { ua: "Macintosh; Intel Mac OS X 14_6_1", platform: "MacIntel" },
  { ua: "X11; Linux x86_64", platform: "Linux x86_64" },
];
let lastFreshUA = [];
export function freshDesktopUA() {
  let ua, platform;
  let guard = 0;
  do {
    const os = UA_OS[Math.floor(Math.random() * UA_OS.length)];
    const patch = 7000 + Math.floor(Math.random() * 900);
    const build = Math.floor(Math.random() * 1000);
    ua = `Mozilla/5.0 (${os.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ENGINE_MAJOR}.0.${patch}.${build} Safari/537.36`;
    platform = os.platform;
  } while (lastFreshUA.includes(ua) && guard++ < 30);
  lastFreshUA.push(ua);
  if (lastFreshUA.length > 20) lastFreshUA.shift();
  return { ua, platform };
}

export { pool };
