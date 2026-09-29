// Fetching and reading ordinary web pages, for the `enrich` stage.
//
// Everything goes through http.mjs, so robots.txt and per-host rate limiting
// apply here exactly as they do to the job-board APIs. No Playwright: the design
// permits it only where a page genuinely requires JS rendering, and a team page
// almost never does. A page that comes back empty is reported as empty rather
// than escalated to a browser.

import { getJson } from './http.mjs';

// One user-agent for every fetch, built from the operator's config in http.mjs.

// Paths worth trying on a firm's own site. Ordered by how often they carry the
// fact the gates need: who works there.
export const CANDIDATE_PATHS = [
  '', '/about', '/team', '/our-team', '/people', '/leadership', '/who-we-are',
  '/company', '/about-us', '/partners', '/services', '/what-we-do',
  // NESTED PATHS, added 2026-09-16 after enriching 19 large firms named ZERO
  // people between them — every site reachable, every site read, no leadership
  // anywhere. The flat guesses above are a small firm's URL shape. A large firm
  // nests: /about/leadership holds eleven executive titles at one of those
  // nineteen and five at another, and neither homepage LINKS to it, so link
  // discovery cannot reach it and only a guess can.
  '/about/leadership', '/about-us/leadership', '/about/leadership-team',
  '/about/our-people', '/about/management', '/about/executive-team',
  '/who-we-are/leadership', '/company/leadership', '/our-leadership',
  '/leadership-team', '/executive-team', '/management',
  // CAREERS PAGES, added 2026-09-18, and for a different reason than the rest.
  // Every path above answers "who works here". These answer "what work is this
  // firm about to pay a person to do", which at a small firm is the only public
  // statement it makes about its own operations.
  //
  // A ten-person HVAC company publishes no press release, no leadership page and
  // no trade coverage, and its Google Business description says "family-owned
  // since 1998". It publishes one thing that names a process: a job ad for
  // somebody to handle quote requests, enter invoices and answer scheduling
  // calls. That is a named, funded, manual process, and it is the work the
  // small-shop offer automates.
  //
  // Read from the firm's OWN site rather than a job board. Indeed, ZipRecruiter
  // and LinkedIn Jobs all prohibit crawling, and the aggregator APIs that are
  // licensed carry ATS feeds from large employers — precisely the wrong end of
  // the market. The employer's own careers page is where the posting existed
  // before any board saw it.
  '/careers', '/jobs', '/careers/open-positions', '/join-us', '/employment',
  '/work-with-us', '/about/careers', '/company/careers', '/careers/jobs',
];

const LINK_HINTS =
  /\b(team|about|leadership|people|our-people|who-we-are|partners|company|management|founders)\b/i;

// Pages where a firm announces things about itself. This is the authoritative
// source for the events `news` hunts, and the only one that works for firms too
// small for the press to cover — an 18-person PE shop generates no news but does
// publish "we invested in X" on its own site.
const NEWS_HINTS =
  /\b(news|press|newsroom|media|announcements?|insights?|blog|updates?|portfolio|investments?|transactions?|deals?)\b/i;

export const NEWS_PATHS = [
  '/news', '/press', '/newsroom', '/media', '/announcements', '/insights',
  '/portfolio', '/investments', '/transactions', '/blog', '/news-insights',
  '/about/news', '/firm/news',
];

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&rsquo;': '’',
  '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…',
};

/** HTML to readable text. Crude on purpose — a team page is names and titles, not prose. */
export function extractText(html) {
  return String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Block-level tags become line breaks so names and titles stay on separate
    // lines instead of running together into one unreadable paragraph.
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function extractTitle(html) {
  const m = String(html ?? '').match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return m ? extractText(m[1]).slice(0, 200) : null;
}

/** Same-host links whose text or href suggests a team or about page. */
export function discoverLinks(html, baseUrl) {
  const out = new Map();
  let base;
  try { base = new URL(baseUrl); } catch { return []; }

  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const [, href, inner] = m;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (!/^https?:$/.test(u.protocol)) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|mp4|webp)$/i.test(u.pathname)) continue;

    const text = extractText(inner);
    if (!LINK_HINTS.test(u.pathname) && !LINK_HINTS.test(text)) continue;
    u.hash = '';
    if (!out.has(u.href)) out.set(u.href, text.slice(0, 80));
  }
  return [...out].map(([url, text]) => ({ url, text }));
}

/** Same-host links that look like a newsroom, press page or portfolio index. */
export function discoverNewsLinks(html, baseUrl) {
  const out = new Map();
  let base;
  try { base = new URL(baseUrl); } catch { return []; }

  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const [, href, inner] = m;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (!/^https?:$/.test(u.protocol)) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|mp4|webp)$/i.test(u.pathname)) continue;
    const text = extractText(inner);
    if (!NEWS_HINTS.test(u.pathname) && !NEWS_HINTS.test(text)) continue;
    u.hash = '';
    if (!out.has(u.href)) out.set(u.href, text.slice(0, 80));
  }
  return [...out].map(([url, text]) => ({ url, text }));
}

