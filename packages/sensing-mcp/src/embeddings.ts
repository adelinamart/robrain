// packages/sensing-mcp/src/embeddings.ts
// ─────────────────────────────────────────────────────────────
// Thin adapter binding the shared embedding client (@robrain/shared)
// to this package's env config. Provider switch, retry/abort, and
// 1536-dim padding all live in shared/src/embeddings.ts — the same
// code Perception uses, so the two can no longer drift.
//
// Storage backend: pgvector (not Pinecone). Self-hosted OSS keeps
// embeddings co-located with `decisions` rows so search_decisions()
// can filter on project_id / invalidated_at in a single query, and
// users don't need a managed SaaS account to run `pnpm docker:up`.
// ─────────────────────────────────────────────────────────────

import { embed as sharedEmbed } from '@robrain/shared'
import { config } from './config.js'

export { cosineSimilarity, cosineDistance } from '@robrain/shared'

export function embed(text: string, signal?: AbortSignal): Promise<number[]> {
  return sharedEmbed(
    text,
    {
      provider:     config.embeddingProvider,
      openaiApiKey: config.openaiApiKey,
      openaiModel:  config.openaiEmbeddingModel,
      voyageApiKey: config.voyageApiKey,
      voyageModel:  config.voyageEmbeddingModel,
      cohereApiKey: config.cohereApiKey,
      cohereModel:  config.cohereEmbeddingModel,
    },
    signal,
  )
}
