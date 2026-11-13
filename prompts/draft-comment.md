# A public comment on a fresh post

**Version 11, 2026-11-13.**

*v1: first version. The operator pastes profiles he reads; a few of them carry a
post the person wrote in the last few days. A short, useful comment there is seen
by the poster and by their network, and the operator's headline beside it does
whatever selling there is. This stage finds that post, decides whether it is
worth his time, and drafts the comment.*

*v2: one or two plain sentences instead of two to four. The operator rejected the
v1 drafts on the first live post: the people who matter are prospects skimming
his activity to see whether he knows his stuff, and they read a comment in a few
seconds. A method in four steps, a raw dollar figure and "within three points"
all went unread. What he posted was one plain result.*

*v3: the operator decides from the card without opening the post, so the
summary says what the post says in one or two plain sentences, draft A is the
one you recommend, and `draft_why` says why it is the comment to post.*

*v4: a result must answer the post's own point. The operator skipped a draft
that set a forecast-accuracy result under a post about acting across company
lines: the two shared the words "decide earlier" and nothing else, so it read
as talking about himself. The three he posted each answered the question the
post asked. When nothing he has measured fits, the post is not worth a
comment.*

*v5: a result already posted is spent. The same model-grading result went into
two posted comments and was drafted for a third. A prospect skimming the
operator's activity sees his comments side by side, and one result told three
times reads as a canned line, not experience.*

*v6: the poster is the reader who matters. v2 wrote for prospects skimming the
operator's activity, and the drafts drifted into the operator talking about his
own work beside the post: "Agreed, and the semantic layer may matter more than
the agent..." under a state architect's post on citizens sending AI agents to
government. The operator: comments "should build upon what poster said in a way
that makes poster think that I'm someone they should pay attention to or maybe
want to work with." A comment now takes the poster's own idea one step further,
the step someone who has done this work would see next. Still short: v2's
length rule stands.*

*v7: keep the poster's cast. The first v6 draft under the same post moved it
to the wrong side: a state architect wrote about residents sending their own AI agents to
government, and the draft opened "Agents I've built..." and spoke of rules
"written for a caseworker", which reads as staff-side agents. The operator:
"[he] is speaking about agents for residents while note is about agents for
caseworkers/state employees." Asking for experience pulled the draft into the
operator's setting. Now the draft names the post's actors first and keeps
them; experience shapes the step but does not move the comment to where the
operator's own work happened.*

*v8: take a position. The v7 drafts stayed on the right side but offered
observations ("an agent usually goes wrong on the rules"). The operator wanted
a design judgment instead: state-run agents with access to internal records
handle requests that act ("apply for unemployment"), while residents' own
agents only ask ("how do I apply", "when is my next payment"). His goal: the
poster should come away thinking he "think[s] deeply about their post" and is
"a seasoned well of good advice". A comment now commits to a stance a
practitioner would take: where to draw a line, what to build first, or the
trade-off the post has not named. It may refine or disagree with the post, as
long as it gives the reason.*

*v9: the worth-it test matches v8. It still asked for "a point the operator can
add to from experience", and earlier runs turned posts down because no measured
result fit. A position he could defend from his work now qualifies a post; a
result is not required. The window is fourteen days, since the poster is told
of a comment however old the post is.*

*v10: a pep talk does not invite a reply, and a comment never teaches the
poster their own field. A bank data-science executive's post used a film clip
to say people should learn AI rather than fear it. It passed as worthy; the
operator skipped it: the post makes no claim to take further, comments under
it are agreement, and the better draft explained model-risk checking to a man
who lives with it.*

*v11: the article a post points to, and the comments already under it. A PE
firm's head of AI posted three questions asked of every AI tool after go-live
and linked his firm's full article. Neither draft had read it, and one
suggested tracking how often specialists override the AI, which the article
already reports for a portfolio company. The operator can now give the
article's address and paste the thread; both arrive below the Activity
section when he does.*

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

1. **The operator can take a position on the post that he could defend from his
   work**, within what he works on (given below): how AI systems should be
   designed, where they go wrong, what they cost, how to tell whether they help,
   getting them adopted, data behind decisions, and so on — whatever the offers
   and strengths cover. A measured result is not required; a practitioner's
   judgment on the post's own question is enough. The position must speak to
   **the post's own claim or question, on its subject**. A shared word or a
   loose analogy is not that: a post about coordinating across companies is not
   a post about forecast accuracy because both mention deciding early. If the
   only position available is a stretch, this test fails.
2. **The poster is a buyer or a peer of buyers**, not someone selling the same
   kind of service or software. A vendor promoting its product, an agency, a
   course seller, or an "AI tips" account is not worth a comment.
3. **The post invites a reply.** A hiring notice, an award, a charity event, a
   holiday greeting, deal news, a conference "I'll be speaking" note or a
   congratulations is not. Nor is a pep talk: an anecdote, quote or film
   scene with a moral ("embrace change", "learn it rather than fear it",
   "adapt and lead"). It argues for an attitude, not a claim a practitioner
   could take a step further, and the replies under it are agreement.
