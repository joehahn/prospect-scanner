// The hand-fed front door.
//
// Under the inverted build order (§13.8) the whole loop runs on firms the
// operator types in, before `scan` can find any. This is not a workaround: the
// operator's own research is a first-class source, and pasted LinkedIn text is
// explicitly allowed (CLAUDE.md, as amended) because a person reading a page in
// their own browser is not automation.
//
// Everything pasted is stored with provenance = 'operator_supplied' so it is
// never confused with something the system retrieved.
//
// Usage:
//   npm run lead -- vet        --name "Firm Name" --domain x.com [--kind ...] [--vertical id]
//                              READ THIS FIRM'S OWN SITE AND GATE IT, before any profile
//                              lookup. ~2 cents, no LinkedIn. Run this first.
//   npm run lead -- vet        --candidates [--limit N] [--jobs 4]
//                              The same pass over every firm `news --discover` left
//                              unvetted. Fills in the `kind` that makes them visible
//                              to gate and rank.
//   npm run lead -- add-org    --name "Firm Name" [--domain x.com] [--vertical id]
//                              [--aum 21e9] [--revenue N] [--headcount N] [--hq "City ST"]
//                              [--kind end_client|investor|advisor|delivery_firm|marketplace|staffing|individual]
//   npm run lead -- add-person --org <org_id> --name "Full Name" --title "Title"
//                              [--url <profile-url>] [--degree 1|2|3] [--email a@b.c]
//   npm run lead -- move       --person <id> --to <org_id> --url <source-url>
//                              [--title "New Title"] [--since YYYY-MM] [--dry]
//                              They changed employers. Signals stay with the old firm.
//   npm run lead -- paste      --person <id>|--org <id> --url <source-url>
//                              [--file path]   (otherwise reads stdin)
//                              [--claim "one-line summary"] [--kind profile|article|filing]
//                              [--provenance operator_supplied|retrieved]  who obtained it;
//                              defaults to operator_supplied, the hand-fed door
//                              [--title "..."] [--degree 1|2|3] [--email a@b.c] [--role "..."]
//                              [--extract]  read the fields off the page with a cheap model
//                              [--confirmed confirmed|unclear|contradicted]  does the page back the title up
//                              [--activity dormant|low|active|high] [--followers N]
//                              [--in-seat-since YYYY-MM] [--referral 0..1]
//                              [--location "London, UK"] [--country "United Kingdom"]
//   npm run lead -- sent       --person <id> --channel linkedin_inmail --service read_proposal
//                              [--date YYYY-MM-DD] [--subject "..."] [--file message.txt]
//                              [--as-drafted]  you sent the latest draft unedited: take its
//                              text and its subject verbatim, no file to write
//                              [--to addr@firm.com]  which address it actually went to;
//                              defaults to the address on file, guess included
//                              [--summary "..."] [--warm] [--credit] [--status ...]
//                              [--again]  the same message really went twice; without
//                              it an identical message within 7 days is refused
//   npm run lead -- unsend     --outreach <id>
//   npm run lead -- merge      --from <person id> --into <person id>
//                              one person on file twice: every row moves to --into,
//                              blank fields on --into are filled from --from, and
//                              --from is removed
//                              Undo a `sent` recorded by mistake. Removes the outreach row,
//                              unpairs the draft, and frees the person back onto the
//                              shortlist. `sent` is easy to run while meaning to READ a
//                              draft — use `npm run draft -- --person <id> --show` for that.
//   npm run lead -- accepted   --person <id> [--date YYYY-MM-DD]
//                              they accepted your connection request: recorded on the
//                              latest one sent them, and NOT counted as a reply
//   npm run lead -- reply      --outreach <id> --sentiment positive|negative|neutral|bounced
//                              [--date YYYY-MM-DD] [--outcome "..."] [--file reply.txt]
//   npm run lead -- banks      --thesis <id> --state "Texas" [--min 2] [--max 25] [--dry]
//                              Every FDIC-insured bank in an asset band, from the
//                              quarterly regulatory filing. Enumerates by SIZE; the
//                              trigger is found afterwards by vet and enrich.
//   npm run lead -- domains    [--org <id>] [--limit N] [--dry]
//                              Resolve a discovered firm's NAME to its own website,
//                              then FETCH that site and check it names the firm before
//                              writing it. A wrong domain describes another company.
//   npm run lead -- addresses --org <id> [--dry] [--pages N] [--no-press]
//                              Read the firm's OWN pages for a published address and
//                              derive the pattern from it, then fill in everyone. If
//                              the site names none, search press releases, where a
//                              media contact has to be a person (one Tavily credit).
//                              Finds nothing at a firm that publishes nothing.
//   npm run lead -- emails     --org <id> [--example "Jane Doe:jdoe@firm.com"]
//                              Derive the firm's address pattern from one known
//                              address and apply it to everyone else named there.
//                              Writes email_guess, never email.
//   npm run lead -- list [--vertical id]

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, slugify } from './db.mjs';
import { loadConfig, capabilityTitles } from './config.mjs';
import { loadTargeting as loadTargetingFn } from './targeting.mjs';
import { loadTargeting } from './targeting.mjs';
import { complete } from './models.mjs';
import { table, heading, bold, dim, truncate } from './report.mjs';
import { hiringQuote, capabilityTerms } from './hiring.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACT_PROMPT = 'prompts/extract-profile.md';

// `addresses` falls back to the news index when a firm publishes nothing, which
// spends Tavily credits from a command nobody thinks of as a retrieval stage.
// Recorded for the same reason model calls are: an unrecorded cost stream makes
// cost per qualified prospect a smaller number than the truth.
let tavilySpent = 0;

// The fields the ranking turns on. Extracted rather than hand-flagged, because
// role_confirmed and platform_activity are judgments about what a page MEANS —
// exactly the case the design reserves for a classification pass.
// NO `['string', 'null']` UNIONS IN THIS SCHEMA, and they are not coming back.
// Twelve of them accumulated here, and each one doubles the branches a strict
// schema has to enumerate: the request started failing with a flat 400 "Schema
// is too complex", which takes down the WHOLE extraction rather than the field
// that tipped it over. Nothing in this schema needs them. `required` names six
// properties and every other one is already optional, so a value the page does
// not give is simply absent -- which is what null was being used to say, in a
// form that costs 2^n.
const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // EVERY PROPERTY IS REQUIRED, and that is what makes this schema legal rather
  // than a stylistic choice. A strict schema has to enumerate the shapes it will
  // accept, and each OPTIONAL property doubles that count: eighteen properties
  // with six required left twelve optional and 2^12 = 4,096 shapes, which the
  // API refused outright with a flat 400 "Schema is too complex". The refusal
  // takes down the whole extraction, so a paste stored its text and silently set
  // no fields at all -- for long enough that nobody noticed which paste was the
  // last one to work.
  //
  // Absence is expressed in the VALUE now, not in the key: '' for a string, 0
  // for a number, [] for a list. `blank()` below turns those back into null on
  // the way in, so nothing downstream sees an empty string where it expects a
  // missing fact.
  required: ['location', 'country', 'title', 'role_confirmed', 'role_note', 'in_seat_since',
             'hiring_for_capability', 'degree', 'email', 'platform_activity', 'followers',
             'decision_role', 'capability_authority', 'builds_in_house', 'buyer_remit',
             'referral_value', 'other_people', 'facts'],
  properties: {
    location: { type: 'string',
      description: 'Where the profile says this person is, verbatim.' },
    country: { type: 'string',
      description: 'Country only, as a plain name.' },
    title: { type: 'string' },
    role_confirmed: { type: 'string', enum: ['confirmed', 'unclear', 'contradicted'] },
    role_note: { type: 'string',
      description: 'One line on why role_confirmed came out as it did.' },
    in_seat_since: { type: 'string', description: 'YYYY-MM from the experience section.' },
    hiring_for_capability: { type: 'string', description:
      'Verbatim quote if THIS PERSON is recruiting for the capability being sold. See the prompt.' },
    degree: { type: 'integer', description: 'LinkedIn connection degree, 1 2 or 3.' },
    email: { type: 'string' },
    platform_activity: { type: 'string', enum: ['high', 'active', 'low', 'dormant'] },
    followers: { type: 'integer' },
    decision_role: { type: 'string',
      description: 'One line: what this person can and cannot decide.' },
    // The same judgment as decision_role, in a form the ranker can read. The
    // prose version has been written correctly for months — "likely cannot make
    // technology or AI investments" — and scored nothing, because nothing parses
    // a sentence. A COO whose career is self-storage operations and a COO who
    // runs technology are the same title and not the same prospect.
    capability_authority: { type: 'string',
      enum: ['owns', 'influences', 'none', 'unclear'],
      description: 'owns | influences | none | unclear. See the prompt.' },
    // A DIFFERENT QUESTION FROM capability_authority, and asking them together
    // was how a COO who publishes daily on building AI agents read as a firm
    // with "nobody in-house to build it". Budget and hands are not the same
    // fact: the first names a buyer, the second names a disqualifier.
    builds_in_house: { type: 'string',
      description: 'Verbatim evidence that THIS PERSON personally builds or runs it. See the prompt.' },
    // WHOSE TECHNOLOGY — THE ONE THEY SELL, OR THE ONE THEY RUN. A third
    // question distinct from the two above, and the profile that forced it was
    // a CTO whose own paste said, in the operator's words, "sets external
    // product strategy, not internal technology operations" and "none of it
    // concerns [the firm] adopting AI for its own internal operations".
    // That reached the drafter, which refused, and never reached rank, which
    // had him top of the writable list. capability_authority could not carry
    // it: he genuinely owns a large technology budget, so "owns" is the true
    // answer and it is the wrong fact. Budget, hands, and WHICH TECHNOLOGY are
    // three separate things and this is the third.
    // The vocabulary only. The guidance for choosing between these lives in
    // prompts/extract-profile.md, where every other judgment's does -- and it
    // has to: written out here in full, this field alone took the request over
    // Anthropic's schema-complexity limit and the whole extraction failed 400.
    // NO `enum` HERE, unlike its two siblings, and it is not an oversight. This
    // schema was already at Anthropic's complexity ceiling: adding one more
    // enumerated property returned 400 "Schema is too complex" and killed every
    // extraction, not just this field. The vocabulary is in the description and
    // in prompts/extract-profile.md, and anything outside it is discarded on
    // the way in — checked in code a few lines below, where an unexpected value
    // becomes null rather than reaching the database.
    buyer_remit: { type: 'string',
      description: 'internal | external | both | unclear. See the prompt.' },
    referral_value: { type: 'number' },
    other_people: {
      type: 'array',
      description: 'Colleagues at the SAME firm, from the profile body only, never the sidebars. See the prompt.',
      items: { type: 'object', additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' }, title: { type: 'string' },
                      degree: { type: 'integer' } } },
    },
    facts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false,
        required: ['claim', 'quote'],
        properties: { claim: { type: 'string' }, quote: { type: 'string' } } },
    },
  },
};

function parseArgs(argv) {
  const cmd = argv[0];
  const args = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (String(argv[j]).startsWith('--')) { prev = String(argv[j]).slice(2); break; }
    }
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"` +
      (prev ? `\n\n  This usually means an unquoted value. "${prev}" took only the first word ` +
        'of what followed. Wrap multi-word values in SINGLE quotes:\n' +
        `    --${prev} 'the whole phrase, dashes and $ and all'\n\n` +
        '  Single quotes, not double: the shell expands $2 inside double quotes and ' +
        'a price like $1,999 silently becomes ",999".' : ''));
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return { cmd, args };
}

const num = (v) => (v === undefined ? null : Number(String(v).replace(/[_,]/g, '')));
const today = () => new Date().toISOString().slice(0, 10);

function requireArg(args, key, cmd) {
  if (!args[key] || args[key] === true) throw new Error(`${cmd} needs --${key}`);
  return String(args[key]);
}

function addOrg(db, cfg, targeting, args) {
  const name = requireArg(args, 'name', 'add-org');
  const id = args.id && args.id !== true ? String(args.id) : slugify(name);

  if (args.vertical && args.vertical !== true) {
    const known = targeting.verticals.map((v) => v.id);
    if (!known.includes(String(args.vertical))) {
      throw new Error(`unknown --vertical "${args.vertical}". Declared: ${known.join(', ')}`);
    }
  }

  const KINDS = ['end_client', 'investor', 'advisor', 'delivery_firm', 'marketplace', 'staffing', 'individual'];
  const kind = args.kind && args.kind !== true ? String(args.kind) : null;
  if (kind && !KINDS.includes(kind)) {
    throw new Error(`--kind must be one of: ${KINDS.join(', ')}`);
  }

  const existing = db.prepare('SELECT * FROM orgs WHERE id = ?').get(id);
  db.prepare(`
    INSERT INTO orgs (id, name, domain, industry, revenue_est, headcount_est, hq, aum_usd,
                      first_seen, source, kind, seeded)
    VALUES (@id, @name, @domain, @industry, @revenue, @headcount, @hq, @aum, @today, @source, @kind, 0)
    ON CONFLICT(id) DO UPDATE SET
      name          = excluded.name,
      domain        = COALESCE(excluded.domain, orgs.domain),
      industry      = COALESCE(excluded.industry, orgs.industry),
      revenue_est   = COALESCE(excluded.revenue_est, orgs.revenue_est),
      headcount_est = COALESCE(excluded.headcount_est, orgs.headcount_est),
      hq            = COALESCE(excluded.hq, orgs.hq),
      kind          = COALESCE(excluded.kind, orgs.kind),
      aum_usd       = COALESCE(excluded.aum_usd, orgs.aum_usd)`)
    .run({
      id, name,
      domain: args.domain && args.domain !== true ? String(args.domain) : null,
      industry: args.industry && args.industry !== true ? String(args.industry) : null,
      revenue: num(args.revenue), headcount: num(args.headcount), aum: num(args.aum),
      hq: args.hq && args.hq !== true ? String(args.hq) : null, kind,
      today: today(),
      // AN EXPLICIT SOURCE WINS. This hardcoded "operator" for every caller,
      // so 48 banks enumerated from a federal register were filed as though the
      // operator had typed them in — and provenance is the one thing this book
      // is strict about everywhere else. A caller that knows where a firm came
      // from says so; a human adding one by hand still gets the old label.
      source: args.source && args.source !== true ? String(args.source)
        : args.vertical && args.vertical !== true
          ? `operator (${args.vertical})` : 'operator',
    });

  // The thesis assignment is stored as a signal-free tag rather than a column,
  // so an org can sit in more than one thesis without a schema change.
  if (args.vertical && args.vertical !== true) {
    db.prepare(`INSERT OR IGNORE INTO org_verticals (org_id, vertical_id, assigned_at)
                VALUES (?, ?, ?)`).run(id, String(args.vertical), today());
  }

  console.log(`${existing ? 'updated' : 'added'} org ${bold(name)} (${id})`);
  return id;
}

