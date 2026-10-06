// A third-party summary of a person from across the web, so fewer profiles have
// to be pasted by hand.
//
// WHY THIS EXISTS. The operator, 2026-10-06, after pasting a search engine's AI
// answer about a prospect: "i want to use google AI or similar to get a 3rd party
// summary of that person". A pasted profile is his slowest step, and a rating-3
// card is usually missing what a web summary has: their career, their remit,
// and a podcast or interview where they talked about AI. `bio` reads only the
// person's own organisation's page; this reads what everyone else says.
//
// HOW. One Claude call per person with Anthropic's web search tool, several
// searches each (prompts/research-person.md). Each fact comes back with the
// page it came from and a verbatim quote, and is stored as retrieved evidence
// on the person, with the summary beside them. The people found are judged
// again, so a card's rating reflects what was found.
//
// NEVER LINKEDIN. linkedin.com is blocked at the search tool, so no search can
// return it, and any fact whose page is on it is dropped here as well. The
// operator may paste what he reads there himself; this stage does not go
// looking (CLAUDE.md, guardrails).
//
// A person researched in the last 30 days is skipped unless named with --ids.
//
// Usage:
//   npm run research -- --rating 3 [--limit 20]   Ready cards rated 3 with no pasted profile
//   npm run research -- --min 3 [--limit 20]      rated 3 and up, best first (the morning run)
//   npm run research -- --ids a,b,c               these people
//   npm run research -- ... --dry                 find and print, store nothing
//   npm run research -- ... --no-judge            do not re-judge afterwards

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete, promptBody } from './models.mjs';
import { ratingOf } from './measures.mjs';
import { heading, bold, dim, truncate } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT = 'prompts/research-person.md';
const BLOCKED = ['linkedin.com', 'lnkd.in'];

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['found', 'summary', 'facts'],
  properties: {
    found: { type: 'boolean' },
    summary: { type: 'string', description: 'Three to five plain sentences, or "".' },
    facts: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['claim', 'quote', 'url', 'date', 'kind'],
      properties: {
        claim: { type: 'string' },
        quote: { type: 'string', description: 'Verbatim from the page.' },
        url: { type: 'string', description: 'The page the fact came from.' },
        date: { type: 'string', description: 'When it happened or was published, as the page gives it, or "".' },
        kind: { type: 'string', enum: ['said', 'remit', 'career', 'recent', 'other'] },
      } } },
  },
};

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const val = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const dry = flag('dry');

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const blocked = (u) => { const h = hostOf(u); return !h || BLOCKED.some((b) => h === b || h.endsWith(`.${b}`)); };

const cfg = loadConfig();
const db = openDb();

/** The latest rating of each judged person, on the 1-5 scale. */
function latestRating(personId) {
  const batch = db.prepare('SELECT batch FROM judgments WHERE person_id = ? ORDER BY id DESC LIMIT 1').get(personId)?.batch;
  if (!batch) return null;
  return ratingOf(db.prepare('SELECT verdict, compelling FROM judgments WHERE batch = ?').all(batch)
    .map((j) => ({ ...j, compelling: j.compelling == null ? null : Number(j.compelling) })));
}

let ids;
if (val('ids')) ids = val('ids').split(',').map((x) => x.trim()).filter(Boolean);
else if (val('rating') || val('min')) {
  // --rating N: exactly N. --min N: N and up, best first (the morning run).
  const want = val('rating') ? Number(val('rating')) : null;
  const min = val('min') ? Number(val('min')) : null;
  // Judged, not written to, not ruled out, no pasted profile, not researched lately.
  const cands = db.prepare(`SELECT DISTINCT j.person_id FROM judgments j
     WHERE NOT EXISTS (SELECT 1 FROM outreach o WHERE o.person_id = j.person_id)
       AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = j.person_id AND e.kind = 'operator_profile')
       AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = j.person_id AND e.kind = 'web_summary'
                       AND e.retrieved_at >= datetime('now', '-30 days'))
       AND COALESCE((SELECT v.verdict FROM verdicts v WHERE v.person_id = j.person_id ORDER BY v.id DESC LIMIT 1), '') <> 'skip'`)
    .all().map((r) => r.person_id);
  ids = cands.map((id) => ({ id, r: latestRating(id) }))
    .filter((x) => x.r != null && (want != null ? x.r === want : x.r >= min))
    .sort((a, b) => b.r - a.r).map((x) => x.id).slice(0, Number(val('limit') ?? 20));
} else {
  console.log('Pass --rating N or --min N [--limit N], or --ids a,b,c.');
  process.exit(0);
}

