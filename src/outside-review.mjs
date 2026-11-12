// An outside review of the whole system by models from other makers.
//
// WHY THIS EXISTS. The system is built and revised by one model, and a run of
// small revisions can move it away from optimal without any one of them looking
// wrong: on 2026-11-12 a replay found eleven drafting-prompt versions made no
// measurable difference to how close drafts came to what the operator sent. A
// reviewer from another maker is not anchored on those choices. The operator
// asked for one now and quarterly after that.
//
// WHAT THEY GET. One packet, the same for each reviewer: the docs, every prompt,
// the operator's config, the header comment of every source file (what it does
// and why, not its code), the funnel and cost numbers, and the last N days of
// outreach as drafted, as sent, and what happened. Email addresses and phone
// numbers are taken out; names are not, at the operator's call (2026-11-12):
// they are public and already go to the model that builds this. Every call goes
// through OpenRouter to zero-data-retention endpoints only (openrouter.mjs).
//
// WHAT HAPPENS TO THEIR ADVICE. Nothing automatic. A suggestion is adopted only
// if it removes something, or a replay or the outcome numbers show a gain.
// Reports land in data/reviews/.
//
// Usage:
//   npm run review -- [--days 60] [--models a,b] [--packet-only]

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete, promptBody } from './models.mjs';
import { ratingOf } from './measures.mjs';
import { heading, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT = 'prompts/outside-review.md';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const scrub = (s) => String(s ?? '')
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  .replace(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]');

/** The leading comment block of a source file: what it does and why. */
function header(rel) {
  const out = [];
  for (const line of read(rel).split('\n')) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line) || (!line.trim() && out.length)) out.push(line);
    else if (out.length || line.trim()) break;
    if (out.length >= 80) break;
  }
  return out.join('\n').trim();
}

function files(dir, ext) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : []));
}

function numbers(db, since) {
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  const table = (rs) => (rs.length ? [Object.keys(rs[0]).join(' | '), ...rs.map((r) => Object.values(r).join(' | '))].join('\n') : '(none)');
  return [
    `### Outreach by channel and outcome since ${since}`,
    table(rows(`SELECT o.channel, COUNT(*) sent,
        SUM(EXISTS(SELECT 1 FROM responses r WHERE r.outreach_id = o.id AND r.sentiment = 'accepted')) accepted,
        SUM(EXISTS(SELECT 1 FROM responses r WHERE r.outreach_id = o.id AND r.sentiment = 'positive')) positive,
        SUM(EXISTS(SELECT 1 FROM responses r WHERE r.outreach_id = o.id AND r.sentiment IN ('negative','neutral'))) other_reply,
        SUM(EXISTS(SELECT 1 FROM responses r WHERE r.outreach_id = o.id AND r.sentiment = 'bounced')) bounced
       FROM outreach o WHERE o.sent_at >= ? GROUP BY 1 ORDER BY 2 DESC`, since)),
    '\n### Outreach, all time, by month',
    table(rows(`SELECT substr(o.sent_at, 1, 7) month, COUNT(*) sent,
        SUM(EXISTS(SELECT 1 FROM responses r WHERE r.outreach_id = o.id AND r.sentiment = 'positive')) positive
       FROM outreach o GROUP BY 1 ORDER BY 1`)),
    `\n### Model spend by stage and model since ${since}`,
    table(rows(`SELECT stage, model, COUNT(*) calls, ROUND(SUM(cost_usd), 2) usd
       FROM llm_calls WHERE at >= ? GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 40`, since)),
    '\n### People and firms on file',
    table(rows(`SELECT (SELECT COUNT(*) FROM people) people, (SELECT COUNT(*) FROM orgs) firms,
        (SELECT COUNT(DISTINCT person_id) FROM judgments) judged, (SELECT COUNT(*) FROM drafts) drafts`)),
  ].join('\n');
}

