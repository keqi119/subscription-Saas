import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto, { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import fs, { createReadStream } from "node:fs";
import {
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rm,
  unlink as unlinkFile,
  writeFile
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  decryptSnapshotStream,
  encryptSnapshotStream,
  wipeKeyBuffer
} from "../src/snapshot/envelope-crypto.mjs";
import { validateSnapshotEncryptionEnvelope } from "../src/snapshot/producer-crypto-contracts.mjs";
import { sha256Canonical } from "../src/digest.mjs";

const keys = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
const keyFingerprint = `sha256:${createHash("sha256")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")}`;
function producerAuthorization(aad) {
  const now = Date.now();
  const context = Object.fromEntries(
    Object.entries(aad).filter(([key]) => !["snapshotAllocatedAt", "snapshotDigest"].includes(key))
  );
  const d = `sha256:${"a".repeat(64)}`;
  return {
    schemaVersion: "producer-crypto-run-authorization.v2",
    authorizationId: "fixture-local-authorization",
    executionPurpose: "qualification",
    repository: { name: "keqi119/subscription-Saas", id: aad.repositoryId },
    sourceSha: aad.sourceSha,
    releaseAttemptId: aad.releaseAttemptId,
    snapshotRunId: aad.snapshotRunId,
    snapshotAllocatedAt: aad.snapshotAllocatedAt,
    producer: {
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      runId: aad.snapshotRunId,
      runAttempt: 1,
      jobId: "snapshot-data",
      phase: "encryption",
      pendingDeploymentId: "fixture-deployment",
      environment: {
        name: "stage1-snapshot-export",
        id: "fixture-environment",
        policyIdentityDigest: d
      }
    },
    bindings: Object.fromEntries(
      [
        "dispatchAuthorizationDigest",
        "sourceGateEvidenceDigest",
        "buildProofDigest",
        "buildBundleDigest",
        "repositoryContractDigest",
        "adapterExecutableDigest",
        "cryptoExecutableDigest"
      ].map((key) => [key, d])
    ),
    issuer: {
      issuerId: "fixture-issuer",
      principal: "fixture-approver",
      cryptoPrincipal: "fixture-producer",
      publisherBrokerPrincipal: "fixture-publisher"
    },
    localKey: {
      kind: "local-rsa-oaep-sha256.v1",
      keyFingerprint,
      keyReadbackDigest: d,
      recoveryReadbackDigest: d,
      action: "local:GenerateAndWrapDataKey",
      keySpec: "AES_256",
      maxCalls: 1,
      context,
      contextDigest: sha256Canonical(context)
    },
    execution: { requestedDurationSeconds: 600, maxDurationSeconds: 900 },
    handoff: { protocol: "public-key-object-v1", publicKeyOnly: true, privateKey: false },
    prerequisites: Object.fromEntries(
      [
        "changePlanDigest",
        "externalChangeApprovalDigest",
        "applyProofDigest",
        "keyReadbackDigest",
        "recoveryReadbackDigest",
        "admissionPolicyReadbackDigest",
        "readbackDigest"
      ]
        .map((key) => [key, d])
        .concat([["completedAt", new Date(now - 2000).toISOString()]])
    ),
    issuedAt: new Date(now - 1000).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    notAfter: new Date(now + 899000).toISOString(),
    revocationPolicyDigest: d,
    custodyAuthorizationDigest: d
  };
}

test("v2 executes real local RSA envelope encryption and decrypts with the original producer authorization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-local-v2-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("sanitized snapshot fixture");
  const aad = expectedAad(bytes);
  const authorization = producerAuthorization(aad);
  const encrypted = join(directory, "snapshot.enc");
  const envelope = await encryptSnapshotStream({
    source: { open: () => Readable.from([bytes]) },
    destination: encrypted,
    aad,
    authorization,
    publicKey: keys.publicKey
  });
  assert.equal(envelope.schemaVersion, "snapshot-encryption-envelope.v2");
  assert.equal(envelope.authorizationDigest, sha256Canonical(authorization));
  const restored = join(directory, "restored.sql");
  await decryptSnapshotStream({
    source: replayableFile(encrypted).source,
    destination: restored,
    aad,
    authorization,
    envelope,
    privateKey: keys.privateKey
  });
  assert.deepEqual(await readFile(restored), bytes);
});

