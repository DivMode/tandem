# Foreman events, and why nothing here can wake a chat client

Tandem workers outlive the conversation that started them. A turn finishes,
a worker gets blocked, someone interrupts a runaway — and the foreman that
should react is often not connected at that moment.

The obvious fix would be for Tandem to *push*: wake the conversation and tell
it. That is not possible today, in any client, and this document records
exactly why, so the limitation is not rediscovered or quietly papered over.

What Tandem does instead is make completion **durable and reconcilable**: every
real lifecycle transition is recorded locally, and a returning foreman reads
what it missed on its next turn.

## What can and cannot wake ChatGPT Web

**Nothing Tandem does can wake a dormant ChatGPT Web conversation.** Not the
MCP connection, not a webhook, not a notification. This is a client capability
that does not exist, not a Tandem configuration gap. Tandem must not claim
otherwise, and this branch adds no browser automation.

| Mechanism | Reaches | Wakes a dormant chat? |
|---|---|---|
| `get_foreman_events` (this branch) | The foreman, on its **next** turn | No — the foreman must ask |
| `~/.tandem/events.log` | Anything on the host that tails it | No |
| `TANDEM_DONE_WEBHOOK` | An HTTP endpoint you run | No |
| `TANDEM_NTFY_TOPIC` | Your **phone** | No — it wakes a person, not a chat |

The phone push is the only thing that genuinely wakes anything, and what it
wakes is a human, who can then go and prompt the foreman. That is the honest
top of the escalation chain.

## The protocol evidence

Measured against the installed SDK, not from memory:

- `@modelcontextprotocol/sdk` **1.30.0**.
- `LATEST_PROTOCOL_VERSION` is **`2025-11-25`**; supported versions are
  `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`.
- Every method the SDK defines that is **relevant to server-initiated wake-up,
  subscription, or task semantics** — this is the complete set for that
  question, not a complete inventory of the protocol, which also carries
  logging, sampling, completion and `list_changed` methods that have no bearing
  on it:
  - tasks: `tasks/get`, `tasks/list`, `tasks/result`, `tasks/cancel`,
    `notifications/tasks/status`
  - subscription: `resources/subscribe`, `resources/unsubscribe`,
    `notifications/resources/updated`
  - other server-initiated notifications: `notifications/cancelled`,
    `notifications/message`, `notifications/progress`,
    `notifications/initialized`, `notifications/elicitation/complete`
  - client-initiated requests that could carry a long operation:
    `tools/call`, `elicitation/create`

Three things follow.

**There is no `listen` and no general subscription.** The only subscribe verb is
`resources/subscribe`, which is resource-scoped, must be initiated by the
client, and still only delivers `notifications/resources/updated` over a
connection that is already open. There is no 2026-07-28-style subscriptions or
listen primitive in this SDK at all.

**Tasks exist, but are experimental and cannot survive the request that made
them.** The SDK ships `tasks/*` under `dist/esm/experimental/`, whose own header
reads *"WARNING: These APIs are experimental and may change without notice."*
More decisively, Tandem's HTTP transport is **stateless**: both
`src/public-server.ts` and `src/http-mcp.ts` construct
`new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` and a
**fresh `McpServer` per request**, tearing both down when the response closes.
A task created during one request has no transport, no server, and no session to
be polled or notified through afterwards. Making Tasks meaningful here would
require converting the transport to stateful sessions with a shared task store —
which is not an additive change, and would still not wake a dormant client,
because `tasks/get` is a client **pull** and `notifications/tasks/status` needs a
live stream.

**So implementing Tasks now would add risk and no capability.** This branch
therefore does not implement them, and equally does not invent a substitute:
no custom notification method, no proprietary SSE channel, no long-poll "wake"
tool. A fake protocol would be worse than the honest gap, because a client would
have no way to tell it from a real one.

## The adapter seam

The event store is deliberately shaped so a future adapter can consume it
without redesign. `bridge/foreman-inbox.ts` exposes:

- `record(input)` — the write side, already fed by every emit path.
- `read({ since, limit })` — a forward-only, checkpointed read returning
  `{ version, events, checkpoint, more, truncated, counts }`, and on the routed
  path an additional `device`.

Each event has a stable content-derived `id`, a monotonic `seq`, and an explicit
`kind`. That is exactly the shape a task store, a resource-subscription bridge,
or a notification pump needs:

- **If Tasks become stable and the transport becomes stateful**, a task's status
  can be projected from the events for its session — `completed`/`error` are
  terminal, `blocked`/`needs_input` map to `input_required` — without changing
  what is recorded.
- **If a client ever supports `resources/subscribe`** against a Tandem resource,
  the store's `seq` is the change token to fire `notifications/resources/updated`
  on.
