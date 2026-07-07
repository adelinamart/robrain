import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionRegistry } from './session-registry.js'

function tempRegistryPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'robrain-sensing-registry-'))
  return {
    path: join(dir, 'sessions.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('SessionRegistry', () => {
  it('register then get returns the session', () => {
    const { path, cleanup } = tempRegistryPath()
    try {
      const registry = new SessionRegistry(path)
      registry.register('session-1', 'robrain')
      const session = registry.get('session-1')
      assert.ok(session)
      assert.equal(session.project_id, 'robrain')
      assert.equal(session.turn_count, 0)
    } finally {
      cleanup()
    }
  })

  it('resume finds a session registered by a previous process (restart)', () => {
    const { path, cleanup } = tempRegistryPath()
    try {
      new SessionRegistry(path).register('session-1', 'robrain')

      // Fresh instance = restarted server: empty memory, same mirror file
      const restarted = new SessionRegistry(path)
      assert.equal(restarted.get('session-1'), undefined)
      const resumed = restarted.resume('session-1')
      assert.ok(resumed)
      assert.equal(resumed.project_id, 'robrain')
      // Now in memory too
      assert.ok(restarted.get('session-1'))
    } finally {
      cleanup()
    }
  })

  it('resume returns null for a session the mirror never saw', () => {
    const { path, cleanup } = tempRegistryPath()
    try {
      assert.equal(new SessionRegistry(path).resume('never-registered'), null)
    } finally {
      cleanup()
    }
  })

  it('adopt falls back to the last registered project_id', () => {
    const { path, cleanup } = tempRegistryPath()
    try {
      new SessionRegistry(path).register('session-1', 'robrain')

      const restarted = new SessionRegistry(path)
      const adopted = restarted.adopt('mystery-session')
      assert.equal(adopted.project_id, 'robrain')
      // Adopted sessions are mirrored like registered ones
      const third = new SessionRegistry(path)
      assert.ok(third.resume('mystery-session'))
    } finally {
      cleanup()
    }
  })

  it('adopt uses "default" when the mirror is empty', () => {
    const { path, cleanup } = tempRegistryPath()
    try {
      const registry = new SessionRegistry(path)
      assert.equal(registry.adopt('mystery-session').project_id, 'default')
    } finally {
      cleanup()
    }
  })

  it('remove drops the session from memory and the mirror', () => {
    const { path, cleanup } = tempRegistryPath()
    try {
      const registry = new SessionRegistry(path)
      registry.register('session-1', 'robrain')
      registry.remove('session-1')
      assert.equal(registry.get('session-1'), undefined)
      assert.equal(new SessionRegistry(path).resume('session-1'), null)
    } finally {
      cleanup()
    }
  })

  it('tolerates a corrupt mirror file', () => {
    const { path, cleanup } = tempRegistryPath()
    try {
      writeFileSync(path, 'not json{{{', 'utf8')
      const registry = new SessionRegistry(path)
      assert.equal(registry.resume('session-1'), null)
      registry.register('session-1', 'robrain')
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        sessions: Record<string, { project_id: string }>
      }
      assert.equal(raw.sessions['session-1']?.project_id, 'robrain')
    } finally {
      cleanup()
    }
  })

  it('does not resurrect sessions from other ids on save (read-merge-write)', () => {
    const { path, cleanup } = tempRegistryPath()
    try {
      // Two registry instances sharing one mirror (two Sensing processes)
      const a = new SessionRegistry(path)
      const b = new SessionRegistry(path)
      a.register('session-a', 'project-a')
      b.register('session-b', 'project-b')
      // a's save must not have clobbered b's entry and vice versa
      const fresh = new SessionRegistry(path)
      assert.ok(fresh.resume('session-a'))
      assert.ok(fresh.resume('session-b'))
    } finally {
      cleanup()
    }
  })
})
