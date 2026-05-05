# RoBrain — Cursor Context

## What this is

RoBrain is an institutional memory system for AI coding agents. It passively captures architectural decisions, rationale, and rejected alternatives from Claude Code / Cursor sessions and makes them available across future sessions.

Built as a TypeScript monorepo with four packages. Apache 2.0.

---

## Monorepo structure

```
packages/
├── sensing-mcp/              MCP server — runs locally alongside Claude Code/Cursor
│   ├── src/index.ts          Entry point — exposes 4 MCP tools to the editor
│   ├── src/buffer.ts         Stream buffer — captures turns instantly, non-blocking
│   ├── src/embeddings.ts     Embedding provider abstraction (OpenAI/Voyage/Cohere)
│   ├── src/router.ts         Routes classifier output to Perception API
│   └── src/classifiers/      Decision classifier + topic-shift + reply scorer
│
├── perception-self-hosted/   HTTP API — receives signals, extracts decisions, writes to Postgres
│   └── src/index.ts          Hono server — all routes including GET /decisions for review+inject
│
├── cli/                      npx robrain — developer-facing CLI
│   ├── src/index.ts          Commander entry point — all commands defined here
│   ├── src/commands/
│   │   ├── install.ts        robrain install [--self-hosted] — wires MCP into editor
│   │   ├── init-project.ts   robrain init-project — warm-starts memory from codebase
│   │   ├── review.ts         robrain review — inspect/edit/delete captured decisions
│   │   ├── inject.ts         robrain inject — get context to paste into Claude Code
│   │   └── status.ts         robrain status / rule / logout
│   └── src/lib/
│       ├── config.ts         ~/.robrain/config.json read/write
│       ├── auth.ts           Rory Plans API auth (cloud mode)
│       ├── editor.ts         Editor detection + MCP config writer + CLAUDE.md writer
│       └── project.ts        Project ID derivation + warm-start memory seeding
│
└── shared/
    ├── schema.sql            Postgres schema — decisions table with rejected[] array
    └── src/types.ts          Shared TypeScript types across all packages
```

---

## Key concepts

**The `rejected[]` array** is the core differentiator. Every stored decision includes what was tried and ruled out:
```typescript
{
  decision: "Use Zustand for state management",
  rationale: "Redux caused re-render issues in cart",
  rejected: [
    { option: "Redux", reason: "re-render performance issues" },
    { option: "MobX",  reason: "team unfamiliar" }
  ]
}
```

**Passive capture** — Sensing MCP watches every Claude Code session turn automatically. No `remember()` call needed.

**OSS vs cloud** — this repo is the OSS version. It captures and stores decisions. The Rory Plans cloud version (roryplans.ai) adds automatic context injection via Planning API + Control MCP so retrieved memories surface in sessions without manual paste.

---

## How the data flows

```
Claude Code session
      ↓
sensing-mcp (local)
  → buffers every turn
  → classifies decisions async (Haiku)
  → routes signals to Perception API
      ↓
perception-self-hosted (Docker / localhost:3001)
  → extracts decision + rationale + rejected[]
  → embeds with pgvector
  → writes to Postgres decisions table
      ↓
robrain review     — developer inspects/edits/deletes
robrain inject     — developer gets formatted context to paste into Claude Code
```

---

## Environment variables

Sensing MCP needs: `ANTHROPIC_API_KEY`, `EMBEDDING_PROVIDER`, embedding API key, `PERCEPTION_API_URL`

Perception needs: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `EMBEDDING_PROVIDER`, embedding API key

See the repo-root `.env.example` (canonical for Docker + `robrain install`), and `packages/sensing-mcp/.env.example` for local MCP-only runs.

**Critical:** `EMBEDDING_PROVIDER` and model must be identical in Sensing and Perception. Different providers produce vectors in incompatible spaces — similarity search breaks silently.

---

## Running locally

```bash
# Start Postgres + Perception (run from repo root; requires `.env`)
cp .env.example .env   # fill in keys once
pnpm docker:up

# Install dependencies and build
pnpm install && pnpm build

# Wire into Claude Code / Cursor
pnpm cli install --self-hosted

# Initialize a project (run in your repo)
pnpm cli init-project

# After sessions
pnpm cli review
pnpm cli inject --query "auth decisions" --copy
```

---

## What NOT to build in this repo

Planning API, Control MCP, and the veto-preserving Haiku extraction prompt are part of the Rory Plans cloud product and are intentionally not in this repo. PRs adding these will not be merged. See CONTRIBUTING.md.
