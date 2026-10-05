// Loader and validator for config/*.yml — me, sectors, signals, offers,
// discovery, runtime. A single legacy firm.yml is still read if present, which is why
// that name appears below; it is a fallback, not where config lives now.
//
// Everything user-specific lives in that file. This module is the
// only place that reads it, and it fails loudly rather than letting a typo turn
// into a silently empty scan. Errors abort; warnings print and continue.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { knownModels } from './models.mjs';
// ONE COPY OF THIS JUDGMENT, NOT A THIRD. This file already carries its own
// MODIFIERS, FILLER, RANK and SUBORDINATE tables beside targeting.mjs's, which is
// the duplication this project keeps finding after it has already cost something.
// The rank-first rule is imported rather than reimplemented so the two matchers
// cannot drift on it.
import { seatMatchesWithRankFirst } from './targeting.mjs';
import { overlayBusiness } from './business.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = resolve(ROOT, 'config');
// LinkedIn caps a connection-request note: 300 characters on Premium, 200 on a
// free account. One number, read by the dashboard's counter and the drafter.
export const CONNECT_NOTE_MAX = 300;

// Five orthogonal input files. The test for orthogonality is whether one can be
// edited without touching another: a new sector touches sectors.yml only, a new
// gate touches signals.yml only. `sectors.yml` is loaded separately by
// targeting.mjs because it has its own validation.
//
// They merge into a single object with the shape the rest of the system already
// reads, so the split is a filing decision, not an API change.
export const INPUT_FILES = [
  ['me.yml', 'who you are: firm, skills, proof points, never-claim'],
  ['offers.yml', 'what you sell: the buyers, the work, and the packages under each'],
  ['signals.yml', 'what disqualifies (gates) and what activates (triggers)'],
  ['runtime.yml', 'plumbing: icp floors, sources, models'],
  ['segments.yml', 'who the buyer is, above the sector: reachability and value, tracked apart'],
  ['discovery.yml', 'how a prospect physically arrives: permission, cost, and measured yield'],
];
/**
 * SQL that excludes outreach which was never a sales approach, per `not_sales`
 * in offers.yml. Returns a fragment to append inside a WHERE, plus its params.
 *
 * It exists because the count of "sends" is the project's headline number — the
 * n in `min_n_for_measured_rate` — and three rows in it were job applications.
 * A rule that changes a headline number belongs in config where the person it
 * affects can see it, and in one function so that rank and dash cannot drift
 * into disagreeing about what a send is.
 */
/**
 * Which geography bucket a person falls in, resolved from DURABLE columns only:
 * their own country and location, falling back to the firm's HQ.
 *
 * Extracted from rank 2026-09-19 for a reason worth recording. The dashboard
 * read a person's bucket out of `person_scores`, which holds only people
 * currently ON THE BOARD — so when ten firms were filed under a retired thesis
 * and correctly dropped from scoring, ten historical SENDS lost their
 * geography with them. A record of what was sent must not change because a
 * targeting decision changed; the send happened, and the person was wherever
 * they were.
 *
 * rank's own comment already warned about the other half of this: "deriving
 * them separately is how a page ends up explaining a score with a category the
 * score never used." So there is one function and both callers use it.
 */
const HOME_ALIASES = ['us', 'usa', 'united states', 'u.s.', 'america'];

/**
 * WHERE THE OPERATOR IS, resolved from BOTH files that state it.
 *
 * It was stated twice and the two disagreed. `me.yml` firm.location carried
 * `metro: Austin, TX` and `secondary: Powell, TN`, and only the drafter read it.
 * `runtime.yml` icp.home_metros listed seven Texas metros and home_region
 * ["Texas","TX"], and only the ranker read that. So the operator's second base
 * existed in one file, was invisible to scoring, and a firm there would have
 * been rated `outside_home` at 0.55 against 1.25 for a home metro — a 2.3x swing
 * against a place he actually works from.
 *
 * Merging is the fix rather than deleting either: `me.yml` says where he IS, and
 * icp.home_metros is the operational expansion of that into the neighbouring
 * towns that count as the same market. Both are real; neither was complete.
 * "Austin, TX" contributes the metro AND the region, so a location stated once
 * reaches scoring without being retyped into the other file.
 */
export function homeGeoOf(cfg = {}) {
  const icp = cfg.icp ?? {};
  const loc = cfg.firm?.location ?? {};
  const metros = new Set((icp.home_metros ?? []).map((m) => String(m).toLowerCase()));
  const region = new Set((icp.home_region ?? []).map((m) => String(m).toLowerCase()));
  for (const place of [loc.metro, loc.secondary]) {
    if (!isStr(place)) continue;
    const [city, state] = String(place).split(',').map((x) => x.trim());
    if (city) metros.add(city.toLowerCase());
    if (state) region.add(state.toLowerCase());
  }
  return {
    geography: (icp.geography ?? ['US']).map((g) => String(g).toLowerCase()),
    metros: [...metros],
    region: [...region],
  };
}

export function geoBucketOf({ country, location, hq } = {}, cfg = {}) {
  // Accepts a whole config, or a bare icp block for older callers.
  const home = homeGeoOf(cfg.icp || cfg.firm ? cfg : { icp: cfg });
  const homeGeo = home.geography;
  const metros = home.metros;
  const region = home.region;
  const inHome = (c) => {
    const v = String(c).toLowerCase();
    return homeGeo.some((g) =>
      v.includes(g) || (HOME_ALIASES.includes(g) && HOME_ALIASES.some((a) => v.includes(a))));
  };
  const away = Boolean(country) && !inHome(country);
  // The person's own location beats the firm's HQ, but the HQ is worth falling
  // back on in a way it is not for country. A global firm's London partner is
  // not in Chicago; a nine-person Austin shop is in Austin.
  const placeText = location ?? hq ?? null;
  const hit = (list) => placeText && list.length
    && list.some((m) => String(placeText).toLowerCase().includes(m));
  const bucket = away ? 'international'
    : hit(metros) ? 'home_metro'
    : hit(region) ? 'home_region'
    : placeText ? 'national'
    : 'unknown';
  return { bucket, away, placeText, viaHq: !location && Boolean(hq) };
}

/**
 * THE LINKEDIN RULE, ENFORCED RATHER THAN REVIEWED.
 *
 * CLAUDE.md says no module may fetch, crawl, log into or message
 * linkedin.com. It said so in PROSE, which is a rule a human reads
 * and not a rule that fails a run. `forbidden_hosts` in discovery.yml is the
 * same rule as data, and this checks it against the source tree every time the
 * config loads.
 *
 * It distinguishes a MENTION from a TARGET, and it has to: four places in this
 * codebase say "nothing fetches linkedin.com", three of them in text printed on
 * the dashboard. A check that flagged those would be turned off within a week,
 * and a guardrail that gets turned off is worse than one that was never built.
 * So it looks only for the host inside a URL literal or a network call, with
 * comment lines stripped first.
 */
export function assertForbiddenHostsUnused(cfg, dir = resolve(ROOT, 'src')) {
  const hosts = (cfg?.forbidden_hosts ?? []).map((h) => (typeof h === 'string' ? h : h.host))
    .filter(Boolean);
  if (!hosts.length) return [];
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(dir);
  // THE ONE EXCEPTION, granted by the operator 2026-09-25 ("yes, add the narrow
  // exception for the search link") and recorded in CLAUDE.md. A dashboard card
  // may carry an href to LinkedIn's people search that the operator CLICKS: it
  // opens in his browser, as him, and nothing here fetches, follows or reads it.
  // Exact file, exact attribute, exact path prefix -- and still refused if the
  // same line contains a call. A fetch of this URL, or this URL in any other
  // file, fails exactly as before.
  const ALLOWED = [{ file: 'src/dash.mjs',
    line: /^\s*const href = `https:\/\/www\.linkedin\.com\/search\/results\/people\/\?keywords=\$\{[a-z]+\}`;\s*$/ }];
  const bad = [];
  for (const f of files) {
    // Relative to the tree being checked, so a test can plant files in a scratch copy.
    const rel = relative(resolve(dir, '..'), f);
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')       // block comments
      // NOT /\/\/.*$/. A naive line-comment stripper deletes the "//" in
      // "https://", and with it the rest of the line — so the very URL this
      // check exists to find is erased before the check runs. Caught by a
      // negative test: the guard passed a planted violation.
      .split('\n').map((l) => l.replace(/(?<!:)\/\/.*$/, ' ')).join('\n');
    src.split('\n').forEach((line, i) => {
      for (const h of hosts) {
        const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const asUrl = new RegExp(`https?:\\/\\/[^\\s"'\`]*${esc}`, 'i');
        const asCall = new RegExp(`\\b(fetch|goto|request|open|axios|get|post)\\s*\\([^)]*${esc}`, 'i');
        if (!asCall.test(line)
            && ALLOWED.some((a) => a.file === rel && a.line.test(line))) continue;
        if (asUrl.test(line) || asCall.test(line)) {
          bad.push(`${rel}:${i + 1} targets ${h}`);
        }
      }
    });
  }
  if (bad.length) {
    throw new ConfigError([
      'A source module targets a host that discovery.yml forbids:',
      ...bad.map((b) => `  ${b}`),
      '',
      'This is not a lint failure to be suppressed. LinkedIn\'s User Agreement §8.2',
      'prohibits crawlers, bots and automated messaging in WORDS, so it is a policy',
      'and not a control, and no technical capability changes the answer — including',
      'a browser this project drives. The operator reading a page themselves and',
      'pasting the text is the sanctioned route: npm run lead -- paste.',
    ], resolve(CONFIG_DIR, 'discovery.yml'));
  }
  return bad;
}

