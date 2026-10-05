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
// started by a command, stopped when the work is done, and the DASHBOARDS STAY
// STATIC FILES. Nothing listens when nobody is typing.
//
// IT SHELLS OUT TO `lead -- paste` RATHER THAN REIMPLEMENTING IT. That stage
// holds the provenance rules, the FIRST_HAND marker, the confirmed/degree
// handling and the evidence write. A second copy of that judgment is the defect
// this project keeps finding, so there is one copy and this is a front end.
//
// Usage:  npm run inbox           then open the printed URL

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { operatorLastSaid } from './operator-said.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.INBOX_PORT ?? 8787);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// THE DEGREE AND THE FOLLOWER COUNT ARE ALREADY IN THE PASTE, and the first
// version of this form made the operator retype them into dropdowns. He asked
// whether they had been captured; they had not, and the text said "· 3rd" eight
// times.
//
// EIGHT TIMES IS THE WHOLE DIFFICULTY. A LinkedIn copy carries the subject's
// degree AND every degree in the "More profiles for you" and "People you may
// know" rails, so the naive first-match or most-common reading picks a
// stranger's. The subject's own sits a few characters after their name, before
// any rail exists, so both are read FROM THE NAME FORWARD and only within a
// short window. Outside that window they are left unset, because an unset field
// is honest and a wrong degree quietly changes what the ranker thinks is
// reachable.
function fieldsNear(text, name) {
  const t = String(text);
  const at = name ? t.toLowerCase().indexOf(String(name).toLowerCase()) : -1;
  if (at < 0) return {};
  const win = t.slice(at, at + 900);              // the header block, not the rails
  const out = {};

  const deg = win.match(/·\s*([123])(?:st|nd|rd)\b/);
  if (deg) out.degree = deg[1];

  // FOLLOWERS HANG OFF THE "Activity" HEADING, not off the name. On one real
  // paste three counts appeared: the subject's 2,696 just after Activity, and
  // 8,163 and 9,950 belonging to company pages in the "Pages for you" rail at
  // the very bottom. Anchoring to the heading picks the person's; anchoring to
  // the name or to the largest number picks a software vendor's.
  const act = t.indexOf('Activity', at);
  if (act > 0) {
    const fol = t.slice(act, act + 200).match(/([\d,]{3,})\s+followers/i);
    if (fol) out.followers = fol[1].replace(/,/g, '');
  }

  // LOCATION sits between the headline and "Contact info", on its own line, and
  // is the only line in the header shaped like a place. Taken only from the
  // header block, because the rails are full of other people's cities.
  const head = win.slice(0, win.indexOf('Contact info') + 1 || 600);
  const loc = head.split('\n').map((l) => l.trim())
    .find((l) => /^[A-Z][\w .'-]+(?:,\s*[A-Z][\w .'-]+){1,3}$/.test(l)
      && /(United States|United Kingdom|Canada|Australia|Ireland|Bermuda|Area|Metropolitan)/i.test(l));
  if (loc) {
    out.location = loc;
    const parts = loc.split(',').map((x) => x.trim());
    if (parts.length > 1) out.country = parts[parts.length - 1];
  }

  // ACTIVITY FROM HOW OLD THE POSTS ARE, which is the only honest source for it.
  // LinkedIn stamps each item "1w", "3mo", "2yr", and says "has no recent posts"
  // when there are none. The freshest one decides. Guessing this wrong changes
  // what the ranker believes about reachability, so an unreadable feed yields
  // NOTHING rather than a default.
  //
  // THE AGE SITS ON EITHER SIDE OF THE BULLET, and the first version only read
  // one. One real profile stamps its items "• \n 1w"; another stamps them
  // "1mo • Edited", and that second one came back with activity UNSET while
  // every other field filled. So the token is matched on its own line with an
  // optional bullet before or after, rather than anchored to the bullet.
  //
  // WORTH KNOWING WHEN READING THE RESULT: on a feed of RESHARES the timestamp
  // belongs to the post being reshared, not to the act of resharing. That makes
  // this a lower bound on how recently someone touched LinkedIn, which is the
  // safe direction to be wrong in for a reachability signal.
  const AGE = /(?:^|\n)[ \t]*(?:•[ \t]*\n?[ \t]*)?(\d{1,2})\s*(d|w|mo|yr)\b[ \t]*(?:•|$|\n)/gm;
  if (/no recent posts/i.test(t)) out.activity = 'dormant';
  else if (act > 0) {
    const ages = [...t.slice(act, act + 9000).matchAll(AGE)]
      .map((m) => Number(m[1]) * ({ d: 1, w: 7, mo: 30, yr: 365 }[m[2]]));
    if (ages.length) {
      const freshest = Math.min(...ages);
      out.activity = freshest <= 14 ? 'high' : freshest <= 60 ? 'active'
        : freshest <= 365 ? 'low' : 'dormant';
    }
  }
  return out;
}

