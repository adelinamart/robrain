#!/usr/bin/env node
// CI gate: mimic `pnpm publish` tarball shape without touching the registry.
// Catches workspace: leaks and resolver paths that miss vendor/sensing-mcp.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), `robrain-pack-verify-${process.pid}`)

function fail(msg) {
  console.error(`pack:verify FAILED — ${msg}`)
  process.exit(1)
}

mkdirSync(work, { recursive: true })

try {
  execFileSync('node', ['scripts/vendor-sensing-mcp.mjs'], { cwd: cliRoot, stdio: 'inherit' })

  execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: cliRoot, stdio: 'inherit' })

  const version = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version
  const tarball = join(work, `robrain-${version}.tgz`)
  if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`)

  execFileSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'inherit' })
  const extracted = join(work, 'package')

  const published = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
  for (const [dep, spec] of Object.entries(published.dependencies ?? {})) {
    if (String(spec).startsWith('workspace:')) {
      fail(`workspace: dep leaked to tarball: ${dep}=${spec}`)
    }
  }

  const vendorEntry = join(extracted, 'vendor', 'sensing-mcp', 'dist', 'index.js')
  if (!existsSync(vendorEntry)) {
    fail('vendor/sensing-mcp/dist/index.js missing from tarball')
  }

  const bundleUrl = pathToFileURL(join(extracted, 'dist', 'lib', 'mcp-bundle.js')).href
  const { resolveInstalledSensingMcpDir } = await import(bundleUrl)
  const dir = resolveInstalledSensingMcpDir()
  if (!dir) fail('resolveInstalledSensingMcpDir() returned undefined in extracted tarball')
  if (!existsSync(join(dir, 'dist', 'index.js'))) {
    fail(`resolved dir has no dist/index.js: ${dir}`)
  }

  console.log(`pack:verify ok — vendor resolves from ${dir}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
