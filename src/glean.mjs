// Stage 5f: read what the operator pasted, and let it fire a trigger.
//
// THE GAP THIS CLOSES, found 2026-09-23. Fifteen profiles were pasted by hand in
// one afternoon. At least five carried a dated, first-person, sourced event that
// a trigger already declared in config/signals.yml describes exactly -- a newly
// created planning-optimisation requisition, a named summit talk in November, an
// OEE roundtable naming where the metric "can unintentionally drive the wrong
// behaviors", three acquisitions and a carve-out, a new kitting facility going
// live. None of them fired. They sat in `evidence.body` as operator_profile
// text, which the ranker reads as biography.
//
// So the book scored a VP who had published his own gap eight months earlier
// BELOW a man whose only visible act was attending a conference. The evidence
// was in the database, in his own words, with a URL. Nothing could see it.
//
// Every other stage that writes a signal reads something it retrieved. This one
// reads something a person handed over, which the design requires stay a distinct
// epistemic object -- and it does: the signal points at the same evidence row,
// which still carries provenance='operator_supplied'. What changes is that the
// ranker can now see it. Nothing here retrieves anything, and nothing here
// touches linkedin.com.
//
// THE CONTROL IS THE QUOTE, AND IT IS IN CODE. A proposed signal must quote the
// span that establishes it, and the quote must appear VERBATIM in the body or
// the signal is rejected and logged. prompts/glean-pasted-fact.md says the same
// thing, but a prompt is guidance where this is a control: every factual claim
// in a dossier carries a source, and a fabricated quote is worse than a missed
// prospect. Same discipline as `unblock` downgrading an angle that cites no
// evidence id -- checkable in code, so checked in code.
//
// Usage:
//   npm run glean -- [--person <id>] [--org <id>] [--limit N]
//                    [--model <id>] [--jobs 4] [--dry] [--redo] [--no-write]

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete } from './models.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/glean-pasted-fact.md';

