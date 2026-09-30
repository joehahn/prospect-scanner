// Proposed searches, written from the operator's own targets and events.
//
// Search terms are not hand-written into sectors.yml and signals.yml; they are
// generated from the plain-prose targets and events in config/business.yml. This stage
// only PROPOSES. It runs no search, spends no search credits, and nothing reads
// its output until the operator has looked at it and said which to keep.
//
// Beside each proposal it prints a sample of the searches the old files compose
// today (a firm shape from a thesis, plus a trigger's discovery terms), so the
// two can be compared on the page.
//
// Usage:
//   npm run queries                 propose, print, and save data/proposed-queries.json
//   npm run queries -- --show       print the last saved proposal, no model call
//   npm run queries -- --compare    run the saved proposal AND an equal sample of the
//                                   old searches through the same search and the same
//                                   filter, and compare what each finds per search.
//                                   Spends search credits; writes nothing to the book.
//   npm run queries -- --adopt      build the search list from what the comparison
//                                   found and the current proposal's untested ones
//   npm run queries -- --adopt --events "a,b"   only the proposal's searches for those events
//                                   (--run takes --events too)
//   npm run queries -- --run [--save]   run the active list, record each search's
//                                   yield, retire a search after two runs with no
//                                   finds; --save adds the finds to the book
//   npm run queries -- --yield      each search's record

import { exemplarText } from './exemplars.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, slugify } from './db.mjs';
import { loadConfig, triggerWeight } from './config.mjs';
import { loadTargeting } from './targeting.mjs';
import { loadBusiness } from './business.mjs';
import { complete } from './models.mjs';
import { searchFunnel } from './measures.mjs';
import { searchNews, creditsUsed } from './sources/tavily.mjs';
import { fetchPage } from './sources/web.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/propose-queries.md';
const OUT = resolve(ROOT, 'data/proposed-queries.json');
const CMP = resolve(ROOT, 'data/query-comparison.json');
const QUALIFY_FILE = 'prompts/qualify-results.md';
const RELEASE_FILE = 'prompts/release-people.md';

const QUALIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['hits'],
  properties: { hits: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['organisation', 'person', 'target', 'event', 'said', 'date', 'url'],
    properties: { organisation: { type: 'string' }, person: { type: 'string' }, target: { type: 'string' },
      event: { type: 'string' }, said: { type: 'string' }, date: { type: 'string' }, url: { type: 'string' } } } } },
};

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['targets'],
  properties: {
    targets: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['target', 'searches', 'appointments_better'],
      properties: {
        target: { type: 'string' },
        searches: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['query', 'event', 'why'],
          properties: { query: { type: 'string' }, event: { type: 'string' }, why: { type: 'string' } } } },
        appointments_better: { type: 'string',
          description: 'One line: are appointment announcements a better source for this target than news search, and why.' },
      } } },
  },
};

/** The targets and events as the filter and the proposer see them. */
function bandText(size) {
  const bits = [];
  if (size?.headcount_max != null) bits.push(`at most ${Number(size.headcount_max).toLocaleString('en-US')} people`);
  if (size?.revenue_max_usd != null) bits.push(`revenue under $${(size.revenue_max_usd / 1e9).toFixed(1)}bn`);
  if (size?.revenue_min_usd != null) bits.push(`revenue over $${(size.revenue_min_usd / 1e6).toFixed(0)}m`);
  return bits.length ? bits.join(', ') : 'no size limit';
}

function businessBlock(b) {
  const where = (t) => t.where?.region ? `${t.where.region} only`
    : t.where?.countries?.length ? `${t.where.countries.join(', ')} only`
    : `${(b.where?.countries ?? []).join(', ') || 'anywhere'}`;
  return [
    `## The operator's targets (where and size are requirements)`,
    ...b.targets.map((t) => `- ${t.name}: ${t.description}\n    where: ${where(t)} · size: ${bandText({ ...b.size, ...(t.size ?? {}) })}`),
    '', '## Events',
    ...b.events.map((e) => `- ${e.name}: ${e.description}`
      + (onWeb(e) ? '\n    found in: what people write and say themselves (posts, talks, podcasts)' : '')
      + (e.does_not_count?.length ? `\n    does NOT count: ${e.does_not_count.map((x) => String(x).slice(0, 160)).join(' | ')}` : '')),
  ].join('\n');
}

