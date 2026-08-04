# Maintainer release checklist

Step-by-step for shipping a new `robrain@X.Y.Z` to npm **without** breaking the
no-clone install path (`npx robrain up`). End-user upgrade steps live in
[CLI reference — Upgrading](cli.md#upgrading).

**Golden rule:** **GHCR image before npm.** `robrain up` defaults its Docker tag
to the CLI version (`packages/cli/src/commands/up.ts`), so publishing npm
before `ghcr.io/adelinamart/robrain-perception:X.Y.Z` exists breaks every fresh
install. The `prepublishOnly` **release guard** enforces this automatically.

---

## Why this exists (the 2.3.6 / 2.3.7 incident)

- `robrain@2.3.6` and `2.3.7` shipped to npm.
- Local git tags `v2.3.6` / `v2.3.7` were never pushed to `origin`.
- `.github/workflows/publish-perception-image.yml` only runs on **pushed** `v*`
  tags, so GHCR stopped at `2.3.5`.
- Users running `npx robrain@2.3.7 up` tried to pull a non-existent image.

**Fix shipped in CLI:** `packages/cli/scripts/verify-release-artifacts.mjs` runs
in `prepublishOnly` and refuses publish unless:

1. `refs/tags/vX.Y.Z` exists on `origin`, and
2. `ghcr.io/adelinamart/robrain-perception:X.Y.Z` returns HTTP 200 (manifest HEAD).

Emergency bypass (avoid unless you know why): `ROBRAIN_SKIP_RELEASE_GUARD=1`.

---

## Files to bump every release

| File | What to update |
|------|----------------|
| `package.json` (root) | `"version"` |
| `packages/cli/package.json` | `"version"` |
| `packages/cli/src/index.ts` | `VERSION` constant |
| `packages/cli/src/commands/install.ts` | `version` in generated config (2 places) |
| `packages/sensing-mcp/package.json` | `"version"` |
| `packages/sensing-mcp/src/server.ts` | `serverInfo.version` |
| `packages/perception-self-hosted/package.json` | `"version"` |
| `packages/shared/package.json` | `"version"` |
| `packages/synthesis/package.json` | `"version"` |
| `packages/eval/package.json` | `"version"` |
| `plugins/claude-code/.claude-plugin/plugin.json` | `"version"` |
| `server.json` | top-level `version` **and** `packages[0].version` |
| `Dockerfile` (root, Glama introspection) | `pnpm add -g robrain@X.Y.Z` pin |

Keep `"mcpName": "io.github.adelinamart/robrain"` in `packages/cli/package.json`
— the MCP Registry ownership check reads it from the **published** npm tarball.

`server.json` `description` must stay ≤ **100 characters** (registry API limit).

---

## Release sequence (maintainer)

### 1. Prep on `main`

```bash
cd /path/to/robrain
pnpm -r build
pnpm test                    # CLI tests (includes release-guard)
cd packages/cli && pnpm pack:verify
```

Commit the version bump (+ any release notes / doc tweaks). Push:

```bash
git push origin main
```

### 2. Tag → GHCR image (before npm)

Create the tag on the version-bump commit if it does not exist yet:

```bash
git tag vX.Y.Z    # skip if tag already points at the right commit
git push origin vX.Y.Z
```

Watch the workflow:

```bash
gh run list --workflow=publish-perception-image.yml --limit 3
gh run watch                      # paste run id from the tag push
```

Or: https://github.com/adelinamart/robrain/actions/workflows/publish-perception-image.yml

Verify the image:

```bash
docker pull ghcr.io/adelinamart/robrain-perception:X.Y.Z
docker pull ghcr.io/adelinamart/robrain-perception:latest   # should match after this run
```

**Backfilling missed tags:** if older npm versions shipped without images, push
their tags **one at a time** (oldest first). Each run stamps `latest`, so push
the highest version last:

```bash
git push origin v2.3.6 && gh run watch
git push origin v2.3.7 && gh run watch
git push origin v2.3.8 && gh run watch
```

### 3. Publish npm

Two packages ship to npm every release: **`@robrain/shared`** (consumed by the
cloud repo as a normal registry dependency) and **`robrain`** (the CLI).

> **One-time setup:** the `@robrain` scope is an npm **organization**, created on
> https://www.npmjs.com/org/create with the same account that owns the `robrain`
> CLI package (`npm owner ls robrain`). Orgs cannot be created from the CLI. Use
> the free *Unlimited public packages* plan. Verify with `npm org ls robrain`.
> Scoped packages default to restricted on publish, which a free org cannot
> host — hence `publishConfig.access: "public"` in `packages/shared/package.json`
> **and** `--access public` on the publish command.

Preflight — confirm the shared tarball has `dist/*` (no `*.test.js`, no
`*.map`), `schema.sql`, `README.md`, `LICENSE`, and `package.json`, and nothing
else:

```bash
pnpm --filter @robrain/shared exec npm pack --dry-run
```

Then from repo root:

```bash
pnpm publish:npm
# equivalent: pnpm --filter robrain build && node packages/cli/scripts/verify-release-artifacts.mjs && pnpm --filter @robrain/shared publish --access public --no-git-checks && pnpm --filter @robrain/sensing-mcp build && pnpm --filter @robrain/synthesis build && pnpm --filter robrain publish --access public --no-git-checks
```

With 2FA on the account, npm prompts for an OTP **per package** — two prompts.

**Why the guard runs up front.** `@robrain/shared` has no coupling to the Docker
image, so the GHCR golden rule does not gate it, and publishing it first means a
cloud repin never waits on a CLI publish failure. But the CLI's own
`prepublishOnly` guard runs *last* in the chain — if it failed there,
`@robrain/shared@X.Y.Z` would already be public with no matching CLI, and npm
blocks reusing a version for 24h after an unpublish. The only way out would be
bumping everything to X.Y.Z+1, leaving an orphan version the cloud could pin and
breaking the lockstep invariant. So `publish:npm` builds the CLI and runs
`verify-release-artifacts.mjs` standalone *before* the first publish. It runs
again in `prepublishOnly`; the second run is a cheap no-op re-check.
`ROBRAIN_SKIP_RELEASE_GUARD=1` still bypasses both.

**`prepack` cleans `dist/` first.** `tsc` never removes stale output, so the
tsconfig test exclusion alone would leave previously-compiled `*.test.js` in a
release machine's `dist/` and ship them. Both `prepack` (npm tarball) and
`prepare` (git-path installs) run `rm -rf dist && tsc -p tsconfig.publish.json`:
the clean makes the exclusion real, and `tsconfig.publish.json` turns off
`sourceMap` / `declarationMap` so no `.js.map` / `.d.ts.map` ships pointing at a
`../src` the tarball does not contain. Plain `build` uses `tsconfig.json` and
keeps maps, so local dev is unaffected.

Smoke:

```bash
npm view @robrain/shared version   # → X.Y.Z
npx robrain@X.Y.Z --version
npx robrain@X.Y.Z up          # only if no conflicting stack already running (see below)
cd packages/cli && pnpm pack:verify
```

### 4. Official MCP Registry

After npm is live, publish the bumped `server.json`:

```bash
mcp-publisher publish
```

Re-authenticate **only** when you get `401` / expired JWT:

```bash
mcp-publisher login github
mcp-publisher publish
```

`mcp-publisher validate` is optional sanity check before publish.

You do **not** need `login` on every release — only when the token expires.
You **do** need `publish` on every release where `server.json` version changes.

PulseMCP ingests registry updates automatically ([distribution notes](distribution/mcp-directories.md)).

### 5. GitHub Release (recommended)

Create a release on the `vX.Y.Z` tag with user-facing notes. Suggested upgrade
block:

```markdown
## Upgrade

\`\`\`bash
npx robrain@latest up
npx robrain@latest install --self-hosted
# Cmd-Q editors fully, then reopen
\`\`\`

Codex users: trust hooks on first run after reinstall.
```

### 6. Extended / optional steps

| Step | When | Action |
|------|------|--------|
| Glama | check fails, or launch contract changes | Zero-touch normally (see note below); admin config only on failure or if `robrain mcp` / required env / Node floor changes |
| awesome-mcp-servers | Glama score changes | PR with Glama badge (see [mcp-directories.md](distribution/mcp-directories.md)) |
| mcp.so | optional | Web form — may auto-ingest registry |
| Smithery | skip | User-run backend; listing cannot launch |
| MCP Registry re-login | 401 on publish | `mcp-publisher login github` |

**Glama:** zero-maintenance per release — its build config installs unpinned `npm install -g robrain` (its own config, not the repo `Dockerfile`), so every Glama re-check automatically tests the latest npm release, license/score read from GitHub, and the badge refreshes itself. After publishing, glance at the [score badge](https://glama.ai/mcp/servers/adelinamart/robrain): green means npm install → server start → introspection just re-verified for free; red means a broken release — fix on the npm side, then one **Build & Release** in the Glama admin.

---

## What to tell users

### Standard upgrade (no-clone path)

```bash
npx robrain@latest up
npx robrain@latest install --self-hosted
```

Fully quit editors (`Cmd-Q`), reopen. Re-run `npx robrain init-project` only if
release notes mention changes to `CLAUDE.md`, `AGENTS.md`, or
`.cursor/rules/robrain.mdc`.

### Clone-path users (repo checkout)

```bash
git pull && pnpm install && pnpm build
pnpm docker:up:build
npx robrain install --self-hosted --repo-root "$(pwd)"
```

They do **not** need `robrain up` if `pnpm docker:up` already runs a healthy
stack.

### Stuck on `robrain up` image pull (missing GHCR tag)

Interim workaround until they upgrade:

```bash
npx robrain up --tag 2.3.5    # or latest published tag on GHCR
```

Note: `--tag latest` only helps if `latest` on GHCR is actually published.

### Container name conflict

If `robrain up` fails with `/robrain-postgres` already in use, a **clone-path**
stack (`pnpm docker:up`) is already running. Either keep it (stack is fine) or
switch paths:

```bash
pnpm docker:down              # from clone root
npx robrain@latest up
```

Both paths share the `robrain_postgres_data` volume — data is preserved.

---

## Quick reference diagram

```text
version bump → commit → push main
       ↓
git tag vX.Y.Z → push tag → wait publish-perception-image.yml ✓
       ↓
docker pull ghcr.io/.../robrain-perception:X.Y.Z  (verify)
       ↓
pnpm publish:npm   (@robrain/shared, then robrain — release guard must pass)
       ↓
mcp-publisher publish   (login github only if 401)
       ↓
GitHub Release notes
```

---

## Do not

- Publish npm before the matching GHCR tag exists (guard blocks this; bypass only in emergencies).
- Push multiple `v*` tags at once if you care which commit `latest` points at — push sequentially.
- Commit `packages/vetobench/results/` benchmark output (unrelated to releases).
- Tell users to run `robrain up` when they already have a healthy clone-path stack.

---

## Related docs

- [CLI reference — Upgrading](cli.md#upgrading) — end-user upgrade paths
- [MCP directory submissions](distribution/mcp-directories.md) — registry, Glama, PulseMCP
- [Troubleshooting](troubleshooting.md) — stale Perception image, 401s, schema drift
