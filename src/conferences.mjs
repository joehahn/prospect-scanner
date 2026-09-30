// Conferences nobody has configured: find them, then read their agendas.
//
// WHY THIS EXISTS. A conference agenda gives a person and a dated reason in one
// fetch, and it is the channel behind this book's strongest finds. But `events`
// reads only the organizers named in discovery.yml, each with CSS selectors
// written by hand for its markup, so the channel cannot grow faster than
// someone writes selectors. This finds new events and reads their pages with a
// general reader instead.
//
// TWO WAYS TO FIND ONE:
//   - Where the operator's examples speak. A target's `exemplars` are people he
//     wants more of; the circuits they appear on are where their look-alikes
//     appear too. Searched on the open web by name, never on LinkedIn.
//   - Searches a model writes from the targets and examples for current agendas
//     and speaker lists (prompts/find-conferences.md).
// Each result page is read once to decide whether it is a real conference with
// a speaker page (prompts/read-conference-page.md). Found events wait in
// `conferences`, outside the book.
//
// READING ONE. The agenda page is fetched under its robots.txt, a browser only
// where CLAUDE.md's three conditions allow it, and read by a cheap model
// (prompts/extract-agenda.md). Every speaker name it returns must appear in the
// page's own text or it is dropped: a reader that invents a speaker would put a
// person in the book who never spoke. What survives goes through the same path
// as configured organizers (events.mjs loadSpeakers): firms sized, vendors and
// out-of-band firms dropped, the session judged for a named difficulty.
//
// NEVER LINKEDIN, by any route: excluded from every search, and a result on a
// forbidden host is never fetched.
//
// Usage:
//   npm run conferences -- --find [--searches 6]    find events, write nothing to the book
//   npm run conferences -- --read [--limit 3]       read waiting agendas into the book
//   npm run conferences -- --read --dry             read and list speakers, write nothing
//   npm run conferences -- --read --ids 4,12        just those
//   npm run conferences -- --show                   what has been found and what each gave

import { openDb, startRun, finishRun, slugify } from './db.mjs';
import { loadConfig } from './config.mjs';
import { loadBusiness } from './business.mjs';
import { complete, promptBody } from './models.mjs';
import { searchNews, creditsUsed } from './sources/tavily.mjs';
import { fetchPage } from './sources/web.mjs';
import { exemplarText } from './exemplars.mjs';
import { loadSpeakers, eventDateFrom } from './events.mjs';
import { heading, bold, dim, truncate } from './report.mjs';

const FIND_FILE = 'prompts/find-conferences.md';
const PAGE_FILE = 'prompts/read-conference-page.md';
const AGENDA_FILE = 'prompts/extract-agenda.md';

const QUERIES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['queries'],
  properties: { queries: { type: 'array', items: { type: 'string' } } },
};
const PAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_conference', 'name', 'organizer', 'when', 'country', 'agenda_url', 'other_events'],
  properties: {
    is_conference: { type: 'boolean' },
    country: { type: 'string' },
    name: { type: 'string' }, organizer: { type: 'string' }, when: { type: 'string' },
    agenda_url: { type: 'string' },
    other_events: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['name', 'url'], properties: { name: { type: 'string' }, url: { type: 'string' } } } },
  },
};
const AGENDA_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['speakers', 'event_when', 'event_country'],
  properties: {
    event_when: { type: 'string' },
    event_country: { type: 'string' },
    speakers: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['name', 'title', 'firm', 'session'],
      properties: { name: { type: 'string' }, title: { type: 'string' }, firm: { type: 'string' },
        session: { type: 'string' } } } },
  },
};

// WHERE THE EVENT IS, against where the operator works: the business's own
// countries plus any a target adds. Added 2026-09-30 after the first find
// returned European summits whose speakers no target can use. A country the
// page does not state, or an online event, is let through: missing is not out.
const CODES = { US: 'united states', UK: 'united kingdom', GB: 'united kingdom', CA: 'canada',
  AE: 'united arab emirates', SA: 'saudi arabia' };
const ALIASES = { usa: 'united states', 'u s': 'united states', 'u s a': 'united states', us: 'united states',
  america: 'united states', uae: 'united arab emirates', ksa: 'saudi arabia', uk: 'united kingdom',
  england: 'united kingdom' };
