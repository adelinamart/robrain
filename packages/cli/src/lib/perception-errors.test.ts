import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  explainPerceptionFailure,
  explainPerceptionUnreachable,
} from './perception-errors.js'

const CLOUD = { cloud: true,  perceptionUrl: 'https://api.roryplans.ai' }
const LOCAL = { cloud: false, perceptionUrl: 'http://127.0.0.1:3001' }

describe('explainPerceptionFailure', () => {
  it('names the second-machine cause for a rejected key on cloud', () => {
    // Reported: install on VM2 left VM1 401ing, and vice versa.
    const { headline, hints } = explainPerceptionFailure(401, CLOUD)
    assert.match(headline, /rejected this API key \(401\)/)
    assert.match(hints.join(' '), /another machine/)
    assert.match(hints.join(' '), /npx robrain install/)
  })

  it('points a self-hosted 401 at the key mismatch instead', () => {
    const { hints } = explainPerceptionFailure(401, LOCAL)
    assert.match(hints.join(' '), /PERCEPTION_API_KEY/)
    assert.doesNotMatch(hints.join(' '), /another machine/)
  })

  it('treats 403 like 401', () => {
    assert.match(explainPerceptionFailure(403, CLOUD).headline, /rejected this API key/)
  })

  it('explains a 404 as scope, not emptiness — including the team case', () => {
    // Reported: a new account got 404 until it was added to the owning team.
    const { headline, hints } = explainPerceptionFailure(404, CLOUD)
    assert.match(headline, /not in your memory space/)
    assert.match(hints.join(' '), /init-project/)
    assert.match(hints.join(' '), /team/)
  })

  it('does not blame the team on a self-hosted 404', () => {
    const { hints } = explainPerceptionFailure(404, LOCAL)
    assert.match(hints.join(' '), /init-project/)
    assert.doesNotMatch(hints.join(' '), /team/)
  })

  it('never tells a cloud user to start a local stack', () => {
    // The old message said "Is Perception running? … pnpm docker:up" for every
    // status — wrong twice over when the store is managed.
    for (const status of [401, 403, 404, 500, 502, 418]) {
      const text = JSON.stringify(explainPerceptionFailure(status, CLOUD))
      assert.doesNotMatch(text, /docker:up|robrain up/, `status ${status} suggested starting a local stack`)
    }
  })

  it('does point a self-hosted user at their stack for an unclassified failure', () => {
    const { hints } = explainPerceptionFailure(418, LOCAL)
    assert.match(hints.join(' '), /robrain up|docker:up/)
  })

  it('routes 5xx to the right owner per mode', () => {
    assert.match(explainPerceptionFailure(503, CLOUD).hints.join(' '), /support@roryplans\.ai/)
    assert.match(explainPerceptionFailure(503, LOCAL).hints.join(' '), /docker logs/)
  })
})

describe('explainPerceptionUnreachable', () => {
  it('never tells a cloud user to start a local stack on network failure', () => {
    // The path Bug 1/2 hit: catch blocks used to print pnpm docker:up even for
    // managed installs. Unreachable must stay cloud-aware too.
    const text = JSON.stringify(explainPerceptionUnreachable(CLOUD))
    assert.doesNotMatch(text, /docker:up|robrain up/)
    assert.match(text, /network|support@roryplans\.ai/i)
  })

  it('points a self-hosted user at their stack when the store is unreachable', () => {
    const { hints } = explainPerceptionUnreachable(LOCAL)
    assert.match(hints.join(' '), /robrain up|docker:up/)
  })
})
