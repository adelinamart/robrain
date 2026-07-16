# RoBrain for eve agents

Give any [eve](https://eve.dev) agent your team's decision memory — including the alternatives you **rejected** and why — so it stops re-proposing approaches your team already ruled out.

Four files, three native eve surfaces, all backed by your self-hosted RoBrain stack:

| File | eve surface | What it does |
|---|---|---|
| `agent/instructions/robrain_memory.ts` | Dynamic instructions (`session.started`) | Injects the always-on project summary — top decisions **with their rejected alternatives** — into every model call. Cache-friendly: resolved once per session. |
| `agent/tools/check_prior_decisions.ts` | Typed tool | Two-tier veto scan, same as the Claude Code/Codex hooks: deterministic `POST /veto-scan` (exact rejected-option match, no embeddings) merged ahead of semantic `GET /decisions` (similarity-gated, so old rejections never fade from warnings). |
| `agent/hooks/robrain_capture.ts` | Stream hook (observe-only) | Ships each completed turn to Perception for server-side decision extraction. Capture is deterministic — not dependent on the model remembering to call anything. |
| `agent/lib/robrain.ts` | — | Shared Perception client. Fail-open everywhere: a dead or unconfigured Perception never breaks the agent's session. |

Verified end-to-end against `eve dev` (eve 0.24.4, 2026-07-16): the agent refused two previously-rejected approaches citing the recorded reasons verbatim, and a novel decision stated in-session was captured with its structured `rejected[]` intact.

## Install

Requires a running RoBrain stack and a registered project:

```bash
npx robrain@latest up                  # start Postgres + Perception (no clone needed)
npx robrain init-project               # register this project, warm-start memory
```

Copy the four files under `agent/` into your eve app's `agent/` directory (paths must match — eve's filesystem routing is the wiring). Then add the connection env vars to your app's `.env.local`:

```bash
PERCEPTION_API_URL=http://localhost:3001
PERCEPTION_API_KEY=<from your repo .env, written by robrain up>
ROBRAIN_PROJECT_ID=<your project id, from init-project>
```

Finally, tell the agent to use the tool — add to your `agent/instructions.md`:

```md
- Before proposing any technology, architecture, or approach, call the
  `check_prior_decisions` tool with a short description of the task. Do not
  re-propose a rejected approach without flagging the prior rejection and why
  circumstances changed.
```

## Notes

- **Requires Node ≥ 24** (eve's own floor).
- **Local vs deployed:** with `eve dev`, `localhost:3001` works as-is. A deployed agent (`vercel deploy`) needs a Perception reachable from your deployment — a self-hosted instance with a public URL, or a hosted RoBrain backend.
- **Capture flushes on `turn.completed`**, not `message.completed` — the latter fires multiple times per turn (interim narration before tool calls); flushing on turn end gives exactly one capture per turn with the final text.
- **Perception dedups server-side.** Turns that restate existing decisions come back `action: "discarded"` — absence of new rows is the dedup working, not capture failing.
- **Test projects must be registered.** Perception rejects unknown project ids (`project_not_registered`) — point `ROBRAIN_PROJECT_ID` at a registered project, and never at a production project from test rigs.
- **Cross-tool by design.** Decisions captured here surface in Claude Code, Cursor, and Codex through the same Perception store — and vice versa.
