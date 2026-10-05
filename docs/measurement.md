# How it measures itself

[← README](../README.md) · [How it works](how-it-works.md) · [Guardrails](guardrails.md) · [Setup](setup.md)

An AI system that cannot show whether it works is guesswork. This one measures itself
as it runs: whether its judge ranks prospects the way the operator would, what each
search is worth, what every AI call costs, and how much of each draft survives to
sending. The numbers change daily and are shown live on the dashboard; this page says
what is measured and which design choices the measurements support.

## What is measured, and where

**The judge against a baseline.** A simple weighted scoring formula runs alongside the
judge on the same people. Every call the operator makes on a card (write first, would
write, wouldn't) is stored with the judge's rating at the time and the formula's
position. Both are asked one question: over every pair of
someone the operator would write to and someone they would not, how often does each
put the right one first? It is scored separately on *blind* calls, made before the
operator saw the judge's rating, and *forward* calls; and on the measure that matches
daily use: how many of the operator's Write first picks were in each system's top five
that day. The first call after a judgment is the one scored, so a changed mind cannot
flatter the judge.
`npm run judge -- --scoreboard`, or the Scoreboard page. The comparison is ongoing.

**The screen against the judge.** The screen asks the judge's question once on the
cheap model, and only people it rates 2 or higher go on to the judge. Whether that
loses anyone the judge would rate 3+ is checked by screening people the judge has
already rated: `npm run judge -- --screen --eval`. On 80 such people the screen kept
all 10 the judge rated 3+ while sending 52 of the 80 on, at about a sixth of the
judge's cost per person. Ten is a small number, so the check is re-run as judgments
accumulate.

**The daily funnel.** Every day is counted stage by stage: found, screened, judged,
rated 3+, still writable, profile pasted, drafted, draft passed grading, sent,
connection accepted, replied, and set against the operator's two daily goals from config. A second table
counts the same stages by where each person was first found, so a source that finds
many people and rates few can be seen. The Funnel page; no model, no cost.

**Which model drafts, and which grades.** A model change for a step is tested on the
same people before it is made. Drafting: ten people drafted on each of two models and
graded by the grader without knowing which wrote which; the newer model passed 2 of 10
against 1, with fewer recitals and no unsourced claim, at 7% less per draft, and it now
drafts. Grading: a model at a sixth of the grader's cost agreed on every pass/fail
verdict over 20 drafts but missed the one unsourced claim the grader caught, so the
grader stayed.

**What each search is worth.** Each weekly search records what it returned, what
qualified, and what each find became: vetted, rated 4 or 5, written to, replied. A
search that finds nothing twice retires itself, with the reason.
`npm run queries -- --yield`, or the Searches page.

**What everything costs.** Every model call records its model, tokens in and out, and
cost into a `runs` table the moment it is made, along with search credits. The Spend
page shows cumulative cost by day, by step and by model. Cost cannot be reconstructed
after the fact, which is why it is recorded at the moment of every call.

**Replies, kept honest.** A bounce and an accepted connection request are each
recorded, and neither counts as a reply: a bounce says the address was wrong, and an
acceptance says the note was read and the door opened, which is worth knowing about a
channel but is not an answer.

**What the drafter got right.** Each note keeps every draft, every revise instruction,
and the text actually sent, so how much of each draft survived is on record for every
note, and replies are linked to the note that drew them. Drafts alternate between
fixed example notes and examples picked per recipient from what was sent; the
Scoreboard shows, for each, the median share of words changed before sending, how
many went out as drafted, and revisions asked for per sent note.

**Whether a stored fact still holds.** Events found by search keep the source's own
words, and `npm run recheck` re-reads older ones against the source and retracts any
the words do not support, with the reason.

## Design choices the measurements support

- **Examples, not rules.** The drafter learns the operator's voice from their own sent
  notes, never from a rule list: either a fixed hand-picked set, or anchors plus the
  sent notes to the most similar recipients with what was asked and changed on the
  way. The two alternate, and the share of each draft that survives to sending decides
  between them.
- **A judge that learns, measured against a formula.** The judge learns from the
  operator's calls rather than from weights and exemptions, and the formula running
  alongside it is the standard it has to beat.
- **Quotes, not labels.** Every event found by search keeps what the source said, not
  just the event's name, so a card can show the reason to write in the source's own
  words, and `npm run recheck` can test it.
- **Nondeterminism is measured, not ignored.** The same input can get a different
  rating. The judge runs three times and the spread is shown; one run is never treated
  as a measurement.
- **Models are right-sized by step.** Cheap models read pages and extract facts; the
  most capable model drafts. Because cost is recorded per step and per model, a change of
  tier is a measured decision rather than a guess.
