/**
 * fleet-registry.ts — the hub's in-memory table of currently connected
 * devices. A plain dependency-injectable factory (`createFleetRegistry`), not
 * a module-level singleton — the hub's production entrypoint builds ONE
 * instance explicitly and shares it with the private listener, the RPC
 * broker, and every per-request MCP server (binding — Phase 3 correction 7).
 *
 * GENERATION SAFETY (binding — Phase 3 correction 6): every `register()` call
 * — including a duplicate registration for an already-online device id — is
 * assigned a fresh, monotonically increasing generation number. `unregister()`
 * only takes effect when the caller's generation still matches the CURRENT
 * live entry, so an OLD socket's close handler can never unregister (or
 * otherwise affect) a NEWER connection that has already replaced it.
 */
import type { EngineId } from './drivable.ts'

/** The minimal socket surface this module needs — real `ws.WebSocket` and a
 *  test fake both satisfy this without either side importing the other. */
export interface FleetSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly bufferedAmount: number
}

export interface DeviceConnection {
  readonly deviceId: string
  name: string
  engines: EngineId[]
  readonly socket: FleetSocket
  readonly generation: number
  readonly connectedAt: number
}

/** Exact public shape (binding — Phase 3 correction 10): id, name, online,
 *  engines ONLY. Never IP, hostname, username, tailnet identity, path, token,
 *  nonce, socket, or timing. */
export interface PublicDeviceInfo {
  id: string
  name: string
  online: boolean
  engines: EngineId[]
}

export interface RegisterResult {
  generation: number
  /** The connection this registration replaced, if the device id was already
   *  online. The caller (fleet-private-server.ts) is responsible for
   *  rejecting its pending RPCs and closing its socket. */
  replaced?: DeviceConnection
}

export function createFleetRegistry() {
  const devices = new Map<string, DeviceConnection>()
  const knownDevices = new Map<string, PublicDeviceInfo>()
  let generationCounter = 0

  function register(deviceId: string, name: string, engines: EngineId[], socket: FleetSocket): RegisterResult {
    const generation = ++generationCounter
    const replaced = devices.get(deviceId)
    devices.set(deviceId, { deviceId, name, engines, socket, generation, connectedAt: Date.now() })
    knownDevices.set(deviceId, { id: deviceId, name, online: true, engines: [...engines] })
    return { generation, replaced }
  }

  function unregister(deviceId: string, generation: number): boolean {
    const current = devices.get(deviceId)
    if (!current || current.generation !== generation) return false
    devices.delete(deviceId)
    const known = knownDevices.get(deviceId)
    if (known) knownDevices.set(deviceId, { ...known, online: false })
    return true
  }

  function get(deviceId: string): DeviceConnection | undefined {
    return devices.get(deviceId)
  }

  function isOnline(deviceId: string): boolean {
    return devices.has(deviceId)
  }

  function listOnline(): DeviceConnection[] {
    return [...devices.values()]
  }

  function publicList(): PublicDeviceInfo[] {
    return [...knownDevices.values()].map((device) => ({ ...device, engines: [...device.engines] }))
  }

  /** Optional capability refresh (spec: "optional capability refresh when
   *  enabled engines change"). Generation-guarded like unregister(). */
  function updateEngines(deviceId: string, generation: number, engines: EngineId[]): boolean {
    const current = devices.get(deviceId)
    if (!current || current.generation !== generation) return false
    current.engines = engines
    const known = knownDevices.get(deviceId)
    if (known) knownDevices.set(deviceId, { ...known, engines: [...engines] })
    return true
  }

  return { register, unregister, get, isOnline, listOnline, publicList, updateEngines }
}

export type FleetRegistry = ReturnType<typeof createFleetRegistry>
