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
- The complete set of request/notification methods the SDK defines is:
  `initialize`, `ping`, `completion/complete`, `elicitation/create`,
  `prompts/get`, `prompts/list`, `resources/list`, `resources/read`,
  `resources/templates/list`, `resources/subscribe`, `resources/unsubscribe`,
  `roots/list`, `tools/call`, `tools/list`, `tasks/get`, `tasks/list`,
  `tasks/result`, `tasks/cancel`, and the `notifications/*` family
  (`cancelled`, `initialized`, `message`, `progress`,
  `elicitation/complete`, `resources/updated`, `tasks/status`).

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
  `{ version, events, checkpoint, more, truncated, counts }`.

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
turns, and a foreman that loses it re-reads the most recent page. Re-reading is
a far cheaper failure than silently missing a completion.

`truncated: true` covers the honest edge: retention dropped history, or the
checkpoint came from a store that has since been reset. The foreman is told to
reconcile against `list_sessions` rather than trust the feed to be complete.

## History is not liveness

`get_foreman_events` says **what happened**. `list_sessions` says **what is
running now**. They answer different questions and the feed must never be used
for the second one:

- a `completed` event does not mean the worker exited — sessions stay open
  between turns on purpose;
- the absence of an event does not mean nothing happened — retention is bounded,
  and a turn Tandem did not drive is deliberately not reported;
- events are recorded **per host**. A session driven on a fleet device is
  recorded on that device, so a hub's feed is not a fleet-wide record. Every
  event carries `device` and the composite `device:localName` so a foreman never
  has to guess which machine a bare name referred to.

The rule for a foreman is: call both, before opening anything.

## Retention and privacy

- At most **400** events, at most **14 days**, with a byte cap as a backstop.
  Bounds are enforced on write, before any reader can see the store, so it
  cannot grow without limit on a long-lived host.
- The store is one owner-only file (0600) in a 0700 private directory, replaced
  atomically via rename, and rejected rather than trusted when its owner,
  permissions, size, or contents are wrong.
- It holds **no** working directory, filesystem path, attach hint, handoff block,
  git facts, environment, tool arguments, or transcript. `summary` and `reason`
  are the only free text: redacted for credential- and path-shaped runs and
  clamped to 200 characters. Set `TANDEM_FOREMAN_EVENT_SUMMARIES=0` to drop them
  entirely and keep only the structured transition.

See [SECURITY.md](../SECURITY.md) for the full data boundary.
