# CLI reference

Install details, editor setup, and the full command table.

[← Back to README](https://github.com/adelinamart/robrain)

## Install and setup

`pnpm docker:up` brings up Postgres + Perception in the background; the user-facing surfaces are Sensing and the `robrain` CLI. `npx robrain init-project` writes the project instructions that tell each editor's agent to call the Sensing tools at session start and end (`CLAUDE.md`, `AGENTS.md` for Codex, and `.cursor/rules/robrain.mdc` when Cursor is installed).

Self-hosted setup usually needs two keys: **`ANTHROPIC_API_KEY`** for extraction and one embedding-provider key for semantic retrieval. If that surprises you, see [Why are there two API keys in self-hosted mode?](https://github.com/adelinamart/robrain/blob/main/docs/concepts.md#why-are-there-two-api-keys-in-self-hosted-mode).

#### No clone needed (`robrain up`)

The fastest path — no git clone, no `pnpm build`:

```bash
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...   # or add them to ~/.robrain/stack/.env after the first run
npx robrain@latest up                             # Postgres + Perception from ghcr.io
npx robrain install --self-hosted                 # wire Sensing MCP into your editors
cd /path/to/your/project && npx robrain init-project
```

`robrain up` writes a managed stack under **`~/.robrain/stack/`**:

| File | Role |
|------|------|
| `docker-compose.yml` | Regenerated every run — do not edit |
| `schema.sql` | Extracted from the Perception image (version-matched) |
| `.env` | Your secrets — auto-generated once, never overwritten |

Default image: `ghcr.io/adelinamart/robrain-perception:<cli-version>`. Override with `--tag` or `--image`:

```bash
npx robrain up --tag latest
npx robrain up --image ghcr.io/adelinamart/robrain-perception:2.3.0
```

Stop the stack (data volume preserved):

```bash
npx robrain down
```

`robrain up` and the repo-clone flow (`pnpm docker:up`) are the **same compose project** (`robrain`) with the same container names and Postgres volume (`robrain_postgres_data`), so you can switch paths without losing data — copy `POSTGRES_PASSWORD` and `PERCEPTION_API_KEY` from your existing `.env` into `~/.robrain/stack/.env` if you migrate. Stacks started before v2.3.9 belong to a different compose project; `robrain up` detects their containers and prints the one-time removal command (the data volume is preserved).

`robrain install --self-hosted` copies the bundled `@robrain/sensing-mcp` package into `~/.robrain/mcp/sensing` — no clone required. `robrain install --hermes` materializes the bundled Hermes memory-provider plugin into `$HERMES_HOME/plugins/robrain` (default `~/.hermes`) the same way — see [integrations/hermes](../integrations/hermes/robrain/README.md); combine with `--self-hosted` to do both in one run. Pass **`--repo-root`** (or set `ROBRAIN_REPO`) when developing in the monorepo; that **replaces** any package-copied bundle with a symlink into your clone (macOS/Linux) or a fresh copy (Windows).

#### Portable MCP config (`robrain mcp`)

For [MCP directory listings](distribution/mcp-directories.md) or a hand-written `mcp.json`, launch Sensing without running install:

```json
{ "mcpServers": { "robrain-sensing": {
    "command": "npx", "args": ["-y", "robrain", "mcp"]
} } }
```

After `npx robrain up`, `robrain mcp` reads Perception URL and API key from `~/.robrain/config.json`. Add an `env` block with `PERCEPTION_API_URL` / `PERCEPTION_API_KEY` to override. For full editor wiring (LLM + embedding keys in the MCP env block), use `npx robrain install` instead — it writes editor-specific configs under `~/.cursor/mcp.json`, `~/.claude.json`, etc.

#### From a clone instead (development)

- Docker + Docker Compose
- Node.js **18.18+** (older 18.x + npm 9.6 can break `npx` bin permissions; upgrade Node or use `pnpm dlx robrain`), pnpm
- Anthropic API key (for Haiku extraction)
- OpenAI, Voyage, or Cohere API key (for embeddings)

From the repository root:

```bash
git clone https://github.com/adelinamart/robrain
cd robrain
cp .env.example .env
```

Edit `.env` at the repo root (the same keys power Perception in Docker and the CLI install prompts). Paste real keys from [Anthropic](https://console.anthropic.com) and your embedding provider — do not commit that file.

```
ANTHROPIC_API_KEY=
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=
```

Keep `EMBEDDING_PROVIDER` identical between this file and what you select when running install (or set `EMBEDDING_PROVIDER` in `.env` and install will pick it up without prompting).

#### What `init-project` writes

`robrain init-project` writes mode-aware instructions:

- **Free / self-hosted** (`robrain install --self-hosted`): generated `CLAUDE.md` / Cursor rule / `AGENTS.md` (Codex) uses only `sensing_*` tools.
- **Cloud / Control-enabled**: generated instructions include both `sensing_*` and `control_*` calls.

`init-project` always writes the same managed RoBrain block into `AGENTS.md` at the project root (for Codex CLI and any tool that reads AGENTS.md). If Codex CLI is installed (`~/.codex/`), `robrain install` also registers `robrain-sensing` in `~/.codex/config.toml` (use `--editor codex` to configure Codex only).

For Claude Code, `init-project` also merges a plugin recommendation into `.claude/settings.json` so teammates who trust the repo get an install prompt from Claude Code itself. Skip with `--skip-claude-plugin`. Details: [plugins/claude-code/README.md](../plugins/claude-code/README.md).

#### CLI on your `PATH` (optional)

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

#### Cursor-specific setup (most reliable path)

`robrain init-project` automatically writes `.cursor/rules/robrain.mdc` with
`alwaysApply: true`, so Cursor loads the RoBrain session-lifecycle instructions
every session. No copy-paste step is required.

To verify:

```bash
cat .cursor/rules/robrain.mdc
```

**If decisions stop landing:** the rule file is present, but Cursor's agent
sometimes ignores rule content turn-to-turn. Check the Cursor MCP panel for the
`robrain-sensing` server status, then see
[Decisions captured in the editor but `robrain review` shows nothing](https://github.com/adelinamart/robrain/blob/main/docs/troubleshooting.md#decisions-captured-in-the-editor-but-robrain-review-shows-nothing-silent-401).

Adding more rules will not fix a compliance gap. That is a Cursor-side behavior
that Rory Plans cloud layers additional safeguards against (see
[Free / self-hosted vs Rory Plans cloud](https://github.com/adelinamart/robrain/blob/main/docs/concepts.md#free--self-hosted-vs-rory-plans-cloud)).

### Codex CLI setup

`robrain install` (or `robrain install --editor codex`) writes a marker-bounded
`robrain-sensing` block into `~/.codex/config.toml`, including a `[hooks]` section
that points at scripts under `~/.robrain/hooks/codex/` (SessionStart, UserPromptSubmit,
Stop — same lifecycle as the Claude Code plugin). Codex asks you to **trust the hooks**
on first run. `init-project` always updates `AGENTS.md` at the project root with the
same session-lifecycle instructions as `CLAUDE.md`.

To verify:

```bash
grep -A2 'robrain-sensing' ~/.codex/config.toml
grep -A6 '\[hooks\]' ~/.codex/config.toml    # SessionStart / UserPromptSubmit / Stop paths
grep 'project_id=' AGENTS.md
codex mcp list   # optional — confirm robrain-sensing is enabled
```

Restart the Codex CLI session after install so it reloads MCP config and hooks. If captures
stop landing, check `PERCEPTION_API_KEY` in the managed block (see [troubleshooting](https://github.com/adelinamart/robrain/blob/main/docs/troubleshooting.md)) and confirm the agent is following the RoBrain section in `AGENTS.md`.

## Upgrading

When a new RoBrain release is out, update every layer you installed: the **CLI** (`npx` or global), the **Perception Docker image**, and **editor MCP configs**. Postgres data and your `.env` secrets stay in place — you are not reinstalling from scratch.

**Maintainers:** see **[docs/release.md](release.md)** for the full tag → GHCR → npm → MCP registry checklist (including the release guard).

Check what you are running: `npx robrain --version`. Compare with [GitHub — Releases](https://github.com/adelinamart/robrain/releases) or the latest `main` branch.

### No-clone stack (`robrain up`)

```bash
npx robrain@latest up --tag <version>    # pull new Perception image; same ~/.robrain/stack/.env
npx robrain@latest install --self-hosted   # refresh editor MCP configs + sensing bundle
```

Fully quit and reopen editors after install (`Cmd-Q` on macOS, then reopen).

### Self-hosted from a clone (typical)

From the **robrain repo root** (same directory as `docker/` and `.env`):

```bash
git pull
pnpm install && pnpm build
pnpm docker:up:build
npx robrain install --self-hosted --repo-root "$(pwd)"
```

| Step | Why it matters |
|------|----------------|
| `git pull` + `pnpm build` | Picks up CLI, Sensing MCP, and shared package changes |
| `pnpm docker:up:build` | Rebuilds Perception and applies startup DB migrations — **pulling code alone leaves the old container running** |
| `robrain install --self-hosted` | Refreshes MCP server paths and env in Cursor, Claude Code, Codex, and Copilot |
| **Fully quit and reopen editors** | Closing a chat does not reload the MCP child process or its environment (`Cmd-Q` on macOS, then reopen) |

Application repos usually **do not** need `init-project` again. Re-run it only if release notes call out changes to `CLAUDE.md`, `AGENTS.md`, or `.cursor/rules/robrain.mdc`.

More detail on stale containers and schema drift: [Troubleshooting — Stale Perception Docker image](https://github.com/adelinamart/robrain/blob/main/docs/troubleshooting.md#stale-perception-docker-image-migrations--schema-out-of-sync).

### Global CLI (`npm install -g robrain`)

```bash
npm install -g robrain@latest
npx robrain up --tag latest          # if you use the no-clone stack
npx robrain install --self-hosted    # refresh editor configs + sensing bundle
```

For the **clone path**, a global CLI update alone is not enough — Perception still requires `pnpm docker:up:build` from the repo:

```bash
cd /path/to/robrain
git pull && pnpm install && pnpm build
pnpm docker:up:build
npx robrain install --self-hosted --repo-root "$(pwd)"
```

### Verify after upgrading

```bash
curl -sf "http://localhost:${PERCEPTION_PORT:-3001}/health"
npx robrain status
```

If captures or review behave oddly after an upgrade, see [Troubleshooting](https://github.com/adelinamart/robrain/blob/main/docs/troubleshooting.md).

## Why does this code exist?

The judgment layer pays off when you need file-scoped history — decisions plus vetoes, not just “we use Zustand”:

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

Works on files, directories, or any path RoBrain has seen in a session. With Synthesis-fed `planning_blocks`, the same command can surface topic-level truth and cross-corpus conflicts the reactive path never linked.

---

## CLI commands

All commands accept `--help` for full flag details. Repo-level `pnpm` scripts live in `package.json`; CLI commands live in `packages/cli`.

| Command | What it does |
|---------|-------------|
| `npx robrain up` | Start Postgres + Perception from the published GHCR image (no clone); writes `~/.robrain/stack/` |
| `npx robrain up --tag <tag>` | Perception image tag (default: CLI version) |
| `npx robrain up --image <image>` | Full image override (wins over `--tag`) |
| `npx robrain down` | Stop the `robrain up` stack; data volume `robrain_postgres_data` is preserved |
| `npx robrain mcp` | Run the bundled Sensing MCP server over stdio (portable `mcp.json` / MCP directory configs; reads Perception from `~/.robrain/config.json`) |
| `pnpm install:self-hosted` | Build everything + run `robrain install --self-hosted --repo-root .` in one shot |
| `pnpm build` | Compile all workspace packages (`pnpm -r build`) — run after `pnpm install` in the robrain clone |
| `pnpm docker:up` | Start Postgres + Perception (uses `.env`) |
| `pnpm docker:up:build` | Same, but force a rebuild of Perception |
| `pnpm docker:build` | Rebuild Perception image without starting |
| `pnpm docker:down` | Stop the stack |
| `pnpm synthesis:build` | Compile `@robrain/synthesis` before running it |
| `pnpm synthesis:dry-run` | Run Synthesis with `SYNTHESIS_DRY_RUN=true` (no DB writes) |
| `npx robrain install --self-hosted` | Wire Sensing MCP into detected editors (Claude Code, Cursor, Codex, Copilot); then runs **`init-project` in the current directory** by default |
| `npx robrain install --hermes` | Install the bundled Hermes memory-provider plugin into `$HERMES_HOME/plugins/robrain` (combine with `--self-hosted`) |
| `npx robrain install --token <token>` | Authenticate against Rory Plans cloud (or set `RORY_TOKEN`) |
| `npx robrain install --editor <claude-code\|cursor\|copilot\|codex>` | Target a specific editor instead of all detected |
| `npx robrain install --perception-url <url>` | Override Perception URL for self-hosted (default `http://localhost:3001`) |
| `npx robrain install --repo-root <path>` | Dev override: symlink/copy sensing-mcp from the clone (replaces any package-copied bundle; or set `ROBRAIN_REPO`) |
| `npx robrain install --skip-init-project` | Wire editors only — do not run **`init-project`** in the current directory after install |
| `npx robrain init-project` | Warm-start memory from package.json, README, git log; recommends the Claude Code plugin in `.claude/settings.json` |
| `npx robrain init-project --project-id <id>` | Override the auto-derived project ID (useful after `projects merge`) |
| `npx robrain init-project --skip-claude-plugin` | Do not write the RoBrain plugin recommendation to `.claude/settings.json` |
| `npx robrain init` | Alias for `init-project` |
| `npx robrain projects list` | List Perception projects with session/decision counts (recover phantom ids) |
| `npx robrain projects merge <from-id> <to-id>` | Merge one project id into another in the database |
| `npx robrain review` | Inspect, edit, or delete captured decisions; conflict **“keep”** can persist a **`related_to`** edge when Perception returns a counterpart id so Synthesis stops re-flagging the pair |
| `npx robrain review --session <id>` | Review a specific session (default: last session) |
| `npx robrain review --all` | Show all active decisions, not only the last session |
| `npx robrain review --limit <n>` | Max decisions to fetch (default: **20**) |
| `npx robrain review --history` | Show full decision lifecycle including superseded decisions |
| `npx robrain review --approve-all` | Bulk-approve every reviewable decision in the current fetch (no prompts per row) |
| `npx robrain export-memory` | Export approved decisions into Claude Code auto-memory files; optional **`--cwd`** / **`--project-id`** for non-interactive paths (Synthesis F2) |
| `npx robrain export-memory --dry-run` | Preview the file plan without touching disk |
| `npx robrain export-memory --include-unreviewed` | Also export decisions not yet approved (not recommended) |
| `npx robrain export-memory --to <dir>` | Write to a custom memory dir instead of `~/.claude/projects/<slug>/memory` |
| `npx robrain export-memory --ledger` | Also write a single git-committed decisions ledger (default: `<project>/decisions.md`); DB is source of truth — file is regenerated each run |
| `npx robrain export-memory --ledger <path>` | Same as `--ledger`, but write to a custom path under the project root (e.g. `docs/decisions.md`) |
| `npx robrain export --format interchange` | Dump the full decision corpus (lifecycle included) as JSONL, one memory per line, format **`robrain-memory/v1`** — spec in [docs/memory-interchange.md](https://github.com/adelinamart/robrain/blob/main/docs/memory-interchange.md). JSONL goes to stdout (pipe-friendly); status to stderr |
| `npx robrain export --format interchange --out <file>` | Same, written to a file instead of stdout; optional **`--cwd`** / **`--project-id`** |
| `npx robrain outcomes` | Scan git history for revert commits (subject starts with **`Revert`**), match them to stored decisions by file overlap + 90-day window, and record **`revert`** outcomes (lowers `historical_relevance`, flags the decision for review) |
| `npx robrain outcomes --since <ref\|date>` | Scan window: a git ref (**`<ref>..HEAD`**) or a date git understands (default: **"30 days ago"**) |
| `npx robrain outcomes --dry-run` | Show matched decisions without recording anything |
| `npx robrain outcomes record <decision-id> --outcome <revert\|incident\|confirmed>` | Manually record an outcome; optional **`--evidence "<text>"`** (commit hash, incident link) |
| `npx robrain inject` | Get formatted context to paste into Claude Code |
| `npx robrain inject --query "..."` | Semantic search for relevant decisions |
| `npx robrain inject --files "..."` | Get decisions about specific files |
| `npx robrain inject --copy` | Copy output directly to clipboard |
| `npx robrain inject --all` | Request up to **100** decisions (server cap): all **unreviewed** without `--query`, or a wider semantic pool with `--query` |
| `npx robrain inject --limit <n>` | Cap how many decisions are returned (default: **5**) |
| `npx robrain doctor` | Run install diagnostics for editors, MCP wiring, and Perception connectivity |
| `npx robrain explain <file>` | Answer "why does this code exist?" for any file |
| `npx robrain explain <file> --why` | Full rationale + rejected alternatives per decision |
| `npx robrain explain <file> --copy` | Copy explain output to the clipboard |
| `npx robrain rule --add "..."` | Add a Planning rule (**Rory Plans cloud** — requires `planningUrl` in config) |
| `npx robrain rule --list` | List rules from Planning **`GET /facts`** when cloud is configured; OSS-only prints guidance |
| `npx robrain rule --type <type>` | When using **`--add`**, set rule type: **`always_include`**, **`always_exclude`**, or **`preference`** (default: **`preference`**) |
| `npx robrain status` | Auth + Perception/Planning health + **active decision count** for the current project |
| `npx robrain logout` | Clear locally stored credentials (Rory Plans token / install state) |
| `pnpm synthesis:run` | **[Synthesis](https://github.com/adelinamart/robrain/blob/main/docs/concepts.md#synthesis)** — batch job from **robrain repo root** (`pnpm` must resolve `@robrain/synthesis`) |
| `npx robrain synth` | Same job via CLI: optional **`--dry-run`**, **`--full`**, **`--lookback <n>`**, **`--project <id>`**. Resolves the robrain monorepo from this CLI package unless **`ROBRAIN_REPO`** is set (needed for some global installs). |

