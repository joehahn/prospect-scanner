// Firms first: find a target's firms through the lists that group them.
//
// WHY THIS EXISTS. Most targets are found event-first: something happened, a
// search finds it, the firm follows. Some kinds of firm publish no events. A
// small recruiting firm placing contractors announces nothing a news search
// will find, and a web search for its job postings returns mostly large vendor
// chains (2026-09-29: seven searches, one find, an entry-level posting). What
// such firms do appear on is a list: a business-journal ranking, an
// association's directory, a "top firms in" roundup.
//
// NOTHING ENTERS THE BOOK UNCHECKED. A list is a claim about a firm, made by a
// publisher. Candidates wait in `firm_candidates`, outside the book, until the
// firm's own site has been read (the same `vet` as everywhere else). A firm is
// admitted only when all three hold:
//   1. its own site makes it a kind the target names (`where.kinds`);
//   2. its own site's description shows the target's `specialty`, where it
//      names one (a cheap model reads the sentence, prompts/check-specialty.md);
//   3. no gate kills it;
//   4. its site names someone in one of the target's `seats`, so there is a
//      person to write to. A firm large enough not to name its recruiters is
//      also one the target does not want.
// Anything else is taken back out of the book, every row the vet wrote, and the
// candidate keeps the reason. At an admitted firm, people outside the seats are
// removed too: a controller is correctly extracted and is not a prospect.
//
// Usage:
//   npm run firms -- [--target "<name>"] [--place "Twin Cities, MN"]
//                    [--searches 4] [--limit 10] [--dry]
//                    --dry finds and lists candidates, vets nothing
//   npm run firms -- --vet [--target ...] [--limit 10]   vet candidates already found
//   npm run firms -- --show                              the candidate list and outcomes
//   npm run firms -- --recheck [--apply]                 the specialty check on firms already
//                                                        admitted; --apply takes out the ones
//                                                        that fail
//   npm run firms -- --prune [--target ...]              apply the seat rule to firms
//                                                        of the target's kinds already
//                                                        in the book

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, slugify, purgeOrg, purgePeople } from './db.mjs';
import { loadConfig } from './config.mjs';
import { loadBusiness, inSeat } from './business.mjs';
import { complete, promptBody } from './models.mjs';
import { searchNews, creditsUsed } from './sources/tavily.mjs';
import { fetchPage } from './sources/web.mjs';
import { heading, bold, dim, truncate } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LISTS_FILE = 'prompts/find-firm-lists.md';
const EXTRACT_FILE = 'prompts/extract-firm-list.md';
const SPECIALTY_FILE = 'prompts/check-specialty.md';

const QUERIES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['queries'],
  properties: { queries: { type: 'array', items: { type: 'string' } } },
};
const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['is_list', 'firms'],
  properties: {
    is_list: { type: 'boolean' },
    firms: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'domain', 'said'],
      properties: { name: { type: 'string' }, domain: { type: ['string', 'null'] }, said: { type: 'string' } },
    } },
  },
};

const SPECIALTY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['fits', 'why'],
  properties: { fits: { type: 'boolean' }, why: { type: 'string' } },
};

/** What the firm's own site says it does, as enrich recorded it. */
const describedAs = (db, orgId) => db.prepare(`SELECT claim FROM evidence WHERE org_id = ?
  AND kind = 'firm_profile' ORDER BY id DESC LIMIT 1`).get(orgId)?.claim ?? null;

/** Whether a firm's own description shows the target's specialty. Null when it names none. */
async function hasSpecialty(db, cfg, runId, target, orgId) {
  if (!target.specialty) return null;
  const said = describedAs(db, orgId);
  if (!said) return { fits: false, why: 'its site gave no description of what it does' };
  const r = await complete(db, runId, { model: cfg.models?.cheap, system: promptBody(SPECIALTY_FILE),
    schema: SPECIALTY_SCHEMA, effort: 'low', thinking: false, maxTokens: 400, messages: [{ role: 'user',
      content: `## Specialty\n${target.specialty}\n\n## What the firm's own site says it does\n${said}` }] });
  return r.data ?? { fits: false, why: 'the check returned nothing' };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument "${argv[i]}"`);
    const k = argv[i].slice(2); const n = argv[i + 1];
    if (n && !n.startsWith('--')) { a[k] = n; i++; } else a[k] = true;
  }
  return a;
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS firm_candidates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    key         TEXT NOT NULL UNIQUE,      -- slug of the name: one row per firm
    domain      TEXT,                      -- only when the list gave it
    said        TEXT,                      -- the list's own words about the firm
    source_url  TEXT NOT NULL,             -- the list it came from
    query       TEXT,
    target      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | admitted | rejected | in_book
    reason      TEXT,
    org_id      TEXT,                      -- set once admitted
    found_at    TEXT NOT NULL,
    checked_at  TEXT)`);
}