async function privateExportFixture(t, { cleanupFails = false } = {}) {
  const { runProtectedSnapshotEncryption } =
    await import("../../../scripts/release/export-sanitized-snapshot.mjs");
  const contract = JSON.parse(
    await readFile(
      new URL("../../../release/contracts/sanitization-contract.v1.json", import.meta.url),
      "utf8"
    )
  );
  const ownershipMap = JSON.parse(
    await readFile(
      new URL("../../../release/contracts/snapshot-ownership-map.v1.json", import.meta.url),
      "utf8"
    )
  );
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "snapshot-protected-v2-"));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const plaintext = Buffer.from("COPY public.customer (mobile) FROM stdin;\n\\.\n");
  const aad = {
    ...expectedAad(plaintext),
    sanitizationContractDigest: sha256Canonical(contract)
  };
  const authorization = producerAuthorization(aad);
  const events = [];
  const fingerprint = {
    migrationHead: contract.source.knownMigrationHeads.at(-1),
    databaseIdentityFingerprint: `sha256:${"2".repeat(64)}`,
    roleIdentityFingerprint: `sha256:${"1".repeat(64)}`,
    tables: contract.source.keyTables.map((table) => ({
      table,
      rowCount: 1,
      checksum: `sha256:${"3".repeat(64)}`
    }))
  };
  const source = {
    trustPolicy: "protected-snapshot-source/v1",
    async observePrivileges() {
      events.push("observed");
      return {
        roleIdentityFingerprint: fingerprint.roleIdentityFingerprint,
        databaseIdentityFingerprint: fingerprint.databaseIdentityFingerprint,
        superuser: false,
        createDatabase: false,
        createRole: false,
        bypassRls: false,
        schemaOwner: false,
        canCreateSchema: false,
        tableWritePrivileges: [],
        tableTruncatePrivileges: [],
        writableFunctionExecutePrivileges: [],
        objectOwners: ["subscription"]
      };
    },
    async openReadOnlySnapshot() {
      events.push("opened");
      return {
        snapshotId: "00000003-0000001A-1",
        isolationLevel: "REPEATABLE READ",
        readOnly: true
      };
    },
    async readFingerprint() {
      return fingerprint;
    },
    async exportRaw() {
      return Buffer.from("PGDMP\0synthetic raw");
    },
    async closeSnapshot() {
      events.push("closed");
    }
  };
  const workspace = {
    trustPolicy: "isolated-sanitization-workspace/v1",
    async restoreRaw() {},
    async applyTransformations() {},
    async exportSanitized() {
      return Buffer.from(plaintext);
    },
    async destroy() {
      events.push("destroyed");
      if (cleanupFails) throw new Error("synthetic cleanup failure");
    }
  };
  const request = {
    environmentClass: "staging",
    sourceSecretReference: "secret://stage1-snapshot-export/source",
    tokenizationSecretReference: "secret://stage1-snapshot-export/tokenization-key",
    workflowRunRef: `github://${authorization.repository.name}/actions/runs/${authorization.snapshotRunId}`
  };
  return {
    runProtectedSnapshotEncryption,
    contract,
    ownershipMap,
    workspaceDirectory,
    authorization,
    publicKey: keys.publicKey,
    request,
    adapters: { trustPolicy: "protected-snapshot-adapters/v1", source, workspace },
    plaintext,
    events,
    aad
  };
}

function encryptionInput(f) {
  return {
    request: f.request,
    contract: f.contract,
    ownershipMap: f.ownershipMap,
    adapters: f.adapters,
    authorization: f.authorization,
    publicKey: f.publicKey,
    workspaceDirectory: f.workspaceDirectory
  };
}

