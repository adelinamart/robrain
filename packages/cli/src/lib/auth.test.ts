import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { detectPlanRequirement } from './auth.js'

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
    assert.equal(req.requiredPlan, 'Pro')   // default when the API does not name one
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
