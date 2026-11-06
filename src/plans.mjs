// A public body's own published plan, read for the AI work it says it will fund.
//
// WHY THIS EXISTS. 2026-11-06: 163 of 186 people rated 3 or more at public
// bodies sat at firms with no live signal at all, rated on title and remit
// alone. One of them, a state cyber agency, had published a strategic plan
// naming "AI-assisted detection and triage" and "analyst decision support" as
// investments it was evaluating, and nothing had read it. A public body is
// required to publish what it means to buy; this reads it.
//
// HOW. One Claude call per body with web search (prompts/read-plan.md) finds
// the body's current plan and copies out the lines where it commits to AI work
// of its own. Then the document itself is fetched, under robots.txt like every
// other fetch, and EVERY QUOTE IS CHECKED AGAINST ITS TEXT. A quote not found
// in the document is dropped; a plan with no verified line records nothing.
// What survives is stored as retrieved evidence with the plan's URL, and as an
// `ai_plan_published` signal dated by the plan. The people rated at the body
// are judged again.
//
// PDF TEXT needs `pdftotext` (poppler) on the PATH. Without it a PDF plan
// cannot be checked, and an unchecked quote is not stored.
//
// NEVER LINKEDIN: blocked at the search tool, and dropped here as well.
//
// A body checked in the last 90 days is skipped unless named with --ids.
//
// Usage:
//   npm run plans -- --limit 5          public bodies with someone rated 3+, no live
//                                       signal, not yet written to, best-rated first
//   npm run plans -- --ids a,b,c        these org ids
//   npm run plans -- ... --dry          find and print, store nothing
//   npm run plans -- ... --no-judge     do not re-judge afterwards

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete, promptBody } from './models.mjs';
import { ratingOf } from './measures.mjs';
import { heading, bold, dim, truncate } from './report.mjs';
import { getJson } from './sources/http.mjs';
import { extractText } from './sources/web.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT = 'prompts/read-plan.md';
const TRIGGER = 'ai_plan_published';
const BLOCKED = ['linkedin.com', 'lnkd.in'];

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['found', 'title', 'url', 'date', 'covers', 'lines'],
  properties: {
    found: { type: 'boolean' },
    title: { type: 'string' },
    url: { type: 'string', description: 'The plan document itself.' },
    date: { type: 'string', description: 'Published or adopted, YYYY-MM-DD, YYYY-MM or YYYY, or "".' },
    covers: { type: 'string', description: 'The fiscal years the plan covers, or "".' },
    lines: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['quote', 'what'],
      properties: {
        quote: { type: 'string', description: 'Verbatim from the document, 20 to 60 words.' },
        what: { type: 'string', description: 'What the AI is for, in a few plain words.' },
      } } },
  },
};

// ---- pure helpers, exported for the tests ---------------------------------