- **If a client ever gains a genuine wake capability**, the same records drive it.

Until one of those exists, reconciliation on the next foreman turn is the
mechanism — not a fallback.

## Why a client-carried checkpoint, and not an `ack` tool

The original design called for `ack_foreman_events`, acknowledging events by id
or through a watermark. It is not implemented, deliberately.

A server-side acknowledgement has to be attributed to *someone*. Tandem's HTTP
transport is stateless and carries **no client identity** across requests: there
is no MCP session id, and a fresh server instance handles every call. So a
server-side "acked" flag could only ever be **one global watermark for the whole
machine** — shared by every ChatGPT conversation, every local MCP client, every
script. The failure mode is silent and bad: whichever reader acknowledged last
hides those events from every other reader, and a foreman that never saw an
event is told there is nothing to see.

A checkpoint carried by the reader is per-client by construction. It also:

- makes the read path **strictly read-only** — `get_foreman_events` writes
  nothing at all, which is what lets it carry `readOnlyHint: true` honestly;
- cannot be corrupted by a concurrent reader;
- needs no writable state, so it still works if the store is read-only;
- is idempotent — reading the same checkpoint twice returns the same events.

The costs are real but small: the foreman must carry an opaque string between
turns, and a foreman that loses it starts again from the oldest retained event.
Re-reading is a far cheaper failure than silently missing a completion.

### What `more` and `truncated` each mean

Reads always move FORWARD, oldest first, from the caller's position — the
supplied checkpoint, or the start of retained history when there is none. That
uniformity is what lets the two flags mean exactly one thing each:

- **`more: true`** is pagination and nothing else: retained events the caller
  has not seen remain after this page. Call again with the returned checkpoint.
  The checkpoint advances only as far as the page actually reached, so a page
  cut short by `limit` never skips the remainder.
- **`truncated: true`** is loss: events the caller never saw are gone, because
  retention rotated them away, or because the checkpoint was issued by a store
  that no longer exists. Reconcile against `list_sessions` rather than trusting
  the feed to be complete.

A page cut short by `limit` is `more`, never `truncated`.

## History is not liveness

`get_foreman_events` says **what happened**. `list_sessions` says **what is
running now**. They answer different questions and the feed must never be used
for the second one:

- a `completed` event does not mean the worker exited — sessions stay open
  between turns on purpose;
- the absence of an event does not mean nothing happened — retention is bounded,
  and a turn Tandem did not drive is deliberately not reported;
- events are recorded **per host**. A session driven on a fleet device is
  recorded on that device — its own inbox is the truth for its own work. The
  hub reads a device by passing `device`, one device per call. Every event
  carries `device` and the composite `device:localName` so a foreman never has
  to guess which machine a bare name referred to.

### The `recent_events` preview on `list_sessions`

`get_foreman_events` answers this better in every respect. It exists anyway
because of one gap the protocol leaves open:

**An MCP client caches a server's tool list for the life of a conversation.** A
chat that was already open when this server gained `get_foreman_events` can
never call it — nothing in the protocol makes a connected client re-read a
schema, and, per everything above, no server can wake one to ask. That
conversation *does* still call `list_sessions`, because it was in the schema it
cached. So a field on that response is the only route a completion has back to
it.

`list_sessions` therefore returns `{ sessions, recent_events }`. `sessions` is
byte-identical to what it always was; a client that ignores unknown fields sees
no change at all. `recent_events` is:

```
{ version, events, checkpoint, older, counts: { shown, retained }, note }
```

with the same event shape the feed returns, **newest first**, capped at five.

It is a preview, not the feed, and the difference is load-bearing:

- **It carries no checkpoint of yours and cannot be paged.** There is no `since`
  and no `limit`, so it can never tell a caller it has seen everything once.
- **Its `checkpoint` is the store position AT the newest event shown.** Handing
  it to `get_foreman_events` as `since` therefore deliberately *skips*
  everything at or before it. Only do that once those events have been acted on.
- **The same history-is-not-liveness rule applies**, doubly so: `sessions` in
  the very same response is the liveness truth, and a `completed` in the preview
  is not proof the worker exited.
- **It is fail-soft.** A preview that cannot be produced is omitted, never
  raised. Listing live sessions is the load-bearing half of that route and must
  not start failing because a summary could not be read — an unreadable or
  corrupt inbox yields an empty preview and an unchanged listing.

