#!/usr/bin/env node
// Fixed, private H1 data plane. Root owns admission, the pipe, and target destruction.
import { Buffer } from "node:buffer";
import { createPublicKey, randomBytes } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import { pathToFileURL, URL } from "node:url";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateProducerCryptoAuthorization } from "../../packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs";
import { createPostgresSnapshotSource } from "../../packages/release-foundation/src/snapshot/postgres-source.mjs";
import { createPostgresSanitizationWorkspace } from "../../packages/release-foundation/src/snapshot/postgres-workspace.mjs";
import {
  createNativePostgresSnapshotToolCallbacks,
  expandNativePostgresSnapshotArchive
} from "./snapshot-postgres-tools.mjs";
import { runProtectedSnapshotEncryption } from "./export-sanitized-snapshot.mjs";

const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { Client } = requireApi("pg");
const WORKSPACE = "/work/crypto";
const MAX_CONFIG = 1048576;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const sourceName = "subscription_saas_staging";
const workspaceName = "stage1_snapshot_workspace";
const sourceRole = "stage1_snapshot_reader";
const workspaceRole = "stage1_snapshot_migrate";
const IDENTITY_SQL = `SELECT current_database() AS database_name,
 (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
 (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
 current_user AS role_name, session_user AS session_role, pg_backend_pid() AS backend_pid`;
const err = (code) => Object.assign(new Error(code), { code });
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

function channel(input) {
  let buffer = Buffer.alloc(0);
  const queue = [];
  let ended = false;
  let invalid = false;
  let wake;
  const notify = () => {
    if (wake) {
      const next = wake;
      wake = null;
      next();
    }
  };
  input.on("data", (chunk) => {
    if (invalid) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_CONFIG + 4096) {
      invalid = true;
      notify();
      return;
    }
    for (;;) {
      const index = buffer.indexOf(10);
      if (index < 0) break;
      queue.push(buffer.subarray(0, index));
      buffer = Buffer.from(buffer.subarray(index + 1));
      if (queue.length > 2) {
        invalid = true;
        break;
      }
    }
    notify();
  });
  input.on("end", () => {
    ended = true;
    notify();
  });
  input.on("error", () => {
    invalid = true;
    notify();
  });
  const wait = (remaining) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, remaining);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const empty = () => !invalid && queue.length === 0 && buffer.length === 0;
  return {
    async next(limit, timeout) {
      const deadline = Date.now() + timeout;
      while (!queue.length && !ended && !invalid) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await wait(remaining);
      }
      if (invalid || !queue.length || queue[0].length > limit) throw err("H1_PIPE_INVALID");
      const line = queue.shift();
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch {
        throw err("H1_PIPE_INVALID");
      }
    },
    noExtra: empty,
    async seal(timeout) {
      const deadline = Date.now() + timeout;
      while (!ended && empty()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await wait(remaining);
      }
      if (!ended || !empty()) throw err("H1_PIPE_INVALID");
    }
  };
}

function configure(value, validateAuthorization) {
  if (
    !keys(value, ["kind", "authorization", "publicKey", "source", "workspace"]) ||
    value.kind !== "configure" ||
    !keys(value.source, ["port", "password", "identityFingerprint"]) ||
    !keys(value.workspace, ["port", "password", "identityFingerprint"]) ||
    typeof value.publicKey !== "string" ||
    value.publicKey.length > 16384 ||
    !value.authorization ||
    typeof value.authorization !== "object"
  )
    throw err("H1_CONFIG_INVALID");
  const owned = JSON.parse(JSON.stringify(value));
  for (const part of [owned.source, owned.workspace]) {
    if (
      !Number.isInteger(part.port) ||
      part.port < 1 ||
      part.port > 65535 ||
      typeof part.password !== "string" ||
      part.password.length < 1 ||
      part.password.length > 1024 ||
      /[\r\n\0]/u.test(part.password) ||
      !FINGERPRINT.test(part.identityFingerprint ?? "")
    )
      throw err("H1_CONFIG_INVALID");
  }
  if (
    owned.source.port === owned.workspace.port ||
    owned.source.identityFingerprint === owned.workspace.identityFingerprint
  )
    throw err("H1_CONFIG_INVALID");
  try {
    validateAuthorization(owned.authorization);
  } catch {
    throw err("H1_AUTHORIZATION_INVALID");
  }
  const auth = owned.authorization;
  if (
    auth.schemaVersion !== "producer-crypto-run-authorization.v2" ||
    auth.repository?.name !== "keqi119/subscription-Saas" ||
    auth.repository?.id !== "1253231368" ||
    !Number.isFinite(Date.parse(auth.notBefore)) ||
    !Number.isFinite(Date.parse(auth.notAfter)) ||
    Date.now() < Date.parse(auth.notBefore) ||
    Date.now() >= Date.parse(auth.notAfter) ||
    typeof auth.snapshotRunId !== "string" ||
    !/^[1-9][0-9]*$/u.test(auth.snapshotRunId) ||
    typeof auth.releaseAttemptId !== "string" ||
    !auth.releaseAttemptId
  )
    throw err("H1_AUTHORIZATION_INVALID");
  return owned;
}

