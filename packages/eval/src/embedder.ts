// packages/eval/src/embedder.ts
// ─────────────────────────────────────────────────────────────
// Deterministic bag-of-tokens hash embedder — a stand-in for the
// real embedding provider so the eval runs offline and gives the
// same numbers on every machine. Pluggable: anything matching
// `Embedder` can replace it (e.g. a real provider client) to eval
// against production embeddings.
// ─────────────────────────────────────────────────────────────

export type Embedder = (text: string) => number[]

export const EMBEDDING_DIM = 64

/** FNV-1a — stable 32-bit hash, no dependencies. */
function hashToken(token: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export const hashEmbedder: Embedder = (text) => {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0)
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)

  for (const t of tokens) {
    const h = hashToken(t)
    vec[h % EMBEDDING_DIM]! += 1
    vec[(h >>> 8) % EMBEDDING_DIM]! += 0.5   // second bucket softens collisions
  }

  const norm = Math.hypot(...vec) || 1
  return vec.map(v => v / norm)
}

/** Cosine similarity — inputs from hashEmbedder are unit-normalized, so this is a dot product. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}