export function notSalesSql(cfg, col = 'service_pitched') {
  const ids = cfg?.not_sales?.services ?? [];
  if (!ids.length) return { sql: '', params: [] };
  return {
    sql: ` AND (${col} IS NULL OR ${col} NOT IN (${ids.map(() => '?').join(',')}))`,
    params: ids,
  };
}

export const CONFIG_PATH = resolve(ROOT, 'config/firm.yml');   // legacy single file

const ATS = ['greenhouse', 'ashby', 'lever'];

// Defaults for keys the config files may omit. Kept here, not in the YAML, so that
// firm.example.yml stays short and a missing key is never a crash.
const DEFAULTS = {
  lookback_days: 120,      // a posting older than this is not a live signal
  stale_req_days: 60,      // past this, an open capability req reads as an unfilled gap
  title_keywords: [
    'ai', 'artificial intelligence', 'machine learning', 'ml ', 'mlops', 'llm',
    'genai', 'generative ai', 'data science', 'data scientist', 'analytics',
    'applied scientist', 'nlp',
  ],
  leadership_keywords: [
    'head of', 'chief', 'vp', 'vice president', 'director', 'principal',
    'lead', 'manager', 'partner',
  ],
};

class ConfigError extends Error {
  constructor(problems, path = CONFIG_PATH) {
    super(`${path} is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isArr = (v) => Array.isArray(v) && v.length > 0;

/** Read one input file, or return null if it is absent. */
function readOne(dir, file) {
  const full = resolve(dir, file);
  if (!existsSync(full)) return null;
  try {
    return YAML.parse(readFileSync(full, 'utf8')) ?? {};
  } catch (err) {
    throw new ConfigError([`YAML did not parse: ${err.message}`], full);
  }
}

/**
 * Merge the split input files into one object. Falls back to the legacy single
 * firm.yml so an older checkout keeps working, and says which files it used so
 * a missing one is never silently an empty section.
 */
export function loadConfig(dir = CONFIG_DIR) {
  // A path to a .yml is the legacy single-file form; a directory is the split form.
  const single = typeof dir === 'string' && dir.endsWith('.yml') ? dir : null;
  let cfg = {};
  const used = [];

  if (single) {
    if (!existsSync(single)) {
      throw new ConfigError(['file does not exist.'], single);
    }
    cfg = readOne(dirname(single), single.split('/').pop()) ?? {};
    used.push(single);
  } else {
    for (const [file] of INPUT_FILES) {
      const part = readOne(dir, file);
      if (part) { Object.assign(cfg, part); used.push(file); }
    }
    if (!used.length) {
      const legacy = readOne(dir, 'firm.yml');
      if (legacy) { Object.assign(cfg, legacy); used.push('firm.yml (legacy single file)'); }
    }
    if (!used.length) {
      throw new ConfigError([
        `no input files in ${dir}. Expected ${INPUT_FILES.map(([f]) => f).join(', ')}. ` +
        'Copy the .example.yml siblings and fill them in.',
      ], dir);
    }
  }

  const path = single ?? dir;
  if (!cfg || typeof cfg !== 'object') throw new ConfigError(['no content'], path);

  const errors = [];
  const warnings = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  const want = (cond, msg) => { if (!cond) warnings.push(msg); };

  // ---- firm -----------------------------------------------------------------
  need(cfg.firm && isStr(cfg.firm.name), 'firm.name is required');
  want(isNum(cfg.firm?.size), 'firm.size missing; engagement plausibility cannot be sized');

  // ---- pitches --------------------------------------------------------------
  // Three pitches, not four services. A pitch is (services, buyer,
  // when it fires, when it must not). `rank` proposes exactly one per prospect.
  const buyerIds = new Set();
  const livePitches = [];
  for (const [i, p] of (cfg.buyers ?? []).entries()) {
    const at = `buyers[${i}]`;
    need(isStr(p?.id), `${at}.id is required`);
    if (isStr(p?.id)) {
      need(!buyerIds.has(p.id), `${at}.id "${p.id}" is duplicated`);
      buyerIds.add(p.id);
    }
    const status = p?.status ?? 'live';
    // TWO WAYS OFF THE MENU, and the difference is worth keeping. `dead` means
    // the thesis was REFUTED — overflow_bench went 0-for-7 and its own note says
    // do not re-enter. `retired` means it was taken off deliberately and may come
    // back — the buyers_side reads were retired to slim the menu for a clean
    // test, not because anyone proved they cannot sell. Calling both dead loses
    // the only thing that distinguishes a verdict from a decision.
    need(['live', 'untested', 'dead', 'retired'].includes(status),
      `${at}.status must be live|untested|dead, got "${status}"`);
    if (status === 'dead') {
      want(isStr(p?.retired_because),
        `${at} ("${p?.id}") is dead with no retired_because; the reason is the point of keeping it`);
    } else {
      livePitches.push(p.id);
      need(isStr(p?.fires_when), `${at} ("${p?.id}") needs fires_when`);
      want(isStr(p?.never_when),
        `${at} ("${p?.id}") has no never_when; a pitch with no disqualifier is how ` +
        'overflow_bench went 0-for-7');
      // `services:` on a pitch is DERIVED, not declared — `pitch()` builds it
      // from each service's own `pitch` and `also_under`. A hand-written copy
      // drifted from the services that claimed it in three of five pitches, so
      // the check is now that something claims the pitch, not that the pitch
      // lists something.
      const claimed = (cfg.packages ?? []).some((s) =>
        s.buyer === p?.id || (s.also_under ?? []).includes(p?.id));
      want(claimed || p?.id === 'referral_ask' || OFF_MENU.has(p?.status ?? 'live'),
        `${at} ("${p?.id}") has no service that claims it`);
    }
  }
  want(buyerIds.size > 0, 'no buyers declared; every package will be treated as one sale');
  want(livePitches.length > 0, 'every pitch is dead; there is nothing to sell');

  // ---- services -------------------------------------------------------------
  need(isArr(cfg.packages), 'services must be a non-empty list');
  const packageIds = new Set();
  for (const [i, s] of (cfg.packages ?? []).entries()) {
    const at = `services[${i}]`;
    need(isStr(s?.id), `${at}.id is required`);
    need(isStr(s?.name), `${at}.name is required`);
    if (isStr(s?.id)) {
      need(!packageIds.has(s.id), `${at}.id "${s.id}" is duplicated`);
      packageIds.add(s.id);
    }
    const priced = isNum(s?.price_usd) || isNum(s?.rate_usd_hour) ||
      isNum(s?.price_usd_month) || isArr(s?.retainers);
    want(priced, `${at} ("${s?.id}") has no price; fee-vs-spend sizing will skip it`);
    want(isArr(s?.buyer_titles), `${at} ("${s?.id}") has no buyer_titles; no decision-maker target`);
    if (buyerIds.size) {
      need(isStr(s?.buyer) && buyerIds.has(s.buyer),
        `${at} ("${s?.id}").buyer must be one of ${[...buyerIds].join('|')}, got "${s?.buyer}"`);
    }
    // A SERVICE MAY NOT READ THE EVIDENCE. That is the capability's job, and
    // two readers of one judgment drift -- which is how a build package came to fire on
    // two triggers while the capability it delivers fired on three. The router
    // strips these, so the warning exists to stop someone editing a list that
    // no longer does anything. Move the trigger onto the capability, and name
    // this service in that capability's `delivered_by`.
    for (const k of (s?.status ?? 'live') === 'retired' ? []
                    : ['triggers_any', 'min_signals', 'count_triggers']) {
      want(s?.fires_when?.[k] === undefined,
        `${at} ("${s?.id}").fires_when.${k} is ignored since 2026-09-20: a service asks about ` +
        'the buyer (seat, size, budget), never about the evidence. Declare it on a capability ' +
        `and list "${s?.id}" in that capability's delivered_by.`);
    }
  }

