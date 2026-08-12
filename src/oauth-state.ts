import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, chmod, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const VERSION = 1;
const PASSWORD_ITERATIONS = 210_000;
const MAX_CLIENTS = 256;
const MAX_CODES = 256;
const MAX_REFRESH = 2048;
const MAX_ACCESS = 4096;
const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;

const ClientSchema = z.object({
  client_id: z.string().min(16).max(256),
  client_id_issued_at: z.number().int().nonnegative(),
  redirect_uris: z.array(z.string().url()).min(1).max(5),
  token_endpoint_auth_method: z.literal("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).min(1).max(2),
  response_types: z.tuple([z.literal("code")]),
  client_name: z.string().min(1).max(80),
  scope: z.literal("mcp"),
}).strict();

const PasswordSchema = z.object({
  scheme: z.literal("pbkdf2-sha256-v1"),
  iterations: z.number().int().min(100_000).max(1_000_000),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const GrantBaseSchema = z.object({
  clientId: z.string().min(1).max(256),
  resource: z.string().url().max(2048),
  scopes: z.tuple([z.literal("mcp")]),
  expiresAt: z.number().int().positive(),
}).strict();

const CodeSchema = GrantBaseSchema.extend({
  redirectUri: z.string().url().max(2048),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

const RefreshSchema = GrantBaseSchema.extend({
  familyId: z.string().regex(/^[a-f0-9]{32}$/),
  usedAt: z.number().int().positive().optional(),
  revokedAt: z.number().int().positive().optional(),
}).strict();

const AccessSchema = GrantBaseSchema.extend({
  familyId: z.string().regex(/^[a-f0-9]{32}$/),
  revokedAt: z.number().int().positive().optional(),
}).strict();

const StateSchema = z.object({
  version: z.literal(VERSION),
  password: PasswordSchema,
  clients: z.record(z.string(), ClientSchema),
  codes: z.record(z.string(), CodeSchema),
  refresh: z.record(z.string(), RefreshSchema),
  access: z.record(z.string(), AccessSchema),
}).strict().superRefine((state, context) => {
  const counts: Array<[string, number, number]> = [
    ["clients", Object.keys(state.clients).length, MAX_CLIENTS],
    ["codes", Object.keys(state.codes).length, MAX_CODES],
    ["refresh", Object.keys(state.refresh).length, MAX_REFRESH],
    ["access", Object.keys(state.access).length, MAX_ACCESS],
  ];
  for (const [field, count, cap] of counts) {
    if (count > cap) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} exceeds its hard cap` });
  }
});

type PersistedClient = z.infer<typeof ClientSchema>;
type PasswordHash = z.infer<typeof PasswordSchema>;
type GrantBase = z.infer<typeof GrantBaseSchema>;
type OAuthState = z.infer<typeof StateSchema>;

export class OAuthStateError extends Error {
  readonly kind: "invalid_grant" | "invalid_token" | "capacity" | "state";

  constructor(kind: OAuthStateError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface OAuthStateStoreOptions {
  directory: string;
  bootstrapPassword?: string;
  now?: () => number;
  random?: (bytes: number) => Buffer;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
}

export interface AuthorizationCodeInput {
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
}

export interface CodeExchangeInput {
  clientId: string;
  redirectUri?: string;
  resource?: string;
}

export interface RefreshExchangeInput {
  clientId: string;
  resource?: string;
  scopes?: string[];
}

function tokenDigest(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function cloneState(state: OAuthState): OAuthState {
  return structuredClone(state);
}

function passwordHash(password: string, random: (bytes: number) => Buffer): PasswordHash {
  const salt = random(16);
  const digest = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return {
    scheme: "pbkdf2-sha256-v1",
    iterations: PASSWORD_ITERATIONS,
    salt: salt.toString("hex"),
    digest: digest.toString("hex"),
  };
}

function verifyPasswordHash(password: string, hash: PasswordHash): boolean {
  const salt = Buffer.from(hash.salt, "hex");
  const expected = Buffer.from(hash.digest, "hex");
  const actual = pbkdf2Sync(password, salt, hash.iterations, expected.length, "sha256");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeMode(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

function removeExpired(state: OAuthState, now: number): void {
  for (const [key, value] of Object.entries(state.codes)) {
    if (value.expiresAt <= now) delete state.codes[key];
  }
  for (const [key, value] of Object.entries(state.refresh)) {
    if (value.expiresAt <= now) delete state.refresh[key];
  }
  for (const [key, value] of Object.entries(state.access)) {
    if (value.expiresAt <= now) delete state.access[key];
  }
}

function assertCapacity(state: OAuthState, field: "clients" | "codes" | "refresh" | "access", cap: number): void {
  if (Object.keys(state[field]).length >= cap) {
    throw new OAuthStateError("capacity", `OAuth ${field} capacity reached`);
  }
}

function toClient(record: PersistedClient): OAuthClientInformationFull {
  return { ...record };
}

export class OAuthStateStore {
  readonly statePath: string;
  private state: OAuthState;
  private queue: Promise<void> = Promise.resolve();
  private readonly directory: string;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Buffer;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private fatalError: Error | undefined;

  private constructor(options: OAuthStateStoreOptions, state: OAuthState) {
    this.directory = options.directory;
    this.statePath = path.join(options.directory, "state.json");
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
    this.accessTtlSeconds = options.accessTtlSeconds ?? 600;
    this.refreshTtlSeconds = options.refreshTtlSeconds ?? 30 * 24 * 60 * 60;
    this.state = state;
  }

  static async open(options: OAuthStateStoreOptions): Promise<OAuthStateStore> {
    const directory = path.resolve(options.directory);
    const normalized = { ...options, directory };
    let directoryExists = true;
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("OAuth state directory must be a real directory");
      if (!safeMode(info.mode, 0o700)) throw new Error("OAuth state directory permissions must be 0700");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      directoryExists = false;
    }
    if (!directoryExists) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }

    const statePath = path.join(directory, "state.json");
    let state: OAuthState;
    try {
      const info = await lstat(statePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("OAuth state file must be a regular file");
      if (!safeMode(info.mode, 0o600)) throw new Error("OAuth state file permissions must be 0600");
      if (info.size > MAX_STATE_FILE_BYTES) throw new Error("OAuth state file exceeds its safe size limit");
      const raw = await readFile(statePath, "utf8");
      const parsed = StateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("OAuth state file is corrupt or uses an unsupported version");
      state = parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyntaxError) throw new Error("OAuth state file is corrupt or uses an unsupported version");
        throw error;
      }
      if (!normalized.bootstrapPassword) {
        throw new Error("TANDEM_OWNER_PASSWORD is required to initialize OAuth state");
      }
      state = {
        version: VERSION,
        password: passwordHash(normalized.bootstrapPassword, normalized.random ?? randomBytes),
        clients: {},
        codes: {},
        refresh: {},
        access: {},
      };
      const store = new OAuthStateStore(normalized, state);
      await store.persist(state);
      return store;
    }
    return new OAuthStateStore(normalized, state);
  }

  private async snapshot(): Promise<OAuthState> {
    await this.queue;
    if (this.fatalError) throw this.fatalError;
    return cloneState(this.state);
  }

  private async transaction<T>(mutate: (draft: OAuthState, now: number) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.fatalError) throw this.fatalError;
      const draft = cloneState(this.state);
      const now = this.now();
      removeExpired(draft, now);
      const value = await mutate(draft, now);
      const validated = StateSchema.parse(draft);
      try {
        await this.persist(validated);
      } catch {
        this.fatalError = new Error("OAuth state persistence failed; restart is required");
        throw this.fatalError;
      }
      this.state = validated;
      return value;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(state: OAuthState): Promise<void> {
    const suffix = this.random(16).toString("hex");
    const tempPath = path.join(this.directory, `.state.${suffix}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.statePath);
      await chmod(this.statePath, 0o600);
      const directoryHandle = await open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private opaque(bytes = 32): string {
    return this.random(bytes).toString("base64url");
  }

  async verifyPassword(password: string): Promise<boolean> {
    const state = await this.snapshot();
    return verifyPasswordHash(password, state.password);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const state = await this.snapshot();
    const record = Object.hasOwn(state.clients, clientId) ? state.clients[clientId] : undefined;
    return record ? toClient(record) : undefined;
  }

  async registerClient(client: PersistedClient): Promise<OAuthClientInformationFull> {
    return this.transaction((state) => {
      assertCapacity(state, "clients", MAX_CLIENTS);
      if (Object.hasOwn(state.clients, client.client_id)) throw new OAuthStateError("state", "OAuth client id collision");
      state.clients[client.client_id] = ClientSchema.parse(client);
      return toClient(client);
    });
  }

  async issueAuthorizationCode(input: AuthorizationCodeInput): Promise<string> {
    return this.transaction((state, now) => {
      assertCapacity(state, "codes", MAX_CODES);
      const raw = this.opaque();
      const digest = tokenDigest(raw);
      if (state.codes[digest]) throw new OAuthStateError("state", "OAuth code collision");
      state.codes[digest] = {
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        resource: input.resource,
        scopes: ["mcp"],
        codeChallenge: input.codeChallenge,
        expiresAt: now + 120_000,
      };
      return raw;
    });
  }

  async challengeForCode(rawCode: string, clientId: string): Promise<string> {
    const state = await this.snapshot();
    const record = state.codes[tokenDigest(rawCode)];
    if (!record || record.expiresAt <= this.now() || record.clientId !== clientId) {
      throw new OAuthStateError("invalid_grant", "invalid authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeCode(rawCode: string, input: CodeExchangeInput): Promise<OAuthTokens> {
    return this.transaction((state, now) => {
      const digest = tokenDigest(rawCode);
      const code = state.codes[digest];
      if (!code || code.expiresAt <= now || code.clientId !== input.clientId) {
        throw new OAuthStateError("invalid_grant", "invalid authorization code");
      }
      if (input.redirectUri !== code.redirectUri || input.resource !== code.resource) {
        throw new OAuthStateError("invalid_grant", "authorization code binding mismatch");
      }
      assertCapacity(state, "access", MAX_ACCESS);
      assertCapacity(state, "refresh", MAX_REFRESH);
      delete state.codes[digest];

      const familyId = this.random(16).toString("hex");
      const accessToken = this.opaque();
      const refreshToken = this.opaque();
      const base: Omit<GrantBase, "expiresAt"> = {
        clientId: code.clientId,
        resource: code.resource,
        scopes: ["mcp"],
      };
      state.access[tokenDigest(accessToken)] = {
        ...base,
        familyId,
        expiresAt: now + this.accessTtlSeconds * 1000,
      };
      state.refresh[tokenDigest(refreshToken)] = {
        ...base,
        familyId,
        expiresAt: now + this.refreshTtlSeconds * 1000,
      };
      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: this.accessTtlSeconds,
        scope: "mcp",
      };
    });
  }

  async exchangeRefresh(rawToken: string, input: RefreshExchangeInput): Promise<OAuthTokens> {
    const outcome = await this.transaction((state, now) => {
      const digest = tokenDigest(rawToken);
      const current = state.refresh[digest];
      if (!current || current.expiresAt <= now || current.clientId !== input.clientId) {
        return { kind: "invalid" as const };
      }
      if (current.resource !== input.resource || !validRefreshScopes(input.scopes, current.scopes)) {
        return { kind: "invalid" as const };
      }
      if (current.usedAt || current.revokedAt) {
        for (const refresh of Object.values(state.refresh)) {
          if (refresh.familyId === current.familyId) refresh.revokedAt = now;
        }
        for (const access of Object.values(state.access)) {
          if (access.familyId === current.familyId) access.revokedAt = now;
        }
        return { kind: "replay" as const };
      }
      assertCapacity(state, "access", MAX_ACCESS);
      assertCapacity(state, "refresh", MAX_REFRESH);
      current.usedAt = now;
      const accessToken = this.opaque();
      const refreshToken = this.opaque();
      state.access[tokenDigest(accessToken)] = {
        clientId: current.clientId,
        resource: current.resource,
        scopes: ["mcp"],
        familyId: current.familyId,
        expiresAt: now + this.accessTtlSeconds * 1000,
      };
      state.refresh[tokenDigest(refreshToken)] = {
        clientId: current.clientId,
        resource: current.resource,
        scopes: ["mcp"],
        familyId: current.familyId,
        expiresAt: now + this.refreshTtlSeconds * 1000,
      };
      return {
        kind: "ok" as const,
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: this.accessTtlSeconds,
          scope: "mcp",
        } satisfies OAuthTokens,
      };
    });
    if (outcome.kind !== "ok") throw new OAuthStateError("invalid_grant", "invalid refresh token");
    return outcome.tokens;
  }

  async verifyAccess(rawToken: string, expectedResource: string): Promise<AuthInfo> {
    const state = await this.snapshot();
    const record = state.access[tokenDigest(rawToken)];
    if (!record || record.expiresAt <= this.now() || record.revokedAt || record.resource !== expectedResource) {
      throw new OAuthStateError("invalid_token", "invalid access token");
    }
    const client = state.clients[record.clientId];
    if (!client) throw new OAuthStateError("invalid_token", "invalid access token");
    return {
      token: rawToken,
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(record.resource),
    };
  }

  async revoke(rawToken: string, clientId: string): Promise<void> {
    await this.transaction((state, now) => {
      const digest = tokenDigest(rawToken);
      const refresh = state.refresh[digest];
      if (refresh?.clientId === clientId) {
        for (const item of Object.values(state.refresh)) {
          if (item.familyId === refresh.familyId) item.revokedAt = now;
        }
        for (const item of Object.values(state.access)) {
          if (item.familyId === refresh.familyId) item.revokedAt = now;
        }
      }
      const access = state.access[digest];
      if (access?.clientId === clientId) access.revokedAt = now;
    });
  }
}

function validRefreshScopes(requested: string[] | undefined, granted: readonly string[]): boolean {
  if (requested === undefined) return true;
  return requested.length === 1 && requested[0] === "mcp" && granted.includes("mcp");
}
