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
// MEASURED AGAINST THE FIXED SET. New drafts alternate between the two arms
// (`fixed`: voice.md as written; `picked`: its prose, a few anchor notes, and
// K chosen notes) and each draft records its arm, so the Scoreboard can say
// whether the picked arm's notes need less changing before they go out.

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

/**
 * The arm for a new draft. A revision keeps the arm of the version it revises,
 * so a revised note is attributed to the examples it started from. A new note
 * takes the arm the last new note did not, which keeps the two arms level.
 */
export function chooseArm(db, { prior = null, override = null } = {}) {
  if (override === 'fixed' || override === 'picked') return override;
  if (prior) {
    const row = db.prepare('SELECT examples FROM drafts WHERE id = ?').get(prior.id);
    return armOf(row?.examples) ?? 'fixed';
  }
  const last = db.prepare(`SELECT examples FROM drafts
    WHERE examples IS NOT NULL AND revised_from IS NULL ORDER BY id DESC LIMIT 1`).get();
  return armOf(last?.examples) === 'picked' ? 'fixed' : 'picked';
}

export function armOf(json) {
  try { return JSON.parse(json ?? 'null')?.arm ?? null; } catch { return null; }
}

/**
 * The K sent notes to the people most like this one. One per recipient, his
 * latest. Never this person or anyone at their firm: those notes are already in
 * the dossier as prior contact, and an example is not evidence.
 */
export function pickExamples(db, { personId, channel, packageId, superseded = [], neverClaim = [],
  k = PICKED_K, before = null } = {}) {
  const me = features(db, personId);
  if (!me) return [];
  const rows = db.prepare(`SELECT d.id, d.person_id, d.org_id, d.channel, d.package_id, d.body, d.sent_text
      FROM drafts d WHERE d.sent_text IS NOT NULL AND TRIM(d.sent_text) <> ''
       AND d.person_id IS NOT NULL AND d.person_id <> ? AND d.org_id <> ? AND d.id < ?
     ORDER BY d.id DESC`).all(personId, me.person.org_id, before ?? Number.MAX_SAFE_INTEGER);
  // ^ `before`, for a replay: only notes drafted before the one being replayed,
  // so a later note cannot hand the answer back.
  const asked = db.prepare(`SELECT revise_note FROM drafts WHERE person_id = ? AND id <= ?
      AND revise_note IS NOT NULL AND TRIM(revise_note) <> '' ORDER BY id`);
  const seen = new Set();
  const scored = [];
  for (const r of rows) {
    if (seen.has(r.person_id)) continue;
    seen.add(r.person_id);
    const sent = updateWording(r.sent_text, superseded).trim();
    // A sent note that says something he must never claim is not a model to copy.
    if (neverClaimHits(sent, neverClaim).length) continue;
    const f = features(db, r.person_id);
    if (!f) continue;
    const delta = changed(r.body, r.sent_text);
    // Similar recipient first; the same channel and offer count for a lot,
    // because length and shape follow the channel. A note he rewrote carries
    // more of his own voice than one he sent as drafted, so it edges ahead.
    const score = similarity(me, f) + (r.channel === channel ? 3 : 0)
      + (packageId && r.package_id === packageId ? 2 : 0) + Math.min(1, delta * 4);
    scored.push({ ...r, f, sent, delta, score,
      asked: asked.all(r.person_id, r.id).map((x) => x.revise_note.trim()) });
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

/**
 * The voice block for a draft. Returns the text for the system prompt and what
 * to record: the arm, the anchors kept and the drafts shown, so any note can
 * be traced to the examples behind it.
 */
export function voiceFor(db, { arm, voiceText, pickedPrompt, personId, channel, packageId,
  superseded = [], neverClaim = [], before = null }) {
  if (arm !== 'picked') return { text: voiceText, record: { arm: 'fixed' } };
  const picks = pickExamples(db, { personId, channel, packageId, superseded, neverClaim, before });
  if (picks.length < MIN_POOL) {
    return { text: voiceText, record: { arm: 'fixed', fell_back: `only ${picks.length} sent notes to choose from` } };
  }
  const { prose, notes } = splitVoice(voiceText);
  const anchors = notes.slice(0, ANCHORS);
  const text = [prose, '---',
    `# The notes\n\n${anchors.length} he sent, kept fixed so the voice has a floor. ` +
      'Read them as a set: the shape, the register and the length are all here.',
    ...anchors, '---', pickedPrompt.trim(), '',
    ...picks.map((x, i) => renderExample(x, i, superseded))].join('\n\n');
  return { text, record: { arm: 'picked', anchors: anchors.length, shown: picks.map((x) => x.id) } };
}
