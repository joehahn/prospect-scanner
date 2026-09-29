// Three separate scores, never blended into one.
//
// No LLM. Every number here comes from a formula written below in plain sight,
// so a ranking that looks wrong can be argued with rather than guessed at, and
// re-running costs nothing. That matters more than sophistication at this stage.
//
// The three scores fail independently (§13.2). A firm can be perfectly ranked
// and have no reachable person; a person can be perfectly reachable and unable
// to buy. Collapsing them into one number hides exactly that.
//
// Usage:
//   npm run rank                    rank every org assigned to a live thesis
//   npm run rank -- --vertical id   just one thesis
//   npm run rank -- --explain <org_id>   show every component for one firm

import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig, buyer as resolveBuyer, packageForBuyer, buyerForOrg, capabilityTitles,
  notSalesSql, geoBucketOf, workForFacts, firmIsStaffed,
  titleFitsBuyer } from './config.mjs';
import { loadTargeting, matchPersona } from './targeting.mjs';
import { historyFor, classify } from './suppression.mjs';
import { table, heading, bold, dim, truncate } from './report.mjs';

const DAY_MS = 86_400_000;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const pct = (v) => (v === null || v === undefined ? ' ·' : `${Math.round(v * 100)}`);

// Which evidence sources this system can actually go and read today. Anything
// else is a source the operator must supply by hand, and a thesis
// that depends entirely on unbuilt sources should score low for it.
// WHAT THIS PROJECT CAN ACTUALLY RETRIEVE TODAY. `trigger_frequency` divides a
// thesis's triggers by how many of them a built source can detect, and it is a
// third of the score that decides whether a thesis is worth a week. It read 0
// for EVERY thesis in the book, which made that third of the score say nothing
// and made every thesis look equally undetectable — including the ones with 40
// live signals on record.
//
// The cause was vocabulary, not a missing key. Verticals do declare
// `evidence_sources` on their triggers; they declare "trade press", "press
// release", "council agenda", "job advertisement" — the words a person would
// write — against a set holding three strings none of which anyone had used
// since. Matching is on substrings now, so a new sector can name its sources in
// plain language without first learning a private vocabulary.
//
// A source belongs here when a stage can FETCH it unattended. Tavily reaches
// press, newsrooms, releases, filings and agendas. The hiring channel reaches
// job advertisements and careers pages as of 2026-09-21. `enrich` reaches a
// firm's own site, so leadership and org pages count. What is NOT here is as
// important: a conference bio, an earnings call transcript and a managing
// partner interview are real evidence and nothing here goes and gets one, so a
// thesis resting on them should score as undetectable, because it is.
const SOURCES_BUILT = ['press', 'newsroom', 'press release', 'news page', 'blog',
  'job advertisement', 'job board', 'job posting', 'ats', 'careers page',
  'rfp', 'procurement portal', 'council agenda', 'council minutes',
  'leadership page', 'org chart', 'announcement', 'sec ', 'filing'];
const sourceIsBuilt = (s) => {
  const v = String(s).toLowerCase();
  return SOURCES_BUILT.some((b) => v.includes(b));
};

// ---------------------------------------------------------------------------
// Vertical score: is this thesis worth a week at all.
// ---------------------------------------------------------------------------
function scoreVertical(v, cfg, weights) {
  const icpFloor = cfg.icp?.revenue_floor_usd ?? 1;
  const floor = v.money?.aum_floor_usd ?? v.money?.revenue_floor_usd ?? icpFloor;
  const ratio = floor / icpFloor;
  const money = ratio >= 10 ? 1.0 : ratio >= 2 ? 0.8 : ratio >= 1 ? 0.6 : 0.3;

  // What fraction of this thesis's triggers can be detected without the
  // operator hand-feeding them. This is the number that exposes an untestable
  // thesis, so it is deliberately harsh.
  const triggers = v.triggers ?? [];
  const detectable = triggers.filter((t) =>
    (t.evidence_sources ?? []).some(sourceIsBuilt));
  const trigger_frequency = triggers.length ? detectable.length / triggers.length : 0;

  // PERSON findability, not firm. The two were one field until 2026-09-16 and
  // conflating them scored sectors on the easy half: every sector in this book
  // is firm-findable — the websites name their officers — and almost none is
  // person-findable, which is the half that decides whether a prospect can ever
  // be written to. Scoring on `firm` rated a sector "high" where 6 of 108 named
  // people could be located.
  const findRating = v.findability?.person ?? v.findability?.rating;
  if (!findRating) {
    throw new Error(`${v.id}: findability.person is missing. It used to be ` +
      'findability.rating; renaming it without updating this line would have scored ' +
      'every sector at the default and said nothing. Set high|medium|low|none.');
  }
  const findability = { high: 1.0, medium: 0.6, low: 0.25, none: 0.1 }[findRating];

  const total = money * weights.money
    + trigger_frequency * weights.trigger_frequency
    + findability * weights.findability;

  return { money, trigger_frequency, findability, total,
           detectable: detectable.map((t) => t.id),
           undetectable: triggers.filter((t) => !detectable.includes(t)).map((t) => t.id) };
}

// ---------------------------------------------------------------------------
// Firm score: is this firm worth an hour.
// ---------------------------------------------------------------------------
function scoreFirm(db, org, v, cfg, weights, now) {
  const pros = [];
  const cons = [];

  // -- fit: can they pay --------------------------------------------------
  const floor = v.money?.aum_floor_usd ?? v.money?.revenue_floor_usd
    ?? cfg.icp?.revenue_floor_usd ?? 0;
  const size = org.aum_usd ?? org.revenue_est ?? null;
  let fit;
  let sizeKnown = true;
  if (size === null) {
    fit = 0.5; sizeKnown = false;
    cons.push('Size unknown, so the money floor is unverified — fit is a placeholder, not a finding.');
  } else if (size >= floor) {
    fit = 1.0;
    pros.push(`Clears the thesis money floor: ${usd(size)} against ${usd(floor)}.`);
  } else {
    fit = 0.0;
    cons.push(`Below the thesis money floor: ${usd(size)} against ${usd(floor)}. ` +
      'The too_small gate should kill this.');
  }

  // -- urgency: decayed trigger weight ------------------------------------
  const signals = db.prepare(`
    SELECT s.trigger_id, s.weight, s.detected_at, s.decays_at, e.source_url, e.claim
    FROM signals s LEFT JOIN evidence e ON e.id = s.evidence_id
    WHERE s.org_id = ? AND s.retracted_at IS NULL`).all(org.id);

  const thesisTriggers = new Set((v.triggers ?? []).map((t) => t.id));
  const maxWeight = (v.triggers ?? []).reduce((a, t) =>
    a + (cfg.triggers.find((x) => x.id === t.id)?.weight ?? 0), 0) || 1;

  let urgencyRaw = 0;
  let triggerTotal = 0;
  for (const s of signals) {
    if (!thesisTriggers.has(s.trigger_id)) continue;
    triggerTotal += s.weight;
    const decay = decayFactor(s.detected_at, s.decays_at, now);
    urgencyRaw += s.weight * decay;
    const line = `${s.trigger_id} fired ${s.detected_at}` +
      (decay < K.decayed_below ? ` but has decayed to ${Math.round(decay * 100)}%` : '') +
      (s.source_url ? ` — ${s.source_url}` : '');
    (decay >= K.decayed_below ? pros : cons).push(line);
  }
  const urgency = clamp(urgencyRaw / maxWeight);
  if (!signals.length) {
    cons.push('No dated trigger on record. Nothing here says act now rather than next quarter.');
  }

  // -- fee vs authority: can one person approve this alone -----------------
  const lineIds = [...new Set((v.service_fit ?? [])
    .map((sid) => cfg.packages.find((s) => s.id === sid)?.line).filter(Boolean))];
  // A retired service is kept in the file as a record and must never be proposed
  // OR priced. resolveBuyer already excludes it from entry_package; this did not,
  // so a withdrawn engagement was still setting fee-vs-authority.
  const prices = (v.service_fit ?? [])
    .map((sid) => cfg.packages.find((s) => s.id === sid))
    .filter((s) => s && (s.status ?? 'live') !== 'retired')
    .map((s) => s.price_usd ?? s.price_usd_month ?? (s.rate_usd_hour ? s.rate_usd_hour * 40 : null))
    .filter((p) => p !== null);
  const cheapest = prices.length ? Math.min(...prices) : null;
  const fee_vs_authority = cheapest === null ? 0.5
    : cheapest <= K.signature_threshold_usd ? 1.0
      : cheapest <= K.committee_threshold_usd ? 0.6 : 0.35;
  if (cheapest !== null && cheapest <= K.signature_threshold_usd) {
    pros.push(`Entry engagement is ${usd(cheapest)}, below most signature thresholds — ` +
      'one person can approve it without a committee.');
  } else if (cheapest !== null) {
    cons.push(`Cheapest way in is ${usd(cheapest)}, likely above one signature.`);
  }

  const total = fit * weights.fit + urgency * weights.urgency
    + fee_vs_authority * weights.fee_vs_authority;

  return { fit, sizeKnown, trigger_total: triggerTotal, urgency, fee_vs_authority,
           total, pros, cons, lines: lineIds, cheapest };
}

function decayFactor(detectedAt, decaysAt, now) {
  if (!detectedAt) return 1;
  const start = Date.parse(detectedAt);
  const end = decaysAt ? Date.parse(decaysAt) : start + 365 * DAY_MS;
  if (!Number.isFinite(start) || end <= start) return 1;
  return clamp(1 - (now - start) / (end - start));
}

