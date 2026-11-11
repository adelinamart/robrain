# RoBrain hooks for Codex CLI / IDE

The same three lifecycle hooks as the [Claude Code plugin](../claude-code/README.md), running on Codex's native hooks system (Codex's hook contract is Claude-compatible: same stdin fields, same `hookSpecificOutput.additionalContext` output, same event names).

| Hook | What it does |
|---|---|
| `SessionStart` | Injects the always-on project summary — top decisions with their rejected alternatives. |
| `UserPromptSubmit` | Two-tier pre-task veto: deterministic `POST /veto-scan` + semantic search. Also stashes the prompt for capture. |
| `Stop` | Ships the completed turn (stashed prompt + `last_assistant_message` from Codex's own stdin) to Perception for server-side extraction. No transcript-format assumptions. |

Everything fails open: a dead Perception never blocks a Codex session.

On a RoBrain cloud install the same hooks do more, exactly as in the Claude Code plugin: the prompt hook makes one call for ranked context, veto warnings and a required acknowledgement, and the stop hook scores the reply against what was injected. See [On RoBrain cloud](../claude-code/README.md#on-robrain-cloud).

## Install

```bash
npx robrain@latest up          # start the backend, once
npx robrain install            # detects Codex; wires MCP + hooks into ~/.codex/config.toml
```

`robrain install` materializes the hook scripts into `~/.robrain/hooks/codex/` and writes the `[hooks]` entries inside RoBrain's managed block in `~/.codex/config.toml`. Codex asks you to trust the hooks on first run.

## Source layout

`session-start.mjs`, `user-prompt-submit.mjs`, and `lib.mjs` are shared verbatim with the Claude Code plugin ([plugins/claude-code/hooks](../claude-code/hooks/)) — one implementation, two clients. Only `stop.mjs` is Codex-specific: Codex hands the assistant reply on stdin, so capture pairs it with the stashed prompt instead of parsing a transcript.

## Not covered: the Codex cloud/web agent

The cloud agent runs in a sandboxed container with no local node or localhost Perception — hooks and the `sensing_*` MCP tools can't reach it (AGENTS.md instructions still can). Covering it requires a hosted remote MCP endpoint — tracked on the Rory Plans cloud roadmap, deliberately not part of the OSS path.
