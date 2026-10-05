// Which sent notes the drafter learns from, chosen for each draft. No model.
//
// THE FIXED SET STOPS LEARNING THE DAY IT IS WRITTEN. `prompts/voice.md` holds
// about nine notes the operator sent, picked by hand, and every draft sees the
// same nine. Everything he has sent since, and everything he asked to have
// changed on the way, sat in `drafts` and taught nothing. The judge already
// learns this way from his calls (the dozen most similar, `src/judge.mjs`);
// this does the same for notes: the sent notes to the people most like this
// recipient, each with the draft it started as and what he asked for between.
//
// EXAMPLES, NOT RULES. Nothing here is summarised into a style rule. The
// prompt was cut from hundreds of lines of rules to a short recipe and real
// notes because rules pile up and interact; this keeps the notes real and only
// changes which ones are shown.
//
// A FIXED COUNT, so cost does not grow with the pool. Choosing is code over
// the database; only the K chosen reach the model.
//
// MEASURED AGAINST THE FIXED SET. New drafts alternate between `fixed`
// (voice.md as written) and LIVE_CHALLENGER, and each draft records its arm, so
// the Scoreboard can say whether the challenger's notes need less changing
// before they go out.

import { features, similarity } from './similar.mjs';
import { noteBody } from './checks.mjs';
import { neverClaimHits } from './never-claim.mjs';

export const PICKED_PROMPT = 'prompts/voice-picked.md';
export const PICKED_K = 6;
export const ANCHORS = 3;
// Fewer chosen notes than this and the picked arm is not worth running: it
// would be the anchors alone, a weaker version of the fixed set.
const MIN_POOL = 3;

