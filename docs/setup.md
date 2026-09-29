# Set it up for your business

[← README](../README.md) · [How it works](how-it-works.md) · [Measurement](measurement.md) · [Guardrails](guardrails.md)

## Quickstart

Requires Node 20+, an Anthropic API key (Claude, including its web search tool), and a
Tavily key for news and event search.

```sh
npm install
cp .env.example .env                       # ANTHROPIC_API_KEY, TAVILY_API_KEY
for f in config/*.example.yml; do cp "$f" "${f%.example.yml}.yml"; done
git config core.hooksPath hooks            # the commit-message check
```

Two files hold what matters: **`config/business.yml`** (who you are, what you sell, who
you want, and which dated events are worth writing on) and **`config/runtime.yml`**
(which models, which sources). The example describes a fictional cybersecurity
consultancy. The remaining example files hold settings some steps still read; copy
them too.

**Choosing models.** The code asks for a tier (cheap, default, most capable), never a
named model; `config/runtime.yml` says which Claude model each tier is. Moving a step
to a cheaper or stronger model is a one-line change there, and because every call's
cost is recorded, its effect on cost is measured.

**Using another AI provider.** It has only been run on Claude, but it is not tied to
it. Every model call goes through one function in one file (`src/models.mjs`), so
moving to another provider (Azure OpenAI, say) means rewriting that function: the
request, structured JSON output against a schema, and the price list. Two steps also
use Anthropic's built-in web search (finding a firm's website, and confirming a news
event on the firm's own site); those need another search in its place. The prompts
are plain text and carry over, but they were tuned on Claude, so the first week on a
new model is the time to watch the Scoreboard. Measuring whether a change like this
helped or hurt is what the scoreboard is for. Claude Code is optional: every step is
an ordinary command, and any coding agent that can run commands can drive them.

Then, in the order a newcomer would run them:

```sh
npm run queries                      # propose searches from your targets and events
npm run queries -- --adopt           # adopt the proposal as the search list
npm run queries -- --run --save      # run it; finds enter the book
npm run lead -- vet --id <firm> --name "<Firm>" --domain <firm.com>   # vet one firm
npm run rank                         # the baseline ordering the judge is measured against
npm run judge -- --queue --limit 5   # rate a few people
npm run dash                         # build the pages into data/dash/
npm run inbox                        # form server on 127.0.0.1; open the Ready page
```

On the pages: click **Write first**, **Would write** or **Wouldn't** on each card, with
a word of reason. Those calls are what the judge learns from. To write to someone:
Draft, revise in plain words, send it yourself, press Sent.

After that, one command a weekday does the routine work (weekly searches and agendas,
vetting new finds, judging a few, rebuilding the pages):

```sh
npm run daily
```

Checks: `npm test` and `npm run leaks`.

## Adapting it to your business

Everything specific to one business is in `config/business.yml`:

- **offers:** name, price, unit, who it is for, and the one-line pitch;
- **targets:** in plain prose, with a few examples, and optionally their own geography
  and size band;
- **events:** the dated happenings worth writing on, each with the near-misses that do
  not count (the most useful thing in the file to grow over time);
- **size and where:** the default band and region.

Change that file and the searches, the gates, the judge's framing and the drafts all
follow. No code change is needed, and `npm run leaks` keeps it that way.

**What does not transfer:** the examples the judge and the drafter learn from are your
own calls and your own sent notes, so a new install starts with none. The first week is
mostly clicking verdicts and editing drafts; both become examples.

## What it costs to run

Model calls and search credits, both recorded as they happen. The Spend page shows the
running total by day, step and model, and `.env.example` lists which steps call which
key. Gates, ranking and the pages make no paid calls.
