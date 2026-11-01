# Deprecation policy

RoBrain is a memory layer other tools build on: the Sensing MCP, the Perception
HTTP API, the CLI, the eve provider and the editor plugins all talk to each
other across versions. This page is the promise about how those surfaces
change.

## What is covered

- Perception HTTP routes and their request and response shapes (self-hosted
  and RoBrain cloud).
- CLI commands and flags (`robrain ...`).
- Sensing MCP tools (`sensing_start_session`, `sensing_record_turn`,
  `sensing_end_session`) and their parameters.
- The `@robrain/shared` and `@robrain/eve` package exports.
- Database migrations.

## The rules

1. **Additive by default.** New fields are optional, new routes and flags are
   additions. An existing field keeps its name and meaning. Older clients keep
   working against a newer server, and a newer client degrades cleanly against
   an older server (a missing route answers 404 and the CLI says what to
   upgrade).
2. **Nothing is retired without a replacement.** A route, command, flag, tool
   parameter or export is marked deprecated first, in the changelog and in
   this file, with the replacement named. It is removed no earlier than the
   next minor version after the one that deprecated it.
3. **Migrations are additive and idempotent.** A migration adds columns,
   tables or indexes. It never drops or rewrites existing data, and running it
   twice is safe. Rows saved before a migration keep working; new columns are
   nullable or defaulted.
4. **Same code, self-hosted and cloud.** Both editions ship the same
   `@robrain/shared` version and the same route shapes. A cloud-only feature is
   marked as such in `docs/cli.md`; it is never a different memory engine.
5. **Your data is always exportable.** `robrain export` writes every decision,
   rejection and its lineage as JSON and Markdown at any version, before and
   after an upgrade.
6. **Version numbers mean something.** Patch: fixes only. Minor: additions and
   deprecations. Major: removals announced under rule 2.

## Currently deprecated

Nothing.

## Removed

Nothing yet.
