/**
 * fleet-device-client.ts — the reconnecting DEVICE-side WebSocket client.
 * Connects OUT to a hub's private fleet listener, registers with a fresh
 * cryptographically random nonce every connection attempt, executes incoming
 * request frames against this device's own local router (via
 * bridge/fleet-device-router.ts, which reuses the SAME fixed op table and
 * per-session scheduler the hub uses — binding — Phase 3 corrections 9 and
 * 11), and reconnects with bounded exponential backoff + jitter on any
 * disconnect.
 *
 * URL / TOKEN HARDENING (binding — Phase 3 correction 5): `wss:` is always
 * accepted; `ws:` is accepted ONLY for an exact loopback host (dev/test).
 * Credentials, query strings, and fragments are rejected outright. The fleet
 * token is sent EXCLUSIVELY as an `Authorization: Bearer` connection header —
 * never embedded in the URL, so it can never leak into a proxy access log,
 * an error message, or a process argument list. No WebSocket subprotocol
 * fallback is used or needed.
 */
import { WebSocket, type RawData } from 'ws'
import type { EngineId } from './drivable.ts'
import { handleDeviceRequest } from './fleet-device-router.ts'
import {
  FrameInvalidError,
  FrameTooLargeError,
  HEARTBEAT_INTERVAL_MS,
  MAX_FRAME_BYTES,
  REGISTRATION_TIMEOUT_MS,
  encodeCapabilitiesFrame,
  encodePingFrame,
  encodePongFrame,
  encodeRegisterFrame,
  encodeResponseFrame,
  generateNonce,
  parseFrame,
  validateDeviceId,
  validateDeviceName,
} from './fleet-protocol.ts'
import { createFleetScheduler, type FleetScheduler } from './fleet-scheduler.ts'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 30_000
const HEALTHY_CONNECTION_MS = 10_000
const DIAL_TIMEOUT_MS = 20_000
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

export class InvalidHubUrlError extends Error {}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** Hard-validates a device client URL (binding — Phase 3 correction 5). */
export function validateHubUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new InvalidHubUrlError('invalid hub URL')
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new InvalidHubUrlError('hub URL must use ws:// or wss://')
  }
  if (url.username || url.password) throw new InvalidHubUrlError('hub URL must not contain credentials')
  if (url.search) throw new InvalidHubUrlError('hub URL must not contain a query string')
  if (url.hash) throw new InvalidHubUrlError('hub URL must not contain a fragment')
  if (url.protocol === 'ws:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new InvalidHubUrlError(
      'ws:// is allowed only for an exact loopback host; use wss:// for a non-loopback hub',
    )
  }
  return url
}

export interface DeviceClientOptions {
  hubUrl: string
  fleetToken: string
  deviceId: string
  deviceName: string
  /** Re-read on every connect (and on demand via sendCapabilityRefresh()) so
   *  a live TANDEM_ENABLED_ENGINES change is reflected without a reconnect. */
  engines: () => EngineId[]
  /** Injectable WebSocket constructor — tests never open a real socket. */
  WebSocketImpl?: typeof WebSocket
  /** Injectable jitter source (0..1) for deterministic reconnect tests. */
  randomJitter?: () => number
  /** Test seams. Production uses the bounded defaults above. */
  dialTimeoutMs?: number
  registrationTimeoutMs?: number
  /** Setup verification seam. Called only after an authenticated hub accepts
   * this device's registration frame. */
  onRegistered?: () => void
}

export interface ReconnectPlan {
  attempt: number
  delayMs: number
}

/** Pure bounded backoff calculation. A connection only earns a reset after
 * it stayed healthy for at least ten seconds. Jitter is symmetric and the
 * final value is always clamped to the hard maximum. */
export function planReconnect(
  previousAttempt: number,
  uptimeMs: number,
  randomValue: number,
  opts: { baseMs?: number; maxMs?: number; healthyMs?: number } = {},
): ReconnectPlan {
  const baseMs = opts.baseMs ?? RECONNECT_BASE_MS
  const maxMs = opts.maxMs ?? RECONNECT_MAX_MS
  const healthyMs = opts.healthyMs ?? HEALTHY_CONNECTION_MS
  const attempt = uptimeMs >= healthyMs ? 1 : Math.min(previousAttempt + 1, 31)
  const raw = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
  const boundedRandom = Math.min(1, Math.max(0, randomValue))
  const jitterFactor = 0.85 + boundedRandom * 0.3
  return { attempt, delayMs: Math.min(maxMs, Math.round(raw * jitterFactor)) }
}

export class FleetDeviceClient {
  private readonly opts: DeviceClientOptions
  private readonly scheduler: FleetScheduler
  private ws: WebSocket | undefined
  private closed = true
  private attempt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private missedPong = false

