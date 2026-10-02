// Stage 5g: work out what the prospect is trying to do, before writing anything.
//
// THE MISSING STEP, found 2026-09-23. Every other stage here is about a firm, a
// seat, or a sentence. `scan` and `glean` gather facts, `gate` kills firms,
// `rank` scores seats, `unblock` finds a premise to open with, `draft` writes
// prose. Nothing was about the person's GOAL.
//
// So the drafter received evidence plus one constraint -- every claim must trace
// to the dossier -- and no task beyond "write a note". Under a constraint with
// no goal the safest possible output is recitation: repeating a fact off
// someone's profile cannot be wrong. That is why draft after draft opened by
// telling a CFO what was on his own LinkedIn, and why the inference that
// replaced it ("I'd guess you don't want to sign off late with no independent
// read") was unfalsifiable rather than useful.
//
// The operator was supplying this reasoning by hand, six revisions at a time, on
// every single note. That is the work this stage does.
//
// AND THE OFFER IS CHOSEN AFTER THE READ, NOT BEFORE IT. The router goes
// evidence -> work -> delivered_by -> filter by seat and size -> package, and
// then the drafter has to justify whatever came out. That is backwards, and it
// is why three drafts in a row refused their assigned pitch. A read names the
// package its own reasoning points at; `draft` can take it or leave it, but it
// is no longer the only thing in the pipeline forming a view of the person.
//
// NOTHING HERE DRAFTS OR SENDS. It writes a thesis the operator can reject in
// one glance, before a note is built on it.
//
// Usage:
//   npm run read -- --person <id> [--redo] [--show]
//   npm run read -- --shortlist [--limit N] [--jobs 4] [--dry]
//   npm run read -- --person <id> --reject "why it is wrong"

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { loadTargeting } from './targeting.mjs';
import { loadBusiness } from './business.mjs';
import { operatorSaidLines } from './operator-said.mjs';
import { boardLines } from './boards.mjs';
import { complete } from './models.mjs';
import { heading, bold, dim } from './report.mjs';
import { retense } from './events.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/read-the-person.md';
// THE OPERATOR'S OWN OFFER-SELECTION CORRECTIONS, accumulated by `voice` and
// appended only when he accepts one. See the note beside RULE_FILES in
// voice.mjs: this stage picks the pitch, and until 2026-09-25 its only input was
// the static prompt above -- so every correction he typed about WHICH OFFER a
// note should make went into the voice file, which only the drafting stage
// reads, by which point the offer is already chosen.
//
// Gitignored and optional. A fresh clone has read-rules.example.md and no rules,
// which is correct: these are one operator's judgments about one operator's
// services, and inheriting a stranger's would be worse than starting empty.
const RULES_FILE = 'prompts/read-rules.md';

function learnedRules() {
  let raw = '';
  try { raw = readFileSync(resolve(ROOT, RULES_FILE), 'utf8'); } catch { return ''; }
  // ONLY THE RULES, not the file's own explanation of what it is. The preamble
  // tells the operator how the file is maintained; handing it to the model is
  // instructions about instructions, and it is the longest part of the file.
  const at = raw.indexOf('\n## Rules');
  // STRIP THE PLACEHOLDER, do not bail on it. The empty-file marker sits at the
  // top of the section and `voice --accept` appends BELOW it, so testing whether
  // the body STARTS with the marker reported "no rules" with two rules in the
  // file -- caught the moment the first two were accepted.
  const body = (at === -1 ? raw : raw.slice(at + '\n## Rules'.length))
    .split('\n').filter((l) => !/^\s*\*\(none\b/.test(l)).join('\n').trim();
  if (!body) return '';
  return `\n\n## Rules the operator has taught this stage\n\n`
    + `These were derived from corrections he typed against real drafts and he\n`
    + `accepted each one. They outrank your own instinct about which offer fits.\n\n`
    + body.slice(0, 6000);
}

// Every property required, no null unions: the strict-schema rule this project
// keeps. "" is the empty answer.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trying_to_do', 'in_the_way', 'next_step', 'what_an_hour_does', 'do_not_say',
    'confidence', 'suggests_package', 'basis', 'recipient', 'better_recipient'],
  properties: {
    trying_to_do: { type: 'string', description: 'What they are working toward that is not finished.' },
    in_the_way: { type: 'string', description: 'The specific obstacle in their terms. "" if nothing is visible.' },
    next_step: { type: 'string', description: 'The step that follows from what they are already doing, in one clause, plus the capability that delivers it. This is what the note is built on.' },
    what_an_hour_does: { type: 'string', description: 'What senior outside attention changes for THIS person.' },
    do_not_say: { type: 'string', description: 'What a competent stranger would get wrong here.' },
    confidence: { type: 'string', enum: ['strong', 'thin'] },
    suggests_package: { type: 'string', description: 'The package id the read points at, from the list given. "" if none fits.' },
    basis: { type: 'string', description: 'Comma-separated evidence ids the read leans on.' },
    recipient: { type: 'string', enum: ['this_person', 'someone_else', 'nobody'],
      description: 'Is this the person the note should go to? See question 6.' },
    better_recipient: { type: 'string',
      description: '"Name — Title" of the person the evidence names as owning this, when recipient is someone_else. "" otherwise.' },
  },
};

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
const str = (v) => (v && v !== true ? String(v) : null);