// A PERSON'S EMPLOYER CHANGES AND NOTHING COULD RECORD IT, found 2026-09-23. A
// head of manufacturing and supply chain had moved firms in June; the book still
// had him at the employer he left, four months on, because `paste` writes a
// profile onto whatever org the person already sits at and has no way to say
// "he is somewhere else now". The conference channel makes this routine rather
// than rare -- an agenda names the seat a person held on the day it was
// published, and people move.
//
// THE SIGNALS STAY WITH THE OLD FIRM, deliberately. A signal is a fact about an
// organisation: the acquisition the previous employer made still happened, and
// it is still not this person's to answer for. Only the person moves.
//
// The target org must already exist, and that is not friction for its own sake.
// An org created here would carry no `kind`, and a firm with no kind is
// invisible to gate and rank -- the person would move somewhere they cannot be
// scored, which is worse than the wrong firm because it looks like nothing.
// `vet` is what sets that, so `vet` is what the error points at.
function move(db, args) {
  const personId = requireArg(args, 'person', 'move');
  const toOrg = requireArg(args, 'to', 'move');
  const url = requireArg(args, 'url', 'move');   // every factual claim carries a source

  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error(`no person "${personId}". Check the id with: npm run lead -- list`);
  const dest = db.prepare('SELECT * FROM orgs WHERE id = ?').get(toOrg);
  if (!dest) {
    throw new Error(`no org "${toOrg}". Create and gate it first:\n`
      + `  npm run lead -- vet --name "Firm Name" --domain firm.com\n`
      + 'A firm with no `kind` is invisible to gate and rank, so add-org alone is not enough.');
  }
  if (person.org_id === toOrg) {
    console.log(`${bold(person.name)} is already at ${toOrg}; nothing to do`);
    return;
  }
  const from = db.prepare('SELECT name FROM orgs WHERE id = ?').get(person.org_id);
  const fromName = from?.name ?? person.org_id;
  const since = args.since && args.since !== true ? String(args.since) : null;
  const title = args.title && args.title !== true ? String(args.title) : null;
  const today = new Date().toISOString().slice(0, 10);

  if (args.dry) {
    console.log(`would move ${bold(person.name)}: ${fromName} -> ${dest.name}`
      + (title ? ` as "${title}"` : '') + (since ? ` since ${since}` : ''));
    return;
  }

  db.transaction(() => {
    db.prepare('UPDATE people SET org_id = ?, title = COALESCE(?, title) WHERE id = ?')
      .run(toOrg, title, personId);

    // The move is a claim about the world, so it carries a source like any other.
    db.prepare(`INSERT OR IGNORE INTO evidence
      (org_id, person_id, kind, claim, source_url, retrieved_at, provenance, body)
      VALUES (?, ?, 'employer_change', ?, ?, ?, 'operator_supplied', ?)`)
      .run(toOrg, personId,
        `${person.name} moved from ${fromName} to ${dest.name}`.slice(0, 300),
        url, new Date().toISOString(),
        `EMPLOYER CHANGE recorded ${today}.\n\n`
        + `${person.name}\n  was: ${fromName} (${person.org_id})`
        + `${person.title ? ` — ${person.title}` : ''}\n`
        + `  now: ${dest.name} (${toOrg})${title ? ` — ${title}` : ''}\n`
        + `${since ? `  since: ${since}\n` : ''}`
        + `\nSignals stay with the former employer: a signal is a fact about a firm,\n`
        + `and events at ${fromName} are not this person's to answer for.\n`);

    // Stale score rows are keyed to the old firm and would survive a re-rank as
    // a second, wrong card. Drop them and let rank rebuild from the new org.
    db.prepare('DELETE FROM person_scores WHERE person_id = ?').run(personId);
  })();

  // A SILENT DEMOTION IS THE WORST OUTCOME HERE, and the first real move caused
  // one. `vet` creates and gates a firm but assigns it no thesis, so the person
  // arrived at a firm with no vertical, fell into the unassigned bucket, and
  // dropped fifteen points for a reason nothing on the screen explained. Say it.
  const destVerticals = db.prepare('SELECT COUNT(*) c FROM org_verticals WHERE org_id = ?')
    .get(toOrg).c;
  if (!destVerticals) {
    const srcVerticals = db.prepare(
      'SELECT group_concat(vertical_id) v FROM org_verticals WHERE org_id = ?')
      .get(person.org_id).v;
    console.log(bold(`\n  ${dest.name} is in no thesis, so ${person.name} will score `)
      + bold('as unassigned.')
      + (srcVerticals ? dim(`\n  ${fromName} was in: ${srcVerticals}`) : '')
      + dim('\n  If the new firm belongs to the same one, say so before ranking:')
      + `\n    npm run lead -- add-org --id ${toOrg} --name ${JSON.stringify(dest.name)}`
      + ` --vertical ${srcVerticals ? srcVerticals.split(',')[0] : '<thesis_id>'}\n`);
  }

  console.log(`moved ${bold(person.name)}: ${fromName} ${dim('->')} ${bold(dest.name)}`
    + (title ? `\n  title: ${title}` : '')
    + (since ? `\n  since: ${since}` : '')
    + dim(`\n  ${db.prepare('SELECT COUNT(*) c FROM signals WHERE org_id = ? AND retracted_at IS NULL')
        .get(person.org_id).c} signal(s) stay with ${fromName}`)
    + dim('\n  run `npm run rank` to score them at the new firm'));
}

function addPerson(db, args) {
  const orgId = requireArg(args, 'org', 'add-person');
  const name = requireArg(args, 'name', 'add-person');
  if (!db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(orgId)) {
    throw new Error(`no org "${orgId}". Run add-org first, or check the id with: npm run lead -- list`);
  }
  const id = args.id && args.id !== true ? String(args.id) : slugify(name);
  const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : null);

  db.prepare(`
    INSERT INTO people (id, org_id, name, title, decision_role, profile_url, notes, degree, email)
    VALUES (@id, @org, @name, @title, @role, @url, @notes, @degree, @email)
    ON CONFLICT(id) DO UPDATE SET
      org_id        = excluded.org_id,
      title         = COALESCE(excluded.title, people.title),
      decision_role = COALESCE(excluded.decision_role, people.decision_role),
      profile_url   = COALESCE(excluded.profile_url, people.profile_url),
      notes         = COALESCE(excluded.notes, people.notes),
      degree        = COALESCE(excluded.degree, people.degree),
      email         = COALESCE(excluded.email, people.email)`)
    .run({ id, org: orgId, name, title: str('title'), role: str('role'),
           url: str('url'), notes: str('note'), degree: num(args.degree), email: str('email') });

  console.log(`added person ${bold(name)} (${id}) at ${orgId}`);
  return id;
}

// Stored in source_url when the operator is the source. Not a URL, and treated
// as one nowhere: the dashboard prints it as a sentence.
const FIRST_HAND = 'operator:first-hand';

/**
 * Undo a mis-recorded send.
 *
 * `sent` writes an outreach row, burns a credit in the record and takes the
 * person off the shortlist, with no confirmation — and it is easy to reach for
 * while meaning only to look at a draft. That happened, and unwinding it meant
 * editing the database by hand, which is not a thing this tool should require.
 */
/**
 * ONE PERSON, TWO RECORDS. Added 2026-10-02: a firm's team page and a profile's
 * sidebar named the same founder two ways, and a managing partner was on file
 * twice with a send under one record and the judgments under the other. Both
 * read as two people, so one could be written to while the other was on hold.
 * Every table that holds a person_id is moved over; a row that would collide
 * with one --into already has is dropped, except a send or a verdict, which
 * stops the merge instead.
 */
function merge(db, args) {
  const from = String(requireArg(args, 'from', 'merge'));
  const into = String(requireArg(args, 'into', 'merge'));
  if (from === into) throw new Error('--from and --into are the same person');
  const a = db.prepare('SELECT * FROM people WHERE id = ?').get(from);
  const b = db.prepare('SELECT * FROM people WHERE id = ?').get(into);
  if (!a) throw new Error(`no person "${from}"`);
  if (!b) throw new Error(`no person "${into}"`);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name)
    .filter((t) => db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'person_id'));
  db.transaction(() => {
    const moved = [];
    for (const t of tables) {
      const n = db.prepare(`UPDATE OR IGNORE ${t} SET person_id = ? WHERE person_id = ?`).run(into, from).changes;
      const left = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE person_id = ?`).get(from).n;
      if (left && ['outreach', 'verdicts'].includes(t)) {
        throw new Error(`${left} ${t} row(s) for ${from} would collide with ${into}'s; nothing merged.`);
      }
      if (left) db.prepare(`DELETE FROM ${t} WHERE person_id = ?`).run(from);
      if (n) moved.push(`${t} ${n}`);
    }
    // Blank fields on the kept record take the other's value; nothing is overwritten.
    const cols = db.prepare('PRAGMA table_info(people)').all().map((c) => c.name)
      .filter((c) => !['id', 'org_id', 'name'].includes(c) && b[c] == null && a[c] != null);
    for (const c of cols) db.prepare(`UPDATE people SET ${c} = ? WHERE id = ?`).run(a[c], into);
    db.prepare('DELETE FROM people WHERE id = ?').run(from);
    console.log(`merged ${bold(a.name)} (${from}) into ${bold(b.name)} (${into})`
      + (moved.length ? dim(` · moved ${moved.join(', ')}`) : '')
      + (cols.length ? dim(` · filled ${cols.join(', ')}`) : ''));
  })();
  console.log(dim('  run `npm run rank` so the board sees one person'));
}

function unsend(db, args) {
  const id = Number(requireArg(args, 'outreach', 'unsend'));
  const row = db.prepare(`SELECT o.*, p.name AS person FROM outreach o
      LEFT JOIN people p ON p.id = o.person_id WHERE o.id = ?`).get(id);
  if (!row) throw new Error(`no outreach #${id}`);
  if (row.seeded) {
    throw new Error(`outreach #${id} came from the operator's own history, not from ` +
      '`sent`. Refusing to delete it — that is the record this system was seeded with.');
  }
  const paired = db.prepare('SELECT id, version FROM drafts WHERE outreach_id = ?').all(id);
  db.prepare('UPDATE drafts SET sent_text = NULL, outreach_id = NULL WHERE outreach_id = ?').run(id);
  db.prepare('DELETE FROM responses WHERE outreach_id = ?').run(id);
  db.prepare('DELETE FROM outreach WHERE id = ?').run(id);
  console.log(`removed outreach #${id}: ${bold(row.person ?? row.org_id)} · ` +
    `${row.channel} · ${row.sent_at}`);
  for (const d of paired) {
    console.log(dim(`  unpaired draft #${d.id} v${d.version} — it is a draft again, not a send`));
  }
  console.log(dim('  run `npm run rank` to put them back on the shortlist'));
}

