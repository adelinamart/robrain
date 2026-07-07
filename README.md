# RoBrain

**Shared memory across your team and your AI agents — with judgment about what's worth keeping.**

RoBrain isn't just another memory layer — it's the brain that helps you and your agents make better decisions and avoid costly mistakes.

Self-hosted on your own Postgres. Passive capture, structured vetoes, corpus-wide contradiction scans — nothing leaves your machine. Works with Claude Code, Cursor, GitHub Copilot (VS Code), and Codex CLI.

## What it is

RoBrain records what your team and its agents decide — and the alternatives they ruled out — without anyone tagging anything by hand. Sensing captures session turns; Perception extracts each decision into Postgres, where every row can carry a structured `rejected[]` field.

Most agent-memory tools stop at capture: they store what happened and hope you query it later. RoBrain adds judgment. Batch **Synthesis** reads the whole corpus to flag contradictions, stance drift, and recurring entities that no single session could see.

The point is the handoff. Someone makes a deliberate call in Cursor on Tuesday — say, keeping Perception on Hono instead of porting to Express. A new teammate opens Claude Code on Wednesday with no memory of it and asks to make exactly that change. RoBrain surfaces the recorded rationale before the agent steers down a path you already rejected — same Postgres store, same vetoes, captured passively.

> The cost of forgetting a rejection isn't inefficiency. It's the auth bypass you already patched, the migration you already rolled back, the dependency you already removed for a CVE — re-suggested by an agent with no memory of why you said no.

Coding is the first vertical because the feedback loops are tight — reverts, incidents, and rework make the cost of a forgotten rejection measurable. The same architecture applies wherever agents make decisions that outlast a session.