  // ---- discovery.yml ------------------------------------------------------
  // Nothing here was checked except `forbidden_hosts`, which is the one part
  // that is genuinely enforced. So the file documenting what is PERMITTED was
  // the least verified in the config, and it drifted: a mechanism sat at
  // `low_yield` having never run, and carried a hand-kept firm count that was
  // stale by a third.
  {
    const MECH_STATUS = ['working', 'low_yield', 'untested', 'unimplemented'];
    const AUTOMATION = ['allowed', 'manual_only', 'forbidden'];
    const served = new Set();
    for (const [i, m] of (cfg.mechanisms ?? []).entries()) {
      const at = `mechanisms[${i}]`;
      need(isStr(m?.id), `${at}.id is required`);
      need(MECH_STATUS.includes(m?.status),
        `${at} ("${m?.id}").status must be one of ${MECH_STATUS.join('|')}, got "${m?.status}" ` +
        '— see the vocabulary at the head of discovery.yml. "low_yield" means it HAS run ' +
        'and returns little; a channel that has never run is "untested".');
      need(AUTOMATION.includes(m?.automation),
        `${at} ("${m?.id}").automation must be one of ${AUTOMATION.join('|')}`);
      want(m?.found_firms === undefined,
        `${at} ("${m?.id}") carries found_firms, a count kept by hand beside a database ` +
        'that records orgs.source per firm. It goes stale; derive it instead.');
      // A mechanism that cannot run serves nothing, whatever it declares.
      if (m?.status !== 'unimplemented') {
        for (const c of m?.evidence_classes ?? []) served.add(c);
      }
    }
    // THE CHECK WORTH HAVING: can each kind of evidence actually be obtained?
    // A trigger whose evidence class no runnable mechanism serves can never fire,
    // and that is a retrieval result the config should state rather than a
    // silence someone reads as a market verdict.
    const needed = new Map();
    for (const t of cfg.triggers ?? []) {
      if (!t?.evidence_class) continue;
      needed.set(t.evidence_class, (needed.get(t.evidence_class) ?? 0) + 1);
    }
    for (const [cls, n] of needed) {
      want(served.has(cls),
        `evidence_class "${cls}" is required by ${n} trigger(s) and no runnable mechanism in ` +
        'discovery.yml serves it. Those triggers cannot fire until one does.');
    }
  }

  // DOES EACH TRIGGER DO WHAT IT SAYS? The `kind` above is a claim, and this is
  // the check on it. Both directions matter:
  //
  //   a `work` trigger named by NO capability fires and reaches no offer
  //   a `work` trigger named only by RETIRED capabilities reaches nothing sellable
  //   an `urgency` trigger that IS named by a live capability is mislabelled
  //
  // The middle case is the one that was invisible and is the largest: four
  // triggers carrying 39 live signals name only `independent_judgment`, retired
  // when the menu was slimmed. They stay `work`, because that is what they are;
  // the warning says their work is retired rather than reclassifying them,
  // since the fix is a decision about the offer menu and not about signals.yml.
  {
    const named = new Map();     // trigger id -> { live: n, retired: n }
    for (const w of cfg.work ?? []) {
      const retired = (w.status ?? 'live') === 'retired';
      for (const id of w.fires_when?.triggers_any ?? []) {
        const e = named.get(id) ?? { live: 0, retired: 0 };
        e[retired ? 'retired' : 'live'] += 1;
        named.set(id, e);
      }
    }
    for (const t of cfg.triggers ?? []) {
      if (t?.orphaned) continue;
      const e = named.get(t?.id) ?? { live: 0, retired: 0 };
      if (t?.kind === 'work') {
        need(e.live + e.retired > 0,
          `trigger "${t.id}" is kind: work but no capability names it in fires_when. ` +
          'It can fire and reach no offer. Name it in a capability, or mark it urgency.');
        want(e.live > 0,
          `trigger "${t.id}" is kind: work but every capability naming it is RETIRED. ` +
          'Signals of it reach nothing sellable. Either revive the work, point another ' +
          'capability at this trigger, or retire the trigger with it.');
      } else if (t?.kind === 'urgency') {
        need(e.live === 0,
          `trigger "${t.id}" is kind: urgency but a live capability names it in ` +
          'fires_when, so it does name work. Mark it kind: work.');
      }
    }
  }

  // A capability that names no service cannot be sold, and a `delivered_by`
  // naming a service that does not exist is a chain that breaks silently --
  // which is the class this rewiring exists to remove.
  for (const [i, c] of (cfg.work ?? []).entries()) {
    const at = `capabilities[${i}]`;
    if ((c?.status ?? 'live') === 'retired') continue;
    want(isArr(c?.delivered_by),
      `${at} ("${c?.id}") has no delivered_by; the evidence can name this work but ` +
      'nothing can be sold for it');
    for (const sid of c?.delivered_by ?? []) {
      need(packageIds.has(sid),
        `${at} ("${c?.id}").delivered_by names "${sid}", which is not a declared service`);
    }
  }

  // A hiring trigger without `posting_terms` is searched as though it were a
  // news story, which is how five of them produced nothing for the life of the
  // project. The news path still needs `discovery_terms`; this is the second
  // rendering, for the index where postings actually live.
  for (const [i, t] of (cfg.triggers ?? []).entries()) {
    want(t?.evidence_class !== 'hiring_req' || !t?.discovery_terms || t?.posting_terms,
      `triggers[${i}] ("${t?.id}") is evidence_class hiring_req and has no posting_terms; ` +
      'discovery will search it as a news story and find articles about the work rather ' +
      'than a firm advertising it');
  }

  // A PACKAGE THAT CANNOT WIN IS NOT ON THE MENU, WHATEVER THE CATALOGUE SAYS.
  // packageForBuyer sorts the candidates a capability names by `priority` and
  // takes the first that clears its seat conditions, so a package always sharing
  // its capabilities with a higher-priority one that asks nothing can never be
  // selected — the dashboard chip reads "0" and the reason is structural rather
  // than a quiet segment. `fires_when: never` is exempt: that is a deliberate
  // statement that the package is sold in conversation, not chosen from a
  // dossier, and the zero there is the intended outcome.
  for (const [i, s2] of (cfg.packages ?? []).entries()) {
    if (OFF_MENU.has(s2?.status ?? 'live') || s2?.fires_when?.never) continue;
    const via = (cfg.work ?? []).filter((c) => (c?.status ?? 'live') !== 'retired'
      && (c?.delivered_by ?? []).includes(s2.id));
    if (!via.length) continue;                 // already reported as unreachable above
    const pri = s2.priority ?? 99;
    // ON THE SAME MENU, or it is not a rival. packageForBuyer narrows to
    // packagesUnder(buyerId) before it sorts by priority, so a package under a
    // different buyer never competes with this one however cheap its priority.
    // `also_under` counts: that is how a package reaches a second menu, and it
    // is how the hourly offer came to be shadowed on the buyer written for it.
    const menus = new Set([s2.buyer, ...(s2.also_under ?? [])].filter(Boolean));
    const shares = (o) => [o.buyer, ...(o.also_under ?? [])].some((b) => menus.has(b));
    const beatenIn = via.filter((c) => (c.delivered_by ?? []).some((id) => {
      const o = (cfg.packages ?? []).find((x) => x.id === id);
      if (!o || o.id === s2.id || OFF_MENU.has(o.status ?? 'live') || !shares(o)) return false;
      // Unconditional: nothing in the evidence can disqualify it, so it wins
      // every time it is cheaper by priority.
      return (o.priority ?? 99) < pri && !seatConditions(o.fires_when);
    }));
    want(beatenIn.length < via.length,
      `packages[${i}] ("${s2.id}") can never be selected: every capability that ` +
      `delivers it also names a higher-priority package with no fires_when to ` +
      `disqualify it, so priority ${pri} always loses. Give it a fires_when that ` +
      'describes the firm it is FOR, or raise its priority, or retire it.');
  }

  // ---- operator -------------------------------------------------------------
  need(isArr(cfg.operator?.strengths), 'operator.strengths must be a non-empty list');
  for (const [i, p] of (cfg.operator?.proof_points ?? []).entries()) {
    need(isStr(p?.claim), `operator.proof_points[${i}].claim is required`);
    // evidence_url may be null: some proof points are under NDA. The dossier
    // writer must then not cite them, which is checked downstream, not here.
    want(p?.evidence_url !== undefined,
      `operator.proof_points[${i}] has no evidence_url key; set it to null if there is no public link`);
    for (const l of p?.buyers ?? []) {
      need(buyerIds.has(l),
        `operator.proof_points[${i}].buyers "${l}" is not a declared buyer in offers.yml`);
    }
    want(isArr(p?.buyers),
      `operator.proof_points[${i}] is not scoped to a buyer; ` +
      'the drafting stage cannot tell which buyer it is evidence for');
  }
  want(Array.isArray(cfg.operator?.never_claim),
    'operator.never_claim is missing; the honesty guardrail will be empty');

  // ---- icp ------------------------------------------------------------------
  need(isArr(cfg.icp?.include_industries), 'icp.include_industries must be a non-empty list');
  need(isNum(cfg.icp?.revenue_floor_usd), 'icp.revenue_floor_usd must be a number');
  want(isArr(cfg.icp?.geography), 'icp.geography is missing');
  // WHERE THE OPERATOR IS, STATED ONCE. me.yml owns the fact; icp.home_metros is
  // its operational expansion into the towns that count as the same market. They
  // are merged by homeGeoOf, so a place named in either reaches scoring — but a
  // base in me.yml that icp does not know about is worth saying out loud, since
  // it means the two files were edited at different times and one was forgotten.
  for (const [field, place] of [['metro', cfg.firm?.location?.metro],
                                ['secondary', cfg.firm?.location?.secondary]]) {
    if (!isStr(place)) continue;
    const city = String(place).split(',')[0].trim().toLowerCase();
    want((cfg.icp?.home_metros ?? []).some((m) => String(m).toLowerCase() === city),
      `firm.location.${field} is "${place}" and icp.home_metros does not list "${
        String(place).split(',')[0].trim()}". It is counted as home anyway, but the ` +
      'two files disagree about where you work.');
  }