async function paste(db, cfg, args) {
  const personId = args.person && args.person !== true ? String(args.person) : null;
  // A URL is required for anything RETRIEVED, because a retrieved claim with no
  // source is exactly the defect the design exists to stop. It cannot be required
  // for what the operator knows first-hand: he worked there, and there is no
  // page to cite. Demanding one invites a fabricated citation, which is worse
  // than none — so `operator_supplied` may stand on its own provenance, and the
  // dossier renders "no source on file" where the link would be.
  const provenance = args.provenance && args.provenance !== true
    ? String(args.provenance) : 'operator_supplied';
  // evidence.source_url is NOT NULL, and the right answer to that is not a
  // fabricated link. FIRST_HAND is a marker, not a URL: it never renders as one,
  // it greps, and it says plainly that the source is the operator himself.
  const url = args.url && args.url !== true ? String(args.url)
    : provenance === 'operator_supplied' ? FIRST_HAND
    : requireArg(args, 'url', 'paste');
  if (url === FIRST_HAND) {
    console.log(dim('no --url: recorded as something you know first-hand rather than something ' +
      'retrieved. The dossier will say so where a link would be.'));
  }
  if (!personId && !(args.org && args.org !== true)) {
    throw new Error('paste needs --person <id> or --org <id>');
  }

  const person = personId
    ? db.prepare('SELECT * FROM people WHERE id = ?').get(personId)
    : null;
  if (personId && !person) throw new Error(`no person "${personId}"`);
  const orgId = person?.org_id ?? String(args.org);
  if (!db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(orgId)) {
    throw new Error(`no org "${orgId}"`);
  }

  // Refuse before the operator spends a lookup on a firm already disqualified.
  // Twelve of thirteen profiles pasted on 2026-08-31 were at firms the gates
  // kill from public web evidence alone — evidence that costs a cent to gather.
  const kills = db.prepare(
    `SELECT gate_id, reason FROM gate_results WHERE org_id = ? AND outcome LIKE 'kill%'`)
    .all(orgId);
  if (kills.length && !args.force) {
    console.error(`${bold('NOT WORTH A LOOKUP')} — ` +
      `${db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId).name} is already killed:`);
    for (const k of kills) console.error(`  · ${k.gate_id}: ${truncate(k.reason ?? '', 200)}`);
    console.error(dim('\nNothing stored. Re-run with --force if you want it on file anyway.'));
    process.exit(2);
  }

  const body = args.file && args.file !== true
    ? readFileSync(String(args.file), 'utf8')
    : readFileSync(0, 'utf8');
  if (!body.trim()) throw new Error('nothing to paste: stdin was empty and no --file given');

  const kind = args.kind && args.kind !== true ? String(args.kind) : 'profile';
  const claim = args.claim && args.claim !== true
    ? String(args.claim)
    : `${kind === 'profile' ? 'Profile' : 'Source'} text for ` +
      `${person ? person.name : orgId}, supplied by the operator on ${today()}.`;

  const row = db.prepare(`
    INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at,
                          provenance, body)
    VALUES (@org, @person, @kind, @claim, @url, @at, @prov, @body)
    ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET
      body = excluded.body, retrieved_at = excluded.retrieved_at
    RETURNING id`)
    .get({ org: orgId, person: personId, kind: `operator_${kind}`, claim, url,
           at: new Date().toISOString(), body,
           // Provenance is a claim about WHO OBTAINED THIS. Hardcoding
           // 'operator_supplied' made the command lie the first time the
           // assistant used it to store something fetched from the web, which is
           // exactly the confusion the provenance rule exists to prevent.
           prov: args.provenance && args.provenance !== true
             ? String(args.provenance) : 'operator_supplied' });

  // A pasted profile carries facts the person record lacked, and those facts are
  // the whole reason the paste changes the ranking. Storing the text without
  // them would leave authority stuck at "no title on record".
  if (person) {
    // FIRST_HAND IS NOT A URL. It is the marker that stands in for `evidence
    // .source_url` when the operator knows something first-hand and there is no
    // page to cite, and writing it here claimed the opposite of what it means:
    // `rank` reads a non-empty profile_url as reach.profile_only and stops
    // reporting "no profile on file", and the dashboard renders it as an href.
    // A paste with no --url must leave this column alone.
    //
    // AND `||` BINDS TIGHTER THAN `?:`, which made the line below read
    // `(person.profile_url || url === FIRST_HAND) ? null : url` -- so ANY
    // existing value, including a conference agenda page, blocked the real
    // profile URL from ever landing. 35 people carried an executiveplatforms or
    // insuretechconnect agenda link in `profile_url` while the LinkedIn URL the
    // operator had pasted sat on the evidence row beside it. The dashboard
    // rendered the agenda as the person's profile link, and `rank` counted it as
    // reach.profile_only, so a page listing forty speakers was scoring as a way
    // to reach one of them.
    //
    // A linkedin.com/in/ URL is the canonical profile and always wins. Anything
    // else only fills a blank.
    const isProfile = (u) => /linkedin\.com\/in\//i.test(String(u ?? ''));
    const updates = {
      profile_url: (!url || url === FIRST_HAND) ? null
        : (isProfile(url) || !person.profile_url) ? url
        : null };
    for (const [flag, col] of [['title', 'title'], ['role', 'decision_role'],
                               ['email', 'email'], ['note', 'notes'],
                               ['confirmed', 'role_confirmed'],
                               ['in-seat-since', 'in_seat_since'],
                               ['location', 'location'], ['country', 'country'],
                               ['activity', 'platform_activity'],
                               // THE ONE FACT NO SOURCE CAN SUPPLY. Everything
                               // else on a person can in principle be retrieved;
                               // whether the operator already knows them cannot,
                               // and it is the fact that decides whether a large
                               // firm is reachable at all. See too_big in gate.mjs.
                               ['relationship', 'prior_relationship']]) {
      if (args[flag] && args[flag] !== true) updates[col] = String(args[flag]);
    }
    if (args.degree && args.degree !== true) updates.degree = num(args.degree);
    if (args.followers && args.followers !== true) updates.followers = num(args.followers);
    if (args.referral && args.referral !== true) updates.referral_value = Number(args.referral);

    // These two are judgement calls the operator makes while reading the page,
    // and they are the only things that let a paste move a score DOWNWARD.
    const enums = { role_confirmed: ['confirmed', 'unclear', 'contradicted'],
                    platform_activity: ['dormant', 'low', 'active', 'high'] };
    for (const [col, allowed] of Object.entries(enums)) {
      if (updates[col] && !allowed.includes(updates[col])) {
        throw new Error(`--${col === 'role_confirmed' ? 'confirmed' : 'activity'} ` +
          `must be one of: ${allowed.join(', ')}`);
      }
    }

    const set = Object.entries(updates).filter(([, v]) => v !== null && v !== undefined);
    if (set.length) {
      db.prepare(`UPDATE people SET ${set.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...set.map(([, v]) => v), personId);
      console.log(dim(`  updated ${set.map(([c]) => c).join(', ')}`));
    }
    const stillMissing = ['title', 'degree', 'email']
      .filter((c) => !updates[c === 'degree' ? 'degree' : c] && !person[c]);
    if (stillMissing.length) {
      console.log(dim(`  still unknown: ${stillMissing.join(', ')} — pass --title / ` +
        '--degree / --email to have the paste change the ranking'));
    }
  }

  console.log(`stored ${bold(String(body.length))} chars as evidence #${row.id} ` +
    `(${dim(`provenance: ${args.provenance && args.provenance !== true
      ? String(args.provenance) : 'operator_supplied'}`)}) for ${person ? person.name : orgId}`);

  // --extract turns the paste into one step: the flags that move a score are
  // read off the page instead of being typed. Off by default because it costs
  // money and the operator may already know the answers.
  if (args.extract && person) {
    await extractProfile(db, cfg, person, body, url, args);
  }
  console.log(dim('run `npm run rank` to re-rank with it'));
  return row.id;
}

/** One cheap call: read the pasted page, fill the structured fields, say what changed. */
/**
 * Record the operator's own call on a person: would he write to them, and why.
 * Stores the rank the ranker had given them at that moment, among live people,
 * so the ranker can later be scored against him without reconstructing the list.
 */
function verdict(db, args) {
  const personId = requireArg(args, 'person', 'verdict');
  const person = db.prepare('SELECT id, name, org_id FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error(`no person "${personId}"`);
  // `first` is a write he would send before the others: --first, or --verdict first.
  const first = Boolean(args.first) || String(args.verdict) === 'first';
  const v = first || args.write ? 'write' : args.skip ? 'skip'
    : ['write', 'skip'].includes(String(args.verdict)) ? String(args.verdict) : null;
  if (!v) throw new Error('verdict needs --first, --write or --skip (or --verdict first|write|skip)');
  const why = args.why && args.why !== true ? String(args.why).trim() : '';
  const pos = db.prepare(`
    WITH latest AS (SELECT * FROM person_scores s
                     WHERE id = (SELECT MAX(id) FROM person_scores x WHERE x.person_id = s.person_id)),
         live AS (SELECT * FROM latest WHERE org_id NOT IN
                   (SELECT org_id FROM gate_results WHERE outcome LIKE 'kill%')),
         r AS (SELECT person_id, total, RANK() OVER (ORDER BY total DESC) rk,
                      COUNT(*) OVER () n FROM live)
    SELECT rk, n, total FROM r WHERE person_id = ?`).get(personId);
  db.prepare(`INSERT INTO verdicts (person_id, org_id, verdict, first, reason, rank_then, live_then,
      score_then, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(person.id, person.org_id, v, first ? 1 : 0, why || null, pos?.rk ?? null, pos?.n ?? null,
      pos?.total ?? null, args.source && args.source !== true ? String(args.source) : 'cli',
      new Date().toISOString());
  console.log(`${bold(person.name)}: ${first ? 'would write FIRST' : v === 'write' ? 'would write' : 'would not write'}` +
    `${why ? ` — ${why}` : ''}${pos ? dim(`  (ranker had them #${pos.rk} of ${pos.n})`) : dim('  (not on the live list)')}`);
}

/**
 * Read a profile ALREADY PASTED, without pasting it again. Added 2026-09-25:
 * the paste box ran without --extract for three days, and re-pasting would add
 * a second copy of each page. `--missing` takes every person whose latest
 * pasted profile has no extracted facts yet. `--all` takes every pasted
 * profile, and `--only hiring` writes hiring_for_capability and nothing else.
 */
async function reextract(db, cfg, args) {
  const latest = `SELECT e.person_id, e.body, e.source_url FROM evidence e
     WHERE e.kind = 'operator_profile' AND e.body IS NOT NULL AND trim(e.body) <> ''
       AND e.id = (SELECT max(id) FROM evidence x WHERE x.person_id = e.person_id
                    AND x.kind = 'operator_profile' AND x.body IS NOT NULL)`;
  const rows = args.all ? db.prepare(latest).all()
    : args.missing
    ? db.prepare(`${latest} AND NOT EXISTS (SELECT 1 FROM evidence f
        WHERE f.person_id = e.person_id AND f.kind = 'profile_fact')`).all()
    : db.prepare(`${latest} AND e.person_id = ?`).all(requireArg(args, 'person', 'extract'));
  if (!rows.length) { console.log('nothing to extract'); return; }
  for (const r of rows) {
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(r.person_id);
    if (!person) continue;
    console.log(`\n${bold(person.name)}`);
    try { await extractProfile(db, cfg, person, r.body, r.source_url, args); }
    catch (err) { console.log(`  FAILED: ${err.message}`); }
  }
}

async function extractProfile(db, cfg, person, body, url, args) {
  const runId = startRun(db, 'extract', { model: cfg.models.cheap, notes: person.id });
  const res = await complete(db, runId, {
    model: cfg.models.cheap,
    system: readFileSync(resolve(ROOT, EXTRACT_PROMPT), 'utf8'),
    effort: 'medium',
    maxTokens: 8000,
    schema: PROFILE_SCHEMA,
    messages: [{ role: 'user', content:
      `Person on file: ${person.name}${person.title ? `, currently recorded as "${person.title}"` : ''}` +
      // THE FIRM ON FILE, added 2026-09-25. Without it the model could only ask
      // whether the page agreed with itself, and a headline two jobs stale both
      // became the title and marked a sitting CFO as contradicted -- a 0.25x cut
      // to her score, for a seat her own experience section confirmed.
      ` at ${db.prepare('SELECT name FROM orgs WHERE id = ?').get(person.org_id)?.name ?? person.org_id}.\n` +
      `Capability titles the operator sells against: ${capabilityTitles(cfg).join(', ')}\n` +
      // WITHOUT THIS THE MODEL CANNOT RESOLVE A RELATIVE DATE, AND IT GUESSES.
      // A LinkedIn page dates its activity as "1 month ago", never absolutely,
      // and an appointment announcement in that feed is the best evidence of a
      // start date there is. Two profiles pasted with an activity feed and no
      // experience section came back with in_seat_since wrong by 31 and 33
      // months -- both reading as years in seat when both were weeks, which
      // switched off the router cap for the one kind of person it exists for.
      `TODAY'S DATE IS ${new Date().toISOString().slice(0, 10)}. Relative dates on the ` +
      'page ("1mo", "6 months ago", "2w") are relative to today; resolve them against it.\n\n' +
      `PROFILE AS PASTED:\n${body.slice(0, 40_000)}` }],
  });
  // '' and 0 mean "the page does not say", because a strict schema cannot make a
  // property optional without exploding (see the note on PROFILE_SCHEMA). Undone
  // here, once, so every line below reads the way it did when the fields were
  // nullable.
  // ABSENCE ALSO ARRIVES AS THE WORD. The schema says absence is '' for a
  // string, and most of the time it is -- but a model told that every property
  // is required and that it must emit something will sometimes emit the string
  // "null" for a fact the page does not give. That went straight into the
  // column: five people carried the literal text 'null' in `email`, which is
  // worse than an empty column, because `email` is the VERIFIED address and
  // everything downstream reads a non-empty value there as a fact rather than
  // a guess.
  //
  // THIS LIST HOLDS ONLY WORDS NO FIELD CAN LEGITIMATELY CARRY, and the first
  // draft of it did not. It included "none" and "unknown", which would have
  // silently erased a real answer: `capability_authority` is an enum whose
  // members are owns | influences | none | unclear, and "none" -- this person
  // has no authority over the capability -- is a finding, not a gap. Forty
  // people on file carry it. Anything added here must be checked against the
  // enums in PROFILE_SCHEMA first.
  const ABSENT = new Set(['null', 'undefined', 'n/a', '-', '%', '?', '.']);
  const blank = (v) => (v === '' || v === 0 || (Array.isArray(v) && !v.length)
    || (typeof v === 'string' && ABSENT.has(v.trim().toLowerCase())) ? null : v);
  const d = Object.fromEntries(
    Object.entries(res.data ?? {}).map(([k, v]) => [k, blank(v)]));

  // ONE FIELD, FOR A BACKFILL. Added 2026-10-02: the UPDATE below left out
  // hiring_for_capability, so the extractor's answer was dropped for every
  // paste and rank's never_when_hiring block saw it on one person of 4,092.
  // Re-reading every profile in full to recover it would also let a
  // nondeterministic model rewrite decision_role, authority and the rest, and
  // move rankings nobody asked to move. `--only hiring` writes that column
  // alone, and only where the page shows a search.
  if (args.only === 'hiring') {
    const quote = hiringQuote(d.hiring_for_capability, body, capabilityTerms(capabilityTitles(cfg)));
    if (quote) db.prepare('UPDATE people SET hiring_for_capability = ? WHERE id = ?').run(quote, person.id);
    console.log(quote ? `  hiring: "${truncate(quote, 160)}"` : dim('  not hiring for it'));
    finishRun(db, runId, { cost_usd: res.cost_usd ?? 0 });
    return;
  }

  const set = {
    title: d.title ?? person.title,
    role_confirmed: d.role_confirmed,
    // A DATE OR NOTHING, same reasoning as `email` below. The blocklist in
    // ABSENT is whack-a-mole -- 'null' arrived first, then '%', then '+' -- and
    // this column has exactly one legal shape, YYYY or YYYY-MM, so match the
    // shape and let every invented token fall through to null.
    // A FULL DATE IS A BETTER ANSWER, NOT A WRONG ONE. The model sometimes gives
    // the day an appointment was announced; the check accepted only YYYY or
    // YYYY-MM, and threw away six dates that way on the 2026-09-25 backfill --
    // including a CEO who took his seat that week. Kept to the month, which is
    // the resolution everything downstream reads.
    in_seat_since: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(d.in_seat_since ?? '').trim())
      ? String(d.in_seat_since).trim().slice(0, 7) : person.in_seat_since,
    hiring_for_capability: hiringQuote(d.hiring_for_capability, body, capabilityTerms(capabilityTitles(cfg))) ?? person.hiring_for_capability,
    degree: d.degree ?? person.degree,
    // AN ADDRESS OR NOTHING. `email` is the VERIFIED column -- rank scores a
    // value here above an email_guess, and draft addresses the note to it --
    // so the one thing it must never hold is a token the model emitted to
    // satisfy a required property. Blocklisting the tokens is a losing game:
    // 'null' arrived first, then '%'. Match the SHAPE instead, which is what
    // the column actually means, and let anything else fall through to null.
    email: bareEmail(d.email) ?? person.email,
    platform_activity: d.platform_activity,
    followers: d.followers ?? person.followers,
    decision_role: d.decision_role ?? person.decision_role,
    capability_authority: d.capability_authority ?? person.capability_authority ?? null,
    builds_in_house: d.builds_in_house ?? person.builds_in_house ?? null,
    buyer_remit: (['internal', 'external', 'both', 'unclear'].includes(d.buyer_remit)
      ? d.buyer_remit : null) ?? person.buyer_remit ?? null,
    referral_value: d.referral_value ?? person.referral_value,
  };
  db.prepare(`UPDATE people SET title=@title, role_confirmed=@role_confirmed,
      in_seat_since=@in_seat_since, degree=@degree, email=@email,
      platform_activity=@platform_activity, followers=@followers,
      decision_role=@decision_role, referral_value=@referral_value,
      capability_authority=@capability_authority,
      builds_in_house=@builds_in_house, buyer_remit=@buyer_remit,
      hiring_for_capability=@hiring_for_capability
    WHERE id=@id`).run({ ...set, id: person.id });

  const insEv = db.prepare(`
    INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance)
    VALUES (?, ?, 'profile_fact', ?, ?, ?, 'operator_supplied')
    ON CONFLICT(org_id, kind, source_url, claim) DO NOTHING`);

  // REPLACE the previous extraction of this page, do not add to it.
  //
  // The ON CONFLICT above dedupes identical claims, and re-extraction almost
  // never produces an identical claim — the model rewords. Re-pasting one
  // profile took its evidence from 7 rows to 11, none of them exact duplicates
  // and all of them saying the same things twice. A dossier that repeats itself
  // is a dossier the operator stops reading.
  //
  // Rows a signal or a gate result points at are LEFT ALONE. Those references
  // are the audit trail behind a live trigger or a kill, and a re-extraction is
  // not grounds to break one.
  const stale = db.prepare(`
    SELECT id FROM evidence
     WHERE person_id = ? AND source_url = ? AND kind = 'profile_fact'
       AND id NOT IN (SELECT evidence_id FROM signals WHERE evidence_id IS NOT NULL)
       AND id NOT IN (SELECT evidence_id FROM gate_results WHERE evidence_id IS NOT NULL)
  `).all(person.id, url).map((r) => r.id);
  if (stale.length) {
    db.prepare(`DELETE FROM evidence WHERE id IN (${stale.map(() => '?').join(',')})`).run(...stale);
    console.log(dim(`  replaced ${stale.length} fact(s) from the previous read of this page`));
  }

  for (const f of d.facts ?? []) {
    insEv.run(person.org_id, person.id, `${f.claim} — "${truncate(f.quote, 240)}"`,
      url, new Date().toISOString());
  }

  // Others named on the page are the lateral moves, and they are free to capture.
  let added = 0;
  const insP = db.prepare(`INSERT INTO people (id, org_id, name, title, degree, notes)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
  // A TITLE THAT NAMES ANOTHER FIRM IS NOT A COLLEAGUE, whatever the extractor
  // decided. `other_people` is filed under the pasted person's org
  // unconditionally, and that is fine while the model obeys its instruction to
  // take only people the page places at the SAME firm -- which it does not
  // always do. A govtech vendor's chief technology officer, captured off a
  // county commissioner's profile, was filed as county staff and reached fifth
  // place on the prospect board; his own title said "@ [a govtech vendor]" the whole time,
  // and that vendor sells AI platforms into exactly the bodies this thesis
  // targets, so the board was ranking a competitor.
  //
  // Checked here rather than in the prompt because a prompt is a request and
  // this is cheap to verify: the title carries the firm, and a firm that is not
  // this one is disqualifying on its face.
  const ownOrg = db.prepare('SELECT name FROM orgs WHERE id = ?').get(person.org_id);
  const orgWords = String(ownOrg?.name ?? '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const namesAnotherFirm = (title) => {
    // ` @ ` and ` at ` only, plus civic bodies by name. `of` was in here and had
    // to come out: it caught "Head of Product" and would have silently dropped a
    // real colleague, which is the worse error. A missed block leaves someone
    // filed at the wrong firm where a human can see and move them; a false block
    // loses them without a trace.
    const m = String(title ?? '').match(
      /(?:\s@\s*|\sat\s+)([A-Z][\w&.,' -]{2,40})|\b((?:City|County|Town|Village|Borough|District) of [A-Z][\w' -]{2,30})/);
    if (!m) return null;
    const claimed = String(m[1] ?? m[2] ?? '').toLowerCase();
    if (!orgWords.length) return null;
    return orgWords.some((w) => claimed.includes(w)) ? null : String(m[1] ?? m[2]).trim();
  };
  // A SURNAME CUT TO AN INITIAL IS NOT A NAME. LinkedIn shows "Jane D." for
  // anyone outside the viewer's network, and a record under that name cannot
  // be searched, emailed or told apart from the next Jane D. Said aloud and
  // not filed, so the operator can look them up by hand if the page mattered.
  // ONE WORD IS NOT A NAME EITHER. "Andrew", "John", "Sheila" were filed off one
  // pasted page -- seven such records across the book, none findable.
  const initialOnly = (name) => /\s[A-Z]\.?$/.test(String(name).trim())
    || !/\s/.test(String(name).trim());
  // A TITLE THAT ENDS IN A COMPANY NAME, the comma form the ` at ` check misses:
  // "Group CEO, Northwind Plc" and "CEO Contoso Companies, Inc." were filed as staff
  // of an insurer and a retailer they do not work for. A trailing legal suffix
  // is the tell; it counts only when none of this firm's own words appear.
  const namesAnotherCompany = (title) => {
    const m = String(title ?? '').match(/([A-Z][\w&.' -]{1,50}?)[, ]+(plc|inc\.?|llc|ltd\.?|limited|corp\.?|corporation|companies|group|holdings|ag|sa|nv|gmbh)\.?$/i);
    if (!m || !orgWords.length) return null;
    const claimed = m[0].toLowerCase();
    return orgWords.some((w) => claimed.includes(w)) ? null : m[0].trim();
  };
  // THE FIRM'S OWN TEAM PAGE OUTRANKS A PROFILE'S SIDEBAR. Added 2026-10-02.
  // "People also viewed" names arrive with no title, so the checks above have
  // nothing to test, and five of them were filed as staff of a PE firm whose
  // own team page lists none of them -- each with a guessed address at its
  // domain. Where the firm's team page is on file, a name joins the firm only
  // if that page lists it. With no team page on file, the old rule stands.
  const nameKey = (n) => String(n ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 1).filter((w, i, all) => i === 0 || i === all.length - 1).join(' ');
  // Same surname, and one first name starting the other: "Ron" is "Ronald".
  const team = db.prepare(`SELECT DISTINCT p.name FROM evidence e JOIN people p ON p.id = e.person_id
      WHERE p.org_id = ? AND e.kind IN ('staff_listing', 'staff_bio')`).all(person.org_id).map((r) => nameKey(r.name).split(' '));
  const onTeam = (name) => {
    const [f, l] = nameKey(name).split(' ');
    return team.some(([tf, tl]) => tl === l && (tf.startsWith(f) || f.startsWith(tf)));
  };
  const elsewhere = [];
  const partial = [];
  const offTeam = [];
  for (const o of d.other_people ?? []) {
    if (!o.name) continue;
    if (initialOnly(o.name)) { partial.push(`${o.name} — ${o.title ?? ''}`); continue; }
    const other = namesAnotherFirm(o.title) ?? namesAnotherCompany(o.title);
    if (other) { elsewhere.push(`${o.name} — ${o.title}`); continue; }
    if (team.length && !onTeam(o.name)) { offTeam.push(`${o.name} — ${o.title ?? ''}`); continue; }
    const changed = insP.run(slugify(o.name), person.org_id, o.name, o.title ?? null,
      o.degree ?? null, `Surfaced from ${person.name}'s profile page. Not researched.`).changes;
    added += changed;
  }
  if (elsewhere.length) {
    console.log(dim(`  ${elsewhere.length} name(s) NOT filed here — their own title names ` +
      `another firm:\n    ${elsewhere.slice(0, 5).join('\n    ')}`));
  }
  if (partial.length) {
    console.log(dim(`  ${partial.length} name(s) NOT filed — surname shown only as an ` +
      `initial:\n    ${partial.slice(0, 5).join('\n    ')}`));
  }
  if (offTeam.length) {
    console.log(dim(`  ${offTeam.length} name(s) NOT filed — not on the firm's own team page:` +
      `\n    ${offTeam.slice(0, 5).join('\n    ')}`));
  }

  const flag = { confirmed: 'confirmed', unclear: 'UNCLEAR', contradicted: 'CONTRADICTED' }[d.role_confirmed];
  console.log(`  ${bold(flag)} · ${d.platform_activity}` +
    `${d.followers != null ? ` (${d.followers} followers)` : ''}` +
    `${d.degree ? ` · ${d.degree}° ` : ''}${d.in_seat_since ? ` · in seat since ${d.in_seat_since}` : ''}`);
  if (d.title && d.title !== person.title) console.log(dim(`  title → ${d.title}`));
  if (d.role_note) console.log(dim(`  ${d.role_note}`));
  if (d.decision_role) console.log(dim(`  role: ${d.decision_role}`));
  if (d.capability_authority && d.capability_authority !== 'unclear') {
    console.log(dim(`  controls the spend: ${d.capability_authority}`));
  }
  console.log(dim(`  ${(d.facts ?? []).length} sourced facts` +
    `${added ? `, ${added} lateral contact(s) added` : ''} · $${(res.cost_usd ?? 0).toFixed(4)}`));

  finishRun(db, runId, { cost_usd: res.cost_usd ?? 0 });
}

