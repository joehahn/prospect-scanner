# Outside review of the whole system

**Version 1, 2026-11-12.**

*v1: first version. The operator asked for the system to be reviewed by models
from other makers, quarterly, because a run of small tweaks may have moved it
away from optimal and its own builder (a Claude model) is anchored on its own
choices. Each reviewer gets the same packet and these instructions. Their
suggestions are not adopted as given: a change goes in only if it removes
something, or if a replay or the outcome numbers show a gain.*

---

You are reviewing a prospect-discovery and outreach-drafting system that one
independent AI consultant (the operator) uses to find clients. It was built and
is maintained by a different AI model, which may have been anchored by its own
earlier choices. Your job is an independent, critical read. You are not being
asked to be agreeable.

The packet below holds:
- how the system works (docs);
- its prompts and configuration, including the operator's positioning, offers
  and targets;
- the header comment of every source file, which states what the file does and why;
- the funnel and cost numbers;
- recent outreach: each note as drafted, as the operator actually sent it,
  and what happened.

The operator sends every message by hand, and nothing is automated on LinkedIn.
That is a fixed constraint, not something to review.

Answer these, using the packet's own evidence, and cite it (a file, a prompt
section, a number, an outreach id):

1. **Discovery.** Is it finding people who can buy and have a reason to buy
   now, or people who are merely interesting? Which sources, targets or gates
   look wasteful or wrong? What is missing?
2. **Positioning and offers.** Given who replied and who didn't, do the offers
   and the way the operator is described fit the people being written to? Is
   anything in the positioning working against him?
3. **Drafting.** Compare what was drafted with what he sent. What does he
   consistently change? Which drafting rules conflict with each other or with
   what he sends? Which rules could be deleted? Treat connection-request notes,
   follow-ups after an accept, emails and InMails separately where they differ.
4. **Judging and grading.** Are the ratings and grades measuring the right
   thing? Any sign that the system optimises a proxy instead of replies?
5. **Models and cost.** Is each stage on the cheapest model that does its job?
   Where is money or the operator's time spent for little return? The
   operator's time per note is his largest cost.
6. **Inconsistencies.** Places where docs, prompts, config and code disagree.
7. **Drift.** Signs that frequent small revisions have made things worse or
   more tangled.

Write a report, at most about 2,500 words, in this form:

## Top findings
Up to 10, most important first. For each: what is wrong, the evidence, the
change you propose, how to test it cheaply before adopting it, and the effect
you expect.

## Delete list
Rules, stages, sources or config that could be removed with little or no loss,
each with one line of why.

## Where you are unsure
What the packet could not tell you, and what data would settle it.

Be concrete and blunt. Do not restate the packet. Do not praise.
