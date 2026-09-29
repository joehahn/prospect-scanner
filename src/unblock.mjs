// Stage 5c: a second opinion on every prospect the ranker stopped.
//
// The operator's framing, 2026-09-22: "the main goal of this project is to
// automate the using of heads." His claim is that nearly every blocked prospect
// still has a sendable note, and that it becomes evident after reading the
// Why-now and What-we-know sections and thinking about them. The day that was
// said, three blocked prospects turned out to be sendable and a fourth turned
// out to be a bug.
//
// So this stage asks, for one blocked person at a time: was the rule right?
// Three answers, never two — see prompts/unblock.md and the `unblocks` table for
// why `system_defect` has to be one of them.
//
// NOTHING HERE SENDS OR DRAFTS. It records a verdict and, where there is one, a
// premise a note could open from. The operator still writes and sends.
//
// Usage:
//   npm run unblock -- [--tag "no offer"] [--limit N] [--person <id>]
//                      [--source conference|pasted|leadership]  where they came from
//                      [--model <id>] [--jobs 4] [--dry] [--redo]

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete } from './models.mjs';
import { blockTag } from './rank.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/unblock.md';
const RETRACTION_PROMPT = 'prompts/rejudge-retraction.md';
const RECHECK_PROMPT = 'prompts/recheck-trigger.md';

// A SECOND QUESTION THIS STAGE CAN ASK. Added 2026-09-23 after a hand sample of
// ten retracted signals found six retractions wrong — a re-judging pass had
// left 57 firms with no live signal at all, which is the single commonest
// reason a prospect reads "no evidence names any work here". Ten is not a
// measurement, so this asks the same question of all of them and records a
// verdict per signal with its reasoning.
const RETRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'why', 'should_be'],
  properties: {
    verdict: { type: 'string',
      enum: ['retraction_right', 'retraction_wrong', 'wrong_trigger', 'filed_right'] },
    why: { type: 'string', description: 'One sentence, quoting what decides it.' },
    should_be: { type: 'string',
      description: 'verdict=wrong_trigger only: the trigger id it belongs to, from the list given. Else "".' },
  },
};

// NOT APPEALABLE, enforced here rather than in the prompt. The prompt says the
// same thing, and a prompt is guidance where this is a control: these blocks are
// facts about the world — a person who left, a firm whose product is the
// capability — and no amount of reasoning about a prospect changes them. Costing
// a model call to be told so is waste; letting a model overturn one is worse.
const NEVER_APPEAL = new Set(['seat vacated', 'product remit']);
const NEVER_APPEAL_PREFIX = ['cooling'];

// Every claim needs a source, so an angle needs evidence ids that exist. The
// model is told this and the code enforces it, because the sourcing rule is a guardrail
// and an instruction in a prompt file is not one. An angle citing nothing is
// recorded as `angle_rejected` rather than quietly downgraded to `stands`: the
// difference matters to the agree rate, which is the number that says whether
// this stage is calibrated or just agreeable.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // ALL REQUIRED, NO NULL UNIONS. An optional property doubles the branch count
  // the constrained decoder has to carry and twelve of them once returned a 400
  // on this codebase. Empty string and empty array are the "not applicable"
  // values, and blank() below turns them back into nulls on the way in.
  required: ['verdict', 'why', 'premise', 'basis', 'package_id', 'rule_asked', 'evidence_says'],
  properties: {
    verdict: { type: 'string', enum: ['stands', 'angle', 'system_defect'] },
    why: { type: 'string', description: 'One sentence. Your reasoning, not the blocker quoted back.' },
    premise: { type: 'string', description: 'verdict=angle only: the note\'s opening claim. Else "".' },
    basis: {
      type: 'array',
      items: { type: 'string' },
      description: 'verdict=angle only: evidence ids from the list given. Else [].',
    },
    package_id: { type: 'string', description: 'verdict=angle only: a live package id. Else "".' },
    rule_asked: { type: 'string', description: 'verdict=system_defect only: what the rule tested. Else "".' },
    evidence_says: { type: 'string', description: 'verdict=system_defect only: what the record shows. Else "".' },
  },
};

const blank = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

