/**
 * fleet-dispatch.ts — the HUB side of session routing (binding — Phase 3
 * correction 2): resolves a caller-supplied `device`/session name into either
 * the existing LOCAL path (bridge/router.ts, unchanged) or a REMOTE fleet RPC,
 * and returns the identical bounded `{status, body}` shape either way.
 *
 * ROUTING RULES:
 *   - A bare name with no `device` is ALWAYS local — preserved exactly as
 *     before, and never re-resolved to a remote device.
 *   - A composite "device:localName" name and/or an explicit `device` field
 *     route exactly there; the two must agree or the call fails 400.
 *   - `open_session` with no device/composite name picks a configured
 *     default device, or the single device (local counts as a candidate)
 *     uniquely capable of the requested engine; otherwise a deterministic
 *     ambiguity error.
 *   - Every remote (or explicitly device-scoped) response that carries a
 *     `name` field has that field rewritten to the globally routable
 *     "<deviceId>:<localName>" form, with additive `device`/`localName`
 *     fields — a bare name is never returned for a remote session. Once a
 *     caller has that composite name, later calls parse the device out of it
 *     directly and never re-run selection — routing never drifts as fleet
 *     membership changes later.
 */
import type { EngineId } from './drivable.ts'
import { executeLocalOp, type DispatchResult } from './fleet-op-table.ts'
import { DeviceOfflineError, InFlightLimitError, BackpressureError, RpcTimeoutError, RpcRejectedError } from './fleet-broker.ts'
import { OPEN_SESSION_TIMEOUT_MS, type FleetOp } from './fleet-protocol.ts'
import type { FleetRuntime } from './fleet-runtime.ts'
import {
  decodeForemanCheckpoint,
  encodeForemanCheckpoint,
  InvalidCheckpointError,
  LOCAL_DEVICE_KEY,
  withDeviceCursor,
} from './foreman-checkpoint.ts'

export class DeviceConflictError extends Error {}
export class DeviceNotFoundError extends Error {}
export class DeviceAmbiguousError extends Error {
  readonly candidates: string[]

  constructor(
    message: string,
    candidates: string[],
  ) {
    super(message)
    this.candidates = candidates
  }
}

interface ResolvedTarget {
  /** undefined ⇒ local. */
  deviceId?: string
  localName: string
}

/** Parses a caller-supplied session name + optional explicit device into a
 *  resolved routing target, WITHOUT consulting online state — a bare name
 *  always means local, a composite/explicit device always means that exact
 *  device, full stop. */
export function resolveExistingTarget(name: string, explicitDevice: string | undefined): ResolvedTarget {
  const sep = name.indexOf(':')
  if (sep === -1) {
    if (explicitDevice !== undefined && explicitDevice !== 'local') return { deviceId: explicitDevice, localName: name }
    return { localName: name }
  }
  const impliedDevice = name.slice(0, sep)
  const localName = name.slice(sep + 1)
  if (explicitDevice !== undefined && explicitDevice !== impliedDevice) {
    throw new DeviceConflictError(
      `device "${explicitDevice}" conflicts with device "${impliedDevice}" implied by session name "${name}"`,
    )
  }
  if (impliedDevice === 'local') return { localName }
  return { deviceId: impliedDevice, localName }
}

interface OpenCandidate {
  deviceId?: string
  engines: EngineId[]
}

/** Device selection for `open_session` when no device/composite name is
 *  given. Local is always a candidate (engines = the local enabled-engine
 *  set), so a single-device/no-fleet setup keeps resolving to local exactly
 *  as before. */
export function resolveOpenDevice(runtime: FleetRuntime, explicitDevice: string | undefined, engine: EngineId): string | undefined {
  if (explicitDevice !== undefined) {
    if (explicitDevice === 'local') {
      const localEngines = runtime.localDevice?.engines ?? ['claude']
      if (!localEngines.includes(engine)) {
        throw new DeviceNotFoundError(`device "local" does not support engine "${engine}"`)
      }
      return undefined
    }
    const device = runtime.registry.get(explicitDevice)
    if (!device) throw new DeviceNotFoundError(`device "${explicitDevice}" is not online`)
    if (!device.engines.includes(engine)) {
      throw new DeviceNotFoundError(`device "${explicitDevice}" does not support engine "${engine}"`)
    }
    return explicitDevice
  }

  const candidates: OpenCandidate[] = [
    { deviceId: undefined, engines: runtime.localDevice?.engines ?? ['claude'] },
    ...runtime.registry.listOnline().map((d) => ({ deviceId: d.deviceId, engines: d.engines })),
  ]
  const capable = candidates.filter((c) => c.engines.includes(engine))

  if (runtime.defaultDeviceId !== undefined) {
    const configured = candidates.find((c) => (c.deviceId ?? 'local') === runtime.defaultDeviceId)
    if (!configured) throw new DeviceNotFoundError(`default device "${runtime.defaultDeviceId}" is not online`)
    if (!configured.engines.includes(engine)) {
      throw new DeviceNotFoundError(`default device "${runtime.defaultDeviceId}" does not support engine "${engine}"`)
    }
    return configured.deviceId
  }
  if (capable.length === 1) return capable[0]!.deviceId
  if (capable.length === 0) throw new DeviceNotFoundError(`no online device (including local) supports engine "${engine}"`)
  throw new DeviceAmbiguousError(
    `multiple online devices support engine "${engine}"; specify device explicitly`,
    capable.map((c) => c.deviceId ?? 'local'),
  )
}

