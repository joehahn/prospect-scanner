// The daily funnel, from a person first appearing to a reply, and the one
// definition of "writable" that the morning run and the dashboard share.
//
// WHY THIS EXISTS. The operator's two daily goals are about 100 high-quality
// prospects found and about 10 compelling notes sent. Neither was a number
// anywhere: the pieces sat in six tables and two pages, and a fix that moved
// one stage could not be seen to move the goal. Every count here is computed
// from the book as it is, with no model and no cost.

/**
 * Someone a note could go to today, apart from their rating: not written to,
 * firm not written to in 14 days, firm not killed, not suppressed, not marked
 * "wouldn't" by the operator, an offer fits the firm, and rank does not block
 * them for recruiting the skill sold. `p` is the people row.
 */
export const WRITABLE = `
       p.id NOT IN (SELECT person_id FROM outreach WHERE person_id IS NOT NULL)
   AND p.org_id NOT IN (SELECT org_id FROM outreach WHERE sent_at >= date('now', '-14 days'))
   AND p.org_id NOT IN (SELECT org_id FROM gate_results WHERE outcome LIKE 'kill%')
   AND p.id NOT IN (SELECT person_id FROM do_not_contact WHERE person_id IS NOT NULL)
   AND p.org_id NOT IN (SELECT org_id FROM do_not_contact WHERE org_id IS NOT NULL)
   AND COALESCE((SELECT v.verdict FROM verdicts v WHERE v.person_id = p.id ORDER BY v.id DESC LIMIT 1), '') <> 'skip'
   -- A firm rank left without an offer: draft refuses it ("no OFFER under it does").
   AND EXISTS (SELECT 1 FROM scores s WHERE s.org_id = p.org_id AND s.package_id IS NOT NULL)
   -- Recruiting the skill sold: rank blocks them (never_when_hiring, src/rank.mjs,
   -- whose wording this matches), since a capacity offer reads as an application.
   AND NOT EXISTS (SELECT 1 FROM person_scores ps WHERE ps.person_id = p.id
                    AND ps.blockers LIKE '%publicly recruiting for this%')`;

const HAS_PROFILE = `EXISTS (SELECT 1 FROM evidence e WHERE e.person_id = p.id AND e.kind = 'operator_profile')`;

/**
 * Everyone the judge rates 3+ (the middle of their latest runs) who is writable,
 * strongest first: rating, then value, then how soon the trigger is.
 */
export function strongWritable(db) {
  const rows = db.prepare(`SELECT j.person_id, j.compelling, j.value, j.timing_days, p.name, p.title,
        p.org_id, p.email, p.degree, o.name AS org_name, ${HAS_PROFILE} AS has_profile
      FROM judgments j JOIN people p ON p.id = j.person_id LEFT JOIN orgs o ON o.id = p.org_id
      JOIN (SELECT person_id, MAX(batch) b FROM judgments GROUP BY person_id) l
        ON l.person_id = j.person_id AND l.b = j.batch
     WHERE ${WRITABLE}`).all();
  const by = new Map();
  for (const r of rows) { if (!by.has(r.person_id)) by.set(r.person_id, []); by.get(r.person_id).push(r); }
  return [...by.values()].map((rs) => {
    const c = rs.map((r) => r.compelling ?? 0).sort((a, b) => a - b);
    return { ...rs[0], rating: c[Math.floor(c.length / 2)], value: Math.max(...rs.map((r) => Number(r.value) || 0)),
      timing: Math.min(...rs.map((r) => r.timing_days ?? 9e9)) };
  }).filter((p) => p.rating >= 3)
    .sort((a, b) => b.rating - a.rating || b.value - a.value || a.timing - b.timing);
}

/**
 * THE PROFILES TO PASTE TODAY. A draft waits for a pasted profile, because the
 * profile is where a note's substance comes from and LinkedIn is read only by
 * the operator, by hand. Pasting is the scarce step -- about twenty minutes for
 * twenty people -- so it goes only to the strongest writable people, one per
 * firm, who have no profile on file.
 */