const countryName = (c) => { const n = norm(c); return CODES[String(c).trim().toUpperCase()] ?? ALIASES[n] ?? n; };
export function allowedCountries(b) {
  const list = [...(b.where?.countries ?? []), ...(b.targets ?? []).flatMap((t) => t.where?.countries ?? [])];
  return new Set(list.map(countryName));
}
export function inOperatorCountries(country, allowed) {
  const n = countryName(country ?? '');
  if (!n || /online|virtual|global|worldwide/.test(n) || !allowed.size) return true;
  return allowed.has(n);
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
  const cols = () => db.prepare(`SELECT name FROM pragma_table_info('conferences')`).all().map((r) => r.name);
  db.exec(`CREATE TABLE IF NOT EXISTS conferences (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL UNIQUE,        -- slug of the event's name
    name        TEXT NOT NULL,
    organizer   TEXT,
    when_text   TEXT,                        -- the dates as the page stated them
    url         TEXT NOT NULL,               -- the agenda or speaker page, or the event page
    found_on    TEXT,                        -- the page it was found on
    found_via   TEXT,                        -- 'example' or 'search', and which
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | read | empty | refused
    reason      TEXT,
    speakers    INTEGER,                     -- speakers read off the page and verified
    country     TEXT,                        -- where the event is, as the page said
    found_at    TEXT NOT NULL,
    read_at     TEXT)`);
  if (!cols().includes('country')) db.exec('ALTER TABLE conferences ADD COLUMN country TEXT');
}

const hostsOf = (cfg) => (cfg.forbidden_hosts ?? []).map((h) => (typeof h === 'string' ? h : h.host)).filter(Boolean);
const forbidden = (url, hosts) => {
  try { const h = new URL(url).hostname; return hosts.some((x) => h === x || h.endsWith(`.${x}`)); }
  catch { return true; }
};
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** Same-page links that look like an agenda, program or speaker list. */
function agendaLinks(html, baseUrl) {
  const out = new Map();
  let base; try { base = new URL(baseUrl); } catch { return []; }
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi)) {
    let u; try { u = new URL(m[1], base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/agenda|speaker|program|session|schedule/i.test(u.pathname + ' ' + label)) out.set(u.href, label.slice(0, 60));
  }
  return [...out].map(([url, text]) => ({ url, text }));
}

// ---- find -----------------------------------------------------------------

