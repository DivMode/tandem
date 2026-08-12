import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, redactAuditFields } from "../bridge/audit.ts";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("metadata-only private audit logging", () => {
  it("replaces content, path, credential, and identity fields with UTF-8 byte counts", () => {
    const safe = redactAuditFields({
      route: "POST /test",
      text: "secret command",
      task: "private task",
      goal: "private goal",
      context: "private context",
      cwd: "/Users/private/project",
      nonce: "private-registration-nonce",
      token: "private-token",
      authorization: "Bearer private-token",
      hostname: "personal-macbook.local",
      username: "private-user",
      ip: "100.64.0.10",
      tailnet: "personal-tailnet.ts.net",
      deviceName: "Max's laptop",
      error: "failed at /Users/private/project",
    });
    expect(safe.route).toBe("POST /test");
    expect(safe.text).toBeUndefined();
    expect(safe.task).toBeUndefined();
    expect(safe.goal).toBeUndefined();
    expect(safe.context).toBeUndefined();
    expect(safe.cwd).toBeUndefined();
    expect(safe.nonce).toBeUndefined();
    expect(safe.token).toBeUndefined();
    expect(safe.authorization).toBeUndefined();
    expect(safe.hostname).toBeUndefined();
    expect(safe.username).toBeUndefined();
    expect(safe.ip).toBeUndefined();
    expect(safe.tailnet).toBeUndefined();
    expect(safe.deviceName).toBeUndefined();
    expect(safe.error).toBeUndefined();
    expect(safe.textBytes).toBe(Buffer.byteLength("secret command"));
    expect(safe.taskBytes).toBe(Buffer.byteLength("private task"));
    expect(safe.cwdBytes).toBe(Buffer.byteLength("/Users/private/project"));
    expect(safe.tokenBytes).toBe(Buffer.byteLength("private-token"));
  });

  it("keeps circular sensitive values redacted without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactAuditFields({ body: circular })).toEqual({ bodyBytes: null });
  });

  it("persists no content and forces 0700 directory / 0600 file modes", () => {
    const root = mkdtempSync(join(tmpdir(), "tandem-audit-"));
    tempRoots.push(root);
    const directory = join(root, "state");
    const secret = "DISTINCTIVE-SECRET-PROMPT";
    audit({ route: "POST /sessions/:name/send", text: secret, outcome: "ok" }, { directory });

    const logPath = join(directory, "bridge.log");
    const line = readFileSync(logPath, "utf8");
    expect(line).not.toContain(secret);
    expect(JSON.parse(line).textBytes).toBe(Buffer.byteLength(secret));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("does not echo a private filesystem path when the audit write fails", () => {
    const root = mkdtempSync(join(tmpdir(), "tandem-audit-failure-"));
    tempRoots.push(root);
    const privatePath = join(root, "not-a-directory");
    writeFileSync(privatePath, "occupied");
    let called = false;
    audit({ event: "test", cwd: "/Users/private/project" }, {
      directory: privatePath,
      onError: (message) => {
        called = true;
        expect(message).toContain("AUDIT WRITE FAILED");
        expect(message).not.toContain("/Users/private/project");
      },
    });
    expect(called).toBe(true);
  });
});
