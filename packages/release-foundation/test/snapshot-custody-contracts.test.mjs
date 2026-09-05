import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateContract } from "../src/index.mjs";
import {
  validateLineageAccessReadback,
  validateLineageRetentionReceipt,
  validateLineageStoragePolicy,
  validateSnapshotCustody,
  validateSnapshotDestructionReceipt,
  validateSnapshotRetentionReceipt
} from "../src/snapshot/custody-contracts.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const sourceSha = "b".repeat(40);
const releaseAttemptId = "attempt-20260903-001";
const snapshotRunId = "9001";

function validCustody() {
  return {
    schemaVersion: "snapshot-private-custody.v1",
    releaseAttemptId,
    snapshotRunId,
    sourceSha,
    bucket: {
      name: "subscription-saas-stage1-snapshot-0123456789ab-cn-shanghai",
      fingerprint: digest("1"),
      region: "oss-cn-shanghai"
    },
    object: {
      key: `snapshot-slots/v2/${releaseAttemptId}/${snapshotRunId}/snapshot.enc`,
      version: "null-version-disabled",
      etag: "0123456789ABCDEF0123456789ABCDEF",
      ciphertextDigest: digest("2"),
      ciphertextSizeBytes: 8192,
      envelopeDigest: digest("3")
    },
    conditionalCreate: { result: "CREATED", forbidOverwrite: true, requestId: "oss-put-001" },
    headReadback: {
      key: `snapshot-slots/v2/${releaseAttemptId}/${snapshotRunId}/snapshot.enc`,
      version: "null-version-disabled",
      etag: "0123456789ABCDEF0123456789ABCDEF",
      digest: digest("2"),
      sizeBytes: 8192
    },
    getReadback: {
      key: `snapshot-slots/v2/${releaseAttemptId}/${snapshotRunId}/snapshot.enc`,
      version: "null-version-disabled",
      etag: "0123456789ABCDEF0123456789ABCDEF",
      digest: digest("2"),
      sizeBytes: 8192
    },
    identities: { writer: "snapshot-publisher-session", reader: "snapshot-custody-reader-session" },
    acl: "private",
    accessPolicyDigest: digest("4"),
    expiresAt: "2026-10-03T00:00:00.000Z",
    terminalAt: "2026-09-03T01:00:00.000Z",
    downstreamRetainUntil: "2027-04-01T00:00:00.000Z",
    legalHoldUntil: null,
    provisional: false,
    worm: {
      id: "worm-policy-001",
      state: "Locked",
      retentionDays: 210,
      lastModified: "2026-09-03T00:00:00.000Z",
      retainUntil: "2027-04-01T00:00:00.000Z",
      readbackAt: "2026-09-03T02:00:00.000Z"
    },
    authoritativeObservationDigest: digest("5")
  };
}

function validDestructionReceipt() {
  return {
    schemaVersion: "snapshot-destruction-receipt.v1",
    releaseAttemptId,
    snapshotRunId,
    claim: "KEY_INVALIDATION_ONLY",
    volume: {
      backingFile: `/var/lib/subscription-saas/snapshot-volumes/${releaseAttemptId}.luks`,
      mapper: `subscription-s1-${releaseAttemptId}`,
      luksUuid: "11111111-2222-4333-8444-555555555555",
      keySlotsBefore: [0, 1],
      keySlotsInvalidated: [0, 1],
      unlockAttemptResult: "DENIED"
    },
    keyDisposition: {
      dekBufferClear: "BEST_EFFORT_COMPLETED",
      tokenizationKeyDestroyed: true,
      credentialsRemoved: true
    },
    residualScan: {
      performedAt: "2026-09-03T00:08:00.000Z",
      pathsChecked: ["/mnt/snapshot-attempt", "/run/subscription-saas/snapshot-secrets"],
      plaintextArtifactsFound: 0
    },
    processTerminal: {
      cryptoExited: true,
      publisherIssuedAfterCryptoTerminal: true,
      terminalAt: "2026-09-03T00:09:00.000Z"
    },
    issuer: "snapshot-adapter-root",
    issuedAt: "2026-09-03T00:10:00.000Z"
  };
}

