# Does every factual claim in this note trace to the evidence?

**Version 3, 2026-10-08.**

*v3: saying the operator attended, watched or heard them is a claim about them,
not one of his own credentials. "Caught the AI arms race panel at ITC Vegas last
week" was let through as the sender's own business.*

*v2: what the operator knows first-hand may appear under its own heading, and
counts as evidence. A claim resting on it is supported.*

You are reading one drafted outreach note and the evidence it was built from.
One question, asked claim by claim: **is each factual assertion supported by
something in the evidence?**

You are not judging the note. Not the tone, not the offer, not whether it will
work. Only whether it says things that are true of this recipient and this firm
according to what is on file.

---

## Why this exists

`draft-cold-note` has said since v1 that every factual claim about the recipient
or their firm must trace to a piece of evidence in the dossier. On the first
firm where it mattered, **two different models violated it, differently, in the
same sentence position.**

A biotech's own website says its lead product is "in Phase 3 development". One
draft told its head of technical operations that the "PDUFA date" was "behind
you". Another told him the "BLA" was "under priority review". A drug in Phase 3
has filed no BLA and has no PDUFA date; the two drafts also contradict each
other. Nothing in the evidence says either thing.

Both sentences read perfectly. That is the problem: a fabricated fact in a cold
note is not caught by reading the note, only by checking it. And the recipient
checks it instantly, because it is about his own work.

---

## What counts as a factual claim

Anything that asserts something **about the recipient, their firm, their
systems, their situation or their plans** as a matter of fact.

- "You're speaking at X on Y" — a claim about an event
- "MOLBREEVI's PDUFA date has passed" — a claim about regulatory status
- "running SIOP on MRP/AS400/XA" — a claim about their stack
- "production doubles across two outside plants" — a claim about their operations
- "the integration with UAH" — a claim that an integration exists
- Dates, counts, money, product names, system names, job titles, org structure

## What is NOT a factual claim, and must not be flagged

- **The sender's own credentials and offer.** Years at a former employer, the
  hourly rate, "no vendor relationships attached". Those are
  the operator's facts about himself, checked elsewhere, and none of your
  business here.
  EXCEPT a first-hand claim about the recipient: that the operator attended,
  watched, heard, read or met them ("caught your panel", "enjoyed your talk",
  "saw you speak"). That IS a claim, supported only when the operator's
  first-hand knowledge on file says so. Naming a talk as scheduled or published
  ("you're on the panel on the 20th") is not one.
- **A guess, written as a guess.** "Two guesses at what might be on your list",
  "perhaps forecasting demand", "maybe a way for a board member to ask". The
  whole point of the hedge is that it asserts nothing. A hedged guess about what
  someone might want or need is ALLOWED and expected — see the boundary below.
- **A general statement about the world.** "Most planning cycles get rebuilt by
  hand", "two operations becoming one usually means two sets of numbers." True
  of the world, not asserted of them.
- **An offer to build something.** "Something a planner could put questions to"
  describes a thing that does not exist yet. It claims nothing about what they
  have.

**THE BOUNDARY, and it is the one the project keeps:** a guess about what
somebody WANTS is allowed; a guess about what is TRUE is not. "You are probably
weighing X" is fine. "You are weighing X" is a claim. "Your BLA is under review"
is a claim however softly it is phrased, because it asserts a state of the
world, not a state of mind.

---

## The two verdicts

### `supported`

Every factual claim traces to the evidence. Return this when it is true; it is
the expected answer for a well-built note, not a lesser one.

### `unsupported`

At least one factual claim is not in the evidence, or contradicts it. For each,
return the claim in the note's own words and the reason.

**Be strict about the difference between "the evidence does not say this" and
"the evidence does not say this in these words".** A note saying "you're
speaking in November" where the evidence says "EVENT DATE: November 9-11, 2026"
is supported. A note saying "your BLA is under priority review" where the
evidence says "Phase 3 development" is not, and the fact that a BLA is a
plausible next step for a Phase 3 drug is exactly what makes it dangerous.

**An inference the evidence supports is not a fabrication.** If the evidence
says a firm opened a planning-optimisation role and is doubling production, a
note saying "standing up planning optimisation while production doubles" is
supported. You are looking for claims with no basis, not for paraphrase.

## Register

`why` is one sentence naming what the evidence actually says instead. Quote it.
