// SQLite access layer. One file, data/prospects.db.
//
// The schema as designed, with three deliberate deviations, all
// additive. They are listed here so the spec and the code stay reconcilable:
//
//   1. orgs.id and people.id are TEXT slugs, not integers. data/seed-outreach.json
//      carries stable human-authored slugs ("strattam", "casey_clinkenbeard") and
//      those are the operator's own identifiers for real relationships. Integer
//      surrogates would have to be mapped back to them on every read.
//   2. A handful of columns exist because the seed carries the fact and dropping
//      it would lose operator history: orgs.hq/aum_usd, people.degree/email,
//      outreach.status/warm/credit_spent/..., gate_results.person_id/decided_at.
//      Each is marked (seed) below.
//   3. Four tables not in §6 — do_not_contact, hold, marketplace_registrations,
//      scheduled_followups — hold the suppression and time-gate lists. §6 assumed
//      outreach history alone was enough to avoid duplicate contact; it is not.
//      A person can be permanently suppressed without ever having been contacted.
//
//   4. An `org_boards` cache, so a discovery probe is paid for once. Neither §6
//      nor §9 anticipated that the three job APIs have no global search, and
//      that the board-token list is therefore state the system must keep.
//   5. A `seeded` flag on the tables the seed loader writes. It marks rows that
//      came from data/seed-outreach.json rather than from a pipeline stage, so
//      `npm run seed` can be re-run without deleting anything the pipeline wrote.
//
// Nothing here is dropped or renamed relative to §6.

import Database from 'better-sqlite3';
// web.mjs is a fetcher and imports nothing from here, so this is one-way. It is
// imported for `browserNote` alone: every stage that fetches gets the browser
// record written without seventeen call sites having to remember to pass it,
// which is how a guardrail stays kept.
import { browserNote } from './sources/web.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = resolve(ROOT, 'data/prospects.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  domain         TEXT,
  industry       TEXT,
  revenue_est    INTEGER,
  headcount_est  INTEGER,
  first_seen     TEXT NOT NULL,
  source         TEXT,
  hq             TEXT,                       -- (seed)
  -- What kind of firm this is. It is the fact the pitch selector turns on
  -- (config.mjs buyerForOrg), and the 2026-08-25 audit showed it is the single
  -- most decisive attribute: a delivery_firm hires, an investor buys judgment.
  kind           TEXT CHECK (kind IN
                   ('end_client','public_body','investor','advisor','delivery_firm','marketplace','staffing','individual')),
  aum_usd        INTEGER,                    -- (seed)
  -- Announced capital programme, from a dated news event. One of three ways a
  -- firm can clear the hands-on money gate: it need not be big, it needs to be
  -- spending big.
  announced_capex_usd INTEGER,
  seeded         INTEGER NOT NULL DEFAULT 0, -- 1 = came from operator history, not a scan
  -- Set by the enrich stage. These two are different: a firm that BUILDS AI and a firm
  -- that SELLS JUDGMENT about AI are both competitors, but for different pitches.
  -- Extracted rather than pattern-matched, because the pages phrase "we do this"
  -- and "we do not do this" in nearly the same words.
  sells_ai_delivery INTEGER,
  sells_ai_advisory INTEGER
);

CREATE TABLE IF NOT EXISTS people (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  name          TEXT NOT NULL,
  title         TEXT,
  seniority     TEXT,
  decision_role TEXT,
  profile_url   TEXT,
  notes         TEXT,
  degree        INTEGER,                     -- (seed) LinkedIn connection degree, recorded by hand
  email         TEXT,                        -- (seed)
  email_guess   TEXT,                        -- (seed) unverified pattern guess, never treated as fact

  -- Added after pasted profiles showed the ranker could only ever move a score
  -- UP. A title can lie: one prospect's read "Principal, Product & Technology"
  -- at a PE firm while his own About section said fractional advisor, actively
  -- job-hunting. Another's read CTO and the experience section corroborated it
  -- with a seven-year tenure. Those two must not score alike.
  role_confirmed    TEXT CHECK (role_confirmed IN ('confirmed','unclear','contradicted')),
  in_seat_since     TEXT,                    -- YYYY-MM, when the current seat started

  -- Both silent InMails went to dormant profiles. A message to an inbox nobody
  -- opens fails for reasons that have nothing to do with fit.
  platform_activity TEXT CHECK (platform_activity IN ('dormant','low','active','high')),
  followers         INTEGER,

  -- Buyer authority and referral value are different things and must not be
  -- collapsed. A person can be a correct kill as a buyer and simultaneously the
  -- best-connected door in the whole record.
  referral_value    REAL
);

-- Every factual claim the system will ever put in a dossier lands here, and
-- source_url is NOT NULL on purpose. A claim without retrievable evidence is a
-- defect (CLAUDE.md). Operator memory from the seed is NOT evidence and does
-- not go in this table.
CREATE TABLE IF NOT EXISTS evidence (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  person_id    TEXT REFERENCES people(id),   -- set when the fact is about a person
  kind         TEXT NOT NULL,
  claim        TEXT NOT NULL,
  source_url   TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  -- A fact the system retrieved and a fact the operator pasted are
  -- different epistemic objects and must never be flattened into one.
  provenance   TEXT NOT NULL DEFAULT 'retrieved'
                 CHECK (provenance IN ('retrieved','operator_supplied')),
  body         TEXT,                          -- full pasted text, when there is one
  UNIQUE (org_id, kind, source_url, claim)
);

CREATE TABLE IF NOT EXISTS gate_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  person_id   TEXT REFERENCES people(id),    -- (seed) some kills are person-specific
  gate_id     TEXT NOT NULL,
  -- 'kill_as_buyer' is a fourth outcome §6 did not anticipate: the org is
  -- disqualified as a purchaser but retained as a referral or channel node.
  -- Collapsing it into 'kill' would lose a live relationship.
  outcome     TEXT NOT NULL CHECK (outcome IN ('pass','warn','kill','kill_as_buyer')),
  reason      TEXT,
  decided_at  TEXT,                          -- (seed)
  evidence_id INTEGER REFERENCES evidence(id),
  seeded      INTEGER NOT NULL DEFAULT 0,
  run_id      INTEGER REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  trigger_id  TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  decays_at   TEXT,
  weight      INTEGER NOT NULL DEFAULT 1,
  evidence_id INTEGER REFERENCES evidence(id),
  UNIQUE (org_id, trigger_id, evidence_id)
);

