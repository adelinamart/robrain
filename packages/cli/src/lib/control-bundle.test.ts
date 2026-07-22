import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { downloadControlBundle } from './control-bundle.js'
import { controlBundleReady } from './mcp-bundle.js'

// Stubbed cloud API: /control-bundle/meta + /control-bundle, mutable between
// tests so each case controls the served bytes/hash/status.
const BUNDLE_V1 = '// control bundle v1\nexport {}\n'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const serve = {
  body:       BUNDLE_V1,
  metaSha:    sha(BUNDLE_V1),          // advertised sha (can be forced wrong)
  version:    '0.1.0',
  metaStatus: 200,
  bundleStatus: 200,
  authSeen:   [] as Array<string | undefined>,
}

const stub = createServer((req, res) => {
  serve.authSeen.push(req.headers.authorization)
  if (req.url === '/control-bundle/meta') {
    res.statusCode = serve.metaStatus
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ sha256: serve.metaSha, bytes: Buffer.byteLength(serve.body), version: serve.version }))
    return
  }
  if (req.url === '/control-bundle') {
    res.statusCode = serve.bundleStatus
    res.setHeader('content-type', 'application/javascript')
    res.setHeader('x-bundle-sha256', serve.metaSha)
    res.end(serve.body)
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve))
stub.unref()
const address = stub.address()
assert.ok(address && typeof address === 'object')
const baseUrl = `http://127.0.0.1:${address.port}`

const mcpDir = mkdtempSync(join(tmpdir(), 'robrain-control-dl-'))

after(async () => {
  stub.closeAllConnections()
  await new Promise<void>(resolve => stub.close(() => resolve()))
  rmSync(mcpDir, { recursive: true, force: true })
})

beforeEach(() => {
  serve.body         = BUNDLE_V1
  serve.metaSha      = sha(BUNDLE_V1)
  serve.version      = '0.1.0'
  serve.metaStatus   = 200
  serve.bundleStatus = 200
  serve.authSeen     = []
  rmSync(join(mcpDir, 'control'), { recursive: true, force: true })
})

describe('downloadControlBundle', () => {
  it('downloads, verifies sha256, and materializes the controlBundleReady layout', async () => {
    const result = await downloadControlBundle({ baseUrl, token: 'rp_live_test', robrainMcpDir: mcpDir })
    assert.deepEqual(result, {
      ok:      true,
      updated: true,
      meta:    { sha256: sha(BUNDLE_V1), bytes: Buffer.byteLength(BUNDLE_V1), version: '0.1.0' },
    })

    assert.equal(controlBundleReady(mcpDir), true)
    assert.equal(readFileSync(join(mcpDir, 'control', 'dist', 'index.js'), 'utf8'), BUNDLE_V1)

    // Minimal ESM package.json — same shape as the Sensing bundle marker.
    const pkg = JSON.parse(readFileSync(join(mcpDir, 'control', 'package.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(pkg, { name: 'robrain-control-mcp', private: true, type: 'module', main: './dist/index.js' })

    // Meta manifest for future update checks.
    const meta = JSON.parse(readFileSync(join(mcpDir, 'control', 'meta.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(meta, { sha256: sha(BUNDLE_V1), bytes: Buffer.byteLength(BUNDLE_V1), version: '0.1.0' })

    // Both requests carried the bearer token.
    assert.deepEqual(serve.authSeen, ['Bearer rp_live_test', 'Bearer rp_live_test'])
  })

  it('skips the download when the on-disk bundle already matches the advertised sha', async () => {
    await downloadControlBundle({ baseUrl, token: 't', robrainMcpDir: mcpDir })
    serve.authSeen = []

    const again = await downloadControlBundle({ baseUrl, token: 't', robrainMcpDir: mcpDir })
    assert.ok(again.ok)
    assert.equal(again.updated, false)
    // Only /control-bundle/meta was hit — no second bundle transfer.
    assert.equal(serve.authSeen.length, 1)
  })

  it('refreshes the bundle when the server sha differs (re-run install = update)', async () => {
    await downloadControlBundle({ baseUrl, token: 't', robrainMcpDir: mcpDir })

    const v2 = '// control bundle v2\nexport {}\n'
    serve.body    = v2
    serve.metaSha = sha(v2)
    serve.version = '0.2.0'

    const result = await downloadControlBundle({ baseUrl, token: 't', robrainMcpDir: mcpDir })
    assert.ok(result.ok)
    assert.equal(result.updated, true)
    assert.equal(readFileSync(join(mcpDir, 'control', 'dist', 'index.js'), 'utf8'), v2)
    const meta = JSON.parse(readFileSync(join(mcpDir, 'control', 'meta.json'), 'utf8')) as { version: string }
    assert.equal(meta.version, '0.2.0')
  })

  it('fails soft on a sha256 mismatch and writes nothing', async () => {
    serve.metaSha = sha('something else entirely')

    const result = await downloadControlBundle({ baseUrl, token: 't', robrainMcpDir: mcpDir })
    assert.equal(result.ok, false)
    assert.match((result as { reason: string }).reason, /sha256 mismatch/)
    assert.equal(controlBundleReady(mcpDir), false)
    assert.equal(existsSync(join(mcpDir, 'control')), false)
  })

  it('fails soft when the API answers 404 (bundle not deployed)', async () => {
    serve.metaStatus = 404

    const result = await downloadControlBundle({ baseUrl, token: 't', robrainMcpDir: mcpDir })
    assert.equal(result.ok, false)
    assert.match((result as { reason: string }).reason, /HTTP 404/)
    assert.equal(controlBundleReady(mcpDir), false)
  })

  it('fails soft when the server is unreachable (no throw, no hang)', async () => {
    const result = await downloadControlBundle({
      baseUrl:       'http://127.0.0.1:9',   // discard port — connection refused
      token:         't',
      robrainMcpDir: mcpDir,
      timeoutMs:     2_000,
    })
    assert.equal(result.ok, false)
    assert.equal(controlBundleReady(mcpDir), false)
  })
})
