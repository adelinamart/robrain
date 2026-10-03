/** Abandoned sessions never call end_session, so the map is capped. */
export const MAX_PENDING_CONFLICT_NOTICES = 1_000

/**
 * Holds one heads-up for a session. A new session past the cap drops the
 * oldest entry. An update to a session already in the map does not.
 * The same notice text is stored once.
 */
export function rememberConflictNotice(
  notices: Map<string, string[]>,
  sessionId: string,
  notice: string,
  maxSessions = MAX_PENDING_CONFLICT_NOTICES,
): void {
  const held = notices.get(sessionId) ?? []
  const alreadyHeld = notices.has(sessionId)
  if (!held.includes(notice)) held.push(notice)
  if (!alreadyHeld && notices.size >= maxSessions) {
    const oldestSessionId = notices.keys().next().value
    if (oldestSessionId !== undefined) notices.delete(oldestSessionId)
  }
  notices.set(sessionId, held)
}