/** The best-scoring row per person, which is the row the report is about. */
// WHERE A PERSON CAME FROM IS A SELECTOR WORTH HAVING. The conference channel
// produced 93 people and this stage had judged none of them -- every prospect it
// had ever seen came off a leadership page, where the only facts are a name and
// a title. A conference speaker carries a dated session and, in 78 of 94 cases,
// a published abstract, which is the best raw material this stage will get.
const SOURCE_SQL = {
  conference: "EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = ps.person_id "
    + "AND e.claim LIKE '% spoke at %')",
  pasted: "EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = ps.person_id "
    + "AND e.provenance = 'operator_supplied' AND e.body IS NOT NULL)",
  leadership: "EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = ps.person_id "
    + "AND e.kind = 'staff_listing') AND NOT EXISTS (SELECT 1 FROM evidence e2 "
    + "WHERE e2.person_id = ps.person_id AND e2.claim LIKE '% spoke at %')",
};

function blockedRows(db, { tag = null, personId = null, redo = false, source = null }) {
  if (source && !SOURCE_SQL[source]) {
    throw new Error(`--source must be one of: ${Object.keys(SOURCE_SQL).join(', ')}`);
  }
  const rows = db.prepare(`
    SELECT ps.*, p.name, p.title, p.degree, p.capability_authority, p.buyer_remit,
           p.decision_role, o.name AS org_name, o.headcount_est, o.kind AS org_kind,
           o.domain
      FROM person_scores ps
      JOIN people p ON p.id = ps.person_id
      JOIN orgs   o ON o.id = ps.org_id
     WHERE ps.blockers IS NOT NULL AND TRIM(ps.blockers) <> ''
       ${source ? `AND ${SOURCE_SQL[source]}` : ''}
  `).all();

  const best = new Map();
  for (const r of rows) {
    const prev = best.get(r.person_id);
    if (!prev || (r.total ?? 0) > (prev.total ?? 0)) best.set(r.person_id, r);
  }

  const already = redo ? new Set()
    : new Set(db.prepare('SELECT person_id FROM unblocks').all().map((r) => r.person_id));

  const hasAbstract = new Set(db.prepare(
    "SELECT DISTINCT person_id FROM evidence WHERE person_id IS NOT NULL"
    + " AND claim LIKE '% spoke at %' AND body IS NOT NULL"
    + " AND body NOT LIKE '%no abstract published%'").all().map((r) => r.person_id));

  return [...best.values()]
    .map((r) => ({ ...r, tag: blockTag(r) }))
    .filter((r) => r.tag && !already.has(r.person_id))
    .filter((r) => !NEVER_APPEAL.has(r.tag))
    .filter((r) => !NEVER_APPEAL_PREFIX.some((p) => r.tag.startsWith(p)))
    // PASTE PROFILE is not a block, it is an absence. The answer to it is to
    // read a profile, which is the operator's hand and not a model's.
    //
    // UNLESS THE PERSON ALREADY CAME WITH SOMETHING TO READ, added 2026-09-23.
    // That rule was written when the only alternative to a profile was a name
    // on a leadership page, where "no profile" really does mean nothing on
    // file. A conference speaker is the case it did not anticipate: 71 of them
    // are blocked PASTE PROFILE and 58 have a PUBLISHED SESSION ABSTRACT -- a
    // dated, sourced statement of what they said they would talk about, which
    // is better material than most pasted profiles and is already in the
    // database. Refusing to read it because a different document is missing is
    // the absence rule misfiring.
    //
    // Still narrow: an abstract, not merely a speaker record. The 13 whose
    // session published no abstract stay excluded, because for them the block
    // means what it always meant.
    .filter((r) => r.tag !== 'PASTE PROFILE' || hasAbstract.has(r.person_id))
    .filter((r) => (tag ? r.tag === tag : true))
    .filter((r) => (personId ? r.person_id === personId : true))
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
}

