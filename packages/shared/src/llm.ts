// packages/shared/src/llm.ts
// ─────────────────────────────────────────────────────────────
// Reasoning-LLM provider switch for the decision classifier,
// Perception extraction, and Synthesis passes.
//
// Anthropic (Haiku) stays the project default. Set LLM_PROVIDER=openai
// to route those text-reasoning calls through OpenAI chat-completions
// instead — for teams that do not want to add an Anthropic account.
//
// Embeddings are configured separately (EMBEDDING_PROVIDER) and are
// already OpenAI-capable; this module only covers the text calls.
// ─────────────────────────────────────────────────────────────

export type LlmProvider = 'anthropic' | 'openai'

/** Project default classifier/extraction model — Anthropic Haiku. */
export const DEFAULT_ANTHROPIC_LLM_MODEL = 'claude-haiku-4-5-20251001'

// NOTE on model choice when LLM_PROVIDER=openai:
// gpt-4o-mini is the cheapest option, BUT it can hallucinate fields when
// forced into a structured-output (JSON) prompt — inventing or dropping
// keys in the {decision, rationale, rejected, confidence} schema. That is
// the recorded reason the project default classifier is Haiku rather than a
// mini model. If you opt into OpenAI, prefer gpt-4o / gpt-4.1 for extraction
// fidelity; reserve gpt-4o-mini for low-stakes / cost-sensitive use and
// expect more review noise.
export const DEFAULT_OPENAI_LLM_MODEL = 'gpt-4o'

/** Reads LLM_PROVIDER; anything other than "openai" (case-insensitive) means Anthropic. */
export function resolveLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  return env.LLM_PROVIDER?.trim().toLowerCase() === 'openai' ? 'openai' : 'anthropic'
}

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * Reads OPENAI_BASE_URL — point the OpenAI-compatible calls (chat AND
 * embeddings) at Ollama / LM Studio / vLLM for a fully-local setup.
 * When a non-default base URL is in use, OPENAI_API_KEY becomes optional
 * (local servers usually ignore auth).
 */
export function resolveOpenAiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENAI_BASE_URL?.trim()
  if (!raw) return DEFAULT_OPENAI_BASE_URL
  return raw.replace(/\/+$/, '')
}

export interface OpenAiChatParams {
  apiKey:    string
  model:     string
  system:    string
  user:      string
  maxTokens: number
  /** OpenAI-compatible endpoint root. Defaults to OPENAI_BASE_URL / api.openai.com. */
  baseUrl?:  string
  /**
   * When true, request a JSON object via response_format. The prompt must
   * mention "JSON" (all our extraction system prompts already do). Leave
   * false for prose / single-word replies (e.g. the contradiction classifier).
   */
  json?:     boolean
}

const OPENAI_MAX_ATTEMPTS  = 4
const OPENAI_BASE_DELAY_MS = 400

/**
 * Minimal OpenAI chat-completions call returning the assistant's text.
 * Retries 429 / 5xx with exponential backoff. Throws on non-retriable
 * failure or after the final attempt — callers already wrap this in their
 * own try/catch or retry (Synthesis withRetry, Perception/Sensing try-catch).
 */
export async function openaiChat(params: OpenAiChatParams): Promise<string> {
  const baseUrl = params.baseUrl ?? resolveOpenAiBaseUrl()
  // Local OpenAI-compatible servers (Ollama, LM Studio, vLLM) typically ignore
  // auth — only require a key when talking to api.openai.com itself.
  if (!params.apiKey && baseUrl === DEFAULT_OPENAI_BASE_URL) {
    throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai (unless OPENAI_BASE_URL points at a local server)')
  }

  const body = JSON.stringify({
    model:       params.model,
    max_tokens:  params.maxTokens,
    temperature: 0,
    messages: [
      { role: 'system', content: params.system },
      { role: 'user',   content: params.user },
    ],
    ...(params.json ? { response_format: { type: 'json_object' as const } } : {}),
  })

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (params.apiKey) headers['Authorization'] = `Bearer ${params.apiKey}`

  let lastErr = ''
  for (let attempt = 0; attempt < OPENAI_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method:  'POST',
      headers,
      body,
    })

    if (res.ok) {
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return data.choices?.[0]?.message?.content ?? ''
    }

    lastErr = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
    const retriable = res.status === 429 || res.status >= 500
    if (!retriable || attempt >= OPENAI_MAX_ATTEMPTS - 1) {
      throw new Error(`OpenAI chat failed: ${lastErr}`)
    }
    const delay = OPENAI_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 150)
    await new Promise(r => setTimeout(r, delay))
  }

  throw new Error(`OpenAI chat failed: ${lastErr}`)
}

export interface AnthropicChatParams {
  apiKey:    string
  model:     string
  system:    string
  user:      string
  maxTokens: number
}

/**
 * Minimal Anthropic Messages call returning the first text block. Fetch-based
 * like openaiChat so callers (Sensing, Perception) need no SDK dependency.
 * Retries 429 / 5xx (incl. 529 overloaded) with exponential backoff; throws
 * on non-retriable failure or after the final attempt.
 */
export async function anthropicChat(params: AnthropicChatParams): Promise<string> {
  if (!params.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic')
  }

  const body = JSON.stringify({
    model:      params.model,
    max_tokens: params.maxTokens,
    system:     params.system,
    messages:   [{ role: 'user', content: params.user }],
  })

  let lastErr = ''
  for (let attempt = 0; attempt < OPENAI_MAX_ATTEMPTS; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         params.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body,
    })

    if (res.ok) {
      const data = await res.json() as {
        content?: Array<{ type?: string; text?: string }>
      }
      const block = data.content?.[0]
      return block?.type === 'text' ? (block.text ?? '') : ''
    }

    lastErr = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
    const retriable = res.status === 429 || res.status >= 500
    if (!retriable || attempt >= OPENAI_MAX_ATTEMPTS - 1) {
      throw new Error(`Anthropic chat failed: ${lastErr}`)
    }
    const delay = OPENAI_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 150)
    await new Promise(r => setTimeout(r, delay))
  }

  throw new Error(`Anthropic chat failed: ${lastErr}`)
}