export function pasteQueue(db, n = 20) {
  const firms = new Set();
  const out = [];
  for (const p of strongWritable(db)) {
    if (p.has_profile || firms.has(p.org_id)) continue;
    firms.add(p.org_id);
    out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

// Where a person came from: the kind of the first retrieved evidence about them.
const SOURCE = {
  announcement: 'conference agendas', staff_listing: 'firm staff pages', staff_bio: 'firm staff pages',
  board_seats: 'board listings', news_event: 'news searches', job_posting: 'job boards',
};
const sourceOf = (kind) => SOURCE[kind] ?? (kind ? kind.replace(/_/g, ' ') : 'added by hand');

// A bare date ("2026-10-02", how sends are recorded) is already the local day;
// parsed as a time it is UTC midnight, which is the evening before here.
const localDay = (iso) => (!iso ? null : /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso
  : new Date(iso).toLocaleDateString('en-CA'));

/**
 * Per person: the day each stage was first reached. One pass over the book,
 * shared by the daily table and the per-source table.
 */
function stages(db) {
  const first = (sql) => new Map(db.prepare(sql).all().map((r) => [r.person_id, r.t]));
  const tableExists = (t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  const found = db.prepare(`SELECT e.person_id, e.retrieved_at t, e.kind, e.provenance FROM evidence e
      WHERE e.person_id IS NOT NULL AND e.id = (SELECT MIN(id) FROM evidence x WHERE x.person_id = e.person_id)`).all();
  const screened = tableExists('screens') ? first('SELECT person_id, MIN(created_at) t FROM screens GROUP BY person_id') : new Map();
  const judged = first('SELECT person_id, MIN(created_at) t FROM judgments GROUP BY person_id');
  const pasted = first(`SELECT person_id, MIN(retrieved_at) t FROM evidence WHERE kind = 'operator_profile' GROUP BY person_id`);
  const drafted = first('SELECT person_id, MIN(created_at) t FROM drafts WHERE person_id IS NOT NULL GROUP BY person_id');
  const clean = first(`SELECT d.person_id, MIN(g.graded_at) t FROM draft_grades g JOIN drafts d ON d.id = g.draft_id
      WHERE g.clean = 1 AND g.graded_text = 'draft' GROUP BY d.person_id`);
  const sent = first(`SELECT person_id, MIN(sent_at) t FROM outreach WHERE sent_at IS NOT NULL AND person_id IS NOT NULL GROUP BY person_id`);
  // A reply is a human answering: not a bounce, and not a connection accepted.
  const replied = first(`SELECT o.person_id, MIN(r.responded_at) t FROM responses r JOIN outreach o ON o.id = r.outreach_id
      WHERE COALESCE(r.sentiment, '') NOT IN ('bounced', 'accepted')
        AND COALESCE(r.outcome, '') NOT LIKE '%undeliverable%' AND COALESCE(r.outcome, '') NOT LIKE '%bounced%'
      GROUP BY o.person_id`);
  const accepted = first(`SELECT o.person_id, MIN(r.responded_at) t FROM responses r JOIN outreach o ON o.id = r.outreach_id
      WHERE r.sentiment = 'accepted' GROUP BY o.person_id`);
  const strongNow = new Set();
  const latest = db.prepare(`SELECT j.person_id, j.compelling FROM judgments j
      JOIN (SELECT person_id, MAX(batch) b FROM judgments GROUP BY person_id) l ON l.person_id = j.person_id AND l.b = j.batch`).all();
  const runs = new Map();
  for (const r of latest) { if (!runs.has(r.person_id)) runs.set(r.person_id, []); runs.get(r.person_id).push(r.compelling ?? 0); }
  for (const [id, c] of runs) { c.sort((a, b) => a - b); if (c[Math.floor(c.length / 2)] >= 3) strongNow.add(id); }
  const writable = new Set(strongWritable(db).map((p) => p.person_id));
  return found.map((f) => ({
    id: f.person_id, source: f.provenance === 'operator_supplied' ? 'added by hand' : sourceOf(f.kind),
    found: localDay(f.t), screened: localDay(screened.get(f.person_id)), judged: localDay(judged.get(f.person_id)),
    strong: strongNow.has(f.person_id), writable: writable.has(f.person_id),
    pasted: localDay(pasted.get(f.person_id)), drafted: localDay(drafted.get(f.person_id)),
    clean: localDay(clean.get(f.person_id)), sent: localDay(sent.get(f.person_id)),
    accepted: localDay(accepted.get(f.person_id)), replied: localDay(replied.get(f.person_id)),
  }));
}

/**
 * One row per local day, newest first. Each column counts people who reached
 * that stage ON that day, except "rated 3+" and "writable", which count the
 * people JUDGED that day by where they stand now.
 */
export function funnelDays(db, days = 14) {
  const ps = stages(db);
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 86_400_000).toLocaleDateString('en-CA');
    const on = (k) => ps.filter((p) => p[k] === day);
    const judged = on('judged');
    out.push({ day, found: on('found').length, screened: on('screened').length, judged: judged.length,
      strong: judged.filter((p) => p.strong).length, writable: judged.filter((p) => p.writable).length,
      pasted: on('pasted').length, drafted: on('drafted').length, clean: on('clean').length,
      sent: on('sent').length, accepted: on('accepted').length, replied: on('replied').length });
  }
  return out;
}

/** Per source, over people found in the last `days`: how far each source's people got. */
export function sourceYield(db, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toLocaleDateString('en-CA');
  const by = new Map();
  for (const p of stages(db).filter((x) => x.found && x.found >= since)) {
    const s = by.get(p.source) ?? { source: p.source, found: 0, judged: 0, strong: 0, writable: 0, sent: 0, accepted: 0, replied: 0 };
    s.found++;
    if (p.judged) s.judged++;
    if (p.strong) s.strong++;
    if (p.writable) s.writable++;
    if (p.sent) s.sent++;
    if (p.accepted) s.accepted++;
    if (p.replied) s.replied++;
    by.set(p.source, s);
  }
  return [...by.values()].sort((a, b) => b.strong - a.strong || b.found - a.found);
}
