// packages/sensing-mcp/src/config.ts
// ─────────────────────────────────────────────────────────────
// All environment variables for the Sensing MCP server.
// Copy .env.example → .env and fill in values before running.
// ─────────────────────────────────────────────────────────────

export const config = {
  // ── Anthropic (needed for decision classifier Stage 2 — Haiku) ─
  // Not validated at process start so the MCP server can boot when Cursor
  // does not inject env (set ANTHROPIC_API_KEY in MCP server config or shell).
  // If unset, keyword hits still run but LLM extraction is skipped.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel:  process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',

  // ── Embeddings (for topic-shift in sensing_record_turn unless disabled) ─
  // Choose ONE provider by setting EMBEDDING_PROVIDER.
  // Options: 'openai' | 'voyage' | 'cohere'
  // Then set the corresponding API key below.
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? 'openai') as EmbeddingProvider,

  // OpenAI — text-embedding-3-small (1536 dims, ~$0.00002/1k tokens)
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',

  // Voyage AI — voyage-3-lite (1024 dims, fast + cheap)
  voyageApiKey: process.env.VOYAGE_API_KEY,
  voyageEmbeddingModel: process.env.VOYAGE_EMBEDDING_MODEL ?? 'voyage-3-lite',

  // Cohere — embed-english-v3.0 (1024 dims)
  cohereApiKey: process.env.COHERE_API_KEY,
  cohereEmbeddingModel: process.env.COHERE_EMBEDDING_MODEL ?? 'embed-english-v3.0',

  // ── Perception API (required — where signals get sent) ──────
  // Set after you deploy the Perception API to Railway / Fly.io.
  // Leave as placeholder during local Sensing-only testing.
  perceptionApiUrl: process.env.PERCEPTION_API_URL ?? 'http://localhost:3001',
  perceptionApiKey: process.env.PERCEPTION_API_KEY ?? '',

  // ── Classifier thresholds (optional — tune after instrumenting) ─
  decisionConfidenceMin:  Number(process.env.DECISION_CONFIDENCE_MIN  ?? 0.60),
  decisionConfidenceHigh: Number(process.env.DECISION_CONFIDENCE_HIGH ?? 0.90),
  topicShiftThreshold:    Number(process.env.TOPIC_SHIFT_THRESHOLD    ?? 0.35),
  similarityLinkThreshold:Number(process.env.SIMILARITY_LINK_THRESHOLD?? 0.82),

  // ── Buffer settings ────────────────────────────────────────
  // Max turns to hold in buffer before dropping oldest (recency bias).
  bufferMaxSize:         Number(process.env.BUFFER_MAX_SIZE          ?? 200),
  // Grace window in ms for flush-on-close hook.
  flushGraceWindowMs:    Number(process.env.FLUSH_GRACE_WINDOW_MS    ?? 2000),
  // How many past messages to compare for topic-shift embedding delta.
  topicShiftWindowSize:  Number(process.env.TOPIC_SHIFT_WINDOW_SIZE  ?? 3),
  // When true, skip embedding API calls — topic_shift is never detected via embeddings.
  topicShiftDisableEmbedding: process.env.SENSING_TOPIC_SHIFT_DISABLE_EMBEDDING === 'true',
} as const

export type EmbeddingProvider = 'openai' | 'voyage' | 'cohere'

