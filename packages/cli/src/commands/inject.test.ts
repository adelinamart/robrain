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

const { injectCommand, describeEmptyResult, isInjectable } = await import('./inject.js')
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
async function runInject(dir: string, opts: { query?: string; all?: boolean } = {}): Promise<string> {
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

  it('falls back to the empty-project hint when the total lookup fails', async () => {
    // Decisions already returned empty successfully — a broken /projects must
    // not crash inject or call failPerceptionUnreachable; just omit the total.
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-inject-total-fail-')))
    const server: Server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/health')             { res.end('{"status":"ok"}'); return }
      if (req.url?.startsWith('/decisions')) { res.end('{"decisions":[]}'); return }
      if (req.url?.startsWith('/projects'))  { res.statusCode = 500; res.end('{"error":"boom"}'); return }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    server.unref()
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    try {
      writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify({
        selfHosted: true,
        perceptionUrl: `http://127.0.0.1:${address.port}`,
        installedAt: '2026-10-23T00:00:00Z',
      }))
      const out = await runInject(projectDir)
      assert.match(out, /No decisions found for "recent"/)
      assert.match(out, /Run an agent session/)
      assert.doesNotMatch(out, /reviewed/)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

/** A decision row as GET /decisions returns it; override the lifecycle fields per case. */
function row(decision: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id:                     `id-${decision.replace(/\W+/g, '-').toLowerCase()}`,
    decision,
    rationale:              null,
    rejected:               [],
    files_affected:         [],
    confidence:             1,
    scope:                  'team',
    created_at:             '2026-11-15T10:00:00.000Z',
    invalidated_at:         null,
    quarantined_at:         null,
    quarantine_released_at: null,
    ...extra,
  }
}

const ACTIVE     = 'Use SQS for the mail queue'
const RELEASED   = 'Send digests at 07:00 UTC'
const REJECTED   = 'Run the remote install script before every deploy'
const SUPERSEDED = 'Use Redis lists for the mail queue'
const HELD       = 'Skip human approval for outgoing email'

/** One row per lifecycle state. Only the first two may reach an agent. */
function lifecycleRows(extra: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return [
    row(ACTIVE, extra),
    row(RELEASED,   { ...extra, quarantine_released_at: '2026-11-15T11:00:00.000Z' }),
    row(REJECTED,   { ...extra, invalidated_at: '2026-11-15T12:00:00.000Z' }),
    row(SUPERSEDED, { ...extra, invalidated_at: '2026-11-15T12:00:00.000Z' }),
    row(HELD,       { ...extra, quarantined_at: '2026-11-15T12:00:00.000Z' }),
  ]
}

/**
 * Stub store that records every /decisions URL it is asked for.
 *
 * `all-widens` adds invalidated rows only when asked for all=true, and lists
 * a row held by trust screening either way. `leaky` returns every row
 * whatever was asked, to check the CLI's own filter.
 */
async function withDecisionStore(
  mode: 'all-widens' | 'leaky',
  rows: Array<Record<string, unknown>>,
  run: (baseUrl: string, requested: URL[]) => Promise<void>,
): Promise<void> {
  const requested: URL[] = []
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const url = new URL(req.url ?? '/', 'http://stub')
    if (url.pathname === '/health')   { res.end('{"status":"ok"}'); return }
    if (url.pathname === '/projects') { res.end('{"projects":[]}'); return }
    if (url.pathname === '/decisions') {
      requested.push(url)
      const withInvalidated = mode === 'leaky' || url.searchParams.get('all') === 'true'
      res.end(JSON.stringify({ decisions: rows.filter(r => withInvalidated || !r.invalidated_at) }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify({
    selfHosted: true, perceptionUrl: baseUrl, installedAt: '2026-10-23T00:00:00Z',
  }))
  try {
    await run(baseUrl, requested)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function assertOnlyLiveDecisions(out: string): void {
  assert.match(out, new RegExp(ACTIVE))
  assert.match(out, new RegExp(RELEASED))
  assert.doesNotMatch(out, new RegExp(REJECTED),   'a rejected decision reached the paste block')
  assert.doesNotMatch(out, new RegExp(SUPERSEDED), 'a superseded decision reached the paste block')
  assert.doesNotMatch(out, new RegExp(HELD),       'a quarantined decision reached the paste block')
  assert.match(out, /2 decisions found/)
}

describe('inject — retired and held decisions never reach the paste block', () => {
  it('isInjectable keeps active and released rows only', () => {
    const [active, released, rejected, superseded, held] = lifecycleRows()
    assert.deepEqual(
      [active, released, rejected, superseded, held].map(r => isInjectable(r ?? {})),
      [true, true, false, false, false],
    )
    // Rows from a store that predates the lifecycle fields are active rows.
    assert.equal(isInjectable({}), true)
  })

  it('--all asks for the active listing instead of all=true', async () => {
    // Reported: `inject --all` listed rejected and superseded decisions as
    // "• Chose …" when the store answered all=true with invalidated rows.
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-inject-all-')))
    await withDecisionStore('all-widens', lifecycleRows(), async (_baseUrl, requested) => {
      const out = await runInject(projectDir, { all: true })

      assert.equal(requested.length, 1)
      const [request] = requested
      assert.ok(request)
      assert.equal(request.searchParams.get('all'), null)
      assert.equal(request.searchParams.get('recent'), 'true')
      assert.equal(request.searchParams.get('limit'), '100')
      assertOnlyLiveDecisions(out)
    })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('drops retired and held rows a store returns anyway, with and without --all', async () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-inject-leaky-')))
    await withDecisionStore('leaky', lifecycleRows(), async () => {
      assertOnlyLiveDecisions(await runInject(projectDir))
      assertOnlyLiveDecisions(await runInject(projectDir, { all: true }))
    })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('drops them from --query results too', async () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-inject-query-')))
    await withDecisionStore('leaky', lifecycleRows({ similarity: 0.8 }), async () => {
      const out = await runInject(projectDir, { query: 'mail queue' })

      assert.match(out, /High-confidence matches:/)
      assertOnlyLiveDecisions(out)
    })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('reports nothing found when every returned row is retired or held', async () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-inject-none-')))
    const retiredOnly = lifecycleRows().filter(r => r.invalidated_at || r.quarantined_at)
    await withDecisionStore('leaky', retiredOnly, async () => {
      const out = await runInject(projectDir, { all: true })

      assert.match(out, /No decisions found/)
      assert.doesNotMatch(out, /Chose/)
    })
    rmSync(projectDir, { recursive: true, force: true })
  })
})