How it works, the two pillars (capture + judgment), and the full walkthrough: [docs/concepts.md](docs/concepts.md#how-it-works).

## Install

First `pnpm docker:up` auto-creates `.env` and fills `PERCEPTION_API_KEY` / `POSTGRES_PASSWORD`. Perception still needs your LLM + embedding keys before it stays up.

```bash
git clone https://github.com/adelinamart/robrain
cd robrain
pnpm install && pnpm build
pnpm docker:up                 # first run: creates .env; Perception won't start yet
# open .env, add ANTHROPIC_API_KEY + your embedding key (e.g. OPENAI_API_KEY)
pnpm docker:up                 # second run: Perception now boots
npx robrain install --self-hosted --repo-root "$(pwd)"
```

OpenAI-only: set `LLM_PROVIDER=openai` and `OPENAI_API_KEY` instead of Anthropic — see [Concepts — Prefer not to use Anthropic](docs/concepts.md#prefer-not-to-use-anthropic-run-openai-only).

Upgrading on a new release, from your robrain clone: `git pull` → `pnpm install && pnpm build` → `pnpm docker:up:build` → `npx robrain install --self-hosted --repo-root "$(pwd)"` → fully restart editors. Full checklist: [CLI reference — Upgrading](docs/cli.md#upgrading).

## Quickstart

```bash
# Wire capture into an application project (run inside the repo)
cd /path/to/your/project
npx robrain init-project          # writes CLAUDE.md, AGENTS.md, .cursor/rules/robrain.mdc

# Capture and recall are automatic from here:
#   - every session turn is classified, no tagging
#   - prior decisions load at session start via the always-on summary

# Explain any file's decision history
npx robrain explain path/to/file

# Run corpus judgment (manual, or add to cron)
npx robrain synth                 # drift, contradictions, entity promotion
npx robrain review                # inspect / approve captured rows
```

After `init-project`, every repo gets `CLAUDE.md` and `AGENTS.md` (Codex CLI), and Cursor also gets `.cursor/rules/robrain.mdc` with `alwaysApply: true`. If captures don't land: [Troubleshooting](docs/troubleshooting.md).

## Synthesis

Synthesis runs three passes over the full `decisions` table — **drift** (stance moving without an explicit reversal), **contradictions** (incompatible decisions from different sessions), and **entity promotion** (recurring tools/patterns condensed into `planning_blocks`). It writes flags and edges into your DB; it does not capture new decisions — it judges the corpus you already have.

```bash
pnpm synthesis:build && pnpm synthesis:run
# or: npx robrain synth
```

Review what it finds with `npx robrain review`. Deep dive (three passes, cron, env vars): [Concepts — Synthesis](docs/concepts.md#synthesis).

## Editor integration

One cross-tool setup covers **Claude Code, Cursor, GitHub Copilot (VS Code), and Codex CLI** against the same Postgres store. The classifier LLM is your choice — Anthropic Haiku or OpenAI. Decisions carry a lifecycle (active / superseded / invalidated) and a graph (`conflicts_with` / `extends` / `related_to`).

Decision ledger for git (opt-in):

```bash
npx robrain export-memory --ledger
# custom path: npx robrain export-memory --ledger docs/decisions.md
```

## Compared to other tools

Versus **Mem0**, **Cloudflare Agent Memory**, and **Claude Code Auto-Memory**: only RoBrain stores rejected alternatives as structured fields and runs scheduled corpus-wide contradiction scans. [Full comparison →](docs/concepts.md#comparisons)

### Self-hosted vs Rory Plans cloud

| Feature | Free / self-hosted | Rory Plans cloud |
|---------|-------------------|------------------|
| Passive session capture | ✓ | ✓ |
| `rejected[]` field as structured data | ✓ | ✓ |
| Decision lifecycle (active / superseded / invalidated) | ✓ | ✓ |
| Cross-tool MCP — Claude Code, Cursor, Copilot, Codex CLI | ✓ | ✓ |
| Classifier LLM choice — Anthropic Haiku or OpenAI | ✓ | ✓ |
| Always-on summary at session start | ✓ | ✓ |
| `npx robrain review` | ✓ | ✓ |
| `npx robrain inject` (manual paste) | ✓ | ✓ |
| `npx robrain explain <file>` | ✓ | ✓ |
| `npx robrain export-memory` → Claude auto-memory + ledger | ✓ | ✓ |
| Synthesis — drift, contradictions, entity promotion | ✓ | ✓ |
| Decision graph (`conflicts_with` / `extends` / `related_to`) | ✓ | ✓ |
| Self-host on your infrastructure | ✓ | — |
| Your data stays local | ✓ | processed remotely |
| Calibrated extraction prompt (fewer false positives) | — | ✓ |
| Calibrated 4-way contradiction taxonomy | — | ✓ |
| Automatic injection at task boundaries | — | ✓ |
| Pre-task `rejected[]` warning | — | ✓ |
| Disengagement protocol (⚠ acknowledgement) | — | ✓ |
| Full 5-signal relevance scorer | — | ✓ |
| Conflict auto-resolution + dashboard visualizations | — | ✓ |
| Team memory — managed multi-user store | — | ✓ |
| Web dashboard | — | ✓ |

Self-hosted gives capture, judgment batch jobs, and session-start recall; you pull focused context with `inject` when needed. Cloud adds Planning + Control so vetoes and conflicts surface before the agent acts. Details: [Concepts — Free / self-hosted vs Rory Plans cloud](docs/concepts.md#free--self-hosted-vs-rory-plans-cloud).

## Security

The memory corpus is guarded by `PERCEPTION_API_KEY` — a random secret in the repo-root `.env` that every client (Sensing MCP, CLI, Synthesis) sends as a Bearer token and Perception verifies on every request except `/health`. It is not issued by any service: `pnpm docker:up` generates one automatically on first run, or set your own (e.g. `openssl rand -hex 32`). `npx robrain install --self-hosted` copies the same value into your editor configs so clients authenticate.

Perception refuses to start when the key is empty — running unauthenticated requires an explicit opt-in. **Upgrading from a version that ran without a key:** add one to `.env` (or re-run `pnpm docker:up` to auto-fill it), then re-run `npx robrain install --self-hosted` so editors pick it up. Details and the opt-in flag are documented in [`.env.example`](.env.example).

Also on by default: secrets redaction (API keys, tokens, private keys, connection-string passwords are scrubbed at capture and again at ingest, before anything is embedded or stored), and a fully-local mode where extraction and embeddings run on an OpenAI-compatible local server — see [`.env.example`](.env.example).

## What's next

`robrain outcomes` now feeds git reverts back into memory quality; next is widening that to incidents and cycle time, so RoBrain can surface when a team is optimizing for the wrong thing in its own codebase.

## Requirements

- Docker + Docker Compose (runs Postgres and Perception locally)
- Node.js with pnpm (build and CLI)
- An LLM key for the classifier — Anthropic Haiku or OpenAI
- An embedding key (e.g. OpenAI)
- No data leaves your machine in self-hosted mode

## Docs

- Concepts (how it works, two pillars, Synthesis, comparisons) → [docs/concepts.md](docs/concepts.md)
- CLI reference (`explain`, install, upgrading, editor setup, full command table) → [docs/cli.md](docs/cli.md)
- Troubleshooting (silent 401s, Docker rebuilds, stale summaries) → [docs/troubleshooting.md](docs/troubleshooting.md)
- Memory interchange format (`robrain export`, `robrain-memory/v1` JSONL) → [docs/memory-interchange.md](docs/memory-interchange.md)

## Contributing

Apache 2.0. PRs welcome for extraction accuracy, new editor integrations, and embedding providers. See [Concepts — Reference](docs/concepts.md#reference) for tradeoffs and schema.

## License

Apache 2.0 — see [LICENSE](./LICENSE)

Built by [Rory Plans](https://roryplans.ai)
