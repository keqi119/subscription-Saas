import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
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
function snapshotDeclarations() {
  const contract = load("sanitization-contract.v1.json"),
    ownershipMap = load("snapshot-ownership-map.v1.json");
  const createdAt = "2026-09-03T00:00:00.000Z",
    expiresAt = "2026-10-03T00:00:00.000Z";
  const dumpDigest = d("4"),
    contractDigest = sha256Canonical(contract),
    sourceSha = "b".repeat(40),
    releaseAttemptId = "attempt-20260903-001",
    snapshotRunId = "9001";
  const identity = {
    snapshotIdFingerprint: sha256Canonical({ snapshotId: "synthetic-snapshot" }),
    migrationHead: contract.source.knownMigrationHeads[0],
    databaseIdentityFingerprint: d("2"),
    roleIdentityFingerprint: d("1"),
    tables: contract.source.keyTables.map((table) => ({ table, rowCount: 0, checksum: d("3") }))
  };
  const beforeFingerprint = {
      schemaVersion: "source-fingerprint.v1",
      identity,
      provenance: { observedAt: createdAt }
    },
    afterFingerprint = structuredClone(beforeFingerprint);
  const sourcePrivilege = {
    schemaVersion: "source-privilege-observation.v1",
    secretReferenceFingerprint: sha256Canonical({ secretReference: "secret://fixture/readonly" }),
    roleIdentityFingerprint: d("1"),
    databaseIdentityFingerprint: d("2"),
    capabilities: {
      superuser: false,
      createDatabase: false,
      createRole: false,
      bypassRls: false,
      schemaOwner: false,
      canCreateSchema: false,
      tableWritePrivilegeCount: 0,
      tableTruncatePrivilegeCount: 0,
      writableFunctionExecutePrivilegeCount: 0,
      objectOwnerCount: 1,
      objectOwnerSetDigest: sha256Canonical([ownershipMap.sourceOwners[0]])
    },
    observedAt: createdAt
  };
  const scan = {
    schemaVersion: "sanitization-scan.v1",
    subjectDigest: dumpDigest,
    contractDigest,
    scannerVersion: contract.tools.scannerVersion,
    status: "PASSED",
    findingsCount: 0,
    scannedAt: createdAt
  };
  const metadata = {
    schemaVersion: "snapshot-metadata.v1",
    dumpDigest,
    sourceMigrationHead: identity.migrationHead,
    sourcePrivilegeObservationDigest: sha256Canonical(sourcePrivilege),
    sourceFingerprintBeforeDigest: sha256Canonical(identity),
    sourceFingerprintAfterDigest: sha256Canonical(identity),
    sanitizationContractDigest: contractDigest,
    ownershipMapDigest: sha256Canonical(ownershipMap),
    ownershipContractVersion: ownershipMap.mapVersion,
    scanDigest: sha256Canonical(scan),
    scanSubjectDigest: dumpDigest,
    exportToolVersion: contract.tools.exporterVersion,
    scanToolVersion: contract.tools.scannerVersion,
    createdAt,
    reviewAt: expiresAt,
    expiresAt,
    owner: contract.lifecycle.owner,
    readers: contract.lifecycle.readers,
    accessPolicyRef: contract.lifecycle.accessPolicyRef,
    workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/9001"
  };
  const context = {
      repositoryId: "1253231368",
      sourceSha,
      releaseAttemptId,
      snapshotRunId,
      sanitizationContractDigest: contractDigest,
      expiresAt
    },
    contextDigest = sha256Canonical(context);
  const localKeyReadback = {
    kind: "local-rsa-oaep-sha256.v1",
    keyFingerprint: d("a"),
    keyReadbackDigest: d("b"),
    recoveryReadbackDigest: d("c")
  };
  const aad = {
    ...context,
    snapshotDigest: dumpDigest,
    contextDigest,
    keyFingerprint: localKeyReadback.keyFingerprint
  };
  const envelope = {
    schemaVersion: "snapshot-encryption-envelope.v2",
    algorithm: "AES-256-GCM",
    releaseAttemptId,
    snapshotRunId,
    sourceSha,
    snapshotDigest: dumpDigest,
    sanitizationContractDigest: contractDigest,
    slotObjectKey: "snapshot-slots/v2/" + releaseAttemptId + "/" + snapshotRunId + "/snapshot.enc",
    nonceBase64: Buffer.alloc(12, 1).toString("base64"),
    authenticationTagBase64: Buffer.alloc(16, 2).toString("base64"),
    ciphertextDigest: d("6"),
    ciphertextSizeBytes: 8192,
    wrappedDek: {
      ciphertextBase64: Buffer.alloc(384, 3).toString("base64"),
      digest: sha256Bytes(Buffer.alloc(384, 3))
    },
    localKeyReadback,
    context,
    contextDigest,
    gcmAad: { ...aad, digest: sha256Canonical(aad) },
    snapshotAllocatedAt: createdAt,
    expiresAt,
    authorizationDigest: d("e")
  };
  const object = {
    key: envelope.slotObjectKey,
    version: "null-version-disabled",
    etag: "0123456789ABCDEF0123456789ABCDEF",
    ciphertextDigest: envelope.ciphertextDigest,
    ciphertextSizeBytes: envelope.ciphertextSizeBytes,
    envelopeDigest: sha256Canonical(envelope)
  };
  const readback = {
    key: object.key,
    version: object.version,
    etag: object.etag,
    digest: object.ciphertextDigest,
    sizeBytes: object.ciphertextSizeBytes
  };
  const custody = {
    schemaVersion: "snapshot-private-custody.v1",
    releaseAttemptId,
    snapshotRunId,
    sourceSha,
    bucket: {
      name: "subscription-saas-stage1-snapshot-0123456789ab-cn-shanghai",
      fingerprint: d("1"),
      region: "oss-cn-shanghai"
    },
    object,
    conditionalCreate: { result: "CREATED", forbidOverwrite: true, requestId: "oss-put-001" },
    headReadback: { ...readback },
    getReadback: { ...readback },
    identities: { writer: "snapshot-publisher-session", reader: "snapshot-custody-reader-session" },
    acl: "private",
    accessPolicyDigest: d("4"),
    expiresAt,
    terminalAt: "2026-09-03T01:00:00.000Z",
    downstreamRetainUntil: "2027-04-01T00:00:00.000Z",
    legalHoldUntil: null,
    provisional: false,
    worm: {
      id: "worm-policy-001",
      state: "Locked",
      retentionDays: 210,
      lastModified: createdAt,
      retainUntil: "2027-04-01T00:00:00.000Z",
      readbackAt: "2026-09-03T02:00:00.000Z"
    },
    authoritativeObservationDigest: d("5")
  };
  return {
    metadata,
    contract,
    ownershipMap,
    scan,
    sourcePrivilege,
    beforeFingerprint,
    afterFingerprint,
    envelope,
    custody
  };
}