/** Letters and digits only, lower case, single-spaced: survives PDF line breaks and hyphenation. */
export function normalise(s) {
  return String(s ?? '').toLowerCase()
    .replace(/-\s*\n\s*/g, '')            // a word hyphenated across a line break
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Is this quote in this text? Whole, after normalising; nothing fuzzier. */
export function quoteInText(quote, text) {
  const q = normalise(quote);
  return q.split(' ').length >= 6 && normalise(text).includes(q);
}

/** A plan date as YYYY-MM-DD, or null when it gives none usable. */
export function planDate(s) {
  const m = String(s ?? '').trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!m) return null;
  return `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const blocked = (u) => { const h = hostOf(u); return !h || BLOCKED.some((b) => h === b || h.endsWith(`.${b}`)); };

/** The plan's text, from a PDF or a page, or an error saying why not. */
async function documentText(url) {
  const res = await getJson(url, { expect: 'document', retries: 1 });
  if (!res.ok) return { error: res.skipped ?? res.error ?? `HTTP ${res.status}` };
  if (!res.pdf) return { text: extractText(res.bytes.toString('utf8')), url: res.finalUrl ?? url };
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  try {
    writeFileSync(join(dir, 'p.pdf'), res.bytes);
    const text = execFileSync('pdftotext', ['-layout', join(dir, 'p.pdf'), '-'],
      { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    return { text, url: res.finalUrl ?? url };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'pdftotext is not installed (poppler)' : `pdf unreadable: ${e.message}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- the run ---------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => args.includes(`--${k}`);
  const val = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
  const dry = flag('dry');

  const cfg = loadConfig();
  const db = openDb();
  const trig = (cfg.triggers ?? []).find((t) => t.id === TRIGGER);
  if (!trig) throw new Error(`config/signals.yml has no trigger "${TRIGGER}"`);

  const rated = (pid) => {
    const batch = db.prepare('SELECT batch FROM judgments WHERE person_id = ? ORDER BY id DESC LIMIT 1').get(pid)?.batch;
    return batch ? ratingOf(db.prepare('SELECT verdict, compelling FROM judgments WHERE batch = ?').all(batch)
      .map((j) => ({ ...j, compelling: j.compelling == null ? null : Number(j.compelling) }))) : null;
  };

  let orgIds;
  if (val('ids')) orgIds = val('ids').split(',').map((x) => x.trim()).filter(Boolean);
  else if (val('limit')) {
    // Public bodies, no live signal, not checked lately; each with its best
    // unsent, not-skipped person's rating, best first.
    const rows = db.prepare(`SELECT p.id pid, p.org_id FROM people p JOIN orgs o ON o.id = p.org_id
        WHERE o.kind = 'public_body'
          AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.org_id = o.id AND s.retracted_at IS NULL
                          AND (s.decays_at IS NULL OR s.decays_at >= date('now')))
          AND NOT EXISTS (SELECT 1 FROM plan_reads r WHERE r.org_id = o.id AND r.checked_at >= datetime('now', '-90 days'))
          AND NOT EXISTS (SELECT 1 FROM outreach x WHERE x.person_id = p.id)
          AND COALESCE((SELECT v.verdict FROM verdicts v WHERE v.person_id = p.id ORDER BY v.id DESC LIMIT 1), '') <> 'skip'
          AND EXISTS (SELECT 1 FROM judgments j WHERE j.person_id = p.id)`).all();
    const best = new Map();
    for (const r of rows) {
      const x = rated(r.pid);
      if (x != null && x >= 3 && x > (best.get(r.org_id) ?? 0)) best.set(r.org_id, x);
    }
    orgIds = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, Number(val('limit')));
  } else {
    console.log('Pass --limit N, or --ids a,b,c (org ids).');
    db.close(); return;
  }

  const orgs = orgIds.map((id) => db.prepare('SELECT id, name, domain FROM orgs WHERE id = ?').get(id)).filter(Boolean);
  const runId = startRun(db, 'plans', { model: cfg.models.default, notes: `${orgs.length} public bodies` });
  console.log(heading(`plans · ${orgs.length} public bod${orgs.length === 1 ? 'y' : 'ies'} · their own published plan, quotes checked`));

  const system = promptBody(PROMPT);
  const answers = await Promise.all(orgs.map((o) => complete(db, runId, {
    model: cfg.models.default, effort: 'low', maxTokens: 6000, schema: SCHEMA, system,
    tools: [{ type: 'web_search_20260209', name: 'web_search', blocked_domains: BLOCKED, max_uses: 5 }],
    messages: [{ role: 'user', content: `PUBLIC BODY: ${o.name}${o.domain ? `\nWEBSITE: ${o.domain}` : ''}\n\n`
      + 'Find its current published plan and the AI lines in it.' }],
  }).catch((error) => ({ error }))));

  const insRead = db.prepare(`INSERT INTO plan_reads (org_id, checked_at, plan_url, plan_title, plan_date, ai_lines, outcome, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insEv = db.prepare(`INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance, body)
    VALUES (?, NULL, 'filing', ?, ?, ?, 'retrieved', ?) RETURNING id`);
  const insSig = db.prepare(`INSERT INTO signals (org_id, trigger_id, detected_at, decays_at, weight, evidence_id)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, trigger_id, evidence_id) DO NOTHING`);

  const tally = {};
  const signalled = [];
  for (const [i, o] of orgs.entries()) {
    process.stdout.write(`  ${truncate(o.name, 40).padEnd(41)}`);
    const now = new Date().toISOString();
    const record = (outcome, d = {}, n = 0) => {
      tally[outcome] = (tally[outcome] ?? 0) + 1;
      if (!dry) insRead.run(o.id, now, d.url || null, d.title || null, planDate(d.date), n, outcome, runId);
    };
    const res = answers[i];
    if (res.error) { console.log(dim(`failed: ${truncate(res.error.message, 70)}`)); continue; }
    const d = res.data ?? {};
    if (!d.found || !/^https?:\/\//.test(d.url ?? '') || blocked(d.url)) { console.log(dim('no plan found')); record('no_plan'); continue; }
    if (!(d.lines ?? []).length) { console.log(dim(`plan, no AI lines · ${truncate(d.title, 50)}`)); record('no_ai_lines', d); continue; }

    const doc = await documentText(d.url);
    if (doc.error) { console.log(dim(`plan unreadable (${truncate(doc.error, 50)})`)); record('unreadable', d); continue; }
    const kept = d.lines.filter((l) => quoteInText(l.quote, doc.text));
    const dropped = d.lines.length - kept.length;
    if (!kept.length) { console.log(dim(`${d.lines.length} line(s), none found in the document`)); record('unverified', d); continue; }

    const on = planDate(d.date);
    console.log(`${bold(`${kept.length} AI line(s)`)} ${dim(`${on ?? 'undated'} · ${truncate(d.title, 40)}${dropped ? ` · ${dropped} dropped` : ''}`)}`);
    for (const l of kept) console.log(dim(`      ${truncate(`${l.what}: "${l.quote}"`, 110)}`));
    if (dry) { tally.signal = (tally.signal ?? 0) + 1; continue; }

    const claim = `${o.name}'s own plan, "${truncate(d.title, 120)}"${on ? ` (${on})` : d.covers ? ` (covers ${d.covers})` : ''}, `
      + `commits to AI work: ${kept.map((l) => l.what).join('; ')}.`;
    const body = [`${d.title} — ${doc.url}`, `published: ${d.date || 'not given'}${d.covers ? ` · covers ${d.covers}` : ''}`,
      `each line below was found verbatim in the document on ${now.slice(0, 10)}`, '',
      ...kept.map((l) => `- ${l.what}: "${l.quote}"`)].join('\n');
    const ev = insEv.get(o.id, truncate(claim, 600), doc.url, now, body).id;
    // A TRIGGER WITHOUT A DATE IS NOT A TRIGGER (news.mjs). An undated plan is
    // kept as evidence for the judge and the drafter, and fires nothing.
    if (!on) { record('undated', d, kept.length); continue; }
    const decays = new Date(Date.parse(on) + (trig.decay_days ?? 730) * 86_400_000).toISOString().slice(0, 10);
    if (decays < now.slice(0, 10)) { record('stale', d, kept.length); continue; }
    insSig.run(o.id, TRIGGER, on, decays, trig.weight ?? 3, ev);
    record('signal', d, kept.length);
    signalled.push(o.id);
  }

  finishRun(db, runId, { n_in: orgs.length, n_out: signalled.length });
  const cost = db.prepare('SELECT ROUND(SUM(cost_usd), 3) c FROM llm_calls WHERE run_id = ?').get(runId)?.c ?? 0;
  const nSig = dry ? (tally.signal ?? 0) : signalled.length;
  console.log(heading(`${nSig} of ${orgs.length} with ${dry ? 'verified AI lines (dry: nothing stored)' : 'a dated AI plan'} · $${cost}`));
  console.log(dim(`  ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(' · ')}`));

  // JUDGED AGAIN: everyone rated at a body that now has a signal.
  if (signalled.length && !flag('no-judge')) {
    const pids = db.prepare(`SELECT DISTINCT j.person_id FROM judgments j JOIN people p ON p.id = j.person_id
        WHERE p.org_id IN (${signalled.map(() => '?').join(',')})
          AND NOT EXISTS (SELECT 1 FROM outreach x WHERE x.person_id = p.id)`).all(...signalled).map((r) => r.person_id);
    if (pids.length) {
      console.log(dim(`  judging ${pids.length} again with the plan on file`));
      execFileSync('npm', ['run', '--silent', 'judge', '--', '--ids', pids.join(',')], { cwd: ROOT, stdio: 'inherit' });
    }
  }
  db.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
