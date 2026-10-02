// Stage 1c: people and events from sector conference agendas.
//
// WHY THIS EXISTS, measured 2026-09-23. 1,338 of the 1,599 people in this book
// arrived from `staff_listing` — a firm's leadership page — and a leadership
// page lists chief officers by design. It never lists the CTO's reports. 720 of
// them were C-suite, 23 notes had gone to chief officers and presidents, and
// not one had been answered; every reply the project has ever had came from
// below that layer.
//
// It also explains the commonest blocker in the database. A leadership page is
// a list of names with NO EVENTS ATTACHED, so the channel produced people
// without reasons and the ranker correctly reported that there was no reason.
//
// An agenda gives a person AND an event in one fetch: name, title, firm, and a
// session that says what they are working on. The session abstract is the
// trigger; prompts/judge-session.md decides whether it names a DIFFICULTY —
// which is what the operator asked for — rather than a victory lap.
//
// NOTHING HERE TOUCHES LINKEDIN, by any route. The agendas are the event
// operator's own pages, fetched under their own robots.txt.
//
// Usage:
//   npm run events                       every operator in discovery.yml
//   npm run events -- --operator <id>    just one
//   npm run events -- --year 2027        which agenda year to ask for
//   npm run events -- --dry              list the events it would fetch, spend nothing
//   npm run events -- --no-judge         extract and load, skip the session judge
//   npm run events -- --limit N

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, slugify } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete, promptBody } from './models.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JUDGE_PROMPT = 'prompts/judge-session.md';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// ONE SLUG FUNCTION, used for orgs, people and nothing else. On the hand-run
// that preceded this stage, two scripts slugged "D'addario & Company" two
// different ways in the same pass and one person was silently lost. Unicode is
// normalised first so an apostrophe or an accent cannot fork an id.
const slug = (s) => slugify(String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, ''));

const parseArgs = (argv) => {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
};

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow',
    signal: AbortSignal.timeout(30_000) });
  return res.ok ? res.text() : null;
}

/**
 * The operator's own robots.txt is the enumeration AND the permission. It lists
 * a sitemap per event subsite, and disallows the ones not yet live. Reading it
 * each run is the point: hard-coding either list goes stale the moment the
 * operator adds an event.
 */
// WHEN THE EVENT ACTUALLY HAPPENS, added 2026-09-23 after a draft went out in the
// past tense about a talk seven weeks in the future.
//
// The record this stage wrote said, in its own words, "the session is the dated
// reason to write" -- and carried no date for the session, only the date the
// agenda was retrieved. So `unblock` had nothing to reason from and guessed the
// tense, differently each time: "You spoke at the 2026 Manufacturing Excellence
// Summit" beside "You're presenting this year". Some of those events are
// months away. A cold note that misplaces a talk in time is checkable by the
// recipient in one second, and it is the cheapest possible way to prove nobody
// looked.
//
// THE DATE IS NOT ON THE AGENDA PAGE. It sits on the event's own landing page --
// "November 9-11, 2026" in plain HTML one level up -- which is why this stage
// missed it while reading agendas only. One extra fetch per event, same origin,
// same robots.txt permission the agenda already cleared, still one-per-firm
// rate-limited.
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_N = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12 };

