// Loader and validator for config/sectors.yml (once called targeting.yml —
// see the rename note below).
//
// Same contract as config.mjs: errors abort, warnings print. The file is a set
// of hypotheses about where money and urgency coincide, and a dangling trigger
// id or an unknown service id here would silently produce a ranking that scores
// nothing, so both are checked against signals.yml and offers.yml rather than trusted.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Renamed from targeting.yml 2026-08-26: it holds SECTORS, and naming it for
// what it contains keeps the five input files legible as one set.
export const TARGETING_PATH = resolve(ROOT, 'config/sectors.yml');

const STATUSES = ['hypothesis', 'validated', 'retired'];
// WHAT SELECTS A FIRM FOR THIS THESIS, and it is not cosmetic: it decides what
// `firm_shapes` means.
//
//   sector     the firm's INDUSTRY is the constraint -- a hedge fund, a law
//              firm, an insurer. `firm_shapes` is the payload and discovery
//              composes shapes x triggers.
//   situation  what is HAPPENING at the firm is the constraint, in whatever
//              industry -- declared AI with no team, a business unit routing
//              around central IT. `firm_shapes` is illustrative only.
//
// Added 2026-09-20, after the operator noticed that every thesis open to
// discovery is a situation and every parked one is a sector. That is not a
// coincidence: TODO 2f measured two OPPOSITE shape vocabularies returning the
// same class of firm, which is what a shape list does when the thesis was
// never about the shape.
const SCOPES = ['sector', 'situation'];
const AUTHORITY = ['buyer', 'router', 'blocker', 'referral_node'];
const FINDABILITY = ['high', 'medium', 'low', 'none'];

// Every key `rank` knows how to read out of `ranking`. This exists so a knob
// misspelled in sectors.yml earns a warning instead of quietly doing nothing.
// If this list ever falls behind the ranker the cost is a spurious warning
// about a real knob, which is the failure worth having.
const KNOWN_RANKING_KEYS = new Set([
  'vertical', 'firm', 'person', 'thresholds', 'reachability', 'activity_factor',
  'response_likelihood', 'outside_home_factor', 'home_metro_factor',
  'home_region_factor', 'shortlist_blend', 'channel_floor',
  'capability_authority',
]);

const DEFAULT_RANKING = {
  vertical: { money: 0.40, trigger_frequency: 0.35, findability: 0.25 },
  firm: { fit: 0.30, urgency: 0.45, fee_vs_authority: 0.25 },
  person: { authority: 0.50, reachability: 0.30, warmth: 0.20 },
  response_likelihood: { source: 'prior', min_n_for_measured_rate: 40, priors: {} },
};

