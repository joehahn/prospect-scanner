// Source candidate orgs from public job-board APIs.
// Zero LLM calls, by design — this milestone spends nothing.
//
// Greenhouse, Ashby and Lever all expose a public, unauthenticated postings
// endpoint scoped to one company board token. None offers a global search. So
// the watchlist in config/runtime.yml sources.job_apis.boards is the input, and
// `--discover` grows it by probing token guesses for orgs already in the
// database.
//
// Output is a candidate table in which anything the operator has already
// touched is marked, and the prior outreach and gate history is printed above
// the table rather than buried.
//
// Usage:
//   npm run scan
//   npm run scan -- --discover        probe board tokens for orgs in the db
//   npm run scan -- --all             show suppressed orgs in the main table too
//   npm run scan -- --no-seed         skip reloading data/seed-outreach.json
//   npm run scan -- --days 90         override the posting lookback window

import { openDb, startRun, finishRun, slugify } from './db.mjs';
import { loadConfig, capabilityTitles, triggerWeight } from './config.mjs';
import { loadSeed } from './seed.mjs';
import { SOURCES, candidateTokens } from './sources/index.mjs';
import { UA } from './sources/http.mjs';
import { historyFor, classify, openContacts } from './suppression.mjs';
import { table, heading, bold, dim, truncate } from './report.mjs';

const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const args = { discover: false, all: false, seed: true, days: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--discover') args.discover = true;
    else if (a === '--all') args.all = true;
    else if (a === '--no-seed') args.seed = false;
    else if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  return args;
}

/** Case-insensitive substring match against a keyword list. */
function matches(text, keywords) {
  const hay = ` ${String(text ?? '').toLowerCase()} `;
  return keywords.filter((k) => hay.includes(String(k).toLowerCase()));
}

const daysBetween = (aIso, bMs) => Math.floor((bMs - Date.parse(aIso)) / DAY_MS);

/**
 * Which board tokens to query. Config entries first; --discover then probes
 * name- and domain-derived guesses for orgs already in the database that have
 * no configured board.
 */
/**
 * Who owns this board? Greenhouse states it in the API; Ashby and Lever do not,
 * but both render the company name in their public board page's <title>.
 * One extra request, paid only when a token actually answered.
 */