// WHERE AN EVENT IS WRITTEN DOWN decides which index can find it. A hire or a
// contract is reported, so the news index holds it. A practitioner saying what
// is hard about their own AI work says it in a post, a talk or a podcast, on
// their firm's blog or a personal one, and a news-only search cannot reach it
// whatever its words. `searched_in: web` on the event says so.
const onWeb = (e) => String(e?.searched_in ?? '').toLowerCase() === 'web';
const indexFor = (b, eventName) => {
  const e = (b.events ?? []).find((x) => String(x.name).toLowerCase() === String(eventName ?? '').toLowerCase());
  return onWeb(e) ? 'general' : 'news';
};

// A VENDOR ANNOUNCING ITS CUSTOMER is the easiest find there is: the customer,
// the project and often the person who owns it, dated, in one release. Those
// releases go out on the wires, and in the open news index they drown under
// stock tips and market-size reports that share every keyword. A search marked
// `searched_in = 'wires'` reads only the wires. Added 2026-09-29: six searches
// written for this in the open index qualified one result between them, the
// release they were modelled on; the same idea against the wires surfaced a
// mid-size insurer choosing an integrator and a bank naming its AI vendor.
const WIRES = ['prnewswire.com', 'businesswire.com', 'globenewswire.com'];
const onWire = (url) => { try { return WIRES.some((d) => new URL(url).hostname.endsWith(d)); } catch { return false; } };

// THE PERSON IS BELOW THE FOLD. A release quotes the customer's own executive
// ("said …, Chief Information Officer of …"), but the search excerpt the filter
// reads stops above the quote, so the find arrives with a firm and no one to
// write to. One fetch of the release, under its robots.txt, and one cheap call
// that returns customer-side people only.
const RELEASE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['people'],
  properties: { people: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['name', 'title', 'quote'],
    properties: { name: { type: 'string' }, title: { type: 'string' }, quote: { type: 'string' } } } } },
};
async function peopleFromRelease(db, runId, model, h) {
  const page = await fetchPage(h.url);
  if (!page.ok) return { people: [], note: `release unread: ${page.error ?? page.status ?? 'refused'}` };
  // THE FILTER CAN FILE A RELEASE UNDER THE WRONG FIRM. On the first run a
  // release about one mutual insurer came back labelled as another, and its CIO
  // and a consultant were added to the wrong firm. A release whose headline does
  // not name the customer is not about the customer.
  const words = String(h.organisation).replace(/\b(the|inc|llc|corp(oration)?|company|companies|group|co)\b\.?/gi, ' ')
    .split(/\W+/).filter((w) => w.length > 2);
  // The HEADLINE, not the page: the mislabelled release named the right firm
  // too, in a related-news link down the side.
  const head = String(page.title ?? '').toLowerCase();
  // Its first distinctive word: a headline says "Acme Mutual", not the full
  // registered name with "Insurance Company" on the end.
  if (!words.length || !head.includes(words[0].toLowerCase())) {
    return { people: [], note: `headline does not name ${h.organisation}; the find may be mislabelled` };
  }
  const res = await complete(db, runId, {
    model, system: readFileSync(resolve(ROOT, RELEASE_FILE), 'utf8'), schema: RELEASE_SCHEMA,
    effort: 'low', thinking: false, maxTokens: 1500,
    messages: [{ role: 'user', content: `## Customer organisation\n${h.organisation}\n\n## Release\n${h.url}\n\n`
      + String(page.text ?? '').slice(0, 14000) }] });
  const text = String(page.text ?? '');
  // A name the release does not contain is not in the release.
  const people = (res.data?.people ?? []).filter((x) => /\s/.test(x.name?.trim() ?? '') && text.includes(x.name.trim()));
  return { people, viaBrowser: page.viaBrowser };
}

const searchFor = (b, q) => q.searched_in === 'wires'
  ? { topic: 'wires', args: { topic: 'news', requireDate: true, includeDomains: WIRES } }
  : ((t) => ({ topic: t, args: { topic: t, requireDate: t === 'news' } }))(indexFor(b, q.event));

/**
 * Old against new, on equal terms. Same search call, same window, same number
 * of results per search, and one filter call per search with the same prompt.
 * The old set is sampled evenly across each active thesis's composed searches,
 * as many as the new set has. Measures what matters for intake: organisations
 * found doing a listed event, inside a target, per search -- and how many of
 * them the book does not already hold.
 */
