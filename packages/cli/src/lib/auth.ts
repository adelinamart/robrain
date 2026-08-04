// src/lib/auth.ts
// ─────────────────────────────────────────────────────────────
// Handles authentication against Rory Plans API.
// On login: validates token, fetches user info + provisioned
// Perception/Planning API URLs for this account.
// ─────────────────────────────────────────────────────────────

import { RORY_API_BASE, type RoMemoryConfig } from './config.js'

export interface AuthResult {
  ok:            boolean
  email?:        string
  perceptionUrl?: string
  planningUrl?:  string
  error?:        string
  /** Account is fine, the plan is not — see PlanRequirement. */
  planRequired?: PlanRequirement
}

/** "Your login worked; your plan doesn't include RoBrain cloud." */
export interface PlanRequirement {
  /** Plan the account is on today, when the API reports it (e.g. "free"). */
  currentPlan?:   string
  /**
   * Minimum plan that includes RoBrain cloud, when the API names one. Left
   * unset otherwise — cloud ships with every paid plan, so there is no single
   * tier name the CLI can safely assume on the API's behalf.
   */
  requiredPlan?:  string
  /** Only false when the API says the trial is used up or unavailable. */
  trialAvailable: boolean
}

const PLAN_ERROR_CODES = new Set([
  'plan_required', 'upgrade_required', 'subscription_required', 'payment_required',
])

/**
 * Recognize an entitlement refusal across the shapes the API might use, so the
 * CLI can say "upgrade" instead of "authentication failed" / "contact support":
 *   • 402 Payment Required (preferred), or
 *   • 401/403 carrying a plan error code, or a message naming plan/subscription/upgrade/trial.
 * Deliberately narrow on 401/403 — a plain bad token must stay an auth error.
 */
export function detectPlanRequirement(status: number, body: unknown): PlanRequirement | null {
  const b = (body ?? {}) as Record<string, unknown>
  const code = String(b.code ?? b.error ?? '').toLowerCase()
  const text = String(b.message ?? b.error ?? '').toLowerCase()
  const hasPlanCode = PLAN_ERROR_CODES.has(code)
  const hasPlanText = /\b(plan|subscription|upgrade|trial|billing)\b/.test(text)
  const hasPlanFields =
    typeof b.required_plan === 'string' ||
    typeof b.plan === 'string' ||
    typeof b.trial_available === 'boolean'
  const looksLikePlan =
    hasPlanCode ||
    ((status === 401 || status === 403 || status === 402) && hasPlanText) ||
    (status === 402 && hasPlanFields)
  if (!looksLikePlan) return null
  return {
    currentPlan:    typeof b.plan === 'string' ? b.plan : undefined,
    ...(typeof b.required_plan === 'string' ? { requiredPlan: b.required_plan } : {}),
    trialAvailable: b.trial_available !== false,
  }
}

/** Outcome of provisioning: config, an entitlement refusal, or an opaque failure. */
export interface ProvisionResult {
  config?:       ProvisionedConfig
  planRequired?: PlanRequirement
}

export interface ProvisionedConfig {
  perceptionUrl: string
  planningUrl:   string
  perceptionKey: string
  planningKey:   string
  embeddingProvider: string
}

/** Validate a Rory Plans token and return account info */
export async function validateToken(token: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${RORY_API_BASE}/robrain/auth/validate`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      const planRequired = detectPlanRequirement(res.status, body)
      if (planRequired) return { ok: false, planRequired }
      return {
        ok:    false,
        error: body.error ?? `Authentication failed (${res.status})`,
      }
    }

    const data = await res.json() as {
      email:          string
      perceptionUrl:  string
      planningUrl:    string
    }

    return {
      ok:            true,
      email:         data.email,
      perceptionUrl: data.perceptionUrl,
      planningUrl:   data.planningUrl,
    }
  } catch (err) {
    return {
      ok:    false,
      error: `Could not reach roryplans.ai — check your internet connection`,
    }
  }
}

/**
 * Fetch provisioned API config for this token. An account on a plan without
 * RoBrain cloud lands here (the token is valid — there is just nothing to
 * provision), so entitlement is reported rather than folded into a failure.
 */
export async function fetchProvisionedConfig(token: string): Promise<ProvisionResult> {
  try {
    const res = await fetch(`${RORY_API_BASE}/robrain/provision`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const planRequired = detectPlanRequirement(res.status, body)
      return planRequired ? { planRequired } : {}
    }

    const data = await res.json() as ProvisionedConfig
    return { config: data }
  } catch {
    return {}
  }
}

/** Register a new project with Rory Plans */
export async function registerProject(
  token: string,
  projectId: string,
  projectName: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${RORY_API_BASE}/robrain/projects`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ project_id: projectId, name: projectName }),
    })
    return res.ok
  } catch {
    return false
  }
}
