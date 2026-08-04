# @robrain/shared

Shared primitives for [RoBrain](https://github.com/adelinamart/robrain) —
database helpers, embedding and LLM providers, secret redaction, trust scoring,
and the canonical Postgres schema.

This package is published so RoBrain services can depend on a prebuilt tarball
instead of compiling the monorepo at install time. It is not a general-purpose
library: the API tracks RoBrain's needs and moves with the monorepo's lockstep
version.

## Install

```bash
npm install @robrain/shared
```

No runtime dependencies — everything here imports only Node built-ins. Database
helpers take a structural `PoolLike`, so bring your own `pg` (or compatible)
pool.

## Usage

```js
import { scoreMemoryTrust, redactSecrets, embed } from '@robrain/shared'
import { loadEnv } from '@robrain/shared/load-env'
```

The Postgres schema ships at the package root and can be resolved directly:

```js
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const schema = readFileSync(require.resolve('@robrain/shared/schema.sql'), 'utf8')
```

## Links

- [Repository](https://github.com/adelinamart/robrain) (source lives in `packages/shared`)
- [Issues](https://github.com/adelinamart/robrain/issues)

## License

Apache-2.0 © Rory Plans, Inc.
