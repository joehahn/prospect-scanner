// Dated-event detection: the stage that answers "why now".
//
// Every other source in this system describes a firm's steady state. A job board
// shows an empty seat; a website shows what a firm sells. Neither can see the
// announcement that makes a firm live THIS quarter, which is why `urgency` sat
// at zero for every firm in the book and `draft` correctly refused to write.
//
// Two passes, the same shape as `enrich`. Retrieval is deterministic and drops
// anything undateable (sources/tavily.mjs). Then one cheap classification pass
// decides which results actually report the trigger at this firm — necessary
// because retrieval alone returns awards listicles and wire noise, as the first
// live query demonstrated.
//
// A firm with no trigger is a true finding, not a failure. Nothing is invented
// to fill the gap.
//
// Usage:
//   npm run news                      every firm that survives its gates
//   npm run news -- --org <id>        just one
//   npm run news -- --all             include firms already killed
//   npm run news -- --dry             retrieve and print, write nothing, no LLM
//   npm run news -- --promote         [--org <id>] [--recheck] [--dry]
//                                     for every event cited to a third party, ask whether
//                                     the FIRM ITSELF announced it, searching only that
//                                     firm's own domain. Promotes the citation to the
//                                     primary source. ~2c per event.
//   npm run news -- --rejudge         re-run the judge over events ALREADY STORED and
//                                     retract the ones that do not hold up. No retrieval,
//                                     no credits. Run it after changing a trigger's `not:`
//                                     list or the discover prompt — it says what the
//                                     change bought, and cleans up what the old one let in.
//   npm run news -- --sectors        what kinds of organisation are out there at all,
//                                     with no firm shape assumed. Proposes nothing to the
//                                     board; produces an argument for the operator.
//   npm run news -- --discover        THE OTHER DIRECTION: search by the SHAPE of a
//                                     firm rather than its name, and surface companies
//                                     the operator has never heard of. Every firm in
//                                     the book today came from him; this is the only
//                                     mode that can change that.
//   npm run news -- --discover --local
//                                     ...and near enough to drive to. Adds icp.discovery_region
//                                     to every query and holds candidates to it. Discovery has
//                                     no geography otherwise: of 61 firms it has found, none
//                                     are in Texas, because it was never asked.
//                                     --region "Denver, Colorado" overrides the config.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, slugify } from './db.mjs';
import { loadConfig, triggerWeight } from './config.mjs';
import { loadTargeting } from './targeting.mjs';
import { complete } from './models.mjs';
import { searchNews, creditsUsed } from './sources/tavily.mjs';
import { fetchPage, discoverNewsLinks, NEWS_PATHS } from './sources/web.mjs';
import { table, heading, bold, dim, truncate } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/judge-news.md';
const PROMPT_DISCOVER = 'prompts/discover-firms.md v3';
const PROMPT_PROMOTE = 'prompts/promote-primary.md';
const DAY_MS = 86_400_000;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      description: 'Only results that genuinely report the trigger at this firm. Usually empty.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['trigger_id', 'event_date', 'what_happened', 'source_url'],
        properties: {
          trigger_id: { type: 'string' },
          event_date: { type: 'string', description: 'YYYY-MM-DD, the EVENT date not the article date.' },
          what_happened: { type: 'string', description: 'One factual sentence.' },
          source_url: { type: 'string' },
        },
      },
    },
    rejected_note: { type: ['string', 'null'],
      description: 'One line on what was rejected and why, for the operator.' },
  },
};

function parseArgs(argv) {
  const a = {};
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
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
}

/**
 * Which triggers to hunt for a firm, and the query for each.
 *
 * A trigger is worth searching only if some sector declares a news-shaped
 * evidence source for it — that declaration is the operator saying "this is
 * findable in the press". Anything else would burn credits on a question the
 * press cannot answer.
 */
function triggersFor(cfg, targeting, org) {
  const NEWSY = /press release|trade press|news|filing|8-k|earnings|conference|interview|letter/i;
  const wanted = new Map();
  for (const v of targeting.verticals ?? []) {
    for (const t of v.triggers ?? []) {
      if (!(t.evidence_sources ?? []).some((s) => NEWSY.test(s))) continue;
      if (!wanted.has(t.id)) wanted.set(t.id, cfg.triggers.find((x) => x.id === t.id));
    }
  }
  return [...wanted.values()].filter(Boolean).map((t) => ({
    ...t,
    // Quoted firm name FIRST, then a short verb list from signals.yml. Using the
    // full description swamped the name: a search for an 18-person PE firm
    // returned a college course catalog and another company's earnings, because
    // the description's words outweighed the name's. Short and name-anchored.
    query: `"${org.name}" ${t.news_terms ?? String(t.id).replace(/_/g, ' ')}`.slice(0, 380),
  }));
}

/**
 * A firm's own newsroom, press page or portfolio index.
 *
 * The authoritative source for the events this stage hunts, and the ONLY one
 * that works for firms too small for the press to cover: an 18-person PE shop
 * generates no news but does publish "we invested in X" on its own site. Free —
 * no API, just the same robots-respecting fetcher `enrich` uses.
 */
/**
 * WHEN A SIGNAL STOPS COUNTING, per trigger rather than once for everything.
 *
 * Every signal used to decay at `sources.news.lookback_days` — one number for
 * all fifteen triggers — while four of them state a different bound in their own
 * description. The flagship was the worst of them:
 * `capability_leader_recently_named` says "within the last 6 months and has not
 * yet built a team", and decayed at 365 days, so a year-old appointment still
 * scored as a fresh mandate. That is the exact tenure dimension the
 * capability_already_staffed gate was already known to be missing, and it fed
 * the two sectors just opened to discovery.
 *
 * `decay_days` on the trigger now wins; the global stays as the default for the
 * triggers that state no bound.
 */
function decaysOn(cfg, triggerId, eventDate, fallbackDays) {
  const d = (cfg.triggers ?? []).find((t) => t.id === triggerId)?.decay_days;
  const days = Number.isFinite(d) ? d : fallbackDays;
  // A JOB POSTING HAS NO EVENT DATE, so it decays from the day it was found.
  // Every other trigger is an event that happened on a day the article states;
  // this class is a page that is up now, and the honest reading of "how long
  // does this stay true" is measured from when we looked. Without this the
  // whole run died on `Invalid time value` at the moment the first hiring req
  // finally qualified.
  const from = Date.parse(eventDate);
  return new Date((Number.isFinite(from) ? from : Date.now()) + days * DAY_MS)
    .toISOString().slice(0, 10);
}