  // ---- gates ----------------------------------------------------------------
  need(isArr(cfg.gates), 'gates must be a non-empty list; they are the heart of the system');
  const gateIds = new Set();
  for (const [i, g] of (cfg.gates ?? []).entries()) {
    const at = `gates[${i}]`;
    need(isStr(g?.id), `${at}.id is required`);
    need(isStr(g?.kill_if), `${at} ("${g?.id}") needs a kill_if condition`);
    if (isStr(g?.id)) {
      need(!gateIds.has(g.id), `${at}.id "${g.id}" is duplicated`);
      gateIds.add(g.id);
    }
    const sev = g?.severity ?? 'kill';
    need(['kill', 'warn'].includes(sev), `${at}.severity must be kill or warn, got "${sev}"`);
  }

  // ---- triggers -------------------------------------------------------------
  need(isArr(cfg.triggers), 'triggers must be a non-empty list');
  const triggerIds = new Set();
  for (const [i, t] of (cfg.triggers ?? []).entries()) {
    const at = `triggers[${i}]`;
    need(isStr(t?.id), `${at}.id is required`);
    need(isNum(t?.weight) && t.weight > 0, `${at} ("${t?.id}") needs a positive weight`);
    // HOW LONG THIS EVENT STAYS TRUE, per trigger. Absent means the global
    // `sources.news.lookback_days`. It exists because four triggers state a
    // bound in their own description and all fifteen decayed on one number.
    need(t?.decay_days === undefined || (isNum(t.decay_days) && t.decay_days > 0),
      `${at} ("${t?.id}").decay_days must be a positive number of days if set`);
    // WHAT THIS TRIGGER LICENSES. `evidence_class` says how it is FOUND; this
    // says what it entitles the system to conclude, and the two are independent.
    need(['work', 'urgency'].includes(t?.kind),
      `${at} ("${t?.id}").kind must be work or urgency — does this trigger name WHAT TO ` +
      'BUILD, or only that it is urgent and they can pay?');
    if (isStr(t?.id)) {
      need(!triggerIds.has(t.id), `${at}.id "${t.id}" is duplicated`);
      triggerIds.add(t.id);
    }
  }

  // ---- sources --------------------------------------------------------------
  const ja = cfg.sources?.job_apis ?? {};
  const enabledAts = ATS.filter((a) => ja[a] === true);
  want(enabledAts.length > 0, 'no job API is enabled in sources.job_apis; scan will find nothing');

  const boards = ja.boards ?? [];
  need(Array.isArray(boards), 'sources.job_apis.boards must be a list');
  const seenBoards = new Set();
  for (const [i, b] of (Array.isArray(boards) ? boards : []).entries()) {
    const at = `sources.job_apis.boards[${i}]`;
    need(ATS.includes(b?.ats), `${at}.ats must be one of ${ATS.join('|')}, got "${b?.ats}"`);
    need(isStr(b?.token), `${at}.token is required (the board slug in the ATS URL)`);
    if (isStr(b?.token) && ATS.includes(b?.ats)) {
      const key = `${b.ats}/${b.token}`;
      want(!seenBoards.has(key), `${at} duplicates ${key}`);
      seenBoards.add(key);
      want(ja[b.ats] === true, `${at} targets ${b.ats}, which is disabled in sources.job_apis`);
    }
  }
  want(Array.isArray(boards) && boards.length > 0,
    'sources.job_apis.boards is empty. These APIs have no global search — each request is scoped ' +
    'to one company board token — so scan has nothing to query. Run `npm run scan -- --discover` ' +
    'to probe board tokens for orgs already in the database.');

  // ---- models ---------------------------------------------------------------
  need(isStr(cfg.models?.default), 'models.default is required');

  // A wrong model id is a 404 at call time, after the operator has already
  // waited. Catch it here. Date-suffixed ids like "claude-haiku-4-5-20251001"
  // are the common form of this mistake — current ids carry no date.
  const known = new Set(knownModels());
  const declared = [cfg.models?.default, cfg.models?.cheap, cfg.models?.grader,
                    ...(cfg.models?.bakeoff ?? [])].filter(isStr);
  for (const id of new Set(declared)) {
    want(known.has(id),
      `models: "${id}" is not a model id this system has pricing for. ` +
      (/-\d{8}$/.test(id)
        ? 'It looks date-suffixed; current ids carry no date. '
        : '') +
      `Known: ${[...known].join(', ')}`);
  }

  want(isStr(cfg.models?.grader), 'models.grader is missing; the grading stage has no frontier model');
  want(isArr(cfg.models?.bakeoff), 'models.bakeoff is empty; the cost study cannot sweep');
  if (isStr(cfg.models?.grader) && isArr(cfg.models?.bakeoff)) {
    // §8: the grader must never sit in the production path being graded.
    want(!cfg.models.bakeoff.includes(cfg.models.grader),
      `models.grader "${cfg.models.grader}" also appears in models.bakeoff; a model cannot grade its own output`);
  }

  if (errors.length) throw new ConfigError(errors, path);

  // Normalise the shape the rest of the system reads.
  cfg.sources = cfg.sources ?? {};
  cfg.sources.job_apis = {
    ...DEFAULTS,
    ...ja,
    boards: (Array.isArray(boards) ? boards : []).filter((b) => ja[b.ats] === true),
    enabled: enabledAts,
  };
  cfg.gates = cfg.gates.map((g) => ({ ...g, severity: g.severity ?? 'kill' }));
  // THE NEW BUSINESS FILE WINS where a setting has moved there (firm, the
  // operator's own facts, the outreach budget). See src/business.mjs; the rest
  // of business.yml is read by the stages that have switched over.
  overlayBusiness(cfg);
  cfg._warnings = warnings;
  cfg._path = path;
  cfg._files = used;
  // LAST, AND IT THROWS. Every command loads config, so every command enforces
  // the forbidden-host rule — there is no entry point that can skip it, which
  // is the whole difference between this and the paragraph in CLAUDE.md that
  // said the same thing for three weeks.
  assertForbiddenHostsUnused(cfg);
  return cfg;
}

/**
 * One pitch, resolved: its services, the proof points that are evidence FOR it,
 * and the seats that buy it. `citable_proof_points` is the subset with a public
 * URL — the drafting stage is handed only those, because a claim without a
 * retrievable link is a defect (CLAUDE.md).
 */
/**
 * Every live service sold under a pitch, by its own declaration.
 *
 * ONE PREDICATE, because there were two. `pitch()` and `packageForBuyer()` each
 * filtered the catalogue with their own copy of the same rule, and adding
 * `also_under` to one of them silently unrouted twelve firms: the pitch page
 * showed the offer, the router could not find it, and nothing reported a
 * contradiction. The third instance of one rule written twice in a single day.
 */
function packagesUnder(cfg, buyerId) {
  return (cfg.packages ?? []).filter((s) =>
    (s.buyer === buyerId || (s.also_under ?? []).includes(buyerId))
    && (s.status ?? 'live') !== 'retired');
}

export function buyer(cfg, buyerId) {
  const p = (cfg.buyers ?? []).find((x) => x.id === buyerId);
  if (!p) return null;
  // A retired service stays in the file as a record and is never proposed.
  // A service belongs to one pitch and may be SOLD UNDER others. One hourly
  // engagement is the same product whether the buyer has an AI team or not;
  // what differs is the sentence, and the sentence is what a pitch is.
  const services = packagesUnder(cfg, buyerId);
  const proof = (cfg.operator?.proof_points ?? []).filter(
    (x) => (x.buyers ?? []).includes(buyerId));
  return {
    ...p,
    status: p.status ?? 'live',
    services,
    proof_points: proof,
    citable_proof_points: proof.filter((x) => isStr(x.evidence_url)),
    buyer_titles: [...new Set(services.flatMap((s) => s.buyer_titles ?? []))],
    // Cheapest way in. A fee below one signature is the easiest yes.
    entry_package: services
      .map((s) => ({ s, p: s.price_usd ?? s.price_usd_month ?? (s.rate_usd_hour ?? 0) * 40 }))
      .sort((a, b) => a.p - b.p)[0]?.s ?? null,
  };
}

/**
 * WHICH SERVICE INSIDE THE CHOSEN PITCH, from the evidence rather than the price
 * list. `rank` took the pitch's cheapest service and stopped -- buyers_side
 * always meant the proposal read, build_direct always meant the working session
 * -- so five of eight offers could not be assigned by any code path. Pilot
 * management sat at zero and read as a market verdict when it was a routing
 * ceiling: nothing could ever put anyone there.
 *
 * Each service declares `fires_when`, evaluated against facts the dossier
 * actually holds at this point. Candidates are ordered by the same `priority`
 * that orders the dashboard chips, so one judgment drives both. A service with
 * no `fires_when` is a fallback and only wins if nothing else does; the pitch's
 * entry service remains the last resort, so a firm always gets an offer.
 */
