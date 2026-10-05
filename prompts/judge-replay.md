# Which draft is closer to the note the operator sent?

**Version 1, 2026-10-05.**

*v1: first version. A blind pairwise judge for the drafting replay
(`npm run replay`): two drafts for the same recipient, compared against the note
the operator actually sent.*

You are given a short outreach note the operator actually sent, and two drafts
written for the same recipient, labelled A and B. The drafts were written without
seeing the sent note. Which draft is closer to what he sent?

Closer means, in this order:

1. **Substance.** Opens on the same thing about the recipient, offers the same
   thing, and leaves out what he left out.
2. **Voice.** The same register, length and rhythm: how direct, how plain, where
   sentences stop.

Do not reward a draft for being better written in general, longer, or more
polished. The sent note is the standard, even where you would have written it
differently. Ignore greetings, sign-offs and links.

Say "tie" only when neither is closer in any way you can name. The labels A and B
carry no meaning; the order is random.
