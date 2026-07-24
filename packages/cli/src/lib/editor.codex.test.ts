import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSensingMcpEnv,
  DEFAULT_OPENAI_BASE_URL,
  forceEditor,
  renderCodexBlock,
  resolveEditorsForInstall,
  resolveOpenAiBaseUrlFromEnv,
  usingLocalOpenAi,
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
  it('omits hooks tables when no codexHooksDir is provided', () => {
    const block = renderCodexBlock({ ...baseOpts, includeControl: false })
    assert.doesNotMatch(block, /\[\[hooks\./)
  })

  it('wires the three lifecycle hooks when codexHooksDir is set', () => {
    const block = renderCodexBlock({
      ...baseOpts,
      includeControl: false,
      codexHooksDir: '/home/user/.robrain/hooks/codex',
    })
    assert.match(block, /\[\[hooks\.SessionStart\]\]/)
    assert.match(block, /\[\[hooks\.UserPromptSubmit\]\]/)
    assert.match(block, /\[\[hooks\.Stop\]\]/)
    // command strings quote the script path and run it with node
    assert.match(block, /command = "node \\"\/home\/user\/\.robrain\/hooks\/codex\/user-prompt-submit\.mjs\\""/)
    // capture must be async so it never blocks the turn ending
    assert.match(block, /\[\[hooks\.Stop\.hooks\]\]\ntype = "command"\ncommand = [^\n]+\ntimeout = 30\nasync = true/)
    // hooks tables must stay inside the managed block
    assert.ok(block.indexOf('[[hooks.Stop]]') < block.indexOf('# <!-- /robrain -->'))
  })

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

  it('thin mode writes only ROBRAIN_MODE + Perception vars — no LLM or embedding keys', () => {
    const env = buildSensingMcpEnv({ ...baseOpts, thin: true })
    assert.deepEqual(env, {
      ROBRAIN_MODE:       'cloud',
      PERCEPTION_API_URL: 'http://localhost:3001',
      PERCEPTION_API_KEY: 'perception-secret',
    })

    const block = renderCodexBlock({ ...baseOpts, thin: true, includeControl: false })
    assert.match(block, /ROBRAIN_MODE = "cloud"/)
    assert.doesNotMatch(block, /ANTHROPIC_API_KEY|EMBEDDING_PROVIDER|OPENAI_API_KEY|VOYAGE_API_KEY|COHERE_API_KEY/)
  })

  it('non-thin env is unchanged (self-hosted stays byte-for-byte)', () => {
    const env = buildSensingMcpEnv({ ...baseOpts })
    assert.equal(env.ROBRAIN_MODE, undefined)
    assert.deepEqual(env, {
      ANTHROPIC_API_KEY:  'sk-ant-test',
      EMBEDDING_PROVIDER: 'openai',
      PERCEPTION_API_URL: 'http://localhost:3001',
      PERCEPTION_API_KEY: 'perception-secret',
      OPENAI_API_KEY:     'sk-openai-test',
    })
  })

  it('local base URL: writes OPENAI_BASE_URL and omits an empty OPENAI_API_KEY', () => {
    const env = buildSensingMcpEnv({
      ...baseOpts,
      embeddingKey:  '',
      openaiBaseUrl: 'http://localhost:11434/v1',
    })
    assert.equal(env.OPENAI_BASE_URL, 'http://localhost:11434/v1')
    assert.equal('OPENAI_API_KEY' in env, false)

    // A key set alongside a local base URL is still forwarded (server may enforce auth)
    const withKey = buildSensingMcpEnv({ ...baseOpts, openaiBaseUrl: 'http://localhost:11434/v1' })
    assert.equal(withKey.OPENAI_API_KEY, 'sk-openai-test')
    assert.equal(withKey.OPENAI_BASE_URL, 'http://localhost:11434/v1')
  })

  it('split local setup: writes Docker OPENAI_BASE_URL and host OPENAI_HOST_BASE_URL', () => {
    const env = buildSensingMcpEnv({
      ...baseOpts,
      embeddingKey: '',
      openaiBaseUrl: 'http://host.docker.internal:11434/v1',
      openaiHostBaseUrl: 'http://127.0.0.1:11434/v1',
    })
    assert.equal(env.OPENAI_BASE_URL, 'http://host.docker.internal:11434/v1')
    assert.equal(env.OPENAI_HOST_BASE_URL, 'http://127.0.0.1:11434/v1')
    assert.equal('OPENAI_API_KEY' in env, false)
  })

  it('host-only local URL: OPENAI_HOST_BASE_URL alone is enough for keyless', () => {
    const env = buildSensingMcpEnv({
      ...baseOpts,
      embeddingKey: '',
      openaiHostBaseUrl: 'http://127.0.0.1:11434/v1',
    })
    assert.equal(env.OPENAI_HOST_BASE_URL, 'http://127.0.0.1:11434/v1')
    assert.equal('OPENAI_BASE_URL' in env, false)
    assert.equal('OPENAI_API_KEY' in env, false)
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

describe('resolveOpenAiBaseUrlFromEnv', () => {
  it('preferHost uses OPENAI_HOST_BASE_URL over the Docker URL', () => {
    const env = {
      OPENAI_BASE_URL: 'http://host.docker.internal:11434/v1',
      OPENAI_HOST_BASE_URL: 'http://127.0.0.1:11434/v1',
    }
    assert.equal(
      resolveOpenAiBaseUrlFromEnv(env),
      'http://host.docker.internal:11434/v1',
    )
    assert.equal(
      resolveOpenAiBaseUrlFromEnv(env, { preferHost: true }),
      'http://127.0.0.1:11434/v1',
    )
    assert.equal(usingLocalOpenAi(env), true)
  })

  it('preferHost falls through empty OPENAI_HOST_BASE_URL to OPENAI_BASE_URL', () => {
    const env = {
      OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1/',
      OPENAI_HOST_BASE_URL: '   ',
    }
    assert.equal(
      resolveOpenAiBaseUrlFromEnv(env, { preferHost: true }),
      'http://127.0.0.1:11434/v1',
    )
  })

  it('normalizes localhost to 127.0.0.1', () => {
    assert.equal(
      resolveOpenAiBaseUrlFromEnv({ OPENAI_BASE_URL: 'http://localhost:11434/v1' }),
      'http://127.0.0.1:11434/v1',
    )
  })

  it('defaults when unset', () => {
    assert.equal(resolveOpenAiBaseUrlFromEnv({}), DEFAULT_OPENAI_BASE_URL)
    assert.equal(usingLocalOpenAi({}), false)
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
