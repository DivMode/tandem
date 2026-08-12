/**
 * fleet-private-server.ts — the PRIVATE, tailnet-only fleet WebSocket
 * listener (spec: loopback 8788, published tailnet-only by Tailscale Serve;
 * NEVER Funnel-published, NEVER part of the public HTTP router). Started
 * explicitly by the production entrypoint (src/server.ts) in the SAME
 * process as the public MCP server, sharing the SAME FleetRuntime — never
 * built as a module-import side effect (binding — Phase 3 correction 7).
 *
 * BIND HOST: hard-refuses any non-loopback host before opening a socket
 * (binding — Phase 3 correction 5).
 *
 * AUTH: every WebSocket upgrade must present an exact `Authorization: Bearer
 * <fleetToken>` header — never a URL/query/path token — checked BEFORE the
 * upgrade completes and BEFORE any frame is read. A failed check is a plain
 * 401 with no detail and nothing logged (binding — Phase 3 correction 5).
 *
 * DUPLICATE REPLACEMENT: generation-safe (binding — Phase 3 correction 6). A
 * newer registration for an already-online device id immediately (a) rejects
 * every pending broker request for that device id, THEN (b) closes the OLD
 * socket. The old socket's own 'close' handler is generation-guarded, so it
 * can never unregister (or otherwise affect) the connection that replaced it.
 */
import { createServer, type IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  encodePingFrame,
  encodePongFrame,
  encodeRegisterAckFrame,
  FrameInvalidError,
  FrameTooLargeError,
  HEARTBEAT_INTERVAL_MS,
  MAX_FRAME_BYTES,
  REGISTRATION_TIMEOUT_MS,
  parseFrame,
} from './fleet-protocol.ts'
import type { FleetSocket } from './fleet-registry.ts'
import type { FleetRuntime } from './fleet-runtime.ts'
import type { FleetEnrollmentStore } from './fleet-enrollment.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** Hard-refuses a bind host that is not loopback (binding — Phase 3
 *  correction 5). Never bind the private fleet listener to all interfaces. */
export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('private fleet listener host must be loopback (127.0.0.1, ::1, or localhost)')
  }
}

