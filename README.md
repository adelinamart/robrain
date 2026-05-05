# RoBrain

**Institutional memory for AI coding agents.**

RoBrain remembers architectural decisions, rationale, and rejected alternatives from your AI coding sessions, so future agents stop repeating old mistakes.
Works across Claude Code, Cursor, and Copilot sessions.

```bash
# Install and start
git clone https://github.com/roryplans/robrain
cd robrain && cp docker/.env.example docker/.env
# Add your ANTHROPIC_API_KEY and OPENAI_API_KEY to docker/.env
pnpm docker:up

# Register Sensing MCP with Claude Code
pnpm cli install --self-hosted

# Initialize your project
pnpm cli init-project

# After sessions: review what was captured
pnpm cli review

# Get context to paste into Claude Code
pnpm cli inject --query "auth decisions" --copy
```

---

## What makes this different

Every other memory tool requires you to call `remember()`. RoBrain doesn't. It watches your Claude Code sessions passively and captures decisions automatically — including **what was tried and ruled out**.

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
  robrain inject --query "state management" --copy
  
  → Pastes into Claude Code:
  "• Chose Zustand over Redux (re-render performance) — Mar 15, high confidence"
```

Six sessions later, Claude Code knows why your codebase looks the way it does.

---

## The `rejected[]` array

Your AI agent resets every session. 
 Mem0 stores facts. Zep stores entity relationships. Neither stores what was tried and ruled out — which means your agent will keep suggesting Redux until you tell it again.

RoBrain stores the veto. That's the differentiator.

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
pnpm cli install --self-hosted --perception-url http://localhost:3001

# Initialize your project (run in your repo root)
cd /path/to/your/project
pnpm robrain init-project
```

### 4. Start a Claude Code session

Open Claude Code normally. Sensing watches in the background.

### 5. Review what was captured

```bash
robrain review
```

### 6. Inject context into Claude Code

```bash
# Search for relevant decisions
robrain inject --query "payment flow decisions" --copy

# Get context for specific files
robrain inject --files "src/api/payments.ts,src/store/cart.ts" --copy

# Get all recent decisions
robrain inject --all --copy
```

Paste the output into Claude Code before your next task.

---

## CLI commands

| Command | What it does |
|---------|-------------|
| `robrain install --self-hosted` | Wire Sensing MCP into Claude Code / Cursor |
| `robrain init-project` | Warm-start memory from package.json, README, git log |
| `robrain review` | Inspect, edit, or delete captured decisions |
| `robrain inject` | Get formatted context to paste into Claude Code |
| `robrain inject --query "..."` | Semantic search for relevant decisions |
| `robrain inject --files "..."` | Get decisions about specific files |
| `robrain inject --copy` | Copy output directly to clipboard |
| `robrain rule --add "..."` | Add an explicit retrieval rule |
| `robrain status` | Health check |

---

## OSS vs Rory Plans cloud

The self-hosted version is fully functional for solo developers. The cloud version adds automatic injection — you stop pasting and it just works.

| Feature | OSS self-hosted | Rory Plans cloud |
|---------|----------------|-----------------|
| Passive session capture | ✓ | ✓ |
| `rejected[]` array | ✓ | ✓ |
| `robrain review` CLI | ✓ | ✓ |
| `robrain inject` (manual paste) | ✓ | ✓ |
| Self-host on your infra | ✓ | — |
| Basic Haiku extraction | ✓ | ✓ |
| Calibrated extraction prompt | — | ✓ more accurate |
| Automatic task-boundary injection | — | ✓ no paste needed |
| Planning scorer (4-signal relevance) | — | ✓ |
| Disengagement protocol | — | ✓ |
| Web dashboard | — | ✓ |
| Team memory + scope | — | ✓ |
| Conflict auto-resolution | — | ✓ |
| Unlimited decisions | up to your Postgres | ✓ |

The OSS extraction prompt is functional but without the calibrated few-shot examples and veto-preserving logic in the cloud version. You'll get most of decisions correctly — the cloud version gets you even closer.

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
