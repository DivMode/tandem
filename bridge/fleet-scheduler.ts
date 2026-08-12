/**
 * fleet-scheduler.ts — a bounded per-key operation chain shared by the LOCAL
 * dispatch path and the REMOTE (fleet) dispatch path (binding — Phase 3
 * correction 9): `open_session`/`send`/`close` for the same device/local-
 * session name are chained so two concurrent calls can never interleave
 * mid-turn. `read`/`interrupt` intentionally bypass this module entirely so a
 * long bounded turn can still be observed or stopped.
 *
 * Each key's chain entry is deleted once nothing is pending for that key —
 * this map never grows without bound.
 */
export function createFleetScheduler() {
  const chains = new Map<string, Promise<unknown>>()

  function schedule<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve()
    // Run `fn` regardless of whether `prior` resolved or rejected, so one
    // failed operation never wedges the chain for later callers of the same key.
    const next = prior.then(fn, fn) as Promise<T>
    chains.set(key, next)
    // Observe cleanup on both outcomes without creating a second rejecting
    // promise. Using `finally()` here would leave an unhandled rejection when
    // the scheduled operation failed and the caller correctly handled only
    // the original `next` promise.
    void next.then(
      () => {
        if (chains.get(key) === next) chains.delete(key)
      },
      () => {
        if (chains.get(key) === next) chains.delete(key)
      },
    )
    return next
  }

  function pendingKeyCount(): number {
    return chains.size
  }

  return { schedule, pendingKeyCount }
}

export type FleetScheduler = ReturnType<typeof createFleetScheduler>
