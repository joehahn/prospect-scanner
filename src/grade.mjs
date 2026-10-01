// Grade drafted outreach notes. SPEC §8, the self-grading layer.
//
// The drafter already checks its own claims before storing a note, with its own
// model, and prints the answer without keeping it. That is a control, not a
// measurement. This stage is the measurement: a DIFFERENT model
// (`models.grader`), a versioned prompt (`prompts/grade-draft.md`), and every
// answer stored in `draft_grades`, so a defect rate can be attributed to the
// drafting model and prompt version that produced it.
//
// Four model-read dimensions and one code check:
//   claims         every fact about the recipient or firm is on file
//   recital        the note does not hand them their own facts back
//   never_claim    nothing on operator.never_claim, literally or paraphrased
//   channel_rules  the operator's own rules, where one note can break them
//   clarity        every reference lands ("those tools" names something)
//   fits_channel   a connect note fits LinkedIn's limit (code)
//
// CLASSIFIERS ARE NONDETERMINISTIC. The same note can pass on one call and fail
// on the next, so one pass is never a measurement. `--repeat N` grades each note
// N times as separate rows, and the report shows how often the passes agree.
//
// EVIDENCE IS TODAY'S, NOT THE DRAFT'S. Evidence rows are upserted and their
// retrieved_at moves on refresh, so the set on file when a note was drafted
// cannot be rebuilt exactly. Grading against the current set is lenient in one
// direction only: a claim backed solely by evidence found AFTER drafting passes.
//
// Usage:
//   npm run grade                          ungraded latest drafts, 10 of them
//   npm run grade -- --limit 40 | --all
//   npm run grade -- --draft <id> | --person <id>
//   npm run grade -- --since <ISO time>    every latest draft written since then (the daily run)
//   npm run grade -- --sent                grade what the operator SENT instead
//   npm run grade -- --repeat 3            three passes per note, for agreement
//   npm run grade -- --report              summary only, no API calls

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig, CONNECT_NOTE_MAX } from './config.mjs';
import { complete, promptBody } from './models.mjs';
import { operatorSaidLines } from './operator-said.mjs';
import { neverClaimHits } from './never-claim.mjs';
import { noteOnly } from './note-text.mjs';
import { table, heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/grade-draft.md';
const DIMENSIONS = ['claims', 'recital', 'never_claim', 'channel_rules', 'clarity'];

const ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['quote', 'rule', 'why'],
    properties: {
      quote: { type: 'string', description: 'The failing words, exactly as in the note.' },
      rule: { type: 'string', description: 'Which rule or never_claim entry it breaks.' },
      why: { type: 'string', description: 'One sentence: what the evidence or the rule says instead.' },
    },
  },
};
const DIM = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'items'],
  properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, items: ITEMS },
};
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: DIMENSIONS,
  properties: Object.fromEntries(DIMENSIONS.map((d) => [d, DIM])),
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument "${argv[i]}"`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const promptVersion = () =>
  (readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8').match(/—\s*(v\d+)/) ?? [])[1] ?? null;

/**
 * The evidence the drafter's own check sees: this person's and the firm's, never a colleague's.
 * A profile the operator pasted is given whole: cut at 2,200 characters, a post
 * 180 lines down was invisible, and a note quoting it was graded "not on file".
 */
function evidenceFor(db, d) {
  return db.prepare(`SELECT id, kind, claim, body FROM evidence
     WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL)) ORDER BY id`).all(d.person_id, d.org_id)
    .map((e) => `- [id ${e.id}] ${e.claim}`
      + (e.body && String(e.body).trim().length > 80
        ? `\n${String(e.body).trim().slice(0, e.kind === 'operator_profile' ? 30000 : 2200).split('\n').map((l) => `    ${l}`).join('\n')}` : ''))
    .join('\n');
}

function pick(db, args, model, version, which) {
  const col = which === 'sent' ? 'sent_text' : 'body';
  if (args.draft && args.draft !== true) {
    return db.prepare(`SELECT * FROM drafts WHERE id = ? AND ${col} IS NOT NULL`).all(Number(args.draft));
  }
  const byPerson = args.person && args.person !== true;
  const since = args.since && args.since !== true ? String(args.since) : null;
  // The latest version per person and channel: earlier versions were rewritten,
  // and grading them measures a note nobody would send.
  const rows = db.prepare(`
    SELECT d.* FROM drafts d
     WHERE d.${col} IS NOT NULL AND TRIM(d.${col}) <> ''
       ${byPerson ? 'AND d.person_id = @person' : ''}
       ${since ? 'AND d.created_at >= @since' : ''}
       AND d.version = (SELECT MAX(version) FROM drafts x
                         WHERE x.person_id IS d.person_id AND x.channel = d.channel)
       AND NOT EXISTS (SELECT 1 FROM draft_grades g WHERE g.draft_id = d.id
                         AND g.grader_model = @model AND g.prompt_version IS @version
                         AND g.graded_text = @which)
     ORDER BY d.created_at DESC`)
    .all({ model, version, which, ...(byPerson ? { person: String(args.person) } : {}), ...(since ? { since } : {}) });
  if (args.all || byPerson || since) return rows;
  return rows.slice(0, Number(args.limit && args.limit !== true ? args.limit : 10));
}

function report(db) {
  const rows = db.prepare(`
    SELECT g.*, d.model AS drafter, d.prompt_file AS draft_prompt, d.channel
      FROM draft_grades g JOIN drafts d ON d.id = g.draft_id`).all();
  console.log(heading(`grade · ${rows.length} pass(es) stored`));
  if (!rows.length) { console.log('Nothing graded yet. Run `npm run grade`.'); return; }

  // One row per grader, drafter and graded text. Counts, not rates: a bucket of
  // six notes does not have a defect rate.
  const groups = new Map();
  for (const r of rows) {
    const k = [r.grader_model, r.prompt_version, r.drafter, r.graded_text].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const fails = (rs, dim) => rs.filter((r) => r[dim] === 0).length;
  console.log(table([...groups.values()].map((rs) => ({
    grader: `${rs[0].grader_model} ${rs[0].prompt_version ?? ''}`.trim(),
    drafter: rs[0].drafter ?? '?',
    text: rs[0].graded_text,
    notes: new Set(rs.map((r) => r.draft_id)).size,
    passes: rs.length,
    clean: rs.filter((r) => r.clean === 1).length,
    claims: fails(rs, 'claims'),
    recital: fails(rs, 'recital'),
    never: fails(rs, 'never_claim'),
    rules: fails(rs, 'channel_rules'),
    clear: fails(rs, 'clarity'),
    length: fails(rs, 'fits_channel'),
  })), [
    { key: 'grader', label: 'GRADER' }, { key: 'drafter', label: 'DRAFTER' },
    { key: 'text', label: 'TEXT' }, { key: 'notes', label: 'NOTES' }, { key: 'passes', label: 'PASSES' },
    { key: 'clean', label: 'CLEAN' }, { key: 'claims', label: 'CLAIMS✘' },
    { key: 'recital', label: 'RECITAL✘' }, { key: 'never', label: 'NEVER✘' },
    { key: 'rules', label: 'RULES✘' }, { key: 'clear', label: 'CLEAR✘' }, { key: 'length', label: 'LENGTH✘' },
  ]));
  console.log(dim('  ✘ columns count failing passes, not notes.'));

  // AGREEMENT. For every note graded more than once by the same grader and
  // prompt, does each dimension get the same verdict on every pass?
  const multi = new Map();
  for (const r of rows) {
    const k = [r.draft_id, r.grader_model, r.prompt_version, r.graded_text].join('|');
    if (!multi.has(k)) multi.set(k, []);
    multi.get(k).push(r);
  }
  const repeated = [...multi.values()].filter((rs) => rs.length > 1);
  if (!repeated.length) {
    console.log(dim('\n  No note graded twice yet, so agreement is unmeasured. `--repeat 3` measures it.'));
    return;
  }
  console.log(`\n${bold('Agreement')} across ${repeated.length} note(s) graded more than once:`);
  for (const dim_ of [...DIMENSIONS, 'clean']) {
    const agree = repeated.filter((rs) => new Set(rs.map((r) => r[dim_])).size === 1).length;
    console.log(`  ${dim_.padEnd(14)} ${agree} of ${repeated.length} unanimous`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  if (args.report) { report(db); db.close(); return; }

  const cfg = loadConfig();
  const model = args.model && args.model !== true ? String(args.model) : cfg.models.grader;
  if (!model) throw new Error('models.grader is not set in config/runtime.yml');
  const which = args.sent ? 'sent' : 'draft';
  const version = promptVersion();
  const repeat = Math.max(1, Number(args.repeat && args.repeat !== true ? args.repeat : 1) || 1);
  const neverClaim = cfg.operator?.never_claim ?? [];
  const seed = JSON.parse(readFileSync(resolve(ROOT, 'data/seed-outreach.json'), 'utf8'));
  const system = promptBody(PROMPT_FILE, {
    never_claim: neverClaim.map((c) => `- ${c}`).join('\n') || '(none declared)',
    channel_rules: (seed.channel_rules ?? []).map((r) => `- ${r}`).join('\n') || '(none declared)',
  });

  const drafts = pick(db, args, model, version, which);
  console.log(heading(`grade · ${drafts.length} note(s) × ${repeat} · ${model} · ${PROMPT_FILE} ${version ?? ''}`));
  if (!drafts.length) {
    console.log('Nothing ungraded. `--draft <id>` regrades one; `--report` shows what is stored.');
    db.close(); return;
  }
  if (model === cfg.models.draft || drafts.some((d) => d.model === model)) {
    console.log(dim(`  note: ${model} also drafted some of these. A model grading its own output ` +
      'is the conflict this stage exists to avoid; read those grades with that in mind.'));
  }

  const runId = startRun(db, 'grade', { model, notes: `${PROMPT_FILE} ${version ?? ''} ${which}` });
  const names = new Map(db.prepare('SELECT id, name FROM people').all().map((p) => [p.id, p.name]));
  const ins = db.prepare(`INSERT INTO draft_grades (draft_id, graded_text, grader_model, prompt_file,
      prompt_version, claims, claims_items, recital, recital_items, never_claim, never_claim_items,
      channel_rules, channel_rules_items, clarity, clarity_items, fits_channel, clean, cost_usd, run_id, graded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let cost = 0;
  let done = 0;
  const gradeOne = async (d) => {
    // The note alone. A stored draft carries the drafter's NOTES to the operator
    // under it; grading those measured a 213-character connect note as 2,403.
    const text = which === 'sent' ? String(d.sent_text).trim() : noteOnly(d.body);
    const said = operatorSaidLines(db, d.person_id);
    const content = `## The note (channel: ${d.channel})\n\n`
      + `${d.subject ? `Subject: ${d.subject}\n\n` : ''}${text}\n\n`
      + `## The evidence on file\n\n${evidenceFor(db, d) || '(none)'}`
      + (said ? `\n\n## What the operator knows first-hand (counts as evidence)\n\n${said}` : '');

    // Code, not model: the literal screen and the length limit.
    const literal = neverClaimHits(text, neverClaim);
    const fits = d.channel === 'linkedin_connect_note' ? (text.length <= CONNECT_NOTE_MAX ? 1 : 0) : 1;

    const passes = await Promise.all(Array.from({ length: repeat }, () => complete(db, runId, {
      model, system, schema: SCHEMA, effort: 'high', maxTokens: 8000,
      messages: [{ role: 'user', content }] })));

    const lines = [];
    for (const res of passes) {
      cost += res.cost_usd ?? 0;
      const g = res.data;
      if (!g) { lines.push(dim(`    no structured answer (${res.stop_reason}); not stored`)); continue; }
      const never = [...g.never_claim.items,
        ...literal.map((h) => ({ quote: h.around, rule: h.entry, why: `names "${h.term}" literally` }))];
      const v = {
        claims: g.claims.verdict === 'pass' ? 1 : 0,
        recital: g.recital.verdict === 'pass' ? 1 : 0,
        never_claim: g.never_claim.verdict === 'pass' && !literal.length ? 1 : 0,
        channel_rules: g.channel_rules.verdict === 'pass' ? 1 : 0,
        clarity: g.clarity.verdict === 'pass' ? 1 : 0,
      };
      const clean = Object.values(v).every(Boolean) && fits ? 1 : 0;
      ins.run(d.id, which, model, PROMPT_FILE, version,
        v.claims, JSON.stringify(g.claims.items), v.recital, JSON.stringify(g.recital.items),
        v.never_claim, JSON.stringify(never), v.channel_rules, JSON.stringify(g.channel_rules.items),
        v.clarity, JSON.stringify(g.clarity.items), fits, clean, res.cost_usd ?? null, runId, new Date().toISOString());
      const mark = (ok) => (ok ? '✔' : '✘');
      lines.push(`    ${clean ? '✔ clean' : '✘'}  claims ${mark(v.claims)} recital ${mark(v.recital)} ` +
        `never ${mark(v.never_claim)} rules ${mark(v.channel_rules)} clear ${mark(v.clarity)} length ${mark(fits)}`);
      for (const [dimName, items] of [['claims', g.claims.items], ['recital', g.recital.items],
        ['never', never], ['rules', g.channel_rules.items], ['clarity', g.clarity.items]]) {
        for (const it of items) lines.push(dim(`      ${dimName}: "${it.quote}" — ${it.why}`));
      }
    }
    done += 1;
    console.log(`\n${bold(names.get(d.person_id) ?? d.person_id ?? '?')} ${dim(
      `draft #${d.id} v${d.version} · ${d.channel} · drafted by ${d.model ?? '?'}`)}  ${dim(`[${done}/${drafts.length}]`)}`);
    console.log(lines.join('\n'));
  };

  // Four notes in flight; each note's repeats already run side by side.
  let cursor = 0;
  const worker = async () => { for (let i = cursor++; i < drafts.length; i = cursor++) await gradeOne(drafts[i]); };
  await Promise.all(Array.from({ length: Math.min(4, drafts.length) }, worker));

  finishRun(db, runId, { cost_usd: cost, n_in: drafts.length });
  console.log(dim(`\n$${cost.toFixed(3)} · ${drafts.length} note(s) × ${repeat} pass(es)`));
  console.log('');
  report(db);
  db.close();
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
