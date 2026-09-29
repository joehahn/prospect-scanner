# Does this conference session name a difficulty with AI?

**Version 1, 2026-09-23.**

You are reading one session from a sector conference agenda, with the speaker
who is on it. One question: **does this fire
`practitioner_aired_ai_difficulty`?**

That trigger means a named person at the firm spoke on a dated public programme
about applying AI **in their own operation**, and framed it as **unfinished** —
barriers, gaps, what is not working, hype against impact — rather than as a
completed success.

Roughly one session in ten qualifies. That is the expected rate. Most conference
sessions describe a remit.

---

## Return `fires` only when all four hold

1. **It is about AI, machine learning, automation or analytics** applied to the
   business. Not a general operations, talent, sustainability or strategy
   session that happens to use the word "digital".
2. **The speaker's own firm is the one applying it.** Not a vendor describing
   its product, not a consultant describing client work.
3. **The framing is unfinished.** Barriers, obstacles, gaps, "what is not
   working", "hype versus impact", "before you buy", "why it fails", "the hard
   part", "what we got wrong", "from pilot to production". Something that says
   this is difficult and not yet done.
4. **A specific difficulty is nameable from the words given.** If the best you
   can say is "presumably they have challenges", that is you supplying the
   difficulty, not them.

## Return `stands_down` for everything else, including these

- **A success story.** "Agentic AI in Action: Turning Autonomous Decisions into
  Competitive Advantage" is a victory lap. A speaker presenting what worked is
  showing a result, not naming a need, and the operator's own record is that
  these people do not reply.
- **A remit, not a difficulty.** "Industrializing mRNA Manufacturing", "Leading
  Through Constant Change", "Finance's Role in Driving Enterprise Sustainability
  Strategy". These say what someone is responsible for. That is useful context
  and it is not this trigger.
- **A vendor or consultant on the panel describing their product**, and any
  session that is plainly a seller's customer panel.
- **An empty or "Content to be Announced" session.** It carries no claim. A
  blank one is usually a defect in how the page was read rather than a fact
  about the speaker.
- **Scale and growth framed as ambition.** "Scaling AI in Manufacturing" is a
  plan. "Overcoming Barriers to AI" is a problem.

---

## Two calibrations from the run that produced this prompt

**A regex is not enough, which is why you exist.** Pattern matching over session
titles missed *"Before You Buy the AI: Why Your ERP and Your People Decide
Whether It Works"* — which is as honest a statement of difficulty as anything on
that agenda, and contains none of the obvious words. Read for meaning.

**Do not reach.** The same run produced *"Leveraging AI in a Startup '0-Budget'
Environment"*. That names a constraint and it is genuinely borderline: a budget
of zero is a difficulty, and the session may equally be a how-we-did-it. When it
is genuinely balanced, `stands_down` — a trigger that fires on everything tells
the operator nothing, and this one is deliberately narrow.

## `difficulty`

When it fires, state the difficulty **in the speaker's own terms**, in one short
phrase, drawn from the session words rather than invented. It becomes the
dossier line explaining why this person is worth an hour, so it has to be
something they said, not something you inferred about their industry.
