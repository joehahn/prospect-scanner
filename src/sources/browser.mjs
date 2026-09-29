// Reading a page with a real browser, for the narrow case CLAUDE.md permits.
//
// `robots.txt` decides what may be fetched, not the WAF in front of it. A site
// that serves robots.txt to this crawler, allows the path for `*`, and then
// refuses the user-agent at the firewall has published one policy and enforced
// a cruder one. Ten firms in this book do exactly that: they hang until the
// timeout or return 403, and serve a browser the identical static HTML in under
// 300ms.
//
// This module is the ONLY place a browser is used, so the three conditions can
// be checked in one place and nothing can quietly grow a fourth:
//
//   1. robots.txt allows the path for `*`  — checked by the caller, in http.mjs,
//      before escalation is offered at all. A disallow is a stated policy and
//      ends it.
//   2. The site serves a browser           — if this returns a 403 too, the site
//      is closed to everyone and the answer stays no.
//   3. It is not linkedin.com              — asserted here as well as upstream,
//      because a guardrail worth having is worth failing loudly for.
//
// Cost is why this is never the default: a browser page load is two orders of
// magnitude more expensive than a fetch, in time and memory both. `fetch` is
// always tried first and this runs only on a timeout or a 4xx.

const BLOCKED_HOSTS = [/(^|\.)linkedin\.com$/i];

// ONE BROWSER PER CALL, LAUNCHED AND CLOSED. The first version kept a
// process-lifetime browser and exported closeBrowser() for callers to invoke.
// Nobody did: `enrich` never called it, `vet` spawns one `enrich` per firm, and
// two ten-firm vet loops were killed for exhausting memory. Adding an exit hook
// did not fix it either -- `beforeExit` does not fire on process.exit() and will
// not await an async close, so three chromium processes survived the node run
// that started them.
//
// A resource whose cleanup depends on every caller remembering is a leak with
// extra steps, and an exit hook that cannot await is a leak with a comment. So
// the browser does not outlive the call. A launch costs roughly 200ms, and this
// path runs only on a refusal and only once per host, so the cost is a fraction
// of a second on a run that already spends seconds per page. Correctness over
// speed on the rare path.
const LAUNCH_ARGS = ['--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
  '--disable-background-networking', '--no-first-run'];

/** Kept as a no-op so existing callers do not break; there is nothing to close. */
export async function closeBrowser() {}

export async function fetchPageWithBrowser(url, { timeoutMs = 20_000 } = {}) {
  const u = new URL(url);
  if (BLOCKED_HOSTS.some((re) => re.test(u.hostname))) {
    // Their §8.2 prohibits crawlers in words. That is a policy, not a control,
    // and no technical capability changes it.
    return { ok: false, status: 0, error: 'blocked host: never automate this domain' };
  }

  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    const ctx = await browser.newContext({ javaScriptEnabled: true });
    const page = await ctx.newPage();
    // Images, fonts and media are never read by anything downstream, and
    // blocking them is both faster and less load on the site.
    await page.route('**/*', (route) => (
      ['image', 'font', 'media'].includes(route.request().resourceType())
        ? route.abort() : route.continue()));
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = res?.status() ?? 0;
    if (status >= 400) {
      // Condition 2 failed: the site refuses a browser too, so it is closed to
      // everyone and this is a real answer rather than a filtering artefact.
      return { ok: false, status, viaBrowser: true,
        error: `site refuses a browser too (${status})` };
    }
    return { ok: true, status, text: await page.content(), finalUrl: page.url(), viaBrowser: true };
  } catch (err) {
    return { ok: false, status: 0, viaBrowser: true, error: err.message };
  } finally {
    // The whole point. Runs on success, on refusal, and on throw.
    try { await browser?.close(); } catch { /* already gone */ }
  }
}