// Every property required and no null unions: the strict-schema rule this
// project keeps, because an optional property doubles the branch count for no
// gain. "" is the empty answer throughout.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'trigger_id', 'quote', 'dated_on', 'why'],
  properties: {
    verdict: { type: 'string', enum: ['fires', 'stands_down'] },
    trigger_id: { type: 'string',
      description: 'verdict=fires only: the trigger id, from the list given. Else "".' },
    quote: { type: 'string',
      description: 'verdict=fires only: the exact words from the body, copied verbatim. '
        + 'Checked in code against the body; a quote that is not there is rejected.' },
    dated_on: { type: 'string',
      description: 'YYYY-MM-DD if the evidence gives a date, else "".' },
    why: { type: 'string', description: 'One sentence: what happened, and which trigger it meets.' },
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const str = (v) => (v && v !== true ? String(v) : null);

// WHITESPACE ONLY. The quote check is deliberately close to exact: case, accents
// and punctuation all have to match, because those are how a claim gets
// distorted. Only line wrapping is forgiven, since the body is stored hard
// wrapped and a model copying a span across a newline is not the failure this
// guards against.
export const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function quoteIsInBody(quote, body) {
  const q = flat(quote);
  // A two-word "quote" would pass against almost any body and prove nothing.
  if (q.length < 25) return false;
  return flat(body).includes(q);
}

function triggerBook(cfg) {
  return (cfg.triggers ?? []).map((t) =>
    `  ${t.id}  [kind: ${t.kind ?? '?'}]  ${t.description ?? ''}` +
    (t.not?.length ? `\n      NOT: ${t.not.map((n) => String(n).slice(0, 180)).join(' | ')}` : ''))
    .join('\n');
}

/** Pasted evidence with a body, one row per paste, newest first. */
function pastedRows(db, { personId, orgId, redo }) {
  // NOT AT FIRMS THAT SELL WHAT HE SELLS. The first full run spent 15 calls on
  // 10 delivery firms and fired a capital_event on one -- a data-services
  // consultancy's own $40M raise, read as a buying signal. Nobody was ever going
  // to be contacted there: the org gate blocks a delivery_firm downstream, so
  // the signal was invisible waste rather than a wrong dossier. Still waste, and
  // a competitor's funding round is not a reason to write to anyone.
  const where = ["e.provenance = 'operator_supplied'", 'e.body IS NOT NULL', "e.body <> ''",
    "COALESCE(o.kind,'') <> 'delivery_firm'",
    'COALESCE(o.sells_ai_delivery,0) = 0', 'COALESCE(o.sells_ai_advisory,0) = 0'];
  const bind = [];
  if (personId) { where.push('e.person_id = ?'); bind.push(personId); }
  if (orgId) { where.push('e.org_id = ?'); bind.push(orgId); }
  if (!redo) where.push('NOT EXISTS (SELECT 1 FROM gleans g WHERE g.evidence_id = e.id)');
  return db.prepare(`
    SELECT e.id, e.org_id, e.person_id, e.body, e.source_url, e.retrieved_at,
           COALESCE(p.name, '(no person)') person_name, COALESCE(p.title, '') title,
           COALESCE(o.name, e.org_id) org_name
      FROM evidence e
      LEFT JOIN people p ON p.id = e.person_id
      LEFT JOIN orgs   o ON o.id = e.org_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.id DESC`).all(...bind);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  const cfg = await loadConfig();
  const today = new Date().toISOString().slice(0, 10);
  const model = str(args.model) ?? cfg.runtime?.models?.default ?? cfg.models?.default;   // from runtime.yml
  const prompt = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');

  const known = new Map((cfg.triggers ?? []).map((t) => [t.id, t]));
  const rows = pastedRows(db, {
    personId: str(args.person), orgId: str(args.org), redo: Boolean(args.redo),
  });
  const limit = Number(args.limit ?? 0) || rows.length;
  const work = rows.slice(0, limit);

  console.log(heading(`GLEAN — ${work.length} of ${rows.length} pasted facts, model ${model}`));
  if (!work.length) {
    console.log('Nothing pasted that has not been read. Paste a profile with '
      + '`npm run lead -- paste`, or pass --redo.');
    db.close(); return;
  }
  if (args.dry) {
    for (const r of work) {
      console.log(`  ${String(r.person_name).padEnd(24)} ${r.org_name} `
        + dim(`· ${flat(r.body).length} chars`));
    }
    db.close(); return;
  }

  const runId = startRun(db, 'glean', { model });
  const book = triggerBook(cfg);
  const ins = db.prepare(`INSERT INTO gleans
    (evidence_id, org_id, person_id, verdict, trigger_id, quote, dated_on, why,
     rejected_reason, signal_id, model, run_id, created_at)
    VALUES (@evidence_id, @org_id, @person_id, @verdict, @trigger_id, @quote, @dated_on, @why,
     @rejected_reason, @signal_id, @model, @run_id, @created_at)`);
  // Same guard every other writer keeps: one live signal per firm per trigger.
  const sig = db.prepare(`INSERT INTO signals (org_id,trigger_id,detected_at,decays_at,weight,evidence_id)
    SELECT @org, @trig, @detected, @decays, @weight, @ev
     WHERE NOT EXISTS (SELECT 1 FROM signals x WHERE x.org_id=@org
       AND x.trigger_id=@trig AND x.retracted_at IS NULL)`);

  const tally = { fired: 0, stood_down: 0, rejected: 0, duplicate: 0 };
  let spent = 0;
  const jobs = Math.max(1, Number(args.jobs ?? 4) || 4);
  let next = 0;

  const worker = async () => {
    for (let i = next++; i < work.length; i = next++) {
      const r = work[i];
      const res = await complete(db, runId, {
        // 2000 was not enough: the trigger book is long, the bodies run to
        // 3-4k characters, and the first run died mid-flight having spent real
        // money to hit the ceiling while still thinking.
        model, maxTokens: 8000, schema: SCHEMA, system: prompt,
        messages: [{ role: 'user', content:
          `Person: ${r.person_name}${r.title ? ` — ${r.title}` : ''}\n`
          + `Firm: ${r.org_name}\n`
          + `Source: ${r.source_url}\n`
          + `Pasted on: ${String(r.retrieved_at).slice(0, 10)} `
          + `(convert any relative date in the text against this)\n\n`
          + `## The pasted evidence\n\n${r.body}\n\n`
          + `## Every trigger defined in this project\n\n${book}` }],
      });
      spent += res.cost_usd ?? 0;
      const d = res.data ?? {};
      const row = {
        evidence_id: r.id, org_id: r.org_id, person_id: r.person_id,
        verdict: d.verdict ?? 'stands_down', trigger_id: d.trigger_id ?? '',
        quote: d.quote ?? '', dated_on: d.dated_on ?? '', why: d.why ?? '',
        rejected_reason: null, signal_id: null, model: res.model ?? model,
        run_id: runId, created_at: new Date().toISOString(),
      };

      if (d.verdict !== 'fires') {
        tally.stood_down++; ins.run(row);
        continue;
      }

      // ---- the controls, in order, all in code ----------------------------
      const t = known.get(d.trigger_id);
      if (!t) row.rejected_reason = `no such trigger: "${d.trigger_id}"`;
      else if (!quoteIsInBody(d.quote, r.body)) {
        row.rejected_reason = 'quote does not appear verbatim in the body';
      }

      if (row.rejected_reason) {
        row.verdict = 'rejected'; tally.rejected++; ins.run(row);
        console.log(`  ${bold('REJECT')} ${r.person_name} @ ${r.org_name} — ${row.rejected_reason}`);
        continue;
      }

      // AN UNDATED EVENT IS RECORDED, NOT DISCARDED. A profile rarely carries a
      // publication date and the absence of one is not evidence the event did
      // not happen -- the same rule prompts/rejudge-retraction.md keeps for a
      // job posting with no date. It decays from today instead, which is the
      // conservative reading: it will age out sooner than a dated one would.
      const detected = /^\d{4}-\d{2}-\d{2}$/.test(d.dated_on) && d.dated_on <= today
        ? d.dated_on : today;
      const days = Number(t.decay_days ?? cfg.targeting?.decay_days ?? 180);
      const weight = Number(t.weight ?? 1);

      if (args['no-write']) {
        row.verdict = 'fires'; tally.fired++; ins.run(row);
        console.log(`  ${dim('would fire')} ${d.trigger_id} · ${r.person_name} @ ${r.org_name}`);
        continue;
      }

      const out = sig.run({ org: r.org_id, trig: d.trigger_id, ev: r.id,
        detected, decays: null, weight });
      if (!out.changes) {
        row.verdict = 'duplicate'; tally.duplicate++; ins.run(row);
        console.log(`  ${dim('already live')} ${d.trigger_id} @ ${r.org_name}`);
        continue;
      }
      db.prepare("UPDATE signals SET decays_at = date(detected_at, '+' || ? || ' days') WHERE id = ?")
        .run(days, out.lastInsertRowid);
      row.verdict = 'fires'; row.signal_id = out.lastInsertRowid;
      tally.fired++; ins.run(row);
      console.log(`  ${bold('FIRES')} ${d.trigger_id} · ${r.person_name} @ ${r.org_name}`
        + dim(`\n        ${detected}${d.dated_on ? '' : ' (undated, decays from today)'} — ${d.why}`));
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  console.log(heading('VERDICTS'));
  const n = Object.values(tally).reduce((a, b) => a + b, 0) || 1;
  for (const [k, v] of Object.entries(tally)) {
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)}  ${Math.round((v / n) * 100)}%`);
  }
  if (tally.rejected) {
    console.log(dim('\n  A rejection is a defect worth reading, not noise: the model proposed a\n'
      + '  signal it could not quote. `sqlite3 data/prospects.db "select * from gleans\n'
      + '  where verdict=\'rejected\'"` shows what it tried to claim.'));
  }
  console.log(dim(`\n  $${spent.toFixed(4)} across ${n} calls · next: npm run gate && npm run rank`));
  finishRun(db, runId, { cost_usd: spent, n_in: work.length, n_out: tally.fired });
  db.close();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
