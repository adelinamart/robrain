# RoBrain

**Stop watching your AI agent repeat the same mistakes.**

Open-source shared memory for teams using AI agents. Captures every decision and the alternatives your team ruled out, and flags when a new decision contradicts an old one — so your team revisits past decisions intentionally, instead of re-litigating from zero.

Works across Claude Code, Cursor, and Copilot.

## Contents

- [How it works](#how-it-works)
- [Install and usage](#install-and-usage)
  - [What ships today](#what-ships-today)
  - [Synthesis](#synthesis)
- [CLI commands](#cli-commands)
- [OSS vs Rory Plans cloud](#oss-vs-rory-plans-cloud)
- [Comparisons](#comparisons)
- [Troubleshooting](#troubleshooting)
- [Follow-ups (TODO)](#follow-ups-todo)
- [Reference](#reference)

---

## How it works

**Session 1 — Tuesday afternoon, Alice's machine:**

Alice and her agent are working on the shopping cart. They consider Redux for state management, but settle on Zustand because Redux was causing re-render performance issues in the cart component.

RoBrain captures this automatically:

```json
{
  "decision": "Use Zustand for state management",
  "rationale": "Redux caused re-render issues in cart",
  "rejected": [{ "option": "Redux", "reason": "re-render perf issues in cart" }],
  "files_affected": ["src/store/cart.ts"]
}
```

No notes written. No commands run. The capture is part of the session, not on top of it.

**Session 2 — a week later, Bob's machine:**

Bob is working on a new cart feature. His agent, in a fresh session with no memory of Alice's work, is about to suggest Redux.

Bob runs `npx robrain inject --query "state management" --copy` before his next prompt. RoBrain returns:

> Chose Zustand over Redux (re-render perf issues in cart) — Mar 15, high confidence

Bob pastes that one line into his agent. The agent now knows the team's prior reasoning, surfaces it in the conversation, and Bob's session continues from informed context — instead of re-litigating Alice's decision from scratch.

**That's the loop.** Decisions and their vetoes flow from one developer's session into every other developer's sessions. Captured automatically, retrieved manually today (or auto-injected with the cloud version).

### Why this matters

Six months into a project, every architectural decision your team has made — and every alternative they ruled out — is queryable as structured data. New developers join and inherit the full decision history. Old decisions stay queryable after you change your mind (*"what did we decide in March?"* returns a real answer). Contradictions across sessions get flagged for review instead of silently overwriting each other.

**Captured:**
- Architectural decisions made during AI coding sessions
- The rationale and rejected alternatives for each decision
- Which files were in scope when the decision was made
- Session metadata (timestamp, confidence score)

**Not captured:**
- Your actual code or file contents
- Passwords, tokens, or secrets
- Personal information
- Anything outside of conversation turns with your AI agent

### Does code leave your machine?

In self-hosted mode: no. Conversation turns are processed by your local Perception API running in Docker and stored in your local Postgres instance. Nothing is sent to Rory Plans or any external service.

When using Rory Plans cloud: conversation turns are sent to Rory Plans' hosted Perception API for extraction. The extracted decision object is stored on Rory Plans infrastructure. Raw conversation text is not retained after extraction.

### Why are there two API keys in self-hosted mode?

RoBrain uses Anthropic (Haiku) for decision extraction/classification and a separate embeddings provider (`openai`, `voyage`, or `cohere`) for semantic vector search. That is why you may see both `ANTHROPIC_API_KEY` and an embedding key in setup.

**Cheapest recommended combo:** `ANTHROPIC_API_KEY` (Haiku) + `EMBEDDING_PROVIDER=openai` with `OPENAI_API_KEY` (`text-embedding-3-small`).

### How RoBrain compares

After you've seen the loop, you may want to know how RoBrain fits the broader landscape of AI memory tools. The short version:

- **Claude Code Auto-Memory** captures per-user, per-machine. Bob's machine has no idea what Alice's machine learned.
- **Mem0** stores facts and resolves contradictions at the moment of insertion. It doesn't periodically scan the whole corpus for contradictions that emerge later.
- **Cloudflare Agent Memory** offers shared team memory profiles but runs as a managed service on Cloudflare's infrastructure.
- **RoBrain** captures decisions + rejected alternatives as structured data in your Postgres, runs a scheduled scan over the whole corpus to catch contradictions, and keeps both sides queryable when decisions change.

See [RoBrain vs Claude Code Auto Memory](#robrain-vs-claude-code-auto-memory) and [Comparisons](#comparisons) for the detailed breakdown.

---

## Install and usage

### Setup checklist, then automatic capture

From the **robrain clone**, install dependencies and **build** once (so `sensing-mcp` is compiled before `install` copies it into `~/.robrain/mcp`). Then start Docker, wire editors, and init each app repo.

**One-time (robrain repo):**

```bash
pnpm install && pnpm build

# 1. Start the Docker stack (Postgres + Perception)
pnpm docker:up

# 2. Install CLI and wire Sensing into Claude Code (pass --repo-root so MCP bundle exists)
npx robrain install --self-hosted --repo-root "$(pwd)"
```

**One-time (each application repo):**

```bash
cd /path/to/your/project
npx robrain init-project
```

**Per-project (do once per repo):**

Step 3 above — `init-project` — writes the `CLAUDE.md` instructions that tell Claude Code to call the Sensing MCP tools at session start and end. This only needs to happen once per project.

That's it. After that — nothing.

`npx robrain` is the canonical CLI path used throughout this README. Anywhere you see that, you can use plain `robrain` instead if the CLI is installed globally (see below).

### CLI on your `PATH` (optional)

If you prefer not to use `npx` every time, install the package globally, then use the `robrain` command directly:

```bash
npm install -g robrain
```

Open a **new** terminal, or in zsh run `rehash` so your shell picks up the new binary. Then:

```bash
robrain install --self-hosted
# …and the same for other commands: robrain init-project, robrain review, etc.
```

If you get `command not found: robrain`, either use `npx robrain …` or ensure your global npm `bin` directory is on your `PATH` (see `npm prefix -g`).

### Cursor-specific setup (most reliable path)

For Cursor users specifically, the most reliable OSS path is Cursor Background Agent or Cursor Rules plus self-hosted install:

```bash
npx robrain install --self-hosted
```

Then add project rules in `.cursorrules` so Cursor consistently calls the Sensing tools:

```md
At session start, call sensing_start_session.
After every response, call sensing_record_turn with the current turn details.
At session end, call sensing_end_session.
```

Copy-paste starter `.cursorrules`:

```md
# RoBrain sensing hooks (Cursor)
At session start, call sensing_start_session.
After every response, call sensing_record_turn with the current turn details.
At session end, call sensing_end_session.
```

This improves reliability when Cursor does not consistently follow general instructions by default.

### Architecture

Seven components. Two run locally alongside Claude Code (**Sensing**, **CLI**). On your infrastructure or Rory Plans: **Postgres**, **Perception**, **Synthesis** (batch job over the same DB — not on the hot session path), **Planning API** (cloud only), **Control MCP** (cloud only). In self-hosted OSS, Postgres and Perception run continuously; Synthesis you run on demand or on a schedule against `DATABASE_URL`.

```
Developer machine:
  sensing-mcp     ← watches Claude Code sessions passively (open source)
  robrain CLI     ← review, inject, manage (open source)

Your infrastructure / Rory Plans:
  Postgres        ← decisions table with rejected[] + pgvector (schema open source)
  Perception API  ← extracts + stores decisions (self-hosted: basic | cloud: calibrated)
  Synthesis       ← batch read of decisions → planning_blocks / flags (OSS: `pnpm synthesis:run` or `npx robrain synth`)
  Planning API    ← ranks relevant memories per task (cloud only)
  Control MCP     ← auto-injects context at task boundaries (cloud only)
```

### What ships today

The launch story is what you can run **now** (OSS self-hosted and CLI), not roadmap vapor:

- **Systematic passive capture** — Sensing records turns; Perception extracts decisions without the agent deciding what to remember.
- **`rejected[]` as structured, queryable data** — vetoes are first-class fields in Postgres, not prose buried in markdown.
- **Decision lifecycle** — active vs superseded rows, linked history, and review flows so memory can stay honest over time.
- **Team-shared store** — Postgres as the source of truth across machines and editors (with MCP on Claude Code, Cursor, Copilot-capable setups).
- **`npx robrain explain <file>`** — file-scoped “why does this exist?” from stored decisions.
- **Conflict visibility** — decisions can be flagged for contradiction; **`robrain review`** resolves them in OSS. Rory Plans cloud adds proactive warnings at task boundaries (see [OSS vs Rory Plans cloud](#oss-vs-rory-plans-cloud)).

That combination already goes beyond most “agent memory” products that stop at capture or grep.

### Synthesis

**Synthesis does not create or capture anything new.** It only reads what is already in the **`decisions`** table (plus sessions for `project_id`) and writes derived artefacts — mainly **`planning_blocks`**, **`conflict_flag` / `decision_relations`**, and logs. The reactive pipeline (Sensing → Perception) still owns every new decision row.

#### The gap Synthesis fills

Sensing and Perception are **reactive**: a session runs, one decision is extracted and written, done. Each write is considered **in isolation**. Nothing in that path ever reads the **whole corpus** after six months of work.

So you can end up with hundreds of rows nobody has read as a single picture: contradictions accumulate, the team’s stance on testing shifts across sessions, **Redux** shows up fifteen times as a rejected alternative without any one place that answers “what role does Redux play here?” — and none of that surfaces unless someone goes looking by hand.

**Synthesis is the job that looks at the full table.**

#### Three passes at a glance

Synthesis is a **batch job** that runs **three passes** over the decision corpus. The headline for most teams is the **contradiction scan**: if one row says *“Use Bun as the JS runtime”* (February) and another says *“Migrate back to Node — Bun is missing critical packages”* (May), Synthesis can treat that as a **direct reversal** even though they were captured in separate sessions, possibly by different developers, possibly with almost no overlapping vocabulary. It writes a **`conflicts_with`** edge into the decision graph and flags both for **`robrain review`**.

The other two passes round out corpus-wide analysis:

- **Drift detection** — clusters decisions by topic and surfaces when **stance has moved** without an explicit reversal, e.g. REST → GraphQL spread across four unrelated-looking decisions.
- **Entity promotion** — recurring proper nouns such as **Stripe** get promoted to first-class **`planning_blocks`** with enough relationship history to answer “what role does this play?” without re-reading every raw row.

The subsections below walk through each pass in the order the job runs them (Pass 1 drift, Pass 2 contradictions, Pass 3 entities).

#### Pass 1 — Where has the team’s position drifted?

Synthesis clusters architectural decisions by **topic area** (state management, auth, database, testing, API design, …), orders each cluster **chronologically**, and asks whether **recent** rows disagree with **earlier** consensus. When drift is real, it surfaces a plain-language signal — e.g. *your stance on state management is changing: earlier decisions committed to Zustand; recent ones move toward Jotai.*

It also writes a **compiled-truth** summary per topic into **`planning_blocks`**: one pre-compressed sentence (with vetoes preserved where the summariser is instructed to keep them) so downstream retrieval does not have to re-read fifteen state-management decisions on every store touch. Cheaper context, same substance.

**Review alignment:** clustering and drift detection see **every active** decision (`invalidated_at IS NULL`). The **compiled_truth** sentence is built **only from decisions you have approved in `robrain review`** (`reviewed_at IS NOT NULL`). Topics with no reviewed rows in the cluster skip `compiled_truth` until someone approves at least one row — so the line matches the same trust bar as export/injection, while drift can still call out emerging change from pending rows. Pass 1 prompts label each row **`[approved]`** vs **`[pending review]`** so the model weights stable approvals more heavily when forming clusters.

#### Pass 2 — Which decisions contradict each other but were never compared?

At **write time**, Perception mainly compares a new decision to neighbours that share **files** or are **semantically very similar** to the new embedding. It can **miss** pairs that are architecturally incompatible but live in different parts of the repo — e.g. session 12: *all external API calls must be idempotent* vs session 47: *use fire-and-forget for webhook delivery* (different files, never linked at insert time).

Synthesis runs a **corpus-wide** pass: find candidate pairs (same **scope**, high embedding similarity, no relation row yet), ask a small model to classify the pair, then write **`decision_relations`** accordingly:

- **`conflicts_with`** (+ **`conflict_flag`**) when the model says they cannot both be true.
- **`extends`** when the second decision **builds on** the first without contradicting it (direction: newer message in the prompt extends the earlier one, stored as an edge for graph consumers).
- **`related_to`** when they are compatible peers on the same topic.

Incremental mode (default) only re-checks pairs touched since **`projects.last_synthesis_at`**, unless you disable it (see env vars below). Resolving “keep both” in **`robrain review`** can record **`related_to`** (via the counterpart id) so Pass 2 does not re-flag the same pair forever.

#### Pass 3 — What recurring entity has no structured entry?

If **Redis** (or any library, service, or pattern) appears across many decisions — chosen, rejected, or only in rationale — but there is no compact row a human or tool can point at, every “what does Redis do here?” question devolves into reading a dozen raw decisions.

Synthesis **promotes** those entities into **`planning_blocks`**: a one-line synthesis plus enough context to back-link into the underlying decisions, so **`robrain explain`**, inject paths, and Control can prefer **one line** instead of replaying the whole scatter.

#### Corpus shape: before and after

| Before synthesis | After synthesis |
|------------------|-----------------|
| A flat table of decisions, retrievable by recency or semantic similarity | Topic clusters with **compiled-truth** rows per area |
| Contradictions only if the reactive matcher saw them | Additional **cross-corpus** contradictions flagged and linked |
| Recurring tools only implicit in many rows | **Named entity** blocks for things that keep showing up |

#### Why this matters for `robrain explain`

Without synthesis, **`npx robrain explain src/api/webhooks.ts`** is largely “the most relevant decision rows touching this file.” With synthesis-fed **`planning_blocks`** and relation flags in place, the same command can lean on **pre-summarised topic truth** and **conflicts the reactive path never wired** — e.g. the idempotency vs fire-and-forget tension that only appears when something reads the whole corpus.

#### OSS runner

The batch job lives in **`packages/synthesis`** as **`@robrain/synthesis`**. From the **robrain repo root** (with `.env` loaded):

```bash
pnpm synthesis:build
pnpm synthesis:run
pnpm synthesis:dry-run
```

Equivalent: `pnpm --filter @robrain/synthesis build|start`, or **`npx robrain synth`**, which runs the same filter with `pnpm`’s cwd set to the monorepo root. The CLI resolves that root from **`ROBRAIN_REPO`** if set; otherwise **`../../../..`** from this module’s compiled path (`packages/cli/dist/commands/`), i.e. the published package layout. The package also publishes a **`robrain-synth`** bin after `pnpm synthesis:build`.

It uses the **same `DATABASE_URL` / `DB_SCHEMA` / `ANTHROPIC_API_KEY`** as Perception (see repo `.env`). Optional **`ANTHROPIC_MODEL`** overrides the default Haiku model id. The package depends on **`@anthropic-ai/sdk` ^0.32** and marks fixed system prompts with **ephemeral prompt cache**, so repeated cron runs pay less for identical system text.

**`planning_blocks`** supports **`topic`** + **`last_refreshed_at`** and a **partial unique index** on `(project_id, block_type, topic)` for upserts; **`projects.last_synthesis_at`** drives incremental Pass 2.

**CLI wrapper:** `npx robrain synth` (from a checkout) forwards to the same job with optional **`--dry-run`**, **`--full`** (disable incremental Pass 2), **`--lookback <days>`**, **`--project <id>`** (sets `SYNTHESIS_PROJECT_ID`).

**Useful env vars** (all optional except the three DB/API keys above):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SYNTHESIS_DRY_RUN` | off | When `true`, no DB writes (`pnpm synthesis:dry-run` sets this). |
| `SYNTHESIS_INCREMENTAL` | `true` | Set to `false` to re-scan all Pass 2 candidate pairs. |
| `SYNTHESIS_LOOKBACK_DAYS` | `0` | Limit Pass 1 decision rows to the last *N* days (`0` = all time). |
| `SYNTHESIS_MIN_CLUSTER` | `3` | Minimum decisions before Pass 1 runs. |
| `SYNTHESIS_CONT_THRESHOLD` | shared `THRESHOLDS.SIMILARITY_LINK` | Pass 2 similarity floor (cosine as `1 − distance`). |
| `SYNTHESIS_ENTITY_MIN` | `3` | Minimum mentions to promote an entity in Pass 3. |
| `SYNTHESIS_PASS1_CHUNK` | `50` | Decisions per clustering prompt chunk. |
| `SYNTHESIS_PASS2_CONCURRENCY` | `4` | Parallel Haiku calls in Pass 2. |
| `SYNTHESIS_PROJECT_ID` | *(all projects)* | Restrict the run to one `projects.id`. |
| `SYNTHESIS_EXPORT_MEMORY` | off | When `true`, after **new `compiled_truth`** rows, runs **`robrain export-memory --cwd <stored> --project-id …`** (needs `working_directory` on `projects`, set by **`robrain init-project`**). **`ROBRAIN_REPO`** overrides the monorepo root for that subprocess if needed. |

#### Recommended cron setup

Run Synthesis from the **robrain clone** (so `pnpm` can resolve **`@robrain/synthesis`**). Point **`DATABASE_URL`** (and API keys) at the same Postgres Perception uses — e.g. reuse the repo **`.env`**, or set vars in the cron line / a small wrapper script if you do not want to source `.env` from cron.

**User crontab** (`crontab -e`) — nightly at 02:00:

```bash
# RoBrain Synthesis — contradiction scan + drift + entities (incremental Pass 2 by default)
0 2 * * * cd /path/to/robrain && pnpm synthesis:run >> /tmp/robrain-synthesis.log 2>&1
```

**`npx robrain synth`** works too if the global CLI can resolve the monorepo (**`ROBRAIN_REPO`** / install layout); **`pnpm synthesis:run`** from the clone is the most reliable cron target.

**`/etc/cron.d/`** files need a **sixth field: the user** who runs the job (see `man 5 crontab`):

```cron
# /etc/cron.d/robrain — nightly Synthesis (replace YOUR_USER and path)
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
0 2 * * * YOUR_USER cd /path/to/robrain && pnpm synthesis:run
```

Dry-run smoke test: `SYNTHESIS_DRY_RUN=true pnpm synthesis:run` (or **`pnpm synthesis:dry-run`**).

Cron’s default **`PATH`** is minimal — if **`pnpm`** is not found, use an absolute path (from `which pnpm`) or prepend **`PATH=/usr/local/bin:…`** as in the **`/etc/cron.d`** example above.

**Perception (F1):** semantic **`GET /decisions?query=…`** ranks the top vector neighbours with a **`planning_score`** using shared **`SCORING_WEIGHTS`** (semantic + file overlap + recency + `historical_relevance` + **`APPROVAL_STATE`** from `reviewed_at`). **`robrain inject --files`** forwards paths as **`boost_files`** so file overlap participates.

**Perception (F7):** additive DDL ships as versioned SQL under **`packages/perception-self-hosted/migrations/`** (`001_*.sql`, …) and a **`schema_migrations`** ledger — startup runs any unapplied file. Docker images include that folder next to **`dist/`**.

**Contributors welcome:** tighter `explain` / inject consumption of `planning_blocks`, eval sets, and scheduling examples — open issues or PRs.

### Quick start — self-hosted

#### Prerequisites
- Docker + Docker Compose
- Node.js **18.18+** (older 18.x + npm 9.6 can break `npx` bin permissions; upgrade Node or use `pnpm dlx robrain`), pnpm
- Anthropic API key (for Haiku extraction)
- OpenAI, Voyage, or Cohere API key (for embeddings)

#### 1. Clone and configure

From the repository root, create a single `.env` used by both `pnpm docker:up` and `robrain install --self-hosted --repo-root`:

```bash
git clone https://github.com/adelinamart/robrain
cd robrain
cp .env.example .env
```

Edit `.env` at the repo root (same keys power Perception in Docker and the CLI install prompts). Paste real keys from [Anthropic](https://console.anthropic.com) and your embedding provider — do not commit that file.

```
ANTHROPIC_API_KEY=
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=
```

Keep `EMBEDDING_PROVIDER` identical between this file and what you select when running install (or set `EMBEDDING_PROVIDER` in `.env` and install will pick it up without prompting).

#### 2. Start Postgres + Perception

```bash
pnpm docker:up
```

Verify:
```bash
curl http://localhost:3001/health
# {"status":"ok","db":"connected","mode":"oss-self-hosted"}
```

#### 3. Install CLI and register with Claude Code

```bash
pnpm install && pnpm build

# Install the local package globally — then use robrain normally:
pnpm install -g /absolute/path/to/robrain/packages/cli

# Register Sensing MCP (pass repo root so ~/.robrain/mcp/sensing is populated)
npx robrain install --self-hosted --repo-root "$(pwd)" --perception-url http://localhost:3001

# Initialize your project (run in your repo root)
cd /path/to/your/project
npx robrain init-project
```

#### 4. Start a Claude Code session

Open Claude Code normally. Sensing watches in the background.

`robrain init-project` writes mode-aware instructions:

- **OSS self-hosted** (`robrain install --self-hosted`): generated `CLAUDE.md` / Cursor rule uses only `sensing_*` tools.
- **Cloud / Control-enabled**: generated instructions include both `sensing_*` and `control_*` calls.

#### 5. Review what was captured

```bash
npx robrain review
```

#### 6. Inject context into Claude Code

```bash
# Search for relevant decisions
npx robrain inject --query "payment flow decisions" --copy

# Get context for specific files
npx robrain inject --files "src/api/payments.ts,src/store/cart.ts" --copy

# Up to 100 unreviewed decisions (Perception cap) for a big paste block
npx robrain inject --all --copy
```

Paste the output into Claude Code before your next task.

---

## CLI commands

| Command | What it does |
|---------|-------------|
| `npx robrain install --self-hosted` | Wire Sensing MCP into Claude Code / Cursor; then runs **`init-project` in the current directory** (use `--skip-init-project` to opt out) |
| `npx robrain init-project` | Warm-start memory from package.json, README, git log |
| `npx robrain projects list` | List Perception projects with session/decision counts (recover phantom ids) |
| `npx robrain projects merge <from-id> <to-id>` | Merge one project id into another in the database |
| `npx robrain review` | Inspect, edit, or delete captured decisions; conflict **“keep”** can persist a **`related_to`** edge when Perception returns a counterpart id so Synthesis stops re-flagging the pair |
| `npx robrain review --history` | Show full decision lifecycle including superseded decisions |
| `npx robrain review --approve-all` | Bulk-approve every reviewable decision in the current fetch (no prompts per row) |
| `npx robrain export-memory` | Export approved decisions into Claude Code auto-memory files; optional **`--cwd`** / **`--project-id`** for non-interactive paths (Synthesis F2) |
| `npx robrain inject` | Get formatted context to paste into Claude Code |
| `npx robrain inject --query "..."` | Semantic search for relevant decisions |
| `npx robrain inject --files "..."` | Get decisions about specific files |
| `npx robrain inject --copy` | Copy output directly to clipboard |
| `npx robrain inject --all` | Request up to **100** decisions (server cap): all **unreviewed** without `--query`, or a wider semantic pool with `--query` |
| `npx robrain explain <file>` | Answer "why does this code exist?" for any file |
| `npx robrain explain <file> --why` | Full rationale + rejected alternatives per decision |
| `npx robrain explain <file> --copy` | Copy explain output to the clipboard |
| `npx robrain rule --add "..."` | Add a Planning rule (**Rory Plans cloud** — requires `planningUrl` in config) |
| `npx robrain rule --list` | List rules from Planning **`GET /facts`** when cloud is configured; OSS-only prints guidance |
| `npx robrain status` | Auth + Perception/Planning health + **active decision count** for the current project |
| `pnpm synthesis:run` | **[Synthesis](#synthesis)** — batch job from **robrain repo root** (`pnpm` must resolve `@robrain/synthesis`) |
| `npx robrain synth` | Same job via CLI: optional **`--dry-run`**, **`--full`**, **`--lookback <n>`**, **`--project <id>`**. Resolves the robrain monorepo from this CLI package unless **`ROBRAIN_REPO`** is set (needed for some global installs). |

## "Why does this code exist?"

One of the most disorienting experiences in a long-running codebase: you open a file you haven't touched in three months and have no idea why it's structured the way it is.

```bash
$ npx robrain explain src/store/cart.ts

  src/store/cart.ts — 3 decisions

  • Chose Zustand over Redux (re-render performance issues in cart) — Mar 15 2024
  • Chose optimistic updates over server-confirmed writes (felt slow to users) — Apr 2 2024
  • Chose normalised shape over nested objects — Apr 18 2024

  Tip: add --why for full rationale and rejected alternatives
```

With `--why` for the full picture:

```bash
$ npx robrain explain src/store/cart.ts --why

  src/store/cart.ts — 3 decisions

  Mar 15 2024  Use Zustand for state management
               because: Redux caused re-render performance issues in cart
               rejected: Redux (re-render perf), MobX (team unfamiliar)

  Apr 2 2024   Chose optimistic updates
               because: server-confirmed felt slow to users
               rejected: pessimistic updates (bad UX on slow connections)

  Apr 18 2024  Chose normalised shape over nested objects
               because: query performance at scale
```

Works on files, directories, or any path RoBrain has seen in a session. Pipe it into a PR description, paste it at the top of a code review, or run it before touching a file you haven't seen in months.

---

## OSS vs Rory Plans cloud

### What the cloud version adds — automatic intelligence

The OSS version gives you capture, storage, and manual retrieval. The Rory Plans cloud version adds two layers that make the system feel genuinely smart rather than just useful.

#### Conflict detection

In a long-running project, contradictions accumulate silently. CLAUDE.md has no way to flag them:

```
March: "Use REST for all API endpoints"
September: "We're switching to GraphQL"
```

CLAUDE.md: both lines sit there. No signal.

RoBrain cloud: when Sensing captures the September decision, Perception detects the contradiction against the March decision, classifies it as a reversal, and routes it to Control as a conflict flag. At the next task boundary, Claude sees:

```
⚠ Conflict detected (Mar 15): Previously chose "REST for all API endpoints"
and rejected: GraphQL (latency concerns at the time).
You appear to be reconsidering this — does the prior rejection still apply?
```

Claude must acknowledge this before proceeding. The contradiction doesn't silently accumulate — it surfaces at the moment it matters.

#### Pre-task rejection warnings

The OSS flow is: run `npx robrain inject`, paste context, then work. The cloud version removes the paste step entirely — and adds something the OSS version can't do.

When Control injects context at a task boundary, it scans the current task description against all stored `rejected[]` arrays. If the task mentions something previously ruled out, a warning fires *before* the agent answers:

```
⚠ Previously rejected: GraphQL — latency concerns at scale
(Apr 2024, in favour of: REST API). Proceed intentionally if this has changed.
```

This happens at the right moment — before the agent has suggested anything — not after. It's the difference between a system that reminds you of the past and one that steers you away from known mistakes before they happen.

Both features are built on top of the `rejected[]` field that the OSS version captures. The data is collected in OSS — the intelligence that acts on it is in the cloud.

**Get cloud access:** register for Rory Plans cloud early access by filling in [this form](https://docs.google.com/forms/d/e/1FAIpQLSe9c-7a23MvUEzF_yjxzK4RN_sF1VHiMSpPplRcG9GxEvbPhA/viewform?pli=1), or visit [roryplans.ai](https://roryplans.ai).

The self-hosted version captures decisions and lets you retrieve them manually. The cloud version adds the layer that makes retrieval automatic — context arrives in your sessions without you doing anything.

| Feature | OSS self-hosted | Rory Plans cloud |
|---------|----------------|-----------------|
| Passive session capture | ✓ | ✓ |
| `rejected[]` field | ✓ | ✓ |
| Decision lifecycle tracking | ✓ | ✓ |
| `npx robrain review` | ✓ | ✓ |
| `npx robrain inject` (manual paste) | ✓ | ✓ |
| Self-host on your infrastructure | ✓ | — |
| Your data stays local | ✓ | processed remotely |
| Haiku extraction (functional) | ✓ | ✓ |
| Calibrated extraction (fewer false positives) | — | ✓ |
| **Automatic injection at task boundaries** | — | ✓ |
| **Relevance scoring — surfaces what matters now** | — | ✓ |
| Web dashboard | — | ✓ |
| Team memory + shared scope | — | ✓ |
| Conflict auto-resolution | — | ✓ |

The honest difference: OSS gives you the capture and storage layer — decisions go in, you pull them out manually with `npx robrain inject`. The cloud adds the intelligence layer — Planning scores what's relevant to your current task and Control injects it automatically at every task boundary. You stop pasting. Context just arrives.

The extraction quality difference is real but secondary. Both versions use Claude Haiku. The cloud version has a more calibrated prompt that reduces false positives — we'll publish numbers once we have real-session benchmark data. But the bigger gap is automatic injection vs manual paste. That's a workflow change, not just an accuracy improvement.

**Get cloud access:** register for Rory Plans cloud early access by filling in [this form](https://docs.google.com/forms/d/e/1FAIpQLSe9c-7a23MvUEzF_yjxzK4RN_sF1VHiMSpPplRcG9GxEvbPhA/viewform?pli=1), or visit [roryplans.ai](https://roryplans.ai).

---

## Comparisons

### RoBrain vs Claude Code Auto Memory

**Claude Code Auto memory** is Anthropic’s native persistence: Claude writes notes as it works into machine-local markdown under `~/.claude/projects/…/memory/` ([official docs](https://docs.anthropic.com/en/docs/claude-code/memory)). Roughly the **first ~200 lines or 25 KB** of `MEMORY.md` loads every session; deeper notes live in topic files Claude reads **on demand** with normal file tooling. It ships with **Claude Code v2.1.59+** and needs **no Docker or Postgres**. That makes it the closest competitor to RoBrain’s “capture things without writing MEMORY.md yourself” story — but the **shape of the data** differs.

| Capability | Claude auto-memory | RoBrain |
|---|---|---|
| Storage | Local markdown files, per-user, per-machine | Postgres, can be team-shared |
| Capture mechanism | Active — Claude decides what to write | Systematic passive — every turn auto-classified, Claude doesn't decide |
| Cross-tool | Claude Code only | Any MCP-capable client (Claude Code, Cursor, etc.) |
| Recall | Loads `MEMORY.md` index at session start | Always-on summary + semantic search via embeddings |
| Audit trail | Files only | Full session turn history in DB |
| New developer joining the project | Sees nothing | Inherits the team's accumulated memory immediately |

**When Auto memory is enough:** solo dev, single editor (Claude Code), repo younger than ~6 months, and you’re fine curating markdown when notes drift.

**When RoBrain is worth the overhead:** you need **vetoes and file-level provenance** as data, **semantic recall** across months of history, **invalidation** when decisions reverse, **multiple editors**, or a **shared / auditable** store.

The two can coexist: Auto memory for lightweight scratch notes; RoBrain for canonical decisions you want to query, explain, and review.

### The `rejected[]` array

Your AI agent resets every session.
Mem0 stores facts. Zep stores entity relationships and conversation history. Neither exposes rejected alternatives as a first-class, structured field you can query — which means your agent can know "we use Zustand" but not "we considered Redux and ruled it out for a specific reason." The veto gets lost in prose or not captured at all.

RoBrain stores the veto as structured data. That's the differentiator.

We are not aware of another coding agent memory tool with a first-class rejected alternatives field — but we welcome corrections if that's wrong.

### Decision lifecycle — memory that stays honest

Most memory tools have a staleness problem: once something is stored, it stays stored even after it stops being true. CLAUDE.md has the same problem — nobody goes back to clean it up.

RoBrain tracks decision state over time. When you switch from Zustand to Jotai three months later, the old decision isn't deleted — it's invalidated and linked to the new one:

```json
{
  "decision": "Use Zustand for state management",
  "status": "superseded",
  "superseded_by": "abc123",
  "created_at": "2024-03-15"
}

{
  "decision": "Use Jotai for state management",
  "rationale": "Zustand caused issues at scale with 50+ stores",
  "rejected": [{ "option": "Zustand", "reason": "scaling issues with 50+ stores" }],
  "status": "active",
  "supersedes": "xyz789",
  "created_at": "2024-09-02"
}
```

The full timeline is always queryable. You can ask "what was the state management decision in March?" and get an accurate answer. You can see the full chain of decisions and why each one changed.

**Why this beats markdown:**

Markdown lies over time. A CLAUDE.md file that says "we use Zustand" is accurate until it isn't, and there's no signal when it becomes false. RoBrain becomes living memory — decisions have a state, a history, and a reason for changing. The agent injecting context from RoBrain knows whether a decision is currently active or was superseded, and why.

This lifecycle tracking happens automatically. When Sensing detects a new decision that contradicts an existing one, Perception flags it and links the two. When you confirm the change via `npx robrain review`, the old decision is invalidated. Nothing is ever deleted — history is always preserved.

### Why CLAUDE.md isn't enough — and when it is

CLAUDE.md is a good tool. If your project is small, your team is one person, and your sessions are short, it may be all you need. RoBrain is not trying to replace it — Sensing writes to your CLAUDE.md automatically as part of setup.

The limits show up as a project grows:

| Situation | CLAUDE.md | RoBrain |
|-----------|-----------|---------|
| Project is < 3 months old | ✓ sufficient | overkill |
| Solo developer, < 10 sessions | ✓ sufficient | overkill |
| You remember to update it after every session | ✓ works well | redundant |
| Project is > 6 months old | gets stale fast | grows richer over time |
| Multiple developers | diverges quickly | shared store, single source |
| You want to know what was *rejected* and why | ✗ nobody writes this down | ✓ captured automatically |
| You want to search decisions by file | ✗ grep at best | ✓ semantic + file search |
| Agent suggests something you already ruled out | you re-explain manually | RoBrain injects the veto |
| Session ends mid-task | you forget to update | flush-on-close captures it |

**The core difference is maintenance burden.** CLAUDE.md requires you to decide what to write, remember to write it, and keep it accurate as decisions change. Claude Code **Auto memory** automates some of that note-taking but still leaves you with markdown that can drift unless you curate it — RoBrain pushes durable decisions into Postgres with explicit lifecycle when better evidence arrives.

**Use CLAUDE.md for:** project setup instructions, coding conventions, one-time onboarding context. These are stable facts that don't change often and are easy to write once.

**Use RoBrain for:** architectural decisions, library choices, rejected alternatives, anything that was decided during a session rather than before the project started. These are the things nobody writes down because they happen in the middle of work.

The two are complementary. RoBrain's `npx robrain init-project` reads your existing CLAUDE.md as part of the warm-start, and injects session summaries back into it at session end. You keep writing CLAUDE.md for setup context. RoBrain handles the decision history automatically.

For how RoBrain compares to Claude’s built-in **Auto memory** (same problem space, different tradeoffs), see [RoBrain vs Claude Code Auto Memory](#robrain-vs-claude-code-auto-memory).

### RoBrain vs Zep

RoBrain and Zep answer different questions and work well together.

**RoBrain** captures *architectural decisions* — what was chosen, why, and what was explicitly ruled out as a structured queryable field. It answers: "what did we decide about this module, and what did we reject?"

**Zep / Graphiti** captures *conversation history and entity relationships* — it stores sessions, extracts facts, builds a temporal knowledge graph, and supports semantic retrieval across all of it. Zep can implicitly capture decisions too — the difference is that RoBrain surfaces rejected alternatives as a structured `rejected[]` field you can query directly, whereas in Zep they would live in conversation prose. For relationship queries — "how does the auth module connect to everything else?" — Zep's multi-strategy retrieval (semantic + graph traversal + BM25) is particularly strong.

A combined setup:

```bash
# Before a task — get both types of context
npx robrain inject --query "auth flow" --copy   # structured decisions + rejected alternatives
zep search "authentication" --project my-app    # conversation history + entity graph

# Paste both into Claude Code
```

RoBrain gives structured decision history with vetoes. Zep gives the broader relationship and conversation graph. They are complementary, not competing.

Zep is open source (Apache 2.0): [github.com/getzep/zep](https://github.com/getzep/zep)

---

## Troubleshooting

After setup, Sensing runs automatically whenever Claude Code is open. The MCP server is registered in `~/.claude/mcp.json`, so Claude Code starts it automatically on launch. The `CLAUDE.md` instructions tell Claude to call `sensing_start_session` at the beginning of each session and `sensing_record_turn` after every exchange.

**The one thing that can break it:**

Claude Code doesn't always follow `CLAUDE.md` instructions reliably — this is the compliance problem from pre-launch testing. If Claude stops calling `sensing_record_turn`, Sensing goes silent. The way to check:

```bash
npx robrain status
```

That prints Perception connectivity and a **`Decisions:`** count for the current project (from **`GET /projects`**). If **`Decisions: 0`** after a session where you expected captures, Claude may not have called the Sensing tools, or Perception rejected writes — run **`npx robrain review`** to confirm what is stored. The fix is often to make `CLAUDE.md` more explicit or remind Claude: *"follow the RoBrain instructions in CLAUDE.md."*

**The practical reality:**

The developer needs two habits:
- `npx robrain review` after sessions where important decisions were made
- `npx robrain inject --copy` before starting a new task that builds on prior work

Everything else — capture, extraction, storage, embedding — happens without you doing anything.

### Stale Perception Docker image (migrations / schema out of sync)

If you **pulled new code** but did **not rebuild** the `perception` service, the container may still run an **older** Perception binary than `packages/perception-self-hosted` on disk. Then startup migrations (for example `reviewed_at` on `decisions`) never run, `robrain review` approval can fail against the DB the CLI is using, and features that assume the new schema break in confusing ways.

From the **repo root** (same directory as `.env` and `docker/docker-compose.yml`):

```bash
docker compose -f docker/docker-compose.yml --env-file .env build perception
docker compose -f docker/docker-compose.yml --env-file .env up -d perception
```

If Docker reused layers and you still see old behavior, force a clean rebuild:

```bash
docker compose -f docker/docker-compose.yml --env-file .env build --no-cache perception
docker compose -f docker/docker-compose.yml --env-file .env up -d perception
```

Sanity check:

```bash
curl -sf "http://localhost:${PERCEPTION_PORT:-3001}/health"
```

**After shared types change** (`packages/shared`): downstream packages read **`@robrain/shared` types from `dist/`**. From repo root run **`pnpm --filter @robrain/shared build`** (or **`pnpm -r build`**) before relying on **`pnpm typecheck`** or publishing — otherwise `packages/*/dist/*.d.ts` can lag **`packages/shared/src`**.

**Verify the running container matches your checkout:** tail Perception logs while exercising capture — you should see current behavior (for example embedding dedupe logs as **`POST /signals deduped`** with matched decision text when a near-duplicate is skipped):

```bash
docker compose -f docker/docker-compose.yml logs -f --tail=80 perception
```

**Note:** A **brand-new** Postgres volume applies `packages/shared/schema.sql` on first boot. **Existing** volumes rely on Perception’s **idempotent startup migrations** when you run an up-to-date image — so after upgrading, rebuild and restart `perception` once.

---

## Follow-ups (TODO)

Tracked improvements not yet implemented in this repo:

- **Stable project identity.** Replace cwd-hash `project_id` with a content-based id where possible: hash of `git config --get remote.origin.url` (normalized), with a `.robrain/project.json` UUID fallback for non-git or no-remote repos — plus a migration story for existing DB rows. Survives `mv`, `cp -r`, and nested clones without orphaning decisions.

**Shipped recently:** Perception **404** responses include an actionable **`hint`** (copy tells users to run **`npx robrain init-project`** from the project root). Sensing MCP surfaces **`perception_error`** / **`perception_write_error`** in tool JSON; **`install`** chains **`init-project`** by default (`--skip-init-project` to opt out); **`robrain projects list`** / **`merge`** help repair fragmented installs.

---

## Reference

### Honest tradeoffs

Passive capture is more convenient than manual logging, but it comes with its own costs worth knowing before you adopt:

**False positives.** The classifier occasionally captures things that aren't real decisions — a debugging step, an exploratory suggestion, a temporary workaround. `npx robrain review` exists specifically so you can catch and delete these before they pollute future sessions. Plan to spend a few minutes reviewing after your first few sessions until you understand what the classifier catches.

**Low-confidence captures.** Not every decision is captured at high confidence. The system includes a confidence score on every decision — you may see entries marked "medium confidence" that need verification. The cloud version's calibrated prompt reduces this; the OSS version will have more of it.

**Review overhead.** The memory store is only as good as what's in it. If you never run `npx robrain review`, wrong decisions will persist and get injected into future sessions. The session-end summary helps by surfacing what was captured, but it doesn't replace occasional review.

**Trust in automated capture.** Some developers prefer knowing exactly what their agent has been told. `npx robrain review --all` shows everything stored for a project. Nothing is injected that you can't see and delete.

The alternative — CLAUDE.md maintained manually — has zero false positives but misses everything you forget to write down. RoBrain trades some review overhead for automatic capture of things that would otherwise be lost.

### Database schema

**Mid-session DB inspection:** Sensing buffers turns in-process ([`packages/sensing-mcp/src/buffer.ts`](packages/sensing-mcp/src/buffer.ts)) and flushes raw rows to Postgres when `sensing_end_session` runs; decisions are written asynchronously on the classifier path—so seeing **0** `session_turns` while decisions already exist is expected, not a bug.

The `decisions` table is the core of RoBrain. Open source, Apache 2.0.

```sql
CREATE TABLE context_system.decisions (
  id              TEXT PRIMARY KEY,
  decision        TEXT NOT NULL,           -- what was chosen
  rationale       TEXT,                    -- why (max 15 words)
  rejected        JSONB DEFAULT '[]',      -- [{option, reason}] — the differentiator
  files_affected  TEXT[],                  -- files being discussed
  confidence      FLOAT,                   -- classifier confidence 0–1
  scope           TEXT,                    -- user/local/team/global
  invalidated_at  TIMESTAMPTZ,             -- null = still valid (never deletes)
  embedding       vector(1536),            -- for semantic search
  created_at      TIMESTAMPTZ,
  session_id      TEXT                     -- which session produced this
);
```

Full schema in `packages/shared/schema.sql`.

### Contributing

Apache 2.0. PRs welcome for:
- Improving the OSS extraction prompt accuracy
- Adding new editor integrations (Windsurf, Zed, etc.)
- Localization adapter backends (Cursor API, Copilot API)
- Additional embedding providers

Issues and discussions on GitHub.

### License

Apache 2.0 — see [LICENSE](./LICENSE)

Built by [Rory Plans](https://roryplans.ai)
