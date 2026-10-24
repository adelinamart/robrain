import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// config.ts resolves homedir() at import time — pin a hermetic HOME before the
// dynamic import, so the on-disk test below owns ~/.robrain/config.json.
const fakeHome = mkdtempSync(join(tmpdir(), 'robrain-config-'))
process.env.HOME = fakeHome
mkdirSync(join(fakeHome, '.robrain'), { recursive: true })

const { splitCloudCredentials, clearCloudCredentials, readConfig } = await import('./config.js')

after(() => rmSync(fakeHome, { recursive: true, force: true }))

describe('logout — splitCloudCredentials', () => {
  it('keeps the self-hosted stack settings and clears only the cloud login', () => {
    // Reported: logout wiped the whole file, so a self-hosted user lost
    // perceptionUrl/perceptionKey and status/init-project broke until they
    // re-ran install --self-hosted.
    const { remaining, cleared, kept } = splitCloudCredentials({
      token: 'rory-token', email: 'a@b.c', planningUrl: 'https://plan', planningKey: 'pk',
      selfHosted: true, perceptionUrl: 'http://127.0.0.1:3001', perceptionKey: 'local-key',
      embeddingProvider: 'openai', embeddingKey: 'emb', installedAt: '2026-10-23T00:00:00Z', version: '2.4.10',
    })
    assert.deepEqual(remaining, {
      selfHosted: true, perceptionUrl: 'http://127.0.0.1:3001', perceptionKey: 'local-key',
      embeddingProvider: 'openai', embeddingKey: 'emb', installedAt: '2026-10-23T00:00:00Z', version: '2.4.10',
    })
    assert.deepEqual(cleared, ['token', 'email', 'planningUrl', 'planningKey'])
    assert.deepEqual(kept, ['selfHosted', 'perceptionUrl', 'perceptionKey', 'embeddingProvider', 'embeddingKey', 'installedAt', 'version'])
  })

  it('clears the Rory-provisioned Perception on a pure cloud install', () => {
    // Those keys were handed out by the cloud login; leaving them behind
    // would keep a live credential on disk after logout.
    const { remaining, cleared } = splitCloudCredentials({
      token: 't', email: 'a@b.c', thin: true,
      perceptionUrl: 'https://perception.roryplans.ai', perceptionKey: 'cloud-key',
      planningUrl: 'https://plan', planningKey: 'pk', installedAt: '2026-10-23T00:00:00Z', version: '2.4.10',
    })
    assert.deepEqual(remaining, { installedAt: '2026-10-23T00:00:00Z', version: '2.4.10' })
    assert.ok(cleared.includes('perceptionUrl'))
    assert.ok(cleared.includes('perceptionKey'))
    assert.ok(cleared.includes('thin'))
  })

  it('treats a legacy install (Perception configured, no token) as self-hosted', () => {
    const { remaining, cleared } = splitCloudCredentials({
      perceptionUrl: 'http://127.0.0.1:3001', installedAt: '2026-01-01T00:00:00Z',
    })
    assert.equal(remaining.perceptionUrl, 'http://127.0.0.1:3001')
    assert.deepEqual(cleared, [])
  })

  it('does not report empty placeholders as cleared or kept', () => {
    // install --self-hosted writes planningUrl/planningKey as '' into mcp.json
    // options; if they ever land in config they are noise, not credentials.
    const { cleared, kept } = splitCloudCredentials({ selfHosted: true, planningUrl: '', planningKey: '' })
    assert.deepEqual(cleared, [])
    assert.deepEqual(kept, ['selfHosted'])
  })
})

describe('logout — clearCloudCredentials on disk', () => {
  it('rewrites config.json without the cloud fields and leaves the rest readable', () => {
    const file = join(fakeHome, '.robrain', 'config.json')
    writeFileSync(file, JSON.stringify({
      token: 't', email: 'a@b.c', selfHosted: true,
      perceptionUrl: 'http://127.0.0.1:3001', perceptionKey: 'k', embeddingProvider: 'openai',
    }))

    const { cleared, kept } = clearCloudCredentials()

    assert.deepEqual(cleared, ['token', 'email'])
    assert.deepEqual(kept, ['selfHosted', 'perceptionUrl', 'perceptionKey', 'embeddingProvider'])
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.token, undefined)
    assert.equal(onDisk.email, undefined)
    assert.equal(onDisk.perceptionKey, 'k')
    assert.equal(readConfig().selfHosted, true)
  })
})