test("protected private bundle encrypts the cleaned scan result with its allocated v2 identity", async (t) => {
  const f = await privateExportFixture(t);
  const started = Date.now();
  const result = await f.runProtectedSnapshotEncryption(encryptionInput(f));
  const finished = Date.now();
  assert.equal(result.metadata.dumpDigest, digest(f.plaintext));
  assert.equal(result.metadata.createdAt, f.authorization.snapshotAllocatedAt);
  assert.equal(result.envelope.expiresAt, result.metadata.expiresAt);
  assert.equal(result.cryptoOperation.action, "local:GenerateAndWrapDataKey");
  assert.equal(result.cryptoOperation.callCount, 1);
  assert.equal(result.cryptoOperation.outcome, "SUCCESS");
  assert.equal(result.cryptoOperation.envelopeDigest, sha256Canonical(result.envelope));
  assert.equal(result.cryptoOperation.keyBufferClear, "BEST_EFFORT_COMPLETED");
  assert.match(result.cryptoOperation.requestId, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(result.cryptoOperation.startedAt) >= started);
  assert.ok(Date.parse(result.cryptoOperation.finishedAt) <= finished);
  assert.ok(
    Date.parse(result.cryptoOperation.finishedAt) >= Date.parse(result.cryptoOperation.startedAt)
  );
  // Real fixture encryption above; host observations below are explicitly unit
  // fixtures for the private proof assembler, never production attestation.
  const { buildH1CryptoUseProof } =
    await import("../../../scripts/release/snapshot-h1-data-proof.mjs");
  const before = new Date(started).toISOString(),
    after = new Date(finished).toISOString();
  const memory = (observedAt) => ({
    observedAt,
    hostSwapDisabled: true,
    coreDumpDisabled: true,
    swapTableDigest: sha256Canonical([]),
    corePatternDigest: sha256Canonical("|/bin/false"),
    coreLimit: [0, 0]
  });
  const observation = {
    attemptId: f.authorization.releaseAttemptId,
    snapshotRunId: f.authorization.snapshotRunId,
    authorizationDigest: sha256Canonical(f.authorization),
    workerBundleDigest: f.authorization.bindings.cryptoExecutableDigest,
    issuedAt: before,
    expiresAt: new Date(started + 60000).toISOString(),
    memoryBefore: memory(before),
    memoryAfter: memory(after),
    processExit: {
      workerId: "a".repeat(64),
      image:
        "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0",
      startedAt: before,
      finishedAt: after,
      observedAt: after,
      exitCode: 0,
      signal: null,
      oomKilled: false,
      stdoutClosed: true,
      toolExitCode: 0
    }
  };
  const cleanup = Object.fromEntries(
    [
      "runnerStopped",
      "controlStopped",
      "producerStopped",
      "runnerNotRoutable",
      "githubTokenRevoked",
      "volumeDestroyed"
    ].map((key) => [key, true])
  );
  const volume = {
    attemptId: f.authorization.releaseAttemptId,
    destroyed: true,
    keyslotsBefore: [0],
    keyslotsAfter: [],
    oldKeyRejected: true,
    destroyedAt: after
  };
  const terminal = {
    observedAt: after,
    cleanupFactsDigest: sha256Canonical(cleanup),
    volumeObservationDigest: sha256Canonical(volume),
    runningJobObservationDigest: sha256Canonical({ fixture: true })
  };
  const input = {
    authorization: f.authorization,
    data: { status: "COMPLETE", ...result },
    observation,
    terminal,
    cleanup,
    volume
  };
  const proof = buildH1CryptoUseProof(input);
  assert.equal(proof.cleanup.memoryLocked, false);
  assert.equal(proof.cleanup.hostSwapDisabled, true);
  assert.equal(proof.dataObservationDigest, sha256Canonical(observation));
  for (const change of [
    (x) => {
      x.observation.processExit.exitCode = 1;
    },
    (x) => {
      x.observation.memoryAfter.hostSwapDisabled = false;
    },
    (x) => {
      x.cleanup.runnerNotRoutable = false;
    }
  ]) {
    const invalid = structuredClone(input);
    change(invalid);
    assert.throws(() => buildH1CryptoUseProof(invalid), { code: "H1_DATA_PROOF_REJECTED" });
  }
  for (const observedAt of [
    result.privilegeObservation.observedAt,
    result.fingerprintObservation.provenance.observedAt,
    result.scan.scannedAt
  ]) {
    assert.ok(Date.parse(observedAt) >= started && Date.parse(observedAt) <= finished);
    assert.notEqual(observedAt, f.authorization.snapshotAllocatedAt);
  }
  assert.deepEqual(f.events.slice(-2), ["closed", "destroyed"]);
  assert.equal("dump" in result, false);
  assert.equal(result.ciphertextPath, join(f.workspaceDirectory, "snapshot.enc"));
  assert.deepEqual(await readdir(f.workspaceDirectory), ["snapshot.enc"]);
  const restored = join(f.workspaceDirectory, "restored.sql");
  await decryptSnapshotStream({
    source: replayableFile(result.ciphertextPath).source,
    destination: restored,
    aad: f.aad,
    authorization: f.authorization,
    envelope: result.envelope,
    privateKey: keys.privateKey
  });
  assert.deepEqual(await readFile(restored), f.plaintext);
});

test("protected encryption rejects changed run or contract and cleanup failure before ciphertext", async (t) => {
  for (const kind of ["run", "contract", "cleanup"]) {
    const f = await privateExportFixture(t, { cleanupFails: kind === "cleanup" });
    const input = encryptionInput(f);
    if (kind === "run")
      input.request.workflowRunRef = "github://keqi119/subscription-Saas/actions/runs/9002";
    if (kind === "contract")
      input.authorization.localKey.context.sanitizationContractDigest = `sha256:${"0".repeat(64)}`;
    await assert.rejects(f.runProtectedSnapshotEncryption(input), {
      code:
        kind === "cleanup"
          ? "SNAPSHOT_SECURE_CLEANUP_FAILED"
          : "SNAPSHOT_ENCRYPTION_ADMISSION_INVALID"
    });
    assert.equal((await readdir(f.workspaceDirectory)).includes("snapshot.enc"), false);
    if (kind !== "cleanup") assert.deepEqual(f.events, []);
  }
});

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function expectedAad(bytes) {
  const allocated = Date.now() - 86_400_000;
  return {
    repositoryId: "1253231368",
    sourceSha: "b".repeat(40),
    releaseAttemptId: "attempt-20260903-001",
    snapshotRunId: "9001",
    sanitizationContractDigest: `sha256:${"1".repeat(64)}`,
    expiresAt: new Date(allocated + 30 * 86_400_000).toISOString(),
    snapshotAllocatedAt: new Date(allocated).toISOString(),
    snapshotDigest: digest(bytes)
  };
}

function replayableFile(path, { highWaterMark = 7 } = {}) {
  let opens = 0;
  return {
    source: {
      open() {
        opens += 1;
        return createReadStream(path, { highWaterMark });
      }
    },
    openCount: () => opens
  };
}

