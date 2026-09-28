import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { publishR3SnapshotFixture } from "../../packages/release-foundation/test/r3-snapshot-input-fixture.mjs";
import { decryptSnapshotStream } from "../../packages/release-foundation/src/snapshot/envelope-crypto.mjs";
import { readCapturedOssXml } from "./manual-runner-source-inputs.mjs";

const production = await import("./r3-snapshot-input-admission.mjs").catch((error) => {
  if (
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.url?.endsWith("/r3-snapshot-input-admission.mjs")
  )
    return null;
  throw error;
});

test("R3 snapshot input accepts only a fixed selector and no authority callbacks", async () => {
  assert.equal(typeof production?.readR3SnapshotInput, "function");
  const read = production.readR3SnapshotInput,
    repoRoot = path.resolve("unused");
  for (const input of [
    {
      repoRoot,
      inputReference: {
        toString() {
          throw new Error("selector callback invoked");
        }
      },
      now: new Date()
    },
    { repoRoot, inputReference: "../escape", now: new Date() },
    {
      repoRoot,
      inputReference: "8ce0989b-0a4a-437c-8fce-2e005ab73fe5",
      now: Object.assign(new Date(), {
        getTime() {
          throw new Error("clock callback invoked");
        }
      })
    },
    {
      repoRoot,
      inputReference: "8ce0989b-0a4a-437c-8fce-2e005ab73fe5",
      now: new Date(),
      approved: true
    },
    {
      repoRoot,
      inputReference: "8ce0989b-0a4a-437c-8fce-2e005ab73fe5",
      now: () => new Date()
    }
  ])
    await assert.rejects(read(input), { code: "R3_SNAPSHOT_INPUT_INVALID" });
});