const CHANNELS = ['linkedin_inmail', 'linkedin_message', 'linkedin_connect_note',
  'linkedin_conversation', 'linkedin_and_email', 'email', 'phone', 'referral', 'other'];

// Nobody types "linkedin_inmail" at a prompt, and the short form is what the
// operator reaches for. `draft` carries the same table; both must accept the
// same words or a note is drafted on one channel and recorded on another.
const CHANNEL_ALIAS = {
  inmail: 'linkedin_inmail', li_inmail: 'linkedin_inmail',
  li: 'linkedin_message', linkedin: 'linkedin_message', dm: 'linkedin_message',
  connect: 'linkedin_connect_note', note: 'linkedin_connect_note',
  mail: 'email', e: 'email',
};
const resolveChannel = (raw) => {
  const v = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CHANNEL_ALIAS[v] ?? v;
};

/**
 * Record something the operator already sent, by hand. The system never sends
 * — this is bookkeeping after the fact, and it is what keeps the
 * suppression list honest.
 */
function sent(db, cfg, args) {
  const personId = requireArg(args, 'person', 'sent');
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error(`no person "${personId}"`);

  const channel = resolveChannel(requireArg(args, 'channel', 'sent'));
  if (!CHANNELS.includes(channel)) {
    throw new Error(`--channel must be one of: ${CHANNELS.join(', ')}`);
  }
  const service = args.service && args.service !== true ? String(args.service) : null;
  if (service && !cfg.packages.some((s) => s.id === service)) {
    throw new Error(`--service "${service}" is not declared in config/offers.yml. ` +
      `Declared: ${cfg.packages.map((s) => s.id).join(', ')}`);
  }
  const date = args.date && args.date !== true ? String(args.date) : today();

  // The channel rule the operator paid for: no second note on a channel that
  // went silent. Warn loudly rather than block — they may have a reason.
  const prior = db.prepare(
    'SELECT * FROM outreach WHERE person_id = ? ORDER BY sent_at DESC').all(personId);
  const sameChannel = prior.filter((o) => o.channel === channel);
  if (sameChannel.length && sameChannel.every((o) => o.status === 'sent_no_reply')) {
    console.warn(dim(`  WARNING: ${person.name} already got a ${channel} on ` +
      `${sameChannel[0].sent_at} and never replied. The channel rule says a second ` +
      'attempt needs a NEW channel plus new substance, or go lateral.'));
  }
  const blocked = db.prepare(
    'SELECT reason FROM do_not_contact WHERE person_id = ?').get(personId);
  if (blocked) console.warn(dim(`  WARNING: ${person.name} is on do_not_contact — ${blocked.reason}`));

  // --file holds what he ACTUALLY sent, which is the point: the gap between it
  // and the draft is the only thing that teaches the drafter his voice.
  //
  // But when he sends a draft unedited there is no gap, and making him copy the
  // note out of the database into a file to say so is busywork that invents a
  // transcription error. --as-drafted takes the latest draft on this person and
  // channel verbatim, and takes its subject too unless he overrides it.
  let body = args.file && args.file !== true ? readFileSync(String(args.file), 'utf8') : null;
  let draftedSubject = null;
  if (args['as-drafted'] || args.asDrafted) {
    if (body) throw new Error('pass --file or --as-drafted, not both');
    const d = db.prepare(`SELECT id, version, body, subject FROM drafts
        WHERE person_id = ? AND channel = ? AND sent_text IS NULL
        ORDER BY version DESC, id DESC LIMIT 1`).get(personId, channel);
    if (!d) {
      throw new Error(`--as-drafted: no unsent ${channel} draft for "${personId}". ` +
        'Run `npm run draft` first, or pass --file with what you sent.');
    }
    // The NOTES section is written for the operator and never goes to anyone.
    body = String(d.body).split(/^NOTES\s*$/m)[0]
      .replace(/^\s*DRAFT\s*\n-+\s*\n/m, '').trim();
    draftedSubject = d.subject;
    console.log(dim(`--as-drafted: recording draft #${d.id} v${d.version} as sent verbatim ` +
      `(${body.length} chars)${d.subject ? `, subject "${d.subject}"` : ', no subject on it'}`));
  }
  const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : null);

  // THE SAME NOTE TWICE IS ONE SEND RECORDED TWICE, almost always. Added
  // 2026-10-02: one email was recorded on two consecutive days, identical but
  // for a line ending, which counted an extra send and an extra non-reply and
  // marked a draft he never sent as sent. Refused within seven days unless
  // --again says it really went twice.
  if (body && !args.again) {
    const norm = (x) => String(x ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
    const twin = db.prepare(`SELECT id, channel, sent_at, message_text FROM outreach
        WHERE person_id = ? AND sent_at IS NOT NULL
          AND ABS(julianday(sent_at) - julianday(?)) <= 7`).all(personId, date)
      .find((o) => norm(o.message_text) === norm(body));
    if (twin) {
      throw new Error(`outreach #${twin.id} already records this exact message to ${person.name}, ` +
        `sent ${twin.sent_at} by ${twin.channel}. Nothing recorded. If it really went twice, ` +
        'pass --again.');
    }
  }

  // Resolved once, because the row and the warning below have to agree about
  // which address was used.
  const sentTo = str('to') ?? (channel.includes('email')
    ? (person.email ?? person.email_guess ?? null) : null);

  const row = db.prepare(`
    INSERT INTO outreach (org_id, person_id, channel, sent_at, service_pitched, message_text,
                          subject, pitch_summary, status, warm, credit_spent, source_memory,
                          sent_to, seeded)
    VALUES (@org, @pid, @ch, @date, @svc, @body, @subj, @sum, @status, @warm, @credit, @src,
            @to, 0)
    RETURNING id`)
    .get({ org: person.org_id, pid: personId, ch: channel, date, svc: service, body,
           subj: str('subject') ?? draftedSubject, sum: str('summary'),
           // Default to whatever address was on file, guess included, since that is
           // what he would have copied out of the dashboard.
           to: str('to') ?? (channel.includes('email')
             ? (person.email ?? person.email_guess ?? null) : null),
           status: str('status') ?? 'sent_no_reply',
           warm: args.warm ? 1 : 0,
           credit: args.credit ? 1 : (channel === 'linkedin_inmail' ? 1 : 0),
           src: 'recorded via npm run lead -- sent' });

  // Pair the sent text with the draft it came from. `drafts.sent_text` and
  // `drafts.outreach_id` exist for exactly this and nothing was filling them:
  // the sent text was captured in `outreach`, the draft sat in `drafts`, and the
  // DIFF between them — which the design calls the highest-value signal in the
  // system — could only be reconstructed by hand. The most recent unsent draft
  // on this person and channel is the one he edited.
  //
  // SAME CHANNEL FIRST, THEN ANY CHANNEL. Matching on channel alone lost the
  // pairing in the commonest case there is: a note drafted for InMail and then
  // sent as email, because deciding the channel is part of deciding to send. The
  // draft was there, the sent text was there, and the diff between them was
  // dropped on the floor with a line saying there was nothing to pair. The
  // fallback is reported rather than silent, because a cross-channel pair is a
  // slightly weaker comparison — some of the edit is the channel, not the voice.
  let linked = null;
  let crossChannel = false;
  if (body) {
    // A REFUSAL IS NOT A DRAFT. When the model declines to write a note it
    // returns NOTES and no DRAFT section, and pairing that against what was
    // actually sent reported "365 words drafted, 120 sent" -- a 67% cut that
    // never happened, because the 365 words were an argument for not sending at
    // all. The pair is the training signal; poisoning it with refusals makes the
    // one measurement this command exists for meaningless.
    const hasDraft = (d) => d && /^DRAFT\s*\n-+\s*\n\s*\S/m.test(String(d.body ?? ''))
      && !/^\s*\(none\b/m.test(String(d.body ?? '').split(/^NOTES\s*$/m)[0]);
    const q = (extra, ...params) => {
      const rows = db.prepare(
        `SELECT id, version, body, channel, package_id FROM drafts
          WHERE person_id = ? AND sent_text IS NULL ${extra}
          ORDER BY version DESC, id DESC`).all(personId, ...params);
      return rows.find(hasDraft) ?? null;
    };
    linked = q('AND channel = ?', channel);
    if (!linked && service) { linked = q('AND package_id = ?', service); crossChannel = Boolean(linked); }
    if (!linked) { linked = q(''); crossChannel = Boolean(linked); }
    if (linked) {
      db.prepare('UPDATE drafts SET sent_text = ?, outreach_id = ? WHERE id = ?')
        .run(body, row.id, linked.id);
    }
  }

  console.log(`recorded outreach #${row.id}: ${bold(person.name)} · ${channel} · ${date}` +
    `${service ? ` · pitched ${service}` : ''}`);
  const sentRow = db.prepare('SELECT sent_to, address_basis FROM outreach WHERE id = ?')
    .get(row.id);
  const to = sentRow?.sent_to;
  if (to) {
    const guessed = sentRow?.address_basis === 'guess'
      || (!person.email && person.email_guess
        && bareEmail(person.email_guess) === bareEmail(to));
    console.log(dim(`  to ${to}${guessed ? '' : ` (${sentRow?.address_basis ?? 'unrecorded'})`}`));
    // SAID LOUDLY, because the failure is silent by construction. A hard bounce
    // lands in his own inbox and he can act on it; a catch-all that swallows
    // the note, a quiet spam filter, or a real address belonging to a different
    // person of the same name all return exactly nothing — and "nothing" is
    // also what a read-and-ignored note returns. Two rows already in this
    // record went to inferred addresses and sit in the denominator as sent
    // with no reply, which may be true of the market or may be true of the
    // address, and nothing distinguishes them.
    if (guessed) {
      console.log(`  ${bold('THIS WENT TO A PATTERN GUESS, not a verified address.')}`);
      console.log(dim('  Silence here is not evidence about the market — the note may never ' +
        'have arrived. If it bounces, record it so the denominator stays honest:\n' +
        `    npm run lead -- reply --outreach ${row.id} --sentiment negative ` +
        '--outcome "bounced: address was a guess"\n' +
        '  If a day passes with no bounce, that is the verification — promote it:\n' +
        `    npm run lead -- paste --person ${person.id} --url <profile> --email ${to}`));
    }
  }
  if (!body) console.log(dim('  no --file given, so the sent text was not captured. ' +
    'The draft is in the database and the sent text is only in your mail client, ' +
    'which nothing here can read — pair them now or the edit is gone. That edit is ' +
    'the highest-value signal in the system.'));
  else if (linked) {
    // Count the note, not the NOTES section under it. That briefing is written
    // for the operator and never sent, and counting it reported a 20% trim as
    // an 80% rewrite everywhere the pair was shown.
    const noteOnly = String(linked.body ?? '').split(/^NOTES\s*$/m)[0]
      .replace(/^\s*DRAFT\s*\n-+\s*\n/m, '').trim() || String(linked.body ?? '');
    const drafted = noteOnly.split(/\s+/).filter(Boolean).length;
    const actual = body.split(/\s+/).filter(Boolean).length;
    console.log(dim(`  paired with draft #${linked.id} v${linked.version} ` +
      `(${drafted} words drafted, ${actual} sent). The edit is the training signal.`));
    if (crossChannel && linked.channel !== channel) {
      console.log(dim(`  that draft was written for ${linked.channel} and sent as ${channel}, ` +
        'so part of the edit is the channel change rather than the voice.'));
    }
    if (service && linked.package_id && linked.package_id !== service) {
      // A word count across two different pitches is not an edit measurement.
      // Sheh's capacity note paired against a buyers_side draft at 122 words vs
      // 120 sent, which reads as "barely touched" for a note that shares no
      // sentence with it.
      console.log(dim(`  NOTE: that draft pitches ${linked.package_id}, this send pitches ` +
        `${service}. The word counts above compare two different notes and are not an edit ` +
        'measurement.'));
    }
  } else if (body) {
    console.log(dim('  no unsent draft on this person at all to pair it with, ' +
      'so this is recorded as sent text without a before.'));
  }
  return row.id;
}

/** Record a reply the operator pasted in. Classifies nothing automatically yet. */
/**
 * A CONNECTION REQUEST ACCEPTED IS NOT A REPLY, AND IT IS NOT NOTHING. Added
 * 2026-10-02. Sixteen connection requests sat as "no reply" whether or not
 * they were accepted, so the channel could not be judged at all. Like a bounce
 * it gets its own sentiment, kept out of every reply count; unlike a bounce it
 * is evidence about the market: the note was read and the door opened.
 */
function accepted(db, args) {
  const personId = String(requireArg(args, 'person', 'accepted'));
  const o = db.prepare(`SELECT o.id, o.status, o.sent_at, p.name FROM outreach o JOIN people p ON p.id = o.person_id
      WHERE o.person_id = ? AND o.channel = 'linkedin_connect_note' ORDER BY o.sent_at DESC, o.id DESC LIMIT 1`).get(personId);
  if (!o) throw new Error(`no connection request on record for "${personId}"`);
  if (db.prepare(`SELECT 1 FROM responses WHERE outreach_id = ? AND sentiment = 'accepted'`).get(o.id)) {
    console.log(`already recorded: ${o.name} accepted outreach #${o.id}`); return;
  }
  const date = args.date && args.date !== true ? String(args.date) : today();
  db.prepare(`INSERT INTO responses (outreach_id, responded_at, sentiment, outcome, notes)
              VALUES (?, ?, 'accepted', 'connection request accepted', NULL)`).run(o.id, date);
  if (o.status === 'sent_no_reply') db.prepare(`UPDATE outreach SET status = 'accepted' WHERE id = ?`).run(o.id);
  console.log(`recorded: ${bold(o.name)} accepted the connection request sent ${o.sent_at} (outreach #${o.id})`);
  console.log(dim('  not a reply, and not counted as one; a message to them now goes as a 1st-degree message'));
}

function reply(db, args) {
  const outreachId = Number(requireArg(args, 'outreach', 'reply'));
  const o = db.prepare(`SELECT o.*, p.name FROM outreach o LEFT JOIN people p
                        ON p.id = o.person_id WHERE o.id = ?`).get(outreachId);
  if (!o) throw new Error(`no outreach #${outreachId}`);

  const sentiment = requireArg(args, 'sentiment', 'reply');
  // `bounced` IS NOT A SENTIMENT AND MUST NOT BE COUNTED AS ONE. A bounce is
  // the mail system saying the note never arrived; it is the one outcome that
  // is evidence about the ADDRESS and no evidence at all about the market.
  // Filed under negative it would read as a refusal, which is exactly the
  // confusion this exists to remove — a guessed address that silently fails
  // and a note that was read and ignored both return nothing, and until a
  // bounce can be recorded there is nowhere to put the difference.
  if (!['positive', 'negative', 'neutral', 'bounced'].includes(sentiment)) {
    throw new Error('--sentiment must be positive, negative, neutral or bounced');
  }
  const notes = args.file && args.file !== true
    ? readFileSync(String(args.file), 'utf8')
    : (args.note && args.note !== true ? String(args.note) : null);

  db.prepare(`INSERT INTO responses (outreach_id, responded_at, sentiment, outcome, notes)
              VALUES (?, ?, ?, ?, ?)`)
    .run(outreachId, args.date && args.date !== true ? String(args.date) : today(),
         sentiment, args.outcome && args.outcome !== true ? String(args.outcome) : null, notes);

  db.prepare('UPDATE outreach SET status = ? WHERE id = ?')
    .run(sentiment === 'bounced' ? 'bounced'
      : sentiment === 'neutral' ? 'open_thread'
      : `responded_${sentiment}`, outreachId);
  if (sentiment === 'bounced') {
    console.log(dim('  recorded as BOUNCED, which is a fact about the address and not about ' +
      'the market. It should be excluded from any response rate — a note that never ' +
      'arrived cannot have been ignored.'));
  }

  console.log(`recorded ${sentiment} reply from ${bold(o.name ?? o.person_id)} ` +
    `on outreach #${outreachId}`);
}

/**
 * Decide a firm before spending a single profile lookup on it.
 *
 * Adds the org, reads its own website, applies the gates, and says go or no-go.
 * Costs about two cents and needs no LinkedIn. This is the command that should
 * run before the operator opens a browser, not after.
 *
 * `--candidates` runs the same pass over every firm `news --discover` left
 * behind. Discovery is the only stage that names a firm the operator never
 * heard of, and it deliberately writes those with `kind` NULL so nothing
 * unvetted can reach the shortlist. But filling the kind in was one hand-typed
 * command per firm, so sixteen candidates sat between the two stages doing
 * nothing. Sourcing that stops one step short of the ranked list has not
 * sourced anything.
 */
async function vet(db, cfg, args) {
  if (args.candidates) return vetCandidates(db, cfg, args);

  const name = requireArg(args, 'name', 'vet');
  const id = args.id && args.id !== true ? String(args.id) : slugify(name);

  addOrg(db, cfg, loadTargetingSafe(cfg), { ...args, name, id });
  const v = await vetOne(db, cfg, id);

  console.log(heading(`${v.org.name} — ${verdictWord(v)}`));
  console.log(`  kind: ${bold(v.org.kind ?? 'unknown')}` +
    `${v.org.sells_ai_advisory ? dim(' · sells AI advisory') : ''}` +
    `${v.org.sells_ai_delivery ? dim(' · builds AI') : ''}` +
    `${v.org.headcount_est ? dim(` · ~${v.org.headcount_est} people`) : ''}`);

  for (const g of v.kills) console.log(`  ${bold('KILL')} ${g.gate_id}\n       ${g.reason ?? ''}`);
  for (const g of v.warns) console.log(`  ${dim('warn')} ${g.gate_id} — ${truncate(g.reason ?? '', 150)}`);
  if (v.unreachable) {
    console.log(dim('  their site did not answer this crawler: ' + v.unreachable));
    console.log(dim('  Not a finding about the firm. The page may be plain HTML that a browser ' +
      'loads instantly; what was refused is the user-agent. Evidence has to come from a press ' +
      'release, trade press, or a page you read yourself and paste.'));
  } else if (!v.gates.length) {
    console.log(dim('  no gate could be decided from what their site says.'));
  }

  if (v.kills.length) {
    console.log(`\n${bold('Do not spend a profile lookup here.')}`);
    return;
  }

  console.log(`\n  ${v.people.length} people named on their site, ` +
    `${bold(String(v.worth.length))} in a buying seat:`);
  for (const p of v.worth) console.log(`    ${p.name.padEnd(24)} ${truncate(p.title ?? '', 46)}`);
  if (!v.worth.length && v.people.length) {
    console.log(dim('    none — the site names staff, but no seat that buys this.'));
  }
  if (!v.people.length) {
    console.log(dim('    their site names nobody. A profile lookup is the only way in here.'));
  }
  if (v.worth.length) {
    console.log(dim('\n  Now the lookups are worth it. For each:'));
    for (const p of v.worth.slice(0, 5)) {
      console.log(dim(`    npm run lead -- paste --person ${p.id} --url <profile> --file p.txt --extract`));
    }
  }
}

/**
 * One firm: read its own pages, apply the gates, report what came back.
 * Prints progress but not the verdict, so the batch can render its own.
 */
async function vetOne(db, cfg, id, { quiet = false } = {}) {
  const { execFileSync } = await import('node:child_process');
  const run = (script, extra) => {
    try {
      return execFileSync('node', ['--env-file-if-exists=.env', script, ...extra],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return (err.stdout ?? '') + (err.stderr ?? '');
    }
  };

  if (!quiet) console.log(dim('\nreading the firm\'s own pages...'));
  const enriched = run('src/enrich.mjs', ['--org', id, '--all']);
  // What enrich says about the fetch, kept so the verdict can distinguish a firm
  // whose evidence was ambiguous from one whose site never answered.
  const unreachable = (enriched.match(/site unreachable: (.+)/) ?? [])[1]?.trim()
    ?? (/\b(403|401)\b.*(forbidden|blocked)/i.test(enriched) ? 'refused with 403' : null);
  if (!quiet) {
    for (const line of enriched.split('\n')) {
      if (/named|sourced facts|partnerships|unreachable|"/.test(line)) console.log(dim(line));
    }
  }

  if (!quiet) console.log(dim('\napplying the gates...'));
  run('src/gate.mjs', ['--org', id]);

  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(id);
  const gates = db.prepare(
    'SELECT gate_id, outcome, reason FROM gate_results WHERE org_id = ?').all(id);
  const buyerTitles = [...new Set(cfg.packages.flatMap((x) => x.buyer_titles ?? []))];
  const people = db.prepare('SELECT * FROM people WHERE org_id = ? ORDER BY name').all(id);

  return {
    org, gates, people, unreachable,
    kills: gates.filter((g) => g.outcome.startsWith('kill')),
    warns: gates.filter((g) => g.outcome === 'warn'),
    worth: people.filter((p) => matchesTitle(p.title, buyerTitles)),
    // enrich prints its own cost. No cost means it never reached the model,
    // which means it could not read enough of the site to ask.
    unread: /\$0\.0000/.test(enriched) || !/page\(s\)/.test(enriched),
  };
}

/**
 * A firm whose `kind` is still NULL is NOT vetted, however clean its gates look.
 * `gate` and `rank` both filter on `kind IS NOT NULL`, so calling this one
 * "worth an hour" would promise a shortlist entry that never appears. Seen live
 * on the first batch: a global law firm passed every gate and stayed invisible.
 */
// UNREACHABLE IS NOT UNDECIDED, and reporting both as "kind unknown" hid a
// whole failure mode. Eleven firms were vetted in one batch and nine came back
// unknown; the reading was that their evidence did not settle anything. It had
// not been read at all. Their sites answer a browser in under 300ms and refuse
// this crawler's user-agent -- two hang until the timeout, three return 403.
//
// The two states need different actions and that is the whole point of telling
// them apart. Undecided means gather more evidence. Refused means their own site
// is closed to us and the evidence has to come from somewhere else: a press
// release, trade press, or a page the operator reads himself. Ranking harder
// fixes neither, but only one of them is worth another fetch.
const verdictWord = (v) =>
  v.kills.length ? 'DO NOT PURSUE'
    : v.unreachable ? 'SITE REFUSED US — no evidence, not a verdict'
    : !v.org.kind ? 'KIND UNKNOWN — still invisible to rank'
    : v.warns.length ? 'PROCEED WITH CARE' : 'WORTH AN HOUR';

/**
 * Every candidate discovery left behind, in one pass.
 *
 * A candidate with no domain is skipped rather than guessed at: `enrich` reads
 * whatever domain it is handed, and a wrong one describes another company
 * entirely, which is worse than no answer. Those are printed for the operator
 * to supply by hand.
 */
async function vetCandidates(db, cfg, args) {
  const rows = db.prepare(`
    SELECT o.id, o.name, o.domain,
           (SELECT vertical_id FROM org_verticals WHERE org_id = o.id LIMIT 1)        AS vertical,
           (SELECT trigger_id  FROM signals WHERE org_id = o.id
             ORDER BY detected_at DESC LIMIT 1)                                       AS trigger_id,
           (SELECT MAX(detected_at) FROM signals WHERE org_id = o.id)                 AS dated
      FROM orgs o
     WHERE o.kind IS NULL
     ORDER BY dated DESC, o.name`).all();

  if (!rows.length) {
    console.log('No unvetted candidates. Run: npm run news -- --discover');
    return;
  }

  const blocked = rows.filter((r) => !r.domain);
  const limit = num(args.limit) ?? Infinity;
  const ready = rows.filter((r) => r.domain).slice(0, limit);

  console.log(heading(`VETTING ${ready.length} CANDIDATE(S)`));
  console.log(dim(`about $${(ready.length * 0.02).toFixed(2)}, no LinkedIn, ` +
    'nothing sent. Each firm\'s own site, then the gates.\n'));

  // A FEW AT A TIME, because every firm here is a different host and a
  // different model call, and neither waits on the other. Serial, this pass
  // took about twenty seconds a firm: a hundred and twenty-eight candidates
  // sat unvetted at the end of 2026-09-22 because the queue moved slower than
  // discovery filled it, and an unvetted firm reaches no score and no
  // shortlist. Throughput was the binding constraint, not judgement.
  //
  // THE ONE-FETCH-PER-FIRM RULE IS UNTOUCHED. CLAUDE.md requires fetches to be
  // one per firm and rate-limited, and they still are: concurrency here is
  // ACROSS firms, never within one, so no single site sees a second request any
  // sooner than it did before. What overlaps is one site's page load with a
  // different site's, which is not a thing either site can notice.
  //
  // Bounded low on purpose. The ceiling that matters is the model API, not the
  // websites, and a number that merely looks brave would trade a slow queue for
  // a rate-limited one.
  const jobs = Math.max(1, Math.min(8, num(args.jobs) ?? 4));
  const done = new Array(ready.length);
  let next = 0, finished = 0;
  const worker = async () => {
    while (next < ready.length) {
      const i = next++;
      const r = ready[i];
      const v = await vetOne(db, cfg, r.id, { quiet: true });
      done[i] = { ...r, v };
      finished += 1;
      // Printed on completion rather than on start: out of order is honest
      // when the work is out of order, and a half-written line from two
      // workers at once would be worse than either.
      console.log(dim(`  [${String(finished).padStart(3)}/${ready.length}] ` +
        `${String(r.name).slice(0, 38).padEnd(39)}${verdictWord(v)}` +
        `${v.org.kind ? ` (${v.org.kind})` : ''}`));
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: jobs }, worker));
  console.log(dim(`\n  ${ready.length} vetted ${jobs} at a time in ` +
    `${Math.round((Date.now() - started) / 1000)}s`));

  // ---- what came back ------------------------------------------------------
  // Three outcomes, not two. A firm can survive every gate and still be
  // invisible, because the gates never ran on a kind nobody established.
  const killed  = done.filter((d) => d.v.kills.length);
  const unknown = done.filter((d) => !d.v.kills.length && !d.v.org.kind);
  const live    = done.filter((d) => !d.v.kills.length && d.v.org.kind);

  console.log(heading(`RESULT — ${live.length} of ${done.length} reached the shortlist`));
  console.log(table(done.map((d) => ({
    verdict: d.v.kills.length ? 'KILL' : !d.v.org.kind ? (d.v.unread ? 'unread' : 'no kind')
      : d.v.warns.length ? 'care' : 'WORTH',
    name: d.name,
    kind: d.v.org.kind ?? '·',
    trigger: d.trigger_id ?? '·',
    dated: d.dated ?? '·',
    why: truncate(d.v.kills[0]?.reason ?? d.v.warns[0]?.reason
      ?? (d.v.org.kind ? '' : d.v.unread ? 'could not read their site'
        : 'site read, kind undecided'), 52),
    ppl: `${d.v.worth.length}/${d.v.people.length}`,
  })), [
    { key: 'verdict', label: '', width: 7 },
    { key: 'name', label: 'FIRM', width: 26 },
    { key: 'kind', label: 'KIND', width: 13 },
    { key: 'trigger', label: 'TRIGGER', width: 26 },
    { key: 'dated', label: 'DATED', width: 10 },
    { key: 'ppl', label: 'BUY/ALL', width: 7, align: 'right' },
    { key: 'why', label: 'WHY', width: 52 },
  ]));

  if (blocked.length) {
    console.log(`\n${bold('No domain, so not vetted')} — the extractor withholds one unless ` +
      'confident, and a wrong domain enriches another company entirely:');
    for (const b of blocked) {
      console.log(dim(`  npm run lead -- vet --id ${b.id} --name "${b.name}" --domain <domain>` +
        `${b.vertical ? ` --vertical ${b.vertical}` : ''}`));
    }
  }

  if (unknown.length) {
    console.log(`\n${bold(`${unknown.length} passed their gates and are STILL INVISIBLE`)} — ` +
      'enrich could not establish a kind, and rank skips a firm without one. ' +
      'Set it by hand, or re-run: the classification is not deterministic.');
    for (const d of unknown) {
      console.log(dim(`  npm run lead -- vet --id ${d.id} --name "${d.name}" ` +
        `--domain ${d.domain} --kind end_client` +
        `${d.vertical ? ` --vertical ${d.vertical}` : ''}`));
    }
  }

  const worthLooking = live.filter((d) => d.v.worth.length);
  if (worthLooking.length) {
    console.log(`\n${bold('These name someone in a buying seat')} — now a profile lookup pays:`);
    for (const d of worthLooking) {
      for (const p of d.v.worth.slice(0, 3)) {
        console.log(dim(`  ${d.name}: ${p.name} — ${truncate(p.title ?? '', 40)}`));
      }
    }
  }
  console.log(dim(`\n${live.length} firm(s) now carry a kind, so gate and rank see them. ` +
    `${killed.length} killed, ${unknown.length} undecided, ${blocked.length} lacking a domain.` +
    (live.length ? '\nNext: npm run rank && npm run dash' : '')));
}

const matchesTitle = (title, patterns) => {
  const hay = ` ${String(title ?? '').toLowerCase()} `;
  return patterns.some((t) => hay.includes(String(t).toLowerCase()));
};

function loadTargetingSafe(cfg) {
  try { return loadTargetingFn(cfg); } catch { return { live: [], verticals: [] }; }
}

// Address patterns, most common first. A firm that publishes one address has
// effectively published all of them.
const PATTERNS = [
  { id: 'first.last', fn: (f, l) => `${f}.${l}` },
  { id: 'first',      fn: (f) => f },
  { id: 'flast',      fn: (f, l) => `${f[0]}${l}` },
  { id: 'firstl',     fn: (f, l) => `${f}${l[0]}` },
  { id: 'first_last', fn: (f, l) => `${f}_${l}` },
  { id: 'firstlast',  fn: (f, l) => `${f}${l}` },
  { id: 'lastf',      fn: (f, l) => `${l}${f[0]}` },
];

const nameParts = (name) => {
  const bits = String(name ?? '').toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ').replace(/\b(jr|sr|ii|iii|phd|cpa|mba)\b/g, '')
    .split(/\s+/).filter(Boolean);
  // HONORIFICS ARE STRIPPED FROM THE FRONT, not from anywhere. The suffix list
  // above ran everywhere and this one cannot: `dr` is also a surname, and
  // dropping it wherever it appeared would mangle a real one. It only ever
  // masquerades as a first name when it leads.
  //
  // An executive vice chancellor came through as "Dr. Jane Doe" — the
  // title had been captured into the name field upstream — and a first.last
  // pattern turned that into dr.reeves@, which is not an address anyone holds.
  // A wrong address is the worst failure this file can produce: it fails
  // SILENTLY, so the note reads as ignored rather than undelivered, and the
  // send lands in the denominator as evidence about a market it never reached.
  while (bits.length > 2 && /^(dr|mr|mrs|ms|miss|prof|professor|rev|sir|dame|hon|sgt|capt|col|gen|lt)$/
    .test(bits[0])) bits.shift();
  return bits.length >= 2 ? { first: bits[0], last: bits[bits.length - 1] } : null;
};

/**
 * Pull a bare address out of whatever string holds it. The seed's guesses carry
 * the operator's own annotations — "jane.doe@example.com (first.last@ pattern)" —
 * which are useful to a human and useless to a matcher.
 */
const bareEmail = (v) => String(v ?? '').match(/[\w.+_-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] ?? null;

/** Which pattern produces `email` for `name`, or null. */
function inferPattern(name, email) {
  const p = nameParts(name);
  const local = bareEmail(email)?.split('@')[0]?.toLowerCase();
  if (!p || !local) return null;
  return PATTERNS.find((x) => x.fn(p.first, p.last) === local)?.id ?? null;
}

/**
 * Derive a firm's address pattern from any address already known there, then
 * apply it to everyone else named at that firm.
 *
 * No API and no purchase: one confirmed address at a firm gives you the rest.
 * Results are written to `email_guess`, NEVER to `email` — the schema has
 * carried that distinction since day one ("unverified pattern guess, never
 * treated as fact"), and the ranking scores a guess below a known address
 * because a bounced note is worse than no note.
 *
 *   npm run lead -- emails --org capstreet [--example "Jane Doe:jdoe@firm.com"]
 */
async function emails(db, args) {
  const orgId = requireArg(args, 'org', 'emails');
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
  if (!org) throw new Error(`no org "${orgId}"`);
  if (!org.domain) throw new Error(`${org.name} has no domain on file; add one with add-org --domain`);
  // THE WEBSITE IS NOT ALWAYS THE MAIL DOMAIN. On 2026-09-30 a note to an
  // insurer's CIO went to its website's domain, which has no MX record and
  // receives no mail at all; the firm's mail runs on a sibling domain its site
  // publishes a contact address at. An example address names the real mail
  // domain, so it wins over the website's.
  const exampleDomain = args.example && args.example !== true
    ? (String(args.example).split(':')[1] ?? '').trim().split('@')[1]?.toLowerCase() : null;
  const domain = exampleDomain || String(org.domain).replace(/^www\./, '');
  // A DOMAIN THAT RECEIVES NO MAIL gets no guesses: every one would fail to
  // deliver, and a bounce reads as a dead prospect. A DNS lookup, nothing sent.
  const { promises: dns } = await import('node:dns');
  const mx = await dns.resolveMx(domain).catch(() => []);
  if (!mx.length) {
    console.log(heading(`${org.name} — ${domain} receives no email`));
    console.log(`  It has no MX record, so any address there would fail to deliver.`);
    console.log(dim('  Find the domain its mail really uses (a contact address on its own site usually names it),'));
    console.log(dim(`  then:  npm run lead -- emails --org ${orgId} --example "Jane Doe:jdoe@<mail domain>"`));
    return;
  }

  const people = db.prepare('SELECT * FROM people WHERE org_id = ?').all(orgId);
  // VERIFIED ADDRESSES FIRST, ALWAYS. The first version took whichever person
  // happened to have an address of either kind, which let a guess win on nothing
  // but row order — and then printed that guess as the basis for the pattern, as
  // if it were evidence. It was self-confirming: run this once from an unverified
  // example and every later run re-derives the same pattern from its own previous
  // output and reports it as confirmed. The pattern could never be falsified.
  // A guess is still worth working from when it is all there is, but it is now
  // used last and labelled as what it is.
  const withAddr = (col) => people.filter((p) => bareEmail(p[col]))
    .map((p) => ({ ...p, addr: bareEmail(p[col]), verified: col === 'email' }));
  const known = [...withAddr('email'), ...withAddr('email_guess')];

  // An operator-supplied example beats inference — one real address is enough.
  let pattern = null;
  let basis = null;
  if (args.example && args.example !== true) {
    const [nm, em] = String(args.example).split(':');
    pattern = inferPattern(nm, em);
    basis = `the example you gave (${nm?.trim()} = ${em?.trim()})`;
    if (!pattern) throw new Error(`could not match "${em}" to any known pattern for "${nm}"`);
  } else {
    for (const p of known) {
      const hit = inferPattern(p.name, p.addr);
      if (hit) {
        pattern = hit;
        basis = `${p.name} <${p.addr}>${p.verified ? '' : ' — ITSELF A GUESS'}`;
        break;
      }
    }
  }

  if (!pattern) {
    console.log(heading(`${org.name} — no pattern to work from`));
    console.log(`  ${known.length} address(es) on file at this firm, none matching a known shape.`);
    console.log(dim('  Supply one and every other name at the firm follows:'));
    console.log(dim(`    npm run lead -- emails --org ${orgId} --example "Jane Doe:jdoe@${domain}"`));
    console.log(dim('\n  One address is usually findable: a press contact, a conference bio, a ' +
      'filing signature, or the firm\'s own contact page.'));
    return;
  }

  const shape = PATTERNS.find((x) => x.id === pattern);
  const upd = db.prepare('UPDATE people SET email_guess = ? WHERE id = ?');
  const rows = [];
  for (const p of people) {
    const have = bareEmail(p.email);
    if (have) { rows.push({ p, addr: have, state: 'known' }); continue; }
    const parts = nameParts(p.name);
    if (!parts) { rows.push({ p, addr: '—', state: 'no surname' }); continue; }
    const addr = `${shape.fn(parts.first, parts.last)}@${domain}`;
    upd.run(addr, p.id);
    rows.push({ p, addr, state: 'guess' });
  }

  console.log(heading(`${org.name} — pattern "${pattern}" from ${basis}`));
  if (/ITSELF A GUESS/.test(basis)) {
    console.log(dim('  Nothing at this firm is verified, so the whole column below rests on an ' +
      'assumption about one name. Find one real address before sending.'));
  }
  console.log(table(rows.map((r) => ({
    name: r.p.name, title: truncate(r.p.title ?? '', 34),
    addr: r.addr, state: r.state,
  })), [
    { key: 'name', label: 'NAME', width: 24 }, { key: 'title', label: 'TITLE', width: 36 },
    { key: 'addr', label: 'ADDRESS', width: 34 }, { key: 'state', label: '', width: 10 },
  ]));
  console.log(dim(`\n${rows.filter((r) => r.state === 'guess').length} written to email_guess, ` +
    'not to email. A guess raises reachability but is scored below a verified address, ' +
    'because a bounce costs more than a delay.'));
  console.log(dim('Verify before sending — most mail providers accept a probe, and a firm\'s ' +
    'contact form will often confirm the shape.'));
}

function list(db, args) {
  const filter = args.vertical && args.vertical !== true ? String(args.vertical) : null;
  const rows = db.prepare(`
    SELECT o.id, o.name, o.domain,
           (SELECT group_concat(vertical_id, ' ') FROM org_verticals WHERE org_id = o.id) AS verticals,
           (SELECT COUNT(*) FROM people   WHERE org_id = o.id) AS people,
           (SELECT COUNT(*) FROM evidence WHERE org_id = o.id
              AND provenance = 'operator_supplied') AS pasted,
           (SELECT COUNT(*) FROM outreach WHERE org_id = o.id) AS sent
    FROM orgs o
    WHERE o.seeded = 0 AND (o.source LIKE 'operator%' OR ? IS NULL)
    ORDER BY o.first_seen DESC, o.name`).all(filter);

  const shown = filter ? rows.filter((r) => (r.verticals ?? '').includes(filter)) : rows;
  console.log(heading(`LEADS (${shown.length})`));
  if (!shown.length) {
    console.log('None yet. Add one:\n  npm run lead -- add-org --name "Firm Name" ' +
      '--domain firm.com --vertical hedge_fund_ai_ramp');
    return;
  }
  console.log(table(shown.map((r) => ({
    id: r.id, name: r.name, domain: r.domain ?? '·',
    vertical: r.verticals ?? '·',
    people: String(r.people), pasted: String(r.pasted), sent: String(r.sent),
  })), [
    { key: 'id', label: 'ID', width: 28 },
    { key: 'name', label: 'FIRM', width: 34 },
    { key: 'domain', label: 'DOMAIN', width: 24 },
    { key: 'vertical', label: 'THESIS', width: 26 },
    { key: 'people', label: 'PPL', width: 4, align: 'right' },
    { key: 'pasted', label: 'PASTED', width: 6, align: 'right' },
    { key: 'sent', label: 'SENT', width: 4, align: 'right' },
  ]));
}

// Pages a firm puts an address on, most likely first. Contact pages carry role
// addresses; press releases carry PERSONAL ones, which are the only kind that
// reveals a pattern.
const ADDRESS_PATHS = [
  '/contact', '/contact-us', '/contactus', '/about/contact', '/about-us/contact',
  '/team', '/who-we-are', '/people', '/about', '/about-us',
];

// info@ tells you the domain accepts mail and nothing about how it names people.
const ROLE_LOCALS = new Set([
  'info', 'press', 'media', 'contact', 'hello', 'hi', 'careers', 'jobs',
  'recruiting', 'support', 'help', 'sales', 'admin', 'office', 'general',
  'enquiries', 'inquiries', 'legal', 'privacy', 'compliance', 'marketing',
  'newsletter', 'no-reply', 'noreply', 'donotreply', 'webmaster', 'ir',
  'investors', 'investorrelations', 'security', 'abuse', 'billing', 'accounts',
  'connect', 'team', 'reception', 'mail', 'email', 'firm', 'newbusiness',
  'businessdevelopment', 'partnerships', 'events', 'subscribe', 'rsvp', 'hr',
]);

/**
 * Cloudflare's email obfuscation, decoded.
 *
 * Not a nicety. On 2026-09-09 a press release DISPLAYED "jdoe@firm.com"
 * while the protected payload decoded to an address at an outside PR agency. Trusting the visible text would have "confirmed" the firm's address
 * pattern with an address that does not exist at the firm, and written a wrong
 * guess onto every colleague. Read the payload, never the label.
 */
function decodeCfEmail(hex) {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(out) ? out.toLowerCase() : null;
}

/** Every address on one page at this domain, with the name written beside it. */
function addressesOnPage(html, text, domain) {
  const found = new Map();
  const at = domain.replace(/^www\./, '').toLowerCase();
  const add = (addr, name) => {
    if (!addr) return;
    const [local, host] = addr.toLowerCase().split('@');
    if (host !== at) return;                       // another firm's address
    if (!found.has(addr) || (name && !found.get(addr))) found.set(addr, name ?? null);
  };

  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) add(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/email-protection#([0-9a-f]+)/gi)) add(decodeCfEmail(m[1]));

  // A name written within ~90 characters before the address is almost always
  // whose address it is: "Jane Doe, 1-555-010-0000, jdoe@firm.com".
  const NAME = /([A-Z][a-z]+(?:[- ][A-Z][a-z]+)?\s+[A-Z][a-z'’]+)/;
  for (const m of text.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)) {
    const before = text.slice(Math.max(0, m.index - 90), m.index);
    add(m[0], NAME.exec(before)?.[1] ?? null);
  }
  // A decoded address arrives with no text around it — Cloudflare replaced the
  // label — so proximity cannot name it. Work backwards instead: take every name
  // written anywhere on the page and ask which one GENERATES this local part
  // under some known pattern. "jdoe" plus a "Jane Doe" on the page is
  // flast, and the match is checkable rather than guessed. Ambiguity is left
  // unnamed: two names that both generate it name nobody.
  const onPage = [...new Set([...text.matchAll(
    /\b([A-Z][a-z]{1,15}(?:[- ][A-Z][a-z]{1,15})?)\s+([A-Z][a-z'’]{1,19})\b/g)]
    .map((m) => `${m[1]} ${m[2]}`))];
  for (const [addr, name] of found) {
    if (name) continue;
    const hits = onPage.filter((n) => inferPattern(n, addr));
    if (hits.length === 1) found.set(addr, hits[0]);
  }

  return [...found].map(([addr, name]) => ({ addr, name }));
}

/**
 * Find one real address at a firm, so the pattern can fill in everyone else.
 *
 * The binding constraint in this system is not who to write to, it is how to
 * reach them: 302 people on file, two addresses. Seven firms carry a live dated
 * trigger and not one has a reachable person. A global law firm ranks third with
 * twenty-five named people, a Global Chair and a CIO among them, and no way to
 * write to any of them.
 *
 * The work is mechanical — it was done by hand for one PE firm in twenty minutes,
 * reading their newsroom until a personal address appeared, then applying the
 * shape to everyone. This does that. It finds nothing at a firm that publishes
 * nothing, which is a true answer and common at large banks and law firms.
 */
async function addresses(db, cfg, args) {
  // --all runs every firm that has a rankable person and no address for anyone
  // there. One address unblocks the whole firm, so the unit of work is the firm.
  if (args.all) {
    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.name FROM person_scores ps
        JOIN people p ON p.id = ps.person_id
        JOIN orgs o   ON o.id = ps.org_id
       WHERE ps.run_id = (SELECT MAX(run_id) FROM person_scores)
         AND ps.authority >= 0.5 AND o.domain IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM people q WHERE q.org_id = o.id
                          AND (q.email IS NOT NULL OR q.email_guess IS NOT NULL))
       ORDER BY o.name`).all();
    const limit = num(args.limit) ?? Infinity;
    const todo = rows.slice(0, limit);
    console.log(heading(`${todo.length} firm(s) with someone worth writing to and no way to`));
    let got = 0;
    for (const [i, r] of todo.entries()) {
      console.log(dim(`\n[${i + 1}/${todo.length}] ${r.name}`));
      await addresses(db, cfg, { ...args, all: false, org: r.id });
      const n = db.prepare(`SELECT COUNT(*) c FROM people
        WHERE org_id = ? AND email_guess IS NOT NULL`).get(r.id).c;
      if (n) got += 1;
    }
    console.log(heading(`${got} of ${todo.length} firm(s) now have addresses`));
    return;
  }
  const orgId = requireArg(args, 'org', 'addresses');
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
  if (!org) throw new Error(`no org "${orgId}"`);
  if (!org.domain) throw new Error(`${org.name} has no domain on file; add one with add-org --domain`);
  const domain = String(org.domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const base = `https://${domain}`;

  const { fetchPage, discoverNewsLinks, extractText, NEWS_PATHS } =
    await import('./sources/web.mjs');

  console.log(heading(`${org.name} — looking for one real address`));
  console.log(dim(`${base}, their own pages only, robots respected.\n`));

  const home = await fetchPage(base);
  if (!home.ok) console.log(dim(`  ${base} — ${home.status ?? 'unreachable'}`));
  const linked = home.ok ? discoverNewsLinks(home.html, home.url).map((l) => l.url) : [];
  const urls = [...new Set([
    base,
    ...ADDRESS_PATHS.map((x) => `${base}${x}`),
    ...linked,
    ...NEWS_PATHS.map((x) => `${base}${x}`),
  ])];

  const MAX = Number(args.pages && args.pages !== true ? args.pages : 14);
  const hits = [];
  let read = 0;
  for (const url of urls) {
    if (read >= MAX) break;
    const r = url === base && home.ok ? home : await fetchPage(url);
    if (!r.ok || !r.html) continue;
    read += 1;
    const text = r.text ?? extractText(r.html);
    for (const h of addressesOnPage(r.html, text, domain)) {
      hits.push({ ...h, url: r.url ?? url });
    }
  }

  // THE FIRM'S OWN SITE IS THE WRONG PLACE, and eight firms proved it: two law
  // firms, two investment firms and a hedge fund publish no address at all;
  // others publish only connect@ or HR@. Role addresses, all of them, which
  // reveal nothing about how a firm names people.
  //
  // PRESS RELEASES are where a personal address appears, because a media contact
  // has to be a person. The only personal address recovered that day came off
  // a wire release, not the firm's own site. So when the site yields no named
  // address, ask the news index for one. Costs a Tavily credit and is skipped
  // entirely when the site already answered.
  // USABLE, not merely named. "ClaimSolutions@insurer.com" picked up the
  // words "Claim Solutions" sitting beside it, which looks like a name, is not
  // one, and suppressed the press search that would have found a real address.
  // The test is whether a pattern can actually be DERIVED from it — that is the
  // only thing the address is wanted for, and role addresses cannot be enumerated.
  //
  // A KNOWN PERSON, not merely a name-shaped label. Added 2026-10-01: the same
  // failure as ClaimSolutions@, one level up. A contact page listing
  // "Auto Phone ... auto@" and "Claims Phone ... claims@" read as two people
  // called Auto and Claims, voted "first", and wrote russell@ and bryan@ onto
  // twelve executives. A blog's "Lender Support <lendersupport@>" voted
  // "firstlast" the same way. Every one of those guesses was made up, and a made-up address
  // bounces in silence. A label can generate its own address under SOME pattern
  // by construction, so the only test a label cannot pass is whether the name
  // belongs to someone already on file at this firm. Anyone else is printed
  // for the operator to confirm with --example, never applied automatically.
  const knownHere = new Set(db.prepare('SELECT name FROM people WHERE org_id = ?').all(orgId)
    .map((p) => nameParts(p.name)).filter(Boolean).map((p) => `${p.first} ${p.last}`));
  const isKnown = (name) => { const p = nameParts(name); return Boolean(p) && knownHere.has(`${p.first} ${p.last}`); };
  const named = () => hits.some((h) => h.name && isKnown(h.name) && inferPattern(h.name, h.addr));
  if (!named() && !args['no-press']) {
    const { searchNews, creditsUsed } = await import('./sources/tavily.mjs');
    const q = `"${org.name}" "media contact" OR "press contact" "@${domain}"`;
    console.log(dim(`  nothing named on their site — asking the news index:\n    ${q}`));
    const { results, error } = await searchNews(q, { maxResults: 6 });
    tavilySpent = creditsUsed();
    if (error) console.log(dim(`    ${error}`));
    for (const r of results ?? []) {
      const page = await fetchPage(r.url);
      if (!page.ok || !page.html) continue;
      read += 1;
      const text = page.text ?? extractText(page.html);
      for (const h of addressesOnPage(page.html, text, domain)) {
        hits.push({ ...h, url: page.url ?? r.url });
      }
    }
  }

  const seen = new Map();
  for (const h of hits) if (!seen.has(h.addr) || (h.name && !seen.get(h.addr).name)) seen.set(h.addr, h);
  const all = [...seen.values()];
  const role = all.filter((h) => ROLE_LOCALS.has(h.addr.split('@')[0]));
  const personal = all.filter((h) => !ROLE_LOCALS.has(h.addr.split('@')[0]));

  console.log(dim(`  ${read} page(s) read, ${all.length} address(es) at ${domain}\n`));
  if (!all.length) {
    console.log('None published. Common at large firms, and a true answer rather than a failure.');
    console.log(dim('  Supply one yourself and every name at the firm follows:\n' +
      `    npm run lead -- emails --org ${orgId} --example "Jane Doe:jdoe@${domain}"`));
    return;
  }

  if (role.length) {
    console.log(`${bold('Role addresses')} ${dim('— reach a person, reveal no pattern')}`);
    for (const h of role) console.log(`  ${h.addr.padEnd(34)} ${dim(truncate(h.url, 60))}`);
  }

  // A pattern needs a NAME beside an address. Vote across every pair found.
  const votes = new Map();
  const evidence = [];
  const unconfirmed = [];
  for (const h of personal) {
    if (!h.name) continue;
    if (!isKnown(h.name)) { if (inferPattern(h.name, h.addr)) unconfirmed.push(h); continue; }
    const id = inferPattern(h.name, h.addr);
    if (!id) continue;
    votes.set(id, (votes.get(id) ?? 0) + 1);
    evidence.push({ ...h, pattern: id });
  }

  if (personal.length) {
    console.log(`\n${bold('Personal addresses')}`);
    for (const h of personal) {
      console.log(`  ${h.addr.padEnd(34)} ${(h.name ?? dim('no name beside it')).padEnd(24)} ` +
        dim(truncate(h.url, 52)));
    }
  }

  if (unconfirmed.length) {
    console.log(`\n${bold('Named, but not anyone on file here')} ${dim('— may be a label, not a person; not applied')}`);
    for (const h of unconfirmed) {
      console.log(`  ${h.addr.padEnd(34)} ${String(h.name).replace(/\s+/g, ' ').padEnd(24)} ${dim(truncate(h.url, 52))}`);
    }
    console.log(dim('  If one of these IS a person at the firm, confirm it and the pattern follows:\n' +
      `    npm run lead -- emails --org ${orgId} --example "${String(unconfirmed[0].name).replace(/\s+/g, ' ')}:${unconfirmed[0].addr}"`));
  }

  if (!evidence.length) {
    console.log(`\n${bold('No pattern could be inferred.')} An address needs the NAME of someone ` +
      'on file at this firm beside it before it says how the firm builds addresses.');
    if (personal.length) {
      console.log(dim('  If you can name one of the above, that is enough:\n' +
        `    npm run lead -- emails --org ${orgId} --example "Their Name:${personal[0].addr}"`));
    }
    return;
  }

  const best = [...votes].sort((a, b) => b[1] - a[1])[0][0];
  console.log(`\n${bold(`Pattern: ${best}`)} ${dim(`from ${votes.get(best)} named address(es)`)}`);
  for (const e of evidence.filter((x) => x.pattern === best)) {
    console.log(`  ${e.name} <${e.addr}>  ${dim(truncate(e.url, 56))}`);
  }
  if (votes.size > 1) {
    console.log(dim(`  ${votes.size} patterns disagree (` +
      `${[...votes].map(([k, n]) => `${k}:${n}`).join(', ')}). Largest wins; check it before sending.`));
  }

  const ev = evidence.find((x) => x.pattern === best);
  if (args.dry) {
    console.log(dim('\nDry run: nothing written. Drop --dry to apply, or run\n' +
      `    npm run lead -- emails --org ${orgId} --example "${ev.name}:${ev.addr}"`));
    return;
  }
  console.log(dim('\nApplying it to everyone named at this firm...\n'));
  await emails(db, { org: orgId, example: `${ev.name}:${ev.addr}` });
  console.log(dim(`\nSource for the pattern: ${ev.url}`));
}

const DOMAIN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['domain', 'confidence', 'note'],
  properties: {
    domain: { type: ['string', 'null'], description: 'Bare hostname, no scheme, no path. Null if not found.' },
    confidence: { type: 'string', enum: ['high', 'low'] },
    note: { type: ['string', 'null'] },
    // THE SEARCH IS ALREADY HAPPENING. This step web-searches to find a firm's
    // own site, and a result that identifies the firm very often states its
    // size in the same breath. Asking costs nothing extra and fills the field
    // that both size gates need and neither could evaluate for three quarters
    // of the book.
    headcount_est: { type: ['integer', 'null'],
      description: 'Approximate employees, IF a search result stated it. Null otherwise.' },
    headcount_url: { type: ['string', 'null'],
      description: 'The URL that stated the headcount. Required if headcount_est is given — '
        + 'a number without a source is an estimate, and this field is for retrieved facts.' },
  },
};

/**
 * Resolve a firm name to its own website.
 *
 * Discovery names firms out of news articles and the extractor withholds a
 * domain unless it is confident, on purpose: `enrich` reads whatever domain it
 * is handed, so a wrong one describes a different company and every later
 * decision about this firm is made from that company's site. The result is that
 * three quarters of a discovery run cannot be vetted at all — 36 of 49 after the
 * last one.
 *
 * This closes that gap without loosening the rule, by VERIFYING rather than
 * trusting. The model proposes a domain; this code then fetches it and checks
 * the page actually names the firm. A proposal that fails the check is discarded
 * and the firm keeps no domain, which is the same state it was already in.
 *
 * Note what is different from `news --promote`: that search is pinned to one
 * domain handed over by this code. This one cannot be — the domain is the thing
 * being looked for — so the bound here is the verification, not the scope.
 */
/**
 * ENUMERATE BY SIZE, THEN LOOK FOR THE TRIGGER — the inverse of every other
 * discovery path here, and the one that reaches institutions too small to
 * announce anything.
 *
 * Everywhere else a firm is found by its trigger and a gate then judges its
 * size from a number nobody retrieved. Four sweeps on 2026-09-22 showed that
 * cannot work for a bank in this band: national news, the banking trade press,
 * vendor marketing and award programmes all return the largest institutions,
 * because announcing needs a communications function. The FDIC publishes total
 * assets quarterly by regulation, so the size is free, exact, and available
 * before the first fetch.
 *
 * Writes no signals and no people. These are FIRMS WITH A SIZE AND NOTHING
 * ELSE: they carry no `kind`, so gate and rank skip them until vetted, exactly
 * like a news candidate. The trigger, if there is one, is found afterwards by
 * `vet` and `enrich` reading each bank's own pages — which is where the only
 * small-bank signal anyone found all day actually lived.
 */
async function banks(db, cfg, args) {
  const { banksInBand } = await import('./sources/fdic.mjs');
  const state = args.state && args.state !== true ? String(args.state) : null;
  const bn = (v, dflt) => (num(v) != null ? num(v) * 1e9 : dflt);
  // Defaults come from the thesis rather than from here, so the band this
  // enumerates and the band the money gate accepts cannot drift apart.
  const targeting = loadTargetingSafe(cfg);
  // --thesis names the banking thesis the banks are filed under; it is one
  // business's id, so it comes from the command line, not from here.
  const thesisId = args.thesis && args.thesis !== true ? String(args.thesis) : null;
  if (!thesisId) throw new Error('banks needs --thesis <id>: the sectors.yml thesis to file the banks under.');
  const thesis = (targeting.verticals ?? []).find((v) => v.id === thesisId);
  if (!thesis) throw new Error(`no thesis "${thesisId}" in sectors.yml`);
  const min = bn(args.min, thesis?.money?.aum_floor_usd ?? 2e9);
  // The ceiling is the headcount ceiling expressed in assets: community and
  // regional banks run four to six million dollars of assets per employee, so
  // 5,000 people is roughly $25bn. Stated here because the gate cannot express
  // it — it has a headcount ceiling and the FDIC does not publish headcount.
  const max = bn(args.max, 25e9);

  const { banks: found, error, total } = await banksInBand(state, min, max);
  if (error) throw new Error(error);

  console.log(heading(`FDIC BankFind · ${state ?? 'all states'} · ` +
    `$${(min / 1e9).toFixed(1)}bn to $${(max / 1e9).toFixed(0)}bn`));
  console.log(dim(`${total} active insured institution(s) in the band. Assets are a quarterly ` +
    'regulatory filing, so this is a register and not a search: nothing here was found ' +
    'because it announced something.\n'));

  const seen = new Map(db.prepare('SELECT id, name FROM orgs').all()
    .map((o) => [String(o.name).toLowerCase().replace(/[^a-z0-9]/g, ''), o.id]));
  let added = 0, already = 0;
  for (const b of found) {
    const key = String(b.name).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) { already += 1; continue; }
    if (args.dry) { added += 1; continue; }
    addOrg(db, cfg, targeting, {
      name: b.name, id: slugify(b.name), domain: b.domain ?? undefined,
      vertical: thesisId,
      aum: b.assets_usd, hq: [b.city, b.state].filter(Boolean).join(', '),
      source: `FDIC BankFind, assets as of ${b.as_of ?? 'latest filing'}`,
      quiet: true,
    });
    added += 1;
  }
  const show = found.slice(0, 12);
  for (const b of show) {
    console.log(dim(`  ${String(b.name).slice(0, 34).padEnd(35)}` +
      `$${(b.assets_usd / 1e9).toFixed(1).padStart(5)}bn  ` +
      `${String(b.domain ?? '—').padEnd(26)}${b.offices ?? '?'} offices`));
  }
  if (found.length > show.length) console.log(dim(`  … and ${found.length - show.length} more`));
  console.log(dim(`\n${added} added${args.dry ? ' (DRY RUN, nothing written)' : ''}, ` +
    `${already} already in the book. They carry no \`kind\`, so gate and rank skip them ` +
    'until vetted — the size is known and the trigger is not.'));
  if (added && !args.dry) {
    console.log(dim('Next: npm run lead -- vet --candidates   (reads each bank\'s own pages, ' +
      'which is where a small bank\'s AI news actually lives)'));
  }
}

async function domains(db, cfg, args) {
  const rows = db.prepare(`
    SELECT o.id, o.name,
           (SELECT claim FROM evidence e WHERE e.org_id = o.id AND e.kind = 'news_event'
             ORDER BY e.retrieved_at DESC LIMIT 1) AS why
      FROM orgs o
     -- AN EXPLICIT --org OVERRIDES THE UNVETTED FILTER. The kind-IS-NULL test
     -- is what makes this a sweep over candidates news --discover left behind,
     -- and it is right for the sweep. It is wrong when the operator names one
     -- firm: on 2026-09-23 a vetted end_client with no domain could not be
     -- reached by this command at all, because the filter meant for the sweep
     -- also governed the targeted call. An empty string counts as no domain too.
     WHERE (o.domain IS NULL OR TRIM(o.domain) = '')
       AND (? IS NOT NULL OR o.kind IS NULL)
       AND (? IS NULL OR o.id = ?)
     ORDER BY o.name`)
    .all(args.org && args.org !== true ? String(args.org) : null,
         args.org && args.org !== true ? String(args.org) : null,
         args.org && args.org !== true ? String(args.org) : null);

  if (!rows.length) { console.log('Every unvetted candidate already has a domain.'); return; }
  const limit = num(args.limit) ?? Infinity;
  const todo = rows.slice(0, limit);

  console.log(heading(`${todo.length} firm(s) with no domain`));
  console.log(dim('One search each, then the page is fetched and checked for the firm\'s name. ' +
    `About four cents a firm.${args.dry ? ' Dry run: nothing written.' : ''}\n`));

  const { fetchPage, extractText } = await import('./sources/web.mjs');
  const system = readFileSync(resolve(ROOT, 'prompts/find-domain.md'), 'utf8');
  const runId = startRun(db, 'domains', { model: cfg.models.default });
  const upd = db.prepare('UPDATE orgs SET domain = ? WHERE id = ?');
  // Written separately from the domain because it is a different KIND of fact
  // with a different provenance, and because a headcount without a URL is not a
  // retrieved one — it is the model's recollection, and it is stored under the
  // weaker label rather than being quietly upgraded by proximity to a search.
  const updHc = db.prepare(`UPDATE orgs SET
      headcount_est    = COALESCE(@hc, headcount_est),
      headcount_source = CASE
        WHEN @hc IS NULL THEN headcount_source
        WHEN headcount_source = 'page' THEN 'page'
        ELSE @src END
    WHERE id = @id`);
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  let cost = 0;
  const found = [], rejected = [], missed = [], unreachable = [];

  for (const [i, r] of todo.entries()) {
    process.stdout.write(dim(`  [${i + 1}/${todo.length}] ${r.name.slice(0, 30).padEnd(31)}`));
    const res = await complete(db, runId, {
      model: cfg.models.default, effort: 'low', maxTokens: 3000,
      schema: DOMAIN_SCHEMA, system,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }],
      messages: [{ role: 'user', content:
        `FIRM: ${r.name}\n${r.why ? `KNOWN FOR: ${r.why}\n` : ''}\nWhat is this firm's own website?` }],
    });
    cost += res.cost_usd ?? 0;
    const d = (res.data?.domain ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

    if (!d || res.data?.confidence !== 'high') { missed.push(r); console.log(dim('not found')); continue; }

    // VERIFY. A schema field is a claim; fetching the page is the check. The
    // firm's name has to appear on its own homepage. Try www as well, the same
    // fallback `enrich` uses — the first run rejected tcs.com, novabiomedical.com
    // and deepki.com, all plainly right, for want of it.
    let page = await fetchPage(`https://${d}`);
    if (!page.ok) page = await fetchPage(`https://www.${d}`);
    const text = page.ok && page.html ? (page.text ?? extractText(page.html)) : '';
    const words = r.name.split(/\s+/).filter((w) => w.length > 3).map(norm);
    const hit = words.length
      ? words.some((w) => norm(text).includes(w))
      : norm(text).includes(norm(r.name));

    // A site that refuses the fetcher is NOT a wrong domain, and treating the two
    // the same throws away correct answers — which is the error this check exists
    // to prevent, pointed the other way. Unreachable is reported for a human, not
    // rejected and not written.
    if (!page.ok) {
      unreachable.push({ ...r, d });
      console.log(dim(`${d} — could not load, left for you to confirm`));
      continue;
    }
    if (!hit) {
      rejected.push({ ...r, d, why: 'page never names the firm' });
      console.log(dim(`${d} — rejected, name not on the page`));
      continue;
    }
    found.push({ ...r, d });
    console.log(`${bold(d)}`);
    if (!args.dry) {
      upd.run(d, r.id);
      const hc = Number.isFinite(res.data?.headcount_est) ? res.data.headcount_est : null;
      // A URL makes it retrieved; its absence makes it recalled. The model is
      // not asked to judge which — the presence of the citation decides.
      if (hc) updHc.run({ hc, src: res.data?.headcount_url ? 'search' : 'estimate', id: r.id });
    }
  }

  console.log(heading(`${found.length} resolved · ${unreachable.length} unverifiable · ` +
    `${rejected.length} rejected · ${missed.length} not found`));
  if (unreachable.length) {
    console.log(`${bold('Found but unverifiable')} — the site refused the fetcher, which says ` +
      'nothing about whether the domain is right. Confirm by eye and set it:');
    for (const x of unreachable) {
      console.log(dim(`  npm run lead -- add-org --id ${x.id} --name "${x.name}" --domain ${x.d}`));
    }
  }
  if (rejected.length) {
    console.log(`\n${bold('Rejected')} — the page loaded and never names the firm:`);
    for (const x of rejected) console.log(dim(`  ${x.name} -> ${x.d}`));
  }
  console.log(dim(`\n$${cost.toFixed(4)} including searches.` +
    (found.length && !args.dry ? ` Next: npm run lead -- vet --candidates` : '')));
  finishRun(db, runId, { cost_usd: cost, n_in: todo.length, n_out: found.length });
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const targeting = loadTargeting(cfg);
  const db = openDb();
  const runId = startRun(db, 'lead', { notes: process.argv.slice(2).join(' ') });

  try {
    switch (cmd) {
      // THE VERBS BELOW CHANGE WHAT A CARD SHOWS, so the cards get rebuilt
      // afterwards. Without it the operator pastes a profile at the command
      // line, opens the dashboard, and reads the card as it was before --
      // "i dont see the latest note in the card". The browser path already did
      // this because the server rebuilds after every action; the CLI path
      // writes the same tables and did not.
      case 'add-org':    addOrg(db, cfg, targeting, args); break;
      case 'add-person': addPerson(db, args); break;
      case 'move':       move(db, args); break;
      case 'paste':      await paste(db, cfg, args); break;
      case 'extract':    await reextract(db, cfg, args); break;
      case 'verdict':    verdict(db, args); break;
      case 'vet':        await vet(db, cfg, args); break;
      case 'emails':     await emails(db, args); break;
      case 'addresses': await addresses(db, cfg, args); break;
      case 'banks':     await banks(db, cfg, args); break;
      case 'domains':   await domains(db, cfg, args); break;
      case 'sent':       sent(db, cfg, args); break;
      case 'unsend':     unsend(db, args); break;
      case 'merge':      merge(db, args); break;
      case 'accepted':   accepted(db, args); break;
      case 'reply':      reply(db, args); break;
      case 'list': case undefined: list(db, args); break;
      default:
        throw new Error(`unknown command "${cmd}". ` +
          'Try: vet | add-org | add-person | paste | domains | addresses | emails | sent | reply | list');
    }
    // Rebuild only for the verbs that alter a card. `vet`, `domains` and the
    // sweeps are bulk stages the operator runs deliberately and follows with
    // rank; rebuilding mid-sweep would be noise.
    if (['paste', 'sent', 'move', 'unsend', 'reply', 'add-person'].includes(cmd)
        && !args['no-dash']) {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('npm', ['run', 'dash', '--silent'], { cwd: ROOT, encoding: 'utf8' });
      } catch { console.log(dim('  (dashboards not rebuilt; run `npm run dash`)')); }
    }
  } finally {
    finishRun(db, runId, { tavily_credits: tavilySpent });
    db.close();
  }
}

try {
  await main();
} catch (err) {
  // A usage error is the normal case here, not a crash. Print it plainly.
  console.error(err.message ?? err);
  process.exit(1);
}
