// How outreach is landing, from the book as it is. No model, no cost.
//
// The Results page (src/results.mjs) draws from these. Every number is
// computed when the page is built, so the page and the tables never disagree.
//
// WHAT CAN BE COMPARED (2026-11-18). About 480 sends since September: 296
// connection requests with 54 accepts, and 11 human replies across every
// channel. Accept rates can be split by group; reply rates cannot, so replies
// are listed and counted, never turned into a rate per group. Every rate
// carries its count and a 90% range, and a group under MIN_GROUP sends is
// folded into "Other".

import { readFileSync } from 'node:fs';
import { stages } from './funnel.mjs';

export const SEGMENTS = {
  banking_credit: 'Banking and credit',
  insurance: 'Insurance',
  asset_wealth_management: 'Asset and wealth management',
  private_equity_investment: 'Private equity and investment',
  healthcare_life_sciences: 'Healthcare and life sciences',
  energy_utilities: 'Energy and utilities',
  manufacturing_industrials: 'Manufacturing and industrials',
  logistics_transportation: 'Logistics and transportation',
  construction_engineering: 'Construction and engineering',
  technology: 'Technology and software',
  professional_services: 'Professional services',
  retail_consumer: 'Retail and consumer',
  public_sector_education: 'Public sector and education',
  other: 'Other',
};

export const CHANNELS = {
  linkedin_connect_note: 'Connection request',
  linkedin_message: 'LinkedIn message',
  linkedin_inmail: 'InMail',
  email: 'Email',
  linkedin_conversation: 'LinkedIn conversation',
};

/** Days a send must be old before its accept or reply counts. */
export const MATURE_DAYS = 14;
/** Fewest sends a group needs to be shown on its own. */
export const MIN_GROUP = 15;