const SCHEDULED_OPS = new Set<FleetOp>(['open_session', 'send', 'close'])

function brokerErrorToResult(e: unknown): DispatchResult {
  if (e instanceof DeviceOfflineError) return { status: 404, body: { error: e.message } }
  if (e instanceof InFlightLimitError) return { status: 429, body: { error: e.message } }
  if (e instanceof BackpressureError) return { status: 429, body: { error: e.message } }
  if (e instanceof RpcTimeoutError) return { status: 504, body: { error: e.message } }
  if (e instanceof RpcRejectedError) return { status: 502, body: { error: e.message } }
  return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
}

/** Rewrites a `name` field (when present and a string) into the globally
 *  routable composite form, with additive `device`/`localName`. No-op when
 *  the body has no `name` (e.g. read()'s response). */
function rewriteNameField(result: DispatchResult, deviceId: string): DispatchResult {
  if (result.status < 200 || result.status >= 300) return result
  const body = result.body as Record<string, unknown> | undefined
  if (!body || typeof body.name !== 'string') return result
  const localName = body.name
  return { status: result.status, body: { ...body, name: `${deviceId}:${localName}`, device: deviceId, localName } }
}

function rewriteListSessionsResponse(result: DispatchResult, deviceId: string): DispatchResult {
  if (result.status < 200 || result.status >= 300) return result
  const body = result.body as { sessions?: unknown } | undefined
  if (!body || !Array.isArray(body.sessions)) return result
  const sessions = body.sessions.map((s) => {
    if (typeof s !== 'object' || s === null || typeof (s as Record<string, unknown>).id !== 'string') return s
    const rec = s as Record<string, unknown>
    const localName = rec.id as string
    return { ...rec, id: `${deviceId}:${localName}`, device: deviceId, localName }
  })
  return rewriteRecentEvents({ status: result.status, body: { ...body, sessions } }, deviceId)
}

/**
 * Put the additive `recent_events` preview on the HUB's routing identity,
 * exactly as rewriteForemanPage does for the event feed.
 *
 * IDENTITY IS THE HUB'S, for the same reason it is there: a device reports its
 * events under whatever TANDEM_DEVICE_ID it was configured with, which the hub
 * has no reason to trust and no way to verify. Rewriting to the id the hub
 * actually routed to is what makes the composite name in a preview safe to
 * address a worker with — including on the local path, where the feed already
 * reports "local:<name>" and a preview that disagreed would be a second,
 * conflicting way to name the same session.
 */
function rewriteRecentEvents(result: DispatchResult, deviceId: string): DispatchResult {
  if (result.status < 200 || result.status >= 300) return result
  const body = result.body as { recent_events?: unknown } | undefined
  const preview = body?.recent_events as { events?: unknown } | undefined
  if (!body || !preview || typeof preview !== 'object' || !Array.isArray(preview.events)) return result
  const events = (preview.events as Array<Record<string, unknown>>).map((event) => {
    if (typeof event !== 'object' || event === null) return event
    const localName = typeof event.localName === 'string' ? event.localName : ''
    return { ...event, device: deviceId, session: `${deviceId}:${localName}` }
  })
  return { status: result.status, body: { ...body, recent_events: { ...preview, events } } }
}

async function maybeScheduled(runtime: FleetRuntime, op: FleetOp, key: string, run: () => Promise<DispatchResult>): Promise<DispatchResult> {
  return SCHEDULED_OPS.has(op) ? runtime.scheduler.schedule(key, run) : run()
}

export interface OpenSessionRequest {
  name?: string
  engine?: EngineId
  cwd?: string
  model?: string
  effort?: string
  /** Explicit user consent for a Fable model; forwarded unchanged so the
   *  executing device's router enforces the gate (bridge/model-policy.ts). */
  user_requested_fable?: boolean
  device?: string
}

