// The Results page's numbers and panel order.
//
// Rates must carry their count and a range, small groups must fold, a bounce
// must never count as a reply, titles must land in the right seat, and panels
// must rise, sink, fold and retire by how often the operator looks at them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { openDb } = await import(R + 'db.mjs');
const { wilson, roleOf, rates, weekOf, sends } = await import(R + 'outcomes.mjs');
const { seedBriefs, placeBriefs, BRIEFS, UNSEEN_FOLD, UNSEEN_RETIRE } = await import(R + 'results.mjs');

test('wilson range holds the rate and stays in 0..1', () => {
  const [lo, hi] = wilson(42, 211);
  assert.ok(lo < 42 / 211 && 42 / 211 < hi && lo > 0.1 && hi < 0.3);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const [lo0] = wilson(0, 10);
  assert.equal(lo0, 0);
});

test('titles land in the right function and level', () => {
  assert.deepEqual(roleOf('Chief Financial Officer'), { func: 'Finance', level: 'C-suite and owners' });
  assert.deepEqual(roleOf('Chief Executive Officer'), { func: 'Executive and owners', level: 'C-suite and owners' });
  assert.deepEqual(roleOf('Operating Partner - Finance Leader'), { func: 'PE operating partners', level: 'Partner and principal' });
  assert.equal(roleOf('Chief Operating Officer').func, 'Operations');
  assert.equal(roleOf('SVP Supply Chain').level, 'VP and head of');
  assert.equal(roleOf('Vice President, Data').level, 'VP and head of');
  assert.equal(roleOf('Director of Transformation').func, 'Strategy and transformation');
  assert.equal(roleOf(null).func, 'Other');
});

test('groups under the minimum fold into Other', () => {
  const rows = [...Array(20)].map((_, i) => ({ g: 'a', hit: i < 5 }))
    .concat([...Array(3)].map(() => ({ g: 'b', hit: true })), [{ g: null, hit: false }]);
  const out = rates(rows, (r) => r.g, (r) => r.hit, { min: 15 });
  assert.deepEqual(out.map((g) => [g.label, g.k, g.n]), [['a', 5, 20], ['Other', 3, 4]]);
  assert.ok(out[0].range[0] < 0.25 && out[0].range[1] > 0.25);
});

test('weeks start on Monday', () => {
  assert.equal(weekOf('2026-11-18'), '2026-11-16');
  assert.equal(weekOf('2026-11-16'), '2026-11-16');
  assert.equal(weekOf('2026-11-22'), '2026-11-16');
});

test('a bounce is not a reply, and an accept is not a reply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'results-'));
  try {
    const db = openDb(join(dir, 't.db'));
    db.prepare(`INSERT INTO orgs (id, name, first_seen, source) VALUES ('f', 'F', '2026-09-01', 'test')`).run();
    db.prepare(`INSERT INTO people (id, org_id, name, title) VALUES ('p', 'f', 'P Q', 'CIO')`).run();
    const send = db.prepare(`INSERT INTO outreach (org_id, person_id, channel, sent_at, status, seeded) VALUES ('f', 'p', ?, '2026-09-01', ?, 0)`);
    const bounced = send.run('email', 'responded_negative').lastInsertRowid;
    db.prepare(`INSERT INTO responses (outreach_id, responded_at, sentiment, outcome) VALUES (?, '2026-09-02', 'negative', 'bounced twice, 550')`).run(bounced);
    const cr = send.run('linkedin_connect_note', 'accepted').lastInsertRowid;
    db.prepare(`INSERT INTO responses (outreach_id, responded_at, sentiment, outcome) VALUES (?, '2026-09-02', 'accepted', 'connection request accepted')`).run(cr);
    const s = sends(db);
    assert.deepEqual(s.map((r) => [r.channel, r.bounced, r.accepted, r.replied]),
      [['email', true, false, false], ['linkedin_connect_note', false, true, false]]);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('panels: new on top, looked at rises, unseen folds, long unseen retires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'results-'));
  try {
    const db = openDb(join(dir, 't.db'));
    seedBriefs(db);
    const day = 86_400_000;
    const now = Date.now();
    const ago = (d) => new Date(now - d * day).toISOString();
    // Everything approved long enough ago to be past the new-panel window.
    db.prepare('UPDATE chart_briefs SET approved_at = ?, created_at = ?').run(ago(UNSEEN_FOLD + 5), ago(UNSEEN_FOLD + 5));
    const view = db.prepare('INSERT INTO chart_views (brief_id, at, ms, how) VALUES (?, ?, 3000, \'seen\')');
    for (const id of BRIEFS.map(([x]) => x)) view.run(id, ago(20));
    for (let i = 0; i < 5; i++) view.run('replies', ago(1));
    db.prepare('DELETE FROM chart_views WHERE brief_id = ?').run('rating');
    db.prepare('UPDATE chart_briefs SET approved_at = ? WHERE id = ?').run(ago(UNSEEN_RETIRE + 1), 'channels');
    db.prepare('DELETE FROM chart_views WHERE brief_id = ?').run('channels');
    const placed = placeBriefs(db, now);
    assert.equal(placed[0].id, 'replies');
    assert.equal(placed.find((b) => b.id === 'rating').place, 'folded');
    assert.equal(placed.find((b) => b.id === 'channels'), undefined);
    assert.equal(db.prepare(`SELECT status FROM chart_briefs WHERE id = 'channels'`).get().status, 'retired');
    // A panel approved this week is pinned on top whatever its views.
    db.prepare('UPDATE chart_briefs SET approved_at = ? WHERE id = ?').run(ago(1), 'roles');
    assert.equal(placeBriefs(db, now)[0].id, 'roles');
    // Several new panels keep figure order, whatever their views.
    db.prepare('UPDATE chart_briefs SET approved_at = ?').run(ago(1));
    assert.deepEqual(placeBriefs(db, now).map((b) => b.id), BRIEFS.map(([x]) => x).filter((x) => x !== 'channels'));
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
