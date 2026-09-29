// Stage 12: find what a prospect has said in public, anywhere but LinkedIn.
//
// THE OPERATOR, 2026-09-25: "current solution uses batch ingest of news +
// conference > names & firms > linked profile > note, which does not scale well.
// can we replace the last 2 steps with a swarm of agents (1 per name?) that
// harvests what it can from all possible sources".
//
// He is right that the paste does not scale: 199 profiles pasted out of 1,743
// people, at roughly twenty per sitting.
//
// WHAT TO HARVEST IS THE WHOLE QUESTION, and the obvious answer is wrong. The
// book already holds 3,273 firm-level evidence rows and 1,407 staff listings --
// a name and a title off a leadership page -- and more of that does not help.
// Measured on the bench panel the same day: one prospect has 67 evidence rows
// and a THIN read; another has 2 and a STRONG one. Evidence volume runs
// inversely to thesis quality.
//
// What separates them is whose words they are. Every strong read on the panel
// rests on a pasted profile, and the accepted offer-selection rule says why:
// choose the offer from the subject the person's own output keeps returning to.
// So this hunts FIRST-PERSON MATERIAL -- a talk, a quoted remark, a bylined
// piece, a podcast -- and ignores anything that merely describes their employer.
//
// Leclercq is the worked example. His note went from a generic divestiture pitch
// to "the Rostock workshop where 138 young surgeons trained on your haemostat",
// and Rostock came from his own posts. Nothing in 22 firm-level rows had it.
//
// NEVER LINKEDIN. Not as a search domain, not as a fetch, not through a browser.
// Their §8.2 prohibits crawlers in words, which is a policy and not a control,
// so no technical capability changes it. The operator may paste what he reads
// himself; this stage may not go looking.
//
// CHEAP BY DESIGN. Deciding which of eight search results is the person talking
// is classification, not judgement, and `models.cheap` does it well. The stage
// that needs the expensive model is `read`, which runs once per prospect against
// what this collects -- and runtime.yml records the head-to-head showing why
// that one must not be cheapened.
//
// Usage:
//   npm run harvest -- --person <id>
//   npm run harvest -- --bench            every panel member
//   npm run harvest -- --person <id> --dry

import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete, promptBody } from './models.mjs';
import { searchNews, creditsUsed } from './sources/tavily.mjs';
import { fetchPage } from './sources/web.mjs';
import { heading, bold, dim } from './report.mjs';

// Hosts this stage will not read from, whatever a search returns.
const NEVER = ['linkedin.com', 'www.linkedin.com'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['utterances'],
  properties: {
    utterances: {
      type: 'array',
      description: 'Only material in which THIS PERSON speaks or writes. Empty if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'context', 'source_url', 'dated_on', 'is_first_person'],
        properties: {
          quote: { type: 'string', description: 'Their words, verbatim, or a session/article title they authored.' },
          context: { type: 'string', description: 'One line: where this was said and to whom.' },
          source_url: { type: 'string' },
          dated_on: { type: 'string', description: 'YYYY-MM-DD, or "" when the page carries no date.' },
          is_first_person: { type: 'boolean',
            description: 'True only if the person is speaking or writing. False for anything ABOUT them or about their employer.' },
        },
      },
    },
  },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]; if (!t.startsWith('--')) continue;
    const k = t.slice(2); const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
}

/** The queries that find a person talking, rather than a firm being written about. */
function queriesFor(person, org) {
  const n = `"${person.name}"`;
  const f = org.name ? `"${org.name}"` : '';
  return [
    `${n} ${f} interview OR podcast OR "spoke at" OR panel`,
    `${n} ${f} said OR "told" OR quoted`,
    `${n} ${f} author OR byline OR "wrote"`,
  ];
}

