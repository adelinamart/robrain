# Concepts

How RoBrain works, the capture + judgment pillars, Synthesis, comparisons, and reference material.

[← Back to README](../README.md)

Most agent-memory tools stop at capture — they store what happened and hope you query it later. RoBrain is built around a different question: **what is worth keeping, and what should surface before the agent acts again?** Passive capture records every decision and the alternatives your team ruled out; batch **Synthesis** reads the whole corpus to flag contradictions, drift, and recurring entities that no single session could see.

> The cost of forgetting a rejection isn't inefficiency. It's the auth bypass you already patched, the migration you already rolled back, the dependency you already removed for a CVE — re-suggested by an agent with no memory of why you said no.

## How it works

**Session 1 — Tuesday afternoon, Alice in Cursor:**

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

**Session 2 — Wednesday morning, Bob opens Claude Code:**

Bob is working on a new cart feature in Claude Code. His agent, in a fresh session with no memory of Alice's work, is about to suggest Redux.

Bob runs `npx robrain inject --query "state management" --copy` before his next prompt. RoBrain returns:

> Chose Zustand over Redux (re-render perf issues in cart) — Mar 15, high confidence

The agent now knows the team's prior reasoning, surfaces it in the conversation, and Bob's Claude Code session continues from informed context — instead of re-litigating Alice's Cursor decision from scratch.

**That's the loop.** Alice can make a decision in Cursor on Tuesday and Bob can pick it up in Claude Code on Wednesday. Decisions and their vetoes flow from one developer's session into every other developer's sessions. Captured automatically; surfaced automatically via the always-on summary, with `inject` for focused pull in Free / self-hosted mode (or task-boundary auto-injection in the cloud).

Coding is the first vertical because the feedback loops are tight — reverts, incidents, and rework make the cost of a forgotten rejection measurable. The same architecture applies wherever agents make decisions that outlast a session.

### The layer above memory

Memory alone lets you ask *"what did we decide in March?"* Judgment answers harder questions: *are we contradicting ourselves? did our stance drift without anyone noticing? is the agent about to re-litigate something we already ruled out?*

