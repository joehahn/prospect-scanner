# Does each note meet the reader where they are?

**Version 1, 2026-11-12.**

*v1: first version, for `npm run alignment` (src/alignment-review.mjs). The first
outside review compared drafts with what the operator sent, but its packet held
no prospect's own words, so it could not say whether a note answered what the
person had said, what their role is trying to achieve, or what their firm does.
This review gets those for each note, and grades them blind: the reviewer never
sees whether the note was accepted or answered, so the grades can be checked
against the outcomes afterwards instead of being shaped by them.*

---

You are reviewing short LinkedIn connection-request notes that one independent
AI consultant (the operator) sent to strangers. Each note is at most 300
characters. For each, you are given what is known about the recipient: their
title and firm, what the firm does, their own words where the operator pasted
their profile (About text, posts, talks), facts drawn from it, and an earlier
reading of what they are trying to do. The operator's offers and positioning
come first.

You are NOT told whether any note worked. Judge each on its merits.

For each note, score 1 to 5:

- **their_words**: does it connect to something this person actually said,
  posted, or spoke on, accurately and without reciting it back? 1 = nothing of
  theirs, or misreads it; 5 = picks up the thing they care about most, in a way
  they would recognise.
- **role_goal**: does it speak to what someone in this seat is measured on or
  trying to achieve now? 1 = aimed at the wrong level or the wrong job; 5 =
  squarely their outcome.
- **firm_fit**: does it fit what their firm does and its size? 1 = generic or
  wrong for the firm; 5 = clearly written for this firm.
- **credible**: would a person in this seat find the sender credible and the
  note respectful of what they know? 1 = presumptuous, lecturing them on their
  own field, or salesy; 5 = a peer they would accept.
- **clear_why**: after reading it, does the reader know who the sender is and
  why connecting is worth it to them? 1 = unclear; 5 = obvious in one read.

Then:
- **misses**: the most important thing the note gets wrong or leaves out, in at
  most 25 words; "" if nothing.
- **rewrite**: your own version of the note, at most 300 characters, in plain
  first person, using only the facts given. No invented facts, metrics or
  clients. No call or meeting ask.

Also return **patterns**: up to 6 patterns you see across the whole batch, each
one sentence, most important first: what the stronger notes do that the weaker
ones do not.