/** 90% Wilson interval for k of n, as [lo, hi] fractions. */
export function wilson(k, n, z = 1.645) {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// Function first, so "Chief Financial Officer" is finance and a bare "CEO" is
// the executive bucket.
// PE operating partners come first: "Operating Partner, Finance" is a
// portfolio seat, not a finance one, and they are one of the main audiences.
const FUNCTIONS = [
  ['PE operating partners', /operating (partner|principal|executive)|portfolio (operations|partner)|resource partner|value creation|\bai operating/],
  ['Supply chain and procurement', /supply chain|procure|sourcing|purchas|logistic|materials|expedit|vendor|inventory|planning/],
  ['Finance', /financ|\bcfo\b|controller|accounting|treasur|fp&a|audit|\btax\b/],
  ['IT, data and AI', /\bcio\b|\bcto\b|\bcdo\b|\bcaio\b|information|technolog|\bit\b|data|digital|\bai\b|artificial|analytic|innovation|software|automation/],
  ['Operations', /operat|\bcoo\b|plant|manufactur|maintenance|asset|production|quality|engineering|reliab/],
  ['Risk, legal and compliance', /risk|complian|legal|counsel|underwrit|claims|actuar/],
  ['Strategy and transformation', /strateg|transformation/],
  ['Sales and growth', /sales|\bgtm\b|revenue|commercial|marketing|growth/],
  ['Executive and owners', /\bceo\b|chief executive|chancellor|president|founder|owner|partner|principal|managing director|chair|general manager|executive director|\bmd\b/],
];

/** {func, level} bucketed from a title, in code. */
export function roleOf(title) {
  const t = String(title ?? '').toLowerCase();
  const func = FUNCTIONS.find(([, re]) => re.test(t))?.[0] ?? 'Other';
  const level = /\bchief\b|\bc[a-z]{1,2}o\b|president|founder|owner|managing partner|general partner|\bchair|chancellor/.test(t) && !/vice president|\bvp\b/.test(t)
    ? 'C-suite and owners'
    : /vice president|\b[sea]?vp\b|head of|\bhead,|managing director/.test(t) ? 'VP and head of'
      : /partner|principal|operating executive/.test(t) ? 'Partner and principal'
        : /director/.test(t) ? 'Director' : 'Other';
  return { func, level };
}

const ACCEPTED_STATUS = new Set(['accepted', 'responded_positive', 'responded_negative', 'open_thread']);
const REPLIED_STATUS = new Set(['responded_positive', 'responded_negative', 'open_thread']);
const POSITIVE_STATUS = new Set(['responded_positive', 'open_thread']);

const median = (xs) => { const c = [...xs].sort((a, b) => a - b); return c[Math.floor(c.length / 2)]; };
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA');

/**
 * One row per send (seeded history left out): channel, offer, segment, role,
 * the judge's rating when it went, and what came back.
 */
export function sends(db) {
  const rows = db.prepare(`SELECT o.id, o.channel, o.sent_at, o.status, o.service_pitched, o.warm, o.person_id, o.org_id,
      p.name, p.title, g.name AS org_name, g.segment
    FROM outreach o LEFT JOIN people p ON p.id = o.person_id LEFT JOIN orgs g ON g.id = o.org_id
    WHERE o.seeded = 0 AND o.sent_at IS NOT NULL ORDER BY o.sent_at`).all();
  const resp = new Map();
  for (const r of db.prepare('SELECT outreach_id, sentiment, outcome, responded_at FROM responses').all()) {
    if (!resp.has(r.outreach_id)) resp.set(r.outreach_id, []);
    resp.get(r.outreach_id).push(r);
  }
  const judged = new Map();
  // The judge's table is made by the judge stage, so a new book may not have it.
  const hasJudgments = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'judgments'`).get();
  for (const j of hasJudgments ? db.prepare(`SELECT person_id, batch, compelling, created_at FROM judgments
      WHERE compelling IS NOT NULL ORDER BY batch`).all() : []) {
    if (!judged.has(j.person_id)) judged.set(j.person_id, []);
    judged.get(j.person_id).push(j);
  }
  const matureBy = daysAgo(MATURE_DAYS);
  return rows.map((o) => {
    const rs = resp.get(o.id) ?? [];
    const bounce = (r) => r.sentiment === 'bounced' || /bounced|undeliverable/i.test(r.outcome ?? '');
    // Latest first: the reply that says where things stand, not the first one.
    const human = rs.filter((r) => !bounce(r) && r.sentiment !== 'accepted')
      .sort((a, b) => String(b.responded_at).localeCompare(String(a.responded_at)));
    // The judge's rating when the send went: the middle of its latest batch
    // made on or before that day.
    const js = (judged.get(o.person_id) ?? []).filter((j) => j.created_at.slice(0, 10) <= o.sent_at);
    const lastBatch = js.at(-1)?.batch;
    const rating = lastBatch == null ? null : median(js.filter((j) => j.batch === lastBatch).map((j) => j.compelling));
    const bounced = o.status === 'bounced' || rs.some(bounce);
    return {
      ...o,
      offer: o.service_pitched || null,
      ...roleOf(o.title),
      rating,
      mature: o.sent_at <= matureBy,
      bounced,
      accepted: o.channel === 'linkedin_connect_note' && (ACCEPTED_STATUS.has(o.status) || rs.some((r) => r.sentiment === 'accepted')),
      // A bounce is never a reply, whatever the status says: one send bounced
      // twice was recorded as a negative response.
      replied: !bounced && (REPLIED_STATUS.has(o.status) || human.length > 0),
      positive: !bounced && (POSITIVE_STATUS.has(o.status) || human.some((r) => r.sentiment === 'positive')),
      replied_at: human[0]?.responded_at ?? null,
      reply_note: human[0]?.outcome ?? null,
      reply_sentiment: human[0]?.sentiment ?? (POSITIVE_STATUS.has(o.status) ? 'positive' : null),
    };
  });
}

/**
 * k of n per group, with a 90% range. Groups under `min` are folded into one
 * "Other" row; null keys count as "Other" too.
 */
export function rates(rows, keyOf, hit, { min = MIN_GROUP, label = (k) => k } = {}) {
  const by = new Map();
  for (const r of rows) {
    const k = keyOf(r) ?? null;
    const g = by.get(k) ?? { key: k, n: 0, k: 0 };
    g.n++; if (hit(r)) g.k++;
    by.set(k, g);
  }
  const big = []; const rest = { key: null, label: 'Other', n: 0, k: 0, folded: 0 };
  for (const g of by.values()) {
    if (g.key != null && g.n >= min && label(g.key) !== 'Other') big.push({ ...g, label: label(g.key) });
    else { rest.n += g.n; rest.k += g.k; rest.folded++; }
  }
  big.sort((a, b) => b.k / b.n - a.k / a.n || b.n - a.n);
  const out = rest.n ? [...big, rest] : big;
  return out.map((g) => ({ ...g, rate: g.n ? g.k / g.n : 0, range: wilson(g.k, g.n) }));
}

/**
 * Each judged person's target and current rating, from their latest judgment
 * batch: the target most of its runs named, and the middle rating. A person
 * whose judge named no target maps to null.
 */
export function personTargets(db) {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'judgments'`).get();
  if (!has) return new Map();
  const rows = db.prepare(`SELECT person_id, batch, target, compelling, created_at FROM judgments j
      WHERE batch = (SELECT MAX(batch) FROM judgments x WHERE x.person_id = j.person_id)`).all();
  const first = new Map(db.prepare(`SELECT person_id, MIN(created_at) t FROM judgments GROUP BY person_id`).all()
    .map((r) => [r.person_id, r.t]));
  const by = new Map();
  for (const r of rows) (by.get(r.person_id) ?? by.set(r.person_id, []).get(r.person_id)).push(r);
  const out = new Map();
  for (const [id, rs] of by) {
    const count = {};
    for (const r of rs) if (r.target) count[r.target] = (count[r.target] ?? 0) + 1;
    const target = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const cs = rs.map((r) => r.compelling).filter((c) => c != null).map(Number);
    out.set(id, { target, rating: cs.length ? median(cs) : null,
      firstJudged: new Date(first.get(id)).toLocaleDateString('en-CA') });
  }
  return out;
}

