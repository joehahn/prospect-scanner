// Draft one outreach note.
//
// This is the first stage in the system that spends money, and the first that
// writes something a human being will eventually read. Both facts shape it:
// every call is priced and recorded through models.mjs, and the output is a
// DRAFT that the operator rewrites (CLAUDE.md, as amended 2026-08-25). Nothing
// here sends anything, and no code path exists that could.
//
// Drafts are versioned, never overwritten. The gap between what this writes and
// what he actually sends is the signal that teaches the next version his voice.
//
// Usage:
//   npm run draft -- --person <id> [--channel email] [--service read_proposal]
//                    [--model claude-opus-5] [--effort high] [--force]
//                    [--examples fixed|picked]   which voice examples (default: alternate)
//                    [--no-store] [--pool-before <draft id>]   a replay: print, store nothing
//   npm run draft -- --person <id> --show        print stored drafts, no API call
//   npm run draft -- --person <id> --revise "cut the metrics, halve it"
//                    Rewrite the latest version against an instruction. Writes
//                    version N+1; the version it came from is never touched, so
//                    the sequence stays readable as a record of what was asked
//                    for and what that produced.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadBusiness } from './business.mjs';
import { operatorSaidLines } from './operator-said.mjs';
import { boardLines } from './boards.mjs';
import { CONNECT_NOTE_MAX, loadConfig, buyer as resolveBuyer, buyerForOrg, packageForBuyer, clearsMoneyGate,
  firmIsStaffed, capabilityTitles } from './config.mjs';
import { loadTargeting } from './targeting.mjs';
import { historyFor, classify } from './suppression.mjs';
import { complete } from './models.mjs';
import { neverClaimHits } from './never-claim.mjs';
import { noteBody, unbold } from './checks.mjs';
import { heading, bold, dim } from './report.mjs';
import { retense } from './events.mjs';
import { voiceFor, chooseArm, PICKED_PROMPT } from './voice-examples.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/draft-cold-note.md';

// Every property required, no null unions — the strict-schema rule this project
// keeps because an optional property doubles the branch count for no gain.
const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'unsupported'],
  properties: {
    verdict: { type: 'string', enum: ['supported', 'unsupported'] },
    unsupported: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'why'],
        properties: {
          claim: { type: 'string', description: "The claim in the note's own words." },
          why: { type: 'string', description: 'One sentence: what the evidence says instead. Quote it.' },
        },
      },
    },
  },
};
const VOICE_FILE = 'prompts/voice.md';
const VOICE_EXAMPLE = 'prompts/voice.example.md';
const readPrompt = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

/**
 * The tuned voice file is gitignored, so a fresh clone has only the template.
 * Fall back to it rather than crashing, but say loudly what is missing — drafts
 * written against the template will not sound like anyone in particular.
 */
function readVoice() {
  try {
    return readPrompt(VOICE_FILE);
  } catch {
    console.warn(dim(`no ${VOICE_FILE} — falling back to ${VOICE_EXAMPLE}. ` +
      'Drafts will be generic until you build the real one from notes you have sent.'));
    return readPrompt(VOICE_EXAMPLE);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (String(argv[j]).startsWith('--')) { prev = String(argv[j]).slice(2); break; }
    }
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument "${argv[i]}"` +
      (prev ? `\n\n  This usually means an unquoted value. "${prev}" took only the first word ` +
        'of what followed. Wrap multi-word values in SINGLE quotes:\n' +
        `    --${prev} 'the whole phrase, dashes and $ and all'\n\n` +
        '  Single quotes, not double: the shell expands $2 inside double quotes and ' +
        'a price like $1,999 silently becomes ",999".' : ''));
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

/** Everything the model is allowed to know. Nothing is asserted that is not in here. */
function buildDossier(db, cfg, targeting, person, org, service, line, offerNote = '', cutoff = null) {
  const bizOffer = service ? loadBusiness(cfg, targeting).offers.find((o) => o.name === service.name) : null;
  const evidence = db.prepare(`
    SELECT kind, claim, source_url, retrieved_at, provenance, body
    FROM evidence WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL))
    ORDER BY provenance DESC, retrieved_at DESC`).all(person.id, org.id);
  // ^ This person's evidence and the firm's, never a colleague's. A colleague's
  // pasted profile said "current role at another firm", and a dossier that held
  // it unlabelled could put that move in this person's note.

  const gates = db.prepare(
    'SELECT gate_id, outcome, reason, decided_at FROM gate_results WHERE org_id = ?').all(org.id);
  const signals = db.prepare(`
    SELECT s.trigger_id, s.detected_at, s.weight, e.claim, e.source_url
    FROM signals s LEFT JOIN evidence e ON e.id = s.evidence_id
     WHERE s.org_id = ? AND s.retracted_at IS NULL`).all(org.id);
  const prior = db.prepare(`
    SELECT channel, sent_at, service_pitched, status, subject, message_text
    FROM outreach WHERE org_id = ? AND (? IS NULL OR sent_at < ?) ORDER BY sent_at DESC`)
    .all(org.id, cutoff, cutoff);
  // ^ `cutoff`, for a replay: the note being replayed must not be in its own dossier.

  // THE BEST SENTENCE IN THE DATABASE WAS IN A TABLE THIS STAGE NEVER OPENED.
  // `unblock` reads a blocked prospect and, where there is one, returns the
  // premise a note could open from -- 22 of them from the conference cohort, each
  // quoting something the person said on a dated public programme. draft read
  // only evidence and signals, so a prospect with a live angle and no live
  // trigger arrived here looking like a firm nobody knew anything about, and the
  // operator was left to carry the sentence across by hand.
  //
  // IT IS HANDED OVER AS AN ANGLE, NOT AS A TRIGGER, and the section says so in
  // the words the prompt has to obey. An angle is a reason to open a note. It is
  // NOT evidence the firm is buying anything, and the distinction matters:
  // a person saying on a stage that AI is hard has not started a
  // purchase. Presenting it as a trigger would be the drafting stage inventing a
  // buying signal, which is the failure this whole project is built against.
  // THE THESIS ABOUT THE PERSON, written before this stage runs. Without it the
  // drafter has evidence and a constraint and no goal, and the safest output
  // under a constraint with no goal is recitation -- which is exactly what it
  // produced, repeatedly, until a human supplied the reasoning by hand.
  const read = db.prepare(`
    SELECT trying_to_do, in_the_way, next_step, what_an_hour_does, do_not_say, confidence,
           suggests_package, basis, created_at
      FROM reads WHERE person_id = ? AND rejected_at IS NULL
     ORDER BY id DESC LIMIT 1`).get(person.id);

  const angle = db.prepare(`
    SELECT premise, why, basis, block_tag, decided_at
      FROM unblocks
     WHERE person_id = ? AND verdict = 'angle' AND premise IS NOT NULL AND TRIM(premise) <> ''
     ORDER BY id DESC LIMIT 1`).get(person.id);
  const seed = JSON.parse(readFileSync(resolve(ROOT, 'data/seed-outreach.json'), 'utf8'));

  // WHAT THE LAST FEW NOTES SOUNDED LIKE, so this one does not sound like them.
  // Every draft was written blind to every other, and a voice rule written as a
  // pattern duly became one: six notes drafted in a single batch, and FIVE
  // opened their middle paragraph with the identical string "Two guesses at what
  // might be on your list" and closed on the identical "If that or something
  // else is of interest". Each is fine alone. Side by side they are a mail
  // merge, and these people share sectors and conferences.
  //
  // A model cannot avoid repeating itself if it cannot see what it wrote. Only
  // the sentences are passed, never the substance -- the point is to vary the
  // phrasing, not to know what was said to anyone else.
  const recent = db.prepare(`
    SELECT body FROM drafts WHERE person_id <> ? ORDER BY id DESC LIMIT 8`).all(person.id)
    .flatMap((d) => String(d.body ?? '').split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((l) => /^(Two guesses|Am reaching out|Am writing|Saw |You raised|If that or|If either|If there)/i.test(l))
    .map((l) => l.slice(0, 120));
  const recentLines = [...new Set(recent)].slice(0, 10);

  const fmtEv = (e) => {
    const head = `- [${e.provenance}${e.kind ? `/${e.kind}` : ''}] ${retense(e.claim)}\n  SOURCE: ${e.source_url}`;
    // Pasted profile text is the richest evidence there is; include it whole.
    return e.provenance === 'operator_supplied' && e.body
      ? `${head}\n  FULL TEXT:\n${e.body.split('\n').map((l) => `    ${l}`).join('\n')}`
      : head;
  };

  return `# DOSSIER