const repo = fileURLToPath(new URL("../../", import.meta.url));
const load = (name) => JSON.parse(readFileSync(path.join(repo, "release/contracts", name), "utf8"));
const d = (c) => "sha256:" + c.repeat(64);
async function h1Fixture(t) {
  assert.equal(process.platform, "linux");
  const root = await fs.mkdtemp(path.join(tmpdir(), "r3-reader-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("r3-reader-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const repoRoot = path.join(root, "repo");
  await fs.mkdir(path.join(repoRoot, "release/contracts"), { recursive: true, mode: 0o700 });
  const profile = load("manual-stage1-profile.v2.json");
  profile.profileId = randomUUID();
  profile.ownerId = "synthetic-owner";
  profile.validFrom = "2020-01-01T00:00:00.000Z";
  profile.expiresAt = "2099-01-01T00:00:00.000Z";
  profile.storage = { keyRef: "owner.key", retentionDays: 90 };
  for (const name of ["key", "journal", "archive", "backup", "credential"]) {
    profile.storage[name + "Root"] = path.join(root, name);
    await fs.mkdir(profile.storage[name + "Root"], { mode: 0o700 });
  }
  const machineId = (await fs.readFile("/etc/machine-id", "utf8")).trim();
  const approval = {
    schemaVersion: "manual-stage1-owner-approval.v1",
    profileDigest: sha256Canonical(profile),
    ownerId: profile.ownerId,
    principal: { platform: "posix", uid: process.getuid() },
    hostFingerprint: sha256Bytes(
      Buffer.from("subscription-saas/linux-machine-id/v1\n" + machineId)
    ),
    approvedAt: "2026-09-01T00:00:00.000Z",
    promotionEligible: false
  };
  const approvalBytes = encodeManualJson(approval),
    approvalDigest = sha256Bytes(approvalBytes);
  const binding = {
    ...approval,
    schemaVersion: "manual-stage1-owner-binding.v1",
    approvalDigest,
    approvalReference: "inputs/h1/" + approvalDigest.slice(7) + ".approval.json"
  };
  const approvalPath = path.join(profile.storage.archiveRoot, binding.approvalReference);
  await fs.mkdir(path.dirname(approvalPath), { recursive: true, mode: 0o700 });
  for (const [file, bytes] of [
    [
      path.join(repoRoot, "release/contracts/manual-stage1-profile.v2.json"),
      encodeManualJson(profile)
    ],
    [
      path.join(repoRoot, "release/contracts/manual-stage1-owner-binding.v1.json"),
      encodeManualJson(binding)
    ],
    [approvalPath, approvalBytes]
  ])
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return { root, repoRoot, profile, approval, binding, approvalPath };
}
async function inputFixture(t) {
  t.mock.method(Date, "now", () => Date.parse("2026-09-28T00:00:00.000Z"));
  return publishR3SnapshotFixture(await h1Fixture(t));
}

// Without dereferencing the historical producer, an envelope's digest alone
// previously passed admission. All other declarations remain valid here.
test("R3 refuses missing, oversized and mismatched producer originals", async (t) => {
  const f = await inputFixture(t);
  const originalPath = f.rawPath({ digest: f.s.envelope.authorizationDigest });
  const originalBytes = await fs.readFile(originalPath);
  const readAndClose = async () => {
    const result = await production.readR3SnapshotInput(f.input);
    await result.close();
    return result;
  };
  await fs.unlink(originalPath);
  await assert.rejects(readAndClose(), {
    code: "R3_SNAPSHOT_INPUT_UNAVAILABLE"
  });
  await fs.writeFile(originalPath, Buffer.alloc(1048577, 32), { flag: "wx", mode: 0o600 });
  await assert.rejects(readAndClose(), {
    code: "R3_SNAPSHOT_INPUT_UNAVAILABLE"
  });
  await fs.writeFile(originalPath, originalBytes);
  const authorization = structuredClone(f.s.producerAuthorization);
  authorization.localKey.keyFingerprint = d("f");
  const authorizationRef = await f.publish(authorization);
  const envelope = { ...f.s.envelope, authorizationDigest: authorizationRef.digest };
  const custody = structuredClone(f.s.custody);
  custody.object.envelopeDigest = sha256Canonical(envelope);
  const index = {
    ...f.index,
    envelope: await f.publish(envelope),
    custody: await f.publish(custody)
  };
  await fs.writeFile(f.indexPath, encodeManualJson(index));
  await assert.rejects(readAndClose(), {
    code: "R3_SNAPSHOT_INPUT_UNAVAILABLE"
  });
});

// The reader must derive usable parameters from pinned originals, without
// granting current consumption or opening any private key/payload itself.
test("R3 pinned crypto inputs recover synthetic bytes with the historical local-key authorization", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-03T00:00:01.000Z"));
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
  const bytes = Buffer.from("R3 synthetic sanitized dump\n");
  const f = await publishR3SnapshotFixture(await h1Fixture(t), {
    payload: { bytes, publicKey: keys.publicKey }
  });
  t.mock.method(Date, "now", () => Date.parse("2026-09-28T00:00:00.000Z"));
  const held = await production.readR3SnapshotInput(f.input);
  t.after(() => held.close());
  assert.ok(held.cryptoInputs, "missing parameters derived from original authorization");
  const { authorization, envelope, aad } = held.cryptoInputs;
  assert.deepEqual(authorization, f.s.producerAuthorization);
  assert.ok(Date.parse(authorization.notAfter) < Date.now(), "producer window is historical");
  assert.deepEqual(aad, {
    repositoryId: "1253231368",
    sourceSha: "b".repeat(40),
    releaseAttemptId: "attempt-20260903-001",
    snapshotRunId: "9001",
    sanitizationContractDigest: f.s.metadata.sanitizationContractDigest,
    snapshotDigest: sha256Bytes(bytes),
    snapshotAllocatedAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2026-10-03T00:00:00.000Z"
  });
  assert.ok(Object.isFrozen(held.cryptoInputs));
  assert.throws(() => {
    authorization.localKey.keyFingerprint = d("1");
  }, TypeError);
  assert.throws(() => {
    envelope.context.sourceSha = "f".repeat(40);
  }, TypeError);
  assert.throws(() => {
    aad.snapshotDigest = d("1");
  }, TypeError);
  const originalPath = f.rawPath({ digest: envelope.authorizationDigest });
  const originalBytes = await fs.readFile(originalPath);
  assert.ok(
    held.rawReferences.some(
      (ref) => ref.digest === envelope.authorizationDigest && ref.bytes === originalBytes.length
    )
  );
  assert.ok(!held.rawReferences.some((ref) => ref.digest === envelope.ciphertextDigest));
  assert.deepEqual(await fs.readdir(f.profile.storage.keyRoot), []);
  const destination = path.join(path.dirname(f.ciphertextPath), "authenticated.dump");
  await decryptSnapshotStream({
    ...held.cryptoInputs,
    source: { open: () => createReadStream(f.ciphertextPath) },
    destination,
    privateKey: keys.privateKey
  });
  assert.deepEqual(await fs.readFile(destination), bytes);
  await held.recheck();
  // A held original's replacement is a failure even if the JSON still parses.
  await fs.writeFile(originalPath, Buffer.concat([originalBytes, Buffer.from(" ")]));
  await assert.rejects(held.recheck(), { code: "R3_SNAPSHOT_INPUT_UNAVAILABLE" });
});

test("R3 consumer binds the fixed permission to exact input, destination and existing principals", async (t) => {
  const f = await inputFixture(t),
    held = await production.readR3SnapshotInput(f.input);
  t.after(() => held.close());
  assert.equal(typeof held.assertConsumerBinding, "function");
  const scope = {
    targetPolicyDigest: d("1"),
    creationSpecDigest: d("2"),
    jobAdmissionDigest: d("8"),
    buildProofDigest: d("3"),
    sourceSha: "c".repeat(40),
    phase: "source",
    chain: "snapshot"
  };
  const request = {
    schemaVersion: "manual-runner-request.v3",
    profileDigest: sha256Canonical(f.profile),
    ownerId: f.profile.ownerId,
    sessionId: randomUUID(),
    sessionNonce: "a".repeat(64),
    operationId: randomUUID(),
    idempotencyKey: "synthetic-consumer",
    attemptId: randomUUID(),
    runId: randomUUID(),
    attemptAllocationDigest: d("4"),
    stage: "snapshot-consumer",
    capability: "read-decrypt-use",
    purpose: "sanitized-snapshot-test-input",
    phase: "source",
    sourceSha: scope.sourceSha,
    scopeAuthorizationDigest: held.permissionDigest,
    destinationAdmissionDigest: d("9"),
    input: { inputReference: f.input.inputReference, inputIndexDigest: held.inputIndexDigest },
    candidate: { buildProofDigest: scope.buildProofDigest }
  };
  assert.equal(await held.assertConsumerBinding({ request, scope }), undefined);
  for (const patch of [
    { scopeAuthorizationDigest: d("0") },
    { destinationAdmissionDigest: d("0") },
    { input: { ...request.input, inputIndexDigest: d("0") } },
    { input: { ...request.input, inputReference: randomUUID() } },
    { profileDigest: d("0") },
    { ownerId: "someone-else" },
    { phase: "final", matchingSourceEvidenceDigest: d("0") },
    { candidate: { buildProofDigest: d("0") } },
    { sourceSha: "d".repeat(40) }
  ])
    await assert.rejects(held.assertConsumerBinding({ request: { ...request, ...patch }, scope }));
  await assert.rejects(
    held.assertConsumerBinding({ request, scope: { ...scope, jobAdmissionDigest: d("0") } })
  );
  await assert.rejects(
    held.assertConsumerBinding({ request, scope: { ...scope, chain: "fresh" } })
  );
  await assert.rejects(held.assertConsumerBinding({ request, scope, approved: true }));
  let invoked = false;
  await assert.rejects(
    held.assertConsumerBinding({
      request,
      scope: {
        ...scope,
        jobAdmissionDigest: {
          toString() {
            invoked = true;
            return d("8");
          }
        }
      }
    })
  );
  assert.equal(invoked, false);
  await held.close();
  await assert.rejects(held.assertConsumerBinding({ request, scope }));
  for (const principal of ["readerPrincipal", "decryptorPrincipal", "userPrincipal"]) {
    const permission = structuredClone(f.declarations.permission);
    permission.allowedUses[0][principal] = "unrelated-principal";
    const index = { ...f.index, permission: await f.publish(permission) };
    const bytes = encodeManualJson(index);
    await fs.writeFile(f.indexPath, bytes);
    const changed = await production.readR3SnapshotInput(f.input);
    try {
      await assert.rejects(
        changed.assertConsumerBinding({
          request: {
            ...request,
            scopeAuthorizationDigest: index.permission.digest,
            input: { ...request.input, inputIndexDigest: sha256Bytes(bytes) }
          },
          scope
        })
      );
    } finally {
      await changed.close();
    }
  }
});

test("R3 pins a complete declaration graph without opening ciphertext and detects later changes", async (t) => {
  const f = await inputFixture(t),
    result = await production.readR3SnapshotInput(f.input);
  t.after(() => result.close());
  assert.equal(result.inputIndexDigest, sha256Bytes(await fs.readFile(f.indexPath)));
  assert.equal(result.metadataDigest, f.index.metadata.digest);
  assert.deepEqual(result.restoreInputs, {
    metadata: f.declarations.metadata,
    ownershipMap: f.declarations.ownershipMap
  });
  assert.ok(Object.isFrozen(result.restoreInputs));
  assert.ok(Object.isFrozen(result.restoreInputs.ownershipMap.sourceOwners));
  assert.equal(result.permissionDigest, f.index.permission.digest);
  assert.equal(result.objectVersion, "null-version-disabled");
  assert.deepEqual(result.storageSubject, {
    bucket: f.s.custody.bucket.name,
    region: "oss-cn-shanghai",
    key: f.s.envelope.slotObjectKey,
    version: "null-version-disabled",
    etag: f.s.custody.object.etag,
    ciphertextDigest: f.s.envelope.ciphertextDigest,
    ciphertextSizeBytes: f.s.envelope.ciphertextSizeBytes,
    lastModified: f.s.custody.worm.lastModified,
    writerPrincipal: f.s.custody.identities.writer
  });
  assert.ok(Object.isFrozen(result.storageSubject));
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.allowedUses[0]) &&
      Object.isFrozen(result.rawReferences)
  );
  assert.ok(!result.rawReferences.some((r) => r.digest === result.ciphertextDigest));
  // There is no payload or private key file for the reader to open successfully.
  await assert.rejects(fs.stat(f.rawPath({ digest: result.ciphertextDigest })), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(f.profile.storage.keyRoot), []);
  await result.recheck();
  t.mock.method(Date, "now", () => Date.parse(result.expiresAt));
  await assert.rejects(result.recheck(), { code: "R3_SNAPSHOT_INPUT_UNAVAILABLE" });
  t.mock.restoreAll();
  const file = f.rawPath(f.index.scan),
    bytes = await fs.readFile(file);
  await fs.writeFile(file, Buffer.concat([bytes, Buffer.from(" ")]));
  await assert.rejects(result.recheck(), { code: "R3_SNAPSHOT_INPUT_UNAVAILABLE" });
  await result.close();
  await assert.rejects(result.recheck(), { code: "R3_SNAPSHOT_INPUT_UNAVAILABLE" });
});

