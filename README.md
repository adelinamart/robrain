# RoBrain

**Stop watching your AI agent repeat the same mistakes.**

RoBrain remembers architectural decisions, rationale, and rejected alternatives from your AI coding sessions — so the next session already knows what was tried, what was ruled out, and why.

Works across Claude Code, Cursor, and Copilot sessions.

```bash
# Install and start
git clone https://github.com/roryplans/robrain
cd robrain && cp docker/.env.example docker/.env
# Add your ANTHROPIC_API_KEY and OPENAI_API_KEY to docker/.env
pnpm docker:up

# Register Sensing MCP with Claude Code
npx robrain install --self-hosted

# Initialize your project
npx robrain init-project

# After sessions: review what was captured
npx robrain review

# Get context to paste into Claude Code
npx robrain inject --query "auth decisions" --copy
```

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

---

## What gets captured — and what doesn't

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

```bash
git clone https://github.com/roryplans/robrain
cd robrain
cp docker/.env.example docker/.env
```

Edit `docker/.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

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

```bash
pnpm install && pnpm build

# Register Sensing MCP with Claude Code
npx robrain install --self-hosted --perception-url http://localhost:3001

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
| `npx robrain inject` | Get formatted context to paste into Claude Code |
| `npx robrain inject --query "..."` | Semantic search for relevant decisions |
| `npx robrain inject --files "..."` | Get decisions about specific files |
| `npx robrain inject --copy` | Copy output directly to clipboard |
| `npx robrain rule --add "..."` | Add an explicit retrieval rule |
| `npx robrain status` | Health check |

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

The self-hosted version is fully functional for solo developers. The cloud version adds automatic injection — you stop pasting and it just works.

| Feature | OSS self-hosted | Rory Plans cloud |
|---------|----------------|-----------------|
| Passive session capture | ✓ | ✓ |
| `rejected[]` array | ✓ | ✓ |
| `npx robrain review` CLI | ✓ | ✓ |
| `npx robrain inject` (manual paste) | ✓ | ✓ |
| Self-host on your infra | ✓ | — |
| Basic Haiku extraction | ✓ | ✓ |
| Calibrated extraction prompt | — | ✓ more accurate |
| Automatic task-boundary injection | — | ✓ no paste needed |
| Planning scorer (4-signal relevance) | — | ✓ |
| Web dashboard | — | ✓ |
| Team memory + scope | — | ✓ |
| Conflict auto-resolution | — | ✓ |
| Unlimited decisions | up to your Postgres | ✓ |

The OSS extraction prompt is functional but without the calibrated few-shot examples and veto-preserving logic in the cloud version. You'll get most decisions correctly — the cloud version gets you even closer. We'll publish benchmark data once we have enough real-session data to report it honestly.

**Get cloud access:** [roryplans.ai](https://roryplans.ai)

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