// A REJECTION THAT NEVER REACHES THE MODEL IS NOT A CORRECTION. Found
// 2026-09-23, by rejecting the same read three times and getting the same
// abstraction back. `--reject` wrote the reason into the table and `--redo`
// rebuilt the context from evidence alone, so every re-read started from
// scratch, argued with nothing, and reproduced the thing that had just been
// rejected. The operator's whole stated goal for this stage is "greater usage
// of one's head so i dont have to intervene on every single draft", and a
// correction loop that discards the correction is the opposite of that.
function priorRejections(db, personId) {
  const rows = db.prepare(`SELECT rejected_reason, trying_to_do, what_an_hour_does
      FROM reads WHERE person_id = ? AND rejected_at IS NOT NULL
     ORDER BY id DESC LIMIT 3`).all(personId);
  if (!rows.length) return '';
  return `\n## READS OF THIS PERSON THAT WERE REJECTED, AND WHY\n\n`
    + `The operator read each of these and said it was wrong. They are the most\n`
    + `important thing in this brief: do not reproduce them, and do what the\n`
    + `rejection asks for. Where a rejection names specific things to say, say\n`
    + `those things — it is the operator telling you what he knows about his own\n`
    + `market, not a suggestion to paraphrase.\n\n`
    + rows.map((r, i) => `### Rejected read ${i + 1}\n`
      + `  it said they were trying to: ${String(r.trying_to_do ?? '').slice(0, 300)}\n`
      + `  it said an hour would: ${String(r.what_an_hour_does ?? '').slice(0, 300)}\n`
      + `  REJECTED BECAUSE: ${r.rejected_reason}`).join('\n\n');
}

// THE ARGUMENT THE FIRM WAS SELECTED UNDER, which the read has never seen.
//
// Found 2026-09-24. A city put an agentic-AI platform out to RFP. The read went
// hunting for unrelated internal use cases and produced guesswork the operator
// called "probably not top of mind" -- while config/sectors.yml already carried
// the argument, written two days earlier: "AN RFP IS A NEED, NOT A CLOSED DOOR
// ... A published solicitation says the need is real, funded and admitted in
// public. It also says the delivery will take months, because that is what the
// process is for. Hourly on-demand work under the purchasing threshold is the
// fast alternative, and the operator has availability now."
//
// Every thesis in that file carries reasoning of this kind -- why this shape of
// firm is worth an hour, and what the angle is -- and the stage forming the
// thesis about the person was working without it. Same shape as every other bug
// here: the judgment was written down and nothing read it.
// THE OPERATOR'S TARGETS, from config/business.yml (2026-09-26). The read used
// to be given the one thesis its firm was filed under; the targets that replace
// the theses are few and in plain prose, so it is given all of them and works
// out which this person fits, the same view the judge has. Without a
// business.yml the loader builds targets from the old theses, and this is
// what it returns.
let BUSINESS = null;
function thesisFor(targeting, verticalId) {
  if (BUSINESS?.targets?.length) {
    return `\n## The kinds of client the operator looks for\n\n`
      + `The operator's own descriptions, with examples of people they chose to write to.\n`
      + `Work out which one this person fits, if any, and argue from it.\n\n`
      + BUSINESS.targets.map((t) => `- ${t.name}: ${t.description}`
        + (t.examples?.length ? `\n    e.g. ${t.examples.slice(0, 3).join('; ')}` : '')).join('\n').slice(0, 6000);
  }
  const v = targeting?.verticals?.find((x) => x.id === verticalId);
  if (!v) return '';
  const bits = [v.thesis, v.money?.why_they_can_pay, v.notes]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);
  if (!bits.length) return '';
  return `\n## Why this KIND of firm is a prospect at all\n\n`
    + `This is the operator's own argument for the sector, and it usually names the\n`
    + `angle. Where it does, use it rather than inventing one.\n\n`
    + bits.join('\n\n').slice(0, 4000);
}

