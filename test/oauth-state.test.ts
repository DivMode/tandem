import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStateStore } from "../src/oauth-state.ts";

const PASSWORD = "correct horse battery staple";
const RESOURCE = "https://tandem.example.test/mcp";
const REDIRECT = "https://client.example.test/oauth/callback";
const CHALLENGE = "A".repeat(43);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tandem-oauth-state-"));
  roots.push(root);
  return root;
}

async function openStore(now = Date.now()): Promise<{ root: string; store: OAuthStateStore }> {
  const root = await tempRoot();
  const store = await OAuthStateStore.open({
    directory: join(root, "oauth"),
    bootstrapPassword: PASSWORD,
    now: () => now,
    accessTtlSeconds: 600,
    refreshTtlSeconds: 3600,
  });
  await store.registerClient({
    client_id: "client-01234567890123456789",
    client_id_issued_at: Math.floor(now / 1000),
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "MCP connector",
    scope: "mcp",
  });
  return { root, store };
}

async function issueTokens(store: OAuthStateStore) {
  const code = await store.issueAuthorizationCode({
    clientId: "client-01234567890123456789",
    redirectUri: REDIRECT,
    resource: RESOURCE,
    codeChallenge: CHALLENGE,
  });
  const tokens = await store.exchangeCode(code, {
    clientId: "client-01234567890123456789",
    redirectUri: REDIRECT,
    resource: RESOURCE,
  });
  return { code, tokens };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OAuthStateStore persistence", () => {
  it("creates an owner-only atomic state file and persists only digests", async () => {
    const { root, store } = await openStore();
    const { code, tokens } = await issueTokens(store);
    const statePath = join(root, "oauth", "state.json");
    expect((await stat(join(root, "oauth"))).mode & 0o777).toBe(0o700);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    const raw = await readFile(statePath, "utf8");
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(tokens.access_token);
    expect(raw).not.toContain(tokens.refresh_token!);
  });

  it("fails closed on corrupt, unsafe, or symlinked state", async () => {
    const root = await tempRoot();
    const directory = join(root, "oauth");
    await OAuthStateStore.open({ directory, bootstrapPassword: PASSWORD });
    await writeFile(join(directory, "state.json"), "{broken", { mode: 0o600 });
    await expect(OAuthStateStore.open({ directory, bootstrapPassword: PASSWORD })).rejects.toThrow(/corrupt/);

    await writeFile(join(directory, "state.json"), "{}", { mode: 0o600 });
    await chmod(join(directory, "state.json"), 0o644);
    await expect(OAuthStateStore.open({ directory, bootstrapPassword: PASSWORD })).rejects.toThrow(/0600/);

    await rm(join(directory, "state.json"));
    const target = join(root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, join(directory, "state.json"));
    await expect(OAuthStateStore.open({ directory, bootstrapPassword: PASSWORD })).rejects.toThrow(/regular file/);
  });

  it("requires a bootstrap password only for first initialization", async () => {
    const root = await tempRoot();
    const directory = join(root, "oauth");
    await expect(OAuthStateStore.open({ directory })).rejects.toThrow(/OWNER_PASSWORD/);
    await OAuthStateStore.open({ directory, bootstrapPassword: PASSWORD });
    await expect(OAuthStateStore.open({ directory })).resolves.toBeInstanceOf(OAuthStateStore);
  });
});

describe("OAuthStateStore grant invariants", () => {
  it("consumes an authorization code once and enforces every binding", async () => {
    const { store } = await openStore();
    const code = await store.issueAuthorizationCode({
      clientId: "client-01234567890123456789",
      redirectUri: REDIRECT,
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
    });
    await expect(store.exchangeCode(code, {
      clientId: "client-01234567890123456789",
      redirectUri: `${REDIRECT}/wrong`,
      resource: RESOURCE,
    })).rejects.toThrow(/binding/);
    const tokens = await store.exchangeCode(code, {
      clientId: "client-01234567890123456789",
      redirectUri: REDIRECT,
      resource: RESOURCE,
    });
    await expect(store.exchangeCode(code, {
      clientId: "client-01234567890123456789",
      redirectUri: REDIRECT,
      resource: RESOURCE,
    })).rejects.toThrow(/invalid authorization code/);
    await expect(store.verifyAccess(tokens.access_token, `${RESOURCE}/wrong`)).rejects.toThrow(/invalid access token/);
    await expect(store.verifyAccess(tokens.access_token, RESOURCE)).resolves.toMatchObject({ scopes: ["mcp"] });
  });

  it("serializes concurrent refreshes and replay revokes the whole family", async () => {
    const { store } = await openStore();
    const { tokens } = await issueTokens(store);
    const input = {
      clientId: "client-01234567890123456789",
      resource: RESOURCE,
      scopes: ["mcp"],
    };
    const results = await Promise.allSettled([
      store.exchangeRefresh(tokens.refresh_token!, input),
      store.exchangeRefresh(tokens.refresh_token!, input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rotated = results.find((result) => result.status === "fulfilled");
    if (!rotated || rotated.status !== "fulfilled") throw new Error("missing successful rotation");
    await expect(store.verifyAccess(tokens.access_token, RESOURCE)).rejects.toThrow(/invalid access token/);
    await expect(store.verifyAccess(rotated.value.access_token, RESOURCE)).rejects.toThrow(/invalid access token/);
    await expect(store.exchangeRefresh(rotated.value.refresh_token!, input)).rejects.toThrow(/invalid refresh token/);
  });
});