function validRetentionReceipt() {
  const custody = validCustody();
  return {
    schemaVersion: "snapshot-retention-receipt.v1",
    releaseAttemptId,
    snapshotRunId,
    object: {
      key: custody.object.key,
      version: custody.object.version,
      etag: custody.object.etag,
      digest: custody.object.ciphertextDigest
    },
    custodyObservationDigest: custody.authoritativeObservationDigest,
    dispositionPolicyDigest: digest("6"),
    approvalDigest: digest("7"),
    operator: {
      identity: "snapshot-retention-operator-001",
      independentFromPublisherConsumer: true
    },
    eligibleAt: "2027-04-01T00:00:00.000Z",
    action: "DELETE_CIPHERTEXT_AND_DISABLE_KEY_ACCESS",
    appliedAt: "2027-04-01T01:00:00.000Z",
    terminalReadback: {
      objectAccessDisposition: "DELETED",
      keyAccessDisposition: "DISABLED",
      verifiedAt: "2027-04-01T01:05:00.000Z",
      digest: digest("8")
    },
    legalHold: { active: false, readbackDigest: digest("9") },
    issuer: "snapshot-retention-control-plane"
  };
}

function lineageObject({
  addressingKind,
  objectType,
  character,
  rawProofType = null,
  rawCharacter = null
}) {
  const objectDigest = digest(character);
  const rawProofDigest = rawCharacter === null ? null : digest(rawCharacter);
  const key =
    addressingKind === "claim"
      ? `evidence/claims/v1/${rawProofType}/${rawProofDigest.slice(7)}`
      : `evidence/v1/${releaseAttemptId}/701/${objectType}/${objectDigest.slice(7)}`;
  return {
    addressingKind,
    objectType,
    digest: objectDigest,
    expectedDigest: objectDigest,
    rawProofType,
    rawProofDigest,
    key
  };
}

function validLineageReadback() {
  return {
    schemaVersion: "evidence-lineage-access-readback.v1",
    approvalSchemaVersion: "exact-capability-approval.v2",
    lane: "rc",
    capabilityKind: "lineage-oss-role",
    repository: { name: "keqi119/subscription-Saas", id: "1253231368" },
    releaseAttemptId,
    rcWorkflowRunId: "701",
    job: {
      id: "lineage-purpose-store",
      instanceId: "lineage-purpose-store-source-gate-001",
      environment: "trusted-release-execution",
      permissionProfile: "lineage-create-only-writer",
      lineageNodeKind: "purpose"
    },
    exactObjects: [
      lineageObject({
        addressingKind: "claim",
        objectType: "purpose-claim.v1",
        character: "a",
        rawProofType: "source-gate-evidence.v1",
        rawCharacter: "b"
      }),
      lineageObject({
        addressingKind: "lineage",
        objectType: "execution-purpose-envelope.v1",
        character: "c"
      })
    ],
    namespace: "private-lineage",
    providerRolePolicy: {
      providerArn: "acs:ram::123456789012:oidc-provider/github-actions-subscription-saas-stage1",
      roleArn: "acs:ram::123456789012:role/lineage-purpose-writer",
      trustPolicyDigest: digest("d"),
      permissionPolicyDigest: digest("e"),
      resourceReadbackDigest: digest("f")
    },
    prerequisite: {
      changePlanDigest: digest("0"),
      externalChangeApprovalDigest: digest("1"),
      applyProofDigest: digest("2"),
      rolePolicyReadbackDigest: digest("3"),
      appliedAt: "2026-09-03T00:01:00.000Z",
      approvalIssuedAt: "2026-09-03T00:00:00.000Z"
    },
    acl: "private",
    worm: {
      id: "worm-policy-001",
      state: "Locked",
      retentionDays: 210,
      readbackAt: "2026-09-03T00:03:00.000Z"
    },
    deniedActions: ["Head", "Get", "List", "Delete", "KMS", "Database", "Snapshot", "JIT"],
    observationKind: "PREREQUISITE_ONLY",
    credentialIssued: false,
    contentReadbackPerformed: false,
    accessReceiptDigest: null,
    observationAt: "2026-09-03T00:03:00.000Z"
  };
}

