// A form for hand-entering a profile, served locally while you use it.
//
// WHY THIS EXISTS. Pasting a profile meant retyping a long command per person —
// `npm run lead -- paste --person <id> --url <url> --file profile.txt --title
// "..." --degree 2 --confirmed confirmed --activity active` — and the operator
// does about twenty-five of those in a sitting. He asked for a box instead.
//
// A page opened from file:// cannot write to SQLite, so this needed the "no
// server" convention relaxed. He relaxed it on 2026-09-24, for a laptop-local
// tool. The terms are in CLAUDE.md and they are narrow: bound to 127.0.0.1,
// and the DASHBOARDS STAY STATIC FILES. Since 2026-11-17 it may stay running and
// answer on one private-network address for an assistant (REMOTE, below).
//
// IT SHELLS OUT TO `lead -- paste` RATHER THAN REIMPLEMENTING IT. That stage
// holds the provenance rules, the FIRST_HAND marker, the confirmed/degree
// handling and the evidence write. A second copy of that judgment is the defect
// this project keeps finding, so there is one copy and this is a front end.
//
// Usage:  npm run inbox           then open the printed URL

import { createServer } from 'node:http';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { pasteQueue } from './funnel.mjs';
import { operatorLastSaid } from './operator-said.mjs';
import { fieldsNear, urlFrom, matchPerson } from './paste-match.mjs';
import { loadConfig } from './config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.INBOX_PORT ?? 8787);
// AN ASSISTANT OVER A PRIVATE NETWORK (2026-11-17). The operator: "lets use
// Tailscale for now" so his assistant can paste profiles from her own laptop,
// and "keep her view the same as mine ... maybe disable buttons so she doesnt
// accidentally input something". runtime.yml `inbox.remote_listen` names one
// more address to answer on: this machine's address on a private network
// (Tailscale) that only shared devices can reach. Unset, the server answers on
// 127.0.0.1 only, as before. A request that arrived on that address is the
// assistant's: she sees every page as he does, the buttons that record his
// decisions are disabled, the server refuses them anyway, and her pastes are
// stored --via assistant so her connection degree is never recorded as his.
const REMOTE = (() => { try { return loadConfig()?.inbox?.remote_listen || null; } catch { return null; } })();
const LOCAL_HOST = `http://127.0.0.1:${PORT}`;
// How her pages name the operator ("Note to ..."); config, never code.
const OPERATOR_NAME = (() => { try { return loadConfig()?.inbox?.operator_name || 'the operator'; } catch { return 'the operator'; } })();
const fromAssistant = (req) => !/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(String(req.socket.localAddress ?? ''));
// Her pages: every form but a paste box disabled, with the reason on hover.
const ASSISTANT_VIEW = `<script>(() => {
  const why = 'Only the operator records this. Paste boxes work.';
  for (const f of document.querySelectorAll('form')) {
    if (f.classList.contains('pb')) continue;
    for (const el of f.querySelectorAll('button, input, select, textarea')) {
      el.disabled = true; el.title = why; el.style.cursor = 'not-allowed';
    }
    f.style.opacity = '.55';
  }
})();</script>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


function page(db, { note = '', text = '', err = '', extra = '' } = {}) {
  // THE MORNING'S PASTE LIST, LONGER (2026-11-14). This read the old ranker's
  // scores, so it offered people the operator had skipped, people already
  // written to, and people the judge rates 2. Now the same rule as the paste
  // list on the dashboard: rated 3+, writable, no profile yet, one per firm.
  const waiting = pasteQueue(db, 40).map((p) => ({ id: p.person_id, name: p.name,
    title: p.title ?? '', org: p.org_name ?? '' }));
  return `<!doctype html><meta charset="utf-8"><title>paste a profile</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}
 textarea{width:100%;height:22rem;font:13px/1.45 ui-monospace,Menlo,monospace;padding:.6rem}
 input,select{font:14px system-ui;padding:.4rem}
 label{display:block;margin:.7rem 0 .2rem;font-weight:600}
 .row{display:flex;gap:1rem;flex-wrap:wrap}.row>div{flex:1 1 11rem}
 button{font:600 15px system-ui;padding:.6rem 1.4rem;margin-top:1rem;cursor:pointer}
 .ok{background:#e7f6e7;border-left:4px solid #3a3;padding:.7rem 1rem;white-space:pre-wrap}
 .err{background:#fdeaea;border-left:4px solid #c33;padding:.7rem 1rem;white-space:pre-wrap}
 .dim{opacity:.7;font-size:13px} ul{padding-left:1.1rem} li{margin:.15rem 0}
 code{background:#8881;padding:.1rem .3rem;border-radius:3px}
</style>
<h1>Paste a profile</h1>
${err ? `<p class="err">${esc(err)}</p>` : ''}
${extra}
${note ? `<p class="ok">${esc(note)}</p>` : ''}
<form method="post" action="/">
  <label>Profile text — paste the whole page, chrome and all</label>
  <textarea name="text" autofocus placeholder="Paste here. The URL, the person, the degree, the follower count, the location and how active they are are all read out of this.">${esc(text)}</textarea>
  <div class="row">
    <div><label>Profile URL</label><input name="url" style="width:100%" placeholder="read from the text if present"></div>
    <div><label>Person id</label><input name="person" style="width:100%" placeholder="matched by name if left blank"></div>
  </div>
  <div class="row">
    <div><label>Title <span class="dim">— optional, only if the page is wrong</span></label><input name="title" style="width:100%"></div>
  </div>
  <button type="submit">Ingest</button>
  <span class="dim">&nbsp;Runs <code>lead -- paste</code>. Nothing fetches linkedin.com.</span>
</form>
<h2>Waiting on a profile <span class="dim">(${waiting.length} rated 3+ with no profile yet, one per firm)</span></h2>
<ul class="dim">${waiting.map((w) =>
  `<li><code>${esc(w.id)}</code> — ${esc(w.name)}${w.title ? `, ${esc(w.title)}` : ''}${w.org ? ` · ${esc(w.org)}` : ''}</li>`).join('')}</ul>
${AUTO_PASTE}`;
}

const db = openDb();
const tmp = mkdtempSync(join(tmpdir(), 'inbox-'));
const DASH = resolve(ROOT, 'data/dash');

// SERVE THE DASHBOARDS TOO, so a paste box can live on the card it belongs to.
// The files are exactly the static HTML `dash` already generates — nothing is
// rendered here. They simply have to arrive over http rather than file:// for a
// form inside them to have somewhere to post.
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveDash(req, res, url, assistant = false) {
  // The bare address opens Ready, where the day starts (2026-09-26).
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'ready.html';
  const file = resolve(DASH, rel);
  // Never serve outside data/dash, whatever the path says.
  if (!file.startsWith(DASH) || !existsSync(file) || !statSync(file).isFile()) return false;
  // NEVER CACHED. These files are rewritten by every draft, paste and send, and
  // the page carries the script that makes its own buttons work -- a browser
  // holding yesterday's copy gets stale cards AND stale behaviour. That is how a
  // fixed submit handler stayed broken in the operator's browser after the fix
  // had shipped.
  const ext = file.slice(file.lastIndexOf('.'));
  const banner = ext === '.html' ? pasteBanner() : '';
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
    pragma: 'no-cache',
  }).end(ext === '.html' ? forViewer(withAutoPaste(readFileSync(file, 'utf8').replace(/<body[^>]*>/, (m) => m + banner)), assistant, rel)
    : readFileSync(file));
  return true;
}

// Her copy: the pages' absolute links to this server point at her own laptop's
// 127.0.0.1, so they become relative; and the decision buttons are disabled.
// HIS COPY LINKS TO HERS (2026-11-18, the operator: "add link to my db so i can
// see what she sees"): the same page on the private address, which this machine
// can open too, so what he sees there is exactly her view.
const theirViewLink = (rel) => `<a href="http://${REMOTE}:${PORT}/${encodeURI(rel)}" target="_blank" rel="noopener"
  title="This page as the assistant sees it: decision buttons disabled, paste boxes live"
  style="position:fixed;top:6px;right:10px;z-index:9999;font:12px system-ui,sans-serif;padding:3px 8px;border-radius:4px;background:#eef2f8;color:#2a4a7f;border:1px solid #c8d3e6;text-decoration:none">Assistant's view &#8599;</a>`;
// HER VIEW IS TINTED (2026-11-18, the operator: "give [her address] a faint
// background color ... so i can tell at a glance which I'm looking at").
const ASSISTANT_TINT = `<style>html,body{background:#eefaf3 !important}
@media (prefers-color-scheme: dark){html,body{background:#14241b !important}}</style>`;
const forViewer = (html, assistant, rel = 'ready.html') => (!assistant
  ? (REMOTE ? html.replace(/<body[^>]*>/, (m) => m + notesPanel(`/${rel}`) + refusalPanel(`/${rel}`))
    .replace(/<\/body>(?![\s\S]*<\/body>)/, `${theirViewLink(rel)}</body>`) : html)
  // Her note box goes at the TOP: at the bottom it sat under every card, ~45 MB
  // down index.html, where no one would ever reach it (2026-11-18).
  : html.split(LOCAL_HOST).join('').replace(/<body[^>]*>/, (m) => m + herNotes(rel))
    .replace(/<\/body>(?![\s\S]*<\/body>)/, `${ASSISTANT_TINT}${ASSISTANT_VIEW}</body>`));

// The script goes last in the body, where the body it appends to exists.
const withAutoPaste = (html) => (html.includes('</body>')
  ? html.replace(/<\/body>(?![\s\S]*<\/body>)/, `${AUTO_PASTE}</body>`) : html + AUTO_PASTE);

/** Ingest, then re-rank and rebuild so the card the operator is looking at is current. */
// READ ON PASTE, not on the click (2026-10-12). The read took 75 of the 140
// seconds between pressing Draft and seeing a note, and it was waiting on
// nothing but the profile, which arrives here. So a paste for someone the judge
// says to write to starts the read in the background, while the operator pastes
// the next profile. A marker file says one is running; the Draft button waits
// on it rather than starting a second, paid, identical read.
const READ_WAIT_MS = 180_000;
const readMark = (person) => join(tmpdir(), `prospect-scanner-read-${person.replace(/[^\w-]/g, '_')}.pending`);

function readInBackground(db, person) {
  const write = db.prepare(`SELECT COUNT(*) n FROM judgments WHERE person_id = ? AND verdict = 'write'
      AND batch = (SELECT MAX(batch) FROM judgments WHERE person_id = ?)`).get(person, person).n;
  if (write < 2) return false;   // most of three runs say write, or it is not worth a read yet
  const hadRead = db.prepare('SELECT 1 FROM reads WHERE person_id = ? AND rejected_at IS NULL').get(person);
  const mark = readMark(person);
  writeFileSync(mark, new Date().toISOString());
  spawn('sh', ['-c', 'npm run read --silent -- --person "$1" $2; rm -f "$3"', 'sh',
    person, hadRead ? '--redo' : '', mark], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
  console.log(`  reading ${person} in the background`);
  return true;
}

/** Wait until a background read for this person finishes, or give up after READ_WAIT_MS. */
async function awaitBackgroundRead(person) {
  const mark = readMark(person);
  if (!existsSync(mark)) return;
  if (Date.now() - statSync(mark).mtimeMs > READ_WAIT_MS) { rmSync(mark, { force: true }); return; }
  console.log(`  waiting for the background read of ${person}`);
  // Polled, not blocked on: a blocking wait froze every other tab's request with it.
  const until = Date.now() + READ_WAIT_MS;
  while (existsSync(mark) && Date.now() < until) await new Promise((ok) => setTimeout(ok, 500));
  rmSync(mark, { force: true });
}

function ingest(fields, assistant = false) {
  try { return ingestOne(fields, assistant); }
  catch (e) {
    // Who and where ride on the refusal, so a refused paste can be kept.
    e.personId ??= (fields.person ?? '').trim() || null;
    e.url ??= (fields.url ?? '').trim() || urlFrom(fields.text ?? '') || null;
    throw e;
  }
}

function ingestOne(fields, assistant = false) {
  const text = (fields.text ?? '').trim();
  if (!text) throw new Error('Nothing pasted.');
  let personId = (fields.person ?? '').trim();
  if (!personId) {
    const hits = matchPerson(db, text);
    if (!hits.length) throw new Error('No one in the book matches a name in that text.');
    if (hits.length > 1 && hits[0].at === hits[1].at) {
      throw new Error(`That text matches ${hits.length} people: ${hits.map((h) => h.id).join(', ')}.`);
    }
    personId = hits[0].id;
  }
  fields.person = personId;
  const file = join(tmp, `${personId}.txt`);
  writeFileSync(file, text);
  // --extract IS THE POINT OF THE PASTE. Without it, from 2026-09-23 to 09-25,
  // 83 pastes stored their text and never had it read: no in-seat date (which
  // gate and rank use for the fresh-appointment exemption), no remit, no facts,
  // and a title marked confirmed on a page that said the person had left.
  const args = ['run', 'lead', '--silent', '--', 'paste', '--person', personId,
    '--provenance', 'operator_supplied', '--file', file, '--extract'];
  const url = (fields.url ?? '').trim() || urlFrom(text);
  if (url) args.push('--url', url);
  for (const [k, v] of [['title', fields.title], ['degree', fields.degree],
    ['activity', fields.activity], ['followers', fields.followers]]) {
    if ((v ?? '').trim()) args.push(`--${k}`, String(v).trim());
  }
  // Read what the paste already contains, but never over what was typed.
  const who = db.prepare('SELECT name FROM people WHERE id = ?').get(personId)?.name;
  const auto = fieldsNear(text, who);
  for (const k of ['degree', 'followers', 'activity', 'location', 'country']) {
    if (!(fields[k] ?? '').trim() && auto[k]) args.push(`--${k}`, auto[k]);
  }
  // Her page shows HER degree to them; lead keeps the one on file.
  if (assistant) args.push('--via', 'assistant');
  // Only from the operator's Refused pastes panel, on a refusal he has read.
  if (fields.force) args.push('--force');
  // A paste IS the page, so the title it carries is confirmed by definition.
  if (!(fields.confirmed ?? '').trim()) args.push('--confirmed', 'confirmed');
  // ONLY THE REFUSALS ARE WAITED ON (2026-10-20). Store, extract, re-judge,
  // re-rank and rebuild took about twenty seconds a paste, and the operator
  // pastes a dozen in a row. A wrong card or a killed firm still comes back on
  // the spot, from `lead paste --check`, the same code that refuses it later;
  // the rest runs in the queue below while he pastes the next one.
  execFileSync('npm', [...args, '--check'], { cwd: ROOT, encoding: 'utf8' });
  queuePaste(personId, args);
  return { personId, url };
}

// THE PASTE QUEUE. One paste at a time, in the order sent, each as its own
// process so the server keeps answering. Only the last paste in line re-ranks
// and rebuilds, once, for all of them. A Draft or a verdict on a person whose
// paste is still in line waits for it, so neither runs on a card the paste has
// not reached; the page says how many are in line and what failed.
const run = (args) => new Promise((ok, no) => execFile('npm', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 },
  (err, stdout, stderr) => (err ? no(Object.assign(err, { stdout, stderr })) : ok(stdout))));
let pasteChain = Promise.resolve();

// ONE REBUILD AT A TIME, SHARED (2026-10-21). Drafts now run side by side, one
// per open card tab, and each ended in its own rebuild of every page: six at
// once would write the same files over each other. A rebuild asked for while
// one is waiting to start joins it, since it will read the database after
// this change; one asked for mid-rebuild waits for the next.
let rebuildTail = Promise.resolve();
let rebuildNext = null;
function rebuild() {
  if (rebuildNext) return rebuildNext;
  rebuildNext = rebuildTail.then(() => { rebuildNext = null; return run(['run', 'dash', '--silent']); });
  rebuildTail = rebuildNext.catch(() => {});
  return rebuildNext;
}
let pasteCount = 0;
// HELD UP THROUGH THE REBUILD (2026-11-14). The banner used to drop when the
// last paste was stored, though the cards change only after the re-rank and
// rebuild that follow, about a minute later. A reload in that minute showed the
// old To-paste list with no banner, and pastes looked lost.
let pasteRebuilding = false;
const pasteJobs = new Map();
const pasteFailures = [];

function queuePaste(personId, args) {
  pasteCount += 1;
  const job = pasteChain.then(async () => {
    await run(args);
    // A paste that does not move the card is a paste the operator cannot see the
    // effect of, so the judge and the rank both run before the rebuild.
    // RE-JUDGE AFTER A PASTE, when the person is still waiting on the Ready page.
    // The operator decides with the profile in hand; the judge should too, or the
    // comparison sets his informed call against its uninformed one. Only an
    // undecided person: re-judging someone already decided would send their card
    // back to blind.
    // NEVER JUDGED COUNTS TOO (2026-10-02): a profile pasted for someone the judge
    // had not yet seen was stored and then nothing happened -- a 4/5 sat unjudged
    // until someone noticed. Judged now, unless the operator has already decided.
    const waiting = db.prepare(`SELECT 1 FROM judgments j WHERE j.person_id = ?
        AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.person_id = j.person_id AND v.created_at >= j.created_at)
        AND j.batch = (SELECT MAX(batch) FROM judgments WHERE person_id = ?)`).get(personId, personId)
      || (!db.prepare('SELECT 1 FROM judgments WHERE person_id = ?').get(personId)
        && !db.prepare('SELECT 1 FROM verdicts WHERE person_id = ?').get(personId));
    if (waiting) {
      try { await run(['run', 'judge', '--silent', '--', '--person', personId]); }
      catch (e) {
        // On the page, not only in the log: a paste whose judge failed keeps its
        // old rating, and nothing else would say so.
        const msg = `re-judge failed, so the rating is the one from before the paste: ${
          String(e.stderr || e.message).split('\n').filter((l) => /JUDGE FAILED|Error|error/.test(l)).pop() ?? e.message}`;
        pasteFailures.push({ personId, at: Date.now(), msg: msg.slice(0, 400) });
        console.log(`  ${personId}: ${msg.slice(0, 200)}`);
      }
    }
    readInBackground(db, personId);
    commentInBackground(personId);
    console.log(`  ingested ${personId}${waiting ? ', re-judged' : ''}`);
  }).catch((e) => {
    const msg = String(e.stderr || e.message).trim().slice(-600);
    pasteFailures.push({ personId, at: Date.now(), msg });
    if (args.includes('assistant')) {
      const at = args.indexOf('--file'), u = args.indexOf('--url');
      try { keepRefusal({ personId, url: u >= 0 ? args[u + 1] : null, text: readFileSync(args[at + 1], 'utf8'), reason: msg }); }
      catch {}
    }
    console.log(`  paste failed for ${personId}: ${msg.slice(0, 200)}`);
  }).then(async () => {
    pasteCount -= 1;
    if (pasteCount > 0) return;
    pasteRebuilding = true;
    try {
      await run(['run', 'rank', '--silent']);
      await rebuild();
      console.log('  re-ranked and rebuilt');
    } catch (e) { console.log(`  rebuild failed: ${String(e.stderr || e.message).slice(0, 200)}`); }
    finally { if (pasteCount === 0) pasteRebuilding = false; }
  });
  pasteChain = job;
  pasteJobs.set(personId, job);
  job.then(() => { if (pasteJobs.get(personId) === job) pasteJobs.delete(personId); });
}

/** Resolves once this person's queued paste, if any, has been stored and judged. */
const pasteSettled = (personId) => pasteJobs.get(String(personId ?? '').trim()) ?? Promise.resolve();

// What the queue is doing, at the top of every page the server hands out.
const FAILURE_SHOWN_MS = 30 * 60_000;
function pasteBanner() {
  const failed = pasteFailures.filter((f) => Date.now() - f.at < FAILURE_SHOWN_MS);
  if (!pasteCount && !pasteRebuilding && !failed.length) return '';
  const line = pasteCount
    ? `<div>${pasteCount} paste${pasteCount === 1 ? '' : 's'} in line: stored, judged and then rebuilt in the background. Reload to see the cards once this banner is gone.</div>`
    : pasteRebuilding
      ? '<div>Pastes stored; re-ranking and rebuilding the pages (about a minute). Reload to see the cards once this banner is gone.</div>'
      : '';
  const fails = failed.map((f) => `<div><b>Paste for ${esc(f.personId)} failed:</b> ${esc(f.msg)}</div>`).join('');
  return `<div style="position:sticky;top:0;z-index:98;padding:8px 16px;font-size:13px;white-space:pre-wrap;${
    failed.length ? 'background:#b3261e;color:#fff' : 'background:#fdf3d0;color:#3d3200'}">${line}${fails}</div>`;
}

// HER REFUSED PASTES REACH HIM (2026-11-18, the operator: "she is also going
// to hit snags when her db refuses profiles, i would like to be able to address
// that"). A paste refused on her view is kept with its text and the reason; she
// is told it has gone to him and moves on. His pages carry a Refused pastes
// panel while any wait: store it on that card anyway, store it on another card
// (pasted on the wrong one), or dismiss it. Nothing is pasted twice.
const REFUSAL_KEPT = `This paste has been kept and sent to ${OPERATOR_NAME} to sort out. Nothing more to do here: go on to the next profile.`;
let lastRefusalId = null;
function keepRefusal({ personId, url, text, reason }) {
  if (!(text ?? '').trim()) return null;
  lastRefusalId = db.prepare(`INSERT INTO paste_refusals (person_id, url, text, reason, via, created_at) VALUES (?, ?, ?, ?, 'assistant', ?)`)
    .run(personId || null, url || null, String(text).trim(), String(reason).trim().slice(-2000), new Date().toISOString()).lastInsertRowid;
  console.log(`  refused (kept for the operator): ${personId ?? 'no match'}`);
  return lastRefusalId;
}

// HER NOTES (2026-11-18, the operator: "if she has a pasting issue, we dont want
// to give her a box to discuss that"). A note on a refused paste, or a note
// about anything she hits, is stored and logged as ASSISTANT NOTE, which a
// watching session picks up. Replies show on her pages; his pages list what is
// open. A note changes nothing by itself.
const noteForm = (refusalId, back, placeholder) => `<form method="post" action="/assistant-note" class="pb" style="margin:.6rem 0">
<input type="hidden" name="refusal" value="${refusalId ?? ''}"><input type="hidden" name="back" value="${esc(back)}">
<textarea name="note" rows="3" style="width:100%;height:auto;font:14px system-ui" placeholder="${esc(placeholder)}"></textarea>
<button type="submit" style="margin-top:.3rem">Send to ${esc(OPERATOR_NAME)}</button></form>`;
const refusalNoteBox = (id) => (id ? `<p><b>Anything to add for ${esc(OPERATOR_NAME)}?</b> Optional. For example: the name is spelled differently on LinkedIn, or this person has moved firms.</p>${noteForm(id, '/ready.html', 'Optional note about this paste')}` : '');

function keepNote({ refusalId, page: pg, text }) {
  const t = String(text ?? '').trim().slice(0, 4000);
  if (!t) return null;
  const id = db.prepare('INSERT INTO assistant_notes (refusal_id, page, text, created_at) VALUES (?, ?, ?, ?)')
    .run(refusalId || null, pg || null, t, new Date().toISOString()).lastInsertRowid;
  console.log(`  ASSISTANT NOTE #${id}${refusalId ? ` (refused paste #${refusalId})` : ''}: ${t.replace(/\s+/g, ' ').slice(0, 200)}`);
  return id;
}

// On her pages: her notes from the last week, with any reply, then a box.
function herNotes(rel) {
  const rows = db.prepare(`SELECT * FROM assistant_notes WHERE created_at >= datetime('now', '-7 days') ORDER BY id DESC LIMIT 8`).all();
  const list = rows.map((n) => `<div style="border-top:1px solid #b9dcc6;padding:6px 0"><div style="white-space:pre-wrap">${esc(n.text)}</div>
<div style="margin-top:3px;${n.reply ? '' : 'opacity:.7'}">${n.reply ? `<b>${esc(n.reply_by === 'claude' ? `Claude (for ${OPERATOR_NAME})` : OPERATOR_NAME)}:</b> <span style="white-space:pre-wrap">${esc(n.reply)}</span>` : (n.done_at ? 'Done.' : 'Waiting for a reply.')}</div></div>`).join('');
  return `<details style="margin:8px 16px 12px;padding:10px 14px;border:1px solid #b9dcc6;border-radius:6px;background:#f7fdf9;font:14px system-ui,sans-serif"${rows.some((n) => n.reply && !n.done_at) ? ' open' : ''}>
<summary style="cursor:pointer;font-weight:600">Note to ${esc(OPERATOR_NAME)}${rows.length ? ` (${rows.length} this week${rows.filter((n) => n.reply).length ? `, ${rows.filter((n) => n.reply).length} answered` : ''})` : ''}</summary>
<div style="opacity:.75;font-size:13px;margin:4px 0">Goes to ${esc(OPERATOR_NAME)}. Paste problems may be answered right away by Claude, the AI tool ${esc(OPERATOR_NAME)} uses to run this; anything else waits for ${esc(OPERATOR_NAME)}.</div>
${list}${noteForm(null, `/${rel}`, 'A snag, a question, a card that looks wrong ...')}</details>`;
}

// On his pages: her notes still open.
function notesPanel(back) {
  const rows = db.prepare(`SELECT n.*, r.person_id FROM assistant_notes n LEFT JOIN paste_refusals r ON r.id = n.refusal_id
      WHERE n.done_at IS NULL ORDER BY n.id DESC LIMIT 20`).all();
  if (!rows.length) return '';
  return `<div style="margin:0;padding:10px 16px;background:#eaf6ee;color:#173b26;font:13px system-ui,sans-serif;border-bottom:2px solid #7cbf94">
<b>Notes from the assistant: ${rows.length}</b>
${rows.map((n) => `<div style="border-top:1px solid #b9dcc6;padding:8px 0">
<span style="opacity:.7">#${n.id} · ${esc(new Date(n.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }))}${n.refusal_id ? ` · on refused paste #${n.refusal_id}${n.person_id ? ` (${esc(n.person_id)})` : ''}` : ''}${n.page ? ` · from ${esc(n.page)}` : ''}</span>
<div style="white-space:pre-wrap;margin:3px 0">${esc(n.text)}</div>
<form method="post" action="/assistant-note-reply"><input type="hidden" name="id" value="${n.id}"><input type="hidden" name="back" value="${esc(back)}">
<input name="reply" value="${esc(n.reply ?? '')}" placeholder="Reply she will see" style="width:28em">
<button name="do" value="reply">Reply</button> <button name="do" value="done">Done</button></form></div>`).join('')}</div>`;
}

function refusalPanel(back) {
  const rows = db.prepare(`SELECT r.*, p.name FROM paste_refusals r LEFT JOIN people p ON p.id = r.person_id
      WHERE r.resolved_at IS NULL ORDER BY r.id DESC LIMIT 20`).all();
  if (!rows.length) return '';
  const item = (r) => `<div style="border-top:1px solid #e3c9a8;padding:8px 0">
<b>${esc(r.name ?? r.person_id ?? 'no name matched')}</b> <span style="opacity:.7">· ${esc(new Date(r.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }))}${r.url ? ` · ${esc(r.url)}` : ''}</span>
<div style="white-space:pre-wrap;margin:4px 0">${esc(r.reason.split('\n').filter((l) => l.trim() && !/^\s*at |npm (ERR|error)|^>/.test(l)).slice(-4).join('\n'))}</div>
<details><summary style="cursor:pointer">What she pasted</summary><pre style="white-space:pre-wrap;max-height:16em;overflow:auto;font-size:12px">${esc(r.text.slice(0, 6000))}</pre></details>
<form method="post" action="/refusal" style="margin-top:6px">
<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="back" value="${esc(back)}">
Card (person id): <input name="person" value="${esc(r.person_id ?? '')}" style="width:16em" placeholder="the right person's id">
<label style="display:inline"><input type="checkbox" name="force" value="1"> it is them; skip the name check</label>
<button name="do" value="store">Store</button> <button name="do" value="dismiss">Dismiss</button>
</form></div>`;
  return `<div style="margin:0;padding:10px 16px;background:#fbf0e2;color:#3d2a12;font:13px system-ui,sans-serif;border-bottom:2px solid #d9a35b">
<b>Refused pastes from the assistant: ${rows.length}</b> <span style="opacity:.75">Store one on its card anyway (tick the box when the page names them differently), store it on another card, or dismiss it.</span>
${rows.map(item).join('')}</div>`;
}

// PASTE THESE TOO (2026-11-18, the operator: "show me 5 more cards to paste").
// The next five the paste list would have offered, asked for exactly as
// `lead paste-ask` asks, so they sit at the top until a profile arrives.
async function moreToPaste(assistant) {
  const asked = new Set(db.prepare(`SELECT a.person_id FROM paste_asks a
      WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = a.person_id
                          AND e.kind = 'operator_profile' AND e.retrieved_at >= a.asked_at)
        AND a.person_id NOT IN (SELECT person_id FROM outreach WHERE person_id IS NOT NULL)`).pluck().all());
  const shown = new Set(pasteQueue(db).filter((p) => !asked.has(p.person_id)).map((p) => p.person_id));
  const next = pasteQueue(db, 80).filter((p) => !asked.has(p.person_id) && !shown.has(p.person_id)).slice(0, 5);
  const at = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO paste_asks (person_id, asked_at, note) VALUES (?, ?, ?)
      ON CONFLICT(person_id) DO UPDATE SET asked_at = excluded.asked_at, note = excluded.note`);
  for (const p of next) ins.run(p.person_id, at, `5 more, from the page${assistant ? ' (assistant)' : ''}`);
  console.log(`  5 more to paste: ${next.map((p) => p.person_id).join(', ') || 'none left'}`);
  if (next.length) await rebuild();
  return next.length;
}

// A PASTE INGESTS ITSELF (2026-10-29). The operator: "i'd like the make profile
// pasting less time consuming." Per person it was: open the profile, copy it,
// come back, open the card's box, click into it, paste, press Go. Now a page
// pasted anywhere on a served page that is not some other field goes straight
// in, matched by name exactly as the bulk form matches it, and a paste into a
// card's own box submits that box. A lone profile URL (from the address bar) is
// held and rides along with the next page pasted, so the order does not matter.
//
// Nothing here reads linkedin.com: it handles what the operator copied himself.
// A short or single-line paste is left alone, so pasting a word into a page
// does nothing surprising; a refusal comes back on the bulk form with the text
// still in it, as before.
const AUTO_PASTE = String.raw`<script>(() => {
  const URL_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s"'<>)]+$/i;
  const MIN_CHARS = 300;
  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99;padding:8px 12px;'
    + 'font:13px system-ui;border-radius:6px;background:#1d3b5a;color:#fff;max-width:440px;display:none';
  document.body.appendChild(tag);
  const say = (m) => { tag.textContent = m; tag.style.display = m ? 'block' : 'none'; };
  let held = '';
  try { held = sessionStorage.getItem('pasteUrl') || ''; } catch {}
  if (held) say('Profile URL held: ' + held + '. Paste the page anywhere.');
  const hold = (u) => {
    held = u;
    try { u ? sessionStorage.setItem('pasteUrl', u) : sessionStorage.removeItem('pasteUrl'); } catch {}
  };
  const field = (form, name, value) => {
    let el = form.querySelector('[name="' + name + '"]');
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = value;
    return el;
  };
  document.addEventListener('paste', (e) => {
    const text = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').trim();
    if (!text) return;
    const el = document.activeElement;
    const box = el && el.tagName === 'TEXTAREA' && el.name === 'text' && el.form ? el : null;
    const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    // A WHOLE PROFILE IS NEVER MEANT FOR SOME OTHER BOX. The first live test
    // went nowhere: focus was still in a field on the page, and the paste was
    // left to it. A page carrying a "· 2nd" line goes in wherever focus is.
    const profile = text.length >= MIN_CHARS && /^\s*·\s*(1st|2nd|3rd\+?)\s*$/m.test(text);
    if (typing && !box && !profile) return;
    if (URL_RE.test(text)) {
      e.preventDefault();
      const u = box && box.form.querySelector('[name="url"]');
      if (u) u.value = text;
      hold(text);
      say('Profile URL held: ' + text + '. Paste the page anywhere.');
      return;
    }
    if (text.length < MIN_CHARS || !text.includes('\n')) return;
    e.preventDefault();
    let form = box && box.form;
    if (!form) {
      form = document.createElement('form');
      form.method = 'post';
      form.action = '/paste';
      form.style.display = 'none';
      document.body.appendChild(form);
      field(form, 'back', location.pathname + location.hash);
    }
    field(form, 'text', text);
    const u = form.querySelector('[name="url"]');
    if (held && !(u && u.value.trim())) field(form, 'url', held);
    hold('');
    say('Ingesting the paste...');
    form.requestSubmit ? form.requestSubmit() : form.submit();
  });
})();</script>`;

// A FRESH POST IN THE PASTE (2026-10-17). `comment` looks at the Activity
// section and costs nothing unless a post is a week old or less; when one is,
// it drafts a comment and the main page shows it on the next rebuild.
function commentInBackground(person) {
  spawn('sh', ['-c', 'npm run comment --silent -- --person "$1" && npm run dash --silent', 'sh', person],
    { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
}

// COMMENTED / SKIP / REPLIED / EMAIL, from the main page's comment list.
async function commentAction(f) {
  const id = String(f.id ?? '').trim();
  const act = String(f.do ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('no comment id');
  const args = ['run', 'comment', '--silent', '--'];
  if (act === 'revise') {
    // HIS NOTE ON THE DRAFT (2026-11-07): rewritten in place, the note kept.
    const note = (f.note ?? '').trim();
    if (!note) throw new Error('Nothing in the tweak box: say what to change.');
    const file = join(tmp, `revise-${id}.txt`);
    writeFileSync(file, `${note}\n`);
    args.push('--revise', id, '--file', file);
  } else if (act === 'more') {
    // THE ARTICLE AND THE THREAD (2026-11-13): redraft having read either.
    const url = (f.url ?? '').trim();
    const thread = (f.thread ?? '').trim();
    if (!url && !thread) throw new Error('Give the article address, the comments under the post, or both.');
    args.push('--more', id);
    if (url) args.push('--url', url);
    if (thread) { const file = join(tmp, `thread-${id}.txt`); writeFileSync(file, `${thread}\n`); args.push('--thread', file); }
  } else if (act === 'posted') {
    const body = (f.body ?? '').trim();
    if (!body) throw new Error('Nothing in the comment box to record as posted.');
    const file = join(tmp, `comment-${id}.txt`);
    writeFileSync(file, `${body}\n`);
    args.push('--posted', id, '--file', file);
  } else if (act === 'replied' && (f.reply ?? '').trim()) {
    const file = join(tmp, `reply-${id}.txt`);
    writeFileSync(file, `${f.reply.trim()}\n`);
    args.push('--replied', id, '--file', file);
  } else if (['skip', 'replied', 'email'].includes(act)) {
    args.push(`--${act}`, id);
  } else throw new Error(`unknown comment action "${act}"`);
  const out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
  await rebuild();
  return out.trim();
}

// DRAFT / REVISE / SENT, from the card. Each shells out to the stage that owns
// the judgment -- `draft` for writing and revising, `lead -- sent` for the
// record -- so nothing here re-implements a rule that lives elsewhere.
async function note(fields) {
  const person = (fields.person ?? '').trim();
  if (!person) throw new Error('no person');
  const channel = (fields.channel ?? 'linkedin_inmail').trim();
  const service = (fields.service ?? '').trim();
  // A TYPED INSTRUCTION IS NEVER DROPPED. On 2026-10-07 "mention that I am an AI
  // consultant/builder" went in the box, the post arrived as a plain draft, and
  // a fresh note came back with the instruction nowhere -- it was not even
  // stored. Draft again with words in the box means revise with those words.
  const act = fields.do === 'draft' && (fields.revise ?? '').trim() ? 'revise' : fields.do;

  if (act === 'sent') {
    // THE TEXTAREA AS IT STANDS, not the stored draft. The gap between what was
    // drafted and what he actually sent is the only measurement this project has
    // of its own voice, and it exists only if the thing recorded is HIS text.
    const body = (fields.body ?? '').trim();
    if (!body) throw new Error('Nothing in the note box to record as sent.');
    const file = join(tmp, `${person}.sent.txt`);
    writeFileSync(file, `${body}\n`);
    const args = ['run', 'lead', '--silent', '--', 'sent', '--person', person,
      '--channel', channel, '--file', file];
    if (service) args.push('--service', service);
    const subj = (fields.subject ?? '').trim();
    if (subj) args.push('--subject', subj);
    // An InMail to an Open Profile spends no credit (lead sent --free).
    if (fields.free) args.push('--free');
    // "it went out as is": the send-time check found something, he looked, and
    // the note went out that way regardless (src/send-check.mjs).
    if (fields.checked) args.push('--checked');
    const out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
    await rebuild();
    return out.trim();
  }

  // READ BEFORE DRAFTING, because a note written without a thesis has nothing to
  // connect its facts to. `read` is the stage that decides what the person is
  // trying to do and, in `next_step`, what follows from it -- which is the beat
  // the recipe turns on.
  //
  // Found 2026-09-25 on a draft the operator called "not as tight as i would
  // like": it opened on two true facts about a new facility and an acquisition,
  // then asserted "scoping and delivering AI pilots is what I do" with nothing
  // joining the two. There was no read on file. THIRTY of the forty-eight people
  // ever drafted had none, because this button has never run it -- the CLI
  // workflow reads first and the dashboard, which is now where the work happens,
  // simply skipped the step.
  //
  // Only when one is missing. A read the operator has already seen, or rejected
  // and re-run, is not re-derived behind his back.
  await awaitBackgroundRead(person);
  const lastRead = db.prepare(`SELECT MAX(created_at) at FROM reads
      WHERE person_id = ? AND rejected_at IS NULL`).get(person)?.at;
  // ...and when a profile was pasted after it: the read never saw that page.
  const lastPaste = db.prepare(`SELECT MAX(retrieved_at) at FROM evidence
      WHERE person_id = ? AND kind = 'operator_profile'`).get(person)?.at;
  const pastedSince = lastRead && lastPaste && lastPaste > lastRead;
  // ...and when he has said something about them since the read, because what
  // he said now outranks it (prompts/read-the-person.md v6).
  const lastSaid = operatorLastSaid(db, person);
  const saidSince = lastRead && lastSaid && lastSaid > lastRead;
  // ...and when the read prompt has changed since, since a read is only as
  // current as the instructions it was made under.
  const promptNewer = lastRead
    && statSync(resolve(ROOT, 'prompts/read-the-person.md')).mtime.toISOString() > lastRead;
  if ((!lastRead || saidSince || promptNewer || pastedSince) && act !== 'revise') {
    console.log(`  ${lastRead ? 'read out of date' : 'no read'} for ${person} — reading before drafting`);
    try {
      await run(['run', 'read', '--silent', '--', '--person', person, ...(lastRead ? ['--redo'] : [])]);
    } catch (e) {
      // A read that fails is not a reason to refuse to draft; it is a reason to
      // say so. The draft then runs as it always did, on evidence alone.
      console.log(`  read failed (${e.code}), drafting without one`);
    }
  }

  const args = ['run', 'draft', '--silent', '--', '--person', person, '--channel', channel, '--force'];
  // NOT on a fresh draft: the box's hidden service is the LAST draft's offer,
  // and passing it pinned every redraft to it, over a read that now says
  // otherwise. The read picks; a revise keeps the draft it revises.
  if (service && act === 'revise') args.push('--service', service);
  if (fields.firm_ok) args.push('--firm-ok');
  if (act === 'revise') {
    const r = (fields.revise ?? '').trim();
    if (!r) throw new Error('Say what to change, then press Go.');
    // --revise rewrites the latest draft (on another channel when the box switched
    // channel); --force would start a new one.
    const a = ['run', 'draft', '--silent', '--', '--person', person,
      '--channel', channel, '--revise', r];
    if (service) a.push('--service', service);
    return runDraft(a, person);
  }
  return runDraft(args, person);
}

// Exit 2 from `draft` means the note was written and FAILED ITS CLAIM CHECK.
// That is a verdict, not a crash: the draft is in the table and the operator
// needs to see it and the reason, on the card, rather than an error page.
//
// ASYNC SINCE 2026-10-21, so the server keeps answering while a draft runs: six
// card tabs each pressing Draft used to wait in line, and every page load with
// them. They now draft side by side.
async function runDraft(args, person) {
  let out = '';
  try {
    out = await run(args);
  } catch (e) {
    if (e.code !== 2) throw e;
    out = String(e.stdout ?? '');
    console.log('  draft written but a claim could not be sourced — see the card');
  }
  // GRADED ON THE CLICK, added 2026-10-05 when the morning run stopped drafting:
  // every draft now starts here, and the grader (a model other than the
  // drafter) flags a failing note on its card before it is sent.
  // Since 2026-10-12 `draft` grades its own draft before it exits, so the
  // command line gets the same grade; this catches only a draft that skipped it.
  try { await run(['run', 'grade', '--silent', '--', '--person', person]); }
  catch (e) { console.log(`  grade failed for ${person}: ${String(e.stderr || e.message).slice(0, 160)}`); }
  await rebuild();
  return out.trim();
}

function handle(req, res) {
  const send = (html, code = 200) =>
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const assistant = fromAssistant(req);

  if (req.method === 'GET') {
    if (url.pathname === '/paste') return send(page(db));
    if (serveDash(req, res, url, assistant)) return;
    return send(page(db));
  }
  // Verdicts, notes, sends, comments and balances are his: refused from her
  // address even if a disabled button is forced.
  if (assistant && ['/note', '/comment', '/verdict', '/balance', '/refusal', '/assistant-note-reply'].includes(url.pathname)) {
    return send(page(db, { err: 'Only the operator records this. Pasting a profile works from here.' }), 403);
  }

  // RESULTS PAGE VIEWS (2026-11-18). The page reports each panel he looks at,
  // so panels he uses rise and ones he never looks at fold away. Only his:
  // a view from her address is dropped without a word.
  if (url.pathname === '/chart-view' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e3) req.destroy(); });
    req.on('end', () => {
      const f = new URLSearchParams(raw);
      const id = (f.get('id') ?? '').trim();
      if (!assistant && /^[a-z0-9_-]{1,40}$/.test(id)) {
        db.prepare('INSERT INTO chart_views (brief_id, at, ms, how) VALUES (?, ?, ?, ?)')
          .run(id, new Date().toISOString(), Number(f.get('ms')) || null, f.get('how') === 'opened' ? 'opened' : 'seen');
      }
      res.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === '/chart-revive' && req.method === 'POST') {
    if (assistant) return send(page(db, { err: 'Only the operator records this.' }), 403);
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e3) req.destroy(); });
    req.on('end', async () => {
      const id = (new URLSearchParams(raw).get('id') ?? '').trim();
      const now = new Date().toISOString();
      db.prepare(`UPDATE chart_briefs SET status = 'approved', approved_at = ?, retired_at = NULL, retired_why = NULL WHERE id = ?`).run(now, id);
      db.prepare(`INSERT INTO chart_feedback (brief_id, at, call, note) VALUES (?, ?, 'keep', 'brought back from retired')`).run(id, now);
      try { await rebuild(); } catch { /* the page still loads; it updates on the next build */ }
      res.writeHead(303, { location: '/results.html' }).end();
    });
    return;
  }

  if (url.pathname === '/more-to-paste' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      const back = (new URLSearchParams(raw).get('back') ?? '').trim() || '/';
      try {
        if (await moreToPaste(assistant)) return res.writeHead(303, { location: back }).end();
        send(page(db, { note: 'Nothing more to paste right now: everyone rated 3 or higher already has a profile on file. '
          + 'The morning run adds new people; check back after it.' }));
      }
      catch (e) { send(page(db, { err: `5 more failed:\n${String(e.stderr || e.message)}` })); }
    });
    return;
  }

  if (url.pathname === '/assistant-note' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const back = (f.back ?? '').trim() || '/';
      keepNote({ refusalId: Number(f.refusal) || null, page: back, text: f.note });
      res.writeHead(303, { location: back }).end();
    });
    return;
  }

  if (url.pathname === '/assistant-note-reply' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const now = new Date().toISOString();
      const reply = (f.reply ?? '').trim();
      if (reply) db.prepare("UPDATE assistant_notes SET reply = ?, replied_at = ?, reply_by = 'operator' WHERE id = ?").run(reply, now, Number(f.id));
      if (f.do === 'done') db.prepare('UPDATE assistant_notes SET done_at = ? WHERE id = ?').run(now, Number(f.id));
      res.writeHead(303, { location: (f.back ?? '').trim() || '/' }).end();
    });
    return;
  }

  if (url.pathname === '/refusal' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const back = (f.back ?? '').trim() || '/';
      const r = db.prepare('SELECT * FROM paste_refusals WHERE id = ? AND resolved_at IS NULL').get(Number(f.id));
      if (!r) return res.writeHead(303, { location: back }).end();
      const done = (what) => db.prepare('UPDATE paste_refusals SET resolved_at = ?, resolution = ? WHERE id = ?')
        .run(new Date().toISOString(), what, r.id);
      if (f.do === 'dismiss') { done('dismissed'); return res.writeHead(303, { location: back }).end(); }
      const person = (f.person ?? '').trim() || r.person_id;
      try {
        // Stored as hers: her degree never becomes his.
        const out = ingest({ text: r.text, url: r.url ?? '', person: person ?? '', force: f.force ? '1' : '' }, true);
        done(`${f.force ? 'forced' : 'stored'} ${out.personId}`);
        console.log(`  refused paste #${r.id} ${f.force ? 'forced onto' : 'stored on'} ${out.personId}`);
        res.writeHead(303, { location: back }).end();
      } catch (e) {
        send(page(db, { err: `Still refused, so it stays on the list:\n${String(e.stderr || e.message)}` }));
      }
    });
    return;
  }

  if (url.pathname === '/note') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) req.destroy(); });
    req.on('end', async () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const back = (f.back ?? '').trim() || '/';
      await pasteSettled(f.person);
      try {
        await note(f);
        res.writeHead(303, { location: back }).end();
        console.log(`  ${f.do} · ${f.person} · ${f.channel}`);
      } catch (e) {
        // A refusal is worth reading -- the claim gate lives in `draft` and
        // this is where its verdict surfaces.
        const msg = String(e.stdout || '') + String(e.stderr || e.message);
        send(page(db, { err: `${f.do} refused:\n\n${msg.slice(-3000)}` }));
      }
    });
    return;
  }

  if (url.pathname === '/comment') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      try {
        console.log(`  ${await commentAction(f)}`);
        res.writeHead(303, { location: (f.back ?? '').trim() || '/' }).end();
      } catch (e) {
        send(page(db, { err: `comment refused:\n${e.stderr || e.message}` }));
      }
    });
    return;
  }

  // WOULD HE WRITE TO THEM? One click and a reason, straight back to the card.
  if (url.pathname === '/verdict') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const back = (f.back ?? '').trim() || '/';
      // After the re-judge of a fresh paste, or that judgment lands after the
      // call and sends a decided card back to blind.
      await pasteSettled(f.person);
      try {
        const args = ['run', 'lead', '--silent', '--', 'verdict', '--person', String(f.person ?? ''),
          // The dashboard script disables buttons while working, and a disabled
          // button's value is not posted; it copies the pressed value into
          // `do` first. Read either, or every click from a card fails.
          '--verdict', String(f.verdict || f.do || ''),
          // 'blind' when the card hid the judge's call until the click; scored apart.
          '--source', f.source === 'blind' ? 'blind' : 'card'];
        if ((f.why ?? '').trim()) args.push('--why', f.why.trim());
        const out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
        await rebuild();
        res.writeHead(303, { location: back }).end();
        console.log(`  verdict ${out.trim()}`);
      } catch (e) {
        send(page(db, { err: `verdict refused:\n${e.stderr || e.message}` }));
      }
    });
    return;
  }

  // THE CREDITS LINKEDIN SHOWS, typed in by the operator. InMail is a balance
  // (credits roll over and come back on a reply), not a monthly allowance, so
  // the page counts down from the last number he saw rather than from config.
  if (url.pathname === '/balance') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e4) req.destroy(); });
    req.on('end', async () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const n = Number(String(f.credits ?? '').trim());
      const channel = String(f.channel || 'linkedin_inmail');
      if (!Number.isInteger(n) || n < 0 || n > 1000) return send(page(db, { err: `Not a credit count: "${f.credits}"` }));
      // `after_id`: sends are dated by day only, so "since he looked" is the
      // outreach rows recorded after this one, not a timestamp comparison.
      db.exec(`CREATE TABLE IF NOT EXISTS balances (channel TEXT PRIMARY KEY, credits INTEGER NOT NULL,
          as_of TEXT NOT NULL, after_id INTEGER NOT NULL DEFAULT 0)`);
      const after = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM outreach').get().m;
      db.prepare(`INSERT INTO balances (channel, credits, as_of, after_id) VALUES (?, ?, ?, ?)
          ON CONFLICT(channel) DO UPDATE SET credits = excluded.credits, as_of = excluded.as_of,
          after_id = excluded.after_id`).run(channel, n, new Date().toISOString(), after);
      await rebuild();
      res.writeHead(303, { location: (f.back ?? '').trim() || '/' }).end();
      console.log(`  balance ${channel} = ${n}`);
    });
    return;
  }

  // A card's own box posts here and is sent straight back to that card.
  if (url.pathname === '/paste') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) req.destroy(); });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const back = (f.back ?? '').trim() || '/';
      try {
        const r = ingest(f, assistant);
        res.writeHead(303, { location: `${back}${back.includes('#') ? '' : '#'}` }).end();
        console.log(`  queued ${r.personId}${r.url ? ` · ${r.url}` : ''}`);
      } catch (e) {
        const err = String(e.stderr || e.message);
        if (assistant) {
          const rid = keepRefusal({ personId: e.personId, url: e.url, text: f.text, reason: err });
          return send(page(db, { err: `${err}\n\n${REFUSAL_KEPT}`, extra: refusalNoteBox(rid) }));
        }
        send(page(db, { text: f.text ?? '', err }));
      }
    });
    return;
  }
  if (req.method !== 'POST') return send(page(db));

  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 4e6) req.destroy(); });
  req.on('end', () => {
    const f = Object.fromEntries(new URLSearchParams(raw));
    const text = (f.text ?? '').trim();
    if (!text) return send(page(db, { err: 'Nothing pasted.' }));

    let personId = (f.person ?? '').trim();
    if (!personId) {
      const hits = matchPerson(db, text);
      if (!hits.length) {
        const err = 'No one in the book matches a name in that text. Put the person id in the field below, '
          + 'or add them first with `lead -- add-person`.';
        if (assistant) { const rid = keepRefusal({ personId: null, url: (f.url ?? '').trim() || urlFrom(text), text, reason: err });
          return send(page(db, { err: `${err}\n\n${REFUSAL_KEPT}`, extra: refusalNoteBox(rid) })); }
        return send(page(db, { text, err }));
      }
      // AMBIGUITY IS SHOWN, NEVER GUESSED. Writing a profile onto the wrong
      // person is silent and hard to notice later.
      if (hits.length > 1 && hits[0].at === hits[1].at) {
        return send(page(db, { text, err:
          `That text matches ${hits.length} people: ${hits.map((h) => `${h.id} (${h.name})`).join(', ')}. `
          + 'Pick one in the Person id field.' }));
      }
      personId = hits[0].id;
    }

    const file = join(tmp, `${personId}.txt`);
    writeFileSync(file, text);
    const args = ['run', 'lead', '--silent', '--', 'paste', '--person', personId,
      '--provenance', 'operator_supplied', '--file', file, '--extract'];
    const url = (f.url ?? '').trim() || urlFrom(text);
    if (url) args.push('--url', url);
    for (const [k, v] of [['title', f.title], ['degree', f.degree],
      ['activity', f.activity], ['followers', f.followers]]) {
      if ((v ?? '').trim()) args.push(`--${k}`, String(v).trim());
    }
    if (assistant) args.push('--via', 'assistant');
    try {
      const out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
      const who = db.prepare('SELECT name FROM people WHERE id = ?').get(personId)?.name ?? personId;
      send(page(db, { note: `Ingested for ${who} (${personId})${url ? `\n${url}` : ''}\n\n${out.trim()}` }));
    } catch (e) {
      const err = `lead -- paste refused it:\n${e.stderr || e.message}`;
      if (assistant) { const rid = keepRefusal({ personId, url, text, reason: err });
        return send(page(db, { err: `${err}\n\n${REFUSAL_KEPT}`, extra: refusalNoteBox(rid) })); }
      send(page(db, { text, err }));
    }
  });
}

createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  DASHBOARDS   http://127.0.0.1:${PORT}/index.html`);
  console.log('               open them here, not from disk, and every card that needs a');
  console.log('               profile has its own paste box. A paste is checked, then queued:');
  console.log('               you are back on the card at once, and the cards rebuild when');
  console.log('               the line is empty.');
  console.log(`\n  BULK FORM    http://127.0.0.1:${PORT}/paste`);
  console.log('\n  Local only, nothing listens when this stops. Ctrl-C when done.\n');
});
if (REMOTE) {
  createServer(handle).listen(PORT, REMOTE, () => {
    console.log(`  ASSISTANT    http://${REMOTE}:${PORT}/  (private network; decisions disabled)\n`);
  }).on('error', (e) => console.log(`  ASSISTANT    not listening on ${REMOTE}: ${e.code || e.message}\n`));
}