Two boundaries are re-applied at this layer rather than trusted from the write
path, because the preview rides on the one tool every stale conversation still
calls: the redaction runs again on `summary` and `reason`, and the text is
clamped harder (160 characters, against the feed's 200). Both were already
applied when the event was recorded — but that ran in a possibly older version
of the process, against a file on disk that a later version, a restore, or a
hand edit could have changed since.

The preview is put on the **hub's** routing identity for exactly the reason the
feed is: a device reports under whatever `TANDEM_DEVICE_ID` it was configured
with, which the hub has no way to verify. This holds on the local path too — a
bare local `list_sessions` keeps bare session ids in `sessions`, while the
preview names `local:<name>`, matching the feed rather than contradicting it.

Use `get_foreman_events` with your own checkpoint for anything that must be seen
exactly once. The preview is a nudge to go and reconcile.

### Reading a fleet

`get_foreman_events` takes an optional `device`. Omitted (or `"local"`) it reads
this hub, exactly as before. Given a device id it executes the read **on that
device**, through the same fixed fleet operation table every other routed call
uses, and returns that device's events.

There is deliberately **no aggregate mode**. A foreman that wants the whole
fleet calls `list_devices` and then this tool once per device. That avoids a
cross-device merge with partial-failure semantics, and avoids inventing a
chronological order across clocks that were never synchronised. An offline
device fails explicitly, naming that device and nothing else about it, so one
unreachable machine can never be mistaken for "nothing happened".

Two properties make this safe:

- **The hub's routing id wins.** A device reports events under whatever
  `TANDEM_DEVICE_ID` it was configured with. The hub does not trust that: every
  returned event's `device` and `session` are rewritten to the id the hub
  actually routed to, so the composite name a foreman reads back is always the
  name that will route to that worker.
- **Reading a device cannot fan out.** The router's `/foreman/events` handler is
  a pure local inbox read that knows nothing about a fleet runtime. A device
  executing an incoming `foreman_events` request therefore cannot route back out
  into the fleet, so there is no path by which this recurses.

### Checkpoints across devices

Because each device has its own store, its own epoch and its own sequence
numbers, a single scalar cursor cannot mean anything fleet-wide. The token is a
**versioned map** from the hub's routing device id to that device's own cursor:

```
fe2_<base64url({"v":2,"d":{"local":"fe1_…","studio":"fe1_…"}})>
```

Reading one device advances only that device's entry and preserves every other
entry **verbatim**. The older `fe1_` single-store token is still accepted and
read as the local device's entry; it is never re-issued.

The map ships now even though nothing aggregates yet, because the token is the
part clients persist across turns. Getting its shape right later would mean a
breaking migration that silently stranded every stored checkpoint. A future
aggregating reader can consume this exact token unchanged.

The token stays opaque by contract, and there is still no server-side
acknowledgement: `ts` remains informational, and no global watermark exists for
one reader to move on another's behalf.

The rule for a foreman is: call both, before opening anything.

## Retention and privacy

- At most **400** events, at most **14 days**, with a byte cap as a backstop.
  Bounds are enforced on write, before any reader can see the store, so it
  cannot grow without limit on a long-lived host.
- The store is one owner-only file (0600) in a 0700 private directory, replaced
  atomically via rename, and rejected rather than trusted when its owner,
  permissions, size, or contents are wrong.
- There is **no** `cwd`, `project`, `attachHint`, `handoff`, git-fact,
  environment, tool-argument or transcript field. Those are never returned,
  under any setting.
- `summary` and `reason` are the only free text. They are clamped to 200
  characters and redacted. Precisely what that does and does not remove:

  | Redacted | Kept |
  |---|---|
  | Absolute POSIX paths (`/etc/hosts`, `/Users/x/a.ts`) | Relative repo paths (`src/router.ts`) |
  | Home-relative paths (`~/.ssh/id_rsa`, `~/notes.md`) | Ordinary prose, counts, ratios (`2/3`) |
  | Windows (`C:\...`) and UNC (`\\host\share`) paths | Session, engine and device names |
  | URLs of any scheme | Test names and error text |
  | Email addresses | |
  | Tailnet hosts (`*.ts.net`) and `100.64.0.0/10` addresses | |
  | API keys, GitHub/Slack tokens, AWS key ids, JWTs, private-key blocks | |
  | `password=` / `token=` / `api_key=` style assignments | |
  | Long hex digests and base64 blobs | |
  | ANSI escapes and control bytes | |

  Relative paths are kept deliberately: they name a file inside the repository
  the worker was already told to work in, carry no host or account identity,
  and are most of what makes a summary worth reading. Redaction is a bounded
  best effort on free text, not a proof — a determined engine could still print
  something sensitive in a novel shape. `TANDEM_FOREMAN_EVENT_SUMMARIES=0` drops
  both fields entirely and keeps only the structured transition, which is the
  setting to use if that residual risk is unacceptable.

See [SECURITY.md](../SECURITY.md) for the full data boundary.