const tokens = (t) => String(t ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? [];

/**
 * Share of words that differ between the draft's note and what was sent:
 * 0 is sent exactly as drafted, 1 is nothing kept. Counted on the note alone,
 * since a draft also carries a NOTES section written for the operator.
 */
export function changed(draftBody, sentText) {
  const a = tokens(noteBody(draftBody));
  const b = tokens(sentText);
  if (!a.length && !b.length) return 0;
  const left = new Map();
  for (const w of a) left.set(w, (left.get(w) ?? 0) + 1);
  let kept = 0;
  for (const w of b) if (left.get(w) > 0) { kept++; left.set(w, left.get(w) - 1); }
  return 1 - kept / Math.max(a.length, b.length);
}

/** voice.md split into its prose and its notes (each `### ` under `# The notes`). */
export function splitVoice(text) {
  const at = text.search(/^# The notes\s*$/m);
  if (at < 0) return { prose: text, intro: '', notes: [] };
  const prose = text.slice(0, at).replace(/\n-{3,}\s*$/, '').trimEnd();
  const rest = text.slice(at);
  const parts = rest.split(/^(?=### )/m);
  return { prose, intro: parts[0].trim(), notes: parts.slice(1).map((n) => n.trim()) };
}

/** Old wording in a sent note replaced by the operator's current wording. */
export function updateWording(text, superseded = []) {
  let out = String(text ?? '');
  for (const s of superseded ?? []) {
    if (s?.was && s?.now) out = out.split(String(s.was).trim()).join(String(s.now).trim());
  }
  return out;
}

// THE LIVE COMPARISON: fixed against this one, alternating (decided
// 2026-10-05). An offline replay of 30 sent notes found no arm beat fixed, but
// that replay is tilted toward fixed (every sent note began as a fixed-arm
// draft), so it can rule an arm out and cannot rule one in. `recent` is the arm
// most unlike fixed, the only one that shows what each note was written from,
// and so the one a few weeks of live sends could tell apart. `picked` and
// `edits` stay available through --examples and `npm run replay`.
export const LIVE_CHALLENGER = 'recent';

/**
 * The arm for a new draft. A revision keeps the arm of the version it revises,
 * so a revised note is attributed to the examples it started from. A new note
 * takes the arm the last new note did not, which keeps the two arms level.
 */
export function chooseArm(db, { prior = null, override = null } = {}) {
  if (['fixed', 'picked', 'edits', 'recent'].includes(override)) return override;
  if (prior) {
    const row = db.prepare('SELECT examples FROM drafts WHERE id = ?').get(prior.id);
    return armOf(row?.examples) ?? 'fixed';
  }
  const last = db.prepare(`SELECT examples FROM drafts
    WHERE examples IS NOT NULL AND revised_from IS NULL ORDER BY id DESC LIMIT 1`).get();
  return armOf(last?.examples) === LIVE_CHALLENGER ? 'fixed' : LIVE_CHALLENGER;
}

export function armOf(json) {
  try { return JSON.parse(json ?? 'null')?.arm ?? null; } catch { return null; }
}

/**
 * An instruction that can be shown while drafting to someone else: short, and
 * quoting nothing from the recipient's own pages. Brackets and "profile says"
 * are how quoted text arrives; a long instruction is usually about one person.
 */
export function portable(ask) {
  const a = String(ask ?? '');
  return a.length <= 200 && !/[[\]{}]/.test(a) && !/\b(profile|about section|bio|post)\b[^.]{0,40}\b(says|said|reads|writes)\b/i.test(a);
}

/**
 * The K sent notes to the people most like this one. One per recipient, his
 * latest. Never this person or anyone at their firm: those notes are already in
 * the dossier as prior contact, and an example is not evidence.
 */
export function pickExamples(db, { personId, channel, packageId, superseded = [], neverClaim = [],
  k = PICKED_K, before = null } = {}) {
  // SAME CHANNEL ONLY. A connection note is 300 characters and an InMail is
  // three paragraphs; in the first replay a connection note shown InMails came
  // back longer and further from what was sent.
  const me = features(db, personId);
  if (!me) return [];
  const rows = db.prepare(`SELECT d.id, d.person_id, d.org_id, d.channel, d.package_id, d.body, d.sent_text
      FROM drafts d WHERE d.sent_text IS NOT NULL AND TRIM(d.sent_text) <> ''
       AND d.person_id IS NOT NULL AND d.person_id <> ? AND d.org_id <> ? AND d.id < ? AND d.channel = ?
     ORDER BY d.id DESC`).all(personId, me.person.org_id, before ?? Number.MAX_SAFE_INTEGER, channel);
  // ^ `before`, for a replay: only notes drafted before the one being replayed,
  // so a later note cannot hand the answer back.
  const asked = db.prepare(`SELECT revise_note FROM drafts WHERE person_id = ? AND id <= ?
      AND revise_note IS NOT NULL AND TRIM(revise_note) <> '' ORDER BY id`);
  const seen = new Set();
  const scored = [];
  for (const r of rows) {
    if (seen.has(r.person_id)) continue;
    seen.add(r.person_id);
    const asks = asked.all(r.person_id, r.id).map((x) => x.revise_note.trim());
    // Only instructions that travel. One quoted text a prospect had planted in
    // their profile for AI readers; shown to the drafter for someone else, it
    // would be an instruction from a stranger. Such a note, and its whole
    // chain, stays out of every pool.
    if (!asks.every(portable)) continue;
    const sent = updateWording(r.sent_text, superseded).trim();
    // A sent note that says something he must never claim is not a model to copy.
    if (neverClaimHits(sent, neverClaim).length) continue;
    const f = features(db, r.person_id);
    if (!f) continue;
    const delta = changed(r.body, r.sent_text);
    // Similar recipient first, and the same offer counts for a lot. A note he
    // rewrote carries more of his own voice than one he sent as drafted, so it
    // edges ahead.
    const score = similarity(me, f) + (packageId && r.package_id === packageId ? 2 : 0) + Math.min(1, delta * 4);
    scored.push({ ...r, f, sent, delta, score, asked: asks });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function indent(text) {
  return String(text).trim().split('\n').map((l) => `    ${l}`).join('\n');
}

/** One example as the drafter sees it: who, what was drafted, what was asked, what went. */
export function renderExample(x, i, superseded = []) {
  const who = [x.f.person.title ?? 'title unknown', String(x.f.org.kind ?? 'firm').replace(/_/g, ' '),
    x.f.org.headcount_est && `about ${x.f.org.headcount_est.toLocaleString('en-US')} people`].filter(Boolean).join(', ');
  const same = x.delta < 0.02;
  return [
    `### Example ${i + 1}: ${who} · ${x.channel}${x.package_id ? ` · ${x.package_id}` : ''}`,
    '',
    same ? 'SENT EXACTLY AS DRAFTED:' : 'WHAT THE DRAFT SAID:',
    same ? indent(x.sent) : indent(updateWording(noteBody(x.body), superseded)),
    ...(x.asked.length ? ['', 'WHAT HE ASKED TO HAVE CHANGED:', ...x.asked.map((a) => `    - ${a}`)] : []),
    ...(same ? [] : ['', `WHAT HE SENT (${Math.round(x.delta * 100)}% of the words changed):`, indent(x.sent)]),
  ].join('\n');
}

// ---- edits as examples ------------------------------------------------------
//
// HIS EDITS, NOT HIS NOTES. A median sent note differs from its draft by under
// a tenth of its words, so a whole note mostly shows the drafter what it
// already does. The sentences he changed are the lesson, and the opening is the
// one he changes most (38 of 73 sent notes, 2026-10-05). So this arm shows,
// for the notes to the most similar recipients on the same channel, each
// sentence he rewrote, cut or added, and each change a plain-word instruction
// of his produced. Still examples: nothing is summarised into a rule.

export const EDITS_PROMPT = 'prompts/voice-edits.md';
const EDIT_PEOPLE = 12;
const EDIT_MAX = 20;
const PER_NOTE = 3;

/** A note as sentences: lines, then sentence ends. */
export function sentences(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .flatMap((l) => l.split(/(?<=[.?!])\s+(?=[A-Z"\u201c(])/)).map((x) => x.trim()).filter(Boolean);
}

// The greeting, the sign-off, a name or a bare link: not where the voice is.
const isFrame = (x) => /^(Greetings|Hi|Hello|Dear|Howdy)\b/i.test(x)
  || /^(Best|Thanks|Thank you|Regards|Cheers|Sincerely)\b[,.!]?$/i.test(x)
  || (x.split(/\s+/).length < 4 && !/[.?!]$/.test(x));

function overlap(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  let i = 0;
  for (const w of A) if (B.has(w)) i++;
  return i / ((A.size + B.size - i) || 1);
}

/**
 * Sentence-level edits from one text to another: each `from` sentence paired
 * with its closest `to` sentence (greedy, one to one, at least 30% shared
 * words); paired and different is a rewrite, unpaired is a cut or an addition.
 * `opening` marks the first sentence after the greeting.
 */
export function sentenceEdits(fromText, toText) {
  const a = sentences(fromText).filter((x) => !isFrame(x));
  const b = sentences(toText).filter((x) => !isFrame(x));
  const cands = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const o = overlap(a[i], b[j]);
    if (o >= 0.3) cands.push([o, i, j]);
  }
  cands.sort((x, y) => y[0] - x[0]);
  const ai = new Map(), bj = new Set();
  for (const [, i, j] of cands) if (!ai.has(i) && !bj.has(j)) { ai.set(i, j); bj.add(j); }
  const norm = (x) => tokens(x).join(' ');
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (!ai.has(i)) out.push({ kind: 'cut', from: a[i], opening: i === 0 });
    else if (norm(a[i]) !== norm(b[ai.get(i)])) out.push({ kind: 'rewrote', from: a[i], to: b[ai.get(i)], opening: i === 0 });
  }
  for (let j = 0; j < b.length; j++) if (!bj.has(j)) out.push({ kind: 'added', to: b[j], opening: j === 0 });
  return out;
}

/** The edits behind the notes to the most similar recipients, on this channel. */
export function pickEdits(db, opts) {
  const { superseded = [], neverClaim = [] } = opts;
  const people = pickExamples(db, { ...opts, k: EDIT_PEOPLE });
  const revisions = db.prepare(`SELECT d.revise_note, d.body, p.body AS prior FROM drafts d
      JOIN drafts p ON p.id = d.revised_from
     WHERE d.person_id = ? AND d.id <= ? AND d.revise_note IS NOT NULL AND TRIM(d.revise_note) <> ''
     ORDER BY d.id`);
  const notes = [];
  let total = 0;
  for (const x of people) {
    if (total >= EDIT_MAX) break;
    const fix = (t) => updateWording(t, superseded);
    // Openings first: the sentence he changes most.
    const byHand = sentenceEdits(fix(noteBody(x.body)), x.sent)
      .filter((e) => !e.to || !neverClaimHits(e.to, neverClaim).length)
      .sort((p, q) => Number(q.opening) - Number(p.opening)).slice(0, PER_NOTE);
    const asked = revisions.all(x.person_id, x.id).map((r) => ({ note: r.revise_note.trim(),
      edits: sentenceEdits(fix(noteBody(r.prior)), fix(noteBody(r.body))).slice(0, PER_NOTE) }))
      .filter((r) => r.edits.length);
    const n = byHand.length + asked.reduce((t, r) => t + r.edits.length, 0);
    if (!n) continue;
    notes.push({ ...x, byHand, asked: asked });
    total += n;
  }
  return notes;
}

function renderEdit(e) {
  const tag = e.opening ? ' (the opening)' : '';
  if (e.kind === 'cut') return `- CUT${tag}: "${e.from}"`;
  if (e.kind === 'added') return `- ADDED${tag}: "${e.to}"`;
  return `- REWROTE${tag}:\n    drafted: "${e.from}"\n    sent:    "${e.to}"`;
}

export function renderEdits(x, i) {
  const who = [x.f.person.title ?? 'title unknown', String(x.f.org.kind ?? 'firm').replace(/_/g, ' '),
    x.f.org.headcount_est && `about ${x.f.org.headcount_est.toLocaleString('en-US')} people`].filter(Boolean).join(', ');
  return [
    `### Note ${i + 1}: ${who} · ${x.channel}${x.package_id ? ` · ${x.package_id}` : ''}`,
    ...x.asked.flatMap((r) => ['', `HE ASKED: "${r.note}". The draft changed:`, ...r.edits.map(renderEdit)]),
    ...(x.byHand.length ? ['', 'THEN, BY HAND, BEFORE SENDING:', ...x.byHand.map(renderEdit)] : []),
  ].join('\n');
}

// ---- recent notes, with what they were written from ---------------------------
//
// THE INPUT AS WELL AS THE OUTPUT. Whole notes and edits taught the voice, and a
// replay of 30 sent notes found neither beat the fixed set: redrafts differ most
// from what was sent in WHAT they open on, and an example that shows only the
// letter cannot teach why it opened there. So each example here carries the
// facts the drafter had (the profile he pasted, the firm, the dated events, the
// read), the drafter's own reasoning, what he asked to change, and what went.
//
// MOST RECENT, NOT MOST SIMILAR. The voice moves; the latest notes carry it.
// Choosing by similarity also narrows the range of examples, which a study of
// in-context style imitation found lowered fidelity (arXiv 2509.14543).
//
// Facts are cut to size: a pasted profile averages ~7,000 characters, and
// fifteen in full would crowd out the dossier this note is actually about.

export const RECENT_PROMPT = 'prompts/voice-recent.md';
export const RECENT_K = 15;
const PROFILE_CHARS = 2500;

const cut = (t, n) => { const x = String(t ?? '').replace(/\s+\n/g, '\n').trim(); return x.length > n ? `${x.slice(0, n)} [...]` : x; };

/** The drafter's NOTES section: its reasoning, written for the operator. */
export function draftNotes(raw) {
  const parts = unboldHeaders(raw).split(/^NOTES\s*$/m);
  return parts.length > 1 ? parts[1].replace(/^\s*-+\s*\n/, '').trim() : '';
}
const unboldHeaders = (raw) => String(raw ?? '').replace(/^\s*\*\*(DRAFT|NOTES|SUBJECT)\*\*\s*$/gm, '$1');

/** What the drafter knew about one past recipient when the note was written. */
export function factsThen(db, d) {
  const at = d.created_at;
  const person = db.prepare('SELECT name, title FROM people WHERE id = ?').get(d.person_id) ?? {};
  const org = db.prepare('SELECT name, kind, headcount_est FROM orgs WHERE id = ?').get(d.org_id) ?? {};
  const ev = db.prepare(`SELECT kind, claim, body, provenance FROM evidence
      WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL)) AND retrieved_at <= ?
        AND kind NOT IN ('web_page', 'staff_listing')
      ORDER BY (person_id IS NOT NULL) DESC, (provenance = 'operator_supplied') DESC, id DESC`)
    .all(d.person_id, d.org_id, at);
  const profile = ev.find((e) => e.kind === 'operator_profile' && e.body);
  const firm = ev.find((e) => e.kind === 'firm_profile');
  const facts = ev.filter((e) => e !== profile && e !== firm).slice(0, 10)
    .map((e) => `- ${cut(e.claim, 220).replace(/\s+/g, ' ')}${e.provenance === 'operator_supplied' ? ' (from the operator)' : ''}`);
  const sigs = db.prepare(`SELECT trigger_id, detected_at FROM signals WHERE org_id = ? AND detected_at <= ?
      ORDER BY detected_at DESC LIMIT 4`).all(d.org_id, at.slice(0, 10));
  const read = db.prepare(`SELECT trying_to_do, next_step, in_the_way, do_not_say FROM reads
      WHERE person_id = ? AND created_at <= ? ORDER BY id DESC LIMIT 1`).get(d.person_id, at);
  return [
    `RECIPIENT: ${person.name ?? '?'}, ${person.title ?? 'title unknown'}, at ${org.name ?? '?'}`
      + ` (${String(org.kind ?? 'firm').replace(/_/g, ' ')}${org.headcount_est ? `, about ${org.headcount_est.toLocaleString('en-US')} people` : ''})`,
    firm ? `THE FIRM: ${cut(firm.claim, 300)}` : '',
    sigs.length ? `DATED EVENTS: ${sigs.map((x) => `${x.trigger_id} (${x.detected_at})`).join('; ')}` : '',
    read ? `THE READ: trying to do: ${cut(read.trying_to_do, 300)}\n  next step: ${cut(read.next_step, 200)}`
      + `\n  in the way: ${cut(read.in_the_way, 200)}\n  do not say: ${cut(read.do_not_say, 200)}` : '',
    facts.length ? `FACTS ON FILE:\n${facts.join('\n')}` : '',
    profile ? `PROFILE HE PASTED (first ${PROFILE_CHARS} characters):\n${indent(cut(profile.body, PROFILE_CHARS))}` : '',
  ].filter(Boolean).join('\n');
}

/** The K latest sent notes on this channel, with everything they were written from. */
export function recentExamples(db, { personId, channel, superseded = [], neverClaim = [], before = null,
  k = RECENT_K } = {}) {
  const me = db.prepare('SELECT org_id FROM people WHERE id = ?').get(personId);
  if (!me) return [];
  const rows = db.prepare(`SELECT d.id, d.person_id, d.org_id, d.channel, d.package_id, d.body, d.sent_text, d.created_at
      FROM drafts d WHERE d.sent_text IS NOT NULL AND TRIM(d.sent_text) <> ''
       AND d.person_id IS NOT NULL AND d.person_id <> ? AND d.org_id <> ? AND d.id < ? AND d.channel = ?
     ORDER BY d.id DESC`).all(personId, me.org_id, before ?? Number.MAX_SAFE_INTEGER, channel);
  const asked = db.prepare(`SELECT revise_note FROM drafts WHERE person_id = ? AND id <= ?
      AND revise_note IS NOT NULL AND TRIM(revise_note) <> '' ORDER BY id`);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (out.length >= k) break;
    if (seen.has(r.person_id)) continue;
    seen.add(r.person_id);
    const asks = asked.all(r.person_id, r.id).map((x) => x.revise_note.trim());
    if (!asks.every(portable)) continue;
    const sent = updateWording(r.sent_text, superseded).trim();
    if (neverClaimHits(sent, neverClaim).length) continue;
    out.push({ ...r, sent, asks, delta: changed(r.body, r.sent_text) });
  }
  return out.reverse();   // oldest first, so the latest is nearest the task
}

export function renderRecent(db, x, i, superseded = []) {
  const same = x.delta < 0.02;
  return [
    `### Example ${i + 1} · ${x.created_at.slice(0, 10)} · ${x.channel}${x.package_id ? ` · ${x.package_id}` : ''}`,
    '', factsThen(db, x),
    '', 'THE DRAFTER\'S REASONING AT THE TIME:', indent(cut(updateWording(draftNotes(x.body), superseded), 1500) || '(none recorded)'),
    ...(x.asks.length ? ['', 'WHAT HE ASKED TO HAVE CHANGED:', ...x.asks.map((a) => `    - ${a}`)] : []),
    ...(same ? ['', 'WHAT HE SENT (exactly as drafted):', indent(x.sent)]
      : ['', 'WHAT THE DRAFT SAID:', indent(updateWording(noteBody(x.body), superseded)),
        '', `WHAT HE SENT (${Math.round(x.delta * 100)}% of the words changed):`, indent(x.sent)]),
  ].join('\n');
}

/**
 * The voice block for a draft. Returns the text for the system prompt and what
 * to record: the arm, the anchors kept and the drafts shown, so any note can
 * be traced to the examples behind it.
 *   fixed   voice.md as written
 *   picked  its prose, ANCHORS of its notes, and the PICKED_K most similar sent notes
 *   edits   its prose, ANCHORS of its notes, and the edits behind similar notes
 *   recent  its prose, and the RECENT_K latest sent notes with what they were written from
 */
export function voiceFor(db, { arm, voiceText, prompts = {}, personId, channel, packageId,
  superseded = [], neverClaim = [], before = null }) {
  if (!['picked', 'edits', 'recent'].includes(arm)) return { text: voiceText, record: { arm: 'fixed' } };
  const opts = { personId, channel, packageId, superseded, neverClaim, before };
  if (arm === 'recent') {
    const xs = recentExamples(db, opts);
    if (xs.length < MIN_POOL) {
      return { text: voiceText, record: { arm: 'fixed', wanted: arm,
        fell_back: `only ${xs.length} sent ${channel} notes to choose from` } };
    }
    // The prose (shape and prohibitions) stays; the recent notes replace the fixed ones.
    const text = [splitVoice(voiceText).prose, '---', String(prompts.recent ?? '').trim(), '',
      ...xs.map((x, i) => renderRecent(db, x, i, superseded))].join('\n\n');
    return { text, record: { arm, shown: xs.map((x) => x.id) } };
  }
  const picks = arm === 'edits' ? pickEdits(db, opts) : pickExamples(db, opts);
  if (picks.length < MIN_POOL) {
    return { text: voiceText, record: { arm: 'fixed', wanted: arm,
      fell_back: `only ${picks.length} sent ${channel} notes to choose from` } };
  }
  const { prose, notes } = splitVoice(voiceText);
  const anchors = notes.slice(0, ANCHORS);
  const text = [prose, '---',
    `# The notes\n\n${anchors.length} he sent, kept fixed so the voice has a floor. ` +
      'Read them as a set: the shape, the register and the length are all here.',
    ...anchors, '---', String(prompts[arm] ?? '').trim(), '',
    ...picks.map((x, i) => (arm === 'edits' ? renderEdits(x, i) : renderExample(x, i, superseded)))].join('\n\n');
  return { text, record: { arm, anchors: anchors.length, shown: picks.map((x) => x.id),
    ...(arm === 'edits' ? { edits: picks.reduce((t, x) => t + x.byHand.length
      + x.asked.reduce((u, r) => u + r.edits.length, 0), 0) } : {}) } };
}
