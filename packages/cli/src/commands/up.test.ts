import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ensureStackEnvContent, readEnvValue, renderStackCompose, DEFAULT_IMAGE_REPO } from './up.js'

describe('renderStackCompose', () => {
  const compose = renderStackCompose(`${DEFAULT_IMAGE_REPO}:2.3.8`)

  it('runs Perception from the published image with an env override hook', () => {
    assert.match(compose, /image: \$\{PERCEPTION_IMAGE:-ghcr\.io\/adelinamart\/robrain-perception:2\.3\.8\}/)
    assert.doesNotMatch(compose, /build:/)
  })

  it('mounts the stack-local schema and env file', () => {
    assert.match(compose, /\.\/schema\.sql:\/docker-entrypoint-initdb\.d\/001_schema\.sql/)
    assert.match(compose, /- \.\/\.env/)
  })

  it('keeps ports bound to localhost by default and reuses the shared data volume', () => {
    assert.match(compose, /POSTGRES_BIND_HOST:-127\.0\.0\.1/)
    assert.match(compose, /PERCEPTION_BIND_HOST:-127\.0\.0\.1/)
    assert.match(compose, /name: robrain_postgres_data/)
  })
})

describe('ensureStackEnvContent', () => {
  it('generates secrets and a matching DATABASE_URL on first creation', () => {
    const { content, generated } = ensureStackEnvContent(null, {})
    const password = readEnvValue(content, 'POSTGRES_PASSWORD')
    const key = readEnvValue(content, 'PERCEPTION_API_KEY')

    assert.match(password, /^[0-9a-f]{64}$/)
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.equal(readEnvValue(content, 'DATABASE_URL'), `postgres://robrain:${password}@localhost:5432/robrain`)
    assert.ok(generated.includes('POSTGRES_PASSWORD'))
    assert.ok(generated.includes('PERCEPTION_API_KEY'))
  })

  it('seeds provider keys from the environment on first creation', () => {
    const { content, generated } = ensureStackEnvContent(null, {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      EMBEDDING_PROVIDER: 'voyage',
      VOYAGE_API_KEY: 'pa-test',
    })
    assert.equal(readEnvValue(content, 'ANTHROPIC_API_KEY'), 'sk-ant-test')
    assert.equal(readEnvValue(content, 'EMBEDDING_PROVIDER'), 'voyage')
    assert.equal(readEnvValue(content, 'VOYAGE_API_KEY'), 'pa-test')
    assert.ok(generated.includes('ANTHROPIC_API_KEY'))
  })

  it('never overwrites existing non-empty values', () => {
    const first = ensureStackEnvContent(null, {}).content
    const second = ensureStackEnvContent(first, { ANTHROPIC_API_KEY: 'sk-ant-late' })
    assert.equal(second.content, first)
    assert.equal(second.generated.length, 0)
  })

  it('fills blank secrets and rewrites a CHANGE_ME DATABASE_URL in an existing file', () => {
    const existing = [
      'POSTGRES_PASSWORD=',
      'PERCEPTION_API_KEY=CHANGE_ME',
      'DATABASE_URL=postgres://robrain:CHANGE_ME@localhost:5432/robrain',
      'ANTHROPIC_API_KEY=sk-ant-kept',
    ].join('\n')

    const { content, generated } = ensureStackEnvContent(existing, {})
    const password = readEnvValue(content, 'POSTGRES_PASSWORD')

    assert.match(password, /^[0-9a-f]{64}$/)
    assert.match(readEnvValue(content, 'PERCEPTION_API_KEY'), /^[0-9a-f]{64}$/)
    assert.equal(readEnvValue(content, 'DATABASE_URL'), `postgres://robrain:${password}@localhost:5432/robrain`)
    assert.equal(readEnvValue(content, 'ANTHROPIC_API_KEY'), 'sk-ant-kept')
    assert.deepEqual(generated.sort(), ['DATABASE_URL', 'PERCEPTION_API_KEY', 'POSTGRES_PASSWORD'])
  })

  it('appends missing secret keys to an existing file', () => {
    const { content, generated } = ensureStackEnvContent('ANTHROPIC_API_KEY=sk-ant-kept', {})
    assert.match(readEnvValue(content, 'POSTGRES_PASSWORD'), /^[0-9a-f]{64}$/)
    assert.match(readEnvValue(content, 'PERCEPTION_API_KEY'), /^[0-9a-f]{64}$/)
    assert.ok(generated.includes('POSTGRES_PASSWORD'))
  })
})
