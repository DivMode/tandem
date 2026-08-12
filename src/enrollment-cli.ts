import path from "node:path";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { FleetEnrollmentStore } from "../bridge/fleet-enrollment.ts";
import { validateHubUrl } from "../bridge/fleet-device-client.ts";
import { validateDeviceId, validateDeviceName } from "../bridge/fleet-protocol.ts";
import { buildEnabledEngines } from "../bridge/engine-registry.ts";
import {
  loadProtectedRuntimeConfigFromEnv,
  readProtectedRuntimeConfig,
  writeProtectedFile,
  writeProtectedRuntimeConfig,
} from "./runtime-config.ts";

const MAX_RESPONSE_BYTES = 16 * 1024;

const EnrollmentResponseSchema = z.object({
  fleetToken: z.string().min(16).max(1024),
}).strict();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) throw new Error(`invalid ${name}`);
  return value;
}

async function boundedBody(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_RESPONSE_BYTES) throw new Error("enrollment response is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("enrollment response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function enrollmentEndpoint(hubUrl: string): URL {
  const parsed = validateHubUrl(hubUrl);
  if (parsed.pathname !== "/") throw new Error("enrollment hub URL must use the exact root path");
  const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]).has(parsed.hostname);
  if (!parsed.hostname.endsWith(".ts.net") && !(loopback && process.env.TANDEM_ALLOW_LOOPBACK_ENROLLMENT === "1")) {
    throw new Error("enrollment hub must be a private Tailscale Serve URL");
  }
  if (!loopback && (!parsed.port || parsed.port === "443")) {
    throw new Error("enrollment hub must use the distinct private Serve port");
  }
  const endpoint = new URL(parsed.href);
  endpoint.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/enroll";
  return endpoint;
}

async function createBundle(bundleFile: string): Promise<void> {
  await loadProtectedRuntimeConfigFromEnv();
  const hubUrl = required("TANDEM_PRIVATE_URL");
  enrollmentEndpoint(hubUrl);
  const stateDirectory = required("TANDEM_ENROLLMENT_STATE_DIR");
  const store = await FleetEnrollmentStore.open(stateDirectory);
  try {
    const previous = await readProtectedRuntimeConfig(bundleFile);
    if (previous.TANDEM_ENROLLMENT_TOKEN) await store.revoke(previous.TANDEM_ENROLLMENT_TOKEN);
  } catch {
    /* Missing or already-consumed bundle. Unsafe files are overwritten only
     * after the store has produced a fresh, protected invitation. */
  }
  const invitation = await store.create();
  await writeProtectedRuntimeConfig(bundleFile, {
    TANDEM_HUB_URL: hubUrl,
    TANDEM_ENROLLMENT_TOKEN: invitation.token,
    TANDEM_ENROLLMENT_EXPIRES_AT: String(invitation.expiresAt),
  });
  process.stdout.write("created protected one-time enrollment bundle\n");
}

async function consumeBundle(bundleFile: string): Promise<void> {
  const bundle = await readProtectedRuntimeConfig(bundleFile);
  const hubUrl = bundle.TANDEM_HUB_URL;
  const invitationToken = bundle.TANDEM_ENROLLMENT_TOKEN;
  const expiresAt = Number(bundle.TANDEM_ENROLLMENT_EXPIRES_AT);
  if (!hubUrl || !invitationToken || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("enrollment bundle is invalid or expired");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(enrollmentEndpoint(hubUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${invitationToken}` },
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const rawBody = await boundedBody(response);
  if (!response.ok) throw new Error("hub rejected or could not complete enrollment");
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new Error("hub returned an invalid enrollment response");
  }
  const enrolled = EnrollmentResponseSchema.parse(decoded);

  const deviceId = required("TANDEM_SETUP_DEVICE_ID");
  const deviceName = required("TANDEM_SETUP_DEVICE_NAME");
  const allowlist = required("TANDEM_SETUP_ALLOWLIST");
  const enabledEngines = process.env.TANDEM_SETUP_ENABLED_ENGINES?.trim() ?? "";
  const configFile = required("TANDEM_SETUP_DEVICE_CONFIG");
  validateDeviceId(deviceId);
  validateDeviceName(deviceName);
  buildEnabledEngines(enabledEngines);

  await writeProtectedRuntimeConfig(configFile, {
    TANDEM_HUB_URL: hubUrl,
    TANDEM_FLEET_TOKEN: enrolled.fleetToken,
    TANDEM_DEVICE_ID: deviceId,
    TANDEM_DEVICE_NAME: deviceName,
    TANDEM_CWD_ALLOWLIST: allowlist,
    TANDEM_ENABLED_ENGINES: enabledEngines,
    TANDEM_DEVICE_READY_FILE: required("TANDEM_SETUP_READY_FILE"),
  });

  try {
    await unlink(path.resolve(bundleFile));
  } catch {
    await writeProtectedFile(bundleFile, "consumed\n");
  }
  process.stdout.write("device enrollment consumed and protected configuration written\n");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const file = process.argv[3];
  if (!file || (command !== "create" && command !== "consume")) {
    throw new Error("usage: enrollment-cli.ts create|consume <protected-file>");
  }
  if (command === "create") await createBundle(file);
  else await consumeBundle(file);
}

main().catch((error) => {
  void error;
  console.error("tandem enrollment failed");
  process.exit(1);
});
