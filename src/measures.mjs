// The redesign's measurements, computed once, for the terminal and the dashboard.
//
// `judge --scoreboard`, `queries --yield` and the dashboard's Scoreboard and
// Searches pages all read these functions, so the numbers on a page and in a
// terminal can never disagree. Pure reads: nothing here writes to the book.

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/**
 * The judge's rating of a person from one batch of runs, on the 1-5 scale.
 * Judgments from before the 1-5 prompt carry only write/skip; they are placed
 * on the same scale (unanimous write 4, split write 3, split skip 2, unanimous
 * skip 1) so old and new can be ordered together. Scoring by write/skip alone
 * treated a 5 and a 3 as equal and understated the judge.
 */
export function ratingOf(runs) {
  const cs = runs.map((j) => j.compelling).filter((x) => x != null);
  if (cs.length) return median(cs);
  if (!runs.length) return null;
  const w = runs.filter((j) => j.verdict === 'write').length;
  return w === runs.length ? 4 : w * 2 > runs.length ? 3 : w === 0 ? 1 : 2;
}

/**
 * Judge against ranker on the operator's forward calls: verdicts clicked on a
 * card after the judge had spoken. The FIRST call after a judgment counts; a
 * later different call is counted as a changed mind. One measure for both:
 * over every pair of a person he would write to and one he would skip, how
 * often does the system put the write above the skip? And the measure that
 * matches his day: of his Write-first picks, how many were in each system's
 * top 5 of that day's cards.
 */
export function scoreboard(db, { since = null, topK = 5 } = {}) {
  const people = db.prepare(`SELECT DISTINCT person_id FROM verdicts WHERE source IN ('card', 'blind')`).all();
  const firstBatchAt = db.prepare(`SELECT MIN(created_at) t FROM judgments WHERE batch = (SELECT batch
      FROM judgments WHERE person_id = ? ORDER BY id DESC LIMIT 1)`);
  const callsAfter = db.prepare(`SELECT verdict, first, source, rank_then, created_at FROM verdicts
      WHERE person_id = ? AND source IN ('card', 'blind') AND created_at >= ? ORDER BY id`);
  const batchBefore = db.prepare(`SELECT verdict, compelling, value, timing_days, target FROM judgments
      WHERE batch = (SELECT batch FROM judgments WHERE person_id = ? AND created_at <= ? ORDER BY id DESC LIMIT 1)`);
  const rows = [];
  let changed = 0;
  for (const { person_id } of people) {
    const jAt = firstBatchAt.get(person_id)?.t;
    if (!jAt || (since && jAt < since)) continue;
    const vs = callsAfter.all(person_id, jAt);
    if (!vs.length) continue;
    if (vs.some((v) => v.verdict !== vs[0].verdict)) changed++;
    const runs = batchBefore.all(person_id, vs[0].created_at);
    if (!runs.length) continue;
    rows.push({ person_id, ...vs[0], judgedOn: String(jAt).slice(0, 10), rating: ratingOf(runs),
      value: Number(runs[0]?.value ?? 0), days: runs[0]?.timing_days ?? 9e9,
      target: runs.find((r) => r.target)?.target ?? null });
  }
  const pairs = (xs, score) => {
    const W = xs.filter((x) => x.verdict === 'write'); const K = xs.filter((x) => x.verdict === 'skip');
    if (!W.length || !K.length) return null;
    let c = 0;
    for (const a of W) for (const b of K) { const d = score(a) - score(b); c += d > 0 ? 1 : d === 0 ? 0.5 : 0; }
    return c / (W.length * K.length);
  };
  const judgeScore = (x) => x.rating;
  const rankerScore = (x) => (x.rank_then == null ? -1e9 : -x.rank_then);
  const summary = (xs) => ({
    calls: xs.length, writes: xs.filter((x) => x.verdict === 'write').length,
    agreed: xs.filter((x) => (x.rating >= 3) === (x.verdict === 'write')).length,
    judge: pairs(xs, judgeScore), ranker: pairs(xs, rankerScore),
  });
  const byDay = new Map();
  for (const r of rows) { if (!byDay.has(r.judgedOn)) byDay.set(r.judgedOn, []); byDay.get(r.judgedOn).push(r); }
  const days = [];
  for (const [day, xs] of [...byDay].sort()) {
    const picks = xs.filter((x) => x.first);
    if (!picks.length) continue;
    const top = (score) => [...xs].sort((a, b) => score(b) - score(a) || b.value - a.value || a.days - b.days)
      .slice(0, topK).map((x) => x.person_id);
    const jTop = top(judgeScore); const rTop = top(rankerScore);
    days.push({ day, cards: xs.length, firsts: picks.length,
      judge: picks.filter((x) => jTop.includes(x.person_id)).length,
      ranker: picks.filter((x) => rTop.includes(x.person_id)).length });
  }
  return {
    forward: summary(rows), blind: summary(rows.filter((x) => x.source === 'blind')),
    days, topK, changed,
    firsts: days.reduce((a, d) => a + d.firsts, 0),
    judgeFirsts: days.reduce((a, d) => a + d.judge, 0),
    rankerFirsts: days.reduce((a, d) => a + d.ranker, 0),
  };
}

