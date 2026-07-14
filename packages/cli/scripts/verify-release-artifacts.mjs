#!/usr/bin/env node
// Publish gate: refuse to publish a CLI version whose GHCR Perception image
// does not exist — `robrain up` defaults its Docker tag to the CLI version, so
// npm-without-image breaks every no-clone install. Runs in prepublishOnly
// after the build; evaluation logic lives in dist/lib/release-guard.js.
// Emergency bypass: ROBRAIN_SKIP_RELEASE_GUARD=1 pnpm publish
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.ROBRAIN_SKIP_RELEASE_GUARD === '1') {
  console.warn('release-guard SKIPPED via ROBRAIN_SKIP_RELEASE_GUARD=1 — the GHCR image for this version may not exist.')
  process.exit(0)
}

const { evaluateReleaseGuard, manifestStatusToPublished, originHasReleaseTag } =
  await import(pathToFileURL(join(cliRoot, 'dist', 'lib', 'release-guard.js')).href)
const { DEFAULT_IMAGE_REPO } = await import(pathToFileURL(join(cliRoot, 'dist', 'commands', 'up.js')).href)

const version = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version

function fail(problems) {
  console.error(`\nrelease-guard FAILED for robrain@${version}:\n`)
  for (const p of problems) console.error(`  ✗ ${p}\n`)
  console.error('  (Emergency bypass: ROBRAIN_SKIP_RELEASE_GUARD=1)\n')
  process.exit(1)
}

let lsRemote
try {
  lsRemote = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${version}*`], {
    cwd: cliRoot,
    encoding: 'utf8',
  })
} catch (err) {
  fail([`could not query origin tags (git ls-remote failed): ${err.message}`])
}

// Anonymous pull-scope token, then HEAD the version's manifest — per-tag, so
// immune to tags/list pagination as releases accumulate.
const ghcrRepo = DEFAULT_IMAGE_REPO.replace(/^ghcr\.io\//, '')
let imagePublished
try {
  const tokenRes = await fetch(`https://ghcr.io/token?scope=repository:${ghcrRepo}:pull`)
  const { token } = await tokenRes.json()
  const manifestRes = await fetch(`https://ghcr.io/v2/${ghcrRepo}/manifests/${version}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      // The multi-arch index plus single-manifest fallbacks; without these
      // some registries 404 even for tags that exist.
      Accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  })
  imagePublished = manifestStatusToPublished(manifestRes.status)
} catch (err) {
  fail([`could not check ${DEFAULT_IMAGE_REPO}:${version} on GHCR: ${err.message}`])
}

const result = evaluateReleaseGuard({
  version,
  imageRepo: DEFAULT_IMAGE_REPO,
  originHasTag: originHasReleaseTag(lsRemote, version),
  imagePublished,
})

if (!result.ok) fail(result.problems)

console.log(`release-guard ok — v${version} tag on origin, ${DEFAULT_IMAGE_REPO}:${version} published`)