export async function dispatchOpenSession(runtime: FleetRuntime, req: OpenSessionRequest): Promise<DispatchResult> {
  const engine = req.engine ?? 'claude'
  let localName = req.name
  let requestedDevice = req.device
  const explicitlyScoped = req.device !== undefined || req.name?.includes(':') === true
  if (req.name?.includes(':')) {
    try {
      const target = resolveExistingTarget(req.name, req.device)
      requestedDevice = target.deviceId ?? 'local'
      localName = target.localName
    } catch (e) {
      if (e instanceof DeviceConflictError) return { status: 400, body: { error: e.message } }
      throw e
    }
  }
  let deviceId: string | undefined
  try {
    deviceId = resolveOpenDevice(runtime, requestedDevice, engine)
  } catch (e) {
    if (e instanceof DeviceAmbiguousError) return { status: 409, body: { error: e.message, candidates: e.candidates } }
    if (e instanceof DeviceNotFoundError) return { status: 400, body: { error: e.message } }
    throw e
  }
  const key = `${deviceId ?? 'local'}:${localName ?? '*'}`
  const result = await maybeScheduled(runtime, 'open_session', key, async () => {
    if (deviceId === undefined) {
      return executeLocalOp('open_session', {
        name: localName,
        engine,
        cwd: req.cwd,
        model: req.model,
        effort: req.effort,
        user_requested_fable: req.user_requested_fable,
      })
    }
    try {
      return await runtime.broker.sendRequest(
        deviceId,
        'open_session',
        { name: localName, engine, cwd: req.cwd, model: req.model, effort: req.effort, user_requested_fable: req.user_requested_fable },
        { timeoutMs: OPEN_SESSION_TIMEOUT_MS },
      )
    } catch (e) {
      return brokerErrorToResult(e)
    }
  })
  return deviceId === undefined
    ? explicitlyScoped
      ? rewriteNameField(result, 'local')
      : result
    : rewriteNameField(result, deviceId)
}

export async function dispatchSessionOp(
  runtime: FleetRuntime,
  op: 'send' | 'read' | 'interrupt' | 'close',
  name: string,
  explicitDevice: string | undefined,
  payload: Record<string, unknown>,
): Promise<DispatchResult> {
  const explicitlyScoped = explicitDevice !== undefined || name.includes(':')
  let target: ResolvedTarget
  try {
    target = resolveExistingTarget(name, explicitDevice)
  } catch (e) {
    if (e instanceof DeviceConflictError) return { status: 400, body: { error: e.message } }
    throw e
  }
  const key = `${target.deviceId ?? 'local'}:${target.localName}`
  const result = await maybeScheduled(runtime, op, key, async () => {
    if (target.deviceId === undefined) {
      return executeLocalOp(op, { sessionId: target.localName, ...payload })
    }
    if (!runtime.registry.isOnline(target.deviceId)) {
      return { status: 404, body: { error: `device "${target.deviceId}" is not online` } }
    }
    try {
      return await runtime.broker.sendRequest(target.deviceId, op, { sessionId: target.localName, ...payload })
    } catch (e) {
      return brokerErrorToResult(e)
    }
  })
  return target.deviceId === undefined
    ? explicitlyScoped
      ? rewriteNameField(result, 'local')
      : result
    : rewriteNameField(result, target.deviceId)
}

export async function dispatchListSessions(
  runtime: FleetRuntime,
  explicitDevice: string | undefined,
  payload: { limit?: number; project?: string },
): Promise<DispatchResult> {
  if (explicitDevice === undefined || explicitDevice === 'local') {
    const result = await executeLocalOp('list_sessions', payload)
    // `sessions` keeps its pre-fleet shape on a bare local call — bare names
    // stay bare. The preview is still put on the hub's routing identity, so a
    // composite name read out of it always addresses the right worker.
    return explicitDevice === 'local'
      ? rewriteListSessionsResponse(result, LOCAL_DEVICE_KEY)
      : rewriteRecentEvents(result, LOCAL_DEVICE_KEY)
  }
  if (!runtime.registry.isOnline(explicitDevice)) {
    return { status: 404, body: { error: `device "${explicitDevice}" is not online` } }
  }
  let result: DispatchResult
  try {
    result = await runtime.broker.sendRequest(explicitDevice, 'list_sessions', payload)
  } catch (e) {
    return brokerErrorToResult(e)
  }
  return rewriteListSessionsResponse(result, explicitDevice)
}