/**
 * Does a `fires_when` block match these facts? Returns { ok, trigger } where
 * `ok` is true (matched), false (failed a condition) or null (the block is
 * absent, so this is a fallback rather than a match).
 *
 * Extracted 2026-09-19 so that SERVICE selection and CAPABILITY selection read
 * the same grammar. Two matchers over one vocabulary is how `staffed: false`
 * ends up meaning one thing on an offer and another on a capability, and the
 * divergence would show up as a card that recommends work the evidence does not
 * support — which is the exact defect the capability split exists to remove.
 */
export function firesWhenMatch(w, facts = {}) {
  const { triggers = new Set(), staffed = false, headcount = null } = facts;
  if (!w) return { ok: null, trigger: null };      // fallback, not a match
  if (w.never) return { ok: false, trigger: null };
  let trigger = null;
  if (w.triggers_any) {
    trigger = w.triggers_any.find((t) => triggers.has(t)) ?? null;
    if (!trigger) return { ok: false, trigger: null };
  }
  // A TRACK RECORD IS NOT AN EVENT. Some offers fit a firm's operating model
  // rather than a moment in it -- "they habitually buy pilots and employ nobody
  // to judge them" is a pattern, and one occurrence is not a pattern.
  // `min_signals` counts live signals of the named triggers instead of merely
  // asking whether one exists.
  if (w.min_signals != null) {
    const seen = (w.count_triggers ?? w.triggers_any ?? [])
      .reduce((n, t) => n + (facts.triggerCounts?.[t] ?? 0), 0);
    if (seen < w.min_signals) return { ok: false, trigger };
  }
  if (w.staffed != null && Boolean(staffed) !== Boolean(w.staffed)) return { ok: false, trigger };
  // A missing headcount does not satisfy a headcount condition. An unknown is
  // not a small firm, and guessing that it is was how the small-shop offer
  // would have swallowed every unmeasured enterprise.
  if (w.min_headcount != null && !(headcount >= w.min_headcount)) return { ok: false, trigger };
  if (w.max_headcount != null && !(headcount != null && headcount <= w.max_headcount)) {
    return { ok: false, trigger };
  }
  return { ok: true, trigger };
}

/**
 * WHAT THE WORK IS, chosen from evidence alone.
 *
 * Deliberately independent of which service gets proposed. Evidence names the
 * capability -- a firm advertising for three contract administrators is
 * describing reading, checking and drafting, dated and in its own words -- and
 * the buyer's seat names the form. Deriving the form straight from the trigger
 * was the old behaviour and it required a leap the evidence never supported.
 *
 * Returns null rather than guessing. There is no fallback capability on
 * purpose: "we do not know what they need" is a true and useful answer, and an
 * invented one would be the same default-dressed-as-a-judgment this split
 * exists to remove.
 */
export function evidenceClassesFor(cfg, capability) {
  // Derived, never declared twice. The class is a property of the TRIGGER — a
  // job posting is a job posting whatever it evidences — so signals.yml owns it
  // and a capability inherits whatever its triggers carry. Declaring it on both
  // is how they end up disagreeing.
  const byId = new Map((cfg?.triggers ?? []).map((t) => [t.id, t.evidence_class]));
  return [...new Set((capability?.fires_when?.triggers_any ?? [])
    .map((t) => byId.get(t)).filter(Boolean))];
}

/**
 * EVERY capability the evidence supports, best first. Extracted 2026-09-20 so
 * that `packageForBuyer` can route THROUGH it instead of re-reading the same
 * triggers one layer down, which is the non-orthogonality recorded in the
 * offers analysis: a build package fired on a strict subset of what named
 * `custom_build`, and a small-shop package fired on the exact union of what
 * named the five small-build capabilities. Two lists that must agree and no
 * mechanism making them agree.
 */
export function workHits(cfg, facts = {}) {
  const all = (cfg?.work ?? []).filter((c) => (c.status ?? 'live') !== 'retired');
  const hits = [];
  for (const c of all) {
    const m = firesWhenMatch(c.fires_when, facts);
    if (m.ok === true) hits.push({ capability: c, trigger: m.trigger });
  }
  // Ordered by the offer menu: a capability delivered by a higher-priority
  // service is the one to lead with, because that is the offer most likely to
  // be proposed alongside it.
  const priOf = (c) => Math.min(...((c.delivered_by ?? []).map((id) =>
    (cfg.packages ?? []).find((s) => s.id === id)?.priority ?? 99)), 99);
  hits.sort((a, b) => priOf(a.capability) - priOf(b.capability));
  return hits;
}

export function workForFacts(cfg, facts = {}) {
  const hits = workHits(cfg, facts);
  if (!hits.length) return null;
  return {
    capability: hits[0].capability,
    trigger: hits[0].trigger,
    form: hits[0].capability.form ?? null,
    // The class of the trigger that ACTUALLY fired, not every class the
    // capability could be found by. This records how this prospect was found.
    evidenceClass: (cfg?.triggers ?? []).find((t) => t.id === hits[0].trigger)?.evidence_class ?? null,
    alternatives: hits.slice(1).map((h) => ({
      id: h.capability.id, label: h.capability.label ?? h.capability.id, trigger: h.trigger,
    })),
  };
}

/**
 * SEAT, SIZE AND BUDGET ONLY. A service is HOW the work is bought, so the only
 * questions it may ask are about the buyer: how big they are, whether the seat
 * is filled, whether the money clears. What the work IS was already decided one
 * layer up, by the capability, from the evidence.
 *
 * So a `triggers_any` on a service is stripped here rather than honoured. It is
 * also warned about at load, because leaving it silently ignored would be its
 * own trap -- an operator editing a trigger list that no longer does anything.
 */
function seatConditions(w) {
  if (!w) return null;                       // asks nothing: a fallback, not a match
  const { triggers_any, min_signals, count_triggers, ...seat } = w;
  return seat;
}

/**
 * WHICH SERVICE, reached THROUGH the capability rather than beside it.
 *
 *     evidence -> capability -> delivered_by -> filter by seat and size -> service
 *
 * Rewired 2026-09-20. Services used to declare their own `triggers_any`, which
 * made the service layer a second reader of the evidence the capability layer
 * had already read -- and the two lists drifted, exactly as two copies of one
 * judgment always do. A build package fired on two triggers while `custom_build`, the
 * capability it delivers, fired on three; the firms carrying only the third
 * reached a capability and no offer. 28 of them, every one a firm the system
 * could name the work for and had nothing to sell.
 *
 * `delivered_by` on each capability already named its candidate services and
 * nothing consumed it. Now it is the only route in, so the two lists cannot
 * disagree: there is one list.
 */
export function packageForBuyer(cfg, buyerId, facts = {}) {
  // A retired service is not on the menu. `entry_package` already filtered on
  // this and the selector did not, so a retired offer could still be assigned
  // through the fallback path -- visible nowhere, routed to anyway.
  const mine = packagesUnder(cfg, buyerId);
  if (!mine.length) return null;

  // STEP 1 AND 2. The evidence names capabilities; each capability names the
  // services that can deliver it. First capability to name a service owns the
  // attribution, since `workHits` is already ordered best-first.
  const hits = workHits(cfg, facts);
  const via = new Map();            // package id -> { capability, trigger }
  for (const { capability, trigger } of hits) {
    for (const sid of capability.delivered_by ?? []) {
      if (!via.has(sid)) via.set(sid, { capability, trigger });
    }
  }

  // STEP 3. The service answers for itself, about the BUYER and nothing else.
  const seatOk = (s) => firesWhenMatch(seatConditions(s.fires_when), facts).ok;

  // Ordered by the same `priority` that orders the dashboard chips, so one
  // judgment drives the menu and the router both.
  const byPri = (a, b) => (a.priority ?? 99) - (b.priority ?? 99);
  const matched = mine.filter((s) => via.has(s.id) && seatOk(s) !== false).sort(byPri);

  // A service no capability delivers is UNREACHABLE, and that is a finding
  // rather than a bug to paper over: nothing in the evidence says what work it
  // would be. It is not silently promoted into a match.
  const orphan = mine.filter((s) => !via.has(s.id));

  // EVERYTHING THAT FITS, not only the winner. The operator knows things the
  // dossier does not, and a second offer that the evidence also supports is
  // worth seeing before he writes -- especially where the two sit either side
  // of one decision, like a read before a pilot and management during it.
  //
  // NOT scored: any number attached to "chance of success" here would be
  // asserted, since the whole record is 25 sends and no service clears the
  // n>=40 floor. Fit is a fact about the evidence; likelihood is not available
  // and is not implied.
  const alternatives = matched.slice(1).map((s) => ({
    id: s.id, label: s.label ?? s.id,
    why: `delivers ${via.get(s.id).capability.id}, which the evidence also supports`,
  }));

  if (matched.length) {
    const win = matched[0];
    const { capability, trigger } = via.get(win.id);
    return {
      service: win,
      basis: 'evidence',
      trigger: trigger ?? null,
      capability: capability.id,
      why: `delivers ${capability.label ?? capability.id}`
        + (trigger ? `, and ${trigger} is live here` : ''),
      alternatives,
    };
  }

  // THE BUYER DECIDED IT, and only when the evidence named NO WORK AT ALL.
  //
  // Routing to a buyer is itself a judgment -- firm kind, staffing, the money
  // gate -- and where the evidence adds nothing on top, that judgment is still
  // the best thing known about the firm. This used to be spelled "the buyer has
  // exactly one live package", which made it an accident of MENU SIZE: it fired
  // for a buyer carrying one offer and vanished the moment a second was added.
  // Unretiring `senior_capacity` on 2026-09-20 did exactly that and stripped the
  // offer from seven firms -- adding an offer must not remove offers.
  //
  // SCOPED DELIBERATELY to `!hits.length`, which is the whole point of the
  // condition. If the evidence DID name work and none of this buyer's packages
  // delivers it, that is a real gap between what the firm needs and what is on
  // the menu, and it is reported as one. Falling back there would bury the
  // finding under an offer nothing chose on the evidence -- the same
  // default-dressed-as-a-judgment the cheapest-way-in fallback was removed for.
  if (!hits.length) {
    const byBuyer = mine.filter((s) => seatOk(s) !== false).sort(byPri);
    if (byBuyer.length) {
      return {
        service: byBuyer[0],
        basis: 'buyer',
        trigger: null,
        capability: null,
        why: mine.length === 1
          ? 'the only offer under the buyer this firm was routed to'
          : 'the evidence names no work, so the buyer decides; this is its leading offer',
        alternatives: byBuyer.slice(1).map((s) => ({
          id: s.id, label: s.label ?? s.id, why: 'also sold under this buyer',
        })),
      };
    }
  }

  // A DEFAULT IS NOT AN OFFER, so none is returned. A firm with nothing to sell
  // it is a finding, and the blocker that states it is the point. The old
  // cheapest-way-in fallback existed so every firm got SOMETHING, and that was
  // the error: a default still wrote a package_id, which slipped it past the
  // "nothing to sell this firm" blocker and let the firm rank on authority and
  // reachability alone.
  void orphan;
  return null;
}

