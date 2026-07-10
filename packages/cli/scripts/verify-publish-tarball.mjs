#!/usr/bin/env node
// CI gate: mimic `pnpm publish` tarball shape without touching the registry.
// Catches workspace: leaks and resolver paths that miss vendor/sensing-mcp.
import { execFileSync, spawn } from 'child_process'
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
  execFileSync('node', ['scripts/vendor-hermes-plugin.mjs'], { cwd: cliRoot, stdio: 'inherit' })

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

  const hermesVendorEntry = join(extracted, 'vendor', 'hermes-plugin', 'robrain', '__init__.py')
  if (!existsSync(hermesVendorEntry)) {
    fail('vendor/hermes-plugin/robrain/__init__.py missing from tarball')
  }

  const hermesUrl = pathToFileURL(join(extracted, 'dist', 'lib', 'hermes-plugin.js')).href
  const { installHermesPlugin, resolveHermesPluginSourceDir } = await import(hermesUrl)
  const hermesSrc = resolveHermesPluginSourceDir()
  // realpath both sides — on macOS the tmpdir is reached via the /var →
  // /private/var symlink, so raw prefix comparison false-negatives.
  const { realpathSync } = await import('fs')
  if (!hermesSrc || !realpathSync(hermesSrc).startsWith(realpathSync(extracted))) {
    fail(`resolveHermesPluginSourceDir() did not resolve inside the tarball: ${hermesSrc}`)
  }
  const hermesHome = join(work, 'hermes-home')
  const { dest } = installHermesPlugin(hermesHome)
  if (!existsSync(join(dest, 'plugin.yaml'))) {
    fail(`installHermesPlugin() copy incomplete at ${dest}`)
  }

  // Smoke-test the server entry robrain mcp execs (no CLI deps needed in the tarball).
  const mcpEntry = join(extracted, 'vendor', 'sensing-mcp', 'dist', 'index.js')
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PERCEPTION_API_URL: 'http://localhost:39999',
        PERCEPTION_API_KEY: 'pack-verify',
      },
    })
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      err ? reject(err) : resolve()
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      done()
    }, 800)
    child.on('exit', (code, signal) => {
      if (code === 1 && !signal) done(new Error('sensing-mcp entry exited immediately (bundle corrupt or missing deps)'))
      else done()
    })
    child.on('error', (err) => done(err))
  })

  console.log(`pack:verify ok — sensing vendor resolves from ${dir}; hermes plugin installs from ${hermesSrc}; sensing-mcp entry spawns`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