function validLineageRetentionReceipt() {
  return {
    schemaVersion: "evidence-lineage-retention-receipt.v1",
    releaseAttemptId,
    rcWorkflowRunId: "701",
    objects: [
      {
        addressingKind: "lineage",
        objectType: "release-aggregate-proof.v2",
        key: `evidence/v1/${releaseAttemptId}/701/release-aggregate-proof.v2/${"a".repeat(64)}`,
        version: "null-version-disabled",
        digest: digest("a"),
        rawProofType: null,
        rawProofDigest: null,
        custodyObservationDigest: digest("b")
      },
      {
        addressingKind: "claim",
        objectType: "purpose-claim.v1",
        key: `evidence/claims/v1/source-gate-evidence.v1/${"f".repeat(64)}`,
        version: "claim-version-001",
        digest: digest("c"),
        rawProofType: "source-gate-evidence.v1",
        rawProofDigest: digest("f"),
        custodyObservationDigest: digest("d")
      },
      {
        addressingKind: "lineage",
        objectType: "execution-purpose-envelope.v1",
        key: `evidence/v1/${releaseAttemptId}/701/execution-purpose-envelope.v1/${"1".repeat(64)}`,
        version: "purpose-envelope-version-001",
        digest: digest("1"),
        rawProofType: null,
        rawProofDigest: null,
        custodyObservationDigest: digest("4")
      },
      {
        addressingKind: "lineage",
        objectType: "custody-receipt.v2",
        key: `evidence/v1/${releaseAttemptId}/701/custody-receipt.v2/${"2".repeat(64)}`,
        version: "custody-version-001",
        digest: digest("2"),
        rawProofType: null,
        rawProofDigest: null,
        custodyObservationDigest: digest("5")
      },
      {
        addressingKind: "lineage",
        objectType: "s1-exit-evidence.v2",
        key: `evidence/v1/${releaseAttemptId}/701/s1-exit-evidence.v2/${"3".repeat(64)}`,
        version: "exit-version-001",
        digest: digest("3"),
        rawProofType: null,
        rawProofDigest: null,
        custodyObservationDigest: digest("6")
      }
    ],
    latestWholeLineageRetainUntil: "2027-04-01T00:00:00.000Z",
    legalHoldUntil: null,
    dispositionPlanDigest: digest("c"),
    approvalDigest: digest("d"),
    operatorIdentity: "independent-lineage-retention-operator",
    action: "DELETE",
    appliedAt: "2027-04-01T00:01:00.000Z",
    terminalReadback: {
      disposition: "DELETED",
      verifiedAt: "2027-04-01T00:02:00.000Z",
      digest: digest("e")
    }
  };
}

test("snapshot cloud policy is strict, private, and keeps exactly four separated profiles", () => {
  const policy = JSON.parse(
    readFileSync(
      new URL("../../../release/contracts/snapshot-cloud-policy.v1.json", import.meta.url)
    )
  );
  assert.doesNotThrow(() => validateContract("snapshot-cloud-policy.v1", policy));
  assert.deepEqual(Object.keys(policy.profiles).sort(), [
    "custody-reader",
    "publisher",
    "rc-consumer",
    "retention"
  ]);
  assert.equal(policy.bucket.worm.retentionDays, 210);
  assert.equal(policy.bucket.versioning, "Disabled");
  assert.equal(policy.bucket.forbidOverwrite, true);
});

test("private snapshot custody accepts independent exact-object readback", () => {
  assert.doesNotThrow(() => validateSnapshotCustody(validCustody()));
});

test("private custody expires no earlier than snapshot expiry plus 180 days", () => {
  const candidate = validCustody();
  candidate.worm.retentionDays = 209;
  candidate.worm.retainUntil = "2027-03-31T00:00:00.000Z";
  assert.throws(() => validateSnapshotCustody(candidate), {
    code: "SNAPSHOT_CUSTODY_RETENTION_TOO_SHORT"
  });
});