const usd = (n) => n === null || n === undefined ? 'unknown'
  : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M`
  : `$${n.toLocaleString('en-US')}`;

// ---------------------------------------------------------------------------
// Person score: authority > reachability > warmth, in that order, because the
// operator's own rule is that bench authority outranks hook quality.
// ---------------------------------------------------------------------------
const hasProfileEarly = (db, personId) => db.prepare(`SELECT COUNT(*) c FROM evidence
  WHERE person_id = ? AND provenance = 'operator_supplied'`).get(personId).c > 0;

/**
 * How a channel has actually done, counted from `outreach`.
 *
 * "Answered" is any status that is not silence — an open thread counts, because
 * the question this answers is whether a message reached a person at all, not
 * whether it sold anything. At n=7 the difference between channels is noise and
 * the rationale text says so; what this prevents is a figure drifting out of
 * date in a sentence, which is what happened to InMail's.
 */
const CHANNEL_CACHE = new Map();
// Set once when the config loads. `channelRecord` is reached from deep inside
// scoring, and threading cfg through four frames to answer "is this row a sale"
// would be worse than one module-level that is written exactly once.
let CFG = null;
function channelRecord(db, channel) {
  if (!CHANNEL_CACHE.has(channel)) {
    // Job applications are outreach and are not sales evidence. See `not_sales`
    // in offers.yml — a channel's record must not be graded on notes that asked
    // for work rather than offering it.
    const ns = notSalesSql(CFG);
    const r = db.prepare(
      `SELECT COUNT(*) sent,
              SUM(CASE WHEN status <> 'sent_no_reply' THEN 1 ELSE 0 END) answered
         FROM outreach WHERE channel = ?${ns.sql}`).get(channel, ...ns.params);
    CHANNEL_CACHE.set(channel, { sent: r?.sent ?? 0, answered: r?.answered ?? 0 });
  }
  return CHANNEL_CACHE.get(channel);
}

// Read from signals.yml once per run, never hardcoded: the gate resolves the same
// list through capabilityTitles(cfg), and two copies of it would drift apart the
// first time a title was added to one.
let CAPABILITY_TITLES = [];

// Same rule, same reason. The tenure line belongs to the gate that owns it, and
// this file held a second copy of the number until 2026-09-11.
let TENURE_MONTHS = 12;

// Where the operator sells, from icp.geography. Module-level for the same reason
// the others are: scorePerson does not receive cfg, and a second hardcoded copy
// would drift.
let HOME_GEO = ['US'];
// The towns the operator can drive to. Same mechanism as the country penalty
// and the opposite sign: a contact he can meet over coffee is reachable in a
// way no InMail is, and that is the constraint this whole book is stuck on.
let HOME_METROS = [];
// The tier between the metro and the country. Same substring test, wider net.
let HOME_REGION = [];
const HOME_ALIASES = ['us', 'usa', 'united states', 'u.s.', 'america'];
const inHome = (c) => {
  const v = String(c).toLowerCase();
  return HOME_GEO.map((g) => String(g).toLowerCase()).some((g) =>
    v.includes(g) || (HOME_ALIASES.includes(g) && HOME_ALIASES.some((a) => v.includes(a))));
};

// Every number the ranking turns on, resolved once from config/sectors.yml.
// Nothing below reads a literal: a threshold typed into an expression is a
// judgment the operator cannot see, argue with, or find again six weeks later.
let K = {};
const knobs = (targeting) => ({
  ...{ router_authority_cap: 0.5, firm_cooling_days: 14, signature_threshold_usd: 5000,
       committee_threshold_usd: 15000, decayed_below: 0.5, persona_tier_penalty: 0.08 },
  ...(targeting?.ranking?.thresholds ?? {}),
  outside_home_factor: targeting?.ranking?.outside_home_factor ?? 0.55,
  home_metro_factor: targeting?.ranking?.home_metro_factor ?? 1.25,
  home_region_factor: targeting?.ranking?.home_region_factor ?? 1.10,
  channel_floor: targeting?.ranking?.channel_floor ?? 0.35,
  // FOUR STATES, NOT THREE. `unclear` means a person looked at the profile and
  // could not tell; `unexamined` means nobody looked. Collapsing them scored the
  // 600-odd unread profiles as though every one held full budget authority, and
  // that is the heaviest single lever in the person score (authority is weighted
  // 0.50). The empirical number is not close: across the 50 profiles actually
  // judged — 29 none, 10 owns, 7 influences, 4 unclear — the expected multiplier
  // is 0.451, against the 1.0 the code was handing out for free.
  //
  // This is a BASE RATE over a population, not a response rate, so the
  // n>=40 floor for measured rates is met and it is not the kind of number that rule guards.
  // It is still a prior about a biased sample: these 50 are the people the
  // operator chose to read, which skews toward names that already ranked well —
  // which is exactly the population it is used to score.
  //
  // `unclear` drops off 1.0 for a smaller reason with no data behind it: an
  // examined-but-ambiguous remit scoring identically to a confirmed `owns` makes
  // the judgment worthless in the one case it was added to catch. 0.8 is
  // asserted, sitting between `influences` and `owns`.
  capability_authority: { ...{ owns: 1.0, influences: 0.6, none: 0.15,
                               unclear: 0.8, unexamined: 0.45 },
                          ...(targeting?.ranking?.capability_authority ?? {}) },
  reach: { ...{ verified_email: 0.9, first_degree: 0.85, guessed_email: 0.7,
                second_degree: 0.6, profile_only: 0.45, third_degree: 0.35, nothing: 0.15 },
           ...(targeting?.ranking?.reachability ?? {}) },
  activity: { ...{ unknown: 0.72, dormant: 0.4, low: 0.7, active: 1.0, high: 1.15 },
              ...(targeting?.ranking?.activity_factor ?? {}) },
});

/** Does this title name the capability the operator sells? Same list the gate uses. */
function matchesCapability(_db, title) {
  if (!title) return false;
  const hay = ` ${String(title).toLowerCase()} `;
  return CAPABILITY_TITLES.some((t) => hay.includes(String(t).toLowerCase()));
}

function scorePerson(db, person, org, v, weights, history, today, pitch = null, offer = null) {
  const pros = [];
  const cons = [];
  // Headcount goes in so a persona carrying `buyer_below_headcount` can read it.
  // org may be absent, and an unknown size promotes nobody — see matchPersona.
  const persona = matchPersona(v, person.title, org?.headcount_est ?? null);

  // Base authority from the title, then corroboration from a pasted profile.
  // A title is a claim; the experience section is evidence. Before 2026-08-25
  // this could only ever move up, which scored a job-hunting fractional advisor
  // identically to a CTO seven years in seat.
  const base = persona
    ? { buyer: 1.0, router: 0.5, referral_node: 0.3, blocker: 0.0 }[persona.authority]
    : 0.15;
  const corroboration = { confirmed: 1.0, unclear: 0.7, contradicted: 0.25 }[
    person.role_confirmed] ?? (person.role_confirmed === null && hasProfileEarly(db, person.id)
      ? 0.85 : 1.0);
  // REMIT, not title. The extractor has been writing "likely cannot make
  // technology or AI investments" into decision_role for months and the ranker
  // read none of it, because nothing parses a sentence. Two Chief Operating
  // Officers can be the same word and different jobs: one runs technology, one
  // ran self-storage for twenty-four years, and only the title was being scored.
  //
  // `unclear` is 1.0 deliberately. Most people in the book have no pasted
  // profile, and a page nobody has read is not evidence against them — the same
  // rule the geography penalty follows.
  // `||` and not `??`: the column holds '' as often as NULL, and an empty string
  // was falling past the lookup to the 1.0 default entirely.
  const remitState = person.capability_authority || 'unexamined';
  const remit = K.capability_authority[remitState] ?? 1.0;
  if (persona && remitState === 'unexamined') {
    cons.push('Nobody has judged whether this seat controls spend on this. Scored at ' +
      `${K.capability_authority.unexamined}, the rate at which read profiles turn out to ` +
      'hold the budget, rather than at full authority — being unread is not evidence of ' +
      'authority. Paste the profile and this moves in whichever direction it deserves.');
  } else if (persona && remit < 1.0) {
    cons.push(`Title matches the "${persona.matched}" persona, but the profile says the remit ` +
      `does not: ${person.capability_authority === 'none'
        ? 'he does not control spend on this'
        : 'he is in the room, someone else signs'}${
      person.decision_role ? ` — "${person.decision_role}"` : ''}. Authority scored on what he ` +
      'can decide rather than what he is called.');
  }

  // Persona order is priority. Without this every buyer-matched title scored the
  // same and a whole firm's leadership tied, which is not a ranking.
  const tierPenalty = (persona?.rank ?? 0) * K.persona_tier_penalty;

  // THE FRESH APPOINTEE IS A ROUTER, NOT A BUYER.
  //
  // Two of the operator's own artifacts disagreed about this and both were
  // right about different things. A thesis in sectors.yml says a recently named AI
  // exec makes the FIRM live: mandate open, budget unspent, no team. His
  // hand-entered kill on one consultancy says that same person is "the LEAST likely
  // person to bring in an independent who does the same thing — she is proving
  // her own value", which is about WHO TO WRITE TO.
  //
  // Both hold once they are kept at their own level, which the design requires
  // anyway: the firm score carries the timing, the person score carries the
  // seat. So the appointment keeps firing urgency at the firm and the appointee
  // is demoted here, to the authority of a router — someone worth reaching
  // THROUGH rather than selling to.
  //
  // Note what this is not: evidence. The one attempt on record (outreach #27,
  // a prospect, 2026-08-18) pitched overflow_bench over InMail with no subject
  // and drew silence, against a 77% base rate of silence. It tested a different
  // pitch on the worst channel and settles nothing. This is the operator's
  // judgement, applied at the level where it costs one contact instead of a firm.
  const FRESH_MONTHS = TENURE_MONTHS;
  const freshSeat = person.in_seat_since
    && `${person.in_seat_since}-01` >= new Date(Date.now() - FRESH_MONTHS * 30 * 86_400_000)
      .toISOString().slice(0, 10);
  // A CEILING, not a subtraction. Subtracting 0.5 drove that prospect to 0 —
  // "blocker", worse than the rule claims — because her title matches no persona
  // in the thesis, so her base was 0.15 before the penalty. Capping says what was
  // meant: no more than a router, however the title otherwise scores.
  const capTitle = freshSeat && matchesCapability(db, person.title);
  const ROUTER = K.router_authority_cap;
  if (capTitle) {
    cons.push(`In seat since ${person.in_seat_since}, under ${FRESH_MONTHS} months, holding ` +
      `"${person.title}" — the capability being sold. Scored as a router, not a buyer: ` +
      'someone this new is proving the mandate they were hired for, and an outside opinion ' +
      `on their own patch is the last thing they want. Capped at ${ROUTER} — reach their ` +
      'approver instead. ' +
      'The firm stays live — a fresh appointment means budget and timing; this is about ' +
      'which seat to write to.');
  }

  const scored = clamp(base * corroboration * remit - tierPenalty);
  const authority = capTitle ? Math.min(scored, ROUTER) : scored;
  // SEAT AND EVIDENCE ARE TWO QUESTIONS. `authority` discounts the seat by what
  // is known about the remit, which is right for RANKING and wrong as an
  // eligibility test: the shortlist floor was written to ask "is this a buyer or
  // a router seat", and the remit multiplier silently turned it into "is this a
  // buyer or router seat AND has someone already read the profile".
  //
  // That closed the loop the system runs on. With `unexamined` at 0.45 against a
  // floor of 0.5, the best possible unexamined person -- a perfectly matched
  // buyer title at a surviving firm -- could no longer reach the shortlist at
  // all. And because the "who to paste next" worklist is derived FROM the
  // shortlist, it emptied too: the dashboard could only ever show people whose
  // profiles had already been read by hand, and had no way left to say who to
  // read next. A discount must not act as a disqualifier.
  const seatScored = clamp(base * corroboration - tierPenalty);
  const seat_authority = capTitle ? Math.min(seatScored, ROUTER) : seatScored;
  if (persona) {
    pros.push(`Title matches the "${persona.matched}" persona (${persona.authority})` +
      (persona.note ? ` — ${persona.note.trim().split('\n')[0]}` : ''));
  } else if (person.title) {
    cons.push(`Title "${person.title}" matches no persona in this thesis. ` +
      'Either the wrong person or a persona the thesis is missing.');
  } else {
    cons.push('No title on record. Paste a profile before ranking this seriously.');
  }

  const hasProfile = hasProfileEarly(db, person.id);

  if (person.role_confirmed === 'contradicted') {
    cons.push('Profile CONTRADICTS the title — the page does not support this being a ' +
      'buying seat. Authority scored down accordingly.');
  } else if (person.role_confirmed === 'confirmed') {
    pros.push('Title corroborated by the profile itself' +
      (person.in_seat_since ? `, in seat since ${person.in_seat_since}` : '') + '.');
  }

  // A channel is only as good as whether the recipient reads it. Both of the
  // silent InMails in this record went to profiles with no recent activity.
  const activityFactor = K.activity[person.platform_activity ?? 'unknown']
    ?? K.activity.unknown ?? 1.0;

  // A contact outside where the operator sells is harder to reach and harder to
  // close: no shared working hours, and cross-border procurement on a fixed-price
  // engagement is friction the fee cannot carry. Soft, and only when the country
  // is actually known — an unrecorded location is not evidence of distance.
  // ONE resolution, shared with the dashboard. See geoBucketOf in config.mjs.
  const geo = geoBucketOf({ country: person.country, location: person.location, hq: org?.hq },
    CFG ?? { icp: { geography: HOME_GEO, home_metros: HOME_METROS, home_region: HOME_REGION } });
  const away = geo.away;
  const geoFactor = away ? K.outside_home_factor : 1.0;
  if (away) {
    cons.push(`Based in ${person.country}${person.location && person.location !== person.country
      ? ` (${person.location})` : ''}, outside ${HOME_GEO.join('/')}. ` +
      'Scored down rather than out: at a global firm the right answer is usually a ' +
      'colleague in the home market, not a different firm.');
  }
  const hasAddressForReach = Boolean(person.email)
    || /[\w.+_-]+@[\w.-]+\.[a-z]{2,}/i.test(person.email_guess ?? '');
  const reachBase = person.email ? K.reach.verified_email
    // A pattern guess is a real channel but an unverified one. Scored between a
    // 1st-degree connection and a 2nd, because a bounce costs more than a delay
    // and the operator should verify before spending the note.
    : /[\w.+_-]+@[\w.-]+\.[a-z]{2,}/i.test(person.email_guess ?? '') ? K.reach.guessed_email
    : person.degree === 1 ? K.reach.first_degree
    : person.degree === 2 ? K.reach.second_degree
    : person.degree === 3 ? K.reach.third_degree
    : person.profile_url ? K.reach.profile_only
    : K.reach.nothing;
  // Local beats far, and the person's own location beats the firm's HQ — but
  // the firm's HQ is worth falling back on here in a way it is not for country.
  // A global firm's London partner is not in Chicago; a nine-person Austin shop
  // is in Austin. The note below says which one it used, so a wrong inference
  // is visible rather than baked into a number.
  const placeText = geo.placeText;
  const viaHq = geo.viaHq;

  // ONE resolution feeding both the multiplier and the label the dashboard
  // shows. Deriving them separately is how a page ends up explaining a score
  // with a category the score never used.
  const bucket = geo.bucket;
  const metroFactor = bucket === 'home_metro' ? K.home_metro_factor
    : bucket === 'home_region' ? K.home_region_factor
    : 1.0;
  if (bucket === 'home_metro') {
    pros.push(`In the home metro (${placeText}${viaHq ? ', per the firm\'s HQ' : ''}) — ` +
      'meetable in person, which is the one channel this record has never had to cold-open.');
  } else if (bucket === 'home_region') {
    pros.push(`In the home region (${placeText}${viaHq ? ', per the firm\'s HQ' : ''}) — ` +
      'a drive rather than a flight, and the same working hours.');
  }

  // ACTIVITY DESCRIBES ONE CHANNEL, SO IT MUST ONLY SCORE THAT ONE. This was
  // multiplied in unconditionally, which meant a man with an address on file was
  // marked hard to reach because he does not post on LinkedIn -- two unrelated
  // facts. It is the sharpest at a firm like the wholesale insurance broker
  // where eight of ten named executives have no LinkedIn presence at all: the
  // COO and CFO are on the firm's own leadership page today, they are simply not
  // on that platform, and penalising them for silence on a channel they do not
  // use is measuring the wrong thing. Where the route is an address, LinkedIn
  // activity is not evidence about reachability in either direction.
  const addressRoute = hasAddressForReach;
  const reachability = clamp(
    reachBase * (addressRoute ? 1.0 : activityFactor) * geoFactor * metroFactor);
  if (addressRoute && !person.profile_url) {
    pros.push('No LinkedIn profile on file, which is not a reachability problem here — ' +
      'the route is the address, and an absent profile costs nothing against it. It only ' +
      'means the channel facts on this card cannot be checked that way.');
  }
  if (person.platform_activity === 'dormant') {
    cons.push(`Dormant on LinkedIn${person.followers ? ` (${person.followers} followers, ` +
      `no recent posts)` : ''} — a message here lands in an inbox nobody opens. ` +
      'Reachability scored down; prefer email or a lateral.');
  } else if (person.platform_activity === 'high') {
    pros.push(`Highly active on LinkedIn${person.followers ?
      ` (${person.followers} followers)` : ''} — the channel is genuinely live.`);
  }
  if (person.email) pros.push('Direct email on record — no InMail credit needed.');
  else if (person.email_guess) {
    pros.push(`Address inferred from the firm's pattern: ${person.email_guess}. ` +
      'Unverified — confirm before sending.');
  }
  else if (person.degree === 1) pros.push('First-degree connection: a free LinkedIn message.');
  else if (person.degree >= 3 || (!person.degree && !person.profile_url)) {
    // Counted from the record, not asserted. The hardcoded "0-for-7" here
    // outlived its own correction: ca1eb1c fixed the figure to 1-for-7 in a
    // comment fourteen lines below and left the operator-facing string saying
    // zero. A number typed into a sentence cannot be kept true.
    const im = channelRecord(db, 'linkedin_inmail');
    cons.push('No cheap channel on record. This is a cold InMail' +
      (im.sent ? `, which is ${im.answered}-for-${im.sent} in the outreach history.` : '.'));
  }

  const mine = history.outreach.filter((o) => o.person_id === person.id);
  const best = mine.map((o) => o.status);
  // WARMTH WAS ENTIRELY A FUNCTION OF THIS PIPELINE'S OWN HISTORY, so a person
  // the operator worked with for years before any of this existed scored 0.1 --
  // the coldest value available, identical to a stranger. A CIO who had been his
  // customer came in at WRM 10 and drew the `functional_vp_large_firm` prior of
  // 3%, where the record says a warm reconnect answers at 25%. Placed at 0.6,
  // level with an outreach marked warm, because that is the same claim: a
  // channel that exists before the first message does.
  //
  // STILL TRUE OF THE PLATFORM SIGNALS, fixed 2026-09-22. Everything above
  // needed either an outreach row or a sentence the operator typed, so a
  // second-degree contact who posts weekly -- someone a shared connection can
  // introduce, whose profile shows they read what arrives -- scored 0.10,
  // identical to a stranger at the far end of a 3rd-degree search. Seven public
  // sector names sat at WRM 10 in a row while the board called them all cold.
  //
  // These are deliberately BELOW every judgement above them. A degree is not a
  // relationship: it says a path exists, not that anyone has walked it. Second
  // degree with a used profile is the strongest of the three, because both
  // halves have to be true — a path in, and someone at the other end who opens
  // things. Second degree alone is a path to a profile nobody reads. And an
  // active profile at any degree at least means the message lands somewhere
  // attended, which is more than the floor deserves.
  const secondDegree = (person.degree ?? 9) <= 2;
  const reads = ['active', 'high'].includes(person.platform_activity ?? '');
  const warmth = best.includes('responded_positive') ? 1.0
    : best.some((s) => s === 'open_thread' || s === 'channel_open') ? 0.75
    : mine.some((o) => o.warm) ? 0.6
    : String(person.prior_relationship ?? '').trim() ? 0.6
    : mine.length ? 0.35
    : (secondDegree && reads) ? 0.3
    : secondDegree ? 0.2
    : reads ? 0.15
    : 0.1;
  if (mine.length) {
    cons.push(`Already contacted ${mine.length}x, last ${mine[0].sent_at} ` +
      `via ${mine[0].channel} (${mine[0].status}). No same-channel follow-up.`);
  }


  const total = authority * weights.authority
    + reachability * weights.reachability + warmth * weights.warmth;

  // Referral value is deliberately NOT folded into total. A person can be a
  // correct kill as a buyer and simultaneously the best door in the record.
  const referral = person.referral_value ?? null;
  if (referral !== null && referral >= 0.6) {
    pros.push(`High referral value (${Math.round(referral * 100)}%) — worth an ask ` +
      'even though they are not the buyer.');
  }

  // ---- blockers: reasons not to write THIS WEEK ---------------------------
  // Deliberately NOT folded into the score. Reachability is only 18% of the
  // final number, so an unreachable person with the right title still ranks
  // first — correctly, as an answer to "who is the right person", and uselessly
  // as an answer to "who do I write to". These are the second answer.
  // Would pasting a profile actually change this score? That is the whole
  // point of the flag: it tells the operator which few to go look up. Computed
  // here rather than lower down because the blockers now branch on it.
  const needsProfile = !hasProfile &&
    (!person.title || !person.role_confirmed || (!person.degree && !person.email));

  const blockers = [];
  // A usable address, even a guessed one, is a channel — so it clears the block.
  const hasAddress = Boolean(person.email)
    || /[\w.+_-]+@[\w.-]+\.[a-z]{2,}/i.test(person.email_guess ?? '');
  // A guessed channel is not a channel. Someone whose profile has never been read
  // has no confirmed degree, no known activity and no address — the reachability
  // above is arithmetic over absent values, and it put people nobody had looked
  // at at the top of the shortlist reading as ready to write to. Being
  // unexamined is itself the blocker, whatever the number came out as.
  if (needsProfile && !hasAddress) {
    // SAY WHICH DOCUMENT IS MISSING, not that none is. This text used to read
    // "no profile on file... nobody has looked", and for a conference speaker
    // both halves are false: the agenda was read, it published their LinkedIn
    // URL, and a session abstract is on file. What is missing is narrower --
    // the CHANNEL FIELDS (degree, activity, followers) that only a LinkedIn
    // profile carries. Three separate unblock calls independently reported this
    // as a system defect, citing the operator_profile row by id, and they were
    // right about the wording though the block itself is sound. A blocker that
    // misdescribes itself sends the operator chasing a phantom too.
    const seen = db.prepare(
      'SELECT COUNT(*) c FROM evidence WHERE person_id = ?').get(person.id).c;
    blockers.push(
      `Not assessed — no LinkedIn profile read${seen ? ` (${seen} other record(s) on file)` : ''}. `
      + 'Degree, activity and followers are unset, so the reachability above is arithmetic over '
      + 'values nobody has confirmed — not a finding that he is hard to reach. '
      // NO COMMAND LINE IN THE STORED TEXT. The operator, 2026-09-24: "i would
      // like all code removed from db since I'll never use it". He reads these
      // in the dashboard, not in a terminal, and a command he will never type
      // is noise sitting inside the one sentence explaining why a score is low.
      + 'Paste the profile and the score becomes real.');
  } else if (!hasAddress && !person.profile_url) {
    // NO ROUTE AT ALL. No address and no profile to InMail. This is the only
    // remaining state that is genuinely a blocker rather than a low score.
    blockers.push(
      'No route on file: no address, and no LinkedIn profile to InMail. ' +
      'Find the profile or find one address at the firm — ' +
      'One sweep covers the whole firm at once.');
  } else if (reachability < K.channel_floor && !hasAddress) {
    // A WEAK CHANNEL IS A LOW SCORE, NOT A WALL. This used to be a blocker,
    // which filed 18 people under "right person, wrong week" while the blocker
    // text itself said, in its own words, that InMail was available and nothing
    // stopped him sending one. The section heading and the sentence under it
    // contradicted each other on the same screen. Reachability is already
    // weighted at 0.30 and already ranks these people below someone with an
    // address; saying it twice, once as a number and once as an exile, was the
    // error. It is a con now, where the other judgments about value live.
    //
    // The previous text also asserted "InMail runs 1-for-7 here against 1-for-2
    // by email" as though it were measured. Neither number survives contact with
    // the record: cold InMail is 1-for-10, and cold email is n=1. No rate is
    // quoted here any more .
    cons.push(
      `Weak channel: ${person.degree ? `${person.degree}°` : 'no connection on file'}, ` +
      `${person.platform_activity ?? 'activity unknown'}` +
      `${person.followers != null ? ` (${person.followers} followers)` : ''}, no email. ` +
      'InMail is available and nothing stops you sending one; this is a judgment about ' +
      'value, not a wall. A dormant inbox does make silence uninterpretable — an unread ' +
      'message and a wrong pitch look identical. The cheapest fix is an address: ' +
      'One sweep covers the whole firm at once.');
  }
  // NOTHING TO SELL THEM IS A BLOCKER. The firm-level pitch choice was recorded
  // as a con on the FIRM and nothing was done with it at the person level, so
  // eleven of eighteen writable people -- 61% of the only list that says who to
  // write to today -- sat at firms with no pitch behind them at all. Eight were
  // AI consultancies, correctly classified, whose pitch (overflow_bench) is dead
  // on purpose: there is deliberately nothing to sell them, and they were at the
  // top of the list anyway.
  //
  // A person is not writable when there is no offer. Stated as a blocker with
  // the firm's own reason, so the exit is visible: either the firm kind is wrong
  // or the catalogue has a gap, and both are fixable.
  if (!pitch?.id) {
    blockers.push(`Nothing to sell this firm: ${pitch?.why ?? 'no pitch fits'}. ` +
      'Ranking harder does not fix this — either the firm kind is wrong, or the pitch ' +
      'catalogue has no offer for a firm of this shape. Check config/offers.yml.');
  } else if (person.hiring_for_capability
             && (offer?.service?.never_when_hiring
                 || (CFG?.buyers ?? []).find((b) => b.id === pitch?.id)?.never_when_hiring)) {
    // READ OFF THE BUYER, not only the package. The flag used to live on the
    // senior_capacity PACKAGE while the firm resolved to a build package, so the guard
    // read a field that was not there. The package is still checked, for a
    // package that carries the rule on its own.
    // A CAPACITY OFFER TO SOMEONE RUNNING THAT SEARCH READS AS AN APPLICATION.
    // The rule lived in the pitch's never_when, where the drafter would read it
    // and the router would not, so the board put this offer in front of a CIO
    // who had posted an agentic-platform engineering req the week before.
    // Blocked rather than re-routed: another offer may fit, and silently
    // swapping one would hide that this seat is buying HEADCOUNT right now,
    // which is the single most useful thing known about him.
    blockers.push(`He is publicly recruiting for this: "${
      String(person.hiring_for_capability).slice(0, 110)}". An offer of hours to someone ` +
      'running that search reads as an application, which is the one misread this pitch ' +
      'cannot survive. Sell him something that is not headcount, or wait until the req closes.');
  } else if (!offer?.service?.id) {
    // A PITCH WITHOUT AN OFFER IS STILL NOTHING TO SELL. The blocker above tested
    // the pitch and the pitch alone, so a firm routed to buyers_side with no
    // service matching its evidence passed it and ranked on authority and
    // reachability — which is how a payments CEO reached rank 1 of the shortlist
    // under a heading that said, on his own card, that the offer was a default
    // and not a recommendation.
    blockers.push(`Pitch "${pitch.id}" fits this firm but no OFFER under it does: ` +
      'nothing in the evidence satisfies what any of its services ask for. Until that ' +
      'changes there is no sentence to write. The fix is a trigger this firm can fire, ' +
      'not a better ranking.');
  }

  // WHOSE SEAT BUYS THIS. The firm is routed to a package and the person is
  // picked independently, on authority and reachability, and nothing required
  // the two to agree. Every package declares `buyer_titles` and no code read
  // them, so a Group CFO with three years of quarterly-results posts and no
  // mention of AI in any of them led a filtered shortlist under an offer sold
  // to CTOs and Heads of AI -- while the one seat at that firm holding the AI
  // mandate sat near the bottom, because his title field still read Group Chief
  // Actuary. The drafter caught it and refused; the board had already spent the
  // operator's attention by then.
  //
  // A BLOCKER RATHER THAN A CON, unlike the channel judgment above, and the
  // difference is worth stating: a weak channel means this is the right person
  // and a hard week, so the score is the honest answer. A seat that does not buy
  // this offer means there is no sentence to write to THIS person at all, and
  // ranking them lower would still leave them on the list, above people who can
  // actually buy.
  //
  // Only `=== false`. titleFitsBuyer returns null when the package declares no
  // buyer_titles, which asserts nothing and so contradicts nothing.
  if (offer?.service?.id
      && titleFitsBuyer(person.title, offer.service.buyer_titles) === false) {
    blockers.push(`"${offer.service.label ?? offer.service.id}" is sold to ` +
      `${(offer.service.buyer_titles ?? []).slice(0, 4).join(', ')} and this seat is ` +
      `"${person.title ?? 'unknown'}". The firm fits the offer and this person does not ` +
      'buy it. Find the seat that does, or widen buyer_titles in offers.yml if this one ' +
      'genuinely buys it — the list is the claim about who does, and it is read now.');
  }

  // ELIGIBILITY IS NOT A TRIGGER. `packageForBuyer` falls back to the buyer's
  // leading offer when the evidence names no work at all, and that fallback is
  // right for the FIRM view -- it answers "what would we sell them if we found
  // something" -- and wrong for a name the operator is about to write to. There
  // is no dated fact to open with, so the note has to be built out of the firm
  // passing its gates, and passing a gate is not a reason to hear from a
  // stranger. The drafter says it plainly and refuses: gates tell us the firm
  // is theoretically eligible, eligibility is not a trigger, and there is no
  // honest way to name the problem without inventing one.
  //
  // The blocker below for "no OFFER under this pitch" could never fire on these
  // people, because the fallback had already supplied one.
  if (offer?.basis === 'buyer') {
    blockers.push('No evidence names any work here. The offer was chosen from the buyer ' +
      'alone, because nothing in the record says what this firm needs — so a note would have ' +
      'to be built out of the firm passing its gates, which is not a reason to hear from a ' +
      'stranger. The fix is a trigger this firm can fire, not a better sentence.');
  }

  // SELLS THE TECHNOLOGY, DOES NOT RUN IT. Every live package sells work done on
  // a firm's OWN operations -- a build it will run, hours into a team it employs
  // -- so a seat whose remit is the product the firm ships is not the buyer,
  // whatever its title and whatever its budget. That last clause is why this is
  // not `capability_authority`: a CTO at a chip manufacturer genuinely owns an
  // enormous technology budget, "owns" is the true answer, and every dollar of
  // it goes to what the fabs make. He led the writable list while his own
  // extracted profile facts -- operator-supplied, sitting in `evidence` where
  // rank has never looked -- said "sets external product strategy, not internal
  // technology operations". The drafter read them and refused. The board could
  // not, so the refusal arrived after the operator had already picked him.
  //
  // `both` and `unclear` do not block. An unread page is not evidence of
  // absence, and a seat with real evidence of each is a buyer for one of them.
  // If a productised offer ever joins the catalogue this rule needs revisiting,
  // because it is a statement about what is currently for sale.
  // A SEAT SOMEONE HAS LEFT CANNOT BUY. Fourteen people in the book carry
  // "retired" or "former" in the title -- four of them retired US Army generals
  // -- and one, a retired CIO, reached the WRITABLE list, which is the list of
  // people to write to this week. Authority was scoring the seat and nothing
  // was reading the word beside it.
  //
  // Only where the word governs the CURRENT title. "Former EVP" is the whole
  // title and the seat is gone; a title that merely recites an earlier role
  // after a live one -- "CTO at X, former VP at Y" -- is a person in a job,
  // and `(Ret)` before a live civilian role is a military career, not a
  // vacancy. So the test is anchored to the front, where a title that has
  // lapsed puts the word.
  // Two shapes, and both have to be here. The word at the FRONT means the whole
  // title has lapsed -- "Retired Chief Information Officer", "Former President".
  // A parenthetical marker means the same wherever it sits: "Head of Consulting
  // (RETIRED)", "Lieutenant General, U.S. Army (Ret), Former Director". What
  // neither matches is a live role that merely recites an earlier one after it
  // -- "Chief Technology Officer, former VP at a large vendor" -- which is a person in
  // a job, and the reason this is not a bare search for the word.
  const LAPSED = /^\s*(retired|former|ex-)\b|\(\s*ret(ired)?\b/i;
  if (LAPSED.test(person.title ?? '')) {
    blockers.push(`"${person.title}" is a seat this person has left. Authority here is ` +
      'scored on the title, and the title is a record of what they used to do — nobody buys ' +
      'out of a post they have retired from. If they have since taken a live role, update ' +
      'the title; if they are worth knowing as a route to someone else, set referral_value.');
  }

  // A CHIEF EXECUTIVE OWNS EVERYTHING, INCLUDING THE BACK OFFICE. The remit
  // distinction is a fact about a FUNCTIONAL seat -- this VP owns the product,
  // that one owns enterprise IT -- and it dissolves at the top of the house,
  // where one person owns both. The backfill classified a payments CEO and a
  // telecoms CEO `external` because their firms SELL technology, which is true
  // about the firm and says nothing about what they can buy. Both had been
  // written to the day before, on the operator's own judgment. A rule that
  // contradicts a send he stands behind is wrong about the market, not right
  // about the send -- the same finding that widened buyer_titles this week, and
  // the second time this exact class of seat has been filed as unsellable by a
  // rule that meant something narrower.
  // `president` needs the lookbehind: without it this matched "Senior Vice
  // President" on its last word and exempted the very product CTO the rule was
  // being fixed for, who then read clear on the board while the drafter
  // refused him. A vice president is a functional seat, which is exactly the
  // case this exemption is NOT about.
  const TOP_OF_HOUSE =
    /\b(chief executive|ceo|founder|owner|(?<!vice )president|managing director|chief operating|coo)\b/i;
  if (person.buyer_remit === 'external' && !TOP_OF_HOUSE.test(person.title ?? '')) {
    blockers.push('This seat owns the technology the firm SELLS, not the technology it runs. ' +
      'Every offer on the menu is work done on a firm\'s own operations, so a product or ' +
      'roadmap remit is not the buyer for any of them, whatever the title and whatever the ' +
      'budget. Find the seat that owns internal systems — usually the CIO where this one is ' +
      'the CTO. Set buyer_remit on the person if this reading is wrong.');
  }

  // THE READ SAYS THIS IS NOT THE PERSON TO WRITE TO. Added 2026-09-25: a chief
  // executive was first on the list to write while his own read said he had just
  // appointed someone else to own the mandate the note would pitch. Only the
  // latest read the operator has not rejected counts, and a read that predates
  // the `recipient` field says nothing here, so no one is blocked on an absence.
  //
  // ONLY A STRONG READ BLOCKS. A thin read is the model saying the evidence is
  // too sparse to judge, and "I cannot tell" is not "nothing to sell": a newly
  // named Chief AI Officer at a national retailer was blocked by a thin read
  // answering `nobody` with an empty reason, on the first run of this rule.
  const verdict = db.prepare(`SELECT recipient, better_recipient, in_the_way FROM reads
     WHERE person_id = ? AND confidence = 'strong' ORDER BY id DESC LIMIT 1`).get(person.id);
  // The LATEST read decides, so a strong verdict superseded by a newer thin read
  // no longer blocks either.
  const latestRead = db.prepare(`SELECT confidence, rejected_at FROM reads
     WHERE person_id = ? ORDER BY id DESC LIMIT 1`).get(person.id);
  const rejectedRead = verdict && (latestRead?.rejected_at || latestRead?.confidence !== 'strong');
  if (verdict && !rejectedRead && verdict.recipient === 'someone_else') {
    blockers.push(`The read says the note belongs with someone else: ${
      verdict.better_recipient || 'another person named in the evidence'}. ` +
      'Write to them instead, or reject the read if it is wrong.');
  } else if (verdict && !rejectedRead && verdict.recipient === 'nobody') {
    blockers.push('The read found nothing to offer anyone here' +
      `${verdict.in_the_way ? `: ${String(verdict.in_the_way).slice(0, 220)}` : '.'} ` +
      'Reject the read if it is wrong.');
  }

  // A firm touched days ago cannot take a second note, whoever it goes to. The
  // operator's own rule: two notes into one small firm in a week reads badly.
  const COOL_DAYS = K.firm_cooling_days;
  const lastAtFirm = history.outreach[0];
  if (lastAtFirm) {
    const days = Math.floor((Date.parse(today) - Date.parse(lastAtFirm.sent_at)) / 86_400_000);
    if (days < COOL_DAYS && lastAtFirm.person_id !== person.id) {
      blockers.push(`The firm was contacted ${days} day(s) ago — ${lastAtFirm.person_name ?? '?'} ` +
        `via ${lastAtFirm.channel}, ${lastAtFirm.status}. A second note this soon reads as spray. ` +
        `Wait until ${new Date(Date.parse(lastAtFirm.sent_at) + COOL_DAYS * 86_400_000)
          .toISOString().slice(0, 10)}, or write on a genuinely new channel with new substance.`);
    }
  }

  return { persona, authority, seat_authority, reachability, warmth, total, geo_bucket: bucket,
           pros, cons, referral, blockers,
           needsProfile, hasProfile, contacted: mine.length };
}

