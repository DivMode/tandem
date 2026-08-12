import { describe, it, expect, afterEach } from "vitest";
import { startRelay, RelayConfigError } from "../bridge/relay.ts";

// The relay is NO-HUMAN-IN-THE-LOOP: if Claude ever raises an in-session
// permission prompt, nobody is there to click through it and the loop hangs
// forever. startRelay() must refuse to start — synchronously, before spawning
// any tmux session — unless bypass is explicitly enabled. This is deliberately
// testable WITHOUT tmux/claude: the guard runs before any TerminalSession.spawn.
describe("startRelay — fail-fast bypass guard", () => {
  const prev = process.env.TANDEM_ALLOW_BYPASS;
  afterEach(() => {
    if (prev === undefined) delete process.env.TANDEM_ALLOW_BYPASS;
    else process.env.TANDEM_ALLOW_BYPASS = prev;
  });

  it("rejects with a RelayConfigError when bypass is not enabled (unset)", async () => {
    delete process.env.TANDEM_ALLOW_BYPASS;
    await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(
      RelayConfigError,
    );
  });

  it("the error message is a clear, actionable configuration error", async () => {
    delete process.env.TANDEM_ALLOW_BYPASS;
    await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(
      /TANDEM_ALLOW_BYPASS=1/,
    );
  });

  it("rejects when the legacy TANDEM_SKIP_PERMISSIONS variable is set instead", async () => {
    delete process.env.TANDEM_ALLOW_BYPASS;
    const prevSkip = process.env.TANDEM_SKIP_PERMISSIONS;
    process.env.TANDEM_SKIP_PERMISSIONS = "1";
    try {
      await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(
        RelayConfigError,
      );
    } finally {
      if (prevSkip === undefined) delete process.env.TANDEM_SKIP_PERMISSIONS;
      else process.env.TANDEM_SKIP_PERMISSIONS = prevSkip;
    }
  });

  it("rejects with values other than exactly '1'", async () => {
    for (const v of ["true", "yes", "0", ""]) {
      process.env.TANDEM_ALLOW_BYPASS = v;
      await expect(startRelay({ goal: "test", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(
        RelayConfigError,
      );
    }
  });
});
