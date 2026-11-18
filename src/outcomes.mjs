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
  const rows = db.prepare(`SELECT o.id, o.channel, o.sent_at, o.status, o.service_pitched, o.warm, o.person_id,
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
    const human = rs.filter((r) => !bounce(r) && r.sentiment !== 'accepted');
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
  const recent = stages(db).filter((p) => p.judged && p.judged >= since);
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
  const seen = new Set();
  const uniq = marks.filter((m) => { const k = `${m.day}|${m.kind}|${m.what}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // The 3s too, as one band: with them, a bar is every new card that day.
  const threes = dayList.map((d) => recent.filter((p) => p.rating === 3 && p.judged === d).length);
  return { days: dayList, series, threes, marks: uniq };
}
