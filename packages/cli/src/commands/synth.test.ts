import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// config.ts resolves homedir() at import time — pin a hermetic HOME (and kill
// colour, so assertions match plain substrings) BEFORE the dynamic imports.
const fakeHome = mkdtempSync(join(tmpdir(), 'robrain-synth-'))
process.env.HOME = fakeHome
process.env.FORCE_COLOR = '0'
mkdirSync(join(fakeHome, '.robrain'), { recursive: true })

// A directory that is deliberately NOT a robrain checkout. Entry resolution
// fails fast there, which is what makes this file hermetic: a run that reached
// resolution is distinguishable from one the cloud guard short-circuited —
// and neither ever spawns Synthesis or touches a database.
const notACheckout = join(fakeHome, 'not-a-checkout')
mkdirSync(notACheckout, { recursive: true })
process.env.ROBRAIN_REPO = notACheckout

// Ambient DATABASE_URL would flip the mode routing below — own it per test.
delete process.env.DATABASE_URL

const { isCloudInstall } = await import('../lib/config.js')
const { synthCommand } = await import('./synth.js')

function writeInstallConfig(config: Record<string, unknown>): void {
  writeFileSync(join(fakeHome, '.robrain', 'config.json'), JSON.stringify(config))
}

/** Run `robrain synth` with console captured and a clean exit code. */
async function runSynth(): Promise<{ out: string; exitCode: number }> {
  const lines: string[] = []
  const { log, error } = console
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')) }
  process.exitCode = 0
  try {
    await synthCommand({})
  } finally {
    console.log = log
    console.error = error
  }
  const exitCode = Number(process.exitCode ?? 0)
  process.exitCode = 0
  return { out: lines.join('\n'), exitCode }
}

const CLOUD_MESSAGE   = 'Synthesis runs server-side on Rory Plans cloud'
const RESOLVE_FAILURE = 'does not look like a robrain checkout'