async function newsroomPages(org, maxPages, log) {
  if (!org.domain) return [];
  const base = `https://${String(org.domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const pages = [];
  const seen = new Set();

  const home = await fetchPage(base);
  const linked = home.ok ? discoverNewsLinks(home.html, home.url).map((l) => l.url) : [];
  // Link discovery first, guessed paths as the fallback — one PE firm's homepage
  // links no newsroom at all, so guessing is the only way in there.
  for (const url of [...linked, ...NEWS_PATHS.map((p) => `${base}${p}`)]) {
    if (pages.length >= maxPages) break;
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await fetchPage(url);
    if (!r.ok || !r.text || r.text.length < 300) continue;
    pages.push(r);
    log(`      ${url}`);
  }
  return pages;
}

const DISCOVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['firms'],
  properties: {
    firms: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'trigger_id', 'event_date', 'what_happened', 'source_url',
                   'people'],
        properties: {
          name: { type: 'string', description: "The firm's name as written." },
          domain: { type: ['string', 'null'],
            description: 'Only if confident. A wrong domain sends enrichment to another company.' },
          trigger_id: { type: 'string' },
          event_date: { type: 'string' },
          what_happened: { type: 'string' },
          source_url: { type: 'string' },
          // RECALLED, NOT RETRIEVED, and stored as such. The judge already
          // reasons about firm size — it rejects firms for being above a
          // sector's band and names the number when it does — and that
          // judgment was being discarded. It is good enough to GATE on and not
          // good enough to print as a fact, which is what headcount_source
          // exists to keep straight.
          headcount_est: { type: ['integer', 'null'],
            description: 'Approximate employees, from what you already know about the firm. '
              + 'Null if you have no idea. A guess dressed as a number is worse than null.' },
          // NAMES IN THE ARTICLE, which were being read and thrown away. A
          // sweep on 2026-09-22 returned "CIO <name> has successfully
          // implemented automated AI" at a Texas city, and the name reached
          // nothing: only `enrich` creates people, and it reads a firm's own
          // homepage. For a municipality that is fatal — a city site is built
          // for residents, so officials appear in agendas and press releases
          // and nowhere the crawler looks. Six bodies vetted, zero buying
          // seats, while the seats were sitting in the evidence already
          // fetched, already judged and already stored.
          //
          // Cheapest source of names in the system: the text is in hand and
          // the judge has read it. Only people the article places AT THIS FIRM
          // — an official quoted about their own body, an executive the piece
          // says was appointed. Never a vendor's spokesperson, never an
          // analyst, never a reporter, and never a name that merely appears
          // nearby.
          people: {
            type: 'array',
            description: 'People the article names as working AT THIS FIRM, with their title '
              + 'as the article gives it. Empty when it names none.',
            items: { type: 'object', additionalProperties: false,
              required: ['name', 'title'],
              properties: { name: { type: 'string' }, title: { type: 'string' } } },
          },
        },
      },
    },
    rejected_note: { type: ['string', 'null'] },
  },
};

/**
 * One trigger as the judge sees it: what it is, and what has been mistaken for it.
 *
 * The `not:` lines are the whole point. A one-line description is a target the
 * model hits approximately — "an executive was named to own AI" matched a board
 * director credited with AI experience, twice-removed from a budget. The
 * exclusions are specific wrong answers already produced, which is the only kind
 * of instruction that has reliably changed the outcome here.
 */
function triggerBrief(cfg, id) {
  const t = cfg.triggers.find((x) => x.id === id);
  if (!t) return `- ${id}`;
  const one = (s) => String(s).replace(/\s+/g, ' ').trim();
  const nots = (t.not ?? []).map((n) => `\n    NOT: ${one(n)}`).join('');
  return `- ${t.id}: ${one(t.description ?? '')}${nots}`;
}

/**
 * Search by the SHAPE of a firm rather than its name.
 *
 * Every one of the 31 firms in the book was supplied by the operator — 28 from
 * his own history, 3 typed in. The system has been good at disqualifying and has
 * never once contributed a candidate. This is the mode that can, and it is the
 * reason not to build an events table: the gap was never organising what he had,
 * it was supply.
 */
const SECTOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['segments', 'notable_absence'],
  properties: {
    segments: {
      type: 'array',
      items: { type: 'object', additionalProperties: false,
        required: ['label', 'firms', 'why_they_appear', 'size_signal', 'procurement_shape'],
        properties: {
          label: { type: 'string' },
          firms: { type: 'array', items: { type: 'string' } },
          why_they_appear: { type: 'string' },
          size_signal: { type: 'string' },
          procurement_shape: { type: 'string',
            description: 'owner_decides | department_budget | committee | '
              + 'formal_procurement | unclear' },
        } },
    },
    notable_absence: { type: 'string' },
  },
};

/**
 * WHAT IS OUT THERE, rather than whether a guess was any good.
 *
 * `discover` composes firm_shapes x trigger terms, so it can only find firms in
 * shapes the operator already named: every sweep confirms his priors by
 * construction, and the thesis table then scores what he wrote down and calls
 * that an evaluation. Nothing in this project could propose a sector.
 *
 * Same machinery with one field removed. The trigger terms go out unshaped, and
 * the results are read for WHAT KINDS OF ORGANISATION keep appearing rather than
 * for individual firms. Nothing is written to the database: this pass produces
 * an argument for the operator, not candidates for the board, and a segment that
 * survives his judgement becomes a thesis in sectors.yml by hand.
 */
async function sectors(db, cfg, targeting, news, runId, args) {
  // Every trigger with terms, deduped, minus the ones whose whole meaning is a
  // firm shape the sweep is trying not to assume.
  const trigs = (cfg.triggers ?? []).filter((t) => t.discovery_terms);
  if (!trigs.length) throw new Error('no trigger carries discovery_terms');
  const region = typeof args.region === 'string' ? args.region
    : (args.local || args.region === true) ? (cfg.icp?.discovery_region ?? null) : null;

  console.log(heading(`news --sectors · ${trigs.length} trigger(s), no firm shape`
    + (region ? ` · ${region}` : '')));
  console.log(dim('Unshaped: the terms go out without an industry in front of them, and the '
    + 'results are read for what kinds of organisation keep appearing. Nothing is written '
    + 'to the database.\n'));

  const hits = [];
  let cost = 0;
  for (const t of trigs) {
    const q = `${t.discovery_terms}${region ? ` ${region}` : ''}`.slice(0, 380);
    const { results, error } = await searchNews(q, {
      sinceDate: null, maxResults: news.max_results ?? 6,
      topic: t.evidence_class === 'hiring_req' ? 'general' : 'news',
      requireDate: false,
      excludeDomains: news.exclude_domains ?? [],
      includeDomains: t.evidence_class === 'hiring_req' ? (news.hiring_domains ?? []) : [],
    });
    if (error) { console.log(dim(`    ${truncate(t.id, 34)}: ${error}`)); continue; }
    console.log(dim(`    ${truncate(t.id, 34).padEnd(36)} -> ${results.length}`));
    for (const r of results) hits.push({ ...r, trigger: t.id });
  }
  if (!hits.length) { console.log(dim('\nNothing came back.')); return; }

  const res = await complete(db, runId, {
    model: cfg.models.cheap, effort: 'medium', maxTokens: 8000, schema: SECTOR_SCHEMA,
    system: readFileSync(resolve(ROOT, 'prompts/discover-sectors.md'), 'utf8'),
    messages: [{ role: 'user', content:
      `The operator sells senior AI capacity by the hour and fixed-price builds, out of a\n`
      + `services budget, to organisations of roughly 100 to 5,000 people.\n\n`
      + `RESULTS:\n${hits.map((h, i) =>
        `[${i + 1}] (${h.trigger}) ${h.title}\n  ${h.url}\n  ${h.snippet}`).join('\n\n')}` }],
  });
  cost += res.cost_usd ?? 0;

  const known = new Set((targeting.live ?? []).map((v) => String(v.name ?? v.id).toLowerCase()));
  const segs = res.data?.segments ?? [];
  console.log(heading(`\nSEGMENTS SEEN (${segs.length})`));
  for (const g of segs) {
    const covered = [...known].some((k) => k.includes(String(g.label).toLowerCase().split(' ')[0]));
    console.log(`\n${bold(g.label)}${covered ? dim('  — a thesis already covers this') : ''}`);
    console.log(dim(`  buys: ${g.procurement_shape}`
      + (g.size_signal ? ` · size: ${g.size_signal}` : '')));
    console.log(dim(`  why:  ${truncate(g.why_they_appear, 150)}`));
    console.log(dim(`  saw:  ${(g.firms ?? []).slice(0, 6).join(', ')}`));
  }
  if (res.data?.notable_absence) {
    console.log(dim(`\nExpected and not seen: ${res.data.notable_absence}`));
  }
  console.log(dim(`\nNothing written. A segment that survives your judgement becomes a `
    + `thesis in sectors.yml by hand.\n${hits.length} results · $${cost.toFixed(4)} judging`));
}

async function discover(db, cfg, targeting, news, since, runId, args) {
  // `discovery: paused` retires a vertical FROM DISCOVERY ONLY. It is checked
  // here and nowhere else on purpose: `targeting.live` gates ranking as well, so
  // marking these `status: retired` would have hidden the 866 people already in
  // them — and those people are the reason to keep the verticals. A firm found
  // under a thesis the operator has moved on from can still qualify under a live
  // one, and one insurer already has.
  //
  // Naming a vertical explicitly with --vertical overrides the pause, so a
  // paused thesis can still be re-tested deliberately without editing config.
  const named = args.vertical && args.vertical !== true;
  const sectors = targeting.live.filter((v) =>
    (v.firm_shapes ?? []).length &&
    (named ? v.id === args.vertical : (v.discovery ?? 'active') !== 'paused'));
  if (!sectors.length) {
    const paused = targeting.live.filter((v) => (v.discovery ?? 'active') === 'paused').length;
    throw new Error('no sector is open to discovery' +
      (paused ? `: ${paused} are \`discovery: paused\` in sectors.yml. Name one with --vertical <id> to re-test it.` : ''));
  }

  const known = new Map(db.prepare('SELECT id, name, domain FROM orgs').all()
    .map((o) => [String(o.name).toLowerCase().replace(/[^a-z0-9]/g, ''), o]));
  // THE DOMAIN IS THE FIRM; THE NAME IS HOW ONE ARTICLE SPELT IT. Matching on
  // name alone filed one bank three times -- "Northwind Islamic Bank", the same
  // with "(NIB)" after it, and "NIB" -- all at one domain, with its signals on
  // one record and its Chief AI Officer on another.
  const bareDomain = (d) => String(d ?? '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const knownDomain = new Map();
  for (const o of known.values()) {
    const d = bareDomain(o.domain);
    if (d && !knownDomain.has(d)) knownDomain.set(d, o);
  }

  // --region "..." wins over --local, which falls back to config. A region that
  // resolves to nothing is an error rather than a silent national run: the whole
  // point of asking for --local is not getting a national one.
  const region = typeof args.region === 'string' ? args.region
    : (args.local || args.region === true) ? (cfg.icp?.discovery_region ?? null)
    : null;
  if ((args.local || args.region) && !region) {
    throw new Error('--local needs icp.discovery_region in runtime.yml, or --region "City, State"');
  }

  console.log(heading(`news --discover · ${sectors.length} sector(s) · events since ${since}` +
    (region ? ` · ${region} only` : '')));
  let cost = 0;
  const found = [];

  for (const v of sectors) {
    console.log(`\n${bold(v.name ?? v.id)}`);
    // ONE vocabulary, TWO renderings — the lesson from geo-herd-rider's
    // retrieval_config. The trigger owns the event words; the sector owns what a
    // firm in it is CALLED. Composing them replaced 16 hand-written queries that
    // retyped "appoints ... chief AI officer" into five different sectors, and
    // means a new sector needs a name, not a query-writing session.
    // TRIGGER-MAJOR, NOT SHAPE-MAJOR. This loop was nested shape-outer and the
    // cap below truncates a PREFIX, so a sector's later shapes were never
    // searched at all: with five triggers and a cap of twelve, shapes three
    // onward composed queries that were built, counted, reported — and thrown
    // away. The mid-market sector declared ten shapes and searched two of them,
    // which made "manufacturer", "logistics company" and five others decoration
    // in the one vertical the business had just prioritised.
    //
    // Ordering by trigger first makes the cap SAMPLE the space instead of
    // taking a prefix of it: every shape gets its first trigger before any
    // shape gets its second. A cap that cuts here costs breadth of EVENT, which
    // is recoverable on the next run; a cap that cut where it did cost whole
    // firm shapes, permanently and silently.
    //
    // A SECTOR MAY SAY THE SAME EVENT IN ITS OWN TITLES. capability_leader
    // _recently_named was rewritten for the mid-market ("first head of data"),
    // which was right there and silently stopped every enterprise sector from
    // searching for a Chief AI Officer at all -- the title that found both
    // Gulf appointees already in the book. The event, its id and everything
    // gate and rank key on it stay global; only the words searched can be
    // overridden, on the sector's reference to the trigger.
    const queries = [];
    const trigs = (v.triggers ?? [])
      .map((t) => {
        const g = cfg.triggers.find((x) => x.id === t.id);
        return g && t.discovery_terms ? { ...g, discovery_terms: t.discovery_terms } : g;
      })
      .filter((t) => t?.discovery_terms);
    for (const trig of trigs) {
      // A POSTING IS A ROLE, A COMPANY AND A PLACE. It is not an article about
      // the work, so it is not composed like one. Leading with the firm shape
      // searches for the shape -- Tavily weights early terms -- and the context
      // words that make a news query precise (`forecast Excel`, `"3-way
      // match"`) describe the PROBLEM, which is what an article would say and
      // what no posting says. Measured on 2026-09-21: shape-first returned four
      // aggregator pages, a YouTube video and a government page; role-first
      // returned five named employers.
      const hiring = trig.evidence_class === 'hiring_req' && trig.posting_terms;
      for (const shape of v.firm_shapes) {
        // Region goes on the END of the query. Tavily weights early terms more
        // heavily, and the firm's shape is what must match — a place name given
        // first returns the city's news rather than the sector's.
        queries.push({ q: (hiring
          ? `${trig.posting_terms} ${shape}${region ? ` ${region}` : ''}`
          : `${shape} ${trig.discovery_terms}${region ? ` ${region}` : ''}`)
          .slice(0, 380), trigger: trig.id });
      }
    }
    // A wide sector can compose more queries than a credit budget wants; cap and
    // say so rather than silently truncating.
    const CAP = Number(news.max_discovery_queries ?? 12);
    if (queries.length > CAP) {
      const shapesReached = new Set(queries.slice(0, CAP).map((x) => x.q.split(' ')[0])).size;
      console.log(dim(`    ${queries.length} composed, capping at ${CAP} ` +
        `(${Math.ceil(CAP / Math.max(v.firm_shapes.length, 1))} of ${trigs.length} triggers ` +
        `across all ${v.firm_shapes.length} shapes; raise sources.news.max_discovery_queries to widen)`));
      queries.length = CAP;
      void shapesReached;
    }

    // A HIRING REQ IS NOT AN EVENT IN THE PRESS, so it is not searched as one.
    // Added 2026-09-21. The five hiring triggers had produced zero signals in
    // the life of the project, and a sweep run to find out why returned 64
    // results and qualified none: market forecasts, listicles and directory
    // pages, because `topic: news` searches a news index and a news index holds
    // articles ABOUT demand planning rather than any firm's careers page.
    // Three things change for this evidence class and each has the same reason:
    // the index (general, not news), the date filter (a posting carries no
    // publication date and the client-side filter was dropping what survived)
    // and the trade-press restriction (a trade title reports on the sector; it
    // does not advertise the sector's vacancies).
    const classOf = new Map((cfg.triggers ?? []).map((t) => [t.id, t.evidence_class]));
    const hits = [];
    for (const { q, trigger } of queries) {
      const hiring = classOf.get(trigger) === 'hiring_req';
      const { results, undated, error } = await searchNews(q, {
        sinceDate: hiring ? null : since, maxResults: news.max_results ?? 6,
        topic: hiring ? 'general' : 'news', requireDate: !hiring,
        excludeDomains: news.exclude_domains ?? [],
        // A sector may name the press that covers it. Without this, "sportsbook
        // AI" retrieves betting-tipster SEO, white-label vendor pages and
        // literal match reports — 72 dated results, none of them an operator
        // doing anything. Restricted to the trade press, the same query returns
        // a fraud-prevention deal at a named operator on the first page.
        // A trade title reports on a sector; it does not advertise the
        // sector's vacancies. The hiring class gets the hosts postings live on
        // instead, which is what separates a named employer from a salary page.
        includeDomains: hiring ? (news.hiring_domains ?? []) : (v.trade_press ?? []),
      });
      if (error) { console.log(dim(`    "${truncate(q, 56)}": ${error}`)); continue; }
      console.log(dim(`    "${truncate(q, 56)}" -> ${results.length} dated` +
        (undated ? `, ${undated} undateable` : '')));
      for (const r of results) hits.push({ ...r, hiring });
    }
    if (!hits.length) continue;
    if (args.dry) { hits.forEach((h) => console.log(dim(`      ${h.published_on} ${truncate(h.title, 80)}`))); continue; }

    // JUDGED IN BATCHES, because at full sweep this is 231 results in one call
    // and the judgment visibly degrades. Its own rejection note on 2026-09-21
    // read "All 226 results are non-job-posting content: ... Myworkday and
    // recruiter pages that are FIRM JOB POSTINGS for demand planners at
    // [four named employers]" -- naming four real
    // employers inside the sentence that rejected them. Forty at a time is
    // small enough to attend to each result and still cheap: the cost is tokens
    // of prompt re-sent, not credits.
    const BATCH = 40;
    const batches = [];
    for (let b = 0; b < hits.length; b += BATCH) batches.push(hits.slice(b, b + BATCH));
    const firms = [];
    const notes = [];
    for (const batch of batches) {
    const res = await complete(db, runId, {
      model: cfg.models.cheap, effort: 'medium', maxTokens: 8000, schema: DISCOVER_SCHEMA,
      // ONE PROMPT PER EVIDENCE CLASS. discover-firms.md reads dated news and
      // every sentence in it assumes an article, a date and a reporter. Pointed
      // at job postings it rejected all 72 of them and said why in its own
      // note: "No news articles report any firm executing a hiring action."
      system: readFileSync(resolve(ROOT, hits.some((h) => h.hiring)
        ? 'prompts/discover-hiring.md' : 'prompts/discover-firms.md'), 'utf8'),
      messages: [{ role: 'user', content:
        `SECTOR: ${v.name ?? v.id}\n${(v.thesis ?? '').trim()}\n\n` +
        (region ? `REGION: ${region}\n\n` : '') +
        `TRIGGERS IN PLAY:\n${(v.triggers ?? []).map((t) =>
          triggerBrief(cfg, t.id)).join('\n')}\n\n` +
        `RESULTS:\n${batch.map((h, i) =>
          `[${i + 1}] ${h.published_on ?? 'undated'} — ${h.title}\n  ${h.url}\n  ${h.snippet}`)
          .join('\n\n')}` }],
    });
    cost += res.cost_usd ?? 0;
    firms.push(...(res.data?.firms ?? []));
    if (res.data?.rejected_note) notes.push(res.data.rejected_note);
    }
    const res = { data: { firms, rejected_note: notes.join(' ') } };

    // Say why nothing qualified. A sector that returns no firms is either quiet
    // or badly queried, and those need different responses — the judge knows
    // which and was being asked to write it down into a variable nobody read.
    const named = (res.data?.firms ?? []).length;
    if (!named) {
      console.log(dim(`    ${hits.length} results, none qualified.` +
        (res.data?.rejected_note ? ` ${truncate(res.data.rejected_note, 300)}` : '')));
    } else if (res.data?.rejected_note) {
      console.log(dim(`    also rejected: ${truncate(res.data.rejected_note, 220)}`));
    }

    for (const f of res.data?.firms ?? []) {
      const key = String(f.name).toLowerCase().replace(/[^a-z0-9]/g, '');
      const already = known.get(key) ?? knownDomain.get(bareDomain(f.domain)) ?? undefined;
      // The date check that the judge is not trusted to make, applied here --
      // and NOT applied to a hiring req, which has no event date to check. The
      // prompt for that class says in as many words to leave the date null, and
      // this line then dropped every firm it returned, silently, before any of
      // them reached the operator. A guaranteed zero that looked exactly like a
      // quiet market.
      const today = new Date().toISOString().slice(0, 10);
      const dateless = hits.some((h) => h.url === f.source_url && h.hiring);
      if (!dateless && (!/^\d{4}-\d{2}-\d{2}$/.test(f.event_date ?? '')
          || f.event_date < since || f.event_date > today)) continue;
      if (!hits.some((h) => h.url === f.source_url)) continue;
      found.push({ ...f, sector: v.id, already });
    }
  }

  // PERSIST. The first run named 41 firms and lost 40 of them: they were printed
  // and forgotten. An unvetted candidate is written as an org with kind NULL —
  // `gate` and `rank` both skip those, so nothing unvetted can reach the
  // shortlist, and `vet` fills the kind in. No new table: the same reasoning
  // that said no to an events table applies here.
  const insOrg = db.prepare(`
    INSERT INTO orgs (id, name, domain, headcount_est, headcount_source, first_seen, source, seeded)
    VALUES (@id, @name, @domain, @headcount, @hcsrc, @today, @source, 0)
    -- COALESCE both ways round on purpose. A recalled estimate must never
    -- overwrite a number read off a page, and the source travels with the
    -- number so a later reader can tell which one they have.
    ON CONFLICT(id) DO UPDATE SET
      domain           = COALESCE(orgs.domain, excluded.domain),
      headcount_est    = COALESCE(orgs.headcount_est, excluded.headcount_est),
      headcount_source = COALESCE(orgs.headcount_source, excluded.headcount_source)`);
  const insEv = db.prepare(`
    INSERT INTO evidence (org_id, kind, claim, source_url, retrieved_at, provenance)
    VALUES (@org, 'news_event', @claim, @url, @at, 'retrieved')
    ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET retrieved_at = excluded.retrieved_at
    RETURNING id`);
  const insSig = db.prepare(`
    INSERT INTO signals (org_id, trigger_id, detected_at, decays_at, weight, evidence_id)
    VALUES (@org, @trig, @on, @decays, @w, @ev)
    ON CONFLICT(org_id, trigger_id, evidence_id) DO NOTHING`);
  const insVert = db.prepare(
    'INSERT OR IGNORE INTO org_verticals (org_id, vertical_id, assigned_at) VALUES (?, ?, ?)');

  const stamp = new Date().toISOString();
  const day = stamp.slice(0, 10);
  const insPerson = db.prepare(`
    INSERT INTO people (id, org_id, name, title, notes)
    VALUES (@id, @org, @name, @title, @notes)
    ON CONFLICT(id) DO UPDATE SET title = COALESCE(people.title, excluded.title)`);
  let namedPeople = 0;
  for (const f of found) {
    const id = f.already?.id ?? slugify(f.name);
    insOrg.run({ id, name: f.name, domain: f.domain ?? null, today: day,
      // Only stored when the judge actually gave one; a null stays null rather
      // than becoming a zero that reads as a tiny firm.
      headcount: Number.isFinite(f.headcount_est) ? f.headcount_est : null,
      hcsrc: Number.isFinite(f.headcount_est) ? 'estimate' : null,
      // The region is part of how the firm was found, so it belongs in `source`
      // — otherwise a local sweep and a national one are indistinguishable six
      // weeks later, and there is no way to ask whether the local one paid.
      source: `discovered by news --discover (${f.sector}${region ? `, ${region}` : ''})` });
    insVert.run(id, f.sector, day);
    // A NAME FROM AN ARTICLE IS NOT A NAME FROM THE FIRM'S OWN SITE, and the
    // note says which so the two are never confused downstream. Titles are not
    // overwritten: a staff listing read off the firm's own leadership page is
    // better evidence than a reporter's paraphrase, so an existing one wins.
    for (const q of f.people ?? []) {
      if (!q?.name || !q?.title) continue;
      insPerson.run({ id: slugify(q.name), org: id, name: q.name, title: q.title,
        notes: `Named in the article that triggered this firm, ${f.event_date}: ${f.source_url}` });
      namedPeople += 1;
    }
    const ev = insEv.get({ org: id, claim: `${f.what_happened} (${f.event_date})`,
      url: f.source_url, at: stamp });
    // One event, one signal — same rule as the firm-name path.
    const dup = db.prepare(
      'SELECT 1 FROM signals WHERE org_id = ? AND trigger_id = ? AND detected_at = ?')
      .get(id, f.trigger_id, f.event_date);
    if (!dup) {
      insSig.run({ org: id, trig: f.trigger_id, on: f.event_date,
        decays: decaysOn(cfg, f.trigger_id, f.event_date, news.lookback_days ?? 365),
        w: triggerWeight(cfg, f.trigger_id), ev: ev.id });
    }
    f.id = id;
  }

  // ---- report --------------------------------------------------------------
  const fresh = found.filter((f) => !f.already);
  const seen = found.filter((f) => f.already);

  console.log(heading(`FIRMS NAMED (${found.length}) — ${fresh.length} not already in the book`));
  if (found.length) {
    console.log(table(found.map((f) => ({
      state: f.already ? 'known' : 'NEW',
      name: f.name, domain: f.domain ?? '—', date: f.event_date,
      trig: f.trigger_id, what: truncate(f.what_happened, 60),
    })), [
      { key: 'state', label: '', width: 5 }, { key: 'name', label: 'FIRM', width: 28 },
      { key: 'domain', label: 'DOMAIN', width: 22 }, { key: 'date', label: 'DATED', width: 10 },
      { key: 'trig', label: 'TRIGGER', width: 26 }, { key: 'what', label: 'WHAT', width: 60 },
    ]));
  }

  if (fresh.length) {
    console.log(`\n${bold('Vet these before spending anything else on them')} — two cents each, ` +
      'and the gates kill roughly three quarters:');
    for (const f of fresh) {
      console.log(dim(`  npm run lead -- vet --name "${f.name}"` +
        `${f.domain ? ` --domain ${f.domain}` : ''} --vertical ${f.sector}` +
        `${f.id ? ` --id ${f.id}` : ''}`));
    }
    if (fresh.some((f) => !f.domain)) {
      console.log(dim('\n  Some have no domain: the extractor withholds one unless confident, ' +
        'because a wrong domain enriches another company entirely. Supply it yourself.'));
    }
  } else {
    console.log(dim('\nNothing new. Either the sector is quiet, or the queries are returning ' +
      'the same firms the book already holds.'));
  }
  console.log(dim(`\n${found.length} candidate(s) saved with their triggering event. ` +
    'They carry no `kind`, so gate and rank skip them until vetted — nothing unvetted ' +
    'can reach the shortlist.'));
  // Said out loud, because it is the whole point of reading the article twice.
  if (namedPeople) {
    console.log(dim(`${namedPeople} person(s) named in those articles and kept, with the ` +
      'source on each. They are a reporter\'s word for who holds a seat, not the firm\'s ' +
      'own page — worth confirming before writing to one.'));
  }
  console.log(dim(`${creditsUsed()} Tavily credits · $${cost.toFixed(4)} judging`));
  finishRun(db, runId, { cost_usd: cost, n_in: sectors.length, n_out: fresh.length, tavily_credits: creditsUsed() });
}

