// Replay sent notes through both example arms, to test the picked arm without
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
//   npm run replay -- [--limit 10] [--jobs 4]

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openDb } from './db.mjs';
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

async function main() {
  const limit = arg('limit', 10);
  const jobs = arg('jobs', 4);
  const db = openDb();
  // The latest sent note per person, newest first.
  const rows = db.prepare(`SELECT d.id, d.person_id, d.channel, d.package_id, d.body, d.sent_text
      FROM drafts d WHERE d.sent_text IS NOT NULL AND TRIM(d.sent_text) <> ''
       AND d.id = (SELECT MAX(id) FROM drafts e WHERE e.person_id = d.person_id AND e.sent_text IS NOT NULL)
     ORDER BY d.id DESC LIMIT ?`).all(limit);
  db.close();

  const tasks = rows.flatMap((x) => ['fixed', 'picked'].map((arm) => ({ x, arm })));
  const out = new Map(rows.map((x) => [x.id, { draft_id: x.id, channel: x.channel,
    original: changed(x.body, x.sent_text) }]));
  let next = 0;
  let cost = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const { x, arm } = tasks[next++];
      try {
        const r = await draftOnce(x, arm);
        cost += r.cost_usd ?? 0;
        const o = out.get(x.id);
        o[arm] = changed(r.body, x.sent_text);
        o[`${arm}_record`] = r.examples;
        o[`${arm}_body`] = r.body;
        console.log(dim(`  draft ${x.id} ${arm}: ${Math.round(o[arm] * 100)}% different from what was sent`
          + (r.examples?.fell_back ? ` (fell back: ${r.examples.fell_back})` : '')));
      } catch (e) {
        console.log(`  draft ${x.id} ${arm} FAILED: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  const res = [...out.values()];
  const both = res.filter((r) => r.fixed != null && r.picked != null && r.picked_record?.arm === 'picked');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  console.log(heading(`REPLAY: ${both.length} sent notes redrafted both ways`));
  console.log(`  different from what was sent, mean   fixed ${pct(mean(both.map((r) => r.fixed)))}`
    + ` · picked ${pct(mean(both.map((r) => r.picked)))}`
    + ` · original draft ${pct(mean(both.map((r) => r.original)))}`);
  console.log(`  picked closer on ${both.filter((r) => r.picked < r.fixed).length} of ${both.length}`);
  console.log(`  cost $${cost.toFixed(2)}`);

  const dir = resolve(ROOT, 'data/replays');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`);
  writeFileSync(file, JSON.stringify(res, null, 2));
  console.log(dim(`  ${file}`));
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