async function compare(cfg, targeting, b) {
  if (!existsSync(OUT)) throw new Error('No proposal saved. Run npm run queries first.');
  const saved = JSON.parse(readFileSync(OUT, 'utf8'));
  const fresh = saved.targets.flatMap((t) => t.searches.map((q) => q.query));
  const old = [];
  const pools = oldSearches(cfg, targeting, { all: true }).filter((o) => o.all.length);
  const per = Math.ceil(fresh.length / pools.length);
  for (const o of pools) {
    const step = Math.max(1, Math.floor(o.all.length / per));
    for (let i = 0; i < o.all.length && old.filter((x) => x.thesis === o.thesis).length < per; i += step) {
      old.push({ thesis: o.thesis, query: o.all[i] });
    }
  }
  const oldQs = old.slice(0, fresh.length).map((x) => x.query);
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const db = openDb();
  const known = db.prepare('SELECT name FROM orgs').all().map((r) => r.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const inBook = (n) => { const k = String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
    return k.length > 3 && known.some((x) => x === k || (x.length > 5 && (x.includes(k) || k.includes(x)))); };
  const model = cfg.models?.cheap;
  const runId = startRun(db, 'queries-compare', { model });
  const system = readFileSync(resolve(ROOT, QUALIFY_FILE), 'utf8');
  const context = businessBlock(b);
  const runSet = async (label, qs) => {
    const rows = [];
    for (const q of qs) {
      const { results = [], error } = await searchNews(q, { sinceDate: since, maxResults: 6 });
      let hits = [];
      if (results.length) {
        const res = await complete(db, runId, { model, system, schema: QUALIFY_SCHEMA, effort: 'low',
          thinking: false, maxTokens: 3000, messages: [{ role: 'user', content: `${context}\n\n## Search: ${q}\n\n`
            + results.map((r, i) => `[${i + 1}] ${r.title} (${r.published_on ?? 'undated'}) ${r.url}\n${r.snippet}`).join('\n\n') }] });
        hits = (res.data?.hits ?? []).map((h) => ({ ...h, new_to_book: !inBook(h.organisation) }));
      }
      rows.push({ query: q, results: results.length, error: error ?? null, hits });
      process.stdout.write(dim(`  ${label} ${String(rows.length).padStart(2)}/${qs.length}  ${hits.length} found  ${q.slice(0, 70)}\n`));
    }
    return rows;
  };
  const c0 = creditsUsed();
  const newRows = await runSet('new', fresh);
  const c1 = creditsUsed();
  const oldRows = await runSet('old', oldQs);
  const c2 = creditsUsed();
  finishRun(db, runId, { tavily_credits: c2 - c0 });
  db.close();
  const sum = (rows, credits) => {
    const hits = rows.flatMap((r) => r.hits);
    const orgs = new Set(hits.map((h) => h.organisation.toLowerCase()));
    const newOrgs = new Set(hits.filter((h) => h.new_to_book).map((h) => h.organisation.toLowerCase()));
    return { searches: rows.length, credits, results: rows.reduce((a, r) => a + r.results, 0),
      qualified: hits.length, organisations: orgs.size, new_to_book: newOrgs.size,
      with_person: hits.filter((h) => h.person && h.person.trim()).length,
      searches_that_found_any: rows.filter((r) => r.hits.length).length,
      targets: [...new Set(hits.map((h) => h.target))] };
  };
  const out = { run_at: new Date().toISOString(), since, filter: QUALIFY_FILE, model,
    new: { summary: sum(newRows, c1 - c0), rows: newRows }, old: { summary: sum(oldRows, c2 - c1), rows: oldRows } };
  writeFileSync(CMP, JSON.stringify(out, null, 2));
  return out;
}

// ---- the search list, and what each search has found ----------------------
//
// SEARCHES ARE DATA, NOT CONFIG. They are generated from business.yml and then
// judged by what they find, so they live in the database beside their record,
// where a search that stops paying can be seen and retired.
function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL UNIQUE,
    target TEXT, event TEXT,
    origin TEXT NOT NULL,             -- proposed | legacy
    status TEXT NOT NULL DEFAULT 'active',  -- active | retired
    retired_reason TEXT,
    created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS search_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id INTEGER NOT NULL REFERENCES searches(id),
    run_at TEXT NOT NULL,
    results INTEGER, qualified INTEGER, new_finds INTEGER, new_to_book INTEGER, with_person INTEGER,
    hits TEXT,                        -- JSON, every qualifying result with its URL
    filter TEXT, run_id INTEGER REFERENCES runs(id))`);
  if (!db.prepare(`PRAGMA table_info(search_runs)`).all().some((c) => c.name === 'topic')) {
    db.exec(`ALTER TABLE search_runs ADD COLUMN topic TEXT`);
  }
  if (!db.prepare(`PRAGMA table_info(searches)`).all().some((c) => c.name === 'searched_in')) {
    db.exec(`ALTER TABLE searches ADD COLUMN searched_in TEXT`);   // null: the event's index; 'wires'
  }
}

const RETIRE_AFTER = 2;   // consecutive runs with nothing qualifying

/** The list: what found something in the comparison, plus the current proposal's untested searches. */
function adopt(db, { events = null } = {}) {
  ensureTables(db);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO searches (query, target, event, origin, created_at) VALUES (?, ?, ?, ?, ?)`);
  const top = (xs) => Object.entries(xs.reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  let n = 0;
  if (existsSync(CMP) && !events) {
    const c = JSON.parse(readFileSync(CMP, 'utf8'));
    for (const [origin, set] of [['proposed', c.new], ['legacy', c.old]]) {
      for (const r of set.rows.filter((x) => x.hits.length)) {
        n += ins.run(r.query, top(r.hits.map((h) => h.target)), top(r.hits.map((h) => h.event)), origin, now).changes;
      }
    }
  }
  if (existsSync(OUT)) {
    const p = JSON.parse(readFileSync(OUT, 'utf8'));
    const tried = new Set(existsSync(CMP) ? JSON.parse(readFileSync(CMP, 'utf8')).new.rows.map((r) => r.query) : []);
    const wanted = (q) => !events || events.includes(String(q.event).toLowerCase());
    for (const t of p.targets) for (const q of t.searches) {
      if (!tried.has(q.query) && wanted(q)) n += ins.run(q.query, t.target, q.event, 'proposed', now).changes;
    }
  }
  return n;
}