/**
 * GET an HTML page. Reuses http.mjs's robots and rate-limit handling by asking
 * it not to parse JSON.
 */
// origin -> why the browser was refused there. Process-lifetime, like the
// robots cache: one run of `enrich` should learn this once.
const browserRefused = new Map();

// WHICH HOSTS NEEDED A BROWSER, and how many pages each took. CLAUDE.md makes
// this a hard guardrail, not a nicety: "when a browser is needed, `vet` says so
// in its verdict rather than passing silently — knowing which firms required it
// is what keeps this auditable instead of habitual."
//
// The `viaBrowser` flag has existed on every fetch result since the escalation
// was written and NOTHING READ IT. It was computed and dropped, so a browser
// fetch passed silently, which is the one thing the rule forbids. Tracked here
// because this module is the only place a browser is reached.
const browserUsed = new Map();

/** Hosts a browser was needed for this run, for the stage to report and record. */
export function browserReport() {
  return [...browserUsed.entries()].map(([origin, pages]) => ({ origin, pages }));
}

/** One line for a run's `notes`, or null when no browser was used. */
export function browserNote() {
  const r = browserReport();
  if (!r.length) return null;
  return `browser needed for ${r.length} host(s): ` +
    r.map((x) => `${x.origin.replace(/^https?:\/\//, '')} (${x.pages}p)`).join(', ');
}

/** The success shape, shared so the early-return above cannot drift from it. */
function finish(url, res) {
  const html = res.text ?? '';
  return {
    ok: true, url: res.finalUrl ?? url, html,
    title: extractTitle(html), text: extractText(html),
    viaBrowser: Boolean(res.viaBrowser),
  };
}

export async function fetchPage(url, { delayMs = 1500, allowBrowser = true } = {}) {
  let res = await getJson(url, { delayMs, retries: 1, expect: 'text' });

  // ESCALATE ONLY WHERE robots.txt ALREADY SAID YES. `getJson` returns
  // `skipped` when robots disallows the path, and that is the end of it -- a
  // stated policy is not something a browser is allowed to talk past. What is
  // escalated is the OTHER failure: a timeout or a 4xx from a firewall in front
  // of a page the site's own robots.txt permits. Ten firms in this book serve
  // robots.txt to this crawler, allow the root for `*`, and then hang or 403 on
  // the user-agent while serving a browser the same static HTML in 264ms.
  //
  // Not on 404, which is a real answer. Not on 5xx, which is the site being
  // broken rather than selective. And never as the first attempt: a browser page
  // load costs two orders of magnitude more than a fetch.
  // GIVE UP ON THE HOST, NOT THE PAGE. `enrich` walks up to a dozen paths per
  // firm, and without this a site that refuses browsers pays for a browser load
  // on every one of them -- twelve launches to learn the same fact twelve times.
  // The first refusal settles it for the whole origin: condition 2 has failed,
  // and it does not fail differently on /about than it did on /.
  const origin = new URL(url).origin;
  if (browserRefused.has(origin)) {
    return res.ok ? finish(url, res) : { ...res, browserTried: true,
      browserError: `skipped: ${origin} already refused a browser (${browserRefused.get(origin)})` };
  }

  const filtered = !res.ok && !res.skipped
    && (res.status === 0 || (res.status >= 400 && res.status < 500 && res.status !== 404));
  if (filtered && allowBrowser) {
    const { fetchPageWithBrowser } = await import('./browser.mjs');
    const viaBrowser = await fetchPageWithBrowser(url);
    // A browser refused too means the site is closed to everyone, which is a
    // finding. Keep that answer rather than the fetch's, so the caller reports
    // the stronger evidence.
    // Keep the browser's answer when it is one: success, or a refusal that
    // settles condition 2. When the browser fails inconclusively -- two of these
    // sites drop the HTTP/2 connection from headless Chrome before a status
    // exists -- keep the fetch's error, which is more informative, but record
    // that the escalation was tried. Otherwise the log reads as though it never
    // happened and the next person repeats the work.
    if (!viaBrowser.ok) {
      browserRefused.set(origin, viaBrowser.status >= 400
        ? `HTTP ${viaBrowser.status}` : (viaBrowser.error ?? 'failed').slice(0, 60));
    }
    if (viaBrowser.ok) browserUsed.set(origin, (browserUsed.get(origin) ?? 0) + 1);
    res = viaBrowser.ok || viaBrowser.status >= 400
      ? viaBrowser
      : { ...res, browserTried: true, browserError: viaBrowser.error };
  }

  if (!res.ok) return res;
  return finish(url, res);
}
