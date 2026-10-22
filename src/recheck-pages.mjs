// Before a note leans on a page, check the page still names the person.
//
// Added 2026-10-22. A speaker record written on 2026-10-06 put a managing
// director on a conference session; by the time a note was drafted the agenda
// listed four other people for it and did not name him at all. Records are
// written once and read for weeks, and the page behind them moves. The two
// kinds a note opens on -- a talk, and something they said -- are fetched
// again here, and a record whose page loads without their surname is removed.
// A page that cannot be read keeps its record: a slow site is not evidence.

import { fetchPage } from './sources/web.mjs';
import { nameOnPage } from './name-on-page.mjs';

const LEDE_KINDS = ['announcement', 'web_said'];

/** Remove this person's lede records whose page no longer names them. Returns what was removed. */
export async function recheckPages(db, person, { fetch = fetchPage } = {}) {
  const rows = db.prepare(`SELECT id, kind, claim, source_url FROM evidence
     WHERE person_id = ? AND provenance = 'retrieved' AND kind IN (${LEDE_KINDS.map(() => '?').join(',')})
       AND source_url LIKE 'http%'
       AND id NOT IN (SELECT evidence_id FROM signals WHERE evidence_id IS NOT NULL)
       AND id NOT IN (SELECT evidence_id FROM gate_results WHERE evidence_id IS NOT NULL)`)
    .all(person.id, ...LEDE_KINDS);
  const pages = new Map();
  const removed = [];
  for (const r of rows) {
    if (!pages.has(r.source_url)) pages.set(r.source_url, await fetch(r.source_url).catch(() => ({ ok: false })));
    const page = pages.get(r.source_url);
    if (!page.ok || !page.html || nameOnPage(page.html, person.name)) continue;
    db.prepare('DELETE FROM evidence WHERE id = ?').run(r.id);
    removed.push(r);
  }
  return removed;
}
