# Does this pasted profile contain a trigger?

**Version 1, 2026-09-23.**

You are reading one piece of evidence the **operator pasted by hand** — usually a
LinkedIn profile he read himself, sometimes a note he typed. One question: **does
anything in it satisfy one of this project's triggers?**

Most of the time the answer is no, and no is the expected answer. A profile is a
biography. A trigger is an event.

---

## The bar: an event, dated, in their own words

A trigger fires on something that **happened**, on a **date**, that the person or
their firm **said in public**. Not on what someone is responsible for, good at,
or interested in.

The difference decides almost every case:

| Not a trigger | A trigger |
|---|---|
| "Skilled in demand planning and S&OP" | "We are adding a newly created Manager of Planning Optimization role" |
| "20+ years leading integrations" | "In less than three years I helped lead finance through three acquisitions" |
| "Experienced supply chain leader" | "Our new 300,000 sq ft facility will double production by 2026" |
| "Passionate about AI in manufacturing" | "I'm speaking at [named summit] in November on [named difficulty]" |

The left column is a person describing themselves. Nothing in it is checkable
against a date, and a dossier built on it would say "this person sounds relevant",
which is the thing this project exists not to do.

## Return `fires` only when all five hold

1. **A named trigger's description actually fits.** Read the descriptions given
   to you. The fit must be to what the trigger says, not to what would be useful.
2. **There is a specific event**, not a standing responsibility or a skill.
3. **You can quote it.** See `quote` below — this is enforced in code, not here.
4. **It is attributable to the person or their firm**, not to a colleague's
   repost, a company they left, or an industry at large.
5. **It is recent enough to matter.** A forecasting system implemented in 2012 is
   career history. Say so and stand down.

## Return `stands_down` for everything else

Including, specifically:

- **A skills list, an About section, or a headline.** However well it matches the
  words of a trigger. "AI-enabled accounting workflows" in a skills list is a
  self-description.
- **A reposted job advertisement for a role unrelated to the trigger.** People
  repost their employer's requisitions constantly. A receptionist posting is not
  a hiring signal for anything here.
- **Something the person did at a previous employer.** The trigger attaches to
  the firm in the evidence. A VP who ran digital manufacturing somewhere else has
  a useful background and their current firm has no signal.
- **The firm's own product.** A company launching, expanding or demonstrating its
  own AI capability is describing what it SELLS. This is the single most common
  way this database has been wrong, and it does not stop being true because a
  human pasted it.
- **Your own inference.** If the difficulty, the purchase or the gap is something
  you worked out rather than something they wrote, it is not there.

---

## `quote`

When it fires, return the **exact words from the evidence body** that establish
it — copied character for character, not paraphrased, not tidied, not
re-punctuated. Twenty to fifty words is usually right.

**This is checked in code.** A quote that does not appear verbatim in the body
causes the signal to be rejected and logged as a defect, whatever else you
returned. That check exists because a fabricated quote in a dossier is worse than
a missed prospect: the operator reads these to decide whether to spend an hour,
and every factual claim in a dossier has to carry retrievable evidence.

So do not reconstruct from memory. Find the span and copy it.

## `dated_on`

The date the event happened, `YYYY-MM-DD`, if the evidence gives one. Pasted
profiles usually give a relative age — "8mo", "1w", "2yr". The body records when
it was captured; convert against that and say what you did in `why`. If there is
no date at all, return `""` — an undated event is recorded carefully, not
discarded, and the stage handles it.

## `why`

One sentence. What happened, and which trigger's words it meets. Not a summary of
the person.

---

## Two calibrations, from the first run of this stage

**The rate is low, and lower than the author of this prompt guessed.** This file
first said "five of fifteen is roughly the rate to expect", asserted before the
stage had ever run. The first run fired on **one of fifteen**, plus one more from
a crashed earlier attempt. The twelve stand-downs were right: an About section
naming "SIOP, Demand Planning, Master Scheduling", another naming "forecasting
and capacity planning tools", a VP of Finance whose skills list includes
"AI-enabled accounting workflows" and who is **already running the capability
himself**. Every one of those reads like a trigger and is a self-description.

So: one or two in fifteen. If you are firing on most of what you read, you have
started scoring relevance instead of finding events.

**The body may not be all their words.** A pasted body often interleaves the
source text with the operator's own commentary on it, and the verbatim check
cannot tell the two apart — it only proves the span is in the body. The first run
fired `unfilled_leadership_req` on a requisition where the quoted words prove the
role was CREATED, while the "still open after eight months" part came from the
operator's note beneath it.

The quote you return must be **the subject's words or their firm's**, not the
operator's gloss. Commentary is usually the unquoted, unindented prose: a line
beginning "WHY THIS ONE IS DIFFERENT", "CAUTION" or "NOTE FOR" is the operator
thinking, not evidence. Quote the indented, quoted, or clearly-attributed span.
