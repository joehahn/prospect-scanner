// The literal never_claim screen, shared by `draft` (before a note is stored)
// and `grade` (after). One copy, so the two cannot drift.

/**
 * Screen a finished draft against `operator.never_claim`.
 *
 * The honesty guardrail was prompt-only: the terms were injected under NEVER
 * CLAIM and nothing ever looked at what came back. A draft saying "Docker" would
 * have been written, stored and shown with nothing flagging it — and this week a
 * model broke a freshly written rule in this very prompt on its first outing, so
 * "the instruction says not to" is not a control.
 *
 * This is a SCREEN, not a proof, and the difference is worth stating. It catches
 * a term named literally, which is the realistic failure. It cannot catch a
 * paraphrase: "production ML ownership" is a description of a claim, not a string
 * a note would contain, and a draft implying it in other words passes clean here.
 *
 * Short terms are matched case-SENSITIVELY, because "Go" and "R" as bare words
 * appear inside ordinary prose constantly and a screen that cries wolf gets
 * ignored, which is worse than no screen. A phrase written as alternatives —
 * "Neo4j or other graph databases" — is split and each side checked.
 */
export function neverClaimHits(text, neverClaim) {
  const hits = [];
  for (const entry of neverClaim ?? []) {
    for (const term of String(entry).split(/\s+or\s+/i).map((t) => t.trim()).filter(Boolean)) {
      // A phrase of four or more words is a description of a claim, not a string.
      if (term.split(/\s+/).length >= 4) continue;
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // & is a boundary char but "R&D" is not a claim to know R. Same shape as
      // the hyphen exclusion, which keeps "go-to-market" from flagging Go.
      const re = new RegExp(`(^|[^\\w&-])${esc}([^\\w&-]|$)`, term.length <= 2 ? '' : 'i');
      const m = re.exec(text);
      if (m) hits.push({ entry, term, around: text.slice(Math.max(0, m.index - 40),
        m.index + term.length + 40).replace(/\s+/g, ' ').trim() });
    }
  }
  return hits;
}