class TargetingError extends Error {
  constructor(problems, path) {
    super(`${path} is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'TargetingError';
  }
}

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isArr = (v) => Array.isArray(v) && v.length > 0;

/** Weights are normalised rather than rejected: a set summing to 0.9 is a typo, not a crash. */
function normaliseWeights(w, fallback, label, warnings) {
  const merged = { ...fallback, ...(w ?? {}) };
  const sum = Object.values(merged).reduce((a, b) => a + (isNum(b) ? b : 0), 0);
  if (sum <= 0) return { ...fallback };
  if (Math.abs(sum - 1) > 0.001) {
    warnings.push(`ranking.${label} weights sum to ${sum.toFixed(3)}, not 1; normalising`);
    for (const k of Object.keys(merged)) merged[k] = (merged[k] ?? 0) / sum;
  }
  return merged;
}

export function loadTargeting(cfg, path = TARGETING_PATH) {
  if (!existsSync(path)) {
    throw new TargetingError(
      ['file does not exist. Copy config/sectors.example.yml to config/sectors.yml.'], path);
  }

  let doc;
  try {
    doc = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new TargetingError([`YAML did not parse: ${err.message}`], path);
  }
  if (!doc || typeof doc !== 'object') throw new TargetingError(['file is empty'], path);

  const errors = [];
  const warnings = [];
  const need = (c, m) => { if (!c) errors.push(m); };
  const want = (c, m) => { if (!c) warnings.push(m); };

  const knownTriggers = new Set((cfg?.triggers ?? []).map((t) => t.id));
  const knownServices = new Set((cfg?.packages ?? []).map((s) => s.id));
  // A RETIRED PACKAGE IS NOT SELLABLE, so a thesis whose whole menu is retired
  // can convert nothing. Kept apart from `knownServices` because naming a
  // retired offer is legitimate as a record; naming ONLY retired offers is not.
  const livePackages = new Set((cfg?.packages ?? [])
    .filter((s) => (s.status ?? 'live') !== 'retired').map((s) => s.id));
  // `serves` points at config/segments.yml. `legacy` is the holding value for
  // theses written before segments existed; it is allowed and warned about,
  // because a bucket nobody empties stops being a bucket.
  const knownSegments = new Set((cfg?.segments ?? []).map((x) => x.id));

  need(Array.isArray(doc.verticals), 'verticals must be a list');
  const seen = new Set();

  for (const [i, v] of (doc.verticals ?? []).entries()) {
    const at = `verticals[${i}]`;
    need(isStr(v?.id), `${at}.id is required`);
    if (isStr(v?.id)) {
      need(!seen.has(v.id), `${at}.id "${v.id}" is duplicated`);
      seen.add(v.id);
    }
    const label = v?.id ?? at;
    need(STATUSES.includes(v?.status ?? 'hypothesis'),
      `${label}.status must be one of ${STATUSES.join('|')}, got "${v?.status}"`);
    // No default. A thesis whose scope nobody stated is one nobody has decided
    // the shape of, and guessing `sector` would quietly restore the behaviour
    // this field exists to make visible.
    need(SCOPES.includes(v?.scope),
      `${label}.scope must be one of ${SCOPES.join('|')}, got "${v?.scope ?? '(unset)'}" -- ` +
      'is this thesis selected by the firm\'s INDUSTRY, or by what is happening at it?');

    // A retired thesis is a record of what did not work, not a live rubric. It
    // is held to one requirement only: say why it died.
    if (v?.status === 'retired') {
      want(isStr(v?.retired_because),
        `${label} is retired without a retired_because; the reason is the point of keeping it`);
      continue;
    }

    need(isStr(v?.thesis), `${label} needs a thesis`);

    // A trigger the system does not know is a rule that will never fire.
    for (const [j, t] of (v?.triggers ?? []).entries()) {
      need(isStr(t?.id), `${label}.triggers[${j}].id is required`);
      if (isStr(t?.id)) {
        need(knownTriggers.has(t.id),
          `${label}.triggers[${j}] "${t.id}" is not declared in config/signals.yml triggers`);
      }
      want(isArr(t?.evidence_sources),
        `${label}.triggers[${j}] ("${t?.id}") names no evidence_sources; ` +
        'a trigger with no findable source cannot be detected');
    }
    want(isArr(v?.triggers), `${label} has no triggers; nothing will ever make it live`);

    need(isArr(v?.personas), `${label} needs at least one persona`);
    for (const [j, p] of (v?.personas ?? []).entries()) {
      need(isArr(p?.title_patterns), `${label}.personas[${j}] needs title_patterns`);
      need(AUTHORITY.includes(p?.authority),
        `${label}.personas[${j}].authority must be one of ${AUTHORITY.join('|')}, got "${p?.authority}"`);
      // OPTIONAL, and it only ever promotes to buyer on a KNOWN headcount at or
      // below the number. See matchPersona for why it never fires on a null.
      if (p?.buyer_below_headcount !== undefined) {
        need(Number.isFinite(p.buyer_below_headcount) && p.buyer_below_headcount > 0,
          `${label}.personas[${j}].buyer_below_headcount must be a positive number, ` +
          `got "${p.buyer_below_headcount}"`);
        need(p.authority !== 'buyer',
          `${label}.personas[${j}] is already authority "buyer"; ` +
          'buyer_below_headcount would do nothing and is probably a mistake');
      }
    }
    want((v?.personas ?? []).some((p) => p?.authority === 'buyer'),
      `${label} has no persona with authority "buyer"; there is no one to sell to`);

    // findability is TWO ratings since 2026-09-16: `firm` is how readily the firm
    // names its people, `person` is how often one of those names turns out to be
    // contactable. The old single `rating` measured the first and was used as if
    // it meant the second.
    const findPerson = v?.findability?.person ?? v?.findability?.rating;
    need(findPerson !== undefined,
      `${label}.findability.person is required (was findability.rating before 2026-09-16)`);
    need(FINDABILITY.includes(findPerson ?? 'medium'),
      `${label}.findability.person must be one of ${FINDABILITY.join('|')}`);
    want(v?.findability?.firm !== undefined,
      `${label}.findability.firm is not set; only the person half is being scored`);
    if (findPerson === 'low' || findPerson === 'none') {
      warnings.push(`${label} is rated findability.person "${findPerson}" — expect most ` +
        'named people here to be unreachable on LinkedIn. Work the address route instead. ' +
        'That is the honest outcome, not a bug.');
    }

    // A FLOOR THAT RESTATES THE GLOBAL IS A COPY THAT CAN DRIFT. `rank` already
    // falls back to icp.revenue_floor_usd when a thesis omits one, so an
    // identical restatement adds nothing and has to be kept in sync by hand.
    // Ten of them existed. A thesis needing a DIFFERENT floor still declares it.
    for (const k of ['revenue_floor_usd', 'headcount_ceiling']) {
      const mine = v?.money?.[k];
      const global = cfg?.icp?.[k];
      want(!(mine !== undefined && global !== undefined && mine === global),
        `${label}.money.${k} is ${mine}, the same as the global icp.${k}. ` +
        'Remove it — the global already applies — or change it if this thesis differs.');
    }

    for (const sid of v?.service_fit ?? []) {
      need(knownServices.has(sid),
        `${label}.service_fit "${sid}" is not a package declared in config/offers.yml`);
    }

    // WHICH SEGMENT THIS THESIS SERVES. Was rendered and never checked, so 8 of
    // 12 pointed at "legacy", which is not a segment, and one pointed at
    // nothing. A link nothing validates is a link that quietly stops being true.
    if (v?.status !== 'retired') {
      need(isStr(v?.serves), `${label}.serves is required: which segment in ` +
        'config/segments.yml does this thesis hunt for?');
      if (isStr(v?.serves)) {
        need(knownSegments.has(v.serves) || v.serves === 'legacy',
          `${label}.serves "${v.serves}" is not a segment declared in config/segments.yml`);
        want(v.serves !== 'legacy',
          `${label}.serves is "legacy", which is a holding value rather than a segment — ` +
          'it predates config/segments.yml and nobody has said which market it hunts');
      }

      // A THESIS THAT CAN SELL NOTHING. Six theses still name only packages
      // retired on 2026-09-19 when the menu was slimmed, and were never
      // updated. That is an error where the thesis is open to discovery,
      // because it spends queries to find firms it has no offer for; it is a
      // warning where discovery is paused, because a parked thesis costs
      // nothing until it is woken.
      const fit = v?.service_fit ?? [];
      const sellable = fit.filter((x) => livePackages.has(x));
      const msg = `${label} can sell nothing: ` +
        (fit.length ? `service_fit names ${fit.length} package(s) and every one is retired`
                    : 'it names no service_fit at all') +
        '. Point it at a live package in config/offers.yml, or retire the thesis.';
      if ((v?.discovery ?? 'active') === 'active') need(sellable.length > 0, msg);
      else want(sellable.length > 0, msg);
    }
  }

  // A TRIGGER NOTHING CONSUMES. This is the only place that sees both sides —
  // config.mjs holds the capabilities and gates, this file holds the theses — so
  // the check lives here. `unfilled_leadership_req` sat wired to nothing at
  // either end for weeks with a weight and discovery terms, looking like a live
  // rule that merely had not matched yet. A trigger that is deliberately parked
  // declares `orphaned: true` and is exempt.
  {
    const named = new Set([
      ...(cfg?.work ?? []).flatMap((w) => w.fires_when?.triggers_any ?? []),
      ...(cfg?.gates ?? []).flatMap((g) => g.unless_trigger ?? []),
      ...(doc.verticals ?? []).flatMap((v) => (v.triggers ?? []).map((t) => t.id ?? t)),
    ]);
    for (const t of cfg?.triggers ?? []) {
      if (t?.orphaned) continue;
      want(named.has(t.id),
        `trigger "${t.id}" is consumed by nothing — no capability's fires_when, no ` +
        'thesis, no gate exemption. It can fire and reach nothing. Wire it up, or ' +
        'mark it `orphaned: true` with the reason.');
    }
  }

  const live = (doc.verticals ?? []).filter((v) => (v.status ?? 'hypothesis') !== 'retired');
  want(live.length > 0, 'every vertical is retired; there is nothing to target');

  if (errors.length) throw new TargetingError(errors, path);

  const ranking = doc.ranking ?? {};
  const rl = { ...DEFAULT_RANKING.response_likelihood, ...(ranking.response_likelihood ?? {}) };

  // Pass-through keeps a knob from vanishing; this keeps a misspelled one from
  // looking like it works.
  for (const key of Object.keys(ranking)) {
    if (!KNOWN_RANKING_KEYS.has(key)) {
      want(false, `ranking.${key} is not a knob the ranker reads — check the spelling. ` +
        'It is carried through, but nothing will act on it.');
    }
  }

  return {
    verticals: doc.verticals ?? [],
    live,
    parked: doc.parked ?? [],           // §13: kept, never read by the ranker
    ranking: {
      // Spread FIRST, so a knob this function has never heard of still reaches
      // the ranker. Enumerating the keys instead dropped `thresholds` when they
      // were moved out of the code, then dropped `outside_home_factor` the same
      // way — each time the ranker fell back to a default and said nothing, and
      // each time that default happened to equal the configured value, which is
      // what made it invisible. The keys below still override, because they are
      // normalised or defaulted rather than merely carried.
      ...ranking,
      vertical: normaliseWeights(ranking.vertical, DEFAULT_RANKING.vertical, 'vertical', warnings),
      firm: normaliseWeights(ranking.firm, DEFAULT_RANKING.firm, 'firm', warnings),
      person: normaliseWeights(ranking.person, DEFAULT_RANKING.person, 'person', warnings),
      thresholds: ranking.thresholds ?? {},
      reachability: ranking.reachability ?? {},
      activity_factor: ranking.activity_factor ?? {},
      response_likelihood: rl,
    },
    _warnings: warnings,
    _path: path,
  };
}