async function boardOwnerName(ats, token, res) {
  if (res.org_name) return res.org_name;
  const url = ats === 'lever'
    ? `https://jobs.lever.co/${token}`
    : `https://jobs.ashbyhq.com/${token}`;
  try {
    const r = await fetch(url, { redirect: 'follow',
      headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const m = (await r.text()).match(/<title>([^<]{1,200})<\/title>/i);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const NAME_NOISE = new Set(['the', 'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'group', 'holdings', 'plc', 'gmbh', 'sa', 'nv', 'ag',
  'jobs', 'careers', 'board']);

/** Distinctive words of a company name, in order, noise removed. */
function nameWords(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(/\s+/).filter((w) => w && !NAME_NOISE.has(w));
}

/**
 * Does this board belong to this org? Returns the basis, or null to reject.
 *
 * Measured 2026-09-25, the first time --discover ran: of five boards it found,
 * THREE were a different company. Each would have written that company's job
 * postings as a hiring_req trigger on a real prospect, cited to a URL that does
 * not describe them.
 *
 * THE FIRST ATTEMPT AT THIS CHECK FAILED IN BOTH DIRECTIONS, and the reasons
 * are the interesting part:
 *
 *   - It searched the POSTINGS for the firm's name. The normalized posting
 *     carries no description -- only a title, department, team and URL -- so it
 *     was really searching job titles. And the URL contains the very token being
 *     probed, which makes the test confirm whatever it is handed.
 *   - It matched substrings without word boundaries, so "arch" matched
 *     "Research" and a seed-stage AI startup passed as a Lloyd's insurer.
 *   - It required a distinctive word longer than three characters, so an org
 *     called "AGR" produced no words at all and could never be confirmed.
 *
 * So: compare NAME TO NAME, and demand that every distinctive word of the ORG
 * appears in the owner's name. The asymmetry is deliberate. A board called
 * "Acme" against an org called "Acme Insurance International" shares a word and
 * is still not the same company; requiring the org's words to be covered
 * rejects it, while "Contoso" against "Contoso" passes.
 */
function boardBelongsTo(org, ownerName) {
  if (!ownerName) return null;
  const orgW = nameWords(org.name);
  const ownW = nameWords(ownerName);
  if (!orgW.length || !ownW.length) return null;

  if (orgW.join('') === ownW.join('')) return 'confirmed';

  // An acronym is a real match no string comparison finds: an org filed as
  // "NGR" against a board owned by "Northwind Global Risks".
  const initials = (w) => w.map((x) => x[0]).join('');
  if (orgW.length === 1 && orgW[0].length >= 2 && orgW[0].length <= 6
      && ownW.length > 1 && initials(ownW) === orgW[0]) return 'acronym';
  if (ownW.length === 1 && ownW[0].length >= 2 && ownW[0].length <= 6
      && orgW.length > 1 && initials(orgW) === ownW[0]) return 'acronym';

  // Every distinctive word of the ORG must be present as a whole word.
  const own = new Set(ownW);
  if (!orgW.every((w) => own.has(w))) return null;

  // ONE SHARED WORD IS NOT AN IDENTITY when it is the org's whole name. An org
  // that reduces to a single distinctive word matches any company beginning
  // with it, and the two readings are genuinely different things:
  //   "Acme Holdings"     vs "Acme Specialty Insurance"     -- a subsidiary
  //   "Contoso Holdings"  vs "Contoso"                      -- a stranger
  // Nothing in a name tells them apart, so this returns 'partial': recorded and
  // reported, never trusted. The operator settles it by putting the board in
  // config/runtime.yml, which is what the 'config' basis is for.
  return (orgW.length === 1 && ownW.length > 1) ? 'partial' : 'confirmed';
}

async function resolveBoards(db, cfg, { discover }, log) {
  const ja = cfg.sources.job_apis;
  const boards = [];
  const seen = new Set();
  const add = (b) => {
    const key = `${b.ats}/${b.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    boards.push(b);
    return true;
  };

  for (const b of ja.boards) {
    add({ ats: b.ats, token: b.token, org_id: b.org ?? null,
          org_name: b.name ?? null, domain: b.domain ?? null,
          verified_by: 'config', origin: 'config' });
  }

  // Boards a previous --discover run proved out. Cached so the probe is paid
  // for once, not on every scan.
  for (const b of db.prepare(
    `SELECT b.ats, b.token, b.org_id, b.verified_by, o.name AS org_name, o.domain
     FROM org_boards b JOIN orgs o ON o.id = b.org_id
     WHERE b.ats IN (${ja.enabled.map(() => '?').join(',') || "''"})`).all(...ja.enabled)) {
    add({ ...b, origin: 'cached' });
  }

  if (!discover) return boards;

  const remember = db.prepare(`
    INSERT INTO org_boards (ats, token, org_id, discovered_at, verified_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ats, token) DO UPDATE SET org_id = excluded.org_id,
                                          verified_by = excluded.verified_by`);
  const today = new Date().toISOString().slice(0, 10);

  const orgs = db.prepare('SELECT id, name, domain FROM orgs ORDER BY name').all();
  log(`probing ${ja.enabled.length} ATS x ${orgs.length} orgs for board tokens ` +
      `(public endpoints, rate limited, ~1 request/sec)`);

  let probes = 0;
  let found = 0;
  for (const org of orgs) {
    for (const token of candidateTokens(org)) {
      for (const ats of ja.enabled) {
        if (seen.has(`${ats}/${token}`)) continue;
        probes++;
        const res = await SOURCES[ats].fetchBoard(token);
        // Ashby and Lever answer 200 with an empty list for a token that does
        // not exist, so "no postings" has to be read as "no board".
        if (!res.ok || !res.postings.length) { seen.add(`${ats}/${token}`); continue; }

        // WHOSE BOARD IS THIS? A token is a first-come registration on a shared
        // namespace, so answering is not the same as belonging. Greenhouse
        // states a company name; Ashby and Lever state none, so the only
        // evidence there is whether the firm names itself in its own postings.
        const owner = await boardOwnerName(ats, token, res);
        const why = boardBelongsTo(org, owner);
        seen.add(`${ats}/${token}`);
        if (why === 'partial') {
          log(`  ${ats}/${token} MIGHT be ${org.name} — owner is "${owner}", which shares its `
            + 'only distinctive word. Not used. If it is right, add it to '
            + 'config/runtime.yml sources.job_apis.boards.');
          continue;
        }
        if (!why) {
          log(`  ${ats}/${token} answered but is NOT ${org.name}`
            + `${owner ? ` — it is "${owner}"` : ' — owner could not be established'}`);
          continue;
        }
        log(`  found ${ats}/${token} - ${res.postings.length} postings -> ${org.name} [${why}]`);
        found++;
        remember.run(ats, token, org.id, today, why);
        add({ ats, token, org_id: org.id, org_name: org.name, domain: org.domain,
              origin: 'discovered', verified_by: why, prefetched: res });
      }
    }
  }
  log(`  ${probes} probes, ${found} boards found and cached in org_boards`);
  return boards;
}

/** Resolve a board to an orgs row, reusing an existing org where one matches. */
function upsertOrg(db, board, fetched, today) {
  const name = board.org_name ?? fetched.org_name ?? board.token;
  let id = board.org_id;

  if (!id && board.domain) {
    id = db.prepare('SELECT id FROM orgs WHERE domain = ?').get(board.domain)?.id ?? null;
  }
  if (!id) {
    // A scanned board whose slug already exists is the same firm, not a new one.
    const slug = slugify(name);
    id = db.prepare('SELECT id FROM orgs WHERE id = ? OR lower(name) = lower(?)')
      .get(slug, name)?.id ?? slug;
  }

  db.prepare(`
    INSERT INTO orgs (id, name, domain, first_seen, source, seeded)
    VALUES (@id, @name, @domain, @today, @source, 0)
    ON CONFLICT(id) DO UPDATE SET
      domain = COALESCE(orgs.domain, excluded.domain),
      first_seen = MIN(orgs.first_seen, excluded.first_seen)`)
    .run({ id, name, domain: board.domain ?? null, today,
           source: `${board.ats} board "${board.token}"` });
  return id;
}

async function scan() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`usage: npm run scan -- [--discover] [--all] [--no-seed] [--days N] [--limit N]`);
    return;
  }

  const cfg = loadConfig();
  for (const w of cfg._warnings) console.warn(dim(`config warning: ${w}`));

  const db = openDb();
  const runId = startRun(db, 'scan', { notes: process.argv.slice(2).join(' ') || null });
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const retrievedAt = new Date(now).toISOString();

  // The suppression list has to be in the database before anything is called a
  // candidate, so it loads first unless explicitly skipped.
  if (args.seed) loadSeed(db, undefined, { quiet: true });

  const ja = cfg.sources.job_apis;
  const lookbackDays = args.days ?? ja.lookback_days;
  const capTitles = capabilityTitles(cfg);
  const relevantKeywords = [...new Set([...ja.title_keywords, ...capTitles])];

  const log = (s) => console.log(dim(s));
  console.log(heading(`scan · ${cfg.firm.name} · ${today}`));
  console.log(dim(`sources: ${ja.enabled.join(', ') || 'none enabled'} · ` +
    `lookback ${lookbackDays}d · unfilled-req threshold ${ja.stale_req_days}d`));

  const allBoards = await resolveBoards(db, cfg, args, log);
  // AN UNVERIFIED BOARD MAY NOT PRODUCE EVIDENCE. Rows cached before ownership
  // was checked carry verified_by = NULL; they stay in org_boards so a later
  // run can confirm them, and contribute nothing until it does. Same rule the
  // schema already applies to email_guess: a guess is kept and labelled, never
  // promoted by default.
  const unverified = allBoards.filter((b) => !b.verified_by);
  const boards = allBoards.filter((b) => b.verified_by);
  if (unverified.length) {
    console.log(dim(`  ${unverified.length} board(s) held back as unverified — `
      + `ownership never confirmed: ${unverified.map((b) => `${b.ats}/${b.token}`).join(', ')}`));
    console.log(dim('  Re-run with --discover to re-check them, or add the board to '
      + 'config/runtime.yml if you have confirmed it yourself.'));
  }
  if (!boards.length) {
    console.log('\nNo boards to query. Add entries under sources.job_apis.boards in ' +
      'config/runtime.yml, or run `npm run scan -- --discover`.');
    finishRun(db, runId, { n_in: 0, n_out: 0 });
    db.close();
    return;
  }

  const insertEvidence = db.prepare(`
    INSERT INTO evidence (org_id, kind, claim, source_url, retrieved_at)
    VALUES (@org_id, @kind, @claim, @source_url, @retrieved_at)
    ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET retrieved_at = excluded.retrieved_at
    RETURNING id`);
  const insertSignal = db.prepare(`
    INSERT INTO signals (org_id, trigger_id, detected_at, decays_at, weight, evidence_id)
    VALUES (@org_id, @trigger_id, @detected_at, @decays_at, @weight, @evidence_id)
    ON CONFLICT(org_id, trigger_id, evidence_id) DO UPDATE SET
      detected_at = excluded.detected_at, decays_at = excluded.decays_at`);

  const touchBoard = db.prepare(
    'UPDATE org_boards SET last_ok_at = ?, postings_last_seen = ? WHERE ats = ? AND token = ?');

  const results = [];
  const failures = [];
  let postingsSeen = 0;
  let evidenceWritten = 0;

  for (const board of boards) {
    const fetched = board.prefetched ?? await SOURCES[board.ats].fetchBoard(board.token);
    if (!fetched.ok) {
      failures.push({ board: `${board.ats}/${board.token}`,
        why: fetched.skipped ?? (fetched.status === 404 ? 'no such board' :
             fetched.error ?? `HTTP ${fetched.status}`) });
      continue;
    }
    postingsSeen += fetched.postings.length;
    touchBoard.run(retrievedAt, fetched.postings.length, board.ats, board.token);

    // Keep only dated, recent postings whose title names something the operator
    // sells against. An undated posting cannot support a "why now", so it is
    // recorded as an org sighting but never as a signal.
    const hits = [];
    for (const p of fetched.postings) {
      const hitWords = matches(`${p.title} ${p.department ?? ''}`, relevantKeywords);
      if (!hitWords.length) continue;
      const ageDays = p.posted_at ? daysBetween(p.posted_at, now) : null;
      if (ageDays !== null && ageDays > lookbackDays) continue;
      hits.push({ ...p, hitWords, ageDays,
        capability: matches(p.title, capTitles).length > 0,
        leadership: matches(p.title, ja.leadership_keywords).length > 0 });
    }
    if (!hits.length && !board.org_id) continue;   // nothing relevant, nothing known

    const orgId = upsertOrg(db, board, fetched, today);

    const write = db.transaction(() => {
      for (const h of hits) {
        const posted = h.posted_at ? h.posted_at.slice(0, 10) : 'undated';
        const claim =
          `Open req "${h.title}"${h.department ? ` (${h.department})` : ''}` +
          `${h.location ? `, ${h.location}` : ''}, posted ${posted}` +
          `${h.ageDays !== null ? `, ${h.ageDays}d open` : ''}` +
          ` on the ${board.ats} board "${board.token}".`;
        const ev = insertEvidence.get({
          org_id: orgId, kind: 'job_posting', claim, source_url: h.url, retrieved_at: retrievedAt });
        evidenceWritten++;

        // The only trigger a job board can evidence on its own: a leadership req
        // for the capability, still open past the configured threshold.
        if (h.capability && h.leadership && h.ageDays !== null && h.ageDays >= ja.stale_req_days) {
          insertSignal.run({
            org_id: orgId, trigger_id: 'unfilled_leadership_req',
            detected_at: posted,
            decays_at: new Date(Date.parse(h.posted_at) + lookbackDays * DAY_MS)
              .toISOString().slice(0, 10),
            weight: triggerWeight(cfg, 'unfilled_leadership_req'),
            evidence_id: ev.id });
        }
      }
    });
    write();

    results.push({ org_id: orgId, board, hits });
  }

  // ---- report ---------------------------------------------------------------
  // One row per org, not per board: a firm can run two boards — an Ashby one
  // and a Lever one, say — and must not be reported twice.
  const byOrg = new Map();
  for (const r of results) {
    if (!byOrg.has(r.org_id)) byOrg.set(r.org_id, { org_id: r.org_id, boards: [], hits: [] });
    const e = byOrg.get(r.org_id);
    e.boards.push(r.board);
    e.hits.push(...r.hits);
  }

  const orgIds = [...byOrg.keys()];
  const history = historyFor(db, orgIds);
  const rows = [...byOrg.values()].map((r) => {
    const h = history.get(r.org_id);
    const verdict = classify(h, today);
    const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(r.org_id);
    const signals = db.prepare(
      `SELECT DISTINCT s.trigger_id, s.weight FROM signals s
        WHERE s.org_id = ? AND s.retracted_at IS NULL`).all(r.org_id);
    return { ...r, org, verdict, history: h, signals,
      open: openContacts(h, today),
      workHits: r.hits.filter((x) => x.capability),
      oldest: r.hits.reduce((m, x) => (x.ageDays > (m ?? -1) ? x.ageDays : m), null) };
  });

  // Prior history first: no org appears as a candidate before the operator has
  // seen what was already said to it.
  const withHistory = rows.filter((r) => r.verdict.status !== 'NEW');
  if (withHistory.length) {
    console.log(heading('PRIOR HISTORY — these firms are already in play'));
    for (const r of withHistory) {
      console.log(`\n${bold(r.org.name)}  ${dim(`[${r.verdict.status}]`)}`);
      for (const reason of r.verdict.reasons) console.log(`    ${reason}`);
      for (const o of r.history.outreach) {
        console.log(dim(`    sent ${o.sent_at} · ${o.channel} · ${o.person_name ?? '?'}` +
          `${o.person_title ? ` (${truncate(o.person_title, 46)})` : ''} · ` +
          `pitched ${o.service_pitched ?? '?'} · ${o.status ?? 'no status'}` +
          `${o.credit_spent ? ' · InMail credit spent' : ''}`));
      }
      if (r.open.length) {
        console.log(`    still open at this firm: ${r.open.map((p) =>
          `${p.name} (${truncate(p.title, 40)})`).join('; ')}`);
      } else if (r.history.people.length) {
        console.log(dim('    no un-contacted, un-suppressed contact remains here'));
      }
    }
  }

  const shown = args.all ? rows : rows.filter((r) => r.verdict.contactable || r.hits.length);
  // Contactable first, so the operator's eye lands on work they can actually do;
  // everything already touched still appears, marked, below the fold.
  const sorted = shown.sort((a, b) =>
    (Number(b.verdict.contactable) - Number(a.verdict.contactable)) ||
    (b.signals.length - a.signals.length) ||
    (b.workHits.length - a.workHits.length) ||
    (b.hits.length - a.hits.length));
  const limited = args.limit ? sorted.slice(0, args.limit) : sorted;

  console.log(heading(`CANDIDATE ORGS (${limited.length}${
    limited.length < rows.length ? ` of ${rows.length}` : ''})`));

  if (!limited.length) {
    console.log('No org on the watchlist has a relevant, dated posting in the window.');
  } else {
    console.log(table(limited.map((r) => ({
      status: r.verdict.status,
      org: r.org.name,
      board: r.boards.map((b) => `${b.ats}/${b.token}`).join(' '),
      reqs: String(r.hits.length),
      cap: r.workHits.length ? String(r.workHits.length) : '·',
      oldest: r.oldest === null ? '·' : `${r.oldest}d`,
      signal: r.signals.length
        ? r.signals.map((s) => `${s.trigger_id}(+${s.weight})`).join(' ')
        : '·',
      note: r.verdict.status === 'NEW' ? '' : (r.verdict.reasons[0] ?? ''),
    })), [
      { key: 'status', label: 'STATUS', width: 9 },
      { key: 'org', label: 'ORG', width: 30 },
      { key: 'board', label: 'BOARD', width: 26 },
      { key: 'reqs', label: 'REQS', width: 5, align: 'right' },
      { key: 'cap', label: 'CAP', width: 4, align: 'right' },
      { key: 'oldest', label: 'OLDEST', width: 7, align: 'right' },
      { key: 'signal', label: 'TRIGGER', width: 34 },
      { key: 'note', label: 'WHY MARKED', width: 60 },
    ]));
    console.log(dim(
      '\nSTATUS  KILLED = a gate already disqualified this firm · DNC = do-not-contact · ' +
      'CONTACTED = outreach already sent\n        HOLD = time-gated · KNOWN = in the file, ' +
      'never contacted · NEW = surfaced by this scan\nREQS    relevant open postings in window · ' +
      'CAP = postings matching a capability_title from signals.yml gates'));
  }

  // Gate ids the operator has applied by hand that signals.yml does not declare.
  const declared = new Set(cfg.gates.map((g) => g.id));
  const undeclared = db.prepare(
    'SELECT DISTINCT gate_id FROM gate_results WHERE gate_id NOT IN ' +
    `(${cfg.gates.map(() => '?').join(',')})`).all(...declared).map((r) => r.gate_id);
  if (undeclared.length) {
    console.log(dim(`\nGates applied by hand but not declared in config/signals.yml: ` +
      `${undeclared.join(', ')}. The gate stage cannot reproduce these until they are added.`));
  }

  const discovered = boards.filter((b) => b.origin === 'discovered');
  if (discovered.length) {
    console.log(dim(`\n${discovered.length} board(s) discovered this run and cached in org_boards, ` +
      'so the next `npm run scan` picks them up without re-probing. To keep them under version ' +
      'control, paste into sources.job_apis.boards in config/runtime.yml:'));
    for (const b of discovered) {
      console.log(dim(`      - { ats: ${b.ats}, token: ${b.token}, org: ${b.org_id}, ` +
        `name: "${b.org_name}" }`));
    }
  }

  if (failures.length) {
    console.log(dim(`\n${failures.length} board(s) did not answer: ` +
      failures.map((f) => `${f.board} (${f.why})`).join(', ')));
  }

  console.log(dim(`\n${boards.length} boards queried · ${postingsSeen} postings read · ` +
    `${evidenceWritten} sourced evidence rows · $0.00 (no LLM calls in this stage)`));

  finishRun(db, runId, { n_in: postingsSeen, n_out: evidenceWritten, cost_usd: 0 });
  db.close();
}

scan().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
