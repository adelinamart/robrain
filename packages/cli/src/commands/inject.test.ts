import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// config.ts resolves homedir() at import time — pin a hermetic HOME before the
// dynamic imports, so the integration tests below own ~/.robrain/config.json.
const fakeHome = mkdtempSync(join(tmpdir(), 'robrain-inject-'))
process.env.HOME = fakeHome
process.env.FORCE_COLOR = '0'
mkdirSync(join(fakeHome, '.robrain'), { recursive: true })

const { injectCommand, describeEmptyResult } = await import('./inject.js')
const { deriveProjectId } = await import('../lib/project.js')

/**
 * Stub Perception: GET /decisions always answers with an empty list (the
 * no-query listing only returns unreviewed rows); GET /projects reports the
 * project's total so the CLI can tell "empty" from "all reviewed".
 */
async function withStub(
  projects: Array<{ id: string; decision_count?: number }>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health')               { res.end('{"status":"ok"}'); return }
    if (req.url?.startsWith('/projects'))    { res.end(JSON.stringify({ projects })); return }
    if (req.url?.startsWith('/decisions'))   { res.end('{"decisions":[]}'); return }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

const originalCwd = process.cwd()
after(() => {
  process.chdir(originalCwd)
  rmSync(fakeHome, { recursive: true, force: true })
})

/** Run injectCommand in `dir` with console captured. */
async function runInject(dir: string, opts: { query?: string } = {}): Promise<string> {
  const lines: string[] = []
  const { log } = console
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
  process.chdir(dir)
  try {
    await injectCommand(opts)
  } finally {
    console.log = log
    process.chdir(originalCwd)
  }
  return lines.join('\n')
}

describe('inject — empty-result wording', () => {
  it('says every decision is reviewed when the project has decisions but none unreviewed', () => {
    // Reported: after approving everything in `robrain review`, inject with
    // no --query claimed "No decisions found … run an agent session first".
    const text = describeEmptyResult({ total: 4 }).join('\n')
    assert.match(text, /All 4 decisions are reviewed/)
    assert.match(text, /--query "<topic>"/)
    assert.doesNotMatch(text, /Run an agent session/)
  })

  it('uses singular wording for one decision', () => {
    assert.match(describeEmptyResult({ total: 1 }).join('\n'), /All 1 decision is reviewed/)
  })

  it('keeps the original hint for a genuinely empty project', () => {
    const text = describeEmptyResult({ total: 0 }).join('\n')
    assert.match(text, /No decisions found for "recent"/)
    assert.match(text, /Run an agent session/)
  })

  it('falls back to the original hint when the total is unknown', () => {
    assert.match(describeEmptyResult({}).join('\n'), /Run an agent session/)
  })

  it('leaves the --query message alone', () => {
    const text = describeEmptyResult({ query: 'auth', total: 9 }).join('\n')
    assert.match(text, /No decisions found for "auth"/)
    assert.match(text, /broader query/)
    assert.doesNotMatch(text, /reviewed/)
  })
})

describe('inject — rendered output against a stub store', () => {
  it('reports the reviewed total instead of telling the user to run a session', async () => {
    // realpath: on macOS mkdtemp hands back /var/... while cwd() reports the
    // resolved /private/var/... — the id is a hash of the path.
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-inject-proj-')))
    const id = deriveProjectId(projectDir)
    await withStub([{ id, decision_count: 3 }], async baseUrl => {
      writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify({
        selfHosted: true, perceptionUrl: baseUrl, installedAt: '2026-10-23T00:00:00Z',
      }))

      const out = await runInject(projectDir)

      assert.match(out, /All 3 decisions are reviewed/)
      assert.doesNotMatch(out, /Run an agent session/)
    })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('still points an empty project at running a session', async () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-inject-empty-')))
    const id = deriveProjectId(projectDir)
    await withStub([{ id, decision_count: 0 }], async baseUrl => {
      writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify({
        selfHosted: true, perceptionUrl: baseUrl, installedAt: '2026-10-23T00:00:00Z',
      }))

      const out = await runInject(projectDir)

      assert.match(out, /No decisions found for "recent"/)
      assert.match(out, /Run an agent session/)
    })
    rmSync(projectDir, { recursive: true, force: true })
  })
})
