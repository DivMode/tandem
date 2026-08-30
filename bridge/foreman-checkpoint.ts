/**
 * foreman-checkpoint.ts — the opaque token a foreman carries between turns.
 *
 * WHY A MAP AND NOT A NUMBER. Foreman events are stored per device: each host
 * keeps its own inbox, with its own store epoch and its own sequence numbers.
 * A single scalar cursor therefore cannot mean anything across devices — seq 7
 * on the hub and seq 7 on `studio` are unrelated facts. The token is a MAP from
 * the hub's routing device id to that device's own store cursor.
 *
 * WHY THE MAP SHIPS NOW, WITH ONLY ONE ENTRY EVER WRITTEN PER CALL. This PR
 * routes `get_foreman_events` to one device at a time; it does not aggregate.
 * But the token is the part clients persist across turns, so getting its shape
 * wrong is the expensive mistake: adding aggregation later would force a
 * breaking format migration and silently strand every stored checkpoint. So a
 * single-device read advances ONLY its own entry and preserves every other
 * entry verbatim, and a future aggregating reader can consume the same token
 * unchanged.
 *
 * LEGACY. `fe1_` tokens (a bare single-store cursor, the only format the first
 * release of this feature issued) are accepted and interpreted as the LOCAL
 * device's entry, which is exactly what they were. They are never re-issued.
 *
 * DEVICE KEYS ARE THE HUB'S, NOT THE DEVICE'S. The key is always the id the hub
 * routed to. A device's self-reported TANDEM_DEVICE_ID never reaches this map —
 * see dispatchForemanEvents, which rewrites identity on the way back.
 *
 * The token is opaque to clients by contract: they store it and hand it back.
 * It carries no secret, no path and no host identity — only device ids the
 * client already sees in list_devices, plus per-store counters.
 */

/** Thrown for a token this server cannot interpret. Callers turn it into a
 *  400 rather than silently guessing a position in the history. */
export class InvalidCheckpointError extends Error {}

/** The device key used for the local hub, and for a legacy fe1 token. */
export const LOCAL_DEVICE_KEY = 'local'

const MAP_PREFIX = 'fe2_'
const LEGACY_PREFIX = 'fe1_'
/** Bounded so a hostile or corrupted token cannot become a memory cost. */
export const MAX_CHECKPOINT_CHARS = 4096
const MAX_DEVICE_ENTRIES = 64

/**
 * Per-device cursors, keyed by the hub's routing device id. The value is the
 * single-store token that device's own inbox issued (an `fe1_` string) — kept
 * opaque here on purpose: only the device that minted it can interpret its
 * store epoch, and this module never needs to.
 */
export type ForemanCheckpointMap = Map<string, string>

function decodeBase64Url(payload: string): string {
  try {
    return Buffer.from(payload, 'base64url').toString('utf8')
  } catch {
    throw new InvalidCheckpointError('checkpoint is not decodable')
  }
}

/**
 * Read a client-supplied token. An absent token means "no position yet" (an
 * empty map), which every reader treats as a first read.
 */
export function decodeForemanCheckpoint(token: string | undefined): ForemanCheckpointMap {
  if (token === undefined || token === '') return new Map()
  if (token.length > MAX_CHECKPOINT_CHARS) throw new InvalidCheckpointError('checkpoint is too long')

  // Legacy: a bare single-store cursor was always the local device's.
  if (token.startsWith(LEGACY_PREFIX)) return new Map([[LOCAL_DEVICE_KEY, token]])

  if (!token.startsWith(MAP_PREFIX)) throw new InvalidCheckpointError('checkpoint is not a Tandem foreman checkpoint')

  let parsed: unknown
  try {
    parsed = JSON.parse(decodeBase64Url(token.slice(MAP_PREFIX.length)))
  } catch (e) {
    if (e instanceof InvalidCheckpointError) throw e
    throw new InvalidCheckpointError('checkpoint is malformed')
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidCheckpointError('checkpoint is malformed')
  const record = parsed as { v?: unknown; d?: unknown }
  if (record.v !== 2) throw new InvalidCheckpointError('unsupported checkpoint version')
  if (!record.d || typeof record.d !== 'object') throw new InvalidCheckpointError('checkpoint is malformed')

  const entries = Object.entries(record.d as Record<string, unknown>)
  if (entries.length > MAX_DEVICE_ENTRIES) throw new InvalidCheckpointError('checkpoint has too many devices')
  const map: ForemanCheckpointMap = new Map()
  for (const [device, cursor] of entries) {
    // An entry we cannot use is dropped rather than fatal: the token stays
    // usable for every other device, and the affected one simply re-reads.
    if (typeof device !== 'string' || device.length === 0 || device.length > 64) continue
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) continue
    map.set(device, cursor)
  }
  return map
}

/** Re-issue the token. Always `fe2_`; legacy tokens are accepted, never minted. */
export function encodeForemanCheckpoint(map: ForemanCheckpointMap): string {
  const d: Record<string, string> = {}
  // Stable key order keeps the token byte-identical for an unchanged position,
  // so a client can cheaply tell that nothing moved.
  for (const device of [...map.keys()].sort()) d[device] = map.get(device)!
  return MAP_PREFIX + Buffer.from(JSON.stringify({ v: 2, d }), 'utf8').toString('base64url')
}

/**
 * Advance exactly one device's entry, preserving every other entry verbatim.
 * This is the whole forward-compatibility contract: a single-device read must
 * never discard a position the client holds for a device it did not ask about.
 */
export function withDeviceCursor(
  map: ForemanCheckpointMap,
  device: string,
  cursor: string,
): ForemanCheckpointMap {
  const next = new Map(map)
  next.set(device, cursor)
  return next
}
