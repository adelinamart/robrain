import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { editorConfigPath, mcpServersKey, writeMcpConfig, type McpWriteOptions } from './editor.js'

const opts: McpWriteOptions = {
  sensingMcpPath:    '/mcp/sensing/dist/index.js',
  controlMcpPath:    '/mcp/control/dist/index.js',
  anthropicKey:      '',
  perceptionUrl:     'http://localhost:3001',
  perceptionKey:     'pk',
  planningUrl:       '',
  planningKey:       '',
  embeddingProvider: 'openai',
  embeddingKey:      '',
  includeControl:    false,
}

test('VS Code (copilot) config uses the `servers` key, not `mcpServers`', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robrain-vscode-'))
  const file = join(dir, 'mcp.json')
  writeMcpConfig(file, opts, 'copilot')
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
  assert.ok(json.servers?.['robrain-sensing'], 'robrain-sensing must be under servers')
  assert.equal(json.mcpServers, undefined)
})

test('VS Code write preserves existing `servers` and `inputs`', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robrain-vscode-'))
  const file = join(dir, 'mcp.json')
  writeFileSync(file, JSON.stringify({
    inputs:  [{ id: 'token', type: 'promptString' }],
    servers: { other: { command: 'other-mcp' } },
  }))
  writeMcpConfig(file, opts, 'copilot')
  const json = JSON.parse(readFileSync(file, 'utf8')) as {
    inputs: unknown[]; servers: Record<string, unknown>
  }
  assert.equal(json.inputs.length, 1)
  assert.ok(json.servers.other, 'unrelated server entry must survive')
  assert.ok(json.servers['robrain-sensing'])
})

test('Claude Code and Cursor keep the `mcpServers` key', () => {
  for (const editor of ['claude-code', 'cursor'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'robrain-mcp-'))
    const file = join(dir, 'mcp.json')
    writeMcpConfig(file, opts, editor)
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
    assert.ok(json.mcpServers?.['robrain-sensing'])
    assert.equal(json.servers, undefined)
  }
  assert.equal(mcpServersKey(undefined), 'mcpServers')
})

test('copilot config path is the VS Code user settings dir, never ~/.vscode', () => {
  const home = mkdtempSync(join(tmpdir(), 'robrain-home-'))
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    // ~/.vscode (extensions folder) exists on nearly every machine; it must not win.
    mkdirSync(join(home, '.vscode'))
    assert.equal(editorConfigPath('copilot'), null)

    const user = join(home, 'Library', 'Application Support', 'Code', 'User')
    mkdirSync(user, { recursive: true })
    assert.equal(editorConfigPath('copilot'), join(user, 'mcp.json'))
  } finally {
    process.env.HOME = prev
  }
})
