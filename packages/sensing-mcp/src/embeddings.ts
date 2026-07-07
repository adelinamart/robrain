// packages/sensing-mcp/src/embeddings.ts
// ─────────────────────────────────────────────────────────────
// Thin wrapper over the shared embedding client (@robrain/shared),
// bound to this server's config. Provider/model/timeout/retry all
// live in the shared module so Sensing and Perception cannot drift
// onto different embedding spaces.
// ─────────────────────────────────────────────────────────────

import { embed as sharedEmbed } from '@robrain/shared'
import { config } from './config.js'

export { cosineSimilarity, cosineDistance } from '@robrain/shared'

export async function embed(text: string, signal?: AbortSignal): Promise<number[]> {
  return sharedEmbed(text, config.embedding, signal)
}