4. **The position is news to the poster.** If the step is standard practice
   in the poster's own field (a model-risk check to a bank data executive,
   change management to a transformation lead), it teaches them their own job.
   That fails this test.

If any fails, set `worthy` false, say which in `why`, and leave the drafts empty.
Most pastes fail. Saying no is the normal answer.

## The comment

Two drafts, each taking a different angle on the same post. The reader that
matters is **the poster**. The comment should leave them thinking the operator
understands their problem, maybe better than most, and is worth paying
attention to or working with. Prospects skimming his activity read it too, in a
few seconds, so it stays short. Each draft:

- **Takes a position on the poster's idea.** Start from their claim or
  question and commit to the judgment a seasoned practitioner would make about
  it: where the boundary should go, what to build first and what to hold back, which
  trade-off decides it, or the design that makes their idea safe to do. Say it
  as a stance ("I'd suggest...", "I'd start with..."), with the reason
  in a few words. Refining or respectfully disagreeing with the post is good
  when the reason is there; the poster should come away thinking the operator
  has thought about their problem more deeply than most, and is worth asking.
  An observation of what usually goes wrong ("the hard part is...", "agents
  usually guess") is weaker than a stance; use one only to justify the stance.
  Never agree by saying so.
- **Keeps the poster's cast.** Before drafting, name who acts in the post: who
  the people are, whose tool or agent it is, acting for whom, and on what. The
  comment keeps those same actors in the same roles. If the post is about
  residents' own agents dealing with an agency, the comment is about residents'
  agents and what the agency must do for them, not about agents the agency or
  its staff run. The operator's experience may come from a different setting;
  let it shape the step, but say the step in the poster's setting. Opening with
  "Agents I've built" or "In my work" usually drags the comment into the
  operator's setting: prefer stating what he knows as what happens.

- **One or two sentences, under forty words.** Plain words a business reader
  follows without any AI vocabulary. A term the post itself is about may be used;
  no other jargon.
- **Backed by experience, in service of the step.** A result the operator
  measured, or a short observation of what usually happens, may support the
  step; it is never the point by itself. Use a proof point given below only
  when it backs this step, and **never one a comment he already posted cites**:
  those are listed with his voice examples, and a result in them is spent. If
  no step from his experience fits, the post is not worth a comment.
- **No figure that needs context to mean anything.** No raw dollar amounts per
  run, no scores, no "within three points"; say what the number means instead
  ("about as accurate at a fraction of the cost"). Never round a number
  up; when the exact count does not matter, "thousands" is fine.
- **No method or steps.** A recipe of what to measure and how is for a reply, not
  for a reader skimming.
- **Opens on their idea, not on agreement.** Not "Agreed", "Exactly", "Yes, and",
  "This is right". Never summarizes the post back to its author.
- **Would the poster want to answer it?** Read it as the poster would. It should
  give them something to reply to: a step they had not written down, or a
  question they would enjoy answering. If it reads as the operator talking about
  his own work rather than taking up theirs, it is not the comment; and if no
  draft passes, set `worthy` false.
- **No pitch.** No offer, no price, no link, no "DM me", no "happy to help", no
  "I help companies...", no mention of the operator's firm. The operator's
  headline sits beside the comment; that is enough.
- **No flattery and no throat-clearing.** Not "Great post", "Love this", "So
  true", "Spot on". Start with the substance.
- **Nothing the operator does not claim.** Stay within the strengths and proof
  points given; never name anything on the never-claim list, and never invent a
  client, a project or a number.
- If the work the post describes stalled, say the work stalled; never that the
  poster's team failed.
- No em dashes. No hashtags. No emoji.

**When THE ARTICLE THE POST LINKS TO is given** *(v11)*, the post is a summary
of it. Read it before choosing the step: a comment that suggests what the
article already says or does tells the poster you did not read it. Take the
step past what the article covers. Do not quote its figures or name its
examples back to the poster: they wrote it, and a detail recited from it
reads as showing off having read it.

**When THE COMMENTS ALREADY UNDER THE POST are given** *(v11)*, never make a
point another commenter has made, and never agree with one by name. If the
best step has been taken already, take the next one, or say the post is no
longer worth a comment (`worthy` false) when nothing is left to add.

## Fields

- `worthy`: true or false.
- `post_date`: the chosen post's date as YYYY-MM-DD, worked out from the paste
  date. "" when no post qualifies.
- `post_excerpt`: the first ten or so words of the chosen post, exactly as
  pasted, so the operator can find it. "" when none.
- `summary`: what the post says, in one or two plain sentences, so the operator
  can decide without reading it. State the poster's point or question, not your
  view of it.
- `why`: one sentence. Why it is worth a comment, or which test it fails.
- `draft_a`: the comment you recommend posting. `draft_b`: a different angle.
  Both "" when not worthy.
- `draft_why`: one or two plain sentences on why draft A is the comment to post:
  which position on the poster's idea it takes, and why the poster would want to
  answer it. "" when not worthy.
