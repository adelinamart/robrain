// packages/shared/src/db.ts
// ─────────────────────────────────────────────────────────────
// Postgres pool resilience. pg's Pool emits 'error' for idle
// clients whose server connection drops (e.g. Postgres restart:
// "terminating connection due to administrator command"). With no
// listener attached, Node treats it as an unhandled 'error' event
// and crashes the whole process — observed taking Perception down
// until its container was manually recreated. Attaching a listener
// is sufficient: the pool discards the dead client and opens a
// fresh connection on the next query.
// ─────────────────────────────────────────────────────────────

/** Structural subset of pg.Pool — avoids a pg dependency in shared. */
export interface PoolLike {
  on(event: 'error', listener: (err: Error) => void): unknown
}

export function attachPoolErrorHandler(
  pool: PoolLike,
  label: string,
  log: (message: string) => void = console.error,
): void {
  pool.on('error', (err: Error) => {
    log(`[${label}] Postgres pool error (dead connection dropped; pool will reconnect on next query): ${err.message}`)
  })
}
