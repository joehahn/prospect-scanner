# What is wrong with this note?

**Version 2, 2026-09-24.**

You are reading one drafted outreach note, the read it was built from, and the
evidence behind both. Return the flags that apply. **Each flag below encodes a
failure this project has actually hit**, so this is a regression check rather
than an opinion.

Flag only what is there. A clean note returns nothing, and a clean note is the
expected outcome for most of them — a checker that flags everything teaches the
reader to ignore it, which is worse than no checker.

---

## The flags

### `offers-a-meeting`
The ask is a conversation rather than a deliverable. "A second opinion", "a
sounding board", "happy to compare notes", "help thinking it through". A paid
working session IS a deliverable when it says what comes out of it — an hour and
a written page is a thing; "an outside view on priorities" is not.

*Real instance: "No outsider gets to answer that one. But the ordering argument
is easier to have out loud with someone who has no stake in which part of the
operation goes first."*

### `dropped-the-object`
The read's AN HOUR DOES names one or more specific buildable things, and the
note mentions none of them. This has been the single commonest failure.

*Real instance: the read named a variance narrative drafting "why did this line
move" from the ledger; the note talked only about the recipient's conference
talk.*

### `generic`
The sentence meant to be specific could be sent unchanged to anyone in that seat
in a different industry. Swap the firm name and it still reads — which means it
names no decision this person is actually making.

### `recites`
Hands the recipient a fact about themselves: their own posted words, a bullet
off their profile, their firm's announcement. It proves someone read the page,
and reading a page is not a reason to reply.

### `speculative-detail`
Granular technical specifics **asserted as facts about their situation** from
thin evidence — naming a system they run, a cost problem they have, or a use
case they are pursuing, where the dossier does not support it. Worse than being
general, because it asserts more.

*Real instance, from a single hiring announcement: "the model-cost question is
usually the one that waits: which of the candidates is worth its price."*

**A PROPOSAL IS NOT A SPECULATION, AND THIS FLAG COST TWO WASTED ITERATIONS BY
COUNTING THEM AS ONE.** Version 1 fired on the buildable objects the note is
REQUIRED to name — "an evaluation run on your own traffic", "turning technician
write-ups into the line items the rest of the portfolio reports". Those describe
what could be made. They claim nothing about what exists, so there is nothing
for the evidence to support or contradict, and flagging them told the drafter to
stop doing the thing that makes a note worth reading.

The test is the VERB, not the detail:

| not this flag — a proposal | this flag — an assertion |
|---|---|
| "something that flags delivery exposure when a storm is forecast" | "your delivery exposure is unmanaged when storms hit" |
| "an evaluation run on your own traffic" | "your traffic is going to the wrong model" |
| "a view your department heads could query directly" | "your department heads cannot get answers" |

Nor does it cover a general statement about how this kind of work goes —
"submissions and claim files are where that work tends to pay first" is a view
about the domain, not a claim about their firm. Those belong to `generic` if
they are empty, and to nothing if they are not.

Fire this only where a sentence would be FALSE if the guess were wrong.

### `unsourced-claim`
A factual assertion about the recipient or their firm that the evidence does not
carry. Their credentials, their price, their independence are the SENDER's facts
and are not your business here.

### `wrong-register`
The offer is plainly mismatched to the seat — a single fixed-price hour to a director
running three functions at a company with hundreds of millions in revenue, or a
large engagement pitched at a fifty-person firm. Judge against the seat and firm
in front of you.

### `formulaic`
The opening or closing is a template: announcing a count of guesses, or a
construction so generic it would survive being pasted into any other note. You
are shown the other notes in this batch — a phrase shared with them is the
strongest evidence for this flag.

---

## For each flag

`quote` the words that trigger it, from the note, verbatim. `why` in one
sentence. If you cannot quote it, you are inferring a defect rather than finding
one, and it does not go in.

`verdict`: "send" if nothing material is wrong, "fix" otherwise. A note with
only a mild `recites` on a closing line is still "send".