/** Run the active list once, record each search's yield, retire what keeps finding nothing. */
async function runList(cfg, b, { save = false, events = null, wires = false } = {}) {
  const db = openDb();
  ensureTables(db);
  const list = db.prepare(`SELECT * FROM searches WHERE status = 'active' ORDER BY id`).all()
    .filter((x) => !events || events.includes(String(x.event).toLowerCase()))
    .filter((x) => !wires || x.searched_in === 'wires');
  if (!list.length) { db.close(); throw new Error('No active searches. Run npm run queries -- --adopt.'); }
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const orgs = db.prepare('SELECT id, name FROM orgs').all();
  const key = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
  const findOrg = (n) => { const k = key(n);
    return k.length > 3 ? orgs.find((o) => { const x = key(o.name); return x === k || (x.length > 5 && (x.includes(k) || k.includes(x))); }) : null; };
  const seenBefore = new Set(db.prepare('SELECT hits FROM search_runs').all()
    .flatMap((r) => JSON.parse(r.hits || '[]').map((h) => `${key(h.organisation)}|${h.url}`)));
  const model = cfg.models?.cheap;
  const forbidden = (cfg.forbidden_hosts ?? []).map((h) => (typeof h === 'string' ? h : h.host)).filter(Boolean);
  const runId = startRun(db, 'queries-run', { model });
  const system = readFileSync(resolve(ROOT, QUALIFY_FILE), 'utf8');
  const context = businessBlock(b);
  const insRun = db.prepare(`INSERT INTO search_runs (search_id, run_at, results, qualified, new_finds, new_to_book,
      with_person, hits, filter, run_id, topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const c0 = creditsUsed();
  const report = [];
  for (const q of list) {
    // A web page often carries no machine-readable date; the filter reads the
    // page's own words for one, and an undated find is saved without a signal.
    const { topic, args } = searchFor(b, q);
    // A web search reaches sites a news search never did, job postings on the
    // forbidden hosts among them. Their pages are not ours to take, even second hand.
    const { results = [] } = await searchNews(q.query, { sinceDate: since, maxResults: 6, ...args,
      excludeDomains: forbidden });
    let hits = [];
    if (results.length) {
      const res = await complete(db, runId, { model, system, schema: QUALIFY_SCHEMA, effort: 'low', thinking: false,
        maxTokens: 3000, messages: [{ role: 'user', content: `${context}\n\n## Search: ${q.query}\n\n`
          + results.map((r, i) => `[${i + 1}] ${r.title} (${r.published_on ?? 'undated'}) ${r.url}\n${r.snippet}`).join('\n\n') }] });
      hits = (res.data?.hits ?? []).map((h) => ({ ...h, in_book: Boolean(findOrg(h.organisation)) }));
    }
    const fresh = hits.filter((h) => !seenBefore.has(`${key(h.organisation)}|${h.url}`));
    fresh.forEach((h) => seenBefore.add(`${key(h.organisation)}|${h.url}`));
    insRun.run(q.id, new Date().toISOString(), results.length, hits.length, fresh.length,
      fresh.filter((h) => !h.in_book).length, hits.filter((h) => h.person?.trim()).length,
      JSON.stringify(hits), QUALIFY_FILE, runId, topic);
    // RETIRE WHAT KEEPS FINDING NOTHING, with the reason, never silently.
    const lastRuns = db.prepare(`SELECT qualified FROM search_runs WHERE search_id = ? ORDER BY id DESC LIMIT ?`).all(q.id, RETIRE_AFTER);
    if (lastRuns.length >= RETIRE_AFTER && lastRuns.every((r) => !r.qualified)) {
      db.prepare(`UPDATE searches SET status = 'retired', retired_reason = ? WHERE id = ?`)
        .run(`nothing qualified in ${RETIRE_AFTER} consecutive runs (last ${new Date().toISOString().slice(0, 10)})`, q.id);
    }
    report.push({ q, hits, fresh });
    process.stdout.write(dim(`  ${String(report.length).padStart(2)}/${list.length}  ${String(hits.length).padStart(2)} found  ${fresh.length} new  ${q.query.slice(0, 70)}\n`));
  }
  const named = [];
  for (const r of report) for (const h of r.fresh) {
    if (h.person?.trim() || !onWire(h.url)) continue;
    const { people, note, viaBrowser } = await peopleFromRelease(db, runId, model, h);
    h.people = people;
    named.push(`${h.organisation}: ${people.length ? people.map((x) => `${x.name} (${x.title})`).join(', ') : note ?? 'no one at the customer named'}${viaBrowser ? ' [browser]' : ''}`);
  }
  if (named.length) console.log(dim(`  read ${named.length} release(s) for the customer's people:\n    ${named.join('\n    ')}`));
  let saved = 0;
  if (save) saved = saveFinds(db, cfg, report.flatMap((r) => r.fresh.map((h) => ({ ...h, query: r.q.query }))), findOrg);
  finishRun(db, runId, { tavily_credits: creditsUsed() - c0 });
  db.close();
  return { report, credits: creditsUsed() - c0, saved };
}

