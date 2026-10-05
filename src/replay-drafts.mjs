// Replay sent notes through the example arms, to test the picked arm without
// waiting weeks for live sends.
//
// For each of the last N notes the operator sent, the same person, channel and
// offer are drafted again twice, today, with the same dossier: once from the
// fixed voice.md set, once from examples picked for the recipient. The picked
// pool is cut at the replayed draft, so no later note can hand the answer back.
// Each new draft is scored by how much of it differs from what he actually
// sent (src/voice-examples.mjs `changed`); lower is closer.
//
// A PROXY, AND A BIASED ONE. What he sent was edited from the original draft, so
// it carries that draft's structure; both replays are equally far from it, so
// the comparison between the arms is fair even though neither can match the
// original's score. The dossier today also differs from the dossier then.
//
// Every call is costed in `runs`. Nothing is stored in `drafts`: no card, no
// Scoreboard count. Results go to data/replays/<date>.json.
//
// Usage:
//   npm run replay -- [--limit 10] [--jobs 4] [--arms fixed,picked,edits,recent]
//                     [--reuse data/replays/<file>.json]   keep arms drafted earlier
//
// Then a blind judge (models.grader, prompts/judge-replay.md) compares each
// pair of arms against the sent note, in both orders; a split is a tie.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete } from './models.mjs';
import { changed } from './voice-examples.mjs';
import { heading, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

async function draftOnce(x, arm) {
  const argv = ['--env-file-if-exists=.env', 'src/draft.mjs', '--person', x.person_id, '--channel', x.channel, '--examples', arm,
    '--no-store', '--no-dash', '--force', '--pool-before', String(x.id)];
  // --force: this person was written to, which is the point; nothing is stored.
  if (x.package_id) argv.push('--service', x.package_id);
  const { stdout } = await run('node', argv, { cwd: ROOT, maxBuffer: 1 << 24, timeout: 15 * 60_000 });
  const line = stdout.split('\n').find((l) => l.startsWith('REPLAY '));
  if (!line) throw new Error('no REPLAY line');
  return JSON.parse(line.slice(7));
}

const JUDGE_PROMPT = 'prompts/judge-replay.md';
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['closer', 'why'],
  properties: {
    closer: { type: 'string', enum: ['A', 'B', 'tie'] },
    why: { type: 'string', description: 'One sentence: what makes it closer.' },
  },
};

/**
 * Is arm `p` or arm `q` closer to what was sent? Asked twice, once in each
 * order, because a judge favours a position most when the two are close. A
 * split is a tie. Returns 1 (p), -1 (q) or 0.
 */
async function judgePair(db, runId, model, system, sent, p, q) {
  const ask = async (first, second) => {
    const r = await complete(db, runId, { model, system, schema: JUDGE_SCHEMA, thinking: false,
      effort: 'low', maxTokens: 800, messages: [{ role: 'user', content:
        `## The note he sent\n\n${sent}\n\n## Draft A\n\n${first}\n\n## Draft B\n\n${second}` }] });
    return r.data?.closer ?? 'tie';
  };
  const [one, two] = await Promise.all([ask(p.body, q.body), ask(q.body, p.body)]);
  const v1 = one === 'A' ? 1 : one === 'B' ? -1 : 0;
  const v2 = two === 'B' ? 1 : two === 'A' ? -1 : 0;
  return v1 === v2 ? v1 : 0;
}

