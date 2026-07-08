#!/usr/bin/env node
// Copy the built sensing-mcp bundle into vendor/ so the published robrain
// tarball is self-contained — no @robrain npm org or second package required.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(cliRoot, '..', 'sensing-mcp')
const dest = join(cliRoot, 'vendor', 'sensing-mcp')
const srcEntry = join(src, 'dist', 'index.js')

if (!existsSync(srcEntry)) {
  console.error('vendor-sensing-mcp: missing', srcEntry)
  console.error('Run: pnpm --filter @robrain/sensing-mcp build')
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version

rmSync(dest, { recursive: true, force: true })
mkdirSync(join(dest, 'dist'), { recursive: true })
cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true })
writeFileSync(
  join(dest, 'package.json'),
  JSON.stringify(
    { name: '@robrain/sensing-mcp', version, private: true, type: 'module', main: './dist/index.js' },
    null,
    2,
  ) + '\n',
)
console.log(`Vendored sensing-mcp@${version} → packages/cli/vendor/sensing-mcp`)
