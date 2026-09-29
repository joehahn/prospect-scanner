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