// Titles are written both ways in the wild — "Head of AI" and "Head of
// Artificial Intelligence" are the same seat — so both sides are normalised to
// the abbreviation before comparison. Without this, a persona pattern silently
// fails to match the very person it was written for.
const SYNONYMS = [
  [/\bartificial intelligence\b/g, 'ai'],
  [/\ba\s+i\b/g, 'ai'],          // "A.I." survives punctuation stripping as "a i"
  [/\bmachine learning\b/g, 'ml'],
  [/\bdata science\b/g, 'ds'],
  [/\bsenior vice president\b/g, 'vp'],
  [/\bexecutive vice president\b/g, 'vp'],
  [/\bvice president\b/g, 'vp'],
  // Seniority prefixes collapse to the seat, so a persona written for
  // "VP Integration" still matches an SVP holding it. Ordered before the bare
  // forms because these are the longer match.
  [/\bsvp\b/g, 'vp'],
  [/\bevp\b/g, 'vp'],
  [/\bchief technology officer\b/g, 'cto'],
  [/\bchief information officer\b/g, 'cio'],
  [/\bchief operating officer\b/g, 'coo'],
  [/\bchief financial officer\b/g, 'cfo'],
  [/\bchief executive officer\b/g, 'ceo'],
  [/\bchief data officer\b/g, 'cdo'],
  [/\bchief ai officer\b/g, 'caio'],
  [/\bmanaging director\b/g, 'md'],
  [/\bglobal head\b/g, 'head'],
  [/\bgroup head\b/g, 'head'],
];

