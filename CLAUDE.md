# prospect-scanner — project instructions

Read `docs/how-it-works.md` first. It describes the system as built. This file holds conventions and guardrails only.

## What this is

A configurable prospect-discovery pipeline for small consulting firms, with a built-in evaluation harness that grades its own output. It is **two things at once**, and both matter:

1. A working tool the author uses to find clients.
2. A public portfolio artifact demonstrating agentic-system design **with measurement**. The self-grading and model-right-sizing layers are the point of the project, not a bonus. Do not deprioritize them.

## Hard guardrails, non-negotiable

- **Never automate, scrape, or message LinkedIn.** Their User Agreement §8.2 prohibits crawlers, bots, extensions and automated messaging, and enforcement is fast. The operator's LinkedIn account is their most valuable professional asset. No source module may target it, no Playwright script may log into it.
- **Never send anything.** No email dispatch, no sequences, no auto-replies. No stage holds credentials to any inbox or messaging system. The operator edits and sends every message by hand. If a task seems to require sending, stop and ask.
- **Drafting is allowed; sending is not.** *(Amended 2026-08-25; this previously read "A human writes and sends every message" and barred drafting.)* The pipeline may produce a draft outreach note, and iterate on it with the operator until it is in their voice. Every draft is bound by the channel rules carried in `data/seed-outreach.json` and by `operator.never_claim` in `config/me.yml`. A draft that violates either is a defect and the grader treats it as one.
- **The operator may paste in text they read on LinkedIn themselves.** That is a person using a site as a person, and it is allowed. No module may fetch, crawl, log into or message linkedin.com. Store operator-pasted facts with a provenance marker so they are never confused with something the system retrieved.
  *(Exception added 2026-09-25, at the operator's explicit request: "yes, add the
  narrow exception for the search link".)* A dashboard card may carry an `href` to
  LinkedIn's people search (`/search/results/people/?keywords=`) for the operator
  to CLICK. It opens in his browser, as him, and saves retyping a name; nothing
  in the repo fetches, follows or reads it. This is the only exception, and
  `src/config.mjs` enforces it to the character: one line in `src/dash.mjs`,
  refused if a call shares the line. `test/forbidden-host.test.mjs` plants the
  near-misses. Widening it is a new decision for the operator, not a refactor.
- **Every factual claim in a dossier carries a source URL.** A claim without retrievable evidence is a defect, and the grader treats it as one.
- **Every LLM call records model, tokens and cost** into the `runs` table. The cost study depends on it and cannot be retrofitted.
- **Respect robots.txt and rate limits** on every source.
- **`robots.txt` decides what may be fetched, not the WAF in front of it.**
  *(Added 2026-09-17.)* A site's `robots.txt` is the one statement of intent it
  publishes for machines, and it is the rule this project obeys. A firewall that
  refuses a user-agent is a cruder instrument than the policy it sits in front
  of, and refusing a named crawler while serving the identical page to a browser
  in 264ms is not a considered decision about access.

  So: where a plain fetch cannot read a page the site's own `robots.txt`
  **permits** — JS-rendered content, or a user-agent filter in front of static
  HTML — a browser may read it. Three conditions, all required, and any one
  failing is a stop:
    1. `robots.txt` allows that path for `*`. If it disallows, that is a stated
       policy and the answer is no, whatever a browser could do.
    2. The site serves a browser. If it refuses one too, it is closed to
       everyone and the answer is no.
    3. It is not linkedin.com. Their §8.2 prohibits crawlers *in words*, which
       is a policy and not a control, so no technical capability changes it.

  Fetches stay one-per-firm and rate-limited either way. And when a browser is
  needed, `vet` says so in its verdict rather than passing silently — knowing
  which firms required it is what keeps this auditable instead of habitual.
- **Never name a real prospect in a commit message.** `.gitignore` protects
  files, not history, and history cannot be un-written — this repo already
  carries a scrub debt because concrete commit messages felt more useful than
  careful ones. Describe the role and the shape: "a CIO at a large insurer",
  "three non-executive directors at one bank". A `commit-msg` hook in `hooks/`
  enforces it against the names in the database; `core.hooksPath` must point
  there (`git config core.hooksPath hooks`).

## Conventions

- Node, ES modules, `.mjs`. Matches the author's other projects.
- SQLite via `better-sqlite3`, single file at `data/prospects.db`.
- Claude via the Agent SDK. Model ids come from `config/runtime.yml`, never hard-coded in source.
- **Prompts live in versioned files under `prompts/`, never as inline strings.** Grading results are only attributable if the prompt that produced them can be identified.
- Dashboards are static HTML with inline Plotly, generated from SQLite, opened from disk. No server.
  *(Amended 2026-09-24. The operator: "i'm ok with relaxing the No server requirement to
  allow server on my laptop if that helps." A page opened from `file://` cannot write to
  SQLite, so hand-entering a profile meant retyping a long command per person — about
  twenty-five of them in one sitting. A LOCAL TOOL MAY SERVE A FORM WHILE IT IS IN USE,
  bound to 127.0.0.1, started by a command and stopped when the work is done. The
  dashboards themselves stay static files: this is a data-entry exception, not a web app,
  and nothing listens when nobody is typing.)*
- Playwright where a plain fetch cannot read a page `robots.txt` permits, under the
  three conditions in the guardrail above. Not as a default: `fetch` first, always,
  because a browser is two orders of magnitude more expensive per page. Never against
  LinkedIn.
- User data (every `config/*.yml`, and `data/`) is gitignored. The `config/*.example.yml` siblings are the public templates and must stay generic.
  *(Amended 2026-09-20. All three references above previously named `config/firm.yml`, a single file that was split into seven on 2026-08-26 and no longer exists. `src/config.mjs` still reads it if present, so an older checkout keeps working, but nothing in this repo has it. See `config/README.md` for which file answers what.)*
- **Nothing about the operator in code, prompts or queries.** *(Added 2026-09-25.)* This repo is meant to be pulled down and pointed at someone else's small business. The operator's name, firm, employer history, rates, target sectors and titles belong in `config/` (gitignored) and in example files, never in `src/` or `prompts/`; a prompt says "the operator's offers", not what they are. Do not add new config files or keys to hold one person's preference: a setting belongs in config only if another business would need to change it. `npm run leaks` checks this, and its test requires zero.

## Ranking

**Ranking changes go through the operator's verdicts, not new rules.** *(Added 2026-09-25.)* Do not patch the ranker with another exemption, persona pattern or weight when it gets someone wrong. Fix the missing or wrong data at the gates, record the operator's call in `verdicts`, and let the Scoreboard (the judge against the baseline formula) decide.

## Tone for generated dossiers

Dense and factual. Name the decision-maker and why they are the decision-maker. State the trigger as a dated event. List the gates checked and their outcomes. No persuasion, no adjectives, no speculation presented as fact. The reader is the operator, who is deciding whether to spend an hour on this candidate.