function contextFor(db, person) {
  const ev = db.prepare(`
    SELECT id, kind, claim, source_url, provenance, body
      FROM evidence WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL))
     ORDER BY provenance DESC, id DESC`).all(person.id, person.org_id);
  // ^ Never a colleague's evidence: see buildDossier in draft.mjs.
  const sig = db.prepare(`
    SELECT s.trigger_id, s.detected_at, e.claim
      FROM signals s LEFT JOIN evidence e ON e.id = s.evidence_id
     WHERE s.org_id = ? AND s.retracted_at IS NULL`).all(person.org_id);
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(person.org_id) ?? {};

  // THE FULL BODY, NOT THE ONE-LINE CLAIM. The claim is a summary; the substance
  // -- a session abstract, a pasted profile -- is in the body, and a thesis built
  // on summaries is how you get a thesis that could apply to anyone.
  const fmt = (e) => `- [id ${e.id}] (${e.kind}${e.provenance === 'operator_supplied' ? ', operator-supplied' : ''}) `
    + `${retense(e.claim)}${e.source_url ? `  <${e.source_url}>` : ''}`
    + (e.body && String(e.body).trim().length > 80
      ? `\n${retense(String(e.body).trim()).slice(0, 3000).split('\n').map((l) => `    ${l}`).join('\n')}` : '');

  return [
    `## The person`,
    `${person.name} — ${person.title ?? '(no title)'}`,
    `${org.name ?? person.org_id}${org.headcount_est ? `, about ${org.headcount_est} people` : ''}`
      + `${org.kind ? ` (${org.kind})` : ''}`,
    person.degree ? `LinkedIn degree: ${person.degree}` : '',
    person.in_seat_since ? `In seat since: ${person.in_seat_since}` : '',
    ``,
    ...(operatorSaidLines(db, person.id)
      ? [`## What the operator said about this person (first-hand; outranks inference)`, operatorSaidLines(db, person.id), ``] : []),
    ...(boardLines(db, person.id)
      ? [`## Boards this person sits on now (each a company they can introduce the operator to)`, boardLines(db, person.id), ``] : []),
    `## Everything on file`,
    ev.length ? ev.map(fmt).join('\n') : '(nothing — say so and return thin)',
    ``,
    `## Dated triggers at the firm`,
    sig.length ? sig.map((s) => `- ${s.trigger_id} (${s.detected_at}): ${s.claim ?? ''}`).join('\n')
      : '(none on record)',
  ].filter((l) => l !== '').join('\n');
}

