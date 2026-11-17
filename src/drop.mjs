// THE ASSISTANT'S DROP FOLDER (2026-11-17). The operator: "lets get the dropbox
// and profile pasting working" so his assistant can paste profiles remotely.
//
// A shared folder, not a server: she sees only this folder, never the book.
//   <dir>/to-paste.html   the paste list, written by `npm run dash`
//   <dir>/*.txt           a page she copied, one person per file; the profile
//                         URL on the first line (url=... or the bare URL)
//   <dir>/done/           files stored, renamed with the date and person id
//   <dir>/check/          files refused, each with a .why.txt beside it
//
// Each file goes through the same refusals as a paste on the operator's own
// form (lead paste: right person, right firm, messaging cut), stored as a
// hand-pasted page, with --via assistant so her connection degree is never
// recorded as his. Nothing here fetches linkedin.com.
//
//   npm run drop             pick up what is in the folder
//   npm run drop -- --dry    say what would happen, change nothing
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { loadConfig } from './config.mjs';
import { fieldsNear, urlFrom, matchPerson } from './paste-match.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The drop folder from config (runtime.yml `assistant_drop.dir`), or null when unset. */
export function dropDir(cfg) {
  const d = cfg?.assistant_drop?.dir;
  if (!d || typeof d !== 'string') return null;
  return resolve(d.replace(/^~(?=\/|$)/, homedir()));
}

/** The URL and the page from one dropped file: a first line `url=...` or a bare URL. */
export function readDropped(raw) {
  const lines = String(raw).replace(/^﻿/, '').split(/\r?\n/);
  const first = (lines[0] ?? '').trim();
  const m = first.match(/^(?:url\s*[=:]\s*)?(https?:\/\/\S+)$/i);
  const text = (m ? lines.slice(1) : lines).join('\n').trim();
  return { url: m ? m[1] : urlFrom(text), text };
}

const npm = (args) => execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
const lastLine = (e) => String(e.stderr || e.stdout || e.message).trim().split('\n').filter(Boolean).slice(-3).join(' ');

export function pickUp({ dry = false, quiet = false } = {}) {
  const cfg = loadConfig();
  const dir = dropDir(cfg);
  const say = (m) => { if (!quiet) console.log(m); };
  if (!dir) { say('No drop folder: set assistant_drop.dir in config/runtime.yml.'); return { stored: [], refused: [] }; }
  if (!existsSync(dir)) { say(`Drop folder ${dir} does not exist.`); return { stored: [], refused: [] }; }
  const files = readdirSync(dir).filter((f) => /\.txt$/i.test(f) && statSync(join(dir, f)).isFile());
  const stored = [], refused = [];
  if (!files.length) { say('Nothing in the drop folder.'); return { stored, refused }; }
  const db = openDb();
  const day = new Date().toISOString().slice(0, 10);
  const refuse = (f, why) => {
    refused.push({ file: f, why });
    say(`  refused ${f}: ${why}`);
    if (dry) return;
    mkdirSync(join(dir, 'check'), { recursive: true });
    renameSync(join(dir, f), join(dir, 'check', f));
    writeFileSync(join(dir, 'check', f.replace(/\.txt$/i, '.why.txt')), `${why}\n`);
  };
  for (const f of files) {
    const { url, text } = readDropped(readFileSync(join(dir, f), 'utf8'));
    if (text.length < 300) { refuse(f, 'Too short to be a whole profile page. Copy the whole page (Cmd-A, Cmd-C) and save it again.'); continue; }
    const hits = matchPerson(db, text);
    if (!hits.length) { refuse(f, 'No one on the paste list matches the name on this page.'); continue; }
    if (hits.length > 1 && hits[0].at === hits[1].at) {
      refuse(f, `The page matches ${hits.length} people (${hits.map((h) => h.name).join(', ')}), so it was left for a person to sort out.`);
      continue;
    }
    const person = hits[0];
    const tmp = join(dir, `.${f}.page`);
    const args = ['run', 'lead', '--silent', '--', 'paste', '--person', person.id,
      '--provenance', 'operator_supplied', '--via', 'assistant', '--extract', '--confirmed', 'confirmed', '--file', tmp];
    if (url) args.push('--url', url);
    // Followers, activity and location are the person's own; the degree is
    // hers to them, so it is never read from her page.
    const auto = fieldsNear(text, person.name);
    for (const k of ['followers', 'activity', 'location', 'country']) if (auto[k]) args.push(`--${k}`, auto[k]);
    writeFileSync(tmp, text);
    try {
      npm([...args, '--check']);
      if (dry) { say(`  would store ${f} for ${person.name}`); stored.push({ file: f, person: person.id }); continue; }
      npm(args);
      mkdirSync(join(dir, 'done'), { recursive: true });
      renameSync(join(dir, f), join(dir, 'done', `${day} ${person.id} ${f}`));
      stored.push({ file: f, person: person.id });
      say(`  stored ${f} for ${person.name}`);
    } catch (e) {
      refuse(f, lastLine(e));
    } finally {
      try { execFileSync('rm', ['-f', tmp]); } catch {}
    }
  }
  if (dry || !stored.length) return { stored, refused };
  // As a paste on his own form: judged if still undecided, then one re-rank and rebuild.
  for (const { person } of stored) {
    const decided = db.prepare('SELECT 1 FROM verdicts WHERE person_id = ?').get(person);
    if (decided) continue;
    try { npm(['run', 'judge', '--silent', '--', '--person', person]); }
    catch (e) { say(`  judge failed for ${person}: ${lastLine(e)}`); }
  }
  npm(['run', 'rank', '--silent']);
  npm(['run', 'dash', '--silent']);
  say(`  ${stored.length} stored, ${refused.length} refused; re-ranked and rebuilt`);
  return { stored, refused };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  pickUp({ dry: process.argv.includes('--dry') });
}
