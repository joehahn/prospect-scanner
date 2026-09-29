# Was this retraction right?

**Version 1, 2026-09-23.**

A signal was created from a piece of evidence, and later a re-judging pass
retracted it. You are being asked one question about one signal: **was the
retraction correct?**

You are not deciding whether the firm is a good prospect. You are not writing
outreach. You are checking one classification against the trigger's own
definition and the evidence's own words.

---

## The three verdicts

### `retraction_right`

The signal should not have fired in the first place. The usual reasons:

- **The firm's own product is the thing.** An AI-native insurer "demonstrating
  its AI-driven underwriting model", or a company "launching" an AI platform, is
  describing what it SELLS. That is not evidence it is buying, piloting or
  adopting anything, and reading a vendor's launch as a buying signal is the
  single most common way this database has been wrong.
- **The evidence does not say what the trigger requires.** The trigger's
  description is the test. If it names a condition the evidence does not meet,
  the signal was wrong.
- **The trigger's `not:` list excludes it** — those lists were written from real
  mistakes and they are binding.

### `retraction_wrong`

The evidence plainly satisfies the trigger and the signal should be restored.
Be concrete about which words in the evidence meet which part of the
description. A dated appointment of a named person to a named seat, or a live
job posting on an employer's own careers domain, is not a marginal case.

### `wrong_trigger`

The event is real and worth recording, but it was filed under the wrong trigger.
This is the case neither of the other two verdicts covers, and it is common:

- a firm deploying a VENDOR's platform filed as though its own business unit
  built something
- a PE firm's platform acquisition filed as a generic capital event
- an appointment filed as a hiring requisition, or the reverse

Name the trigger it belongs to in `should_be`, chosen from the list of trigger
ids given to you. If no existing trigger fits, say so in `why` and leave
`should_be` empty — inventing one is worse than reporting the gap.

---

## What matters in the trigger definitions

Each trigger carries a `kind`, and the two kinds do different jobs:

- **`kind: work`** names a piece of work. These are what a dossier means when it
  says evidence "names work".
- **`kind: urgency`** says something is in motion without saying what to build.
  It scores the firm and names no capability.

A signal is not wrong merely because it is `urgency` rather than `work`. Judge
it against its own trigger's description.

---

## Two cautions, both from how this database has actually gone wrong

**Undated is not the same as untrue.** A job posting on an employer's careers
domain often carries no publication date. The absence of a date is a reason to
record the signal carefully, not a reason to say the event did not happen. If
the only thing wrong with a signal is that it has no date, the retraction was
wrong and `why` should say the date is missing.

**Do not re-litigate the prospect.** Whether the firm is too big, already
staffed, or a poor fit is decided elsewhere by gates that exist for it. Your
question is narrower: does this evidence meet this trigger's definition?

## Register

`why` is one sentence, in your own words, quoting the part of the evidence or
the definition that decides it. Not a restatement of the retraction reason.
