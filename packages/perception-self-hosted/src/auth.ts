// Timing-safe bearer-token check for the global auth middleware.
// Pure module so it can be unit-tested without booting the server.

import { timingSafeEqual } from 'node:crypto'

/**
 * Compares the Authorization header against `Bearer <apiKey>` in constant
 * time. Length guard first — timingSafeEqual throws on unequal lengths, and
 * an attacker learns nothing useful from total-length mismatches.
 */
export function bearerAuthorized(header: string | undefined, apiKey: string): boolean {
  if (!header || !apiKey) return false
  const provided = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${apiKey}`)
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}