async function assertRuntime() {
  if (process.platform !== "linux" || process.getuid() !== 65532 || process.getgid() !== 65532)
    throw err("H1_RUNTIME_INVALID");
  const stat = await lstat(WORKSPACE);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 65532 ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(WORKSPACE)) !== WORKSPACE
  )
    throw err("H1_WORKSPACE_INVALID");
}

async function readContracts() {
  const [contract, ownershipMap] = await Promise.all([
    readFile(
      new URL("../../release/contracts/sanitization-contract.v1.json", import.meta.url),
      "utf8"
    ).then(JSON.parse),
    readFile(
      new URL("../../release/contracts/snapshot-ownership-map.v1.json", import.meta.url),
      "utf8"
    ).then(JSON.parse)
  ]);
  return { contract, ownershipMap };
}

async function physicalIdentity(client, expectedName, expectedRole, expectedFingerprint) {
  const result = await client.query(IDENTITY_SQL);
  const row = result?.rows?.[0];
  if (
    result.rows.length !== 1 ||
    row?.database_name !== expectedName ||
    row.role_name !== expectedRole ||
    row.session_role !== expectedRole ||
    row.backend_pid !== client.processID ||
    !/^\d+$/u.test(row.database_oid ?? "") ||
    !/^\d+$/u.test(row.system_identifier ?? "")
  )
    throw err("H1_DATABASE_IDENTITY_INVALID");
  const actual = sha256Canonical({
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    systemIdentifier: row.system_identifier
  });
  if (actual !== expectedFingerprint) throw err("H1_DATABASE_IDENTITY_INVALID");
  return row.backend_pid;
}

function connection(ClientType, port, database, role, password, source) {
  return new ClientType({
    host: "127.0.0.1",
    port,
    database,
    user: role,
    password,
    ssl: false,
    connectionTimeoutMillis: 5000,
    query_timeout: 120000,
    statement_timeout: 120000,
    application_name: source ? "stage1-snapshot-source" : "stage1-snapshot-workspace",
    options: source ? "-c default_transaction_read_only=on" : "-c statement_timeout=120000"
  });
}

async function writeLine(output, value) {
  await new Promise((resolve, reject) =>
    output.write(`${JSON.stringify(value)}\n`, (cause) => (cause ? reject(cause) : resolve()))
  );
}

const DEFAULT_DEPS = {
  Client,
  assertRuntime,
  readContracts,
  validateAuthorization: validateProducerCryptoAuthorization,
  parsePublicKey: createPublicKey,
  createSource: createPostgresSnapshotSource,
  createWorkspace: createPostgresSanitizationWorkspace,
  createNativeTools: createNativePostgresSnapshotToolCallbacks,
  expandArchive: expandNativePostgresSnapshotArchive,
  runEncryption: runProtectedSnapshotEncryption
};