/**
 * New cards per target: people first judged in the last `days` days whose
 * current rating is 3 or more, split into 3s and 4-5s. Sorted by total.
 */
export function targetCards(db, days = 30) {
  const since = daysAgo(days - 1);
  const by = new Map();
  for (const p of personTargets(db).values()) {
    if (p.firstJudged < since || !(p.rating >= 3)) continue;
    const k = p.target ?? null;
    const g = by.get(k) ?? { target: k, threes: 0, top: 0 };
    if (p.rating >= 4) g.top++; else g.threes++;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => (b.top + b.threes) - (a.top + a.threes));
}

/**
 * New cards per target per week (Monday start), for the last `weeks` weeks:
 * people first judged that week who are rated 3 or more now, filed under the
 * target of their latest judgment. {weeks, rows: [{target, cells: [{all, top}]}]}.
 */
export function targetWeekly(db, weeks = 8) {
  const thisWeek = weekOf(daysAgo(0));
  const list = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(`${thisWeek}T12:00:00`); d.setDate(d.getDate() - 7 * i);
    list.push(d.toLocaleDateString('en-CA'));
  }
  const by = new Map();
  for (const p of personTargets(db).values()) {
    if (!(p.rating >= 3)) continue;
    const i = list.indexOf(weekOf(p.firstJudged));
    if (i < 0) continue;
    const k = p.target ?? null;
    const row = by.get(k) ?? { target: k, cells: list.map(() => ({ all: 0, top: 0 })) };
    row.cells[i].all++; if (p.rating >= 4) row.cells[i].top++;
    by.set(k, row);
  }
  const total = (r) => r.cells.reduce((a, c) => a + c.all, 0);
  return { weeks: list, rows: [...by.values()].sort((a, b) => total(b) - total(a)) };
}