test("private custody rejects fabricated now-plus-180, unlocked WORM, malformed time, and self-readback", () => {
  for (const [mutate, code] of [
    [
      (value) => (value.worm.retainUntil = "2027-03-03T02:00:00.000Z"),
      "SNAPSHOT_CUSTODY_WORM_READBACK_INVALID"
    ],
    [(value) => (value.worm.state = "Unlocked"), "CONTRACT_SCHEMA_INVALID"],
    [(value) => (value.terminalAt = "not-a-time"), "CONTRACT_SCHEMA_INVALID"],
    [
      (value) => (value.identities.reader = value.identities.writer),
      "SNAPSHOT_CUSTODY_IDENTITY_NOT_INDEPENDENT"
    ]
  ]) {
    const candidate = validCustody();
    mutate(candidate);
    assert.throws(() => validateSnapshotCustody(candidate), { code });
  }
});

test("preterminal snapshot custody remains provisional until independent terminal revalidation", () => {
  const candidate = validCustody();
  candidate.provisional = true;
  candidate.terminalAt = null;
  assert.throws(() => validateSnapshotCustody(candidate), {
    code: "SNAPSHOT_CUSTODY_TERMINAL_REVALIDATION_REQUIRED"
  });
  assert.doesNotThrow(() => validateSnapshotCustody(candidate, { allowProvisional: true }));
});

test("snapshot destruction receipt proves key invalidation without claiming physical erasure", () => {
  assert.doesNotThrow(() => validateSnapshotDestructionReceipt(validDestructionReceipt()));
  const candidate = validDestructionReceipt();
  candidate.volume.keySlotsInvalidated = [0];
  assert.throws(() => validateSnapshotDestructionReceipt(candidate), {
    code: "SNAPSHOT_DESTRUCTION_INCOMPLETE"
  });
});

test("snapshot retention receipt requires independent approved terminal disposition", () => {
  assert.doesNotThrow(() => validateSnapshotRetentionReceipt(validRetentionReceipt()));
  for (const mutate of [
    (value) => (value.operator.independentFromPublisherConsumer = false),
    (value) => (value.appliedAt = "2027-03-31T23:59:59.000Z"),
    (value) => (value.terminalReadback.keyAccessDisposition = "ACTIVE")
  ]) {
    const candidate = validRetentionReceipt();
    mutate(candidate);
    assert.throws(() => validateSnapshotRetentionReceipt(candidate));
  }
});

test("lineage storage policy fixes the exact eight-job matrix and excludes a runtime retention profile", () => {
  const policy = validateLineageStoragePolicy();
  assert.deepEqual(policy.matrix, [
    {
      permissionProfile: "lineage-create-only-writer",
      jobId: "lineage-purpose-store",
      environment: "trusted-release-execution",
      lineageNodeKind: "purpose",
      allowedActions: ["ConditionalCreate"]
    },
    {
      permissionProfile: "lineage-readback-reader",
      jobId: "lineage-purpose-readback",
      environment: "trusted-release-execution",
      lineageNodeKind: "purpose",
      allowedActions: ["Head", "Get"]
    },
    {
      permissionProfile: "lineage-create-only-writer",
      jobId: "lineage-custody-store",
      environment: "trusted-release-execution",
      lineageNodeKind: "custody",
      allowedActions: ["ConditionalCreate"]
    },
    {
      permissionProfile: "lineage-readback-reader",
      jobId: "lineage-custody-readback",
      environment: "trusted-release-execution",
      lineageNodeKind: "custody",
      allowedActions: ["Head", "Get"]
    },
    {
      permissionProfile: "lineage-create-only-writer",
      jobId: "lineage-aggregate-store",
      environment: "trusted-release-candidate",
      lineageNodeKind: "aggregate",
      allowedActions: ["ConditionalCreate"]
    },
    {
      permissionProfile: "lineage-readback-reader",
      jobId: "lineage-aggregate-readback",
      environment: "trusted-release-candidate",
      lineageNodeKind: "aggregate",
      allowedActions: ["Head", "Get"]
    },
    {
      permissionProfile: "lineage-create-only-writer",
      jobId: "lineage-exit-store",
      environment: "trusted-release-candidate",
      lineageNodeKind: "exit",
      allowedActions: ["ConditionalCreate"]
    },
    {
      permissionProfile: "lineage-readback-reader",
      jobId: "lineage-exit-readback",
      environment: "trusted-release-candidate",
      lineageNodeKind: "exit",
      allowedActions: ["Head", "Get"]
    }
  ]);
  assert.equal(policy.approvalSchemaVersion, "exact-capability-approval.v2");
  assert.equal(policy.retention.liveRoleProvisioned, false);
  assert.equal(policy.retention.runtimeProfile, null);
  const candidate = structuredClone(policy);
  candidate.matrix[0].environment = "trusted-release-candidate";
  assert.throws(() => validateLineageStoragePolicy(candidate), {
    code: "LINEAGE_STORAGE_POLICY_MISMATCH"
  });
  for (const field of ["claimMinimumDays", "accessReceiptMinimumDays"]) {
    const shortened = structuredClone(policy);
    shortened.retention[field] = 179;
    assert.throws(() => validateLineageStoragePolicy(shortened));
  }
});