function show(db, personId) {
  const r = db.prepare('SELECT * FROM reads WHERE person_id = ? ORDER BY id DESC LIMIT 1').get(personId);
  if (!r) { console.log(`No read for "${personId}". Run without --show first.`); return null; }
  const p = db.prepare('SELECT name, title FROM people WHERE id = ?').get(personId) ?? {};
  console.log(heading(`${p.name ?? personId} — ${p.title ?? ''}`));
  if (r.rejected_at) console.log(bold(`  REJECTED ${r.rejected_at}: ${r.rejected_reason}\n`));
  console.log(`  ${bold('trying to do')}   ${r.trying_to_do}`);
  console.log(`  ${bold('next step')}      ${r.next_step || dim('(none named)')}`);
  console.log(`  ${bold('in the way')}     ${r.in_the_way || dim('(nothing visible)')}`);
  console.log(`  ${bold('an hour does')}   ${r.what_an_hour_does}`);
  console.log(`  ${bold('do not say')}     ${r.do_not_say}`);
  console.log(dim(`\n  confidence ${r.confidence} · points at ${r.suggests_package || '(no package)'} `
    + `· evidence ${r.basis || '-'}`));
  if (r.confidence === 'thin') {
    console.log(dim('  A thin read is reasoning from the seat and the sector. Check it before a note leans on it.'));
  }
  return r;
}

