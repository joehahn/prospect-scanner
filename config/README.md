# config/ — what the system needs to know about your business

Everything specific to one business lives here and nowhere else: the code and
prompts say "the operator's offers", never what they are. Every `*.yml` here is
gitignored; each ships with a `.example.yml` sibling describing a fictional
cybersecurity consultancy, so the system runs before you have written your own.
To start, copy each example to the same name without `.example`.

## The two files that matter

| File | Answers | You edit it when |
|---|---|---|
| `business.yml` | Who you are, what you sell, who you want, and which dated events are worth writing on | often; this is the working file |
| `runtime.yml` | Which models (by tier), which sources, and the size floors | rarely |

`business.yml` is written in plain prose on purpose. The search proposer turns
its targets and events into searches, the judge reads it to frame each rating,
and the drafter reads it for your offers and what you must never claim. An
event's `does_not_count` list, one line per near-miss you have actually seen, is
the most useful thing in the file to grow over time.

## The files some steps still read

| File | Read by |
|---|---|
| `signals.yml` | the gates (what disqualifies a firm) and the trigger vocabulary the code refers to |
| `sectors.yml` | the baseline formula the judge is measured against |
| `offers.yml` | the baseline formula and the drafter's package details |
| `segments.yml` | the baseline formula's reachability scores |
| `me.yml` | older steps; `business.yml` holds the same facts under `firm` and `you` |
| `discovery.yml` | the record of how prospects arrive; its `forbidden_hosts` is checked against every source module at load time, so the never-touch-LinkedIn rule fails a run rather than a review |

Copy these too. A setting belongs in config only if another business would need
to change it.

## Checks

Any command validates the files it reads: errors stop the run, warnings print
and continue. `npm run leaks` confirms that nothing from your own config has
found its way into code, prompts or the public templates.