test("lineage prerequisite validator accepts each exact matrix row without claiming object use", () => {
  const rows = validateLineageStoragePolicy().matrix;
  const objectType = {
    custody: "custody-receipt.v2",
    aggregate: "release-aggregate-proof.v2",
    exit: "s1-exit-evidence.v2"
  };
  for (const row of rows) {
    const candidate = validLineageReadback();
    Object.assign(candidate.job, {
      id: row.jobId,
      instanceId: `${row.jobId}-001`,
      environment: row.environment,
      permissionProfile: row.permissionProfile,
      lineageNodeKind: row.lineageNodeKind
    });
    candidate.deniedActions =
      row.permissionProfile === "lineage-create-only-writer"
        ? ["Head", "Get", "List", "Delete", "KMS", "Database", "Snapshot", "JIT"]
        : ["Put", "List", "Delete", "KMS", "Database", "Snapshot", "JIT"];
    if (row.lineageNodeKind !== "purpose") {
      candidate.exactObjects = [
        lineageObject({
          addressingKind: "lineage",
          objectType: objectType[row.lineageNodeKind],
          character: row.lineageNodeKind[0]
        })
      ];
    }
    assert.doesNotThrow(() => validateLineageAccessReadback(candidate), row.jobId);
  }
});

test("lineage prerequisite readback accepts the exact purpose writer binding only", () => {
  assert.doesNotThrow(() => validateLineageAccessReadback(validLineageReadback()));
  for (const mutate of [
    (value) => (value.approvalSchemaVersion = "exact-capability-approval.v1"),
    (value) => (value.job.id = "lineage-exit-store"),
    (value) => (value.job.permissionProfile = "lineage-readback-reader"),
    (value) => (value.job.environment = "trusted-release-candidate"),
    (value) => (value.prerequisite.approvalIssuedAt = "2026-09-03T00:02:00.000Z"),
    (value) => (value.exactObjects[0].key = "evidence/claims/v1/*"),
    (value) =>
      (value.exactObjects[0].key = `evidence/claims/v1/source-gate-evidence.v1/${"0".repeat(64)}`),
    (value) => {
      value.exactObjects[0].rawProofType = "unknown-proof.v1";
      value.exactObjects[0].key = `evidence/claims/v1/unknown-proof.v1/${value.exactObjects[0].rawProofDigest.slice(7)}`;
    },
    (value) => (value.contentReadbackPerformed = true)
  ]) {
    const candidate = validLineageReadback();
    mutate(candidate);
    assert.throws(() => validateLineageAccessReadback(candidate));
  }
});

test("both purpose jobs reject a purpose claim relabeled as ordinary lineage", () => {
  for (const job of [
    {
      id: "lineage-purpose-store",
      permissionProfile: "lineage-create-only-writer",
      deniedActions: ["Head", "Get", "List", "Delete", "KMS", "Database", "Snapshot", "JIT"]
    },
    {
      id: "lineage-purpose-readback",
      permissionProfile: "lineage-readback-reader",
      deniedActions: ["Put", "List", "Delete", "KMS", "Database", "Snapshot", "JIT"]
    }
  ]) {
    const candidate = validLineageReadback();
    candidate.job.id = job.id;
    candidate.job.instanceId = `${job.id}-001`;
    candidate.job.permissionProfile = job.permissionProfile;
    candidate.deniedActions = job.deniedActions;
    const claim = candidate.exactObjects[0];
    claim.addressingKind = "lineage";
    claim.rawProofType = null;
    claim.rawProofDigest = null;
    claim.key = `evidence/v1/${releaseAttemptId}/701/purpose-claim.v1/${claim.digest.slice(7)}`;

    assert.throws(() => validateLineageAccessReadback(candidate), undefined, job.id);
  }
});

