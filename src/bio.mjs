// A person's official bio, from their organisation's own site or a conference
// they spoke at, so fewer profiles have to be pasted by hand.
//
// WHY THIS EXISTS. A draft waits for a profile, and pasting one is the
// operator's slowest step: about twenty a morning, mostly public-sector leaders
// whose agencies publish a bio page anyway. Added 2026-10-05.
//
// HOW. For each person: find the organisation's own website if none is on file
// (`lead domains`, which checks the page names the firm); then one web search
// limited to that site and the site of the conference they spoke at, asking for
// this person's bio (prompts/find-person-bio.md). The page the facts came from
// must be on one of those domains, or nothing is stored. Each fact is kept with
// a verbatim quote and its URL, as retrieved evidence on the person.
//
// NEVER LINKEDIN. The search is restricted to the domains named, which are the
// organisation's and the conference's, so it cannot reach LinkedIn.
//
// A miss is remembered (bio_lookups) and not retried for 30 days; the person
// stays on the paste list.
//
// Usage:
//   npm run bio -- --paste-list [--limit 20]    the people the Ready page asks to paste
//   npm run bio -- --ids a,b,c                  these people
//   npm run bio -- ... --dry                    find and print, store nothing
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete, promptBody } from './models.mjs';
import { pasteQueue } from './funnel.mjs';
import { heading, bold, dim, truncate } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT = 'prompts/find-person-bio.md';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['found', 'url', 'title_on_page', 'mismatch', 'facts'],
  properties: {
    found: { type: 'boolean' },
    url: { type: 'string', description: 'The page the facts came from, or "".' },
    title_on_page: { type: 'string', description: 'Their title as the page gives it, or "".' },
    mismatch: { type: 'string', description: 'If the page names a different title or employer, what it says; "" otherwise.' },
    facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'quote'],
      properties: { claim: { type: 'string' }, quote: { type: 'string', description: 'Verbatim from the page.' } } } },
  },
};

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const val = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const dry = flag('dry');

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const onDomains = (url, domains) => {
  const h = hostOf(url);
  return Boolean(h) && domains.some((d) => h === d || h.endsWith(`.${d}`));
};

const cfg = loadConfig();
const db = openDb();
db.exec(`CREATE TABLE IF NOT EXISTS bio_lookups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL, at TEXT NOT NULL,
  found INTEGER NOT NULL, url TEXT, note TEXT, run_id INTEGER)`);

let ids;
if (val('ids')) ids = val('ids').split(',').map((x) => x.trim()).filter(Boolean);
else if (flag('paste-list')) {
  const recent = new Set(db.prepare(`SELECT person_id FROM bio_lookups WHERE at >= datetime('now', '-30 days')`).all()
    .map((r) => r.person_id));
  ids = pasteQueue(db, 200).map((p) => p.person_id).filter((id) => !recent.has(id)).slice(0, Number(val('limit') ?? 20));
} else {
  console.log('Pass --paste-list [--limit N] or --ids a,b,c.');
  process.exit(0);
}
if (!ids.length) { console.log('nobody to look up'); process.exit(0); }

console.log(heading(`bio · ${ids.length} person(s) · own site and conference site only${dry ? ' · dry run' : ''}`));
const runId = startRun(db, 'bio', { model: cfg.models.default });
const system = promptBody(PROMPT);
const insEv = db.prepare(`INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance, body)
  VALUES (?, ?, ?, ?, ?, ?, 'retrieved', ?) ON CONFLICT(org_id, kind, source_url, claim) DO NOTHING`);
const logLookup = db.prepare('INSERT INTO bio_lookups (person_id, at, found, url, note, run_id) VALUES (?, ?, ?, ?, ?, ?)');
const found = [];

