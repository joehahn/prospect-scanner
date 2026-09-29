// Re-check stored events whose evidence holds only the event's name.
//
// Until qualify-results v4 (2026-09-27) the search filter returned an event's
// name and nothing it had read, so a find was stored as "<firm>: <event name>".
// One such find turned out to be a trade-press list mentioning a firm's AI use
// in passing, recorded as an "ai coe announcement" and offered on a card as the
// reason to write. This reads each source again, asks whether it shows the
// event, stores what it actually says, and retracts the event where it does not.
//
// The source is the page itself, fetched under its robots.txt; where the site
// refuses the fetcher, a search engine's excerpt of that same page. Nothing is
// guessed: a source that cannot be read is left as it was and reported.
//
// Usage:
//   npm run recheck            every thin event
//   npm run recheck -- --dry   list them, spend nothing

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { loadBusiness } from './business.mjs';
import { complete } from './models.mjs';
import { fetchPage } from './sources/web.mjs';
import { searchNews, creditsUsed } from './sources/tavily.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/recheck-event.md';
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['said', 'shows_event', 'date', 'why'],
  properties: { said: { type: 'string' }, shows_event: { type: 'boolean' }, date: { type: 'string' }, why: { type: 'string' } },
};

const dry = process.argv.includes('--dry');
const db = openDb();
const cfg = loadConfig();
const biz = loadBusiness(cfg);

const thin = db.prepare(`SELECT s.id sig, s.trigger_id, s.detected_at, s.org_id, o.name org, e.id ev, e.source_url url
    FROM signals s JOIN evidence e ON e.id = s.evidence_id JOIN orgs o ON o.id = s.org_id
    WHERE s.retracted_at IS NULL AND e.body IS NULL AND e.claim LIKE o.name || ': %'
      AND length(e.claim) < length(o.name) + 60 ORDER BY e.source_url`).all();

console.log(heading(`recheck · ${thin.length} event(s) stored with only a name${dry ? ' · dry run' : ''}`));
if (dry) { for (const t of thin) console.log(`  ${t.org} · ${t.trigger_id} · ${t.url}`); process.exit(0); }

// The words that find this organisation in a page: its name, and its first
// distinctive word, since pages shorten names ("UNFI", "Securityplus FCU").
const keys = (org) => {
  const words = org.replace(/[.,()]/g, ' ').split(/\s+/).filter((w) => w.length > 2
    && !/^(inc|llc|ltd|the|and|group|corporation|company|partners|federal|credit|union|bank)$/i.test(w));
  return [org, ...words.slice(0, 1)].map((k) => k.toLowerCase());
};
const excerpt = (text, org) => {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const ks = keys(org); const out = []; let used = 0;
  for (const k of ks) {
    let i = t.toLowerCase().indexOf(k);
    while (i >= 0 && used < 3500) {
      const piece = t.slice(Math.max(0, i - 500), i + 900);
      out.push(piece); used += piece.length;
      i = t.toLowerCase().indexOf(k, i + 900);
    }
    if (out.length) break;
  }
  return out.join('\n…\n');
};

const cache = new Map();   // one fetch per URL: two firms can share an article
async function sourceText(url, org) {
  if (!cache.has(url)) {
    const r = await fetchPage(url);
    cache.set(url, r.ok ? String(r.text ?? '') : '');
  }
  const page = excerpt(cache.get(url), org);
  if (page) return { how: 'page', text: page };
  // Refused or no mention: the search engine's excerpt of the same page.
  const slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
    .replace(/\.[a-z]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\d{6,}\b/g, '').slice(0, 120);
  const { results = [] } = await searchNews(`${org} ${slug}`, { maxResults: 6, topic: 'general', requireDate: false });
  const same = results.find((x) => x.url?.split('?')[0] === url.split('?')[0]);
  const hit = same ?? results.find((x) => keys(org).some((k) => `${x.title} ${x.snippet}`.toLowerCase().includes(k)));
  if (hit) return { how: same ? 'search excerpt of the page' : `search excerpt of ${hit.url}`, text: `${hit.title}\n${hit.snippet}` };
  return null;
}

const system = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');
const model = cfg.models?.cheap;
const runId = startRun(db, 'recheck', { model });
const c0 = creditsUsed();
const now = new Date().toISOString();
const tally = { kept: 0, retracted: 0, unread: 0 };

for (const t of thin) {
  const src = await sourceText(t.url, t.org);
  if (!src) { tally.unread++; console.log(`  ${dim('unread')}    ${t.org} · ${t.trigger_id} · nothing readable at the source`); continue; }
  const ev = (biz.events ?? []).find((e) => String(e.name).toLowerCase() === t.trigger_id.replace(/_/g, ' '));
  const res = await complete(db, runId, {
    model, system, schema: SCHEMA, effort: 'low', thinking: false, maxTokens: 1500,
    messages: [{ role: 'user', content: [
      `## Organisation\n${t.org}`,
      `## Recorded event\n${t.trigger_id.replace(/_/g, ' ')}: ${ev?.description ?? '(no definition on file)'}`
        + (ev?.does_not_count?.length ? `\nDoes NOT count: ${ev.does_not_count.map((x) => String(x).slice(0, 200)).join(' | ')}` : ''),
      `## Source\n${t.url} (${src.how})\n\n${src.text}`,
    ].join('\n\n') }],
  });
  const d = res.data;
  if (!d) { tally.unread++; console.log(`  ${dim('no answer')} ${t.org}`); continue; }
  const date = /^\d{4}-\d{2}(-\d{2})?$/.test(d.date ?? '') ? d.date : '';
  db.transaction(() => {
    db.prepare(`UPDATE evidence SET claim = ?, body = ?, retrieved_at = ? WHERE id = ?`).run(
      `${t.org}: ${String(d.said).trim()}${date ? ` (${date})` : ''}`,
      `${src.text.slice(0, 3000)}\n\n[re-checked ${now.slice(0, 10)} from the ${src.how}; ${PROMPT_FILE}]`, now, t.ev);
    if (!d.shows_event) {
      db.prepare(`UPDATE signals SET retracted_at = ?, retracted_reason = ? WHERE id = ?`)
        .run(now, `Re-checked against the source (${PROMPT_FILE}): ${d.why}`, t.sig);
    } else if (date && date.length === 10 && date !== String(t.detected_at).slice(0, 10)) {
      db.prepare(`UPDATE signals SET date_corrected_from = detected_at, detected_at = ? WHERE id = ?`).run(date, t.sig);
    }
  })();
  if (d.shows_event) tally.kept++; else tally.retracted++;
  console.log(`  ${d.shows_event ? bold('kept     ') : 'retracted'} ${t.org} · ${t.trigger_id}${date ? ` · ${date}` : ''}\n            ${dim(String(d.said).slice(0, 160))}`
    + (d.shows_event ? '' : `\n            ${dim(`why: ${d.why}`)}`));
}

const credits = creditsUsed() - c0;
finishRun(db, runId, { tavily_credits: credits });
const cost = db.prepare('SELECT ROUND(SUM(cost_usd), 4) c FROM runs WHERE id = ?').get(runId)?.c ?? 0;
console.log(heading(`${tally.kept} kept · ${tally.retracted} retracted · ${tally.unread} unread · $${cost} · ${credits} search credits`));
