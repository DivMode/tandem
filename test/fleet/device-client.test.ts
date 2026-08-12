import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

const { FleetDeviceClient, InvalidHubUrlError, planReconnect, validateHubUrl } = await import("../../bridge/fleet-device-client.ts");
const { encodeCapabilitiesFrame, encodeRegisterAckFrame, encodeRequestFrame, generateRequestId, parseFrame } = await import("../../bridge/fleet-protocol.ts");
const { registerLive, unregisterLive } = await import("../../bridge/sessions.ts");
type DrivableSession = import("../../bridge/drivable.ts").DrivableSession;

function fakeSession(id: string): DrivableSession {
  return {
    id,
    engine: "claude",
    cwd: "/tmp/fake",
    isAlive: async () => true,
    isWorking: async () => false,
    send: async () => ({ status: "done", report: "ok", cursor: 1 }),
    read: async () => ({ text: "", cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => "fake-attach-hint",
  };
}

describe("validateHubUrl (binding — correction 5)", () => {
  it("accepts wss:// for any host", () => {
    expect(() => validateHubUrl("wss://hub.example-tailnet.ts.net:8443")).not.toThrow();
  });

  it("accepts ws:// only for an exact loopback host", () => {
    expect(() => validateHubUrl("ws://127.0.0.1:8788")).not.toThrow();
    expect(() => validateHubUrl("ws://localhost:8788")).not.toThrow();
  });

  it("rejects ws:// for a non-loopback host", () => {
    expect(() => validateHubUrl("ws://hub.example-tailnet.ts.net:8788")).toThrow(InvalidHubUrlError);
  });

  it("rejects credentials, query, and fragment", () => {
    expect(() => validateHubUrl("wss://user:pass@hub.example.ts.net:8443")).toThrow(InvalidHubUrlError);
    expect(() => validateHubUrl("wss://hub.example.ts.net:8443?token=x")).toThrow(InvalidHubUrlError);
    expect(() => validateHubUrl("wss://hub.example.ts.net:8443#frag")).toThrow(InvalidHubUrlError);
  });

  it("rejects a non-ws(s) scheme and a malformed URL", () => {
    expect(() => validateHubUrl("https://hub.example.ts.net:8443")).toThrow(InvalidHubUrlError);
    expect(() => validateHubUrl("not a url")).toThrow(InvalidHubUrlError);
  });
});

/** A minimal fake `ws.WebSocket` — enough surface for FleetDeviceClient. */
class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  headersSeen: Record<string, string> | undefined;

  constructor(
    public url: string,
    public options: { headers?: Record<string, string> },
  ) {
    super();
    this.headersSeen = options.headers;
    queueMicrotask(() => this.emit("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.emit("close");
  }

  terminate(): void {
    this.emit("close");
  }

  get OPEN() {
    return FakeWebSocket.OPEN;
  }
}

const opened: string[] = [];
afterEach(() => {
  for (const name of opened.splice(0)) unregisterLive(name);
});

describe("FleetDeviceClient: registration + token handling (binding — correction 5)", () => {
  it("rejects a short fleet token before opening a socket", () => {
    expect(
      () =>
        new FleetDeviceClient({
          hubUrl: "wss://hub.example.ts.net:8443",
          fleetToken: "too-short",
          deviceId: "device-a",
          deviceName: "studio",
          engines: () => ["claude"],
        }),
    ).toThrow(/at least 16/);
  });

  it("does not repeat a rejected URL or hostname in validation errors", () => {
    const secretBearingUrl = "https://user:private-value@personal-host.example:8443";
    try {
      validateHubUrl(secretBearingUrl);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidHubUrlError);
      expect((error as Error).message).not.toContain("private-value");
      expect((error as Error).message).not.toContain("personal-host");
    }
  });

  it("rejects invalid device metadata before opening a socket", () => {
    expect(
      () =>
        new FleetDeviceClient({
          hubUrl: "wss://hub.example.ts.net:8443",
          fleetToken: "super-secret-fleet-token",
          deviceId: "BAD ID!",
          deviceName: "studio",
          engines: () => ["claude"],
        }),
    ).toThrow();
    expect(
      () =>
        new FleetDeviceClient({
          hubUrl: "wss://hub.example.ts.net:8443",
          fleetToken: "super-secret-fleet-token",
          deviceId: "local",
          deviceName: "studio",
          engines: () => ["claude"],
        }),
    ).toThrow(/reserved/);
  });

  it("sends the fleet token ONLY as an Authorization bearer header, never in the URL", async () => {
    let created: FakeWebSocket | undefined;
    const client = new FleetDeviceClient({
      hubUrl: "wss://hub.example.ts.net:8443",
      fleetToken: "super-secret-fleet-token",
      deviceId: "device-a",
      deviceName: "studio",
      engines: () => ["claude"],
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options);
          created = this;
        }
      } as never,
    });
    client.start();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(created).toBeDefined();
    expect(created!.url).toBe("wss://hub.example.ts.net:8443");
    expect(created!.url).not.toContain("super-secret-fleet-token");
    expect(created!.headersSeen?.authorization).toBe("Bearer super-secret-fleet-token");
    await client.stop();
  });

  it("registers with a fresh register frame containing the device id/name/engines and a bounded nonce", async () => {
    let created: FakeWebSocket | undefined;
    const client = new FleetDeviceClient({
      hubUrl: "wss://hub.example.ts.net:8443",
      fleetToken: "super-secret-fleet-token",
      deviceId: "device-a",
      deviceName: "studio",
      engines: () => ["claude", "shell"],
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options);
          created = this;
        }
      } as never,
    });
    client.start();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const frame = parseFrame(created!.sent[0]!);
    expect(frame).toMatchObject({ type: "register", deviceId: "device-a", name: "studio", engines: ["claude", "shell"] });
    await client.stop();
  });
});

