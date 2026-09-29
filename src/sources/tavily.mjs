// Tavily news search.
//
// Ported from geo-herd-rider's src/search.py, keeping the two lessons that
// project paid for and dropping the look-ahead machinery this one does not need
// (there is no backtest here).
//
// The lesson that transfers, and why it matters MORE here than there:
// Tavily's date filters are not reliably honoured server-side, and some results
// carry no published_date at all. GHR re-enforces the bound client-side to stop
// future articles leaking into a backtest. This project enforces it because a
// trigger IS a dated event — the design grades every dossier on whether its "why
// now" is a specific datable event, so an article with no date cannot support
// one. An undateable result is DROPPED, never kept with a guessed date.
//
// The other lesson: 429 with exponential backoff, and a global pacer so a sweep
// cannot burst past the rate limit.

const URL = 'https://api.tavily.com/search';
const TIMEOUT_MS = 20_000;
const RETRIES = 4;

// The free tier allows 100 requests/minute. A per-firm x per-trigger sweep is
// ~90 queries and would otherwise fire several per second, so the safe pace is
// the DEFAULT rather than something the caller must remember to set. GHR
// defaults this to 0 and relies on its bulk driver; here that would be a footgun.
const DEFAULT_INTERVAL_S = 0.7;    // ~85 requests/minute

let lastCall = 0;
let credits = 0;

/** Requests made this process. The free tier's ~1000/month is the real budget. */
export const creditsUsed = () => credits;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pace() {
  const raw = process.env.TAVILY_MIN_INTERVAL;
  const gap = (raw === undefined || raw === '' ? DEFAULT_INTERVAL_S : Number(raw)) * 1000;
  if (!(gap > 0)) return;
  const wait = gap - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

/**
 * The publication date of a result as YYYY-MM-DD, or null if it has none we can
 * parse. Null is the signal to drop the result — fail closed.
 */
export function publishedOn(result) {
  const raw = result?.published_date ?? '';
  if (!raw) return null;
  const d = new Date(raw);                      // handles RFC-2822 and ISO
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const iso = String(raw).slice(0, 10);         // last-ditch ISO prefix
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/**
 * News results for `query`, every one carrying a parseable publication date.
 *
 * @param sinceDate  YYYY-MM-DD; results published before it are dropped.
 * @returns {results, error} — results is [] on any failure. A search miss must
 *          never sink the run: the firm simply has no trigger on record, which
 *          is a true statement about the evidence.
 */
export async function searchNews(query, {
  sinceDate = null, maxResults = 6, includeDomains = null, excludeDomains = null,
  topic = 'news', requireDate = true,
} = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { results: [], error: 'no TAVILY_API_KEY in .env' };

  // Over-fetch when filtering by date: the dated announcement often ranks below
  // later undated commentary, so a shallow pull loses exactly what we want.
  const pull = sinceDate ? Math.max(maxResults * 4, 20) : maxResults;
  // A JOB POSTING IS NOT NEWS, and this was hard-coded to the news index.
  // Added 2026-09-21 after a sweep for the five hiring triggers returned 64
  // results and qualified none of them: every hit was an IndexBox market
  // forecast, a listicle or a directory page, because a news index holds
  // articles ABOUT demand planning and no firm's own careers page. The five
  // triggers had produced zero signals in the life of the project and the
  // reason read as a quiet market rather than a query aimed at the wrong index.
  const body = {
    query: String(query).slice(0, 400),
    topic,
    max_results: pull,
    search_depth: 'basic',
  };
  // Sent as belt-and-braces only; the client-side filter below is what is trusted.
  if (sinceDate) body.start_date = String(sinceDate).slice(0, 10);
  if (includeDomains?.length) body.include_domains = includeDomains;
  if (excludeDomains?.length) body.exclude_domains = excludeDomains;

  let raw = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    await pace();
    let res;
    try {
      credits++;
      res = await fetch(URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === RETRIES - 1) return { results: [], error: err.message };
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (res.status === 429) { await sleep(2 ** attempt * 1000); continue; }
    if (res.status === 401 || res.status === 403) {
      return { results: [], error: `Tavily rejected the key (HTTP ${res.status})` };
    }
    if (!res.ok) {
      if (attempt === RETRIES - 1) return { results: [], error: `HTTP ${res.status}` };
      await sleep(2 ** attempt * 1000);
      continue;
    }
    try { raw = (await res.json()).results ?? []; } catch { raw = []; }
    break;
  }
  if (raw === null) return { results: [], error: 'rate limited after retries' };

  // Attach the parsed date and drop anything undateable. This is the whole point.
  let undated = 0;
  const dated = [];
  for (const r of raw) {
    const on = publishedOn(r);
    // A JOB POSTING CARRIES NO PUBLICATION DATE, and dropping undateable
    // results is right for every caller but that one. The drop is the whole
    // point for an EVENT -- an undated page saying a firm "has announced" says
    // nothing about when -- and it silently emptied the hiring sweep, which
    // returned six results per query and passed none of them on. `requireDate`
    // makes the choice the caller's rather than the file's.
    if (!on && requireDate) { undated++; continue; }
    if (sinceDate && on < String(sinceDate).slice(0, 10)) continue;
    dated.push({
      title: (r.title ?? '').trim(),
      url: r.url,
      published_on: on ?? null,
      snippet: (r.content ?? '').trim().slice(0, 600),
      score: r.score ?? null,
    });
  }
  dated.sort((a, b) => (b.published_on < a.published_on ? -1 : 1));
  return { results: dated.slice(0, maxResults), undated };
}
