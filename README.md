# RoBrain

**Stop watching your AI agent repeat the same mistakes.**

RoBrain remembers architectural decisions, rationale, and rejected alternatives from your AI coding sessions — so the next session already knows what was tried, what was ruled out, and why.

Works across Claude Code, Cursor, and Copilot sessions.

## Setup — four steps, then fully automatic

The user has to do four things, in order. After that it's fully automatic.

**One-time setup (do once, ever):**

```bash
# 1. Start the Docker stack (Postgres + Perception)
#    (run this from the robrain repo root)
pnpm docker:up

# 2. Install CLI and wire Sensing into Claude Code
npx robrain install --self-hosted

# 3. Initialize your project (run in your repo root)
cd /path/to/your/project
npx robrain init-project
```

**Per-project (do once per repo):**

Step 3 above — `init-project` — writes the `CLAUDE.md` instructions that tell Claude Code to call the Sensing MCP tools at session start and end. This only needs to happen once per project.

That's it. After that — nothing.

`npx robrain` is the canonical CLI path used throughout this README.

## Cursor-specific setup (most reliable path)

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

---

## What makes this different

Most memory tools rely on explicit calls like `remember()` or manual logging. RoBrain doesn't. It watches your Claude Code sessions passively and captures decisions automatically — including **what was tried and ruled out**.

```
Session 3, turn 12:
  User: "let's use Zustand instead of Redux — Redux caused re-render issues in the cart"
  
  RoBrain captures:
  {
    decision: "Use Zustand for state management",
    rationale: "Redux caused re-render performance issues in cart",
    rejected: [{ option: "Redux", reason: "re-render performance issues in cart" }],
    files_affected: ["src/store/cart.ts"],
    confidence: 0.94
  }

Session 7, turn 3:
  npx robrain inject --query "state management" --copy
  
  → Pastes into Claude Code:
  "• Chose Zustand over Redux (re-render performance) — Mar 15, high confidence"
```

Six sessions later, Claude Code knows why your codebase looks the way it does.

---

## The `rejected[]` array

Your AI agent resets every session.
Mem0 stores facts. Zep stores entity relationships and conversation history. Neither exposes rejected alternatives as a first-class, structured field you can query — which means your agent can know "we use Zustand" but not "we considered Redux and ruled it out for a specific reason." The veto gets lost in prose or not captured at all.

RoBrain stores the veto as structured data. That's the differentiator.

We are not aware of another coding agent memory tool with a first-class rejected alternatives field — but we welcome corrections if that's wrong.

## Decision lifecycle — memory that stays honest

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

---

**Captured:**
- Architectural decisions made during Claude Code sessions
- The rationale and rejected alternatives for each decision
- Which files were in scope when the decision was made
- Session metadata (timestamp, confidence score)

**Not captured:**
- Your actual code or file contents
- Passwords, tokens, or secrets
- Personal information
- Anything outside of conversation turns with your AI agent

**Does code leave your machine?**

In self-hosted mode: no. Conversation turns are processed by your local Perception API running in Docker and stored in your local Postgres instance. Nothing is sent to Rory Plans or any external service.

When using Rory Plans cloud: conversation turns are sent to Rory Plans' hosted Perception API for extraction. The extracted decision object is stored on Rory Plans infrastructure. Raw conversation text is not retained after extraction.

**Why are there two API keys in self-hosted mode?**

RoBrain uses Anthropic (Haiku) for decision extraction/classification and a separate embeddings provider (`openai`, `voyage`, or `cohere`) for semantic vector search. That is why you may see both `ANTHROPIC_API_KEY` and an embedding key in setup.

**Cheapest recommended combo:** `ANTHROPIC_API_KEY` (Haiku) + `EMBEDDING_PROVIDER=openai` with `OPENAI_API_KEY` (`text-embedding-3-small`).

---

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

## Why CLAUDE.md isn't enough — and when it is

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

**The core difference is maintenance burden.** CLAUDE.md requires you to decide what to write, remember to write it, and keep it accurate as decisions change. RoBrain captures passively and invalidates stale decisions automatically.