const runId = startRun(db, 'research', { model: cfg.models.default, notes: `${ids.length} people` });
console.log(heading(`research · ${ids.length} person(s) · the web, LinkedIn blocked`));

const people = ids.map((id) => db.prepare(`SELECT p.id, p.name, p.title, p.org_id, o.name org, o.domain
    FROM people p JOIN orgs o ON o.id = p.org_id WHERE p.id = ?`).get(id)).filter(Boolean);
const system = promptBody(PROMPT);

// Every search at once; with CLAUDE_BATCH=1 they go as one batch at half price.
const answers = await Promise.all(people.map((p) => complete(db, runId, {
  model: cfg.models.default, effort: 'low', maxTokens: 6000, schema: SCHEMA, system,
  tools: [{ type: 'web_search_20260209', name: 'web_search', blocked_domains: BLOCKED, max_uses: 5 }],
  messages: [{ role: 'user', content: `PERSON: ${p.name}\nTITLE ON FILE: ${p.title ?? 'unknown'}\n`
    + `ORGANISATION: ${p.org}${p.domain ? ` (${p.domain})` : ''}\n\nResearch this person.` }],
}).catch((error) => ({ error }))));

const insEv = db.prepare(`INSERT OR IGNORE INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance, body)
  VALUES (?, ?, ?, ?, ?, ?, 'retrieved', ?)`);
const found = [];
for (const [i, p] of people.entries()) {
  process.stdout.write(`  ${truncate(p.name, 26).padEnd(27)}`);
  const res = answers[i];
  if (res.error) { console.log(dim(`failed: ${truncate(res.error.message, 80)}`)); continue; }
  const d = res.data ?? {};
  // A returned URL is a claim; the host is checked before anything is stored.
  const facts = (d.facts ?? []).filter((f) => /^https?:\/\//.test(f.url ?? '') && !blocked(f.url) && (f.quote ?? '').trim());
  const dropped = (d.facts ?? []).length - facts.length;
  if (!d.found || facts.length < 2) {
    console.log(dim(`little found${dropped ? ` (${dropped} fact(s) without a usable page dropped)` : ''}`));
    continue;
  }
  const said = facts.filter((f) => f.kind === 'said').length;
  console.log(`${bold(`${facts.length} facts`)}${said ? `, ${said} in their own words` : ''} `
    + dim(`from ${new Set(facts.map((f) => hostOf(f.url))).size} sites${dropped ? ` · ${dropped} dropped` : ''}`));
  if (dry) { for (const f of facts) console.log(dim(`      ${truncate(`${f.claim} (${hostOf(f.url)})`, 100)}`)); continue; }
  const now = new Date().toISOString();
  const body = [`${p.name}, ${p.title ?? ''} — web summary retrieved ${now.slice(0, 10)}`, '', d.summary, '',
    ...facts.map((f) => `- ${f.claim}${f.date ? ` (${f.date})` : ''} — "${f.quote}" ${f.url}`)].join('\n');
  insEv.run(p.org_id, p.id, 'web_summary', `Web summary of ${p.name}: ${truncate(d.summary, 400)}`, facts[0].url, now, body);
  for (const f of facts) {
    insEv.run(p.org_id, p.id, f.kind === 'said' ? 'web_said' : 'web_fact',
      `${f.claim}${f.date ? ` (${f.date})` : ''} — "${truncate(f.quote, 240)}"`, f.url, now, null);
  }
  found.push(p.id);
}

finishRun(db, runId, { n_in: people.length, n_out: found.length });
const cost = db.prepare('SELECT ROUND(SUM(cost_usd), 3) c FROM llm_calls WHERE run_id = ?').get(runId)?.c ?? 0;
console.log(heading(`${found.length} of ${people.length} researched · $${cost}`));

// JUDGED AGAIN, so the card's rating reflects what was found.
if (found.length && !dry && !flag('no-judge')) {
  console.log(dim(`  judging ${found.length} again with what was found`));
  execFileSync('npm', ['run', '--silent', 'judge', '--', '--ids', found.join(',')], { cwd: ROOT, stdio: 'inherit' });
}
if (found.length) console.log(`FOUND ${found.join(',')}`);
db.close();
