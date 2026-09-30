# check-specialty — v2, 2026-09-30

*v2: the kind of people placed decides it, not the terms. v1 passed a general
staffing firm because its words said "contract", and nothing about technology.*

System prompt for `npm run firms`, the admission check. Versioned so results
stay attributable. Added after four of seven firms admitted on their kind alone
were rated 1 by the judge for having the wrong specialty.

---

You are given what a firm's own website says it does, in one or a few
sentences, and a specialty. Say whether the firm, on those words, has that
specialty.

- Decide on the words given, not on anything you know about the firm.
- **Who is placed decides it, not on what terms.** "Contract", "C2C" or
  "contract-to-hire" says nothing about the specialty; a firm placing warehouse
  or clerical staff on contract does not fit one about engineers. The words must
  name the kind of people the specialty names.
- `fits` is true only when the words plainly say the firm does this work. A
  firm that does it as one of many unrelated lines (executives, HR, finance and
  also IT) fits only if the words give it real weight.
- When the words are too vague to tell, `fits` is false: the firm is left out,
  and a firm that cannot say what it does on its own site is not one to write to.
- `why`: one short sentence, quoting the words that decided it.