// The dependency argument is a private test seam. CLI input cannot select dependencies.
export async function runH1DataWorker({ input, output, deps = DEFAULT_DEPS } = {}) {
  const pipe = channel(input);
  let sourceClient, workspaceClient, source, workspace, tokenizationKey;
  let failure,
    result,
    destroyRequested = false,
    workspaceDestroyed = false,
    connectionError = false;
  try {
    await deps.assertRuntime();
    const c = configure(await pipe.next(MAX_CONFIG, 30000), deps.validateAuthorization);
    if (
      !/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/u.test(
        c.publicKey
      )
    )
      throw err("H1_PUBLIC_KEY_INVALID");
    const publicKey = deps.parsePublicKey(c.publicKey);
    if (
      publicKey?.type !== "public" ||
      publicKey.asymmetricKeyType !== "rsa" ||
      publicKey.asymmetricKeyDetails?.modulusLength !== 3072 ||
      publicKey.asymmetricKeyDetails?.publicExponent !== 65537n ||
      sha256Bytes(publicKey.export({ type: "spki", format: "der" })) !==
        c.authorization.localKey?.keyFingerprint
    )
      throw err("H1_PUBLIC_KEY_INVALID");
    const { contract, ownershipMap } = await deps.readContracts();
    sourceClient = connection(
      deps.Client,
      c.source.port,
      sourceName,
      sourceRole,
      c.source.password,
      true
    );
    workspaceClient = connection(
      deps.Client,
      c.workspace.port,
      workspaceName,
      workspaceRole,
      c.workspace.password,
      false
    );
    sourceClient.on("error", () => {
      connectionError = true;
    });
    workspaceClient.on("error", () => {
      connectionError = true;
    });
    await sourceClient.connect();
    await workspaceClient.connect();
    await physicalIdentity(sourceClient, sourceName, sourceRole, c.source.identityFingerprint);
    const backendPid = await physicalIdentity(
      workspaceClient,
      workspaceName,
      workspaceRole,
      c.workspace.identityFingerprint
    );
    const sourceTools = deps.createNativeTools({
      workspaceDirectory: WORKSPACE,
      port: c.source.port,
      databaseName: sourceName,
      roleName: sourceRole,
      password: c.source.password,
      purpose: "source"
    });
    const workspaceTools = deps.createNativeTools({
      workspaceDirectory: WORKSPACE,
      port: c.workspace.port,
      databaseName: workspaceName,
      roleName: workspaceRole,
      password: c.workspace.password,
      purpose: "workspace"
    });
    source = deps.createSource({ client: sourceClient, exportDump: sourceTools.exportDump });
    tokenizationKey = randomBytes(32);
    workspace = deps.createWorkspace({
      client: workspaceClient,
      sourceDatabaseIdentityFingerprint: c.source.identityFingerprint,
      workspaceDatabaseIdentityFingerprint: c.workspace.identityFingerprint,
      tokenizationKey,
      restoreDump: workspaceTools.restoreDump,
      exportDump: workspaceTools.exportDump,
      expandArchive: (input) => deps.expandArchive(input, { workspaceDirectory: WORKSPACE }),
      destroyResource: async () => {
        if (destroyRequested) throw err("H1_DESTROY_UNKNOWN");
        if (!pipe.noExtra()) throw err("H1_DESTROY_UNKNOWN");
        destroyRequested = true;
        const nonce = randomBytes(16).toString("hex");
        const binding = {
          snapshotRunId: c.authorization.snapshotRunId,
          releaseAttemptId: c.authorization.releaseAttemptId,
          backendPid,
          nonce
        };
        await writeLine(output, { kind: "workspace-destroy-request", ...binding });
        const ack = await pipe.next(4096, deps.ackTimeoutMs ?? 30000);
        if (
          !keys(ack, ["kind", ...Object.keys(binding)]) ||
          ack.kind !== "workspace-destroyed" ||
          Object.keys(binding).some((key) => ack[key] !== binding[key]) ||
          !pipe.noExtra()
        )
          throw err("H1_DESTROY_UNKNOWN");
        // EOF closes the two-message protocol before encryption; a point-in-time
        // empty-buffer check alone cannot reject delayed trailing bytes.
        await pipe.seal(deps.ackTimeoutMs ?? 30000);
        return { removed: true };
      }
    });
    result = await deps.runEncryption({
      request: {
        environmentClass: "staging",
        sourceSecretReference: "secret://stage1-snapshot-export/source",
        tokenizationSecretReference: "secret://stage1-snapshot-export/tokenization-key",
        workflowRunRef: `github://${c.authorization.repository.name}/actions/runs/${c.authorization.snapshotRunId}`
      },
      contract,
      ownershipMap,
      adapters: { trustPolicy: "protected-snapshot-adapters/v1", source, workspace },
      authorization: c.authorization,
      publicKey,
      workspaceDirectory: WORKSPACE
    });
    if (
      connectionError ||
      !destroyRequested ||
      !pipe.noExtra() ||
      result?.ciphertextPath !== `${WORKSPACE}/snapshot.enc`
    )
      throw err("H1_RESULT_INVALID");
  } catch (cause) {
    failure =
      typeof cause?.code === "string" && /^H1_[A-Z0-9_]{1,97}$/u.test(cause.code)
        ? cause.code
        : "H1_WORKER_FAILED";
  }
  try {
    if (source) await source.closeSnapshot();
    else if (sourceClient) await sourceClient.end();
  } catch {
    failure = "H1_CLEANUP_UNKNOWN";
  }
  try {
    if (workspace) {
      await workspace.destroy();
      workspaceDestroyed = true;
    } else if (workspaceClient) await workspaceClient.end();
  } catch {
    failure = "H1_CLEANUP_UNKNOWN";
  }
  tokenizationKey?.fill(0);
  if (failure || !result) {
    await writeLine(output, { status: "FAILED", code: failure ?? "H1_WORKER_FAILED" });
    return false;
  }
  // A successful workspace.destroy() clears its private copy; the local buffer
  // is cleared above. This reports process-observable cleanup, not physical erasure.
  const keyCleanup = {
    tokenizationKeyBufferCleared: tokenizationKey?.every((byte) => byte === 0) === true,
    workspaceKeyBufferCleared: workspaceDestroyed,
    observedAt: new Date().toISOString()
  };
  if (!keyCleanup.tokenizationKeyBufferCleared || !keyCleanup.workspaceKeyBufferCleared) {
    await writeLine(output, { status: "FAILED", code: "H1_CLEANUP_UNKNOWN" });
    return false;
  }
  await writeLine(output, {
    status: "COMPLETE",
    keyCleanup,
    metadata: result.metadata,
    privilegeObservation: result.privilegeObservation,
    fingerprintObservation: result.fingerprintObservation,
    scan: result.scan,
    envelope: result.envelope,
    cryptoOperation: result.cryptoOperation,
    ciphertextPath: result.ciphertextPath
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) process.exitCode = 1;
  else
    runH1DataWorker({ input: process.stdin, output: process.stdout })
      .then((success) => {
        if (!success) {
          process.exitCode = 1;
          process.stdin.destroy();
        }
      })
      .catch(() => {
        process.stdout.write('{"status":"FAILED","code":"H1_WORKER_FAILED"}\n');
        process.exitCode = 1;
        process.stdin.destroy();
      });
}