export function normaliseTitle(t) {
  let out = String(t ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  for (const [re, to] of SYNONYMS) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The persona in this vertical that matches a title, or null. Personas are
 * tried in declared order, so the file's ordering is the priority. Never
 * guesses: an unmatched title returns null rather than a nearest fit.
 */
// A seat someone used to hold. "Retired Chief Information Officer" matched the
// CIO persona as a buyer at full authority until this existed, and the only
// thing that caught it was the operator pasting a profile and the extractor
// reporting the title as contradicted — a human step, on a title that says so
// in its first word.
//
// The marker must come BEFORE the seat to disqualify it. "Retired Chief
// Information Officer" is a past seat; "Chief Technology Officer, formerly of
// Google" is a current one with a past employer, and excluding that would trade
// one false reading for another.
// Two kinds of marker. "Retired" and "emeritus" describe the person wherever
// they appear — "CIO Emeritus" is as past as "Retired CIO". "Former" and "ex"
// only mean it when they come before the seat, because after it they usually
// attach to an employer: "CTO, formerly of Google" is a sitting CTO.
const ALWAYS_PAST = /\b(retired|emeritus|ret)\b/;
const PAST_BEFORE = /\b(former|ex)\b/g;

function seatIsPast(hay, needle) {
  if (ALWAYS_PAST.test(hay)) return true;
  const at = hay.search(new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  if (at < 0) return false;
  for (const m of hay.slice(0, at).matchAll(PAST_BEFORE)) if (m.index < at) return true;
  return false;
}

// A MODIFIER BETWEEN THE RANK AND THE SEAT IS STILL THE SEAT.
//
// The twin of the helper of the same name in config.mjs, and the duplication is
// itself the defect: on 2026-09-23 three separate title matchers were found in
// this codebase — this one for personas, titleFitsBuyer for package
// buyer_titles, and matchesAny in gate.mjs for the capability kill list — each
// with its own synonym handling and its own answer for the same seat. Fixing
// only titleFitsBuyer moved nothing, because personas come through here.
//
// They should be one function. Until they are, the two implementations must at
// least agree, so this mirrors the rules recorded there: only the words in
// MODIFIERS may be skipped, at most two of them, never before the first token,
// and the subordinate guard reads the word immediately before the RANK rather
// than before the seat noun.
const MODIFIERS = new Set(['global', 'integrated', 'corporate', 'enterprise', 'group',
  'regional', 'international', 'worldwide', 'americas', 'america', 'north', 'us', 'na',
  'strategic', 'advanced', 'technical', 'commercial', 'digital']);
const FILLER = new Set(['of', 'the', 'for']);
const RANKS = { svp: 'vp', evp: 'vp', avp: 'vp' };
const SUBORDINATE_WORD = /^(vice|deputy|assistant|associate|acting|interim)$/i;
const tokens = (t) => String(t ?? '').trim().split(' ').filter(Boolean)
  .filter((x) => !FILLER.has(x)).map((x) => RANKS[x] ?? x);

// THE SAME SEAT WITH THE RANK ON THE OTHER SIDE, added 2026-09-23. The persona
// lists were written with one rank word per seat noun -- "Continuous Improvement
// Manager", "Operational Excellence Manager" -- and real agendas print every
// rank there is: "Director of Continuous Improvement", "Head of Operational
// Excellence". Same job, no match, because the anchored regex and the modifier
// matcher both need the pattern's words contiguous and in the pattern's order.
// Measured on the conference cohort: 48 of 93 speakers matched no persona, and
// a run of them are this.
//
// A pattern ENDING in a rank noun is read as <seat...> <rank>, and a title
// carrying any rank noun followed by that same seat matches it. `tokens` has
// already dropped "of", so "Director of Continuous Improvement" arrives as
// [director, continuous, improvement].
//
// THREE GUARDS, and each one is a false match that would otherwise happen:
//   1. The seat must be at least TWO words. "Plant Manager" would otherwise
//      reduce to the seat "plant" and match "Director of Plant Operations",
//      "VP of Plant Engineering" and anything else with a plant in it.
//   2. The rank word cannot follow a subordinate. "Deputy Director of Quality
//      Assurance" is not the director, the same rule the rest of this file keeps.
//   3. The pattern's own rank is ignored, not required to match. A Director and
//      a Manager of the same function are the same persona here; authority comes
//      from the persona, not from which rank word the config author happened to
//      write. That is the deliberate looseness, and it is why guard 1 matters.
const RANK_NOUN = new Set(['manager', 'director', 'head', 'lead', 'officer',
  'vp', 'president', 'supervisor', 'chief']);

export function seatMatchesWithRankFirst(normalisedTitle, normalisedPattern) {
  const pat = tokens(normalisedPattern);
  // >= 3 tokens means >= 2 seat words once the trailing rank is removed.
  if (pat.length < 3 || !RANK_NOUN.has(pat[pat.length - 1])) return false;
  const seat = pat.slice(0, -1);
  const w = tokens(normalisedTitle);
  for (let i = 0; i < w.length; i++) {
    if (!RANK_NOUN.has(w[i])) continue;
    if (i > 0 && SUBORDINATE_WORD.test(w[i - 1])) continue;
    if (i + 1 + seat.length > w.length) continue;
    if (seat.every((t, k) => w[i + 1 + k] === t)) return true;
  }
  return false;
}

export function seatMatchesWithModifier(normalisedTitle, normalisedPattern) {
  const pat = tokens(normalisedPattern);
  if (pat.length < 2) return false;
  const w = tokens(normalisedTitle);
  const rest = pat.slice(1);
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== pat[0]) continue;
    if (i > 0 && SUBORDINATE_WORD.test(w[i - 1])) continue;
    for (let skip = 0; skip <= 2; skip++) {
      const at = i + 1 + skip;
      if (at + rest.length > w.length) break;
      if (skip && !MODIFIERS.has(w[i + skip])) break;
      if (rest.every((r, k) => w[at + k] === r)) return true;
    }
  }
  return false;
}

// THE SPLIT THE PERSONA LISTS COULD NOT EXPRESS, added 2026-09-23. The supply
// chain and technology personas in this file carry a long note saying the same
// thing in prose -- "At 300 people this seat signs; at 5,000 it recommends. No
// persona in this file expresses that split" -- and then pick `router` for
// every firm because one tier had to cover both. A VP of Supply Chain at a
// 300-person snack manufacturer who opened a planning requisition himself was
// scored at authority 0.5 for the same reason as a VP of Supply Chain at a
// 9,000-person semiconductor fab.
//
// A persona may now name `buyer_below_headcount: N`. Below N the seat signs, at
// or above it recommends, and the declared `authority` remains what the seat is
// at enterprise scale.
//
// IT NEVER FIRES ON AN UNKNOWN HEADCOUNT, which is the whole discipline of it.
// A firm nobody has sized is not a small firm; it is an unsized one, and the
// rule this file keeps is that an unread page is not evidence. Sizing in this
// book is mostly model recall (headcount_source is null for 27 of the 30 people
// this first touched), so the promotion is deliberately the narrow case: a
// number we hold, at or under the line.
export function matchPersona(vertical, title, headcount = null) {
  if (!isStr(title)) return null;
  const hay = ` ${normaliseTitle(title)} `;
  // THE MOST SPECIFIC PATTERN WINS, THEN ORDER BREAKS THE TIE. Taking the first
  // persona with any match made list order do two jobs at once -- it is also the
  // tier penalty, so a more specific persona cannot simply be moved to the front
  // without silently reducing the authority of everything below it.
  //
  // The two collided as soon as a divisional seat needed its own tier.
  // normaliseTitle collapses "Chief Information Officer" to "cio", so the
  // ENTERPRISE persona matches "CIO - Strategic Businesses" and "SVP CIO
  // Foundational Business" just as well as it matches the enterprise CIO, and
  // being first it won. Both divisional seats at one insurer were scored as the
  // enterprise buyer at authority 1.0, which is the seat above them.
  //
  // Longest matching needle wins instead: "cio -" beats "cio" on the divisional
  // title and loses on the enterprise one, because it is not there to match.
  const all = [];
  for (const [i, p] of (vertical.personas ?? []).entries()) {
    const hit = (p.title_patterns ?? []).find((t) => {
      const needle = normaliseTitle(t);
      if (!needle) return false;
      // ANCHORED AT A WORD START, never a bare substring. The fallback this
      // replaces read `hay.includes(needle)` with no boundary at all, and the
      // synonym table turns "Chief Technology Officer" into "cto" — which is
      // inside "dire-cto-r". Every board Director in the book was scored a
      // buyer at authority 1.0 against the CTO persona, 43 people in all,
      // including three non-executive directors at one bank the operator's own
      // `not:` list says hold no budget.
      //
      // The end is deliberately left unanchored so "Chair" still matches
      // "Chairman" and "Director" still matches "Directors". The start is not,
      // because that is where the false matches came from.
      const anchored = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        .test(hay);
      // The anchored regex cannot read "VP, Integrated Supply Chain" against
      // "VP Supply Chain". Fall through to the modifier-aware match, which can,
      // under the constraints documented above it.
      return (anchored || seatMatchesWithModifier(hay, needle)
        || seatMatchesWithRankFirst(hay, needle)) && !seatIsPast(hay, needle);
    });
    if (hit) all.push({ ...p, persona_id: `${vertical.id}#${i}`, matched: hit, rank: i });
  }
  if (!all.length) return null;
  const won = all.sort((a, b) => normaliseTitle(b.matched).length - normaliseTitle(a.matched).length
    || a.rank - b.rank)[0];
  const size = Number(headcount);
  if (won.buyer_below_headcount && Number.isFinite(size) && size > 0
      && size <= won.buyer_below_headcount) {
    return { ...won, authority: 'buyer', promoted_below_headcount: won.buyer_below_headcount };
  }
  return won;
}