/**
 * Which asserted prior applies. NEVER a measured rate: at this volume there is
 * no statistical power and §13.3 requires it be labelled as an assertion.
 */
/**
 * THE BEST CHANNEL ON FILE, not the first one matched. A first-match chain got
 * this backwards on its first run: everyone holding a guessed address priced at
 * 3%, including second-degree contacts who post weekly and for whom the note
 * would obviously go by InMail instead. The operator uses the best route he
 * has, so the prior has to read the best route he has.
 *
 * Returns null when no channel prior is configured, which leaves the seat rules
 * below to answer as they always did.
 */
function bestChannel(person, priors) {
  const options = [];
  if (person.email) options.push('cold_email_verified');
  if (person.email_guess) options.push('cold_email_guess');
  if ((person.degree ?? 9) <= 2
    && ['active', 'high'].includes(person.platform_activity ?? '')) {
    options.push('second_degree_active');
  }
  const live = options.filter((k) => priors?.[k] != null);
  if (!live.length) return null;
  return live.reduce((a, b) => (priors[b] > priors[a] ? b : a));
}

function responsePrior(person, org, s, priors) {
  const t = (person.title ?? '').toLowerCase();
  const head = org.headcount_est;
  let name;
  if (s.warmth >= 0.6) name = 'warm_reconnect';
  // THE CHANNEL IS PART OF THE ODDS AND WAS NOT BEING READ. This function saw
  // the seat and the firm's size and nothing about how the note would actually
  // travel, so a second-degree contact who posts weekly, a county commissioner
  // with a published .gov address and a stranger with a profile URL all priced
  // at cold_inmail 5%. Checked before the title rules because the channel is a
  // harder fact than a job title: an address either exists or it does not.
  //
  // Ordered worst-known-first among the channels so a guessed address cannot
  // borrow the optimism of a verified one. That ordering is the point: an
  // InMail arrives or is visibly refused, while a guess can be swallowed
  // silently and return exactly what being ignored returns.
  else if (bestChannel(person, priors)) name = bestChannel(person, priors);
  else if (/founder|owner|chief executive|\bceo\b/.test(t)) name = 'founder_or_owner';
  else if (head !== null && head <= 25 && s.authority >= 0.9) name = 'small_firm_principal';
  else if (head !== null && head > 200 && /vp|vice president|head of|director/.test(t))
    name = 'functional_vp_large_firm';
  else name = 'cold_inmail';
  return { name, value: priors?.[name] ?? null };
}

