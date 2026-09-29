# What has the operator corrected often enough to be a rule?

**Version 2, 2026-09-25.** v2 splits the output in two: a correction can be about
how a note is WORDED or about WHICH OFFER it makes, and those are decided by
different stages. See "The two kinds" below.

You are reading two kinds of correction, both accumulated over real notes:

- **Revise instructions** — what he typed when a draft was wrong.
- **Draft-versus-sent diffs** — what he changed with his own hands before
  sending. These are the stronger evidence: an instruction says what he noticed,
  an edit says what he actually could not leave alone.

One question: **which of these has happened often enough to be a rule?**

---

## THE TWO KINDS, and getting this wrong wastes the correction entirely

Every rule you propose carries a `kind`. It decides which file the rule is
appended to and therefore which stage ever sees it.

**`kind: "voice"` — how the note is written.** Register, claim strength, length,
where the credential sits, what is never said, the shape of the ask. These go to
`prompts/voice.md`, which the DRAFTING stage loads.

**`kind: "read"` — which offer the note should make, and how to work it out.**
Which of his services fits this person, what evidence to reason from, what the
obvious next step is for someone in that situation, which pitch is a reach. These
go to `prompts/read-rules.md`, which the READ stage loads — the stage that picks
the offer *before a word is drafted*.

### Why the split exists, in his own words

*Added 2026-09-25 after the corrections below were all filed as voice rules and
every one of them was ignored, because the stage that needed them never reads the
voice file.*

These are `read`, not `voice`:

> "Emily's LinkedIn profile summary is very detailed about her work and she has
> lots of LI updates too. use that to figure out what is of greatest importance
> to her, which of that can be accelerated or enhanced by ai, then figure out
> what i sell/deliver that speaks to that"

> "prospect's LI feed is mostly about hiring, as is her conference talk, so
> revise note to discuss maybe using AI to harvest applicants resume + blogs +
> whitepapers + socials at scale"

> "i like the RFP angle here, but the RFP process can be very slow. revise note
> to indicate that I can help with his immediate agentic use cases now, in
> parallel"

None of those is about wording. Each says *the pitch was wrong and here is how
to have chosen better*. The same class of error had been corrected by hand four
times and the system retained none of it.

These are `voice`:

> "cut the last sentence and make the opening one line shorter"

> "Restore the spine: 'What I sell is a working session' — not 'I sell a working
> session'."

### The test

Ask: **would obeying this change which service he offers, or only how the offer
is phrased?** Changes the service, the evidence it rests on, or the argument for
why it fits — `read`. Changes only the words — `voice`.

When a correction does both, split it into two rules. A single rule filed under
one kind loses the half that belonged to the other.

A `read` rule is still a PRINCIPLE, never a pitch. "Offer model right-sizing to
CIOs" is a phrase to copy, and it is how one fallback offer reached four of five
consecutive notes. "Reason from what the person's own output is mostly about,
not from the most technically interesting thing on file" is a rule.

---

## FIRST, THE RECIPE — the structure his sent notes already share

Before looking for individual rules, read the SENT notes as a set and ask
whether they follow a common sequence. They usually do, and the operator will
not have written it down, because a structure you use every time stops looking
like a choice.

Derived once by hand from thirty-three of them, the sequence was: their
situation stated as a fact, often in their own words; ONE flat line naming a
capability that matches it; the credential with the present affiliation in the
same breath; what he sells, near enough unchanged note to note; a soft ask and
the link. Five beats, fixed order, nothing between them.

**That structure is worth more than any single rule**, because it governs every
note rather than one sentence, and because it is the thing a drafter gets wrong
in a way no individual rule catches — a note can obey twenty rules and still put
an observation where the claim belongs.

So: if the sent notes share a sequence, propose it as a rule with
`is_recipe: true`, the beats in order, and one real sentence from a real note
illustrating each. Quote his sentences, never invent illustrations — the whole
value is that these are what he actually writes.

If the notes do NOT share a sequence, say so and propose nothing. A recipe read
off four notes that happen to rhyme would be a worse default than none, and it
would be followed every time.

**Re-derive rather than defend.** Where a recipe is already in the voice file and
the recent notes no longer match it, that is the finding: say which beat moved
and quote the notes that moved it.

## The bar is recurrence, and it is the whole discipline

A single correction is a fact about one note. A pattern across several is a fact
about his voice. **Do not propose a rule you have seen once.** Say how many
times you saw it and quote each instance — the count is the argument, and a rule
offered without one is an opinion with a citation stapled to it.

Three instances is comfortable. Two is worth proposing if they are unmistakably
the same move in different notes. One is an observation; put it in `noticed_once`
and let it wait for a second sighting.

## A RULE IS A PRINCIPLE, NEVER A PHRASE

*This is the failure that motivated this stage, and it is not hypothetical.*

He edited "what is on your list" to "what **might** be on your to-do list", and
"if either is live" to "if that or **something else** is of interest". Those were
written into his voice file as sentence patterns. The next batch of six notes
came back with **five identical middle paragraphs** — "Two guesses at what might
be on your list" — and five identical closings. Each was fine alone. Together
they were a mail merge, which is the one thing a cold note cannot look like.

So state the QUALITY the sentence should have, never the words that achieved it:

- **Wrong:** 'Open with "Two guesses at what might be on your list".'
- **Right:** 'Carry the uncertainty on each item rather than once at the top of
  the paragraph, and vary how — on the verb, in a conditional, as an aside, or
  by handing the judgment back to them. Counting the guesses out loud is a tell.'

If your proposed rule contains a sentence a drafter could copy, rewrite it.

## What to look for

Corrections cluster. Common shapes, from a project that has already found some:

- **Register** — a word or construction he always removes or always reaches for.
- **Claim strength** — asserting what he would hedge, or hedging what he states.
- **Whose frame** — describing what the sender wants rather than what the
  recipient is dealing with.
- **What is never said** — a subject, a compliment or a framing he strips every
  time.
- **Shape** — length, paragraph count, where a credential or an ask belongs.

## What is NOT a rule

- **A fact about one prospect.** "Do not tell this CFO his ERP is behind" is
  about that person. The rule underneath it might be "never characterise a
  recipient's systems as deficient", and that is the one to propose.
- **A correction of a defect.** If he told you a session title was wrong or a
  date was in the past, that is a data problem someone has already fixed, not a
  preference about writing.
- **Something already in the voice file.** You are given it. A rule that is
  already there, however well put, wastes his attention; if the existing one was
  ignored, say THAT instead — the fix is a control, not a second copy of a rule.

## For each rule

`rule` — the principle, in the register of the voice file: direct, addressed to
whoever drafts next, no hedging about whether it matters.
`why` — one sentence on what goes wrong without it.
`seen` — how many times, and quote each one in `instances`.
`confidence` — "strong" for three or more unmistakable instances, "worth asking"
for two or for a pattern you can see but would not bet on.
`kind` — "voice" or "read", by the test above. If you are unsure, ask which file
the rule would have to be in for it to have prevented the correction.

Propose few. A rules file that grows by five rules a week stops being read, and
the rules that matter get buried under the ones that were merely true once. This
applies to both files independently — the split is not licence to propose twice
as much.
