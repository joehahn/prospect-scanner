// The grader's advisory strategy flag is judged by whether flagged drafts are the
// ones the operator rewrites (measures.mjs, gradePredictsEdits).
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('sent drafts split by the grader\'s latest verdict, strategy apart from clean', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb } = await import('../src/db.mjs');
  const { gradePredictsEdits } = await import('../src/measures.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'grade-predicts-'));
  const db = openDb(join(dir, 'test.db'));
  try {
    db.pragma('foreign_keys = OFF');
    const draft = db.prepare(`INSERT INTO drafts (id, person_id, org_id, channel, version, model, body, sent_text, created_at)
      VALUES (?, ?, 'o', 'email', 1, 'm', ?, ?, '2026-10-12T10:00:00Z')`);
    draft.run(1, 'a', 'one two three four', 'one two three four');           // sent as drafted
    draft.run(2, 'b', 'one two three four', 'five six seven eight');         // rewritten
    draft.run(3, 'c', 'one two three four', null);                           // never sent: not counted
    const grade = db.prepare(`INSERT INTO draft_grades (draft_id, graded_text, grader_model, prompt_file,
      prompt_version, clean, strategy, graded_at) VALUES (?, 'draft', 'g', 'p', ?, ?, ?, '2026-10-12')`);
    grade.run(1, 'v5', 1, 1);
    grade.run(2, 'v4', 1, 1);   // superseded by the later pass below
    grade.run(2, 'v5', 1, 0);   // clean on the rules, approach questioned
    grade.run(3, 'v5', 0, 0);
    const row = (check, label) => gradePredictsEdits(db).find((r) => r.check.startsWith(check) && r.label === label);
    assert.equal(row('approach', 'flagged').sent, 1);
    assert.equal(row('approach', 'flagged').rewritten, 1);
    assert.equal(row('approach', 'not flagged').sent, 1);
    assert.equal(row('approach', 'not flagged').rewritten, 0);
    assert.equal(row('rules', 'not flagged').sent, 2);
    assert.equal(row('rules', 'flagged').sent, 0);
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
