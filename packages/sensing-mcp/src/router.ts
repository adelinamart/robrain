// packages/sensing-mcp/src/router.ts
// ─────────────────────────────────────────────────────────────
// Layer C of Sensing — routes classifier output to destinations.
// Stateless. Classifiers do the hard work; router just directs.
// ─────────────────────────────────────────────────────────────

import type { DecisionSignal, IngestSignalResponse, ReplyScore } from '@robrain/shared'
import { config } from './config.js'

// ── Route decision signal → Perception API ─────────────────

/** Returns true only when Perception persisted the decision ({ accepted:true, action:'written' }). */
export async function routeDecisionSignal(signal: DecisionSignal, projectId: string): Promise<boolean> {
  if (!config.perceptionApiUrl) {
    console.log('[Sensing] Decision signal (PERCEPTION_API_URL unset):', {
      decision_type: signal.decision_type,
      confidence:    signal.confidence,
      files:         signal.files_affected,
      scope:         signal.scope,
    })
    return false
  }

  try {
    const res = await fetch(`${config.perceptionApiUrl}/signals`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.perceptionApiKey}`,
        'X-Project-Id':  projectId,   // Bug 3 fix: always include project ID
      },
      body: JSON.stringify({ signal }),
    })

    const raw = await res.text()
    if (!res.ok) {
      console.error('[Sensing] Perception API error:', res.status, raw)
      return false
    }

    let payload: IngestSignalResponse
    try {
      payload = JSON.parse(raw) as IngestSignalResponse
    } catch {
      console.error('[Sensing] Perception /signals returned non-JSON:', raw.slice(0, 500))
      return false
    }

    // Perception often returns HTTP 200 for discarded signals — body must drive success.
    if (!payload.accepted || payload.action !== 'written') {
      console.error(
        '[Sensing] Perception did not persist signal:',
        payload.action,
        payload.message ?? '',
      )
      return false
    }
    return true
  } catch (err) {
    console.error('[Sensing] Failed to reach Perception API:', err)
    return false
  }
}

// ── Route reply score → Perception API ────────────────────

export async function routeReplyScore(score: ReplyScore): Promise<void> {
  if (!config.perceptionApiUrl) {
    console.log('[Sensing] Reply score (PERCEPTION_API_URL unset):', score)
    return
  }

  try {
    await fetch(`${config.perceptionApiUrl}/scores`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
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
): Promise<void> {
  if (turns.length === 0) return

  if (!config.perceptionApiUrl) {
    console.log(`[Sensing] Flush: ${turns.length} unclassified turns (PERCEPTION_API_URL unset)`)
    return
  }

  const signals = turns.map(turn => ({
    signal: {
      turn,
      decision_type: 'unknown',
      confidence:    0.5,
      files_affected: turn.files_touched,
      scope:         'team' as const,
      needs_classification: true,
    }
  }))

  await Promise.allSettled(
    signals.map(s =>
      fetch(`${config.perceptionApiUrl}/signals`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.perceptionApiKey}`,
          'X-Project-Id':  projectId,   // Bug 3 fix
        },
        body: JSON.stringify(s),
      }).catch(err => console.error('[Sensing] Flush route failed:', err))
    )
  )
}
