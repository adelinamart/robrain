import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// config.ts resolves homedir() at import time — pin a hermetic HOME before the
// dynamic imports, so the integration test below owns ~/.robrain/config.json.
const fakeHome = mkdtempSync(join(tmpdir(), 'robrain-status-'))
process.env.HOME = fakeHome
process.env.FORCE_COLOR = '0'
mkdirSync(join(fakeHome, '.robrain'), { recursive: true })

const { lookUpRegistration, describeRegistration, registrationHint, statusCommand } = await import('./status.js')
const { deriveProjectId } = await import('../lib/project.js')

/**
 * Stub Perception. `projects` is what GET /projects returns; `null` = 500,
 * `'401'` = an authenticated store rejecting the key (health stays OK, as it
 * is unauthenticated by design).
 */
async function withStub(
  projects: Array<{ id: string; decision_count?: number }> | null | '401' | 'bad-shape',
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') { res.end('{"status":"ok"}'); return }
    if (req.url?.startsWith('/projects')) {
      if (projects === '401')       { res.statusCode = 401; res.end('{"error":"Unauthorized"}'); return }
      if (projects === null)        { res.statusCode = 500; res.end('{}'); return }
      if (projects === 'bad-shape') { res.end('{"data":{"items":[]}}'); return }
      res.end(JSON.stringify({ projects }))
      return
    }
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

describe('status — project registration lookup', () => {
  it('reports a registered project with its decision count', async () => {
    await withStub([{ id: 'abc123', decision_count: 12 }], async baseUrl => {
      const reg = await lookUpRegistration({ perceptionUrl: baseUrl }, 'abc123')
      assert.deepEqual(reg, { reachable: true, state: 'registered', decisions: 12 })
    })
  })

  it('reports unregistered when this directory has no project row', async () => {
    // Radu's case: a clean install, init-project skipped, `status` run in a
    // directory whose id is only ever derived from the path.
    await withStub([{ id: 'someone-else', decision_count: 3 }], async baseUrl => {
      const reg = await lookUpRegistration({ perceptionUrl: baseUrl }, 'abc123')
      assert.deepEqual(reg, { reachable: true, state: 'unregistered' })
    })
  })

  it('says unknown — never "unregistered" — when the store cannot be reached', async () => {
    // Claiming a project is missing because the API is down would send people
    // off to re-init a project that already exists.
    const reg = await lookUpRegistration({ perceptionUrl: 'http://127.0.0.1:1' }, 'abc123')
    assert.equal(reg.state, 'unknown')
    assert.equal(reg.reachable, false)
  })

  it('says unknown when the projects endpoint errors but health is fine', async () => {
    await withStub(null, async baseUrl => {
      const reg = await lookUpRegistration({ perceptionUrl: baseUrl }, 'abc123')
      assert.deepEqual(reg, { reachable: true, state: 'unknown' })
    })
  })

  it('says unknown — not unregistered — when the response shape is unexpected', async () => {
    // Absence is only provable from a well-formed list. A differently-shaped
    // response (e.g. a cloud API that answers another way) previously landed
    // on `unregistered`, which tells a user with a live project to re-init it.
    await withStub('bad-shape', async baseUrl => {
      const reg = await lookUpRegistration({ perceptionUrl: baseUrl }, 'abc123')
      assert.deepEqual(reg, { reachable: true, state: 'unknown' })
    })
  })

  it('says unknown with no Perception configured at all', async () => {
    const reg = await lookUpRegistration({}, 'abc123')
    assert.deepEqual(reg, { reachable: false, state: 'unknown' })
  })
})

describe('status — how registration reads', () => {
  it('points an unregistered directory at init-project', () => {
    const reg = { reachable: true, state: 'unregistered' } as const
    assert.match(describeRegistration(reg), /not registered/)
    assert.match(String(registrationHint(reg)), /npx robrain init-project/)
  })

  it('flags a registered project with zero decisions (the silent-Sensing tell)', () => {
    const text = describeRegistration({ reachable: true, state: 'registered', decisions: 0 })
    assert.match(text, /registered/)
    assert.match(text, /0 decisions/)
  })

  it('never tells the user to init-project when the answer is unknown', () => {
    const reg = { reachable: false, state: 'unknown' } as const
    assert.match(describeRegistration(reg), /unknown/)
    assert.equal(registrationHint(reg), null)
  })

  it('distinguishes a rejected API key from a store it could not reach', async () => {
    await withStub('401', async baseUrl => {
      const reg = await lookUpRegistration({ perceptionUrl: baseUrl, perceptionKey: 'wrong' }, 'abc123')
      assert.deepEqual(reg, { reachable: true, state: 'auth_failed' })
      assert.match(describeRegistration(reg), /rejected this API key/)
      assert.match(String(registrationHint(reg)), /robrain install/)
      // Must not read as "your project is gone".
      assert.doesNotMatch(describeRegistration(reg), /not registered/)
    })
  })
})

/** Run statusCommand in `dir` with console captured. */
async function runStatus(dir: string): Promise<string> {
  const lines: string[] = []
  const { log } = console
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
  process.chdir(dir)
  try {
    await statusCommand()
  } finally {
    console.log = log
    process.chdir(originalCwd)
  }
  return lines.join('\n')
}

describe('status — rendered output', () => {
  it('reports a registered project with its count, and names the id source', async () => {
    // realpath: on macOS mkdtemp hands back /var/... while cwd() reports the
    // resolved /private/var/... — the id is a hash of the path, so it must be
    // derived from the same string statusCommand will see.
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-status-proj-')))
    const id = deriveProjectId(projectDir)
    await withStub([{ id, decision_count: 7 }], async baseUrl => {
      writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify({
        selfHosted: true, perceptionUrl: baseUrl, installedAt: '2026-07-25T00:00:00Z',
      }))

      const out = await runStatus(projectDir)

      assert.match(out, new RegExp(`ID:\\s+${id}`))
      assert.match(out, /derived from this directory path/)
      assert.match(out, /Memory:\s+registered · 7 decisions/)
      assert.doesNotMatch(out, /init-project/)
    })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('says a directory is not registered instead of implying membership', async () => {
    // The report that prompted this: clean install, init-project skipped, and
    // `status` still looked like the user was inside a live project.
    const projectDir = mkdtempSync(join(tmpdir(), 'robrain-status-unreg-'))
    await withStub([], async baseUrl => {
      writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify({
        selfHosted: true, perceptionUrl: baseUrl, installedAt: '2026-07-25T00:00:00Z',
      }))

      const out = await runStatus(projectDir)

      assert.match(out, /Memory:\s+not registered/)
      assert.match(out, /npx robrain init-project/)
      assert.doesNotMatch(out, /registered ·/)   // no decision count for a project that isn't there
    })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('names the exact editor file when one pins the id', async () => {
    // init-project writes three files; the Cursor rule is the easy one to
    // forget, so the hint must name whichever actually supplied the id.
    const projectDir = mkdtempSync(join(tmpdir(), 'robrain-status-pinned-'))
    mkdirSync(join(projectDir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(
      join(projectDir, '.cursor', 'rules', 'robrain.mdc'),
      '<!-- robrain -->\nsensing_start_session(project_id="pinned123abc")\n<!-- /robrain -->\n',
    )
    await withStub([], async baseUrl => {
      writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify({
        selfHosted: true, perceptionUrl: baseUrl, installedAt: '2026-07-25T00:00:00Z',
      }))

      const out = await runStatus(projectDir)

      assert.match(out, /ID:\s+pinned123abc/)
      assert.match(out, /pinned in \.cursor\/rules\/robrain\.mdc/)
      assert.doesNotMatch(out, /derived from this directory path/)
    })
    rmSync(projectDir, { recursive: true, force: true })
  })
})
