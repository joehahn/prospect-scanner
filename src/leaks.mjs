// Does anything about the operator, or about a prospect, sit in code or prompts
// that would be published?
//
// THE RULE, CLAUDE.md, 2026-09-25: this repo is meant to be pulled down and
// pointed at someone else's small business, so the operator's name, firm,
// employers, prices and target theses belong in config/ (gitignored) and never
// in src/ or prompts/. A rule nothing checks is a wish; this is the check, built
// the same way as the forbidden-host guard.
//
// THE FORBIDDEN TERMS ARE READ FROM THE OPERATOR'S OWN CONFIG, never listed
// here -- a list of the author's details in this file would be the first leak.
// Four kinds, each matched the way it would actually appear:
//
//   identity  firm name, website domain, contact email, the handle in the
//             proof-point URLs, the town, and any `operator.identifying_terms`
//             (a past employer, say). Whole words, anywhere, comments included.
//   price     every price in offers.yml, as a dollar amount.
//   id        thesis, trigger, offer and segment ids that exist in the operator's
//             config but NOT in the public *.example.yml templates. Template ids
//             are shared vocabulary; the rest are one business's choices. Matched
//             only as a quoted literal in code or `backticked` in a prompt, since
//             several are ordinary words.
//   prospect  full names of people in the database. Not about the operator, but
//             a real person named in public source is the same kind of mistake
//             the commit-msg hook exists to stop.
//
// Scope is what would be PUBLISHED: files git tracks plus new ones it does not
// ignore. A gitignored prompt (the operator's own voice file) is private by
// construction and is not scanned.
//
// Usage:
//   npm run leaks                 list every hit, grouped; exit 1 if any
//   npm run leaks -- --summary    counts per file and kind only

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(ROOT, 'config');

const readYaml = (f) => {
  const p = resolve(CONFIG, f);
  return existsSync(p) ? (YAML.parse(readFileSync(p, 'utf8')) ?? {}) : {};
};
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every `id:` under the given top-level keys of one parsed file. */
function idsUnder(doc, keys) {
  const out = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (k === 'id' && typeof v === 'string') out.add(v);
        else walk(v);
      }
    }
  };
  for (const k of keys) walk(doc[k]);
  return out;
}

/** The terms to look for, all derived from config. */
export function forbiddenTerms() {
  // business.yml is where these live after the consolidation; me.yml before it.
  const biz = readYaml('business.yml');
  const me = biz.firm ? { firm: biz.firm, operator: biz.you ?? {} } : readYaml('me.yml');
  const identity = new Set();
  const add = (s) => { const t = String(s ?? '').trim(); if (t.length >= 4) identity.add(t); };
  add(me.firm?.name);
  if (me.firm?.url) add(String(me.firm.url).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
  add(me.firm?.contact_email);
  add(me.firm?.location?.town?.split(',')[0]);
  for (const p of me.operator?.proof_points ?? []) {
    const h = String(p.evidence_url ?? '').match(/github\.com\/([^/]+)/i)?.[1];
    if (h) add(h);
  }
  for (const t of me.operator?.identifying_terms ?? []) add(t);
  // The operator's own name, if the email spells it (first.last@).
  const local = String(me.firm?.contact_email ?? '').split('@')[0];
  if (/^[a-z]+\.[a-z]+$/i.test(local)) add(local.split('.').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));

  const prices = new Set();
  const walkPrices = (o) => {
    if (Array.isArray(o)) o.forEach(walkPrices);
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (/^(price_usd|price_usd_month|rate_usd_hour)$/.test(k) && Number.isFinite(v) && v >= 100) prices.add(v);
        else walkPrices(v);
      }
    }
  };
  walkPrices(readYaml('offers.yml'));

  const pairs = [['sectors.yml', ['verticals', 'parked']], ['signals.yml', ['triggers']],
                 ['offers.yml', ['buyers', 'packages', 'work']], ['segments.yml', ['segments']]];
  // An id in ANY public template is shared vocabulary. Compared file by file,
  // a trigger the operator nests inside a sector counted as private although
  // signals.example.yml declares it: most of the 52 hits were that.
  const pub = new Set();
  for (const [f, keys] of pairs) {
    const ex = readYaml(f.replace('.yml', '.example.yml'));
    for (const i of idsUnder(ex, Object.keys(ex))) pub.add(i);
  }
  const ids = new Set();
  for (const [f, keys] of pairs) {
    for (const i of idsUnder(readYaml(f), keys)) if (!pub.has(i) && i.length >= 4) ids.add(i);
  }
  return { identity: [...identity], prices: [...prices], ids: [...ids] };
}