/** Pull a linkedin.com/in/ URL out of pasted text. Nothing fetches it. */
function urlFrom(text) {
  const m = String(text).match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s"'<>)]+/i);
  return m ? m[0].replace(/[.,;]$/, '') : '';
}

// THE NAME IS THE FIRST LINE THAT IS A NAME. A LinkedIn copy-paste opens with
// the URL, then the nav chrome, then the person. Matching against the book
// rather than guessing at structure is what makes this reliable across the
// layout changes that have already broken two parsers in this project.
function matchPerson(db, text) {
  const hay = String(text).slice(0, 4000).toLowerCase();
  const rows = db.prepare(`SELECT p.id, p.name, p.title, o.name org,
      EXISTS(SELECT 1 FROM evidence e WHERE e.person_id = p.id
             AND e.provenance = 'operator_supplied' AND e.body IS NOT NULL) has_profile
    FROM people p LEFT JOIN orgs o ON o.id = p.org_id`).all();
  const hits = rows.filter((r) => r.name && r.name.length > 5 && hay.includes(r.name.toLowerCase()));
  // Longest name wins: "Alex Chen" also matches inside "Alex Chenoweth".
  return hits.sort((a, b) => b.name.length - a.name.length);
}

function page(db, { note = '', text = '', err = '' } = {}) {
  const waiting = db.prepare(`SELECT p.id, p.name, COALESCE(p.title,'') title, COALESCE(o.name,'') org
      FROM people p LEFT JOIN orgs o ON o.id = p.org_id
      JOIN person_scores s ON s.person_id = p.id
     WHERE s.needs_profile = 1 GROUP BY p.id
     ORDER BY MAX(s.total) DESC LIMIT 40`).all();
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
<h2>Waiting on a profile <span class="dim">(top ${waiting.length} by score)</span></h2>
<ul class="dim">${waiting.map((w) =>
  `<li><code>${esc(w.id)}</code> — ${esc(w.name)}${w.title ? `, ${esc(w.title)}` : ''}${w.org ? ` · ${esc(w.org)}` : ''}</li>`).join('')}</ul>`;
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
function serveDash(req, res, url) {
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
  res.writeHead(200, {
    'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
    pragma: 'no-cache',
  }).end(readFileSync(file));
  return true;
}

/** Ingest, then re-rank and rebuild so the card the operator is looking at is current. */
function ingest(fields) {
  const text = (fields.text ?? '').trim();
  if (!text) throw new Error('Nothing pasted.');
  let personId = (fields.person ?? '').trim();
  if (!personId) {
    const hits = matchPerson(db, text);
    if (!hits.length) throw new Error('No one in the book matches a name in that text.');
    if (hits.length > 1 && hits[0].name.length === hits[1].name.length) {
      throw new Error(`That text matches ${hits.length} people: ${hits.map((h) => h.id).join(', ')}.`);
    }
    personId = hits[0].id;
  }
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
  // A paste IS the page, so the title it carries is confirmed by definition.
  if (!(fields.confirmed ?? '').trim()) args.push('--confirmed', 'confirmed');
  const out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
  // A paste that does not move the card is a paste the operator cannot see the
  // effect of, so both stages run before the browser comes back. Together they
  // take about a second, measured.
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
    try { execFileSync('npm', ['run', 'judge', '--silent', '--', '--person', personId], { cwd: ROOT, encoding: 'utf8' }); }
    catch (e) { console.log(`  re-judge failed for ${personId}: ${String(e.stderr || e.message).slice(0, 200)}`); }
  }
  execFileSync('npm', ['run', 'rank', '--silent'], { cwd: ROOT, encoding: 'utf8' });
  execFileSync('npm', ['run', 'dash', '--silent'], { cwd: ROOT, encoding: 'utf8' });
  return { personId, url, out: out.trim(), rejudged: Boolean(waiting) };
}

// DRAFT / REVISE / SENT, from the card. Each shells out to the stage that owns
// the judgment -- `draft` for writing and revising, `lead -- sent` for the
// record -- so nothing here re-implements a rule that lives elsewhere.
function note(fields) {
  const person = (fields.person ?? '').trim();
  if (!person) throw new Error('no person');
  const channel = (fields.channel ?? 'linkedin_inmail').trim();
  const service = (fields.service ?? '').trim();
  const act = fields.do;

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
    const out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
    execFileSync('npm', ['run', 'dash', '--silent'], { cwd: ROOT, encoding: 'utf8' });
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
  const lastRead = db.prepare(`SELECT MAX(created_at) at FROM reads
      WHERE person_id = ? AND rejected_at IS NULL`).get(person)?.at;
  // ...and when he has said something about them since the read, because what
  // he said now outranks it (prompts/read-the-person.md v6).
  const lastSaid = operatorLastSaid(db, person);
  const saidSince = lastRead && lastSaid && lastSaid > lastRead;
  // ...and when the read prompt has changed since, since a read is only as
  // current as the instructions it was made under.
  const promptNewer = lastRead
    && statSync(resolve(ROOT, 'prompts/read-the-person.md')).mtime.toISOString() > lastRead;
  if ((!lastRead || saidSince || promptNewer) && act !== 'revise') {
    console.log(`  ${lastRead ? 'read out of date' : 'no read'} for ${person} — reading before drafting`);
    try {
      execFileSync('npm', ['run', 'read', '--silent', '--', '--person', person, ...(lastRead ? ['--redo'] : [])],
        { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      // A read that fails is not a reason to refuse to draft; it is a reason to
      // say so. The draft then runs as it always did, on evidence alone.
      console.log(`  read failed (${e.status}), drafting without one`);
    }
  }

  const args = ['run', 'draft', '--silent', '--', '--person', person, '--channel', channel, '--force'];
  // NOT on a fresh draft: the box's hidden service is the LAST draft's offer,
  // and passing it pinned every redraft to it, over a read that now says
  // otherwise. The read picks; a revise keeps the draft it revises.
  if (service && act === 'revise') args.push('--service', service);
  if (act === 'revise') {
    const r = (fields.revise ?? '').trim();
    if (!r) throw new Error('Say what to change, then press Go.');
    // --revise rewrites the latest draft (on another channel when the box switched
    // channel); --force would start a new one.
    const a = ['run', 'draft', '--silent', '--', '--person', person,
      '--channel', channel, '--revise', r];
    if (service) a.push('--service', service);
    return runDraft(a);
  }
  return runDraft(args);
}

// Exit 2 from `draft` means the note was written and FAILED ITS CLAIM CHECK.
// That is a verdict, not a crash: the draft is in the table and the operator
// needs to see it and the reason, on the card, rather than an error page.
function runDraft(args) {
  let out = '';
  try {
    out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 2) throw e;
    out = String(e.stdout ?? '');
    console.log('  draft written but a claim could not be sourced — see the card');
  }
  execFileSync('npm', ['run', 'dash', '--silent'], { cwd: ROOT, encoding: 'utf8' });
  return out.trim();
}

createServer((req, res) => {
  const send = (html, code = 200) =>
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET') {
    if (url.pathname === '/paste') return send(page(db));
    if (serveDash(req, res, url)) return;
    return send(page(db));
  }

  if (url.pathname === '/note') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) req.destroy(); });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const back = (f.back ?? '').trim() || '/';
      try {
        note(f);
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

  // WOULD HE WRITE TO THEM? One click and a reason, straight back to the card.
  if (url.pathname === '/verdict') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(raw));
      const back = (f.back ?? '').trim() || '/';
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
        execFileSync('npm', ['run', 'dash', '--silent'], { cwd: ROOT, encoding: 'utf8' });
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
    req.on('end', () => {
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
      execFileSync('npm', ['run', 'dash', '--silent'], { cwd: ROOT, encoding: 'utf8' });
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
        const r = ingest(f);
        res.writeHead(303, { location: `${back}${back.includes('#') ? '' : '#'}` }).end();
        console.log(`  ingested ${r.personId}${r.url ? ` · ${r.url}` : ''} — re-ranked and rebuilt`);
      } catch (e) {
        send(page(db, { text: f.text ?? '', err: String(e.stderr || e.message) }));
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
        return send(page(db, { text, err:
          'No one in the book matches a name in that text. Put the person id in the field below, '
          + 'or add them first with `lead -- add-person`.' }));
      }
      // AMBIGUITY IS SHOWN, NEVER GUESSED. Writing a profile onto the wrong
      // person is silent and hard to notice later.
      if (hits.length > 1 && hits[0].name.length === hits[1].name.length) {
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
    try {
      const out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
      const who = db.prepare('SELECT name FROM people WHERE id = ?').get(personId)?.name ?? personId;
      send(page(db, { note: `Ingested for ${who} (${personId})${url ? `\n${url}` : ''}\n\n${out.trim()}` }));
    } catch (e) {
      send(page(db, { text, err: `lead -- paste refused it:\n${e.stderr || e.message}` }));
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  DASHBOARDS   http://127.0.0.1:${PORT}/index.html`);
  console.log('               open them here, not from disk, and every card that needs a');
  console.log('               profile has its own paste box. A paste re-ranks and rebuilds,');
  console.log('               then returns you to the same card.');
  console.log(`\n  BULK FORM    http://127.0.0.1:${PORT}/paste`);
  console.log('\n  Local only, nothing listens when this stops. Ctrl-C when done.\n');
});
