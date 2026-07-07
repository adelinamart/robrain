// packages/sensing-mcp/src/session-registry.ts
// ─────────────────────────────────────────────────────────────
// Active session registry — memory-first, mirrored to a small
// JSON file so sessions survive MCP server restarts (editor
// reconnect, crash, upgrade). Without the mirror a restart made
// sensing_record_turn error with "Session not found", forcing
// clients to start a fresh session and splitting one real
// conversation across multiple session rows in Postgres.
// ─────────────────────────────────────────────────────────────

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ActiveSession {
  project_id:  string
  started_at:  Date
  turn_count:  number
}

interface PersistedSession {
  project_id: string
  started_at: string
}

interface RegistryFile {
  last_project_id?: string
  sessions: Record<string, PersistedSession>
}

// Sessions that never saw sensing_end_session are pruned from the mirror
// after this long, so the file cannot grow without bound.
const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000

export class SessionRegistry {
  private sessions = new Map<string, ActiveSession>()

  constructor(private filePath: string) {}

  get(session_id: string): ActiveSession | undefined {
    return this.sessions.get(session_id)
  }

  /** Register a fresh session (sensing_start_session) and mirror it to disk. */
  register(session_id: string, project_id: string): ActiveSession {
    const session: ActiveSession = {
      project_id,
      started_at: new Date(),
      turn_count:  0,
    }
    this.sessions.set(session_id, session)
    this.save(file => {
      file.last_project_id = project_id
      file.sessions[session_id] = {
        project_id,
        started_at: session.started_at.toISOString(),
      }
    })
    return session
  }

  /**
   * Re-register a session found in the file mirror but not in memory — i.e.
   * the server restarted mid-conversation. turn_count restarts at 0: it is
   * per-process diagnostics only; the buffer and Postgres rows are what matter.
   */
  resume(session_id: string): ActiveSession | null {
    const persisted = this.load().sessions[session_id]
    if (!persisted) return null
    const session: ActiveSession = {
      project_id: persisted.project_id,
      started_at: new Date(persisted.started_at),
      turn_count:  0,
    }
    this.sessions.set(session_id, session)
    return session
  }

  /**
   * Adopt a session id we have no record of at all (mirror file lost or
   * pruned). Falls back to the last project this registry saw — one Sensing
   * process serves one editor/repo, so that is almost always right.
   */
  adopt(session_id: string): ActiveSession {
    const project_id = this.load().last_project_id ?? 'default'
    return this.register(session_id, project_id)
  }

  /** Drop a session (sensing_end_session) from memory and the file mirror. */
  remove(session_id: string): void {
    this.sessions.delete(session_id)
    this.save(file => {
      delete file.sessions[session_id]
    })
  }

  // ── File mirror (best-effort — registry I/O must never break recording) ──

  private load(): RegistryFile {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as RegistryFile
      return { last_project_id: raw.last_project_id, sessions: raw.sessions ?? {} }
    } catch {
      // Missing or corrupt file = empty registry
      return { sessions: {} }
    }
  }

  private save(mutate: (file: RegistryFile) => void): void {
    try {
      // Read-mutate-write so concurrent Sensing processes sharing the file
      // do not clobber each other's sessions.
      const file = this.load()
      const cutoff = Date.now() - STALE_SESSION_MS
      for (const [id, s] of Object.entries(file.sessions)) {
        if (new Date(s.started_at).getTime() < cutoff) delete file.sessions[id]
      }
      mutate(file)
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(file, null, 2))
    } catch (err) {
      console.error('[Sensing] Session registry write failed (continuing in-memory):', err)
    }
  }
}
