import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSensingMcpEnv,
  forceEditor,
  renderCodexBlock,
  resolveEditorsForInstall,
  writeCodexMcpConfig,
} from './editor.js'

const baseOpts = {
  sensingMcpPath:    '/home/user/.robrain/mcp/sensing/dist/index.js',
  controlMcpPath:    '/home/user/.robrain/mcp/control/dist/index.js',
  anthropicKey:      'sk-ant-test',
  perceptionUrl:     'http://localhost:3001',
  perceptionKey:     'perception-secret',
  planningUrl:       '',
  planningKey:       '',
  embeddingProvider: 'openai',
  embeddingKey:      'sk-openai-test',
}

describe('renderCodexBlock', () => {
  it('includes sensing server with enabled and env', () => {
    const block = renderCodexBlock({ ...baseOpts, includeControl: false })
    assert.match(block, /\[mcp_servers\.robrain-sensing\]/)
    assert.match(block, /enabled = true/)
    assert.match(block, /PERCEPTION_API_KEY = "perception-secret"/)
    assert.doesNotMatch(block, /robrain-control/)
  })

  it('includes control when includeControl is true', () => {
    const block = renderCodexBlock({
      ...baseOpts,
      includeControl: true,
      planningUrl: 'https://plan.example',
      planningKey: 'plan-key',
    })
    assert.match(block, /\[mcp_servers\.robrain-control\]/)
    assert.match(block, /PLANNING_API_URL = "https:\/\/plan\.example"/)
  })

  it('sets OPENAI_API_KEY and LLM_PROVIDER when LLM is openai with non-openai embeddings', () => {
    const env = buildSensingMcpEnv({
      ...baseOpts,
      embeddingProvider: 'voyage',
      embeddingKey:      'voyage-emb-key',
      llmProvider:       'openai',
      openaiKey:         'sk-openai-llm',
      includeControl:    false,
    })
    assert.equal(env.LLM_PROVIDER, 'openai')
    assert.equal(env.OPENAI_API_KEY, 'sk-openai-llm')
    assert.equal(env.VOYAGE_API_KEY, 'voyage-emb-key')
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test')

    const block = renderCodexBlock({
      ...baseOpts,
      embeddingProvider: 'voyage',
      embeddingKey:      'voyage-emb-key',
      llmProvider:       'openai',
      openaiKey:         'sk-openai-llm',
      includeControl:    false,
    })
    assert.match(block, /LLM_PROVIDER = "openai"/)
    assert.match(block, /OPENAI_API_KEY = "sk-openai-llm"/)
    assert.match(block, /VOYAGE_API_KEY = "voyage-emb-key"/)
  })

  it('escapes quotes and backslashes in TOML strings', () => {
    const block = renderCodexBlock({
      ...baseOpts,
      perceptionKey: 'say "hello" \\ path',
      includeControl: false,
    })
    assert.match(block, /PERCEPTION_API_KEY = "say \\"hello\\" \\\\ path"/)
  })
})

describe('writeCodexMcpConfig', () => {
  it('creates a new file with the managed block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'robrain-codex-'))
    const path = join(dir, 'config.toml')
    try {
      writeCodexMcpConfig(path, { ...baseOpts, includeControl: false })
      const text = readFileSync(path, 'utf8')
      assert.match(text, /# <!-- robrain -->/)
      assert.match(text, /\[mcp_servers\.robrain-sensing\]/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces an existing managed block without dropping other TOML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'robrain-codex-'))
    const path = join(dir, 'config.toml')
    writeFileSync(path, [
      'model = "gpt-5"',
      '',
      '# <!-- robrain -->',
      '[mcp_servers.robrain-sensing]',
      'command = "node"',
      'args = ["/old/path"]',
      '# <!-- /robrain -->',
      '',
      '[other]',
      'x = 1',
    ].join('\n'), 'utf8')
    try {
      writeCodexMcpConfig(path, { ...baseOpts, includeControl: false })
      const text = readFileSync(path, 'utf8')
      assert.match(text, /^model = "gpt-5"/m)
      assert.match(text, /\[other\]/)
      assert.match(text, /sensing\/dist\/index.js/)
      assert.doesNotMatch(text, /\/old\/path/)
      assert.equal((text.match(/# <!-- robrain -->/g) ?? []).length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveEditorsForInstall', () => {
  it('forceEditor returns codex config path', () => {
    const forced = forceEditor('codex')
    assert.ok(forced)
    assert.equal(forced.editor, 'codex')
    assert.match(forced.configPath, /config\.toml$/)
  })

  it('honors --editor when not detected', () => {
    const resolved = resolveEditorsForInstall({ editor: 'codex' })
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0]!.editor, 'codex')
  })
})
