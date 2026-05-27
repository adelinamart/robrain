// packages/sensing-mcp/src/buffer.ts
// ─────────────────────────────────────────────────────────────
// Stream buffer — Layer A of the Sensing architecture.
// Captures every session turn immediately and synchronously.
// Never blocks. Classifier runs async from this buffer.
// ─────────────────────────────────────────────────────────────

import type { SessionTurn } from '@robrain/shared'
import { config } from './config.js'

interface BufferedTurn {
  turn: SessionTurn
  buffered_at: Date
  classified: boolean
}

class StreamBuffer {
  private buffer = new Map<string, BufferedTurn[]>() // session_id → turns

  // ── Write (synchronous, instant) ──────────────────────────

  push(turn: SessionTurn): void {
    const existing = this.buffer.get(turn.session_id) ?? []

    // Enforce max buffer size — drop oldest if full (recency bias)
    if (existing.length >= config.bufferMaxSize) {
      existing.shift()
    }

    existing.push({
      turn,
      buffered_at: new Date(),
      classified: false,
    })

    this.buffer.set(turn.session_id, existing)
  }

  // ── Read ───────────────────────────────────────────────────

  getUnclassified(session_id: string): SessionTurn[] {
    return (this.buffer.get(session_id) ?? [])
      .filter(b => !b.classified)
      .map(b => b.turn)
  }

  getAll(session_id: string): SessionTurn[] {
    return (this.buffer.get(session_id) ?? []).map(b => b.turn)
  }

  // ── Mark classified ────────────────────────────────────────

  markClassified(session_id: string, sequence: number): void {
    const turns = this.buffer.get(session_id)
    if (!turns) return
    const entry = turns.find(b => b.turn.sequence === sequence)
    if (entry) entry.classified = true
  }

  // ── Flush on close ─────────────────────────────────────────
  // Returns all unclassified turns for a session, then clears.
  // Called by sensing_end_session; Perception ingest runs in the background.

  flush(session_id: string): SessionTurn[] {
    const unclassified = this.getUnclassified(session_id)
    this.buffer.delete(session_id)
    return unclassified
  }

  // ── Stats ──────────────────────────────────────────────────

  stats(session_id: string): { total: number; unclassified: number } {
    const turns = this.buffer.get(session_id) ?? []
    return {
      total:        turns.length,
      unclassified: turns.filter(b => !b.classified).length,
    }
  }
}

// Singleton — one buffer for the lifetime of the MCP server process
export const streamBuffer = new StreamBuffer()