test("R3 refuses inconsistent source, scan, permission and native storage originals", async (t) => {
  const f = await inputFixture(t);
  const original = structuredClone(f.index);
  const rejectMutation = async (mutate, code = "R3_SNAPSHOT_INPUT_BINDING_INVALID") => {
    const index = structuredClone(original),
      data = structuredClone(f.declarations);
    await mutate(data, index);
    for (const [name, value] of Object.entries(data)) index[name] = await f.publish(value);
    await fs.writeFile(f.indexPath, encodeManualJson(index));
    await assert.rejects(production.readR3SnapshotInput(f.input), { code });
  };
  await rejectMutation(async (data) => {
    data.permission.validUntil = "2026-09-27T00:00:00.000Z";
  });
  await rejectMutation(async (data) => {
    data.permission.sourceIdentity = await f.publish({
      ...f.identity,
      databaseIdentityFingerprint: d("8")
    });
  });
  await rejectMutation(async (data) => {
    data.scan.findingsCount = 1;
    data.metadata.scanDigest = sha256Canonical(data.scan);
  }, "R3_SNAPSHOT_INPUT_UNAVAILABLE");
  await rejectMutation(async (data) => {
    for (const obj of [data.custody.object, data.custody.headReadback, data.custody.getReadback])
      obj.version = "another-version";
  });
  for (const [name, mutate] of [
    [
      "conditionalCreate",
      (record) => {
        record.response.headers.etag = '"WRONG"';
      }
    ],
    [
      "get",
      (record) => {
        record.principal = f.s.custody.identities.writer;
      }
    ],
    [
      "objectAcl",
      (record) => {
        record.observedAt = "2026-09-03T00:30:00.000Z";
        record.response.headers.date = new Date(record.observedAt).toUTCString();
      }
    ]
  ])
    await rejectMutation(async (data) => {
      const record = structuredClone(f.responses[name]);
      mutate(record);
      data.storageReadback[name] = await f.publish(record);
      data.custody.authoritativeObservationDigest = sha256Canonical(data.storageReadback);
    });
  await fs.writeFile(f.indexPath, encodeManualJson(original));
  const scanPath = f.rawPath(original.scan),
    scanBytes = await fs.readFile(scanPath);
  await fs.rename(scanPath, scanPath + ".withheld");
  try {
    await assert.rejects(production.readR3SnapshotInput(f.input), {
      code: "R3_SNAPSHOT_INPUT_UNAVAILABLE"
    });
  } finally {
    await fs.rename(scanPath + ".withheld", scanPath);
    assert.deepEqual(await fs.readFile(scanPath), scanBytes);
  }
  for (const xml of ["<Wrong/>", '<!DOCTYPE x [<!ENTITY y "x">]><VersioningConfiguration/>'])
    await assert.rejects(readCapturedOssXml(Buffer.from(xml), "VersioningConfiguration"));
});