test("claim addressing remains bound to raw proof identity across attempt and run changes", () => {
  const candidate = validLineageReadback();
  const claim = structuredClone(candidate.exactObjects[0]);
  candidate.releaseAttemptId = "attempt-20260903-002";
  candidate.rcWorkflowRunId = "702";
  candidate.exactObjects[1].key = `evidence/v1/attempt-20260903-002/702/execution-purpose-envelope.v1/${candidate.exactObjects[1].digest.slice(7)}`;

  assert.deepEqual(candidate.exactObjects[0], claim);
  assert.doesNotThrow(() => validateLineageAccessReadback(candidate));
});

test("lineage retention receipt requires whole-lineage and legal-hold boundaries", () => {
  assert.doesNotThrow(() => validateLineageRetentionReceipt(validLineageRetentionReceipt()));
  for (const mutate of [
    (value) => (value.appliedAt = "2027-03-31T23:59:59.000Z"),
    (value) => (value.legalHoldUntil = "2027-05-01T00:00:00.000Z"),
    (value) => (value.objects[0].key = "evidence/v1/*")
  ]) {
    const candidate = validLineageRetentionReceipt();
    mutate(candidate);
    assert.throws(() => validateLineageRetentionReceipt(candidate));
  }
});

test("lineage retention receipt derives every exact key and rejects duplicate addresses", () => {
  const valid = validLineageRetentionReceipt();
  assert.doesNotThrow(() => validateLineageRetentionReceipt(valid));

  for (const mutate of [
    (value) =>
      (value.objects[0].key = `evidence/v1/wrong-attempt/701/release-aggregate-proof.v2/${"a".repeat(64)}`),
    (value) =>
      (value.objects[0].key = `evidence/v1/${releaseAttemptId}/702/release-aggregate-proof.v2/${"a".repeat(64)}`),
    (value) =>
      (value.objects[0].key = `evidence/v1/${releaseAttemptId}/701/release-aggregate-proof.v2/${"0".repeat(64)}`),
    (value) =>
      (value.objects[1].key = `evidence/claims/v1/source-gate-evidence.v1/${"0".repeat(64)}`),
    (value) => value.objects.push({ ...value.objects[0], version: "different-version" })
  ]) {
    const candidate = validLineageRetentionReceipt();
    mutate(candidate);
    assert.throws(() => validateLineageRetentionReceipt(candidate), {
      code: "LINEAGE_RETENTION_DISPOSITION_INVALID"
    });
  }
});

test("lineage retention receipt cannot relabel a purpose claim as ordinary lineage", () => {
  const candidate = validLineageRetentionReceipt();
  const claim = candidate.objects[1];
  claim.addressingKind = "lineage";
  claim.rawProofType = null;
  claim.rawProofDigest = null;
  claim.key = `evidence/v1/${releaseAttemptId}/701/purpose-claim.v1/${claim.digest.slice(7)}`;

  assert.throws(() => validateLineageRetentionReceipt(candidate), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("every Task 4 custody and lineage schema compiles and accepts its positive fixture", () => {
  const policy = JSON.parse(
    readFileSync(
      new URL("../../../release/contracts/evidence-lineage-storage-policy.v1.json", import.meta.url)
    )
  );
  for (const [schemaId, value] of [
    ["snapshot-private-custody.v1", validCustody()],
    ["snapshot-destruction-receipt.v1", validDestructionReceipt()],
    ["snapshot-retention-receipt.v1", validRetentionReceipt()],
    ["evidence-lineage-storage-policy.v1", policy],
    ["evidence-lineage-access-readback.v1", validLineageReadback()],
    ["evidence-lineage-retention-receipt.v1", validLineageRetentionReceipt()]
  ]) {
    assert.doesNotThrow(() => validateContract(schemaId, value), schemaId);
  }
});