async function encryptedFixture(
  directory,
  plaintext,
  {
    stem = "fixture",
    aad = expectedAad(plaintext),
    authorization = producerAuthorization(aad)
  } = {}
) {
  const inputPath = join(directory, stem + ".sql"),
    ciphertextPath = join(directory, stem + ".enc");
  await writeFile(inputPath, plaintext);
  const envelope = await encryptSnapshotStream({
    source: replayableFile(inputPath).source,
    destination: ciphertextPath,
    aad,
    authorization,
    publicKey: keys.publicKey
  });
  return { aad, authorization, ciphertextPath, envelope, inputPath };
}

function serializedSecretScan(value, forbidden) {
  const pending = [value];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === null || entry === undefined) continue;
    if (typeof entry === "string") {
      for (const secret of forbidden) assert.equal(entry.includes(secret), false);
      continue;
    }
    if (typeof entry !== "object") continue;
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(/plaintext.*dek|access.*key|secret/i.test(key), false);
      pending.push(child);
    }
  }
}

async function childProcessRoundtrip(value) {
  const child = spawn(
    process.execPath,
    ["-e", "process.once('message', (value) => process.send(value))"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] }
  );
  const message = once(child, "message");
  child.send(value);
  const [received] = await message;
  child.disconnect();
  await once(child, "exit");
  return received;
}

async function withFileHandleFailure(directory, method, action) {
  const probePath = join(directory, `file-handle-probe-${method}`);
  const probe = await openFile(probePath, "wx", 0o600);
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype[method];
  await probe.close();
  await unlinkFile(probePath);
  prototype[method] = function injectedFileHandleFailure() {
    throw Object.assign(new Error("SENTINEL_RAW_FS_SECRET"), {
      secret: "SENTINEL_RAW_FS_SECRET"
    });
  };
  try {
    return await action();
  } finally {
    prototype[method] = original;
  }
}

async function withTemporaryUnlinkFailures(destination, failureCount, action) {
  const originalUnlink = fs.promises.unlink;
  let injectedFailures = 0;
  fs.promises.unlink = async function injectedUnlink(path) {
    if (
      String(path).includes(".snapshot-tmp-") &&
      fs.existsSync(destination) &&
      injectedFailures < failureCount
    ) {
      injectedFailures += 1;
      throw Object.assign(new Error("SENTINEL_UNLINK_SECRET"), {
        secret: "SENTINEL_UNLINK_SECRET"
      });
    }
    return originalUnlink(path);
  };
  syncBuiltinESMExports();
  try {
    return await action(() => injectedFailures);
  } finally {
    fs.promises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
}

async function withTemporaryNameReplacement(destination, replacement, action) {
  const originalUnlink = fs.promises.unlink;
  let temporaryPath;
  let temporaryUnlinkCalls = 0;
  fs.promises.unlink = async function replaceReleasedTemporaryName(path) {
    if (String(path).includes(".snapshot-tmp-") && fs.existsSync(destination)) {
      temporaryUnlinkCalls += 1;
      const result = await originalUnlink(path);
      if (temporaryUnlinkCalls === 1) {
        temporaryPath = String(path);
        await writeFile(temporaryPath, replacement, { flag: "wx" });
      }
      return result;
    }
    return originalUnlink(path);
  };
  syncBuiltinESMExports();
  try {
    return await action(() => ({ temporaryPath, temporaryUnlinkCalls }));
  } finally {
    fs.promises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
}

async function directoryFor(t) {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-local-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function producerOptions(directory, bytes, extra = {}) {
  const aad = expectedAad(bytes);
  return {
    source: { open: () => Readable.from([bytes]) },
    destination: join(directory, "output.enc"),
    aad,
    authorization: producerAuthorization(aad),
    publicKey: keys.publicKey,
    ...extra
  };
}
function consumerOptions(directory, fixture, extra = {}) {
  return {
    source: replayableFile(fixture.ciphertextPath).source,
    destination: join(directory, "restored.sql"),
    aad: fixture.aad,
    authorization: fixture.authorization,
    envelope: fixture.envelope,
    privateKey: keys.privateKey,
    ...extra
  };
}
async function observeKeys(action) {
  const held = [],
    originals = [crypto.createCipheriv, crypto.createDecipheriv];
  for (const [index, name] of ["createCipheriv", "createDecipheriv"].entries()) {
    crypto[name] = function (...args) {
      held.push(args[1]);
      return originals[index](...args);
    };
  }
  syncBuiltinESMExports();
  try {
    await action(held);
  } finally {
    crypto.createCipheriv = originals[0];
    crypto.createDecipheriv = originals[1];
    syncBuiltinESMExports();
  }
}
async function noTemps(directory) {
  assert.equal(
    (await readdir(directory)).some((name) => name.includes(".snapshot-tmp-")),
    false
  );
}
const fixtureDigest = "sha256:" + "f".repeat(64);

test("real random envelopes differ, roundtrip and clear actual producer and consumer DEKs", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("sanitized snapshot bytes".repeat(1000));
  await observeKeys(async (held) => {
    const a = await encryptedFixture(directory, bytes, { stem: "a" });
    const b = await encryptedFixture(directory, bytes, {
      stem: "b",
      aad: a.aad,
      authorization: a.authorization
    });
    assert.notEqual(a.envelope.wrappedDek.ciphertextBase64, b.envelope.wrappedDek.ciphertextBase64);
    assert.notEqual(a.envelope.nonceBase64, b.envelope.nonceBase64);
    assert.equal(Buffer.from(a.envelope.wrappedDek.ciphertextBase64, "base64").length, 384);
    assert.deepEqual(held[0], Buffer.alloc(32));
    assert.deepEqual(held[1], Buffer.alloc(32));
    await decryptSnapshotStream(consumerOptions(directory, a));
    assert.deepEqual(held[2], Buffer.alloc(32));
    assert.deepEqual(await readFile(join(directory, "restored.sql")), bytes);
    assert.equal(Object.isFrozen(a.envelope.gcmAad), true);
    const transferred = await childProcessRoundtrip(a.envelope);
    assert.deepEqual(transferred, a.envelope);
    serializedSecretScan(transferred, ["PRIVATE KEY", "SENTINEL_RAW_FS_SECRET"]);
    await noTemps(directory);
  });
});

test("producer freezes authorization and AAD before caller mutation during awaits", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture");
  const options = producerOptions(directory, bytes),
    original = structuredClone(options.authorization);
  options.source.open = () => {
    options.authorization.localKey.context.sourceSha = "c".repeat(40);
    options.authorization.prerequisites.keyReadbackDigest = fixtureDigest;
    options.aad.snapshotDigest = fixtureDigest;
    return Readable.from([bytes]);
  };
  const envelope = await encryptSnapshotStream(options);
  assert.equal(envelope.authorizationDigest, sha256Canonical(original));
  validateSnapshotEncryptionEnvelope(envelope, { authorization: original });
});

test("consumer freezes original authorization, envelope and AAD before caller mutation", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture"),
    f = await encryptedFixture(directory, bytes);
  const options = consumerOptions(directory, f);
  options.envelope = structuredClone(options.envelope);
  options.source.open = () => {
    options.authorization.localKey.keyFingerprint = fixtureDigest;
    options.aad.snapshotDigest = fixtureDigest;
    options.envelope.authenticationTagBase64 = Buffer.alloc(16).toString("base64");
    return createReadStream(f.ciphertextPath);
  };
  await decryptSnapshotStream(options);
  assert.deepEqual(await readFile(options.destination), bytes);
});