## THE FIRM
Name (spell it exactly this way): ${org.name}
${[org.domain && `Domain: ${org.domain}`, org.hq && `HQ: ${org.hq}`,
   org.industry && `Industry: ${org.industry}`,
   org.headcount_est && `Headcount estimate: ${org.headcount_est}`,
   org.aum_usd && `AUM: $${(org.aum_usd / 1e9).toFixed(1)}B`].filter(Boolean).join('\n')}

## THE PERSON
${person.name} — ${person.title ?? 'title unknown'}
${[person.decision_role && `Decision role: ${person.decision_role}`,
   person.role_confirmed && `Title corroboration: ${person.role_confirmed}`,
   person.in_seat_since && `In seat since: ${person.in_seat_since}`,
   person.degree && `LinkedIn degree: ${person.degree}`,
   person.platform_activity && `LinkedIn activity: ${person.platform_activity}` +
     (person.followers != null ? ` (${person.followers} followers)` : ''),
   // ONE PLACE, READ BY BOTH. rank blocks on this field; without it here the
   // drafter would go on re-deriving the same judgment from the profile prose
   // underneath, which is how six earlier misalignments started.
   person.buyer_remit && `Remit: ${person.buyer_remit === 'external'
     ? 'the technology this firm SELLS, not the technology it runs — not a buyer for work '
       + 'done on its own operations'
     : person.buyer_remit === 'internal' ? 'the systems this firm runs for itself'
     : person.buyer_remit === 'both' ? 'both what the firm sells and what it runs'
     : 'unclear from the profile'}`,
   person.capability_authority && `Controls spend on the capability: ${person.capability_authority}`,
   person.builds_in_house && `Builds it personally: ${person.builds_in_house}`,
   person.notes && `Operator notes: ${person.notes}`].filter(Boolean).join('\n')}
${boardLines(db, person.id) ? `
## BOARDS THIS PERSON SITS ON NOW (from their firm's own site; each is a company they can introduce you to)
${boardLines(db, person.id)}
` : ''}${operatorSaidLines(db, person.id) ? `
## WHAT THE OPERATOR SAID ABOUT THIS PERSON (first-hand; outranks the read)
${operatorSaidLines(db, person.id)}
` : ''}
## EVIDENCE (every claim you make must trace to one of these)
${evidence.length ? evidence.map(fmtEv).join('\n\n') : '(none — see the instruction about drafting nothing)'}

## DATED TRIGGERS
${signals.length
  ? signals.map((s) => `- ${s.trigger_id} detected ${s.detected_at}: ${s.claim ?? ''} ${s.source_url ?? ''}`).join('\n')
  : '(none on record)'}

## SENTENCES THE LAST FEW NOTES USED — DO NOT REUSE THESE
${recentLines.length
  ? recentLines.map((l) => `- ${l}`).join('\n')
    + `\n\nThese went to OTHER people, recently. Openings and closings repeat far more
than anyone intends, and the reader who notices is the one who also knows
somebody else who got a note. Say this note's version differently — not a
synonym swap, a different shape of sentence. If the natural phrasing is on that
list, the phrasing is not natural, it is a habit.`
  : '(nothing recent on file)'}

## WHAT THIS PERSON IS TRYING TO DO
${read
  ? `A read of this prospect, written before any note existed, ${read.confidence === 'thin'
      ? 'and marked THIN — it reasons mostly from the seat and the sector, so lean on it lightly'
      : 'and marked strong'}. It rests on evidence ${read.basis || '(none cited)'}.

  TRYING TO DO:   ${read.trying_to_do}
  NEXT STEP:      ${read.next_step || '(none named — fall back on the circumstance)'}
                  ^ THIS IS BEAT 2 OF THE RECIPE. Say it in one line and move on.
  IN THE WAY:     ${read.in_the_way || '(nothing visible — which is itself a reason the note may have nothing to offer)'}
  AN HOUR DOES:   ${read.what_an_hour_does}
  DO NOT SAY:     ${read.do_not_say}

WRITE FROM THIS. It is the goal the note serves, and having one is what stops a
draft falling back on reciting facts the recipient already knows about himself.
DO NOT QUOTE IT AT THEM and do not restate it as an observation about their
career — it is your reasoning, not your material. "DO NOT SAY" is binding.

It is still a READ, not a finding. Constraint 1 is unchanged: every factual claim
traces to an evidence id. A motive may be inferred; a project, budget, search,
headcount or deadline may not.`
  : '(no read on file. Run  npm run read -- --person <id>  first. Without one this '
    + 'draft has evidence and a constraint but no goal, and will tend to recite.)'}

## THE OFFER, AND WHETHER IT IS THE RIGHT SIZE
${offerNote || '(the offer chosen is the largest this firm clears, or the gates have no view)'}

