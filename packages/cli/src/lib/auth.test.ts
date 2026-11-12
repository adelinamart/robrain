import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { detectPlanRequirement, fetchProvisionedConfig, INSTALL_ID_HEADER } from './auth.js'

describe('detectPlanRequirement — entitlement vs. everything else', () => {
  it('reads 402 Payment Required as a plan problem', () => {
    const req = detectPlanRequirement(402, { error: 'plan_required', plan: 'free', required_plan: 'Pro' })
    assert.deepEqual(req, { currentPlan: 'free', requiredPlan: 'Pro', trialAvailable: true })
  })

  it('does not misclassify ambiguous 402 errors as plan-required', () => {
    assert.equal(detectPlanRequirement(402, { error: 'Payment Required' }), null)
    assert.equal(detectPlanRequirement(402, {}), null)
  })

  it('reads a 403 carrying a plan error code', () => {
    const req = detectPlanRequirement(403, { code: 'upgrade_required' })
    assert.ok(req)
    // Unset when the API names no tier — the CLI must not invent one, since
    // cloud is included with every paid plan rather than a single named tier.
    assert.equal(req.requiredPlan, undefined)
  })

  it('reads a 403 whose message names the plan, without a code', () => {
    const req = detectPlanRequirement(403, { error: 'Your subscription does not include RoBrain' })
    assert.ok(req)
  })

  it('leaves a plain bad token as an auth error', () => {
    // The failure mode to avoid in both directions: a mistyped token must not
    // be answered with "upgrade your plan".
    assert.equal(detectPlanRequirement(401, { error: 'Invalid token' }), null)
    assert.equal(detectPlanRequirement(401, {}), null)
    assert.equal(detectPlanRequirement(403, { error: 'Forbidden' }), null)
  })

  it('leaves server and network failures alone', () => {
    assert.equal(detectPlanRequirement(500, { error: 'Internal error' }), null)
    assert.equal(detectPlanRequirement(404, {}), null)
    assert.equal(detectPlanRequirement(502, undefined), null)
  })

  it('honours an exhausted trial, and assumes one is available otherwise', () => {
    // Offering "start your free trial" to someone who already used theirs is
    // the one line here that can be actively wrong.
    assert.equal(detectPlanRequirement(402, { error: 'plan_required', trial_available: false })?.trialAvailable, false)
    assert.equal(detectPlanRequirement(402, { error: 'plan_required' })?.trialAvailable, true)
  })

  it('passes through the plan names the API reports', () => {
    const req = detectPlanRequirement(402, { error: 'plan_required', plan: 'free', required_plan: 'Teams' })
    assert.equal(req?.currentPlan, 'free')
    assert.equal(req?.requiredPlan, 'Teams')
  })
})

describe('fetchProvisionedConfig — per-machine key request', () => {
  const INSTALL = '0b1f6c1e-3c58-4e0e-9a55-0d4f6f0a7a11'
  const PROVISIONED = {
    perceptionUrl: 'https://api.example', planningUrl: 'https://api.example',
    perceptionKey: 'rp_live_x', planningKey: 'rp_live_x', embeddingProvider: 'openai',
  }

  async function capture(run: () => Promise<unknown>, respond: () => Response): Promise<Headers> {
    const realFetch = globalThis.fetch
    let seen = new Headers()
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return respond()
    }) as typeof fetch
    try {
      await run()
    } finally {
      globalThis.fetch = realFetch
    }
    return seen
  }

  it('sends the install id so the cloud keeps one key per machine', async () => {
    let result: Awaited<ReturnType<typeof fetchProvisionedConfig>> = {}
    const headers = await capture(
      async () => { result = await fetchProvisionedConfig('rory_token', INSTALL) },
      () => new Response(JSON.stringify(PROVISIONED), { status: 200 }),
    )
    assert.equal(headers.get(INSTALL_ID_HEADER), INSTALL)
    assert.equal(headers.get('Authorization'), 'Bearer rory_token')
    assert.deepEqual(result.config, PROVISIONED)
  })

  it('omits the header when there is no install id', async () => {
    const headers = await capture(
      () => fetchProvisionedConfig('rory_token'),
      () => new Response(JSON.stringify(PROVISIONED), { status: 200 }),
    )
    assert.equal(headers.has(INSTALL_ID_HEADER), false)
  })

  it('still reports a plan problem when the request carries an install id', async () => {
    let result: Awaited<ReturnType<typeof fetchProvisionedConfig>> = {}
    await capture(
      async () => { result = await fetchProvisionedConfig('rory_token', INSTALL) },
      () => new Response(JSON.stringify({ error: 'subscription_required' }), { status: 403 }),
    )
    assert.equal(result.config, undefined)
    assert.ok(result.planRequired)
  })
})