test("producer checks actual approval time; consumer accepts an expired original producer window only while object remains valid", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture");
  const aad = expectedAad(bytes),
    authorization = producerAuthorization(aad),
    base = Date.now() - 3_600_000;
  authorization.prerequisites.completedAt = new Date(base - 2000).toISOString();
  authorization.issuedAt = authorization.notBefore = new Date(base - 1000).toISOString();
  authorization.notAfter = new Date(base + 899000).toISOString();
  let opens = 0;
  await assert.rejects(
    encryptSnapshotStream({
      ...producerOptions(directory, bytes),
      aad,
      authorization,
      source: {
        open() {
          opens++;
          return Readable.from([bytes]);
        }
      }
    }),
    { code: "SNAPSHOT_AUTHORIZATION_WINDOW_CLOSED" }
  );
  assert.equal(opens, 0);
  const realNow = Date.now;
  let f;
  try {
    Date.now = () => base;
    f = await encryptedFixture(directory, bytes, { aad, authorization });
  } finally {
    Date.now = realNow;
  }
  await decryptSnapshotStream(consumerOptions(directory, f));
  assert.deepEqual(await readFile(join(directory, "restored.sql")), bytes);
  try {
    Date.now = () => Date.parse(aad.expiresAt);
    await assert.rejects(
      decryptSnapshotStream(
        consumerOptions(directory, f, { destination: join(directory, "expired.sql") })
      ),
      { code: "SNAPSHOT_EXPIRED" }
    );
  } finally {
    Date.now = realNow;
  }
});