async function main() {
  const limit = arg('limit', 10);
  const jobs = arg('jobs', 4);
  const ai = process.argv.indexOf('--arms');
  const ARMS = ai > 0 ? process.argv[ai + 1].split(',') : ['fixed', 'picked', 'edits'];
  const db = openDb();
  const cfg = loadConfig();
  // The latest sent note per person, newest first.
  const rows = db.prepare(`SELECT d.id, d.person_id, d.channel, d.package_id, d.body, d.sent_text
      FROM drafts d WHERE d.sent_text IS NOT NULL AND TRIM(d.sent_text) <> ''
       AND d.id = (SELECT MAX(id) FROM drafts e WHERE e.person_id = d.person_id AND e.sent_text IS NOT NULL)
     ORDER BY d.id DESC LIMIT ?`).all(limit);

  const tasks = rows.flatMap((x) => ARMS.map((arm) => ({ x, arm })));
  const out = new Map(rows.map((x) => [x.id, { draft_id: x.id, channel: x.channel,
    original: changed(x.body, x.sent_text), arms: {} }]));
  // --reuse <file>: arms already drafted in an earlier replay are loaded, not
  // redrafted, and only pairs involving a new arm are judged.
  const ri = process.argv.indexOf('--reuse');
  const OLD = new Set();
  if (ri > 0) {
    for (const r of JSON.parse(readFileSync(resolve(ROOT, process.argv[ri + 1]), 'utf8'))) {
      const o = out.get(r.draft_id);
      if (!o) continue;
      for (const [arm, v] of Object.entries(r.arms ?? {})) { if (!ARMS.includes(arm)) { o.arms[arm] = v; OLD.add(arm); } }
      o.judged = { ...(r.judged ?? {}) };
    }
  }
  let next = 0;
  let cost = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const { x, arm } = tasks[next++];
      try {
        const r = await draftOnce(x, arm);
        cost += r.cost_usd ?? 0;
        // An arm that fell back to the fixed set is not that arm; leave it out.
        if (r.examples?.arm !== arm) {
          console.log(dim(`  draft ${x.id} ${arm}: fell back (${r.examples?.fell_back ?? '?'}), not counted`));
          continue;
        }
        const d = changed(r.body, x.sent_text);
        out.get(x.id).arms[arm] = { body: r.body, changed: d, record: r.examples };
        console.log(dim(`  draft ${x.id} ${arm}: ${Math.round(d * 100)}% different from what was sent`));
      } catch (e) {
        console.log(`  draft ${x.id} ${arm} FAILED: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  // THE JUDGE: blind, pairwise, both orders, against what he sent.
  const ALL = [...OLD, ...ARMS];
  const pairs = ALL.flatMap((p, i) => ALL.slice(i + 1).map((q) => [p, q]));
  const fresh = pairs.filter(([p, q]) => ARMS.includes(p) || ARMS.includes(q));
  const model = cfg.models.grader ?? cfg.models.default;
  const system = readFileSync(resolve(ROOT, JUDGE_PROMPT), 'utf8');
  const runId = startRun(db, 'replay-judge', { model, notes: `${rows.length} notes, ${ARMS.join(' ')}` });
  const before = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) c FROM llm_calls WHERE run_id = ?');
  const jt = [...out.values()].flatMap((o) => fresh.filter(([p, q]) => o.arms[p] && o.arms[q]).map((pq) => ({ o, pq })));
  let jn = 0;
  const sentOf = new Map(rows.map((x) => [x.id, x.sent_text]));
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (jn < jt.length) {
      const { o, pq: [p, q] } = jt[jn++];
      try {
        (o.judged ??= {})[`${p}>${q}`] = await judgePair(db, runId, model, system, sentOf.get(o.draft_id), o.arms[p], o.arms[q]);
      } catch (e) { console.log(`  judge ${o.draft_id} ${p}/${q} FAILED: ${e.message}`); }
    }
  }));
  const judgeCost = before.get(runId).c;
  finishRun(db, runId, { cost_usd: judgeCost });
  db.close();

  const res = [...out.values()];
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  console.log(heading(`REPLAY: ${rows.length} sent notes, arms ${ALL.join(', ')}`));
  for (const arm of ALL) {
    const xs = res.filter((r) => r.arms[arm]).map((r) => r.arms[arm].changed);
    console.log(`  ${arm.padEnd(7)} drafted ${String(xs.length).padStart(2)} · words different from sent, mean ${pct(mean(xs))}`);
  }
  console.log(`  original drafts, mean ${pct(mean(res.map((r) => r.original)))}`);
  console.log('\n  Blind judge, closer to what was sent (both orders; a split is a tie):');
  for (const [p, q] of pairs) {
    const v = res.map((r) => r.judged?.[`${p}>${q}`] ?? (r.judged?.[`${q}>${p}`] == null ? null : -r.judged[`${q}>${p}`]))
      .filter((x) => x != null);
    console.log(`  ${p} vs ${q}: ${p} ${v.filter((x) => x > 0).length} · ${q} ${v.filter((x) => x < 0).length}`
      + ` · tie ${v.filter((x) => x === 0).length}  (of ${v.length})`);
  }
  console.log(`\n  cost: drafting $${cost.toFixed(2)} · judging $${judgeCost.toFixed(2)}`);

  const dir = resolve(ROOT, 'data/replays');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`);
  writeFileSync(file, JSON.stringify(res, null, 2));
  console.log(dim(`  ${file}`));
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
