// packages/sensing-mcp/src/config.ts
// ─────────────────────────────────────────────────────────────
// All environment variables for the Sensing MCP server.
// Copy .env.example → .env and fill in values before running.
// ─────────────────────────────────────────────────────────────

import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveLlmProvider, DEFAULT_ANTHROPIC_LLM_MODEL, DEFAULT_OPENAI_LLM_MODEL } from '@robrain/shared'

export const config = {
  // ── Reasoning LLM provider for decision classifier Stage 2 ──
  // Default 'anthropic' (Haiku). Set LLM_PROVIDER=openai to extract decisions
  // with OpenAI chat-completions instead — for teams avoiding Anthropic.
  // (Embeddings are chosen separately via EMBEDDING_PROVIDER.)
  llmProvider:     resolveLlmProvider(),
  // gpt-4o-mini can hallucinate JSON fields under structured-output prompts —
  // prefer gpt-4o / gpt-4.1 for extraction fidelity. Reuses OPENAI_API_KEY below.
  openaiLlmModel:  process.env.OPENAI_LLM_MODEL ?? DEFAULT_OPENAI_LLM_MODEL,

  // ── Anthropic (needed for decision classifier Stage 2 — Haiku) ─
  // Not validated at process start so the MCP server can boot when Cursor
  // does not inject env (set ANTHROPIC_API_KEY in MCP server config or shell).
  // If unset, keyword hits still run but LLM extraction is skipped.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel:  process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_LLM_MODEL,

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
  // Deprecated: end_session no longer waits on flush. Kept for env compatibility.
  flushGraceWindowMs:    Number(process.env.FLUSH_GRACE_WINDOW_MS    ?? 2000),
  // Max ms to wait inline for topic-shift embedding before returning buffered:true.
  topicShiftInlineTimeoutMs: Number(process.env.TOPIC_SHIFT_INLINE_TIMEOUT_MS ?? 1500),
  // Per-request timeout for Perception API fetches (always-on summary, etc.).
  fetchTimeoutMs: Number(process.env.SENSING_FETCH_TIMEOUT_MS ?? 10_000),
  // How many past messages to compare for topic-shift embedding delta.
  topicShiftWindowSize:  Number(process.env.TOPIC_SHIFT_WINDOW_SIZE  ?? 3),
  // When true, skip embedding API calls — topic_shift is never detected via embeddings.
  topicShiftDisableEmbedding: process.env.SENSING_TOPIC_SHIFT_DISABLE_EMBEDDING === 'true',

  // ── Session registry mirror ────────────────────────────────
  // Active sessions are mirrored to this JSON file so a restarted MCP server
  // (editor reconnect, crash, upgrade) resumes them transparently —
  // sensing_record_turn keeps accepting the same session_id instead of erroring.
  sessionRegistryPath: process.env.SENSING_SESSION_REGISTRY_PATH
    ?? join(homedir(), '.robrain', 'sensing-sessions.json'),
} as const

export type EmbeddingProvider = 'openai' | 'voyage' | 'cohere'

