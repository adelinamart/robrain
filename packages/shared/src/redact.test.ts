import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, totalRedactions, SECRET_PATTERNS } from './redact.js'

// One representative sample per pattern type. The enumeration test below
// fails if a pattern is added to SECRET_PATTERNS without a sample here.
const SAMPLES: Record<string, { input: string; mustSurvive?: string[] }> = {
  pem_private_key: {
    input: 'here is the key\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq0\nx9GJ2Fk=\n-----END RSA PRIVATE KEY-----\ndone',
    mustSurvive: ['here is the key', 'done'],
  },
  aws_access_key_id: {
    input: 'creds: AKIAIOSFODNN7EXAMPLE region us-east-1',
    mustSurvive: ['creds:', 'region us-east-1'],
  },
  aws_secret_access_key: {
    input: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    mustSurvive: ['aws_secret_access_key = '],
  },
  github_token: {
    input: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijk',
    mustSurvive: ['use ', ' and '],
  },
  anthropic_api_key: {
    input: 'ANTHROPIC_API_KEY=sk-ant-api03-h4x0r-abcdefghijklmnop-qrstuvwx',
    mustSurvive: ['ANTHROPIC_API_KEY='],
  },
  openai_api_key: {
    input: 'sk-proj-abc123DEF456ghi789JKL012 and legacy sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    mustSurvive: [' and legacy '],
  },
  slack_token: {
    input: 'bot token xoxb-1234567890-abcdefGHIJKL',
    mustSurvive: ['bot token '],
  },
  stripe_key: {
    // Assemble at runtime so push protection doesn't flag static sk_live_/rk_live_ strings.
    input: `STRIPE=${['sk', 'live', 'abcdefghij1234567890ABCD'].join('_')} ${['rk', 'live', 'abcdefghij1234567890ABCD'].join('_')}`,
    mustSurvive: ['STRIPE='],
  },
  npm_token: {
    input: '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789',
    mustSurvive: ['//registry.npmjs.org/'],
  },
  jwt: {
    input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    mustSurvive: ['Authorization: Bearer '],
  },
  connection_string_password: {
    input: 'DATABASE_URL=postgres://robrain:sup3rs3cret@localhost:5432/robrain',
    mustSurvive: ['postgres://robrain:', '@localhost:5432/robrain'],
  },
  credential_assignment: {
    input: 'DB_PASSWORD=hunter2hunter2',
    mustSurvive: ['DB_PASSWORD='],
  },
}

describe('SECRET_PATTERNS coverage', () => {
  it('every pattern in the table has a sample and every sample has a pattern', () => {
    assert.deepEqual(
      Object.keys(SAMPLES).sort(),
      SECRET_PATTERNS.map(p => p.type).sort(),
    )
  })

  for (const p of SECRET_PATTERNS) {
    it(`redacts ${p.type}`, () => {
      const sample = SAMPLES[p.type]!
      const { text, redactions } = redactSecrets(sample.input)
      assert.ok(text.includes(`[REDACTED:${p.type}]`), `expected [REDACTED:${p.type}] in: ${text}`)
      assert.ok(redactions.some(r => r.type === p.type && r.count >= 1))
      for (const survivor of sample.mustSurvive ?? []) {
        assert.ok(text.includes(survivor), `expected "${survivor}" to survive in: ${text}`)
      }
    })
  }
})

describe('redactSecrets — secret values are gone', () => {
  it('removes the raw secret material', () => {
    for (const [type, sample] of Object.entries(SAMPLES)) {
      const { text } = redactSecrets(sample.input)
      if (type === 'pem_private_key') assert.ok(!text.includes('MIIEowIBAAKCAQEA7bq0'))
      if (type === 'aws_access_key_id') assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'))
      if (type === 'connection_string_password') assert.ok(!text.includes('sup3rs3cret'))
      if (type === 'credential_assignment') assert.ok(!text.includes('hunter2hunter2'))
    }
  })

  it('counts multiple hits of the same type', () => {
    const { redactions } = redactSecrets(
      'a ghp_abcdefghijklmnopqrstuvwxyz0123456789 b ghp_0123456789abcdefghijklmnopqrstuvwxyz c',
    )
    assert.deepEqual(redactions, [{ type: 'github_token', count: 2 }])
  })

  it('handles multiple different types in one text', () => {
    const { text, redactions } = redactSecrets(
      'PERCEPTION_API_KEY=deadbeefdeadbeef1234 and postgres://u:pw12345678@db:5432/x',
    )
    assert.ok(text.includes('[REDACTED:credential_assignment]'))
    assert.ok(text.includes('[REDACTED:connection_string_password]'))
    assert.equal(totalRedactions(redactions), 2)
  })

  it('does not double-redact values already masked by a specific pattern', () => {
    const { text, redactions } = redactSecrets(
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    )
    assert.equal(text, 'GITHUB_TOKEN=[REDACTED:github_token]')
    assert.deepEqual(redactions, [{ type: 'github_token', count: 1 }])
  })

  it('masks quoted assignment values and keeps the quotes', () => {
    const { text } = redactSecrets('"api_key": "abcd1234efgh5678"')
    assert.equal(text, '"api_key": "[REDACTED:credential_assignment]"')
  })

  it('preserves all surrounding prose', () => {
    const input = 'Set the key (AKIAIOSFODNN7EXAMPLE) in your env, then restart.'
    const { text } = redactSecrets(input)
    assert.equal(text, 'Set the key ([REDACTED:aws_access_key_id]) in your env, then restart.')
  })
})

