# Troubleshooting

401 debugging, Docker rebuilds, stale summaries, and verification commands.

[← Back to README](https://github.com/adelinamart/robrain)

**New release?** See **[CLI reference — Upgrading](https://github.com/adelinamart/robrain/blob/main/docs/cli.md#upgrading)** for the full pull → build → `docker:up:build` → reinstall → restart-editor checklist.

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

### Decisions captured in the editor but `robrain review` shows nothing (silent 401)

The most common silent failure: the editor's MCP panel shows Sensing as connected, you made decisions in chats, but `robrain review --history` or a direct DB query returns nothing. Perception is rejecting every signal with **401 Unauthorized** and Sensing has no way to surface that back to the editor.

**1. Check the API key wired into the MCP env:**

```bash
grep PERCEPTION_API_KEY ~/.cursor/mcp.json          # Cursor
grep PERCEPTION_API_KEY ~/.claude.json | head       # Claude Code
grep PERCEPTION_API_KEY ~/.codex/config.toml        # Codex CLI
```

If you see `"PERCEPTION_API_KEY": ""`, that's the bug. Versions of `robrain` **< 2.3.1** could write it as empty even when `.env` had a key. Upgrade and reinstall:

```bash
npm install -g robrain@latest          # global install
# — or from a clone of the repo —
pnpm install:self-hosted
```

**2. Inspect Sensing MCP's stderr — the only place 401s surface:**

```bash
# Cursor — tail the Sensing MCP stderr from the most recent log dir
LATEST=$(ls -td ~/Library/Application\ Support/Cursor/logs/*/ | head -1)
find "$LATEST" -name "MCP user-robrain-sensing.log" -exec tail -30 {} \;
```

Look for `[Sensing] Perception API error: 401` or `always-on summary fetch failed: 401`. If you see them, the key in the editor's MCP env doesn't match Perception's `PERCEPTION_API_KEY`.

**3. Fully restart the editor — closing the chat is not enough.**

Cursor and Claude Code cache the spawned MCP **child process** with its initial env. Closing a chat or window keeps that child alive with the old (empty) env. Use **`Cmd-Q`** on the editor entirely, then reopen.

### Verifying a decision actually landed

```bash
# Compute your project_id (deterministic 12-char hash of the absolute repo path)
echo -n "/absolute/path/to/your/repo" | shasum -a 256 | awk '{print substr($1,1,12)}'

# Direct DB query — substitute <project_id>
docker exec -i robrain-postgres psql -U robrain -d robrain -c \
  "SELECT created_at, decision, rejected
   FROM context_system.decisions
   WHERE project_id='<project_id>' AND created_at > NOW() - INTERVAL '15 minutes'
   ORDER BY created_at DESC;"

# Or via Perception API (Authorization required)
curl -s -H "Authorization: Bearer <PERCEPTION_API_KEY>" \
  "http://localhost:3001/decisions?project_id=<project_id>&history=true&limit=20"
```

### Decision is in the DB but the next session doesn't surface it

The always-on summary is **cached on the project row**. Fresh decisions normally trigger regeneration, but a missed regen leaves the cache stale. Force one:

```bash
curl -s -X POST -H "Authorization: Bearer <PERCEPTION_API_KEY>" \
  "http://localhost:3001/projects/<project_id>/regenerate-summary"
```

Then start a **new** Claude Code / Cursor session so `sensing_start_session` pulls the regenerated summary.

### `Conflict. The container name "/robrain-postgres" is already in use`

Upgrading a clone that ran before the compose project name was pinned. Those containers belong to project `docker`; the stack now uses `robrain`, and Compose cannot adopt containers across projects.

**Your data is not at risk.** The database lives in the named volume `robrain_postgres_data`, which is not project-scoped — removing containers does not touch it.

```bash
docker compose -p docker down   # containers only; the volume is preserved
pnpm docker:up
```

`pnpm docker:up` and `npx robrain up` both refuse to run when they find this and print the same fix, so you should see guidance rather than the raw Docker error. If you hit the bare error, you're on an older CLI — the commands above still apply.

**Do not** recreate a single service to "get around" it. Recreating only Perception leaves Postgres on the old network and Perception on the new one, and Perception then dies with `getaddrinfo ENOTFOUND postgres` — a healthy database that merely looks broken. Migrate the whole stack with the two commands above.

**Never add `-v`** to `docker compose down` here — that deletes the volume, which is the one thing that isn't recoverable.

### Fully-local LLM: Sensing fails with `host.docker.internal`

With a local OpenAI-compatible server (Ollama / LM Studio / vLLM) and Perception in Docker, a single `OPENAI_BASE_URL=http://host.docker.internal:…` breaks host processes: Sensing MCP and Synthesis need `127.0.0.1`. Set both URLs using **your** server’s port (not tied to a model — common defaults: Ollama `11434`, LM Studio `1234`, vLLM `8000`). Full steps: [CLI — Fully-local LLM](cli.md#fully-local-llm-ollama--lm-studio--vllm).

```bash
OPENAI_BASE_URL=http://host.docker.internal:<port>/v1
OPENAI_HOST_BASE_URL=http://127.0.0.1:<port>/v1
LLM_PROVIDER=openai
EMBEDDING_PROVIDER=openai
```

Then rebuild, reinstall, and fully quit the editor so MCP reloads env:

```bash
pnpm docker:up:build                 # or: npx robrain up  (no-clone stack)
pnpm install:self-hosted             # or: npx robrain install --self-hosted
```

Confirm editor configs have **both** vars (`OPENAI_HOST_BASE_URL` is what Sensing uses on the host):

```bash
python3 -c "import json; e=json.load(open('$HOME/.cursor/mcp.json'))['mcpServers']['robrain-sensing']['env']; print(e.get('OPENAI_BASE_URL')); print(e.get('OPENAI_HOST_BASE_URL'))"
```

Also verify Perception can reach the local server:

```bash
docker exec robrain-perception printenv OPENAI_BASE_URL
docker exec robrain-perception curl -sf http://host.docker.internal:<port>/api/tags
```

### Perception container unhealthy or refusing to start

```bash
docker ps | grep robrain-perception
docker inspect robrain-perception --format='{{.State.Health.Status}}'
docker logs --tail=80 robrain-perception
```

If Perception logs `Refusing to start: PERCEPTION_API_KEY is empty`, put a key in `<repo-root>/.env`:

```bash
PERCEPTION_API_KEY=<any-long-random-string>
```

Then rebuild:

```bash
pnpm docker:up:build
```

The CLI installer (2.3.1+) reads the **same** `.env`, so client and server stay in sync automatically. Run `pnpm install:self-hosted` (or `robrain install --self-hosted --repo-root /path/to/clone`) to propagate the key into editor MCP configs, then fully restart Cursor / Claude Code.

If setup still fails, run:

```bash
npx robrain doctor
```

### Stale Perception Docker image (migrations / schema out of sync)

If you **pulled new code** but did **not rebuild** the `perception` service, the container may still run an **older** Perception binary than `packages/perception-self-hosted` on disk. Then startup migrations (for example `reviewed_at` on `decisions`) never run, `robrain review` approval can fail against the DB the CLI is using, and features that assume the new schema break in confusing ways.

From the **repo root** (same directory as `.env` and `docker/docker-compose.yml`):

```bash
pnpm docker:up:build
```

That runs **`prepare-env`** and **`docker compose … up -d --build perception`** — rebuilds the Perception image and recreates the container.

To **build only**, then start Perception yourself:

```bash
pnpm docker:build
docker compose -f docker/docker-compose.yml --env-file .env up -d perception
```

If Docker reused layers and you still see old behavior, force a clean rebuild (no pnpm shortcut for **`--no-cache`** yet):

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

