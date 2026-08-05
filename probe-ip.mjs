// probe-ip.mjs — shared IP health probe used by probe-login-ips.mjs and
// verify-accounts.mjs (auto-recovery of demoted IPs + discovery of new ones).
// An IP is healthy when the apiv2 email/check call answers 200 AND the
// password step renders (i.e. the WAF let the registered-account flow through).
import { seededDesktopUA } from "./ua.js";
import { proxyFromEntry } from "./proxy.js";

const LOGIN_URL = "https://us.vestiairecollective.com/login/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function probeLoginIp(browser, entry, email = "cryptopasserelle@gmail.com") {
  const label = `${entry.country_code} ${entry.proxy_address}:${entry.port}`;
  let ctx;
  try {
    ctx = await browser.newContext({
      userAgent: seededDesktopUA("probe-" + entry.proxy_address),
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
      proxy: proxyFromEntry(entry),
    });
    ctx.setDefaultTimeout(12000);
    const page = await ctx.newPage();
    let api = null;
    let apiUrl = "";
    page.on("response", (r) => {
      if (r.url().includes("/accounts/email/check")) { api = r.status(); apiUrl = r.url().slice(0, 80); }
    });
    const t0 = Date.now();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    const c0 = Date.now();
    while (Date.now() - c0 < 45000) {
      const t = await page.title().catch(() => "");
      if (!t.toLowerCase().includes("just a moment")) break;
      await sleep(1200);
    }
    await sleep(1200);
    await page.evaluate(() => {
      const ov = document.querySelector("#privacy-overlay");
      if (ov) ov.remove();
      document.body.classList.remove("tc-modal-open", "scroll-lock");
      document.documentElement.style.overflow = "";
    }).catch(() => {});
    const emailInput = page.locator("input[name=email]");
    if (!(await emailInput.count())) {
      return { ip: entry.proxy_address, label, ok: false, api, step: "no-input", ms: Date.now() - t0 };
    }
    await emailInput.first().fill(email);
    await page.locator("[data-cy=authentication__cta]").click().catch(() => {});
    let step = "none";
    const w0 = Date.now();
    while (Date.now() - w0 < 9000) {
      if (await page.locator("input[type=password]:not(#registerPassword)").first().isVisible().catch(() => false)) { step = "password"; break; }
      if (await page.locator("input[name=firstname]").count()) { step = "firstname"; break; }
      await sleep(600);
    }
    const ok = api === 200 && step === "password";
    return { ip: entry.proxy_address, label, ok, api, step, apiUrl, ms: Date.now() - t0 };
  } catch (e) {
    return { ip: entry.proxy_address, label, ok: false, api: null, step: "error", ms: 0, why: (e.message || "").split("\n")[0].slice(0, 60) };
  } finally {
    await ctx?.close().catch(() => {});
  }
}