async function find(db, cfg, b, args) {
  const hosts = hostsOf(cfg);
  const runId = startRun(db, 'conferences-find', { model: cfg.models?.cheap });
  const c0 = creditsUsed();
  const n = Number(args.searches ?? 6);
  const searches = [];

  // Where the examples speak: their name, their firm, and a speaking word.
  for (const t of b.targets ?? []) {
    for (const id of t.exemplars ?? []) {
      const p = db.prepare('SELECT p.name, o.name org FROM people p JOIN orgs o ON o.id = p.org_id WHERE p.id = ?').get(id);
      if (p) searches.push({ query: `"${p.name}" ${p.org} speaker OR panel OR keynote conference`, via: `example:${id}` });
    }
  }
  // Searches written from the targets and their examples.
  const examples = (b.targets ?? []).filter((t) => t.exemplars?.length)
    .map((t) => `\n## Examples for "${t.name}"\n${exemplarText(db, t, { full: false })}`).join('\n');
  const q = await complete(db, runId, { model: cfg.models?.default, system: promptBody(FIND_FILE),
    schema: QUERIES_SCHEMA, effort: 'low', thinking: false, maxTokens: 1500, messages: [{ role: 'user',
      content: `## The operator's targets\n${(b.targets ?? []).map((t) => `- ${t.name}: ${t.description}`).join('\n')}\n`
        + `${examples}\n\nToday is ${new Date().toISOString().slice(0, 10)}. Write ${n} searches.` }] });
  for (const query of (q.data?.queries ?? []).slice(0, n)) searches.push({ query, via: 'search' });

  const known = new Set(db.prepare('SELECT key FROM conferences').all().map((r) => r.key));
  const knownUrl = new Set(db.prepare('SELECT url FROM conferences').all().map((r) => r.url));
  const ins = db.prepare(`INSERT OR IGNORE INTO conferences (key, name, organizer, when_text, url, found_on,
    found_via, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (name, organizer, when, url, foundOn, via) => {
    const key = slugify(name);
    if (!name?.trim() || !url || forbidden(url, hosts) || known.has(key) || knownUrl.has(url)) return false;
    known.add(key); knownUrl.add(url);
    return ins.run(key, name.trim(), organizer || null, when || null, url, foundOn, via, new Date().toISOString()).changes > 0;
  };

  const seen = new Set();
  const allowed = allowedCountries(b);
  let added = 0; let abroad = 0;
  for (const s of searches) {
    const { results = [] } = await searchNews(s.query, { topic: 'general', requireDate: false,
      maxResults: 6, excludeDomains: hosts });
    let fromThis = 0;
    for (const r of results) {
      if (seen.has(r.url) || forbidden(r.url, hosts)) continue;
      seen.add(r.url);
      const page = await fetchPage(r.url, { allowBrowser: false });
      if (!page.ok || !page.text) continue;
      const links = agendaLinks(page.html, page.url).slice(0, 25);
      const res = await complete(db, runId, { model: cfg.models?.cheap, system: promptBody(PAGE_FILE),
        schema: PAGE_SCHEMA, effort: 'low', thinking: false, maxTokens: 2000, messages: [{ role: 'user',
          content: `## Page: ${page.url}\n${page.title ?? ''}\n\n${page.text.slice(0, 15000)}`
            + (links.length ? `\n\n## Links on the page that look like an agenda or speaker list\n`
              + links.map((l) => `- ${l.text}: ${l.url}`).join('\n') : '') }] });
      const d = res.data;
      if (!d) continue;
      // A URL the model gives must be this page or one it links to: never recalled.
      const onPage = (u) => u && (u === page.url || u === r.url || String(page.html).includes(u)
        || links.some((l) => l.url === u));
      if (d.is_conference && !inOperatorCountries(d.country, allowed)) {
        abroad++;
      } else if (d.is_conference) {
        const url = onPage(d.agenda_url) ? d.agenda_url : page.url;
        if (add(d.name, d.organizer, d.when, url, page.url, s.via)) { added++; fromThis++; }
      }
      for (const e of d.other_events ?? []) {
        if (onPage(e.url) && add(e.name, '', '', e.url, page.url, s.via)) { added++; fromThis++; }
      }
    }
    console.log(dim(`  ${String(fromThis).padStart(2)} new  ${truncate(s.query, 90)}`));
  }
  finishRun(db, runId, { tavily_credits: creditsUsed() - c0 });
  console.log(`\n${searches.length} searches · ${bold(String(added))} new conferences found, none read yet` +
    (abroad ? `; ${abroad} outside the operator's countries left out ` : ' ') +
    '(npm run conferences -- --read)');
}

// ---- read -----------------------------------------------------------------

/**
 * Only speakers the page itself names, with a title and a firm. A model reading
 * a page can return a plausible name that is not on it; that person never spoke
 * there, and one note naming a talk they did not give is worse than none.
 */
export function verifiedSpeakers(speakers, pageText) {
  // Whole words: padded, so "Jane Do" cannot pass on the strength of "Jane Doerr".
  const plain = ` ${norm(pageText)} `;
  return (speakers ?? []).filter((s) => s.name?.trim() && s.firm?.trim() && s.title?.trim()
    && plain.includes(` ${norm(s.name)} `));
}

/** Speakers off one page, each name checked against the page's own text. */
async function speakersOn(db, cfg, runId, page) {
  const res = await complete(db, runId, { model: cfg.models?.cheap, system: promptBody(AGENDA_FILE),
    schema: AGENDA_SCHEMA, effort: 'low', thinking: false, maxTokens: 16000, messages: [{ role: 'user',
      content: `## Page: ${page.url}\n${page.title ?? ''}\n\n${page.text.slice(0, 60000)}` }] });
  const all = res.data?.speakers ?? [];
  const kept = verifiedSpeakers(all, page.text);
  return { kept, dropped: all.length - kept.length, when: res.data?.event_when ?? '',
    country: res.data?.event_country ?? '' };
}

