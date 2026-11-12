// A blind review of sent connection notes against each reader: their own words,
// their role's goal, and their firm. Outcomes are hidden from the reviewers and
// joined afterwards, to see whether alignment is what gets notes accepted.
//
// WHY (2026-11-12). The first outside review (outside-review.mjs) compared what
// was drafted with what was sent, and could not say whether a note fitted the
// person, because its packet held no prospect's words. The operator asked for
// a review that could. If the grades track accepts, alignment becomes the
// drafter's target instead of closeness to what he sent.
//
// The sample: connection notes sent in a window old enough for accepts to have
// arrived; every accepted one and an equal number, chosen at random with a fixed
// seed, that were not. Reviewers are the outside models in models.reviewers,
// through OpenRouter's zero-retention endpoints. Results go to data/reviews/.
//
// Usage:
//   npm run alignment -- [--from 2026-10-13] [--to 2026-11-05] [--batch 8] [--models a,b] [--packet-only]

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { loadBusiness } from './business.mjs';
import { complete, promptBody } from './models.mjs';
import { heading, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT = 'prompts/alignment-review.md';
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const scrub = (s) => String(s ?? '').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  .replace(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]');

/** The person's own part of a pasted profile: About onward, without the page chrome. */
function ownWords(body, max = 3500) {
  const t = String(body ?? '');
  // From the profile's own header (after the site's navigation) to where the
  // page's suggestions and footer begin. A bare "About" also names a footer link.
  const start = Math.max(0, t.search(/Cover photo|\n\s*Contact info\s*\n/));
  const ends = [/\n\s*More profiles for you\s*\n/, /\n\s*People you may know\s*\n/, /\n\s*Explore Premium profiles\s*\n/,
    /\n\s*Accessibility\s*\n/].map((re) => { const i = t.slice(start).search(re); return i < 0 ? Infinity : start + i; });
  const end = Math.min(...ends);
  return t.slice(start, Number.isFinite(end) ? end : undefined).replace(/\n{3,}/g, '\n\n').slice(0, max).trim();
}

// A tiny seeded shuffle, so the sample is the same on a rerun.
function shuffle(xs, seed = 7) {
  const a = [...xs]; let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function sample(db, from, to) {
  const rows = db.prepare(`SELECT o.id, o.person_id, o.org_id, o.sent_at, o.message_text,
      EXISTS(SELECT 1 FROM responses r WHERE r.outreach_id = o.id AND r.sentiment = 'accepted') accepted,
      EXISTS(SELECT 1 FROM responses r WHERE r.outreach_id = o.id AND r.sentiment IN ('positive','neutral','negative')) replied
    FROM outreach o WHERE o.channel = 'linkedin_connect_note' AND o.sent_at BETWEEN ? AND ?
      AND o.message_text IS NOT NULL`).all(from, to);
  const yes = rows.filter((r) => r.accepted || r.replied);
  const no = shuffle(rows.filter((r) => !r.accepted && !r.replied)).slice(0, yes.length);
  return shuffle([...yes, ...no], 11);
}

function card(db, o, i) {
  const p = db.prepare('SELECT name, title, location FROM people WHERE id = ?').get(o.person_id) ?? {};
  const g = db.prepare('SELECT name, kind, industry, headcount_est, hq FROM orgs WHERE id = ?').get(o.org_id) ?? {};
  const firm = db.prepare(`SELECT claim FROM evidence WHERE org_id = ? AND person_id IS NULL
      AND retrieved_at <= ? ORDER BY id DESC LIMIT 4`).all(o.org_id, `${o.sent_at}T23:59`).map((r) => `- ${r.claim}`);
  const prof = db.prepare(`SELECT body FROM evidence WHERE person_id = ? AND kind = 'operator_profile'
      AND body IS NOT NULL AND retrieved_at <= ? ORDER BY id DESC LIMIT 1`).get(o.person_id, `${o.sent_at}T23:59`);
  const facts = db.prepare(`SELECT claim FROM evidence WHERE person_id = ? AND kind <> 'operator_profile'
      AND retrieved_at <= ? ORDER BY id DESC LIMIT 8`).all(o.person_id, `${o.sent_at}T23:59`).map((r) => `- ${r.claim}`);
  const read = db.prepare(`SELECT trying_to_do, in_the_way, next_step FROM reads WHERE person_id = ?
      AND rejected_at IS NULL AND created_at <= ? ORDER BY id DESC LIMIT 1`).get(o.person_id, `${o.sent_at}T23:59`);
  return [`## Note ${i + 1} (id ${o.id}), sent ${String(o.sent_at).slice(0, 10)}`,
    `Recipient: ${p.title ?? '?'} at ${g.name ?? '?'} (${g.kind ?? '?'}${g.headcount_est ? `, ~${g.headcount_est} people` : ''}${g.hq ? `, ${g.hq}` : ''})`,
    g.industry ? `Firm: ${g.industry}` : '',
    firm.length ? `What is on file about the firm:\n${firm.join('\n')}` : '',
    prof ? `Their own profile, as the operator pasted it:\n${ownWords(prof.body)}` : 'No pasted profile.',
    facts.length ? `Facts about them:\n${facts.join('\n')}` : '',
    read ? `An earlier reading of them: trying to do: ${read.trying_to_do ?? ''} In the way: ${read.in_the_way ?? ''} Next step: ${read.next_step ?? ''}` : '',
    `THE NOTE AS SENT:\n${o.message_text}`].filter(Boolean).join('\n\n');
}

const NOTE = { type: 'object', additionalProperties: false,
  required: ['id', 'their_words', 'role_goal', 'firm_fit', 'credible', 'clear_why', 'misses', 'rewrite'],
  properties: { id: { type: 'integer' }, their_words: { type: 'integer' }, role_goal: { type: 'integer' },
    firm_fit: { type: 'integer' }, credible: { type: 'integer' }, clear_why: { type: 'integer' },
    misses: { type: 'string' }, rewrite: { type: 'string' } } };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['notes', 'patterns'],
  properties: { notes: { type: 'array', items: NOTE }, patterns: { type: 'array', items: { type: 'string' } } } };
const DIMS = ['their_words', 'role_goal', 'firm_fit', 'credible', 'clear_why'];

async function main() {
  const cfg = loadConfig();
  const b = loadBusiness(cfg);
  const from = arg('from', '2026-10-13'); const to = arg('to', '2026-11-05');
  const per = Number(arg('batch', 8));
  const models = String(arg('models', (cfg.models.reviewers ?? []).join(','))).split(',').filter(Boolean);
  const db = openDb();
  const picks = sample(db, from, to);
  const operator = `# The operator\n\n${(b.offers ?? []).map((o) => `- Offer: ${o.name}${o.price ? ` (${o.price})` : ''}`).join('\n')}\n`
    + `${(cfg.operator?.credentials ?? []).map((c) => `- ${c}`).join('\n')}\n\nTargets:\n`
    + `${(b.targets ?? []).map((t) => `- ${t.name}`).join('\n')}`;
  const batches = [];
  for (let i = 0; i < picks.length; i += per) batches.push(picks.slice(i, i + per));
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = resolve(ROOT, 'data/reviews'); mkdirSync(dir, { recursive: true });
  const packets = batches.map((bt) => scrub(`${operator}\n\n${bt.map((o) => card(db, o, picks.indexOf(o))).join('\n\n---\n\n')}`));
  writeFileSync(join(dir, `${stamp}-alignment-packet.md`), packets.join('\n\n=====\n\n'));
  console.log(heading(`ALIGNMENT REVIEW: ${picks.length} connection notes sent ${from} to ${to}`));
  console.log(dim(`  ${picks.filter((o) => o.accepted || o.replied).length} accepted or answered, ${picks.filter((o) => !o.accepted && !o.replied).length} not; `
    + `${batches.length} batches; packet ${Math.round(packets.join('').length / 4000)}k tokens`));
  if (process.argv.includes('--packet-only')) return;

  const runId = startRun(db, 'alignment-review', { model: models.join(' '), notes: `${from}..${to}` });
  const results = {}; let cost = 0;
  await Promise.all(models.map(async (model) => {
    results[model] = { notes: [], patterns: [] };
    for (const [i, packet] of packets.entries()) {
      try {
        const r = await complete(db, runId, { model, system: promptBody(PROMPT), schema: SCHEMA, maxTokens: 16000,
          effort: 'high', messages: [{ role: 'user', content: packet }] });
        cost += r.cost_usd ?? 0;
        results[model].notes.push(...(r.data?.notes ?? []));
        results[model].patterns.push(...(r.data?.patterns ?? []));
        console.log(dim(`  ${model} batch ${i + 1}/${packets.length}: ${r.data?.notes?.length ?? 0} notes, $${(r.cost_usd ?? 0).toFixed(2)}`));
      } catch (e) { console.log(`  ${model} batch ${i + 1} FAILED: ${e.message}`); }
    }
  }));
  finishRun(db, runId, { cost_usd: cost });

  // THE JOIN: grades against outcomes the reviewers never saw.
  const out = new Map(picks.map((o) => [o.id, o]));
  const mean = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : NaN);
  console.log(heading('Mean grade, accepted or answered vs not (reviewers blind to outcome)'));
  for (const model of models) {
    const rows = results[model].notes.filter((n) => out.has(n.id));
    console.log(`  ${model} (${rows.length} graded)`);
    for (const d of [...DIMS, 'total']) {
      const val = (n) => (d === 'total' ? DIMS.reduce((a, k) => a + n[k], 0) / DIMS.length : n[d]);
      const yes = rows.filter((n) => out.get(n.id).accepted || out.get(n.id).replied).map(val);
      const no = rows.filter((n) => !out.get(n.id).accepted && !out.get(n.id).replied).map(val);
      console.log(`    ${d.padEnd(12)} worked ${mean(yes).toFixed(2)}  did not ${mean(no).toFixed(2)}`);
    }
  }
  const file = join(dir, `${stamp}-alignment.json`);
  writeFileSync(file, JSON.stringify({ from, to, picks: picks.map((o) => ({ id: o.id, accepted: !!o.accepted, replied: !!o.replied })), results }, null, 2));
  console.log(dim(`\n  cost $${cost.toFixed(2)} · ${file}`));
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