test("v1 and provider execution options, hidden properties, getters and missing expected AAD fail closed", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture");
  for (const name of ["kms", "provider", "nonce", "privateKey"]) {
    await assert.rejects(
      encryptSnapshotStream(producerOptions(directory, bytes, { [name]: undefined })),
      { code: "SNAPSHOT_CRYPTO_OPTIONS_INVALID" }
    );
  }
  const options = producerOptions(directory, bytes);
  options.authorization.schemaVersion = "producer-crypto-run-authorization.v1";
  await assert.rejects(encryptSnapshotStream(options), { code: "SNAPSHOT_AUTHORIZATION_INVALID" });
  let getterCalls = 0;
  for (const target of ["aad", "authorization"]) {
    const option = producerOptions(directory, bytes);
    Object.defineProperty(option[target], "hidden", {
      get() {
        getterCalls++;
        return "secret";
      },
      enumerable: false
    });
    await assert.rejects(encryptSnapshotStream(option));
  }
  assert.equal(getterCalls, 0);
  for (const target of ["source", "limits"]) {
    const option = producerOptions(directory, bytes, { limits: {} });
    Object.defineProperty(option[target], "hidden", { value: "secret", enumerable: false });
    await assert.rejects(encryptSnapshotStream(option), {
      code: target === "source" ? "SNAPSHOT_SOURCE_REPLAY_REQUIRED" : "SNAPSHOT_LIMITS_INVALID"
    });
  }
  const f = await encryptedFixture(directory, bytes);
  await assert.rejects(decryptSnapshotStream(consumerOptions(directory, f, { aad: undefined })), {
    code: "SNAPSHOT_AAD_REQUIRED"
  });
  await assert.rejects(
    decryptSnapshotStream(
      consumerOptions(directory, f, {
        envelope: { ...f.envelope, schemaVersion: "snapshot-encryption-envelope.v1" }
      })
    ),
    { code: "SNAPSHOT_ENVELOPE_INVALID" }
  );
});

test("scanned digest and deterministic readback metadata fail before replay", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture"),
    options = producerOptions(directory, bytes);
  let opens = 0;
  options.source.open = () => {
    opens++;
    return Readable.from([Buffer.from("different")]);
  };
  await assert.rejects(encryptSnapshotStream(options), { code: "SNAPSHOT_DIGEST_MISMATCH" });
  assert.equal(opens, 1);
  for (const change of [
    (auth) => (auth.localKey.contextDigest = fixtureDigest),
    (auth) => (auth.localKey.recoveryReadbackDigest = fixtureDigest)
  ]) {
    const option = producerOptions(directory, bytes);
    change(option.authorization);
    await assert.rejects(encryptSnapshotStream(option), { code: "SNAPSHOT_AUTHORIZATION_INVALID" });
  }
  await noTemps(directory);
});

test("wrong public or private KeyObjects cannot execute and native errors are redacted", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture");
  await assert.rejects(
    encryptSnapshotStream(producerOptions(directory, bytes, { publicKey: keys.privateKey })),
    { code: "SNAPSHOT_LOCAL_KEY_GENERATE_FAILED" }
  );
  const f = await encryptedFixture(directory, bytes),
    wrong = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
  await assert.rejects(
    decryptSnapshotStream(consumerOptions(directory, f, { privateKey: wrong.privateKey })),
    { code: "SNAPSHOT_LOCAL_KEY_DECRYPT_FAILED" }
  );
  await noTemps(directory);
  assert.equal(fs.existsSync(join(directory, "restored.sql")), false);
});

test("ciphertext, truncation, tag, nonce, wrapped key, AAD and authorization tampering never publish plaintext", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture".repeat(100)),
    f = await encryptedFixture(directory, bytes);
  const original = await readFile(f.ciphertextPath);
  for (const altered of [
    original.subarray(0, original.length - 1),
    Buffer.from(original).fill(1, 0, 1)
  ]) {
    await writeFile(f.ciphertextPath, altered);
    await assert.rejects(decryptSnapshotStream(consumerOptions(directory, f)), {
      code: "SNAPSHOT_CIPHERTEXT_MISMATCH"
    });
  }
  await writeFile(f.ciphertextPath, original);
  await observeKeys(async (held) => {
    for (const [field, size] of [
      ["authenticationTagBase64", 16],
      ["nonceBase64", 12]
    ]) {
      const envelope = structuredClone(f.envelope);
      envelope[field] = Buffer.alloc(size).toString("base64");
      await assert.rejects(decryptSnapshotStream(consumerOptions(directory, f, { envelope })), {
        code: "SNAPSHOT_AUTHENTICATION_FAILED"
      });
      assert.deepEqual(held.at(-1), Buffer.alloc(32));
    }
  });
  const envelope = structuredClone(f.envelope),
    wrapped = Buffer.from(envelope.wrappedDek.ciphertextBase64, "base64");
  wrapped[0] ^= 1;
  envelope.wrappedDek = { ciphertextBase64: wrapped.toString("base64"), digest: digest(wrapped) };
  await assert.rejects(decryptSnapshotStream(consumerOptions(directory, f, { envelope })), {
    code: "SNAPSHOT_LOCAL_KEY_DECRYPT_FAILED"
  });
  for (const altered of [
    { aad: { ...f.aad, snapshotDigest: fixtureDigest } },
    { envelope: { ...f.envelope, authorizationDigest: fixtureDigest } },
    { envelope: { ...f.envelope, ciphertextSizeBytes: original.length + 1 } }
  ])
    await assert.rejects(decryptSnapshotStream(consumerOptions(directory, f, altered)));
  await noTemps(directory);
  assert.equal(fs.existsSync(join(directory, "restored.sql")), false);
});