## AN ANGLE, WHICH IS NOT A TRIGGER
${angle
  ? `A second-opinion pass over this blocked prospect found a premise a note could
open from. It was judged on ${angle.decided_at ?? 'an earlier run'}, against the block "${angle.block_tag ?? '?'}".

  PREMISE: ${angle.premise}
  REASONING: ${angle.why ?? ''}
  RESTS ON EVIDENCE ID(S): ${angle.basis ?? '(none recorded)'}

USE IT AS THE OPENING AND NOTHING MORE. It is a reason to write, not evidence
this firm is buying. Do not say or imply that they are looking for help, running
a search, or have a budget — none of that is on record. The premise must still
trace to the evidence ids above; if you cannot find it there, say so and draft
nothing rather than dressing the premise up as a finding.`
  : '(none — this prospect has no angle on record)'}

## GATES EVALUATED FOR THIS FIRM
${gates.length
  ? gates.map((g) => `- ${g.gate_id}: ${g.outcome}${g.decided_at ? ` (${g.decided_at})` : ''} — ${g.reason ?? ''}`).join('\n')
  : '(none evaluated)'}

## PRIOR CONTACT WITH THIS FIRM
${prior.length
  ? prior.map((o) => `- ${o.sent_at} via ${o.channel}, pitched ${o.service_pitched ?? '?'}, status ${o.status ?? '?'}` +
      (o.message_text ? `\n  WHAT WAS SENT:\n${o.message_text.split('\n').map((l) => `    ${l}`).join('\n')}` : '')).join('\n')
  : '(no prior contact)'}

## THE SERVICE BEING PITCHED
${service ? `${service.name} (${service.id})
${[service.price_usd && `Price: $${service.price_usd.toLocaleString('en-US')} fixed`,
   service.price_usd_month && `Price: $${service.price_usd_month.toLocaleString('en-US')}/month`,
   service.rate_usd_hour && `Rate: $${service.rate_usd_hour}/hour`,
   service.duration && `Turnaround: ${service.duration}`,
   // WHO IT IS FOR AND WHY THIS ONE, from config/business.yml where the offer
   // is there (matched by name); the old best_for otherwise.
   (bizOffer?.for ?? service.best_for) && `Best for: ${bizOffer?.for ?? service.best_for}`,
   bizOffer?.pitch && `Pitch, in the operator's words: ${bizOffer.pitch}`,
   // THE LINK. A note pitching one offer links to that offer's own page when
   // business.yml names one, so the reader lands on what the note sold rather
   // than on a home page written for a different buyer.
   bizOffer?.url && `Link for this offer (use it in place of the firm's address): ${bizOffer.url}`,
   service.note && `Note: ${service.note}`].filter(Boolean).join('\n')}` : '(none specified)'}

## THE PITCH (name this one and no other)
${line ? `${line.id} — ${line.name} [${line.status}]
Sells: ${line.sells}
The buyer's problem: ${line.buyer_problem}
The seat that buys it: ${line.buyer_seat}
It fires when: ${(line.fires_when ?? '').trim()}
It must NOT be used when: ${(line.never_when ?? '').trim()}
${line.proof_needed ? `WHAT MUST BE SHOWABLE BEFORE THIS PITCH IS HONEST: ${
  line.proof_needed.trim()}
  If the evidence above does not establish that, say so in your reasoning and write a
  weaker note rather than asserting it. This is the precondition of the pitch, not a
  style preference.` : ''}
${line.note ? `Note: ${line.note.trim()}` : ''}` : '(unset)'}

## CITABLE PROOF POINTS (only these may appear in the note)
${(line?.citable_proof_points ?? []).map((p) => `- ${p.claim}\n  URL: ${p.evidence_url}`).join('\n') || '(none citable for this line)'}
${(line?.proof_points ?? []).filter((p) => !p.evidence_url).length
  ? `\nNOT citable (no public URL — do not use):\n${(line.proof_points).filter((p) => !p.evidence_url).map((p) => `- ${p.claim}`).join('\n')}`
  : ''}

## NEVER CLAIM
${(cfg.operator?.never_claim ?? []).map((c) => `- ${c}`).join('\n')}

## THE OPERATOR
${cfg.firm.name}, ${[cfg.firm.location?.town, cfg.firm.location?.county, cfg.firm.location?.metro].filter(Boolean).join(', ') || ''}${cfg.firm.location?.secondary ? ` and ${cfg.firm.location.secondary}` : ''}. ${cfg.firm.url ?? ''}\nHow he works: ${[cfg.firm.location?.remote_ok ? 'remote is fine' : null,
  cfg.firm.location?.travel ? `travel ${cfg.firm.location.travel}` : null,
  cfg.firm.location?.relocation === false ? 'will not relocate' : null]
  .filter(Boolean).join(', ') || 'unstated'} ${cfg.firm.contact_email ?? ''}
Strengths: ${(cfg.operator?.strengths ?? []).join('; ')}
WHO HE IS TODAY (say the credentials in the past tense where these require it):
${(cfg.operator?.standing ?? []).map((x) => `  - ${x}`).join('\n') || '  - not stated'}
Credentials, things he has DONE: ${(cfg.operator?.credentials ?? []).join('; ')}

## CHANNEL RULES (the operator wrote these; they bind you)
${(seed.channel_rules ?? []).map((r) => `- ${r}`).join('\n')}
`;
}

// The channel names stored in `outreach` are the long ones, but nobody types
// "linkedin_inmail" at a prompt. An unnormalised "inmail" silently missed
// CARRIES_SUBJECT and the draft came back with the subject line stripped out and
// a note saying InMail has no subject field. It has one.
const CHANNEL_ALIAS = {
  inmail: 'linkedin_inmail', li_inmail: 'linkedin_inmail',
  li: 'linkedin_message', linkedin: 'linkedin_message', dm: 'linkedin_message',
  connect: 'linkedin_connect_note', note: 'linkedin_connect_note',
  mail: 'email', e: 'email',
};