for (const id of ids) {
  const p = db.prepare('SELECT p.id, p.name, p.title, p.org_id, o.name org, o.domain FROM people p JOIN orgs o ON o.id = p.org_id WHERE p.id = ?').get(id);
  if (!p) continue;
  process.stdout.write(`  ${truncate(p.name, 26).padEnd(27)}`);
  let domain = (p.domain ?? '').trim();
  if (!domain && !dry) {
    // The organisation's own site, found and checked by the existing step.
    try { execFileSync('npm', ['run', '--silent', 'lead', '--', 'domains', '--org', p.org_id], { cwd: ROOT, encoding: 'utf8' }); } catch { /* reported below */ }
    domain = (db.prepare('SELECT domain FROM orgs WHERE id = ?').get(p.org_id)?.domain ?? '').trim();
  }
  const conf = db.prepare(`SELECT source_url FROM evidence WHERE person_id = ? AND kind = 'announcement'
      AND provenance = 'retrieved' ORDER BY retrieved_at DESC LIMIT 1`).get(p.id)?.source_url;
  const domains = [...new Set([domain.replace(/^www\./, '').toLowerCase(), hostOf(conf)].filter(Boolean))];
  if (!domains.length) {
    console.log(dim('no site on file and none found'));
    if (!dry) logLookup.run(p.id, new Date().toISOString(), 0, null, 'no domain', runId);
    continue;
  }
  let res;
  try {
    res = await complete(db, runId, { model: cfg.models.default, effort: 'low', maxTokens: 4000, schema: SCHEMA, system,
      tools: [{ type: 'web_search_20260209', name: 'web_search', allowed_domains: domains, max_uses: 3 }],
      messages: [{ role: 'user', content: `PERSON: ${p.name}\nTITLE ON FILE: ${p.title ?? 'unknown'}\n`
        + `ORGANISATION: ${p.org}\nSEARCH ONLY: ${domains.join(', ')}\n\nFind this person's own bio on these domains.` }] });
  } catch (e) {
    console.log(dim(`failed: ${truncate(e.message, 80)}`));
    continue;
  }
  const d = res.data ?? {};
  const now = new Date().toISOString();
  // THREE FACTS OR IT IS NOT A BIO. A title and a session name is what the
  // agenda already said; it gives a draft nothing, so the person stays on the
  // paste list.
  if (!d.found || !d.url || (d.facts ?? []).length < 3) {
    console.log(dim(`no bio on ${domains.join(', ')}`));
    if (!dry) logLookup.run(p.id, now, 0, null, 'not found', runId);
    continue;
  }
  // A returned URL is a claim; the host is checked before anything is stored.
  if (!onDomains(d.url, domains)) {
    console.log(dim(`off-domain, rejected: ${truncate(d.url, 50)}`));
    if (!dry) logLookup.run(p.id, now, 0, d.url, 'off-domain', runId);
    continue;
  }
  if (d.mismatch) {
    console.log(dim(`page disagrees, not stored: ${truncate(d.mismatch, 70)}`));
    if (!dry) logLookup.run(p.id, now, 0, d.url, `mismatch: ${d.mismatch}`, runId);
    continue;
  }
  console.log(`${bold(`${d.facts.length} facts`)} ${dim(hostOf(d.url))}`);
  if (dry) { for (const f of d.facts) console.log(dim(`      ${truncate(f.claim, 90)}`)); continue; }
  const body = [`${p.name}${d.title_on_page ? `, ${d.title_on_page}` : ''} — bio retrieved ${now.slice(0, 10)} from ${d.url}`, '',
    ...d.facts.map((f) => `- ${f.claim} — "${f.quote}"`)].join('\n');
  insEv.run(p.org_id, p.id, 'staff_bio', `${p.name}'s bio on ${hostOf(d.url)}`, d.url, now, body);
  for (const f of d.facts) insEv.run(p.org_id, p.id, 'bio_fact', `${f.claim} — "${truncate(f.quote, 240)}"`, d.url, now, null);
  logLookup.run(p.id, now, 1, d.url, null, runId);
  found.push(p.id);
}

finishRun(db, runId, { n_in: ids.length, n_out: found.length });
const cost = db.prepare('SELECT ROUND(SUM(cost_usd), 3) c FROM runs WHERE id = ?').get(runId)?.c ?? 0;
console.log(heading(`${found.length} of ${ids.length} bio(s) found · $${cost}`));
// The daily run reads this line to re-judge the people who now have a bio.
if (found.length) console.log(`FOUND ${found.join(',')}`);
db.close();
