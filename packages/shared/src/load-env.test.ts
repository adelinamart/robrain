import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadEnv } from './load-env.js'

// Each test uses its own env keys so parallel/shared process.env stays clean.
function inTempRepo(fn: (repo: string) => void): void {
  // realpath: macOS tmpdir is a symlink (/var → /private/var); process.cwd()
  // returns the resolved path, which must match what the walk compares.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'robrain-loadenv-')))
  const prevCwd = process.cwd()
  try {
    fn(repo)
  } finally {
    process.chdir(prevCwd)
    rmSync(repo, { recursive: true, force: true })
  }
}

describe('loadEnv upward walk', () => {
  it('finds the repo-root .env from a nested subdirectory', () => {
    inTempRepo(repo => {
      mkdirSync(join(repo, '.git'))
      mkdirSync(join(repo, 'packages', 'deep', 'nested'), { recursive: true })
      writeFileSync(join(repo, '.env'), 'ROBRAIN_TEST_WALK_ROOT=from-root\n')

      process.chdir(join(repo, 'packages', 'deep', 'nested'))
      delete process.env.ROBRAIN_TEST_WALK_ROOT
      loadEnv()

      assert.equal(process.env.ROBRAIN_TEST_WALK_ROOT, 'from-root')
      delete process.env.ROBRAIN_TEST_WALK_ROOT
    })
  })

  it('nearer .env wins over the repo-root .env per key', () => {
    inTempRepo(repo => {
      mkdirSync(join(repo, '.git'))
      mkdirSync(join(repo, 'packages', 'app'), { recursive: true })
      writeFileSync(join(repo, '.env'), [
        'ROBRAIN_TEST_WALK_SHARED=from-root',
        'ROBRAIN_TEST_WALK_ONLY_ROOT=root-value',
      ].join('\n'))
      writeFileSync(join(repo, 'packages', 'app', '.env'), 'ROBRAIN_TEST_WALK_SHARED=from-app\n')

      process.chdir(join(repo, 'packages', 'app'))
      delete process.env.ROBRAIN_TEST_WALK_SHARED
      delete process.env.ROBRAIN_TEST_WALK_ONLY_ROOT
      loadEnv()

      assert.equal(process.env.ROBRAIN_TEST_WALK_SHARED, 'from-app')
      assert.equal(process.env.ROBRAIN_TEST_WALK_ONLY_ROOT, 'root-value')
      delete process.env.ROBRAIN_TEST_WALK_SHARED
      delete process.env.ROBRAIN_TEST_WALK_ONLY_ROOT
    })
  })

  it('stops at pnpm-workspace.yaml as a root marker', () => {
    inTempRepo(repo => {
      writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
      mkdirSync(join(repo, 'packages', 'lib'), { recursive: true })
      writeFileSync(join(repo, '.env'), 'ROBRAIN_TEST_WALK_WS=workspace\n')

      process.chdir(join(repo, 'packages', 'lib'))
      delete process.env.ROBRAIN_TEST_WALK_WS
      loadEnv()

      assert.equal(process.env.ROBRAIN_TEST_WALK_WS, 'workspace')
      delete process.env.ROBRAIN_TEST_WALK_WS
    })
  })

  it('does not walk above cwd outside a repo', () => {
    inTempRepo(dir => {
      // No .git / workspace marker anywhere in the temp tree: a parent .env
      // must NOT load, only cwd's own.
      mkdirSync(join(dir, 'child'))
      writeFileSync(join(dir, '.env'), 'ROBRAIN_TEST_WALK_PARENT=leaked\n')
      writeFileSync(join(dir, 'child', '.env'), 'ROBRAIN_TEST_WALK_CWD=own\n')

      process.chdir(join(dir, 'child'))
      delete process.env.ROBRAIN_TEST_WALK_PARENT
      delete process.env.ROBRAIN_TEST_WALK_CWD
      loadEnv()

      assert.equal(process.env.ROBRAIN_TEST_WALK_CWD, 'own')
      assert.equal(process.env.ROBRAIN_TEST_WALK_PARENT, undefined)
      delete process.env.ROBRAIN_TEST_WALK_CWD
    })
  })

  it('explicit repoRoot still wins over everything on the walk', () => {
    inTempRepo(repo => {
      mkdirSync(join(repo, '.git'))
      mkdirSync(join(repo, 'sub'))
      mkdirSync(join(repo, 'explicit'))
      writeFileSync(join(repo, '.env'), 'ROBRAIN_TEST_WALK_PREC=walk\n')
      writeFileSync(join(repo, 'explicit', '.env'), 'ROBRAIN_TEST_WALK_PREC=explicit\n')

      process.chdir(join(repo, 'sub'))
      delete process.env.ROBRAIN_TEST_WALK_PREC
      loadEnv(join(repo, 'explicit'))

      assert.equal(process.env.ROBRAIN_TEST_WALK_PREC, 'explicit')
      delete process.env.ROBRAIN_TEST_WALK_PREC
    })
  })
})
