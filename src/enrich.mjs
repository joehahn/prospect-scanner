// Public evidence per org, each fact carrying its source URL.
//
// This is the stage that makes `gate` possible. The 2026-08-25 profile audit
// found that nine of eleven hand-pulled LinkedIn profiles were on firms that
// public web pages alone would have disqualified — a team page, a press release,
// a hiring post. Every one of those is fetchable here, before the operator
// spends the one input only a human can supply.
//
// Two passes. The first is deterministic: fetch the firm's own pages, store the
// text. The second is one cheap LLM call that extracts structured facts and
// attributes each to the page it came from. Nothing is asserted without a URL.
//
// Usage:
//   npm run enrich                    every org with a domain and no enrichment yet
//   npm run enrich -- --org <id>      just one
//   npm run enrich -- --all           re-enrich even orgs already done
//   npm run enrich -- --pages 6       how many pages per firm (default 12)
//   npm run enrich -- --jobs 4        firms read in parallel (default 8)
//   npm run enrich -- --no-llm        fetch and store text only, no model call

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, slugify, recordSize} from './db.mjs';
import { loadConfig, capabilityTitles } from './config.mjs';
import { complete } from './models.mjs';
import { fetchPage, discoverLinks, CANDIDATE_PATHS } from './sources/web.mjs';
import { crawlDelayFor } from './sources/http.mjs';
import { table, heading, bold, dim, truncate } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/enrich-firm.md';