test("producer replay mutation and replay acquisition failure wipe DEKs and remove private temps", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture");
  await observeKeys(async (held) => {
    for (const mutation of [true, false]) {
      let opens = 0;
      const options = producerOptions(directory, bytes, {
        source: {
          open() {
            if (++opens === 1) return Readable.from([bytes]);
            if (mutation) return Readable.from([Buffer.from("changed")]);
            throw new Error("SENTINEL_SOURCE_SECRET");
          }
        }
      });
      await assert.rejects(encryptSnapshotStream(options), {
        code: mutation ? "SNAPSHOT_SOURCE_CHANGED" : "SNAPSHOT_SOURCE_OPEN_FAILED"
      });
      assert.deepEqual(held.at(-1), Buffer.alloc(32));
      await noTemps(directory);
    }
  });
});

test("consumer detects ciphertext mutation after prevalidation", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture"),
    f = await encryptedFixture(directory, bytes);
  let opens = 0;
  await assert.rejects(
    decryptSnapshotStream(
      consumerOptions(directory, f, {
        source: {
          open() {
            if (++opens === 1) return createReadStream(f.ciphertextPath);
            return Readable.from([Buffer.from("changed")]);
          }
        }
      })
    ),
    { code: "SNAPSHOT_AUTHENTICATION_FAILED" }
  );
  await noTemps(directory);
  assert.equal(fs.existsSync(join(directory, "restored.sql")), false);
});

test("existing and racing producer and consumer destinations are preserved", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture"),
    sentinel = Buffer.from("other actor"),
    f = await encryptedFixture(directory, bytes);
  for (const decrypt of [false, true]) {
    const options = decrypt ? consumerOptions(directory, f) : producerOptions(directory, bytes),
      action = decrypt ? decryptSnapshotStream : encryptSnapshotStream;
    await writeFile(options.destination, sentinel);
    await assert.rejects(action(options), { code: "SNAPSHOT_DESTINATION_EXISTS" });
    assert.deepEqual(await readFile(options.destination), sentinel);
    await unlinkFile(options.destination);
    let opens = 0;
    options.source = {
      async open() {
        if (++opens === 2) await writeFile(options.destination, sentinel, { flag: "wx" });
        return decrypt ? createReadStream(f.ciphertextPath) : Readable.from([bytes]);
      }
    };
    await assert.rejects(action(options), { code: "SNAPSHOT_DESTINATION_EXISTS" });
    assert.deepEqual(await readFile(options.destination), sentinel);
    await unlinkFile(options.destination);
    await noTemps(directory);
  }
});

test("stream and envelope byte caps allow only downward overrides", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture".repeat(100));
  for (const limits of [{ maxCiphertextBytes: bytes.length - 1 }, { maxEnvelopeBytes: 1 }]) {
    await assert.rejects(encryptSnapshotStream(producerOptions(directory, bytes, { limits })));
    await noTemps(directory);
    assert.equal(fs.existsSync(join(directory, "output.enc")), false);
  }
  for (const limits of [
    { maxCiphertextBytes: 1073741825 },
    { maxEnvelopeBytes: 1048577 },
    { maxCiphertextBytes: 0 },
    { extra: true }
  ])
    await assert.rejects(encryptSnapshotStream(producerOptions(directory, bytes, { limits })), {
      code: "SNAPSHOT_LIMITS_INVALID"
    });
  const f = await encryptedFixture(directory, bytes);
  await assert.rejects(
    decryptSnapshotStream(
      consumerOptions(directory, f, { limits: { maxCiphertextBytes: bytes.length - 1 } })
    )
  );
});

test("pre-abort, first-pass and second-pass abort stop IO and wipe actual DEKs", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture".repeat(100));
  for (const boundary of [0, 1, 2]) {
    const controller = new AbortController();
    let opens = 0;
    if (boundary === 0) controller.abort();
    await observeKeys(async (held) => {
      const options = producerOptions(directory, bytes, {
        signal: controller.signal,
        source: {
          open() {
            if (++opens === boundary) controller.abort();
            return Readable.from([bytes]);
          }
        }
      });
      await assert.rejects(encryptSnapshotStream(options), { code: "SNAPSHOT_ABORTED" });
      assert.equal(opens, boundary);
      for (const key of held) assert.deepEqual(key, Buffer.alloc(32));
    });
    await noTemps(directory);
  }
  const f = await encryptedFixture(directory, bytes),
    controller = new AbortController();
  let opens = 0;
  await observeKeys(async (held) => {
    await assert.rejects(
      decryptSnapshotStream(
        consumerOptions(directory, f, {
          signal: controller.signal,
          source: {
            open() {
              if (++opens === 2) controller.abort();
              return createReadStream(f.ciphertextPath);
            }
          }
        })
      ),
      { code: "SNAPSHOT_ABORTED" }
    );
    assert.deepEqual(held[0], Buffer.alloc(32));
  });
  await noTemps(directory);
});