async function read(db, cfg, b, args) {
  const allowed = allowedCountries(b);
  const hosts = hostsOf(cfg);
  const limit = Number(args.limit ?? 3);
  const ids = args.ids && args.ids !== true ? String(args.ids).split(',').map(Number) : null;
  const rows = db.prepare(`SELECT * FROM conferences WHERE status = 'pending' ORDER BY id`).all()
    .filter((r) => !ids || ids.includes(r.id)).slice(0, ids ? undefined : limit);
  if (!rows.length) { console.log('no conferences waiting. Run with --find first.'); return; }
  const runId = startRun(db, 'conferences-read', { model: cfg.models?.cheap });
  const done = db.prepare(`UPDATE conferences SET status = ?, reason = ?, speakers = ?, read_at = ? WHERE id = ?`);
  const all = [];
  console.log(heading(`Reading ${rows.length} agenda(s)`));
  for (const c of rows) {
    const now = new Date().toISOString();
    if (forbidden(c.url, hosts)) { done.run('refused', 'forbidden host', 0, now, c.id); continue; }
    let page = await fetchPage(c.url);
    if (!page.ok) {
      done.run('refused', page.skipped ? 'robots.txt disallows it' : `fetch failed (${page.status ?? page.error ?? '?'})`, 0, now, c.id);
      console.log(`  ${dim('refused')} ${c.name}`);
      continue;
    }
    let got = await speakersOn(db, cfg, runId, page);
    // An event page that is not itself the agenda usually links to it.
    if (!got.kept.length) {
      for (const l of agendaLinks(page.html, page.url).slice(0, 2)) {
        if (forbidden(l.url, hosts)) continue;
        const p2 = await fetchPage(l.url);
        if (!p2.ok) continue;
        const g2 = await speakersOn(db, cfg, runId, p2);
        if (g2.kept.length) { page = p2; got = g2; break; }
      }
    }
    if (got.country && !inOperatorCountries(got.country, allowed)) {
      done.run('refused', `outside the operator's countries (${got.country})`, 0, now, c.id);
      console.log(`  ${dim('abroad')}  ${c.name} (${got.country})`);
      continue;
    }
    if (!got.kept.length) {
      done.run('empty', 'no speakers with a title and firm found on the page or its agenda link', 0, now, c.id);
      console.log(`  ${dim('empty')}   ${c.name}`);
      continue;
    }
    const when = eventDateFrom(got.when) ?? eventDateFrom(page.html);
    all.push(...got.kept.map((s) => ({ ...s, event: c.key, event_name: c.name, url: page.url, when })));
    done.run('read', got.dropped ? `${got.dropped} name(s) not found on the page, dropped` : null, got.kept.length, now, c.id);
    console.log(`  ${bold('read')}    ${c.name}: ${got.kept.length} speakers` +
      `${got.kept.filter((s) => s.session).length ? `, ${got.kept.filter((s) => s.session).length} with a session` : ''}` +
      `${got.dropped ? dim(` (${got.dropped} unverifiable, dropped)`) : ''}${when ? dim(` · ${when.text}`) : ''}`);
  }
  if (args.dry) {
    for (const s of all.slice(0, 40)) console.log(dim(`    ${s.name} · ${truncate(s.title, 40)} · ${s.firm} · ${truncate(s.session, 50)}`));
    // A dry read leaves the events waiting, so the real read can take them.
    db.prepare(`UPDATE conferences SET status = 'pending', read_at = NULL WHERE id IN (${rows.map((r) => r.id).join(',')})
      AND status = 'read'`).run();
    finishRun(db, runId, {});
    console.log(dim('\n  --dry: nothing written to the book'));
    return;
  }
  if (all.length) await loadSpeakers(db, runId, all, { model: cfg.models?.default, source: 'conference_discovery' });
  finishRun(db, runId, {});
  if (all.length) console.log(dim('  next: npm run gate && npm run rank'));
}

function show(db) {
  const rows = db.prepare('SELECT name, status, speakers, found_via, reason, url FROM conferences ORDER BY status, id').all();
  if (!rows.length) { console.log('nothing found yet.'); return; }
  for (const r of rows) {
    console.log(`  ${r.status.padEnd(8)} ${truncate(r.name, 50).padEnd(50)} ${String(r.speakers ?? '').padStart(3)} ` +
      dim(`${r.found_via} · ${truncate(r.reason ?? r.url, 60)}`));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const mech = (cfg.mechanisms ?? []).find((m) => m.id === 'conference_discovery');
  if (!mech) throw new Error('no `conference_discovery` mechanism in config/discovery.yml');
  if (mech.automation !== 'allowed') throw new Error(`conference_discovery automation is "${mech.automation}"`);
  const b = loadBusiness(cfg);
  const db = openDb();
  ensureTable(db);
  if (args.show) return show(db);
  if (args.find) return find(db, cfg, b, args);
  if (args.read) return read(db, cfg, b, args);
  console.log('Try: --find | --read [--limit N] [--dry] | --show');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
