/**
 * SEC EDGAR: public companies that just completed an acquisition.
 *
 * WHY (2026-11-12). Both outside reviewers named EDGAR as a free source this
 * book never built: it was declared in runtime.yml in September, and no module
 * read it. An 8-K under Item 2.01 ("Completion of Acquisition or Disposition of
 * Assets") is a dated, mandatory filing: a firm that has just bought an
 * operating company has two sets of records, two ways of doing the same work,
 * and a deadline to make them one. That is the integration work this business
 * sells, with the date on it, found by the filing a public company must make
 * rather than by a press release it may not issue.
 *
 * THREE ENDPOINTS, ALL PUBLIC:
 *   efts.sec.gov/LATEST/search-index   full-text search over filings
 *   data.sec.gov/api/xbrl/companyconcept  reported revenue, for the size band
 *   www.sec.gov/Archives/edgar/data    the filing itself (robots.txt: Allow)
 * SEC's fair-access policy requires a User-Agent naming the requester with a
 * contact address and at most 10 requests a second. The User-Agent comes from
 * config (sources.sec_edgar.user_agent), never from code: it is one business's
 * identity. Requests are spaced 150ms apart.
 */
import { extractText } from './web.mjs';

const SPACING_MS = 150;
let last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function secFetch(url, ua, { json = true } = {}) {
  if (!ua) throw new Error('sources.sec_edgar.user_agent is not set in config/runtime.yml: SEC refuses requests without one');
  const wait = last + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: json ? 'application/json' : 'text/html' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  return json ? res.json() : res.text();
}

/**
 * 8-K filings under Item 2.01 between two dates, one per company, newest first.
 * Amendments (8-K/A) are left out: they refile the same event, usually to add
 * the acquired firm's financial statements.
 */
export async function acquisitionFilings(ua, startdt, enddt, { max = 300 } = {}) {
  const out = new Map();
  for (let from = 0; from < max; from += 100) {
    const url = 'https://efts.sec.gov/LATEST/search-index?q=%22Item%202.01%22&forms=8-K'
      + `&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}`;
    const d = await secFetch(url, ua);
    const hits = d?.hits?.hits ?? [];
    for (const h of hits) {
      const s = h._source ?? {};
      if (s.form !== '8-K' || !(s.items ?? []).includes('2.01')) continue;
      const cik = String(s.ciks?.[0] ?? '').replace(/^0+/, '');
      if (!cik || out.has(cik)) continue;
      const [adsh, file] = String(h._id).split(':');
      const name = String(s.display_names?.[0] ?? '').replace(/\s*\(.*$/, '').trim();
      out.set(cik, {
        cik, name, adsh, file,
        filed: s.file_date, sic: Number(s.sics?.[0] ?? 0), state: s.biz_states?.[0] ?? null,
        location: s.biz_locations?.[0] ?? null, items: s.items,
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${file}`,
      });
    }
    if (hits.length < 100) break;
  }
  return [...out.values()];
}

const REVENUE_TAGS = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'];

/** The latest annual revenue a company reported in its 10-K, or null. */
export async function annualRevenue(ua, cik) {
  const padded = String(cik).padStart(10, '0');
  let best = null;
  for (const tag of REVENUE_TAGS) {
    const d = await secFetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/us-gaap/${tag}.json`, ua)
      .catch(() => null);
    const rows = (d?.units?.USD ?? []).filter((r) => r.form === '10-K' && r.fp === 'FY' && r.start && r.end
      && (Date.parse(r.end) - Date.parse(r.start)) > 300 * 864e5);
    for (const r of rows) if (!best || r.end > best.end) best = { usd: r.val, end: r.end, tag };
  }
  return best;
}

/** The Item 2.01 passage of a filing, as plain text, for a reader to judge. */
export async function itemText(ua, url, { chars = 7000 } = {}) {
  const html = await secFetch(url, ua, { json: false });
  if (!html) return null;
  const text = extractText(html);
  const at = text.search(/Item\s*2\.01/i);
  return (at >= 0 ? text.slice(at, at + chars) : text.slice(0, chars)).trim();
}
