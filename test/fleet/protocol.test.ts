import { describe, expect, it } from "vitest";
import {
  FrameInvalidError,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  encodeCapabilitiesFrame,
  encodePingFrame,
  encodePongFrame,
  encodeRegisterAckFrame,
  encodeRegisterFrame,
  encodeRequestFrame,
  encodeResponseFrame,
  generateNonce,
  generateRequestId,
  parseFrame,
} from "../../bridge/fleet-protocol.ts";

describe("fleet-protocol: nonce/id generation", () => {
  it("generates a bounded, base64url nonce (never logged, just format-checked here)", () => {
    const nonce = generateNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(22);
    expect(nonce.length).toBeLessThanOrEqual(128);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a bounded hex request id", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[A-Za-z0-9]{16,64}$/);
  });
});

describe("fleet-protocol: register frame", () => {
  it("round-trips a valid register frame", () => {
    const raw = encodeRegisterFrame("device-a13f2c", "studio", ["claude", "codex"], generateNonce());
    const frame = parseFrame(raw);
    expect(frame).toMatchObject({ v: 1, type: "register", deviceId: "device-a13f2c", name: "studio" });
  });

  it("rejects a malformed device id", () => {
    expect(() => encodeRegisterFrame("BAD ID!", "studio", ["claude"], generateNonce())).toThrow(FrameInvalidError);
  });

  it("rejects an unknown engine id in the engines array", () => {
    expect(() =>
      encodeRegisterFrame("device-a", "studio", ["claude", "not-a-real-engine" as never], generateNonce()),
    ).toThrow(FrameInvalidError);
  });

  it("rejects duplicate engine claims", () => {
    expect(() => encodeRegisterFrame("device-a", "studio", ["claude", "claude"], generateNonce())).toThrow(FrameInvalidError);
  });

  it("rejects an out-of-bounds nonce", () => {
    expect(() => encodeRegisterFrame("device-a", "studio", ["claude"], "short")).toThrow(FrameInvalidError);
  });

  it("fails closed on an unknown extra field (strict schema)", () => {
    const withExtra = JSON.stringify({
      v: 1,
      type: "register",
      deviceId: "device-a",
      name: "studio",
      engines: ["claude"],
      nonce: generateNonce(),
      extra: "not allowed",
    });
    expect(() => parseFrame(withExtra)).toThrow(FrameInvalidError);
  });
});

describe("fleet-protocol: request frames — exact operation-specific payload schemas", () => {
  it("round-trips every known op with a valid payload", () => {
    expect(parseFrame(encodeRequestFrame(generateRequestId(), "open_session", { name: "x", engine: "claude" }))).toMatchObject({
      op: "open_session",
    });
    expect(parseFrame(encodeRequestFrame(generateRequestId(), "send", { sessionId: "x", text: "hi" }))).toMatchObject({ op: "send" });
    expect(parseFrame(encodeRequestFrame(generateRequestId(), "read", { sessionId: "x", cursor: 5 }))).toMatchObject({ op: "read" });
    expect(parseFrame(encodeRequestFrame(generateRequestId(), "interrupt", { sessionId: "x" }))).toMatchObject({ op: "interrupt" });
    expect(parseFrame(encodeRequestFrame(generateRequestId(), "close", { sessionId: "x" }))).toMatchObject({ op: "close" });
    expect(parseFrame(encodeRequestFrame(generateRequestId(), "list_sessions", { limit: 10 }))).toMatchObject({ op: "list_sessions" });
  });

  it("rejects an unknown operation entirely (fails closed)", () => {
    const raw = JSON.stringify({ v: 1, type: "request", id: generateRequestId(), op: "delete_everything", payload: {} });
    expect(() => parseFrame(raw)).toThrow(FrameInvalidError);
  });

  it("rejects a payload with an unexpected field for its op (strict, no smuggled fields)", () => {
    expect(() => encodeRequestFrame(generateRequestId(), "read", { sessionId: "x", cwd: "/etc" } as never)).toThrow(FrameInvalidError);
  });

  it("rejects an over-length text payload", () => {
    expect(() => encodeRequestFrame(generateRequestId(), "send", { sessionId: "x", text: "a".repeat(70_000) })).toThrow(
      FrameInvalidError,
    );
  });

  it("rejects a negative cursor", () => {
    expect(() => encodeRequestFrame(generateRequestId(), "read", { sessionId: "x", cursor: -1 })).toThrow(FrameInvalidError);
  });

  it("relay is never a valid fleet operation (binding — correction 1)", () => {
    const raw = JSON.stringify({ v: 1, type: "request", id: generateRequestId(), op: "relay", payload: {} });
    expect(() => parseFrame(raw)).toThrow(FrameInvalidError);
  });
});

describe("fleet-protocol: response/ack/heartbeat/capabilities frames", () => {
  it("round-trips a successful response with an object body", () => {
    const raw = encodeResponseFrame(generateRequestId(), true, 200, { name: "x", engine: "claude" });
    expect(parseFrame(raw)).toMatchObject({ type: "response", ok: true, status: 200 });
  });

  it("round-trips a rejected response with an error message", () => {
    const raw = encodeResponseFrame(generateRequestId(), false, undefined, undefined, "boom");
    expect(parseFrame(raw)).toMatchObject({ type: "response", ok: false, error: "boom" });
  });

  it("rejects a non-object response body", () => {
    expect(() => encodeResponseFrame(generateRequestId(), true, 200, "not an object")).toThrow(FrameInvalidError);
  });

  it("requires a normalized status/body on success and an error on failure", () => {
    expect(() => encodeResponseFrame(generateRequestId(), true, undefined, {})).toThrow(FrameInvalidError);
    expect(() => encodeResponseFrame(generateRequestId(), true, 200, undefined)).toThrow(FrameInvalidError);
    expect(() => encodeResponseFrame(generateRequestId(), false)).toThrow(FrameInvalidError);
  });

  it("round-trips register_ack, ping, pong, capabilities", () => {
    expect(parseFrame(encodeRegisterAckFrame(true))).toMatchObject({ type: "register_ack", ok: true });
    expect(parseFrame(encodePingFrame())).toMatchObject({ type: "ping" });
    expect(parseFrame(encodePongFrame())).toMatchObject({ type: "pong" });
    expect(parseFrame(encodeCapabilitiesFrame(["claude", "shell"]))).toMatchObject({ type: "capabilities", engines: ["claude", "shell"] });
  });
});

describe("fleet-protocol: size and malformed-input bounds", () => {
  it("rejects an oversize inbound frame before JSON.parse", () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1);
    expect(() => parseFrame(huge)).toThrow(FrameTooLargeError);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseFrame("{not json")).toThrow(FrameInvalidError);
  });

  it("rejects a frame with no type field", () => {
    expect(() => parseFrame(JSON.stringify({ v: 1 }))).toThrow(FrameInvalidError);
  });

  it("rejects an unknown frame type", () => {
    expect(() => parseFrame(JSON.stringify({ v: 1, type: "not-a-real-type" }))).toThrow(FrameInvalidError);
  });

  it("encodeResponseFrame rejects a body that would serialize over the 1 MiB cap", () => {
    const huge = { report: "x".repeat(MAX_FRAME_BYTES + 10) };
    expect(() => encodeResponseFrame(generateRequestId(), true, 200, huge)).toThrow(FrameTooLargeError);
  });
});
