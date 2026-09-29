# <Your name>'s voice — template

Copy to `prompts/voice.md` and fill in. The real file is gitignored: it is the
one artifact that would let a stranger write as you, and it is the thing that
takes actual work to build.

**Do not write this from imagination.** Derive it from notes you have really
sent. Get five or ten of them into the database first (`npm run lead -- sent
--file sent.txt`), read them side by side, and write down what they have in
common. A voice file invented in the abstract produces drafts that sound like a
generic consultant, which is the problem you are trying to solve.

---

## Structure of a strong note

Number the moves your best notes actually make, in order. Name your best one and
your worst one so the contrast is on the page. A useful list looks like:

1. **Salutation.** The exact form you use, and the ones you never use.
2. **The thing on their desk.** One sentence about *their* situation, not yours.
3. **Any disclaimer you always include** (e.g. that you are not job hunting).
4. **Your credential, and what you did with it.** The same phrase every time.
5. **One proof point — the credential, not the measurement.** Where you worked
   and what you did there. A benchmark figure persuades only a reader who already
   has the context to place it, and a stranger will not build that context on the
   strength of a cold note. Keep numbers for the second conversation.
6. **The offer, named and priced.** Plain noun, plain price, plain turnaround.
   The price and the turnaround are the only figures a cold note should carry.
7. **A line of deference** — what they know better than you do.
8. **Your anti-sell, as structure rather than performance.** State the
   arrangement — no vendor relationships, one service, a fixed price — and let
   the reader draw the conclusion. Lines that dramatise disinterest ("sometimes
   I tell people not to buy") are recognisable sales technique and cost you the
   trust they are reaching for.
9. **The use-moment**, as a scene rather than a benefit.
10. **Your close**, verbatim.

> **A warning about how you build this file.** Write down what distinguishes the
> notes that got ANSWERED, not the ones you judged strongest. Those are different
> lists, and at the volume a solo practice generates they may not overlap at all.
> This project's own first voice file named a numbered proof point and a
> theatrical anti-sell as the marks of its best notes; both came from a corpus of
> ten notes with one reply, and the operator later rejected both on sight. A
> voice file describes your habits. It is not evidence that a habit works, and it
> should say so where you can see it.

## Register

- Any grammatical tic that is recognisably yours. Keep it; do not let a model
  correct it into standard business English.
- Sentence length, paragraph length, bullets or no bullets.
- Words you never use. Check your sent notes for absences, not just presences.
- Contractions: yes or no.

## Hard prohibitions

List the mistakes you have already made and do not intend to repeat. Be specific
enough that a model can check a draft against each one:

- A closing move that does not work for you (e.g. a question whose answer changes
  nothing, or an ask for a meeting).
- Anything in `operator.never_claim` in `config/me.yml`.
- Rapport moves you dislike (shared school, mutual connections, flattery).
- Facts you keep for a second conversation, never a first.
- Any factual error you have actually made — misspelling a firm's name, for
  instance. Naming it here is how it stops happening.

## What separates the strong notes from the weak ones

Write the honest comparison. Which of your notes got answered, which did not,
and what is structurally different about them? End with a test a draft must
pass. A good one:

> A note is not ready if it could be sent to a different firm by changing one
> proper noun.