async function inputFixture(t) {
  t.mock.method(Date, "now", () => Date.parse("2026-09-28T00:00:00.000Z"));
  const f = await h1Fixture(t),
    s = snapshotDeclarations();
  const archive = f.profile.storage.archiveRoot,
    inputReference = randomUUID();
  const rawPath = (ref) => path.join(archive, "raw", `${ref.digest.slice(7)}.bin`);
  await fs.mkdir(path.join(archive, "raw"), { mode: 0o700 });
  const publish = async (value) => {
    const bytes = Buffer.isBuffer(value) ? value : encodeManualJson(value);
    const ref = { digest: sha256Bytes(bytes), bytes: bytes.length };
    try {
      await fs.writeFile(rawPath(ref), bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      assert.deepEqual(await fs.readFile(rawPath(ref)), bytes);
    }
    return ref;
  };
  const profileDigest = sha256Canonical(f.profile);
  const authority = {
    recordVersion: "r3-snapshot-source-authority.v1",
    ownerId: f.profile.ownerId,
    profileDigest,
    capacity: "controller",
    controllerId: "synthetic-controller",
    statement: "Synthetic fixture only; no customer data or legal authority.",
    originals: []
  };
  const identity = {
    databaseIdentityFingerprint: s.sourcePrivilege.databaseIdentityFingerprint,
    roleIdentityFingerprint: s.sourcePrivilege.roleIdentityFingerprint,
    migrationHead: s.metadata.sourceMigrationHead,
    sourceEnvironment: s.contract.source.allowedEnvironment,
    objectOwners: [s.ownershipMap.sourceOwners[0]]
  };
  const permission = {
    recordVersion: "r3-snapshot-input-permission.v1",
    inputReference,
    ownerId: f.profile.ownerId,
    profileDigest,
    sourceAuthority: await publish(authority),
    sourceIdentity: await publish(identity),
    allowedPurpose: "sanitized-snapshot-test-input",
    allowedUses: [
      {
        phase: "source",
        destinationAdmissionDigest: d("9"),
        readerPrincipal: "fixture-reader",
        decryptorPrincipal: "fixture-decryptor",
        userPrincipal: "fixture-user"
      }
    ],
    validUntil: s.metadata.expiresAt,
    restrictionOriginals: []
  };
  const c = s.custody,
    account = "1234567890123456";
  c.identities = {
    writer: `acs:ram::${account}:role/fixture-writer/session`,
    reader: `acs:ram::${account}:role/fixture-reader/session`
  };
  const storage = {
    recordVersion: "r3-snapshot-storage-readback.v1",
    bucket: c.bucket.name,
    objectKey: c.object.key,
    writerIdentity: c.identities.writer,
    readerIdentity: c.identities.reader,
    writerIdentityOriginal: await publish({ Arn: c.identities.writer, AccountId: account }),
    readerIdentityOriginal: await publish({ Arn: c.identities.reader, AccountId: account })
  };
  const acl = Buffer.from(
    `<AccessControlPolicy><Owner><ID>${account}</ID><DisplayName>fixture</DisplayName></Owner><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>`
  );
  const bodies = {
    conditionalCreate: Buffer.alloc(0),
    head: Buffer.alloc(0),
    bucketAcl: acl,
    objectAcl: acl,
    versioning: Buffer.from("<VersioningConfiguration/>"),
    worm: Buffer.from(
      `<WormConfiguration><WormId>${c.worm.id}</WormId><State>Locked</State><RetentionPeriodInDays>210</RetentionPeriodInDays><CreationDate>2026-09-01T00:00:00.000Z</CreationDate></WormConfiguration>`
    )
  };
  const responses = {};
  for (const [name, operation] of Object.entries({
    conditionalCreate: "PutObject",
    head: "HeadObject",
    get: "GetObject",
    bucketAcl: "GetBucketAcl",
    objectAcl: "GetObjectAcl",
    versioning: "GetBucketVersioning",
    worm: "GetBucketWorm"
  })) {
    const put = operation === "PutObject",
      at = put ? "2026-09-03T00:00:01.000Z" : c.worm.readbackAt;
    const headers = {
      date: new Date(at).toUTCString(),
      "x-oss-request-id": put ? c.conditionalCreate.requestId : `fixture-${name}`
    };
    if (["PutObject", "HeadObject", "GetObject"].includes(operation))
      headers.etag = `"${c.object.etag}"`;
    if (["HeadObject", "GetObject"].includes(operation))
      Object.assign(headers, {
        "content-length": String(c.object.ciphertextSizeBytes),
        "last-modified": new Date(c.worm.lastModified).toUTCString(),
        "x-oss-server-side-encryption": "AES256"
      });
    responses[name] = {
      recordVersion: "r3-snapshot-oss-response.v1",
      operation,
      bucket: c.bucket.name,
      objectKey: ["PutObject", "HeadObject", "GetObject", "GetObjectAcl"].includes(operation)
        ? c.object.key
        : null,
      principal: c.identities[put ? "writer" : "reader"],
      observedAt: at,
      requestHeaders: put ? { "x-oss-forbid-overwrite": "true" } : {},
      response: {
        status: 200,
        headers,
        body:
          name === "get"
            ? { digest: c.object.ciphertextDigest, bytes: c.object.ciphertextSizeBytes }
            : await publish(bodies[name])
      }
    };
    storage[name] = await publish(responses[name]);
  }
  c.authoritativeObservationDigest = sha256Canonical(storage);
  const index = {
    recordVersion: "r3-snapshot-input-index.v1",
    inputReference,
    profileDigest,
    ownerId: f.profile.ownerId
  };
  const declarations = {
    permission,
    metadata: s.metadata,
    sanitizationContract: s.contract,
    ownershipMap: s.ownershipMap,
    scan: s.scan,
    sourcePrivilege: s.sourcePrivilege,
    beforeFingerprint: s.beforeFingerprint,
    afterFingerprint: s.afterFingerprint,
    envelope: s.envelope,
    custody: c,
    storageReadback: storage
  };
  for (const [name, value] of Object.entries(declarations)) index[name] = await publish(value);
  const indexPath = path.join(archive, "inputs", "snapshots", inputReference, "index.json");
  await fs.mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(indexPath, encodeManualJson(index), { flag: "wx", mode: 0o600 });
  return {
    ...f,
    s,
    index,
    indexPath,
    identity,
    responses,
    declarations,
    rawPath,
    publish,
    input: { repoRoot: f.repoRoot, inputReference, now: new Date("2026-09-28T00:00:00.000Z") }
  };
}

test("R3 pins a complete declaration graph without opening ciphertext and detects later changes", async (t) => {
  const f = await inputFixture(t),
    result = await production.readR3SnapshotInput(f.input);
  t.after(() => result.close());
  assert.equal(result.inputIndexDigest, sha256Bytes(await fs.readFile(f.indexPath)));
  assert.equal(result.metadataDigest, f.index.metadata.digest);
  assert.equal(result.permissionDigest, f.index.permission.digest);
  assert.equal(result.objectVersion, "null-version-disabled");
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