/**
 * Which single pitch fits an org, or null. The selector is the KIND of firm —
 * that is the fact that decides it, and it is the fact the 2026-08-25 audit
 * turned on. Never returns a list: a note that offers a choice makes the reader
 * do work they will not do.
 */
/**
 * Does a firm clear a pitch's money gate? Any ONE of the declared floors is
 * enough — revenue, announced capex, or AUM — because a firm proves it can
 * absorb a retainer in whichever of those terms it happens to publish.
 *
 * Unknown size does NOT clear the gate. "A null is not a pass" applies here as
 * it does everywhere else: a firm whose size nobody established is not a firm
 * that has demonstrated the fee is noise.
 */
/**
 * DOES THIS SEAT BUY THIS PACKAGE. Every package declares `buyer_titles` and
 * nothing read them: `rank` routes the FIRM to a package, then picks the
 * highest-authority PERSON at that firm independently, and the two were never
 * required to agree. So a Group CFO with three years of quarterly-results posts
 * and no mention of AI in any of them led the shortlist under an offer whose
 * buyer_titles are CTO, VP Engineering, Head of AI and Head of Data — while the
 * one seat at that firm who had just been handed the AI mandate sat at 4,
 * because his title field still read Group Chief Actuary.
 *
 * Deliberately generous. This is a BLOCKER, and a blocker that fires on a
 * wording difference is worse than none: it would file a real buyer under
 * "wrong seat" and the operator would stop trusting the column. A declared
 * title matches when its words appear in the seat, when the seat's words appear
 * in it, or through the abbreviation table below — the three-letter forms are
 * how people actually write these titles and treating "CTO" and "Chief
 * Technology Officer" as different strings is a bug wearing a tie.
 *
 * Returns null, not false, when the package declares no buyer_titles. Nothing
 * was asserted about who buys it, so there is nothing to contradict.
 */
