// Synthetic declarations only; no payload, private decrypt key, cloud call or legal authority.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeManualJson, sha256Bytes, sha256Canonical } from "../src/index.mjs";
import { readCapturedOssXml } from "../../../scripts/release/manual-runner-source-inputs.mjs";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const load = (name) => JSON.parse(readFileSync(path.join(repo, "release/contracts", name), "utf8"));
const d = (c) => "sha256:" + c.repeat(64);
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

export async function publishR3SnapshotFixture(
  f,
  {
    destinationAdmissionDigest = d("9"),
    jobAdmissionDigest = d("8"),
    inputReference = randomUUID()
  } = {}
) {
  const s = snapshotDeclarations();
  const archive = f.profile.storage.archiveRoot;
  const rawPath = (ref) => path.join(archive, "raw", `${ref.digest.slice(7)}.bin`);
  await fs.mkdir(path.join(archive, "raw"), { recursive: true, mode: 0o700 });
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
        destinationAdmissionDigest,
        readerPrincipal: `manual-h1:${profileDigest}`,
        decryptorPrincipal: `manual-h1:${profileDigest}`,
        userPrincipal: `manual-r3-job:${jobAdmissionDigest}`
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
