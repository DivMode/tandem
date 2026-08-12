import { afterEach, describe, expect, it } from "vitest";
import { startServer, type ServerHandle } from "../src/http-mcp.ts";

const TOKEN = "legacy-test-token-01234567890123456789";
let handle: ServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("explicit legacy HTTP authentication", () => {
  it("accepts only an Authorization bearer header on the exact /mcp path", async () => {
    handle = await startServer({ host: "127.0.0.1", port: 0, token: TOKEN });
    const base = `http://127.0.0.1:${handle.port}`;

    const query = await fetch(`${base}/mcp?token=${TOKEN}`, { method: "POST" });
    expect(query.status).toBe(404);
    const path = await fetch(`${base}/${TOKEN}/mcp`, { method: "POST" });
    expect(path.status).toBe(404);
    const missing = await fetch(`${base}/mcp`, { method: "POST" });
    expect(missing.status).toBe(401);

    const authenticated = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "not-json",
    });
    expect(authenticated.status).toBe(400);
  });

  it("never exposes private enrollment routes on the legacy public listener", async () => {
    handle = await startServer({ host: "127.0.0.1", port: 0, token: TOKEN });
    const response = await fetch(`http://127.0.0.1:${handle.port}/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(TOKEN);
  });
});