describe('redactSecrets — identifier-looking and $-prefixed real secrets redact', () => {
  const mustRedact: Array<[string, string]> = [
    ['password=MyRealPassword', 'MyRealPassword'],                    // leading cap ≠ variable ref
    ['API_KEY=Xj29fkd83jfid', 'Xj29fkd83jfid'],                       // digits = entropy
    ['token = deadbeefToken', 'deadbeefToken'],                       // hex run inside camelCase
    ['DB_PASSWORD=$2b$10$N9qo8uLOickgx2ZMRZoMye', '$2b$10$N9qo8uLOickgx2ZMRZoMye'],  // bcrypt hash
    ['PASSWORD=$uperSecret123!', '$uperSecret123!'],                  // $-prefixed literal
    ['SECRET_KEY=abcd1234efgh5678', 'abcd1234efgh5678'],
    ['ENCRYPTION_KEY=wibble8wobble9', 'wibble8wobble9'],
    ['SIGNING_KEY="minttu1234abcd"', 'minttu1234abcd'],
    ['GITHUB_PAT=n0tthegithubshape', 'n0tthegithubshape'],
    ['db_credential: sup3rSecret99', 'sup3rSecret99'],
    ['ssh_passphrase=correcthorse9battery', 'correcthorse9battery'],
  ]

  for (const [input, secret] of mustRedact) {
    it(`redacts ${JSON.stringify(input)}`, () => {
      const { text, redactions } = redactSecrets(input)
      assert.ok(text.includes('[REDACTED:credential_assignment]'), `expected redaction in: ${text}`)
      assert.ok(!text.includes(secret), `raw secret survived in: ${text}`)
      assert.ok(redactions.some(r => r.type === 'credential_assignment' && r.count >= 1))
    })
  }
})

describe('redactSecrets — legit code and placeholders survive', () => {
  const untouched = [
    'const token = await getToken()',
    'token: getToken()',
    'const apiKey = config.openaiApiKey',
    'apiKey = process.env.OPENAI_API_KEY ?? \'\'',
    'token = authToken',
    'password: changeme',
    'PASSWORD=CHANGE_ME',
    'API_KEY=<your-key-here>',
    'SECRET=${VAULT_SECRET}',
    'PASSWORD=xxx',
    'SECRET=xxxxxxxxxxxx',
    'password = "********"',
    'pwd=abc12345',
    'max_tokens: 30000000',
    'TOKEN_BUDGETS = { ALWAYS_ON_SUMMARY: 80 }',
    'the sk- prefix identifies OpenAI keys',
    'npm_config_registry=https://registry.npmjs.org',
    'rotate the token: see docs/security.md',
    'the password is: hunter2',
    'key=Enter',
    'public_key_fingerprint=ab:cd',
    'postgres://localhost:5432/robrain',
    'header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0 has no signature',
    'short token = ab12',
    'ghp_tooshort123',
  ]

  for (const input of untouched) {
    it(`leaves ${JSON.stringify(input)} untouched`, () => {
      const { text, redactions } = redactSecrets(input)
      assert.equal(text, input)
      assert.deepEqual(redactions, [])
    })
  }

  it('is idempotent — running twice changes nothing further', () => {
    const once = redactSecrets('DB_PASSWORD=hunter2hunter2 and sk-ant-api03-abcdefghijklmnop')
    const twice = redactSecrets(once.text)
    assert.equal(twice.text, once.text)
    assert.deepEqual(twice.redactions, [])
  })
})
