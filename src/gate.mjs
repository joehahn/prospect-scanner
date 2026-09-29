// Apply the gates from config/signals.yml and record why.
//
// "Deterministic where possible, one classification pass where not" (§5). It
// turns out most of it is deterministic. Once `enrich` has named the people a
// firm publishes, `capability_already_staffed` is a string match against
// capability_titles, not a judgment call — and that gate kills more candidates
// than all the others combined.
//
// Every result records a reason and, where one exists, the evidence row that
// justifies it. A kill the operator cannot audit is worse than no kill: the gate
// log is the most interesting dataset this system produces, because it says why
// the market keeps disqualifying itself.
//
// Hand-entered gate results are never overwritten. The operator's own judgment
// outranks this stage.
//
// Usage:
//   npm run gate                  every org with evidence
//   npm run gate -- --org <id>    just one
//   npm run gate -- --explain     show the evidence behind every outcome
//   npm run gate -- --redo        re-evaluate orgs already gated by this stage

import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig, capabilityTitles } from './config.mjs';
import { normaliseTitle } from './targeting.mjs';
import { loadBusiness, inCountries } from './business.mjs';

// THE SIZE BAND, from config/business.yml (2026-09-26), falling back to the old
// runtime.yml icp block. A target may carry its own band -- large Gulf firms
// are large by nature -- and it applies to a firm located in that target's
// countries, read from its people's recorded country or its headquarters.
// Firms are not yet filed under the new targets, so location is the link. A
// null in a target's band means no limit on that side.
let BIZ = null;
function sizeBand(ctx) {
  BIZ ??= loadBusiness(ctx.cfg);
  const icp = ctx.cfg.icp ?? {};
  const base = {
    revenue_min_usd: BIZ.size?.revenue_min_usd ?? icp.revenue_floor_usd,
    headcount_max: BIZ.size?.headcount_max ?? icp.headcount_ceiling,
    revenue_max_usd: BIZ.size?.revenue_max_usd ?? icp.revenue_ceiling_usd ?? 3_000_000_000,
    target: null,
  };
  const here = [
    ...ctx.db.prepare(`SELECT DISTINCT country FROM people WHERE org_id = ? AND country IS NOT NULL`)
      .all(ctx.org.id).map((r) => r.country),
    ctx.org.hq ?? '',
  ].join(' | ').toLowerCase();
  for (const t of BIZ.targets ?? []) {
    if (!t.size || !t.where?.countries?.length) continue;
    if (!inCountries(here, t.where.countries)) continue;
    const band = { ...base, target: t.name };
    for (const k of ['revenue_min_usd', 'headcount_max', 'revenue_max_usd']) if (k in t.size) band[k] = t.size[k];
    return band;
  }
  return base;
}
import { table, heading, bold, dim, truncate } from './report.mjs';

const MONTH_MS = 30 * 86_400_000;

function parseArgs(argv) {
  const args = {};
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
    if (n === undefined || n.startsWith('--')) args[k] = true; else { args[k] = n; i++; }
  }
  return args;
}

const matchesAny = (text, patterns) => {
  const hay = ` ${normaliseTitle(text)} `;
  return patterns.find((p) => {
    const needle = normaliseTitle(p);
    return needle && hay.includes(needle);
  }) ?? null;
};

/**
 * Deterministic evaluators, keyed by gate id. Each returns
 * {outcome, reason, evidence_id} or null for "cannot decide from what is here".
 *
 * A null is not a pass. It means the evidence does not reach the question, and
 * the gate stays unevaluated rather than quietly clearing the firm.
 */