/**
 * Per industry: firms the judge has rated anyone at, how many of them have a
 * card (someone rated 3 or more now), and how many a 4 or 5. Firms with no
 * segment yet are counted as unlabelled. Sorted by firms judged.
 */
export function industryYield(db) {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'judgments'`).get();
  if (!has) return [];
  const orgOf = new Map(db.prepare('SELECT DISTINCT person_id, org_id FROM judgments').all().map((r) => [r.person_id, r.org_id]));
  const seg = new Map(db.prepare('SELECT id, segment FROM orgs').all().map((r) => [r.id, r.segment]));
  const best = new Map();
  for (const [pid, p] of personTargets(db)) {
    const o = orgOf.get(pid);
    if (o) best.set(o, Math.max(best.get(o) ?? 0, p.rating ?? 0));
  }
  const by = new Map();
  for (const [o, r] of best) {
    const k = seg.get(o) ?? null;
    const g = by.get(k) ?? { segment: k, firms: 0, card: 0, top: 0 };
    g.firms++; if (r >= 3) g.card++; if (r >= 4) g.top++;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => b.firms - a.firms);
}

/** Connection requests old enough to have been accepted. */
export const matureRequests = (rows) => rows.filter((r) => r.channel === 'linkedin_connect_note' && r.mature);

/** Per channel: sent, bounced, delivered, mature, accepted, replied, positive. */
export function channelScores(rows) {
  const by = new Map();
  for (const r of rows) {
    const c = by.get(r.channel) ?? { channel: r.channel, label: CHANNELS[r.channel] ?? r.channel,
      sent: 0, bounced: 0, mature: 0, accepted: 0, replied: 0, positive: 0, warm: 0 };
    c.sent++;
    if (r.bounced) c.bounced++;
    if (r.warm) c.warm++;
    if (r.mature && !r.bounced) {
      c.mature++;
      if (r.accepted) c.accepted++;
      if (r.replied) c.replied++;
      if (r.positive) c.positive++;
    }
    by.set(r.channel, c);
  }
  return [...by.values()].sort((a, b) => b.sent - a.sent)
    .map((c) => ({ ...c, replyRange: wilson(c.replied, c.mature), acceptRange: wilson(c.accepted, c.mature) }));
}

/**
 * Per channel a conversation STARTED on: people whose first send went that
 * way, and how many ever wrote back, on any later send. Counted by person.
 *
 * WHY BY PATH (2026-11-18). Counted by send, a connection request that was
 * accepted and then answered on the follow-up message showed up as a reply to
 * "LinkedIn message", and connection requests looked like they almost never
 * drew a reply (3 of 211) when 6 of the 8 people who ever replied came in
 * through one. The decision the chart informs is where to start.
 *
 * A request's reply counts only after an accept, which is how every one so far
 * has gone ("accepted, then replied"). A person whose first send bounced is
 * left out, as is one whose first send is under MATURE_DAYS old.
 */
export function paths(rows) {
  const byPerson = new Map();
  for (const r of rows) {
    const k = r.person_id ?? `o${r.id}`;
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(r);
  }
  const by = new Map();
  for (const rs of byPerson.values()) {
    rs.sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id - b.id);
    const first = rs[0];
    const c = by.get(first.channel) ?? { channel: first.channel, label: CHANNELS[first.channel] ?? first.channel,
      people: 0, bounced: 0, mature: 0, accepted: 0, replied: 0 };
    by.set(first.channel, c);
    c.people++;
    if (first.bounced) { c.bounced++; continue; }
    if (!first.mature) continue;
    c.mature++;
    const isRequest = first.channel === 'linkedin_connect_note';
    if (isRequest && first.accepted) c.accepted++;
    if (rs.some((r) => r.replied) && (!isRequest || first.accepted)) c.replied++;
  }
  return [...by.values()].sort((a, b) => b.people - a.people)
    .map((c) => ({ ...c, replyRange: wilson(c.replied, c.mature), acceptRange: wilson(c.accepted, c.mature) }));
}

/** Monday of the week a date falls in, as YYYY-MM-DD. */
export function weekOf(day) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toLocaleDateString('en-CA');
}

/** Per week sent: sends by channel, and how many of them were accepted or replied. */
export function weekly(rows) {
  const by = new Map();
  for (const r of rows) {
    const w = weekOf(r.sent_at);
    const x = by.get(w) ?? { week: w, sent: 0, byChannel: {}, accepted: 0, replied: 0 };
    x.sent++; x.byChannel[r.channel] = (x.byChannel[r.channel] ?? 0) + 1;
    if (r.accepted) x.accepted++;
    if (r.replied) x.replied++;
    by.set(w, x);
  }
  // From the first week with five or more sends: the weeks before are hand
  // tests, not a pace.
  const ws = [...by.values()].sort((a, b) => a.week.localeCompare(b.week));
  const start = ws.findIndex((w) => w.sent >= 5);
  return start < 0 ? ws : ws.slice(start);
}

// Stages that run once a week, and the one every weekday run starts with.
// (The conference finder runs every weekday since 2026-10-02, so it is not marked.)
const WEEKLY_STAGES = { 'queries-run': 'weekly searches', events: 'weekly conference agendas' };
const DAILY_STAGE = 'screen';

/**
 * Per local day over the last `days`: people judged that day who now rate 4 or
 * 5, by where they were found, and those who rate 3; plus what ran (weekly jobs), what failed, and
 * weekdays the morning run never started.
 */
export function inboundDaily(db, days = 60) {
  const since = daysAgo(days - 1);
  // As rated that day, so a later re-judge does not rewrite a past bar.
  const recent = stages(db).filter((p) => p.judged && p.judged >= since)
    .map((p) => ({ ...p, rating: p.ratingThen ?? p.rating }));
  const top = recent.filter((p) => p.rating >= 4);
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(daysAgo(i));
  const sources = new Map();
  for (const p of top) sources.set(p.source, (sources.get(p.source) ?? 0) + 1);
  const named = [...sources.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s]) => s);
  const series = [...named, 'other sources'].map((s) => ({ source: s, counts: dayList.map(() => 0) }));
  for (const p of top) {
    const i = dayList.indexOf(p.judged);
    if (i < 0) continue;
    (series.find((x) => x.source === p.source) ?? series.at(-1)).counts[i]++;
  }
  const local = (iso) => new Date(iso).toLocaleDateString('en-CA');
  const runs = db.prepare(`SELECT stage, started_at, ended_at FROM runs WHERE started_at >= ?`)
    .all(new Date(Date.now() - days * 86_400_000).toISOString());
  const marks = [];
  for (const r of runs) {
    if (WEEKLY_STAGES[r.stage]) marks.push({ day: local(r.started_at), kind: 'weekly', what: WEEKLY_STAGES[r.stage] });
    const stale = Date.now() - new Date(r.started_at).getTime() > 6 * 3_600_000;
    if (!r.ended_at && stale && (r.stage === DAILY_STAGE || r.stage === 'judge' || r.stage === 'conferences-find' || WEEKLY_STAGES[r.stage])) {
      marks.push({ day: local(r.started_at), kind: 'failed', what: `${r.stage} did not finish` });
    }
  }
  const ranOn = new Set(runs.filter((r) => r.stage === DAILY_STAGE).map((r) => local(r.started_at)));
  const firstRun = [...ranOn].sort()[0];
  for (const d of dayList) {
    const wd = new Date(`${d}T12:00:00`).getDay();
    if (firstRun && d > firstRun && wd >= 1 && wd <= 5 && !ranOn.has(d) && d < daysAgo(0)) {
      marks.push({ day: d, kind: 'missed', what: 'morning run did not run' });
    }
  }
  // A new judge version is marked on its day: the bars after it are rated by
  // different rules. Read from the version notes at the top of its prompt.
  try {
    const judgeMd = readFileSync(new URL('../prompts/judge.md', import.meta.url), 'utf8');
    for (const m of judgeMd.matchAll(/^\*v(\d+), (\d{4}-\d{2}-\d{2})/gm)) {
      if (dayList.includes(m[2])) marks.push({ day: m[2], kind: 'judge', what: `judge v${m[1]}` });
    }
  } catch { /* no prompt file: no marks */ }
  const seen = new Set();
  const uniq = marks.filter((m) => { const k = `${m.day}|${m.kind}|${m.what}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // The 3s too, as one band: with them, a bar is every new card that day.
  const threes = dayList.map((d) => recent.filter((p) => p.rating === 3 && p.judged === d).length);
  return { days: dayList, series, threes, marks: uniq };
}