/** The target to work on: named, or the only one limited to firm kinds. */
function pickTarget(b, name) {
  const firmFirst = (b.targets ?? []).filter((t) => t.where?.kinds?.length);
  if (name) {
    const t = (b.targets ?? []).find((x) => x.name.toLowerCase().startsWith(String(name).toLowerCase()));
    if (!t) throw new Error(`no target starts with "${name}". Targets: ${b.targets.map((x) => x.name).join('; ')}`);
    if (!t.where?.kinds?.length) throw new Error(`"${t.name}" names no where.kinds, so nothing can decide admission`);
    if (!t.seats?.length) throw new Error(`"${t.name}" names no seats, so nothing says who is worth writing to`);
    return t;
  }
  if (firmFirst.length !== 1) {
    throw new Error(`pass --target: ${firmFirst.length} targets carry where.kinds ` +
      `(${firmFirst.map((t) => t.name).join('; ') || 'none'})`);
  }
  if (!firmFirst[0].seats?.length) throw new Error(`"${firmFirst[0].name}" names no seats`);
  return firmFirst[0];
}

const forbiddenHosts = (cfg) => (cfg.forbidden_hosts ?? [])
  .map((h) => (typeof h === 'string' ? h : h.host)).filter(Boolean);
const onHost = (url, hosts) => {
  try { const h = new URL(url).hostname; return hosts.some((x) => h === x || h.endsWith(`.${x}`)); }
  catch { return true; }
};
const cleanDomain = (d) => (d ? String(d).trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null : null);

/** Step one and two: lists found, firms read off them, candidates stored. */
async function find(db, cfg, b, target, args) {
  const model = cfg.models?.cheap;
  const hosts = forbiddenHosts(cfg);
  const runId = startRun(db, 'firms-find', { model });
  const c0 = creditsUsed();
  const place = args.place && args.place !== true ? String(args.place) : null;
  const n = Number(args.searches ?? 4);

  const q = await complete(db, runId, { model, system: promptBody(LISTS_FILE), schema: QUERIES_SCHEMA,
    effort: 'low', thinking: false, maxTokens: 1000, messages: [{ role: 'user', content:
      `## Target\n${target.name}: ${target.description}\n\nFirm kinds: ${target.where.kinds.join(', ')}\n` +
      `${target.specialty ? `Specialty: ${target.specialty}\n` : ''}` +
      `${place ? `Place: ${place}\n` : 'Place: anywhere in the operator\'s countries\n'}` +
      `\nWrite ${n} searches.` }] });
  const queries = (q.data?.queries ?? []).slice(0, n);

  const known = new Set(db.prepare('SELECT key FROM firm_candidates').all().map((r) => r.key));
  const inBook = new Map();
  for (const o of db.prepare('SELECT id, domain FROM orgs').all()) {
    inBook.set(o.id, o.id);
    if (o.domain) inBook.set(cleanDomain(o.domain), o.id);
  }
  const ins = db.prepare(`INSERT OR IGNORE INTO firm_candidates
    (name, key, domain, said, source_url, query, target, status, reason, org_id, found_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seenUrls = new Set();
  let added = 0; let lists = 0;
  for (const query of queries) {
    const { results = [] } = await searchNews(query, { topic: 'general', requireDate: false,
      maxResults: 5, excludeDomains: hosts });
    for (const r of results) {
      if (seenUrls.has(r.url) || onHost(r.url, hosts)) continue;
      seenUrls.add(r.url);
      const page = await fetchPage(r.url, { allowBrowser: false });
      if (!page.ok || !page.text) continue;
      const ex = await complete(db, runId, { model, system: promptBody(EXTRACT_FILE), schema: EXTRACT_SCHEMA,
        effort: 'low', thinking: false, maxTokens: 6000, messages: [{ role: 'user', content:
          `## The kind of firm\n${target.description}\n\n## Page: ${r.url}\n${page.title ?? ''}\n\n` +
          page.text.slice(0, 40_000) }] });
      if (!ex.data?.is_list) continue;
      lists++;
      let fromThis = 0;
      for (const f of ex.data.firms ?? []) {
        const key = slugify(f.name);
        if (!f.name?.trim() || known.has(key)) continue;
        known.add(key);
        const domain = cleanDomain(f.domain);
        const already = inBook.get(key) ?? (domain && inBook.get(domain));
        ins.run(f.name.trim(), key, domain, f.said || null, r.url, query, target.name,
          already ? 'in_book' : 'pending', already ? `already in the book as ${already}` : null,
          already ?? null, new Date().toISOString());
        if (!already) { added++; fromThis++; }
      }
      console.log(dim(`  list  ${String(fromThis).padStart(3)} new  ${truncate(page.title || r.url, 90)}`));
    }
  }
  finishRun(db, runId, { tavily_credits: creditsUsed() - c0 });
  console.log(`\n${queries.length} searches · ${lists} lists read · ${bold(String(added))} new candidates, ` +
    'none of them in the book yet');
  return added;
}

