# Trusted completion: wiring Claude's own Stop hook

Every completion signal Tandem had before this path was **inferred from outside
the worker**. The backend watches a terminal pane, decides from idle detection
and screen content that a turn probably ended, and the turn ledger makes that
inference reportable exactly once — without making it true. When the inference
is wrong the pane keeps reporting `working` after the worker has finished, and
the turn stays stranded until a foreman gives up on it.

Claude's `Stop` / `StopFailure` lifecycle hooks are a different kind of signal.
Claude runs each in its own process, at its own turn boundary, and hands it
structured JSON stating that the turn ended and whether it ended cleanly.
`UserPromptSubmit` is a third hook, registered alongside them: it fires the
moment a prompt lands, before the turn that answers it. Tandem records that a
submit happened — never what was submitted — and requires one after a turn's
baseline before trusting the `Stop`/`StopFailure` that follows it. That closes
a race a `Stop`-only signal could not: a stray `Stop` from a turn that was just
interrupted or superseded can still land, with a `seq` after the new turn's
baseline, before the new turn has even reached Claude — and without a submit to
order against, it would be mistaken for the new turn's own boundary. This
document is how an operator turns all of this on.

**It is entirely optional.** Unconfigured is the default and changes nothing:
no flag, no environment, a spawn byte-identical to the one before this existed,
and completion stays inferred from the terminal.

## The two things that must be true

1. **Claude must be told to run the hook**, which means a settings file.
2. **The hook process must know which Tandem session it belongs to**, which it
   cannot work out for itself — a cwd is shared by every worker in a repository
   and a pid tree says nothing about Tandem's naming.

Tandem solves both with one environment variable, `TANDEM_CLAUDE_SETTINGS_PATH`.
When it is set, a Tandem-spawned Claude gets `--settings <path>` and a stamped
`TANDEM_SESSION_ID`. The hook copies that id into the record it writes, and the
bridge matches records back to sessions by it.

### Tandem never touches your personal settings file

`~/.claude/settings.json` is yours. It is shared by every Claude you start by
hand, and a bridge that edited it would be changing the behaviour of sessions it
does not own. Tandem never reads, writes, or modifies it. The file you point
`TANDEM_CLAUDE_SETTINGS_PATH` at is a **separate, Tandem-owned** file, and
`--settings` layers it on top of your personal settings for that process only.

Registering the hook in your personal settings instead would fire it for every
Claude you start by hand — all of which lack `TANDEM_SESSION_ID`, so each one
records nothing and exits `not_tandem`. It is harmless, but it is not the wiring
this path is built for.

## Register the packaged command, never a source path

The hook command is `tandem-claude-stop-hook`, a `bin` entry of this package.

Do **not** write `node --experimental-strip-types .../src/claude-stop-hook.ts`
into a settings file. That string hard-codes an interpreter flag whose necessity
depends on the Node version, and a path into the package's private layout. Under
Nix that path lives inside an immutable store output whose hash changes on every
rebuild, so a settings file naming it breaks on the next update. The `bin` entry
is the stable name; the layout behind it is free to move.

`bin/tandem-claude-stop-hook.mjs` imports the real entrypoint when the running
Node can load a `.ts` file directly (Node ≥ 22.18), and otherwise re-executes it
in a child Node with `--experimental-strip-types`. Either way it keeps the
entrypoint's three promises: it always exits 0, it always exits, and it never
writes to stdout.

## The settings file

Exactly this, with all three events registered — the same command handles all
of them; it dispatches on `hook_event_name` internally:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "tandem-claude-stop-hook" }] }
    ],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "tandem-claude-stop-hook" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "tandem-claude-stop-hook" }] }
    ]
  }
}
```

`UserPromptSubmit` is not optional if you want trusted completion to actually
work: without it, a session's `Stop`/`StopFailure` records have no submit to
order against, `claudeTurnEndAfter` never resolves, and every turn silently
falls back to the terminal-pane heuristic — exactly as if no hook were
configured at all, with no error to say so.

If `tandem-claude-stop-hook` is not on the `PATH` the workers inherit, use its
absolute path instead — under Nix, `${pkgs.tandem}/bin/tandem-claude-stop-hook`,
which is stable across rebuilds in a way a `src/` path is not.

## Then point Tandem at it

```bash
TANDEM_CLAUDE_SETTINGS_PATH=/absolute/path/to/tandem-claude-settings.json
```

## Validation is fail-closed, and loud

A configured path that cannot be trusted **throws at spawn**. It is not quietly
dropped, because silently ignoring it would leave you believing completion is
reported by Claude while it is in fact still being guessed. The path must be:

| Requirement | Why |
|---|---|
| Absolute | A relative path resolves against whatever cwd the worker happened to get. |
| An existing **regular file** | Never a symlink, whose target can be repointed underneath us. |
| Owned by the Tandem OS user | Same-OS-user is the trust boundary everything else here uses. |
| Not group- or world-writable | **The load-bearing one.** This file names commands Claude will execute, so a path another account can rewrite is a command in every Tandem worker. |
| At most 256 KiB | A settings file is small JSON; refuse to read anything that is not. |
| Valid JSON, a JSON **object** | An array or a scalar is not a settings file. |

Unset, or set to empty, is the unconfigured case: no flag, no environment stamp,
no behaviour change at all.

## Nix wiring

Home Manager, writing the settings file declaratively and exporting the variable
that names it.

**The one trap: `home.file` materialises as a symlink into the Nix store**, and
the validator refuses a symlink — rightly, since a symlink target can be
repointed under a running bridge, and a store path is not owned by the user
either. So the settings file is *rendered* into the store and then *installed*
as a real, owner-only copy by an activation script.

```nix
{ config, pkgs, lib, ... }:

