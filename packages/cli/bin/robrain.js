#!/usr/bin/env node
/**
 * Entry shim for npm/npx: some older npm versions chmod the declared `bin` file more reliably
 * than `dist/index.js` alone when extracting the package cache.
 */
import '../dist/index.js'