// ---------------------------------------------------------------------------
// ONE NAME FOR EACH BLOCK, shared with `unblock`. This lived inside main() as a
// closure until 2026-09-22, when a second stage needed to ask the same question
// — which rule stopped this person — and the only alternative was a second copy
// of these regexes drifting away from these. That is the failure this file
// documents a dozen times over, so the function moved out instead.
//
// It reads the STORED blocker strings, so it works equally on a live row and on
// a `person_scores` row read back later. `blockers` may be an array or the
// newline-joined text the column holds.
export function blockTag(r) {
  const raw = r?.blockers ?? [];
  const bs = Array.isArray(raw) ? raw : String(raw).split('\n').filter(Boolean);
  const first = (re) => bs.find((b) => re.test(b));
  if (first(/ is a seat this person has left/)) return 'seat vacated';
  if (first(/^Not assessed/)) return 'PASTE PROFILE';
  const cooling = first(/^The firm was contacted/);
  if (cooling) return `cooling ${(cooling.match(/Wait until \d{4}-(\d{2}-\d{2})/) ?? [])[1] ?? ''}`.trim();
  if (first(/publicly recruiting/)) return 'hiring for it';
  if (first(/technology the firm SELLS/)) return 'product remit';
  if (first(/ and this seat is /)) return 'wrong seat';
  if (first(/^No evidence names any work/)) return 'no trigger';
  if (first(/^Nothing to sell this firm|but no OFFER under it does/)) return 'no offer';
  if (first(/^No route on file/)) return 'no route';
  return bs.length ? 'blocked' : '';
}

