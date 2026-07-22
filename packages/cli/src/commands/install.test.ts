import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// installCommand resolves homedir() and RORY_API_BASE at import time — pin a
// hermetic HOME, a local stub Rory API, and an empty key env BEFORE the
// dynamic imports below. Runs under node --test, so this file owns its process.
const fakeHome = mkdtempSync(join(tmpdir(), 'robrain-install-'))
process.env.HOME = fakeHome
delete process.env.ROBRAIN_REPO
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.VOYAGE_API_KEY
delete process.env.COHERE_API_KEY
delete process.env.EMBEDDING_PROVIDER
delete process.env.LLM_PROVIDER

// Fake robrain clone with a built sensing-mcp so prepareMcpBundles links it.
const fakeRepo = join(fakeHome, 'repo')
mkdirSync(join(fakeRepo, 'packages', 'sensing-mcp', 'dist'), { recursive: true })
writeFileSync(join(fakeRepo, 'packages', 'sensing-mcp', 'dist', 'index.js'), '// stub bundle\n')

// Claude Code detection: ~/.claude present, ~/.claude.json written by install.
mkdirSync(join(fakeHome, '.claude'), { recursive: true })

// Stub Rory Plans API. Provision deliberately returns NO embeddingProvider —
// the case the old cloud path answered with an interactive provider prompt.
const provisioned = {
  perceptionUrl:     'https://perception.roryplans.test',
  planningUrl:       'https://planning.roryplans.test',
  perceptionKey:     'cloud-perception-key',
  planningKey:       'cloud-planning-key',
  embeddingProvider: '',
}
const stub = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/robrain/auth/validate') {
    res.end(JSON.stringify({ email: 'ade@roryplans.ai', perceptionUrl: provisioned.perceptionUrl, planningUrl: provisioned.planningUrl }))
    return
  }
  if (req.url === '/robrain/provision') {
    res.end(JSON.stringify(provisioned))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve))
// Never let the stub (or its keep-alive sockets) hold the test process open.
stub.unref()
const address = stub.address()
assert.ok(address && typeof address === 'object')
process.env.RORY_API_BASE = `http://127.0.0.1:${address.port}`

const prompts = (await import('prompts')).default
const { installCommand, buildCloudMcpOptions } = await import('./install.js')

after(async () => {
  // fetch()'s keep-alive sockets outlive the requests — destroy them or
  // stub.close() waits forever and the test runner hangs.
  stub.closeAllConnections()
  await new Promise<void>(resolve => stub.close(() => resolve()))
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('cloud install (thin client)', () => {
  it('completes without any embedding prompt and wires Sensing in thin mode', async () => {
    // Hang-guard: if any prompt fires, it consumes this Error (prompts treats an
    // injected Error as a cancel) instead of blocking on stdin — and the config
    // assertions below then fail on the old prompt-path fallbacks.
    prompts.inject([new Error('unexpected prompt during cloud install')])

    await installCommand({
      token:           'test-token',
      editor:          'claude-code',
      repoRoot:        fakeRepo,
      skipInitProject: true,
    })

    // Editor config: thin env only — no LLM or embedding keys.
    const claudeJson = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
    }
    const sensing = claudeJson.mcpServers['robrain-sensing']
    assert.ok(sensing, 'robrain-sensing must be configured')
    assert.deepEqual(sensing.env, {
      ROBRAIN_MODE:       'cloud',
      PERCEPTION_API_URL: provisioned.perceptionUrl,
      PERCEPTION_API_KEY: provisioned.perceptionKey,
    })
    assert.equal(sensing.args[0], join(fakeHome, '.robrain', 'mcp', 'sensing', 'dist', 'index.js'))
    // No Control bundle in the OSS tree — must not be registered.
    assert.equal(claudeJson.mcpServers['robrain-control'], undefined)

    // Local config: thin marker set, no embedding key stored.
    const config = JSON.parse(readFileSync(join(fakeHome, '.robrain', 'config.json'), 'utf8')) as Record<string, unknown>
    assert.equal(config.thin, true)
    assert.equal(config.token, 'test-token')
    assert.equal(config.email, 'ade@roryplans.ai')
    assert.equal(config.perceptionUrl, provisioned.perceptionUrl)
    assert.equal(config.embeddingKey, undefined)
    assert.equal(config.embeddingProvider, undefined)
    assert.equal(config.selfHosted, undefined)

    // Sensing bundle was materialized from the fake clone.
    assert.ok(existsSync(join(fakeHome, '.robrain', 'mcp', 'sensing', 'dist', 'index.js')))
  })

  it('buildCloudMcpOptions is thin and keeps the provisioned provider for display only', () => {
    const opts = buildCloudMcpOptions(
      { ...provisioned, embeddingProvider: 'openai' },
      { includeControl: false },
    )
    assert.equal(opts.thin, true)
    assert.equal(opts.embeddingProvider, 'openai')
    assert.equal(opts.embeddingKey, '')
    assert.equal(opts.anthropicKey, '')
    assert.equal(opts.perceptionKey, provisioned.perceptionKey)
  })
})