// Constrained so the extraction is a shape the gates can rely on rather than
// prose that has to be re-parsed.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Every property required. An optional one doubles the shapes a strict schema
  // must enumerate, and that is what took PROFILE_SCHEMA over the API's limit --
  // see the note there. Absence is a value: 0, or ''.
  required: ['what_they_do', 'kind', 'kind_confidence', 'headcount_est', 'headcount_basis',
             'headcount_recalled', 'revenue_or_aum_usd', 'staffs_capability', 'people', 'evidence'],
  properties: {
    what_they_do: { type: ['string', 'null'],
      description: 'One plain sentence, in your words: what the firm sells or provides, to whom, in which '
        + 'industry. Not a slogan or tagline copied from the site, no praise words. (enrich-firm v2.)' },
    // An enum cannot also be nullable in this schema dialect, so "unknown" is an
    // explicit member rather than null. It is mapped back to null on write.
    kind: { type: 'string',
      enum: ['end_client', 'investor', 'advisor', 'delivery_firm', 'marketplace', 'staffing', 'unknown'] },
    kind_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    headcount_est: { type: 'integer', description: '0 if no page states one.' },
    headcount_basis: { type: 'string', description: 'How the number was arrived at. \'\' if none.' },
    // RECALLED, NOT RETRIEVED, and stored as such. A firm's own website almost
    // never publishes its headcount: four insurers were enriched on 2026-09-21
    // -- one of them a Fortune 100 carrier -- and not one page gave a number, so
    // all four stayed null and every seat at them was blocked by the money gate
    // reading a data gap as a market verdict. Four people the operator had just
    // hand-pasted, one scoring 69 against a writable list topping out at 24.
    //
    // The licence for asking is exactly the one discover-firms.md already uses:
    // this number decides whether $60k/year disappears into a budget line nobody
    // defends, and knowing a carrier employs tens of thousands answers that
    // without anyone looking it up. It is never printed as a fact about the
    // firm, where a source URL is required and this has none -- headcount_source
    // records which kind it is, so the two can never be confused.
    headcount_recalled: { type: 'integer',
      description: 'Roughly how many people you already know this firm employs, from your own '
        + 'knowledge rather than the pages. 0 if you have no idea. Never a guess dressed as a '
        + 'number: 0 leaves the gate honest, a wrong number decides something.' },
    revenue_or_aum_usd: { type: 'integer', description: '0 if no page states one.' },
    // DOES THE FIRM ALREADY EMPLOY THIS CAPABILITY, as a FIRM FACT rather than a
    // person one. Added 2026-09-23. firmIsStaffed() could ask three questions --
    // does a named person hold a capability title, is there a dated
    // leader-appointed signal, is anyone recorded as a builder -- and all three
    // need a PERSON. So a careers page reading "AI/ML Team hiring Senior ML
    // Engineer with computer vision; multiple models in production serving
    // millions of people every day" was invisible, and a 2,000-person firm with
    // models in production routed to build_direct, whose premise is "end client
    // with a named problem and NO AI STAFF". A note on that premise is wrong in
    // its first line, to a reader who would know it.
    //
    // '' means the pages did not say, which is the common case and is NOT a no.
    staffs_capability: { type: 'string',
      description: 'Quote or paraphrase, from the pages only, of anything saying this firm '
        + 'EMPLOYS AI, ML or data-science people of its own — a team named on a careers or '
        + 'engineering page, models described as in production, an internal platform they '
        + 'built. Not what they sell to customers, and not a single technology title in a '
        + 'leadership list. Empty string if the pages do not say.' },
    people: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'title', 'source_url'],
        properties: {
          name: { type: 'string' },
          title: { type: ['string', 'null'] },
          source_url: { type: 'string' },
        },
      },
    },
    platform_partnerships: { type: 'array', items: { type: 'string' } },
    in_house_consulting_size: { type: ['integer', 'null'] },
    // Two different things, and the distinction decides whether a firm is a
    // buyer or a competitor. A regex over prose cannot make it, because the
    // pages say "we build AI" and "we do not build AI" in nearly the same words.
    sells_ai_services: { type: 'boolean',
      description: 'They BUILD or DELIVER AI systems for clients.' },
    sells_ai_advisory: { type: 'boolean',
      description: 'They SELL judgment about AI to clients — advisory, strategy, readiness ' +
        'assessments, vendor or proposal evaluation, AI playbooks. TRUE only if their own ' +
        'pages advertise it as a service they offer. FALSE if the pages merely mention AI, ' +
        'or say they do not do this.' },
    evidence: {
      type: 'array',
      description: 'Every material claim, each with a verbatim snippet and the page URL.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['claim', 'quote', 'source_url'],
        properties: {
          claim: { type: 'string' },
          quote: { type: 'string' },
          source_url: { type: 'string' },
        },
      },
    },
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (String(argv[j]).startsWith('--')) { prev = String(argv[j]).slice(2); break; }
    }
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument "${argv[i]}"` +
      (prev ? `\n\n  This usually means an unquoted value. "${prev}" took only the first word ` +
        'of what followed. Wrap multi-word values in SINGLE quotes:\n' +
        `    --${prev} 'the whole phrase, dashes and $ and all'\n\n` +
        '  Single quotes, not double: the shell expands $2 inside double quotes and ' +
        'a price like $1,999 silently becomes ",999".' : ''));
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) args[k] = true; else { args[k] = n; i++; }
  }
  return args;
}

// THE FIRM'S OWN SITE, NOT WHEREVER IT REDIRECTS. Added 2026-09-27: a domain
// that redirected to a different business (a western-wear store for a workwear
// maker) was read as the firm's, and its staff page became five one-word
// "people" at the firm. A page that lands on another host is not the firm's.
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const sameSite = (u, domain) => {
  const h = hostOf(u); const d = hostOf(`https://${String(domain).replace(/^https?:\/\//, '')}`);
  return Boolean(h && d) && (h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`));
};

// How long one firm may spend waiting out a site's crawl delay. Leaves room
// inside daily's ten-minute step for the model call and a browser fallback.
const PAGE_WAIT_BUDGET_MS = 4 * 60_000;

/** Fetch a firm's own pages: homepage, then whatever it links to that looks like a team page. */
async function fetchFirmPages(domain, maxPages, log) {
  const base = `https://${String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const pages = [];
  const seen = new Set();

  const home = await fetchPage(base);
  if (!home.ok) {
    // Plenty of small firms are www-only or http-only. One retry, then give up.
    const alt = await fetchPage(base.replace('https://', 'https://www.'));
    if (!alt.ok) return { pages, error: home.skipped ?? home.error ?? `HTTP ${home.status}` };
    if (!sameSite(alt.url, domain)) return { pages, error: `redirected off-site, to ${hostOf(alt.url)}` };
    pages.push(alt); seen.add(alt.url);
  } else {
    if (!sameSite(home.url, domain)) return { pages, error: `redirected off-site, to ${hostOf(home.url)}` };
    pages.push(home); seen.add(home.url);
  }

  // A CRAWL DELAY THE PAGE BUDGET CANNOT AFFORD. Added 2026-10-01: a hospital
  // district's robots.txt asks for 120s between requests, so twelve pages is
  // twenty-four minutes, and `daily` kills a step at ten. The vet died, left
  // the firm unvetted, and was picked again the next morning to die the same
  // way. The delay is obeyed in full; what shrinks is how many pages we ask for.
  const delayMs = await crawlDelayFor(pages[0].url);
  const affordable = delayMs ? 1 + Math.floor(PAGE_WAIT_BUDGET_MS / delayMs) : maxPages;
  if (affordable < maxPages) {
    log(`    robots.txt asks ${delayMs / 1000}s between pages: reading ${affordable} of up to ${maxPages}`);
    maxPages = affordable;
  }

  const linked = discoverLinks(pages[0].html, pages[0].url).map((l) => l.url);
  const guessed = CANDIDATE_PATHS.filter(Boolean).map((p) => `${base}${p}`);
  // Links the site actually offers beat paths we guessed at.
  for (const url of [...linked, ...guessed]) {
    if (pages.length >= maxPages) break;
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await fetchPage(url);
    if (r.ok && r.text && r.text.length > 200 && sameSite(r.url, domain)) { pages.push(r); log(`    ${url}`); }
  }
  return { pages };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const db = openDb();
  const runId = startRun(db, 'enrich', { model: args['no-llm'] ? null : cfg.models.cheap });
  const now = new Date().toISOString();
  // 5 was tuned when CANDIDATE_PATHS held twelve flat guesses. It now holds
  // twenty-four including nested leadership paths, and 5 stops before reaching
  // them: one firm named nobody at 5 pages and four people at 12, off the same
  // site with the same prompt. The budget, not the site, was the limit.
  const maxPages = Number(args.pages && args.pages !== true ? args.pages : 12);
  const log = (s) => console.log(dim(s));

  const where = args.org && args.org !== true
    ? 'o.id = ?'
    : args.all
      ? 'o.domain IS NOT NULL'
      : `o.domain IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM evidence e WHERE e.org_id = o.id AND e.kind = 'firm_profile')`;
  const orgs = args.org && args.org !== true
    ? db.prepare(`SELECT * FROM orgs o WHERE ${where}`).all(String(args.org))
    : db.prepare(`SELECT * FROM orgs o WHERE ${where} ORDER BY o.name`).all();

  console.log(heading(`enrich · ${orgs.length} firm(s)` +
    (args['no-llm'] ? ' · fetch only, no model calls' : ` · ${cfg.models.cheap}`)));
  if (!orgs.length) {
    console.log('Nothing to enrich. Add a firm with `npm run lead -- add-org`, ' +
      'or pass --all to re-run.');
    finishRun(db, runId, {}); db.close(); return;
  }

  const insEv = db.prepare(`
    INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance, body)
    VALUES (@org, @person, @kind, @claim, @url, @at, 'retrieved', @body)
    ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET
      retrieved_at = excluded.retrieved_at, body = excluded.body`);

  const rows = [];
  let totalCost = 0;

  // PARALLEL ACROSS FIRMS, serial within one. Added 2026-09-25: enriching 270
  // firms one after another is six hours, because each firm is twelve page
  // fetches with a rate-limit delay plus a model call, and nothing overlaps.
  // `read` and `audit` already carry this pattern; this stage never got it.
  //
  // THE RATE LIMIT IS PER HOST AND STAYS THAT WAY. Four workers means four
  // DIFFERENT firms in flight, so each site still sees one sequential request
  // stream from `fetchFirmPages` -- the guardrail asks for one-per-firm and
  // rate-limited, and that is unchanged. What is removed is the idle time
  // spent waiting on one site while three others could have been read.
  //
  // better-sqlite3 is synchronous, so the writes below serialise inside this
  // one process with no extra locking.
  const jobs = Math.max(1, Number(args.jobs && args.jobs !== true ? args.jobs : 8) || 8);
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < orgs.length; i = cursor++) {
      await enrichOne(orgs[i]);
    }
  };

  const enrichOne = async (org) => {
    console.log(`\n${bold(org.name)} ${dim(org.domain)}`);
    const { pages, error } = await fetchFirmPages(org.domain, maxPages, log);
    if (!pages.length) {
      console.log(dim(`    site unreachable: ${error}`));
      rows.push({ org, pages: 0, note: `unreachable: ${error}` });
      return;
    }
    log(`    ${pages.length} page(s), ${pages.reduce((a, p) => a + p.text.length, 0)} chars`);

    for (const p of pages) {
      insEv.run({ org: org.id, person: null, kind: 'web_page',
        claim: p.title ?? `Page at ${p.url}`, url: p.url, at: now,
        body: p.text.slice(0, 40_000) });
    }

    if (args['no-llm']) { rows.push({ org, pages: pages.length, note: 'fetched only' }); return; }

    const corpus = pages.map((p) =>
      `### PAGE: ${p.url}\n### TITLE: ${p.title ?? '(none)'}\n${p.text.slice(0, 12_000)}`).join('\n\n');
    const res = await complete(db, runId, {
      model: cfg.models.cheap,
      system: readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8'),
      effort: 'medium',
      maxTokens: 8000,
      schema: SCHEMA,
      messages: [{ role: 'user', content:
        `Firm: ${org.name}\nCapability titles the operator sells against ` +
        `(list every person whose title resembles one): ${capabilityTitles(cfg).join(', ')}\n\n${corpus}` }],
    });
    totalCost += res.cost_usd ?? 0;
    const d = res.data;

    // Store every extracted claim as its own sourced evidence row.
    for (const e of d.evidence ?? []) {
      insEv.run({ org: org.id, person: null, kind: 'firm_fact',
        claim: `${e.claim} — "${truncate(e.quote, 300)}"`, url: e.source_url, at: now, body: null });
    }
    insEv.run({ org: org.id, person: null, kind: 'firm_profile',
      claim: d.what_they_do ?? `Profile extracted for ${org.name}`,
      url: pages[0].url, at: now, body: JSON.stringify(d, null, 1) });

    // Only fill columns the pages actually supported. A null stays null.
    db.prepare(`UPDATE orgs SET
        kind              = COALESCE(kind, @kind),
        -- A PAGE BEATS AN ESTIMATE, which is the one place the usual
        -- COALESCE order is wrong. Everything else here fills a null and
        -- leaves an existing value alone; a headcount read off the firm's own
        -- page must OVERWRITE a number the discovery judge recalled, because
        -- that is the whole point of the provenance column.
        headcount_est     = CASE WHEN @headcount IS NOT NULL THEN @headcount ELSE headcount_est END,
        headcount_source  = CASE WHEN @headcount IS NOT NULL THEN @headcountSource ELSE headcount_source END,
        staffs_capability = COALESCE(@staffsCapability, staffs_capability),
        revenue_est       = COALESCE(@revenue, revenue_est),
        sells_ai_delivery = @delivery,
        sells_ai_advisory = @advisory
      WHERE id = @id`).run({
      id: org.id,
      kind: d.kind_confidence === 'low' || d.kind === 'unknown' ? null : d.kind,
      // A page beats recall, always. Recall only fills a blank.
      staffsCapability: (d.staffs_capability ?? '').trim() || null,
      headcount: (d.headcount_est || null) ?? (d.headcount_recalled || null),
      headcountSource: d.headcount_est ? 'page' : (d.headcount_recalled ? 'recalled' : null),
      revenue: d.revenue_or_aum_usd || null,
      delivery: d.sells_ai_services ? 1 : 0,
      advisory: d.sells_ai_advisory ? 1 : 0,
    });

    // ALSO RECORD IT AS A FOUND FIGURE, keeping the recall beside it. The
    // UPDATE above already does the right thing for the effective value; this
    // splits the number into the found/recalled pair so that a figure read off
    // a firm's own page becomes a TEST of whatever `size` had guessed, instead
    // of quietly erasing it. See recordSize in db.mjs.
    for (const [metric, value, isPage] of [
      ['headcount', d.headcount_est || null, true],
      ['headcount', d.headcount_est ? null : (d.headcount_recalled || null), false],
      ['revenue', d.revenue_or_aum_usd || null, true],
    ]) {
      if (!value) continue;
      const w = recordSize(db, org.id, metric, value,
        isPage ? { found: true, url: org.domain ? `https://${org.domain}` : null, source: 'page' }
          : { found: false });
      if (isPage && w.replaced_recall) {
        console.log(dim(`    ${metric} was recalled as ${w.replaced_recall}, page says ${value} `
          + `(${w.off_by > 0 ? '+' : ''}${w.off_by}%)`));
      }
    }

    // Named people are the input the capability gate runs on.
    const insPerson = db.prepare(`
      INSERT INTO people (id, org_id, name, title, notes)
      VALUES (@id, @org, @name, @title, @notes)
      ON CONFLICT(id) DO UPDATE SET title = COALESCE(people.title, excluded.title)`);
    let added = 0;
    for (const p of d.people ?? []) {
      if (!p.name) continue;
      const pid = slugify(p.name);
      const before = db.prepare('SELECT 1 FROM people WHERE id = ?').get(pid);
      insPerson.run({ id: pid, org: org.id, name: p.name, title: p.title ?? null,
        notes: `Extracted from ${p.source_url} on ${now.slice(0, 10)} by enrich.` });
      if (!before) added++;
      insEv.run({ org: org.id, person: pid, kind: 'staff_listing',
        claim: `${p.name} is listed as "${p.title ?? 'no title given'}" on the firm's own site.`,
        url: p.source_url, at: now, body: null });
    }

    console.log(`    ${d.kind && d.kind !== 'unknown' ? d.kind : 'kind unknown'} (${d.kind_confidence}) · ` +
      `${(d.people ?? []).length} named (${added} new) · ` +
      `${(d.evidence ?? []).length} sourced facts · $${(res.cost_usd ?? 0).toFixed(4)}`);
    if (d.what_they_do) console.log(dim(`    "${truncate(d.what_they_do, 110)}"`));
    if ((d.platform_partnerships ?? []).length) {
      console.log(dim(`    partnerships: ${d.platform_partnerships.join(', ')}`));
    }

    rows.push({ org, pages: pages.length, kind: d.kind === 'unknown' ? null : d.kind, people: (d.people ?? []).length,
      facts: (d.evidence ?? []).length, sells_ai: d.sells_ai_services,
      partners: (d.platform_partnerships ?? []).length });
  };

  await Promise.all(Array.from({ length: jobs }, worker));

  console.log(heading('ENRICHED'));
  console.log(table(rows.map((r) => ({
    org: r.org.name, pages: String(r.pages),
    kind: r.kind ?? (r.note ? '·' : 'unknown'),
    people: r.people != null ? String(r.people) : '·',
    facts: r.facts != null ? String(r.facts) : '·',
    ai: r.sells_ai ? 'sells AI' : '',
    note: r.note ?? '',
  })), [
    { key: 'org', label: 'FIRM', width: 30 },
    { key: 'pages', label: 'PAGES', width: 5, align: 'right' },
    { key: 'kind', label: 'KIND', width: 14 },
    { key: 'people', label: 'NAMED', width: 5, align: 'right' },
    { key: 'facts', label: 'FACTS', width: 5, align: 'right' },
    { key: 'ai', label: 'AI', width: 15 },
    { key: 'note', label: 'NOTE', width: 40 },
  ]));
  console.log(dim(`\n$${totalCost.toFixed(4)} total · run ${runId} · next: npm run gate`));

  finishRun(db, runId, { cost_usd: totalCost, n_in: orgs.length, n_out: rows.length });
  db.close();
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
