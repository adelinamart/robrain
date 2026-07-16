# Dockerfile — RoBrain Sensing MCP server, for MCP-directory introspection (Glama).
#
# This image exists so directories like Glama can start the Sensing MCP server
# and run introspection (initialize + tools/list) in isolation. It does NOT run
# the Perception backend — that is a separate stack you self-host with
# `npx robrain up` (see docker/Dockerfile.perception). Introspection needs no
# backend: the tool list is static, so the server starts and answers with no
# config, env, or database present.
FROM node:22-alpine

# Install the published CLI (bundles the Sensing server) with pnpm — this repo
# is pnpm-only. corepack ships with the node image; PNPM_HOME on PATH is where
# pnpm places global binaries. Pinned to a known-good release: `pnpm add -g
# robrain@latest` mis-resolves to the oldest published version, and pinning
# keeps the Glama-introspected surface reproducible. Bump on release.
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
RUN corepack enable && pnpm add -g robrain@2.3.9

# stdio MCP transport: the client speaks JSON-RPC over stdin/stdout.
ENTRYPOINT ["robrain", "mcp"]
