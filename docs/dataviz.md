# Charts

Rules for the Results page (`src/results.mjs`) and any chart added later.
They are numbered so a review or a correction can cite one. A correction that
reflects a general preference becomes a new rule at the bottom, with its date.

## What gets drawn

- **D1. A brief before a chart.** Each panel starts as one line in
  `chart_briefs`: the question it answers and the decision it informs. Only an
  approved brief is drawn. A panel without a decision behind it is not built.
- **D2. One question per panel.** A comparison goes on one axis, not in a grid
  of small charts.
- **D3. Use decides order.** Panels the operator looks at rise; ones he passes
  over sink. A panel unseen for 30 days folds into a strip at the bottom, and
  after 60 it is retired, with one click to bring it back. A new panel stays
  on top for 14 days so it gets a fair look. Views come from the page itself
  (`chart_views`), never from the assistant's view.

## Numbers

- **D4. A rate shows its count and its range.** "17 of 66", a dot at the rate,
  and a bar for the 90% range. Never a bare percentage. The caption says what
  the bar means ("where the true rate likely lies"), not how it is computed.

  The range is the Wilson score interval for k hits in n sends (`wilson()` in
  `src/outcomes.mjs`): the true rates p for which the observed k sits within
  1.645 binomial standard deviations, √(n·p·(1−p)), taken at p. It is inferred
  from the two counts, not measured. Not ±1.645√k: that matches Wilson at tens
  of hits but at 0 to 4 hits, where most reply counts are, it goes negative,
  runs short on top, and shows no width at all for zero.

  It assumes independent sends with one fixed rate. Sends are clustered (same
  firm, same week, same offer) and the rate drifts as the notes and targets
  change, so the real uncertainty is wider than the bar. Read the bar as the
  least uncertainty there could be: overlapping bars cannot be told apart, and
  a small gap is weak evidence.
- **D5. Small groups fold.** A group under 15 sends goes into Other. Below
  that, a rate is noise.
- **D6. Too few to rate means a list.** When the events are too few to split
  (replies, for now), list them with dates instead of charting a rate.
- **D7. Wait for an answer to be possible.** A send counts toward an accept or
  reply rate once it is 14 days old. A bounce never counts as a reply.
- **D8. Every number comes from the book when the page is built**, by code in
  `src/outcomes.mjs`. No stored copies, no numbers from a model.

## Look

- **D9. The page's palette, in order**, with gray for "other". The overall rate
  is a dashed line. Markers under a time axis carry events (a weekly job, a
  failed run), with what happened in the hover text.
- **D10. Axis titles are words** ("accepted", "sends", "week starting").
  Percent axes start at zero.

## Words

- **D11. The title is a plain noun phrase** saying what is plotted: "Reply rate
  by channel", not a question and not a conclusion. It starts with the panel's
  figure number, which is fixed to the panel, not to its place on the page, so
  "Figure 3" means the same chart after the order changes.
- **D12. The caption is two to four short sentences**: what is plotted, what
  the marks mean, and at most one number read off it. No method essays, no
  advice, no em-dashes.

## Before anyone sees it

- **D13. Render and look.** Every changed page is screenshotted and checked
  for clutter, empty panels and wrong data before it is shown.

## Habits to avoid

From dashboards built before these rules.

| Habit | Instead |
|---|---|
| A panel because the data existed | a brief with a decision (D1) |
| A paragraph above every chart explaining the method | two to four sentences under it (D12) |
| A percentage on a handful of sends | count, range, fold (D4, D5) |
| Markers for every job that ran | only the jobs a reader could miss (D9) |
| Several panels answering one question | one panel (D2) |
| Counting a status as an event without checking the record | read the response rows (D7) |

## From the operator's edits

*(Each correction to a panel becomes a rule here, so it is not needed twice.
The call itself is kept in `chart_feedback`.)*

- **D14. Rows run high to low.** In a chart of rates, rows are sorted by rate,
  highest first, within each color group: the blue rows, then the orange.
  Ordered scales (a rating) keep their own order. (2026-11-18)
- **D15. A list of events says where each one stands now**: the latest event
  for each person, and what has happened since, so a thread that went quiet
  does not read as live. (2026-11-18)
