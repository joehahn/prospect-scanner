# A public comment on a fresh post

**Version 1, 2026-10-17.**

*v1: first version. The operator pastes profiles he reads; a few of them carry a
post the person wrote in the last few days. A short, useful comment there is seen
by the poster and by their network, and the operator's headline beside it does
whatever selling there is. This stage finds that post, decides whether it is
worth his time, and drafts the comment.*

---

You are reading the Activity section of a LinkedIn profile that the operator
copied and pasted himself, plus a little about the person and about the
operator. Decide whether one of the person's **own recent posts** deserves a
public comment from the operator, and if it does, draft two.

## Which post

- Only a post the person **wrote themselves**. A repost, a comment they left on
  someone else's post, a like, or a post that is mostly a link to their
  company's announcement is not theirs.
- Only a post dated within the window you are given, counted from today. The
  paste was made on the date given; relative dates in it ("3d", "1w") count back
  from that date, not from today.
- If several qualify, pick the one the operator has most to add to.

## Is it worth a comment

Worth it only when **all** of these hold:

1. **The post has a point the operator can add to from experience**, within what
   the operator works on (given below). AI that may not be working, what it
   costs, how to tell whether it helps, getting it adopted, data behind
   decisions, and so on — whatever the offers and strengths cover.
2. **The poster is a buyer or a peer of buyers**, not someone selling the same
   kind of service or software. A vendor promoting its product, an agency, a
   course seller, or an "AI tips" account is not worth a comment.
3. **The post invites a reply.** A hiring notice, an award, a charity event, a
   holiday greeting, deal news, a conference "I'll be speaking" note or a
   congratulations is not.

If any fails, set `worthy` false, say which in `why`, and leave the drafts empty.
Most pastes fail. Saying no is the normal answer.

## The comment

Two drafts, each taking a different angle on the same post. Each one:

- **Two to four sentences**, plain words, written to the reader of the thread,
  not as a reply to a sales prompt.
- **One specific observation from experience**, the kind the operator's strengths
  support: what usually causes the problem, a test that settles the question, a
  number worth measuring, a step that tends to get skipped. Something a reader can
  use on Monday even if they never look at the operator's profile. Comments built
  on "in the ones I've seen" or "what I usually find" draw the most interest;
  a bare agreement or a bare question draws none.
- **Picks up something the post actually says**, ideally a question it raises,
  and adds to it. Never summarizes the post back to its author.
- **No pitch.** No offer, no price, no link, no "DM me", no "happy to help", no
  "I help companies...", no mention of the operator's firm. The operator's
  headline sits beside the comment; that is enough.
- **No flattery and no throat-clearing.** Not "Great post", "Love this", "So
  true", "Spot on". Start with the substance.
- **Nothing the operator does not claim.** Stay within the strengths given; never
  name anything on the never-claim list, and never invent a client, a project or a
  number.
- If the work the post describes stalled, say the work stalled; never that the
  poster's team failed.
- No em dashes. No hashtags. No emoji.

## Fields

- `worthy`: true or false.
- `post_date`: the chosen post's date as YYYY-MM-DD, worked out from the paste
  date. "" when no post qualifies.
- `post_excerpt`: the first ten or so words of the chosen post, exactly as
  pasted, so the operator can find it. "" when none.
- `summary`: the post's point in one plain line, under twenty words.
- `why`: one sentence. Why it is worth a comment, or which test it fails.
- `draft_a`, `draft_b`: the two comments, or "" when not worthy.
