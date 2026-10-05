// How alike two people are, for choosing examples. No model.
//
// Shared by the judge, which shows the operator's past calls on the most similar
// people, and by the drafter, which shows the notes he sent to the most similar
// people. One measure for both, so "similar" means the same thing in each.

const STOP = new Set(['the', 'and', 'for', 'of', 'at', 'vice', 'senior', 'head', 'group', 'global',
  'officer', 'president', 'director', 'manager', 'chief', 'executive', 'svp', 'evp']);
export const words = (t) => new Set(String(t ?? '').toLowerCase().split(/[^a-z]+/)
  .filter((w) => w.length > 2 && !STOP.has(w)));

export function sizeBand(o) {
  const h = o?.headcount_est;
  if (h != null) return h >= 5000 ? 'xl' : h >= 1000 ? 'l' : h >= 200 ? 'm' : 's';
  const r = o?.revenue_basis === 'revenue' ? o?.revenue_est : null;
  if (r) return r >= 3e9 ? 'xl' : r >= 1.5e8 ? 'l' : r >= 3e7 ? 'm' : 's';
  return 'unknown';
}

export function features(db, personId) {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return null;
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(person.org_id) ?? {};
  const verticals = db.prepare('SELECT vertical_id FROM org_verticals WHERE org_id = ?')
    .all(person.org_id).map((r) => r.vertical_id);
  const triggers = db.prepare(`SELECT DISTINCT trigger_id FROM signals
    WHERE org_id = ? AND retracted_at IS NULL`).all(person.org_id).map((r) => r.trigger_id);
  return { person, org, verticals, triggers, band: sizeBand(org), title: words(person.title) };
}

export function similarity(a, b) {
  let s = 0;
  if (a.verticals.some((v) => b.verticals.includes(v))) s += 3;
  s += 2 * Math.min(2, a.triggers.filter((t) => b.triggers.includes(t)).length);
  if (a.band !== 'unknown' && a.band === b.band) s += 2;
  if (a.org.kind && a.org.kind === b.org.kind) s += 1;
  const inter = [...a.title].filter((w) => b.title.has(w)).length;
  const union = new Set([...a.title, ...b.title]).size || 1;
  return s + 3 * (inter / union);
}