/** "November 9-11, 2026" -> { text, starts_on: '2026-11-09', ends_on: '2026-11-11' }. Null when the page says nothing. */
export function eventDateFrom(html) {
  if (!html) return null;
  const plain = String(html).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');
  const iso = (yr, mo, d) => `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const mon = (x) => MONTH_N[String(x).toLowerCase()];
  // A RANGE ACROSS A MONTH FIRST ("September 29-October 1, 2026"). Added
  // 2026-10-01: without it the same-month pattern below found nothing, the
  // single-day pattern took "October 1, 2026", and a three-day event was
  // stamped with its LAST day. Fifty-one speakers who spoke on the 29th and
  // 30th were then written to as speaking "today".
  const cross = plain.match(new RegExp(`(${MONTHS})\\s+(\\d{1,2})\\s*[-\u2013\u2014]\\s*(${MONTHS})\\s+(\\d{1,2}),?\\s*(20\\d\\d)`, 'i'));
  if (cross && mon(cross[1]) && mon(cross[3])) {
    const yr = Number(cross[5]);
    return { text: cross[0].replace(/\s+/g, ' ').trim(), starts_on: iso(yr, mon(cross[1]), Number(cross[2])),
      ends_on: iso(yr, mon(cross[3]), Number(cross[4])) };
  }
  // A range first ("November 9-11, 2026"), then a single day. Ranges are what
  // these operators publish, and taking the single-day pattern first would
  // match the range's opening day and silently drop the end.
  const range = plain.match(new RegExp(`(${MONTHS})\\s+(\\d{1,2})\\s*[-\u2013\u2014]\\s*(\\d{1,2}),?\\s*(20\\d\\d)`, 'i'));
  const single = range ? null
    : plain.match(new RegExp(`(${MONTHS})\\s+(\\d{1,2}),?\\s*(20\\d\\d)`, 'i'));
  const m = range ?? single;
  if (!m) return null;
  const month = mon(m[1]);
  const day = Number(m[2]);
  const yr = Number(range ? m[4] : m[3]);
  if (!month || !day || day > 31) return null;
  return { text: m[0].replace(/\s+/g, ' ').trim(), starts_on: iso(yr, month, day),
    ends_on: range ? iso(yr, month, Number(m[3])) : iso(yr, month, day) };
}

const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Mark the day blocks of a multi-day agenda in its HTML, so the text a model
 * reads says which day each session sits under.
 *
 * Tabbed agendas print all their day labels together at the top and then one
 * block per day whose only tie to its label is an id or data attribute
 * ("29-sep-2026"). Flattened to text, every session looks like it belongs to
 * whichever label came last. An element whose id or data-date/data-day/data-id
 * IS a date gets "[DAY 2026-09-29]" inserted as its first text.
 */
export function markAgendaDays(html) {
  const asIso = (v) => {
    const x = String(v).toLowerCase();
    let m = x.match(/^(\d{1,2})[-_ ]([a-z]{3})[a-z]*[-_ ](20\d\d)$/);
    if (m && MON3[m[2]]) return `${m[3]}-${String(MON3[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = x.match(/^([a-z]{3})[a-z]*[-_ ](\d{1,2})[-_ ](20\d\d)$/);
    if (m && MON3[m[1]]) return `${m[3]}-${String(MON3[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = x.match(/^(?:day[-_])?(20\d\d)-(\d{2})-(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  return String(html ?? '').replace(
    /<(div|section|article|ul|ol|li|table|tbody)\b([^>]*?)\b(id|data-date|data-day)="([^"]+)"([^>]*)>/gi,
    (tag, el, pre, attr, val, post) => {
      const d = asIso(val);
      return d ? `${tag}\n[DAY ${d}]\n` : tag;
    });
}

// THE LANDING PAGE ADVERTISES THE NEXT EDITION, NOT THE ONE YOU SCRAPED, and
// that nearly turned this fix into a worse bug. Checked across twelve events:
// the Biomanufacturing summit's page says November 9-11 2026 and its 2026
// agenda is indeed still to come -- but the finance summit's page says March
// 8-10 2027 while the 2026 agenda in hand is the edition that ran last spring.
// A CFO's own post ("excited for this upcoming week to present at NAFES in
// Tampa", six months ago) is the ground truth that settles it.
//
// So the landing-page date only describes the agenda you hold WHEN THE YEARS
// MATCH. When the page has rolled forward to a later year, the edition you
// scraped has already happened, and the honest output is 'past' with no date
// rather than next year's date attached to last year's talk.
export function tenseFor(startsOn, today, agendaYear = null) {
  if (!startsOn) return null;
  const pageYear = Number(String(startsOn).slice(0, 4));
  if (agendaYear && pageYear > Number(agendaYear)) return 'past';
  return startsOn > today ? 'upcoming' : 'past';
}

/** The date to print, or null when the page has rolled past the agenda in hand. */
export function dateForAgenda(when, agendaYear) {
  if (!when) return null;
  if (agendaYear && Number(when.starts_on.slice(0, 4)) > Number(agendaYear)) return null;
  return when;
}

async function eventsFromRobots(origin) {
  const txt = await get(new URL('/robots.txt', origin).href);
  if (!txt) return { events: [], disallowed: [], raw: '' };
  const events = [...new Set([...txt.matchAll(/Sitemap:\s*https?:\/\/[^\s/]+\/([a-z0-9-]+)\/sitemap[^\s]*/gi)]
    .map((m) => m[1].toLowerCase()))];
  const disallowed = [...new Set([...txt.matchAll(/^Disallow:\s*\/([a-z0-9-]+)\/\s*$/gim)]
    .map((m) => m[1].toLowerCase()))];
  return { events: events.filter((e) => !disallowed.includes(e)), disallowed, raw: txt };
}

const strip = (h) => String(h ?? '')
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
const text = (h) => strip(h).replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#x27;|&#039;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/&rsquo;|&#8217;/g, "'").replace(/\s+/g, ' ').trim();

/** A CSS-class selector like `h3.name`, compiled to the one regex this needs. */
// Accepts "h3.title" and, since 2026-09-23, "h3.title|h3.agenda-title" — one
// operator serves two markup variants for the same field across its own pages,
// and a selector that only knows one silently drops every speaker on the other.
const sel = (s) => {
  const alts = String(s).split('|').map((one) => {
    const [tag, cls] = one.trim().split('.');
    return `<${tag}[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/${tag}>`;
  });
  return new RegExp(`(?:${alts.join('|')})`, 'gi');
};

/**
 * Read each speaker's session FROM THE CONTAINER THEY SIT IN, not from document
 * order.
 *
 * THE FIRST VERSION WALKED THE PAGE IN ORDER, carrying the most recent session
 * heading onto every speaker until the next one matched. That is wrong whenever
 * a heading is missed, and these pages are not uniform, so headings are missed
 * constantly. Checked by hand against four speakers on two live agendas, THREE
 * WERE WRONG:
 *
 *   - a CFO and a director of business analytics credited with a session
 *     belonging to a speaker at another firm; the CFO's own post named a
 *     different talk entirely
 *   - an SVP of global operations credited with a session 90,925 characters
 *     earlier in the document, belonging to a president at another company. His
 *     own heading sat 359 characters before his name and was never matched
 *   - two executives at one biotech credited with an AI session 1,429
 *     characters back, when their actual entry says "Content to be Announced"
 *
 * A distance bound was tried first and the third case defeats it: 1,429 is
 * inside any bound generous enough to keep real ones. The structure was the
 * answer all along — the markup NESTS the session with its speakers:
 *
 *   <div class="stream-speaker-detail">
 *     <h3 class="agenda-title">Content to be Announced</h3>
 *     <div class="speaker-info"><h3 class="name">Jane Doe</h3>
 *
 * Scoped to that container, all four read correctly, and 61 of 63 speakers on
 * one agenda get a session where the two without genuinely have none.
 *
 * A WRONG SESSION IS WORSE THAN NO SESSION, which is why this matters more than
 * a parsing detail. For a conference-sourced prospect the session IS the reason
 * to write; strip it and what is left is a name and a title, which is the
 * leadership-page layer that produced zero replies from 23 sends. A borrowed
 * session does not degrade the channel, it poisons it — the note goes out
 * naming a talk the recipient did not give.
 *
 * Returns a confidence report alongside the rows. A parse that breaks must LOOK
 * broken: the first extractor written by eye returned eighty rows with session
 * prose in the company column and nothing said so.
 */
function extract(html, selectors) {
  const h = strip(html);
  const rows = []; const seen = new Set();
  let blocks = 0;

  // Split on the containers a session and its speakers share. Declared in
  // config so a new operator's markup is a config change, not a code change.
  const wrap = new RegExp(
    `<div[^>]*class="[^"]*\\b(?:${(selectors.container ?? 'stream-speaker-detail|stream-col')})\\b[^"]*"[^>]*>`, 'gi');
  const starts = [...h.matchAll(wrap)].map((m) => m.index);
  for (const [i, at] of starts.entries()) {
    const blk = h.slice(at, starts[i + 1] ?? h.length);
    blocks++;
    const sm = blk.match(sel(selectors.session));
    const session = sm ? text(sm[0].replace(/<[^>]+>/g, ' ')) : '';
    const names = [...blk.matchAll(sel(selectors.name))];
    const titles = [...blk.matchAll(sel(selectors.title))];
    const firms = [...blk.matchAll(sel(selectors.company))];
    for (const [j, n] of names.entries()) {
      const name = text(String(n[0]).replace(/<[^>]+>/g, ' '));
      const title = text(String(titles[j]?.[0] ?? '').replace(/<[^>]+>/g, ' '));
      const firm = text(String(firms[j]?.[0] ?? '').replace(/<[^>]+>/g, ' '));
      const key = `${name.toLowerCase()}|${firm.toLowerCase()}`;
      if (!name || !title || !firm || seen.has(key)) continue;
      seen.add(key);
      rows.push({ name, title, firm, session });
    }
  }

  const suspect = rows.filter((r) => r.firm.toLowerCase() === r.name.toLowerCase()
    || r.firm.length > 60 || r.title.length > 90).length;
  return { rows, report: { speakers: rows.length, blocks,
    withSession: rows.filter((r) => r.session).length, suspect } };
}

const SIZE_SCHEMA = { type: 'object', additionalProperties: false, required: ['firms'],
  properties: { firms: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['firm', 'employees', 'sells_to_this_market'],
    properties: {
      firm: { type: 'string' },
      employees: { type: 'integer', description: 'Approximate total employees you already know. 0 if you genuinely do not know this firm: a 0 is honest and a wrong number decides something.' },
      sells_to_this_market: { type: 'boolean', description: 'true if this firm SELLS software, consulting, systems integration, logistics or staffing INTO these functions rather than being such a buyer itself.' },
    } } } } };

const RELEVANCE_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['relevant', 'why'],
  properties: { relevant: { type: 'boolean' }, why: { type: 'string' } } };

const JUDGE_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['verdict', 'difficulty', 'why'],
  properties: {
    verdict: { type: 'string', enum: ['fires', 'stands_down'] },
    difficulty: { type: 'string', description: "verdict=fires only: the difficulty in the speaker's own terms. Else \"\"." },
    why: { type: 'string' },
  } };

/**
 * SPEAKERS INTO THE BOOK, whichever agenda they came from: size each firm, drop
 * vendors and firms out of band, write the rest with their session as dated
 * evidence, and judge each session for a named difficulty. Split out of main()
 * on 2026-09-30 so `conferences` (organizers found rather than configured) goes
 * through the same judgment as the configured ones, not a second copy of it.
 *
 * `all` rows: { name, title, firm, session, event, event_name, url, when }.
 * Returns what the model calls cost.
 */
// ---- when a speaker speaks ------------------------------------------------
// THE SESSION'S DAY, NOT THE EVENT'S. Added 2026-10-01: a three-day event was
// stamped with one date for every session, and notes told people who spoke two
// days earlier that their talk was "today". A session's own day is used where
// the page placed it on one; otherwise a multi-day event says plainly that the
// day is unknown, so no note can name one.
const isoDay = (x) => (/^20\d\d-\d\d-\d\d$/.test(String(x ?? '')) ? String(x) : null);
const longDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US',
  { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const multiDay = (r) => Boolean(r.when?.ends_on && r.when.ends_on !== r.when.starts_on);
const dateLabel = (r) => (isoDay(r.session_date) ? longDay(r.session_date) : r.when?.text ?? '');
function speakingVerb(r, today) {
  const sd = isoDay(r.session_date);
  if (sd) return sd > today ? 'is speaking at' : sd === today ? 'is speaking today at' : 'spoke at';
  if (!r.when) return 'is on the agenda at';
  if (r.when.starts_on > today) return 'is speaking at';
  if ((r.when.ends_on ?? r.when.starts_on) < today) return 'spoke at';
  return 'is on the agenda at';
}
function dateBlock(r, today) {
  const sd = isoDay(r.session_date);
  const tenseRule = `Write about this talk in that tense. A note that puts a future talk in the past\n`
    + `is checkable by the recipient in one second.\n\n`;
  if (sd) {
    return `SESSION DATE: ${longDay(sd)} — which is `
      + `${sd > today ? 'STILL TO COME' : sd === today ? 'TODAY' : 'IN THE PAST'} as of ${today}.\n` + tenseRule;
  }
  if (r.when && multiDay(r)) {
    const state = r.when.starts_on > today ? 'STILL TO COME'
      : r.when.ends_on < today ? 'IN THE PAST' : 'UNDER WAY';
    return `EVENT DATES: ${r.when.text} (${r.when.starts_on} to ${r.when.ends_on}), ${state} as of ${today}.\n`
      + `THE SESSION'S OWN DAY IS NOT PUBLISHED. Name the event without a day: never "today",\n`
      + `"tomorrow" or "yesterday", and never a date for this session.\n\n`;
  }
  if (r.when) {
    return `EVENT DATE: ${r.when.text} — starts ${r.when.starts_on}, which is `
      + `${r.when.starts_on > today ? 'STILL TO COME' : 'IN THE PAST'} as of ${today}.\n` + tenseRule;
  }
  return `EVENT DATE: NOT PUBLISHED on the event page. The tense of this talk is UNKNOWN —\n`
    + `do not assert that it has happened or is coming. Check the agenda before writing.\n\n`;
}

// THE TENSE IS THE READER'S DAY, NOT THE AGENDA'S. Added 2026-10-02. A speaker
// record is written once, when the agenda is read, and its verb ("is speaking
// at" / "spoke at") and its "STILL TO COME as of <day>" line were frozen at that
// day. A note drafted a week later was told a finished talk was still to come.
// Every stage that hands evidence to a model passes it through here first, so
// the tense is worked out from the stored date on the day it is read. The
// stored row is never rewritten: its claim is part of its key.
const localDay = () => new Date().toLocaleDateString('en-CA');
const stateOf = (from, to, today) => (from > today ? 'STILL TO COME'
  : (to ?? from) < today ? 'IN THE PAST' : from === (to ?? from) ? 'TODAY' : 'UNDER WAY');
export function retense(text, today = localDay()) {
  if (!text || !/ as of 20\d\d-|(?:is speaking(?: today)? at|spoke at|is on the agenda at) .+\(/.test(text)) return text;
  return String(text)
    .replace(/\b(is speaking today at|is speaking at|spoke at|is on the agenda at) (.+?) \(([^()]+)\) on:/g, (m, verb, ev, when) => {
      const d = eventDateFrom(when);
      if (!d) return m;
      const st = stateOf(d.starts_on, d.ends_on, today);
      const v = st === 'STILL TO COME' ? 'is speaking at' : st === 'IN THE PAST' ? 'spoke at'
        : st === 'TODAY' ? 'is speaking today at' : 'is on the agenda at';
      return `${v} ${ev} (${when}) on:`;
    })
    .split('\n').map((line) => {
      const asOf = line.match(/\b(STILL TO COME|TODAY|IN THE PAST|UNDER WAY) as of (20\d\d-\d\d-\d\d)/);
      if (!asOf) return line;
      const range = line.match(/\((20\d\d-\d\d-\d\d) to (20\d\d-\d\d-\d\d)\)/);
      const starts = line.match(/starts (20\d\d-\d\d-\d\d)/);
      const session = /^SESSION DATE:/.test(line.trim()) ? eventDateFrom(line) : null;
      const st = range ? stateOf(range[1], range[2], today)
        : starts ? (starts[1] > today ? 'STILL TO COME' : 'IN THE PAST')
        : session ? stateOf(session.starts_on, session.starts_on, today) : null;
      return st ? line.replace(asOf[0], `${st} as of ${today}`) : line;
    }).join('\n');
}

export async function loadSpeakers(db, runId, all, { model, judge = true, source = 'conference_agendas' } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let spent = 0;
  const firms = [...new Set(all.map((r) => r.firm))];

  // ---- size and vendor-classify, in batches -------------------------------
  const sized = new Map();
  for (let i = 0; i < firms.length; i += 90) {
    const res = await complete(db, runId, { model, maxTokens: 14000, schema: SIZE_SCHEMA,
      system: promptBody('prompts/size-speaker-firms.md'),
      messages: [{ role: 'user', content: firms.slice(i, i + 90).join('\n') }] });
    spent += res.cost_usd ?? 0;
    for (const f of res.data?.firms ?? []) sized.set(f.firm, f);
  }
  // THE BOOK ALREADY KNOWS SOME OF THESE FIRMS, and this threw that away. The
  // sizing above asks a model to recall every employer fresh, and a firm it
  // cannot place comes back 0 — "unknown" — which inBand treats as out. On the
  // 2026-09-23 re-harvest that dropped a 50-person biotech whose headcount was
  // RETRIEVED FROM ITS OWN SITE by `vet` and sat in orgs.headcount_est the whole
  // time, taking two speakers with it. 29 firms came back unknown that run.
  //
  // A figure somebody looked up beats a figure a model half-remembers, so the
  // database wins wherever it has one. Same precedence recordSize keeps.
  const onFile = new Map(db.prepare(`SELECT name, headcount_est hc, kind,
      COALESCE(sells_ai_delivery,0) + COALESCE(sells_ai_advisory,0) sells
    FROM orgs WHERE headcount_est IS NOT NULL`).all().map((o) => [o.name.toLowerCase(), o]));
  let rescued = 0;
  for (const f of firms) {
    const o = onFile.get(String(f).toLowerCase());
    if (!o) continue;
    const guess = sized.get(f);
    if (guess && guess.employees > 0) continue;          // the model knew it; leave it
    sized.set(f, { firm: f, employees: o.hc,
      sells_to_this_market: o.kind === 'delivery_firm' || o.sells > 0 });
    rescued++;
  }
  if (rescued) console.log(dim(`  ${rescued} firm(s) sized from the book rather than from recall`));

  const ceiling = 5000;
  const inBand = (f) => { const s = sized.get(f); return s && !s.sells_to_this_market && s.employees > 0 && s.employees <= ceiling; };
  const hits = all.filter((r) => inBand(r.firm));
  console.log(`  vendors ${[...sized.values()].filter((x) => x.sells_to_this_market).length}` +
    ` · over ${ceiling}: ${[...sized.values()].filter((x) => !x.sells_to_this_market && x.employees > ceiling).length}` +
    ` · unknown ${[...sized.values()].filter((x) => !x.sells_to_this_market && !x.employees).length}` +
    ` · ${bold(`in band ${[...new Set(hits.map((h) => h.firm))].length}`)}`);

  // ---- write ---------------------------------------------------------------
  const org = db.prepare(`INSERT INTO orgs (id,name,domain,headcount_est,headcount_source,kind,first_seen,source)
    VALUES (@id,@name,NULL,@hc,'recalled','end_client',@today,@source)
    ON CONFLICT(id) DO UPDATE SET headcount_est = COALESCE(orgs.headcount_est, excluded.headcount_est)`);
  const per = db.prepare(`INSERT OR IGNORE INTO people (id,org_id,name,title) VALUES (@id,@org,@name,@title)`);
  // IDEMPOTENT, because a harvest gets re-run. The first re-run after the parser
  // was fixed died on the UNIQUE index against its own previous rows, AFTER
  // writing part of the batch — so the run half-succeeded and the judging pass
  // never happened. A speaker record that already exists is not an error; the
  // claim is the same claim.
  const ev = db.prepare(`INSERT INTO evidence (org_id,person_id,kind,claim,source_url,retrieved_at,provenance,body)
    VALUES (@org,@person,'announcement',@claim,@url,@now,'retrieved',@body)
    ON CONFLICT (org_id, kind, source_url, claim) DO UPDATE SET body = excluded.body`);
  let people = 0;
  for (const r of hits) {
    const oid = slug(r.firm); const pid = slug(r.name);
    org.run({ id: oid, name: r.firm, hc: sized.get(r.firm).employees, today, source });
    per.run({ id: pid, org: oid, name: r.name, title: r.title });
    ev.run({ org: oid, person: pid, url: r.url, now: new Date().toISOString(),
      claim: `${r.name} ${speakingVerb(r, today)} ${r.event_name}${dateLabel(r) ? ` (${dateLabel(r)})` : ''} on: `
        + `${r.session || '(no session title published)'}`.slice(0, 300),
      body: `SPEAKER RECORD — ${r.event_name}, agenda retrieved ${today}.\n\n`
        + dateBlock(r, today)
        + `${r.name} — ${r.title}, ${r.firm}\n\nSESSION: ${r.session || '(none published)'}\n\n`
        + `Discovered through a conference agenda rather than a firm leadership page: the session is the\n`
        + `dated reason to write and the seat is the operator layer leadership pages do not list.\n`
        + `Headcount ${sized.get(r.firm).employees} is RECALLED, not retrieved.\n` });
    people++;
  }
  console.log(`  wrote ${people} people`);

  // ---- judge the sessions --------------------------------------------------
  if (judge) {
    const prompt = readFileSync(resolve(ROOT, JUDGE_PROMPT), 'utf8');
    const sig = db.prepare(`INSERT INTO signals (org_id,trigger_id,detected_at,decays_at,weight,evidence_id)
      SELECT @org,'practitioner_aired_ai_difficulty',@today,date(@today,'+180 days'),4,@ev
       WHERE NOT EXISTS (SELECT 1 FROM signals x WHERE x.org_id=@org
         AND x.trigger_id='practitioner_aired_ai_difficulty' AND x.retracted_at IS NULL)`);
    // ONE PLACEHOLDER PER VALUE, which this did not have. It built the IN list
    // from `new Set(hits.map(() => '?'))` -- a set of identical strings, which
    // collapses to exactly ONE '?' however many events ran -- and then bound
    // every distinct url against it. With a handful of events it merely bound
    // the wrong ones; with seventeen it threw "Too many parameter values were
    // provided" and took the whole judging pass down AFTER the harvest had been
    // written, so the run looked half-successful and the signals never fired.
    const urls = [...new Set(hits.map((h) => h.url))];
    const rows = db.prepare(`SELECT e.id ev, e.org_id, e.body, p.name, p.title, o.name firm
      FROM evidence e JOIN people p ON p.id=e.person_id JOIN orgs o ON o.id=e.org_id
     WHERE e.source_url IN (${urls.map(() => '?').join(',') || "''"})`).all(...urls);
    let fired = 0;
    for (const r of rows) {
      const res = await complete(db, runId, { model, maxTokens: 3000, schema: JUDGE_SCHEMA, system: prompt,
        messages: [{ role: 'user', content: `Speaker: ${r.name} — ${r.title}, ${r.firm}\n\n${r.body}` }] });
      spent += res.cost_usd ?? 0;
      if (res.data?.verdict === 'fires') {
        fired++; sig.run({ org: r.org_id, ev: r.ev, today });
        console.log(`  ${bold('FIRES')} ${r.name} @ ${r.firm} — ${res.data.difficulty}`);
      }
    }
    console.log(`\n  ${fired} of ${rows.length} sessions named a difficulty`);
  }

  return spent;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  const cfg = await loadConfig();
  const year = String(args.year ?? new Date().getFullYear());
  const model = cfg.runtime?.models?.default ?? cfg.models?.default;   // from runtime.yml
  const today = new Date().toISOString().slice(0, 10);

  const mech = (cfg.mechanisms ?? []).find((m) => m.id === 'conference_agendas');
  if (!mech) throw new Error('no `conference_agendas` mechanism in config/discovery.yml');
  if (mech.automation !== 'allowed') throw new Error(`conference_agendas automation is "${mech.automation}"`);
  let operators = mech.operators ?? [];
  if (args.operator && args.operator !== true) operators = operators.filter((o) => o.id === args.operator);
  if (!operators.length) throw new Error('no operators to run');

  const runId = startRun(db, 'events', { model, notes: `year=${year} operators=${operators.length}` });
  let spent = 0;
  const all = [];

  for (const op of operators) {
    const origin = new URL(op.sitemap).origin;
    const { events, disallowed } = await eventsFromRobots(origin);
    console.log(heading(`${op.id} — ${events.length} event(s) permitted` +
      (disallowed.length ? `, ${disallowed.length} disallowed by robots.txt` : '')));
    if (disallowed.length) console.log(dim(`  skipped by robots: ${disallowed.join(', ')}`));

    const picked = [];
    for (const ev of events.slice(0, Number(args.limit ?? 0) || events.length)) {
      const url = origin + op.agenda_path.replace('{event}', ev).replace('{year}', year);
      const html = await get(url);
      if (!html) { console.log(`  ${dim('—')} ${ev.padEnd(9)} no agenda at ${year}`); continue; }
      const name = text((html.match(/<title>([\s\S]*?)<\/title>/i) ?? [])[1] ?? ev).slice(0, 70);
      const low = name.toLowerCase();
      const never = (op.never_when ?? []).find((k) => low.includes(k));
      const rel = (op.relevant_when ?? []).some((k) => low.includes(k));
      if (never || !rel) {
        console.log(`  ${dim('skip')} ${ev.padEnd(9)} ${never ? `never_when: ${never}` : 'not relevant'}  ${dim(name)}`);
        continue;
      }
      // The landing page one level up carries the dates; the agenda does not.
      // Only kept when the landing page still advertises the year we scraped.
      const when = dateForAgenda(eventDateFrom(await get(`${origin}/${ev}/`)), year);
      const { rows, report } = extract(html, op.selectors);
      if (!rows.length) { console.log(`  ${bold('PARSE?')} ${ev.padEnd(9)} 0 speakers — selectors may not fit this page`); continue; }
      const flag = report.suspect > rows.length * 0.2 ? bold(` ${report.suspect} SUSPECT`) : '';
      console.log(`  ${dim('ok')}   ${ev.padEnd(9)} ${String(rows.length).padStart(3)} speakers, ` +
        `${report.withSession} with a session${flag}  ${dim(name)}`);
      if (!when) console.log(dim(`       no date found for ${ev} — tense will stay unstated`));
      picked.push({ ev, url, name, rows, when });
    }

    // DEDUPE BY SPEAKER OVERLAP, NEVER BY TITLE. A rule that deduped on title
    // similarity collapsed the Fall edition of a summit into the Spring one and
    // would have thrown away 44 people: they share 2 speakers out of 46. Two
    // slugs pointing at one page share all of them.
    const kept = [];
    for (const p of picked) {
      const mine = new Set(p.rows.map((r) => `${r.name.toLowerCase()}|${r.firm.toLowerCase()}`));
      const dup = kept.find((k) => {
        const theirs = new Set(k.rows.map((r) => `${r.name.toLowerCase()}|${r.firm.toLowerCase()}`));
        const shared = [...mine].filter((x) => theirs.has(x)).length;
        return shared >= Math.min(mine.size, theirs.size) * 0.8;
      });
      if (dup) { console.log(dim(`  dupe ${p.ev} is the same page as ${dup.ev}`)); continue; }
      kept.push(p);
    }
    for (const k of kept) all.push(...k.rows.map((r) => ({ ...r, event: k.ev, event_name: k.name,
      url: k.url, when: k.when })));
  }

  console.log(heading(`${all.length} speakers, ${[...new Set(all.map((r) => r.firm))].length} firms`));
  if (args.dry) { console.log(dim('--dry: nothing sized, judged or written.')); finishRun(db, runId, {}); db.close(); return; }
  spent += await loadSpeakers(db, runId, all, { model, judge: !args['no-judge'], source: 'conference_agendas' });
  console.log(dim(`\n  $${spent.toFixed(4)} · next: npm run gate && npm run rank`));
  finishRun(db, runId, {});
  db.close();
}

// RUN ONLY WHEN INVOKED, never on import. Without this, importing the module to
// test eventDateFrom fired a full agenda sweep and an API call. rank.mjs carries
// the same guard for the same reason.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
