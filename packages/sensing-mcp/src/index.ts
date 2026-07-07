#!/usr/bin/env node
// packages/sensing-mcp/src/index.ts
// ─────────────────────────────────────────────────────────────
// Sensing MCP server — entry point.
// Exposes four tools to Claude Code via stdio transport.
// Tool definitions live in server.ts, imported dynamically so
// loadEnv() runs before config reads process.env.
// ─────────────────────────────────────────────────────────────

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadEnv } from '@robrain/shared'

// `.env` is the single source of truth for API keys; values there override anything
// already in process.env (including the env block injected from ~/.claude.json),
// which only acts as a fallback for keys missing from `.env`.
loadEnv()

// Stdio MCP must stay alive — log and continue rather than exit on stray rejections.
process.on('unhandledRejection', reason => {
  console.error('[Sensing] Unhandled rejection (process kept alive):', reason)
})
process.on('uncaughtException', err => {
  console.error('[Sensing] Uncaught exception (process kept alive):', err)
})

const { buildServer } = await import('./server.js')

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await buildServer().connect(transport)
console.error('[Sensing] MCP server running — waiting for Claude Code')
