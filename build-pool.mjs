#!/usr/bin/env node
// Build a curated, deduplicated user-agent pool from:
//   1. the pzb/b4b6f57144aea7827ae4 gist (Browsers.json)
//   2. random-useragent's useragent-data.json
// Keeps reasonably modern desktop + mobile strings, plus an evergreen
// generator for current browser versions (2025-2026).
import { readFileSync, writeFileSync } from "node:fs";

const gist = readFileSync(new URL("./user-agents-gist.json", import.meta.url), "utf8")
  .split("\n").map((s) => s.trim()).filter(Boolean);
const ruData = JSON.parse(readFileSync(new URL("./node_modules/random-useragent/useragent-data.json", import.meta.url), "utf8"));
const fromRu = ruData.map((d) => d.userAgent).filter(Boolean);

const raw = [...new Set([...gist, ...fromRu])];

// accept the best strings these older sources can give us
const OK = [
  /Chrome\/[6-9][0-9]\./i, /Chrome\/[1-9][0-9][0-9]\./i, // Chrome 60-199
  /Firefox\/[6-9][0-9]\./i, /Firefox\/[1-9][0-9][0-9]\./i, // Firefox 60-199
  /Edg\/[7-9][0-9]\./i, /Edg\/[1-9][0-9][0-9]\./i,        // Edge 70-199
  /Safari\/\d+\.\d+.*Version\/\d+\.\d/i,                  // any Safari
  /CriOS\//, /FxiOS\//, /Mobile.*Safari/i, /Android/i,
];
const BAD = [
  /Trident/i, /MSIE /i, /Opera Mini/i, /OPR\/[12][0-9]\./i,
  /curl/i, /python/i, /bot/i, /spider/i, /crawl/i, /^[a-z ]*$/i,
  /Chrome\/[0-5][0-9]\./i, /Firefox\/[0-5][0-9]\./i,
  /CPU (?:iPhone )?OS 1[0-6]_/i,   // iOS <= 16 (too old)
  /Android 1[0-3]\./i,             // Android <= 13
];

const pool = raw.filter((ua) => OK.some((re) => re.test(ua)) && !BAD.some((re) => re.test(ua)));
const unique = [...new Set(pool)].sort();

// ---- evergreen generator (current browser lines, desktop-Chromium dominant) ----
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[rnd(0, arr.length - 1)];
function genDesktopChromium() {
  const major = rnd(124, 145);
  const patch = rnd(6000, 7599);        // realistic 3rd component
  const build = rnd(0, 999);            // realistic 4th component
  const os = pick([
    "Windows NT 10.0; Win64; x64",
    "Windows NT 10.0; Win64; x64",
    "Windows NT 10.0; WOW64",
    "Windows NT 10.0; Win64; x64",
    "Macintosh; Intel Mac OS X 10_15_7",
    "Macintosh; Intel Mac OS X 14_6_1",
    "Macintosh; Intel Mac OS X 15_1",
  ]);
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.${patch}.${build} Safari/537.36`;
}
function genOther() {
  const kind = rnd(0, 9);
  const ch = rnd(126, 142);
  const ff = rnd(126, 143);
  const sf = rnd(17, 19);
  const sfP = rnd(0, 6);
  const win = rnd(0, 9) < 7 ? "Windows NT 10.0; Win64; x64" : "Windows NT 10.0";
  const mac = pick(["Macintosh; Intel Mac OS X 10_15_7", "Macintosh; Intel Mac OS X 14_6_1", "Macintosh; Intel Mac OS X 13_5_2", "Macintosh; Intel Mac OS X 12_7_5"]);
  const devices = ["SM-S928B", "Pixel 9", "Pixel 8a", "SM-G998B", "SM-S911B", "Xiaomi 14", "OnePlus 12"];
  const dev = devices[rnd(0, devices.length - 1)];
  const andr = rnd(14, 15);
  const iphone = `Version/${sf}.${sfP} Mobile/15E148 Safari/604.1`;
  switch (kind) {
    case 0: case 1: case 2: // Windows Chrome
      return `Mozilla/5.0 (${win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ch}.0.0.0 Safari/537.36`;
    case 3: // Windows Edge
      return `Mozilla/5.0 (${win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ch}.0.0.0 Safari/537.36 Edg/${ch}.0.0.0`;
    case 4: case 5: // macOS Chrome
      return `Mozilla/5.0 (${mac}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ch}.0.0.0 Safari/537.36`;
    case 6: // macOS Safari
      return `Mozilla/5.0 (${mac}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${sf}.${sfP} Safari/605.1.15`;
    case 7: // Windows Firefox
      return `Mozilla/5.0 (${win}; rv:${ff}.0) Gecko/20100101 Firefox/${ff}.0`;
    case 8: // Android Chrome
      return `Mozilla/5.0 (Linux; Android ${andr}; ${dev}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ch}.0.0.0 Mobile Safari/537.36`;
    default: // iPhone Safari
      return `Mozilla/5.0 (iPhone; CPU iPhone OS ${sf}_${sfP} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${iphone}`;
  }
}

const generated = [
  ...Array.from({ length: 600 }, genDesktopChromium),
  ...Array.from({ length: 40 }, genOther),
];
const all = [...new Set([...unique, ...generated])].sort();

writeFileSync(new URL("./user-agents.json", import.meta.url), JSON.stringify(all, null, 2) + "\n");
const isDesktop = (u) => !/Mobile|Android|iPhone|iPad|CriOS|FxiOS/i.test(u);
console.log(`raw candidates        : ${raw.length}`);
console.log(`from sources (filtered): ${unique.length}`);
console.log(`generated (fresh)      : ${generated.length}`);
console.log(`TOTAL pool             : ${all.length}`);
console.log(`  desktop ${all.filter(isDesktop).length} | mobile ${all.filter((u) => !isDesktop(u)).length}`);
