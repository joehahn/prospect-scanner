// Appointments columns: the people who were just handed an AI seat, by name.
//
// WHY THIS EXISTS. The two strongest prospects in the book on 2026-09-25 -- a
// bank's first Chief AI Officer and a venture firm's -- were both named in a
// dated appointment notice, and `news --discover` found them by luck: it
// searches the whole press for an event of the right shape and hopes. Trade
// columns that do nothing BUT report appointments already exist, and they
// publish sitemaps. Reading those directly swaps a search for a list.
//
// Two passes, the same shape as every other source. Retrieval is free and
// deterministic: walk each feed's sitemap, keep article URLs whose slug names a
// data or AI seat, drop anything already in the book. Then one cheap extraction
// per article decides what actually happened -- who, which seat, which firm,
// hired from outside or promoted -- because a headline slug cannot tell an
// external hire from a promotion, and the trigger's own `not:` list says a
// promotion is not a fresh mandate.
//
// THE SEAT THEY LEFT IS THE NEXT LEAD. An external hire vacates a seat, and the
// firm that lost them will announce a successor. Every extraction records the
// prior seat, and the report lists them, so the chain can be followed.
//
// robots.txt: both configured feeds allow `*` on every path read here (checked
// 2026-09-25). Enforced per request by sources/http.mjs regardless.
//
// Usage:
//   npm run moves                     every configured feed, last `lookback_days`
//   npm run moves -- --dry            list the matching articles; no model, no writes
//   npm run moves -- --feed <id>      one feed only
//   npm run moves -- --max <n>        cap articles read this run (default from config)
//   npm run moves -- --since YYYY-MM-DD

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, slugify } from './db.mjs';
import { loadConfig, triggerWeight } from './config.mjs';
import { complete } from './models.mjs';
import { getJson } from './sources/http.mjs';
import { fetchPage } from './sources/web.mjs';
import { table, heading, bold, dim, truncate } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT = 'prompts/extract-move.md';
const TRIGGER = 'capability_leader_recently_named';
const DAY_MS = 86_400_000;

