// The ranked-prospect dashboard.
//
// Static HTML generated from SQLite, opened from disk. Styled to
// match the author's other dashboards: KPI tiles over numbered panels, each
// panel carrying a lead paragraph that says what the reader is looking at and
// what is wrong with it.
//
// The thing this page exists to answer is not "what are the scores" but "why
// this one over that one". Every ranked row therefore carries the component
// that separates it from the row below, computed rather than narrated.
//
// Usage:  npm run dash            writes data/dashboard.html
//         npm run dash -- --open  and opens it

import { writeFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { openDb } from './db.mjs';
import { CONNECT_NOTE_MAX, loadConfig, buyer as resolveBuyer, notSalesSql, geoBucketOf,
  evidenceClassesFor } from './config.mjs';
import { loadTargeting } from './targeting.mjs';
import { scoreboard, searchFunnel, spend, draftArms, timingText } from './measures.mjs';
import { armOf, channelResults } from './channel-test.mjs';
import { loadBusiness, targetsOfPeople, inSeat } from './business.mjs';
import { historyFor, classify } from './suppression.mjs';
import { noteOnly, isDeclined } from './note-text.mjs';
import { pasteQueue, funnelDays, sourceYield } from './funnel.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'data/dash');
// THE FORMS POST TO THE SERVER'S FULL ADDRESS, not to a relative path. Twice in
// a day, a batch of verdict clicks made on a page opened from disk (file://)
// went nowhere: a relative action posts to the filesystem, and nothing said so.
// With the full address the page works however it was opened, and the page
// warns when the server is not there to receive a click.
const SERVER = `http://127.0.0.1:${process.env.INBOX_PORT ?? 8787}`;
const OUT = resolve(ROOT, 'data/dashboard.html');   // kept: the single-page entry point

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (v) => (v == null ? '—' : Math.round(v * 100));

function linkify(text) {
  return String(text ?? '').split(/(https?:\/\/[^\s)]+)/g).map((p, i) => i % 2
    ? `<a href="${esc(p)}" target="_blank" rel="noopener">${esc(p.replace(/^https?:\/\//, '').slice(0, 48))}</a>`
    : esc(p)).join('');
}

const tile = ({ label, value, sub, note, state = 'good' }) => {
  const color = { good: '#0ca30c', warn: '#c47f17', bad: '#c03434', flat: '#7a7973' }[state];
  // state 'none': a plain figure with no status to report, so no dot and no badge.
  if (state === 'none') {
    return `<div class="tile"><div class="tile-h"><span class="tl">${esc(label)}</span></div>
    <div class="tv">${esc(value)}</div><div class="ts">${esc(sub ?? '')}</div><div class="tw">${note ?? ''}</div></div>`;
  }
  return `<div class="tile"><div class="tile-h">
    <span class="dot" style="color:${color}">●</span><span class="tl">${esc(label)}</span>
    <span class="badge" style="color:${color};border-color:${color}">${state}</span></div>
    <div class="tv">${esc(value)}</div><div class="ts">${esc(sub ?? '')}</div>
    <div class="tw">${note ?? ''}</div></div>`;
};

const bar = (v, cls = '') =>
  `<span class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, Math.round((v ?? 0) * 100)))}%"></i></span>`;

const bullets = (text, cls) => {
  const items = String(text ?? '').split('\n').filter((s) => s.trim());
  return items.length ? `<ul class="${cls}">${items.map((i) => `<li>${linkify(i)}</li>`).join('')}</ul>` : '';
};



// ---------------------------------------------------------------------------
// One page per view. The author's other dashboards are a set of sibling HTML
// files with a shared nav, not one page with client-side tabs — a filtered view
// is a different URL you can leave open in a browser tab.
// ---------------------------------------------------------------------------

const NAVCSS = `
/* Three columns: the whole-book pages, then the two ways of slicing it. Columns
   rather than one wrapping row because the row reordered itself at every window
   width — a link moved because the browser resized, not because anything about
   the run changed. Wrapping happens between columns now, never inside one. */
nav.tabs { display:flex; flex-wrap:wrap; align-items:flex-start; gap:12px 18px;
  margin:0 0 22px; }
nav.tabs .col { display:flex; flex-direction:column; gap:6px; min-width:0; }
nav.tabs .stack { display:flex; flex-direction:column; gap:14px; min-width:0; }
nav.tabs a { font-size:12.5px; padding:5px 11px; border:1px solid var(--line);
  border-radius:20px; color:var(--text2); text-decoration:none; background:var(--card);
  text-align:center; white-space:nowrap; }
nav.tabs a.on { color:var(--surface); background:var(--acc); border-color:var(--acc); }
/* A selected chip's counts take its text colour, or they vanish dark-on-accent. */
nav.tabs a.on span { color:inherit !important; opacity:.85; }
/* A filter reads as a switch: rounded, and it fills in when it is on. A page
   link reads as a destination: square-ended, and the page you are already on is
   marked rather than filled, because "you are here" is not "this is switched
   on". Before this they were the same chip and the same highlight. */
nav.tabs a.f { border-radius:20px; }
nav.tabs a:not(.f) { border-radius:5px; border-style:dashed; }
nav.tabs a.here { border-style:solid; font-weight:600; color:var(--text);
  box-shadow:inset 3px 0 0 var(--acc); }
nav.tabs .grp { font-size:12.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
  color:var(--acc); padding-left:2px; }
nav.tabs .fcount { font-size:12.5px; padding:5px 2px; color:var(--text); white-space:nowrap; }
nav.tabs .fstate a { border-style:dashed; }
/* Cards are hidden by attribute rather than by class so the filter never has to
   know what display mode a card was using. */
[hidden] { display:none !important; }
pre.yml { background:var(--card); border:1px solid var(--line); border-radius:9px;
  padding:12px 14px; overflow-x:auto; font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
  line-height:1.5; color:var(--text); }
pre.yml .c { color:var(--text2); }
/* A retired row stays on the page and must not be mistaken for a live one.
   Loud enough to catch the eye mid-scan, quiet enough not to dominate. */
.ret { display:inline-block; background:#8a2f1e; color:#fff; border-radius:4px;
  padding:1px 6px; font:700 10px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;
  letter-spacing:.08em; vertical-align:1px; }
/* The config index is a list of filenames and nothing else, so it should look
   like one: monospace, two columns, no bullets, no decoration. */
ul.files { list-style:none; padding:0; margin:0; columns:2; max-width:36rem; }
ul.files li { margin:0 0 .5rem; }
ul.files a { font:600 15px ui-monospace,SFMono-Regular,Menlo,monospace; }
`;

const AXIS_OF = { service: 'service', sector: 'sectors', geo: 'geo', capability: 'capability' };

/** The filterable id behind a nav page, in the same vocabulary the cards carry. */
function axisValue(p) {
  return p.group === 'service' ? p.service.id
    : p.group === 'sector' ? p.vertical.id
      : p.group === 'geo' ? p.bucket.id
        : p.group === 'capability' ? p.capability.id : null;
}

/**
 * What a chip has RETURNED, rendered under one hard rule: NO PERCENTAGE UNTIL
 * THE BUCKET CLEARS min_n_for_measured_rate.
 *
 * The rule is the whole point and it is worth stating plainly. With 28 sends
 * across the entire record, a per-segment rate is noise wearing the costume of
 * a measurement: a chip reading "0%" beside three sends would get a good segment
 * killed, and one reading "33%" beside three would get a bad one funded. Raw
 * counts cannot lie that way — "3 sent · 0 replied" says exactly what happened
 * and implies nothing about what it means.
 *
 * A chip earning its percentage is therefore a milestone rather than a default,
 * and it arrives on its own the moment the bucket is large enough to mean
 * something.
 */
let MIN_N = 40;
const ZERO = { firms: 0, people: 0, sent: 0, replied: 0 };
// A pitch in either state is off the menu; the words differ because a refuted
// thesis and a deliberate pause are not the same fact. Mirrors OFF_MENU in
// config.mjs, which is the copy the router uses.
const OFF_MENU_P = new Set(['dead', 'retired']);
function statSpan(st, outcomes = true) {
  if (!st) return '';
  const bits = [`${st.people}`];
  if (outcomes && st.sent) {
    bits.push(`${st.sent} sent`);
    // The rate appears only once the bucket is big enough to carry one.
    if (st.sent >= MIN_N) bits.push(`<b>${Math.round((st.replied / st.sent) * 100)}%</b>`);
    else if (st.replied) bits.push(`${st.replied} replied`);
  }
  return ` <span class="dim">${bits.join(' &middot; ')}</span>`;
}
function statTitle(st, outcomes = true) {
  if (!st) return '';
  // WHERE OUTCOMES ARE MEANINGLESS, SAY NOTHING RATHER THAN ZERO. The status
  // column is a workflow state, not a segment: "Blocked" has no sends by
  // definition and "In flight" is nothing but sends, so a sent/replied pair
  // there would be a tautology reported as a finding.
  if (!outcomes) return ` title="${esc(`${st.firms} firm${st.firms === 1 ? '' : 's'} · ` +
    `${st.people} ${st.people === 1 ? 'person' : 'people'} — a workflow state, not a segment`)}"`;
  const base = `${st.firms} firm${st.firms === 1 ? '' : 's'} · ${st.people} ` +
    `${st.people === 1 ? 'person' : 'people'} · ${st.sent} sent · ${st.replied} replied`;
  const verdict = !st.sent ? 'Nothing sent here yet.'
    : st.sent >= MIN_N ? `${Math.round((st.replied / st.sent) * 100)}% — a measured rate: n >= ${MIN_N}.`
      : `No rate shown: ${st.sent} send${st.sent === 1 ? '' : 's'} is below the ` +
        `n >= ${MIN_N} this project requires before calling a rate measured.`;
  return ` title="${esc(base)} — ${esc(verdict)}"`;
}

function nav(pages, currentId, personas = [], counts = {}, forms = [], minimal = false,
  unattributed = null, retired = null, retiredSvc = null) {
  // Composed once so the heading can carry it; empty when nothing is missing.
  const offerNote = (retiredSvc ?? []).length
    ? `${retiredSvc.reduce((a, r) => a + r.sent, 0)} send(s) went to an offer since retired (`
      + retiredSvc.map((r) => `${r.name}, ${r.sent}`).join('; ') + '), which has no chip'
    : '';
  const sectorNote = [
    unattributed?.sectors ? `${unattributed.sectors} send(s) went to a firm under none of the targets`
      : '',
    (retired ?? []).length
      ? `${retired.reduce((a, r) => a + r.sent, 0)} went to a thesis since retired (`
        + retired.map((r) => r.name).join('; ') + '), which has no chip'
      : '',
  ].filter(Boolean).join('. ');
  // A CONFIG PAGE HAS NOTHING TO SLICE. The slicing columns exist to filter a
  // shortlist, and on a page that renders offers.yml there is no shortlist —
  // twenty-five chips there are navigation debris that make the page harder to
  // read, which is the one thing these pages were split out to fix.
  if (minimal) {
    return '<nav class="tabs">' +
      `<div class="col"><span class="grp">overall</span>${pages.filter((p) => !p.group)
        .map((p) => `<a href="${p.file}"${p.id === currentId ? ' class="here"' : ''}>${esc(p.label)}</a>`)
        .join('')}</div>` +
      '<div class="col"><span class="grp">configuration</span>' +
      `<a href="inputs.html">&larr; all config files</a></div></nav>`;
  }
  // On the shortlist a chip is a filter, not a destination. "Pilot read AND
  // hedge funds AND Texas" is a question the page has to be able to answer, and
  // separate pages cannot express a combination — 7 services x 7 sectors x 5
  // geographies is 245 files nobody is going to generate or find. So the three
  // slicing columns toggle instead of navigating, ANDing across columns and
  // ORing within one.
  //
  // The href stays the single-axis page regardless, because it is still a real
  // URL: a middle-click or cmd-click opens it, and with JS off the nav still
  // works as it always did.
  // Ready filters too (2026-09-27), on targets, offers and geography; the
  // status column is the old ranker's and stays on All prospects only.
  const filtering = currentId === 'index' || currentId === 'ready';
  const here = currentId === 'ready' ? 'ready.html' : 'index.html';
  const link = (p) => {
    const axis = filtering ? AXIS_OF[p.group] : null;
    const val = axis ? axisValue(p) : null;
    // TWO KINDS OF CHIP, AND THEY MUST NOT LOOK ALIKE. A filter chip toggles
    // what this page shows; a page chip leaves for another page. They were
    // styled identically, and worse, the current page carried `.on` — the same
    // token an active filter uses — so "Shortlist" on the shortlist read as a
    // filter that was switched on. `.f` marks a filter, `.here` marks where you
    // already are, and only `.f.on` gets the accent fill.
    const cls = axis && val ? 'f' : (p.id === currentId ? 'here' : '');
    // The count belongs on every filter chip, not just one column. It is worth
    // most on the chips that can be empty: "Austin metro 0" answers the question
    // before the click, where an empty page answers it after.
    // An empty bucket still answers the question, and answers it BEFORE the
    // click where an empty page answers it after. A missing cell is zero, not
    // absent, so the chip renders "0" rather than falling silent.
    const st = axis && val ? ((counts[axis] ?? {})[val] ?? ZERO) : null;
    return `<a href="${p.file}"${axis && val
      ? ` data-axis="${axis}" data-val="${esc(val)}"` : ''}${
      cls ? ` class="${cls}"` : ''}${statTitle(st)}>${esc(p.label)}${statSpan(st)}</a>`;
  };
  // A column is dropped entirely when it is empty rather than left as a bare
  // heading: a "pitches" label over nothing reads as a page that failed to load.
  // A heading may carry a note. Used for one thing only: the sector column
  // under-reports, because some sends belong to no sector and some to a thesis
  // since retired, and without saying so a quiet segment and a gap in the
  // record look identical on a chip. It was a paragraph in the footer; it is a
  // tooltip now, which costs no visible prose and loses no fact.
  const col = (heading, items, note = '') => (items.length
    ? `<div class="col"><span class="grp"${note ? ` title="${esc(note)}"` : ''}>${heading}${
      note ? ' <span class="dim">*</span>' : ''}</span>${items.map(link).join('')}</div>`
    : '');
  // NO "found via" COLUMN, DELIBERATELY. Which retrieval path produced a
  // prospect is a question about the SYSTEM; this page answers a question about
  // the PERSON. The data is still on every card as data-channel.
  // YOUR CALL: the operator's latest verdict. "Write first, not yet sent" is his
  // send list. Counted by the page itself from the cards it shows, so each
  // number is exactly what the chip filters to.
  const callCol = filtering ? `<div class="col"><span class="grp">your call &middot; filter</span>` +
    CALLS.map(([id, label]) =>
      `<a href="${here}" class="f" data-axis="call" data-val="${id}">${label} <span class="n" data-count-call="${id}"></span></a>`).join('')
    + '</div>' : '';
  const ownerCol = filtering ? `<div class="col"><span class="grp">who decides &middot; filter</span>` +
    OWNERS.map(([id, label]) =>
      `<a href="${here}" class="f" data-axis="owner" data-val="${id}">${label} <span class="n" data-count-owner="${id}"></span></a>`).join('')
    + '</div>' : '';
  const pastedCol = filtering ? `<div class="col"><span class="grp">profile &middot; filter</span>` +
    PASTED.map(([id, label]) =>
      `<a href="${here}" class="f" data-axis="pasted" data-val="${id}">${label} <span class="n" data-count-pasted="${id}"></span></a>`).join('')
    + '</div>' : '';
  const statusCol = currentId === 'index' ? `<div class="col"><span class="grp">status &middot; filter</span>` +
    [['open', 'Open'], ['cooling', 'Cooling off'], ['in_flight', 'In flight']]
      .map(([id, label]) =>
        `<a href="index.html" class="f" data-axis="status" data-val="${id}"` +
        `${statTitle((counts.status ?? {})[id] ?? ZERO, false)}>${label}` +
        `${statSpan((counts.status ?? {})[id] ?? ZERO, false)}</a>`)
      .join('') + '</div>' : '';
  const stateBox = filtering ? `<div class="col fstate"><span class="fcount" id="fcount"></span>
      <a href="${here}" id="fclear" hidden>clear filters</a></div>` : '';
  return `<nav class="tabs"${filtering ? ' data-filter="1"' : ''}>` +
    col(filtering ? 'overall &middot; pages' : 'overall',
      pages.filter((p) => !p.group)) +
    // "offers", not "what to sell". The file is offers.yml, the code says
    // offer, the blocker says pitch-but-no-offer — the nav was the last place
    // still using a different word for the same thing.
    // YOUR CALL STACKS UNDER OFFERS, STATUS UNDER TARGETS (the operator,
    // 2026-09-27), so the nav stays a single row of columns.
    '<div class="stack">' +
    col(filtering ? 'offers &middot; filter' : 'offers',
      pages.filter((p) => p.group === 'service'), offerNote) +
    callCol + stateBox +
    '</div>' +
    // No "what the work is" column since 2026-09-27: it was the old capability
    // catalogue, which the redesign does not keep (see the pages list).
    '<div class="stack">' +
    col(filtering ? 'targets &middot; filter' : 'targets',
      pages.filter((p) => p.group === 'sector'), sectorNote) +
    statusCol + '</div>' +
    '<div class="stack">' +
    col(filtering ? 'geography &middot; filter' : 'geography',
      pages.filter((p) => p.group === 'geo')) +
    ownerCol + pastedCol + '</div>' +
    '</nav>';
}

/**
 * The five geography buckets, in the order they matter to the operator. Labels
 * for the two home tiers come from runtime.yml, because "Austin metro" is his
 * answer and not this file's — the ids underneath stay generic so the code
 * reads the same for anyone who forks it.
 */
function geoBuckets(cfg) {
  return [
    { id: 'home_metro', label: cfg.icp?.home_metro_label ?? 'Home metro',
      blurb: 'Close enough to meet. The one channel this record has never had to cold-open.' },
    { id: 'home_region', label: cfg.icp?.home_region_label ?? 'Home region',
      blurb: 'A drive rather than a flight, and the same working hours.' },
    { id: 'national', label: 'National',
      blurb: 'Somewhere else in the home market. No penalty and no bonus.' },
    { id: 'international', label: 'International',
      blurb: 'Outside the home market. Scored down, never out — at a global firm the ' +
        'right answer is usually a colleague in the home market.' },
    { id: 'unknown', label: 'Unknown',
      blurb: 'No location on file and no firm HQ to fall back on. Not penalised: ' +
        'absence of data is not evidence of distance. This is the bucket to shrink.' },
  ];
}

// The one place the three scores are blended. Module-level because both the
// sort and the label that explains the sort have to read the same numbers — a
// card claiming 60/40 above a list ordered 70/30 is worse than no label at all.
let BLEND = { person: 0.6, firm: 0.4 };

/** A service whose pitch is retired should not appear as somewhere to sell. */
function buyerDead(cfg, buyerId) {
  const p = (cfg.buyers ?? []).find((x) => x.id === buyerId);
  return OFF_MENU_P.has(p?.status ?? 'live');
}

/**
 * A service off the menu: its pitch is dead, or the service itself is retired.
 * The second case is an offer that is fine and has no buyer YET -- a retainer
 * positioned to a client already being delivered to, with no clients yet. The
 * chip was a control that could do nothing, on a column read top-down.
 */
function serviceOff(cfg, sv) {
  return buyerDead(cfg, sv.buyer) || (sv.status ?? 'live') === 'retired';
}

function collect(db, cfg, targeting) {
  BLEND = { person: 0.6, firm: 0.4, ...(targeting.ranking?.shortlist_blend ?? {}) };
  const today = new Date().toISOString().slice(0, 10);
  const runId = db.prepare('SELECT MAX(run_id) r FROM scores').get()?.r ?? null;

  const firms = db.prepare(`
    SELECT s.*, o.name, o.domain, o.hq, o.kind, o.aum_usd, o.revenue_est, o.headcount_est,
           o.sells_ai_advisory, o.sells_ai_delivery, o.source
    FROM scores s JOIN orgs o ON o.id = s.org_id WHERE s.run_id = ?`).all(runId);
  const people = db.prepare(`
    SELECT ps.*, (SELECT group_concat(DISTINCT x.vertical_id) FROM person_scores x
                    WHERE x.person_id = ps.person_id AND x.run_id = ps.run_id) AS all_verticals,
           p.name, p.title, p.profile_url, p.degree, p.email, p.email_guess, p.prior_relationship,
           p.platform_activity,
           p.followers, p.role_confirmed, p.in_seat_since, p.location, p.country,
           o.name AS org_name, o.kind AS org_kind, o.source AS org_source
    FROM person_scores ps JOIN people p ON p.id = ps.person_id
    JOIN orgs o ON o.id = ps.org_id WHERE ps.run_id = ?`).all(runId);

  const killedOrgs = new Set(db.prepare(
    "SELECT DISTINCT org_id FROM gate_results WHERE outcome LIKE 'kill%'").all().map((r) => r.org_id));
  const gatesByOrg = new Map();
  for (const g of db.prepare(
    `SELECT g.org_id, g.gate_id, g.outcome, g.reason, g.seeded, g.run_id,
            e.source_url, e.kind AS evidence_kind
       FROM gate_results g LEFT JOIN evidence e ON e.id = g.evidence_id
      ORDER BY g.outcome`).all()) {
    if (!gatesByOrg.has(g.org_id)) gatesByOrg.set(g.org_id, []);
    gatesByOrg.get(g.org_id).push(g);
  }

  // ---- the backstory behind each prospect ---------------------------------
  // None of this was loaded before, which is why the page could rank a firm on
  // a dated trigger and never show the operator the event, the source, or the
  // fact that a judge had since retracted it.
  const evidenceByOrg = new Map();
  for (const e of db.prepare(
    `SELECT org_id, person_id, kind, claim, source_url, provenance, retrieved_at, body
       FROM evidence WHERE claim IS NOT NULL AND TRIM(claim) <> ''
      ORDER BY retrieved_at DESC`).all()) {
    if (!evidenceByOrg.has(e.org_id)) evidenceByOrg.set(e.org_id, []);
    evidenceByOrg.get(e.org_id).push(e);
  }

  // Drafts, newest version first, with whatever was actually sent alongside.
  const draftsByPerson = new Map();
  // NEWEST FIRST, not highest version: versions count per channel, so an old
  // InMail v2 outranked a new connection-note v1 and the box showed the wrong
  // draft after Draft was pressed.
  for (const d of db.prepare(
    `SELECT id, person_id, version, channel, body, sent_text, revise_note, created_at,
            package_id, model, cost_usd, subject
       FROM drafts WHERE person_id IS NOT NULL ORDER BY id DESC`).all()) {
    if (!draftsByPerson.has(d.person_id)) draftsByPerson.set(d.person_id, []);
    draftsByPerson.get(d.person_id).push(d);
  }

  // The grader's latest pass on each draft, shown on the card's note box.
  GRADES.clear();
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'draft_grades'`).get()) {
    for (const g of db.prepare(`SELECT * FROM draft_grades WHERE graded_text = 'draft' ORDER BY id DESC`).all()) {
      if (!GRADES.has(g.draft_id)) GRADES.set(g.draft_id, g);
    }
  }

  // His own call on each person, latest first. See verdictBox().
  const verdictsByPerson = new Map();
  for (const v of db.prepare(`SELECT person_id, verdict, first, reason, rank_then, live_then, created_at
       FROM verdicts ORDER BY id DESC`).all()) {
    if (!verdictsByPerson.has(v.person_id)) verdictsByPerson.set(v.person_id, v);
  }

  const signalsByOrg = new Map();
  for (const g of db.prepare(
    `SELECT s.org_id, s.trigger_id, s.detected_at, s.decays_at, s.weight,
            s.retracted_at, s.retracted_reason, e.claim, e.source_url, e.provenance
       FROM signals s LEFT JOIN evidence e ON e.id = s.evidence_id
      ORDER BY s.detected_at DESC`).all()) {
    if (!signalsByOrg.has(g.org_id)) signalsByOrg.set(g.org_id, []);
    signalsByOrg.get(g.org_id).push(g);
  }

  const outreachByOrg = new Map();
  for (const o of db.prepare(
    `SELECT p.org_id, p.id AS person_id, p.name AS person, p.title AS person_title,
            o.channel, o.sent_at, o.service_pitched, o.status, o.subject, o.sent_to,
            o.message_text, r.sentiment, r.responded_at
       FROM outreach o JOIN people p ON p.id = o.person_id
       LEFT JOIN responses r ON r.outreach_id = o.id
      ORDER BY o.sent_at DESC`).all()) {
    if (!outreachByOrg.has(o.org_id)) outreachByOrg.set(o.org_id, []);
    outreachByOrg.get(o.org_id).push(o);
  }

  const holdsByPerson = new Map(db.prepare(
    'SELECT person_id, release_after, condition FROM hold').all().map((h) => [h.person_id, h]));

  const history = historyFor(db, firms.map((f) => f.org_id));
  const contactedPeople = new Set(db.prepare(
    'SELECT DISTINCT person_id FROM outreach WHERE person_id IS NOT NULL').all().map((r) => r.person_id));
  // ORG-LEVEL ROWS COUNT TOO, and this read only person-level ones. A firm was
  // suppressed on 2026-09-25 because it has ONE decision-maker who had already
  // been written to -- "if he doesnt want me nobody at jtv will want me" -- and
  // the four subordinate seats there kept appearing as live prospects. `draft`
  // honours org rows and refuses; the page that decides where the operator
  // looks did not, so the suppression existed and was invisible exactly where
  // it mattered.
  //
  // AN ORG ROW DOES NOT SUPPRESS THE PERSON ALREADY WRITTEN TO. The first
  // version did, and hid the decision-maker whose reply the firm is waiting on
  // -- while the recorded reason said in as many words that it suppresses the
  // subordinate seats only. He belongs in the in-flight view, not out of sight.
  // A PERSON-level row still suppresses absolutely, because that is what a
  // person-level row means.
  const suppressed = new Set(db.prepare(`
    SELECT p.id FROM people p JOIN do_not_contact d
        ON d.person_id = p.id
        OR (d.org_id = p.org_id AND NOT EXISTS (
              SELECT 1 FROM outreach o WHERE o.person_id = p.id))`).all().map((r) => r.id));
  const held = new Set(db.prepare(
    'SELECT person_id FROM hold WHERE release_after > ?').all(today).map((r) => r.person_id));

  // ---- the shortlist ------------------------------------------------------
  const live = firms.filter((f) => !killedOrgs.has(f.org_id));
  // Enrichment names everyone a firm publishes — Controllers, General Counsel,
  // Associates, Chief Talent Officers. They are correctly extracted and they are
  // not prospects. Only seats that matched a persona as a buyer or a router make
  // the shortlist; the rest are counted and reported, never silently dropped.
  const eligible = people.filter((p) => !killedOrgs.has(p.org_id)
    && !suppressed.has(p.person_id) && !held.has(p.person_id)
    && !contactedPeople.has(p.person_id));
  // SEAT, not discounted authority. See the note in rank.mjs beside
  // seat_authority: gating on the discounted number meant an unexamined person
  // could never appear, and the "who to read next" worklist derived from this
  // list went to zero. The discount still does its work in the ORDERING below.
  // THE FLOOR WAS ALWAYS A SEAT TEST, SO TEST THE SEAT. Its own comment says
  // "only seats that matched a persona as a buyer or a router make the
  // shortlist" -- and the number could not express that. `router` base authority
  // is exactly 0.50, the floor is >= 0.50, and persona_tier_penalty takes 0.08
  // off per step down the list, so a router cleared the floor only at rank 0 and
  // no sector puts a router first. Zero routers had ever reached the shortlist.
  //
  // It surfaced when twelve real business-unit seats -- Chief Claims Officer,
  // Head of Underwriting, VP Claims Digital Experience -- matched their personas
  // correctly, scored 0.18, and vanished. The persona had done its job and the
  // floor threw the answer away.
  //
  // A TARGET'S OWN SEATS COUNT TOO. A target limited to a kind of firm names who
  // there is worth writing to (`seats:` in business.yml), and the personas the
  // formula matches were written for buyers, not for, say, recruiters placing
  // contractors. Without this a Technical Recruiter the operator marked write
  // first scored 0.15 and never reached the page.
  const seatTargets = (loadBusiness(cfg, targeting).targets ?? [])
    .filter((t) => t.where?.kinds?.length && t.seats?.length);
  const seatOk = (p) => seatTargets.some((t) => t.where.kinds.includes(p.org_kind) && inSeat(t, p.title))
    || (p.persona_authority
      ? p.persona_authority === 'buyer' || p.persona_authority === 'router'
      : (p.seat_authority ?? p.authority ?? 0) >= 0.5);
  const noAuthority = eligible.filter((p) => !seatOk(p));

  // People held until a date, at surviving firms. They are correctly excluded
  // from the ranking — but silently, which hides the fact that two of the
  // strongest names in the book unlock within days.
  const releasing = db.prepare(`
    SELECT h.person_id, h.release_after, h.condition, p.name, p.title, o.name AS org_name
    FROM hold h JOIN people p ON p.id = h.person_id JOIN orgs o ON o.id = p.org_id
    WHERE h.release_after > ?
      AND NOT EXISTS (SELECT 1 FROM gate_results g
                      WHERE g.org_id = p.org_id AND g.outcome LIKE 'kill%')
    ORDER BY h.release_after`).all(today);

  // DEDUPED AT THE SOURCE, 2026-09-23. `person_scores` carries a row per
  // (person, thesis), so a firm sitting in four theses puts the same name on the
  // page four times — 232 of 1,465 people on the day this was found, one of them
  // a President & CFO with two identical cards. The note further down already
  // said this, and the dedupe it describes was applied only to the
  // "best prospects" list, so every other view built from `shortlist` kept the
  // duplicates. Fixing it here means every consumer inherits one row per person
  // and no future list has to remember to do it again.
  //
  // The row kept is the best-scoring one, which is the thesis the rest of the
  // card is written about.
  const bestPerPerson = new Map();
  for (const p of eligible.filter(seatOk)) {
    const firm = firms.find((f) => f.org_id === p.org_id);
    const combined = (p.total ?? 0) * BLEND.person + (firm?.total ?? 0) * BLEND.firm;
    const prev = bestPerPerson.get(p.person_id);
    if (!prev || combined > prev.combined) bestPerPerson.set(p.person_id, { ...p, firm, combined });
  }
  const shortlist = [...bestPerPerson.values()].sort((a, b) => b.combined - a.combined);

  const AXES = [['authority', 'authority'], ['reachability', 'reachability'],
                ['warmth', 'warmth']];
  const backstory = { evidenceByOrg, signalsByOrg, outreachByOrg, holdsByPerson, draftsByPerson,
                      verdictsByPerson };

  const totalSpend = db.prepare('SELECT ROUND(SUM(cost_usd), 2) t FROM runs').get().t ?? 0;
  const signals = db.prepare(
    'SELECT COUNT(*) c FROM signals WHERE retracted_at IS NULL').get().c;
  const needProfile = shortlist.filter((p) => p.needs_profile);

  // ---- kill tally ---------------------------------------------------------
  const killTally = db.prepare(`
    SELECT gate_id, COUNT(*) n FROM gate_results
    WHERE outcome LIKE 'kill%' GROUP BY gate_id ORDER BY n DESC`).all();

  // ---- markup -------------------------------------------------------------

  // TRIGGER PERFORMANCE. A trigger is a hypothesis that a findable public event
  // marks a firm worth writing to, and until now nothing said whether any of them
  // paid. Retraction rate is the sharpest column: it is how often the judge
  // accepted something that later failed re-reading, which is a property of that
  // trigger's wording and its `not:` list. A trigger declared and never fired is
  // the other finding — either the event is not public, or the words are wrong.
  const triggerRows = (cfg.triggers ?? []).map((t) => {
    const r = db.prepare(`SELECT COUNT(*) fired,
        SUM(retracted_at IS NOT NULL) retracted,
        COUNT(DISTINCT org_id) firms,
        MAX(detected_at) newest
      FROM signals WHERE trigger_id = ?`).get(t.id);
    const live = db.prepare(`SELECT COUNT(DISTINCT s.org_id) n FROM signals s
       JOIN orgs o ON o.id = s.org_id
      WHERE s.trigger_id = ? AND s.retracted_at IS NULL AND o.kind IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gate_results g
                        WHERE g.org_id = s.org_id AND g.outcome LIKE 'kill%')`).get(t.id).n;
    return { id: t.id, ...r, live };
  }).sort((a, b) => b.fired - a.fired);

  const spendRows = db.prepare(
    'SELECT stage, model, COUNT(*) n, ROUND(SUM(cost_usd),4) c FROM runs GROUP BY stage, model ORDER BY c DESC')
    .all();

  // Two different questions, kept apart. The score answers "is this the right
  // person"; `blockers` answers "should I write to them this week". Ranking by
  // the first and presenting it as the second put an unreachable contact at #1.
  const writable = shortlist.filter((p) => !(p.blockers ?? '').trim());
  const blocked = shortlist.filter((p) => (p.blockers ?? '').trim());
  // BEST FIRST, OBSTACLE SHOWN — the list the operator actually asked for.
  //
  // Splitting on blockers answers "who can I write to this minute with nothing
  // in the way", which is a fair question and was the only one on offer. It is
  // not "who are my best prospects". On 2026-09-22 it put an elected county
  // judge at 40 above a chief information officer at 74 who runs a $100M
  // budget, 155 staff and 295 contractors and had just shipped an agentic
  // system with a named integrator — because the judge had no blocker and the
  // CIO had one. The operator's words: "the shortlist isn't showing me what I
  // want to see."
  //
  // A 74 with one fixable obstacle is worth more of an hour than a 40 with
  // none. So this orders by score across BOTH, and the obstacle rides along on
  // the card instead of removing the person from view. The two lists below stay
  // exactly as they were: this is an additional way of looking, not a
  // replacement, because "writable this week" is still the right question on
  // the morning you have an hour and want to spend it.
  // ONE ROW PER PERSON. person_scores carries a row per (person, thesis), so a
  // firm in two theses lists the same name twice — the same defect the paste
  // worklist had, and it showed up here on the first render.
  // NOT EVERY BLOCKER IS THE SAME KIND OF THING, and the difference is what
  // makes this list worth reading. Some say "not this week": the firm was
  // contacted on Monday, nobody has read the profile, there is no address on
  // file. Those are timing and missing data, and the person behind them is
  // still a prospect — that is exactly who this view exists to surface.
  //
  // Others say "not this person, ever": the seat does not buy this, the remit
  // is the product rather than the operations, the seat has been vacated, the
  // firm sells AI itself. Showing those under "best prospects" is how a
  // competitor's chief technology officer reached fifth place on the first
  // render of this view.
  //
  // Matched on the blocker's own words rather than a parallel list of codes,
  // for the same reason the rank table's tags are: two places to keep in sync
  // is how these drift apart.
  const DISQUALIFYING = [
    'and this seat is',            // wrong seat for the package
    'technology the firm SELLS',   // product remit, not operations
    'seat this person has left',   // retired or former
    'sells AI delivery',           // a competitor
    'publicly recruiting',         // hiring for the thing being sold
  ];
  const disqualified = (p) => DISQUALIFYING.some((d) => String(p.blockers ?? '').includes(d));
  const seenByValue = new Set();
  const byValue = [...shortlist]
    .filter((p) => !disqualified(p))
    .sort((a, b) => b.combined - a.combined)
    .filter((p) => !seenByValue.has(p.person_id) && seenByValue.add(p.person_id))
    .slice(0, 15);

  // WRITTEN TO IS NOT THE SAME AS GONE. Contacting someone removed them from
  // `eligible`, which is correct for ranking and wrong for the page: the card
  // vanished from every view the moment the note went out, and no combination of
  // filters could bring it back, because the person was no longer a card at all.
  // The one thing an operator wants to look at on the day he writes to someone
  // is the person he just wrote to.
  //
  // Only people held out SOLELY because they were contacted. Anyone also killed,
  // suppressed or held belongs in the list that explains that instead — a card
  // can carry one reason honestly and not two.
  // ONE ROW PER PERSON HERE TOO. This list is built from `people` rather than
  // from `shortlist`, so the dedupe applied above did not reach it and Marc
  // Sylvain rendered twice in the same section — once per thesis his firm sits
  // in. Deduped on first occurrence, which is the highest-scoring row because
  // `people` arrives ordered.
  const seenInFlight = new Set();
  const inFlight = people
    .filter((p) => !seenInFlight.has(p.person_id) && seenInFlight.add(p.person_id))
    .filter((p) => contactedPeople.has(p.person_id)
      && !killedOrgs.has(p.org_id) && !suppressed.has(p.person_id) && !held.has(p.person_id)
      && seatOk(p))
    .map((p) => {
      const firm = firms.find((f) => f.org_id === p.org_id);
      const mine = (outreachByOrg.get(p.org_id) ?? [])
        .filter((o) => o.person_id === p.person_id)
        .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));
      return { ...p, firm, combined: (p.total ?? 0) * BLEND.person + (firm?.total ?? 0) * BLEND.firm,
               lastSent: mine[0] ?? null, sentCount: mine.length };
    })
    .sort((a, b) => String(b.lastSent?.sent_at ?? '').localeCompare(String(a.lastSent?.sent_at ?? '')));

  return { today, firms, people, live, shortlist, writable, blocked, byValue, inFlight,
           noAuthority, eligible, killedOrgs, releasing,
           // Needed by the geography pages to say why a bucket is empty rather
           // than just showing an empty bucket.
           contactedPeople, suppressed, held,
           gatesByOrg, killTally, totalSpend, signals, needProfile, spendRows, triggerRows, AXES,
           history, runId, ...backstory };
}

// ---------------------------------------------------------------------------
// Rendering. One shell, many pages.
// ---------------------------------------------------------------------------

const STYLE = `
/* JUMP TO TOP. The shortlist runs to a hundred-odd cards and the only way back
   to the filters was a long scroll or Home, which does nothing while focus sits
   in a paste box. Hidden until there is something to scroll back from. */