/**
 * Re-run the judgement over events already stored, and retract what fails.
 *
 * Two jobs in one pass, and it is the same pass either way.
 *
 * The cleanup: a signal admitted under a looser prompt is still in the database,
 * still dated, still carrying urgency into `rank`. Fixing the prompt does not
 * reach it. Five of sixteen discovered events described something that had not
 * happened as claimed, and one of them ranked fourth on the operator's list.
 *
 * The measurement: those sixteen events are a labelled set the system produced
 * itself, so re-judging them says what a prompt change actually bought, in
 * findings kept and findings dropped, rather than in an assertion that it reads
 * better. Costs no Tavily credits — the evidence is already here.
 *
 * A failed signal is RETRACTED, never deleted. What the system got wrong is the
 * record this project exists to keep.
 */
async function rejudge(db, cfg, targeting, runId, args) {
  const rows = db.prepare(`
    SELECT s.id, s.org_id, s.trigger_id, s.detected_at, o.name AS firm,
           e.claim, e.source_url,
           (SELECT vertical_id FROM org_verticals WHERE org_id = o.id LIMIT 1) AS vertical
      FROM signals s
      JOIN orgs o     ON o.id = s.org_id
      JOIN evidence e ON e.id = s.evidence_id
     WHERE s.retracted_at IS NULL AND e.kind = 'news_event'
     ORDER BY vertical, o.name`).all();

  if (!rows.length) { console.log('No news-sourced signal to re-judge.'); return; }

  const bySector = new Map();
  for (const r of rows) {
    const k = r.vertical ?? '(unassigned)';
    if (!bySector.has(k)) bySector.set(k, []);
    bySector.get(k).push(r);
  }

  console.log(heading(`re-judging ${rows.length} stored event(s) · ${bySector.size} sector(s)` +
    (args.dry ? ' · dry run, nothing retracted' : '')));
  console.log(dim('No retrieval, no credits — the same judge, over evidence already held.\n'));

  const kept = [];
  const dropped = [];
  const refiled = [];
  let cost = 0;

  for (const [sectorId, items] of bySector) {
    const v = targeting.verticals?.find((x) => x.id === sectorId);
    // Judge each event against the trigger it actually claims, not against
    // whatever the sector happens to declare: a signal predating a sector's
    // current trigger list would otherwise be retracted for the wrong reason.
    const triggerIds = [...new Set(items.map((i) => i.trigger_id))];

    const res = await complete(db, runId, {
      model: cfg.models.cheap, effort: 'medium', maxTokens: 8000, schema: DISCOVER_SCHEMA,
      system: readFileSync(resolve(ROOT, 'prompts/discover-firms.md'), 'utf8'),
      messages: [{ role: 'user', content:
        `SECTOR: ${v?.name ?? sectorId}\n${(v?.thesis ?? '').trim()}\n\n` +
        `TRIGGERS IN PLAY:\n${triggerIds.map((id) => triggerBrief(cfg, id)).join('\n')}\n\n` +
        'RESULTS: each is an event this system already accepted. Return only those ' +
        'that genuinely report their stated trigger at that firm. Keep the same ' +
        'firm name, trigger_id and source_url so the answer can be matched back.\n\n' +
        items.map((r, i) =>
          `[${i + 1}] ${r.detected_at} — ${r.firm} — claims: ${r.trigger_id}\n` +
          `  ${r.source_url}\n  ${r.claim}`).join('\n\n') }],
    });
    cost += res.cost_usd ?? 0;

    // Matched on url AND trigger, because the interesting case is the event that
    // survives under a DIFFERENT trigger than it was filed under. Kirkland's $500M
    // AI commitment was stored as `published_ai_cost_concern` — announcing a large
    // budget is not the cost pressure that trigger describes, but it is plainly a
    // capital event. Retracting it silently would throw away a real finding, so a
    // re-file is reported as its own outcome and the operator decides.
    const survived = new Set((res.data?.firms ?? [])
      .map((f) => `${f.source_url}|${f.trigger_id}`));
    const byUrl = new Map((res.data?.firms ?? []).map((f) => [f.source_url, f]));
    for (const r of items) {
      if (survived.has(`${r.source_url}|${r.trigger_id}`)) { kept.push(r); continue; }
      const elsewhere = byUrl.get(r.source_url);
      if (elsewhere && elsewhere.trigger_id !== r.trigger_id) {
        refiled.push({ ...r, suggested: elsewhere.trigger_id });
      } else {
        dropped.push({ ...r, why: res.data?.rejected_note ?? null });
      }
    }
    console.log(`  ${bold(v?.name ?? sectorId)} ${dim(`${items.length} judged`)}`);
    if (res.data?.rejected_note) console.log(dim(`    ${truncate(res.data.rejected_note, 150)}`));
  }

  // ---- retract -------------------------------------------------------------
  if (!args.dry && (dropped.length || refiled.length)) {
    const stamp = new Date().toISOString();
    const ret = db.prepare(
      'UPDATE signals SET retracted_at = ?, retracted_reason = ? WHERE id = ?');
    const all = db.transaction(() => {
      for (const d of dropped) {
        ret.run(stamp, `re-judged under ${PROMPT_DISCOVER} and did not report ` +
          `${d.trigger_id}`, d.id);
      }
      // A re-file is retracted too — the signal as FILED was wrong — but the
      // reason records the trigger it does fit, so the event is recoverable.
      for (const r of refiled) {
        ret.run(stamp, `re-judged under ${PROMPT_DISCOVER}: not ${r.trigger_id}, ` +
          `but reports ${r.suggested}. Re-file by hand if it is worth a signal.`, r.id);
      }
    });
    all();
  }

  console.log(heading(`${kept.length} kept · ${dropped.length} retracted` +
    (refiled.length ? ` · ${refiled.length} filed under the wrong trigger` : '')));
  if (dropped.length) {
    console.log(table(dropped.map((d) => ({
      firm: d.firm, trigger: d.trigger_id, dated: d.detected_at,
      claim: truncate(d.claim, 66),
    })), [
      { key: 'firm', label: 'RETRACTED', width: 26 },
      { key: 'trigger', label: 'CLAIMED', width: 26 },
      { key: 'dated', label: 'DATED', width: 10 },
      { key: 'claim', label: 'WHAT IT SAID', width: 66 },
    ]));
  }
  if (refiled.length) {
    console.log(`\n${bold('Real events, wrong trigger')} — retracted as filed, ` +
      'and worth a second look rather than a bin:');
    for (const r of refiled) {
      console.log(`  ${r.firm}: filed ${dim(r.trigger_id)}, reports ${bold(r.suggested)}`);
      console.log(dim(`    ${truncate(r.claim, 90)}`));
    }
  }
  console.log(dim(`\n$${cost.toFixed(4)} judging, 0 Tavily credits.` +
    (args.dry ? ' Dry run: nothing was retracted.'
      : (dropped.length || refiled.length)
        ? ' Retracted, not deleted — next: npm run rank && npm run dash' : '')));
  finishRun(db, runId, { cost_usd: cost, n_in: rows.length, n_out: kept.length, tavily_credits: creditsUsed() });
}

const PROMOTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['found', 'url', 'event_date', 'note'],
  properties: {
    found: { type: 'boolean', description: 'Did the firm announce THIS event on its own site?' },
    url: { type: ['string', 'null'], description: "The firm's own page. Null when found is false." },
    event_date: { type: ['string', 'null'], description: 'YYYY-MM-DD as the firm states it, or null.' },
    note: { type: ['string', 'null'], description: 'Date disagreements, near-misses, anything a human should see.' },
  },
};

/**
 * Ask whether a firm announced, on its own site, an event we recorded from
 * someone else.
 *
 * 19 of 22 stored events cite a third party, and the hosts include four content
 * farms. A firm's own newsroom is the better citation for the same fact: it is
 * primary, it is durable, and it carries detail the trade write-up drops. New
 * York Life's own release named the executive the new Chief AI Officer reports
 * to AND a working email address; the aggregator the system had stored named
 * neither, and that release was found by hand rather than by this pipeline.
 *
 * This is the one stage where a model chooses what to retrieve, and the choice
 * is bounded to a single allowed domain handed to it by this code. It can pick
 * the query; it cannot pick the site. Every URL it returns is verified to be on
 * that domain before anything is written, because a schema field is a claim and
 * not a guarantee.
 */
async function promote(db, cfg, news, runId, args) {
  const rows = db.prepare(`
    SELECT s.id, s.org_id, s.trigger_id, s.detected_at, s.evidence_id,
           o.name AS firm, o.domain, e.claim, e.source_url
      FROM signals s
      JOIN orgs o     ON o.id = s.org_id
      JOIN evidence e ON e.id = s.evidence_id
     WHERE s.retracted_at IS NULL AND o.domain IS NOT NULL
       AND (? IS NULL OR s.org_id = ?)
     ORDER BY s.detected_at DESC`)
    .all(args.org && args.org !== true ? String(args.org) : null,
         args.org && args.org !== true ? String(args.org) : null);

  const onOwnDomain = (url, domain) => {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      const d = String(domain).replace(/^www\./, '').toLowerCase();
      return h === d || h.endsWith(`.${d}`);
    } catch { return false; }
  };

  // Normally only off-domain citations are worth a search. `--recheck` includes
  // the ones already primary, because promoting a citation and leaving the date
  // alone is how a signal ends up contradicting its own source.
  const todo = args.recheck ? rows : rows.filter((r) => !onOwnDomain(r.source_url, r.domain));
  const already = rows.length - todo.length;

  console.log(heading(`${todo.length} event(s) cited to a third party` +
    (already ? ` · ${already} already primary` : '') + (args.dry ? ' · dry run' : '')));
  if (!todo.length) { console.log('Nothing to promote.'); return; }
  console.log(dim('One search each, restricted to the firm\'s own domain. ' +
    `$10 per 1,000 searches plus tokens.\n`));

  const system = readFileSync(resolve(ROOT, 'prompts/promote-primary.md'), 'utf8');
  const insEv = db.prepare(`
    INSERT INTO evidence (org_id, kind, claim, source_url, retrieved_at, provenance)
    VALUES (@org, 'news_event', @claim, @url, @at, 'retrieved')
    ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET retrieved_at = excluded.retrieved_at
    RETURNING id`);
  const point = db.prepare('UPDATE signals SET evidence_id = ? WHERE id = ?');

  let cost = 0;
  const promoted = [];
  const missed = [];
  const rejected = [];

  for (const r of todo) {
    const domain = String(r.domain).replace(/^www\./, '');
    process.stdout.write(dim(`  ${r.firm.slice(0, 26).padEnd(27)} `));
    const res = await complete(db, runId, {
      model: cfg.models.default, effort: 'low', maxTokens: 4000,
      schema: PROMOTE_SCHEMA, system,
      tools: [{
        type: 'web_search_20260209', name: 'web_search',
        allowed_domains: [domain], max_uses: 2,
      }],
      messages: [{ role: 'user', content:
        `FIRM: ${r.firm}\nTHEIR DOMAIN: ${domain}\n` +
        `EVENT THIS SYSTEM RECORDED: ${r.claim}\n` +
        `TRIGGER: ${r.trigger_id}\nDATE ON FILE: ${r.detected_at}\n` +
        `CURRENTLY CITED TO: ${r.source_url}\n\n` +
        'Did this firm announce this same event on its own site?' }],
    });
    cost += res.cost_usd ?? 0;
    const d = res.data ?? {};

    // A returned URL is a claim. Verify the host before trusting it: the whole
    // value of this stage is that the citation is primary, and a model that
    // hands back an off-domain link would quietly undo that.
    if (!d.found || !d.url) {
      missed.push({ ...r, note: d.note });
      console.log(dim('no announcement'));
      continue;
    }
    if (!onOwnDomain(d.url, domain)) {
      rejected.push({ ...r, url: d.url });
      console.log(dim(`off-domain, rejected: ${truncate(d.url, 40)}`));
      continue;
    }
    // TAKE THE PRIMARY SOURCE'S DATE. The first version of this stage promoted
    // the citation and left the date, which produced a signal whose own evidence
    // contradicted it: a global law firm read 2026-08-30 from a content farm while
    // the firm's newsroom dated the same rollout 2026-05-12 — three and a half
    // months of urgency the ranking should never have had. A firm is the better
    // authority on the date of its own announcement, which is what this stage
    // exists to assert; declining to act on it was incoherent.
    // Month precision counts. That firm's newsroom path says /2026/05/ and
    // names no day, and "sometime in May" is enormously better than a content
    // farm's 30 August. A bare YYYY-MM is read as the FIRST of the month, which
    // makes the event as old as it could be — the conservative direction for a
    // system whose failure mode is inventing urgency.
    const raw = String(d.event_date ?? '');
    const norm = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw
      : /^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : null;
    const corrected = norm && norm !== r.detected_at ? norm : null;
    promoted.push({ ...r, url: d.url, event_date: d.event_date, note: d.note, corrected });
    console.log(`${bold('primary')} ${dim(truncate(d.url, 46))}` +
      (corrected ? ` ${bold(`date ${r.detected_at} -> ${corrected}`)}` : ''));
    if (!args.dry) {
      const ev = insEv.get({ org: r.org_id, claim: r.claim, url: d.url,
        at: new Date().toISOString() });
      point.run(ev.id, r.id);
      if (corrected) {
        db.prepare(`UPDATE signals SET detected_at = ?, decays_at = ?,
                      date_corrected_from = COALESCE(date_corrected_from, ?)
                    WHERE id = ?`)
          .run(corrected,
               new Date(Date.parse(corrected) + (news.lookback_days ?? 365) * DAY_MS)
                 .toISOString().slice(0, 10),
               r.detected_at, r.id);
      }
    }
  }

  const fixed = promoted.filter((p) => p.corrected);
  console.log(heading(`${promoted.length} promoted · ${fixed.length} date(s) corrected · ` +
    `${missed.length} never announced it` +
    (rejected.length ? ` · ${rejected.length} rejected off-domain` : '')));
  if (promoted.length) {
    console.log(table(promoted.map((p) => ({
      firm: p.firm, was: hostOf(p.source_url), now: hostOf(p.url),
      dates: p.event_date && p.event_date !== p.detected_at
        ? `${p.detected_at} -> ${p.event_date}` : p.detected_at,
    })), [
      { key: 'firm', label: 'FIRM', width: 26 },
      { key: 'was', label: 'WAS CITED TO', width: 26 },
      { key: 'now', label: 'NOW CITED TO', width: 26 },
      { key: 'dates', label: 'DATE', width: 24 },
    ]));
    for (const p of promoted.filter((x) => x.note)) {
      console.log(dim(`  ${p.firm}: ${truncate(p.note, 110)}`));
    }
  }
  console.log(dim(`\n$${cost.toFixed(4)} including searches at $0.01 each.` +
    (args.dry ? ' Dry run: nothing written.'
      : promoted.length ? ' Next: npm run dash' : '')));
  finishRun(db, runId, { cost_usd: cost, n_in: todo.length, n_out: promoted.length, tavily_credits: creditsUsed() });
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; } };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const targeting = loadTargeting(cfg);
  const news = cfg.sources?.news ?? {};
  if (news.enabled === false) throw new Error('sources.news.enabled is false in runtime.yml');

  const db = openDb();
  const runId = startRun(db, 'news', { model: args.dry ? null : cfg.models.cheap });
  const now = Date.now();
  const since = new Date(now - (news.lookback_days ?? 365) * DAY_MS).toISOString().slice(0, 10);

  if (args.sectors) {
    await sectors(db, cfg, targeting, news, runId, args);
    db.close();
    return;
  }

  if (args.discover) {
    await discover(db, cfg, targeting, news, since, runId, args);
    db.close();
    return;
  }

  if (args.rejudge) {
    await rejudge(db, cfg, targeting, runId, args);
    db.close();
    return;
  }

  if (args.promote) {
    await promote(db, cfg, news, runId, args);
    db.close();
    return;
  }

  const orgs = args.org && args.org !== true
    ? db.prepare('SELECT * FROM orgs WHERE id = ?').all(String(args.org))
    : db.prepare(`SELECT o.* FROM orgs o
        WHERE o.kind IS NOT NULL
          ${args.all ? '' : `AND NOT EXISTS (SELECT 1 FROM gate_results g
                             WHERE g.org_id = o.id AND g.outcome LIKE 'kill%')`}
        ORDER BY o.name`).all();

  console.log(heading(`news · ${orgs.length} firm(s) · events since ${since}` +
    (args.dry ? ' · dry run, nothing written' : '')));
  if (!orgs.length) { console.log('No firm to search.'); finishRun(db, runId, {}); db.close(); return; }

  const insEv = db.prepare(`
    INSERT INTO evidence (org_id, kind, claim, source_url, retrieved_at, provenance)
    VALUES (@org, 'news_event', @claim, @url, @at, 'retrieved')
    ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET retrieved_at = excluded.retrieved_at
    RETURNING id`);
  const insSig = db.prepare(`
    INSERT INTO signals (org_id, trigger_id, detected_at, decays_at, weight, evidence_id)
    VALUES (@org, @trig, @on, @decays, @w, @ev)
    ON CONFLICT(org_id, trigger_id, evidence_id) DO UPDATE SET
      detected_at = excluded.detected_at, decays_at = excluded.decays_at`);

  const rows = [];
  let cost = 0;
  let totalDropped = 0;

  for (const org of orgs) {
    const triggers = triggersFor(cfg, targeting, org);
    if (!triggers.length) continue;
    console.log(`\n${bold(org.name)} ${dim(`— ${triggers.length} trigger(s) worth searching`)}`);

    const own = await newsroomPages(org, 4, (l) => console.log(dim(l)));
    if (own.length) console.log(dim(`    ${own.length} page(s) from their own site`));

    const hits = [];
    for (const t of triggers) {
      const { results, undated, error } = await searchNews(t.query, {
        sinceDate: since,
        maxResults: news.max_results ?? 6,
        excludeDomains: news.exclude_domains ?? [],
      });
      if (error) { console.log(dim(`    ${t.id}: ${error}`)); continue; }
      totalDropped += undated ?? 0;
      console.log(dim(`    ${t.id}: ${results.length} dated` +
        (undated ? `, ${undated} dropped as undateable` : '')));
      for (const r of results) hits.push({ ...r, trigger_id: t.id });
    }
    if (!hits.length && !own.length) {
      rows.push({ org, searched: triggers.length, found: 0 });
      continue;
    }

    if (args.dry) {
      for (const h of hits) console.log(dim(`      ${h.published_on}  ${truncate(h.title, 84)}`));
      rows.push({ org, searched: triggers.length, found: hits.length,
                  own: own.length, note: 'dry' });
      continue;
    }

    // One judging pass over everything found for this firm.
    const res = await complete(db, runId, {
      model: cfg.models.cheap, effort: 'medium', maxTokens: 6000, schema: SCHEMA,
      system: readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8'),
      messages: [{ role: 'user', content:
        `Report every qualifying event with the date it happened. Do NOT judge whether ` +
        `a date is recent or in range — that is decided in code after you answer.\n\n` +
        `FIRM: ${org.name}${org.domain ? ` (${org.domain})` : ''}` +
        `${org.kind ? `, a ${org.kind}` : ''}\n\nTRIGGERS BEING TESTED:\n` +
        triggers.map((t) => `- ${t.id}: ${t.description ?? ''}`).join('\n') +
        (hits.length ? `\n\nDATED NEWS RESULTS (published_date is the ARTICLE's date; the ` +
          `event may be earlier):\n` + hits.map((h, i) =>
          `[${i + 1}] trigger searched: ${h.trigger_id}\n  ARTICLE DATE: ${h.published_on}\n` +
          `  TITLE: ${h.title}\n  URL: ${h.url}\n  SNIPPET: ${h.snippet}`).join('\n\n') : '') +
        (own.length ? `\n\nTHE FIRM'S OWN PAGES. These are authoritative — a firm announcing ` +
          `its own transaction or appointment is ground truth. They usually carry the event ` +
          `date in the text; use that date, and cite the page URL you found it on.\n` +
          own.map((p) => `--- PAGE: ${p.url}\n${p.text.slice(0, 9000)}`).join('\n\n') : '') }],
    });
    cost += res.cost_usd ?? 0;
    const events = res.data?.events ?? [];

    const today = new Date(now).toISOString().slice(0, 10);
    let rejected = 0;
    for (const e of events) {
      // Verify the judged date the same way the retriever verifies published_date.
      // A model asked for a date will supply one whether or not it found one, and
      // the first live run emitted a 2023-01-01 that no source supported.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.event_date ?? '')
          || e.event_date < since || e.event_date > today) {
        console.log(dim(`    rejected ${e.trigger_id}: event_date "${e.event_date}" is ` +
          `outside ${since}..${today} or malformed — a date nothing supports is worse than none`));
        rejected++;
        continue;
      }
      // The URL must be one actually retrieved, not one recalled or assembled.
      const known = hits.some((h) => h.url === e.source_url)
        || own.some((p) => p.url === e.source_url)
        // A newsroom index links its own items; accept a URL on the same host.
        || own.some((p) => { try {
             return new URL(p.url).hostname === new URL(e.source_url).hostname;
           } catch { return false; } });
      if (!known) {
        console.log(dim(`    rejected ${e.trigger_id}: source_url was not among the ` +
          'retrieved results'));
        rejected++;
        continue;
      }
      const w = triggerWeight(cfg, e.trigger_id);
      const ev = insEv.get({ org: org.id, claim: `${e.what_happened} (${e.event_date})`,
        url: e.source_url, at: new Date(now).toISOString() });

      // One EVENT, one signal — however many outlets carried it. The unique key
      // on signals is (org, trigger, evidence_id), so two articles about the same
      // announcement produced two signals and double-counted urgency. Extra
      // coverage is corroboration, and belongs in `evidence`, not in the score.
      const already = db.prepare(
        'SELECT id FROM signals WHERE org_id = ? AND trigger_id = ? AND detected_at = ?')
        .get(org.id, e.trigger_id, e.event_date);
      if (already) {
        console.log(dim(`    ${e.trigger_id} ${e.event_date} already on file; stored the ` +
          'extra source as corroborating evidence only'));
        continue;
      }

      insSig.run({ org: org.id, trig: e.trigger_id, on: e.event_date,
        decays: decaysOn(cfg, e.trigger_id, e.event_date, news.lookback_days ?? 365),
        w, ev: ev.id });
      console.log(`    ${bold('EVENT')} ${e.trigger_id} ${e.event_date} — ${truncate(e.what_happened, 110)}`);
      console.log(dim(`          ${e.source_url}`));
    }
    const kept = events.length - rejected;
    if (!kept) {
      console.log(dim(`    nothing qualified. ${res.data?.rejected_note ?? ''}`));
    }
    rows.push({ org, searched: triggers.length, found: hits.length,
                own: own.length, events: kept });
  }

  console.log(heading('RESULT'));
  console.log(table(rows.map((r) => ({
    org: r.org.name, kind: r.org.kind ?? '·',
    searched: String(r.searched), dated: String(r.found ?? 0), own: String(r.own ?? 0),
    events: r.events ? String(r.events) : (r.note === 'dry' ? 'dry' : '—'),
  })), [
    { key: 'org', label: 'FIRM', width: 34 }, { key: 'kind', label: 'KIND', width: 14 },
    { key: 'searched', label: 'QUERIES', width: 7, align: 'right' },
    { key: 'dated', label: 'NEWS', width: 5, align: 'right' },
    { key: 'own', label: 'OWN', width: 4, align: 'right' },
    { key: 'events', label: 'EVENTS', width: 6, align: 'right' },
  ]));
  console.log(dim(`\n${creditsUsed()} Tavily credits · ${totalDropped} results dropped as ` +
    `undateable · $${cost.toFixed(4)} judging · run ${runId}`));
  console.log(dim('An undateable article cannot support a "why now", so it is ' +
    'dropped rather than kept with a guessed date.'));

  finishRun(db, runId, { cost_usd: cost, n_in: orgs.length,
    n_out: rows.reduce((a, r) => a + (r.events ?? 0), 0) , tavily_credits: creditsUsed() });
  db.close();
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