-- Firm-level score. The three levels are kept SEPARATE on purpose: they
-- fail independently and one blended number hides which one is weak.
CREATE TABLE IF NOT EXISTS scores (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  vertical_id      TEXT,                       -- thesis in config/sectors.yml
  fit              REAL,
  trigger_total    REAL,                       -- raw, undecayed
  urgency          REAL,                       -- trigger_total after decay
  fee_vs_authority REAL,                       -- can one person approve this alone
  total            REAL,
  package_id       TEXT,
  rationale        TEXT,
  pros             TEXT,                       -- newline-separated, each with a URL
  cons             TEXT,
  model            TEXT,
  run_id           INTEGER REFERENCES runs(id)
);

-- Person-level score. Ordered authority > reachability > warmth, per the
-- operator's own rule that bench authority outranks hook quality.
CREATE TABLE IF NOT EXISTS person_scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id     TEXT NOT NULL REFERENCES people(id),
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  vertical_id   TEXT,
  authority     REAL,
  reachability  REAL,
  warmth        REAL,
  total         REAL,
  persona_id    TEXT,                          -- which persona pattern matched
  -- An asserted prior, NEVER a measured rate, until n clears the threshold in
  -- sectors.yml.
  response_prior      REAL,
  response_prior_name TEXT,
  rationale     TEXT,
  pros          TEXT,
  cons          TEXT,
  needs_profile INTEGER NOT NULL DEFAULT 0,    -- 1 = paste a profile to rank properly
  -- Reasons NOT to write to this person THIS WEEK, newline separated. Separate
  -- from the score on purpose: "is this the right person" and "should I write
  -- to them now" are different questions, and answering the first while the
  -- reader asks the second put an unreachable contact at rank 1.
  blockers      TEXT,
  model         TEXT,
  run_id        INTEGER REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS briefs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  markdown   TEXT,
  model      TEXT,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  cost_usd   REAL,
  run_id     INTEGER REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS grades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id        INTEGER NOT NULL REFERENCES briefs(id),
  evidence_cited  INTEGER,
  gates_correct   INTEGER,
  why_now_datable INTEGER,
  clean           INTEGER,
  grader_model    TEXT
);

-- Versioned, never overwritten: the diff between what the system
-- drafted and what the operator actually sent is the highest-value signal here,
-- and it cannot be reconstructed after the fact.
CREATE TABLE IF NOT EXISTS drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  person_id    TEXT REFERENCES people(id),
  channel      TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  subject      TEXT,
  body         TEXT NOT NULL,
  package_id   TEXT,
  prompt_file  TEXT,                            -- prompts/ file that produced it
  model        TEXT,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  cost_usd     REAL,
  created_at   TEXT NOT NULL,
  sent_text    TEXT,                            -- what the operator actually sent
  outreach_id  INTEGER REFERENCES outreach(id),
  run_id       INTEGER REFERENCES runs(id)
);