/** Why now, What we know, and the live offer menu — the dossier, as text. */
function contextFor(db, row, cfg, today) {
  const signals = db.prepare(`
    SELECT s.trigger_id, s.detected_at, s.decays_at, e.claim, e.source_url
      FROM signals s LEFT JOIN evidence e ON e.id = s.evidence_id
     WHERE s.org_id = ? AND s.retracted_at IS NULL
       AND (s.decays_at IS NULL OR s.decays_at > ?)
     ORDER BY s.detected_at DESC`).all(row.org_id, today);

  const evidence = db.prepare(`
    SELECT id, kind, claim, source_url, provenance, person_id, body
      FROM evidence
     WHERE org_id = ? AND (person_id IS NULL OR person_id = ?)
     ORDER BY (person_id IS NULL), id`).all(row.org_id, row.person_id);

  // THE LABEL HAS TO BE HERE OR THE STAGE INVENTS MISSING PACKAGES. A blocker
  // names the offer by its LABEL -- '"Project Work" is sold to VP Delivery...'
  // -- while this list named it by its id. Shown both halves of the
  // same package under different names, the first run reported a system_defect
  // saying "there is no 'Project Work' package on file, so the rule is
  // comparing this seat against a retired or renamed offer". The rule was fine.
  // A stage whose whole job is to catch defects must not manufacture one out of
  // a naming mismatch in what it was handed.
  const packages = (cfg.packages ?? [])
    .filter((x) => (x.status ?? 'live') === 'live')
    .map((x) => `  ${x.id}${x.label && x.label !== x.name ? ` (blockers call this "${x.label}")` : ''}`
      + ` — ${x.name ?? ''}${x.price_usd ? ` ($${x.price_usd})` : ''}`);

  const lines = [];
  lines.push(`## The person`);
  lines.push(`${row.name} — ${row.title ?? '(no title on file)'}`);
  lines.push(`Firm: ${row.org_name}${row.headcount_est ? `, ${row.headcount_est} people` : ', headcount unknown'}` +
    `${row.org_kind ? `, kind=${row.org_kind}` : ''}`);
  if (row.capability_authority) lines.push(`Judged authority over this spend: ${row.capability_authority}`);
  if (row.buyer_remit) lines.push(`Remit: ${row.buyer_remit}`);
  if (row.decision_role) lines.push(`Decision role, as extracted: ${row.decision_role}`);
  lines.push(`Thesis this row scored under: ${row.vertical_id ?? '(none)'}`);

  lines.push(`\n## The blocker that fired — tagged "${row.tag}"`);
  lines.push(String(row.blockers).trim());
  if (row.cons) lines.push(`\nOther reservations the ranker recorded:\n${String(row.cons).trim()}`);

  lines.push(`\n## Why now`);
  lines.push(signals.length
    ? signals.map((s) => `- ${s.trigger_id} (${s.detected_at ?? 'undated'})` +
        `${s.claim ? `: ${s.claim}` : ''}${s.source_url ? ` [${s.source_url}]` : ''}`).join('\n')
    : '- No live trigger on this firm. There is no dated event saying anything is in motion.');

  lines.push(`\n## What we know — cite these ids and no others`);
  // THE CLAIM WAS ALL THAT REACHED THE MODEL, and for a conference speaker the
  // claim is a one-line summary of a record whose substance is the SESSION
  // ABSTRACT sitting in `body`. That is the whole reason this cohort is better
  // material than a leadership-page name: not that someone spoke, but what they
  // said they would speak about. Judging them on the summary threw it away.
  //
  // Bodies run to thousands of characters, so only the ones with something to
  // read are expanded and each is capped. A staff listing or a firm fact has
  // nothing in its body worth the tokens.
  const BODY_KINDS = new Set(['profile_fact', 'operator_profile', 'operator_note',
    'operator_article', 'employer_change', 'news_event']);
  lines.push(evidence.length
    ? evidence.map((e) => {
      const head = `- [id ${e.id}] (${e.kind}${e.person_id ? ', about this person' : ', about the firm'}`
        + `${e.provenance === 'operator_supplied' ? ', supplied by the operator' : ''}) ${e.claim}`
        + `${e.source_url && e.source_url !== 'FIRST_HAND' ? `  <${e.source_url}>` : ''}`;
      const body = BODY_KINDS.has(e.kind) && e.body && String(e.body).trim().length > 80
        ? String(e.body).trim().slice(0, 2500)
        : null;
      return body ? `${head}\n${body.split('\n').map((l) => `    ${l}`).join('\n')}` : head;
    }).join('\n')
    : '- Nothing on file. With no evidence there can be no angle: return stands.');

  lines.push(`\n## Live packages`);
  lines.push(packages.length ? packages.join('\n') : '  (none live)');

  return lines.join('\n');
}

