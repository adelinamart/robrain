// packages/synthesis/build.mjs
// ─────────────────────────────────────────────────────────────
// Bundle Synthesis into a single self-contained ESM file.
//
// Everything it needs at runtime — @robrain/shared (a workspace package),
// pg, the LLM SDKs, jsonrepair — is inlined into one dist/index.js. The
// artifact has NO node_modules dependency, so the CLI can vendor it into the
// published robrain tarball (scripts/vendor-synthesis.mjs) and `npx robrain
// synth` works without a repo clone. This replaces plain `tsc`, whose
// unbundled output left bare `import '@robrain/shared'` calls that only
// resolved via the monorepo's pnpm symlink farm.
//
// Because everything is inlined, package.json declares NO runtime dependencies —
// they all live in devDependencies (same pattern as sensing-mcp).
// ─────────────────────────────────────────────────────────────
import { build } from 'esbuild'
import { rmSync } from 'node:fs'

// Start clean so no stale per-file tsc output lingers next to the single bundle.
rmSync('dist', { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile:     'dist/index.js',
  bundle:      true,
  platform:    'node',
  format:      'esm',
  target:      'node18',
  // pg lazily requires the optional native driver; leave it unresolved so the
  // bundle builds — the pure-JS pg client is what actually runs.
  external:    ['pg-native'],
  // Some bundled CJS dependencies call require() at runtime; under ESM output
  // there is no implicit `require`, so provide one from import.meta.url.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
})