async function harvestOne(db, runId, person, org, cfg, model, { dry = false } = {}) {
  const seen = new Set(db.prepare('SELECT source_url FROM evidence WHERE person_id = ?')
    .all(person.id).map((r) => r.source_url));
  const hits = [];
  for (const q of queriesFor(person, org)) {
    const { results = [] } = await searchNews(q, {
      maxResults: 6, requireDate: false, topic: 'general', excludeDomains: NEVER,
    });
    for (const r of results) {
      if (NEVER.some((h) => String(r.url ?? '').includes(h))) continue;
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      hits.push({ url: r.url, title: r.title, snippet: (r.content ?? '').slice(0, 600) });
    }
  }
  if (dry) return { hits, utterances: [], cost: 0 };
  if (!hits.length) return { hits, utterances: [], cost: 0 };

  const res = await complete(db, runId, {
    model, maxTokens: 8000, schema: SCHEMA, thinking: false,
    system: promptBody('prompts/own-words.md', { name: person.name,
      title: person.title ?? 'title unknown', org: org.name ?? '?' }),
    messages: [{ role: 'user', content: hits.map((h, i) =>
      `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`).join('\n\n') }],
  });

  const out = (res.data?.utterances ?? []).filter((u) => u.is_first_person
    && String(u.quote ?? '').trim() && String(u.source_url ?? '').startsWith('http')
    && !NEVER.some((h) => u.source_url.includes(h)));

  const ins = db.prepare(`INSERT INTO evidence (org_id, person_id, kind, claim, source_url, retrieved_at, provenance, body)
    -- PROVENANCE IS A CLAIM ABOUT WHO OBTAINED THIS, and the schema enforces a
    -- closed set for that reason. This stage retrieved it from the open web, so
    -- 'retrieved' is the true answer; 'operator_supplied' would be the stage
    -- lying about where the words came from, which is the confusion the
    -- provenance rule exists to prevent. The KIND carries the distinction that
    -- matters here instead.
    VALUES (@org, @person, 'public_utterance', @claim, @url, @at, 'retrieved', @body)
    ON CONFLICT(org_id, kind, source_url, claim) DO UPDATE SET retrieved_at = excluded.retrieved_at`);
  for (const u of out) {
    ins.run({ org: person.org_id, person: person.id,
      claim: `${person.name}: ${String(u.quote).slice(0, 300)}`.trim(),
      url: u.source_url, at: new Date().toISOString(),
      body: `${u.context}\n\n"${u.quote}"${u.dated_on ? `\n\n(${u.dated_on})` : ''}` });
  }
  return { hits, utterances: out, cost: res.cost_usd ?? 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  const cfg = await loadConfig();
  const model = (args.model && args.model !== true) ? String(args.model)
    : cfg.models?.cheap;   // from runtime.yml

  let people;
  if (args.bench) {
    people = db.prepare(`SELECT p.* FROM people p JOIN bench b ON b.person_id = p.id`).all();
  } else if (args.person && args.person !== true) {
    people = db.prepare('SELECT * FROM people WHERE id = ?').all(String(args.person));
  } else {
    console.log('Pass --person <id>, or --bench for the panel.'); db.close(); return;
  }
  if (!people.length) { console.log('nobody to harvest'); db.close(); return; }

  const runId = startRun(db, 'harvest', { model });
  console.log(heading(`HARVEST — ${people.length} person(s), model ${model}`));
  console.log(dim('  their own words only, never linkedin.com\n'));

  let spent = 0; let found = 0;
  for (const p of people) {
    const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(p.org_id) ?? {};
    const r = await harvestOne(db, runId, p, org, cfg, model, { dry: !!args.dry });
    spent += r.cost; found += r.utterances.length;
    console.log(`  ${String(p.name).padEnd(22)} ${String(r.hits.length).padStart(2)} page(s) read `
      + `-> ${r.utterances.length ? bold(`${r.utterances.length} utterance(s)`) : dim('nothing first-person')}`);
    for (const u of r.utterances) console.log(dim(`       "${String(u.quote).slice(0, 88)}"`));
  }
  console.log(dim(`\n  ${found} utterance(s) stored · $${spent.toFixed(4)} · ${creditsUsed()} Tavily credits`));
  console.log(dim('  Re-read anyone this changed:  npm run read -- --person <id> --redo'));
  finishRun(db, runId, { cost_usd: spent, n_in: people.length, n_out: found, tavily_credits: creditsUsed() });
  db.close();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
