// The boards a person sits on, with what each company does, for the read and
// the drafter.
//
// Added 2026-09-28. A partner's board seats are the reason to write to them:
// they are a route into those companies, where the buyer sits. The drafter had
// the names only (from a pasted bio), knew nothing about the companies, and led
// a note with a company on a colleague's board instead. This gives it each
// current board company and what it does, from the investor's own pages
// (npm run bios) and the company's own site where it has been read.
//
// A pasted profile fills it too (lead paste --extract): the board seats,
// advisory roles, investments and founder roles the person holds besides their
// job. `role` says which. A former agency head, now selling for a large IT
// services firm, advises and invests in two startups that sell to agencies; his job made
// him no buyer, and the two startups were the route to one.

const has = (db, t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);

/** The table, for a stage that writes to it before `npm run bios` has ever run. */
export function ensureBoardSeats(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS board_seats (
    person_id TEXT NOT NULL REFERENCES people(id), company TEXT NOT NULL,
    company_id TEXT REFERENCES orgs(id), status TEXT NOT NULL, source_url TEXT NOT NULL,
    first_seen TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'board', PRIMARY KEY (person_id, company))`);
  const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('board_seats').map((r) => r.name);
  if (!cols.includes('role')) db.exec("ALTER TABLE board_seats ADD COLUMN role TEXT NOT NULL DEFAULT 'board'");
}

const ROLES = new Set(['board', 'advisor', 'investor', 'founder']);
/** The role words this table keeps, from whatever the extractor wrote ("advisor and investor"). */
export function roleWords(raw) {
  const words = String(raw ?? '').toLowerCase().match(/board|advis|invest|found/g) ?? [];
  const norm = { board: 'board', advis: 'advisor', invest: 'investor', found: 'founder' };
  return [...new Set(words.map((w) => norm[w]))].filter((w) => ROLES.has(w)).join(', ');
}

export function boardSeats(db, personId) {
  if (!has(db, 'board_seats')) return [];
  const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('board_seats').map((r) => r.name);
  return db.prepare(`SELECT b.company, b.company_id, b.status, b.source_url,
      ${cols.includes('role') ? 'b.role' : "'board'"} role,
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
    return `- ${r.company} (${r.role || 'board'})${what ? `: ${what}` : ' (what it does is not on file)'}  <${r.source_url}>`;
  }).join('\n');
}