function resolveChannel(raw) {
  const v = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CHANNEL_ALIAS[v] ?? v;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const personId = args.person && args.person !== true ? String(args.person) : null;
  if (!personId) throw new Error('draft needs --person <id>');

  const cfg = loadConfig();
  const targeting = loadTargeting(cfg);
  const db = openDb();
  const today = new Date().toISOString().slice(0, 10);

  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error(`no person "${personId}"`);
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(person.org_id);

  if (args.show) {
    const rows = db.prepare(`SELECT id, version, channel, created_at, model, cost_usd,
      sent_text, revise_note, subject, body FROM drafts WHERE person_id = ? ORDER BY version`).all(personId);
    console.log(heading(`DRAFTS for ${person.name} (${rows.length})`));
    for (const r of rows) {
      console.log(`\n${bold(`v${r.version}`)} ${dim(`${r.channel} · ${r.created_at} · ${r.model} · ` +
        `$${(r.cost_usd ?? 0).toFixed(4)} · ${r.body.length} chars`)}\n`);
      if (r.revise_note) console.log(dim(`  asked for: ${r.revise_note}\n`));
      if (r.subject) console.log(`${bold('Subject:')} ${r.subject}\n`);
      console.log(r.body);
      // The gap is the lesson. Print it next to the draft that lost the argument.
      if (r.sent_text) {
        const cut = Math.round((1 - r.sent_text.length / r.body.length) * 100);
        console.log(`\n${bold('WHAT HE ACTUALLY SENT')} ${dim(`${r.sent_text.length} chars, ` +
          `${cut}% shorter`)}\n`);
        console.log(r.sent_text);
      }
    }
    db.close();
    return;
  }

  const channel = resolveChannel(args.channel && args.channel !== true ? args.channel : 'email');

  // THE READ PICKS THE OFFER, WHEN THERE IS ONE AND NOTHING OVERRIDES IT. The
  // router goes evidence -> work -> delivered_by -> filter by seat and size ->
  // package, and the drafter then has to justify whatever came out; that is how
  // three drafts in a row came to refuse their assigned pitch. A read has
  // already formed a view of the person and named the package its own reasoning
  // points at, which is the whole reason it runs first. Until now nothing read
  // that field.
  //
  // Explicit --service still wins, and a read that names nothing changes
  // nothing: the router keeps its say wherever no thesis has an opinion.
  const readPick = db.prepare(`SELECT suggests_package FROM reads
     WHERE person_id = ? AND rejected_at IS NULL AND suggests_package <> ''
     ORDER BY id DESC LIMIT 1`).get(personId)?.suggests_package ?? null;
  const serviceId = args.service && args.service !== true ? String(args.service)
    : (readPick ?? null);
  if (!args.service && readPick) {
    console.log(dim(`service from the read: ${readPick} — the thesis chose it, not the router`));
  }

  // WHEN THE READ AND THE GATES DISAGREE, SAY SO. Added 2026-09-24 after the
  // read pitched a single fixed-price hour to a director over three functions at a
  // few-hundred-million-dollar business — a firm that clears the hands-on money gate
  // outright. The operator: "that is small potatoes."
  //
  // A FLOOR WAS THE OBVIOUS FIX AND IT IS THE WRONG ONE. Revenue is RECALLED
  // for 293 of 411 firms here, so a rule that forced a bigger pitch whenever the
  // gate clears would let a model's half-remembered number raise the ask. And
  // the read's choice has been right more often than the router's: it is what
  // caught senior_capacity being pitched at three firms with no AI staff.
  //
  // So neither wins by rule. The disagreement is surfaced, in the draft's own
  // notes and on the card, and the operator decides — which is the same move
  // this project makes everywhere else a judgment is contested.
  let offerNote = '';
  if (!args.service && readPick && org) {
    const live = (cfg.packages ?? []).filter((x) => (x.status ?? 'live') === 'live');
    // NOT RANKED BY PRICE. The first version compared price_usd and quietly
    // dropped every HOURLY offer, because an hourly package carries no fixed
    // price and compares as zero — so the largest offer in the catalogue was
    // the one it could never mention. Ranking offers by size is a judgment this
    // does not need to make: listing what else the firm clears is the whole job,
    // and the operator can see that an hour and a build are different asks.
    const affordable = live.filter((x) => {
      const b = cfg.buyers?.find((y) => y.id === x.buyer);
      return x.id !== readPick && b && clearsMoneyGate(cfg, b.id, org);
    });
    if (affordable.length) {
      const src = org.revenue_source === 'recalled'
        ? ' — noting the revenue behind that is RECALLED, not retrieved' : '';
      offerNote = `The read chose ${readPick}. This firm ALSO clears the money gate for: `
        + `${affordable.map((x) => `${x.id}${x.price_usd ? ` ($${x.price_usd})` : ' (hourly)'}`).join(', ')}`
        + `${src}.\n\nIf ${readPick} reads as small for this seat, that is why. It is a judgment the `
        + `read made, not a limit the gates imposed — say so in the notes if the register looks wrong.`;
      console.log(dim(`  also clears: ${affordable.map((x) => x.id).join(', ')}${src}`));
    }
  }
  const service = serviceId ? cfg.packages.find((s) => s.id === serviceId) : null;
  if (serviceId && !service) {
    throw new Error(`--service "${serviceId}" is not in config/offers.yml. ` +
      `Declared: ${cfg.packages.map((s) => s.id).join(', ')}`);
  }
  // THE BUYER `rank` CHOSE, not the package's primary one.
  //
  // This read `service.buyer`, which is the package's DEFAULT buyer — for the
  // operator's build package that is build_direct. But a package is sold under several
  // buyers via also_under, and rank routes a staffed firm to senior_capacity
  // while still quoting that package. So passing it as --service made draft judge the
  // firm against build_direct, whose exclusion is "must NOT be used when the
  // firm already employs the capability" — and refuse a firm rank had routed to
  // the buyer that EXISTS for firms employing the capability. The top-ranked
  // prospect was refused on a condition that was never in play.
  //
  // Now the buyer is resolved the same way in both branches; --service says
  // which package to quote, not which argument to make.
  const chosen = (() => {
        // THE SAME FACTS `rank` USES, or the two stages disagree about what to
        // sell the same firm. This passed only `kind` and `referralValue`, so it
        // always landed in the no-event, not-staffed branch: `rank` routed a
        // staffed hedge fund to the capacity pitch and `draft` announced "pitch
        // chosen: buyers_side" for the same firm in the same minute. The note
        // came out right only because --service was passed by hand, and without
        // that flag the next draft on a staffed firm would have pitched a
        // proposal read to a team that does not need one.
        // ONE ANSWER, shared with rank. draft kept its own title-only copy, so a
        // firm rank saw as staffed — on a dated signal or a recorded builder —
        // read as unstaffed here. See firmIsStaffed in config.mjs.
        const staffed = firmIsStaffed(db, org.id, capabilityTitles(cfg));
        const SELLING = ['vendor_selection_underway', 'vendor_led_pilot', 'integrator_engaged',
          'published_ai_cost_concern', 'capital_event', 'new_portco'];
        const liveTriggers = new Set(db.prepare(
          `SELECT DISTINCT trigger_id FROM signals WHERE org_id = ? AND retracted_at IS NULL
             AND (decays_at IS NULL OR decays_at > date('now'))`).all(org.id)
          .map((r) => r.trigger_id));
        const triggerCounts = Object.fromEntries(db.prepare(
          `SELECT trigger_id, COUNT(*) n FROM signals WHERE org_id = ? AND retracted_at IS NULL
             AND (decays_at IS NULL OR decays_at > date('now')) GROUP BY trigger_id`)
          .all(org.id).map((r) => [r.trigger_id, r.n]));
        const hasVendorTrigger = db.prepare(
          `SELECT COUNT(*) c FROM signals WHERE org_id = ? AND retracted_at IS NULL
             AND trigger_id IN (${SELLING.map(() => '?').join(',')})`)
          .get(org.id, ...SELLING).c > 0;
        const c = buyerForOrg(cfg, { kind: org.kind, referralValue: person.referral_value,
          staffed, hasVendorTrigger, org });
        // THE READ'S CHOICE STANDS OVER THE FIRM-KIND ROUTER (2026-09-27). The
        // read, which hears the operator's own call, chose an offer; the router
        // then refused "no pitch fits" on the firm's kind alone, for a first
        // Chief AI Officer the operator had marked Write first. Where an offer
        // has been chosen, argue from that offer's own pitch.
        if (!c?.id && service?.buyer) {
          console.log(dim(`no pitch fits ${org.name} by firm kind (${c?.why ?? 'unknown'}); `
            + `arguing from ${service.id}'s own pitch, which the read chose`));
          return resolveBuyer(cfg, service.buyer);
        }
        if (!c?.id) {
          throw new Error(`No pitch fits ${org.name}: ${c?.why ?? 'unknown'}\n` +
            'Pass --service explicitly to override, or fix the firm kind with ' +
            '`npm run lead -- add-org --id ' + org.id + ' --name "..." --kind ...`');
        }
        // A PITCH IS NOT AN OFFER. `rank` picks the SERVICE whose fires_when the
        // evidence satisfies and leaves a firm unrouted when none does; draft
        // stopped at the pitch, so a firm the board shows with no offer at all
        // would still get a note written for it. Refuse instead, with the same
        // reason the card carries, rather than drafting into a gap.
        const svcPick = packageForBuyer(cfg, c.id, { triggers: liveTriggers, triggerCounts,
          staffed, headcount: org.headcount_est ?? null });
        // An explicit --service overrides which package is quoted, but never
        // which buyer is argued from: that is what rank decided.
        if (service) return resolveBuyer(cfg, c.id);
        if (!svcPick?.service?.id) {
          throw new Error(`Pitch "${c.id}" fits ${org.name} but no OFFER under it does: ` +
            'nothing in the evidence satisfies what any of its services ask for. ' +
            'Pass --service to override, or find a trigger this firm can fire.');
        }
        console.log(dim(`pitch chosen: ${c.id} — ${c.why}`));
        console.log(dim(`service chosen: ${svcPick.service.id} — ${svcPick.why}`));
        return resolveBuyer(cfg, c.id);
      })();
  const line = chosen;
  if (chosen && ['dead', 'retired'].includes(chosen.status)) {
    throw new Error(`Pitch "${chosen.id}" is retired: ${(chosen.retired_because ?? '').trim()}`);
  }
  // The system must not draft to someone it has already disqualified — a draft
  // is the moment the suppression list would otherwise be bypassed.
  //
  // But the check is PER PERSON, not per firm. "A firm we have contacted" is
  // not a reason to refuse: the operator's own channel rule says a silent
  // thread should go lateral to someone else at the same firm, and blocking
  // that would forbid the one move the rules prescribe. What is refused is a
  // repeat approach to the same person, a suppressed person, or any person at
  // a firm a gate has killed.
  const history = historyFor(db, [org.id]);
  const h = history.get(org.id);
  const verdict = classify(h, today);
  const refusals = [];

  const blocked = db.prepare(
    'SELECT reason FROM do_not_contact WHERE person_id = ? OR org_id = ?').get(personId, org.id);
  if (blocked) refusals.push(`do-not-contact: ${blocked.reason}`);

  const held = h.holds.find((x) => x.person_id === personId && x.release_after > today);
  if (held) refusals.push(`${person.name} is held until ${held.release_after}: ${held.condition ?? ''}`);

  for (const g of h.gates.filter((x) => x.outcome === 'kill' || x.outcome === 'kill_as_buyer')) {
    refusals.push(`${org.name} was killed on ${g.gate_id}: ${g.reason ?? ''}`);
  }

  const sameChannel = h.outreach.filter(
    (o) => o.person_id === personId && o.channel === channel);
  if (sameChannel.length && sameChannel.every((o) => o.status === 'sent_no_reply')) {
    refusals.push(`${person.name} already received a ${channel} on ${sameChannel[0].sent_at} ` +
      'and never replied. The channel rule requires a NEW channel plus new substance, ' +
      'or a lateral to someone else at the firm.');
  }

  if (refusals.length && !args.force) {
    console.error(`${bold('REFUSING TO DRAFT')} — ${person.name} at ${org.name} [${verdict.status}]`);
    for (const r of refusals) console.error(`  · ${r}`);
    const open = h.people.filter((p) => p.id !== personId
      && !h.outreach.some((o) => o.person_id === p.id)
      && !h.dnc.some((d) => d.person_id === p.id)
      && !h.holds.some((x) => x.person_id === p.id && x.release_after > today));
    if (open.length) {
      console.error(dim(`\n  Laterals still open at ${org.name}:`));
      for (const p of open) console.error(dim(`    ${p.id}  ${p.name} — ${p.title ?? '?'}`));
    }
    console.error(dim('\nRe-run with --force only if this is deliberate.'));
    db.close();
    process.exit(2);
  }
  if (h.outreach.length) {
    console.log(dim(`note: ${org.name} has ${h.outreach.length} prior outreach on record; ` +
      'this is a lateral. The dossier includes what was already said.'));
  }

  // models.draft, falling back to the default. Drafting is the one stage whose
  // output IS the deliverable, and the head-to-head recorded in runtime.yml is
  // why it gets its own key rather than riding the default.
  const model = args.model && args.model !== true ? String(args.model)
    : (cfg.models.draft ?? cfg.models.default);
  // MEDIUM, NOT HIGH, since 2026-09-21. `max_tokens` covers thinking AND the
  // answer, so effort decides how long the stage may deliberate — and it was
  // pinned at maximum for every draft regardless of how much judgment the case
  // needed. Measured on the same dossiers, both directions:
  //
  //   a refusal   high 4,075 out / $0.0800   medium 1,346 out / $0.0527
  //   a real note high 13,148 out / $0.1448  medium 4,008 out / $0.0733
  //
  // Same verdicts, comparable notes, roughly half the cost — and on the refusal
  // medium made a distinction high missed. The deliberation high was buying had
  // largely become redundant: the checks it kept re-deriving from prose —
  // is the firm staffed, is this seat hiring, does someone here build it —
  // now run in `rank`, free and deterministic, before draft is ever called.
  //
  // `--effort high` is still there for a case that earns it.
  const effort = args.effort && args.effort !== true ? String(args.effort) : 'medium';

  // --revise rewrites the latest version rather than starting over. The dossier
  // still goes in, because an instruction like "shorter" must not be allowed to
  // cost the note its evidence.
  const revise = args.revise && args.revise !== true ? String(args.revise) : null;
  // A REVISE CAN CHANGE THE CHANNEL. The card lets the operator pick Email and
  // press revise on an InMail draft, and this refused with "no email draft yet"
  // (2026-09-29): the revise was looked up on the new channel only. With no
  // draft on the new channel, the newest draft on any channel is the one he was
  // reading, so it is rewritten into the new channel's shape.
  const prior = revise
    ? db.prepare(`SELECT id, version, body, channel FROM drafts WHERE person_id = ? AND channel = ?
                  ORDER BY version DESC LIMIT 1`).get(personId, channel)
      ?? db.prepare(`SELECT id, version, body, channel FROM drafts WHERE person_id = ?
                  ORDER BY id DESC LIMIT 1`).get(personId)
    : null;
  const crossChannel = Boolean(prior && prior.channel !== channel);
  if (revise && !prior) {
    throw new Error(`nothing to revise: no ${channel} draft for "${personId}" yet. ` +
      'Run without --revise first.');
  }

  // WHICH EXAMPLES. Two arms, alternated, so the Scoreboard can say whether
  // notes chosen for this recipient beat the fixed set (src/voice-examples.mjs).
  // `--examples fixed|picked` forces one.
  const arm = chooseArm(db, { prior, override: args.examples && args.examples !== true ? String(args.examples) : null });
  const voice = voiceFor(db, { arm, voiceText: readVoice(), pickedPrompt: readPrompt(PICKED_PROMPT),
    personId, channel, packageId: serviceId, superseded: cfg.operator?.superseded_wording,
    neverClaim: cfg.operator?.never_claim,
    before: args['pool-before'] && args['pool-before'] !== true ? Number(args['pool-before']) : null });
  const system = `${readPrompt(PROMPT_FILE)}\n\n---\n\n${voice.text}`;
  const poolBefore = args['pool-before'] && args['pool-before'] !== true ? Number(args['pool-before']) : null;
  const cutoff = poolBefore
    ? db.prepare(`SELECT MIN(created_at) t FROM drafts WHERE person_id = ?`).get(personId)?.t?.slice(0, 10) ?? null
    : null;
  const dossier = buildDossier(db, cfg, targeting, person, org, service, line, offerNote, cutoff);

  const runId = startRun(db, 'draft', { model, notes: `${personId} ${channel} ${serviceId ?? ''}` });
  console.log(dim(`${revise ? `revising ${crossChannel ? `the ${prior.channel} ` : ''}v${prior.version} for` : 'drafting for'} ${person.name} ` +
    `at ${org.name} · ${channel} · ${service?.id ?? 'no service'} · ${model} · effort ${effort}`));
  if (revise) console.log(dim(`  asked for: ${revise}`));
  console.log(dim(`  examples: ${voice.record.arm}${voice.record.shown ? ` (${voice.record.shown.length} chosen sent notes + ${voice.record.anchors} anchors)` : ''}${voice.record.fell_back ? ` — ${voice.record.fell_back}` : ''}`));

  // A connection note has LinkedIn's hard cap (draft-cold-note v24 says what to do with it).
  const capNote = channel === 'linkedin_connect_note'
    ? `\n\nCHARACTER LIMIT: ${CONNECT_NOTE_MAX} characters for the note, spaces included.` : '';
  // Generous: max_tokens covers thinking plus the note plus the NOTES section.
  // A note is ~400 tokens; the rest is headroom for reasoning over the dossier.
  const res = await complete(db, runId, {
    // 24000, NOT 32000. Above roughly that the SDK refuses a non-streaming
    // request outright — "streaming is required for operations that may take
    // longer than 10 minutes" — which fails client-side, unbilled, and looks
    // like a model problem. 16000 was too low for a dossier carrying two full
    // pasted profiles; this sits between the two limits. Streaming would remove
    // the ceiling properly and is the real fix if drafts keep growing.
    model, system, effort, maxTokens: 24000,
    messages: [{ role: 'user', content: revise
      ? `${dossier}\n\nHere is version ${prior.version}, which the operator wants changed:\n\n` +
        `<<<DRAFT\n${prior.body}\nDRAFT\n\n` +
        `WHAT HE ASKED FOR: ${revise}\n\n` +
        (crossChannel
          ? `The version above was written as a ${prior.channel} note. Rewrite it as the ${channel} ` +
            'note: follow that channel\'s own rules (its length, and whether it takes a SUBJECT), ' +
            'keep the substance, and change what he asked about. An instruction '
          : `This is the ${channel} note — the same channel as the version above, and the ` +
            'SUBJECT rules apply to it exactly as they did the first time. ' +
            'Rewrite it. Change what he asked about and leave the rest alone — an instruction ') +
        'about length is not licence to drop the evidence, and an instruction about one ' +
        'paragraph is not licence to rewrite the opening. Today is ' + today + '.' + capNote
      : `${dossier}\n\nDraft the ${channel} note. Today is ${today}.${capNote}` }],
  });

  if (!res.text.trim()) {
    throw new Error('the model returned no text. Nothing stored.');
  }
  // Headers as plain words, so every split below finds them (checks.mjs).
  res.text = unbold(res.text);

  // --no-store: a replay for measurement (src/replay-drafts.mjs). The call is
  // costed in `runs` like any other; the note is printed and never stored, so
  // it reaches no card and no Scoreboard count.
  if (args['no-store']) {
    finishRun(db, runId, { cost_usd: res.cost_usd ?? 0 });
    console.log(`REPLAY ${JSON.stringify({ arm: voice.record.arm, examples: voice.record,
      cost_usd: res.cost_usd, body: noteBody(res.text) })}`);
    db.close();
    return;
  }

  // Split the subject off the body. It is stored in its own column because the
  // operator pastes it into a different box than the note, and because pairing
  // it later against what he actually used is the same evidence the body/sent
  // gap gives — a subject nobody ever reused is a subject that was wrong.
  //
  // Channels without a subject field must not carry one: an invented subject on
  // linkedin_message ends up as the first line of the message.
  const CARRIES_SUBJECT = new Set(['email', 'linkedin_inmail']);
  const subjectMatch = res.text.match(/^SUBJECT\s*\n-+\s*\n(.+?)\s*$/m);
  let subject = subjectMatch ? subjectMatch[1].trim() : null;
  // The model sometimes explains itself where the subject goes — "(omitted —
  // channel not marked email or InMail)" was stored verbatim as a subject and
  // would have gone out as one. A subject is a line addressed to the recipient;
  // a parenthetical about the instructions is not.
  if (subject && (/^[([]/.test(subject) || /\b(omitted|n\/a|none|not applicable)\b/i.test(subject))) {
    console.log(dim(`  ignoring a non-subject the model wrote there: ${subject}`));
    subject = null;
  }
  if (subject && !CARRIES_SUBJECT.has(channel)) {
    console.log(dim(`  discarding a subject: ${channel} has no subject field`));
    subject = null;
  }
  if (!subject && CARRIES_SUBJECT.has(channel)) {
    console.log(dim('  no subject returned — write one yourself before sending; ' +
      'an empty subject on this channel reads as a broken send'));
  }
  // The stored body keeps SUBJECT out of it, so what is stored is what he pastes.
  const body = res.text.replace(/^SUBJECT\s*\n-+\s*\n.+?\n+/m, '');
  if (channel === 'linkedin_connect_note') {
    const note = body.split(/^NOTES\s*$/m)[0].replace(/^\s*DRAFT\s*\n-+\s*\n/m, '').trim();
    if (note.length > CONNECT_NOTE_MAX) {
      console.log(bold(`  ${note.length} characters: over LinkedIn's ${CONNECT_NOTE_MAX} for a connection note. `
        + 'Cut it before sending; the box shows the count.'));
    }
  }

  // THE CLAIM GATE. draft-cold-note has said since v1 that every factual claim
  // must trace to the dossier. On the first firm where it mattered, TWO
  // DIFFERENT MODELS violated it, differently, in the same sentence position: a
  // biotech whose own site says its lead product is "in Phase 3 development"
  // was told its "PDUFA date" was "behind you" and, in the next draft, that its
  // "BLA" was "under priority review". Both sentences read perfectly. Neither
  // is in the evidence, and they contradict each other.
  //
  // A prompt is guidance where this is a control, which is the same reason
  // `glean` verifies its quotes in code: that gate has refused a fabricated
  // quote across 218 calls, and this prose rule was broken on its first real
  // test. So the note is CHECKED BEFORE IT IS STORED, by a separate call with
  // the evidence in front of it and no stake in the note reading well.
  //
  // It flags, it does not rewrite. A note with an unsupported claim is still
  // written to the drafts table, marked, and refused at the console — deleting
  // it would hide the failure that needs reading.
  let claimCheck = null;
  if (!args['no-check']) {
    const checkPrompt = readFileSync(resolve(ROOT, 'prompts/check-claims.md'), 'utf8');
    const ev = db.prepare(`SELECT id, kind, claim, body FROM evidence
       WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL)) ORDER BY id`).all(personId, org.id)
      .map((e) => `- [id ${e.id}] ${retense(e.claim)}`
        + (e.body && String(e.body).trim().length > 80
          ? `\n${retense(String(e.body).trim()).slice(0, e.kind === 'operator_profile' ? 30000 : 2200).split('\n').map((l) => `    ${l}`).join('\n')}` : ''))
      .join('\n');
    // A pasted profile goes in whole; cut at 2,200 characters, a post far down
    // the page could neither support a claim nor be seen to be recited.
    // What the operator said counts as evidence for the check: he knows it
    // first-hand, and a note may rest on it (never attribute it to him).
    const said = operatorSaidLines(db, personId);
    const chk = await complete(db, runId, {
      model: cfg.models.draft ?? cfg.models.default, maxTokens: 6000,
      schema: CLAIM_SCHEMA, system: checkPrompt,
      messages: [{ role: 'user', content:
        `## The note\n\n${body}\n\n## The evidence on file\n\n${ev || '(none)'}`
        + (said ? `\n\n## What the operator knows first-hand (counts as evidence)\n\n${said}` : '') }],
    });
    claimCheck = chk.data ?? null;
  }

  const version = (db.prepare(
    'SELECT COALESCE(MAX(version), 0) v FROM drafts WHERE person_id = ? AND channel = ?')
    .get(personId, channel).v) + 1;

  db.prepare(`INSERT INTO drafts (org_id, person_id, channel, version, body, package_id,
      prompt_file, model, tokens_in, tokens_out, cost_usd, created_at, run_id,
      revised_from, revise_note, subject, examples)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(org.id, personId, channel, version, body, serviceId, PROMPT_FILE, model,
         res.usage.input_tokens, res.usage.output_tokens, res.cost_usd,
         new Date().toISOString(), runId, prior?.id ?? null, revise, subject,
         JSON.stringify(voice.record));

  // REBUILD THE CARDS. Drafting from the command line left the dashboards on
  // whatever they said before, so the operator opened a card and saw an older
  // note than the one just written -- "i dont see the latest note in the card".
  // The Draft button rebuilt them because the server runs `dash` after every
  // action; the CLI did not, and the two paths write the same table.
  //
  // Half a second, measured, and it runs after the row is stored so a failed
  // rebuild cannot lose a draft.
  if (!args['no-dash']) {
    try {
      execFileSync('npm', ['run', 'dash', '--silent'], { cwd: ROOT, encoding: 'utf8' });
    } catch { console.log(dim('  (dashboards not rebuilt; run `npm run dash`)')); }
  }

  // DOES THE NOTE ADDRESS THE PERSON IT IS FILED UNDER? A prompt rule told the
  // stage it could "draft for a different person" when a prior message went
  // unanswered, and it did: a note to a CFO came back addressed to his CTO,
  // describing the CFO in the third person, stored under the CFO. Sending that
  // is unrecoverable, and nothing would have caught it but the operator reading
  // the salutation.
  //
  // The rule is fixed, and this is the control, because a prompt is guidance.
  const first = String(person.name ?? '').trim().split(/\s+/)[0] ?? '';
  const salutation = (body.match(/^\s*(Greetings|Hi|Hello|Howdy|Dear)[^\n]*/mi) ?? [''])[0];
  if (first && salutation && !new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(salutation)) {
    console.log(heading('WRONG RECIPIENT'));
    console.log(`  This draft is filed under ${bold(person.name)} and opens "${salutation.trim()}".`);
    console.log('  A note addressed to the wrong person cannot be taken back. The draft is');
    console.log('  stored so you can read it, and it should not be sent as written.');
    process.exitCode = 2;
  }

  // DOES THE NOTE SAY WHAT HE DOES, AND START FROM THEM? Two beats of the recipe
  // in prompts/voice.md, both stated plainly there since v19, both routinely
  // ignored. Measured over 30 recent drafts on 2026-09-25: 27% carried no bridge
  // sentence at all, and 37% opened on an abstraction instead of the prospect.
  //
  // The operator, reading one of them: "its very sales-ey and its unclear until
  // 50% that I am an AI consultant offering my services."
  //
  //   Beat 1 "their situation, as a fact"  became  "Size is the half of growth
  //     you can plan for." / "A newly created AI remit at a company this size
  //     tends to draw work." / "Credit, real assets and GP stakes are three
  //     different animals." -- an indefinite noun phrase stating a general
  //     truth, which is a consultant's insight-hook and not a fact about anyone.
  //   Beat 2 "one flat line saying that is what he does" became "A guess at
  //     something buildable there." -- naming no capability, so a cold reader
  //     reaches the credential paragraph still not knowing what is on offer.
  //
  // A prompt already says both. This is the control, for the same reason the
  // salutation check above is one.
  const salLine = (body.match(/^\s*(?:Greetings|Hi|Hello|Howdy|Dear)[^\n]*/mi) ?? [''])[0];
  const prose = body.slice(body.indexOf(salLine) + salLine.length).trim();
  const opener = (prose.split(/(?<=[.?!])\s/)[0] ?? '').trim();

  // BEAT 1 SAYS "DRAWN FROM THE EVIDENCE", so test exactly that rather than
  // testing for the word "you". The first version of this check looked for a
  // second person and passed the note that prompted it: "Size is the half of
  // growth YOU can plan for" is a maxim with a pronoun in it, which is the whole
  // trick. An opener that is really about them carries a term that appears in
  // what is on file about them.
  const evWords = new Set();
  // THE BODY, NOT JUST THE CLAIM. `claim` is a one-line summary; the vocabulary a
  // real opener draws on -- a pasted profile, a session abstract -- is in `body`.
  // Testing claims alone flagged two openers that quoted the prospect directly.
  for (const e of db.prepare('SELECT claim, body FROM evidence WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL))')
    .all(person.id, org.id)) {
    for (const w of `${e.claim ?? ''} ${e.body ?? ''}`.toLowerCase()
      .match(/[a-z][a-z0-9'-]{4,}/g) ?? []) evWords.add(w);
  }
  for (const w of `${org.name ?? ''} ${person.name ?? ''}`.toLowerCase()
    .match(/[a-z][a-z0-9'-]{3,}/g) ?? []) evWords.add(w);
  const openerWords = opener.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? [];
  const namesThem = openerWords.some((w) => evWords.has(w));

  // BEAT 2 IS THE SECOND BEAT, and where it sits is the whole point. Eckl's note
  // does contain "I build" -- in the fourth paragraph, after the pitch, which is
  // precisely the operator's complaint: "its unclear until 50% that I am an AI
  // consultant offering my services." A bridge that arrives late is not a bridge,
  // it is a footnote. So this asks where the first one lands, not whether one
  // exists anywhere.
  //
  // Kept as a family of phrasings rather than one string: a fixed sentence is how
  // six notes in one batch came back with identical middle paragraphs.
  const BRIDGE = /(is what I do|what I sell is|that is what I sell|is what I build|is the next piece|is one of the many things I do|and that is what I|which is what I)/i;
  const bridgeAt = prose.search(BRIDGE);
  const hasBridge = bridgeAt >= 0;
  const bridgeEarly = hasBridge && bridgeAt / Math.max(prose.length, 1) <= 0.55;

  const recipeMisses = [];
  if (!namesThem) {
    recipeMisses.push('beat 1: the opener shares no term with the evidence on file — it is a '
      + `maxim, not their situation: "${opener.slice(0, 88)}"`);
  }
  if (!hasBridge) {
    recipeMisses.push('beat 2: no bridge — nothing says flatly that this is what he does');
  } else if (!bridgeEarly) {
    recipeMisses.push(`beat 2: the bridge arrives ${Math.round(100 * bridgeAt / prose.length)}% `
      + 'of the way in. A reader should know what is on offer before the credential, not after');
  }

  console.log(heading(`DRAFT v${version} — ${person.name}, ${org.name}`));
  console.log(res.text);

  // REFUSED AT THE CONSOLE, not deleted from the table. The draft stays so the
  // failure can be read; what it does not get is a clean bill of health.
  if (claimCheck?.verdict === 'unsupported' && claimCheck.unsupported?.length) {
    console.log(heading('CLAIMS THIS NOTE CANNOT SOURCE'));
    for (const u of claimCheck.unsupported) {
      console.log(`  ${bold('UNSOURCED')} "${u.claim}"`);
      console.log(dim(`             ${u.why}`));
    }
    console.log(bold('\n  DO NOT SEND THIS AS WRITTEN.') + ' Each line above asserts something about');
    console.log('  the recipient or their firm that the evidence does not support. A fabricated');
    console.log('  fact in a cold note reads perfectly and is checked instantly by the one person');
    console.log('  who would know — which is why this is a gate and not a note in a prompt.');
    console.log(dim('\n  Revise, or re-run. --no-check skips this, and is for when you have'));
    console.log(dim('  already read the evidence yourself.'));
    // EXIT 2, NOT 1. A failed claim check is a verdict about the note, not a
    // crash of the stage -- the draft was written and stored and is sitting in
    // the table. The inbox server shells out with execFileSync, which throws on
    // any non-zero status, so exit 1 made a perfectly good draft that merely
    // failed its check arrive at the browser as a server error. A distinct code
    // lets a caller tell "this note has an unsourced claim" from "this stage
    // broke", which are different things to do something about.
    process.exitCode = 2;
  } else if (claimCheck?.verdict === 'supported') {
    console.log(dim('\n  claims check: every factual claim traces to the evidence on file'));
  }

  if (recipeMisses.length) {
    console.log(heading('OFF THE RECIPE'));
    for (const m of recipeMisses) console.log(`  ${bold('MISS')} ${m}`);
    console.log(dim('\n  prompts/voice.md beats 1 and 2: their situation as a fact, then one flat'));
    console.log(dim('  line naming the capability. A note that opens on a maxim and never says'));
    console.log(dim('  what he does reads as sales copy, and the reader is half way in before'));
    console.log(dim('  they learn an AI consultant is writing to them.'));
    process.exitCode = 2;
  }
  // THE NOTE, NOT THE NOTES. Checked over the whole response, "Go" on the
  // never-claim list matched the drafter's own advice to "Go lateral to ..."
  // three times in ten drafts. Only the note is sent.
  const hits = neverClaimHits(noteBody(res.text), cfg.operator?.never_claim);
  if (hits.length) {
    console.log(`\n${bold('NEVER_CLAIM — this draft names something you do not claim')}`);
    for (const h of hits) {
      console.log(`  ${bold(h.term)}  ${dim(`(${h.entry})`)}\n    ...${h.around}...`);
    }
    console.log(dim('  Cut it before sending. The draft is stored either way — what the ' +
      'model wrote is the record.'));
  }

  console.log(dim(`\n${res.usage.input_tokens} in / ${res.usage.output_tokens} out · ` +
    `$${(res.cost_usd ?? 0).toFixed(4)} · ${model} · prompt ${PROMPT_FILE}`));
  console.log(dim('Nothing was sent. Edit this, send it yourself, then record what you ' +
    `actually sent:\n  npm run lead -- sent --person ${personId} --channel ${channel} ` +
    `--service ${serviceId ?? '<id>'} --file sent.txt`));

  finishRun(db, runId, { cost_usd: res.cost_usd ?? 0 });
  db.close();
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
