# RoBrain plugin for Claude Code

Claude's memory keeps your best notes. RoBrain keeps the things you decided **not** to do — and hands them back right before they're about to happen again.

The plugin wires three lifecycle hooks into Claude Code, backed by your self-hosted RoBrain stack or by RoBrain cloud:

| Hook | What it does |
|---|---|
| `SessionStart` | Injects the always-on project summary — top decisions **with their rejected alternatives** — into every new session. |
| `UserPromptSubmit` | Two-tier pre-task veto: **tier 1** — `POST /veto-scan` (deterministic exact match on `rejected[]`, no embeddings); **tier 2** — semantic `GET /decisions?query=` for longer prompts. Warns before Claude starts working. |
| `Stop` | Ships the completed turn to Perception for server-side decision extraction (async — never blocks your session). Capture becomes deterministic instead of depending on the model remembering to call MCP tools. |

Every hook fails open: if Perception is down or unconfigured, your session is unaffected.

### On RoBrain cloud

The same plugin works on a cloud install (`npx robrain install` with a Rory Plans token); nothing else to add. Two hooks do more there:

| Hook | What changes on cloud |
|---|---|
| `UserPromptSubmit` | One call to the ranked context route replaces both tiers. It returns the memories most relevant to the prompt, the veto warnings (including rules an admin pushed to the project), and a required acknowledgement when a warning comes from a rejection nobody has reviewed yet. Claude is told to show that warning to you and wait for your confirmation. |
| `Stop` | After shipping the turn, it scores the reply against what was injected, so each memory builds up helpful and pushback counts you can see in the dashboard. |

What a session has already been shown is not injected again. If the context route does not answer, the hook falls back to the two tiers above, so a slow or older API never leaves a prompt unchecked.

## Install

Requires a registered project on a running RoBrain stack (self-hosted) or a cloud install:

```bash
npx robrain@latest up                  # self-hosted: start Postgres + Perception (no clone needed)
# or: npx robrain install              # RoBrain cloud: sign in with your Rory Plans token
npx robrain init-project               # register this project, warm-start memory
```

Then add the plugin:

```bash
claude plugin marketplace add adelinamart/robrain
claude plugin install robrain@robrain
```

Connection settings come from `~/.robrain/config.json` (written by `robrain up` / `robrain install`); `PERCEPTION_URL` / `PERCEPTION_API_KEY` environment variables override it. Whether the install is cloud is read from the same file; set `ROBRAIN_CLOUD=1` or `0` to override when you configure the hooks through the environment only.

## Notes

- **Works alongside the Sensing MCP.** Perception deduplicates near-identical decisions server-side, so running both double-captures nothing. With the plugin installed, the mandatory `sensing_record_turn` block in `CLAUDE.md` becomes optional — hooks capture deterministically.
- **Cross-tool by design.** Decisions captured here surface in Cursor, Copilot, and Codex through the same Perception store (`robrain install --self-hosted`).
- **Your data stays yours.** Hooks talk only to the Perception URL you configured — by default a Docker container on localhost; on a cloud install, the Rory Plans API.