/** Run a lead subcommand, returning its output whatever the exit code. */
function lead(args) {
  try {
    return execFileSync('node', ['--env-file-if-exists=.env', 'src/lead.mjs', ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { return (err.stdout ?? '') + (err.stderr ?? ''); }
}

/** Step three: each candidate's own site, then admit or take it back out. */
async function vetCandidates(db, cfg, target, args) {
  const limit = Number(args.limit ?? 10);
  const rows = db.prepare(`SELECT * FROM firm_candidates WHERE status = 'pending' AND target = ?
    ORDER BY (domain IS NULL), id LIMIT ?`).all(target.name, limit);
  if (!rows.length) { console.log('no pending candidates. Run without --vet to find some.'); return; }
  const done = db.prepare(`UPDATE firm_candidates SET status = ?, reason = ?, org_id = ?, checked_at = ?
    WHERE id = ?`);
  const tally = { admitted: 0, rejected: 0 };
  const runId = startRun(db, 'firms-vet', { model: cfg.models?.cheap });

  console.log(heading(`Vetting ${rows.length} candidate(s) for "${target.name}"`));
  for (const c of rows) {
    const now = new Date().toISOString();
    if (db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(c.key)) {
      done.run('in_book', `already in the book as ${c.key}`, c.key, now, c.id);
      continue;
    }
    const reject = (reason) => {
      purgeOrg(db, c.key);
      done.run('rejected', reason, null, now, c.id);
      tally.rejected++;
      console.log(`  ${dim('out')}  ${c.name.padEnd(34)} ${dim(reason)}`);
    };
    // A CRASH MID-CANDIDATE MUST NOT LEAVE A HALF-VETTED FIRM IN THE BOOK. On
    // 2026-09-30 one did, and the next run would have read it as already there.
    try {
      await (async () => {
        lead(['add-org', '--name', c.name, '--id', c.key, ...(c.domain ? ['--domain', c.domain] : [])]);
        let domain = c.domain;
        if (!domain) {
          lead(['domains', '--org', c.key]);
          domain = db.prepare('SELECT domain FROM orgs WHERE id = ?').get(c.key)?.domain ?? null;
          if (!domain) { reject('no website found that names the firm'); return; }
        }
        lead(['vet', '--name', c.name, '--id', c.key, '--domain', domain]);

        const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(c.key);
        const kill = db.prepare(`SELECT gate_id, reason FROM gate_results WHERE org_id = ?
          AND outcome LIKE 'kill%' LIMIT 1`).get(c.key);
        const people = db.prepare('SELECT id, name, title FROM people WHERE org_id = ?').all(c.key);
        const seated = people.filter((p) => inSeat(target, p.title));
        if (!org?.kind) { reject('its own site did not settle what kind of firm it is'); return; }
        if (!target.where.kinds.includes(org.kind)) { reject(`its own site makes it ${org.kind}`); return; }
        const spec = await hasSpecialty(db, cfg, runId, target, c.key);
        if (spec && !spec.fits) { reject(`not the specialty: ${truncate(spec.why, 100)}`); return; }
        if (kill) { reject(`gate ${kill.gate_id}: ${truncate(kill.reason ?? '', 90)}`); return; }
        if (!seated.length) {
          reject(`its site names ${people.length ? `${people.length} people, none` : 'nobody'} in a seat worth writing to`);
          return;
        }
        const dropped = people.filter((p) => !seated.includes(p));
        purgePeople(db, dropped.map((p) => p.id));
        done.run('admitted', `${seated.length} in a seat` +
          (dropped.length ? `; ${dropped.length} others not kept` : ''), c.key, now, c.id);
        tally.admitted++;
        console.log(`  ${bold('in')}   ${c.name.padEnd(34)} ${seated.map((p) => `${p.name} (${p.title})`).slice(0, 3).join(', ')}`
          + (seated.length > 3 ? dim(` +${seated.length - 3}`) : ''));
      })();
    } catch (err) {
      // Taken back out but left pending: an error says nothing about the firm.
      purgeOrg(db, c.key);
      console.log(`  ${dim('err')}  ${c.name.padEnd(34)} ${dim(`nothing kept, still pending: ${truncate(err.message, 70)}`)}`);
    }
  }
  finishRun(db, runId);
  console.log(`\n${bold(String(tally.admitted))} admitted · ${tally.rejected} taken back out, reasons kept ` +
    '(npm run firms -- --show)');
  // The dashboard shows only scored people, so an admitted firm is invisible
  // until the formula has run. Both are code, no model calls.
  if (tally.admitted) {
    for (const stage of ['rank', 'dash']) {
      try {
        execFileSync('node', ['--env-file-if-exists=.env', `src/${stage}.mjs`],
          { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) { console.log(dim(`  ${stage} failed: ${truncate(String(err.stderr ?? err.message), 120)}`)); }
    }
    console.log(dim('  re-ranked and rebuilt the dashboard, so the admitted firms show there now'));
  }
}

/** The seat rule, applied to firms of the target's kinds already in the book. */
function prune(db, target) {
  const kinds = target.where.kinds;
  const orgs = db.prepare(`SELECT id, name FROM orgs WHERE kind IN (${kinds.map(() => '?').join(',')})`).all(...kinds);
  for (const o of orgs) {
    // Never someone the operator has written to, judged or pasted a profile for.
    const drop = db.prepare(`SELECT id, name, title FROM people p WHERE org_id = ?
      AND NOT EXISTS (SELECT 1 FROM outreach x WHERE x.person_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.person_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = p.id AND e.provenance = 'operator_supplied')`)
      .all(o.id).filter((p) => !inSeat(target, p.title));
    purgePeople(db, drop.map((p) => p.id));
    console.log(`${o.name}: ${drop.length} removed` +
      (drop.length ? dim(` (${drop.map((p) => p.title).join(', ')})`) : ''));
  }
}

/** The specialty check on firms of the target's kinds already in the book. */
async function recheck(db, cfg, target, { apply = false } = {}) {
  if (!target.specialty) throw new Error(`"${target.name}" names no specialty to check`);
  const runId = startRun(db, 'firms-recheck', { model: cfg.models?.cheap });
  const kinds = target.where.kinds;
  const orgs = db.prepare(`SELECT id, name FROM orgs WHERE kind IN (${kinds.map(() => '?').join(',')})`).all(...kinds);
  for (const o of orgs) {
    const spec = await hasSpecialty(db, cfg, runId, target, o.id);
    // Never a firm the operator is in touch with, or has made a call on.
    const touched = db.prepare(`SELECT 1 FROM people p WHERE p.org_id = ? AND (
      EXISTS (SELECT 1 FROM outreach x WHERE x.person_id = p.id)
      OR EXISTS (SELECT 1 FROM verdicts v WHERE v.person_id = p.id))`).get(o.id);
    const out = !spec.fits && !touched;
    if (out && apply) {
      purgeOrg(db, o.id);
      db.prepare(`UPDATE firm_candidates SET status = 'rejected', reason = ?, org_id = NULL,
        checked_at = ? WHERE key = ?`).run(`not the specialty: ${spec.why}`, new Date().toISOString(), o.id);
    }
    console.log(`  ${spec.fits ? bold('fits') : out ? (apply ? 'out ' : 'fail') : dim('kept')}  ` +
      `${o.name.padEnd(28)} ${dim(truncate(spec.why, 110))}` +
      (!spec.fits && touched ? dim(' (kept: you are in touch or made a call)') : ''));
  }
  finishRun(db, runId);
  if (!apply) console.log(dim('\n  nothing removed; --apply takes out the ones marked fail'));
}

function show(db) {
  const rows = db.prepare(`SELECT name, status, reason, source_url FROM firm_candidates
    ORDER BY status, name`).all();
  if (!rows.length) { console.log('no candidates yet.'); return; }
  for (const s of ['admitted', 'pending', 'rejected', 'in_book']) {
    const r = rows.filter((x) => x.status === s);
    if (!r.length) continue;
    console.log(heading(`${s} (${r.length})`));
    for (const x of r) console.log(`  ${x.name.padEnd(36)} ${dim(truncate(x.reason ?? x.source_url, 100))}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const b = loadBusiness(cfg);
  const db = openDb();
  ensureTable(db);
  if (args.show) return show(db);
  const target = pickTarget(b, args.target && args.target !== true ? args.target : null);
  if (args.prune) return prune(db, target);
  if (args.recheck) return recheck(db, cfg, target, { apply: Boolean(args.apply) });
  if (!args.vet) {
    const added = await find(db, cfg, b, target, args);
    if (args.dry || !added) return;
  }
  await vetCandidates(db, cfg, target, args);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