async function readOne(db, runId, person, cfg, prompt, model, packages, targeting, rules = '') {
  // THE THESIS THE FIRM WAS SELECTED UNDER. `thesisFor` was written on
  // 2026-09-24 with a long note explaining why this stage needs it, `targeting`
  // was threaded all the way down to here to supply it -- and nothing ever
  // called it. Dead on arrival, which is the exact defect its own comment
  // describes: the judgment was written down and nothing read it.
  //
  // The vertical is the best-scoring one for this person, which is the thesis
  // the rest of the card is written about.
  const vertical = db.prepare(
    'SELECT vertical_id FROM person_scores WHERE person_id = ? ORDER BY total DESC LIMIT 1')
    .get(person.id)?.vertical_id;

  const res = await complete(db, runId, {
    // 8000 WAS ENOUGH UNTIL THE PROMPT GREW. Adding the sector thesis and the
    // accepted offer-selection rules to this stage on 2026-09-25 pushed three of
    // twelve reads in one batch past the ceiling -- one died "while thinking and
    // produced no text", two returned JSON truncated mid-string. Both had already
    // been paid for. The ceiling is shared between adaptive thinking and output,
    // so a longer input costs headroom twice.
    model, maxTokens: 24000, schema: SCHEMA, system: prompt + rules,
    messages: [{ role: 'user', content: `${contextFor(db, person)}\n\n## Live packages\n${packages}`
      + thesisFor(targeting, vertical)
      + priorRejections(db, person.id) }],
  });
  const d = res.data ?? {};

  // THE SAME CONTROL `unblock` AND `glean` KEEP: a read must rest on evidence
  // that exists for this firm, by id. A thesis citing nothing is the model
  // reasoning from the sector, which reads exactly like insight and is not.
  const valid = new Set(db.prepare('SELECT id FROM evidence WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL))')
    .all(person.id, person.org_id).map((r) => String(r.id)));
  const cited = String(d.basis ?? '').split(/[,\s]+/).filter((b) => valid.has(b));
  const confidence = cited.length ? d.confidence : 'thin';

  db.prepare(`INSERT INTO reads (person_id, org_id, trying_to_do, in_the_way, what_an_hour_does,
    do_not_say, confidence, suggests_package, basis, next_step, recipient, better_recipient,
    model, prompt_file, cost_usd, run_id, created_at)
    VALUES (@person, @org, @trying, @way, @hour, @dont, @conf, @pkg, @basis, @step, @recip, @better,
    @model, @pf, @cost, @run, @now)`)
    .run({ person: person.id, org: person.org_id, trying: d.trying_to_do ?? '',
      way: d.in_the_way ?? '', hour: d.what_an_hour_does ?? '', dont: d.do_not_say ?? '',
      step: d.next_step ?? '',
      recip: d.recipient ?? 'this_person', better: d.better_recipient ?? '',
      conf: confidence, pkg: d.suggests_package ?? '', basis: cited.join(','),
      model: res.model ?? model, pf: PROMPT_FILE, cost: res.cost_usd ?? 0, run: runId,
      now: new Date().toISOString() });
  return { ...d, confidence, cost_usd: res.cost_usd ?? 0, downgraded: cited.length === 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  const personId = str(args.person);

  if (args.show && personId) { show(db, personId); db.close(); return; }
  if (args.reject && personId) {
    const r = db.prepare('SELECT id FROM reads WHERE person_id = ? ORDER BY id DESC LIMIT 1').get(personId);
    if (!r) { console.log('No read to reject.'); db.close(); return; }
    db.prepare('UPDATE reads SET rejected_at = ?, rejected_reason = ? WHERE id = ?')
      .run(new Date().toISOString().slice(0, 10), String(args.reject), r.id);
    console.log(`rejected the read for ${personId}. Run again with --redo for a fresh one.`);
    db.close(); return;
  }

  const cfg = await loadConfig();
  const targeting = loadTargeting(cfg);
  const model = str(args.model) ?? cfg.runtime?.models?.default ?? cfg.models?.default;   // from runtime.yml
  const prompt = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');
  const rules = learnedRules();
  BUSINESS = loadBusiness(cfg, targeting);
  // Offers keep their ids (the drafter keys its choice on them) and gain who
  // each is for and its one-line pitch, from the business file where it has them.
  const bizOffer = (name) => BUSINESS.offers.find((o) => o.name === name);
  const packages = (cfg.packages ?? []).filter((x) => (x.status ?? 'live') === 'live')
    .map((x) => {
      const o = bizOffer(x.name);
      return `  ${x.id} — ${x.name ?? ''}${x.price_usd ? ` ($${x.price_usd})` : x.rate_usd_hour ? ` ($${x.rate_usd_hour}/hour)` : ''}`
        + `${(o?.for ?? x.best_for) ? `\n      for: ${o?.for ?? x.best_for}` : ''}${o?.pitch ? `\n      pitch: ${o.pitch}` : ''}`;
    }).join('\n');

  let people;
  if (personId) {
    people = db.prepare('SELECT * FROM people WHERE id = ?').all(personId);
    if (!people.length) { console.log(`no person "${personId}"`); db.close(); return; }
  } else if (args.shortlist) {
    // The shortlist, not the book. A read costs a model call, and 1,700 of them
    // is not a thing to do by accident.
    people = db.prepare(`
      SELECT p.* FROM people p JOIN person_scores s ON s.person_id = p.id
       WHERE s.total >= 0.25
       GROUP BY p.id ORDER BY MAX(s.total) DESC`).all();
  } else {
    console.log('Pass --person <id>, or --shortlist for everyone scoring 25+.');
    db.close(); return;
  }
  if (!args.redo) {
    const done = new Set(db.prepare('SELECT person_id FROM reads WHERE rejected_at IS NULL')
      .all().map((r) => r.person_id));
    people = people.filter((p) => !done.has(p.id));
  }
  const limit = Number(args.limit ?? 0) || people.length;
  people = people.slice(0, limit);

  console.log(heading(`READ — ${people.length} person(s), model ${model}`));
  console.log(rules
    ? dim(`  offer-selection rules in force: ${RULES_FILE}\n`)
    : dim('  no offer-selection rules on file\n'));
  if (!people.length) { console.log('Nothing to read. Pass --redo to re-read.'); db.close(); return; }
  if (args.dry) {
    for (const p of people) console.log(`  ${String(p.name).padEnd(24)} ${p.title ?? ''}`);
    db.close(); return;
  }

  const runId = startRun(db, 'read', { model });
  let spent = 0; let thin = 0;
  const jobs = Math.max(1, Number(args.jobs ?? 4) || 4);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < people.length; i = next++) {
      const p = people[i];
      const d = await readOne(db, runId, p, cfg, prompt, model, packages, targeting, rules);
      spent += d.cost_usd;
      if (d.confidence === 'thin') thin++;
      console.log(`  ${d.confidence === 'strong' ? bold('STRONG') : dim('thin  ')} `
        + `${String(p.name).padEnd(22)} ${dim(String(d.trying_to_do ?? '').slice(0, 74))}`
        + (d.downgraded ? dim('\n         downgraded to thin: cited no evidence id for this firm') : ''));
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  console.log(dim(`\n  ${people.length - thin} strong, ${thin} thin · $${spent.toFixed(4)}`));
  console.log(dim('  Read one before drafting on it:  npm run read -- --person <id> --show'));
  finishRun(db, runId, { cost_usd: spent, n_in: people.length, n_out: people.length - thin });
  db.close();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