**Use CLAUDE.md for:** project setup instructions, coding conventions, one-time onboarding context. These are stable facts that don't change often and are easy to write once.

**Use RoBrain for:** architectural decisions, library choices, rejected alternatives, anything that was decided during a session rather than before the project started. These are the things nobody writes down because they happen in the middle of work.

The two are complementary. RoBrain's `npx robrain init-project` reads your existing CLAUDE.md as part of the warm-start, and injects session summaries back into it at session end. You keep writing CLAUDE.md for setup context. RoBrain handles the decision history automatically.

---

## Architecture

Five components. Two run locally alongside Claude Code. Three run on your infrastructure (self-hosted) or Rory Plans (cloud).

```
Developer machine:
  sensing-mcp     ← watches Claude Code sessions passively (open source)
  robrain CLI     ← review, inject, manage (open source)

Your infrastructure / Rory Plans:
  Postgres        ← decisions table with rejected[] + pgvector (schema open source)
  Perception API  ← extracts + stores decisions (self-hosted: basic | cloud: calibrated)
  Planning API    ← ranks relevant memories per task (cloud only)
  Control MCP     ← auto-injects context at task boundaries (cloud only)
```

---

## Quick start — self-hosted

### Prerequisites
- Docker + Docker Compose
- Node.js 18+, pnpm
- Anthropic API key (for Haiku extraction)
- OpenAI, Voyage, or Cohere API key (for embeddings)

### 1. Clone and configure

From the repository root, create a single `.env` used by both `pnpm docker:up` and `robrain install --self-hosted --repo-root`:

```bash
git clone https://github.com/adelinamart/robrain
cd robrain
cp .env.example .env
```

Edit `.env` at the repo root (same keys power Perception in Docker and the CLI install prompts):
```
ANTHROPIC_API_KEY=sk-ant-...
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

Keep `EMBEDDING_PROVIDER` identical between this file and what you select when running install (or set `EMBEDDING_PROVIDER` in `.env` and install will pick it up without prompting).

### 2. Start Postgres + Perception

```bash
pnpm docker:up
```

Verify:
```bash
curl http://localhost:3001/health
# {"status":"ok","db":"connected","mode":"oss-self-hosted"}
```

### 3. Install CLI and register with Claude Code

#  Install the local package globally — then use robrain normally:
pnpm install -g /absolute/path/to/robrain/robrain/packages/cli

```bash
pnpm install && pnpm build

# Register Sensing MCP (pass repo root so ~/.robrain/mcp/sensing is populated)
npx robrain install --self-hosted --repo-root "$(pwd)" --perception-url http://localhost:3001

# Initialize your project (run in your repo root)
cd /path/to/your/project
npx robrain init-project
```

### 4. Start a Claude Code session

Open Claude Code normally. Sensing watches in the background.

### 5. Review what was captured

```bash
npx robrain review
```

### 6. Inject context into Claude Code

```bash
# Search for relevant decisions
npx robrain inject --query "payment flow decisions" --copy

# Get context for specific files
npx robrain inject --files "src/api/payments.ts,src/store/cart.ts" --copy

