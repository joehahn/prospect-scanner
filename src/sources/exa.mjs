// Exa web search, the challenger to Tavily for finding conference pages.
//
// Measured before it is used: `npm run conferences -- --find --compare exa`
// runs the same searches through both and reads every result the same way,
// writing nothing to the book. Nothing else calls this yet.
//
// The forbidden hosts are asked to be left out AND dropped from whatever comes
// back, at this one door, exactly as tavily.mjs does: a search result from a
// host CLAUDE.md says is never retrieved from is a page taken second hand.

const URL = 'https://api.exa.ai/search';
const TIMEOUT_MS = 30_000;
const RETRIES = 3;
const MIN_INTERVAL_MS = 250;    // the free tier allows 10 searches a second

let lastCall = 0;
let requests = 0;
let dollars = 0;

/** Searches made this process, and what Exa said they cost. */
export const exaUsage = () => ({ requests, dollars });

let forbiddenHosts = null;
async function forbidden() {
  if (forbiddenHosts) return forbiddenHosts;
  try {
    const { loadConfig } = await import('../config.mjs');
    forbiddenHosts = (loadConfig().forbidden_hosts ?? []).map((h) => (typeof h === 'string' ? h : h.host)).filter(Boolean);
  } catch { forbiddenHosts = []; }
  return forbiddenHosts;
}
const onHost = (url, hosts) => {
  try { const h = new globalThis.URL(url).hostname; return hosts.some((x) => h === x || h.endsWith(`.${x}`)); }
  catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Web results for `query`, shaped like searchNews's: { results: [{url, title,
 * published_date}], error }. results is [] on any failure.
 */
export async function searchExa(query, { maxResults = 6, excludeDomains = null } = {}) {
  const key = process.env.EXA_API_KEY;
  if (!key) return { results: [], error: 'no EXA_API_KEY in .env' };
  const hosts = await forbidden();
  const exclude = [...new Set([...(excludeDomains ?? []), ...hosts])];
  const body = { query: String(query).slice(0, 400), type: 'auto', numResults: maxResults };
  if (exclude.length) body.excludeDomains = exclude;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res;
    try {
      requests++;
      res = await fetch(URL, {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === RETRIES - 1) return { results: [], error: err.message };
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (res.status === 429) { await sleep(2 ** attempt * 1000); continue; }
    if (res.status === 401 || res.status === 403) return { results: [], error: `Exa rejected the key (HTTP ${res.status})` };
    if (!res.ok) {
      if (attempt === RETRIES - 1) return { results: [], error: `HTTP ${res.status}` };
      await sleep(2 ** attempt * 1000);
      continue;
    }
    const raw = await res.json();
    dollars += Number(raw.costDollars?.total ?? 0);
    const results = (raw.results ?? [])
      .filter((r) => r?.url && !onHost(r.url, hosts))
      .map((r) => ({ url: r.url, title: r.title ?? '', published_date: r.publishedDate ?? null }));
    return { results, error: null };
  }
  return { results: [], error: 'Exa kept answering 429' };
}
