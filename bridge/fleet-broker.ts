/**
 * fleet-broker.ts — the bounded RPC broker: turns a hub-side "send this op to
 * this device" call into a request frame, tracks the pending reply, and
 * resolves/rejects it when a matching response frame arrives (or the request
 * times out, the device disconnects, is replaced, or the hub shuts down).
 *
 * BOUNDS (binding — Phase 3 corrections 3 and 8):
 *   - MAX_IN_FLIGHT_PER_DEVICE is a hard, IMMEDIATE rejection of the next
 *     request once reached — never an unbounded queue.
 *   - a device socket already holding more than MAX_BUFFERED_BYTES of
 *     unsent data is refused a new request too, so a burst of large
 *     in-flight responses can never grow the socket's buffer without bound.
 */
import type { FleetRegistry } from './fleet-registry.ts'
import { DEFAULT_RPC_TIMEOUT_MS, MAX_IN_FLIGHT_PER_DEVICE, encodeRequestFrame, generateRequestId, type FleetOp } from './fleet-protocol.ts'

export class DeviceOfflineError extends Error {}
export class InFlightLimitError extends Error {}
export class BackpressureError extends Error {}
export class RpcTimeoutError extends Error {}
export class RpcRejectedError extends Error {}

/** A large in-flight response burst must never grow a device socket's send
 *  buffer without bound; this is independent of (and in addition to) the
 *  32-request in-flight cap. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024 // 8 MiB

interface PendingRequest {
  resolve: (v: { status: number; body: unknown }) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export function createFleetBroker(registry: FleetRegistry) {
  const pendingByDevice = new Map<string, Map<string, PendingRequest>>()

  function pendingMapFor(deviceId: string): Map<string, PendingRequest> {
    let m = pendingByDevice.get(deviceId)
    if (!m) {
      m = new Map()
      pendingByDevice.set(deviceId, m)
    }
    return m
  }

  function deletePending(deviceId: string, id: string, pending: Map<string, PendingRequest>): void {
    pending.delete(id)
    if (pending.size === 0 && pendingByDevice.get(deviceId) === pending) {
      pendingByDevice.delete(deviceId)
    }
  }

  async function sendRequest(
    deviceId: string,
    op: FleetOp,
    payload: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ status: number; body: unknown }> {
    const device = registry.get(deviceId)
    if (!device) throw new DeviceOfflineError(`device "${deviceId}" is not online`)

    const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('RPC timeout must be a positive finite number')
    }

    const pending = pendingMapFor(deviceId)
    if (pending.size >= MAX_IN_FLIGHT_PER_DEVICE) {
      throw new InFlightLimitError(`device "${deviceId}" is at its ${MAX_IN_FLIGHT_PER_DEVICE}-request in-flight limit`)
    }
    if (device.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      throw new BackpressureError(`device "${deviceId}" socket is backpressured`)
    }

    const id = generateRequestId()
    const frame = encodeRequestFrame(id, op, payload)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        deletePending(deviceId, id, pending)
        reject(new RpcTimeoutError(`"${op}" to device "${deviceId}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        device.socket.send(frame)
      } catch (e) {
        clearTimeout(timer)
        deletePending(deviceId, id, pending)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** Routes a device's response frame to its matching pending request. A
   *  late/unknown id (already timed out, or from a superseded connection) is
   *  silently ignored — never throws. */
  function handleResponse(
    deviceId: string,
    id: string,
    ok: boolean,
    status: number | undefined,
    body: unknown,
    error: string | undefined = undefined,
  ): void {
    const pending = pendingByDevice.get(deviceId)
    const entry = pending?.get(id)
    if (!pending || !entry) return
    deletePending(deviceId, id, pending)
    clearTimeout(entry.timer)
    if (ok) entry.resolve({ status: status ?? 200, body })
    else entry.reject(new RpcRejectedError(error ?? 'request rejected'))
  }

  /** Deterministically rejects every pending request for `deviceId`, oldest
   *  first. Used on disconnect, duplicate replacement (BEFORE the old socket
   *  is closed), and shutdown. */
  function rejectAll(deviceId: string, reason: string): void {
    const pending = pendingByDevice.get(deviceId)
    if (!pending) return
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new RpcRejectedError(reason))
      pending.delete(id)
    }
    pendingByDevice.delete(deviceId)
  }

  function rejectEverything(reason: string): void {
    for (const deviceId of [...pendingByDevice.keys()]) rejectAll(deviceId, reason)
  }

  function inFlightCount(deviceId: string): number {
    return pendingByDevice.get(deviceId)?.size ?? 0
  }

  return { sendRequest, handleResponse, rejectAll, rejectEverything, inFlightCount }
}

export type FleetBroker = ReturnType<typeof createFleetBroker>
