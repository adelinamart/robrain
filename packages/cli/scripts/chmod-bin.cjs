#!/usr/bin/env node
/** Older npm/npx (e.g. 9.6.x on Node 18.17) sometimes extract bins without +x — fix after install. */
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
for (const rel of ['dist/index.js', 'bin/robrain.js']) {
  const p = path.join(root, rel)
  try {
    fs.chmodSync(p, 0o755)
  }
  catch {
    /* missing during partial install — ignore */
  }
}