async function judge(db, runId, row, cfg, prompt, model, today) {
  const res = await complete(db, runId, {
    model,
    system: prompt,
    messages: [{ role: 'user', content: contextFor(db, row, cfg, today) }],
    schema: SCHEMA,
    // 8000, not 4000. With adaptive thinking on, max_tokens covers the thinking
    // AND the answer, and one call in the first run of 35 burned 4,000 tokens
    // reasoning and returned nothing — a billed call that looks like the model
    // had no opinion.
    maxTokens: 8000,
  });
  const d = res.data ?? {};
  let verdict = d.verdict;
  const basis = (d.basis ?? []).map(String).filter(Boolean);

  // THE CONTROL. An angle has to rest on evidence that exists, for this firm,
  // by id. Anything else is the model reasoning from the sector, which is the
  // defect the design exists to stop and which reads exactly like a finding.
  if (verdict === 'angle') {
    const valid = new Set(db.prepare(
      'SELECT id FROM evidence WHERE org_id = ?').all(row.org_id).map((r) => String(r.id)));
    const cited = basis.filter((b) => valid.has(b));
    if (!cited.length) verdict = 'angle_rejected';
  }

  return { ...d, verdict, basis, cost_usd: res.cost_usd, model: res.model };
}

function triggerBook(cfg) {
  return (cfg.triggers ?? []).map((t) =>
    `  ${t.id}  [kind: ${t.kind ?? '?'}]  ${t.description ?? ''}` +
    (t.not?.length ? `\n      NOT: ${t.not.map((n) => String(n).slice(0, 180)).join(' | ')}` : ''))
    .join('\n');
}