/** Constant-time token compare — never short-circuits on the first mismatch. */
function tokenMatches(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (presentedBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(presentedBytes, expectedBytes)
}

export interface PrivateServerOptions {
  host: string
  port: number
  fleetToken: string
  runtime: FleetRuntime
  /** Test seam — production always uses the protocol default. */
  registrationTimeoutMs?: number
  /** Test seam — production always uses the protocol default. */
  heartbeatIntervalMs?: number
  /** Production injects the metadata-only audit logger explicitly. Tests may
   * omit it so they never touch the user's real private audit file. */
  auditEvent?: (fields: Record<string, unknown>) => void
  /** Optional tailnet-only one-time enrollment exchange. It is deliberately
   * hosted only on this private listener and never mounted on public MCP. */
  enrollment?: { store: FleetEnrollmentStore; fleetToken: string }
}

export interface PrivateServerHandle {
  readonly port: number
  close(): Promise<void>
}

function handleConnection(
  ws: WebSocket,
  runtime: FleetRuntime,
  registrationTimeoutMs: number,
  heartbeatIntervalMs: number,
  auditEvent: (fields: Record<string, unknown>) => void,
): void {
  let registered: { deviceId: string; generation: number } | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let missedPong = false

  const registrationTimer = setTimeout(() => {
    if (!registered) {
      auditEvent({ event: 'fleet.registration', outcome: 'rejected', reason: 'timeout' })
      ws.close(4001, 'registration timeout')
    }
  }, registrationTimeoutMs)

  const socketAdapter: FleetSocket = {
    send: (data: string) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    get bufferedAmount() {
      return ws.bufferedAmount
    },
  }

  function startHeartbeat(): void {
    missedPong = false
    heartbeatTimer = setInterval(() => {
      if (missedPong) {
        auditEvent({ event: 'fleet.connection', deviceId: registered?.deviceId, outcome: 'closed', reason: 'heartbeat_timeout' })
        ws.terminate()
        return
      }
      missedPong = true
      try {
        ws.send(encodePingFrame())
      } catch {
        /* socket already closing; the 'close' handler runs the real cleanup */
      }
    }, heartbeatIntervalMs)
  }

  ws.on('message', (data: RawData, isBinary: boolean) => {
    let frame
    try {
      frame = parseFrame(isBinary ? (data as Buffer) : data.toString('utf8'))
    } catch (e) {
      if (e instanceof FrameTooLargeError || e instanceof FrameInvalidError) {
        auditEvent({
          event: 'fleet.protocol',
          deviceId: registered?.deviceId,
          outcome: 'rejected',
          reason: e instanceof FrameTooLargeError ? 'frame_too_large' : 'invalid_frame',
        })
        ws.close(4002, 'malformed or oversize frame')
        return
      }
      throw e
    }

    if (frame.type === 'register') {
      if (registered) {
        auditEvent({ event: 'fleet.registration', deviceId: registered.deviceId, outcome: 'rejected', reason: 'already_registered' })
        ws.close(4003, 'already registered')
        return
      }
      if (frame.deviceId === 'local') {
        auditEvent({ event: 'fleet.registration', outcome: 'rejected', reason: 'reserved_device_id' })
        try {
          ws.send(encodeRegisterAckFrame(false, 'device id is reserved'))
        } catch {
          /* close below is the authoritative rejection */
        } finally {
          ws.close(4010, 'reserved device id')
        }
        return
      }
      clearTimeout(registrationTimer)
      const { generation, replaced } = runtime.registry.register(frame.deviceId, frame.name, frame.engines, socketAdapter)
      registered = { deviceId: frame.deviceId, generation }
      if (replaced) {
        // Reject every OLD pending request deterministically BEFORE closing
        // the old socket (binding — Phase 3 correction 6).
        runtime.broker.rejectAll(frame.deviceId, 'device connection replaced by a newer registration')
        replaced.socket.close(4004, 'replaced by a newer connection')
      }
      auditEvent({
        event: 'fleet.registration',
        deviceId: frame.deviceId,
        name: frame.name,
        engines: frame.engines,
        outcome: replaced ? 'replaced' : 'accepted',
      })
      try {
        ws.send(encodeRegisterAckFrame(true))
      } catch {
        /* best-effort ack; the device will notice via heartbeat if this socket is bad */
      }
      startHeartbeat()
      return
    }

    if (!registered) {
      auditEvent({ event: 'fleet.registration', outcome: 'rejected', reason: 'register_required' })
      ws.close(4005, 'first frame must be register')
      return
    }

    const current = runtime.registry.get(registered.deviceId)
    if (!current || current.generation !== registered.generation) {
      auditEvent({ event: 'fleet.connection', deviceId: registered.deviceId, outcome: 'closed', reason: 'superseded' })
      ws.close(4004, 'superseded connection')
      return
    }

    switch (frame.type) {
      case 'response':
        if (frame.ok) {
          runtime.broker.handleResponse(registered.deviceId, frame.id, true, frame.status, frame.body)
        } else {
          runtime.broker.handleResponse(registered.deviceId, frame.id, false, undefined, undefined, frame.error)
        }
        return
      case 'pong':
        missedPong = false
        return
      case 'ping':
        try {
          ws.send(encodePongFrame())
        } catch {
          /* ignore — heartbeat will catch a dead socket */
        }
        return
      case 'capabilities':
        runtime.registry.updateEngines(registered.deviceId, registered.generation, frame.engines)
        return
      default:
        // A device never legitimately sends 'request', a second 'register', or
        // 'register_ack' — treat it as a protocol violation, fail closed.
        auditEvent({ event: 'fleet.protocol', deviceId: registered.deviceId, outcome: 'rejected', reason: 'unexpected_direction' })
        ws.close(4006, `unexpected frame type from device: ${frame.type}`)
    }
  })

  ws.on('close', () => {
    clearTimeout(registrationTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (registered) {
      const removed = runtime.registry.unregister(registered.deviceId, registered.generation)
      if (removed) {
        runtime.broker.rejectAll(registered.deviceId, 'device disconnected')
        auditEvent({ event: 'fleet.connection', deviceId: registered.deviceId, outcome: 'closed', reason: 'disconnected' })
      }
    }
  })

  ws.on('error', () => {
    /* 'close' always follows; nothing further to do here */
  })
}

export async function startPrivateFleetServer(opts: PrivateServerOptions): Promise<PrivateServerHandle> {
  assertLoopbackHost(opts.host)
  if (opts.fleetToken.trim().length < 16) {
    throw new Error('private fleet token must contain at least 16 characters')
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65_535) {
    throw new Error('private fleet port must be an integer from 0 to 65535')
  }

  const httpServer = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200)
      res.end('{"ok":true,"localDevice":true}\n')
      return
    }
    if (!opts.enrollment || req.method !== 'POST' || req.url !== '/enroll') {
      res.writeHead(404)
      res.end('{"error":"not_found"}\n')
      return
    }
    if (req.headers['content-encoding'] || req.headers['transfer-encoding'] || (req.headers['content-length'] ?? '0') !== '0') {
      req.resume()
      res.writeHead(400)
      res.end('{"error":"invalid_request"}\n')
      return
    }
    const auth = req.headers['authorization']
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : ''
    void opts.enrollment.store.consume(presented).then((accepted) => {
      if (!accepted) {
        res.writeHead(401)
        res.end('{"error":"invalid_enrollment"}\n')
        return
      }
      const body = JSON.stringify({ fleetToken: opts.enrollment!.fleetToken })
      res.setHeader('Content-Length', String(Buffer.byteLength(body)))
      res.writeHead(200)
      res.end(body)
    }).catch(() => {
      res.writeHead(503)
      res.end('{"error":"enrollment_unavailable"}\n')
    })
  })
  httpServer.maxHeadersCount = 32
  httpServer.requestTimeout = 10_000
  httpServer.headersTimeout = 5_000
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url !== '/') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const auth = req.headers['authorization']
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!tokenMatches(presented, opts.fleetToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  const registrationTimeoutMs = opts.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const auditEvent = opts.auditEvent ?? (() => {})
  wss.on('connection', (ws: WebSocket) =>
    handleConnection(ws, opts.runtime, registrationTimeoutMs, heartbeatIntervalMs, auditEvent),
  )

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(opts.port, opts.host, () => resolve())
  })
  const address = httpServer.address()
  const port = typeof address === 'object' && address !== null ? address.port : opts.port

  return {
    port,
    async close() {
      auditEvent({ event: 'fleet.listener', outcome: 'closed', reason: 'shutdown', connectedDevices: wss.clients.size })
      opts.runtime.broker.rejectEverything('fleet listener shutting down')
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
