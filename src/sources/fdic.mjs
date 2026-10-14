/**
 * FDIC BankFind — the register, not a search.
 *
 * Four sweeps on 2026-09-22 established that a bank in this book's size band
 * cannot be found by searching. National news, the banking trade press, vendor
 * marketing and award programmes all return the largest institutions, because
 * announcing requires a communications function and a two-billion-dollar bank
 * does not have one. The only small bank that surfaced all day came from its own
 * newsroom, and the only one this thesis has sold into came from a regional
 * business journal — both reachable per firm, neither reachable market-wide.
 *
 * So this inverts the pipeline. Everywhere else discovery finds a firm by its
 * trigger and a gate then judges its size from a number nobody retrieved; here
 * the size comes first, from a quarterly regulatory filing, and the trigger is
 * looked for afterwards on each firm's own pages.
 *
 * Free, no key, no rate limit worth pacing for. ASSET is reported in THOUSANDS
 * of dollars, which is the one thing about this API that will bite.
 */
const BASE = 'https://api.fdic.gov/banks/institutions';

/**
 * Active insured institutions in a state, within an asset band.
 *
 * @param state    full state name as the FDIC writes it: "Texas", not "TX"
 * @param minUsd   inclusive floor in dollars
 * @param maxUsd   inclusive ceiling in dollars
 */
export async function banksInBand(state, minUsd, maxUsd, { limit = 500 } = {}) {
  const k = (usd) => Math.round(usd / 1000);          // dollars -> thousands
  const filters = [
    state ? `STNAME:"${state}"` : null,
    'ACTIVE:1',
    `ASSET:[${k(minUsd)} TO ${k(maxUsd)}]`,
  ].filter(Boolean).join(' AND ');
  const url = `${BASE}?filters=${encodeURIComponent(filters)}`
    + '&fields=NAME,CITY,STNAME,ASSET,WEBADDR,CERT,OFFDOM,REPDTE'
    + `&limit=${limit}&sort_by=ASSET&sort_order=DESC&format=json`;

  let res;
  try { res = await fetch(url, { headers: { accept: 'application/json' } }); }
  catch (err) { return { banks: [], error: `fdic unreachable: ${err.message}` }; }
  if (!res.ok) return { banks: [], error: `fdic ${res.status}` };

  let body;
  try { body = await res.json(); }
  catch (err) { return { banks: [], error: `fdic returned unparseable json: ${err.message}` }; }

  const banks = (body.data ?? []).map((r) => r.data ?? {}).map((x) => ({
    cert: x.CERT ?? null,
    name: String(x.NAME ?? '').trim(),
    city: x.CITY ?? null,
    state: x.STNAME ?? null,
    // Back to dollars. Stored as aum_usd because that is what the money gate on
    // this thesis asks for, and for a bank total assets IS the size figure.
    assets_usd: Number.isFinite(x.ASSET) ? x.ASSET * 1000 : null,
    // The FDIC keeps these as bare hostnames, sometimes with a trailing slash
    // and sometimes with a scheme. Normalised to what `orgs.domain` holds.
    domain: String(x.WEBADDR ?? '').trim()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null,
    offices: Number.isFinite(x.OFFDOM) ? x.OFFDOM : null,
    as_of: x.REPDTE ?? null,
  })).filter((b) => b.name);

  return { banks, total: body.meta?.total ?? banks.length };
}

const FIN = 'https://api.fdic.gov/banks/financials';

/** The financials endpoint for one institution, newest quarter first. It is the
 * source_url a filed fact cites: opening it shows the figures the claim states. */
export function financialsUrl(cert, quarters = 5) {
  return `${FIN}?filters=${encodeURIComponent(`CERT:${cert}`)}`
    + `&fields=CERT,NAMEFULL,REPDTE,ASSET,EEFFR&sort_by=REPDTE&sort_order=DESC&limit=${quarters}`;
}

/**
 * Every insured institution's call-report figures for one quarter, within an
 * asset band, across the whole country. Peers are national because that is how
 * a bank's investors and examiners compare it: by size, not by state line.
 *
 * EEFFR is the efficiency ratio, noninterest expense over revenue, in percent.
 * HIGHER IS WORSE: it is what a bank spends to earn a dollar.
 *
 * @param repdte   quarter end as YYYYMMDD; omitted, the latest quarter filed
 */
export async function quarterFinancials(minUsd, maxUsd, { repdte = null } = {}) {
  const k = (usd) => Math.round(usd / 1000);          // dollars -> thousands, as before
  const get = async (filters, limit, sort = '') => {
    const url = `${FIN}?filters=${encodeURIComponent(filters)}`
      + `&fields=CERT,NAMEFULL,STALP,STNAME,REPDTE,ASSET,EEFFR&limit=${limit}${sort}&format=json`;
    let res;
    try { res = await fetch(url, { headers: { accept: 'application/json' } }); }
    catch (err) { return { error: `fdic unreachable: ${err.message}` }; }
    if (!res.ok) return { error: `fdic ${res.status}` };
    try { return { body: await res.json() }; }
    catch (err) { return { error: `fdic returned unparseable json: ${err.message}` }; }
  };
  const band = `ASSET:[${k(minUsd)} TO ${k(maxUsd)}]`;
  if (!repdte) {
    // A quarter appears institution by institution as filings are processed, so
    // the newest REPDTE can be a handful of early filers. Taken as latest only
    // once it has most of the previous quarter's count.
    const head = await get(band, 1, '&sort_by=REPDTE&sort_order=DESC');
    if (head.error) return { rows: [], error: head.error };
    repdte = head.body.data?.[0]?.data?.REPDTE ?? null;
    if (!repdte) return { rows: [], error: 'fdic returned no quarters' };
    const count = async (q) => (await get(`${band} AND REPDTE:${q}`, 1)).body?.meta?.total ?? 0;
    const prior = quarterBefore(repdte);
    if (await count(repdte) < 0.8 * await count(prior)) repdte = prior;
  }
  const got = await get(`${band} AND REPDTE:${repdte}`, 10000);
  if (got.error) return { rows: [], error: got.error };
  const rows = (got.body.data ?? []).map((r) => r.data ?? {}).map((x) => ({
    cert: x.CERT ?? null,
    name: String(x.NAMEFULL ?? '').trim(),
    state: x.STNAME ?? null,
    assets_usd: Number.isFinite(x.ASSET) ? x.ASSET * 1000 : null,
    efficiency: Number.isFinite(x.EEFFR) ? x.EEFFR : null,
  })).filter((r) => r.cert && r.name);
  return { rows, repdte, total: got.body.meta?.total ?? rows.length };
}

/** YYYYMMDD four quarters earlier. */
export function yearEarlier(repdte) {
  return `${Number(String(repdte).slice(0, 4)) - 1}${String(repdte).slice(4)}`;
}

/** YYYYMMDD of the quarter end before this one. */
export function quarterBefore(repdte) {
  const y = Number(String(repdte).slice(0, 4));
  const ends = ['0331', '0630', '0930', '1231'];
  const i = ends.indexOf(String(repdte).slice(4));
  return i > 0 ? `${y}${ends[i - 1]}` : `${y - 1}1231`;
}