after(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('isCloudInstall', () => {
  it('is true for a cloud thin-client install', () => {
    writeInstallConfig({ token: 'rory_x', email: 'dev@example.com', thin: true })
    assert.equal(isCloudInstall(), true)
  })

  it('is false for a self-hosted install', () => {
    writeInstallConfig({ selfHosted: true, perceptionUrl: 'http://127.0.0.1:3001' })
    assert.equal(isCloudInstall(), false)
  })

  it('is false when a cloud login also runs a local stack (selfHosted wins)', () => {
    // `robrain up` merges selfHosted onto an existing cloud config — that user
    // does have a local Postgres, so synth must stay available to them.
    writeInstallConfig({ token: 'rory_x', thin: true, selfHosted: true })
    assert.equal(isCloudInstall(), false)
  })

  it('is true for a legacy cloud install that predates the thin flag', () => {
    // Cloud installs before `thin` existed carry only token/email. Nothing
    // self-hosted writes a Rory token, so token-without-thin means cloud.
    writeInstallConfig({ token: 'rory_x', email: 'dev@example.com', perceptionUrl: 'https://api.roryplans.ai' })
    assert.equal(isCloudInstall(), true)
  })

  it('is false for a legacy self-hosted install with no flags', () => {
    // Pre-`selfHosted` installs: Perception configured, never logged into Rory.
    writeInstallConfig({ perceptionUrl: 'http://127.0.0.1:3001', installedAt: '2026-01-01T00:00:00Z' })
    assert.equal(isCloudInstall(), false)
  })

  it('is false with no config at all', () => {
    writeInstallConfig({})
    assert.equal(isCloudInstall(), false)
  })
})

describe('robrain synth — install mode routing', () => {
  it('explains itself and exits 0 on a cloud install', async () => {
    writeInstallConfig({ token: 'rory_x', email: 'dev@example.com', thin: true })

    const { out, exitCode } = await runSynth()

    assert.match(out, new RegExp(CLOUD_MESSAGE))
    assert.match(out, /npx robrain review/)      // says where results DO surface
    assert.match(out, /npx robrain up/)          // …and how to opt into a local pass
    assert.equal(exitCode, 0, 'a cloud install is not an error state')
    // The guard must short-circuit BEFORE entry resolution — otherwise a cloud
    // user still eats a resolution/DATABASE_URL failure.
    assert.doesNotMatch(out, new RegExp(RESOLVE_FAILURE))
  })

  it('runs the normal path on a self-hosted install', async () => {
    writeInstallConfig({ selfHosted: true, perceptionUrl: 'http://127.0.0.1:3001' })

    const { out, exitCode } = await runSynth()

    // Same environment as the cloud case — only the install mode differs, and
    // here we reach entry resolution (which this fake HOME makes fail cleanly).
    assert.match(out, new RegExp(RESOLVE_FAILURE))
    assert.doesNotMatch(out, new RegExp(CLOUD_MESSAGE))
    assert.equal(exitCode, 1, 'a real synth failure must stay non-zero for scripts')
  })

  it('still runs when a stale cloud token sits on top of a real DATABASE_URL', async () => {
    // Logged into Rory once, never logged out, now self-hosting by hand (no
    // `robrain up`, so no selfHosted flag). Refusing here would tell someone
    // with a working local store that there is nothing to run — silently, and
    // with exit 0. A store you can point at wins over a leftover token.
    writeInstallConfig({ token: 'rory_stale', email: 'dev@example.com', thin: true })
    process.env.DATABASE_URL = 'postgres://robrain:pw@127.0.0.1:5432/robrain'
    try {
      const { out, exitCode } = await runSynth()

      assert.doesNotMatch(out, new RegExp(CLOUD_MESSAGE))
      assert.match(out, new RegExp(RESOLVE_FAILURE))   // reached resolution = would have run
      assert.equal(exitCode, 1)
    } finally {
      delete process.env.DATABASE_URL
    }
  })

  it('counts a resolved checkout\'s .env as a local store, like the child would', async () => {
    // The narrow case the config-only guard still got wrong: cloud token, no
    // `robrain up`, DATABASE_URL living ONLY in a checkout's .env — a file the
    // parent never reads but the child's own loadEnv does. Declining here
    // refuses work that would have succeeded.
    const checkout = join(fakeHome, 'checkout')
    const distDir  = join(checkout, 'packages', 'synthesis', 'dist')
    mkdirSync(distDir, { recursive: true })
    // Stand-in for the Synthesis bundle: records the DATABASE_URL it was
    // handed, so this asserts what the child actually got — not just that the
    // parent decided to spawn. CJS on purpose (no package.json type here).
    const marker = join(fakeHome, 'child-saw.txt')
    writeFileSync(
      join(distDir, 'index.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.env.DATABASE_URL))\n`,
    )
    const repoDbUrl = 'postgres://robrain:pw@127.0.0.1:5432/from_checkout_env'
    writeFileSync(join(checkout, '.env'), `DATABASE_URL=${repoDbUrl}\n`)

    writeInstallConfig({ token: 'rory_stale', email: 'dev@example.com', thin: true })
    process.env.ROBRAIN_REPO = checkout
    try {
      const { out, exitCode } = await runSynth()

      assert.doesNotMatch(out, new RegExp(CLOUD_MESSAGE), 'a store in the checkout .env must win over the token')
      assert.equal(exitCode, 0)
      assert.equal(readFileSync(marker, 'utf8'), repoDbUrl, 'child must receive the checkout .env DATABASE_URL')
    } finally {
      process.env.ROBRAIN_REPO = notACheckout
    }
  })

  it('prefers the cloud explanation over a resolution failure', async () => {
    // A cloud install has no local Synthesis to find — "we could not locate the
    // bundle" is a true but useless answer; the mode is the actual reason.
    writeInstallConfig({ token: 'rory_x', email: 'dev@example.com', thin: true })

    const { out, exitCode } = await runSynth()

    assert.match(out, new RegExp(CLOUD_MESSAGE))
    assert.doesNotMatch(out, new RegExp(RESOLVE_FAILURE))
    assert.equal(exitCode, 0)
  })

  it('names the stale-token escape hatch when it does decline', async () => {
    writeInstallConfig({ token: 'rory_stale', email: 'dev@example.com', thin: true })

    const { out } = await runSynth()

    assert.match(out, /npx robrain logout/)
    assert.match(out, /DATABASE_URL/)
  })
})
