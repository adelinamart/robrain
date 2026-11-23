import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// config.ts resolves homedir() at import time — pin a hermetic HOME before the
// dynamic import, so these tests own ~/.robrain/config.json.
const fakeHome = mkdtempSync(join(tmpdir(), 'robrain-explain-'))
process.env.HOME = fakeHome
process.env.FORCE_COLOR = '0'
mkdirSync(join(fakeHome, '.robrain'), { recursive: true })

const { explainCommand } = await import('./explain.js')

const originalCwd = process.cwd()
after(() => {
  process.chdir(originalCwd)
  rmSync(fakeHome, { recursive: true, force: true })
})

/** A decision row as GET /decisions returns it. */
function row(decision: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id:             `id-${decision.replace(/\W+/g, '-').toLowerCase()}`,
    decision,
    rationale:      null,
    rejected:       [],
    files_affected: [],
    confidence:     1,
    created_at:     '2026-11-15T10:00:00.000Z',
    supersedes_id:  null,
    invalidated_at: null,
    quarantined_at: null,
    ...extra,
  }
}

/** Run explainCommand for `path` against a stub store that answers every lookup with `rows`. */
async function explain(path: string, rows: Array<Record<string, unknown>>): Promise<string> {
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/decisions')) { res.end(JSON.stringify({ decisions: rows })); return }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify({
    selfHosted: true, perceptionUrl: `http://127.0.0.1:${address.port}`, installedAt: '2026-10-23T00:00:00Z',
  }))

  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-explain-proj-')))
  const lines: string[] = []
  const { log } = console
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
  process.chdir(projectDir)
  try {
    await explainCommand(path, {})
  } finally {
    console.log = log
    process.chdir(originalCwd)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(projectDir, { recursive: true, force: true })
  }
  return lines.join('\n')
}

const POOL     = 'Use one shared connection pool'
const RETRIES  = 'Retry failed jobs three times'
const REJECTED = 'Open a connection per request'
const HELD     = 'Skip the pool for admin scripts'

describe('explain — decisions linked to the path', () => {
  it('lists only the decisions whose files include the path', async () => {
    const out = await explain('src/db.ts', [
      row(POOL, { files_affected: ['src/db.ts'] }),
      row(RETRIES, { files_affected: ['src/jobs.ts'] }),
    ])

    assert.match(out, /1 decision found/)
    assert.match(out, new RegExp(POOL))
    assert.doesNotMatch(out, new RegExp(RETRIES))
    assert.doesNotMatch(out, /related by topic/)
  })

  it('keeps a superseded decision in the history of its own file, marked as such', async () => {
    const out = await explain('src/db.ts', [
      row(POOL, { files_affected: ['src/db.ts'] }),
      row(REJECTED, { files_affected: ['src/db.ts'], invalidated_at: '2026-11-15T12:00:00.000Z' }),
    ])

    assert.match(out, /2 decisions found/)
    assert.match(out, new RegExp(`${REJECTED}.*\\[superseded\\]`))
  })
})

describe('explain — nothing linked to the path', () => {
  it('says so, and offers the nearest decisions as related, not as found for the file', async () => {
    // Reported: `explain does/not/exist.ts` printed "N decisions found" and
    // listed unrelated decisions, rejected ones included, as "• Chose …".
    const out = await explain('does/not/exist.ts', [
      row(RETRIES, { files_affected: ['src/jobs.ts'] }),
      row(REJECTED, { invalidated_at: '2026-11-15T12:00:00.000Z' }),
    ])

    assert.match(out, /No decisions are linked to this path/)
    assert.match(out, /1 related by topic/)
    assert.match(out, new RegExp(RETRIES))
    assert.doesNotMatch(out, /decisions? found/)
    assert.doesNotMatch(out, new RegExp(REJECTED), 'a retired decision was offered as related context')
  })

  it('reports nothing found when the nearest decisions are all retired', async () => {
    const out = await explain('does/not/exist.ts', [
      row(REJECTED, { invalidated_at: '2026-11-15T12:00:00.000Z' }),
    ])

    assert.match(out, /No decisions found for does\/not\/exist\.ts/)
    assert.doesNotMatch(out, /Chose/)
  })
})

describe('explain — decisions held by trust screening', () => {
  it('never lists one, linked to the path or not', async () => {
    const linked = await explain('src/db.ts', [
      row(POOL, { files_affected: ['src/db.ts'] }),
      row(HELD, { files_affected: ['src/db.ts'], quarantined_at: '2026-11-15T12:00:00.000Z' }),
    ])
    assert.match(linked, /1 decision found/)
    assert.doesNotMatch(linked, new RegExp(HELD))

    const unlinked = await explain('does/not/exist.ts', [
      row(RETRIES),
      row(HELD, { quarantined_at: '2026-11-15T12:00:00.000Z' }),
    ])
    assert.match(unlinked, /1 related by topic/)
    assert.doesNotMatch(unlinked, new RegExp(HELD))
  })
})