- **Contradiction-catching** — Perception flags conflicts when a new decision collides with an old one. **Synthesis** scans the full corpus for incompatible pairs the reactive path never linked (different files, different sessions, different vocabulary). Rory Plans cloud surfaces conflicts and `rejected[]` vetoes at task boundaries before the agent suggests code.
- **Synthesis as the judgment layer** — drift detection, contradiction passes, and entity promotion turn hundreds of isolated rows into `planning_blocks`, relation edges, and `robrain review` queues. See [Synthesis](#synthesis) below.
- **`rejected[]` as substrate** — structured vetoes are the input pre-task warnings need. Capture stores them; judgment (retrieval, Synthesis, Control) acts on them.

Supporting capability: six months in, every architectural decision and ruled-out alternative is queryable as structured data. New developers inherit the full history. Old decisions stay queryable after you change your mind. Contradictions get flagged for review instead of silently overwriting each other.

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

RoBrain uses one LLM for decision extraction/classification and Synthesis, plus a separate embeddings provider (`openai`, `voyage`, or `cohere`) for semantic vector search. By default the LLM is Anthropic (Haiku), which is why you may see both `ANTHROPIC_API_KEY` and an embedding key in setup.

**Cheapest recommended combo:** `ANTHROPIC_API_KEY` (Haiku) + `EMBEDDING_PROVIDER=openai` with `OPENAI_API_KEY` (`text-embedding-3-small`).

### Prefer not to use Anthropic? Run OpenAI-only.

The reasoning LLM is pluggable. Set **`LLM_PROVIDER=openai`** and decision extraction + Synthesis use OpenAI chat-completions instead of Haiku — so the whole stack runs on a single OpenAI key (embeddings already default to OpenAI):

```
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
EMBEDDING_PROVIDER=openai     # already the default
# OPENAI_LLM_MODEL=gpt-4o     # default; see warning below
```

With this set, **no `ANTHROPIC_API_KEY` is required** — Perception, Sensing, and Synthesis all boot on the OpenAI key alone.

> **Model note:** `gpt-4o-mini` is cheaper but can hallucinate fields (invent or drop keys) when forced into the structured-output JSON prompt — which is exactly why the project default classifier is Haiku. If you go OpenAI, prefer **`gpt-4o`** or **`gpt-4.1`** for extraction fidelity and reserve `gpt-4o-mini` for low-stakes use.
>
> Synthesis uses Anthropic's ephemeral prompt cache on the default path; the OpenAI path simply skips that (OpenAI caches inputs automatically), so the only difference is cost behavior, not correctness.

### How RoBrain compares

After you've seen the loop, you may want to know how RoBrain fits the broader landscape of AI memory tools. The short version:

- **Claude Code Auto-Memory** captures per-user, per-machine. Bob's machine has no idea what Alice's machine learned.
- **Mem0** stores facts and resolves contradictions at the moment of insertion. It doesn't periodically scan the whole corpus for contradictions that emerge later.
- **Cloudflare Agent Memory** offers shared team memory profiles but runs as a managed service on Cloudflare's infrastructure.
- **RoBrain** captures decisions + rejected alternatives as structured data in your Postgres, runs a scheduled scan over the whole corpus to catch contradictions, and keeps both sides queryable when decisions change.

See [RoBrain vs Claude Code Auto Memory](#robrain-vs-claude-code-auto-memory) and [Comparisons](#comparisons) for the detailed breakdown.

### How memory gets back into your next session

There are two retrieval paths, and the automatic one is the default:

- **Automatic, cross-tool via the always-on summary.** At session start, Sensing fetches the project's always-on summary from Perception, so the next session begins with approved decisions already in context. That is how Alice can make a decision in Cursor and Bob can open Claude Code later with the same decision already loaded. For Claude Code specifically, **`npx robrain export-memory`** can also project approved decisions into Claude auto-memory files, and Synthesis can refresh that export after **`compiled_truth`** updates. Opt in to a **team-visible ledger** with **`npx robrain export-memory --ledger`**, which writes a single regenerated **`decisions.md`** in the repo (default: project root) for git diff and PR review — separate from per-user auto-memory under `~/.claude/`.
- **On-demand semantic pull via `npx robrain inject`.** Use this when you want context for a specific topic, file, or stale decision that does not belong in the always-loaded summary. This is the manual paste path in Free / self-hosted mode; Rory Plans cloud automates that targeted retrieval step at task boundaries via Control.

Why isn't retrieval just another MCP tool? You usually don't need to run anything. The always-on summary loads automatically at session start. `inject` is for the cases where you want something narrower than that default block. In Rory Plans cloud, Control automates that second path at task boundaries.

<details>
<summary>Reference: export-memory vs always-on summary vs Synthesis</summary>

| Path | `npx robrain export-memory` | Always-on summary | Synthesis (`compiled_truth`) |
|---|---|---|---|
| How it runs | **Manual** — `npx robrain export-memory`, or chained from Synthesis when `SYNTHESIS_EXPORT_MEMORY=true` | **Automatic** — Sensing fetches it every `sensing_start_session` | **Batch** — `npx robrain synth` / `pnpm synthesis:run` on demand, or nightly cron |
| What it is | The archive — vetted decisions written to disk so Claude can read them on its own | The "good morning" briefing — a short ranked digest handed to the agent at session start | The **dreaming** step — cross-corpus consolidation that runs while no one is looking, looking for drift, contradictions, and recurring entities |
| What it pulls from decisions | All approved active rows (no cap); `--include-unreviewed` widens | <=20 active rows: <=15 **high-signal** (approved OR has `rejected[]` OR scope=`global`) + <=5 **recency fill** | All active rows are clustered by topic; the `compiled_truth` sentence is built from **approved rows only** in each cluster |
| Where the output lives | Markdown files in `~/.claude/projects/<slug>/memory/` (+ managed block in `MEMORY.md`); optional **`--ledger`** → `<project>/decisions.md` (git-committed, regenerated) | `projects.always_on_summary` text column in Postgres | `planning_blocks` rows in Postgres — one pre-compressed sentence per topic |
| How it reaches Claude | Claude Code's own auto-memory loader reads the files on every session; **`decisions.md`** is for humans and git — not loaded by Claude automatically | Returned as the `sensing_start_session` tool result — the agent sees it as a tool response | Stays in Postgres — needs **`export-memory`** (or cloud Control) to surface to Claude. **Synthesis without export = a dream nobody remembers.** |
| Why it matters | Survives Perception outages; gives Claude the full vetted corpus, file-clustered | Zero-effort context at the start of every session, even before the agent does anything | Catches the contradictions, drift, and recurring entities the reactive write path can't see in isolation |

</details>

## Two pillars in one stack

| Pillar | When it runs | What it does |
|--------|----------------|--------------|
| **Capture** | Every session (Sensing → Perception) | Extracts decisions + `rejected[]`; flags conflicts at write time; fills the always-on summary |
| **Judgment** | On demand or on a schedule (Synthesis + review) | Reads the **whole** corpus — drift, cross-session contradictions, entity promotion |

Capture without judgment leaves contradictions buried in hundreds of rows. Judgment without capture has nothing to judge. RoBrain ships both.

## Synthesis

**Synthesis is the judgment pillar in code.** It does not create or capture anything new — it only reads what is already in the **`decisions`** table (plus sessions for `project_id`) and writes derived artefacts: **`planning_blocks`**, **`conflict_flag` / `decision_relations`**, and logs. The reactive pipeline (Sensing → Perception) still owns every new decision row.

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

<details>
<summary>OSS runner, env vars, cron, and implementation details</summary>

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

</details>

<details>
<summary>Architecture details (optional reading)</summary>

What you interact with is **Sensing** and the **`robrain` CLI**. `pnpm docker:up` brings up Postgres + Perception in the background, and Synthesis runs later on demand or on a schedule.

```text
Developer machine:
  sensing-mcp     ← watches Claude Code sessions passively; fetches the
                    always-on summary at session start (open source)
  robrain CLI     ← review, inject, manage (open source)

Your infrastructure / Rory Plans:
  Postgres        ← decisions table with rejected[] + pgvector (schema open source)
  Perception API  ← extracts + stores decisions (self-hosted: basic | cloud: calibrated)
  Synthesis       ← batch read of decisions → planning_blocks / flags (OSS: `pnpm synthesis:run` or `npx robrain synth`)
  Planning API    ← ranks relevant memories per task (cloud only)
  Control MCP     ← auto-injects context at task boundaries (cloud only)
```

</details>

---
## Free / self-hosted vs Rory Plans cloud

### What the cloud version adds — automatic intelligence

The self-hosted version gives you capture, storage, the always-on summary, and manual focused retrieval. The Rory Plans cloud version adds two layers that make the system feel genuinely smart rather than just useful.

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

In Free / self-hosted mode, the default retrieval path is the always-on summary Sensing loads at session start. When you need something narrower than that always-loaded block, you run `npx robrain inject`, paste the result, then work. The cloud version removes that manual query-and-paste step entirely — and adds something the self-hosted version can't do.

When Control injects context at a task boundary, it scans the current task description against all stored `rejected[]` arrays. If the task mentions something previously ruled out, a warning fires *before* the agent answers:

```
⚠ Previously rejected: GraphQL — latency concerns at scale
(Apr 2024, in favour of: REST API). Proceed intentionally if this has changed.
```

This happens at the right moment — before the agent has suggested anything — not after. It's the difference between a system that reminds you of the past and one that steers you away from known mistakes before they happen.

Both features run on the `rejected[]` substrate the Free / self-hosted version captures. The vetoes are collected locally — the intelligence that acts on them at task boundaries is in the cloud.

**Get cloud access:** register for Rory Plans cloud early access by filling in [this form](https://docs.google.com/forms/d/e/1FAIpQLSe9c-7a23MvUEzF_yjxzK4RN_sF1VHiMSpPplRcG9GxEvbPhA/viewform?pli=1), or visit [roryplans.ai](https://roryplans.ai).

The self-hosted version already brings decisions back automatically through the always-on summary, and lets you pull extra context manually with `npx robrain inject` when you need something task-specific. The cloud version adds the layer that makes that focused retrieval automatic too — context arrives at task boundaries without you doing anything.

| Feature | Free / self-hosted | Rory Plans cloud |
|---------|--------------------|-----------------|
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

The honest difference: self-hosted already gives you capture, storage, and the always-on summary. When you need focused retrieval beyond that default block, you still pull it manually with `npx robrain inject`. The cloud adds the intelligence layer — Planning scores what's relevant to your current task and Control injects it automatically at every task boundary. You stop pasting for task-specific recall. Context just arrives.

The extraction quality difference is real but secondary. Both versions use Claude Haiku. The cloud version has a more calibrated prompt that reduces false positives — we'll publish numbers once we have real-session benchmark data. But the bigger gap is task-boundary targeting and proactive injection vs manual focused paste. That's a workflow change, not just an accuracy improvement.

**Get cloud access:** register for Rory Plans cloud early access by filling in [this form](https://docs.google.com/forms/d/e/1FAIpQLSe9c-7a23MvUEzF_yjxzK4RN_sF1VHiMSpPplRcG9GxEvbPhA/viewform?pli=1), or visit [roryplans.ai](https://roryplans.ai).

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

RoBrain stores each veto in **`rejected[]`** so the judgment layer can act on it: pre-task warnings (cloud Control), semantic inject, contradiction surfacing, and Synthesis clustering — not as an isolated novelty, but as the structured input those features require.

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

CLAUDE.md is a good tool. If your project is small, your team is one person, and your sessions are short, it may be all you need. RoBrain is not trying to replace it — `robrain init-project` writes the RoBrain instructions into your `CLAUDE.md` as part of setup.

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

The two are complementary. RoBrain's `npx robrain init-project` reads your existing `CLAUDE.md` as part of the warm-start and writes the RoBrain instructions there; approved decision recall comes from the always-on summary and, for Claude Code, optional `export-memory` files. Use **`export-memory --ledger`** when you want one committed **`decisions.md`** in the repo for the whole team to review in PRs (approved, superseded, and optionally pending rows). You keep writing `CLAUDE.md` for setup context. RoBrain handles the decision history automatically.

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

## What's next

**Next:** connecting decisions to outcomes (reverts, incidents, cycle time) so RoBrain can surface when a team is optimizing for the wrong thing in its own codebase. If you want to help shape that layer, [get in touch via Rory Plans](https://roryplans.ai).

## Follow-ups (TODO)

Tracked improvements not yet implemented in this repo:

- **Stable project identity.** Replace cwd-hash `project_id` with a content-based id where possible: hash of `git config --get remote.origin.url` (normalized), with a `.robrain/project.json` UUID fallback for non-git or no-remote repos — plus a migration story for existing DB rows. Survives `mv`, `cp -r`, and nested clones without orphaning decisions.

- **Remote MCP for cloud agents (e.g. ChatGPT Codex web agent).** `robrain install` wires a **stdio** MCP server (`command = "node"`, a local bundle path) that talks to Perception at `localhost:3001`. That covers the local Codex CLI and the Codex IDE extension — both share `~/.codex/config.toml` — but **not** the cloud/web Codex agent, which runs in a sandboxed container where neither the local node binary nor a `localhost` Perception exists. Codex supports **remote Streamable-HTTP MCP servers** (`url` + `bearer_token_env_var`), so a hosted Perception/Sensing endpoint behind HTTPS + a token could let cloud agents capture too. That hosted surface is the Rory Plans cloud direction, not the OSS self-hosted path — tracked here so the gap is explicit. (`AGENTS.md` is still read by the cloud agent; only the `sensing_*` tools are unavailable there.)

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
  rejected        JSONB DEFAULT '[]',      -- [{option, reason}] — substrate for warnings + judgment
  files_affected  TEXT[],                  -- files being discussed
  confidence      FLOAT,                   -- classifier confidence 0–1
  scope           TEXT,                    -- user/local/team/global
  invalidated_at  TIMESTAMPTZ,             -- null = still valid (never deletes)
  embedding       vector(1536),            -- for semantic search
  created_at      TIMESTAMPTZ,
  session_id      TEXT                     -- which session produced this
);
```

Full schema in [`packages/shared/schema.sql`](../packages/shared/schema.sql).
