/**
 * fleet-device-router.ts — the DEVICE side of an incoming fleet request:
 * executes an already-validated {op, payload} against THIS device's own
 * local router.ts, through the same fixed op table the hub uses (binding —
 * Phase 3 correction 11), with the same per-session-name scheduler bounding
 * open_session/send/close (binding — Phase 3 correction 9). read/interrupt
 * bypass the scheduler so a long bounded turn can still be observed/stopped.
 *
 * This module grants nothing the local router wouldn't already grant to a
 * same-machine caller — bridge/router.ts (cwd allowlist, engine gate,
 * ownership) remains the one trust boundary regardless of transport (binding
 * — Phase 3 correction 13: the device still re-checks enablement/availability
 * itself; the hub's registration-time capability report is only ever treated
 * as an authenticated CLAIM, not a bypass).
 */
import { executeLocalOp, type DispatchResult, type LocalOpPayload } from './fleet-op-table.ts'
import type { FleetScheduler } from './fleet-scheduler.ts'
import type { FleetOp } from './fleet-protocol.ts'

const SCHEDULED_OPS = new Set<FleetOp>(['open_session', 'send', 'close'])

function schedulerKey(op: FleetOp, payload: Record<string, unknown>): string {
  if (op === 'open_session') {
    return `local:${typeof payload.name === 'string' ? payload.name : '*'}`
  }
  return `local:${typeof payload.sessionId === 'string' ? payload.sessionId : '*'}`
}

export async function handleDeviceRequest(scheduler: FleetScheduler, op: FleetOp, payload: Record<string, unknown>): Promise<DispatchResult> {
  const run = () => executeLocalOp(op, payload as LocalOpPayload)
  if (!SCHEDULED_OPS.has(op)) return run()
  return scheduler.schedule(schedulerKey(op, payload), run)
}
