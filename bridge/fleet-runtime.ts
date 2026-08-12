/**
 * fleet-runtime.ts — builds the explicit, dependency-injectable set of
 * objects the hub needs for fleet routing: a registry, a broker bound to that
 * registry, and a scheduler. `createFleetRuntime()` has NO side effect at
 * import — it does nothing until an entrypoint calls it explicitly (binding —
 * Phase 3 correction 7). The production HTTP entrypoint (src/server.ts) calls
 * this once and hands the SAME instance to the private listener and to every
 * per-request MCP server; the stdio entrypoint never calls it at all.
 */
import { createFleetRegistry, type FleetRegistry } from './fleet-registry.ts'
import { createFleetBroker, type FleetBroker } from './fleet-broker.ts'
import { createFleetScheduler, type FleetScheduler } from './fleet-scheduler.ts'
import { buildEnabledEngines } from './engine-registry.ts'
import type { PublicDeviceInfo } from './fleet-registry.ts'

export interface FleetRuntime {
  registry: FleetRegistry
  broker: FleetBroker
  scheduler: FleetScheduler
  /** Safe public metadata for the hub itself. The id and display name are
   * deliberately fixed and never derived from a hostname, username, path, or
   * tailnet identity. */
  localDevice?: PublicDeviceInfo
  /** Configured default device id for ambiguous open_session resolution
   *  (TANDEM_DEFAULT_DEVICE). Undefined ⇒ no configured default. */
  defaultDeviceId?: string
}

export interface FleetRuntimeOptions {
  defaultDeviceId?: string
  localEngines?: PublicDeviceInfo['engines']
}

export function createFleetRuntime(opts: FleetRuntimeOptions = {}): FleetRuntime {
  const registry = createFleetRegistry()
  const broker = createFleetBroker(registry)
  const scheduler = createFleetScheduler()
  const localDevice: PublicDeviceInfo = {
    id: 'local',
    name: 'local',
    online: true,
    engines: opts.localEngines ?? [...buildEnabledEngines()],
  }
  return { registry, broker, scheduler, localDevice, defaultDeviceId: opts.defaultDeviceId }
}

/** Reads TANDEM_DEFAULT_DEVICE. A pure function, not a module-load read — the
 *  entrypoint calls this explicitly after env setup, same pattern as every
 *  other TANDEM_* config reader in this repo. */
export function buildDefaultDeviceIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.TANDEM_DEFAULT_DEVICE?.trim()
  return v ? v : undefined
}
