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

const { splitCloudCredentials, clearCloudCredentials, readConfig, resolveInstallId } = await import('./config.js')

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

describe('install id — one per machine', () => {
  const file = join(fakeHome, '.robrain', 'config.json')
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const SAVED = '0b1f6c1e-3c58-4e0e-9a55-0d4f6f0a7a11'

  it('reuses the saved id, so a reinstall replaces this machine\'s key and no other', () => {
    assert.equal(resolveInstallId({ installId: SAVED }), SAVED)
    assert.equal(resolveInstallId({ installId: SAVED.toUpperCase() }), SAVED)
  })

  it('makes a new random id when none is saved', () => {
    const first = resolveInstallId({})
    assert.match(first, UUID)
    assert.notEqual(resolveInstallId({}), first)
  })

  it('replaces a value the cloud API would refuse', () => {
    assert.match(resolveInstallId({ installId: 'my-laptop' }), UUID)
  })

  it('does not write the config file', () => {
    rmSync(file, { force: true })
    resolveInstallId(readConfig())
    assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/)
  })

  it('survives logout, since it names the machine and not the account', () => {
    writeFileSync(file, JSON.stringify({ token: 't', email: 'a@b.c', thin: true, perceptionKey: 'k', installId: SAVED }))

    const { cleared } = clearCloudCredentials()

    assert.equal(cleared.includes('installId'), false)
    assert.equal(readConfig().installId, SAVED)
  })
})
