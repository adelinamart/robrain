// packages/sensing-mcp/src/router.ts
// ─────────────────────────────────────────────────────────────
// Layer C of Sensing — routes classifier output to destinations.
// Stateless. Classifiers do the hard work; router just directs.
// ─────────────────────────────────────────────────────────────

import type { DecisionSignal, IngestSignalResponse, ReplyScore } from '@robrain/shared'
import { config } from './config.js'

export interface RouteDecisionOutcome {
  persisted: boolean
  /** Show in MCP tool JSON so the editor surfaces Perception failures (e.g. unregistered project). */
  userFacing?: string
}

function parsePerceptionUserMessage(status: number, rawText: string): string {
  try {
    const j = JSON.parse(rawText) as { message?: string; hint?: string; error?: string }
    const parts = [j.message, j.hint].filter(Boolean)
    if (parts.length) return parts.join(' ')
  } catch {
    /* ignore */
  }
  return `[Perception HTTP ${status}] ${rawText.slice(0, 500)}`
}

// ── Route decision signal → Perception API ─────────────────

/** Returns persisted=true only when Perception persisted the decision ({ accepted:true, action:'written' }). */
export async function routeDecisionSignal(
  signal: DecisionSignal,
  projectId: string,
): Promise<RouteDecisionOutcome> {
  if (!config.perceptionApiUrl) {
    console.error('[Sensing] Decision signal (PERCEPTION_API_URL unset):', {
      decision_type: signal.decision_type,
      confidence:    signal.confidence,
      files:         signal.files_affected,
      scope:         signal.scope,
    })
    return {
      persisted: false,
      userFacing:
        'PERCEPTION_API_URL is not set — decisions cannot be saved. Configure Perception and restart Sensing.',
    }
  }

  try {
    const res = await fetch(`${config.perceptionApiUrl}/signals`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.perceptionApiKey}`,
        'X-Project-Id':  projectId,
      },
      body: JSON.stringify({ signal }),
    })

    const raw = await res.text()
    if (!res.ok) {
      const msg = parsePerceptionUserMessage(res.status, raw)
      console.error('[Sensing] Perception API error:', res.status, raw)
      return { persisted: false, userFacing: msg }
    }

    let payload: IngestSignalResponse
    try {
      payload = JSON.parse(raw) as IngestSignalResponse
    } catch {
      console.error('[Sensing] Perception /signals returned non-JSON:', raw.slice(0, 500))
      return { persisted: false, userFacing: 'Perception returned invalid JSON for /signals.' }
    }

    if (!payload.accepted || payload.action !== 'written') {
      const soft = [payload.message].filter(Boolean).join(' ')
      console.error(
        '[Sensing] Perception did not persist signal:',
        payload.action,
        payload.message ?? '',
      )
      return {
        persisted: false,
        userFacing: soft || 'Perception did not persist this signal (discarded or below threshold).',
      }
    }
    return { persisted: true }
  } catch (err) {
    console.error('[Sensing] Failed to reach Perception API:', err)
    return {
      persisted: false,
      userFacing: `Could not reach Perception: ${String(err)}`,
    }
  }
}

// ── Route reply score → Perception API ────────────────────

export async function routeReplyScore(score: ReplyScore): Promise<void> {
  if (!config.perceptionApiUrl) {
    console.error('[Sensing] Reply score (PERCEPTION_API_URL unset):', score)
    return
  }

  try {
    await fetch(`${config.perceptionApiUrl}/scores`, {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'Authorization': `Bearer ${config.perceptionApiKey}`,
      },
      body: JSON.stringify({ scores: [score] }),
    })
  } catch (err) {
    console.error('[Sensing] Failed to route reply score:', err)
  }
}

// ── Route raw flush turns → Perception (needs_classification) ─

export async function routeFlushTurns(
  turns: Array<import('@robrain/shared').SessionTurn>,
  projectId: string,
): Promise<string[]> {
  const errors: string[] = []
  if (turns.length === 0) return errors

  if (!config.perceptionApiUrl) {
    console.error(`[Sensing] Flush: ${turns.length} unclassified turns (PERCEPTION_API_URL unset)`)
    errors.push('PERCEPTION_API_URL is not set — flush could not reach Perception.')
    return errors
  }

  const signals = turns.map(turn => ({
    signal: {
      turn,
      decision_type: 'unknown',
      confidence:    0.5,
      files_affected: turn.files_touched,
      scope:          'team' as const,
      needs_classification: true,
    },
  }))

  await Promise.allSettled(
    signals.map(async s => {
      try {
        const res = await fetch(`${config.perceptionApiUrl}/signals`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${config.perceptionApiKey}`,
            'X-Project-Id':  projectId,
          },
          body: JSON.stringify(s),
        })
        const raw = await res.text()
        if (!res.ok) {
          errors.push(parsePerceptionUserMessage(res.status, raw))
        }
      } catch (err) {
        errors.push(`Flush route failed: ${String(err)}`)
      }
    }),
  )
  return errors
}