-- One row per grading pass over one draft, by a model other than the drafter.
-- Rows are never updated: a repeat pass is a new row, so agreement between
-- passes on the same draft is measurable (classifiers are nondeterministic).
-- Each dimension is 1 pass / 0 fail; its *_items hold the failing quotes as JSON.
CREATE TABLE IF NOT EXISTS draft_grades (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id            INTEGER NOT NULL REFERENCES drafts(id),
  graded_text         TEXT NOT NULL,     -- 'draft' (the body) or 'sent' (sent_text)
  grader_model        TEXT NOT NULL,
  prompt_file         TEXT NOT NULL,
  prompt_version      TEXT,
  claims              INTEGER,
  claims_items        TEXT,
  recital             INTEGER,
  recital_items       TEXT,
  never_claim         INTEGER,           -- model's reading AND the literal screen
  never_claim_items   TEXT,
  channel_rules       INTEGER,
  channel_rules_items TEXT,
  clarity             INTEGER,           -- every reference lands; the sentences connect
  clarity_items       TEXT,
  fits_channel        INTEGER,           -- code, not model: length limits
  clean               INTEGER,           -- every dimension above passed
  cost_usd            REAL,
  run_id              INTEGER REFERENCES runs(id),
  graded_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outreach (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id               TEXT NOT NULL REFERENCES orgs(id),
  person_id            TEXT REFERENCES people(id),
  channel              TEXT NOT NULL,
  sent_at              TEXT NOT NULL,
  service_pitched      TEXT,
  message_text         TEXT,
  subject              TEXT,                 -- (seed) email only
  pitch_summary        TEXT,                 -- (seed) present when message_text was not preserved
  status               TEXT,                 -- (seed) sent_no_reply | open_thread | responded_* | channel_open | bounced
  warm                 INTEGER,              -- (seed)
  credit_spent         INTEGER,              -- (seed) a LinkedIn InMail credit was burned
  rate_usd_hour_quoted REAL,                 -- (seed)
  source_memory        TEXT,                 -- (seed) file holding the full text
  seeded               INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS responses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  outreach_id  INTEGER NOT NULL REFERENCES outreach(id),
  responded_at TEXT,
  sentiment    TEXT,
  outcome      TEXT,
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  stage      TEXT NOT NULL,
  model      TEXT,
  cost_usd   REAL NOT NULL DEFAULT 0,
  n_in       INTEGER,
  n_out      INTEGER,
  notes      TEXT
);

-- ONE ROW PER MODEL CALL, added 2026-10-01. The runs table holds one model and one
-- running cost per stage run, which cannot split a run that used two models,
-- and its n_in/n_out held tokens for some stages and item counts for others
-- (the stage's own totals overwrote the tokens at finish). This ledger is
-- written inside complete(), which every call goes through, and nothing else
-- writes to it. Tokens and per-model cost are read from here.
CREATE TABLE IF NOT EXISTS llm_calls (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER REFERENCES runs(id),
  stage              TEXT,
  model              TEXT NOT NULL,
  at                 TEXT NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  web_searches       INTEGER,
  cost_usd           REAL,                   -- NULL when the model has no price on file
  stop_reason        TEXT
);

-- ---- suppression, not in §6 ------------------------------------------------

-- Hard suppression. A row here means never surface as a prospect again,
-- whether or not the person was ever contacted.
CREATE TABLE IF NOT EXISTS do_not_contact (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT REFERENCES people(id),
  org_id    TEXT REFERENCES orgs(id),
  reason    TEXT NOT NULL,
  seeded    INTEGER NOT NULL DEFAULT 0,
  CHECK (person_id IS NOT NULL OR org_id IS NOT NULL)
);

-- Time-gated suppression. Expires on release_after; the condition is prose the
-- operator must read before releasing, so it is surfaced, not auto-cleared.
CREATE TABLE IF NOT EXISTS hold (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id     TEXT NOT NULL REFERENCES people(id),
  release_after TEXT NOT NULL,
  condition     TEXT,
  seeded        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS marketplace_registrations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id            TEXT NOT NULL REFERENCES orgs(id),
  joined_at         TEXT,
  applied_at        TEXT,
  rate_usd_hour     TEXT,
  rate_usd_hour_net REAL,
  pitches_submitted INTEGER,
  last_pitch        TEXT,
  outcome           TEXT,
  note              TEXT,
  seeded            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scheduled_followups (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  date   TEXT NOT NULL,
  note   TEXT,
  seeded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scheduled_followup_targets (
  followup_id INTEGER NOT NULL REFERENCES scheduled_followups(id),
  person_id   TEXT NOT NULL REFERENCES people(id),
  PRIMARY KEY (followup_id, person_id)
);

-- Which thesis in config/sectors.yml a firm is being pursued under. A join
-- table rather than a column so one firm can sit in more than one thesis.
CREATE TABLE IF NOT EXISTS org_verticals (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  vertical_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (org_id, vertical_id)
);

-- Board tokens known to answer, so a discovery probe is paid for once rather
-- than on every run. config/runtime.yml stays the curated list; this is the cache.
CREATE TABLE IF NOT EXISTS org_boards (
  ats                TEXT NOT NULL,
  token              TEXT NOT NULL,
  org_id             TEXT NOT NULL REFERENCES orgs(id),
  discovered_at      TEXT NOT NULL,
  last_ok_at         TEXT,
  postings_last_seen INTEGER,
  PRIMARY KEY (ats, token)
);

CREATE INDEX IF NOT EXISTS idx_evidence_org   ON evidence(org_id);
CREATE INDEX IF NOT EXISTS idx_evidence_person ON evidence(person_id);
CREATE INDEX IF NOT EXISTS idx_pscores_org    ON person_scores(org_id);
CREATE TABLE IF NOT EXISTS unblocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   TEXT NOT NULL REFERENCES people(id),
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  vertical_id TEXT,
  block_tag   TEXT NOT NULL,                -- as blockTag() named it, e.g. 'no offer'
  block_text  TEXT NOT NULL,                -- the blocker verbatim, so a verdict stays readable
  -- THREE VERDICTS AND NOT TWO. stands and angle are the obvious pair;
  -- system_defect exists because most of what was unblocked BY HAND on
  -- 2026-09-22 was not a better reading of a prospect, it was a bug: a thesis
  -- pointing at retired packages, a report column reading a field no row
  -- carries. Without a third verdict those come back dressed as pitches.
  -- angle_rejected is not the model's to choose: it is what this stage
  -- records when a returned angle cites no evidence that exists.
  verdict     TEXT NOT NULL CHECK (verdict IN ('stands','angle','system_defect','angle_rejected')),
  why         TEXT,
  premise     TEXT,                         -- the note's opening claim, when verdict='angle'
  basis       TEXT,                         -- comma-joined evidence ids backing the premise
  package_id  TEXT,
  rule_asked  TEXT,                         -- when verdict='system_defect'
  evidence_says TEXT,
  model       TEXT,
  prompt_file TEXT,
  cost_usd    REAL,
  decided_at  TEXT NOT NULL,
  run_id      INTEGER REFERENCES runs(id)
);

-- EVERY VERDICT, INCLUDING THE REFUSED ONES. The glean stage proposes signals
-- from text the operator pasted, and a proposal that cannot quote itself is
-- rejected in code. Those rejections are the interesting rows: they are the
-- stage trying to claim something the evidence does not say, and the only way
-- to know how often that happens is to keep them. Same reason the unblocks
-- table records angle_rejected rather than dropping it.
-- (No backticks in here. This whole schema is a JS template literal.)
-- A THESIS ABOUT THE PERSON, written before any note exists.
-- Every other stage in this project is about a firm, a seat or a sentence.
-- Nothing was about what the prospect is trying to DO, so the drafter got a pile
-- of evidence and a constraint and no goal -- and under a constraint with no
-- goal the safest output is recitation. Six hand revisions on one note were the
-- operator supplying this reasoning himself.
-- Stored rather than computed inside the drafter so it can be read in one glance
-- and rejected before a note is built on it, and so a grader has something
-- checkable to score.
CREATE TABLE IF NOT EXISTS reads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id        TEXT    NOT NULL REFERENCES people(id),
  org_id           TEXT    NOT NULL REFERENCES orgs(id),
  trying_to_do     TEXT,
  in_the_way       TEXT,
  what_an_hour_does TEXT,
  do_not_say       TEXT,
  confidence       TEXT,              -- strong | thin
  suggests_package TEXT,              -- the offer the thesis points at, chosen AFTER the read
  basis            TEXT,              -- evidence ids the read leans on
  rejected_at      TEXT,              -- set by hand when the operator says the read is wrong
  rejected_reason  TEXT,
  model            TEXT,
  prompt_file      TEXT,
  cost_usd         REAL,
  run_id           INTEGER REFERENCES runs(id),
  created_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reads_person ON reads(person_id);

-- RULES PROPOSED FROM THE OPERATOR'S OWN CORRECTIONS, and never written into
-- the voice file until he accepts one. A bad rule silently degrades every note
-- that follows, and the voice file is the one input no stage can sanity-check.
-- Rejections are kept: a rule proposed twice and rejected twice is a fact about
-- the learner, not about him.
CREATE TABLE IF NOT EXISTS voice_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule        TEXT NOT NULL,
  why         TEXT,
  seen        INTEGER,            -- how many corrections it was drawn from
  instances   TEXT,               -- the corrections themselves, quoted
  confidence  TEXT,               -- strong | worth asking
  status      TEXT NOT NULL DEFAULT 'proposed',   -- proposed | accepted | rejected
  -- WHICH STAGE THE RULE IS ABOUT, because they are not the same stage and the
  -- lesson is worthless in the wrong one. A correction about WORDING belongs to
  -- the draft stage and lands in prompts/voice.md. A correction about WHICH
  -- OFFER and WHY belongs to the read stage, which chooses the pitch before a
  -- word is written, and lands in prompts/read-rules.md.
  --
  -- Found 2026-09-25. Three of five corrections typed in one evening were about
  -- offer selection -- "figure out what is of greatest importance to her, which
  -- of that can be accelerated by ai, then figure out what i sell that speaks to
  -- that" -- and every one was filed as a voice rule, which only the draft
  -- stage reads,
  -- by which point the offer is already chosen. The same pitch error had been
  -- corrected by hand four times and retained none of it.
  kind        TEXT NOT NULL DEFAULT 'voice',      -- voice | read
  decided_at  TEXT,
  decided_why TEXT,
  model       TEXT,
  run_id      INTEGER REFERENCES runs(id),
  created_at  TEXT NOT NULL
);

-- EVERY AUDIT FINDING, KEPT. Five audit runs on 2026-09-24 cost $5.50 between
-- them and every census was printed to a terminal and lost, so "did that prompt
-- change help?" was unanswerable and each defect had to be chased one note at a
-- time. A loop whose results evaporate is not a loop.
--
-- One row per (run, draft, flag). The prompt file and its mtime ride along so a
-- census can be attributed to the prompt that produced the notes, which is the
-- whole point of versioning prompts in the first place (CLAUDE.md).
--
-- The source column separates the two kinds of finding; do not pool them:
--   mechanical  arithmetic over the text. Same answer every time, costs nothing.
--   judge       a model read the note. About 3c, and NOT reproducible -- a
--               re-run over an unchanged corpus moved a flag by three.
-- Comparing two runs means comparing mechanical counts exactly and judge counts
-- with a wide margin.
CREATE TABLE IF NOT EXISTS audit_findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER REFERENCES runs(id),
  draft_id    INTEGER REFERENCES drafts(id),
  person_id   TEXT    REFERENCES people(id),
  flag        TEXT    NOT NULL,
  source      TEXT    NOT NULL,          -- mechanical | judge
  detail      TEXT,
  draft_prompt TEXT,                     -- prompts/draft-cold-note.md as it stood
  prompt_mtime TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_run  ON audit_findings(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_flag ON audit_findings(flag);

-- THE FIXED PANEL the drafter is measured against.
--
-- The operator, 2026-09-25, on being shown two redrafted notes: "is the above
-- resolving the debugging issue? or merely redrafting notes?" Merely redrafting.
-- A census over whatever drafts happen to exist cannot attribute a change to
-- anything: the corpus moves under you, and on the day this was written 8 of the
-- 23 audited notes were at firms a gate had killed or that had already been
-- contacted, so their defects could never matter and were pure noise.
--
-- A panel is the same people every time, chosen to span the situations that
-- break things -- a conference angle, an acquisition, a published RFP, a hiring
-- req, thin evidence. Change one thing, regenerate the whole panel, read the
-- delta. At 13c a draft and 3c a read, a twelve-person cycle is about $2.
CREATE TABLE IF NOT EXISTS bench (
  person_id  TEXT PRIMARY KEY REFERENCES people(id),
  why        TEXT,                       -- the situation this member is here to cover
  added_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gleans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id     INTEGER NOT NULL REFERENCES evidence(id),
  org_id          TEXT    NOT NULL REFERENCES orgs(id),
  person_id       TEXT    REFERENCES people(id),
  verdict         TEXT    NOT NULL,   -- fires | stands_down | rejected | duplicate
  trigger_id      TEXT,
  quote           TEXT,               -- verified verbatim against evidence.body
  dated_on        TEXT,               -- '' when the paste carried no date
  why             TEXT,
  rejected_reason TEXT,               -- why a proposed signal was refused
  signal_id       INTEGER REFERENCES signals(id),
  model           TEXT,
  run_id          INTEGER REFERENCES runs(id),
  created_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gleans_ev ON gleans(evidence_id);

CREATE TABLE IF NOT EXISTS signal_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id     INTEGER NOT NULL REFERENCES signals(id),
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  trigger_id    TEXT NOT NULL,
  retracted_reason TEXT,
  -- Was the retraction right? Three answers, for the same reason unblocks has
  -- three: the interesting middle case is an event that IS real and was filed
  -- under the wrong trigger, which is neither "the retraction was correct" nor
  -- "put it back as it was".
  verdict       TEXT NOT NULL CHECK (verdict IN ('retraction_right','retraction_wrong','wrong_trigger')),
  why           TEXT,
  should_be     TEXT,                       -- when verdict='wrong_trigger', the trigger id it belongs to
  model         TEXT,
  prompt_file   TEXT,
  cost_usd      REAL,
  decided_at    TEXT NOT NULL,
  run_id        INTEGER REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_sigrev_signal ON signal_reviews(signal_id);
CREATE INDEX IF NOT EXISTS idx_unblocks_person ON unblocks(person_id);
CREATE INDEX IF NOT EXISTS idx_unblocks_verdict ON unblocks(verdict);
CREATE INDEX IF NOT EXISTS idx_drafts_person  ON drafts(person_id);
CREATE INDEX IF NOT EXISTS idx_signals_org    ON signals(org_id);
CREATE INDEX IF NOT EXISTS idx_gate_org       ON gate_results(org_id);
CREATE INDEX IF NOT EXISTS idx_outreach_org   ON outreach(org_id);
CREATE INDEX IF NOT EXISTS idx_outreach_perso ON outreach(person_id);
CREATE INDEX IF NOT EXISTS idx_people_org     ON people(org_id);
`;

// CREATE TABLE IF NOT EXISTS silently does nothing to a table that already
// exists, so every column added after a database was first created has to be
// applied here as well. Learned the hard way on 2026-08-25, when four columns
// added to `people` were invisible to a database created an hour earlier.
//
// Each entry is (table, column, definition). Adding a column is idempotent
// because we check pragma_table_info first, and SQLite's ALTER TABLE ADD COLUMN
// is cheap. Anything more complex than adding a nullable column needs a real
// migration, not this.
const COLUMN_MIGRATIONS = [
  ['orgs', 'staffs_capability', 'TEXT'],
  ['evidence', 'person_id', 'TEXT REFERENCES people(id)'],
  ['evidence', 'provenance', "TEXT NOT NULL DEFAULT 'retrieved'"],
  ['evidence', 'body', 'TEXT'],
  ['people', 'role_confirmed', 'TEXT'],
  ['people', 'in_seat_since', 'TEXT'],
  ['people', 'platform_activity', 'TEXT'],
  ['people', 'followers', 'INTEGER'],
  ['people', 'referral_value', 'REAL'],
  // Where the person actually sits. icp.geography has always declared US and
  // nothing read it, so a London partner and a Chicago CIO at the same global
  // firm ranked identically. Stored as written, plus a country for comparing.
  ['people', 'location', 'TEXT'],
  ['people', 'country', 'TEXT'],
  ['scores', 'vertical_id', 'TEXT'],
  ['scores', 'urgency', 'REAL'],
  ['scores', 'fee_vs_authority', 'REAL'],
  ['scores', 'total', 'REAL'],
  ['scores', 'pros', 'TEXT'],
  ['scores', 'cons', 'TEXT'],
  ['gate_results', 'seeded', 'INTEGER NOT NULL DEFAULT 0'],
  ['gate_results', 'run_id', 'INTEGER'],
  ['outreach', 'seeded', 'INTEGER NOT NULL DEFAULT 0'],
  ['orgs', 'hq', 'TEXT'],
  ['orgs', 'kind', 'TEXT'],
  ['person_scores', 'blockers', 'TEXT'],
  ['orgs', 'sells_ai_delivery', 'INTEGER'],
  ['orgs', 'sells_ai_advisory', 'INTEGER'],
  ['orgs', 'aum_usd', 'INTEGER'],
  ['orgs', 'announced_capex_usd', 'INTEGER'],
  ['orgs', 'seeded', 'INTEGER NOT NULL DEFAULT 0'],
  // A signal that was judged wrong is retracted, not deleted. The record of what
  // the system got wrong is the measurement layer this project exists to have.
  // Which address or handle a note actually went to. Absent until 2026-09-09,
  // when a note was sent to a PATTERN-GUESSED address and nothing recorded which
  // one — so a bounce could not be attributed and a delivery could not confirm
  // the firm's address shape.
  ['outreach', 'sent_to', 'TEXT'],
  // HOW GOOD THE ADDRESS WAS AT THE MOMENT IT WAS USED. `sent_to` records where
  // a note went and nothing recorded whether anyone had ever confirmed that
  // address existed. Two sends in the record went to inferred addresses and sit
  // in the denominator as "sent, no reply", which is indistinguishable from
  // arrived-and-ignored and is a completely different fact about the market.
  // people.email_guess can be overwritten later, so this cannot be
  // reconstructed after the fact -- it has to be stamped at send time.
  ['outreach', 'address_basis', 'TEXT'],
  // A date corrected against the firm's own announcement keeps the date it
  // came from. Overwriting silently would hide that a content farm had the
  // event three months late and that the ranking believed it.
  // Tavily spend. CLAUDE.md says every call is priced into `runs` and the cost
  // study depends on it — and searches were counted in memory, printed, and
  // dropped, so cost per qualified prospect understated itself by whatever
  // retrieval cost. A second cost stream nobody recorded is the same defect as
  // no cost stream.
  ['runs', 'tavily_credits', 'INTEGER NOT NULL DEFAULT 0'],
  ['signals', 'date_corrected_from', 'TEXT'],
  ['signals', 'retracted_at', 'TEXT'],
  ['signals', 'retracted_reason', 'TEXT'],
  // Derived by `rank` from the same location the reachability factor reads, and
  // stored so the dashboard can count and filter on it. Never hand-entered: a
  // label that can disagree with the multiplier it explains is worse than none.
  ['person_scores', 'geo_bucket', 'TEXT'],
  // What the operator asked for between two versions, and which version he asked
  // it of. Without these the version sequence is a pile of drafts; with them it
  // is a record of which instructions actually changed the writing.
  ['drafts', 'revised_from', 'INTEGER'],
  ['drafts', 'revise_note', 'TEXT'],
  // Which voice examples a draft was written from: {arm: fixed|picked, shown:
  // [draft ids]}. Without it the two arms cannot be compared (voice-examples.mjs).
  ['drafts', 'examples', 'TEXT'],
  // When the sent text was RECORDED, not when the note went out (that is
  // outreach.sent_at, which may be backdated). The example pool for a day is
  // the notes recorded before it began, so a send recorded at noon does not
  // change the prompt every later draft that day reads from cache. NULL on
  // rows recorded before the column existed: they count as long recorded.
  ['drafts', 'sent_recorded_at', 'TEXT'],
  // owns | influences | none | unclear — whether the person controls spend on
  // the thing being sold, as distinct from holding a title that suggests he does.
  ['people', 'capability_authority', 'TEXT'],
  // The seat score BEFORE the capability_authority discount. `authority` answers
  // "how much of this seat's budget power do we believe in", which is the right
  // thing to rank on and the wrong thing to gate on: used as the shortlist floor
  // it turned "is this a buyer seat" into "is this a buyer seat we have already
  // researched", and emptied the worklist that says who to research next.
  ['person_scores', 'seat_authority', 'REAL'],
  // The persona PATTERN that matched, not the persona's index. `persona_id` is
  // "<vertical>#3", which is unstable across a config edit and means nothing
  // across verticals -- the same seat is #0 in one sector and #2 in another.
  // The pattern is the seat, and the seat is what an operator filters on.
  ['person_scores', 'persona_match', 'TEXT'],
  // buyer | router | referral_node | blocker -- the persona's OWN word for what
  // this seat can do. The shortlist floor was a number standing in for it, and
  // the number could not express what the comment beside it claimed.
  ['person_scores', 'persona_authority', 'TEXT'],
  // Other services whose fires_when the same evidence also satisfies, so the
  // card can offer a second sell rather than only the router's first choice.
  ['scores', 'package_alts', 'TEXT'],
  // "evidence" or "default", and the dated trigger behind it. Whether the router
  // decided or shrugged is the first thing to know about an assignment.
  ['scores', 'package_basis', 'TEXT'],
  // Verbatim evidence that THIS PERSON is publicly recruiting for the capability
  // being sold. A capacity offer landing in front of someone running that search
  // reads as an application, which is the one misread the whole pitch is built
  // to avoid. Null means nobody has looked; empty means looked and found none.
  ['people', 'hiring_for_capability', 'TEXT'],
  // DOES THIS PERSON BUILD IT THEMSELVES? Kept apart from capability_authority,
  // which asks who holds the BUDGET — the opposite question, and one where "owns"
  // marks the best buyer in the book. A firm can have a budget holder and no
  // builder, which is the whole build pitch; it can also have a COO who ships his
  // own agent systems in public every day, which is a firm that does not need one.
  // Verbatim evidence, not a boolean, so the claim can be read and argued with.
  // Null means nobody has looked; empty means looked and found none.
  ['people', 'builds_in_house', 'TEXT'],
  ['people', 'buyer_remit', 'TEXT'],
  ['people', 'prior_relationship', 'TEXT'],
  // 1 when the call went through the Batches API, which bills at half price.
  // Without it a halved cost would read as a cheaper model.
  ['llm_calls', 'batch', 'INTEGER'],
  ['scores', 'package_trigger', 'TEXT'],
  // WHAT THE WORK IS, kept apart from which offer was chosen. See `capabilities`
  // in offers.yml: evidence names the capability, the buyer's seat names the
  // form, and storing only the form threw away the half that the trigger
  // actually supports.
  ['scores', 'work_id', 'TEXT'],
  ['scores', 'work_trigger', 'TEXT'],
  ['scores', 'work_alts', 'TEXT'],
  // The two groupings the capability belongs to, denormalised onto the score so
  // the dashboard can bucket without re-reading config, and so a historical row
  // records how a prospect was found even after the config is rewritten.
  ['scores', 'work_form', 'TEXT'],
  ['scores', 'work_evidence', 'TEXT'],
  // WHERE A HEADCOUNT CAME FROM, which decides what it may be used for. Two
  // size gates existed and could not evaluate three quarters of the book
  // because `enrich` will only record a number a PAGE states — correctly, since
  // "a team of talented scientists" is not a number. The cheaper sources are a
  // web search and the judge's own recollection, and neither is a sourced claim.
  //   page     a page stated it. Citable in a dossier.
  //   search   a search result stated it, with a URL. Citable.
  //   estimate the model recalled it. GATES ONLY — never shown as a fact.
  ['orgs', 'headcount_source', 'TEXT'],
  // See the note beside voice_rules.kind. Existing rows backfill to 'voice',
  // which is what every rule proposed before the split actually was.
  ['voice_rules', 'kind', "TEXT NOT NULL DEFAULT 'voice'"],
  // A BOARD FOUND BY GUESSING A TOKEN IS A GUESS, and the same distinction the
  // schema already draws between `email` and `email_guess` applies: three of the
  // first five boards --discover ever found belonged to a different company.
  // Only a board whose owner has been confirmed may produce evidence.
  //   confirmed  the board states a company name that matches this org
  //   named      the org's name appears in the postings themselves
  //   config     the operator put it in runtime.yml by hand
  //   (null)     a token guess nobody has checked -- never used for evidence
  ['org_boards', 'verified_by', 'TEXT'],
];

function migrate(db) {
  const applied = [];
  for (const [tbl, col, def] of COLUMN_MIGRATIONS) {
    const exists = db.prepare('SELECT COUNT(*) c FROM pragma_table_info(?) WHERE name = ?')
      .get(tbl, col).c > 0;
    if (exists) continue;
    // The table itself may not exist yet in a very old file; skip quietly.
    const tblExists = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(tbl).c > 0;
    if (!tblExists) continue;
    db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`);
    applied.push(`${tbl}.${col}`);
  }
  return applied;
}

export function openDb(path = DB_PATH, { quiet = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // WAIT FOR THE LOCK INSTEAD OF FAILING ON IT. WAL allows one writer at a
  // time, and the default busy_timeout of 0 means a second writer throws
  // SQLITE_BUSY the instant it collides rather than queueing. That made running
  // two stages at once unsafe -- enrich writing while gate wanted to, on
  // 2026-09-25 -- so the answer was always "wait for the other job to finish".
  // Five seconds is far longer than any write here takes; the writes are single
  // small inserts, not transactions held open across network calls.
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  const applied = migrate(db);
  addRevenueSource(db);
  addSizeProvenance(db);
  addAddressCheck(db);
  addNextStep(db);
  addVerdicts(db);
  addGradeClarity(db);
  if (applied.length && !quiet) console.error(`migrated: ${applied.join(', ')}`);
  return db;
}

// CLARITY, added 2026-10-01 with grade-draft v2: two drafts in one evening
// pointed at "those intelligent tools" and "those point agents" that nothing
// before them named, and four content checks passed both.
function addGradeClarity(db) {
  const cols = db.prepare('PRAGMA table_info(draft_grades)').all().map((c) => c.name);
  if (!cols.length) return;
  if (!cols.includes('clarity')) db.exec('ALTER TABLE draft_grades ADD COLUMN clarity INTEGER');
  if (!cols.includes('clarity_items')) db.exec('ALTER TABLE draft_grades ADD COLUMN clarity_items TEXT');
}

/** Open a run row. Every stage records one, LLM or not, so cost is never retrofitted. */
// Revenue, like headcount, may be RECALLED rather than retrieved, and the gate
// has to be able to tell which. 374 of 411 firms had no revenue figure at all,
// and the money gate read every one of them as below threshold -- the same
// "unsized is not small" error the persona headcount rule exists to avoid.
// TWO NUMBERS, NOT ONE WITH A LABEL ON IT. Added 2026-09-23 at the operator's
// request: "can ths solution be revised to that it trackes discovered and
// recalled numbers? with subsequent discovery replacing recalled values".
//
// A single column plus a source field can say where today's number came from and
// nothing else. The moment a real figure is found, the recall it replaced is
// gone, and with it the only chance this project ever had to answer the question
// that matters: HOW GOOD IS THE RECALL? 293 firms were sized from model memory
// in one pass, and those numbers now decide which offer a stranger gets pitched.
// Keeping both columns means every later discovery is a free test of the guess
// that preceded it.
//
// <metric>_found beats <metric>_recalled, always and automatically. <metric>_est
// stays as the effective value every other stage already reads, so nothing
// downstream has to know this happened.
// THE FIELD THE RECIPE NEEDS. `what_an_hour_does` is artifact-shaped by design,
// built to stop the read offering meetings. The note's second beat is different:
// the STEP that follows from what they are already doing, which the operator
// writes as "tailoring the AI that directs help to each student is the next
// piece, and that is what I build". Deriving that from an artifact field made
// the drafter pad the gap with an extra observation every time.
function addNextStep(db) {
  const cols = db.prepare('PRAGMA table_info(reads)').all().map((c) => c.name);
  if (!cols.includes('next_step')) db.exec('ALTER TABLE reads ADD COLUMN next_step TEXT');
  // WHO THE NOTE SHOULD GO TO, added 2026-09-25. The read could say in prose
  // that someone else owns the mandate, and rank could not hear prose; a CEO
  // topped the list to write the day he appointed the person who does.
  if (!cols.includes('recipient')) db.exec('ALTER TABLE reads ADD COLUMN recipient TEXT');
  if (!cols.includes('better_recipient')) db.exec('ALTER TABLE reads ADD COLUMN better_recipient TEXT');
}

// THE OPERATOR'S OWN CALL, person by person. Added 2026-09-25 as the first step
// toward deciding, with numbers, whether the ranker should keep its weights or
// learn from examples the way the drafter did. A verdict records what he would
// do and why, and the rank the ranker had given that person at the moment, so
// the two can be compared later without re-deriving what the list looked like.
// Append-only: a changed mind is a second row, and the latest one counts.
function addVerdicts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS verdicts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id   TEXT NOT NULL REFERENCES people(id),
    org_id      TEXT NOT NULL REFERENCES orgs(id),
    verdict     TEXT NOT NULL CHECK (verdict IN ('write', 'skip')),
    reason      TEXT,
    rank_then   INTEGER,           -- position among live people when he judged
    live_then   INTEGER,           -- how many live people there were
    score_then  REAL,
    source      TEXT NOT NULL DEFAULT 'card',   -- card | cli | seeded
    created_at  TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_verdicts_person ON verdicts(person_id)');
  // WRITE FIRST, added 2026-09-26. A plain "write" meant any opening, however
  // small; what the ranking is for is putting the few he would write to FIRST at
  // the top of a day's cards. `first` marks those, on a write.
  const cols = db.prepare('PRAGMA table_info(verdicts)').all().map((c) => c.name);
  if (!cols.includes('first')) db.exec('ALTER TABLE verdicts ADD COLUMN first INTEGER NOT NULL DEFAULT 0');
}

// WHEN A FIRM'S ADDRESSES WERE LAST LOOKED FOR, added 2026-10-09. The morning
// run looked up the same eight firms every day: a firm that publishes no
// address still has none tomorrow, so it stayed first in line and the firms
// behind it were never reached. A lookup records the date; the morning skips a
// firm looked at recently.
function addAddressCheck(db) {
  const cols = db.prepare('PRAGMA table_info(orgs)').all().map((c) => c.name);
  if (!cols.includes('addresses_checked_at')) db.exec('ALTER TABLE orgs ADD COLUMN addresses_checked_at TEXT');
}

function addSizeProvenance(db) {
  const cols = db.prepare('PRAGMA table_info(orgs)').all().map((c) => c.name);
  const add = (name, type) => { if (!cols.includes(name)) db.exec(`ALTER TABLE orgs ADD COLUMN ${name} ${type}`); };
  for (const m of ['revenue', 'headcount']) {
    add(`${m}_found`, 'INTEGER');          // retrieved from a page, filing or the operator
    add(`${m}_found_url`, 'TEXT');         // every factual claim carries a source
    add(`${m}_found_at`, 'TEXT');
    add(`${m}_recalled`, 'INTEGER');       // what a model remembered, before anyone looked
    add(`${m}_recalled_at`, 'TEXT');
  }

  // Backfill from the single-column era. These source values were already being
  // written; they just had nowhere to separate into.
  const FOUND = "('page','search','operator','filing','sec','vet')";
  const RECALL = "('recalled','estimate','model')";
  db.exec(`UPDATE orgs SET headcount_found = headcount_est
            WHERE headcount_found IS NULL AND headcount_est IS NOT NULL
              AND COALESCE(headcount_source,'') IN ${FOUND}`);
  db.exec(`UPDATE orgs SET headcount_recalled = headcount_est
            WHERE headcount_recalled IS NULL AND headcount_est IS NOT NULL
              AND COALESCE(headcount_source,'') IN ${RECALL}`);
  db.exec(`UPDATE orgs SET revenue_found = revenue_est
            WHERE revenue_found IS NULL AND revenue_est IS NOT NULL
              AND COALESCE(revenue_source,'') IN ${FOUND}`);
  db.exec(`UPDATE orgs SET revenue_recalled = revenue_est
            WHERE revenue_recalled IS NULL AND revenue_est IS NOT NULL
              AND COALESCE(revenue_source,'') IN ${RECALL}`);
}

/**
 * Write a size figure with its provenance, and let discovery win.
 *
 * A found figure always replaces the effective value. A recalled one only fills
 * a gap -- it can never overwrite something somebody actually looked up, which
 * is the rule `size` was already keeping by hand and is now kept here so every
 * caller keeps it.
 *
 * The recalled column is never cleared by a discovery. That is the point: the
 * pair is the record of what was guessed and what turned out to be true.
 */
export function recordSize(db, orgId, metric, value, { found = false, url = null, source = null } = {}) {
  if (!['revenue', 'headcount'].includes(metric)) throw new Error(`unknown metric "${metric}"`);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { written: false, why: 'not a usable number' };
  const now = new Date().toISOString();
  const row = db.prepare(`SELECT ${metric}_found f, ${metric}_recalled r FROM orgs WHERE id = ?`).get(orgId);
  if (!row) return { written: false, why: 'no such org' };

  if (found) {
    db.prepare(`UPDATE orgs SET ${metric}_found = ?, ${metric}_found_url = ?, ${metric}_found_at = ?,
      ${metric}_est = ?, ${metric}_source = ? WHERE id = ?`)
      .run(n, url, now, n, source ?? 'page', orgId);
    // A discovery that lands on top of a guess is a measurement, so say so.
    return { written: true, replaced_recall: row.r ?? null,
      off_by: row.r ? Number(((n - row.r) / row.r * 100).toFixed(1)) : null };
  }
  db.prepare(`UPDATE orgs SET ${metric}_recalled = ?, ${metric}_recalled_at = ? WHERE id = ?`)
    .run(n, now, orgId);
  // Only fills a hole. Never displaces a found figure.
  if (row.f == null) {
    db.prepare(`UPDATE orgs SET ${metric}_est = ?, ${metric}_source = 'recalled' WHERE id = ?`).run(n, orgId);
  }
  return { written: true, deferred_to_found: row.f != null };
}

function addRevenueSource(db) {
  const cols = db.prepare('PRAGMA table_info(orgs)').all().map((c) => c.name);
  if (!cols.includes('revenue_source')) {
    db.exec('ALTER TABLE orgs ADD COLUMN revenue_source TEXT');
  }
  if (!cols.includes('revenue_basis')) {
    // For a union, a charity or a public body the meaningful number is an
    // OPERATING BUDGET, not revenue. Storing which one this is stops a $2bn
    // budget being read as $2bn of sales.
    db.exec('ALTER TABLE orgs ADD COLUMN revenue_basis TEXT');
  }
}

export function startRun(db, stage, { model = null, notes = null } = {}) {
  const info = db
    .prepare('INSERT INTO runs (started_at, stage, model, notes) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), stage, model, notes);
  return info.lastInsertRowid;
}

// A RUN THAT SPENT MONEY MUST NOT END AT ZERO.
//
// `cost_usd` and `tavily_credits` defaulted to 0 and the UPDATE below ASSIGNED
// them, so any stage calling finishRun(db, runId, {}) overwrote whatever
// complete() had already accumulated on the row. `unblock` did exactly that on
// 2026-09-22: $2.09 of real calls, six runs rows reading $0.00. CLAUDE.md makes
// this a hard guardrail — every LLM call records model, tokens and cost, and the
// cost study cannot be retrofitted — so a default that silently erases the
// record is the one default this function may not have.
//
// Now null-defaulted and COALESCEd: pass a number to assert it, pass nothing to
// keep what the calls themselves recorded. A stage that makes no LLM calls and
// wants to say so explicitly still passes `cost_usd: 0`, and that still writes 0.
export function finishRun(db, runId,
  { cost_usd = null, n_in = null, n_out = null, tavily_credits = null, notes = null } = {}) {
  // `notes` carries what a run needs to be auditable after it ends. Today that
  // is which hosts required a browser: CLAUDE.md forbids a browser fetch passing
  // silently, and a line printed to a terminal that is gone tomorrow does not
  // answer "which firms required it" next week.
  const note = notes ?? browserNote();
  // A STAGE'S OWN TOTAL CAN ONLY RAISE THE RECORDED COST, never lower it.
  // complete() adds every call's cost as it happens; a stage that finished with
  // cost_usd: 0, or a tally that missed a call, used to overwrite that.
  db.prepare(`UPDATE runs SET ended_at = @ended,
                cost_usd = CASE WHEN @cost IS NULL THEN cost_usd ELSE MAX(COALESCE(cost_usd, 0), @cost) END,
                n_in  = COALESCE(@n_in, n_in),
                n_out = COALESCE(@n_out, n_out),
                tavily_credits = COALESCE(@credits, tavily_credits),
                notes = COALESCE(@note, notes) WHERE id = @id`)
    .run({ ended: new Date().toISOString(), cost: cost_usd, n_in, n_out, credits: tavily_credits,
      note: note ?? null, id: runId });
  if (note && !notes) {
    // SAID OUT LOUD, not only filed. The rule is that a browser fetch does not
    // pass silently; a row nobody looks at would still be silent.
    console.log(`\nBROWSER USED — ${note}`);
    console.log('  Permitted only where robots.txt allows the path, the site serves a ' +
      'browser, and it is not linkedin.com. Recorded on this run so it stays auditable.');
  }
}

// UNDOING AN ADMISSION. `npm run firms` vets candidates in the book, because
// enrich and gate work on org rows, and takes out every one that fails. These
// remove what the vet wrote: every row keyed to the firm or its people. The
// runs ledger keeps its cost; it holds no org or person id.
const tablesWith = (db, col) => db.prepare(`SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) p
  WHERE m.type = 'table' AND p.name = ?`).all(col).map((r) => r.name);

// Rows elsewhere that cite evidence about to go: a gate's reason can cite a
// staff listing. A nullable citation is cleared, a required one goes with it.
function releaseEvidence(db, where, args) {
  const ids = db.prepare(`SELECT id FROM evidence WHERE ${where}`).all(...args).map((r) => r.id);
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()) {
    for (const fk of db.prepare(`SELECT "from" col FROM pragma_foreign_key_list(?) WHERE "table" = 'evidence'`).all(name)) {
      const required = db.prepare(`SELECT "notnull" n FROM pragma_table_info(?) WHERE name = ?`).get(name, fk.col).n;
      db.prepare(required ? `DELETE FROM ${name} WHERE ${fk.col} IN (${marks})`
        : `UPDATE ${name} SET ${fk.col} = NULL WHERE ${fk.col} IN (${marks})`).run(...ids);
    }
  }
}

/** Remove people and every row keyed to them. */
export function purgePeople(db, personIds) {
  if (!personIds.length) return;
  const marks = personIds.map(() => '?').join(',');
  db.transaction(() => {
    releaseEvidence(db, `person_id IN (${marks})`, personIds);
    for (const t of tablesWith(db, 'person_id')) {
      db.prepare(`DELETE FROM ${t} WHERE person_id IN (${marks})`).run(...personIds);
    }
    db.prepare(`DELETE FROM people WHERE id IN (${marks})`).run(...personIds);
  })();
}

/** Remove a firm, its people, and every row keyed to either. */
export function purgeOrg(db, orgId) {
  const people = db.prepare('SELECT id FROM people WHERE org_id = ?').all(orgId).map((r) => r.id);
  db.transaction(() => {
    purgePeople(db, people);
    releaseEvidence(db, 'org_id = ?', [orgId]);
    const has = (t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
    if (has('holdings')) db.prepare('DELETE FROM holdings WHERE company_id = ? OR investor_id = ?').run(orgId, orgId);
    if (has('board_seats')) db.prepare('DELETE FROM board_seats WHERE company_id = ?').run(orgId);
    for (const t of tablesWith(db, 'org_id')) {
      if (t !== 'orgs') db.prepare(`DELETE FROM ${t} WHERE org_id = ?`).run(orgId);
    }
    db.prepare('DELETE FROM orgs WHERE id = ?').run(orgId);
  })();
}

/** Slug usable as an orgs.id, matching the hand-authored style in the seed file. */
export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'unknown';
}
