// Is every model call's cost kept?
//
// complete() adds each call's cost to its run as it happens, and a stage then
// finishes the run with its own total. That total used to REPLACE the recorded
// cost, so a stage finishing with cost_usd: 0, or a tally that missed a call,
// erased spend the run had already recorded. A finish may raise it, never lower it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { openDb, startRun, finishRun } = await import(R + 'db.mjs');

const dir = mkdtempSync(join(tmpdir(), 'cost-ledger-'));
const db = openDb(join(dir, 'test.db'));
let pass = 0, fail = 0;
const check = (ok, why) => { if (ok) pass++; else { fail++; console.log(`  FAIL  ${why}`); } };
const cost = (id) => db.prepare('SELECT cost_usd FROM runs WHERE id = ?').get(id).cost_usd;
const spend = (id, usd) => db.prepare('UPDATE runs SET cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?').run(usd, id);

let id = startRun(db, 'test'); spend(id, 0.5);
finishRun(db, id, { cost_usd: 0, n_in: 3 });
check(Math.abs(cost(id) - 0.5) < 1e-9, `a finish at $0 erased $0.50 already recorded (now ${cost(id)})`);
check(db.prepare('SELECT n_in FROM runs WHERE id = ?').get(id).n_in === 3, 'the item count was not kept');

id = startRun(db, 'test'); spend(id, 0.5);
finishRun(db, id, { cost_usd: 0.75 });
check(Math.abs(cost(id) - 0.75) < 1e-9, `a finish with a larger total did not raise it (now ${cost(id)})`);

id = startRun(db, 'test'); spend(id, 0.5);
finishRun(db, id, {});
check(Math.abs(cost(id) - 0.5) < 1e-9, `a finish with no total changed the cost (now ${cost(id)})`);

check(Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'llm_calls'`).get()),
  'the per-call ledger table does not exist');

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