function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }

  const cfg = loadConfig();
  CFG = cfg;
  CAPABILITY_TITLES = capabilityTitles(cfg) ?? [];
  TENURE_MONTHS = Number((cfg.gates ?? [])
    .find((g) => g.id === 'capability_already_staffed')?.fresh_months ?? 12);
  const targeting = loadTargeting(cfg);
  K = knobs(targeting);
  HOME_GEO = cfg.icp?.geography ?? ['US'];
  HOME_METROS = (cfg.icp?.home_metros ?? []).map((m) => String(m).toLowerCase());
  HOME_REGION = (cfg.icp?.home_region ?? []).map((m) => String(m).toLowerCase());
  // Both sets, because only `scan` printed the config ones and `rank` is the
  // stage the operator actually runs. A catalogue defect — a live package no
  // capability can route to — showed as a "0" on a dashboard chip and nowhere
  // else, which reads as a quiet segment rather than a package that cannot be
  // sold.
  for (const w of cfg._warnings ?? []) console.warn(dim(`config warning: ${w}`));
  for (const w of targeting._warnings) console.warn(dim(`targeting warning: ${w}`));

  const db = openDb();
  const runId = startRun(db, 'rank');
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  const live = targeting.live.filter((v) =>
    !args.vertical || args.vertical === true || v.id === args.vertical);

  // Most of the operator's real book is not assigned to a thesis — the theses
  // are hypotheses about where to look NEXT, while the book is who he has
  // already found. Ranking only the assigned ones showed 1 firm out of 14
  // survivors. Orgs without a thesis are scored against a synthetic one built
  // from icp plus every declared trigger: no thesis-specific money floor, no
  // thesis-specific persona list, and the ranking says so rather than pretending.
  const DEFAULT_VERTICAL = {
    id: '(unassigned)',
    name: 'No thesis assigned',
    status: 'hypothesis',
    thesis: 'Scored against icp defaults because this firm is not assigned to a thesis.',
    money: { revenue_floor_usd: cfg.icp?.revenue_floor_usd },
    triggers: cfg.triggers.map((t) => ({ id: t.id, evidence_sources: [] })),
    // Tiered, because pooling every buyer title into one persona made everyone at
    // a firm score identically — seven people at one PE shop tied at the top,
    // including Investor Relations and Compliance. Persona ORDER is priority,
    // and scorePerson decays authority down the list.
    personas: [
      // The seat that owns technology decisions across a portfolio or a company.
      // NOT "Operating Executive": that is the name of a GROUP, not a function,
      // and matching it made a Chief Talent Officer and a Chief Revenue Officer
      // score as buyers for a technology read. Match the function.
      { title_patterns: ['Operating Partner', 'Value Creation', 'Portfolio Operations',
          'Chief Operating Officer', 'COO', 'Chief Technology Officer', 'CTO',
          'Chief Information Officer', 'CIO', 'Chief Digital Officer', 'Chief Data Officer',
          'VP Engineering', 'Head of Technology', 'Head of Engineering',
          'Chief Product Officer'],
        authority: 'buyer',
        note: 'owns technology decisions; the natural reader of a proposal review' },
      // The person who can simply decide, at a firm small enough to have one.
      { title_patterns: ['Managing Partner', 'Founder', 'Co-Founder', 'Owner',
          'Chief Executive Officer', 'CEO', 'President'],
        authority: 'buyer', note: 'can approve without a committee' },
      // Holds budget, reads the fee before the architecture.
      { title_patterns: ['Chief Financial Officer', 'CFO', 'VP Finance'],
        authority: 'buyer', note: 'budget authority; sell the fee, not the architecture' },
      { title_patterns: ['Partner', 'Principal', 'Managing Director', 'Director', 'Head of'],
        authority: 'router', note: 'can route internally; rarely signs alone' },
    ],
    findability: { person: 'medium' },
    service_fit: cfg.packages.map((x) => x.id),
  };

  db.prepare('DELETE FROM scores WHERE run_id IS NULL OR run_id < ?').run(runId);
  db.prepare('DELETE FROM person_scores WHERE run_id IS NULL OR run_id < ?').run(runId);

  const insScore = db.prepare(`
    INSERT INTO scores (org_id, vertical_id, fit, trigger_total, urgency, fee_vs_authority,
                        total, package_id, package_alts, package_basis, package_trigger,
                        work_id, work_trigger, work_alts,
                        work_form, work_evidence,
                        rationale, pros, cons, run_id)
    VALUES (@org, @v, @fit, @tt, @urg, @fee, @total, @svc, @alts, @basis, @strig,
            @cap, @ctrig, @calts, @cform, @cev, @rat, @pros, @cons, @run)`);
  const insPerson = db.prepare(`
    INSERT INTO person_scores (person_id, org_id, vertical_id, authority, seat_authority,
                               reachability, warmth,
                               total, persona_id, persona_match, persona_authority,
                               response_prior, response_prior_name,
                               rationale, pros, cons, blockers, needs_profile, geo_bucket, run_id)
    VALUES (@pid, @org, @v, @auth, @seat, @reach, @warm, @total, @persona, @pmatch, @pauth,
            @prior, @priorName,
            @rat, @pros, @cons, @blockers, @needs, @geo, @run)`);

  const verticalScores = [];
  const firmRows = [];
  const personRows = [];

  for (const v of [...live, DEFAULT_VERTICAL]) {
    const vs = scoreVertical(v, cfg, targeting.ranking.vertical);
    if (v.id !== '(unassigned)') verticalScores.push({ v, vs });

    const orgs = v.id === '(unassigned)'
      ? db.prepare(`SELECT o.* FROM orgs o
          WHERE o.kind IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM org_verticals ov WHERE ov.org_id = o.id)
          ORDER BY o.name`).all()
      // `kind IS NOT NULL` belongs on BOTH branches. It was on the unassigned one
      // only, which is the branch a discovered candidate never takes: `news
      // --discover` writes an org_verticals row for every firm it names, so all
      // sixteen unvetted candidates arrived here and nine of them ranked above
      // a vetted hedge fund on urgency alone, with no kind, no people and no pitch that fits.
      : db.prepare(`SELECT o.* FROM orgs o JOIN org_verticals ov ON ov.org_id = o.id
          WHERE ov.vertical_id = ? AND o.kind IS NOT NULL ORDER BY o.name`).all(v.id);
    if (!orgs.length) continue;

    const history = historyFor(db, orgs.map((o) => o.id));

    for (const org of orgs) {
      const h = history.get(org.id);
      const verdict = classify(h, today);
      const fs = scoreFirm(db, org, v, cfg, targeting.ranking.firm, now);

      // ONE pitch, chosen by what KIND of firm this is — never a menu. The
      // selector lives in config.mjs so the same rule binds rank and draft.
      // A trigger that means someone is being SOLD something tips an end client
      // from build_direct to buyers_side.
      // `capability_leader_recently_named` joined this set on 2026-09-09, at the
      // operator's decision. It is 8 of 15 live signals and the whole of the
      // hedge_fund_ai_ramp thesis, and without it every end client discovery
      // finds showed NONE FITS: the trigger fired, the gates passed, and the
      // ranking had no pitch to offer. A law firm and a life insurer sat
      // there with a dated AI appointment and nothing to say to them.
      //
      // It belongs here on the same logic as the rest. These triggers mean
      // someone is being SOLD something — an RFP, a capital programme, a cost
      // review. A firm that has just put a person in charge of AI is a firm
      // about to receive proposals, which is precisely when a read is worth
      // buying. The seat is new; the vendors already know it exists.
      // SPLIT 2026-09-17. This was one set and one boolean, and the boolean was
      // used EXCLUSIVELY: has an event -> buyers_side, otherwise build_direct.
      // So build_direct received only firms with no event at all, and no
      // condition inside it could ever reference a trigger. Two services died
      // there before the cause was found.
      //
      // The set had also grown past its own name. It was called vendorTriggers
      // and held capability appointments and CoE announcements, which are not
      // vendor events -- they were added, correctly, because a firm that just
      // put someone in charge of AI is about to receive proposals. True, and it
      // is not the only thing true about them: that firm also has a live mandate
      // and NO TEAM, which is a different problem and a different offer.
      //
      // SOMEONE IS SELLING TO THEM -> they need judgment -> buyers_side.
      // THEY DECLARED A PROGRAMME AND NOBODY IS ON IT -> they need hands ->
      // build_direct. The second reading is the one the record supports:
      // a newly appointed AI head is the least likely person to buy an outside
      // read of the thing he was just hired to do, and 11 capacity-shaped notes
      // on this record drew 3 replies against 0 from 11 judgment-shaped ones.
      const sellingTriggers = new Set(['vendor_selection_underway', 'vendor_led_pilot',
        'integrator_engaged', 'published_ai_cost_concern', 'capital_event', 'new_portco']);
      const hasVendorTrigger = db.prepare(
        `SELECT COUNT(*) c FROM signals WHERE org_id = ? AND retracted_at IS NULL
           AND trigger_id IN
         (${[...sellingTriggers].map(() => '?').join(',')})`).get(org.id, ...sellingTriggers).c > 0;

      // DOES THIS FIRM ALREADY EMPLOY THE CAPABILITY? Read from the people on
      // file, not from the gate. The gate reads the firm's public leadership
      // page, which lists the C-suite and by design never lists a CTO's
      // reports -- that is how a betting operator with an AI/ML engineering
      // organisation, a named Data Executive and a named AI Executive came to
      // pass `capability_already_staffed` and get routed the read-the-proposal
      // pitch, which its own CTO is the person who would do the reading.
      // A NAMED SEAT, not a budget holder. `capability_authority = owns` was the
      // first test and it is the wrong one: it says this person controls spend
      // on the thing being sold, which a lone CIO at a firm with no AI staff
      // also does -- and that firm needs someone to build, not an extra pair of
      // hands. The test is whether the firm EMPLOYS the capability, so it reads
      // titles.
      //
      // It reads them more widely than CAPABILITY_TITLES does, because that list
      // is the gate's kill list and every entry on it was added to justify
      // throwing a firm away. The real seats in this book are "AI Executive",
      // "Data Executive" and "Chief Product Officer, Data & AI", none of which
      // that list matches. Widening the kill list to catch them would kill more
      // firms; widening it only here routes them instead.
      const AI_SEAT = /\b(a\.?i\.?|machine[ -]?learning|\bml\b|data science|analytics|data)\b/i;
      // A BOARD SEAT IS NOT STAFF. The first version routed a bank to the
      // capacity pitch on a non-executive director's headline reading "Public
      // Company Board Director | AI & Digital Transformation" -- which is the
      // failure already written down under the `not:` lists,
      // "a board appointment read as an operating hire: a director holds no
      // budget". It holds no team either. "Director of AI" must survive this,
      // so the test is the word board and its relatives, never "director".
      const BOARD_SEAT = /\b(board|non[- ]?exec|\bned\b|trustee|supervisory)\b/i;
      // ONE ANSWER, shared with draft. See firmIsStaffed in config.mjs: it reads
      // the team page, the dated leader-named signal and any recorded builder,
      // because the fact hides in all three and each stage used to ask only the
      // part it happened to know about.
      const staffed = firmIsStaffed(db, org.id, CAPABILITY_TITLES, today);

      const choice = buyerForOrg(cfg, { kind: org.kind, hasVendorTrigger, staffed, org });
      const chosen = choice?.id ? resolveBuyer(cfg, choice.id) : null;
      // Within the chosen pitch, the service the EVIDENCE fits -- not the
      // cheapest one. See packageForBuyer in config.mjs for why that mattered.
      const liveTriggers = new Set(db.prepare(
        `SELECT DISTINCT trigger_id FROM signals WHERE org_id = ? AND retracted_at IS NULL
           AND (decays_at IS NULL OR decays_at > ?)`).all(org.id, today).map((r) => r.trigger_id));
      const triggerCounts = Object.fromEntries(db.prepare(
        `SELECT trigger_id, COUNT(*) n FROM signals WHERE org_id = ? AND retracted_at IS NULL
           AND (decays_at IS NULL OR decays_at > ?) GROUP BY trigger_id`)
        .all(org.id, today).map((r) => [r.trigger_id, r.n]));
      const pick = choice?.id
        ? packageForBuyer(cfg, choice.id, { triggers: liveTriggers, triggerCounts, staffed,
            headcount: org.headcount_est ?? null })
        : null;
      const svc = pick?.service?.id ?? null;
      // CHOSEN FROM EVIDENCE ALONE, and not from `choice` — a capability is a
      // fact about what the firm needs, and stays true whichever pitch the
      // router lands on. It returns null rather than guessing: "we do not know
      // what they need" is a true answer and an invented one is the default
      // dressed as a judgment all over again.
      const cap = workForFacts(cfg, { triggers: liveTriggers, triggerCounts, staffed,
        headcount: org.headcount_est ?? null });
      if (cap) {
        fs.pros.push(`Capability: ${cap.capability.label ?? cap.capability.id}` +
          (cap.trigger ? ` — ${cap.trigger} is live here` : ''));
      }
      if (pick) fs.pros.push(`Service: ${pick.service.id} — ${pick.why}`);
      if (!choice?.id) fs.cons.push(`No pitch fits this firm: ${choice?.why ?? 'unknown'}`);
      else fs.pros.push(`Pitch: ${choice.id} — ${choice.why}`);

      insScore.run({ org: org.id, v: v.id, fit: fs.fit, tt: fs.trigger_total, urg: fs.urgency,
        fee: fs.fee_vs_authority, total: fs.total, svc,
        alts: (pick?.alternatives ?? []).map((a) => `${a.id}|${a.why}`).join('~') || null,
        basis: pick?.basis === 'buyer' ? `buyer:${choice?.why ?? ''}` : (pick?.basis ?? null),
        strig: pick?.trigger ?? null,
        cap: cap?.capability?.id ?? null,
        ctrig: cap?.trigger ?? null,
        calts: (cap?.alternatives ?? []).map((a) => a.id).join('~') || null,
        cform: cap?.form ?? null,
        cev: cap?.evidenceClass ?? null,
        rat: `vertical ${v.id}; line ${fs.lines.join(',') || 'unset'}; pitch ${svc ?? 'none'}`,
        pros: fs.pros.join('\n'), cons: fs.cons.join('\n'), run: runId });

      const people = db.prepare('SELECT * FROM people WHERE org_id = ? ORDER BY name').all(org.id);
      const scored = people.map((p) => {
        const ps = scorePerson(db, p, org, v, targeting.ranking.person, h, today, choice, pick);
        const prior = responsePrior(p, org, ps, targeting.ranking.response_likelihood.priors);
        insPerson.run({ pid: p.id, org: org.id, v: v.id, auth: ps.authority,
          seat: ps.seat_authority, reach: ps.reachability,
          warm: ps.warmth, total: ps.total, persona: ps.persona?.persona_id ?? null,
          pmatch: ps.persona?.matched ?? null, pauth: ps.persona?.authority ?? null,
          prior: prior.value, priorName: prior.name,
          rat: ps.persona ? `matched "${ps.persona.matched}"` : 'no persona match',
          pros: ps.pros.join('\n'), cons: ps.cons.join('\n'),
          blockers: ps.blockers.join('\n'),
          needs: ps.needsProfile ? 1 : 0, geo: ps.geo_bucket, run: runId });
        return { person: p, ...ps, prior };
      }).sort((a, b) => b.total - a.total);

      const kills = db.prepare(
        `SELECT gate_id, outcome, reason FROM gate_results
         WHERE org_id = ? AND outcome LIKE 'kill%'`).all(org.id);
      const warns = db.prepare(
        "SELECT gate_id, reason FROM gate_results WHERE org_id = ? AND outcome = 'warn'").all(org.id);

      firmRows.push({ org, v, fs, verdict, people: scored, kills, warns,
        pitch: choice?.id ?? null, buyerWhy: choice?.why, service: svc });
      // WHETHER THE FIRM IS STILL ALIVE travels with the person. `kills` and the
      // chosen package are known here and were being dropped, so the report below
      // could not tell a prospect worth looking up from one at a firm the gates
      // had already disqualified.
      personRows.push(...scored.map((s) => ({ ...s, org, v,
        firmKilled: kills.length > 0, firmOffer: svc })));
    }
  }

  // ---- report -------------------------------------------------------------
  console.log(heading(`VERTICALS — is the thesis worth a week`));
  console.log(table(verticalScores.map(({ v, vs }) => ({
    id: v.id, status: v.status ?? 'hypothesis',
    money: pct(vs.money), det: pct(vs.trigger_frequency), find: pct(vs.findability),
    total: pct(vs.total),
    note: vs.undetectable.length
      ? `${vs.undetectable.length}/${(v.triggers ?? []).length} triggers need an unbuilt source: ${vs.undetectable.join(', ')}`
      : 'all triggers detectable today',
  })), [
    { key: 'id', label: 'THESIS', width: 26 }, { key: 'status', label: 'STATUS', width: 10 },
    { key: 'money', label: 'MONEY', width: 5, align: 'right' },
    { key: 'det', label: 'DETECT', width: 6, align: 'right' },
    { key: 'find', label: 'FIND', width: 4, align: 'right' },
    { key: 'total', label: 'SCORE', width: 5, align: 'right' },
    { key: 'note', label: 'WHY', width: 74 },
  ]));

  firmRows.sort((a, b) => b.fs.total - a.fs.total);
  console.log(heading(`FIRMS — is this one worth an hour (${firmRows.length})`));
  if (!firmRows.length) {
    console.log('No firms assigned to a live thesis yet.\n  ' +
      'npm run lead -- add-org --name "Firm" --domain firm.com --vertical ' +
      (live[0]?.id ?? 'THESIS'));
  } else {
    console.log(table(firmRows.map((r) => ({
      status: r.verdict.status, org: r.org.name,
      fit: pct(r.fs.fit) + (r.fs.sizeKnown ? '' : '?'),
      urg: pct(r.fs.urgency), fee: pct(r.fs.fee_vs_authority), total: pct(r.fs.total),
      ppl: String(r.people.length),
      kind: r.org.kind ?? '?',
      // READ `r.pitch`, NOT `r.buyer`. The row above stores the chosen buyer as
      // `pitch`; this column asked for `r.buyer`, which no row has ever carried,
      // so every firm in this table printed NONE FITS — 214 of 214 on
      // 2026-09-22 — including firms the router had in fact matched to a live
      // pitch. The routing was never broken; only the report was, and it was the
      // report the operator was reading. Found while asking why a 1,400-person
      // law firm with a live vendor trigger appeared to have nothing to sell it.
      pitch: r.pitch ? `${r.pitch}${r.service ? ` (${r.service})` : ''}` : 'NONE FITS',
      top: r.people[0] ? `${r.people[0].person.name} ${pct(r.people[0].total)}` : '— none —',
    })), [
      { key: 'status', label: 'STATUS', width: 9 }, { key: 'org', label: 'FIRM', width: 32 },
      { key: 'fit', label: 'FIT', width: 4, align: 'right' },
      { key: 'urg', label: 'URG', width: 4, align: 'right' },
      { key: 'fee', label: 'FEE', width: 4, align: 'right' },
      { key: 'total', label: 'SCORE', width: 5, align: 'right' },
      { key: 'ppl', label: 'PPL', width: 3, align: 'right' },
      { key: 'kind', label: 'KIND', width: 13 },
      { key: 'pitch', label: 'PITCH', width: 30 },
      { key: 'top', label: 'BEST CONTACT', width: 30 },
    ]));
    console.log(dim('FIT ? = size unknown, so the money floor is unverified'));
  }

  personRows.sort((a, b) => b.total - a.total);
  if (personRows.length) {
    // WHY THIS ROW CANNOT BE WRITTEN TO TODAY, in one column's worth of words.
    // scorePerson computes a full paragraph per blocker and stores it, and
    // until 2026-09-21 none of it reached this table: a person blocked on a
    // live hiring req and a person ready to write to rendered identically, as
    // a blank cell. Four notes sent in one morning left the table looking
    // exactly as it had before them, and the next name it appeared to offer
    // was a colleague of someone written to an hour earlier. A blocker the
    // operator cannot see is not a rule, it is a surprise waiting in draft.
    // Tags are read back off the stored text rather than recomputed, so this
    // column and the reason behind it cannot drift apart.
    console.log(heading(`PEOPLE — authority first, then reachability (${personRows.length})`));
    console.log(table(personRows.map((r) => ({
      name: r.person.name, org: r.org.name, title: r.person.title ?? '·',
      auth: pct(r.authority), reach: pct(r.reachability), warm: pct(r.warmth),
      total: pct(r.total),
      ref: r.referral === null ? '·' : String(Math.round(r.referral * 100)),
      prior: r.prior.value === null ? '·' : `${Math.round(r.prior.value * 100)}% ${r.prior.name}`,
      // A dead firm's row says so instead of inviting work on it. So does a
      // firm inside its cooling period: that blocker is computed and stored,
      // but until 2026-09-21 it was invisible here, so four notes sent in one
      // morning left this table looking exactly as it had before them and the
      // next name it appeared to offer was a colleague of someone written to
      // an hour earlier. A blocker the operator cannot see is not a rule.
      flag: r.firmKilled ? 'firm killed'
        : r.needsProfile && !r.firmOffer ? 'no offer'
        : blockTag(r) || (r.contacted ? 'contacted' : ''),
    })), [
      { key: 'name', label: 'PERSON', width: 24 }, { key: 'org', label: 'FIRM', width: 22 },
      { key: 'title', label: 'TITLE', width: 34 },
      { key: 'auth', label: 'AUTH', width: 4, align: 'right' },
      { key: 'reach', label: 'RCH', width: 4, align: 'right' },
      { key: 'warm', label: 'WRM', width: 4, align: 'right' },
      { key: 'total', label: 'BUYER', width: 5, align: 'right' },
      { key: 'ref', label: 'REF', width: 3, align: 'right' },
      { key: 'prior', label: 'PRIOR (ASSERTED)', width: 26 },
      { key: 'flag', label: '', width: 14 },
    ]));
    // ONLY WHERE LOOKING WOULD PAY. Reading a profile by hand is the scarcest
    // input this system has — discovery.yml says so in as many words — and this
    // list was spending it on firms the gates had already killed and on firms
    // with no offer to make. Two of its first five were disqualified and the
    // top one had no sellable package, so the most expensive step was being
    // aimed at prospects that could not be sold to whatever the profile said.
    //
    // The suppressed count is printed rather than hidden: a list that quietly
    // drops people is its own kind of lie, and the operator may still want to
    // look one up for reasons this system does not model.
    // ONE ROW PER PERSON. personRows holds a row per person PER VERTICAL, so a
    // firm sitting in two theses listed its people twice — the same name printed
    // back as though it were two jobs to do. Deduped on the best-scoring row,
    // which is the one the rest of the report is about.
    const bestPerPerson = new Map();
    for (const r of personRows) {
      const prev = bestPerPerson.get(r.person.id);
      if (!prev || r.total > prev.total) bestPerPerson.set(r.person.id, r);
    }
    const eligible = [...bestPerPerson.values()]
      .filter((r) => r.needsProfile).sort((a, b) => b.total - a.total);
    const needy = eligible.filter((r) => !r.firmKilled && r.firmOffer);
    const suppressed = eligible.length - needy.length;
    if (needy.length) {
      console.log(`\n${bold('Paste these profiles next')} — it is the only input that ` +
        'changes their score:');
      for (const r of needy.slice(0, 5)) {
        console.log(`  npm run lead -- paste --person ${r.person.id} --url <profile-url> ` +
          `--file profile.txt   ${dim(`# ${r.person.name}, ${r.org.name}`)}`);
      }
    }
    if (suppressed) {
      console.log(dim(`  ${suppressed} more need a profile and are NOT listed: their firm is ` +
        'killed or has no offer, so reading the profile changes nothing you could act on.'));
    }
    console.log(dim('\nPRIOR is an ASSERTED number from config/sectors.yml, not a measured ' +
      `rate. Measured rates need n >= ${targeting.ranking.response_likelihood.min_n_for_measured_rate}; ` +
      `the record currently holds ${(() => {
        const ns = notSalesSql(cfg);
        const c = db.prepare(`SELECT COUNT(*) c FROM outreach WHERE 1=1${ns.sql}`)
          .get(...ns.params).c;
        const all = db.prepare('SELECT COUNT(*) c FROM outreach').get().c;
        return c + (all > c ? ` sales sends (${all - c} more rows are outreach that was not a pitch)` : '');
      })()}.`));
  }

  finishRun(db, runId, { n_in: firmRows.length, n_out: personRows.length, cost_usd: 0 });
  db.close();
}

// RUN ONLY WHEN RUN, not when imported. `unblock` imports blockTag() from this
// file, and a bare main() at module scope meant importing the name re-ranked the
// entire book as a side effect — the report printed above the importing stage's
// own output, and the database was opened twice in one process.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