let
  # The command string that survives being written down. A path into the
  # package's private layout would not: under Nix it sits in an immutable store
  # output whose hash changes on every rebuild.
  stopHook = "${pkgs.tandem}/bin/tandem-claude-stop-hook";

  settingsJson = pkgs.writeText "tandem-claude-settings.json" (builtins.toJSON {
    hooks = {
      Stop = [ { hooks = [ { type = "command"; command = stopHook; } ]; } ];
      StopFailure = [ { hooks = [ { type = "command"; command = stopHook; } ]; } ];
      UserPromptSubmit = [ { hooks = [ { type = "command"; command = stopHook; } ]; } ];
    };
  });

  # NOT ~/.claude/settings.json. That file is the user's, shared by every Claude
  # they start by hand, and Tandem must never read or write it.
  settingsPath = "${config.home.homeDirectory}/.tandem/claude-settings.json";
in
{
  # `install -m 0600` gives a regular file, owned by this user, with no group or
  # other write bit — which is exactly what the validator requires. Copying on
  # every activation is what keeps it in step with the rendered value above.
  home.activation.tandemClaudeSettings =
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      $DRY_RUN_CMD mkdir -p "$(dirname ${lib.escapeShellArg settingsPath})"
      $DRY_RUN_CMD install -m 0600 ${settingsJson} ${lib.escapeShellArg settingsPath}
    '';

  home.sessionVariables.TANDEM_CLAUDE_SETTINGS_PATH = settingsPath;
}
```

If the Tandem service is launched by launchd or systemd rather than an
interactive shell, `home.sessionVariables` will not reach it. Set the variable in
the service definition itself — `launchd.agents.<name>.config.EnvironmentVariables`
or `systemd.user.services.<name>.Environment` — or in the protected JSON that
`./setup.sh` writes under `~/.tandem`.

Confirm the result is what the validator wants before restarting the bridge:

```bash
stat -f '%Sp %u %N' ~/.tandem/claude-settings.json   # -c '%A %u %n' on Linux
# -rw-------  501 /Users/you/.tandem/claude-settings.json
```

A leading `l` in that mode string means it is still a symlink and Tandem will
refuse it at spawn.

## Verifying it

The hook is silent by design: it writes nothing to stdout and always exits 0, so
a successful run looks exactly like a no-op. Two ways to see it work.

**One outcome word on stderr**, with `TANDEM_CLAUDE_HOOK_DEBUG=1`:

```bash
echo '{"hook_event_name":"Stop","session_id":"abc123","last_assistant_message":"done"}' \
  | TANDEM_CLAUDE_HOOK_DEBUG=1 \
    TANDEM_STATE_DIR=/tmp/tandem-smoke \
    TANDEM_SESSION_ID=ts_0123456789abcdef0123456789abcdef \
    tandem-claude-stop-hook
# [tandem-claude-hook] recorded
```

The outcomes, and what each means:

| Outcome | Meaning |
|---|---|
| `recorded` | The transition is in the store. |
| `not_tandem` | No `TANDEM_SESSION_ID` — a Claude started by hand, which Tandem has no business recording and no way to attribute. |
| `ignored` | Not a payload this hook handles: another event name, empty, oversized, or unparseable. |
| `invalid` | A `Stop`/`StopFailure`/`UserPromptSubmit` whose required fields are missing or unusable. |
| `unwritable` | The store refused the write. |

**The store itself**, at `$TANDEM_STATE_DIR/claude-lifecycle/` (default
`~/.tandem/claude-lifecycle/`), a 0700 directory holding a 0600 file. A store
that is not demonstrably ours — wrong owner, group-readable, oversized, corrupt,
wrong version — degrades to empty rather than to an error.

## What is stored, and what is pointedly not

Read from the payload: `hook_event_name` (which boundary), `session_id`
(Claude's own opaque id), and — on `Stop` only — `last_assistant_message`, which
is clamped and passed through the same event sanitiser as every other summary
before it reaches disk. `StopFailure` carries no message and none is guessed at
from another field.

`UserPromptSubmit` carries a `prompt` field. It is never read. The record it
produces exists to prove a submit happened, not to carry what was submitted —
the store enforces this independently of the hook, so a `prompt_submit` record
can never carry a message even if a future edit to the hook tried to pass one.

Never read and never stored: `cwd` and `transcript_path`.

The Tandem session id is derived, not minted: a hash of the installation's
private state root and the session name. It is stable across bridge restarts,
distinct per installation, and opaque — it carries no project, path, or client
text. It is a correlation key, not a secret; anything that could forge a record
by guessing it already runs as the same OS user and could write the 0700 store
directly.

## What it fixes, and what it does not

With the hooks configured, a Claude worker's own `Stop` — preceded by its own
`UserPromptSubmit` — ends the turn Tandem was waiting on, so a finished worker
no longer sits in `working` until someone gives up on it.

It does not make Tandem able to wake a dormant chat client — nothing can; see
[foreman-events.md](foreman-events.md). And `working` still never justifies
resending a prompt: delivery on this transport is ambiguous in the other
direction too, so reconcile before you resend.