/** Full names of people in the book, if there is a database. */
function prospectNames() {
  const db = resolve(ROOT, 'data/prospects.db');
  if (!existsSync(db)) return [];
  try {
    const out = execFileSync('sqlite3', [db,
      "SELECT DISTINCT name FROM people WHERE name LIKE '% %' AND length(name) >= 8"], { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim())
      // A title filed as a name ("Chief AI Officer") is not a person.
      .filter((n) => n && !/\b(officer|director|president|manager|head|chief|vice)\b/i.test(n));
  } catch { return []; }
}

/**
 * Firms in the book, and the domains they mail from. A real firm named in a
 * comment is how a prospect gets published: "[firm] was killed on a Director of
 * AI appointed fourteen days earlier" is a sentence about a real firm's hiring,
 * in public source. Added 2026-09-29, when 28 firm names and four
 * real addresses were found in code this check called clean.
 *
 * Not flagged: names that are also in the public *.example.yml templates, and
 * the vendors and platforms the system itself uses or searches about, which are
 * public companies named for what they sell, not prospects.
 */
const PUBLIC_NAMES = new Set(['Google', 'Microsoft', 'Amazon', 'AWS', 'Anthropic', 'Claude', 'OpenAI',
  'LinkedIn', 'GitHub', 'Tavily', 'Guidewire', 'Cognizant', 'Accenture', 'Deloitte', 'Capgemini',
  'Salesforce', 'ServiceNow', 'Databricks', 'Snowflake', 'UiPath', 'Infosys', 'Wipro', 'EPAM', 'Genpact',
  'NVIDIA', 'Nvidia', 'IBM', 'SAP', 'Workday', 'Greenhouse', 'Lever', 'Ashby', 'Playwright',
  'PR Newswire', 'Business Wire', 'GlobeNewswire', 'Gartner', 'McKinsey', 'FDIC', 'Coursera', 'ZoomInfo']);
// Firms whose whole name is an ordinary word, which a comment uses as a word.
const COMMON_WORDS = new Set(['Action', 'Enumerate', 'Frontier', 'Summit', 'Beacon', 'Pinnacle']);
function bookFirms() {
  const db = resolve(ROOT, 'data/prospects.db');
  if (!existsSync(db)) return { names: [], domains: [] };
  const templates = readdirSync(CONFIG).filter((f) => f.endsWith('.example.yml'))
    .map((f) => readFileSync(resolve(CONFIG, f), 'utf8')).join('\n');
  try {
    const rows = execFileSync('sqlite3', ['-separator', '\t', db, 'SELECT name, COALESCE(domain, \'\') FROM orgs'],
      { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.split('\t'));
    const names = [...new Set(rows.map((r) => r[0].trim()))]
      // Short names are often ordinary words, and a one-word name must be long.
      .filter((n) => n.length >= 5 && /^[A-Z0-9]/.test(n) && (/\s/.test(n) || n.length >= 6))
      .filter((n) => !PUBLIC_NAMES.has(n) && !COMMON_WORDS.has(n) && !templates.includes(n));
    const domains = [...new Set(rows.map((r) => r[1].trim().replace(/^www\./, '')).filter((d) => /\./.test(d)))];
    return { names, domains };
  } catch { return { names: [], domains: [] }; }
}

// What is scanned: code, prompts, the public config templates (which CLAUDE.md
// requires to stay generic), and the written docs and README.
const SCOPE = /^(src\/.*\.mjs|test\/.*\.mjs|prompts\/.*\.md|config\/.*\.example\.yml|docs\/.*\.md|README\.md|CLAUDE\.md|config\/README\.md)$/;

/** Files that would be published: tracked, plus untracked-but-not-ignored. */
function publishedFiles() {
  const list = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const files = new Set([...list(['ls-files']), ...list(['ls-files', '--others', '--exclude-standard'])]);
  return [...files].filter((f) => SCOPE.test(f) && existsSync(resolve(ROOT, f)));
}

export function findLeaks({ withProspects = true } = {}) {
  const t = forbiddenTerms();
  const rules = [
    ...t.identity.map((term) => ({ kind: 'identity', term,
      re: new RegExp(`(^|[^A-Za-z0-9])${escRe(term)}([^A-Za-z0-9]|$)`, 'i') })),
    ...t.prices.map((p) => ({ kind: 'price', term: `$${p.toLocaleString('en-US')}`,
      re: new RegExp(`\\$\\s?${escRe(p.toLocaleString('en-US'))}(?![0-9,])|\\$\\s?${p}(?![0-9,])`) })),
    ...t.ids.map((id) => ({ kind: 'id', term: id,
      re: new RegExp(`['"\`]${escRe(id)}['"\`]`) })),
    ...(withProspects ? prospectNames() : []).map((n) => ({ kind: 'prospect', term: n,
      re: new RegExp(`(^|[^A-Za-z])${escRe(n)}([^A-Za-z]|$)`) })),
  ];
  if (withProspects) {
    const f = bookFirms();
    rules.push(...f.names.map((n) => ({ kind: 'firm', term: n,
      re: new RegExp(`(^|[^A-Za-z])${escRe(n)}([^A-Za-z]|$)`) })));
    // An address at a firm in the book is a person at that firm, whatever the name.
    rules.push(...f.domains.map((d) => ({ kind: 'address', term: `@${d}`,
      re: new RegExp(`[A-Za-z0-9._%+-]@${escRe(d)}([^A-Za-z0-9.-]|$)`, 'i') })));
  }
  // AUTHORSHIP IS NOT A LEAK. The README and the lessons write-up carry the
  // author's byline and site on purpose: this is a portfolio project, and credit
  // is not configuration. Identity terms are allowed there and nowhere else;
  // prices, ids and prospect names are not allowed there either.
  const BYLINE_OK = /^(README\.md|docs\/lessons\.md)$/;
  const hits = [];
  for (const f of publishedFiles()) {
    const lines = readFileSync(resolve(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const r of rules) {
        if (r.kind === 'identity' && BYLINE_OK.test(f)) continue;
        if (r.re.test(line)) hits.push({ file: f, line: i + 1, kind: r.kind, term: r.term });
      }
    });
  }
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = findLeaks();
  const kinds = ['identity', 'price', 'id', 'prospect', 'firm', 'address'];
  if (process.argv.includes('--summary')) {
    const by = new Map();
    for (const h of hits) {
      const k = `${h.file}`;
      if (!by.has(k)) by.set(k, Object.fromEntries(kinds.map((x) => [x, 0])));
      by.get(k)[h.kind]++;
    }
    for (const [f, c] of [...by].sort()) {
      console.log(`${f.padEnd(34)} ${kinds.map((k) => c[k] ? `${k} ${c[k]}` : '').filter(Boolean).join(' · ')}`);
    }
  } else {
    for (const k of kinds) {
      const hk = hits.filter((h) => h.kind === k);
      if (!hk.length) continue;
      console.log(`\n${k.toUpperCase()} — ${hk.length}`);
      for (const h of hk) console.log(`  ${h.file}:${h.line}  ${h.term}`);
    }
  }
  const total = kinds.map((k) => `${hits.filter((h) => h.kind === k).length} ${k}`).join(', ');
  console.log(`\n${hits.length ? 'LEAKS' : 'clean'}: ${total}`);
  process.exit(hits.length ? 1 : 0);
}