test("mid-stream producer and consumer abort removes private partial output and wipes DEKs", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture".repeat(100));
  const f = await encryptedFixture(directory, bytes);
  for (const decrypt of [false, true]) {
    const options = decrypt ? consumerOptions(directory, f) : producerOptions(directory, bytes);
    const controller = new AbortController();
    options.signal = controller.signal;
    const input = decrypt ? await readFile(f.ciphertextPath) : bytes;
    let opens = 0;
    options.source = {
      open() {
        if (++opens === 1) return Readable.from([input]);
        return Readable.from(
          (async function* () {
            yield input.subarray(0, 10);
            controller.abort();
            yield input.subarray(10);
          })()
        );
      }
    };
    await observeKeys(async (held) => {
      await assert.rejects((decrypt ? decryptSnapshotStream : encryptSnapshotStream)(options), {
        code: "SNAPSHOT_ABORTED"
      });
      assert.deepEqual(held[0], Buffer.alloc(32));
    });
    assert.equal(fs.existsSync(options.destination), false);
    await noTemps(directory);
  }
});

test("source and output setup failures redact raw secrets and preserve cleanup", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture"),
    f = await encryptedFixture(directory, bytes);
  await assert.rejects(
    encryptSnapshotStream(
      producerOptions(directory, bytes, {
        source: {
          open() {
            throw Object.assign(new Error("SENTINEL_SOURCE_SECRET"), {
              code: "SENTINEL_SOURCE_SECRET",
              safe: true
            });
          }
        }
      })
    ),
    { code: "SNAPSHOT_SOURCE_OPEN_FAILED" }
  );
  for (const decrypt of [false, true])
    for (const method of ["chmod", "createWriteStream"]) {
      const options = decrypt ? consumerOptions(directory, f) : producerOptions(directory, bytes);
      await observeKeys(async (held) => {
        await withFileHandleFailure(directory, method, async () => {
          await assert.rejects(
            (decrypt ? decryptSnapshotStream : encryptSnapshotStream)(options),
            (error) => {
              assert.equal(error.message.includes("SENTINEL"), false);
              assert.equal(error.code, "SNAPSHOT_DESTINATION_SETUP_FAILED");
              return true;
            }
          );
        });
        assert.deepEqual(held[0], Buffer.alloc(32));
      });
      await noTemps(directory);
    }
});

test("producer and consumer committed status survives transient and persistent cleanup errors", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture"),
    f = await encryptedFixture(directory, bytes);
  for (const decrypt of [false, true])
    for (const failureCount of [1, Infinity]) {
      const options = decrypt ? consumerOptions(directory, f) : producerOptions(directory, bytes);
      options.destination = join(directory, (decrypt ? "consumer" : "producer") + failureCount);
      await withTemporaryUnlinkFailures(options.destination, failureCount, async (attempts) => {
        await assert.rejects(
          (decrypt ? decryptSnapshotStream : encryptSnapshotStream)(options),
          (error) => {
            assert.equal(error.code, "SNAPSHOT_TEMP_CLEANUP_FAILED");
            assert.deepEqual(error.details, { outputCommitted: true });
            assert.equal(error.message.includes("SENTINEL"), false);
            return true;
          }
        );
        assert.equal(attempts() >= 1, true);
      });
      assert.equal(fs.existsSync(options.destination), true);
      if (decrypt) assert.deepEqual(await readFile(options.destination), bytes);
    }
});

test("producer and consumer preserve replacement at released temporary name", async (t) => {
  const directory = await directoryFor(t),
    bytes = Buffer.from("fixture"),
    replacement = Buffer.from("replacement actor"),
    options = producerOptions(directory, bytes);
  let envelope;
  await withTemporaryNameReplacement(options.destination, replacement, async (state) => {
    envelope = await encryptSnapshotStream(options);
    assert.equal(state().temporaryUnlinkCalls, 1);
    assert.deepEqual(await readFile(state().temporaryPath), replacement);
  });
  const consumer = {
    source: replayableFile(options.destination).source,
    destination: join(directory, "restored.sql"),
    envelope,
    aad: options.aad,
    authorization: options.authorization,
    privateKey: keys.privateKey
  };
  await withTemporaryNameReplacement(consumer.destination, replacement, async (state) => {
    await decryptSnapshotStream(consumer);
    assert.equal(state().temporaryUnlinkCalls, 1);
    assert.deepEqual(await readFile(state().temporaryPath), replacement);
  });
  assert.deepEqual(await readFile(consumer.destination), bytes);
});

test("wipeKeyBuffer performs explicitly best-effort mutable Buffer clearing", () => {
  const key = Buffer.alloc(32, 7);
  wipeKeyBuffer(key);
  assert.deepEqual(key, Buffer.alloc(32));
  assert.throws(() => wipeKeyBuffer(new Uint8Array(32)), { code: "SNAPSHOT_KEY_BUFFER_INVALID" });
});

test("public package index preserves the existing three stream functions", async () => {
  const index = await import("../src/index.mjs");
  assert.equal(index.encryptSnapshotStream, encryptSnapshotStream);
  assert.equal(index.decryptSnapshotStream, decryptSnapshotStream);
  assert.equal(index.wipeKeyBuffer, wipeKeyBuffer);
  assert.equal(index.generateLocalSnapshotDataKey, undefined);
});
