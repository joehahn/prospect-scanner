/**
 * A CONSISTENT COPY, into a folder Dropbox is allowed to sync.
 *
 * The live database sat inside a Dropbox-synced folder in WAL mode with two
 * sessions writing to it, and on 2026-09-22 it came back `database disk image
 * is malformed`. Dropbox syncs `.db`, `-wal` and `-shm` as three independent
 * files and can restore an inconsistent set; a second writer makes that far
 * likelier. `sqlite3 .recover` saved everything that time. It will not always.
 *
 * So `data/` carries com.dropbox.ignored now and nothing in it syncs — which
 * removes the corruption and, left there, would also remove the only off-machine
 * copy of the outreach record. This is the replacement: SQLite's own backup API
 * takes a transactionally consistent copy while the database is in use, and that
 * copy lands somewhere Dropbox does sync.
 *
 * Never copy the live file with `cp`. That is the thing that broke it.
 */
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'db-snapshots');
const KEEP = 14;

mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const target = resolve(OUT, `prospects-${stamp}.db`);

const db = new Database(resolve(ROOT, 'data/prospects.db'), { readonly: true });
await db.backup(target);
db.close();

// Verify what was written rather than trusting that it worked. A snapshot that
// is itself corrupt is worse than none, because it looks like insurance.
const check = new Database(target, { readonly: true });
const ok = check.pragma('integrity_check', { simple: true });
const rows = check.prepare('SELECT COUNT(*) n FROM outreach').get().n;
check.close();
if (ok !== 'ok') throw new Error(`snapshot failed its integrity check: ${ok}`);

const kept = readdirSync(OUT).filter((f) => f.endsWith('.db')).sort();
for (const f of kept.slice(0, Math.max(0, kept.length - KEEP))) unlinkSync(resolve(OUT, f));

console.log(`${target.replace(ROOT + '/', '')} · ${(statSync(target).size / 1e6).toFixed(1)}MB · `
  + `integrity ok · ${rows} outreach rows · keeping the last ${KEEP}`);