#totop{position:fixed;right:18px;bottom:18px;z-index:60;display:none;
  border:1px solid #cfd6e0;background:#fffffff2;color:#334;border-radius:999px;
  padding:.55rem .9rem;font:600 12px/1 system-ui,sans-serif;cursor:pointer;
  box-shadow:0 2px 10px #0000002e;backdrop-filter:blur(3px)}
#totop:hover{background:#fff;border-color:#8fa1b8;color:#111}
#totop b{font-weight:600;color:#7a8699;margin-left:.45rem}
@media print{#totop{display:none!important}}

:root { --surface:#fcfcfb; --card:#ffffff; --text:#0b0b0b; --text2:#52514e;
  --grid:#e6e5e1; --line:#e6e5e1; --acc:#3b5ba9; --good:#0ca30c; --warn:#c47f17; --bad:#c03434;
  --barbg:#eceae4; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --surface:#1a1a19; --card:#222220; --text:#ffffff; --text2:#c3c2b7;
  --grid:#33322f; --line:#33322f; --acc:#8aa4e8; --good:#6ec08d; --warn:#d59a52;
  --bad:#dd7f7f; --barbg:#2f2e2b; } }
:root[data-theme="dark"] { --surface:#1a1a19; --card:#222220; --text:#ffffff; --text2:#c3c2b7;
  --grid:#33322f; --line:#33322f; --acc:#8aa4e8; --good:#6ec08d; --warn:#d59a52;
  --bad:#dd7f7f; --barbg:#2f2e2b; }
* { box-sizing:border-box; }
body { margin:0; background:var(--surface); color:var(--text);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
.wrap { max-width:1180px; margin:0 auto; padding:28px 20px 80px; }
header h1 { font-size:26px; margin:0 0 4px; letter-spacing:-.01em; }
.sub { color:var(--text2); font-size:14px; margin:0 0 6px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(238px,1fr)); gap:12px; margin-bottom:30px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:13px 14px; }
.tile-h { display:flex; align-items:center; gap:7px; margin-bottom:5px; }
.dot { font-size:11px; }
.tl { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--text2); flex:1; }
.badge { font-size:10px; text-transform:uppercase; letter-spacing:.05em; border:1px solid;
  border-radius:20px; padding:1px 7px; }
.tv { font-size:27px; font-weight:600; letter-spacing:-.02em; }
.ts { font-size:12.5px; color:var(--text2); margin-bottom:7px; }
.tw { font-size:12.5px; color:var(--text2); line-height:1.5; }
.panel { margin:0 0 34px; }
.panel h2 { font-size:17px; margin:0 0 5px; font-weight:600; }
.lead { color:var(--text2); font-size:13.5px; margin:0 0 12px; max-width:80ch; line-height:1.65; }
.panel[id] { scroll-margin-top:16px; }
.plot { background:var(--card); border:1px solid var(--line); border-radius:10px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px;
  padding:14px 16px; margin-bottom:11px; }
.card header { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.card h3 { font-size:15.5px; margin:0; font-weight:600; }
.rank { display:inline-block; min-width:1.6em; color:var(--text2); font-variant-numeric:tabular-nums; }
/* A card that is not on the shortlist says so where its position would be. */
.rank.flag { min-width:0; font-size:.72em; letter-spacing:.04em; text-transform:uppercase;
  border:1px solid var(--line); border-radius:3px; padding:.1em .45em; color:var(--text2); }
.title { color:var(--text2); font-weight:400; font-size:13.5px; }
.need { font-size:12.5px; color:var(--text2); margin:8px 0 4px;
  border-left:2px solid var(--line); padding-left:9px; }
.score { font-size:24px; font-weight:600; color:var(--acc); font-variant-numeric:tabular-nums;
  display:flex; flex-direction:column; align-items:flex-end; line-height:1.15; }
.score .scorelab { font-size:10.5px; font-weight:400; color:var(--text2); letter-spacing:.01em;
  white-space:nowrap; }
.meta { color:var(--text2); font-size:12.5px; margin:3px 0 9px; }
.lookup { margin:6px 0 4px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.lookup code { background:var(--bg2,rgba(127,127,127,.12)); border:1px solid var(--line);
  border-radius:5px; padding:3px 7px; font-size:13px; user-select:all; }
.lookup .dim { font-size:12.5px; }
.lookup a.search { font-size:12.5px; }
form.verdict { margin:4px 0 8px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:12.5px; }
form.verdict input[type=text] { font-size:12.5px; padding:2px 6px; }
form.verdict button { font-size:12px; padding:2px 8px; }
form.verdict .vd.write { color:#2a7a2a; font-weight:600; }
form.verdict .vd.skip { color:#a33; font-weight:600; }
.gradefail { color:#a33; }
.gradebox { border-left:3px solid #a33; padding:4px 10px; margin:6px 0; font-size:.92em; }
.gradebox ul { margin:4px 0 0 18px; padding:0; }
button.copy { font:inherit; font-size:11.5px; padding:2px 8px; cursor:pointer;
  border:1px solid var(--line); border-radius:5px; background:transparent;
  color:var(--text2); }
button.copy:hover { color:var(--text); }
button.copy.done { color:#3f8f5f; border-color:#3f8f5f; }
button.copy.copyname { font-size:14px; font-weight:600; padding:3px 10px; }
details.back { margin:10px 0 2px; border-top:1px solid var(--line); padding-top:8px; }
details.back summary { cursor:pointer; font-size:12.5px; color:var(--text2);
  list-style:revert; user-select:none; }
details.back summary:hover { color:var(--text); }
details.raw { margin:6px 0 10px; }
.colleague { border-left:2px solid var(--line); padding:2px 0 2px 10px; margin:9px 0; }
details.raw summary { cursor:pointer; font-size:12px; color:var(--acc); user-select:none;
  list-style:revert; }
pre.pasted { background:var(--bg2,rgba(127,127,127,.10)); border:1px solid var(--line);
  border-radius:8px; padding:11px 13px; margin:8px 0 0; max-height:380px; overflow:auto;
  white-space:pre-wrap; word-break:break-word;
  font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--text2); }
details.back[open] summary { margin-bottom:8px; font-weight:600; color:var(--text); }
.backbody { font-size:12.5px; }
.backbody h5 { margin:12px 0 4px; font-size:12px; text-transform:uppercase;
  letter-spacing:.04em; color:var(--text2); font-weight:600; }
.backbody h5:first-child { margin-top:2px; }
ul.ev { margin:0; padding-left:16px; }
ul.ev li { margin:0 0 7px; line-height:1.45; }
ul.ev.dead li { opacity:.72; text-decoration-color:var(--text2); }
ul.ev a { color:inherit; }
.nosrc { color:#a8642c; }
.firsthand { color:#3f8f5f; font-size:12px; }
.prov { font-size:10.5px; padding:1px 5px; border-radius:9px; border:1px solid var(--line);
  color:var(--text2); white-space:nowrap; }
.prov.op { border-color:#4a7fb5; color:#4a7fb5; }
.status { font-size:10.5px; padding:1px 5px; border-radius:9px; border:1px solid var(--line); }
.status.cold { color:#a8642c; border-color:#a8642c; }
.status.warm { color:#3f8f5f; border-color:#3f8f5f; }
.ev-note { margin:2px 0; line-height:1.45; }
table.knobs { width:100%; border-collapse:collapse; margin:4px 0 14px; font-size:12.5px; }
table.knobs td { border-top:1px solid var(--line); padding:5px 8px; vertical-align:top; }
table.knobs td:first-child { width:210px; }
table.knobs td.num { width:110px; text-align:right; white-space:nowrap; }
.backbody h4, .panel h4 { margin:16px 0 2px; font-size:13px; }
.why { font-size:13.5px; margin:0 0 10px; padding:8px 11px; background:var(--barbg);
  border-radius:7px; border-left:3px solid var(--acc); }
.components div { display:grid; grid-template-columns:8.5rem 1fr 2.4rem; gap:9px;
  align-items:center; margin:2px 0; }
.components .sep { margin-top:8px; padding-top:8px; border-top:1px dashed var(--line); }
.components label { font-size:12px; color:var(--text2); }
.components b { font-size:12px; text-align:right; font-variant-numeric:tabular-nums; }
.bar { display:block; background:var(--barbg); height:7px; border-radius:4px; overflow:hidden; }
.bar i { display:block; height:100%; background:var(--acc); }
.bar.b i { background:var(--warn); } .bar.c i { background:var(--good); }
.pitch { font-size:13px; margin:10px 0 0; }
ul.pros, ul.cons { margin:8px 0 0; padding-left:18px; font-size:13px; }
ul.pros li { color:var(--good); } ul.cons li { color:var(--bad); }
.blocked { margin-top:10px; border-left:3px solid var(--bad); padding-left:11px; }
.blocked h4 { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em;
  color:var(--bad); margin:0 0 3px; font-weight:600; }
.blocked ul { margin:0; padding-left:16px; font-size:12.5px; color:var(--text2); }
.warns { margin-top:10px; border-left:2px solid var(--warn); padding-left:10px; }
.warns h4 { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em;
  color:var(--text2); margin:0 0 3px; font-weight:600; }
.warns ul { margin:0; padding-left:16px; font-size:12.5px; color:var(--text2); }
.action { background:var(--barbg); padding:9px 11px; border-radius:7px; font-size:12.5px; margin:10px 0 0; }
code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
a { color:var(--acc); }
table { border-collapse:collapse; margin-top:9px; width:100%; font-size:12.5px; }
th,td { text-align:left; padding:6px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--text2); font-weight:600; }
details.tbl { margin-top:9px; font-size:13px; color:var(--text2); }
details.tbl summary { cursor:pointer; }
.dim { color:var(--text2); font-size:11.5px; }
.callout { border:1px solid var(--warn); border-radius:9px; padding:11px 14px; color:var(--warn);
  font-size:13.5px; margin:0 0 12px; }
.foot { color:var(--text2); font-size:12.5px; margin-top:40px; border-top:1px solid var(--line);
  padding-top:14px; }
` + NAVCSS;

function layout({ title, h1, sub, body, pages, currentId, personas = [], counts = {},
  minN = 40, unattributed = null, retired = null, retiredSvc = null, forms = [],
  minimal = false, script = '' }) {
  MIN_N = minN;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>${STYLE}  .notebox{margin:.6rem 0 0;font-size:13px}
  .notebox summary{cursor:pointer;opacity:.85}
  .notebox textarea{width:100%;font:13px/1.5 -apple-system,system-ui,sans-serif;margin:.4rem 0;padding:.5rem}
  .nbrow{display:flex;gap:.4rem;flex-wrap:wrap;margin:.3rem 0}
  .nbrow input{flex:1 1 16rem;padding:.3rem}
  .nbrow button{padding:.3rem 1rem;font-weight:600;cursor:pointer}
  .nbrow button.sent{background:#e7f6e7}
  .nbto{margin:.2rem 0}
  .nbnote{opacity:.6;align-self:center}
  .working{display:block;margin-top:.4rem;font-weight:600;opacity:.8}
  .nbdecl{background:#fdeaea;border-left:3px solid #c33;padding:.5rem .7rem;margin:.4rem 0}
  .nbwhy pre{white-space:pre-wrap;font:12px/1.45 ui-monospace,Menlo,monospace;opacity:.75;margin:.3rem 0}
  .pastebox{margin:.6rem 0 0;font-size:13px}
  .pastebox summary{cursor:pointer;opacity:.85}
  .pastebox textarea{width:100%;font:12px/1.4 ui-monospace,Menlo,monospace;margin:.4rem 0;padding:.4rem}
  .pbrow{display:flex;gap:.4rem;flex-wrap:wrap}
  .pbrow input{flex:1 1 14rem;padding:.3rem}
  .pbrow button{padding:.3rem 1rem;font-weight:600;cursor:pointer}
  .pbnote{opacity:.6;margin:.35rem 0 0}
</style>
<script>
// NO SERVER, NO SAVE, AND SAY SO. If the local server is not answering, every
// click and paste on this page is lost; show that before anyone clicks.
window.addEventListener('DOMContentLoaded', () => {
  fetch('${SERVER}/ready.html', { mode: 'no-cors', cache: 'no-store' }).catch(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:sticky;top:0;z-index:99;background:#b3261e;color:#fff;padding:10px 16px;font-weight:600';
    d.textContent = 'The local server is not running, so clicks, pastes and drafts on this page will NOT be saved. '
      + 'Start it with: npm run inbox, then open ${SERVER}/' + (location.pathname.split('/').pop() || 'index.html');
    document.body.prepend(d);
  });
});
// Send the browser back to the card it was posted from, and say something is
// happening. A draft is two API calls plus a re-rank and a rebuild -- about
// thirty seconds -- and an unchanged page for that long reads as a dead button.
document.addEventListener('submit', (e) => {
  const f = e.target;
  const b = f.querySelector('input[name=back]');
  // Back to the same page on the server, by name, however this copy was opened.
  // The server's root serves the Ready page, so a post from '/' goes back to
  // '/', not to index.html (the old ranker's page, which that name still holds).
  if (b) b.value = '/' + (location.protocol === 'file:' && !location.pathname.split('/').pop()
    ? 'ready.html' : location.pathname.split('/').pop()) + '#' + (f.closest('article')?.id || '');
  const pressed = e.submitter || f.querySelector('button[type=submit]:focus');
  const label = pressed ? pressed.value : '';
  // A DISABLED SUBMIT BUTTON IS NOT SUBMITTED. Disabling it for the working
  // state stripped its name and value from the post, so the action field
  // arrived undefined on every press and everything fell through to the default
  // branch -- a revise ran as a plain re-draft and the operator's instruction
  // was thrown away silently. Carry the value in a hidden field before anything
  // is disabled. (No backticks in here: this whole block is a JS template
  // literal, and that is the third time tonight it has bitten.)
  if (label) {
    let h = f.querySelector('input[name=do]');
    if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = 'do'; f.appendChild(h); }
    h.value = label;
  }
  const says = { draft: 'drafting', revise: 'revising', sent: 'recording' }[label] || 'working';
  for (const btn of f.querySelectorAll('button')) btn.disabled = true;
  if (pressed) {
    pressed.disabled = true;
    pressed.dataset.was = pressed.textContent;
    pressed.textContent = says + '\u2026';
  }
  const tick = document.createElement('span');
  tick.className = 'working';
  tick.textContent = ' ' + says + '\u2026 this takes about half a minute; the page will come back here.';
  f.appendChild(tick);
});
</script></head><body><div class="wrap">
<header><h1>${esc(h1)}</h1><p class="sub">${sub}</p></header>
${nav(pages, currentId, personas, counts, forms, minimal, unattributed, retired, retiredSvc)}
${body}
</div>
<script>
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const font = { color: dark ? '#c3c2b7' : '#52514e', size: 12 };
const layoutFor = (extra) => Object.assign({
  paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)', font,
  margin:{l:210,r:24,t:14,b:38},
  xaxis:{gridcolor: dark ? '#33322f' : '#e6e5e1', zeroline:false},
  yaxis:{gridcolor:'rgba(0,0,0,0)', automargin:true},
}, extra || {});

// ---- combining filters (shortlist only) ----------------------------------
// Three independent axes, ANDed across and ORed within, with the selection in
// location.hash so a filtered view is still a URL you can bookmark or leave
// open in a tab — which is the one property the separate pages had and a
// client-side filter would otherwise have thrown away.
(function () {
  const bar = document.querySelector('nav.tabs[data-filter]');
  if (!bar) return;
  const AXES = ['service', 'capability', 'form', 'sectors', 'geo', 'status', 'channel', 'call', 'owner', 'pasted'];
  const cards = Array.from(document.querySelectorAll('article.card[data-service]'));
  const count = document.getElementById('fcount');
  const clear = document.getElementById('fclear');
  for (const n of bar.querySelectorAll('[data-count-call]')) {
    n.textContent = String(cards.filter((c) => c.dataset.call === n.dataset.countCall).length);
  }
  for (const n of bar.querySelectorAll('[data-count-owner]')) {
    n.textContent = String(cards.filter((c) => c.dataset.owner === n.dataset.countOwner).length);
  }
  for (const n of bar.querySelectorAll('[data-count-pasted]')) {
    n.textContent = String(cards.filter((c) => c.dataset.pasted === n.dataset.countPasted).length);
  }

  const read = () => {
    // BUILT FROM AXES, never listed again. This object used to be a second
    // hand-written copy of the axis list, and when two axes were added to AXES
    // and not to it, sel[axis] came back undefined and reading .size threw on
    // the very first click. That killed the whole filter bar silently: the
    // handler died before it could change anything visible, so every chip
    // looked inert. One list, one place.
    //
    // NOTE FOR ANYONE EDITING THIS BLOCK: it is a template literal in dash.mjs.
    // A backtick here terminates the string and the build fails with a syntax
    // error pointing at a comment. Do not quote identifiers with backticks.
    const sel = {};
    AXES.forEach((a) => { sel[a] = new Set(); });
    new URLSearchParams(location.hash.replace(/^#/, '')).forEach((v, k) => {
      if (sel[k]) v.split(',').filter(Boolean).forEach((x) => sel[k].add(x));
    });
    return sel;
  };

  function apply() {
    const sel = read();
    const active = AXES.filter((a) => sel[a].size);
    let shown = 0;
    for (const c of cards) {
      // A person can sit in several sectors, so the card carries a list and a
      // match is any overlap. Service and geography are single-valued but read
      // through the same code path.
      const ok = active.every((axis) => {
        const have = (c.dataset[axis] || '').split(',').map((x) => x.trim());
        return Array.from(sel[axis]).some((v) => have.indexOf(v) !== -1);
      });
      c.hidden = !ok;
      if (ok) shown++;
    }
    // RENUMBER WHAT IS VISIBLE. The rank badge is written at render time, so
    // under a filter it kept the position the card held on the unfiltered page
    // — and the first card left standing in a section could read "7" while a
    // card further down read "3". Worse in the other direction: a blocked card
    // carried a bare number at all, which is a position on a shortlist it is
    // not on. A group CFO whose seat does not buy the offer sat under two
    // chips looking like the top prospect in that bucket, which is what this
    // is being fixed for. Blocked and in-flight cards say so where the number
    // was, and the numbers that remain count only the cards you can see.
    for (const sec of document.querySelectorAll('section.panel')) {
      let n = 0;
      for (const c of sec.querySelectorAll('article.card')) {
        const badge = c.querySelector('.rank');
        if (!badge || badge.classList.contains('flag') || badge.classList.contains('rating') || c.hidden) continue;
        badge.textContent = String(++n);
      }
    }
    for (const a of bar.querySelectorAll('a.f[data-axis]')) {
      a.classList.toggle('on', sel[a.dataset.axis].has(a.dataset.val));
    }
    // A section whose every card is filtered out is hidden with it, so the page
    // never shows a heading and a paragraph of explanation over nothing.
    for (const sec of document.querySelectorAll('section.panel')) {
      const own = sec.querySelectorAll('article.card[data-service]');
      if (own.length) sec.hidden = !Array.from(own).some((c) => !c.hidden);
    }
    // Never the word "everyone": this page is 20-odd cards out of hundreds of
    // people in the database, and the unfiltered state is all of THIS PAGE, not
    // all of the book. Same denominator in both states so the filter reads as a
    // subset of the shortlist rather than of the database.
    // The offer blocks follow the "what to sell" chips exactly: pick two and you
    // see two, pick none and the page opens on the people as it always did.
    // A FILTER OPENS WHAT IT FOUND. Decided cards sit in a collapsed section; a
    // filter that matched one there showed nothing, and the card read as missing.
    if (active.length) {
      for (const det of document.querySelectorAll('details')) {
        if (Array.from(det.querySelectorAll('article.card')).some((c) => !c.hidden)) det.open = true;
      }
    }
    for (const box of document.querySelectorAll('section.offer')) {
      box.hidden = !sel.service.has(box.dataset.offer);
    }
    count.textContent = (active.length ? shown : cards.length) + ' of '
      + cards.length + (shown === 1 && active.length ? ' person' : ' people');
    clear.hidden = !active.length;
  }

  bar.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const chip = e.target.closest('a.f[data-axis]');
    if (chip) {
      e.preventDefault();
      const sel = read();
      const set = sel[chip.dataset.axis];
      if (set.has(chip.dataset.val)) set.delete(chip.dataset.val);
      else set.add(chip.dataset.val);
      const q = AXES.filter((a) => sel[a].size)
        .map((a) => a + '=' + Array.from(sel[a]).join(',')).join('&');
      // Assigning the hash rather than replaceState: it keeps back/forward
      // working as undo, and file:// pages reject history.pushState in some
      // browsers.
      location.hash = q;
      apply();
      return;
    }
    if (e.target.closest('#fclear')) { e.preventDefault(); location.hash = ''; apply(); }
  });
  addEventListener('hashchange', apply);
  apply();
})();

// One delegated listener for every copy button on the page. Falls back to
// selecting the text when the clipboard API is unavailable, which it is on a
// file:// page in some browsers — and these pages are always opened from disk.
document.addEventListener('click', (e) => {
  const b = e.target.closest('button.copy');
  if (!b) return;
  const text = b.getAttribute('data-copy');
  const done = () => { const o = b.textContent; b.textContent = 'copied'; b.classList.add('done');
    setTimeout(() => { b.textContent = o; b.classList.remove('done'); }, 1200); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => selectInstead(b));
  } else selectInstead(b);
});
// The note box's To: line shows only while Email is the channel, and a
// connection note shows its length against LinkedIn's cap.
function nbCount(f) {
  const c = f.querySelector('.nbcount'); const t = f.querySelector('textarea[name=body]');
  if (!c || !t) return;
  const max = Number(c.dataset.max); const n = t.value.trim().length;
  c.textContent = n + ' of ' + max + ' characters' + (n > max ? ', too long for a connection note' : '');
  c.style.color = n > max ? '#c33' : '';
}
document.addEventListener('change', (e) => {
  if (e.target.name !== 'channel') return;
  const f = e.target.closest('form');
  // The Sent button names the channel it will record, so a wrong one shows
  // before the click. (It replaced a confirm popup the operator found needless.)
  const sb = f?.querySelector('button.sent');
  if (sb) sb.textContent = 'Sent as ' + e.target.options[e.target.selectedIndex].text.replace('LinkedIn InMail', 'InMail');
  const to = f?.querySelector('.nbto');
  if (to) to.hidden = e.target.value !== 'email';
  const c = f?.querySelector('.nbcount');
  if (c) { c.hidden = e.target.value !== 'linkedin_connect_note'; nbCount(f); }
});
document.addEventListener('input', (e) => { if (e.target.name === 'body') nbCount(e.target.closest('form')); });
document.querySelectorAll('form.nb').forEach(nbCount);
function selectInstead(b) {
  const code = b.parentElement.querySelector('code');
  if (!code) return;
  const r = document.createRange(); r.selectNodeContents(code);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  b.textContent = 'select+copy';
}
${script}

// JUMP TO TOP, and say where you are while doing it. The count is the useful
// half: on a page of cards the question is usually "how far down am I", and a
// percentage answers it without a scrollbar to squint at.
(function () {
  const btn = document.createElement('button');
  btn.id = 'totop';
  btn.type = 'button';
  btn.innerHTML = '\u2191 top<b></b>';
  btn.title = 'Back to the top of the page';
  document.body.appendChild(btn);
  const pct = btn.querySelector('b');
  let ticking = false;
  const update = () => {
    ticking = false;
    const y = window.scrollY || document.documentElement.scrollTop;
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    btn.style.display = y > 600 ? 'block' : 'none';
    pct.textContent = y > 600 ? Math.round(100 * y / max) + '%' : '';
  };
  addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  addEventListener('resize', update, { passive: true });
  // A CLICK, NOT A HASH. Setting location.hash would push a history entry and
  // put the back button one press further from where the operator came in.
  btn.addEventListener('click', () => {
    scrollTo({ top: 0, behavior: 'smooth' });
  });
  update();
})();
</script></body></html>`;
}

/**
 * Everything behind one prospect, collapsed until asked for.
 *
 * The ranking is a set of numbers, and a number is only checkable if the thing
 * it was computed from is one click away. Urgency 36 means nothing; "appointed
 * a chief AI officer on 2026-08-07, here is the announcement" is a fact the
 * operator can accept or reject in five seconds. CLAUDE.md requires every claim
 * to carry a source URL — until now they carried one in the database and none
 * on the page.
 *
 * `<details>` rather than a script: these pages are opened from disk, the arrow
 * and the toggle are native, and nothing here depends on JavaScript running.
 */
function backstoryPanel(p, d) {
  const sigs = d.signalsByOrg.get(p.org_id) ?? [];
  const ev = d.evidenceByOrg.get(p.org_id) ?? [];
  const out = d.outreachByOrg.get(p.org_id) ?? [];
  const gates = d.gatesByOrg.get(p.org_id) ?? [];
  const hold = d.holdsByPerson.get(p.person_id);
  const live = sigs.filter((x) => !x.retracted_at);
  const dead = sigs.filter((x) => x.retracted_at);
  if (!sigs.length && !ev.length && !out.length && !gates.length && !hold) return '';

  const src = (url, label) => url === 'operator:first-hand'
    ? '<span class="firsthand">you know this first-hand</span>'
    : url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label ?? 'source')}</a>`
    : '<span class="nosrc">no source on file</span>';
  // Written where a URL would go when the operator is the source himself.
  const FIRST_HAND = 'operator:first-hand';
  const prov = (x) => `<span class="prov ${x === 'operator_supplied' ? 'op' : 'ret'}">${
    x === 'operator_supplied' ? 'you pasted this' : 'retrieved'}</span>`;

  // Evidence is stored per firm, but 49 of one PE firm's 68 rows are about one
  // named person and only 19 describe the firm. Pooled under one heading, a
  // card contradicted itself on screen — one prospect's dossier reported 790
  // followers above and cited a colleague's 9,213 below, both sourced, both
  // true, neither about the same man. Split by who the claim is about.
  const EV_CAP = 8;
  const mine = ev.filter((e) => e.person_id === p.person_id);
  const firmWide = ev.filter((e) => !e.person_id);
  const colleagues = ev.length - mine.length - firmWide.length;
  const evList = (rows, cap) => `<ul class="ev">${rows.slice(0, cap).map((e) =>
    `<li>${esc(e.claim)} ${prov(e.provenance)}<br>
      <span class="dim">${esc(e.kind ?? '')}</span> — ${src(e.source_url)}</li>`).join('')}${
    rows.length > cap
      ? `<li class="dim">and ${rows.length - cap} more in the database</li>` : ''}</ul>`;

  return `<details class="back">
    <summary>Why this firm — ${live.length} live trigger${live.length === 1 ? '' : 's'}, ${
      mine.length + firmWide.length} sourced fact${
      mine.length + firmWide.length === 1 ? '' : 's'}${
      out.length ? `, ${out.length} prior contact${out.length === 1 ? '' : 's'}` : ''}${
      dead.length ? `, ${dead.length} retracted` : ''}</summary>
    <div class="backbody">

    ${live.length ? `<h5>Why now</h5><ul class="ev">${live.map((g) => `<li>
      <b>${esc(g.trigger_id)}</b> <span class="dim">${esc(g.detected_at)}${
        g.decays_at ? ` · decays ${esc(g.decays_at)}` : ''}</span><br>
      ${esc(g.claim ?? 'no claim recorded')} — ${src(g.source_url)}</li>`).join('')}</ul>`
    : '<h5>Why now</h5><p class="dim">No live trigger. This firm ranks on fit alone.</p>'}

    ${dead.length ? `<h5>Retracted — judged wrong, kept on the record</h5><ul class="ev dead">${
      dead.map((g) => `<li><b>${esc(g.trigger_id)}</b> <span class="dim">${esc(g.detected_at)}</span><br>
      ${esc(g.claim ?? '')} — ${src(g.source_url)}<br>
      <span class="dim">${esc(g.retracted_reason ?? 'retracted')}</span></li>`).join('')}</ul>` : ''}

    ${mine.length ? `<h5>What we know about ${esc(p.name)}</h5>${evList(mine, EV_CAP)}` : ''}

    ${firmWide.length ? `<h5>What we know about the firm</h5>${evList(firmWide, EV_CAP)}` : ''}

    ${colleagues ? `<p class="dim">${colleagues} further sourced fact${
      colleagues === 1 ? '' : 's'} on file describe colleagues at this firm. Held off this
      card on purpose — they are evidence about someone else, and reading them here is how a
      dossier ends up asserting a colleague's follower count about this person.</p>` : ''}

    ${out.length ? `<h5>Already said to this firm</h5><ul class="ev">${out.map((o) => `<li>
      <b>${esc(o.person)}</b> <span class="dim">${esc(o.sent_at)} · ${esc(o.channel)}${
        o.service_pitched ? ` · ${esc(o.service_pitched)}` : ''}${
        o.sent_to ? ` · to ${esc(o.sent_to)}` : ''}</span><br>
      ${esc(o.subject ?? '')} <span class="status ${o.status === 'sent_no_reply' ? 'cold' : 'warm'}">${
        esc(o.status)}${o.sentiment ? ` (${esc(o.sentiment)})` : ''}</span></li>`).join('')}</ul>` : ''}

    ${gates.length ? `<h5>Gates</h5><ul class="ev">${gates.map((g) => `<li>
      <span class="status ${g.outcome.startsWith('kill') ? 'cold' : 'warm'}">${esc(g.outcome)}</span>
      <b>${esc(g.gate_id)}</b> — ${esc(g.reason ?? '')}
      ${g.outcome === 'pass' ? '' : `<span class="dim">${checkLabel(g)}</span>`}</li>`).join('')}</ul>` : ''}

    ${hold ? `<h5>Your own instruction</h5><p class="ev-note">Held until <b>${
      esc(hold.release_after)}</b> — ${esc(hold.condition ?? '')}</p>` : ''}
    </div></details>`;
}


/**
 * What has already been said to anyone at this firm.
 *
 * It sat inside the backstory disclosure, two clicks down, and carried no
 * message text. A colleague's note is the single most useful thing to read
 * before writing: it fixes what was already claimed, which pitch was tried and
 * what it drew, and the firm cooling rule turns on it. Anything sent to THIS
 * person is left out — that appears on his own draft panel.
 */
function firmOutreachPanel(p, d) {
  const all = d.outreachByOrg.get(p.org_id) ?? [];
  const others = all.filter((o) => o.person_id !== p.person_id);
  if (!others.length) return '';
  const replied = others.filter((o) => /responded_positive|open_thread/.test(o.status ?? ''));
  return `<details class="raw"><summary>${others.length} note${
    others.length === 1 ? '' : 's'} already sent to colleagues at ${esc(p.org_name)}${
    replied.length ? ` — ${replied.length} got a reply` : ', none answered'}</summary>
    <p class="dim">Read these before writing. They fix what the firm has already been told, which
    pitch was tried on it, and what that drew — and a second note into one firm too soon reads as
    spray, which is what the cooling rule in the blockers is counting.
    <a href="outreach.html">Everything sent</a>.</p>
    ${others.map((o) => `<div class="colleague">
      <b>${esc(o.person)}</b> <span class="dim">${esc(o.person_title ?? '')}</span><br>
      <span class="dim">${esc(o.sent_at)} &middot; ${esc(o.channel)}${
        o.service_pitched ? ` &middot; pitched ${esc(o.service_pitched)}` : ''} &middot; <b>${
        esc(o.status ?? 'no status')}</b>${o.sentiment ? ` (${esc(o.sentiment)})` : ''}</span>
      ${(o.message_text ?? '').trim()
        ? `<details class="raw"><summary>Read what was sent — ${o.message_text.length} characters</summary>
           <pre class="pasted">${esc(o.message_text)}</pre></details>`
        : '<p class="dim">Text not preserved; only the fact of it.</p>'}
    </div>`).join('')}
  </details>`;
}

/**
 * Drafts written for this person, and what was actually sent.
 *
 * The gap between the two is the only evidence that can teach voice.md what a
 * note should look like, and until now it lived in a column nothing rendered.
 * Six drafts on record run 2,379 to 4,863 characters; the one note actually
 * sent was 764. That is not six near-misses, it is one systematic error made
 * six times, and it is invisible unless the pair is shown side by side.
 */
// Channels whose recipient sees a subject line before the message. Anywhere else
// a subject would land in the first line of the note and read as a headline.
const CARRIES_SUBJECT = new Set(['email', 'linkedin_inmail']);

function draftPanel(p, d) {
  const rows = d.draftsByPerson.get(p.person_id) ?? [];
  // The button copies the command; it cannot run it. This page is a file on
  // disk with no server behind it, and giving it the power to spend
  // money and write to the database would mean running one — which would also
  // mean a page that can draft outreach on a click, with nothing between a
  // stray click and a billed call.
  // The channel the card actually recommends, not a hardcoded default. Suggesting
  // `--channel email` to someone with no address and a live LinkedIn profile
  // contradicted the "Reachable now" line three lines above it.
  // NO COMMAND LINE HERE EITHER. This printed a `draft` invocation to copy, from
  // before the Note panel existed; the Draft button on the card does the same
  // thing without leaving the page. The operator, 2026-09-24: "delete code from
  // db, its never used".
  const button = '<p class="lookup dim">Use the Note panel below to draft, revise and record.</p>';

  if (!rows.length) {
    return `<details class="raw"><summary>No draft written yet — draft one</summary>
      <p class="dim">Nothing has been drafted for this person. Drafting spends money and cites a
      dated trigger, so it is done one at a time against a live reason rather than in advance.</p>
      ${button}</details>`;
  }
  const sentRow = rows.find((r) => (r.sent_text ?? '').trim());
  return rows.map((r) => {
    const note = noteOnly(r.body);
    const cut = sentRow === r
      ? Math.round((1 - r.sent_text.length / note.length) * 100) : null;
    return `<details class="raw"><summary>Draft v${r.version} — ${r.channel}, ${
      note.length} characters${r.sent_text ? `, sent at ${r.sent_text.length} (${
        cut > 0 ? `${cut}% cut` : `${-cut}% longer`})` : ', not sent'}</summary>
      ${r.revise_note ? `<p class="dim"><b>You asked for:</b> ${esc(r.revise_note)}</p>` : ''}
      ${r.subject ? `<p class="lookup"><code>${esc(r.subject)}</code>
        <button class="copy" data-copy="${esc(r.subject)}">copy</button>
        <span class="dim">subject &mdash; pastes into a different box than the note</span></p>`
      : CARRIES_SUBJECT.has(r.channel)
        ? `<p class="dim">No subject on this draft. ${esc(r.channel)} shows one in the inbox
           list before anything else is read, so an empty one reads as a broken send.</p>`
        : ''}
      <p class="dim">${esc((r.created_at ?? '').slice(0, 10))} · ${esc(r.model ?? '')}${
        r.package_id ? ` · ${esc(r.package_id)}` : ''} · $${(r.cost_usd ?? 0).toFixed(4)}.
      Drafting is all this system does; it has never sent anything and no code path could.</p>
      <pre class="pasted">${esc(r.body)}</pre>
      ${r.sent_text ? `<p class="dim"><b>What you actually sent</b> — ${r.sent_text.length}
        characters against ${note.length} drafted, ${cut > 0 ? `${cut}% shorter` : 'longer'}.
        Measured on the note alone; the NOTES section below it is written for you and never
        goes to anyone.</p>
        <pre class="pasted">${esc(r.sent_text)}</pre>` : ''}
    </details>`;
  // The last pair of command lines on a card. Revise and Sent are buttons in the
  // Note panel now, and a version history that ends by telling him to type the
  // thing he just clicked is noise on every card in the book.
  }).join('') + button + `<p class="dim" style="margin:4px 0 0">Every version is kept;
    revising never overwrites the one it came from.</p>`;
}

/**
 * What went out, on a card for someone already written to. Without this the
 * in-flight section is a list of people with no indication of what was said to
 * them or when, which is the only reason to be looking at it.
 */
function inFlightPanel(p) {
  if (!p.lastSent) return '';
  const o = p.lastSent;
  const days = Math.round(
    (Date.now() - Date.parse(`${String(o.sent_at).slice(0, 10)}T12:00:00Z`)) / 86400000);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const state = { sent_no_reply: 'no reply yet', open_thread: 'thread open',
    channel_open: 'channel open', responded_positive: 'answered',
    responded_negative: 'declined' }[o.status] ?? (o.status ?? 'no status recorded');
  return `<p class="need"><b>Written to ${esc(when)}</b> &middot; ${esc(o.channel)}${
    o.service_pitched ? ` &middot; pitched ${esc(o.service_pitched)}` : ''} &middot; ${esc(state)}${
    p.sentCount > 1 ? ` &middot; ${p.sentCount} notes on file` : ''}</p>
  ${o.subject ? `<p class="dim">Subject: ${esc(o.subject)}</p>` : ''}
  ${o.message_text ? `<details class="raw"><summary>What you actually sent &mdash; ${
    o.message_text.length} characters</summary><p class="dim">Recorded by hand after the fact.
    Nothing in this system sent it.</p><pre class="yml">${esc(o.message_text)}</pre></details>` : ''}`;
}

/**
 * The address, on the face of the card. It was reachable only by opening the
 * draft disclosure and reading the pros list inside it — three clicks from a
 * card whose headline complaint was that no address was on file. The thing you
 * need in order to act is the thing that should not be behind a disclosure.
 */
function addressLine(p) {
  const addr = p.email || p.email_guess;
  if (!addr) return '';
  const verified = Boolean(p.email);
  return `<p class="lookup"><code>${esc(addr)}</code>
    <button class="copy" data-copy="${esc(addr)}">copy</button>
    <span class="dim">${verified
      ? 'verified address'
      : 'inferred from the firm&rsquo;s pattern &mdash; unconfirmed, so a bounce is possible'
    }</span></p>`;
}

/**
 * The pasted LinkedIn text, and what is still missing, at the top level of the
 * card. It used to sit inside the backstory disclosure, which put it two clicks
 * away — and it is the thing most often wanted, because every extracted fact on
 * the card was read out of it.
 */
function profilePanel(p, d) {
  const ev = (d.evidenceByOrg.get(p.org_id) ?? [])
    .filter((e) => e.person_id === p.person_id);
  const pasted = ev.find((e) => e.kind === 'operator_profile' && (e.body ?? '').trim());

  // TWO DIFFERENT LISTS, AND ONLY ONE OF THEM WAS BEING SHOWN. "To move this
  // one: an email address" described what is MISSING and read as though nothing
  // could be done today — on a card for a 2nd-degree contact, active, with
  // fourteen thousand followers, where an InMail was available the whole time.
  // Missing data and available action are different questions and the card now
  // answers both, action first.
  const open = [];
  if (p.email) {
    open.push('<b>email</b> to a verified address');
  } else if (p.email_guess) {
    open.push('<b>email</b> to the pattern guess above — unconfirmed, so it may bounce silently');
  }
  if (p.profile_url) {
    const qual = [
      p.degree ? `${p.degree}°` : 'no connection degree on file',
      p.platform_activity
        ? `${p.platform_activity}${p.followers != null ? ` (${p.followers} followers)` : ''}`
        : 'activity unknown',
    ].join(', ');
    open.push(`<b>InMail</b> — ${esc(qual)}`);
  }

  // What would actually move this person, cheapest first. Named explicitly
  // because "weak channel" describes a state without naming the fix.
  const need = [];
  if (!p.email) {
    need.push(p.email_guess
      ? 'a <b>verified</b> address — the one on file is a pattern guess'
      : 'an <b>email address</b>');
  }
  if (!pasted) need.push('the <b>LinkedIn profile text</b>, pasted in');
  if (!p.degree) need.push('his <b>connection degree</b>');
  if (!p.platform_activity) need.push('whether he is <b>active on LinkedIn</b>');

  // The record cannot rank the two channels — cold email is n=1 on file against
  // ten cold InMails — so the page says which it would open with and why, rather
  // than implying a rate it does not have.
  const prefersInMail = !p.email && p.profile_url;

  return `${reachLine(p, d)}
  ${need.length ? `<p class="need"><b>Worth adding:</b> ${need.join(' · ')}</p>` : ''}
  ${pasted
    ? `<details class="raw"><summary>The LinkedIn profile you pasted on ${
        esc((pasted.retrieved_at ?? '').slice(0, 10))} — ${pasted.body.length} characters</summary>
      <p class="dim">Every fact on this card was read out of this text, so this is where to look
      when one of them seems wrong. Nothing fetched it: you read the page as a person and pasted
      what you saw.${p.profile_url
        ? ` <a href="${esc(p.profile_url)}" target="_blank" rel="noopener">Open his profile</a>.`
        : ''}</p>
      <pre class="pasted">${esc(pasted.body)}</pre></details>`
    : `<details class="raw"><summary>No LinkedIn profile on file — how to add it</summary>
      <p class="dim">The channel fields on this card are empty because nobody has looked, not
      because he is hard to reach. Nothing fetches linkedin.com; you read the page as a person and
      paste what you see.${p.profile_url
        ? ` <a href="${esc(p.profile_url)}" target="_blank" rel="noopener">Open his profile</a>.`
        : ' No profile URL on file either, so the copyable search line above is the way in.'}</p>
      </details>`}`;
}


// A PASTE BOX ON THE CARD ITSELF. The operator, 2026-09-24: "i want the pasting
// box to be a little box associated with each card, i paste that card's LI url
// and profile, press an update or go button, and then the card and database
// update."
//
// It posts to the local inbox server, which ingests, re-ranks, rebuilds the
// dashboards and sends the browser back to this same card — about a second end
// to end. Opened from file:// the form has nowhere to post, so it says so
// rather than looking broken: the dashboards are still static files, they just
// have to be reached through `npm run inbox` for this one control to work.
// A LINK THE OPERATOR CLICKS -- the one exception to the forbidden-host guard,
// granted 2026-09-25 and recorded in CLAUDE.md. It opens LinkedIn's people
// search in HIS browser, as him; nothing in this repo fetches it, follows it or
// reads what comes back. It saves retyping name and firm, which is the only part
// of the paste loop a link can save. Where the profile URL is already on file,
// that is the better link. The guard in config.mjs matches the `href` line
// below character for character, so reshaping it re-arms the guard.
// Legal suffixes and bracketed abbreviations are dropped from the firm:
// LinkedIn search finds "Northwind Islamic Bank" and misses "... (NIB)".
// The firm as LinkedIn search matches it: no bracketed abbreviations, no legal
// suffix. "Northwind Islamic Bank" finds the bank; "... (NIB)" does not.
function searchFirm(org) {
  return String(org ?? '').replace(/\([^)]*\)/g, ' ')
    .replace(/,?\s+(inc|llc|ltd|plc|corp|corporation|co|a\/s|ag|sa|se|nv|group|holdings)\.?$/i, '')
    .replace(/\s+/g, ' ').trim();
}

// The name as a search box wants it: no "Dr."/"Mr."/"Ms.", no trailing degrees.
function searchName(name) {
  return String(name ?? '').replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '')
    .replace(/,?\s+(ph\.?\s?d|md|mba|cpa|jr|sr|iii|ii)\.?$/i, '').trim();
}

// NAME, THEN FIRM, ONE CLICK TO COPY, for pasting into LinkedIn's search box.
// A button with the page's copy handler, dressed as the text it copies.
function copyLine(name, org) {
  const text = `${searchName(name)} ${searchFirm(org)}`.trim();
  return `<button class="copy copyname" data-copy="${esc(text)}" title="Click to copy">${esc(text)}</button>`;
}

// A PROFILE URL IS A LINKEDIN PROFILE ONLY IF IT IS ONE. Conference speakers
// carry the agenda page in the same field, and their cards offered "open
// profile" and advised InMail as if a LinkedIn profile were on file.
const isProfile = (u) => /linkedin\.com\/in\//i.test(String(u ?? ''));

// ONE TAB, REUSED (2026-10-06). Each link opened a new tab, so a paste session
// of twenty cards left twenty LinkedIn tabs open, each a heavy page, and the
// operator's browser grew slow to render LinkedIn. A named target sends every
// click to the same tab.
function searchLink(name, org, profileUrl) {
  if (isProfile(profileUrl)) {
    return `<a class="search" href="${esc(profileUrl)}" target="linkedin" rel="noopener">open profile</a>`;
  }
  const q = encodeURIComponent(`${searchName(name)} ${searchFirm(org)}`.trim());
  const href = `https://www.linkedin.com/search/results/people/?keywords=${q}`;
  return `<a class="search" href="${esc(href)}" target="linkedin" rel="noopener">search LinkedIn</a>`;
}

// THE READY QUEUE. Added 2026-09-25.
//
// Everyone the judge (`npm run judge -- --queue`) has looked at who is still
// live, not contacted, not suppressed or held: its verdict first, then Value,
// Timing and Reach, in that order and never added up. It sits beside the
// current ranking rather than replacing it, and each card says where the ranker
// has the same person, because the operator's clicks here are what decide
// between the two. The month's send budget is counted against config.
function readyPage(db, d, cfg) {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'judgments'`).get();
  const month = new Date().toISOString().slice(0, 7);
  const budget = cfg.outreach_budget_per_month ?? {};
  // An InMail to an Open Profile costs no credit (lead sent --free), so it is
  // not counted against the InMail budget or balance.
  const sent = Object.fromEntries(db.prepare(`SELECT channel, COUNT(*) n FROM outreach
      WHERE substr(sent_at, 1, 7) = ? AND NOT (channel = 'linkedin_inmail' AND COALESCE(credit_spent, 1) = 0) GROUP BY channel`).all(month).map((r) => [r.channel, r.n]));
  // A BALANCE BEATS AN ALLOWANCE. LinkedIn's InMail credits roll over and come
  // back on a reply, so a monthly cap in config read "none left" while LinkedIn
  // showed twelve. Where the operator has typed in the balance he sees, count
  // down from it: that number, less the sends recorded on that channel since.
  const bal = new Map(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'balances'`).get()
    ? db.prepare('SELECT * FROM balances').all().map((b) => [b.channel, b]) : []);
  const chName = (ch) => (ch === 'linkedin_inmail' ? 'InMail' : ch);
  const meter = [...new Set([...Object.keys(budget), ...bal.keys()])].map((ch) => {
    const b = bal.get(ch);
    if (b) {
      const since = db.prepare(`SELECT COUNT(*) n FROM outreach WHERE channel = ? AND id > ? AND NOT (channel = 'linkedin_inmail' AND COALESCE(credit_spent, 1) = 0)`).get(ch, b.after_id).n;
      return `<b>${esc(chName(ch))}</b> ${Math.max(0, b.credits - since)} left <span class="dim">(LinkedIn showed ${
        b.credits} on ${esc(String(b.as_of).slice(0, 10))}; ${since} sent since)</span>`;
    }
    const cap = budget[ch];
    return `<b>${esc(chName(ch))}</b> ${Math.max(0, cap - (sent[ch] ?? 0))} of ${cap} left this month`;
  }).join(' &middot; ');
  const balanceForm = `<form method="post" action="${SERVER}/balance" class="inline">
    <input type="hidden" name="channel" value="linkedin_inmail"><input type="hidden" name="back" value="">
    LinkedIn shows <input name="credits" size="3" inputmode="numeric" value="${esc(bal.get('linkedin_inmail')?.credits ?? '')}">
    InMail credits <button type="submit">Update</button></form>`;
  const intro = `<section class="panel"><h2>Ready to write</h2>
<p class="lead">Rated 1 to 5 from your own past decisions, not from the ranking formula; each
person three times, and <b>±</b> means the runs disagreed by two or more. The page shows
everyone the judge rates 3 or more, in the order of whichever of the judge and the ranking
formula the Scoreboard currently favours. Your <b>Write first</b> picks are the check:
<code>npm run judge -- --scoreboard</code>, or the Scoreboard page.</p>
<p class="lead">${meter || 'No outreach_budget_per_month in config.'}</p>
${balanceForm}</section>`;
  if (!has) {
    return intro + '<section class="panel"><p class="callout">Nobody judged yet. Run '
      + '<code>npm run judge -- --queue</code>.</p></section>';
  }
  // The latest batch per person, with its majority.
  const rows = db.prepare(`SELECT j.* FROM judgments j JOIN (SELECT person_id, MAX(batch) b
      FROM judgments GROUP BY person_id) l ON l.person_id = j.person_id AND l.b = j.batch`).all();
  const byPerson = new Map();
  for (const r of rows) {
    if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, []);
    byPerson.get(r.person_id).push(r);
  }
  const eligible = new Map();
  for (const p of d.eligible ?? []) if (!eligible.has(p.person_id)) eligible.set(p.person_id, p);
  const listPos = new Map((d.writable ?? []).map((p, i) => [p.person_id, i + 1]));
  const blockedIds = new Set((d.blocked ?? []).map((p) => p.person_id));
  const reachRank = (r) => /verified/.test(r) ? 0 : /guessed/.test(r) ? 1 : /active/.test(r) ? 2
    : /^InMail$/.test(r) ? 3 : /rarely/.test(r) ? 4 : 5;
  const cards = [];
  for (const [pid, runs] of byPerson) {
    const p = eligible.get(pid);
    if (!p) continue;
    // The middle of the runs' 1-5 ratings (judge prompt v4). Older judgments
    // carry only write/skip, read as 4 and 1 so they still sort.
    const rs = runs.map((r) => r.compelling ?? (r.verdict === 'write' ? 4 : 1)).sort((a, b) => a - b);
    const rating = rs[Math.floor(rs.length / 2)];
    const spread = rs[rs.length - 1] - rs[0];
    const pick = runs.find((r) => (r.compelling ?? (r.verdict === 'write' ? 4 : 1)) === rating) ?? runs[0];
    const verdict = rating >= 3 ? 'write' : 'skip';
    cards.push({ p, pick, verdict, rating, spread, agree: runs.length - (spread >= 2 ? 1 : 0), of: runs.length });
  }
  cards.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'write' ? -1 : 1)
    || (b.agree / b.of) - (a.agree / a.of)
    || Number(b.pick.value) - Number(a.pick.value)
    || (a.pick.timing_days ?? 9e9) - (b.pick.timing_days ?? 9e9)
    || reachRank(a.pick.reach) - reachRank(b.pick.reach));
  // BLIND UNTIL DECIDED. A verdict clicked while the judge's call is on screen
  // is partly the judge's: on the first 23 the operator agreed 23 times, which
  // proves less than it looks. So a person not yet decided since they were
  // judged shows only neutral facts, in an order that leaks nothing, and the
  // click is recorded as blind. The call, its reasons and the ranker's position
  // appear once the operator has decided, with whether they matched.
  const vmap = (d.backstory ?? d).verdictsByPerson ?? new Map();
  const decided = (c) => { const v = vmap.get(c.p.person_id);
    return v && String(v.created_at) >= String(c.pick.created_at) ? v : null; };
  const hash = (x) => [...String(x)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const facts = (pick) => `${pick.timing_days == null ? 'no dated event'
    : esc(timingText(pick.timing_days, pick.timing_what))} · ${esc(pick.reach ?? '')}`;
  // THE FACTS STAY; ONLY THE CALLS ARE HIDDEN. The first version hid everything
  // but the name, and the operator could not judge. What a card withholds is
  // anyone's verdict -- the judge's, the read's, the ranker's -- never evidence.
  // This person's facts and the firm's, never a colleague's: a fact from one
  // person's paste ("current role at another firm") read as this person's on
  // their card, next to the button that drafts a note to them.
  const evQ = db.prepare(`SELECT kind, claim, source_url, provenance FROM evidence
      WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL)) AND kind NOT IN ('operator_profile', 'web_page')
      ORDER BY (person_id = ?) DESC, (kind = 'news_event') DESC, (provenance = 'operator_supplied') DESC, id DESC
      LIMIT 10`);
  // THE JUDGE CITES BY ID ("[e16422]") and the card printed the id, so checking
  // a claim meant a trip to the database. Each id now opens its source. A pasted
  // fact has no page to open (and its URL is LinkedIn, which no card links to
  // beyond the one search exception), so it says where it came from instead.
  const citeQ = db.prepare('SELECT source_url, provenance FROM evidence WHERE id = ?');
  const cited = (text) => esc(text ?? '').replace(/\[e(\d+)\]/g, (m, id) => {
    const r = citeQ.get(Number(id));
    if (!r) return m;
    if (r.provenance === 'operator_supplied' || !/^https?:/.test(r.source_url ?? '')
      || /(^|\.)linkedin\.com$/i.test(new URL(r.source_url).hostname)) {
      return `<span class="dim" title="you pasted this">[e${id}]</span>`;
    }
    return `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">[e${id}]</a>`;
  });
  // Each event with the evidence behind it. The name alone ("ai coe
  // announcement") hid that the article said something else entirely.
  const sigQ = db.prepare(`SELECT s.trigger_id, s.detected_at, e.claim, e.source_url FROM signals s
      LEFT JOIN evidence e ON e.id = s.evidence_id WHERE s.org_id = ?
      AND s.retracted_at IS NULL ORDER BY s.detected_at DESC LIMIT 5`);
  const orgQ = db.prepare('SELECT kind, headcount_est, revenue_est, revenue_basis FROM orgs WHERE id = ?');
  const perQ = db.prepare('SELECT in_seat_since, location FROM people WHERE id = ?');
  // WHAT THE FIRM DOES, in one line from its own site (enrich's firm_profile),
  // so a card can be read without opening the firm's website first.
  const profQ = db.prepare(`SELECT claim, source_url FROM evidence WHERE org_id = ? AND person_id IS NULL
      AND kind = 'firm_profile' ORDER BY id DESC LIMIT 1`);
  const industryQ = db.prepare('SELECT industry FROM orgs WHERE id = ?');
  // One line for both pages: what the firm does, and who owns it (d.firmLine).
  const whatTheyDo = (p) => d.firmLine(p.org_id);
  // A PASTE MUST SHOW. A profile pasted onto a blind card changed nothing
  // visible when its facts matched what was already there, and the operator,
  // reasonably, pasted it again and asked whether it had been kept.
  const pastedQ = db.prepare(`SELECT MAX(retrieved_at) at, source_url FROM evidence
      WHERE person_id = ? AND kind = 'operator_profile'`);
  const blindFacts = (p) => {
    const o = orgQ.get(p.org_id) ?? {};
    const me = perQ.get(p.person_id) ?? {};
    const size = o.headcount_est ? `${Number(o.headcount_est).toLocaleString('en-US')} people`
      : o.revenue_est && o.revenue_basis === 'revenue' ? `~$${(o.revenue_est / 1e6).toFixed(0)}m revenue` : 'size unknown';
    const sigs = sigQ.all(p.org_id);
    const shown = new Set(sigs.map((x) => x.claim).filter(Boolean));
    const ev = evQ.all(p.person_id, p.org_id, p.person_id).filter((e) => !shown.has(e.claim)).slice(0, 8);
    return `<p class="meta">${esc(o.kind ?? 'kind unknown')}, ${esc(size)}${
      me.location ? ` · ${esc(me.location)}` : ''}${me.in_seat_since ? ` · in the seat since ${esc(me.in_seat_since)}` : ''}</p>
  ${sigs.length ? `<p class="meta"><b>Events</b></p><ul class="facts">${[...new Map(sigs.map((x) => {
      const when = /^\d{4}-\d{2}-\d{2}/.test(String(x.detected_at ?? '')) ? String(x.detected_at).slice(0, 10) : 'undated';
      return [`${x.trigger_id}|${when}`, `<li><b>${esc(String(x.trigger_id).replace(/_/g, ' '))}</b> (${when})${
        x.claim ? `: ${esc(String(x.claim).slice(0, 300))}` : ''}${/^https?:/.test(x.source_url ?? '')
        ? ` <a href="${esc(x.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</li>`];
    })).values()].join('')}</ul>` : ''}
  ${ev.length ? `<ul class="facts">${ev.map((e) => `<li>${esc(String(e.claim).slice(0, 260))}${
      e.provenance === 'operator_supplied' ? ' <span class="dim">(you)</span>' : ''}${
      /^https?:/.test(e.source_url ?? '') ? ` <a href="${esc(e.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</li>`).join('')}</ul>`
    : '<p class="dim">Nothing on file beyond the title.</p>'}`;
  };
  const pastedLine = (p) => { const x = pastedQ.get(p.person_id);
    return x?.at ? `<p class="meta"><span class="vd write">&#10003; profile pasted ${esc(String(x.at).slice(0, 10))}</span>${
      /^https?:/.test(x.source_url ?? '') ? ` · <a href="${esc(x.source_url)}" target="_blank" rel="noopener">the profile</a>` : ''}</p>` : ''; };
  const blindCard = ({ p, pick }) => `<article class="card" id="r-${esc(p.person_id)}">
  <header><h3>${esc(p.name)} <span class="title">${esc(p.title ?? '')}</span></h3></header>
  <p class="meta">${esc(p.org_name ?? '')} · ${facts(pick)}</p>
  ${whatTheyDo(p)}
  ${pastedLine(p)}
  ${blindFacts(p)}
  <p class="lookup">${copyLine(p.name, p.org_name)} ${searchLink(p.name, p.org_name, p.profile_url)} ·
    <a href="index.html#p-${esc(p.person_id)}">full card, if they are on the main list</a></p>
  ${pastedQ.get(p.person_id)?.at ? pasteBox(p).replace('<b>Paste a profile</b>', '<b>Paste again</b>') : pasteBox(p)}
  ${verdictBox(p, null, { blind: true })}
</article>`;
  // THE NOTE BOX, SAME AS THE OLD CARDS: draft, revise by instruction, record
  // what was sent. An address on file makes Email the default channel, because
  // email costs nothing and an InMail spends a credit.
  const draftsOf = (d.backstory ?? d).draftsByPerson;
  // The fields the reach advice reads, fresh from the book (a paste may have added them).
  const reachQ = db.prepare('SELECT email, email_guess, degree, profile_url, platform_activity, prior_relationship FROM people WHERE id = ?');
  const pFull = (p) => ({ ...p, ...(reachQ.get(p.person_id) ?? {}) });
  // THE CHANNEL TEST (channel-test.mjs): a person assigned the email arm gets
  // Email as the box's default and a line saying why; the LinkedIn arm keeps the
  // usual advice. Either way the operator chooses, and what he sends is counted.
  const testLine = (p) => {
    const arm = armOf(db, p.person_id);
    if (!arm) return '';
    return `<p class="meta"><b>Channel test: ${arm === 'email' ? 'send by email' : 'send on LinkedIn'}</b>
      <span class="dim">(people rated 4+ with an address alternate between the two, so the reply rates compare like with like)</span></p>`;
  };
  const readyNote = (p) => {
    const latest = draftsOf?.get(p.person_id)?.[0] ?? null;
    const { email, email_guess: guess } = db.prepare('SELECT email, email_guess FROM people WHERE id = ?').get(p.person_id) ?? {};
    const usual = reachOptions(pFull(p), d).find((x) => x.channel && x.channel !== 'email')?.channel
      ?? reachOptions(pFull(p), d).find((x) => x.channel)?.channel ?? 'linkedin_inmail';
    const arm = armOf(db, p.person_id);
    const channel = arm === 'email' && (email || guess) ? 'email'
      : arm === 'linkedin' ? usual
      : reachOptions(pFull(p), d).find((x) => x.channel)?.channel ?? 'linkedin_inmail';
    return noteBox(p, latest, { channel, email, guess });
  };
  // THE SAME FILTER ATTRIBUTES AS ON ALL PROSPECTS, so a target, offer or
  // geography chip narrows the day's cards in place.
  const firmOf = new Map((d.shortlist ?? []).map((x) => [x.person_id, x.firm]));
  const orgFirm = new Map((d.firms ?? []).map((f) => [f.org_id, f]));
  const svcOf = (p) => d.offerId((firmOf.get(p.person_id) ?? orgFirm.get(p.org_id))?.package_id ?? 'none');
  const readyAxes = (p) => ` data-sectors="${esc(d.tgt.of(p.person_id, p.org_id).join(','))}"`
    + ` data-service="${esc(svcOf(p))}" data-geo="${esc(p.geo_bucket ?? 'unknown')}" data-call="${callOf(d, p.person_id)}" data-owner="${ownerOf(d, p.person_id)}" data-pasted="${pastedOf(d, p.person_id)}"`;
  // The chips' counts on this page are of this page's cards; what was sent and
  // replied stays the whole record, since a segment's history is the same.
  d.readyCounts = (all) => {
    const out = { sectors: {}, service: {}, geo: {}, call: {} };
    for (const { p } of cards) {
      const put = (axis, v) => { const c = (out[axis][v] ??= { people: new Set(), firms: new Set() });
        c.people.add(p.person_id); c.firms.add(p.org_id); };
      for (const t of d.tgt.of(p.person_id, p.org_id)) put('sectors', t);
      put('service', svcOf(p)); put('geo', p.geo_bucket ?? 'unknown'); put('call', callOf(d, p.person_id));
    }
    const res = {};
    for (const axis of Object.keys(all)) {
      if (!out[axis]) { res[axis] = all[axis]; continue; }
      res[axis] = Object.fromEntries([...new Set([...Object.keys(all[axis]), ...Object.keys(out[axis])])].map((v) =>
        [v, { people: out[axis][v]?.people.size ?? 0, firms: out[axis][v]?.firms.size ?? 0,
          sent: all[axis][v]?.sent ?? 0, replied: all[axis][v]?.replied ?? 0 }]));
    }
    return res;
  };
  const card = ({ p, pick, verdict, rating, spread }) => {
    const ranker = listPos.has(p.person_id) ? `the current list has them #${listPos.get(p.person_id)}`
      : blockedIds.has(p.person_id) ? 'the current list has them blocked' : 'not on the current list';
    const mine = decided({ p, pick });
    const yours = mine ? (mine.first ? 'write first' : mine.verdict === 'write' ? 'would write' : 'wouldn\'t') : '';
    const match = mine ? `<span class="dim">you: ${yours}</span>` : '';
    return `<article class="card" id="r-${esc(p.person_id)}" data-name="${esc(p.name)}"${readyAxes(p)}>
  <header><h3><span class="rank rating ${rating >= 3 ? '' : 'flag'}">judge: ${rating}/5${
      spread >= 2 ? ' ±' : ''}</span> ${esc(p.name)}
    <span class="title">${esc(p.title ?? '')}</span></h3></header>
  <p class="meta">${esc(p.org_name ?? '')} · ${esc(ranker)} ${match}</p>
  ${whatTheyDo(p)}
  <p><b>${cited(pick.reason)}</b></p>
  <p class="meta">Need <b>${esc(pick.need)}</b> · Owner <b>${esc(pick.owner)}</b>${
      pick.better_recipient ? ` (→ ${esc(pick.better_recipient)})` : ''} · Value <b>${esc(pick.value)}</b> ·
    ${facts(pick)}</p>
  <details><summary>Why, in full</summary><ul>
    <li>Need: ${cited(pick.need_why)}</li><li>Owner: ${cited(pick.owner_why)}</li>
    <li>Value: ${cited(pick.value_why)}</li>${pick.against_example
      ? `<li>Against the examples: ${cited(pick.against_example)}</li>` : ''}</ul></details>
  <p class="lookup">${copyLine(p.name, p.org_name)} ${searchLink(p.name, p.org_name, p.profile_url)}</p>
  ${reachLine(pFull(p), d)}
  ${testLine(p)}
  ${pastedQ.get(p.person_id)?.at ? pasteBox(p).replace('<b>Paste a profile</b>', '<b>Paste again</b>') : pasteBox(p)}
  ${verdictBox(p, mine)}
  ${readyNote(p)}
</article>`;
  };
  // ONE NOTE PER FIRM. Two people at one firm both came up to write, and he
  // writes to one. Blind cards are grouped by firm in a neutral order (the
  // judge's preference between them would leak its ratings); decided ones show
  // the highest-rated person per firm with the colleagues folded under them.
  // WHICHEVER THE SCOREBOARD FAVOURS ORDERS THE PAGE. The judge did from
  // 2026-09-26, when it put the operator's writes above his skips 0.86 of the
  // time against the ranker's 0.61. By 2026-10-02, on 69 blind calls, it was
  // the ranker 0.73 to the judge's 0.63, and the ranker held 4 of his 7 Write
  // first picks in its top five to the judge's 3. CLAUDE.md: ranking changes
  // go through his verdicts and the Scoreboard decides, so the page follows
  // it. The judge still decides who is on the page (3+), who is judged in full
  // and who is drafted; both are still scored on every call. Set ORDER to
  // 'judge' to go back. BLIND = true is neutral order with ratings hidden.
  const BLIND = false;
  const ORDER = 'ranker';
  const firmBest = new Map();
  for (const c of cards.filter((x) => !decided(x))) {
    firmBest.set(c.p.org_id, Math.max(firmBest.get(c.p.org_id) ?? 0, c.rating));
  }
  const byJudge = (a, b) => (firmBest.get(b.p.org_id) - firmBest.get(a.p.org_id))
    || String(a.p.org_id).localeCompare(String(b.p.org_id))
    || b.rating - a.rating || Number(b.pick.value) - Number(a.pick.value)
    || (a.pick.timing_days ?? 9e9) - (b.pick.timing_days ?? 9e9);
  // The ranker's order AS THE SCOREBOARD SCORES IT: each person's latest score
  // among all live people, blockers or not (verdicts.rank_then, lead.mjs). The
  // writable list leaves out anyone with a blocker, which on this page is
  // nearly everyone. Firms kept together under their best-placed person; anyone
  // the ranker has not scored goes last, in the judge's order.
  const rankTotal = new Map(db.prepare(`SELECT s.person_id, s.total FROM person_scores s
      WHERE s.id = (SELECT MAX(id) FROM person_scores x WHERE x.person_id = s.person_id)`).all()
    .map((r) => [r.person_id, r.total]));
  const pos = (c) => (rankTotal.has(c.p.person_id) ? -rankTotal.get(c.p.person_id) : Infinity);
  const firmPos = new Map();
  for (const c of cards.filter((x) => !decided(x))) {
    firmPos.set(c.p.org_id, Math.min(firmPos.get(c.p.org_id) ?? Infinity, pos(c)));
  }
  const byRanker = (a, b) => {
    const fa = firmPos.get(a.p.org_id) ?? Infinity; const fb = firmPos.get(b.p.org_id) ?? Infinity;
    if (fa !== fb) return fa === Infinity ? 1 : fb === Infinity ? -1 : fa - fb;
    if (fa === Infinity) return byJudge(a, b);
    return String(a.p.org_id).localeCompare(String(b.p.org_id))
      || (pos(a) === pos(b) ? 0 : pos(a) === Infinity ? 1 : pos(b) === Infinity ? -1 : pos(a) - pos(b))
      || b.rating - a.rating;
  };
  // ONLY 3 AND ABOVE (2026-09-27). Judging the backlog put 110 undecided cards
  // here, 70 of them rated 1 or 2; the day's list is the ones worth a note.
  // The rest stay on All prospects, in the judge's order.
  const MIN_RATING = 3;
  const below = cards.filter((c) => !decided(c) && c.rating < MIN_RATING).length;
  const open = cards.filter((c) => !decided(c) && c.rating >= MIN_RATING).sort(BLIND
    ? (a, b) => hash(a.p.org_id) - hash(b.p.org_id) || String(a.p.name).localeCompare(String(b.p.name))
    : ORDER === 'ranker' ? byRanker : byJudge);
  // An undecided card, rated: the judge's call and reasons, the evidence, and the
  // paste box, so a profile can still be pasted before deciding.
  // Every Ready card carries the paste box now (card() adds it), decided or not:
  // the To paste shortcut lists decided cards too, and one had no box to paste into.
  const openCard = (c) => card(c).replace(/(<p class="lookup">)/, `${pastedLine(c.p)}${blindFacts(c.p)}$1`);
  const perFirm = new Map();
  for (const c of open) perFirm.set(c.p.org_id, (perFirm.get(c.p.org_id) ?? 0) + 1);
  const blindList = open.map((c, i) => {
    const n = perFirm.get(c.p.org_id);
    const lead = n > 1 && (i === 0 || open[i - 1].p.org_id !== c.p.org_id)
      ? `<p class="lead"><b>${n} people at ${esc(c.p.org_name ?? '')}</b>: you would write to one of them.</p>` : '';
    return lead + (BLIND ? blindCard(c) : openCard(c));
  }).join('');
  const doneAll = cards.filter((c) => decided(c))
    .sort((a, b) => b.rating - a.rating || Number(b.pick.value) - Number(a.pick.value)
      || (a.pick.timing_days ?? 9e9) - (b.pick.timing_days ?? 9e9));
  const done = [];
  const alsoAt = new Map();
  for (const c of doneAll) {
    if (!alsoAt.has(c.p.org_id)) { alsoAt.set(c.p.org_id, []); done.push(c); }
    else alsoAt.get(c.p.org_id).push(c);
  }
  const withColleagues = (c) => {
    const rest = alsoAt.get(c.p.org_id) ?? [];
    return card(c) + (rest.length ? `<p class="meta" style="margin:-6px 0 14px 12px">Also at ${esc(c.p.org_name ?? '')}: ${
      rest.map((x) => `${esc(x.p.name)} (judge ${x.rating}/5)`).join(', ')}</p>` : '');
  };
  return intro + pastePanel(db)
    + `<section class="panel"><h2>${open.length} to decide${BLIND ? ', blind' : ', best first'}</h2>
<p class="lead">${BLIND ? 'The judge has rated these 1 to 5; its rating stays hidden until you click, and the order here is neutral, so your answer is yours.'
  : ORDER === 'ranker'
    ? 'Ordered by the ranking formula, which the Scoreboard currently favours; anyone it does not list comes after, in the judge\'s order. People at one firm are kept together, best first.'
    : 'Ordered by the judge: its 1-to-5 rating, then value, then how fresh the reason is. People at one firm are kept together, best first.'}
<b>Write first</b> is for the few you would send before the rest; paste a profile first for anyone worth a closer look.</p>
${below ? `<p class="lead dim">${below} more the judge rated 1 or 2 are on <a href="index.html">All prospects</a>.</p>` : ''}
${blindList || '<p class="callout">Nothing waiting. Run <code>npm run judge -- --queue</code> for more.</p>'}</section>`
    + (done.length ? `<section class="panel"><details><summary><b>${doneAll.length} decided</b> at `
      + `${done.length} firms, highest-rated first</summary>${done.map(withColleagues).join('')}</details></section>` : '');
}

// SEARCHES, down the funnel (measures.mjs, shared with `queries --yield`).
function searchesPage(db) {
  const rows = searchFunnel(db);
  if (!rows.length) return '<section class="panel"><p class="callout">No search list yet. Run <code>npm run queries -- --adopt</code>.</p></section>';
  const act = rows.filter((r) => r.status === 'active');
  const tr = (r) => `<tr${r.status === 'retired' ? ' class="dim"' : ''}><td>${r.runs}</td><td>${r.found}</td><td>${r.alive}</td>
    <td>${r.rated}</td><td><b>${r.wrote}</b></td><td>${r.sent}</td><td>${r.replied}</td><td>${esc(r.origin)}</td>
    <td>${r.status === 'retired' ? `[retired] ` : ''}${esc(r.query)}${r.target ? `<br><span class="dim">${esc(r.target)}</span>` : ''}</td></tr>`;
  return `<section class="panel"><h2>What each search is worth</h2>
<p class="lead">${act.length} active, ${rows.length - act.length} retired. Finding firms is the top of the funnel; a search is
worth how far its finds get: vetted and alive, rated 4 or 5 by the judge, your call to write, a note sent,
a reply. A search that finds nothing in two runs in a row is retired, with the reason kept. Runs weekly
from <code>npm run daily</code>.</p>
<table><thead><tr><th>runs</th><th>firms</th><th>alive</th><th>rated 4+</th><th>you write</th><th>sent</th>
<th>replied</th><th>origin</th><th>search</th></tr></thead><tbody>${rows.map(tr).join('')}</tbody></table></section>`;
}

// SPEND: what the project has spent on AI, from `runs` (measures.mjs). Charts
// follow the dataviz method: one series each, so one colour and no legend (the
// title names it); one axis per chart, cumulative and daily kept apart; the
// accent validated against each surface (#3b5ba9 light, #6f8cdb dark); hover on
// every mark; and the tables below are the readable version of both.
function spendPage(db) {
  const s = spend(db);
  const usd = (x) => `$${Number(x ?? 0).toFixed(2)}`;
  const k = (x) => (x == null ? '—' : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(x));
  const perDay = s.daily.length ? s.total / s.daily.length : 0;
  const html = `<section class="panel"><h2>AI spend for this project</h2>
<div class="tiles">
${tile({ label: 'Today', value: usd(s.today.usd), sub: `${s.today.runs} runs · ${s.today.credits} search credits · as of ${s.today.asOf}`, state: 'none' })}
${tile({ label: 'Last 7 days', value: usd(s.week), sub: `about ${usd(s.week / 7)} a day`, state: 'none' })}
${tile({ label: `This month (${s.month.label})`, value: usd(s.month.usd), sub: `${s.month.credits} search credits`, state: 'none' })}
${tile({ label: 'All time', value: usd(s.total), sub: `since ${s.since} · ${s.runs.toLocaleString('en-US')} runs`, state: 'none' })}
${tile({ label: 'Search credits, all time', value: String(s.credits), sub: 'counted, not dollars', state: 'none' })}
</div>
<p class="lead">Every model call records its model, tokens and cost in <code>runs</code> as it happens. That covers the
pipeline's own calls; the Claude Code sessions used to build it are billed separately and are not here.
Averages ${usd(perDay)} over ${s.daily.length} days with any spend.</p></section>
<section class="panel"><h2>Cumulative spend</h2><div id="c-cum" style="height:280px"></div></section>
<section class="panel"><h2>Spend per day</h2><div id="c-day" style="height:240px"></div></section>
<section class="panel"><h2>Where it goes, by stage</h2><div id="c-stage" style="height:${60 + 26 * s.byStage.length}px"></div>
<p class="dim">Tokens are counted per call from 2026-10-01; cost covers every run since the start.</p>
<table><thead><tr><th>stage</th><th class="num">runs</th><th class="num">tokens in</th><th class="num">tokens out</th><th class="num">cost</th></tr></thead>
<tbody>${s.stages.map((r) => `<tr><td><code>${esc(r.stage)}</code></td><td class="num">${r.runs}</td><td class="num">${k(r.n_in)}</td>
<td class="num">${k(r.n_out)}</td><td class="num">${usd(r.usd)}</td></tr>`).join('')}</tbody></table></section>
<section class="panel"><h2>By model</h2>
<table><thead><tr><th>model</th><th class="num">runs</th><th class="num">tokens in</th><th class="num">tokens out</th><th class="num">cost</th></tr></thead>
<tbody>${s.models.map((r) => `<tr><td><code>${esc(r.model)}</code></td><td class="num">${r.runs}</td><td class="num">${k(r.n_in)}</td>
<td class="num">${k(r.n_out)}</td><td class="num">${usd(r.usd)}</td></tr>`).join('')}</tbody></table>
<details><summary>Every day, as a table</summary><table><thead><tr><th>day</th><th class="num">spent</th>
<th class="num">running total</th><th class="num">search credits</th></tr></thead><tbody>${s.daily.map((d, i) =>
  `<tr><td>${esc(d.day)}</td><td class="num">${usd(d.usd)}</td><td class="num">${usd(s.cumulative[i].usd)}</td>
<td class="num">${d.credits || ''}</td></tr>`).reverse().join('')}</tbody></table></details></section>`;
  const byStage = [...s.byStage].reverse();
  const script = `
const ink = dark ? '#6f8cdb' : '#3b5ba9';
Plotly.newPlot('c-cum', [{ type:'scatter', mode:'lines', x:${JSON.stringify(s.cumulative.map((d) => d.day))},
  y:${JSON.stringify(s.cumulative.map((d) => d.usd))}, line:{color:ink, width:2},
  hovertemplate:'%{x}<br>$%{y:.2f} to date<extra></extra>' }],
  layoutFor({margin:{l:56,r:24,t:10,b:38}, hovermode:'x', yaxis:{tickprefix:'$', gridcolor: dark?'#33322f':'#e6e5e1', rangemode:'tozero'},
    xaxis:{gridcolor:'rgba(0,0,0,0)', showspikes:true, spikemode:'across', spikethickness:1, spikecolor: dark?'#555':'#bbb'}}),
  {displayModeBar:false,responsive:true});
Plotly.newPlot('c-day', [{ type:'bar', x:${JSON.stringify(s.daily.map((d) => d.day))},
  y:${JSON.stringify(s.daily.map((d) => d.usd))}, marker:{color:ink},
  hovertemplate:'%{x}<br>$%{y:.2f}<extra></extra>' }],
  layoutFor({margin:{l:56,r:24,t:10,b:38}, bargap:0.15, yaxis:{tickprefix:'$', gridcolor: dark?'#33322f':'#e6e5e1'},
    xaxis:{gridcolor:'rgba(0,0,0,0)'}}),
  {displayModeBar:false,responsive:true});
Plotly.newPlot('c-stage', [{ type:'bar', orientation:'h', y:${JSON.stringify(byStage.map((r) => r.stage))},
  x:${JSON.stringify(byStage.map((r) => r.usd))}, marker:{color:ink},
  text:${JSON.stringify(byStage.map((r) => `$${r.usd.toFixed(2)}`))}, textposition:'outside', cliponaxis:false,
  textfont:{color: dark ? '#c3c2b7' : '#52514e'},
  hovertemplate:'%{y}: $%{x:.2f}<extra></extra>' }],
  layoutFor({margin:{l:150,r:60,t:6,b:30}, bargap:0.25, xaxis:{tickprefix:'$', gridcolor: dark?'#33322f':'#e6e5e1'}}),
  {displayModeBar:false,responsive:true});`;
  return { html, script };
}

// SCOREBOARD: the judge against the old ranker (measures.mjs, shared with
// `judge --scoreboard`).
// PASTE THESE TODAY: the few strongest people whose seat is in doubt
// (funnel.mjs pasteQueue). Each links to
// its card below, where the paste box and the profile search are.
function pastePanel(db) {
  const q = pasteQueue(db);
  if (!q.length) {
    return '<section class="panel"><h2>Profiles to paste</h2><p class="lead">None. Everyone rated 3+ '
      + 'whose seat is in doubt has a profile on file. Draft the rest straight from their cards.</p></section>';
  }
  return `<section class="panel"><h2>Profiles to paste today: ${q.length}</h2>
<p class="lead">Rated 3+ on a title alone, or on a seat the judge doubts owns the work, with no profile
on file. The profile settles whether they are the right person. Anyone rated on a dated event can be
drafted without one; paste theirs when you open it to send, if it shows something.</p>
<ol>${q.map((p) => `<li><a href="#r-${esc(p.person_id)}">${esc(p.name)}</a> · ${p.rating}/5 ·
  ${esc(p.title ?? '')}, ${esc(p.org_name ?? p.org_id)}</li>`).join('')}</ol></section>`;
}

// THE FUNNEL, added 2026-10-02: the operator's two daily goals as numbers.
// Counts come from funnel.mjs, computed from the book with no model.
function funnelPage(db, cfg) {
  const goals = cfg.daily_goals ?? {};
  const days = funnelDays(db, 14);
  const week = days.slice(0, 7);
  const avg = (k) => (week.reduce((a, d) => a + d[k], 0) / week.length).toFixed(1);
  const goal = (v, g) => (g ? `${v} <span class="dim">of ${g}</span>` : String(v));
  const cols = [['found', 'found'], ['screened', 'screened'], ['judged', 'judged'], ['strong', 'rated 3+'],
    ['writable', 'writable now'], ['pasted', 'profile pasted'], ['drafted', 'drafted'],
    ['clean', 'draft passed grading'], ['sent', 'sent'], ['accepted', 'connection accepted'], ['replied', 'replied']];
  const src = sourceYield(db, 30);
  return `<section class="panel"><h2>The two daily goals</h2>
<table><thead><tr><th></th><th>today</th><th>7-day average</th><th>goal</th></tr></thead><tbody>
<tr><td>People judged that day and rated 3+</td><td>${days[0].strong}</td><td>${avg('strong')}</td><td>${goals.strong_prospects ?? '—'}</td></tr>
<tr><td>Notes sent</td><td>${days[0].sent}</td><td>${avg('sent')}</td><td>${goals.notes_sent ?? '—'}</td></tr>
</tbody></table>
<p class="dim">Goals are <code>daily_goals</code> in config/me.yml.</p></section>
<section class="panel"><h2>Each stage, by day</h2>
<p class="lead">How many people reached each stage on each day. <b>Rated 3+</b> and <b>writable now</b>
count the people judged that day by where they stand today: writable means a note could still go to
them (not written to, an offer fits, not recruiting for the skill sold).</p>
<table><thead><tr><th>day</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
${days.map((d) => `<tr><td>${esc(d.day)}</td>${cols.map(([k]) => `<td>${
    k === 'strong' ? goal(d[k], goals.strong_prospects) : k === 'sent' ? goal(d[k], goals.notes_sent) : d[k]}</td>`).join('')}</tr>`).join('')}
</tbody></table></section>
<section class="panel"><h2>What each source yields</h2>
<p class="lead">People first found in the last 30 days, by where they were first found, and how far
each source's people got. A source that finds many and rates few is costing judging time.</p>
<table><thead><tr><th>source</th><th>found</th><th>judged</th><th>rated 3+</th><th>writable now</th><th>sent</th><th>accepted</th><th>replied</th></tr></thead><tbody>
${src.map((r) => `<tr><td>${esc(r.source)}</td><td>${r.found}</td><td>${r.judged}</td><td>${r.strong}</td>
  <td>${r.writable}</td><td>${r.sent}</td><td>${r.accepted}</td><td>${r.replied}</td></tr>`).join('')}
</tbody></table></section>`;
}

function scoreboardPage(db) {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'judgments'`).get();
  if (!has) return '<section class="panel"><p class="callout">Nothing judged yet.</p></section>';
  const sb = scoreboard(db);
  const f2 = (x) => (x == null ? 'n/a' : x.toFixed(2));
  const row = (label, x) => `<tr><td>${label}</td><td>${x.calls} (${x.writes} write)</td><td>${x.agreed} of ${x.calls}</td>
    <td><b>${f2(x.judge)}</b></td><td>${f2(x.ranker)}</td></tr>`;
  return `<section class="panel"><h2>Is the judge holding up?</h2>
<p class="lead">The Ready page is ordered by whichever of the two scores better here. The check: are
your <b>Write first</b> picks near the top of each one's list? The judge's rating and the ranker's
position are stored with every call, so both are scored the same way.</p>
<p class="lead"><b>Your Write first picks in the top ${sb.topK} of their day:</b>
${sb.firsts ? `judge ${sb.judgeFirsts} of ${sb.firsts} · old ranker ${sb.rankerFirsts} of ${sb.firsts}` : 'none yet. Mark your top one or two each day Write first.'}</p>
${sb.days.length ? `<ul>${sb.days.map((d) => `<li>${esc(d.day)}: ${d.cards} cards, ${d.firsts} write first,
  judge top ${sb.topK} held ${d.judge}, ranker top ${sb.topK} held ${d.ranker}</li>`).join('')}</ul>` : ''}</section>
<section class="panel"><h2>Writes above skips</h2>
<p class="lead">Over every pair of a person you would write to and one you would skip, how often each puts
the write above the skip. 1.00 is perfect, 0.50 a coin. Blind calls were made before seeing the judge's rating.</p>
<table><thead><tr><th></th><th>calls</th><th>judge agreed</th><th>judge</th><th>old ranker</th></tr></thead>
<tbody>${row('all your calls since each judgment', sb.forward)}${row('blind calls only', sb.blind)}</tbody></table>
<p class="dim">Changed your mind after seeing the judge: ${sb.changed}.</p></section>
${draftArmsPanel(db)}
${channelPanel(db)}`;
}

// EMAIL OR LINKEDIN? (channel-test.mjs, 2026-10-08.) Replies only on sends old
// enough to have had one; bounces apart, since a note that never arrived says
// nothing about the channel. The test rows are the people assigned an arm, so
// the two columns compare like with like; the record rows are everything, which
// is not a fair comparison and is shown only for scale.
function channelPanel(db) {
  let cfg = null;
  try { cfg = loadConfig(); } catch { /* no config: count every row */ }
  const r = channelResults(db, { notSales: cfg ? notSalesSql(cfg, 'o.service_pitched') : undefined });
  const pct = (x) => (x.mature ? `${Math.round((100 * x.replied) / x.mature)}%` : '—');
  const row = (label, x) => `<tr><td>${label}</td><td>${x.sent}</td><td>${x.mature}</td><td>${x.replied}</td>
    <td><b>${pct(x)}</b></td><td>${x.bounced}</td></tr>`;
  return `<section class="panel"><h2>Email or LinkedIn?</h2>
<p class="lead">People rated 4+ with an address alternate between the two, and the card says which.
Replies are counted on sends at least ${r.matureDays} days old. With reply rates in single digits,
about thirty a side shows a large difference and no small one.</p>
<table><thead><tr><th></th><th>sent</th><th>${r.matureDays}+ days old</th><th>replied</th><th>rate</th><th>bounced</th></tr></thead>
<tbody>${row('<b>Test</b>: email', r.test.email)}${row('<b>Test</b>: LinkedIn', r.test.linkedin)}
${row('Whole record: email', r.all.email)}${row('Whole record: LinkedIn', r.all.linkedin)}</tbody></table>
<p class="dim">The whole record is not a fair comparison: email went where an address happened to be on file.</p></section>`;
}

// FIXED EXAMPLES OR PICKED ONES? New drafts alternate between the hand-picked
// notes in voice.md and notes chosen for each recipient from what was sent
// (src/voice-examples.mjs). Less changing before a note goes out is better.
function draftArmsPanel(db) {
  const arms = draftArms(db);
  if (!arms.length) return '';
  const label = { before: 'before the comparison (fixed set)', fixed: 'fixed examples', picked: 'sent notes picked for the recipient', edits: 'your edits on similar notes', recent_v1: 'your latest notes, until 2026-10-09 (a long ask dropped the note)', recent: 'your latest notes, with what they were written from' };
  const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
  return `<section class="panel"><h2>Is drafting learning from you?</h2>
<p class="lead">New drafts alternate between the fixed example notes in <code>voice.md</code> and your latest
sent notes on the same channel, each shown with what it was written from, the drafter's reasoning, what you
asked to change and what you sent. Less changing before a note goes out is better. About 25 sent notes per
arm are needed before a gap means anything.</p>
<table><thead><tr><th></th><th>drafted</th><th>sent</th><th>words changed (median)</th>
<th>sent as drafted</th><th>revisions per sent note</th></tr></thead><tbody>
${arms.map((a) => `<tr><td>${label[a.arm]}</td><td>${a.drafted}</td><td>${a.sent}</td><td><b>${pct(a.changed)}</b></td>
  <td>${a.unchanged} of ${a.sent}</td><td>${a.revisionsPerSent == null ? 'n/a' : a.revisionsPerSent.toFixed(1)}</td></tr>`).join('')}
</tbody></table></section>`;
}

// WOULD YOU WRITE TO THEM? Added 2026-09-25. Nothing reads these yet: they are
// the evidence for deciding, later and with numbers, whether the ranker's
// weights agree with the operator or should give way to examples of his own
// calls. One click and an optional reason; the rank at that moment is stored
// with it. The latest call shows on the card so a second click is a change of
// mind, not a duplicate.
function verdictBox(p, latest, { blind = false } = {}) {
  const id = esc(p.person_id);
  const shown = latest
    ? `<span class="vd ${latest.verdict}">${latest.first ? 'You would write FIRST'
        : latest.verdict === 'write' ? 'You would write' : 'You would not write'}`
      + `${latest.reason ? `: ${esc(latest.reason)}` : ''}</span>`
      + (latest.rank_then ? ` <span class="dim">(ranked #${latest.rank_then} then)</span>` : '')
    : '<span class="dim">Would you write to them?</span>';
  return `<form method="post" action="${SERVER}/verdict" class="verdict">
      <input type="hidden" name="person" value="${id}">
      <input type="hidden" name="back" value="">
      ${blind ? '<input type="hidden" name="source" value="blind">' : ''}
      ${shown}
      <input type="text" name="why" size="34" placeholder="why, in a few words">
      <button type="submit" name="verdict" value="first">Write first</button>
      <button type="submit" name="verdict" value="write">Would write</button>
      <button type="submit" name="verdict" value="skip">Wouldn't</button>
    </form>`;
}

function pasteBox(p) {
  const id = esc(p.person_id);
  return `<details class="pastebox"><summary><b>Paste a profile</b> — it is the only
    input that changes this score</summary>
    <form method="post" action="${SERVER}/paste" class="pb">
      <input type="hidden" name="person" value="${id}">
      <input type="hidden" name="back" value="">
      <textarea name="text" rows="6" placeholder="Paste the whole LinkedIn page here, chrome and all."></textarea>
      <div class="pbrow"><input type="text" name="url" size="44"
        placeholder="profile URL from the address bar (optional, but it counts)">
        <button type="submit">Go</button></div>
      <p class="pbnote">Paste and press Go — connection degree, follower count, location and how
        active they are are all read out of the text. A select-all copy leaves out the address
        bar, so put the profile URL in the box beside Go: rank counts a profile on file as a
        way to reach them, and the card then links straight to it. Nothing fetches
        linkedin.com. Needs <code>npm run inbox</code> running, and this page opened from
        <code>127.0.0.1:8787</code> rather than from disk.</p>
    </form></details>`;
}


// THE NOTE, ON THE CARD, EDITABLE. The operator, 2026-09-24: "add a box or a
// triangle to the cards that, when expanded or triggered by the user, whould
// auto-draft a note to that person... I can revise the words or request a
// change like change 'such and such' to something like 'this and that'. i then
// press the go button and this solution would revise the note accordingly. in
// other words, move the note editing out of the CC commandline and into the db.
// also include a Sent button so this solution can track what was actually send."
//
// Three actions, all posting to the local inbox server:
//   Draft   — writes a first version, or another one
//   Revise  — an instruction in his words; the stage writes version N+1 and
//             never touches the one it came from, so the sequence stays a
//             record of what was asked for and what that produced
//   Sent    — records the textarea EXACTLY AS IT STANDS, which is the point:
//             the gap between what was drafted and what he actually sent is
//             what the design calls the highest-value signal in the book, and it
//             only exists if the thing recorded is his text and not the model's.
// THE GRADER'S VERDICT ON THE DRAFT IN THE BOX, added 2026-10-01 when the
// daily run began drafting ten notes a morning. The drafter's own check asks
// only whether each fact is on file, and a note can be all true and still
// hand the reader his own post back, or point at "those tools" it never
// named. `npm run grade` reads for that; this puts its answer where the
// operator edits, quoting the words that failed.
const GRADES = new Map();
const GRADE_DIMS = [['claims', 'claim not on file'], ['recital', 'recites their own facts'],
  ['never_claim', 'never-claim'], ['channel_rules', 'channel rule'], ['clarity', 'unclear'], ['fits_channel', 'too long']];
function gradeLine(draft) {
  const g = draft?.id ? GRADES.get(draft.id) : null;
  if (!g) return { mark: '', html: '' };
  if (g.clean === 1) return { mark: ' <span class="dim">· checked ✔</span>', html: '' };
  const items = [];
  for (const [dim, label] of GRADE_DIMS) {
    if (g[dim] !== 0) continue;
    let list = [];
    try { list = JSON.parse(g[`${dim}_items`] ?? '[]'); } catch { /* stored by an older pass */ }
    if (!list.length) items.push(`<li><b>${esc(label)}</b></li>`);
    for (const it of list) items.push(`<li><b>${esc(label)}:</b> &ldquo;${esc(it.quote)}&rdquo; <span class="dim">— ${esc(it.why)}</span></li>`);
  }
  return { mark: ' <b class="gradefail">· check ✘</b>',
    html: `<div class="gradebox"><b>The grader flagged this draft</b> <span class="dim">(${esc(g.grader_model)}, ${
      esc(String(g.graded_at).slice(0, 10))})</span><ul>${items.join('')}</ul></div>` };
}

function noteBox(p, draft, { channel: preferred = null, email = null, guess = null } = {}) {
  const id = esc(p.person_id);
  // THE SENDABLE NOTE ONLY. The stored body is the model's whole reply — DRAFT,
  // then a NOTES section arguing with itself about what it left out. The
  // operator pressed Draft and got the reasoning in the edit box: "all i see
  // are notes". The notes are worth keeping and worth reading; they are not the
  // letter, and they must never be what the Sent button records.
  //
  // AND SOMETIMES THERE IS NO LETTER AT ALL. The stage refuses outright when the
  // rules kill a note — the case that surfaced this was a public body with a
  // live solicitation out, which the channel rules forbid approaching in any
  // wording. That is the guardrail working, and it has to READ as a refusal
  // rather than as a note that happens to be strange, or the operator edits an
  // explanation and sends it.
  const declined = draft?.body && isDeclined(draft.body);
  const body = esc(declined ? '' : (draft?.body ? noteOnly(draft.body) : ''));
  const subject = esc(draft?.subject ?? '');
  const svc = esc(draft?.package_id ?? p.service_id ?? '');
  const ch = draft?.channel ?? preferred ?? 'linkedin_inmail';
  const sel = (v, label) => `<option value="${v}"${ch === v ? ' selected' : ''}>${label}</option>`;
  // WHO IT GOES TO, when it is an email: the address on file, or the guessed one
  // marked as a guess, with a copy button for the mail client.
  const addr = email ?? p.email ?? null;
  const guessed = addr ? null : (guess ?? p.email_guess ?? null);
  const to = addr ? `<code>${esc(addr)}</code> <button type="button" class="copy" data-copy="${esc(addr)}">copy</button>`
    : guessed ? `<code>${esc(guessed)}</code> <button type="button" class="copy" data-copy="${esc(guessed)}">copy</button>
      <span class="dim">guessed from the firm's pattern, not confirmed</span>`
      : '<span class="dim">no address on file; paste the profile if it lists one</span>';
  return `<details class="notebox"><summary><b>Note</b>${draft
    ? (declined ? ` <b class="dim">— the stage declined to draft one</b>`
      : ` <span class="dim">v${esc(draft.version)}, ${esc(String(draft.created_at).slice(0, 10))}</span>${declined ? '' : gradeLine(draft).mark}`)
    : ' <span class="dim">— none yet</span>'}</summary>
    ${declined ? `<div class="nbdecl"><b>No note was written, and the reason is below.</b>
      A rule in the pitch definition or the channel rules stopped it. Read it before
      overriding — the box is empty on purpose.</div>` : ''}
    <form method="post" action="${SERVER}/note" class="nb">
      <input type="hidden" name="person" value="${id}">
      <input type="hidden" name="back" value="">
      <input type="hidden" name="service" value="${svc}">
      <div class="nbrow">
        <select name="channel">${sel('email', 'Email')}${sel('linkedin_inmail', 'InMail (also a free Open Profile message)')}${
          sel('linkedin_connect_note', 'Connection request note')}${sel('linkedin_message', 'Message to a 1st-degree connection')}</select>
        <input name="subject" placeholder="subject" value="${subject}">
      </div>
      <p class="nbto"${ch === 'email' ? '' : ' hidden'}>To: ${to}</p>
      ${declined ? '' : gradeLine(draft).html}
      <textarea name="body" rows="12" placeholder="No draft yet. Press Draft.">${body}</textarea>
      <p class="nbcount dim" data-max="${CONNECT_NOTE_MAX}"${ch === 'linkedin_connect_note' ? '' : ' hidden'}></p>
      ${draft?.body && (declined || noteOnly(draft.body) !== String(draft.body).trim())
        ? `<details class="nbwhy"${declined ? ' open' : ''}><summary class="dim">${
            declined ? 'why it declined' : 'why it wrote that'}</summary><pre>${
            esc(String(draft.body).split(/^NOTES\s*$/m)[1] ?? String(draft.body))}</pre></details>` : ''}
      <div class="nbrow">
        <input name="revise" placeholder="or say what to change — e.g. change &quot;senior AI capacity&quot; to &quot;an extra pair of hands&quot;">
        <button type="submit" name="do" value="revise">Go</button>
      </div>
      <div class="nbrow">
        <button type="submit" name="do" value="draft">${draft ? 'Draft again' : 'Draft'}</button>
        <button type="submit" name="do" value="sent" class="sent">Sent as ${esc(({ email: 'Email', linkedin_inmail: 'InMail', linkedin_connect_note: 'Connection note', linkedin_message: 'LinkedIn message' })[ch] ?? ch)}</button>
        ${ch === 'linkedin_inmail' ? '<label class="nbnote"><input type="checkbox" name="free" value="1"> free (Open Profile, no credit spent)</label>' : ''}
        <span class="nbnote">Sent records the box above exactly as it stands — edit it first.</span>
      </div>
    </form></details>`;
}


// HOW TO REACH THEM, cheapest and surest first (2026-09-27, at the operator's
// request: "spend them wisely"). A real address, then a message if already
// connected, then a connection request with a note at 2nd degree, then InMail,
// which spends a credit, then a guessed address, which can bounce or fail
// silently. Ordered by cost and certainty: the send record is too thin to rank
// channels by replies (1 of 31 InMails, 1 of 7 emails, 1 of 3 connection notes).
// TAILORED (2026-09-27, the operator: "should solution make tailored
// recommendations?"). What is on file decides: a real address first, a message
// if connected; then a card worth a credit (a Write first or a 4-5) gets an
// InMail, which lands, alerts by email, and is refunded on a reply; a weaker
// card is told to find a real address before anything else. A connection
// request leads only for someone who knows the operator; otherwise it is a
// fallback, since a stranger's request may never be accepted. Channels already tried on this person are
// skipped (never the same channel twice to a non-responder).
function reachOptions(p, d = null) {
  const inmailLeft = d?.inmailLeft ?? null;
  const tried = d?.triedChannels?.(p.person_id) ?? new Set();
  const j = d?.judgeOf?.(p.person_id);
  const call = d ? callOf(d, p.person_id) : 'none';
  const strong = call === 'first' || (j?.rating ?? 0) >= 4;
  const act = String(p.platform_activity ?? '').toLowerCase();
  const active = ['active', 'high'].includes(act);
  const quiet = ['dormant', 'low'].includes(act);
  const deg = String(p.degree ?? '');
  // Someone who knows the operator (a recorded prior relationship) recognises
  // the name, so a free connection request is not a stranger's cold ask.
  const knows = Boolean(String(p.prior_relationship ?? '').trim());
  const credits = inmailLeft == null ? 'spends a credit' : `spends 1 of your ${inmailLeft} credits`;
  const li = isProfile(p.profile_url);
  const canInMail = li && inmailLeft !== 0 && !tried.has('linkedin_inmail');
  const inmail = { channel: 'linkedin_inmail', text: 'InMail',
    why: `${credits}${quiet ? '; it also alerts them by email, which matters for someone rarely on LinkedIn' : ''}${
      strong ? '' : '; a borderline card, so weigh keeping the credit for a stronger one'}` };
  const connect = { channel: 'linkedin_connect_note',
    text: `a connection request with a note (up to ${CONNECT_NOTE_MAX} characters)`,
    why: knows ? 'free, and they know you, so it will be recognised'
      : `free, but a stranger's request may never be accepted${quiet ? '; rarely on LinkedIn' : ''}` };
  // THE OPERATOR'S RULE (2026-09-27): "if he is inmail worthy we should inmail,
  // if not then research his email." A one-line connection request from a
  // stranger has no evidence behind it (3 sent, 1 reply) and gates the pitch
  // behind an acceptance, so it is a fallback, never the lead, for anyone.
  const out = [];
  if (p.email && !tried.has('email')) out.push({ channel: 'email', text: 'email, free', addr: p.email, why: 'a real address, which reaches them wherever they are' });
  if (deg === '1' && !tried.has('linkedin_message')) out.push({ channel: 'linkedin_message', text: 'LinkedIn message, free', why: 'you are connected' });
  if (knows && deg !== '1' && li && !tried.has('linkedin_connect_note')) out.push(connect);
  if (strong) {
    if (canInMail) out.push(inmail);
  } else if (!p.email) {
    out.push({ channel: null, text: 'find a real address first',
      why: li ? 'check the Contact info on their LinkedIn profile, then paste the profile again'
        : 'find them on LinkedIn and paste the profile; its Contact info may list one' });
  }
  if (!p.email && p.email_guess && !tried.has('email')) {
    out.push({ channel: 'email', text: 'email to a guessed address', addr: p.email_guess,
      why: 'guessed from the firm\'s pattern; it may bounce, or fail silently' });
  }
  if (deg === '2' && li && !tried.has('linkedin_connect_note') && !out.includes(connect)) out.push(connect);
  if (!strong && canInMail) out.push(inmail);
  return out;
}
function reachLine(p, d = null) {
  const o = reachOptions(p, d);
  const tried = d?.triedChannels?.(p.person_id);
  const note = tried?.size ? ` <span class="dim">(already tried: ${esc([...tried].join(', ').replace(/linkedin_/g, ''))})</span>` : '';
  if (!o.length) {
    return `<p class="need"><b>Reach by:</b> no channel yet. Find them on LinkedIn and paste the profile.${note}</p>`;
  }
  // An address is shown where it is recommended, with a copy button.
  const addr = (x) => (x.addr ? ` <code>${esc(x.addr)}</code> <button type="button" class="copy" data-copy="${esc(x.addr)}">copy</button>` : '');
  return `<p class="need"><b>Reach by:</b> ${esc(o[0].text)}${addr(o[0])} <span class="dim">(${esc(o[0].why)})</span>${
    o[1] ? ` <span class="dim">&middot; else ${esc(o[1].text)}</span>${addr(o[1])} <span class="dim">(${esc(o[1].why)})</span>` : ''}${note}</p>`;
}

/** The operator's latest call on a person, as a filter value: first, write, skip or none. */
function callOf(d, personId) {
  const v = (d.backstory ?? d).verdictsByPerson?.get(personId);
  return !v ? 'none' : v.first ? 'first' : v.verdict === 'write' ? 'write' : 'skip';
}
const CALLS = [['first', 'Write first'], ['write', 'Would write'], ['skip', "Wouldn't"], ['none', 'Undecided']];

// WHO DECIDES (2026-09-27): the judge's Owner rating, a PERSON attribute that
// cuts across every target. "Owns" is the operator's "budget and authority to
// hire someone like me": an operating partner, a portfolio manager, a business
// head, wherever they sit. Measured from the evidence per person, not read off
// the title.
function ownerOf(d, personId) {
  const o = d.judgeOf?.(personId)?.pick?.owner;
  return ['owns', 'influences', 'no'].includes(o) ? o : 'none';
}
const OWNERS = [['owns', 'Owns the budget'], ['influences', 'Influences'], ['no', "Doesn't"], ['none', 'Not judged yet']];

// PROFILE PASTED OR NOT (2026-09-28): replaces the old ranker's "To paste"
// page. "Would write" + "Not pasted" is the paste worklist, and it combines
// with every other chip.
const pastedOf = (d, personId) => (d.pastedSet?.has(personId) ? 'yes' : 'no');
const PASTED = [['no', 'Not pasted'], ['yes', 'Pasted']];

/** The blocker lines that are channel rules rather than the ranker's scoring. */
function coolingLines(p) {
  return String(p.blockers ?? '').split('\n').filter((b) => /^The firm was contacted/.test(b.trim()));
}
function statusOfCard(p) {
  return p.lastSent ? 'in_flight' : coolingLines(p).length ? 'cooling' : 'open';
}

/** The judge's call on a card, the same fields Ready shows. */
function judgeBlock(j) {
  if (!j) return '<p class="meta dim">Not judged yet. The daily run judges people a few at a time; '
    + '<code>npm run judge -- --person &lt;id&gt;</code> does one now.</p>';
  const k = j.pick;
  return `<p><b>${esc(k.reason ?? '')}</b></p>
      <p class="meta">Need <b>${esc(k.need ?? '')}</b> · Owner <b>${esc(k.owner ?? '')}</b>${
        k.better_recipient ? ` (→ ${esc(k.better_recipient)})` : ''} · Value <b>${esc(k.value ?? '')}</b> · ${
        k.timing_days == null ? 'no dated event' : `${k.timing_days} days since ${esc(k.timing_what ?? '')}`} · ${
        esc(k.reach ?? '')}</p>`;
}

/** One card per prospect. */
/**
 * What you are selling, shown when you pick it. The dedicated service page has
 * carried this block since it was written -- price, duration, who it is for,
 * which seats buy it -- and the filter chip that replaced it as the way in
 * carried none of it. Picking "Pilot management" narrowed the list and never
 * said what pilot management is or what it costs, which is the first thing you
 * need when deciding whether the people in front of you are the right ones.
 *
 * All of them are rendered and hidden; the filter shows the ones selected, so
 * two chips show two offers and none shows none.
 */
function offerBlocks(cfg) {
  const svcs = (cfg.packages ?? []).filter((sv) => !serviceOff(cfg, sv));
  if (!svcs.length) return '';
  return `<div id="offers">${svcs.map((sv) => {
    const pit = resolveBuyer(cfg, sv.buyer) ?? {};
    const price = sv.price_usd ? `$${sv.price_usd.toLocaleString()}`
      : sv.price_usd_month ? `$${sv.price_usd_month.toLocaleString()} / month`
      : sv.rate_usd_hour ? `$${sv.rate_usd_hour} / hour` : 'not priced';
    return `<section class="panel offer" data-offer="${esc(sv.id)}" hidden>
      <h2>${esc(sv.name ?? sv.id)}</h2>
      <p class="lead"><b>${esc(price)}</b>${sv.duration ? `, ${esc(sv.duration)}` : ''}${
      sv.minimum ? `, minimum ${esc(sv.minimum)}` : ''}. <b>Best for:</b> ${
      esc(sv.best_for ?? '—')}.</p>
      <table class="params"><tbody>
      <tr><td>Seats that buy it</td><td>${(sv.buyer_titles ?? []).map((t) => esc(t)).join(', ') || '—'}</td></tr>
      <tr><td>Sold under the pitch</td><td>${esc(pit.label ?? pit.name ?? sv.buyer)}</td></tr>
      ${sv.note ? `<tr><td>Note</td><td>${esc(sv.note)}</td></tr>` : ''}
      <tr><td>Its own page</td><td><a href="service-${esc(sv.id)}.html">service-${esc(sv.id)}.html</a></td></tr>
      </tbody></table></section>`;
  }).join('')}</div>`;
}

/** A persona pattern as a filter value. The pattern IS the seat; the index is not. */
function personaSlug(m) {
  return m ? String(m).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : 'none';
}

/**
 * WHERE THIS FIRM CAME FROM, normalised. `orgs.source` is free text written by
 * whatever stage added the row -- 27 distinct strings for 6 real paths -- and
 * the distinction that matters is which RETRIEVAL PATH produced a prospect, not
 * how that path phrased itself. This is the axis the project exists to measure:
 * a channel that never yields a writable person is a channel to stop running.
 *
 * Not to be confused with a target definition. Shadow IT is WHAT is being looked
 * for; these are WHERE it was looked.
 */
const CHANNELS = [
  ['news_discover', 'news --discover', /news --discover/i],
  ['conference', 'conference agenda', /conference|agenda|summit/i],
  ['warm', 'warm tie / inbound', /\bwarm\b|inbound|recruiter|former (colleague|client|account)|friend/i],
  ['scan', 'channel scan', /\bscan\b|channel expansion|\bchannel\b|directory|thesis/i],
  ['operator', 'added by hand', /^operator/i],
];
function channelOf(src) {
  const v = String(src ?? '');
  return (CHANNELS.find(([, , re]) => re.test(v)) ?? ['unknown'])[0];
}

/**
 * WHAT TO SELL THIS PERSON, on the face of the card. It was in a data attribute
 * and inside the firm disclosure, and nowhere a reader would see it -- on a page
 * whose first column is called "what to sell".
 *
 * The second offer is shown when the same evidence supports one, because the
 * operator knows things the dossier does not and the two often sit either side
 * of a decision. No likelihood is attached to either: the record is 25 sends and
 * no service clears the n>=40 floor, so a "chance of success" would be an
 * asserted number wearing the clothes of a measured one.
 */
function sellLine(p, cfg, d0) {
  const id = p.pitchedService ?? p.firm?.package_id;
  if (!id) {
    return `<p class="need"><b>Nothing to sell here yet.</b> No offer in the catalogue matches
      what is known about this firm &mdash; check its kind, or config/offers.yml.</p>`;
  }
  const sv = (cfg.packages ?? []).find((x) => x.id === id);
  const price = !sv ? '' : sv.price_usd ? `$${sv.price_usd.toLocaleString()}`
    : sv.price_usd_month ? `$${sv.price_usd_month.toLocaleString()}/mo`
    : sv.rate_usd_hour ? `$${sv.rate_usd_hour}/hr` : '';
  // Two things the first version got wrong. The alternatives were computed
  // against the ROUTED service, so once a note had gone out on a different offer
  // the routed one disappeared and the sent one turned up as its own
  // alternative. And nothing removed the primary from its own list.
  const routed = p.firm?.package_id;
  const raw = String(p.firm?.package_alts ?? '').split('~').filter(Boolean)
    .map((x) => { const [aid, why] = x.split('|'); return { aid, why }; });
  if (p.pitchedService && routed && routed !== id) {
    raw.unshift({ aid: routed, why: 'what the evidence routes to, rather than what was sent' });
  }
  const seen = new Set([id]);
  const alts = raw.filter((a) => !seen.has(a.aid) && seen.add(a.aid))
    .map((a) => ({ ...a, sv: (cfg.packages ?? []).find((y) => y.id === a.aid) }))
    .filter((a) => a.sv);
  // WHY THIS OFFER, and above all whether the router DECIDED or SHRUGGED. Asking
  // that question is how it was found that 23 of 28 proposal-read assignments
  // were the cheapest-way-in fallback rather than a match on anything. A default
  // dressed as a recommendation is the worst of the three, because it reads as a
  // judgment and is the absence of one.
  const basis = String(p.firm?.package_basis ?? '');
  const trig = p.firm?.package_trigger;
  const ev = trig ? (d0?.signalsByOrg?.get(p.org_id) ?? [])
    .find((x) => x.trigger_id === trig) : null;
  const why = basis.startsWith('buyer:')
    ? `<span class="dim">${esc(basis.slice(6))}.</span>`
    : basis === 'evidence'
      // NAME THE EVENT, not just its trigger id. "Because capital_event is live
      // here, dated 2026-07-09" is a fact about the database. What the operator
      // needs before writing is what actually happened, and reading it is how a
      // top-priced offer was found routed to a COO on the strength of his firm
      // buying twelve hospitals. The trailing "which is what this offer asks
      // for" is dropped: it restates the rule rather than the reason, and the
      // rule is one click away on the offer block.
      ? `<span class="dim">Because <b>${esc(trig ?? 'the evidence')}</b> is live here${
        ev?.detected_at ? `, dated ${esc(ev.detected_at)}` : ''}${
        ev?.claim ? `: ${esc(String(ev.claim).replace(/\s+/g, ' ').slice(0, 190))}${
          String(ev.claim).length > 190 ? '…' : ''}` : '.'}</span>`
      : `<span class="dim"><b>Not a match &mdash; a default.</b> Nothing in this firm's evidence
        satisfies any offer, so this is the cheapest way in. Treat it as the absence of a
        recommendation rather than one.</span>`;
  // WHAT THE WORK IS, above what it costs. The offer line answers "how is this
  // bought"; this answers "what am I offering to do", and it is the half a draft
  // can use verbatim. Written in the buyer's words in offers.yml precisely so
  // that it needs no translation on the way into a note.
  const cap = (cfg.work ?? []).find((c) => c.id === p.firm?.work_id);
  const capTrig = p.firm?.work_trigger;
  const capLine = cap
    ? `<p class="need"><b>Build:</b> ${esc(cap.label ?? cap.id)} <span class="dim">&mdash; ${
      esc(cap.what_it_is ?? '')}</span></p>${capTrig && capTrig !== trig
        ? `<p class="dim">Named by <b>${esc(capTrig)}</b>.</p>` : ''}`
    // An absent capability is a real answer and is worth one line, because the
    // alternative is a card that quietly sells a price with no description.
    : `<p class="need"><b>Build:</b> <span class="dim">unknown &mdash; no trigger here names a
      kind of work. The offer below is about how it would be bought, not what it is.</span></p>`;
  return `${capLine}
  <p class="need"><b>Sell:</b> ${esc(d0?.offerName?.(d0.offerId?.(id) ?? id) ?? sv?.label ?? id)}${price ? ` &middot; ${esc(price)}` : ''}${
    sv?.duration ? ` &middot; ${esc(sv.duration)}` : ''}${
    p.pitchedService ? ' <span class="dim">&mdash; already pitched to him</span>' : ''}</p>
  <p class="dim">${why}</p>
  ${alts.length ? `<p class="dim">Also fits: ${alts.map((a) =>
    `<b>${esc(a.sv.label ?? a.aid)}</b> &mdash; ${esc(a.why)}`).join(' &middot; ')}.
    Ordered by the menu, not by odds &mdash; nothing here has enough sends behind it to
    quote a rate.</p>` : ''}`;
}

function cards(list, cfg, d) {
  return list.map((p, i) => {
    const warnGates = (d.gatesByOrg.get(p.org_id) ?? []).filter((g) => g.outcome === 'warn');
    const buyerId = p.firm?.package_id
      ? cfg.packages.find((s) => s.id === p.firm.package_id)?.buyer : null;
    const pd = buyerId ? resolveBuyer(cfg, buyerId) : null;
    // Name, firm and role together, in that order, because that is the order the
    // operator retypes them into a LinkedIn search himself. He reads the page as
    // a person and searches as a person; nothing here fetches linkedin.com. The
    // copy button hands him the query; searchLink() opens it in his own browser.
    const lookup = `${p.name} ${p.org_name}`;
    // The three axes a reader filters on, declared on the card itself. A person
    // can sit in several sectors, so that one is a list.
    // THE REDESIGN'S STATUS (2026-09-27): sent, cooling off (a note went into
    // this firm too recently; a channel rule, not a score), or open. The
    // ranker's "blocked" mixed that rule with its own scoring judgments.
    const status = statusOfCard(p);
    const cooling = coolingLines(p);
    const j = d.judgeOf?.(p.person_id);
    // WHAT WAS PITCHED BEATS WHAT WAS FORECAST. `firm.package_id` is the
    // ranking's guess at the right thing to sell. Once a note has gone out, the
    // service in it is a fact, and a fact outranks a forecast: a note pitching
    // senior capacity left the card filed under "proposal read" because nothing
    // reconciled the two, so the service page for the pitch just sent was empty.
    const pitched = (d.outreachByOrg.get(p.org_id) ?? [])
      .filter((o) => o.person_id === p.person_id && o.service_pitched)
      .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0]?.service_pitched;
    // WHY IT CANNOT BE ACTED ON, FIRST. This sat last on the card, about fifteen
    // thousand characters down it, under the channel advice and the backstory —
    // so a blocked person read as a candidate for the length of a scroll, and a
    // group CFO whose seat does not buy the offer looked like the top prospect
    // in his bucket. On a card that cannot be acted on, the reason is the card's
    // subject and everything else is detail about a person nobody is writing to
    // this week. It stays in place for a writable card, where it is a caveat on
    // work that is going ahead rather than the answer to why it is not.
    const inTheWay = (p.blockers ?? '').trim()
      ? `<div class="blocked"><h4>What is in the way</h4><ul>${
        p.blockers.split('\n').filter(Boolean).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`
      : '';
    const axes = ` data-channel="${esc(channelOf(p.firm?.source ?? p.org_source))}"` +
      ` data-service="${esc(d.offerId?.(pitched ?? p.firm?.package_id ?? 'none') ?? pitched ?? p.firm?.package_id ?? 'none')}"` +
      ` data-sectors="${esc(d.tgt.of(p.person_id, p.org_id).join(','))}"` +
      ` data-capability="${esc(p.firm?.work_id ?? 'none')}"` +
      ` data-form="${esc(p.firm?.work_form ?? 'none')}"` +
      ` data-geo="${esc(p.geo_bucket ?? 'unknown')}"` +
      ` data-status="${status}" data-call="${callOf(d, p.person_id)}" data-owner="${ownerOf(d, p.person_id)}" data-pasted="${pastedOf(d, p.person_id)}"`;
    return `<article class="card" id="p-${esc(p.person_id)}" data-name="${esc(p.name)}"${axes}>
      <header><h3>${status === 'in_flight' ? '<span class="rank flag">sent</span>'
        : j ? `<span class="rank rating ${j.rating >= 3 ? '' : 'flag'}">judge: ${j.rating}/5${j.spread >= 2 ? ' ±' : ''}</span>`
        : '<span class="rank rating flag">not judged</span>'} ${esc(p.name)}
        <span class="title">${esc(p.title ?? 'title unknown')}</span></h3></header>
      ${cooling.length ? `<div class="blocked"><h4>Cooling off</h4><ul>${
        cooling.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
      ${status === 'in_flight' ? '' : judgeBlock(j)}
      <p class="lookup"><code>${esc(lookup)}</code>
        <button class="copy" data-copy="${esc(lookup)}">copy</button>
        ${searchLink(p.name, p.org_name, p.profile_url)}
        <span class="dim">${esc(p.title ?? 'title unknown')}</span></p>
      ${verdictBox(p, (d.backstory ?? d).verdictsByPerson?.get(p.person_id) ?? null)}
      <p class="meta">${esc(p.org_name)} · ${esc(p.org_kind ?? 'kind unknown')}
        ${p.location ? `· ${esc(p.location)}` : p.firm?.hq ? `· ${esc(p.firm.hq)} (firm HQ)` : ''}
        ${p.in_seat_since ? `· in seat since ${esc(p.in_seat_since)}` : ''}
        ${p.platform_activity ? `· LinkedIn ${esc(p.platform_activity)}${
          p.followers != null ? ` (${p.followers})` : ''}` : ''}</p>
      ${d.firmLine?.(p.org_id) ?? ''}
      ${addressLine(p)}
      ${inFlightPanel(p)}
      ${profilePanel(p, d)}
      ${firmOutreachPanel(p, d)}
      ${p.needs_profile ? pasteBox(p) : ''}
      ${draftPanel(p, d)}

      ${warnGates.length ? `<div class="warns"><h4>Gate warnings on the firm</h4><ul>${
        warnGates.map((g) => `<li><b>${esc(g.gate_id)}</b> — ${esc(g.reason ?? '')}
          <span class="dim">${checkLabel(g)}</span></li>`).join('')}</ul></div>` : ''}
      ${backstoryPanel(p, d)}
      ${noteBox(p, (d.backstory ?? d).draftsByPerson?.get(p.person_id)?.[0] ?? null, { channel: reachOptions(p, d).find((x) => x.channel)?.channel ?? 'linkedin_inmail' })}
    </article>`;
  }).join('');
}

const triggerCallout = (d) => d.signals === 0 ? `<p class="callout"><b>Read every ranking here as
"who is worth an hour", not "who to write to this week".</b> No firm in the book carries a dated
trigger, so nothing distinguishes a firm worth contacting today from one worth contacting in
March. Ordering is fit and reachability only.</p>` : '';

function buildAll(db, cfg, targeting) {
  const d = collect(db, cfg, targeting);
  mkdirSync(OUT_DIR, { recursive: true });

  // THE SECTOR COLUMN IS THE REDESIGN'S TARGETS (2026-09-27), from business.yml.
  // The old theses fold into them through each target's `replaces:` list, and
  // the judge's recorded target wins for a person it has judged. Theses no
  // target replaces get no page and no chip.
  d.tgt = targetsOfPeople(db, loadBusiness(cfg, targeting));
  // Offers: each business.yml offer names the old ids it `replaces:`, so a send
  // or a card filed under a merged id counts toward the offer it became.
  const bizOffers = loadBusiness(cfg, targeting).offers ?? [];
  const offerAlias = new Map();
  for (const o of bizOffers) for (const id of o.replaces ?? []) offerAlias.set(id, (o.replaces ?? [])[0]);
  d.offerId = (id) => offerAlias.get(id) ?? id;
  d.offerName = (id) => bizOffers.find((o) => (o.replaces ?? [])[0] === id)?.name ?? null;
  // The chip's text: business.yml's short `label` where given, else the name.
  d.offerLabel = (id) => { const o = bizOffers.find((x) => (x.replaces ?? [])[0] === id); return o ? (o.label ?? o.name) : null; };
  // THE JUDGE'S CALL PER PERSON, for every card (not only Ready's): the latest
  // batch's middle rating, how far its runs disagreed, and the run that gave it.
  const judged = new Map();
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'judgments'`).get()) {
    const byP = new Map();
    for (const r of db.prepare(`SELECT j.* FROM judgments j JOIN (SELECT person_id, MAX(batch) b FROM judgments
        GROUP BY person_id) l ON l.person_id = j.person_id AND l.b = j.batch`).all()) {
      if (!byP.has(r.person_id)) byP.set(r.person_id, []);
      byP.get(r.person_id).push(r);
    }
    for (const [pid, runs] of byP) {
      const rs = runs.map((r) => r.compelling ?? (r.verdict === 'write' ? 4 : 1)).sort((a, b) => a - b);
      const rating = rs[Math.floor(rs.length / 2)];
      judged.set(pid, { rating, spread: rs[rs.length - 1] - rs[0],
        pick: runs.find((r) => (r.compelling ?? (r.verdict === 'write' ? 4 : 1)) === rating) ?? runs[0] });
    }
  }
  d.judgeOf = (pid) => judged.get(pid) ?? null;
  d.pastedSet = new Set(db.prepare(`SELECT DISTINCT person_id FROM evidence
      WHERE kind = 'operator_profile' AND person_id IS NOT NULL`).all().map((r) => r.person_id));
  // Channels already used on each person: never the same one twice to a non-responder.
  const tried = new Map();
  for (const r of db.prepare('SELECT person_id, channel FROM outreach').all()) {
    if (!tried.has(r.person_id)) tried.set(r.person_id, new Set());
    tried.get(r.person_id).add(r.channel);
  }
  d.triedChannels = (pid) => tried.get(pid) ?? new Set();
  // InMail credits left: the balance LinkedIn showed, less InMails recorded since.
  d.inmailLeft = (() => {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'balances'`).get()) return null;
    const b = db.prepare(`SELECT * FROM balances WHERE channel = 'linkedin_inmail'`).get();
    if (!b) return null;
    return Math.max(0, b.credits - db.prepare(`SELECT COUNT(*) n FROM outreach WHERE channel = 'linkedin_inmail' AND id > ?`).get(b.after_id).n);
  })();
  // WHAT EACH FIRM DOES, one line from its own site, for every card.
  const firmDesc = new Map();
  // "Profile extracted for X" is enrich's placeholder when a site said nothing; not a description.
  for (const r of db.prepare(`SELECT o.id, o.industry, (SELECT e.claim FROM evidence e WHERE e.org_id = o.id
      AND e.person_id IS NULL AND e.kind = 'firm_profile' AND e.claim NOT LIKE 'Profile extracted for %' ORDER BY e.id DESC LIMIT 1) claim,
      (SELECT e.source_url FROM evidence e WHERE e.org_id = o.id AND e.person_id IS NULL
      AND e.kind = 'firm_profile' AND e.claim NOT LIKE 'Profile extracted for %' ORDER BY e.id DESC LIMIT 1) url FROM orgs o`).all()) {
    if (r.claim || r.industry) firmDesc.set(r.id, { line: r.claim ?? r.industry, url: r.claim ? r.url : null });
  }
  // WHO OWNS IT, AND WHO SITS ON ITS BOARD (npm run bios): a warm route. A card
  // at a portfolio company says which investor owns it and which of the
  // investor's people is on its board, and whether he has written to them.
  const has = (t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  const owners = new Map();
  if (has('holdings')) {
    for (const r of db.prepare(`SELECT h.company_id, h.investor_id, o.name investor FROM holdings h
        JOIN orgs o ON o.id = h.investor_id WHERE h.status <> 'exited'`).all()) {
      const board = has('board_seats') ? db.prepare(`SELECT p.id, p.name,
          (SELECT MAX(sent_at) FROM outreach x WHERE x.person_id = p.id) sent FROM board_seats b
          JOIN people p ON p.id = b.person_id WHERE b.company_id = ? AND b.status = 'current' AND p.org_id = ?`)
        .all(r.company_id, r.investor_id) : [];
      if (!owners.has(r.company_id)) owners.set(r.company_id, []);
      owners.get(r.company_id).push({ investor: r.investor, board });
    }
  }
  d.ownerLine = (orgId) => (owners.get(orgId) ?? []).map((o) => `<p class="meta"><b>${o.board.length ? 'Owned by' : 'In the portfolio of'} ${esc(o.investor)}</b>${
    o.board.length ? `; on its board: ${o.board.map((b) => `${esc(b.name)}${b.sent ? ` <span class="dim">(you wrote ${esc(String(b.sent).slice(0, 10))})</span>` : ''}`).join(', ')}` : ''}</p>`).join('');
  d.firmLine = (orgId) => {
    const f = firmDesc.get(orgId);
    if (!f) return `<p class="meta dim">What the firm does: not on file.</p>${d.ownerLine(orgId)}`;
    const t = String(f.line); const short = t.length > 240 ? `${t.slice(0, 237).replace(/\s+\S*$/, '')}…` : t;
    return `<p class="meta">${esc(short)}${/^https?:/.test(f.url ?? '')
      ? ` <a href="${esc(f.url)}" target="_blank" rel="noopener">site</a>` : ''}</p>${d.ownerLine(orgId)}`;
  };
  const sectors = d.tgt.targets;
  const pitches = (cfg.buyers ?? []).filter((p) => !OFF_MENU_P.has(p.status ?? 'live'));

  // CHIP ORDER IS A JUDGMENT, SO IT LIVES IN CONFIG. The columns walked
  // declaration order, which put the 0-for-9 proposal read first — first in the
  // file, not first in expected return — and buried the one offer whose
  // precondition survives the gate that accounts for 25 of 40 kills. Reading
  // order is persuasion, and it was persuading toward the worst thing on the
  // menu. `priority` on a service or a vertical, with the reason written beside
  // it; anything unranked sorts last in declaration order rather than vanishing.
  const byPriority = (a, b) => (a.priority ?? 99) - (b.priority ?? 99);
  // THE REDESIGN'S PAGES FIRST (2026-09-26): Ready is where the day starts, then
  // what was sent, what the searches are yielding, and whether the judge is
  // holding up. The ranker's shortlist and its to-paste list follow, kept for
  // the two-week comparison.
  const pages = [
    // EVERYONE IN THE BOOK first, then the day's short list (the operator's
    // order, 2026-09-27). All prospects is in the judge's order since the same day.
    { id: 'index', file: 'index.html', label: 'All prospects' },
    { id: 'ready', file: 'ready.html', label: 'Ready' },
    // A SHORTCUT, NOT A PAGE (2026-09-28): Ready filtered to cards with no pasted
    // profile, leaving out the ones he would not write to. The profile filter did
    // this already, but a reminder has to be in sight to remind.
    { id: 'topaste', file: 'ready.html#call=first,write,none&pasted=no', label: 'To paste', shortcut: true },
    { id: 'funnel', file: 'funnel.html', label: 'Funnel' },
    { id: 'outreach', file: 'outreach.html', label: 'Sent' },
    { id: 'searches', file: 'searches.html', label: 'Searches' },
    { id: 'scoreboard', file: 'scoreboard.html', label: 'Scoreboard' },
    { id: 'spend', file: 'spend.html', label: 'Spend' },
    { id: 'gates', file: 'gates.html', label: 'Gate log' },
    { id: 'inputs', file: 'inputs.html', label: 'Inputs' },
    ...sectors.map((v) => ({ id: `s-${v.id}`, file: `target-${v.id}.html`,
      label: v.label ?? v.name, group: 'sector', vertical: v })),
    // The pitch's own label, not its id. "buyers_side" names the argument to
    // someone who wrote it and nothing to anyone reading a nav bar.
    // One button per SERVICE, not per pitch. A pitch carries several services
    // under one argument, which is right for writing a note and wrong for a
    // menu: it hid the Owner's Technical Representative behind a label about
    // reading proposals. An empty service page is not clutter — it is the
    // pipeline reporting that it cannot find anyone to sell that thing to.
    // Labelled with business.yml's offer names (2026-09-27): the chip is the
    // offer the operator wrote, and the old id behind it is only the key.
    ...(cfg.packages ?? [])
      .filter((sv) => !serviceOff(cfg, sv))
      .sort(byPriority)
      .map((sv) => ({ id: `sv-${sv.id}`, file: `service-${sv.id}.html`,
        label: d.offerLabel(sv.id) ?? sv.label ?? sv.name ?? sv.id, group: 'service', service: sv })),
    // NO CAPABILITY PAGES (removed 2026-09-27). "What the work is" was the old
    // capability catalogue; the redesign describes the work in the offers and
    // targets of business.yml and keeps no catalogue of its own.
    ...geoBuckets(cfg).map((g) => ({ id: `g-${g.id}`, file: `geo-${g.id}.html`,
      label: g.label, group: 'geo', bucket: g })),
  ];

  // The seats actually present in this run, commonest first. Built from the data
  // rather than declared, so a persona nobody matches never becomes a chip that
  // filters to an empty page -- and a new one appears the moment it matches
  // somebody. Shadow IT has no chip today for exactly that reason: it matches
  // nobody, because a leadership page does not list the seat two levels down.
  const personaChips = (() => {
    const seen = new Map();
    for (const p of [...d.writable, ...d.blocked, ...d.inFlight]) {
      const slug = channelOf(p.firm?.source ?? p.org_source);
      const label = (CHANNELS.find(([id]) => id === slug) ?? [, 'unknown'])[1];
      const cur = seen.get(slug) ?? { slug, label, n: 0, ids: new Set() };
      cur.ids.add(p.person_id);
      seen.set(slug, cur);
    }
    return [...seen.values()].map((x) => ({ ...x, n: x.ids.size }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  })();

  // One count per axis value, over the cards that exist. Counted on DISTINCT
  // person, because someone in two verticals is one prospect and two rows.
  // EVERY CHIP CARRIES WHAT IT HAS RETURNED, not just how many people are in it.
  // The operator's framing: this tool exists to reveal which segments are good
  // and which are bad, and a filter bar that only reports population size cannot
  // do that. So the filter bar and the performance report become the same
  // object — you cannot look at a segment without seeing what it has returned.
  //
  // POPULATION comes from the board; OUTCOMES come from every outreach row ever
  // sent. Those are different sets and must be counted separately: someone
  // written to six weeks ago may have cooled off the board entirely, and
  // dropping their send would flatter the bucket they came from.
  const axisStats = (() => {
    const out = { service: {}, sectors: {}, capability: {}, form: {}, geo: {}, status: {}, call: {} };
    const cell = (axis, val) => (out[axis][val] ??=
      { firms: new Set(), people: new Set(), sent: 0, replied: 0 });
    const pop = (axis, val, personId, orgId) => {
      if (!val) return;
      const c = cell(axis, val);
      c.people.add(personId);
      if (orgId) c.firms.add(orgId);
    };
    const statusOf = statusOfCard;

    for (const p of [...d.writable, ...d.blocked, ...d.inFlight]) {
      const pitchedSvc = (d.outreachByOrg.get(p.org_id) ?? [])
        .filter((o) => o.person_id === p.person_id && o.service_pitched)
        .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0]?.service_pitched;
      pop('service', d.offerId(pitchedSvc ?? p.firm?.package_id ?? 'none'), p.person_id, p.org_id);
      for (const v of d.tgt.of(p.person_id, p.org_id)) pop('sectors', v, p.person_id, p.org_id);
      pop('capability', p.firm?.work_id ?? 'none', p.person_id, p.org_id);
      pop('form', p.firm?.work_form ?? 'none', p.person_id, p.org_id);
      pop('geo', p.geo_bucket ?? 'unknown', p.person_id, p.org_id);
      pop('status', statusOf(p), p.person_id, p.org_id);
      pop('call', callOf(d, p.person_id), p.person_id, p.org_id);
    }

    // Outcomes, attributed in the same vocabulary the chips use. `service` is
    // attributed to what was ACTUALLY PITCHED rather than what the catalogue
    // would route to today — the record of what was sent cannot be revised by a
    // later change to the router.
    // Job applications are outreach and are not sales evidence, so they are not
    // counted on a chip that reports what a segment returned. Same rule, same
    // config key, same helper as rank — two surfaces that disagreed about what a
    // send is would be worse than either being wrong alone. See offers.yml.
    const ns = notSalesSql(cfg);
    let unattributed = { sectors: 0, geo: 0, service: 0 };
    for (const o of db.prepare(`
      SELECT o.service_pitched,
             -- A reply is a human answering: a bounce or an accepted connection is not one.
             EXISTS (SELECT 1 FROM responses x WHERE x.outreach_id = o.id
                     AND COALESCE(x.sentiment, '') NOT IN ('bounced', 'accepted')) AS replied,
             p.org_id, o.person_id,
             p.country, p.location, g.hq
        FROM outreach o
        JOIN people p ON p.id = o.person_id
        JOIN orgs g ON g.id = p.org_id
       WHERE 1=1${ns.sql.replace(/service_pitched/g, 'o.service_pitched')}`).all(...ns.params)) {
      const add = (axis, val) => {
        if (!val) { unattributed[axis] += 1; return; }
        const c = cell(axis, val);
        c.sent += 1;
        if (o.replied) c.replied += 1;
      };
      add('service', o.service_pitched ? d.offerId(o.service_pitched) : o.service_pitched);
      // Resolved from durable columns, NOT from person_scores. A send's
      // geography must not disappear because the person left the board — see
      // geoBucketOf in config.mjs for what went wrong when it did.
      add('geo', geoBucketOf({ country: o.country, location: o.location, hq: o.hq },
        cfg).bucket);
      const vs = d.tgt.of(o.person_id, o.org_id);
      if (!vs.length) unattributed.sectors += 1;
      else for (const v of vs) add('sectors', v);
    }

    const flat = {};
    for (const [a, m] of Object.entries(out)) {
      flat[a] = Object.fromEntries(Object.entries(m).map(([k, c]) =>
        [k, { firms: c.firms.size, people: c.people.size, sent: c.sent, replied: c.replied }]));
    }
    flat._unattributed = unattributed;
    // SENDS FILED UNDER A RETIRED THESIS HAVE NOWHERE TO SHOW. Only live
    // verticals get a chip, so attributing outreach to a dead one moves it from
    // "unattributed" to "attributed and invisible" — which is the same hole
    // wearing a better label. Counted separately and named in the footnote.
    const liveIds = new Set(d.tgt.targets.map((v) => v.id));
    flat._retired = Object.entries(flat.sectors)
      .filter(([id]) => !liveIds.has(id))
      .map(([id, c]) => ({ id, name: id, sent: c.sent }))
      .filter((x) => x.sent);
    // THE SAME HOLE ON THE OFFER AXIS. A retired service gets no chip, so sends
    // recorded against it vanish from the column rather than being reported
    // somewhere. Merging one service into another made this live: two sends sit
    // under an id that is now retired, and they are still sends.
    const liveSvcIds = new Set((cfg.packages ?? [])
      .filter((x) => !serviceOff(cfg, x)).map((x) => x.id));
    flat._retiredSvc = Object.entries(flat.service)
      .filter(([id]) => id !== 'none' && !liveSvcIds.has(id))
      .map(([id, c]) => ({ id, name: (cfg.packages ?? []).find((x) => x.id === id)?.label ?? id, sent: c.sent }))
      .filter((x) => x.sent);
    return flat;
  })();

  // THE NUMBER THAT DECIDES WHETHER A RATE MAY BE SHOWN AT ALL. It is already
  // declared in sectors.yml and already governs the priors; the chips honour the
  // same threshold so that two surfaces cannot disagree about what counts as
  // measured.
  const minN = targeting.ranking?.response_likelihood?.min_n_for_measured_rate ?? 40;

  // Built from the capabilities present, in the order they are declared, so a
  // new form needs a capability and not a code change. Labels are humanised
  // from the id rather than declared twice.
  const forms = [...new Set((cfg.work ?? [])
    .filter((c) => (c.status ?? 'live') !== 'retired').map((c) => c.form).filter(Boolean))]
    .map((id) => ({ id: String(id), label: String(id).replace(/_/g, ' ') }));

  // Firm and when, and nothing else. The methodology note and the file list were
  // true and answered a question nobody asks twice; the timestamp answers the
  // one that gets asked every time, which is whether this is the latest run.
  const stamp = new Date().toLocaleString(undefined,
    { dateStyle: 'medium', timeStyle: 'short' });
  const sub = `${esc(cfg.firm.name)} · generated ${esc(stamp)}`;
  const out = [];
  const write = (page, h1, body, script, minimal = false, counts = axisStats) => {
    const f = resolve(OUT_DIR, page.file);
    writeFileSync(f, layout({ title: `${h1} — ${cfg.firm.name}`, h1, sub, body,
      pages, currentId: page.id, personas: personaChips, counts,
      minN, unattributed: axisStats._unattributed, retired: axisStats._retired,
      retiredSvc: axisStats._retiredSvc, forms, minimal, script }));
    out.push(f);
  };

  const pageOf = (id) => pages.find((x) => x.id === id);
  const readyBody = readyPage(db, d, cfg);
  write(pageOf('ready'), 'Ready', readyBody, undefined, false,
    { ...axisStats, ...(d.readyCounts ? d.readyCounts(axisStats) : {}) });
  write(pageOf('searches'), 'Searches', searchesPage(db));
  write(pageOf('scoreboard'), 'Scoreboard', scoreboardPage(db));
  write(pageOf('funnel'), 'Funnel', funnelPage(db, cfg));
  { const sp = spendPage(db); write(pageOf('spend'), 'Spend', sp.html, sp.script); }

  // ---- 1. index: everyone, in the judge's order ------------------------------
  // REBUILT 2026-09-27 for the redesign. It was the ranker's page: four lists
  // by score (best, writable, blocked, in flight) with a person in two of them,
  // six score bars per card and the ranker's blockers. Now one list, one card
  // per person: the judge's rating first, then value and how fresh the reason
  // is; people it has not judged follow in the order it will meet them.
  const openAll = [];
  { const seen = new Set();
    for (const p of [...d.writable, ...d.blocked]) if (!seen.has(p.person_id)) { seen.add(p.person_id); openAll.push(p); }
    // THE OLD SEAT FILTER DOES NOT OVERRULE HIM OR THE JUDGE (2026-09-28). It
    // drops titles it reads as not buying ("Principal"), and it hid a Write
    // first pick from this page. Anyone it dropped whom the operator would write
    // to, or the judge rates 3 or more, is listed; still not contacted.
    for (const p of d.noAuthority ?? []) {
      if (seen.has(p.person_id) || d.contactedPeople?.has(p.person_id)) continue;
      const call = callOf(d, p.person_id);
      if (call === 'first' || call === 'write' || (d.judgeOf(p.person_id)?.rating ?? 0) >= 3) {
        seen.add(p.person_id); openAll.push(p);
      }
    }
  }
  const judgedFirst = openAll.map((p, i) => ({ p, i, j: d.judgeOf(p.person_id) }))
    .sort((a, b) => (b.j ? 1 : 0) - (a.j ? 1 : 0)
      || (b.j?.rating ?? 0) - (a.j?.rating ?? 0)
      || Number(b.j?.pick.value ?? 0) - Number(a.j?.pick.value ?? 0)
      || (a.j?.pick.timing_days ?? 9e9) - (b.j?.pick.timing_days ?? 9e9)
      || a.i - b.i)
    .map((x) => x.p);
  const nJudged = judgedFirst.filter((p) => d.judgeOf(p.person_id)).length;
  // WHAT IT HAS COST, at a glance (the operator missed the all-time tile when
  // this page was rebuilt). Same numbers as the Spend page: measures.spend().
  const sp = spend(db);
  const costTiles = `<div class="tiles">
${tile({ label: 'Today', value: `$${Number(sp.today.usd).toFixed(2)}`, state: 'none',
    sub: `${sp.today.runs} runs · ${Number(sp.today.credits).toLocaleString('en-US')} search credits`,
    note: `as of ${sp.today.asOf}, when this page was built` })}
${tile({ label: 'Last 7 days', value: `$${Number(sp.week).toFixed(2)}`, state: 'none',
    sub: 'model calls', note: '<a href="spend.html">Spend page</a>' })}
${tile({ label: 'This month', value: `$${Number(sp.month.usd).toFixed(2)}`, state: 'none',
    sub: `${sp.month.label} · ${Number(sp.month.credits ?? 0).toLocaleString('en-US')} search credits`,
    note: 'every model call is recorded as it is made' })}
${tile({ label: 'AI spend, all time', value: `$${Number(sp.total).toFixed(2)}`, state: 'none',
    sub: `since ${sp.since} · ${Number(sp.credits).toLocaleString('en-US')} search credits`,
    note: '<a href="spend.html">by day, stage and model</a>' })}
</div>`;
  write(pageOf('index'), 'Prospects', `
${costTiles}
<section class="panel"><h2>Everyone in the book</h2>
<p class="lead">${openAll.length} people not yet written to, ${nJudged} of them rated by the judge, best
first; the rest follow, not yet judged. Filter by offer, target, geography or status above. The
<b>Ready</b> page is the day's short list; this is everyone behind it.</p>
<p class="lead dim">${new Set(d.noAuthority.map((p) => p.person_id)).size} further named people at these firms are not listed: their
titles matched no seat that buys this work (controllers, counsel, associates and the like).</p>
${cards(judgedFirst, cfg, d)}
</section>

${d.inFlight.length ? `<section class="panel"><h2>In flight</h2>
<p class="lead">Written to and waiting. Each card carries what was sent, on which channel, and how long
it has been quiet.</p>
${cards(d.inFlight, cfg, d)}
</section>` : ''}

${d.releasing.length ? `<section class="panel"><h2>Unlocking soon</h2>
<p class="lead">Held until a date, at firms that survive the gates. They are excluded from the
ranking above because contacting them today would break a sequencing decision already made —
usually "do not put two notes into one small firm in the same week". Listed here because
excluding them silently would hide names that are about to become the best available.</p>
<table><thead><tr><th>Releases</th><th>Person</th><th>Firm</th><th>Why held</th></tr></thead><tbody>
${d.releasing.map((r) => `<tr><td><b>${esc(r.release_after)}</b></td>
  <td>${esc(r.name)}<br><span class="dim">${esc(r.title ?? '')}</span>
    <p class="lookup"><code>${esc(`${r.name} ${r.org_name}`)}</code>
    <button class="copy" data-copy="${esc(`${r.name} ${r.org_name}`)}">copy</button>
    ${searchLink(r.name, r.org_name, r.profile_url)}</p></td>
  <td>${esc(r.org_name)}</td><td>${esc(r.condition ?? '')}</td></tr>`).join('')}
</tbody></table></section>` : ''}`);

  // ---- 2. gate log ---------------------------------------------------------
  const killedRows = [...d.killedOrgs].map((id) => {
    const f = d.firms.find((x) => x.org_id === id);
    const gs = (d.gatesByOrg.get(id) ?? []).filter((g) => g.outcome.startsWith('kill'));
    if (!f || !gs.length) return '';
    return `<tr><td><b>${esc(f.name)}</b><br><span class="dim">${esc(f.kind ?? '')}</span></td>
      <td>${gs.map((g) => `<b>${esc(g.gate_id)}</b>`).join('<br>')}</td>
      <td>${gs.map((g) => `${esc(g.reason ?? '')}<br><span class="dim">${checkLabel(g)}</span>`)
        .join('<br><br>')}</td></tr>`;
  }).filter(Boolean).join('');

  write(pageOf('gates'), 'Why the market disqualifies itself', `
<section class="panel"><h2>Kills by reason</h2>
<p class="lead">Every kill on file. This is the most useful dataset the system produces: when
one reason dominates, the targeting thesis is wrong and more outreach will not fix it. Two
rules keep it honest — a gate that cannot be decided from the evidence stays unevaluated
rather than quietly passing, and a gate decided by hand is never overwritten.</p>
<p class="lead">Every kill says how it can be checked, because <b>&ldquo;I decided this&rdquo;
and &ldquo;the system decided this and cannot show you why&rdquo; are not the same claim</b>.
A computed kill links the page it was derived from. One marked <span class="nosrc">no source on
file</span> is asserting a fact with nothing behind it, which this project treats as a defect
rather than a detail — there are currently none.</p>
<div id="c-kills" class="plot" style="height:${Math.max(220, d.killTally.length * 34 + 90)}px"></div>
<table><thead><tr><th>Firm</th><th>Gate</th><th>Reason</th></tr></thead>
<tbody>${killedRows}</tbody></table></section>

<section class="panel"><h2>Did the triggers pay?</h2>
<p class="lead">Each trigger is a hypothesis: that a specific public event marks a firm worth
an hour. This is whether it held. <b>Retracted</b> counts signals the judge accepted and a
re-reading later withdrew — it measures the trigger's wording and its <code>not:</code> list,
not the firm. <b>Still live</b> is firms that survived the gates and are ranked today.</p>
<p class="lead">A trigger that has never fired is the other finding, and not always a failure:
it may need a source this system does not have. One that fires often and retracts often is a
wording problem, and the <code>not:</code> list is where to fix it.</p>
<table><thead><tr><th>Trigger</th><th>Fired</th><th>Retracted</th><th>Firms</th>
<th>Still live</th><th>Most recent</th></tr></thead><tbody>
${d.triggerRows.map((t) => `<tr>
  <td><code>${esc(t.id)}</code></td>
  <td class="num">${t.fired || '<span class="dim">never</span>'}</td>
  <td class="num">${t.retracted
    ? `<span class="nosrc">${t.retracted} · ${Math.round(100 * t.retracted / t.fired)}%</span>`
    : (t.fired ? '0' : '<span class="dim">—</span>')}</td>
  <td class="num">${t.firms || '<span class="dim">—</span>'}</td>
  <td class="num"><b>${t.live || 0}</b></td>
  <td class="dim">${esc(t.newest ?? '—')}</td></tr>`).join('')}
</tbody></table></section>`,
  `Plotly.newPlot('c-kills', [{ type:'bar', orientation:'h',
    y:${JSON.stringify(d.killTally.map((k) => k.gate_id).reverse())},
    x:${JSON.stringify(d.killTally.map((k) => k.n).reverse())},
    marker:{color:${JSON.stringify(d.killTally.map((k) =>
      k.gate_id === 'capability_already_staffed' ? '#c03434' : '#7a8fbf').reverse())}},
    hovertemplate:'%{y}: %{x} kills<extra></extra>' }],
    layoutFor({xaxis:{title:'firms killed',gridcolor:dark?'#33322f':'#e6e5e1',dtick:1}}),
    {displayModeBar:false,responsive:true});`);

  // ---- 3. inputs -----------------------------------------------------------
  // ---- inputs: an index of files, plus one rendered page per file ---------
  write(pageOf('inputs'), 'Inputs', inputsPage(cfg, targeting), '', true);

  // THE LIVE FILE, AT THE TOP. `../../config/x.yml` resolves from data/dash to
  // the working file on disk, so this opens the thing being rendered rather
  // than a copy of it — click it, edit it, re-run, and the page below changes.
  // A `[LABEL](anchor)` in a purpose line becomes a link to that section of the
  // same page. Written this way rather than as raw HTML so the text still goes
  // through `esc` — a purpose line cannot inject markup by accident, and the
  // line stays readable as a sentence in source, which is the point of it.
  //
  // The anchor must be a section that page actually renders. Several are
  // conditional — a sectors file with nothing retired renders no retired panel
  // — so an anchor with no section is printed as PLAIN TEXT rather than as a
  // link to nowhere. A dead in-page link is worse than no link: it reports a
  // section that is not there.
  // ONE CLAUSE PER LINE, one line per section of the page below, so the lead
  // reads as a contents list rather than a sentence to parse. The `Open <file>`
  // link is appended as the last line by `cfgPage`.
  const PURPOSE = {
    offers: [
      '[PACKAGES](packages) are what it costs and how it is bought',
      '[WORK](work) is what you would actually do',
      '[BUYERS](buyers) are who buys, and what is wrong',
    ],
    sectors: [
      '[SITUATION](situation) theses select on what is happening at a firm, in any industry',
      '[SECTOR](sector) theses select on the industry itself',
      '[RETIRED](retired-with-the-reason) are dropped, with the reason kept',
    ],
    segments: [
      '[SEGMENTS](segments) are who the buyer is above the sector, reachability and value apart',
      '[GOALS](goals) are what would settle each one',
    ],
    signals: [
      '[GATES](gates) are what disqualifies a firm',
      '[TRIGGERS](triggers) are what makes one live',
      'The same object with opposite sign, which is why they share a file',
    ],
    discovery: [
      '[MECHANISMS](mechanisms) are how a prospect arrives',
      '[CLOSED QUESTIONS](closed-questions) are settled — do not re-test them',
      '[FORBIDDEN HOSTS](forbidden-hosts) are enforced at load, not reviewed',
    ],
    me: [
      'Who you are, and the claims you will never make',
    ],
    business: [
      'What your business is and wants: your firm, offers, size band, targets and events. The file to edit.',
    ],
    runtime: [
      '[SETTINGS](parameter-settings) are the plumbing',
      'No business judgment lives here',
    ],
  };

  // Slug from the heading text before the em dash, so "Gates — what disqualifies
  // a firm" anchors at `sec-gates` and the prose above can name it in one word.
  const slugOf = (h) => h.replace(/&mdash;.*$/, '').replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const anchorSections = (html) => {
    const ids = new Set();
    const out = html.replace(/<section class="panel">(\s*)<h2>([\s\S]*?)<\/h2>/g,
      (m, gap, heading) => {
        const id = slugOf(heading);
        if (!id || ids.has(id)) return m;      // never mint a duplicate anchor
        ids.add(id);
        return `<section class="panel" id="sec-${id}">${gap}<h2>${heading}</h2>`;
      });
    return { html: out, ids };
  };
  const purposeHtml = (line, ids) => esc(line).replace(
    /\[([^\]]+)\]\(([a-z0-9-]+)\)/g,
    (_, text, anchor) => (ids.has(anchor) ? `<a href="#sec-${anchor}">${text}</a>` : text));

  const cfgPage = (id, label, body) => {
    const { html, ids } = anchorSections(body);
    const lines = (PURPOSE[id] ?? []).map((l) => purposeHtml(l, ids));
    lines.push(`<a href="../../config/${label}">Open ${esc(label)}</a>`);
    return write(
      { id: `cfg-${id}`, file: `config-${id}.html`, label }, label,
      `<p class="lead">${lines.join('<br>')}</p>
${html}`, '', true);
  };
  cfgPage('offers', 'offers.yml', offersConfigPage(cfg));
  cfgPage('sectors', 'sectors.yml', sectorsConfigPage(targeting));
  cfgPage('segments', 'segments.yml', segmentsConfigPage(cfg));
  cfgPage('signals', 'signals.yml', signalsConfigPage(cfg));
  cfgPage('discovery', 'discovery.yml', discoveryConfigPage(cfg));
  cfgPage('me', 'me.yml', `<section class="panel"><h2>Who you are &mdash; read by the drafter on every note</h2>
${(cfg.operator?.never_claim ?? []).length ? `<table class="params"><tbody>${
  (cfg.operator.never_claim).map((n) => `<tr><td>never claim</td><td>${esc(n)}</td></tr>`).join('')
}</tbody></table>` : '<p class="callout">No never-claim rules are set.</p>'}</section>
${rawYaml('me.yml')}`);
  cfgPage('runtime', 'runtime.yml', `${knobsPanel(cfg, targeting)}${rawYaml('runtime.yml')}`);
  if (existsSync(resolve(ROOT, 'config/business.yml'))) cfgPage('business', 'business.yml', rawYaml('business.yml'));

  // ---- 3b. everything sent, and the draft it came from ---------------------
  // This page exists because the draft/sent pair is only ever created by
  // WRITING to someone, and writing to someone removes them from the shortlist.
  // The single most informative row in the database — 3,846 characters drafted
  // against 764 sent — was therefore rendered on no page at all.
  {
    const sent = db.prepare(`
      SELECT x.id, x.sent_at, x.channel, x.status, x.service_pitched, x.sent_to,
             x.message_text, x.credit_spent, p.name AS person, p.id AS person_id, o.name AS firm
        FROM outreach x LEFT JOIN people p ON p.id = x.person_id
        LEFT JOIN orgs o ON o.id = x.org_id
       ORDER BY x.sent_at DESC`).all();
    const replied = sent.filter((x) => /^responded|^open_thread|^channel_open/.test(x.status ?? ''));
    const withText = sent.filter((x) => (x.message_text ?? '').trim());
    const pairs = db.prepare(`
      SELECT d.person_id, d.version, d.body, d.sent_text, d.revise_note,
             p.name AS person, o.name AS firm
        FROM drafts d LEFT JOIN people p ON p.id = d.person_id
        LEFT JOIN orgs o ON o.id = d.org_id
       WHERE d.sent_text IS NOT NULL`).all();
    const pairBy = new Map(pairs.map((x) => [x.person_id, x]));

    write(pageOf('outreach'), 'Everything sent', `
<section class="panel"><h2>What has gone out</h2>
<p class="lead">Every message on record, newest first. This system drafts and never sends —
these were all sent by hand, and recorded afterwards with <code>lead sent</code>. The reply
rate is stated rather than implied because ${replied.length} of ${sent.length} is a small
number and rounding it into a percentage would flatter it.</p>
<table class="params"><tbody>
<tr><td>Messages sent</td><td>${sent.length}</td></tr>
<tr><td>&mdash; with the text preserved</td><td>${withText.length}</td></tr>
<tr><td>&mdash; paired with the draft they came from</td><td>${pairs.length}</td></tr>
<tr><td>Replies of any kind</td><td>${replied.length}</td></tr>
</tbody></table></section>

<section class="panel"><h2>The draft, and what you actually sent</h2>
<p class="lead">The gap is the only evidence that can teach <code>voice.md</code> what a note
should look like. It is measured on the note alone: every draft also carries a NOTES section
written for the operator, and counting that as part of the letter turned a 20% trim into an
apparent 80% rewrite.</p>
${pairs.length ? pairs.map((x) => {
  const note = noteOnly(x.body);
  const cut = Math.round((1 - x.sent_text.length / note.length) * 100);
  return `<div class="card"><h3>${esc(x.person ?? x.person_id)}
    <span class="title">${esc(x.firm ?? '')} &middot; draft v${x.version}</span></h3>
    <p class="meta">${note.length} characters drafted &rarr; ${x.sent_text.length} sent
      &middot; <b>${cut > 0 ? `${cut}% cut` : `${-cut}% longer`}</b>
      <span class="dim">(the note alone &mdash; the NOTES section is yours, not his)</span></p>
    ${x.revise_note ? `<p class="dim"><b>You had asked for:</b> ${esc(x.revise_note)}</p>` : ''}
    <details class="raw"><summary>The draft, as written</summary><pre class="pasted">${esc(x.body)}</pre></details>
    <details class="raw"><summary>What you sent</summary><pre class="pasted">${esc(x.sent_text)}</pre></details>
  </div>`;
}).join('') : `<p class="callout"><b>No draft is paired with a sent message yet.</b>
Record one with <code>npm run lead -- sent --person &lt;id&gt; --channel email --file sent.txt</code>
and the pair appears here.</p>`}
</section>

<section class="panel"><h2>Every message</h2>
${sent.map((x) => `<div class="card">
  <header><h3>${esc(x.person ?? '(firm only)')} <span class="title">${esc(x.firm ?? '')}</span></h3>
    <span class="score">${esc(x.status ?? '—')}</span></header>
  <p class="meta">${esc(x.sent_at)} &middot; ${esc(x.channel)}${
    x.service_pitched ? ` &middot; ${esc(x.service_pitched)}` : ''}${
    x.sent_to ? ` &middot; to ${esc(x.sent_to)}` : ''}${
    x.credit_spent ? ' &middot; burned an InMail credit' : ''}</p>
  ${(x.message_text ?? '').trim()
    ? `<details class="raw"><summary>Read it — ${x.message_text.length} characters</summary>
       <pre class="pasted">${esc(x.message_text)}</pre></details>`
    : '<p class="dim">Text not preserved. Only the fact of it was recorded.</p>'}
</div>`).join('')}
</section>`);
  }

  // ---- 3c. no paste worklist page since 2026-09-28: the "profile" filter
  // (Not pasted) does it on Ready and All prospects, in the judge's order.

  // ---- 4. one page per target ---------------------------------------------
  // The target as the operator wrote it in business.yml, and the shortlist of
  // people filed under it. Filing is by the judge's recorded target, else by
  // the firm's old theses through `replaces:`, else by location.
  for (const page of pages.filter((p) => p.group === 'sector')) {
    const v = page.vertical;
    const mine = d.shortlist.filter((p) => d.tgt.of(p.person_id, p.org_id).includes(v.id));
    const firms = db.prepare('SELECT id FROM orgs').all().filter((o) => d.tgt.ofOrg(o.id).includes(v.id)).length;
    const band = v.size ? Object.entries(v.size).map(([k, x]) => `${k.replace(/_/g, ' ')} ${x ?? 'no limit'}`)
      .join(' &middot; ') : 'the business default';
    const where = v.where ? esc(v.where.region ?? (v.where.countries ?? []).join(', ')) : 'anywhere the business works';
    write(page, v.name, `
<section class="panel"><h2>${esc(v.name)}</h2>
<p class="lead">${esc(v.description)}</p>
<table class="params"><tbody>
<tr><td>Where</td><td>${where}</td></tr>
<tr><td>Size</td><td>${band}</td></tr>
<tr><td>Folds in</td><td>${(v.replaces ?? []).map((x) => `<code>${esc(x)}</code>`).join(' ') || '&mdash;'}</td></tr>
<tr><td>Firms filed here</td><td>${firms}</td></tr>
</tbody></table>
${v.examples?.length ? `<h3>Examples</h3><ul>${v.examples.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
</section>
<section class="panel"><h2>Shortlist for this target</h2>
${mine.length ? cards(mine, cfg, d) : `<p class="callout"><b>Nobody on the shortlist is filed here yet.</b>
The daily searches look for this target; the judge records it when it rates someone.</p>`}
</section>`);
  }

  // ---- 4b. one page per geography bucket ----------------------------------
  // The bucket is derived by `rank` and stored, so what this page filters on is
  // literally the value that moved the score. The funnel matters more than the
  // cards: the home metro holds 68 people and shows none, and without the
  // intermediate counts that reads as a broken page rather than a finding.
  for (const page of pages.filter((p) => p.group === 'geo')) {
    const g = page.bucket;
    const inBucket = d.people.filter((p) => (p.geo_bucket ?? 'unknown') === g.id);
    const seen = new Set();
    const uniq = inBucket.filter((p) => !seen.has(p.person_id) && seen.add(p.person_id));
    const mine = d.shortlist.filter((p) => (p.geo_bucket ?? 'unknown') === g.id);
    const step = (n, label) => `<tr><td>${label}</td><td>${n}</td></tr>`;
    const atKilled = uniq.filter((p) => d.killedOrgs.has(p.org_id)).length;
    const gone = uniq.filter((p) => !d.killedOrgs.has(p.org_id)
      && (d.suppressed.has(p.person_id) || d.held.has(p.person_id))).length;
    const already = uniq.filter((p) => !d.killedOrgs.has(p.org_id)
      && d.contactedPeople.has(p.person_id)).length;
    const noAuth = d.noAuthority.filter((p) => (p.geo_bucket ?? 'unknown') === g.id).length;
    const firms = new Set(uniq.map((p) => p.org_id)).size;

    // Say which of the exits actually took them. The first draft asserted they
    // had all been written to, which was true of 2 of 68 here — a page that
    // explains itself wrongly is worse than one that says nothing.
    // Countable noun phrases, not clauses: prefixing a clause with a number
    // reads as broken English at every count except the one it was written for.
    const reasons = [[atKilled, 'at firms a gate killed'],
                     [noAuth, 'with no buying or routing authority'],
                     [already, 'already written to'],
                     [gone, 'suppressed or on hold']]
      .filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]);
    const dominant = reasons.length
      ? `Where they went: ${reasons.map(([n, why]) => `${n} ${why}`).join(', ')}.`
      : 'The table above says where they went.';

    // With no cards to show, the firms ARE the content. A gate kill is the most
    // interesting thing this page can report, so name the gate.
    const byFirm = new Map();
    for (const q of uniq) {
      if (!byFirm.has(q.org_id)) byFirm.set(q.org_id, { name: q.org_name, kind: q.org_kind, n: 0 });
      byFirm.get(q.org_id).n++;
    }
    const firmTable = uniq.length && !mine.length ? `<table class="params"><thead><tr>
      <th>Firm</th><th>Kind</th><th>People</th><th>Why nobody here is writable</th></tr></thead><tbody>${
      [...byFirm.entries()].sort((a, b) => b[1].n - a[1].n).map(([oid, f]) => {
        const kill = (d.gatesByOrg.get(oid) ?? []).find((x) => String(x.outcome).startsWith('kill'));
        return `<tr><td>${esc(f.name)}</td><td>${esc(f.kind ?? '—')}</td><td>${f.n}</td><td>${
          kill ? `killed by <code>${esc(kill.gate_id)}</code> — ${esc(String(kill.reason ?? '').slice(0, 96))}`
               : 'passed the gates; the people here are contacted, held, or hold no authority'
        }</td></tr>`;
      }).join('')}</tbody></table>` : '';

    write(page, g.label, `
<section class="panel"><h2>${esc(g.label)}</h2>
<p class="lead">${esc(g.blurb)}</p>
<table class="params"><tbody>
${step(uniq.length, 'People scored in this bucket')}
${step(firms, 'Firms they work at')}
${step(atKilled, '&mdash; at a firm a gate killed')}
${step(already, '&mdash; already contacted')}
${step(gone, '&mdash; suppressed or on hold')}
${step(noAuth, '&mdash; no buying or routing authority')}
${step(mine.length, '<b>On the shortlist</b>')}
</tbody></table>
</section>
<section class="panel"><h2>Shortlist in ${esc(g.label)}</h2>
${mine.length ? cards(mine, cfg, d)
  : uniq.length ? `<p class="callout"><b>${uniq.length} people here, none contactable.</b>
${esc(dominant)}</p>
${firmTable}`
  : `<p class="callout"><b>Nobody in this bucket.</b> Either no one here has been scored yet, or
the location that would place them has never been recorded.</p>`}
</section>`);
  }

  // ---- 5. one page per service --------------------------------------------
  for (const page of pages.filter((p) => p.group === 'service')) {
    const sv = page.service;
    const pit = resolveBuyer(cfg, sv.buyer);
    const mine = d.shortlist.filter((p) => p.firm?.package_id === sv.id);
    const price = sv.price_usd ? `$${sv.price_usd.toLocaleString()}`
      : sv.price_usd_month ? `$${sv.price_usd_month.toLocaleString()} / month`
      : sv.rate_usd_hour ? `$${sv.rate_usd_hour} / hour` : 'not priced';
    write(page, sv.name ?? sv.id, `
<section class="panel"><h2>${esc(sv.name ?? sv.id)}</h2>
<p class="lead"><b>${esc(price)}</b>${sv.duration ? `, ${esc(sv.duration)}` : ''}${
      sv.minimum ? `, minimum ${esc(sv.minimum)}` : ''}. <b>Best for:</b> ${
      esc(sv.best_for ?? '—')}.</p>
<table class="params"><tbody>
<tr><td>Seats that buy it</td><td>${(sv.buyer_titles ?? []).map((t) => esc(t)).join(', ') || '—'}</td></tr>
<tr><td>Prospects routed here</td><td><b>${mine.length}</b></td></tr>
<tr><td>Sold under the pitch</td><td>${esc(pit.label ?? pit.name ?? sv.buyer)}</td></tr>
${sv.note ? `<tr><td>Note</td><td>${esc(sv.note)}</td></tr>` : ''}
</tbody></table></section>

<section class="panel"><h2>Who this is sold to</h2>
${mine.length ? cards(mine, cfg, d)
  : `<p class="callout"><b>Nobody in the book routes to this.</b> That is a finding, not an
empty page: you sell this and the pipeline cannot currently find anyone to sell it to. Either
no firm in the book has the shape the selector reads as needing it, or no sector in
<code>sectors.yml</code> is written to look for that shape. The seats that buy it are listed
above &mdash; if none of them appear in the book, discovery is the thing to change, not this
page.</p>`}
</section>

<section class="panel"><h2>The argument it is sold with</h2>
<p class="lead">The pitch is the unit of argument; the service is the unit of money. A note
offers one service, and never a menu, because a note that offers a choice makes the reader do
work they will not do.</p>
<p class="lead"><b>Sells:</b> ${esc(pit.sells ?? '—')}. <b>The buyer's problem:</b>
${esc(pit.buyer_problem ?? '—')}. <b>The seat that buys it:</b> ${esc(pit.buyer_seat ?? '—')}.</p>
<table class="params"><tbody>
<tr><td>Status</td><td>${esc(pit.status)}</td></tr>
<tr><td>Fires when</td><td>${esc((pit.fires_when ?? '').trim())}</td></tr>
<tr><td>Must NOT be used when</td><td>${esc((pit.never_when ?? '').trim())}</td></tr>
<tr><td>Services</td><td>${(pit.services ?? []).map((x) => `<code>${esc(x.id)}</code>`).join(' ') || '— none; this pitch sells nothing —'}</td></tr>
<tr><td>Entry engagement</td><td>${pit.entry_package ? esc(pit.entry_package.id) : '—'}</td></tr>
<tr><td>Citable proof points</td><td>${pit.citable_proof_points.length} of ${pit.proof_points.length}</td></tr>
</tbody></table>
${pit.status === 'untested' ? `<p class="callout"><b>Untested.</b> No outreach on record has
used this pitch. Treat anyone listed above as a hypothesis about who would buy it, not evidence
that anyone will.</p>` : ''}
</section>`);
  }

  // ---- 5b. one page per capability ----------------------------------------
  // WHAT THE WORK IS, and whether anything in the book evidences a need for it.
  // This page answers a question no other page could ask: the service pages say
  // "nobody routes here", which mixes up two different failures — an offer
  // nobody needs, and an offer nobody has been FOUND to need because the trigger
  // that would show it has never fired.
  for (const page of pages.filter((p) => p.group === 'capability')) {
    const c = page.capability;
    const mine = d.shortlist.filter((p) => p.firm?.work_id === c.id);
    const firmsWith = new Set(d.firms.filter((f) => f.work_id === c.id).map((f) => f.org_id));
    const trigs = c.fires_when?.triggers_any ?? [];
    // Which of the triggers that would evidence this capability have EVER
    // fired. A capability with no page and no prospects looks identical to one
    // whose evidence is simply unreachable, and they need different fixes.
    const fired = trigs.length ? db.prepare(
      `SELECT trigger_id, COUNT(*) n FROM signals
        WHERE retracted_at IS NULL AND trigger_id IN (${trigs.map(() => '?').join(',')})
        GROUP BY trigger_id`).all(...trigs) : [];
    const firedIds = new Set(fired.map((r) => r.trigger_id));
    const dead = trigs.filter((t) => !firedIds.has(t));
    const svcs = (c.delivered_by ?? []).map((id) => (cfg.packages ?? []).find((x) => x.id === id))
      .filter(Boolean);
    write(page, c.label ?? c.id, `
<section class="panel"><h2>${esc(c.label ?? c.id)}</h2>
<p class="lead">${esc(c.what_it_is ?? '—')}</p>
<table class="params"><tbody>
<tr><td>What the buyer gets</td><td>${esc(String(c.form ?? '—').replace(/_/g, ' '))}</td></tr>
<tr><td>How it is found</td><td>${evidenceClassesFor(cfg, c).map((e) =>
      `<code>${esc(e)}</code>`).join(', ') || '—'}</td></tr>
<tr><td>Firms whose evidence names it</td><td><b>${firmsWith.size}</b></td></tr>
<tr><td>People on the shortlist</td><td><b>${mine.length}</b></td></tr>
<tr><td>Sold as</td><td>${svcs.map((sv) => `${esc(sv.label ?? sv.id)}`).join(', ') || '—'}</td></tr>
<tr><td>Evidenced by</td><td>${trigs.map((t) => `<code>${esc(t)}</code>${
      firedIds.has(t) ? ` <span class="dim">${fired.find((r) => r.trigger_id === t).n}</span>`
        : ' <span class="dim">never fired</span>'}`).join(' ') || '—'}</td></tr>
</tbody></table>
${dead.length === trigs.length && trigs.length ? (() => {
  // HOW MANY OTHER CAPABILITIES SHARE THIS WALL. A blocked capability read on
  // its own looks like a niche that did not work out; read against its siblings
  // it is one symptom of a single unsolved retrieval problem, and that is what
  // decides whether to spend a day on it.
  const cls = evidenceClassesFor(cfg, c);
  const siblings = (cfg.work ?? []).filter((x) =>
    (x.status ?? 'live') !== 'retired'
    && evidenceClassesFor(cfg, x).some((e) => cls.includes(e)));
  const blocked = siblings.filter((x) => (x.fires_when?.triggers_any ?? []).every((t) =>
    !db.prepare('SELECT COUNT(*) n FROM signals WHERE trigger_id = ? AND retracted_at IS NULL')
      .get(t).n));
  return `<p class="callout"><b>No evidence for this exists in the book, and none ever has.</b>
Every trigger that would name it has fired zero times &mdash; ${
    dead.map((t) => `<code>${esc(t)}</code>`).join(', ')}.
That is a RETRIEVAL result and not a market result: it says nothing about whether anyone wants
this, only that nothing in the book can currently see who does. The fix is a discovery channel
that reaches the evidence, not a change to what you sell.${blocked.length > 1
  ? ` <b>And it is not alone.</b> ${blocked.length} of the ${
    (cfg.work ?? []).filter((x) => (x.status ?? 'live') !== 'retired').length}
  capabilities on the menu are blocked on the same evidence class
  (<code>${esc(cls.join(', '))}</code>): ${blocked.map((x) =>
    `${esc(x.label ?? x.id)}`).join(', ')}. One working channel unblocks all of them, which is
  why that question is worth more than any single one of these pages.` : ''}</p>`;
})() : ''}
</section>

<section class="panel"><h2>Who the evidence says needs this</h2>
${mine.length ? cards(mine, cfg, d)
  : `<p class="callout"><b>Nobody yet.</b> ${dead.length === trigs.length && trigs.length
    ? 'See above &mdash; the evidence that would put someone here has never been retrieved.'
    : 'The triggers have fired, but not at a firm that also clears the gates and has a reachable seat.'}</p>`}
</section>`);
  }

  // The single-page entry point stays where it was, as a redirect.
  writeFileSync(OUT, `<!doctype html><meta charset="utf-8">
<title>Prospect dashboard</title>
<meta http-equiv="refresh" content="0; url=dash/index.html">
<p>Moved to <a href="dash/index.html">dash/index.html</a>.</p>`);
  out.push(OUT);

  // A page this run did not write is a page from a previous shape of the nav,
  // and it does not stop being openable just because nothing links to it any
  // more. Three pitch-*.html files outlived the move from pitches to services
  // and sat in this directory for a day showing a stale ranking, with a card
  // that still said no address was on file for a man whose address had since
  // been worked out. A dashboard generated from a database must not leave
  // yesterday's answer lying next to today's.
  const keep = new Set(out.map((f) => resolve(f)));
  const stale = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => resolve(OUT_DIR, f))
    .filter((f) => !keep.has(f));
  for (const f of stale) unlinkSync(f);
  if (stale.length) {
    console.log(`removed ${stale.length} page(s) this run no longer generates: ` +
      stale.map((f) => f.split('/').pop()).join(', '));
  }
  return out;
}

function tiles(d, cfg) {
  return `<div class="tiles">
${tile({ label: 'Firms in the book', value: String(d.firms.length),
  sub: `${d.live.length} survived the gates`, state: 'good',
  note: 'Every firm with evidence on file. The survivors are the ones no gate has killed.' })}
${tile({ label: 'Writable this week', value: String(d.writable.length),
  sub: `${d.blocked.length} more blocked`, state: d.writable.length ? 'good' : 'bad',
  note: 'Right seat, AND reachable, AND the firm is not inside a cooling period. A blocked ' +
    'candidate is not a weak one — it is a good one with a channel or timing problem.' })}
${tile({ label: 'Dated triggers', value: String(d.signals),
  sub: d.signals ? 'across the whole book' : 'nothing says act this week',
  state: d.signals ? 'good' : 'bad',
  note: d.signals ? 'Dated events giving a reason to write now.'
    : '<b>The binding constraint.</b> Triggers live in press releases and filings, and neither ' +
      'source is built. Without one, every note is sendable to any firm by changing a name.' })}
${tile({ label: 'Profiles needed', value: String(d.needProfile.length),
  sub: 'would change the ranking', state: d.needProfile.length ? 'warn' : 'good',
  note: 'Scores that are provisional until a profile corroborates the title or gives a channel.' })}
${tile({ label: 'API spend, all time', value: `$${d.totalSpend.toFixed(2)}`,
  sub: 'recorded per call in runs', state: 'flat',
  note: 'Sourcing, gating and ranking make no model calls. Only enrich and draft spend.' })}
</div>`;
}

/** Renders the five input files, so the dashboard links back to what produced it. */
/**
 * Every knob the pipeline turns on, with its live value and what re-running costs.
 *
 * A threshold typed into an expression is a judgment the operator cannot see,
 * argue with, or find again six weeks later — and this system is full of
 * judgments: what counts as a fresh appointment, what a third-degree connection
 * is worth, how long to leave a firm alone after writing to it. They belong in
 * config, and they belong on a page, because config nobody reads is barely
 * better than a constant.
 *
 * Grouped by what changing one costs, which is the question actually being asked
 * when someone looks at a number and wonders whether to move it.
 */
/**
 * How a gate decision can be checked, rendered so the three states look different.
 *
 * "I decided this" and "the system decided this and cannot show you why" are not
 * the same claim, and a log that renders them identically cannot be audited. A
 * computed decision links the page it was derived from; the operator's own calls
 * say so; anything computed with nothing behind it is marked in warning colour,
 * because that is a defect rather than a detail.
 *
 * `relationship_stale` is the honest exception: it decides from an outreach row
 * rather than a page, and its reason already carries the date, so it has nothing
 * to link and is not pretending otherwise.
 */
/** What is actually blocking the shortlist, counted from the blockers themselves. */
function blockerTally(d) {
  const t = new Map();
  for (const p of d.blocked ?? []) {
    for (const line of String(p.blockers ?? '').split('\n').filter(Boolean)) {
      const k = /Weak channel/.test(line) ? 'no usable channel — no email on file, no close connection'
        : /contacted/.test(line) ? 'the firm was contacted inside the cooling period'
        : /router, not a buyer/.test(line) ? 'a fresh capability hire, to be reached through rather than sold to'
        : line.slice(0, 70);
      t.set(k, (t.get(k) ?? 0) + 1);
    }
  }
  return [...t].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
}

function checkLabel(g) {
  if (g.seeded || g.run_id === null) return '<span class="prov op">your own call</span>';
  if (g.source_url) {
    return `<a href="${esc(g.source_url)}" target="_blank" rel="noopener">check the source</a>`;
  }
  if (g.gate_id === 'relationship_stale') return '<span class="dim">from the outreach record</span>';
  return '<span class="nosrc">computed, no source on file</span>';
}

function knobsPanel(cfg, targeting) {
  const r = targeting.ranking ?? {};
  const gate = (cfg.gates ?? []).find((g) => g.id === 'capability_already_staffed') ?? {};
  const news = cfg.sources?.news ?? {};
  const row = ([k, v, why]) => `<tr><td><code>${esc(k)}</code></td>
    <td class="num"><b>${esc(String(v))}</b></td><td>${why}</td></tr>`;
  // NO BLURB SLOT. Each group carried a line saying how to re-run it and what
  // that costs -- "Re-run npm run rank. Free." -- which is neither a setting nor
  // a fact about one. The heading names the file and the rows are the settings.
  // The one substantive caveat that lived in a blurb, that the reachability
  // numbers are asserted rather than measured, moved onto the rows it is about.
  const group = (title, file, rows) => `
    <h4>${title} <span class="dim">· ${esc(file)}</span></h4>
    <table class="knobs"><tbody>${rows.map(row).join('')}</tbody></table>`;

  const pct = (o) => Object.entries(o ?? {}).map(([k, v]) =>
    [k, `${Math.round(v * 100)}%`, '']);

  return `<section class="panel"><h2>Parameter settings &mdash; every number the pipeline turns on</h2>

${group('Gates', 'signals.yml', [
  ['fresh_months', gate.fresh_months ?? 12,
   'Months in seat below which a capability hire is the <b>buyer</b> rather than the reason to ' +
   'walk. Above it, the kill is correct. <code>rank</code> reads the same number to cap that ' +
   'person at router authority.'],
  ['capability_titles', (gate.capability_titles ?? []).length + ' titles',
   'The titles that trip this gate at all. ' +
   esc((gate.capability_titles ?? []).slice(0, 4).join(', ')) + '…'],
  ['gates declared', (cfg.gates ?? []).length,
   (cfg.gates ?? []).filter((g) => g.severity === 'kill').length + ' kill, ' +
   (cfg.gates ?? []).filter((g) => g.severity === 'warn').length + ' warn. A gate that cannot ' +
   'be decided from the evidence stays unevaluated rather than passing.'],
])}

${group('Ranking weights', 'sectors.yml', [
  ...pct(r.vertical).map(([k, v]) => [`vertical.${k}`, v, 'Is this thesis worth a week.']),
  ...pct(r.firm).map(([k, v]) => [`firm.${k}`, v, 'Is this firm worth an hour.']),
  ...pct(r.person).map(([k, v]) => [`person.${k}`, v, 'Is this person worth the one shot.']),
])}

${group('Ranking thresholds', 'sectors.yml', [
  ['router_authority_cap', r.thresholds?.router_authority_cap ?? 0.5,
   'A capability hire inside <code>fresh_months</code> scores no higher than this — a router ' +
   'to reach through, not a buyer to sell to.'],
  ['firm_cooling_days', r.thresholds?.firm_cooling_days ?? 21,
   'Do not surface a second person at a firm inside this many days of writing to the first.'],
  ['signature_threshold_usd', r.thresholds?.signature_threshold_usd ?? 5000,
   'At or below this, one person can sign alone. A materially easier sale.'],
  ['committee_threshold_usd', r.thresholds?.committee_threshold_usd ?? 15000,
   'Above this it needs a committee, and the fee-vs-authority score drops.'],
  ['decayed_below', r.thresholds?.decayed_below ?? 0.5,
   'A trigger decayed past this reads as a con rather than a pro. Urgency is not permanent.'],
  ['persona_tier_penalty', r.thresholds?.persona_tier_penalty ?? 0.08,
   'Each step down the persona list costs this much authority, so a firm’s leadership does ' +
   'not tie.'],
])}

${group('Reachability priors', 'sectors.yml', [
  ...Object.entries(r.reachability ?? {}).map(([k, v]) =>
    [k, v, 'Asserted, not measured. Channel strength before activity is applied.']),
  ...Object.entries(r.activity_factor ?? {}).map(([k, v]) =>
    [`activity.${k}`, `×${v}`, 'Multiplies the above. A dormant inbox is not a channel.']),
  ['min_n_for_measured_rate', r.response_likelihood?.min_n_for_measured_rate ?? 40,
   'Below this many outreaches the system refuses to render a response rate as measured. ' +
   'The record currently holds far fewer.'],
])}

${group('Retrieval and models', 'runtime.yml', [
  ['models.default', cfg.models?.default ?? '—', 'Drafting, the discovery judge, and promote.'],
  ['models.cheap', cfg.models?.cheap ?? '—', 'Enrichment and profile extraction.'],
  ['models.grader', cfg.models?.grader ?? '—',
   'Reserved for the unbuilt grader. Deliberately never used in the production path.'],
  ['news.lookback_days', news.lookback_days ?? 365,
   'How far back an event may be dated and still count. Also sets a signal’s decay.'],
  ['news.max_discovery_queries', news.max_discovery_queries ?? 12,
   'Shapes × vocabularies compose faster than a credit budget likes. The run says when it capped.'],
  ['news.max_results', news.max_results ?? 6, 'Results pulled per query before date filtering.'],
  ['icp.revenue_floor_usd', cfg.icp?.revenue_floor_usd ?? '—',
   'Below this a firm is too small for the fee to make sense, and <code>too_small</code> kills it.'],
])}
</section>`;
}

/** A block of config prose, wrapped so a long thesis stays readable. */
function prose(t) {
  const x = String(t ?? '').replace(/\s+/g, ' ').trim();
  return x ? `<p class="dim">${esc(x)}</p>` : '';
}
/** id -> label, for the many places config points at config. */
const tags = (xs) => (xs ?? []).map((x) => `<code>${esc(x)}</code>`).join(' ') || '<span class="dim">—</span>';

function priceOf(sv) {
  return sv.price_usd ? `$${sv.price_usd.toLocaleString('en-US')}`
    : sv.rate_usd_hour ? `$${sv.rate_usd_hour}/hour`
    : sv.price_usd_month ? `$${sv.price_usd_month.toLocaleString('en-US')}/month` : 'not priced';
}

/**
 * THE RECURRING TIERS, which were declared and shown nowhere. `retainers` was
 * read by exactly one line of code — a truthiness check asking "is this priced"
 * — so the monthly price per tier of hours appeared only inside the raw YAML
 * dump at the foot of the page. They are the only recurring revenue on the menu
 * and the only prices that compound, which makes them the last thing that should
 * have been invisible.
 */
function retainersOf(sv) {
  const r = sv.retainers ?? [];
  if (!r.length) return '';
  return `<p class="dim">Retainer: ${r.map((x) => `<b>$${
    Number(x.monthly_usd).toLocaleString('en-US')}/mo</b> for ${x.hours}h`
    + (x.rate_usd_hour ? ` ($${x.rate_usd_hour}/hr)` : '')).join(' &middot; ')}</p>`;
}

function offersConfigPage(cfg) {
  // LIVE FIRST, THEN RETIRED, each by priority. Sorting on priority alone
  // interleaved them — a retired read sat above two live offers because its
  // number had never been changed, and priority on a retired row means nothing
  // anyway. The retired ones stay on the page because the reason they were
  // retired is the most useful thing about them; they just stop being in the way.
  const dead = (x) => ((x.status ?? 'live') === 'retired' ? 1 : 0);
  const byPri = (a, b) => dead(a) - dead(b) || (a.priority ?? 99) - (b.priority ?? 99);
  const svc = [...(cfg.packages ?? [])].sort(byPri);
  const caps = [...(cfg.work ?? [])].sort(byPri);
  return `
<section class="panel"><h2>Packages &mdash; what it costs and how it is bought</h2>
<table class="params"><tbody>
${svc.map((sv) => `<tr><td><b>${esc(sv.label ?? sv.id)}</b><br><span class="dim">${esc(sv.id)}</span></td>
  <td><b>${esc(priceOf(sv))}</b>${sv.duration ? ` <span class="dim">&middot; ${esc(sv.duration)}</span>` : ''}
  ${retainersOf(sv)}
  ${(sv.status ?? 'live') === 'retired' ? ' <span class="ret">RETIRED</span>' : ''}
  ${prose(sv.best_for)}
  ${sv.fires_when ? `<p class="dim">Fires when: ${sv.fires_when.never ? 'never &mdash; ' + esc(sv.fires_when.reason ?? '')
    : [sv.fires_when.triggers_any ? 'any of ' + tags(sv.fires_when.triggers_any) : '',
       sv.fires_when.staffed != null ? `staffed: <code>${sv.fires_when.staffed}</code>` : '',
       sv.fires_when.min_headcount ? `min headcount ${sv.fires_when.min_headcount}` : '',
       sv.fires_when.max_headcount ? `max headcount ${sv.fires_when.max_headcount}` : '',
       sv.fires_when.min_signals ? `at least ${sv.fires_when.min_signals} signals` : ''].filter(Boolean).join(', ')}</p>`
    : ''}
  ${sv.note ? prose(sv.note) : ''}
  <p class="dim">Buyers: ${(sv.buyer_titles ?? []).map(esc).join(', ') || '—'}</p></td></tr>`).join('')}
</tbody></table></section>

<section class="panel"><h2>Work &mdash; what you would actually do</h2>
<table class="params"><tbody>
${caps.map((c) => `<tr><td><b>${esc(c.label ?? c.id)}</b><br>
  <span class="dim">${esc(c.id)}</span><br>
  <span class="dim">${esc(String(c.form ?? '').replace(/_/g, ' '))}${
    ''}</span>${(c.status ?? 'live') === 'retired' ? ' <span class="ret">RETIRED</span>' : ''}</td>
  <td>${prose(c.what_it_is)}
  ${c.technique ? `<p class="dim"><b>Built as:</b> ${esc(String(c.technique).replace(/\s+/g, ' ').trim())}</p>` : ''}
  <p class="dim">Evidenced by ${tags(c.fires_when?.triggers_any)} &middot;
  sold as ${tags((c.delivered_by ?? []).map((id) => (cfg.packages ?? []).find((x) => x.id === id)?.label ?? id))}</p></td></tr>`).join('')}
</tbody></table></section>

<section class="panel"><h2>Buyers &mdash; who buys, and what is wrong</h2>
<table class="params"><tbody>
${[...(cfg.buyers ?? [])].sort((a, b) =>
  (OFF_MENU_P.has(a.status ?? 'live') ? 1 : 0) - (OFF_MENU_P.has(b.status ?? 'live') ? 1 : 0))
  .map((p) => `<tr><td><b>${esc(p.label ?? p.id)}</b><br>
  <span class="dim">${esc(p.id)}</span><br>
  <span class="dim">${esc(p.status ?? 'live')}</span>${
    OFF_MENU_P.has(p.status ?? 'live')
      ? ` <span class="ret">${esc(String(p.status).toUpperCase())}</span>` : ''}</td>
  <td>${prose(p.buyer_problem)}
  ${p.sells ? `<p class="dim"><b>Sells:</b> ${esc(String(p.sells).replace(/\s+/g, ' ').trim())}</p>` : ''}
  <p class="dim">Seat: ${esc(p.buyer_seat ?? '—')}</p>
  ${p.proof_needed ? `<p class="dim">Must be showable: ${
    esc(String(p.proof_needed).replace(/\s+/g, ' ').trim())}</p>` : ''}
  ${p.retired_because ? prose('Retired: ' + p.retired_because) : ''}
  <p class="dim">Services: ${tags((cfg.packages ?? []).filter((x) =>
    (x.buyer === p.id || (x.also_under ?? []).includes(p.id))
    && (x.status ?? 'live') !== 'retired').map((x) => x.label ?? x.id))}</p></td></tr>`).join('')}
</tbody></table></section>
${rawYaml('offers.yml')}`;
}

// WHICH PER-THESIS MONEY FLOORS THE CODE ACTUALLY APPLIES. Checked against the
// source rather than assumed: revenue_floor_usd is read in four files,
// headcount_ceiling in gate.mjs, aum_floor_usd in rank.mjs. `headcount_floor`
// and `ai_spend_floor_usd_month` are read NOWHERE, so a thesis declaring "1,000
// employees and up" is enforced only by the discovery judge reading the thesis
// prose. That works, and it is not what the number implies, so the page says
// which is which instead of printing them all as though they were gates.
// WHICH GATES THE CODE CAN ACTUALLY DECIDE. Read off src/gate.mjs rather than
// assumed, so this cannot drift the way the money floors had. A gate that is
// neither implemented nor marked `decided_by: operator` can never fire, and the
// page says so instead of listing it beside the eight that work.
const GATE_EVALUATORS = new Set(['capability_already_staffed', 'open_req_for_capability',
  'too_big', 'too_small', 'relationship_stale', 'in_house_consulting_arm',
  'marketplace_or_expert_network', 'platform_partner_firm']);

const MONEY_ENFORCED = new Set(['revenue_floor_usd', 'headcount_ceiling', 'aum_floor_usd']);

function sectorsConfigPage(targeting) {
  const vs = targeting.verticals ?? [];
  const row = (v) => `<tr><td><b>${esc(v.name ?? v.id)}</b><br><span class="dim">${esc(v.id)}</span><br>
    <span class="dim">${esc(v.scope ?? 'scope unset')}${v.status ? ` &middot; ${esc(v.status)}` : ''}${
      v.discovery ? ` &middot; discovery ${esc(v.discovery)}` : ''}</span>${
      v.status === 'retired' ? ' <span class="ret">RETIRED</span>' : ''}</td>
    <td>${prose(v.thesis ?? v.retired_because)}
    <p class="dim">Serves <code>${esc(v.serves ?? '—')}</code> &middot;
    shapes: ${(v.firm_shapes ?? []).map((x) => `<code>${esc(x)}</code>`).join(' ') || '—'}</p>
    <p class="dim">Triggers: ${tags((v.triggers ?? []).map((t) => t.id))}</p>
    ${v.money ? `<p class="dim">Money: ${Object.entries(v.money).filter(([k]) => k !== 'why_they_can_pay')
      .map(([k, x]) => `${esc(k)} ${esc(String(x))}${MONEY_ENFORCED.has(k) ? ''
        : ' <span class="ret">not enforced</span>'}`).join(' &middot; ') || '—'}</p>` : ''}
    </td></tr>`;
  const dead = vs.filter((v) => v.status === 'retired');
  const alive = vs.filter((v) => v.status !== 'retired');
  const isLive = (v) => (v.discovery ?? 'active') === 'active';
  const ofScope = (sc) => alive.filter((v) => v.scope === sc);

  // GROUPED BY SCOPE FIRST, discovery state second. The page used to lead with
  // "open" versus "paused", which buried the thing that actually explains the
  // split: every thesis open to discovery is a SITUATION and every parked one
  // is a SECTOR. Those two columns were the finding, and the old grouping cut
  // straight across them.
  // Each row already prints its own scope, status and discovery state, so the
  // panel says nothing on top of them.
  const group = (sc, heading) => {
    const mine = ofScope(sc);
    if (!mine.length) return '';
    const on = mine.filter(isLive);
    const off = mine.filter((v) => !isLive(v));
    return `<section class="panel"><h2>${heading}</h2>
<table class="params"><tbody>${[...on, ...off].map(row).join('')}</tbody></table></section>`;
  };

  return `
${group('situation', 'Situation &mdash; what is happening at the firm')}
${group('sector', 'Sector &mdash; what industry the firm is in')}
${dead.length ? `<section class="panel"><h2>Retired, with the reason &mdash; kept so it is not re-tried</h2>
<table class="params"><tbody>${dead.map(row).join('')}</tbody></table></section>` : ''}
${rawYaml('sectors.yml')}`;
}

function segmentsConfigPage(cfg) {
  const segs = cfg.segments ?? [];
  return `
<section class="panel"><h2>Segments &mdash; who the buyer is, above the sector</h2>
<table class="params"><tbody>
${segs.map((sg) => `<tr><td><b>${esc(sg.label ?? sg.id)}</b><br><span class="dim">priority ${sg.priority ?? '—'}</span></td>
  <td>${prose(sg.hypothesis)}
  <p><b>Reachable:</b> <code>${esc(sg.reachability?.status ?? '?')}</code>
  &nbsp; <b>Value:</b> <code>${esc(sg.value?.status ?? '?')}</code></p>
  ${(sg.reachability?.channels_falsified ?? []).length ? `<p class="dim"><b>Channels tried and
    falsified:</b> ${sg.reachability.channels_falsified.map((c) => esc(c.channel)).join(', ')}</p>` : ''}
  ${sg.reachability?.open_question ? `<p class="dim"><b>Open question:</b>
    ${esc(sg.reachability.open_question.q)}</p>` : ''}</td></tr>`).join('')}
</tbody></table></section>
${(() => {
  // GATHERED FROM THE SEGMENTS, not from a second block. Each question lives
  // beside the reachability or value status it tests; this panel is the
  // at-a-glance view of them, plus the one question no segment owns.
  const rows = [];
  for (const sg of segs) {
    for (const axis of ['reachability', 'value']) {
      const g = sg[axis];
      if (g?.goal) rows.push({ who: sg.label ?? sg.id, axis, ...g });
    }
  }
  if (cfg.whole_book?.goal) rows.push({ who: 'the whole book', axis: null, ...cfg.whole_book });
  if (!rows.length) return '';
  return `<section class="panel"><h2>Goals &mdash; what this project is trying to find out, and what would settle it</h2>
<table class="params"><tbody>${rows.map((r) =>
  `<tr><td><b>${esc(r.who)}</b>${r.axis ? `<br><span class="dim">${esc(r.axis)}</span>` : ''}</td>
   <td>${esc(r.goal)}<p class="dim">Done when: ${esc(r.done_when ?? '—')}</p></td></tr>`).join('')}
</tbody></table></section>`;
})()}
${rawYaml('segments.yml')}`;
}

// TRIGGERS THAT REACH LIVE WORK. Derived from the capability list rather than
// asserted, so the page cannot disagree with the loader's own warning. A `work`
// trigger missing from this set fires and reaches nothing sellable — four of
// them do today, carrying 39 live signals between them.
function workWithLiveCapability(cfg) {
  return new Set((cfg.work ?? [])
    .filter((w) => (w.status ?? 'live') !== 'retired')
    .flatMap((w) => w.fires_when?.triggers_any ?? []));
}

function signalsConfigPage(cfg) {
  const WORK_WITH_LIVE = workWithLiveCapability(cfg);
  const byClass = {};
  for (const t of cfg.triggers ?? []) (byClass[t.evidence_class ?? 'unclassified'] ??= []).push(t);
  return `
<section class="panel"><h2>Gates &mdash; what disqualifies a firm</h2>
<p class="lead">An unknown is not a pass.</p>
<table class="params"><tbody>
${(cfg.gates ?? []).map((g) => `<tr><td><b>${esc(g.id)}</b><br>
  <span class="dim">${esc(g.severity ?? 'kill')}</span>${
    g.decided_by === 'operator' ? '<br><span class="dim">decided by hand</span>'
    : GATE_EVALUATORS.has(g.id) ? ''
    : '<br><span class="ret">not implemented</span>'}</td>
  <td>${prose(g.description)}<p class="dim">Kills if: ${esc(g.kill_if ?? '—')}</p>
  ${g.unless_trigger ? `<p class="dim">Overridden by a live ${tags(g.unless_trigger)}</p>` : ''}
  ${g.exempt_trigger ? `<p class="dim">Ceiling raised to
    <b>${Number(g.exempt_ceiling).toLocaleString('en-US')}</b> when ${tags(g.exempt_trigger)} is live</p>` : ''}</td></tr>`).join('')}
</tbody></table></section>

<section class="panel"><h2>Triggers &mdash; what makes a firm live, grouped by how it is found</h2>
${Object.entries(byClass).map(([cls, ts]) => `<h4>${esc(cls)} <span class="dim">&middot; ${ts.length}</span></h4>
<table class="params"><tbody>${ts.map((t) => `<tr><td><b>${esc(t.id)}</b><br>
  <span class="dim">weight ${t.weight ?? '—'}${t.decay_days ? ` &middot; ${t.decay_days}d` : ''}</span>
  <br><span class="dim">${esc(t.kind ?? 'kind unset')}</span>${
    t.orphaned ? '<br><span class="ret">orphaned</span>'
    : t.kind === 'work' && !WORK_WITH_LIVE.has(t.id)
      ? '<br><span class="ret">work is retired</span>' : ''}</td>
  <td>${prose(t.description)}
  ${(t.not ?? []).length ? `<details class="tbl"><summary>${t.not.length} thing(s) mistaken for
    it</summary>${t.not.map((n) => prose(n)).join('')}</details>` : ''}</td></tr>`).join('')}
</tbody></table>`).join('')}</section>
${rawYaml('signals.yml')}`;
}

function discoveryConfigPage(cfg) {
  return `
<section class="panel"><h2>Mechanisms &mdash; how a prospect arrives, and what it costs</h2>
<table class="params"><tbody>
${(cfg.mechanisms ?? []).map((m) => `<tr><td><b>${esc(m.label ?? m.id)}</b><br>
  <span class="dim">${esc(m.automation)} &middot; ${esc(m.status)}</span></td>
  <td>${m.command ? `<p><code>${esc(m.command)}</code></p>` : ''}
  <p class="dim">Cost: ${esc(m.cost ?? '—')}</p>
  ${m.evidence_classes ? `<p class="dim">Serves ${tags(m.evidence_classes)}</p>` : ''}
  ${prose(m.known_bias ?? m.limitation ?? m.why ?? m.note)}</td></tr>`).join('')}
</tbody></table></section>

<section class="panel"><h2>Closed questions &mdash; do not re-test these</h2>
<table class="params"><tbody>
${(cfg.closed ?? []).map((c) => `<tr><td><b>${esc(c.id)}</b><br>
  <span class="dim">asked ${esc(String(c.asked ?? ''))}</span></td>
  <td><p><b>${esc(c.answer)}</b></p>${prose(c.why)}
  ${c.survives ? prose('What survives: ' + c.survives) : ''}
  ${c.open_instead ? prose('Open instead: ' + c.open_instead) : ''}</td></tr>`).join('')}
</tbody></table></section>

<section class="panel"><h2>Forbidden hosts &mdash; enforced, not reviewed</h2>
<table class="params"><tbody>
${(cfg.forbidden_hosts ?? []).map((h) => `<tr><td><b>${esc(h.host ?? h)}</b></td>
  <td>${prose(h.why)}${h.manual_alternative ? `<p class="dim">Sanctioned route:
  <code>${esc(h.manual_alternative)}</code></p>` : ''}</td></tr>`).join('')}
</tbody></table></section>
${rawYaml('discovery.yml')}`;
}

/** Raw YAML, collapsed, at the foot of a config page. The rendering above it is
 *  the point; this is here so nothing is hidden and the file is one click away. */
/**
 * The file, twice: settings alone, then the whole thing.
 *
 * These configs are more comment than data — offers.yml is 323 comment lines to
 * 294 of settings — because the reasoning belongs next to the setting it
 * explains, and every time this project has moved an explanation away from its
 * subject the two have drifted. So the file stays as it is.
 *
 * But that makes it useless for the one job this block has, which is checking
 * that the tables above match what is on disk. Reading 638 lines to verify
 * thirty rows is not verification. So the default view strips the commentary
 * and shows the settings, which map one-to-one onto the tables; the full text
 * is one toggle further in for when the reasoning is what you want.
 */
function stripComments(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;          // whole-line comment
    // A trailing comment, but only outside quotes — `note: "a # b"` must survive.
    let q = null; let cut = -1;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '#' && i > 0 && /\s/.test(line[i - 1])) { cut = i; break; }
    }
    const kept = (cut >= 0 ? line.slice(0, cut) : line).trimEnd();
    if (kept.trim() || out.at(-1)?.trim()) out.push(kept);   // collapse runs of blanks
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function rawYaml(file) {
  let text = '';
  try { text = readFileSync(resolve(ROOT, 'config', file), 'utf8'); } catch { return ''; }
  const bare = stripComments(text);
  const full = esc(text).split('\n')
    .map((l) => l.trimStart().startsWith('#') ? `<span class="c">${l}</span>` : l).join('\n');
  return `<section class="panel"><h2>The file itself &mdash; settings only, comments stripped</h2>
    <details class="tbl" open><summary>Settings only &mdash;
      ${bare.split('\n').length} lines, comments stripped</summary>
      <pre class="yml">${esc(bare)}</pre></details>
    <details class="tbl"><summary>Everything, including the reasoning &mdash;
      ${text.split('\n').length} lines</summary>
      <pre class="yml">${full}</pre></details></section>`;
}

/**
 * THE INPUTS PAGE IS AN INDEX, NOT A DUMP.
 *
 * It was one page carrying five files of raw YAML, a quarter of a megabyte of
 * it, and the settings it exists to make visible were buried in the comments
 * that explain them. Nothing was findable at a glance, which is the only thing
 * this page is for. Each file now gets a page that RENDERS it, and the raw text
 * stays one click further in.
 */
function inputsPage(cfg, targeting) {
  // A LIST OF FILES, and nothing else. This page used to open with a paragraph
  // about how configuration is organised and carry four summary numbers per
  // file, and neither answered the question it is opened with, which is "what
  // is in offers.yml". That answer is one click away, so the index gets out of
  // the way instead of previewing itself badly.
  // TWO FILES, THEN THE ONES BEING RETIRED.
  const current = [
    ...(existsSync(resolve(ROOT, 'config/business.yml')) ? [['business.yml', 'config-business.html',
      'what your business is and wants: edit this one']] : []),
    ['runtime.yml', 'config-runtime.html', 'how the pipeline runs: models, sources, limits'],
  ];
  const old = [
    ['offers.yml', 'config-offers.html'], ['sectors.yml', 'config-sectors.html'],
    ['segments.yml', 'config-segments.html'], ['signals.yml', 'config-signals.html'],
    ['discovery.yml', 'config-discovery.html'], ['me.yml', 'config-me.html'],
  ];
  // The parameter table lives on runtime.yml's own page. It was here too, which
  // made the index long again for no gain — the same content twice.
  void cfg; void targeting;
  return `<section class="panel"><h2>Configuration</h2>
<ul class="files">${current.map(([f, p, why]) =>
  `<li><a href="${esc(p)}"><b>${esc(f)}</b></a> <span class="dim">${esc(why)}</span></li>`).join('')}</ul></section>
<section class="panel"><h2>Still read, being retired</h2>
<p class="lead">The old ranker and a few stages still read these. Their settings are moving into the
two files above; where both say something, business.yml wins.</p>
<ul class="files">${old.map(([f, p]) => `<li><a href="${esc(p)}">${esc(f)}</a></li>`).join('')}</ul></section>`;
}

const db = openDb();
const cfg = loadConfig();
const targeting = loadTargeting(cfg);
const written = buildAll(db, cfg, targeting);
db.close();
console.log(`wrote ${written.length} pages to data/dash/`);
if (process.argv.includes('--open')) execFile('open', [written[0]]);