const TITLE_SYNONYMS = [
  ['cto', 'chief technology officer', 'chief technical officer'],
  ['cio', 'chief information officer'],
  ['ceo', 'chief executive officer'],
  ['coo', 'chief operating officer'],
  ['cfo', 'chief financial officer'],
  ['cdo', 'chief digital officer', 'chief data officer'],
  ['caio', 'chief ai officer', 'chief artificial intelligence officer'],
  ['vp', 'vice president'],
  ['svp', 'senior vice president'],
  ['evp', 'executive vice president'],
  ['md', 'managing director'],
  ['gm', 'general manager'],
  // THE BARE EXPANSIONS, added 2026-09-23. This table had the CHIEF forms of AI
  // and nothing else, so "Director of Artificial Intelligence" never became
  // "Director of AI" and a buyer list containing "Director of AI" did not match
  // it. Meanwhile SYNONYMS in targeting.mjs — which the GATE uses — has carried
  // /artificial intelligence/ -> ai all along. The result was one seat with two
  // answers: a firm's Director of Artificial Intelligence counted as "they
  // already employ this" on the kill side and "wrong seat" on the sell side, at
  // the same firm, in the same run.
  //
  // Two tables describing the same thing is the underlying defect and this only
  // closes the gap; the tables should be one. See normaliseTitle() in
  // targeting.mjs for the other half.
  ['ai', 'artificial intelligence'],
  ['ml', 'machine learning'],
  ['ds', 'data science'],
];
export function titleFitsBuyer(personTitle, buyerTitles = []) {
  const want = (buyerTitles ?? []).filter(Boolean);
  if (!want.length) return null;                 // asserts nothing, contradicts nothing
  const norm = (t) => ` ${String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  // One seat becomes every way of writing it, so the comparison is between
  // sets of spellings rather than between two arbitrary choices of spelling.
  const forms = (t) => {
    const n = norm(t);
    const out = new Set([n]);
    for (const group of TITLE_SYNONYMS) {
      for (const form of group) {
        if (n.includes(` ${form} `)) for (const alt of group) out.add(n.replace(` ${form} `, ` ${alt} `));
      }
    }
    return [...out];
  };
  // A SUBORDINATE OF A SEAT IS NOT THAT SEAT. Containment matching is what makes
  // this generous enough to be safe -- and on 2026-09-22 it made "President"
  // match inside "Executive Vice President", so every EVP at every firm passed
  // the seat check, a general counsel and a chief human resources officer among
  // them. A bank's CFO reached the top of a clear board that way. The same
  // failure sat under "Associate Vice Chancellor" matching "Chancellor".
  //
  // These words mark a different and lower seat, so a title that only matches
  // BEHIND one of them does not match at all. Checked on the occurrence rather
  // than the whole string: "Vice President of Engineering" is still a VP
  // Engineering, and a seat matching on some other declared title keeps it.
  const SUBORDINATE = /\b(vice|deputy|assistant|associate|acting|interim)\s+$/i;
  // The form keeps its padding on purpose. Trimming it was the first attempt and
  // it silently undid the guard: without the leading space the match started one
  // character into "president", so the prefix ended "...vice p" and nothing
  // looked subordinate. The padding IS the word boundary.
  const containsAsSeat = (seatStr, form) => {
    if (!form.trim()) return false;
    let at = seatStr.indexOf(form);
    while (at !== -1) {
      if (!SUBORDINATE.test(seatStr.slice(0, at + 1))) return true;
      at = seatStr.indexOf(form, at + 1);
    }
    return false;
  };
  // A MODIFIER BETWEEN THE RANK AND THE SEAT IS STILL THE SEAT.
  //
  // Containment alone cannot read "VP, Integrated Supply Chain" against the
  // pattern "VP Supply Chain", because a word sits in the middle. Real titles do
  // this constantly — Global, Integrated, Corporate, Americas — and on
  // 2026-09-23 it left 63 of 93 people from the conference channel at the
  // unmatched floor of 0.15, below the threshold that puts a card on the
  // dashboard. They were never judged and rejected; nothing could read their
  // job titles.
  //
  // THE WIDENING IS DELIBERATELY NARROW, because this is the function where
  // "President" once matched inside "Executive Vice President" and passed every
  // EVP in the book. Two constraints hold it:
  //   1. Only the words in MODIFIERS may be skipped, and at most two of them.
  //      A general gap would match "VP Finance" against "VP of Engineering,
  //      Finance Systems", which is a different seat.
  //   2. The skip may only happen after the FIRST token of the pattern, so a
  //      single-word pattern like "President" is untouched by any of this.
  // The SUBORDINATE guard still runs, at the position where the rest of the
  // pattern was found.
  const MODIFIERS = new Set(['global', 'integrated', 'corporate', 'enterprise', 'group',
    'regional', 'international', 'worldwide', 'americas', 'america', 'north', 'us', 'na',
    'strategic', 'advanced', 'technical', 'commercial', 'digital']);
  // "of" and "the" carry no seat information and appear on one side only:
  // "Director of Supply Chain" against "Director, Global Supply Chain".
  const FILLER = new Set(['of', 'the', 'for']);
  // svp and evp ARE vp for seat purposes. The spelled-out forms already reduce
  // through TITLE_SYNONYMS, so without this the abbreviation fails where the
  // long form succeeds — "Senior Vice President, Manufacturing Operations"
  // matched "VP Manufacturing" and "SVP Global Manufacturing" did not.
  const RANK = { svp: 'vp', evp: 'vp', avp: 'vp' };
  const words = (t) => t.trim().split(' ').filter(Boolean)
    .filter((x) => !FILLER.has(x)).map((x) => RANK[x] ?? x);
  const matchesWithModifier = (seatStr, form) => {
    const pat = words(form);
    if (pat.length < 2) return false;            // single-word patterns keep the old rule
    const w = words(seatStr);
    const rest = pat.slice(1);
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== pat[0]) continue;
      // THE GUARD, read against the word immediately before the RANK token —
      // not before the seat noun. Checking the later position let "Deputy Chief
      // Information Officer" match "Chief Information Officer", because the
      // word before "information" is "chief" and looks innocent.
      if (i > 0 && SUBORDINATE.test(` ${w[i - 1]} `)) continue;
      for (let skip = 0; skip <= 2; skip++) {
        const at = i + 1 + skip;
        if (at + rest.length > w.length) break;
        if (skip && !MODIFIERS.has(w[i + skip])) break;
        if (rest.every((r, k) => w[at + k] === r)) return true;
      }
    }
    return false;
  };

  const seat = forms(personTitle ?? '');
  return want.some((w) => forms(w).some((f) =>
    seat.some((s) => containsAsSeat(s, f) || containsAsSeat(f, s)
                  || matchesWithModifier(s, f)
                  || seatMatchesWithRankFirst(s, f))));
}

export function clearsMoneyGate(cfg, buyerId, org = {}) {
  const g = (cfg.buyers ?? []).find((p) => p.id === buyerId)?.money_gate;
  if (!g) return true;
  const checks = [
    [org.revenue_est, g.revenue_floor_usd],
    [org.announced_capex_usd, g.or_announced_capex_usd],
    [org.aum_usd, g.or_aum_usd],
    // HEADCOUNT AS A SIZE PROXY. Every other check needs a financial figure, and
    // 56 of the 58 firms carrying no offer at all had NONE of the three on file
    // -- so the largest bucket on the board was a data gap reading as a market
    // verdict. "A null is not a pass" is right and this was the wrong null to
    // apply it to: the gate asks whether $60k/year disappears into a budget line
    // nobody defends, and a firm with fourteen thousand employees answers that
    // without anyone looking up its revenue. The floor is declared per pitch, so
    // a pitch that genuinely needs a financial figure simply omits it.
    [org.headcount_est, g.or_headcount],
  ];
  return checks.some(([have, floor]) => floor != null && have != null && have >= floor);
}

/** A pitch in either of these states is not routed to. See the status note above. */
const OFF_MENU = new Set(['dead', 'retired']);

/**
 * DOES THIS FIRM ALREADY HAVE THE CAPABILITY? One answer, shared by `rank` and
 * `draft`, because it was computed separately in each and they drifted.
 *
 * Three places the fact hides, and no one of them is sufficient:
 *   a capability title on the team page   — stale for months after a hire
 *   a live capability_leader_recently_named signal — the dated announcement
 *   someone recorded as building it themselves    — a COO who ships agents
 *
 * This lived in rank.mjs alone and draft.mjs had its own title-only copy, so a
 * firm rank routed to the capacity pitch was judged by draft against the build
 * pitch — whose exclusion is "must NOT be used when the firm already employs
 * the capability". The drafter refused the top-ranked prospect on a condition
 * that was never the one in play. One function, both callers.
 */
export function firmIsStaffed(db, orgId, capabilityTitles = [], today = null) {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const BOARD_SEAT = /\b(board|non[- ]?exec|\bned\b|trustee|supervisory)\b/i;
  const AI_SEAT = /\b(a\.?i\.?|machine[ -]?learning|\bml\b|data science|analytics)\b/i;
  const titles = capabilityTitles.map((t) => String(t).toLowerCase());
  const byTitle = db.prepare('SELECT title FROM people WHERE org_id = ?').all(orgId)
    .some((q) => {
      if (!q.title || BOARD_SEAT.test(q.title)) return false;
      const hay = ` ${String(q.title).toLowerCase()} `;
      return titles.some((t) => hay.includes(t)) || AI_SEAT.test(q.title);
    });
  const namedLeader = db.prepare(
    `SELECT 1 FROM signals WHERE org_id = ? AND trigger_id = 'capability_leader_recently_named'
       AND retracted_at IS NULL AND (decays_at IS NULL OR decays_at > ?) LIMIT 1`).get(orgId, day);
  const builder = db.prepare(
    `SELECT 1 FROM people WHERE org_id = ? AND builds_in_house IS NOT NULL
       AND TRIM(builds_in_house) <> '' LIMIT 1`).get(orgId);
  // THE FOURTH ROUTE, AND THE ONLY ONE THAT IS NOT ABOUT A PERSON. Added
  // 2026-09-23. The three tests above all need a NAME — a title, an appointment,
  // a recorded builder — and a firm can say plainly that it employs this
  // capability without naming anybody. A collectibles grading firm was the case: its own
  // careers page reads "AI/ML Team hiring Senior ML Engineer with computer
  // vision; multiple models in production serving millions of people every day",
  // none of its sixteen named people holds a capability title, and so a
  // 2,000-person firm with models in production routed to build_direct — "end
  // client with a named problem and NO AI STAFF". The fact was in the database
  // the whole time, in a column nothing read.
  //
  // Set by `enrich` from the firm's own pages, and only from them: see
  // staffs_capability in src/enrich.mjs for what does and does not count.
  const staffsCapability = db.prepare(
    `SELECT 1 FROM orgs WHERE id = ? AND staffs_capability IS NOT NULL
       AND TRIM(staffs_capability) <> '' LIMIT 1`).get(orgId);
  return Boolean(byTitle || namedLeader || builder || staffsCapability);
}

export function buyerForOrg(cfg, { kind, hasVendorTrigger = false, referralValue = null,
                                   staffed = false, org = {} }) {
  const live = (cfg.buyers ?? []).filter((p) => !OFF_MENU.has(p.status ?? 'live'));
  const has = (id) => live.some((p) => p.id === id);

  // A strong referral node outranks the firm-kind rule: someone who cannot buy
  // but can route is worth asking for a name, whatever kind of firm they sit in.
  if (referralValue !== null && referralValue >= 0.6 && has('referral_ask')) {
    return { id: 'referral_ask', why: `referral node (${Math.round(referralValue * 100)}%) — asks for a name, sells nothing` };
  }

  switch (kind) {
    case 'individual':
      return has('referral_ask')
        ? { id: 'referral_ask', why: 'an individual operator with no bench — a referral ask, never a services pitch' }
        : null;
    case 'investor':
      // STAFFED FIRST, same as an end client. "Always the read" was written
      // before any investor had its own AI team, and it stopped being true: one
      // PE firm on this book now has a Head of AI AND a Director of AI, both
      // appointed to "work with portfolio company management teams to drive AI
      // strategy". That IS the buyers_side function. Selling it to them is
      // selling a firm the thing it just hired twice, and the record
      // holds exactly this firm as the case where "a newly appointed AI head
      // is the LEAST likely person to bring in an independent who does the same
      // thing — she is proving her own value".
      //
      // Two people covering an entire portfolio is not a judgment gap, it is a
      // capacity gap, and that is a different sentence and a different offer.
      if (staffed) {
        return has('senior_capacity')
          ? { id: 'senior_capacity',
              why: 'investor with its own AI team, thin against the portfolio it covers — ' +
                   'sell hands, not the judgment they were hired to provide' }
          : { id: null, why: 'investor already employs the capability, and no live pitch ' +
                             'sells to a buyer who has it' };
      }
      // Oversees companies that are buying, and has nobody of its own.
      //
      // THIS LINE SOLD NOTHING FOR THREE DAYS. It returned `buyers_side` alone,
      // and `buyers_side` was retired on 2026-09-19, so from that date every
      // investor without an AI team of its own routed to null — 11 of the 14
      // investors in the book, each printing NONE FITS while passing every gate. The identical
      // dead fallthrough sat in the end_client branch below; both were written
      // when the read existed and neither was revisited when it went.
      //
      // Same rule as an end client: a firm that has just bought a platform
      // needs hands to land it, whatever kind of firm it is.
      if (hasVendorTrigger && has('senior_capacity')) {
        return { id: 'senior_capacity',
          why: 'investor that has just selected or piloted a platform — sell hands to land ' +
               'it, not a second opinion on a purchase already made' };
      }
      // And with no team, no platform and a portfolio that is buying, what is
      // left to sell is the work itself at one of those companies. Not hands
      // beside a team — there is no team to stand beside, and saying so to a
      // firm that has none is the wrong sentence.
      return has('buyers_side')
        ? { id: 'buyers_side', why: 'investor overseeing portfolio companies that buy AI' }
        : has('build_direct')
          ? { id: 'build_direct',
              why: 'investor with no AI staff, overseeing portfolio companies that buy — ' +
                   'the sale is the work itself at a portfolio company' }
          : null;
    case 'public_body': {
      // A PUBLIC BODY, filed apart from companies 2026-10-02 at the operator's
      // word. Large ones have analytics or AI staff and a backlog -- "cities
      // have analytics teams and huge stack of use cases that are on hold due to
      // insufficient bandwidth" -- so they get hands by the hour. A small one (a
      // town, a small police department) with no sign of AI staff gets the
      // fixed-price build, which fits a purchase order where open-ended hours
      // need a contract. The line is `public_body.hourly_min_headcount` in
      // offers.yml; a headcount the model recalled rather than looked up is
      // said so, because the line is drawn on it.
      const min = Number(cfg.public_body?.hourly_min_headcount ?? 1000);
      const hc = Number(org.headcount_est);
      const big = Number.isFinite(hc) && hc >= min;
      const said = big ? `${hc.toLocaleString('en-US')} staff${/recall/i.test(org.headcount_source ?? '') ? ' (recalled, not looked up)' : ''}` : '';
      if ((staffed || big) && has('senior_capacity')) {
        return { id: 'senior_capacity',
          why: staffed ? 'public body with its own data or AI staff — hands for its backlog'
            : `public body of ${said}, large enough to have an analytics team — hands for its backlog` };
      }
      if (has('build_direct')) {
        return { id: 'build_direct',
          why: 'small public body with no sign of AI staff — one fixed-price build, which fits a ' +
               'purchase order where open-ended hours need a contract' };
      }
      return has('senior_capacity')
        ? { id: 'senior_capacity', why: 'public body; no fixed-price build is live, so hours' } : null;
    }
    case 'end_client':
      // Hands-on only where the retainer is a rounding error. Without this the
      // pitch chased anyone with a problem, and a $5k/mo engagement at a firm
      // that has to defend the line gets managed rather than used.
      if (!hasVendorTrigger && has('build_direct') && !clearsMoneyGate(cfg, 'build_direct', org)) {
        // THE FOURTH DEAD FALLTHROUGH TO buyers_side, and the one that took
        // longest to find because it hides inside a money test rather than at
        // the end of a switch. This returned null and told the operator to go
        // get a vendor trigger for "the buyers_side read" — a pitch retired on
        // 2026-09-19. So every end client too small to absorb a monthly
        // retainer was sold nothing at all, and the advice printed alongside
        // pointed at an offer that no longer exists.
        //
        // Found by `npm run unblock` on 2026-09-23, which returned
        // system_defect on FIVE separate people at five unrelated firms —
        // an engineering firm, a betting company, a distributor, a city and a
        // specialty insurer — each saying independently that the catalogue already holds
        // offers this firm could buy and the gate never looked at them.
        //
        // AN HOURLY RATE CLEARS NO THRESHOLD. That is the whole argument for
        // senior_capacity and it is written on the package: "Hourly, so it
        // clears no signature threshold and needs no committee — it is bought
        // the way contract engineering is bought." A firm that cannot commit
        // $5k a month can still buy an afternoon. Failing the retainer test is
        // a reason not to sell the retainer, not a reason to sell nothing.
        //
        // BUT HOURS NEED A TEAM TO JOIN. Changed 2026-10-02, the operator's
        // decision: a firm with no AI staff of its own has no team for an extra
        // pair of hands to sit beside, and 188 such firms were being sold
        // exactly that. One fixed-price build clears no signature
        // threshold at this size either, and answers what such a firm is about
        // to hire for. Hours stay the pitch where a team exists.
        if (staffed && has('senior_capacity')) {
          return { id: 'senior_capacity',
            why: 'end client with its own AI staff, below the hands-on money gate — a monthly ' +
                 'retainer would be a decision here, so sell hours, which clear no threshold' };
        }
        if (!staffed) {
          return { id: 'build_direct',
            why: 'end client with no AI staff, below the hands-on money gate — one fixed-price ' +
                 'build, which clears no threshold and gives hours no team to join' };
        }
        return { id: null, why: 'end client below the hands-on money gate, and no hourly ' +
          'pitch is live to sell in its place' };
      }
      // STAFFED FIRST. Both older pitches are predicated on the buyer having a
      // hole -- buyers_side wants nobody in-house to judge it, build_direct
      // wants nobody in-house to build it. Pitching either to a firm with a
      // real AI organisation is the thing the draft prompt refuses to write and
      // the operator's own guardrail forbids. senior_capacity is the pitch for
      // this buyer and it must win here, or it can never fire at all: it was
      // added and then routed to nobody, because this switch had no branch that
      // could return it.
      //
      // Deliberately NOT gated on hasVendorTrigger. A team that is short of
      // senior hands is short of them whether or not a vendor is circling, and
      // requiring a purchase event would put this pitch back behind the same
      // door the other two are behind.
      if (staffed) {
        return has('senior_capacity')
          ? { id: 'senior_capacity',
              why: 'end client with its own AI staff — sell hands, not judgment' }
          : { id: null, why: 'end client already employs the capability, and no live pitch ' +
              'sells to a buyer who has it' };
      }
      // A FIRM THAT JUST BOUGHT A PLATFORM IS NOT A FIRM WITH NOTHING.
      //
      // This line used to read `buyers_side` first and fall through to
      // `build_direct`. `buyers_side` was retired on 2026-09-19 and nothing
      // revisited the fallthrough, so from that day a vendor trigger quietly
      // meant `build_direct` — "end client with a named problem and no AI
      // staff" — and the system offered to BUILD SOMETHING NEW to a firm at the
      // exact moment it had just signed for a platform that does the thing.
      // Twenty-seven firms in the book carry one of these triggers and have had
      // no contact; every one of them was being routed that sentence.
      //
      // What a firm needs after it buys is not another build and not a second
      // opinion on the purchase it already made. It is hands to get the thing
      // onto real work, which is `senior_capacity` — and the platform vendor
      // selling a "Command Center to lead your AI transformation" is evidence
      // that adoption is the hard part, not a reason to think it is covered.
      //
      // Deliberately ahead of the `staffed` branch in EFFECT but not in order:
      // staffed still wins above, and lands on the same pitch anyway. The two
      // roads meet because they are the same situation seen from either side —
      // a team that owns the capability, and a platform that has to land on it.
      if (hasVendorTrigger && has('senior_capacity')) {
        return { id: 'senior_capacity',
          why: 'end client that has just selected or piloted a platform — sell hands to ' +
               'land it, not a second opinion on a purchase already made' };
      }
      return hasVendorTrigger && has('buyers_side')
        ? { id: 'buyers_side', why: 'end client with a vendor proposal or spend in motion' }
        : has('build_direct')
          ? { id: 'build_direct', why: 'end client with a named problem and no AI staff' }
          : null;
    case 'advisor':
      // A firm that advises clients on purchases but has no AI depth of its own.
      // Distinct from delivery_firm, and the distinction is whether the
      // capability sits INSIDE their product or BESIDE it. A firm whose product
      // IS AI delivery treats AI depth as core and hires for it. A firm that
      // sells, say, contract-negotiation leverage has AI questions arriving
      // beside its product, outside its competence, and not worth a hire.
      // The first hires, the second can buy.
      //
      // THE THIRD DEAD FALLTHROUGH, and the one a human missed. `buyers_side`
      // retired on 2026-09-19; the end_client and investor branches were found
      // and fixed by hand on 2026-09-22 and THIS one was walked past twice in
      // the same session. It was found by `npm run unblock` on its first real
      // run, which returned `system_defect` on six separate people at one
      // 6,500-lawyer firm and said the same thing each time: kind=advisor means
      // the firm sells ADVICE, not AI, and excluding it on that field conflates
      // the two. That firm is mid-rollout of Legora across 13,000 lawyers.
      //
      // Recorded here because it is the argument for that stage existing. A
      // model reading evidence will not find a report column bound to the wrong
      // field; it found this, because this one is visible from the outside — the
      // firm passes every gate, has a live programme, and is offered nothing.
      if (hasVendorTrigger && has('senior_capacity')) {
        return { id: 'senior_capacity',
          why: 'advisory firm mid-rollout of a platform it bought — sell hands to land it' };
      }
      return has('buyers_side')
        ? { id: 'buyers_side', why: 'advisory firm whose clients buy AI, with no AI depth of its own — sold as specialist judgment behind their practice' }
        : has('build_direct')
          ? { id: 'build_direct',
              why: 'advisory firm with no AI depth of its own — the sale is the work itself, ' +
                   'beside the practice rather than inside its product' }
          : null;
    case 'delivery_firm':
      return { id: null, why: 'sells AI delivery — overflow_bench is retired and buyers_side never fits a firm that judges vendors for a living' };
    case 'marketplace':
      return { id: null, why: 'brokers talent or expert calls — the marketplace_or_expert_network gate kills this' };
    case 'staffing':
      // A recruiter places contractors with client firms, so the operator's
      // hourly time is what they sell on, not what they compete with. Split out
      // of `marketplace` on 2026-09-29, when a recruiter at a small firm placing
      // senior engineers C2C wrote to the operator unprompted.
      return has('senior_capacity')
        ? { id: 'senior_capacity', why: 'staffing firm placing contractors — offer hours by the hour, C2C, for their clients' }
        : null;
    default:
      return { id: null, why: 'firm kind unknown — set it with `npm run lead -- add-org --kind ...` before pitching' };
  }
}

/** Titles the operator sells AGAINST -- the client's own in-house function,
 *  not anything in `work:`. Pooled from every gate that names them. */
export function capabilityTitles(cfg) {
  const out = new Set();
  for (const g of cfg.gates ?? []) for (const t of g.capability_titles ?? []) out.add(t);
  return [...out];
}

export function triggerWeight(cfg, id) {
  return cfg.triggers.find((t) => t.id === id)?.weight ?? 1;
}