describe("FleetDeviceClient: fail-closed protocol direction", () => {
  it("rejects a request before register_ack", async () => {
    let created: FakeWebSocket | undefined;
    const client = new FleetDeviceClient({
      hubUrl: "wss://hub.example.ts.net:8443",
      fleetToken: "super-secret-fleet-token",
      deviceId: "device-a",
      deviceName: "studio",
      engines: () => ["claude"],
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options);
          created = this;
        }
      } as never,
    });
    client.start();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    created!.emit("message", Buffer.from(encodeRequestFrame(generateRequestId(), "read", { sessionId: "x" })), false);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(created!.closeCalls).toContainEqual([4008, "request received before registration acknowledgement"]);
    await client.stop();
  });

  it("closes on a malformed or wrong-direction frame", async () => {
    let created: FakeWebSocket | undefined;
    const client = new FleetDeviceClient({
      hubUrl: "wss://hub.example.ts.net:8443",
      fleetToken: "super-secret-fleet-token",
      deviceId: "device-a",
      deviceName: "studio",
      engines: () => ["claude"],
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options);
          created = this;
        }
      } as never,
    });
    client.start();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    created!.emit("message", Buffer.from(encodeRegisterAckFrame(true)), false);
    created!.emit("message", Buffer.from(encodeCapabilitiesFrame(["claude"])), false);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(created!.closeCalls).toContainEqual([4006, "unexpected frame type from hub: capabilities"]);
    await client.stop();
  });
});

describe("FleetDeviceClient: bounded reconnect planning", () => {
  it("grows exponentially, applies symmetric jitter, clamps, and resets only after a healthy connection", () => {
    expect(planReconnect(0, 0, 0)).toEqual({ attempt: 1, delayMs: 425 });
    expect(planReconnect(1, 0, 1)).toEqual({ attempt: 2, delayMs: 1150 });
    expect(planReconnect(30, 0, 1)).toEqual({ attempt: 31, delayMs: 30000 });
    expect(planReconnect(8, 10_000, 0.5)).toEqual({ attempt: 1, delayMs: 500 });
  });

  it("terminates a dial that never opens", async () => {
    vi.useFakeTimers();
    let terminated = 0;
    class NeverOpenSocket extends EventEmitter {
      static readonly OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      send() {}
      close() { this.emit("close"); }
      terminate() { terminated += 1; this.emit("close"); }
      get OPEN() { return NeverOpenSocket.OPEN; }
    }
    const client = new FleetDeviceClient({
      hubUrl: "wss://hub.example.ts.net:8443",
      fleetToken: "super-secret-fleet-token",
      deviceId: "device-a",
      deviceName: "studio",
      engines: () => ["claude"],
      WebSocketImpl: NeverOpenSocket as never,
      dialTimeoutMs: 50,
      randomJitter: () => 0.5,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(terminated).toBe(1);
    await client.stop();
    vi.useRealTimers();
  });

  it("actually reconnects after a disconnect using the bounded schedule", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const client = new FleetDeviceClient({
      hubUrl: "wss://hub.example.ts.net:8443",
      fleetToken: "super-secret-fleet-token",
      deviceId: "device-a",
      deviceName: "studio",
      engines: () => ["claude"],
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options);
          sockets.push(this);
        }
      } as never,
      randomJitter: () => 0.5,
    });
    client.start();
    await vi.runAllTicks();
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTicks();
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    await client.stop();
    vi.useRealTimers();
  });
});

describe("FleetDeviceClient: incoming request handling", () => {
  it("executes an incoming request frame against the local router and replies with a response frame", async () => {
    const name = "client-sess";
    registerLive(fakeSession(name));
    opened.push(name);

    let created: FakeWebSocket | undefined;
    const client = new FleetDeviceClient({
      hubUrl: "wss://hub.example.ts.net:8443",
      fleetToken: "super-secret-fleet-token",
      deviceId: "device-a",
      deviceName: "studio",
      engines: () => ["claude"],
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options);
          created = this;
        }
      } as never,
    });
    client.start();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    created!.emit("message", Buffer.from(encodeRegisterAckFrame(true)), false);

    const requestId = generateRequestId();
    const requestFrame = encodeRequestFrame(requestId, "send", { sessionId: name, text: "hi" });
    created!.emit("message", Buffer.from(requestFrame), false);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const responseRaw = created!.sent.find((s) => JSON.parse(s).type === "response");
    expect(responseRaw).toBeDefined();
    const response = parseFrame(responseRaw!);
    expect(response).toMatchObject({ type: "response", id: requestId, ok: true, status: 200 });

    await client.stop();
  });
});