/* ---- foreman event feed ---------------------------------------------------
 *
 * Each device keeps its OWN inbox: events are recorded where the work ran and
 * that device's store is their only truth. This is the hub-side read path.
 *
 * NO FAN-OUT, AND NO RECURSION. Exactly one device answers each call — the one
 * the caller selected, or the local hub when none was. bridge/router.ts's
 * `/foreman/events` handler stays a pure local inbox read that knows nothing
 * about a FleetRuntime, so a device executing an incoming `foreman_events`
 * request cannot route back out into the fleet. Aggregation across devices is
 * deliberately NOT implemented here: a foreman enumerates devices with
 * list_devices and asks each explicitly, which needs no cross-device merge and
 * no partial-failure semantics. The checkpoint format is already the map shape
 * aggregation would need, so adding it later breaks no stored token.
 *
 * IDENTITY IS THE HUB'S. A device reports its events under whatever
 * TANDEM_DEVICE_ID it was configured with, which the hub has no reason to
 * trust and no way to verify. Every returned event is rewritten to the id the
 * hub actually routed to, so `device` and `session` always match the name the
 * caller must use to address that worker.
 */

/** Rewrite a remote page onto the hub's routing identity and re-issue the
 *  caller's map token with only this device's entry advanced. */
function rewriteForemanPage(
  result: DispatchResult,
  deviceId: string,
  incoming: Map<string, string>,
): DispatchResult {
  if (result.status < 200 || result.status >= 300) return result
  const body = result.body as Record<string, unknown> | undefined
  if (!body || !Array.isArray(body.events)) return result

  const events = (body.events as Array<Record<string, unknown>>).map((event) => {
    const localName = typeof event.localName === 'string' ? event.localName : ''
    return { ...event, device: deviceId, session: `${deviceId}:${localName}` }
  })

  // The device's own single-store cursor becomes this device's entry in the
  // caller's map. Every other device's entry is preserved untouched.
  const deviceCursor = typeof body.checkpoint === 'string' ? body.checkpoint : undefined
  const nextMap = deviceCursor ? withDeviceCursor(incoming, deviceId, deviceCursor) : incoming

  return {
    status: result.status,
    body: { ...body, events, device: deviceId, checkpoint: encodeForemanCheckpoint(nextMap) },
  }
}

/**
 * Read one device's foreman event inbox. `device` omitted (or "local") keeps
 * the exact pre-fleet local behavior.
 */
export async function dispatchForemanEvents(
  runtime: FleetRuntime,
  payload: { device?: string; since?: string; limit?: number },
): Promise<DispatchResult> {
  let incoming: Map<string, string>
  try {
    incoming = decodeForemanCheckpoint(payload.since)
  } catch (e) {
    if (e instanceof InvalidCheckpointError) {
      return { status: 400, body: { error: `${e.message}; omit "since" to start a fresh checkpoint` } }
    }
    throw e
  }

  const requested = payload.device
  const isLocal = requested === undefined || requested === LOCAL_DEVICE_KEY
  const deviceId = isLocal ? LOCAL_DEVICE_KEY : requested
  // Each device's cursor is the single-store token that device itself issued;
  // the hub never interprets it, it only files it under the right key.
  const deviceCursor = incoming.get(deviceId)

  if (isLocal) {
    const result = await executeLocalOp('foreman_events', { since: deviceCursor, limit: payload.limit })
    return rewriteForemanPage(result, LOCAL_DEVICE_KEY, incoming)
  }

  if (!runtime.registry.isOnline(deviceId)) {
    // Explicit about WHICH device could not answer, and nothing else: no host,
    // no address, no path, no tailnet identity.
    return { status: 404, body: { error: `device "${deviceId}" is not online`, device: deviceId } }
  }

  let result: DispatchResult
  try {
    result = await runtime.broker.sendRequest(deviceId, 'foreman_events', {
      since: deviceCursor,
      limit: payload.limit,
    })
  } catch (e) {
    const mapped = brokerErrorToResult(e)
    // Coarse and sanitized: the caller learns the device and the class of
    // failure, never a transport detail from the far end.
    return { status: mapped.status, body: { error: foremanRoutingError(mapped.status, deviceId), device: deviceId } }
  }
  return rewriteForemanPage(result, deviceId, incoming)
}

/** One short, non-revealing sentence per failure class. */
function foremanRoutingError(status: number, deviceId: string): string {
  switch (status) {
    case 404:
      return `device "${deviceId}" is not online`
    case 429:
      return `device "${deviceId}" is busy; retry shortly`
    case 504:
      return `device "${deviceId}" did not answer in time`
    default:
      return `device "${deviceId}" could not return its foreman events`
  }
}

/** Pure local read of the registry's public list — never a wire round trip;
 *  the hub already knows every online device's engines from registration. */
export function dispatchListDevices(runtime: FleetRuntime): DispatchResult {
  const devices = runtime.localDevice ? [runtime.localDevice, ...runtime.registry.publicList()] : runtime.registry.publicList()
  return { status: 200, body: { devices } }
}