async function reviewRetractions(db, cfg, args, model) {
  const today = new Date().toISOString().slice(0, 10);
  const promptFile = args.misfiled ? RECHECK_PROMPT : RETRACTION_PROMPT;
  const prompt = readFileSync(resolve(ROOT, promptFile), 'utf8');
  const done = args.redo ? new Set()
    : new Set(db.prepare('SELECT signal_id FROM signal_reviews').all().map((r) => r.signal_id));
  // TWO SIGNAL SETS, ONE REVIEWER. `--retractions` audits what the re-judging
  // pass threw away. `--misfiled` audits what it kept: live URGENCY signals at
  // firms that have no work signal at all, which is the state that makes every
  // person there read "no evidence names any work here". Same machinery, its
  // own prompt, because the question asked is different — one is "was the
  // retraction right", the other is "is this label right".
  const misfiled = Boolean(args.misfiled);
  const URGENCY = ['capital_event', 'contract_award_won', 'published_ai_cost_concern',
                   'crossed_ten_billion_assets'];
  const rows = (misfiled
    ? db.prepare(`
      SELECT s.id, s.org_id, s.trigger_id, s.detected_at,
             'LIVE SIGNAL RECHECK — this signal was never retracted' AS retracted_reason,
             o.name AS org_name, o.kind AS org_kind,
             e.claim, e.source_url, e.kind AS evidence_kind
        FROM signals s JOIN orgs o ON o.id = s.org_id
        LEFT JOIN evidence e ON e.id = s.evidence_id
       WHERE s.retracted_at IS NULL
         AND (s.decays_at IS NULL OR s.decays_at > date('now'))
         AND s.trigger_id IN (${URGENCY.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM signals x WHERE x.org_id = s.org_id
                           AND x.retracted_at IS NULL
                           AND (x.decays_at IS NULL OR x.decays_at > date('now'))
                           AND x.trigger_id NOT IN (${URGENCY.map(() => '?').join(',')}))
       ORDER BY s.id`).all(...URGENCY, ...URGENCY)
    : db.prepare(`
      SELECT s.id, s.org_id, s.trigger_id, s.detected_at, s.retracted_reason,
             o.name AS org_name, o.kind AS org_kind,
             e.claim, e.source_url, e.kind AS evidence_kind
        FROM signals s JOIN orgs o ON o.id = s.org_id
        LEFT JOIN evidence e ON e.id = s.evidence_id
       WHERE s.retracted_at IS NOT NULL AND s.retracted_reason LIKE 're-judged%'
       ORDER BY s.id`).all()
  ).filter((r) => !done.has(r.id));

  const limit = Number(args.limit ?? 0) || rows.length;
  const work = rows.slice(0, limit);
  console.log(heading(`${misfiled ? 'MISFILED?' : 'RETRACTIONS'} — ${work.length} of ` +
    `${rows.length} to review, model ${model}`));
  if (!work.length) { console.log('Nothing to review.'); return; }
  if (args.dry) {
    for (const r of work) console.log(`  ${r.trigger_id.padEnd(32)} ${r.org_name}`);
    console.log(dim('\n--dry: nothing called, nothing spent.'));
    return;
  }

  const runId = startRun(db, 'unblock', { model, notes: `retractions n=${work.length}` });
  const book = triggerBook(cfg);
  const ins = db.prepare(`INSERT INTO signal_reviews
    (signal_id, org_id, trigger_id, retracted_reason, verdict, why, should_be,
     model, prompt_file, cost_usd, decided_at, run_id)
    VALUES (@signal_id, @org_id, @trigger_id, @retracted_reason, @verdict, @why, @should_be,
            @model, @prompt_file, @cost_usd, @decided_at, @run_id)`);

  const tally = {}; let spent = 0; let cursor = 0;
  const jobs = Math.min(Math.max(Number(args.jobs ?? 6) || 6, 1), 8);
  const worker = async () => {
    while (cursor < work.length) {
      const r = work[cursor++];
      const body = [
        misfiled ? `## The signal to re-check` : `## The signal that was retracted`,
        `Firm: ${r.org_name}${r.org_kind ? ` (kind: ${r.org_kind})` : ''}`,
        `Trigger it fired: ${r.trigger_id}`,
        `Date on the signal: ${r.detected_at?.trim() || '(none — the evidence carried no date)'}`,
        `\n## The evidence it was built from`,
        r.claim ? `[${r.evidence_kind}] ${r.claim}` : '(no evidence row attached to this signal)',
        r.source_url ? `Source: ${r.source_url}` : 'Source: (none on file)',
        misfiled ? `\n## Status` : `\n## Why it was retracted, verbatim`,
        r.retracted_reason ?? '(none recorded)',
        `\n## Every trigger defined in this project`,
        book,
      ].join('\n');
      let d;
      try {
        const res = await complete(db, runId, { model, system: prompt,
          messages: [{ role: 'user', content: body }], schema: RETRACTION_SCHEMA, maxTokens: 6000 });
        d = { ...(res.data ?? {}), cost_usd: res.cost_usd, model: res.model };
      } catch (err) { console.error(`  ${bold('ERROR')} ${r.org_name}: ${err.message}`); continue; }
      // filed_right is the recheck mode's name for "nothing to change", and it
      // lands in the same column as retraction_right because the table's CHECK
      // predates this mode. The retracted_reason column records which question
      // was asked, so the two can be told apart later.
      if (d.verdict === 'filed_right') d.verdict = 'retraction_right';
      tally[d.verdict] = (tally[d.verdict] ?? 0) + 1;
      spent += d.cost_usd ?? 0;
      ins.run({ signal_id: r.id, org_id: r.org_id, trigger_id: r.trigger_id,
        retracted_reason: r.retracted_reason ?? null, verdict: d.verdict, why: blank(d.why),
        should_be: blank(d.should_be), model: d.model, prompt_file: promptFile,
        cost_usd: d.cost_usd ?? 0, decided_at: today, run_id: runId });
      const mark = { retraction_right: '·', retraction_wrong: bold('RESTORE'),
        wrong_trigger: bold('REFILE') }[d.verdict] ?? '?';
      console.log(`  ${mark} ${r.trigger_id} @ ${r.org_name}` +
        (d.should_be ? ` -> ${d.should_be}` : ''));
      console.log(dim(`      ${d.why ?? ''}`));
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  const n = Object.values(tally).reduce((a, b) => a + b, 0) || 1;
  console.log(heading('VERDICTS'));
  for (const [k, v] of Object.entries(tally)) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)}  ${Math.round((v / n) * 100)}%`);
  }
  console.log(dim(`\n  $${spent.toFixed(4)} across ${n} calls`));
  finishRun(db, runId, {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  const cfg = await loadConfig();
  const today = new Date().toISOString().slice(0, 10);
  const model = (args.model && args.model !== true) ? String(args.model)
    : (cfg.runtime?.models?.default ?? 'claude-sonnet-5');
  const prompt = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');

  if (args.retractions || args.misfiled) {
    await reviewRetractions(db, cfg, args, model); db.close(); return;
  }

  const rows = blockedRows(db, {
    tag: (args.tag && args.tag !== true) ? String(args.tag) : null,
    personId: (args.person && args.person !== true) ? String(args.person) : null,
    source: (args.source && args.source !== true) ? String(args.source) : null,
    redo: Boolean(args.redo),
  });
  const limit = Number(args.limit ?? 0) || rows.length;
  const work = rows.slice(0, limit);

  console.log(heading(`UNBLOCK — ${work.length} of ${rows.length} appealable blocks, model ${model}`));
  if (!work.length) {
    console.log('Nothing to appeal. Run `npm run rank` first, or widen --tag.\n' +
      dim('  Blocks that are never appealed: seat vacated, product remit, cooling, PASTE PROFILE.'));
    db.close();
    return;
  }
  if (args.dry) {
    for (const r of work) console.log(`  ${r.tag.padEnd(14)} ${r.name} · ${r.org_name}`);
    console.log(dim(`\n--dry: nothing called, nothing spent.`));
    db.close();
    return;
  }

  const runId = startRun(db, 'unblock', { model, notes: `tag=${args.tag ?? 'all'} n=${work.length}` });
  const ins = db.prepare(`INSERT INTO unblocks
    (person_id, org_id, vertical_id, block_tag, block_text, verdict, why, premise,
     basis, package_id, rule_asked, evidence_says, model, prompt_file, cost_usd,
     decided_at, run_id)
    VALUES (@person_id, @org_id, @vertical_id, @block_tag, @block_text, @verdict, @why,
            @premise, @basis, @package_id, @rule_asked, @evidence_says, @model,
            @prompt_file, @cost_usd, @decided_at, @run_id)`);

  const tally = { stands: 0, angle: 0, system_defect: 0, angle_rejected: 0 };
  const jobs = Math.min(Math.max(Number(args.jobs ?? 4) || 4, 1), 8);
  let cursor = 0;
  let spent = 0;

  const worker = async () => {
    while (cursor < work.length) {
      const row = work[cursor++];
      let d;
      try {
        d = await judge(db, runId, row, cfg, prompt, model, today);
      } catch (err) {
        console.error(`  ${bold('ERROR')} ${row.name}: ${err.message}`);
        continue;
      }
      tally[d.verdict] = (tally[d.verdict] ?? 0) + 1;
      spent += d.cost_usd ?? 0;
      ins.run({
        person_id: row.person_id, org_id: row.org_id, vertical_id: row.vertical_id ?? null,
        block_tag: row.tag, block_text: String(row.blockers).trim(),
        verdict: d.verdict, why: blank(d.why), premise: blank(d.premise),
        basis: d.basis.length ? d.basis.join(',') : null,
        package_id: blank(d.package_id), rule_asked: blank(d.rule_asked),
        evidence_says: blank(d.evidence_says), model: d.model, prompt_file: PROMPT_FILE,
        cost_usd: d.cost_usd ?? 0, decided_at: today, run_id: runId,
      });
      const mark = { stands: '·', angle: bold('ANGLE'), system_defect: bold('DEFECT'),
        angle_rejected: 'rejected' }[d.verdict];
      console.log(`  ${mark} ${row.name} · ${row.org_name} (${row.tag})`);
      if (d.verdict === 'angle') console.log(dim(`      ${d.premise}  [ev ${d.basis.join(', ')}]`));
      if (d.verdict === 'system_defect') console.log(dim(`      rule asked: ${d.rule_asked}\n      record says: ${d.evidence_says}`));
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  const n = Object.values(tally).reduce((a, b) => a + b, 0) || 1;
  console.log(heading('VERDICTS'));
  for (const [k, v] of Object.entries(tally)) {
    console.log(`  ${k.padEnd(16)} ${String(v).padStart(4)}  ${Math.round((v / n) * 100)}%`);
  }
  // THE NUMBER THAT SAYS WHETHER THIS STAGE IS WORTH ANYTHING. A pass that
  // never agrees with a block has not been reasoning, it has been rationalising,
  // and the book it produces is the pre-gate mailing list with better prose.
  console.log(dim(`\n  agree rate ${Math.round((tally.stands / n) * 100)}% — if this is near zero the ` +
    'stage is broken however good the angles read.'));
  console.log(dim(`  $${spent.toFixed(4)} across ${n} calls ($${(spent / n).toFixed(4)} each)`));

  finishRun(db, runId, {});
  db.close();
}

await main();
