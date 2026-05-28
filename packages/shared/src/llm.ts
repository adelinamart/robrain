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

export interface OpenAiChatParams {
  apiKey:    string
  model:     string
  system:    string
  user:      string
  maxTokens: number
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
  if (!params.apiKey) {
    throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai')
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

  let lastErr = ''
  for (let attempt = 0; attempt < OPENAI_MAX_ATTEMPTS; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${params.apiKey}`,
        'Content-Type':  'application/json',
      },
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