// Defaults, overridable under sources.moves in runtime.yml. The feeds are
// public trade columns, not operator data, so they may live in source.
const DEFAULTS = {
  enabled: true,
  lookback_days: 180,          // the trigger's own decay: older is not a fresh mandate
  max_articles: 40,
  // Matched against the URL slug. A slug is the headline with the punctuation
  // taken out, so "Chief Data & AI Officer" arrives as chief-data-ai-officer.
  slug_pattern: 'chief-(?:[a-z]+-){0,4}(?:ai|artificial-intelligence)-|ai-officer|head-of-(?:data-(?:and-)?)?ai|(?:data|vp)-(?:and-)?ai(?:-|$)|director-of-ai',
  // Not appointments: the column also reports people joining its own board.
  slug_exclude: 'joins-cdo-magazine|editorial-board|global-board|advisory-board',
  feeds: [
    { id: 'cdo_magazine', index: 'https://www.cdomagazine.tech/sitemap.xml',
      child: 'text-sitemap', path: '/leadership-moves/' },
    { id: 'executive_moves', index: 'https://executive-moves.com/sitemap_index.xml',
      child: 'post-sitemap', path: '/appointments/' },
  ],
};

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_appointment', 'move_type', 'first_in_seat', 'event_date', 'person_name',
    'person_title', 'firm_name', 'firm_domain', 'country', 'prior_firm', 'prior_title',
    'quote', 'note'],
  properties: {
    is_appointment: { type: 'boolean' },
    move_type: { type: 'string',
      enum: ['external_hire', 'promotion', 'expanded_role', 'board_or_advisory', 'other'] },
    first_in_seat: { type: 'boolean' },
    event_date: { type: ['string', 'null'] },
    person_name: { type: ['string', 'null'] },
    person_title: { type: ['string', 'null'] },
    firm_name: { type: ['string', 'null'] },
    firm_domain: { type: ['string', 'null'] },
    country: { type: ['string', 'null'] },
    prior_firm: { type: ['string', 'null'] },
    prior_title: { type: ['string', 'null'] },
    quote: { type: 'string' },
    note: { type: 'string' },
  },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument "${argv[i]}"`);
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { a[k] = next; i++; } else a[k] = true;
  }
  return a;
}

/** <loc> and <lastmod> for every <url> or <sitemap> entry. A regex, not a parser:
 * these files are machine-written and flat, and a dependency buys nothing here. */
function sitemapEntries(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<(url|sitemap)>([\s\S]*?)<\/\1>/g)) {
    const loc = m[2].match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1];
    const mod = m[2].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] ?? null;
    if (loc) out.push({ loc: loc.replace(/&amp;/g, '&'), lastmod: mod });
  }
  return out;
}

async function getText(url) {
  const r = await getJson(url, { expect: 'text', retries: 1 });
  if (!r.ok) throw new Error(`${url}: ${r.skipped ?? r.error ?? `HTTP ${r.status}`}`);
  return r.text;
}

/** Article URLs on one feed, modified since `since`, whose slug names an AI seat. */
async function candidates(feed, since, match, exclude) {
  const children = sitemapEntries(await getText(feed.index))
    .filter((c) => c.loc.includes(feed.child))
    // A child sitemap last touched before the window cannot hold an article in it.
    .filter((c) => !c.lastmod || c.lastmod.slice(0, 10) >= since);
  const seen = new Set();
  const out = [];
  for (const c of children) {
    for (const u of sitemapEntries(await getText(c.loc))) {
      if (!u.loc.includes(feed.path) || seen.has(u.loc)) continue;
      seen.add(u.loc);
      if (u.lastmod && u.lastmod.slice(0, 10) < since) continue;
      const slug = u.loc.replace(/\/+$/, '').split('/').pop();
      if (!match.test(slug) || exclude.test(slug)) continue;
      out.push({ feed: feed.id, url: u.loc, lastmod: u.lastmod?.slice(0, 10) ?? null, slug });
    }
  }
  return out;
}

const bareDomain = (d) => String(d ?? '').toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const conf = { ...DEFAULTS, ...(cfg.sources?.moves ?? {}) };
  if (conf.enabled === false) throw new Error('sources.moves.enabled is false in runtime.yml');

  const since = typeof args.since === 'string' ? args.since
    : new Date(Date.now() - conf.lookback_days * DAY_MS).toISOString().slice(0, 10);
  const max = Number(args.max ?? conf.max_articles);
  const feeds = conf.feeds.filter((f) => !args.feed || f.id === args.feed);
  if (!feeds.length) throw new Error(`no feed "${args.feed}"; have: ${conf.feeds.map((f) => f.id).join(', ')}`);
  const match = new RegExp(conf.slug_pattern);
  const exclude = new RegExp(conf.slug_exclude);

  const db = openDb();
  console.log(heading(`moves · ${feeds.map((f) => f.id).join(', ')} · since ${since}`));

  // ---- retrieve ------------------------------------------------------------
  const already = new Set(db.prepare(
    "SELECT source_url FROM evidence WHERE kind = 'news_event'").all().map((r) => r.source_url));
  let found = [];
  for (const f of feeds) {
    try {
      const c = await candidates(f, since, match, exclude);
      const fresh = c.filter((x) => !already.has(x.url));
      console.log(`  ${f.id}: ${c.length} AI-seat article(s) in window, ${fresh.length} not yet read`);
      found.push(...fresh);
    } catch (err) {
      console.log(`  ${f.id}: ${bold('FAILED')} ${err.message}`);
    }
  }
  // Newest first, so a cap spends itself on the freshest mandates.
  found.sort((a, b) => String(b.lastmod).localeCompare(String(a.lastmod)));
  if (found.length > max) {
    console.log(dim(`  reading the newest ${max} of ${found.length}; --max to widen`));
    found = found.slice(0, max);
  }

  if (args.dry) {
    for (const x of found) console.log(`  ${x.lastmod ?? '          '}  ${x.feed.padEnd(16)} ${x.slug}`);
    db.close();
    return;
  }
  if (!found.length) { console.log(dim('\nNothing new to read.')); db.close(); return; }

  // ---- extract -------------------------------------------------------------
  const runId = startRun(db, 'moves', { model: cfg.models.cheap });
  const system = readFileSync(resolve(ROOT, PROMPT), 'utf8');
  const moves = [];
  let cost = 0;
  for (const x of found) {
    const page = await fetchPage(x.url, { allowBrowser: false });
    if (!page.ok) { console.log(dim(`  unreadable: ${x.slug} (${page.skipped ?? page.error ?? page.status})`)); continue; }
    const res = await complete(db, runId, {
      model: cfg.models.cheap, effort: 'low', thinking: false, maxTokens: 1500, schema: SCHEMA,
      system, messages: [{ role: 'user', content:
        `URL: ${x.url}\nSITEMAP LASTMOD: ${x.lastmod ?? 'unknown'}\n\n${truncate(page.text, 12000)}` }],
    });
    cost += res.cost_usd ?? 0;
    if (res.data) moves.push({ ...res.data, url: x.url, feed: x.feed });
  }

  // ---- persist -------------------------------------------------------------
  const orgs = db.prepare('SELECT id, name, domain FROM orgs').all();
  const byName = new Map(orgs.map((o) => [nameKey(o.name), o]));
  const byDomain = new Map();
  for (const o of orgs) { const d = bareDomain(o.domain); if (d && !byDomain.has(d)) byDomain.set(d, o); }

  const insOrg = db.prepare(`INSERT INTO orgs (id, name, domain, first_seen, source, seeded)
    VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET domain = COALESCE(orgs.domain, excluded.domain)`);
  const insEv = db.prepare(`INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance)
    VALUES (?, ?, 'news_event', ?, ?, ?, 'retrieved')
    ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET retrieved_at = excluded.retrieved_at
    RETURNING id`);
  const insSig = db.prepare(`INSERT INTO signals (org_id, trigger_id, detected_at, decays_at, weight, evidence_id)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, trigger_id, evidence_id) DO NOTHING`);
  const getPerson = db.prepare('SELECT id, org_id FROM people WHERE id = ?');
  const insPerson = db.prepare(`INSERT INTO people (id, org_id, name, title, notes) VALUES (?, ?, ?, ?, ?)`);
  const decayDays = cfg.triggers.find((t) => t.id === TRIGGER)?.decay_days ?? 180;
  const today = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString();

  const rows = [];
  for (const m of moves) {
    if (!m.is_appointment || !m.firm_name || !m.person_name) {
      rows.push({ m, state: 'skip', why: m.note || 'not an appointment' });
      continue;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(m.event_date ?? '') ? m.event_date : null;
    const known = byDomain.get(bareDomain(m.firm_domain)) ?? byName.get(nameKey(m.firm_name));
    const orgId = known?.id ?? slugify(m.firm_name);
    // THE ONE EVENT THIS TRIGGER MEANS. Its `not:` list rules out promotions,
    // reorganisations and board seats: none of them is an unspent mandate. They
    // are still stored, as evidence, because the person may matter anyway.
    const fires = m.move_type === 'external_hire' && date && date >= since && date <= today;

    db.transaction(() => {
      insOrg.run(orgId, known?.name ?? m.firm_name, bareDomain(m.firm_domain) || null, today,
        `appointments column (${m.feed})`);
      if (!known) { const o = { id: orgId, name: m.firm_name, domain: m.firm_domain }; byName.set(nameKey(m.firm_name), o); }

      // SAME SLUG, DIFFERENT PERSON is possible -- people.id is a name slug and
      // global. Never re-file an existing person onto another firm from an
      // article; `lead move` is how a person changes employer, with a source.
      const pid = slugify(m.person_name);
      const existing = getPerson.get(pid);
      let personState = 'new';
      if (!existing) {
        insPerson.run(pid, orgId, m.person_name, m.person_title,
          `Named in an appointments column, ${date ?? 'undated'}: ${m.url}`);
      } else personState = existing.org_id === orgId ? 'known' : `CLASH:${existing.org_id}`;

      const left = m.prior_firm ? ` Previously ${m.prior_title ?? 'at'} ${m.prior_firm}.` : '';
      const claim = `${m.firm_name} ${m.move_type === 'external_hire' ? 'hired' : 'named'} ` +
        `${m.person_name} as ${m.person_title}${m.first_in_seat ? ' (a newly created seat)' : ''}` +
        `${date ? ` (${date})` : ''}.${left} — "${truncate(m.quote, 240)}"`;
      const ev = insEv.get(orgId, personState.startsWith('CLASH') ? null : pid, claim, m.url, stamp);
      if (fires) {
        insSig.run(orgId, TRIGGER, date,
          new Date(Date.parse(date) + decayDays * DAY_MS).toISOString().slice(0, 10),
          triggerWeight(cfg, TRIGGER), ev.id);
      }
      rows.push({ m, state: known ? 'known' : 'NEW', orgId, date, fires, personState });
    })();
  }
  finishRun(db, runId, {});

  // ---- report --------------------------------------------------------------
  const kept = rows.filter((r) => r.state !== 'skip');
  console.log(heading(`APPOINTMENTS (${kept.length}) — ${kept.filter((r) => r.fires).length} fire the trigger`));
  if (kept.length) {
    console.log(table(kept.map((r) => ({
      state: r.state, date: r.date ?? '—', type: r.fires ? 'HIRE' : r.m.move_type.replace('_', ' '),
      person: r.m.person_name, title: truncate(r.m.person_title, 34), firm: truncate(r.m.firm_name, 26),
      where: r.m.country ?? '—',
    })), [
      { key: 'state', label: '', width: 5 }, { key: 'date', label: 'DATED', width: 10 },
      { key: 'type', label: 'MOVE', width: 13 }, { key: 'person', label: 'PERSON', width: 22 },
      { key: 'title', label: 'SEAT', width: 34 }, { key: 'firm', label: 'FIRM', width: 26 },
      { key: 'where', label: 'WHERE', width: 14 },
    ]));
  }
  const vacated = kept.filter((r) => r.fires && r.m.prior_firm);
  if (vacated.length) {
    console.log(`\n${bold('Seats just vacated')} ${dim('— each will announce a successor; search it in a month')}`);
    for (const r of vacated) console.log(dim(`  ${r.m.prior_firm}: ${r.m.prior_title ?? '?'} (left for ${r.m.firm_name})`));
  }
  const clashes = kept.filter((r) => r.personState?.startsWith('CLASH'));
  for (const r of clashes) {
    console.log(bold(`\n  ${r.m.person_name} is already in the book at ${r.personState.slice(6)}`) +
      dim(` — not re-filed. If it is the same person: npm run lead -- move --person ${slugify(r.m.person_name)} --to ${r.orgId} --url ${r.m.url}`));
  }
  const fresh = kept.filter((r) => r.state === 'NEW' && r.fires);
  if (fresh.length) {
    console.log(`\n${bold('Vet the new firms before anything else')}:`);
    for (const r of fresh) {
      console.log(dim(`  npm run lead -- vet --name "${r.m.firm_name}"` +
        `${r.m.firm_domain ? ` --domain ${bareDomain(r.m.firm_domain)}` : ''} --id ${r.orgId}`));
    }
  }
  const skipped = rows.filter((r) => r.state === 'skip');
  if (skipped.length) console.log(dim(`\n${skipped.length} article(s) were not appointments and were not filed.`));
  console.log(dim(`\n${moves.length} article(s) read · $${cost.toFixed(4)}`));
  db.close();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
