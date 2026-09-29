// Polite HTTP for source modules: robots.txt, per-host rate limiting, retries.
//
// CLAUDE.md requires robots.txt and rate limits be respected on every source.
// Enforcement lives here rather than in each source module so no future source
// can quietly skip it.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// WHO IS ASKING, from the operator's own config. A site that wants to reach
// whoever is crawling it should reach the person running this copy, not the
// author of the code; a fork announcing someone else's address is wrong on both
// counts. Falls back to the bare name when no website is configured.
export const UA = (() => {
  try {
    const me = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../config/me.yml'), 'utf8');
    const url = me.match(/^\s*url:\s*["']?([^"'\s#]+)/m)?.[1];
    return url ? `prospect-scanner/0.1 (+${url})` : 'prospect-scanner/0.1';
  } catch { return 'prospect-scanner/0.1'; }
})();
const DEFAULT_DELAY_MS = 1000;

const robotsCache = new Map();  // origin -> {rules, crawlDelayMs}
const lastHit = new Map();      // origin -> epoch ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal robots.txt parser: the User-agent: * group only. We never register a
 * named agent, so the wildcard group is the one that binds us. A file that is
 * missing, errors, or is not actually a robots.txt (some API hosts answer with
 * JSON) is treated as "no rules", which is what the standard says.
 */
function parseRobots(text) {
  const rules = [];
  let crawlDelayMs = null;
  let inStar = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, field, value] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (field === 'user-agent') { inStar = value === '*'; continue; }
    if (!inStar) continue;
    if (field === 'disallow' && value) rules.push({ allow: false, path: value });
    else if (field === 'allow' && value) rules.push({ allow: true, path: value });
    else if (field === 'crawl-delay') {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs > 0) crawlDelayMs = secs * 1000;
    }
  }
  return { rules, crawlDelayMs };
}

async function robotsFor(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let parsed = { rules: [], crawlDelayMs: null };
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    const body = res.ok ? await res.text() : '';
    // A body with no directive lines is not a robots.txt. Treat as no rules.
    if (/^\s*(user-agent|disallow|allow|sitemap|crawl-delay)\s*:/im.test(body)) {
      parsed = parseRobots(body);
    }
  } catch {
    // Unreachable robots.txt is not permission to hammer, but it is also not a
    // disallow. We fall back to no rules plus the default delay.
  }
  robotsCache.set(origin, parsed);
  return parsed;
}

/** Longest-match wins, which is what Google and the RFC 9309 draft specify. */
function allowedByRobots({ rules }, path) {
  let best = null;
  for (const r of rules) {
    const pattern = r.path.replace(/\*+$/, '');
    if (!path.startsWith(pattern)) continue;
    if (!best || pattern.length > best.path.replace(/\*+$/, '').length) best = r;
  }
  return best ? best.allow : true;
}

/**
 * GET a URL, honouring robots.txt and a per-host crawl delay.
 * Returns {ok, status, json, skipped} — a robots disallow is `skipped`, not an
 * error, so a scan over many boards does not abort on one closed door.
 */
export async function getJson(url, { delayMs = DEFAULT_DELAY_MS, retries = 2,
                                     expect = 'json' } = {}) {
  const u = new URL(url);
  const robots = await robotsFor(u.origin);

  if (!allowedByRobots(robots, u.pathname)) {
    return { ok: false, status: 0, skipped: 'robots.txt disallows this path' };
  }

  const wait = Math.max(delayMs, robots.crawlDelayMs ?? 0);
  const since = Date.now() - (lastHit.get(u.origin) ?? 0);
  if (since < wait) await sleep(wait - since);

  for (let attempt = 0; ; attempt++) {
    lastHit.set(u.origin, Date.now());
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'user-agent': UA,
          accept: expect === 'text'
            ? 'text/html,application/xhtml+xml'
            : 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt >= retries) return { ok: false, status: 0, error: err.message };
      await sleep(wait * (attempt + 2));
      continue;
    }

    // 404 is the normal answer for "this company has no board here". Not an error.
    if (res.status === 404) return { ok: false, status: 404 };

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) return { ok: false, status: res.status };
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : wait * Math.pow(2, attempt + 1));
      continue;
    }

    if (!res.ok) return { ok: false, status: res.status };

    if (expect === 'text') {
      // A site that answers HTML for a URL we asked for as a page is normal; a
      // site that answers a PDF or an image is not something we can read.
      const ct = res.headers.get('content-type') ?? '';
      if (ct && !/text\/|xml|json/i.test(ct)) {
        return { ok: false, status: res.status, error: `not readable text (${ct})` };
      }
      return { ok: true, status: res.status, text: await res.text(), finalUrl: res.url };
    }

    try {
      return { ok: true, status: res.status, json: await res.json() };
    } catch (err) {
      return { ok: false, status: res.status, error: `bad JSON: ${err.message}` };
    }
  }
}