/**
 * Each search followed down the funnel: the firms its finds named, how many
 * are vetted and alive, rated 4 or 5 by the judge, written to by the operator's
 * latest call, sent a note, and replied. Every stage is already recorded.
 */
export function searchFunnel(db) {
  const has = (t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  if (!has('searches')) return [];
  const key = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
  const orgs = db.prepare('SELECT id, name FROM orgs').all().map((o) => ({ ...o, k: key(o.name) }));
  const orgOf = (n) => { const k = key(n); if (k.length < 4) return null;
    return orgs.find((o) => o.k === k || (o.k.length > 5 && (o.k.includes(k) || k.includes(o.k))))?.id ?? null; };
  const q = (sql) => db.prepare(sql);
  const alive = q(`SELECT 1 FROM orgs o WHERE o.id = ? AND o.kind IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM gate_results g WHERE g.org_id = o.id AND g.outcome LIKE 'kill%')`);
  const rated = q(`SELECT 1 FROM judgments WHERE org_id = ? AND compelling >= 4`);
  const wrote = q(`SELECT 1 FROM verdicts v WHERE v.org_id = ? AND v.verdict = 'write'
      AND v.id = (SELECT MAX(id) FROM verdicts x WHERE x.person_id = v.person_id)`);
  const sent = q(`SELECT 1 FROM outreach WHERE org_id = ?`);
  const replied = q(`SELECT 1 FROM outreach WHERE org_id = ? AND (status LIKE 'responded%' OR status = 'open_thread')`);
  const hitsOf = q(`SELECT hits FROM search_runs WHERE search_id = ?`);
  return q(`SELECT s.*, COUNT(r.id) runs FROM searches s LEFT JOIN search_runs r ON r.search_id = s.id GROUP BY s.id`)
    .all().map((s) => {
      const hits = hitsOf.all(s.id).flatMap((r) => JSON.parse(r.hits || '[]'));
      const ids = [...new Set(hits.map((h) => orgOf(h.organisation)).filter(Boolean))];
      const n = (st) => ids.filter((id) => st.get(id)).length;
      return { ...s, found: ids.length, alive: n(alive), rated: n(rated), wrote: n(wrote), sent: n(sent), replied: n(replied) };
    })
    .sort((a, b) => a.status.localeCompare(b.status) || b.wrote - a.wrote || b.alive - a.alive || b.found - a.found);
}

/**
 * What the project has spent on AI, from `runs`, where every model call records
 * its cost as it happens (CLAUDE.md: it cannot be retrofitted). Search credits
 * are counted separately; they are not dollars.
 */
export function spend(db, { topStages = 12 } = {}) {
  const tot = db.prepare(`SELECT ROUND(SUM(cost_usd), 2) usd, SUM(tavily_credits) credits, MIN(started_at) since,
      COUNT(*) runs FROM runs`).get();
  const month = new Date().toISOString().slice(0, 7);
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const m = db.prepare(`SELECT ROUND(SUM(cost_usd), 2) usd, SUM(tavily_credits) credits FROM runs WHERE substr(started_at, 1, 7) = ?`).get(month);
  const w = db.prepare(`SELECT ROUND(SUM(cost_usd), 2) usd FROM runs WHERE started_at >= ?`).get(week);
  // TODAY IS THE OPERATOR'S DAY, from local midnight: started_at is UTC, and a
  // UTC day would roll over at 5 or 6 in the evening.
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const t = db.prepare(`SELECT ROUND(SUM(cost_usd), 2) usd, SUM(tavily_credits) credits, COUNT(*) runs
      FROM runs WHERE started_at >= ?`).get(midnight.toISOString());
  const daily = db.prepare(`SELECT substr(started_at, 1, 10) day, ROUND(SUM(cost_usd), 4) usd, SUM(tavily_credits) credits
      FROM runs GROUP BY 1 ORDER BY 1`).all();
  let run = 0;
  const cumulative = daily.map((d) => ({ day: d.day, usd: Math.round((run += d.usd) * 100) / 100 }));
  // TOKENS FROM THE PER-CALL LEDGER (llm_calls, from 2026-10-01). runs.n_in and
  // n_out are item counts for most stages, and were summed here as tokens.
  const hasLedger = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'llm_calls'`).get());
  const tok = (by) => new Map(hasLedger ? db.prepare(`SELECT ${by} k, SUM(input_tokens + cache_read_tokens + cache_write_tokens) n_in,
      SUM(output_tokens) n_out FROM llm_calls GROUP BY 1`).all().map((r) => [r.k, r]) : []);
  const stageTok = tok('stage');
  const stages = db.prepare(`SELECT stage, COUNT(*) runs, ROUND(SUM(cost_usd), 2) usd
      FROM runs GROUP BY stage ORDER BY SUM(cost_usd) DESC`).all()
    .map((r) => ({ ...r, n_in: stageTok.get(r.stage)?.n_in ?? null, n_out: stageTok.get(r.stage)?.n_out ?? null }));
  const top = stages.slice(0, topStages);
  const rest = stages.slice(topStages);
  if (rest.length) top.push({ stage: `other (${rest.length} stages)`, runs: rest.reduce((a, s) => a + s.runs, 0),
    usd: Math.round(rest.reduce((a, s) => a + s.usd, 0) * 100) / 100 });
  // BY MODEL: per call where the ledger has the run, so a run that used two
  // models splits correctly; whole runs before the ledger existed.
  const models = db.prepare(hasLedger ? `SELECT model, COUNT(DISTINCT run) runs, ROUND(SUM(usd), 2) usd FROM (
        SELECT model, run_id run, cost_usd usd FROM llm_calls
        UNION ALL SELECT COALESCE(model, '(no model: a stage that calls none)'), id, cost_usd FROM runs
         WHERE id NOT IN (SELECT run_id FROM llm_calls WHERE run_id IS NOT NULL))
      GROUP BY 1 ORDER BY SUM(usd) DESC`
    : `SELECT COALESCE(model, '(no model: a stage that calls none)') model, COUNT(*) runs,
      ROUND(SUM(cost_usd), 2) usd FROM runs GROUP BY 1 ORDER BY SUM(cost_usd) DESC`).all()
    .map((r) => ({ ...r, n_in: null, n_out: null }));
  const modelTok = tok('model');
  for (const r of models) { r.n_in = modelTok.get(r.model)?.n_in ?? null; r.n_out = modelTok.get(r.model)?.n_out ?? null; }
  return { total: tot.usd ?? 0, credits: tot.credits ?? 0, since: String(tot.since ?? '').slice(0, 10), runs: tot.runs,
    month: { label: month, usd: m.usd ?? 0, credits: m.credits ?? 0 }, week: w.usd ?? 0,
    today: { usd: t.usd ?? 0, credits: t.credits ?? 0, runs: t.runs ?? 0,
      asOf: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) },
    daily, cumulative, stages, byStage: top, models };
}