function outreachHistory(db, since) {
  const rows = db.prepare(`SELECT o.id, o.person_id, o.channel, substr(o.sent_at, 1, 10) sent_at, o.service_pitched,
        o.subject, o.message_text, p.title, g.name org, g.kind,
        (SELECT d.body FROM drafts d WHERE d.person_id = o.person_id AND d.channel = o.channel
          AND d.created_at <= o.sent_at || 'T23:59' ORDER BY d.id DESC LIMIT 1) drafted,
        (SELECT group_concat(r.sentiment || COALESCE(': ' || r.outcome, ''), '; ') FROM responses r
          WHERE r.outreach_id = o.id) outcome
       FROM outreach o JOIN people p ON p.id = o.person_id LEFT JOIN orgs g ON g.id = o.org_id
      WHERE o.sent_at >= ? ORDER BY o.sent_at DESC`).all(since);
  const judgments = db.prepare(`SELECT verdict, compelling, target, reason FROM judgments j
      WHERE person_id = ? AND batch = (SELECT batch FROM judgments WHERE person_id = j.person_id
        AND created_at <= ? ORDER BY id DESC LIMIT 1)`);
  return rows.map((r) => {
    const js = judgments.all(r.person_id, `${r.sent_at}T23:59`);
    const draftNote = r.drafted ? String(r.drafted).split(/^NOTES\s*$/m)[0]
      .replace(/^OFFER\s*\n-+\n.*\n/m, '').trim() : '(no draft on file)';
    return [`### Outreach #${r.id} · ${r.channel} · ${r.sent_at}`,
      `To: ${r.title ?? '?'} at ${r.org ?? '?'} (${r.kind ?? '?'}) · offer: ${r.service_pitched ?? '?'}`,
      js.length ? `Judge's rating when sent: ${ratingOf(js)} of 5, target "${js[0].target ?? ''}": ${js[0].reason ?? ''}` : '',
      `Outcome: ${r.outcome ?? 'no response recorded'}`,
      r.subject ? `Subject: ${r.subject}` : '',
      `\nAs drafted:\n${draftNote}`,
      `\nAs sent:\n${r.message_text ?? '(not recorded)'}`].filter(Boolean).join('\n');
  }).join('\n\n');
}

function packet(db, days) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const docs = ['README.md', ...files('docs', '.md').filter((f) => !f.includes('/private/') && !f.includes('/writeups/'))];
  const prompts = files('prompts', '.md').filter((f) => !f.endsWith('.example.md') && !f.endsWith('outside-review.md'));
  // The operator's own config, not the public templates. sectors.yml is a large
  // catalogue of industries and adds little a reviewer can act on.
  const config = files('config', '.yml').filter((f) => !f.endsWith('.example.yml') && !f.endsWith('sectors.yml'));
  const src = files('src', '.mjs');
  const part = (title, list, body) => `\n\n# ${title}\n\n${list.map((f) => `## ${f}\n\n${body(f)}`).join('\n\n')}`;
  return scrub([
    `# Packet for outside review, ${new Date().toISOString().slice(0, 10)}`,
    part('Docs', docs, read),
    part('Prompts', prompts, read),
    part('Configuration (the operator\'s own)', config, read),
    part('Source files: header comments only', src, header),
    `\n\n# Numbers\n\n${numbers(db, since)}`,
    `\n\n# Outreach since ${since}: as drafted, as sent, and what happened\n\n${outreachHistory(db, since)}`,
  ].join(''));
}

async function main() {
  const cfg = loadConfig();
  const days = Number(arg('days', 60));
  const models = String(arg('models', (cfg.models.reviewers ?? []).join(','))).split(',').filter(Boolean);
  const db = openDb();
  const text = packet(db, days);
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = resolve(ROOT, 'data/reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}-packet.md`), text);
  console.log(dim(`  packet: ${Math.round(text.length / 1000)}k characters, about ${Math.round(text.length / 4000)}k tokens`));
  if (process.argv.includes('--packet-only')) return;
  if (!models.length) throw new Error('no reviewers: set models.reviewers in config/runtime.yml or pass --models');

  console.log(heading(`OUTSIDE REVIEW: ${models.join(', ')}`));
  const runId = startRun(db, 'outside-review', { model: models.join(' '), notes: `${days} days` });
  let total = 0;
  await Promise.all(models.map(async (model) => {
    try {
      const r = await complete(db, runId, { model, system: promptBody(PROMPT), maxTokens: 32000, effort: 'high',  // 16000 cut one report off mid-list (2026-11-12)
        messages: [{ role: 'user', content: text }] });
      total += r.cost_usd ?? 0;
      const file = join(dir, `${stamp}-${model.replace(/[^\w.-]+/g, '_')}.md`);
      writeFileSync(file, `# Outside review by ${model}, ${stamp}\n\n${r.text}\n`);
      console.log(`  ${model}: $${(r.cost_usd ?? 0).toFixed(2)} · ${file}`);
    } catch (e) { console.log(`  ${model} FAILED: ${e.message}`); }
  }));
  finishRun(db, runId, { cost_usd: total });
  console.log(dim(`  total $${total.toFixed(2)}`));
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
