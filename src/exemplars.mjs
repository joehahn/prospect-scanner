// A target's examples: people the operator wants more of, in full.
//
// A target in business.yml may name `exemplars`, person ids the operator has
// marked write first or would write. Everything on file about them (the
// operator's own reason, what the firm's site says it does, and what he pasted)
// is a better statement of fit than a sentence written for the config, so the
// stages that decide fit read it: `firms` at admission, and the search proposer
// when it writes searches for look-alikes. Added 2026-09-30.
//
// Nothing about any particular person is written here; the ids live in config.

/** What a firm's own site says it does, as enrich recorded it. */
export const describedAs = (db, orgId) => db.prepare(`SELECT claim FROM evidence WHERE org_id = ?
  AND kind = 'firm_profile' ORDER BY id DESC LIMIT 1`).get(orgId)?.claim ?? null;

/**
 * The target's examples as text. `full` includes the pasted profile text; the
 * short form keeps the reason, the seat and the firm, with the pasted facts as
 * one-line claims, which is enough to write searches from.
 */
export function exemplarText(db, target, { full = true } = {}) {
  return (target.exemplars ?? []).map((id) => {
    const p = db.prepare(`SELECT p.name, p.title, p.org_id, o.name org FROM people p JOIN orgs o ON o.id = p.org_id
      WHERE p.id = ?`).get(id);
    if (!p) return null;
    const why = db.prepare(`SELECT reason FROM verdicts WHERE person_id = ? AND reason IS NOT NULL
      AND TRIM(reason) <> '' ORDER BY id DESC LIMIT 1`).get(id)?.reason;
    const firm = describedAs(db, p.org_id);
    const pasted = db.prepare(`SELECT kind, claim, body FROM evidence WHERE person_id = ?
      AND provenance = 'operator_supplied' ORDER BY id`).all(id);
    const facts = full
      ? pasted.map((r) => r.body || r.claim).join('\n\n').slice(0, 6000)
      : pasted.filter((r) => !r.body || r.kind === 'profile_fact').map((r) => `- ${r.claim}`).join('\n').slice(0, 2000);
    return `### ${p.name}, ${p.title ?? ''}, ${p.org}\n` +
      (why ? `What the operator said about them: "${why}"\n` : '') +
      (firm ? `What their firm's own site says it does: ${firm}\n` : '') +
      (facts ? `\nWhat the operator pasted about them:\n${facts}\n` : '');
  }).filter(Boolean).join('\n');
}
