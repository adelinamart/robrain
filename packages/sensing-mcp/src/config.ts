// packages/sensing-mcp/src/config.ts
// ─────────────────────────────────────────────────────────────
// All environment variables for the Sensing MCP server.
// Copy .env.example → .env and fill in values before running.
// ─────────────────────────────────────────────────────────────

import { resolveLlmProvider, resolveEmbeddingConfig, resolveOpenAiBaseUrl, DEFAULT_ANTHROPIC_LLM_MODEL, DEFAULT_OPENAI_LLM_MODEL } from '@robrain/shared'

export const config = {
  // ── Reasoning LLM provider for decision classifier Stage 2 ──
  // Default 'anthropic' (Haiku). Set LLM_PROVIDER=openai to extract decisions
  // with OpenAI chat-completions instead — for teams avoiding Anthropic.
  // (Embeddings are chosen separately via EMBEDDING_PROVIDER.)
  llmProvider:     resolveLlmProvider(),
  // gpt-4o-mini can hallucinate JSON fields under structured-output prompts —
  // prefer gpt-4o / gpt-4.1 for extraction fidelity. Reuses OPENAI_API_KEY below.
  openaiLlmModel:  process.env.OPENAI_LLM_MODEL ?? DEFAULT_OPENAI_LLM_MODEL,
  // OPENAI_BASE_URL — point the OpenAI-compatible calls (LLM_PROVIDER=openai
  // chat AND EMBEDDING_PROVIDER=openai embeddings) at Ollama / LM Studio /
  // vLLM for a fully-local setup. When set, OPENAI_API_KEY becomes optional.
  openaiBaseUrl:   resolveOpenAiBaseUrl(),

  // ── Anthropic (needed for decision classifier Stage 2 — Haiku) ─
  // Not validated at process start so the MCP server can boot when Cursor
  // does not inject env (set ANTHROPIC_API_KEY in MCP server config or shell).
  // If unset, keyword hits still run but LLM extraction is skipped.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel:  process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_LLM_MODEL,

  // ── Embeddings (for topic-shift in sensing_record_turn unless disabled) ─
  // Choose ONE provider by setting EMBEDDING_PROVIDER ('openai' | 'voyage' |
  // 'cohere') plus its API key. Provider, model, timeout, and retry env vars
  // are all resolved by @robrain/shared so Sensing and Perception always
  // embed with the same model — see shared/src/embeddings.ts for the list.
  embedding: resolveEmbeddingConfig(),

  // Also reused by the OpenAI chat path when LLM_PROVIDER=openai.
  openaiApiKey: process.env.OPENAI_API_KEY,

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
} as const