  constructor(opts: DeviceClientOptions) {
    validateHubUrl(opts.hubUrl)
    if (opts.fleetToken.trim().length < 16) throw new Error('fleet token must contain at least 16 characters')
    validateDeviceId(opts.deviceId)
    validateDeviceName(opts.deviceName)
    this.opts = opts
    this.scheduler = createFleetScheduler()
  }

  start(): void {
    this.closed = false
    this.attempt = 0
    this.connect()
  }

  async stop(): Promise<void> {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.ws?.close(1000, 'client shutdown')
  }

  /** Optional capability refresh (spec: "optional capability refresh when
   *  enabled engines change"). No-op if not currently connected. */
  sendCapabilityRefresh(): void {
    const ws = this.ws
    if (ws && ws.readyState === ws.OPEN) {
      try {
        ws.send(encodeCapabilitiesFrame(this.opts.engines()))
      } catch {
        /* best-effort; the next reconnect re-registers with current engines anyway */
      }
    }
  }

  private connect(): void {
    const WSImpl = this.opts.WebSocketImpl ?? WebSocket
    // Token sent ONLY as an exact Authorization bearer header — never in the
    // URL — so it can never leak via a proxy log, error, or the URL string.
    const ws = new WSImpl(this.opts.hubUrl, {
      headers: { authorization: `Bearer ${this.opts.fleetToken}` },
      maxPayload: MAX_FRAME_BYTES,
    })
    this.ws = ws
    const connection = {
      registered: false,
      registrationTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      dialTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    let openedAt = 0

    connection.dialTimer = setTimeout(() => ws.terminate(), this.opts.dialTimeoutMs ?? DIAL_TIMEOUT_MS)

    ws.once('open', () => {
      if (connection.dialTimer) clearTimeout(connection.dialTimer)
      openedAt = Date.now()
      const nonce = generateNonce()
      try {
        ws.send(encodeRegisterFrame(this.opts.deviceId, this.opts.deviceName, this.opts.engines(), nonce))
      } catch {
        ws.close(4000, 'failed to encode registration frame')
        return
      }
      connection.registrationTimer = setTimeout(
        () => ws.close(4001, 'registration timeout'),
        this.opts.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS,
      )
    })

    ws.on('message', (data: RawData, isBinary: boolean) => {
      void this.onMessage(ws, isBinary ? (data as Buffer) : data.toString('utf8'), connection)
    })

    ws.on('close', () => {
      if (connection.dialTimer) clearTimeout(connection.dialTimer)
      if (connection.registrationTimer) clearTimeout(connection.registrationTimer)
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      if (!this.closed) this.scheduleReconnect(openedAt > 0 ? Date.now() - openedAt : 0)
    })

    ws.on('error', () => {
      /* 'close' always follows; reconnect is scheduled there */
    })
  }

  private async onMessage(
    ws: WebSocket,
    raw: string | Buffer,
    connection: { registered: boolean; registrationTimer?: ReturnType<typeof setTimeout> },
  ): Promise<void> {
    let frame
    try {
      frame = parseFrame(raw)
    } catch (e) {
      if (e instanceof FrameTooLargeError || e instanceof FrameInvalidError) {
        ws.close(4002, 'malformed or oversize frame')
        return
      }
      throw e
    }
    if (frame.type === 'ping') {
      try {
        ws.send(encodePongFrame())
      } catch {
        /* ignore */
      }
      return
    }
    if (frame.type === 'pong') {
      this.missedPong = false
      return
    }
    if (frame.type === 'register_ack') {
      if (!frame.ok) {
        ws.close(4007, 'registration rejected')
        return
      }
      if (!connection.registered) {
        connection.registered = true
        if (connection.registrationTimer) clearTimeout(connection.registrationTimer)
        this.startHeartbeat(ws)
        this.opts.onRegistered?.()
      }
      return
    }
    if (frame.type !== 'request') {
      ws.close(4006, `unexpected frame type from hub: ${frame.type}`)
      return
    }
    if (!connection.registered) {
      ws.close(4008, 'request received before registration acknowledgement')
      return
    }

    const result = await handleDeviceRequest(this.scheduler, frame.op, frame.payload as Record<string, unknown>)
    try {
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(4009, 'socket backpressured')
        return
      }
      ws.send(encodeResponseFrame(frame.id, true, result.status, result.body))
    } catch {
      try {
        ws.send(encodeResponseFrame(frame.id, false, undefined, undefined, 'response encoding failed'))
      } catch {
        /* socket is unusable; the hub's own RPC timeout will surface this */
      }
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.missedPong = false
    this.heartbeatTimer = setInterval(() => {
      if (this.missedPong) {
        ws.terminate()
        return
      }
      this.missedPong = true
      try {
        ws.send(encodePingFrame())
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private scheduleReconnect(uptimeMs: number): void {
    const jitterSource = this.opts.randomJitter ?? Math.random
    const plan = planReconnect(this.attempt, uptimeMs, jitterSource())
    this.attempt = plan.attempt
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.connect()
    }, plan.delayMs)
  }
}