# Get all recent decisions
npx robrain inject --all --copy
```

Paste the output into Claude Code before your next task.

---

## CLI commands

| Command | What it does |
|---------|-------------|
| `npx robrain install --self-hosted` | Wire Sensing MCP into Claude Code / Cursor |
| `npx robrain init-project` | Warm-start memory from package.json, README, git log |
| `npx robrain review` | Inspect, edit, or delete captured decisions |
| `npx robrain review --history` | Show full decision lifecycle including superseded decisions |
| `npx robrain inject` | Get formatted context to paste into Claude Code |
| `npx robrain inject --query "..."` | Semantic search for relevant decisions |
| `npx robrain inject --files "..."` | Get decisions about specific files |
| `npx robrain inject --copy` | Copy output directly to clipboard |
| `npx robrain explain <file>` | Answer "why does this code exist?" for any file |
| `npx robrain explain <file> --why` | Full rationale + rejected alternatives per decision |
| `npx robrain rule --add "..."` | Add an explicit retrieval rule |
| `npx robrain status` | Health check |

---

## What the cloud version adds — automatic intelligence

The OSS version gives you capture, storage, and manual retrieval. The Rory Plans cloud version adds two layers that make the system feel genuinely smart rather than just useful.

### Conflict detection

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

### Pre-task rejection warnings

The OSS flow is: run `npx robrain inject`, paste context, then work. The cloud version removes the paste step entirely — and adds something the OSS version can't do.

When Control injects context at a task boundary, it scans the current task description against all stored `rejected[]` arrays. If the task mentions something previously ruled out, a warning fires *before* the agent answers:

```
⚠ Previously rejected: GraphQL — latency concerns at scale
(Apr 2024, in favour of: REST API). Proceed intentionally if this has changed.
```

This happens at the right moment — before the agent has suggested anything — not after. It's the difference between a system that reminds you of the past and one that steers you away from known mistakes before they happen.

Both features are built on top of the `rejected[]` field that the OSS version captures. The data is collected in OSS — the intelligence that acts on it is in the cloud.

**Get cloud access:** [roryplans.ai](https://roryplans.ai)

---

## Pairing with Zep

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

## Honest tradeoffs

Passive capture is more convenient than manual logging, but it comes with its own costs worth knowing before you adopt:

**False positives.** The classifier occasionally captures things that aren't real decisions — a debugging step, an exploratory suggestion, a temporary workaround. `npx robrain review` exists specifically so you can catch and delete these before they pollute future sessions. Plan to spend a few minutes reviewing after your first few sessions until you understand what the classifier catches.

**Low-confidence captures.** Not every decision is captured at high confidence. The system includes a confidence score on every decision — you may see entries marked "medium confidence" that need verification. The cloud version's calibrated prompt reduces this; the OSS version will have more of it.

**Review overhead.** The memory store is only as good as what's in it. If you never run `npx robrain review`, wrong decisions will persist and get injected into future sessions. The session-end summary helps by surfacing what was captured, but it doesn't replace occasional review.

**Trust in automated capture.** Some developers prefer knowing exactly what their agent has been told. `npx robrain review --all` shows everything stored for a project. Nothing is injected that you can't see and delete.

The alternative — CLAUDE.md maintained manually — has zero false positives but misses everything you forget to write down. RoBrain trades some review overhead for automatic capture of things that would otherwise be lost.

---

## OSS vs Rory Plans cloud

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

**Get cloud access:** [roryplans.ai](https://roryplans.ai)

---

## Troubleshooting

After setup, Sensing runs automatically whenever Claude Code is open. The MCP server is registered in `~/.claude/mcp.json`, so Claude Code starts it automatically on launch. The `CLAUDE.md` instructions tell Claude to call `sensing_start_session` at the beginning of each session and `sensing_record_turn` after every exchange.

**The one thing that can break it:**

Claude Code doesn't always follow `CLAUDE.md` instructions reliably — this is the compliance problem from pre-launch testing. If Claude stops calling `sensing_record_turn`, Sensing goes silent. The way to check:

```bash
npx robrain status
```

If `Decisions: 0` after a session where you made architectural choices, Claude probably didn't call the tools. The fix is to make the `CLAUDE.md` instructions more explicit or remind Claude at the start of the session: *"please follow the RoBrain instructions in CLAUDE.md."*

**The practical reality:**

The developer needs two habits:
- `npx robrain review` after sessions where important decisions were made
- `npx robrain inject --copy` before starting a new task that builds on prior work

Everything else — capture, extraction, storage, embedding — happens without you doing anything.

---

## Database schema

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

---

## Contributing

Apache 2.0. PRs welcome for:
- Improving the OSS extraction prompt accuracy
- Adding new editor integrations (Windsurf, Zed, etc.)
- Localization adapter backends (Cursor API, Copilot API)
- Additional embedding providers

Issues and discussions on GitHub.

---

## License

Apache 2.0 — see [LICENSE](./LICENSE)

Built by [Rory Plans](https://roryplans.ai)
