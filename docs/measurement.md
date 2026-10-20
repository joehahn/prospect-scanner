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
note, and replies are linked to the note that drew them. The Scoreboard compares
drafts learned from a fixed set of example notes with drafts learned from the
operator's latest sent notes and what they were written from: for each, the median
share of words changed before sending, how many went out as drafted, and revisions
asked for per sent note. On 56 and 30 sent notes the two tie (7% and 10% of words
changed, about one revision per note). Drafting uses the latest notes: the operator
judged their drafts better, and they follow his wording as it changes.
First messages after an accepted connection have their own shape and their own
examples, so they get their own row and stay out of that comparison.

**Whether the grader predicts the rewrites.** The grader's sixth question, whether
the approach fits the person, is advisory until it earns more. The Scoreboard splits
sent drafts by whether the grader flagged them, once on its rules and once on the
approach, and shows the median share of words the operator changed and how many he
rewrote. If flagged drafts are the rewritten ones, a flag is worth acting on before
the operator sees the draft; if the rows look alike, it is noise.

**Which examples teach the drafter best, tested offline first.** `npm run replay`
redrafts recent sent notes with each candidate set of examples, using only notes sent
before the one replayed and keeping that note out of its own dossier. A grader model
compares each pair of redrafts against what was actually sent, blind and in both
orders, counting a split as a tie. Over 30 notes, four sets (the fixed notes, notes
picked for a similar recipient, the operator's sentence edits, and the latest notes
with their inputs) came out within chance of one another. The test has a known tilt:
every sent note began as a draft from the fixed set, so redrafts from that set start
closer to it. It can show a new set is worse; it cannot show one is better. That is
decided live, on how much the operator changes each draft.

**Whether a stored fact still holds.** Events found by search keep the source's own
words, and `npm run recheck` re-reads older ones against the source and retracts any
the words do not support, with the reason.

## Design choices the measurements support

- **Examples, not rules.** The drafter learns the operator's voice from their own sent
  notes, never from a rule list: the latest sent notes, with what each was written
  from and what was asked and changed on the way. A fixed hand-picked set measured
  level with them; the operator preferred the drafts from his latest notes.
- **A judge that learns, measured against a formula.** The judge learns from the
  operator's calls rather than from weights and exemptions, and the formula running
  alongside it is the standard it has to beat.
- **The cheapest judge that agrees with the operator.** On 150 people the operator
  had already decided about (75 write, 75 skip), Claude Sonnet agreed with him 83-84%
  of the time and with itself on 96% of write/skip calls. MiniMax M3 agreed with him
  86-87% and with itself 94%, at a third of Sonnet's batched price per call, so it
  judges. Haiku 5.5, GPT-5.6 Luna and DeepSeek V4.1 Flash tied Sonnet within noise;
  GLM-5.3 and Qwen 3.8 fell well short. The host matters as much as the model: the
  same MiniMax id on a host serving a more compressed copy reasoned a fifth as much
  and agreed with him 78%, so the judge is pinned to the host that was measured.
  That host no longer enforces an answer's schema, so the schema goes in the request
  and each answer is checked against it here. Re-measured that way on the same 149
  people: 82.6% agreement, and it still ranked his writes above his skips better than
  Sonnet (0.90 against 0.87-0.89). The same model on a host that does enforce the
  schema reasoned a fifth as much and agreed 81.9%, ranking at 0.86.
  Calls through OpenRouter go only to hosts that keep and train on nothing.
- **Quotes, not labels.** Every event found by search keeps what the source said, not
  just the event's name, so a card can show the reason to write in the source's own
  words, and `npm run recheck` can test it.
- **Nondeterminism is measured, not ignored.** The same input can get a different
  rating. The judge runs three times and the spread is shown; one run is never treated
  as a measurement.
- **Models are right-sized by step.** Cheap models read pages and extract facts; the
  most capable model drafts. Because cost is recorded per step and per model, a change of
  tier is a measured decision rather than a guess.