/**
 * Per local day over the last `days`: people whose profile was first pasted,
 * first drafted to, and first sent to that day. Where work piles up between
 * the assistant's pasting, drafting and the operator's sending.
 */
export function workDaily(db, days = 30) {
  const ps = stages(db);
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(daysAgo(i));
  const per = (k) => dayList.map((d) => ps.filter((p) => p[k] === d).length);
  return { days: dayList, pasted: per('pasted'), drafted: per('drafted'), sent: per('sent') };
}

// HOW A PERSON WAS FOUND, by the route that found them (2026-11-18). Crediting
// a person to the first record about them hid most searches: a news search
// finds a FIRM, and its people are then read off the firm's staff page, so
// about a thousand people from news searches showed as "firm staff pages",
// mixed with firms added by hand and the bank register. A conference speaker
// and a person added by hand are found as people, so they keep their own row.
const FIRM_ROUTES = [
  [/^conference/, 'Firms from conference agendas'],
  [/^discovered by news/, 'News searches'],
  [/^intake search/, 'Weekly searches'],
  [/^portfolio of/, 'PE portfolio lists'],
  [/^operator/, 'Firms added by hand'],
  [/^FDIC/, 'FDIC bank register'],
  [/^appointments column/, 'Appointments columns'],
  [/^SEC /, 'SEC 8-K filings'],
];
export function routeOf(personSource, firmSource) {
  if (personSource === 'conference agendas') return 'Conference agenda speakers';
  if (personSource === 'added by hand') return 'People added by hand';
  if (personSource === 'public utterance') return 'Weekly searches';
  if (personSource === 'regulatory filing') return 'SEC 8-K filings';
  return FIRM_ROUTES.find(([re]) => re.test(firmSource ?? ''))?.[1] ?? 'Other';
}

/** Per route, over people found in the last `days`: found, rated 3+, sent, accepted, replied. */
export function routeYield(db, days = 60) {
  const since = daysAgo(days);
  const firm = new Map(db.prepare('SELECT p.id, o.source FROM people p JOIN orgs o ON o.id = p.org_id').all().map((r) => [r.id, r.source]));
  const by = new Map();
  for (const p of stages(db).filter((x) => x.found && x.found >= since)) {
    const route = routeOf(p.source, firm.get(p.id));
    const r = by.get(route) ?? { route, found: 0, strong: 0, sent: 0, accepted: 0, replied: 0 };
    r.found++;
    if (p.strong) r.strong++;
    if (p.sent) r.sent++;
    if (p.accepted) r.accepted++;
    if (p.replied) r.replied++;
    by.set(route, r);
  }
  return [...by.values()].sort((a, b) => b.accepted - a.accepted || b.replied - a.replied || b.strong - a.strong || b.found - a.found);
}