/**
 * Finds into the book, the way discovery adds them: a firm with no kind (so gate
 * and rank skip it until `lead vet`), the named person if there is one, and the
 * event as sourced evidence. An event that matches one of the old triggers also
 * becomes a signal, so the rest of the pipeline sees it.
 */
/** The customer's people a release named, each with their quote as their own evidence. */
function savePeople(db, orgId, h, date, stamp) {
  for (const x of h.people ?? []) {
    const id = slugify(x.name);
    const other = db.prepare('SELECT org_id FROM people WHERE id = ?').get(id);
    if (other && other.org_id !== orgId) continue;
    if (!other) {
      db.prepare(`INSERT INTO people (id, org_id, name, title, notes) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, x.name.trim(), x.title?.trim() || null, `Named in a press release, ${date ?? 'undated'}: ${h.url}`);
    }
    db.prepare(`INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance)
        VALUES (?, ?, 'public_utterance', ?, ?, ?, 'retrieved')
        ON CONFLICT(org_id, kind, source_url, claim) DO NOTHING`)
      .run(orgId, id, `${x.name.trim()}, ${x.title?.trim() || 'title not given'}`
        + (x.quote?.trim() ? `, in the release: "${x.quote.trim()}"` : ', named in the release')
        + (date ? ` (${date})` : ''), h.url, stamp);
  }
}

/**
 * Backfill: releases already found by wire searches whose firm still has no one
 * in the book. `npm run queries -- --release-people`.
 */
async function releasePeople(cfg) {
  const db = openDb();
  const model = cfg.models?.cheap;
  const runId = startRun(db, 'release-people', { model });
  const rows = db.prepare(`SELECT r.hits, r.run_at FROM search_runs r JOIN searches s ON s.id = r.search_id
      WHERE s.searched_in = 'wires' AND r.qualified > 0`).all();
  const seen = new Set();
  const key = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
  const orgs = db.prepare('SELECT id, name FROM orgs').all();
  for (const r of rows) for (const h of JSON.parse(r.hits || '[]')) {
    if (seen.has(h.url) || !onWire(h.url)) continue; seen.add(h.url);
    const org = orgs.find((o) => key(o.name) === key(h.organisation));
    if (!org) continue;
    if (db.prepare('SELECT 1 FROM people WHERE org_id = ?').get(org.id)) continue;
    const { people, note, viaBrowser } = await peopleFromRelease(db, runId, model, h);
    const date = /^\d{4}-\d{2}-\d{2}/.test(h.date ?? '') ? h.date.slice(0, 10) : null;
    savePeople(db, org.id, { ...h, people }, date, new Date().toISOString());
    console.log(`  ${org.name}: ${people.length ? people.map((x) => `${x.name} (${x.title})`).join(', ') : note ?? 'no one at the customer named'}${viaBrowser ? ' [browser]' : ''}`);
  }
  finishRun(db, runId, {});
  db.close();
}

function saveFinds(db, cfg, finds, findOrg) {
  const day = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString();
  let n = 0;
  for (const h of finds) {
    const existing = findOrg(h.organisation);
    const orgId = existing?.id ?? slugify(h.organisation);
    db.prepare(`INSERT OR IGNORE INTO orgs (id, name, first_seen, source, seeded) VALUES (?, ?, ?, ?, 0)`)
      .run(orgId, h.organisation, day, `intake search: ${h.query}`);
    const date = /^\d{4}-\d{2}-\d{2}/.test(h.date ?? '') ? h.date.slice(0, 10) : null;
    let personId = null;
    if (h.person?.trim() && /\s/.test(h.person.trim())) {
      personId = slugify(h.person);
      const other = db.prepare('SELECT org_id FROM people WHERE id = ?').get(personId);
      if (!other) {
        db.prepare(`INSERT INTO people (id, org_id, name, notes) VALUES (?, ?, ?, ?)`)
          .run(personId, orgId, h.person.trim(), `Named in a search find, ${date ?? 'undated'}: ${h.url}`);
      } else if (other.org_id !== orgId) personId = null;
    }
    const ev = db.prepare(`INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance)
        VALUES (?, ?, 'news_event', ?, ?, ?, 'retrieved')
        ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET retrieved_at = excluded.retrieved_at RETURNING id`)
      .get(orgId, personId, h.said?.trim()
        ? `${h.organisation}: ${h.said.trim()}${date ? ` (${date})` : ''}`
        : `${h.organisation}: ${h.event}${h.person ? ` (${h.person})` : ''}${date ? ` (${date})` : ''}`,
        h.url, stamp);
    savePeople(db, orgId, h, date, stamp);
    const trig = (cfg.triggers ?? []).find((t) => t.id === String(h.event).replace(/\s+/g, '_'));
    if (trig && date) {
      const decay = new Date(Date.parse(date) + (trig.decay_days ?? 365) * 86_400_000).toISOString().slice(0, 10);
      db.prepare(`INSERT OR IGNORE INTO signals (org_id, trigger_id, detected_at, decays_at, weight, evidence_id)
          VALUES (?, ?, ?, ?, ?, ?)`).run(orgId, trig.id, date, decay, triggerWeight(cfg, trig.id), ev.id);
    }
    n++;
  }
  return n;
}

/**
 * Each search's record, followed down the funnel. Finding firms is the top of
 * it; what a search is worth is how far its finds get: through the gates, to a
 * high rating from the judge, to the operator's own "write", to a note sent and
 * a reply. Every stage is already recorded (gate_results, judgments, verdicts,
 * outreach, responses), so this adds no data, it follows the finds through it.
 */
function yieldReport() {
  // Computed in measures.mjs, shared with the dashboard's Searches page.
  const db = openDb();
  ensureTables(db);
  const rows = searchFunnel(db);
  db.close();
  console.log(heading(`Search yield, down the funnel · ${rows.filter((r) => r.status === 'active').length} active, `
    + `${rows.filter((r) => r.status === 'retired').length} retired`));
  console.log(dim('  runs  firms  alive  rated4+  you-write  sent  replied  origin    search'));
  const c = (x, w) => String(x).padStart(w);
  for (const r of rows) {
    console.log(`  ${c(r.runs, 4)}  ${c(r.found, 5)}  ${c(r.alive, 5)}  ${c(r.rated, 7)}  ${c(r.wrote, 9)}  ${c(r.sent, 4)}  ${c(r.replied, 7)}  `
      + `${r.origin.padEnd(8)}  ${r.status === 'retired' ? dim(`[retired] ${r.query.slice(0, 90)}`) : r.query.slice(0, 90)}`);
  }
}

/** What the old files compose today, per thesis: shape + trigger terms, a sample. */
function oldSearches(cfg, targeting, { all = false } = {}) {
  const out = [];
  for (const v of (targeting.live ?? targeting.verticals ?? []).filter((x) => (x.discovery ?? 'active') !== 'paused')) {
    const trigs = (v.triggers ?? []).map((t) => {
      const g = (cfg.triggers ?? []).find((x) => x.id === t.id);
      return g && (t.discovery_terms || g.discovery_terms) ? (t.discovery_terms || g.discovery_terms) : null;
    }).filter(Boolean);
    const qs = [];
    for (const shape of v.firm_shapes ?? []) for (const terms of trigs) qs.push(`${shape} ${terms}`.replace(/\s+/g, ' '));
    out.push({ thesis: v.name ?? v.id, count: qs.length, sample: qs.slice(0, 3), ...(all ? { all: qs } : {}) });
  }
  return out;
}

function print(saved, old) {
  for (const t of saved.targets) {
    console.log(`\n${bold(t.target)}`);
    for (const q of t.searches) console.log(`  ${q.query}\n    ${dim(`${q.event} — ${q.why}`)}`);
    console.log(dim(`  appointments: ${t.appointments_better}`));
  }
  if (old?.length) {
    console.log(heading('What the old files compose today, for comparison'));
    for (const o of old) {
      console.log(`\n${bold(o.thesis)} ${dim(`(${o.count} searches)`)}`);
      for (const q of o.sample) console.log(dim(`  ${q.length > 150 ? `${q.slice(0, 150)}…` : q}`));
    }
  }
}

async function main() {
  // --events "a,b": with --adopt, only the proposal's searches for those events;
  // with --run, only the active searches for them.
  const ei = process.argv.indexOf('--events');
  const events = ei > 0 ? process.argv[ei + 1].split(',').map((x) => x.trim().toLowerCase()) : null;
  const cfg = loadConfig();
  const targeting = loadTargeting(cfg);
  if (process.argv.includes('--yield')) { yieldReport(); return; }
  if (process.argv.includes('--release-people')) { await releasePeople(cfg); return; }
  if (process.argv.includes('--adopt')) {
    const db = openDb(); const n = adopt(db, { events });
    const t = db.prepare(`SELECT origin, COUNT(*) c FROM searches WHERE status = 'active' GROUP BY origin`).all();
    db.close();
    console.log(`adopted ${n} search(es); active now: ${t.map((x) => `${x.c} ${x.origin}`).join(', ')}`);
    return;
  }
  if (process.argv.includes('--run')) {
    const b = loadBusiness(cfg, targeting);
    const r = await runList(cfg, b, { save: process.argv.includes('--save'), events,
      wires: process.argv.includes('--wires') });
    const hits = r.report.flatMap((x) => x.fresh);
    console.log(heading(`Ran ${r.report.length} searches · ${r.credits} credits · ${hits.length} new finds`
      + `${r.saved ? ` · ${r.saved} added to the book` : ' · nothing added (pass --save)'}`));
    for (const h of hits) console.log(`  ${h.organisation}${h.person ? ` — ${h.person}` : ''} ${dim(`· ${h.event} · ${h.date || 'undated'} · ${h.target}`)}`
      + (h.in_book ? dim(' · already in the book') : ''));
    console.log(dim('\nnpm run queries -- --yield for each search\'s record'));
    return;
  }
  if (process.argv.includes('--compare')) {
    const b = loadBusiness(cfg, targeting);
    const r = await compare(cfg, targeting, b);
    console.log(heading('Old searches against new, same search and same filter'));
    const rows = [['searches', 'searches'], ['search credits', 'credits'], ['results read', 'results'],
      ['qualified (named org, listed event, in a target)', 'qualified'], ['distinct organisations', 'organisations'],
      ['  of which not already in the book', 'new_to_book'], ['with a named person', 'with_person'],
      ['searches that found anything', 'searches_that_found_any']];
    console.log(`${''.padEnd(52)}${'new'.padStart(8)}${'old'.padStart(8)}`);
    for (const [label, k] of rows) console.log(`${label.padEnd(52)}${String(r.new.summary[k]).padStart(8)}${String(r.old.summary[k]).padStart(8)}`);
    console.log(`\ntargets reached — new: ${r.new.summary.targets.length} · old: ${r.old.summary.targets.length}`);
    console.log(dim(`\nFull results, every hit with its URL: data/query-comparison.json`));
    return;
  }
  if (process.argv.includes('--show')) {
    if (!existsSync(OUT)) { console.log('Nothing saved yet. Run npm run queries.'); return; }
    print(JSON.parse(readFileSync(OUT, 'utf8')), oldSearches(cfg, targeting));
    return;
  }
  const b = loadBusiness(cfg, targeting);
  const content = [
    `## The operator's targets (from ${b._source})`,
    ...b.targets.map((t) => `- ${t.name}: ${t.description}`
      + (t.where?.countries?.length ? `\n    where: ${t.where.countries.join(', ')}` : '')
      + (t.where?.region ? `\n    region: ${t.where.region} (put this in every search for this target)` : '')
      + (t.examples?.length ? `\n    e.g. ${t.examples.join('; ')}` : '')),
    '', `Default geography: ${(b.where?.countries ?? []).join(', ') || 'not stated'}`
      + (b.where?.home_region ? `; home region ${b.where.home_region}` : ''),
    '', '## Events worth writing on',
    ...b.events.map((e) => `- ${e.name}: ${e.description}`
      + (onWeb(e) ? '\n    searched in: the whole web (found in what people write and say themselves)' : '')
      + (e.does_not_count?.length ? `\n    does NOT count: ${e.does_not_count.map((x) => String(x).slice(0, 160)).join(' | ')}` : '')),
  ].join('\n');

  const db = openDb();
  // THE SEARCHES' OWN RECORD (2026-09-29): which ones produced prospects the
  // judge rated 4 or 5, the operator would write to, or wrote to, and which
  // found nothing. Examples to write more like, and less like: the same move
  // the judge and the drafter make, applied to finding people.
  const funnel = searchFunnel(db);
  const winners = funnel.filter((s) => s.rated || s.wrote || s.sent)
    .sort((a, b) => (b.sent - a.sent) || (b.wrote - a.wrote) || (b.rated - a.rated)).slice(0, 12);
  const losers = funnel.filter((s) => s.runs >= 1 && !s.found).slice(0, 12);
  const yieldBlock = !funnel.length ? '' : [
    '', '## What the searches have yielded so far',
    'Write more like these (each produced prospects rated 4-5, chosen, or written to):',
    ...(winners.length ? winners.map((s) => `- "${s.query}" (${s.event ?? 'event?'}): found ${s.found} firms, `
      + `${s.rated} rated 4+, ${s.wrote} chosen, ${s.sent} written to`) : ['- (none yet)']),
    '', 'Fewer like these (found nothing):',
    ...(losers.length ? losers.map((s) => `- "${s.query}"`) : ['- (none yet)']),
    '', 'Searches already on the list (do not repeat them):',
    ...funnel.filter((s) => s.status === 'active').map((s) => `- "${s.query}"`),
  ].join('\n');
  // THE OPERATOR'S EXAMPLES, per target: people he wants more of, with what he
  // said about them and what is on file. Searches are written to find their
  // look-alikes (propose-queries v6).
  const examples = b.targets.filter((t) => t.exemplars?.length)
    .map((t) => `\n## Examples for "${t.name}": find more like these\n${exemplarText(db, t, { full: false })}`).join('\n');
  const contentWithYield = content + examples + yieldBlock;
  const model = cfg.models?.default;
  const runId = startRun(db, 'queries', { model });
  const res = await complete(db, runId, {
    model, system: readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8'), schema: SCHEMA,
    effort: 'medium', maxTokens: 24000, messages: [{ role: 'user', content: contentWithYield }] });
  finishRun(db, runId, {});
  db.close();

  const saved = { proposed_at: new Date().toISOString(), from: b._source, prompt: PROMPT_FILE,
    model: res.model ?? model, cost_usd: res.cost_usd ?? 0, approved: false, targets: res.data?.targets ?? [] };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(saved, null, 2));
  console.log(heading(`Proposed searches · ${saved.targets.length} targets · $${(saved.cost_usd).toFixed(3)} · nothing was run`));
  print(saved, oldSearches(cfg, targeting));
  console.log(dim(`\nSaved to data/proposed-queries.json (approved: false). Nothing uses them yet.`));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