const EVALUATORS = {
  capability_already_staffed(ctx) {
    const titles = ctx.gate.capability_titles ?? capabilityTitles(ctx.cfg);
    if (!titles.length) return null;

    // TENURE. The operator's own thesis says a RECENTLY named AI exec is the
    // buyer — fresh mandate, unspent budget, no team yet — and that the gate
    // should kill only "past about a year, when the appointee has staff".
    // Without this the two halves of his config contradict: discovery surfaces
    // firms whose whole value is a new AI appointment, and this gate kills every
    // one of them. A private equity firm was killed on a Director of AI appointed
    // fourteen days earlier.
    // 12, set by the operator on 2026-09-09 after reading a hedge fund CTO's
    // profile: in the seat since Sep 2021, five years in, with a named
    // technology organisation under him. The clearest case yet on the kill side
    // of the line, and the reason the line is drawn by tenure rather than title.
    const FRESH_MONTHS = Number(ctx.gate.fresh_months ?? 12);
    const freshCutoff = new Date(Date.now() - FRESH_MONTHS * 30 * 86_400_000)
      .toISOString().slice(0, 10);
    const freshAppointment = ctx.db?.prepare(
      `SELECT detected_at FROM signals WHERE org_id = ? AND retracted_at IS NULL
         AND trigger_id = 'capability_leader_recently_named' AND detected_at >= ?
       ORDER BY detected_at DESC`).get(ctx.org.id, freshCutoff);

    // A firm can employ the capability without naming a person: it can SELL it.
    // A bank advisory firm names nobody with an AI title, and its own solution
    // pages advertise AI advisory alongside vendor management — it sells the
    // judgment function this system pitches. Found on the first live draft run,
    // which refused to write the note.
    //
    // This reads a field `enrich` extracted, NOT a pattern over prose. The first
    // version regexed the evidence text and killed two firms on sentences that
    // said the opposite ("No named individuals with AI-related titles", "not a
    // delivery firm that builds AI"). Polarity is exactly what a classification
    // pass is for.
    // "A null is not a pass" has to hold for a MISSING FIELD too. If we do not
    // know whether this firm sells the capability, and it is the kind of firm
    // that plausibly might, the gate is undecidable — not clear. A software
    // consultancy passed every gate on a null flag while its own site advertised an AI
    // monthly retainer, and its VP of Engineering reached the shortlist.
    if (ctx.org.sells_ai_advisory == null
        && ['delivery_firm', 'advisor', 'individual'].includes(ctx.org.kind)) {
      return null;   // run `npm run enrich --org <id>` to decide it
    }

    if (ctx.org.sells_ai_advisory === 1 || ctx.org.sells_ai_delivery === 1) {
      const ev = ctx.evidence.find((e) => e.kind === 'firm_profile');
      return {
        outcome: 'kill',
        reason: `The firm SELLS this capability rather than employing it ` +
          `(${[ctx.org.sells_ai_advisory === 1 ? 'AI advisory' : null,
               ctx.org.sells_ai_delivery === 1 ? 'AI delivery' : null]
            .filter(Boolean).join(' and ')}). A firm whose own product includes it ` +
          'does not buy it from an independent.',
        evidence_id: ev?.id ?? null,
      };
    }

    // ORDER MATTERS, and it was wrong until 2026-09-09. The tenure branch below
    // returns `pass` on the first fresh appointee it finds, which short-circuited
    // everything after it — so a consultancy whose own site sells "evaluation,
    // selection, and implementation of applied AI applications", passed this gate
    // because it had recently appointed a Head of Applied AI. A weaker signal was
    // clearing a firm that a stronger one disqualifies.
    //
    // Selling the capability is categorical and beats any fact about a person: a
    // firm that judges AI vendors for a living does not buy that judgment,
    // whoever it hired last quarter. Tenure only decides firms that BUY.

    // A person the firm itself lists, whose title is the thing being sold.
    for (const p of ctx.people) {
      const hit = matchesAny(p.title, titles);
      if (!hit) continue;

      const inSeatFresh = p.in_seat_since && `${p.in_seat_since}-01` >= freshCutoff;
      if (freshAppointment || inSeatFresh) {
        return {
          outcome: 'pass',
          reason: `${p.name} holds "${p.title}", which matches the capability "${hit}" — but ` +
            `the appointment is recent (${freshAppointment?.detected_at ?? p.in_seat_since}). ` +
            `Inside ${FRESH_MONTHS} months that person is the BUYER, not the reason to walk: ` +
            'mandate live, budget unspent, no team hired yet, and no in-house judgment to lean ' +
            `on. This gate resumes killing after ${FRESH_MONTHS} months in seat.`,
          evidence_id: null,
        };
      }
      const ev = ctx.evidence.find((e) => e.person_id === p.id && e.kind === 'staff_listing')
        ?? ctx.evidence.find((e) => e.person_id === p.id);

      // AN END CLIENT WITH AI STAFF IS ROUTED, NOT KILLED. Added 2026-09-17.
      //
      // This gate is 25 of 40 kills on record, more than every other gate
      // combined, and it was correct for the catalogue that existed when it was
      // written: both live pitches required the buyer to have a hole -- one
      // wants nobody in-house to judge, the other wants nobody in-house to
      // build. Against those, a firm with an AI organisation genuinely could not
      // be sold to.
      //
      // `senior_capacity` inverts the precondition. It sells hours to a team
      // that ALREADY HAS senior people, out of a services budget rather than an
      // engineering req. For that pitch, staffed is the qualifying condition,
      // and killing on it threw away the only population it can address.
      //
      // The narrowing is deliberately limited to END CLIENTS, and the two
      // exclusions are the two things this gate was actually built to catch:
      //
      //   - A firm that SELLS the capability still dies, above, categorically
      //     and before this branch. That is the overflow_bench lesson, 0-for-7:
      //     a consultancy short of delivery capacity HIRES for it, because the
      //     capability is its product, so an independent reads as a candidate.
      //   - `advisor`, `delivery_firm`, `marketplace` and `individual` are
      //     untouched and still die here.
      //
      // The kill is preserved verbatim in the reason so the gate log still shows
      // what was found; only the outcome changes, and it changes to `warn` --
      // visible, not silent, and not a pass that pretends nothing was seen.
      // A PRACTICE IS SOLD, NOT STAFFED. The narrowing spared a law firm on its
      // first run: "Partner and Global Co-Head of AI Practice". A practice head
      // is client-facing revenue, not an internal team short of hands, and that
      // firm was judged a correct kill. The word is the
      // tell and it is the same tell in every professional-services firm.
      const SELLS_IT = /\b(practice|advisory|consulting|client[- ]facing|go[- ]to[- ]market)\b/i;
      if (ctx.org.kind === 'end_client' && ctx.hasCapacityPitch && !SELLS_IT.test(p.title ?? '')) {
        return {
          outcome: 'warn',
          reason: `${p.name} holds the title "${p.title}", which matches the capability ` +
            `"${hit}", so this firm employs what the READ and BUILD pitches are predicated on ` +
            'it lacking — both are disqualified here. Not a kill, because it is an end client ' +
            'and a staffed team is the qualifying condition for selling capacity by the hour ' +
            'rather than judgment. Route to senior_capacity; do not pitch a proposal read.',
          evidence_id: ev?.id ?? null,
        };
      }

      return {
        outcome: 'kill',
        reason: `${p.name} holds the title "${p.title}", which matches the capability ` +
          `"${hit}". The firm already employs what is being sold.`,
        evidence_id: ev?.id ?? null,
      };
    }
    // Evidence exists and none of it names such a person — that is a pass, not
    // a shrug, but only if we actually looked at their own site.
    const looked = ctx.evidence.some((e) => e.kind === 'staff_listing' || e.kind === 'firm_profile');
    return looked
      ? { outcome: 'pass',
          reason: `${ctx.people.length} people named on the firm's own pages, none holding a ` +
            'capability title. NOTE: team pages go stale and small firms hide staff.',
          evidence_id: null }
      : null;
  },

  open_req_for_capability(ctx) {
    const titles = ctx.gate.capability_titles ?? capabilityTitles(ctx.cfg);
    const posts = ctx.evidence.filter((e) => e.kind === 'job_posting');
    if (!posts.length) return null;
    for (const e of posts) {
      const hit = matchesAny(e.claim, titles);
      if (hit) {
        return { outcome: ctx.gate.severity === 'kill' ? 'kill' : 'warn',
          reason: `Open req matching "${hit}": ${truncate(e.claim, 180)}`,
          evidence_id: e.id };
      }
    }
    return { outcome: 'pass',
      reason: `${posts.length} postings in window, none matching a capability title.`,
      evidence_id: null };
  },

  // THE SELLER'S CONSTRAINT, NOT THE BUYER'S. `too_small` asks whether the fee
  // makes sense to them; this asks whether a one-person firm can transact with
  // them at all. Above the ceiling the binding constraint stops being interest
  // and becomes procurement: MSA, vendor onboarding, security review. Declared
  // `warn` rather than `kill` because the book already holds firms above it,
  // one of them with a live offer and a sent note.
  too_big(ctx) {
    const band = sizeBand(ctx);
    const ceiling = band.headcount_max;
    const hc = ctx.org.headcount_est;
    // A target that sets no headcount ceiling is a decision, not a gap: say so.
    if (band.target && ceiling == null) {
      return { outcome: 'pass', reason: `No headcount ceiling for firms in the target "${band.target}", `
        + 'whose firms are large by nature; its own size band applies (config/business.yml).',
        evidence_id: ctx.derivedFrom };
    }
    // REVENUE STANDS IN WHEN HEADCOUNT IS MISSING. Added 2026-09-25: a Fortune
    // 50 retailer passed this gate, and its newly named Chief AI Officer reached
    // first place to write, because no headcount was on file -- while $107bn of
    // revenue sat in the same row. An unknown headcount returned "undecided",
    // and undecided reads as a pass.
    //
    // Deliberately narrow. Only a figure LABELLED revenue (a budget, assets under
    // management or an FDIC asset total is not one: seven community banks carry
    // their balance sheet in this column), and a ceiling well above the
    // headcount line's revenue equivalent (~$1.5bn at 5,000 people), so only
    // firms that are enterprise on any reading are struck. The closer calls
    // wait for a headcount.
    const revCeiling = band.revenue_max_usd == null ? Infinity : Number(band.revenue_max_usd);
    const rev = ctx.org.revenue_est;
    const byRevenue = hc == null && rev >= revCeiling
      && ctx.org.revenue_basis === 'revenue'
      && !/FDIC/i.test(ctx.org.source ?? '');
    // An unknown headcount is not a small firm. Returning null leaves the gate
    // unevaluated, which is the honest state and is how every other gate here
    // treats a missing fact.
    if (!ceiling || (hc == null && !byRevenue)) return null;
    // A live shadow-IT signal RAISES this ceiling, it does not remove it. See
    // signals.yml: handled here rather than through the generic `unless_trigger`
    // path precisely because that path turns a kill into a pass, and every firm
    // this thesis finds carries one of these triggers by construction.
    const ex = ctx.gate.exempt_trigger ?? [];
    let limit = ceiling;
    let relaxed = null;
    if (ex.length && ctx.gate.exempt_ceiling) {
      const hit = ctx.db.prepare(
        `SELECT trigger_id FROM signals WHERE org_id = ? AND retracted_at IS NULL
           AND trigger_id IN (${ex.map(() => '?').join(',')}) LIMIT 1`).get(ctx.org.id, ...ex);
      if (hit) { limit = ctx.gate.exempt_ceiling; relaxed = hit.trigger_id; }
    }
    // NAME WHERE THE NUMBER CAME FROM. A gate reason is the sentence a human
    // reads when deciding whether to argue with the verdict, and "above the
    // ceiling" reads very differently depending on whether the number was read
    // off the firm's own page or recalled by a model. Both are allowed to gate;
    // only one is allowed to sound certain.
    // A NAMED PRIOR RELATIONSHIP IS THE ANSWER TO THE QUESTION THIS GATE ASKS.
    // The gate is about procurement and nothing else -- see TODO 2g, where an
    // `unless_trigger` waiver was tried here and swallowed the gate whole,
    // because every firm the shadow-IT thesis finds carries an exempting trigger
    // by construction. A 2.1-million-person retailer passed a 5,000 ceiling and
    // the log said `pass` with a straight face.
    //
    // This cannot fail that way, and the difference is where the fact comes
    // from. `prior_relationship` is operator-supplied prose about a named person
    // at this firm: no source produces it, no signal implies it, and no
    // discovery run can manufacture one. It says the operator already has a
    // door, which is precisely what a headcount is being used to guess about.
    //
    // It WARNS rather than passes. The firm really is large, the size fact is
    // true and worth carrying on the card, and a relationship with one person
    // does not make an enterprise small. What it does is stop the firm being
    // struck off before anyone reads that sentence.
    const over = byRevenue || hc > limit;
    const revQual = ctx.org.revenue_source === 'page' ? 'stated on their site'
      : ctx.org.revenue_source === 'recalled' ? 'RECALLED, not retrieved'
      : ctx.org.revenue_source ? `from ${ctx.org.revenue_source}` : 'source unrecorded';
    const sizeText = () => (byRevenue
      ? `$${(rev / 1e9).toFixed(rev >= 1e10 ? 0 : 1)}bn of revenue (${revQual}; no headcount on file, ` +
        `so revenue stands in at a $${(revCeiling / 1e9).toFixed(1)}bn line)`
      : `${hc.toLocaleString('en-US')} people${qual}`);
    const known = over ? ctx.db.prepare(
      `SELECT name, title, prior_relationship FROM people
        WHERE org_id = ? AND TRIM(COALESCE(prior_relationship, '')) <> '' LIMIT 1`)
      .get(ctx.org.id) : null;
    const src = ctx.org.headcount_source;
    // EVERY PROVENANCE GETS A WORD, and the ones missing from this map were the
    // dangerous ones. `recalled` and a null source both rendered as '', so a
    // number a model remembered read exactly like one stated on the firm's own
    // page. Twenty firms carry a recalled headcount and forty-five carry one
    // from nowhere at all.
    //
    // It cost a verdict on 2026-09-22: the third-largest county in the United
    // States was on file at 4,000 people, recalled, against a true figure
    // around 16,000, and it passed a 5,000 ceiling in silence while its own
    // sheriff's office was killed at 5,100. A kill on a wrong number is visible
    // — the firm is struck off and someone argues. A PASS on a wrong number is
    // invisible, and that is the direction this map was hiding.
    const qual = src === 'page' ? ' (stated on their site)'
      : src === 'operator' ? ' (supplied by the operator)'
      : src === 'search' ? ' (from a cited source)'
      : src === 'recalled' ? ' (RECALLED, not retrieved — no source, check before acting)'
      : src === 'estimate' ? ' (ESTIMATED, not retrieved — worth checking before acting)'
      : ' (source unrecorded — this number came from nowhere anyone can point at)';
    const why = relaxed
      ? ` (ceiling raised from ${ceiling.toLocaleString('en-US')} because ${relaxed} is live here)`
      : '';
    // THE SECOND EXEMPTION, and it negates this gate's own reasoning rather than
    // merely outweighing it. The kill says "expect procurement, not a
    // conversation, to decide this one". A business unit routing around central
    // IT is BY DEFINITION buying outside the procurement path -- that is what
    // makes it shadow IT, and it is the whole premise of the
    // shadow_it_business_units thesis, whose own note calls this "the one thesis
    // whose PRECONDITION is the condition every other thesis is disqualified by".
    //
    // The operator, 2026-09-25: "the other one is for shadow it ie a biz unit is
    // delivering their own AI independent of their it firm".
    //
    // WHAT COUNTS IS A BUSINESS-UNIT-SCOPED SEAT, not a title containing the
    // word AI. An enterprise CIO at a 20,000-person firm is exactly who this
    // gate exists to reject. A Director of Analytics for Commercial Lines at the
    // same firm is not: they own a number, a budget and a queue of their own.
    // The tell is that the title is qualified by a division, region, product
    // line or function -- which is also why these seats are so rare in the book
    // (3 of 158 measured on 2026-09-17): `enrich` reads leadership pages, and a
    // leadership page lists the C-suite by design and never the seat two levels
    // down.
    //
    // It WARNS rather than passes, like the relationship exemption above. The
    // firm really is large and that fact still governs everyone else there.
    //
    // NOT AT A REGULATED FINANCIAL FIRM. Narrowed 2026-09-25, at the operator's
    // instruction, after a Head of AI for one division of a 90,000-person bank
    // reached first place to write on this exemption. At a bank, insurer or
    // asset manager, onboarding ANY outside supplier -- third-party risk,
    // data protection, often notice to a regulator -- is enterprise-wide and
    // mandated. A unit there cannot route around procurement, so the premise
    // above does not hold, and a unit head of AI is buying inside the process
    // this gate exists to predict.
    //
    // Known by thesis first (`regulated_verticals` on the gate, the operator's
    // own financial theses; none by default), then by name or stated industry,
    // because a firm can be a bank without having been filed under a banking
    // thesis.
    const REG_VERTICALS = ctx.gate.regulated_verticals ?? [];
    const regulatedFinancial = REG_VERTICALS.length && ctx.db.prepare(
      `SELECT 1 FROM org_verticals WHERE org_id = ? AND vertical_id IN
         (${REG_VERTICALS.map(() => '?').join(',')}) LIMIT 1`).get(ctx.org.id, ...REG_VERTICALS)
      || /\b(bank|banking|bancorp|insurance|insurer|reinsurance|assurance|securities|asset management)\b/i
        .test(`${ctx.org.name ?? ''} ${ctx.org.industry ?? ''}`);

    const unitSeat = over && !regulatedFinancial ? ctx.db.prepare(`
      SELECT name, title FROM people
       WHERE org_id = ?
         AND (title LIKE '%,%' OR title LIKE '% for %' OR title LIKE '% - %')
         AND (
           LOWER(title) LIKE '%analytic%' OR LOWER(title) LIKE '%data%'
           OR LOWER(title) LIKE '% ai%' OR LOWER(title) LIKE '%digital%'
           OR LOWER(title) LIKE '%automation%' OR LOWER(title) LIKE '%transformation%'
         )
         -- ENTERPRISE SCOPE IS THE THING BEING EXCLUDED. The first version of
         -- this list named specific C-titles and let five enterprise seats
         -- through on a dry run: an IT services giant's actual CEO ("President and
         -- CEO | Chief AI Officer"), a global bank's group CTO, a card issuer's
         -- BOARD DIRECTOR, a life insurer's Chief Product Officer and a global law
         -- firm's GLOBAL Head of Applied AI. Rescuing a firm on the strength of its
         -- chief executive is the exact opposite of what this exemption is for.
         AND LOWER(title) NOT LIKE '%chief %'
         AND LOWER(title) NOT LIKE '%enterprise%'
         AND LOWER(title) NOT LIKE '%global%'
         AND LOWER(title) NOT LIKE '%group head%'
         AND LOWER(title) NOT LIKE '%board %'
         AND LOWER(title) NOT LIKE '%president%'
         -- A PIPE IS A LINKEDIN HEADLINE, NOT A TITLE. "Public Company Board
         -- Director | AI & Digital Transformation | QFE | COO" is a person
         -- advertising themselves, and every keyword in it matches something.
         AND title NOT LIKE '%|%'
       LIMIT 1`).get(ctx.org.id) : null;

    if (known) {
      return { outcome: 'warn',
        reason: `${sizeText()} is above the ` +
          `${byRevenue ? 'size' : limit.toLocaleString('en-US')} ceiling${why}, which normally means procurement ` +
          `decides. Not struck off, because the operator already knows ${known.name} ` +
          `(${known.title ?? 'title unknown'}) here: ${known.prior_relationship}. Size still ` +
          'applies to everyone else at this firm.', evidence_id: ctx.derivedFrom };
    }
    if (unitSeat) {
      return { outcome: 'warn',
        reason: `${sizeText()} is above the `
          + `${byRevenue ? 'size' : limit.toLocaleString('en-US')} ceiling${why}, which normally means procurement `
          + `decides. Not struck off, because ${unitSeat.name} (${unitSeat.title}) is a `
          + 'BUSINESS-UNIT seat, not the enterprise technology org — the one buyer this gate '
          + 'is wrong about, since a unit routing around central IT is buying outside '
          + 'procurement by definition. Size still applies to everyone else at this firm.',
        evidence_id: ctx.derivedFrom };
    }

    return over
      ? { outcome: ctx.gate.severity === 'kill' ? 'kill' : 'warn',
          reason: `${sizeText()} is above the ` +
            `${byRevenue ? 'size' : limit.toLocaleString('en-US')} ceiling${why} — expect procurement, not a ` +
            'conversation, to decide this one.' + (regulatedFinancial
              ? ' A regulated financial firm: every unit buys through the same mandated ' +
                'supplier review, so no business-unit seat is exempt here.' : ''),
          evidence_id: ctx.derivedFrom }
      : { outcome: 'pass',
          // A PASS THAT RESTS ON AN UNVERIFIED NUMBER SAYS SO. Within a factor
          // of two of the ceiling is where being wrong changes the verdict, and
          // a firm that survives on a remembered figure is the one worth a
          // minute of checking — precisely because nothing downstream will ever
          // raise it again.
          reason: `${hc.toLocaleString('en-US')} people${qual} is within the ` +
            `${byRevenue ? 'size' : limit.toLocaleString('en-US')} ceiling${why}.`
            + (!['page', 'operator'].includes(src) && hc > limit / 2
              ? ` IT SURVIVES THIS GATE ON THAT NUMBER: within a factor of two of the `
                + 'ceiling, and nobody retrieved it. Worth confirming before spending an hour here.'
              : ''),
          evidence_id: ctx.derivedFrom };
  },

  too_small(ctx) {
    const band = sizeBand(ctx);
    const floor = band.revenue_min_usd;
    const size = ctx.org.aum_usd ?? ctx.org.revenue_est;
    if (!floor || size == null) return null;
    return size < floor
      ? { outcome: 'kill',
          reason: `Estimated size $${size.toLocaleString('en-US')} is below the ` +
            `$${floor.toLocaleString('en-US')} floor${band.target ? ` for the target "${band.target}"` : ''}.`,
          evidence_id: ctx.derivedFrom }
      : { outcome: 'pass',
          reason: `$${size.toLocaleString('en-US')} clears the ` +
            `$${floor.toLocaleString('en-US')} floor.`, evidence_id: ctx.derivedFrom };
  },

  relationship_stale(ctx) {
    if (!ctx.outreach.length) return null;
    const last = ctx.outreach[0];
    const months = (Date.now() - Date.parse(last.sent_at)) / MONTH_MS;
    return months > 24
      ? { outcome: ctx.gate.severity === 'kill' ? 'kill' : 'warn',
          reason: `Last contact ${last.sent_at}, ${Math.round(months)} months ago, with no ` +
            'warm intro path on record.', evidence_id: null }
      : { outcome: 'pass',
          reason: `Last contact ${last.sent_at}, ${Math.round(months)} months ago.`,
          evidence_id: null };
  },

  in_house_consulting_arm(ctx) {
    // The threshold is written into kill_if as a number; read it rather than
    // hard-coding, so changing the config changes the gate.
    const m = String(ctx.gate.kill_if ?? '').match(/(\d+)\s*or more/);
    const threshold = m ? Number(m[1]) : 15;
    if (!ctx.evidence.some((e) => e.kind === 'staff_listing')) return null;

    // The gate asks whether a firm has an in-house group that would do this work
    // instead of buying it. At a consultancy or a delivery firm that question is
    // meaningless — consultants ARE their business, and counting them kills every
    // one of them for existing.
    if (['delivery_firm', 'advisor', 'marketplace', 'individual'].includes(ctx.org.kind)) {
      return { outcome: 'pass',
        reason: `Not applicable to a ${ctx.org.kind}: consulting headcount is their product, ` +
          'not an internal group that displaces an outside adviser.', evidence_id: ctx.derivedFrom };
    }

    // At an investor, the whole investment staff is not an operating team. Count
    // only the seats that would actually do portfolio work. Counting everyone
    // killed a live prospect on the first run — exactly the false kill this gate
    // is known to produce.
    const OPERATING = ['operating partner', 'value creation', 'portfolio operations',
      'operating executive', 'operating advisor', 'head of operations', 'operating director',
      'portfolio support', 'transformation'];
    const relevant = ctx.people.filter((p) => matchesAny(p.title, OPERATING));
    const named = relevant.length;

    return named >= threshold
      ? { outcome: 'kill',
          reason: `${named} operating or value-creation seats named publicly, at or above the ` +
            `threshold of ${threshold}: ${relevant.slice(0, 5).map((p) => p.name).join(', ')}` +
            `${named > 5 ? ', …' : ''}.`, evidence_id: ctx.derivedFrom }
      : { outcome: 'pass',
          reason: `${named} operating or value-creation seats named publicly (of ` +
            `${ctx.people.length} people total), below the ${threshold} threshold.`,
          evidence_id: ctx.derivedFrom };
  },

  // Kind is set by enrich (or by hand) and is the fact these two turn on.
  marketplace_or_expert_network(ctx) {
    if (!ctx.org.kind) return null;
    return ctx.org.kind === 'marketplace'
      ? { outcome: 'kill', reason: 'Firm kind is marketplace: it brokers independent talent ' +
          'or expert calls rather than buying an engagement.', evidence_id: ctx.derivedFrom }
      : { outcome: 'pass', reason: `Firm kind is ${ctx.org.kind}, not a marketplace.`,
          evidence_id: ctx.derivedFrom };
  },

  platform_partner_firm(ctx) {
    const ev = ctx.evidence.find((e) =>
      /partner of the year|preferred partner|premier partner|pure-play .* partner|certified partner/i
        .test(e.claim ?? ''));
    if (ev) {
      return { outcome: ctx.gate.severity === 'kill' ? 'kill' : 'warn',
        reason: `Platform partnership stated on their own pages: ${truncate(ev.claim, 180)}`,
        evidence_id: ev.id };
    }
    return ctx.org.kind ? { outcome: 'pass',
      reason: 'No platform-partner identity found in the evidence gathered.',
      evidence_id: null } : null;
  },
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const db = openDb();
  const runId = startRun(db, 'gate');
  const today = new Date().toISOString().slice(0, 10);

  const orgs = args.org && args.org !== true
    ? db.prepare('SELECT * FROM orgs WHERE id = ?').all(String(args.org))
    : db.prepare(`SELECT DISTINCT o.* FROM orgs o
        WHERE EXISTS (SELECT 1 FROM evidence e WHERE e.org_id = o.id)
           OR EXISTS (SELECT 1 FROM people p WHERE p.org_id = o.id)
        ORDER BY o.name`).all();

  // Never overwrite the operator's own calls, or the seed's.
  const handEntered = new Set(db.prepare(
    "SELECT org_id || '|' || gate_id k FROM gate_results WHERE seeded = 1 OR run_id IS NULL")
    .all().map((r) => r.k));
  const clearPrev = db.prepare(
    'DELETE FROM gate_results WHERE org_id = ? AND gate_id = ? AND seeded = 0 AND run_id IS NOT NULL');
  const insert = db.prepare(`
    INSERT INTO gate_results (org_id, gate_id, outcome, reason, decided_at, evidence_id, seeded, run_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`);

  const rows = [];
  const counts = {};
  let undecidable = 0;
  const unimplemented = new Set();

  for (const org of orgs) {
    const evidence = db.prepare('SELECT * FROM evidence WHERE org_id = ?').all(org.id);
    // The page enrich read to derive kind, sells_ai_*, headcount and revenue. A
    // gate that kills on one of those fields is asserting a fact, and a fact
    // without a retrievable source is the thing this project calls a defect —
    // so the decision carries the page it came from, not just the prose.
    const derivedFrom = (evidence.find((e) => e.kind === 'firm_profile')
      ?? evidence.find((e) => e.kind === 'firm_fact'))?.id ?? null;
    // Does a LIVE pitch exist whose precondition is a staffed buyer? The gate
    // must not soften on a catalogue that cannot sell to the firms it spares.
    // Read from config rather than hardcoded, so retiring senior_capacity
    // restores the kill automatically instead of leaving a silent hole.
    const hasCapacityPitch = (cfg.buyers ?? []).some(
      (x) => x.id === 'senior_capacity' && (x.status ?? 'live') !== 'dead');

    const ctx = {
      cfg, org, db, derivedFrom, hasCapacityPitch,
      people: db.prepare('SELECT * FROM people WHERE org_id = ?').all(org.id),
      evidence,
      outreach: db.prepare(
        'SELECT * FROM outreach WHERE org_id = ? ORDER BY sent_at DESC').all(org.id),
    };

    const results = [];
    for (const gate of cfg.gates) {
      if (handEntered.has(`${org.id}|${gate.id}`)) {
        results.push({ gate_id: gate.id, outcome: 'hand', reason: 'decided by the operator' });
        continue;
      }
      // A GATE THE OPERATOR DECIDES BY HAND has no evaluator and should not
      // have one: each turns on a judgment about what a firm actually does that
      // no team page states. Counting it "undecidable" for every firm it was
      // never going to be evaluated on buried the real number — declaring the
      // three hand gates pushed it from 1,236 to 1,584 in one run.
      if (gate.decided_by === 'operator') continue;

      // A GATE WITH NO EVALUATOR AND NO ONE DECIDING IT BY HAND IS NOT A GATE.
      // It cannot ever fire, and lumping it in with "could not decide from the
      // evidence on hand" made a permanently dead rule look like a temporarily
      // blocked one. Reported separately, and once per gate rather than once
      // per firm.
      const evaluate = EVALUATORS[gate.id];
      if (!evaluate) { unimplemented.add(gate.id); continue; }

      const out = evaluate({ ...ctx, gate });
      if (!out) { undecidable++; continue; }

      // A gate declared `warn` may never return `kill`. Severity is the
      // operator's decision about how much to trust the gate, not the gate's.
      let outcome = gate.severity === 'warn' && out.outcome === 'kill' ? 'warn' : out.outcome;

      // `unless_trigger` — A DISQUALIFIER THAT A LIVE EVENT CAN OVERRIDE.
      //
      // The shadow-IT thesis has said since it was written that its
      // PRECONDITION is the condition every other thesis is disqualified by: a
      // firm with a central technology organisation and a chief AI officer is a
      // BETTER prospect here, not a worse one, because shadow IT exists
      // precisely when central IT exists and is slow. Nothing implemented that.
      // The gate that kills for in-house capability was killing exactly the
      // firms the thesis calls its best, and the gate that flags a firm as too
      // large was flagging the only firms large enough to have a division
      // routing around IT.
      //
      // So a gate may now name the triggers that exempt a firm from it. The
      // exemption requires a LIVE, UNRETRACTED signal — an argument about what
      // a firm is probably like does not clear a disqualifier; a dated event
      // does. It is recorded as a pass with the trigger named, so the override
      // is legible in the gate log rather than silent.
      if ((outcome === 'kill' || outcome === 'warn') && (gate.unless_trigger ?? []).length) {
        const hit = db.prepare(
          `SELECT trigger_id, detected_at FROM signals
            WHERE org_id = ? AND retracted_at IS NULL
              AND trigger_id IN (${gate.unless_trigger.map(() => '?').join(',')})
            ORDER BY detected_at DESC LIMIT 1`).get(org.id, ...gate.unless_trigger);
        if (hit) {
          outcome = 'pass';
          out.reason = `${out.reason} EXEMPT: ${hit.trigger_id} is live here` +
            `${hit.detected_at ? `, dated ${hit.detected_at}` : ''}, and this gate declares ` +
            'that trigger an exemption.';
        }
      }
      clearPrev.run(org.id, gate.id);
      insert.run(org.id, gate.id, outcome, out.reason, today, out.evidence_id, runId);
      results.push({ gate_id: gate.id, outcome, reason: out.reason });
      counts[`${gate.id}:${outcome}`] = (counts[`${gate.id}:${outcome}`] ?? 0) + 1;
    }

    // The verdict must reflect every gate result on file, not only the ones this
    // run produced. A firm the operator killed by hand is killed, and showing it
    // as PASS because this run deferred to that call would be a lie.
    const onFile = db.prepare(
      'SELECT gate_id, outcome, reason, seeded, run_id FROM gate_results WHERE org_id = ?')
      .all(org.id);
    const decidedHere = new Set(results.filter((r) => r.outcome !== 'hand').map((r) => r.gate_id));
    const inherited = onFile
      .filter((g) => !decidedHere.has(g.gate_id))
      .map((g) => ({ ...g, source: g.seeded ? 'seed' : g.run_id ? 'prior run' : 'operator' }));

    const all = [...results.filter((r) => r.outcome !== 'hand'), ...inherited];
    const kills = all.filter((r) => r.outcome === 'kill' || r.outcome === 'kill_as_buyer');
    const warns = all.filter((r) => r.outcome === 'warn');
    rows.push({ org, results, inherited, kills, warns,
      decided: results.filter((r) => r.outcome !== 'hand').length,
      verdict: kills.length ? 'KILL' : warns.length ? 'WARN' : all.length ? 'PASS' : 'NO DATA' });
  }

  console.log(heading(`gate · ${orgs.length} firms · ${cfg.gates.length} gates · $0.00 (no LLM)`));
  const order = { KILL: 0, WARN: 1, PASS: 2, 'NO DATA': 3 };
  rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.org.name.localeCompare(b.org.name));

  console.log(table(rows.map((r) => ({
    verdict: r.verdict, org: r.org.name, kind: r.org.kind ?? '·',
    n: `${r.decided}${r.inherited.length ? `+${r.inherited.length}` : ''}`,
    why: (r.kills[0] ?? r.warns[0])
      ? `${(r.kills[0] ?? r.warns[0]).gate_id}: ${(r.kills[0] ?? r.warns[0]).reason ?? ''}`
      : '',
  })), [
    { key: 'verdict', label: 'VERDICT', width: 7 },
    { key: 'org', label: 'FIRM', width: 30 },
    { key: 'kind', label: 'KIND', width: 14 },
    { key: 'n', label: 'GATES', width: 6, align: 'right' },
    { key: 'why', label: 'FIRST REASON', width: 78 },
  ]));

  if (args.explain) {
    for (const r of rows.filter((x) => x.kills.length || x.warns.length)) {
      console.log(`\n${bold(r.org.name)}`);
      for (const g of [...r.kills, ...r.warns]) {
        console.log(`  ${g.outcome.toUpperCase().padEnd(14)} ${g.gate_id}` +
          `${g.source ? dim(` [${g.source}]`) : ''}\n    ${g.reason ?? ''}`);
      }
    }
  }

  for (const r of rows) {
    for (const g of r.inherited.filter((x) => x.outcome !== 'pass')) {
      const key = `${g.gate_id}:${g.outcome}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  const ranked = Object.entries(counts).filter(([k]) => !k.endsWith(':pass'))
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    console.log(heading('WHY THE MARKET DISQUALIFIES ITSELF'));
    for (const [k, n] of ranked) console.log(`  ${String(n).padStart(3)}  ${k}`);
    console.log(dim('\nThis ranking is the point of the gate log. If one reason ' +
      'dominates, the targeting thesis is wrong and no amount of outreach fixes it.'));
  }
  if (undecidable) {
    console.log(dim(`\n${undecidable} gate/firm pairs could not be decided from the evidence on ` +
      'hand. Run `npm run enrich` to gather more, or add an evaluator in src/gate.mjs.'));
  }
  if (unimplemented.size) {
    console.log(`\n${unimplemented.size} gate(s) DECLARED BUT NOT IMPLEMENTED: ` +
      `${[...unimplemented].join(', ')}.`);
    console.log(dim('  Nothing evaluates these, so they have never decided anything and never ' +
      'will. Write an evaluator in src/gate.mjs, mark them `decided_by: operator` if you ' +
      'apply them yourself, or delete them. A rule that cannot fire is not a rule.'));
  }

  finishRun(db, runId, { n_in: orgs.length, n_out: rows.length, cost_usd: 0 });
  db.close();
}

try { main(); } catch (err) { console.error(err.message ?? err); process.exit(1); }
