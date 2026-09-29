// The boards a person sits on, with what each company does, for the read and
// the drafter.
//
// Added 2026-09-28. A partner's board seats are the reason to write to them:
// they are a route into those companies, where the buyer sits. The drafter had
// the names only (from a pasted bio), knew nothing about the companies, and led
// a note with a company on a colleague's board instead. This gives it each
// current board company and what it does, from the investor's own pages
// (npm run bios) and the company's own site where it has been read.

const has = (db, t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);

export function boardSeats(db, personId) {
  if (!has(db, 'board_seats')) return [];
  return db.prepare(`SELECT b.company, b.company_id, b.status, b.source_url,
      (SELECT e.claim FROM evidence e WHERE e.org_id = b.company_id AND e.person_id IS NULL
         AND e.kind = 'firm_profile' AND e.claim NOT LIKE 'Profile extracted for %' ORDER BY e.id DESC LIMIT 1) profile,
      (SELECT e.claim FROM evidence e WHERE e.org_id = b.company_id AND e.person_id IS NULL
         AND e.kind = 'ownership' ORDER BY e.id DESC LIMIT 1) owned
    FROM board_seats b WHERE b.person_id = ? ORDER BY b.status, b.company`).all(personId);
}

/** Lines for a prompt; empty string when none are on file. */
export function boardLines(db, personId) {
  const rows = boardSeats(db, personId).filter((r) => r.status === 'current');
  return rows.map((r) => {
    const what = r.profile ?? (r.owned ? r.owned.replace(/^.*?current portfolio company\s*/i, '').replace(/^\(|\)$/g, '') : '');
    return `- ${r.company}${what ? `: ${what}` : ' (what it does is not on file)'}  <${r.source_url}>`;
  }).join('\n');
}
