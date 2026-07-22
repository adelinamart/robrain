import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeServerEnv } from './mcp.js'

describe('mergeServerEnv', () => {
  it('fills PERCEPTION_API_URL/KEY from config when env is unset (zero-config directory install)', () => {
    const env = mergeServerEnv({}, { perceptionUrl: 'http://localhost:3001', perceptionKey: 'secret' })
    assert.equal(env.PERCEPTION_API_URL, 'http://localhost:3001')
    assert.equal(env.PERCEPTION_API_KEY, 'secret')
  })

  it('lets explicit env win over config (client mcp.json env block)', () => {
    const env = mergeServerEnv(
      { PERCEPTION_API_URL: 'http://remote:9000', PERCEPTION_API_KEY: 'from-env' },
      { perceptionUrl: 'http://localhost:3001', perceptionKey: 'from-config' },
    )
    assert.equal(env.PERCEPTION_API_URL, 'http://remote:9000')
    assert.equal(env.PERCEPTION_API_KEY, 'from-env')
  })

  it('preserves unrelated env and tolerates an empty config', () => {
    const env = mergeServerEnv({ PATH: '/usr/bin', HOME: '/home/x' }, {})
    assert.equal(env.PATH, '/usr/bin')
    assert.equal(env.HOME, '/home/x')
    assert.equal(env.PERCEPTION_API_URL, undefined)
  })

  it('propagates cloud thin mode from config so portable launches stay thin', () => {
    const env = mergeServerEnv({}, { perceptionUrl: 'http://p', perceptionKey: 'k', thin: true })
    assert.equal(env.ROBRAIN_MODE, 'cloud')
  })

  it('never sets ROBRAIN_MODE for non-thin configs, and explicit env wins', () => {
    assert.equal(mergeServerEnv({}, { perceptionUrl: 'http://p' }).ROBRAIN_MODE, undefined)
    assert.equal(mergeServerEnv({ ROBRAIN_MODE: 'custom' }, { thin: true }).ROBRAIN_MODE, 'custom')
  })
})
