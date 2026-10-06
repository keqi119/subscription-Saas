import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical, validateContract } from "../src/index.mjs";
import {
  validateEvidenceArchiveAccessReceipt,
  validateEvidenceArchiveAuthorization,
  validateEvidenceCustodyBootstrapReadback,
  validatePrebuildSanitizedInputBinding
} from "../src/snapshot/custody-contracts.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const sourceSha = "b".repeat(40);
const knownArchiveProofTypes = [
  "approval-record.v1",
  "approval-revocations.v1",
  "external-change-approval.v1",
  "authoritative-custody-observation.v1",
  "custody-receipt.v1",
  "rc-dispatch-authorization.v1",
  "i0-revocation-state.v1",
  "environment-policy-observation.v1",
  "infrastructure-change.v1",
  "producer-crypto-run-authorization.v1",
  "producer-crypto-use-proof.v1",
  "evidence-archive-authorization.v1",
  "evidence-archive-access-receipt.v1",
  "evidence-custody-bootstrap-readback.v1",
  "producer-terminal-observation.v1",
  "snapshot-jit-launch-proof.v1",
  "snapshot-producer-completion.v1",
  "snapshot-private-custody.v1",
  "snapshot-destruction-receipt.v1",
  "snapshot-retention-receipt.v1",
  "evidence-lineage-retention-receipt.v1",
  "build-proof.v1",
  "build-material-observation.v1",
  "post-state-observation.v1",
  "launch-attestation.v1",
  "prebuild-sanitized-input-binding.v1",
  "source-gate-evidence.v1",
  "execution-proof.v1",
  "final-compose-evidence.v1",
  "exact-capability-approval.v1",
  "exact-capability-approval.v2",
  "exact-run-capability-plan.v1",
  "exact-run-capability-readback.v1",
  "exact-run-capability-revocation.v1",
  "publisher-sts-use-proof.v1",
  "oidc-cloud-role-use-proof.v1",
  "jit-registration-use-proof.v1",
  "lineage-oss-role-use-proof.v1",
  "lineage-storage-access-receipt.v1",
  "bootstrap-canary-run-authorization.v1",
  "bootstrap-canary-execution-proof.v1",
  "bootstrap-canary-checkpoint.v1",
  "snapshot-adapter-build-plan.v1",
  "snapshot-adapter-build-proof.v1",
  "snapshot-adapter-artifact-custody.v1",
  "three-image-bundle-build-plan.v1"
];

function validArchiveAuthorization(profile = "archive-create-only-writer") {
  const contentDigest = digest("1");
  const principal =
    profile === "archive-create-only-writer"
      ? "archive-writer-principal"
      : "archive-reader-principal";
  return {
    schemaVersion: "evidence-archive-authorization.v1",
    authorizationId: `archive-auth-${profile}`,
    operationId: "archive-operation-001",
    profile,
    executor: {
      sourceDigest: digest("2"),
      runtimeDigest: digest("3"),
      principal,
      publicKeyDigest: digest("4")
    },
    resource: {
      region: "oss-cn-shanghai",
      bucket: "subscription-saas-stage1-snapshot-0123456789ab-cn-shanghai",
      bucketFingerprint: digest("5"),
      policyDigest: digest("6")
    },
    objects: [
      {
        proofType: "approval-record.v1",
        canonicalDigest: contentDigest,
        exactKey: `control-evidence/v1/approval-record.v1/${contentDigest.replace(":", "-")}`,
        contentDigest,
        contentSizeBytes: 2048
      }
    ],
    permissions:
      profile === "archive-create-only-writer"
        ? { actions: ["oss:PutObject"], conditionalCreate: true, exactKeysOnly: true }
        : {
            actions: [
              "oss:HeadObject",
              "oss:GetObject",
              "oss:GetObjectAcl",
              "oss:GetBucketAcl",
              "oss:GetBucketWorm",
              "oss:GetBucketVersioning"
            ],
            conditionalCreate: false,
            exactKeysOnly: true
          },
    chain: {
      changePlanDigest: digest("7"),
      externalChangeApprovalDigest: digest("8"),
      applyProofDigest: digest("9"),
      resourceReadbackDigest: digest("a"),
      predecessorTerminalReceiptDigest:
        profile === "archive-create-only-writer" ? null : digest("b")
    },
    identities: {
      management: "archive-management-principal",
      writer: "archive-writer-principal",
      reader: "archive-reader-principal"
    },
    issuer: { id: "archive-control-plane", keyId: "archive-root-key-001" },
    issuedAt: "2026-09-03T00:00:00.000Z",
    notAfter: "2026-09-03T00:15:00.000Z",
    revocationPolicyDigest: digest("c"),
    custodyPolicyDigest: digest("d")
  };
}

function validArchiveAccessReceipt(authorization = validArchiveAuthorization()) {
  const object = authorization.objects[0];
  return {
    schemaVersion: "evidence-archive-access-receipt.v1",
    receiptId: "archive-access-receipt-001",
    authorizationDigest: sha256Canonical(authorization),
    operationId: authorization.operationId,
    profile: authorization.profile,
    session: {
      fingerprint: digest("e"),
      principal: authorization.executor.principal,
      issuedAt: "2026-09-03T00:01:00.000Z",
      expiresAt: "2026-09-03T00:11:00.000Z",
      terminalState: "REVOKED",
      terminalAt: "2026-09-03T00:05:00.000Z",
      terminalReceiptDigest: digest("f")
    },
    actions: [
      ...(authorization.profile === "archive-create-only-writer"
        ? ["oss:PutObject"]
        : ["oss:HeadObject", "oss:GetObject"]
      ).map((action, index) => ({
        objectKey: object.exactKey,
        action,
        result: "SUCCESS",
        conditionalCreate: authorization.profile === "archive-create-only-writer" ? true : false,
        requestId: `oss-request-00${index + 1}`
      }))
    ],
    objectResults: [
      {
        objectKey: object.exactKey,
        objectVersion: "null-version-disabled",
        etag: "0123456789ABCDEF0123456789ABCDEF",
        contentDigest: object.contentDigest,
        contentSizeBytes: object.contentSizeBytes
      }
    ],
    observationDigest: authorization.profile === "archive-readback-reader" ? digest("0") : null,
    issuer: "archive-control-plane",
    issuedAt: "2026-09-03T00:06:00.000Z"
  };
}

function validBootstrapReadback() {
  return {
    schemaVersion: "evidence-custody-bootstrap-readback.v1",
    operationId: "i0-bootstrap-001",
    repository: { name: "keqi119/subscription-Saas", id: "1253231368" },
    custodyBackend: "private-oss-worm",
    executorSourceDigest: digest("1"),
    executorRuntimeDigest: digest("2"),
    signerRootDigest: digest("3"),
    bucket: {
      region: "oss-cn-shanghai",
      name: "subscription-saas-stage1-snapshot-0123456789ab-cn-shanghai",
      fingerprint: digest("4"),
      acl: "private",
      versioning: "Disabled",
      forbidOverwrite: true,
      worm: { id: "worm-policy-001", state: "Locked", retentionDays: 210 }
    },
    identities: {
      management: "archive-management-principal",
      writer: "archive-writer-principal",
      reader: "archive-reader-principal"
    },
    importedOriginals: [
      {
        subjectType: "approval-record.v1",
        originalBytesDigest: digest("5"),
        originalBytesSize: 2048,
        objectKey: `control-evidence/v1/approval-record.v1/${digest("5").replace(":", "-")}`,
        objectVersion: "null-version-disabled",
        authoritativeObservationDigest: digest("6")
      }
    ],
    writerAccessReceiptDigest: digest("7"),
    readerAccessReceiptDigest: digest("8"),
    revocationReadbackDigest: digest("9"),
    closedAt: "2026-09-03T00:10:00.000Z",
    status: "I0_CLOSED"
  };
}

function validPrebuildBinding() {
  return {
    schemaVersion: "prebuild-sanitized-input-binding.v1",
    bindingId: "prebuild-snapshot-input-001",
    sourceExecutionPurpose: "release-candidate",
    qualification: false,
    sourceSha,
    snapshotReleaseAttemptId: "prior-attempt-001",
    snapshotRunId: "9001",
    sanitizationContractDigest: digest("1"),
    snapshotDigest: digest("2"),
    envelopeDigest: digest("3"),
    ciphertext: {
      objectKey: "snapshot-slots/v2/prior-attempt-001/9001/snapshot.enc",
      objectVersion: "null-version-disabled",
      etag: "0123456789ABCDEF0123456789ABCDEF",
      digest: digest("4"),
      sizeBytes: 8192
    },
    snapshotExpiresAt: "2026-10-03T00:00:00.000Z",
    custody: {
      available: true,
      authoritativeObservationDigest: digest("5"),
      archiveAccessReceiptDigest: digest("6"),
      retainUntil: "2027-04-01T00:00:00.000Z"
    },
    readDecryptUseAuthority: {
      authorityKind: "prebuild-independent-read-decrypt-use",
      authorityDigest: digest("7"),
      issuer: "prebuild-input-authority",
      consumerPrincipal: "prebuild-snapshot-consumer",
      sourceProducerPrincipal: "source-snapshot-producer",
      sourcePublisherPrincipal: "source-snapshot-publisher",
      exactObjectKey: "snapshot-slots/v2/prior-attempt-001/9001/snapshot.enc",
      validFrom: "2026-09-03T00:00:00.000Z",
      validUntil: "2026-09-10T00:00:00.000Z",
      verificationProtocol: "external-facts-required-task17b"
    },
    capacityUpperBounds: {
      ciphertextBytes: 1073741824,
      plaintextBytes: 2147483648,
      restoredDatabaseBytes: 4294967296
    },
    issuedAt: "2026-09-03T00:00:00.000Z"
  };
}

test("archive authorization accepts exact create-only and readback-only profiles", () => {
  assert.doesNotThrow(() =>
    validateEvidenceArchiveAuthorization(validArchiveAuthorization("archive-create-only-writer"))
  );
  assert.doesNotThrow(() =>
    validateEvidenceArchiveAuthorization(validArchiveAuthorization("archive-readback-reader"))
  );
});

test("archive authorization rejects prefixes, combined identity, and v1/v2 capability substitution", () => {
  for (const mutate of [
    (value) => (value.objects[0].exactKey = "control-evidence/v1/approval-record.v1/*"),
    (value) =>
      (value.objects[0].exactKey = `control-evidence/v1/approval-record.v1/${value.objects[0].canonicalDigest}`),
    (value) => (value.identities.reader = value.identities.writer),
    (value) => (value.issuer.id = value.identities.writer),
    (value) => (value.profile = "publisher-sts"),
    (value) => (value.approvalSchemaVersion = "exact-capability-approval.v2")
  ]) {
    const candidate = validArchiveAuthorization();
    mutate(candidate);
    assert.throws(() => validateEvidenceArchiveAuthorization(candidate));
  }
});

test("bootstrap readback rejects the former colon object key", () => {
  const readback = validBootstrapReadback();
  readback.importedOriginals[0].objectKey = `control-evidence/v1/approval-record.v1/${readback.importedOriginals[0].originalBytesDigest}`;
  assert.throws(() => validateEvidenceCustodyBootstrapReadback(readback), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("archive authorization requires complete frozen byte facts", () => {
  const candidate = validArchiveAuthorization();
  delete candidate.objects[0].contentSizeBytes;
  assert.throws(() => validateEvidenceArchiveAuthorization(candidate), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("I0 revocation state archives its existing closed dispatch-verifier body", () => {
  const state = {
    schemaVersion: "i0-revocation-state.v1",
    policyDigest: digest("a"),
    sequence: 0,
    revokedAuthorizationIds: [],
    revokedAuthorizationDigests: []
  };
  assert.doesNotThrow(() => validateContract("i0-revocation-state.v1", state));
  const authorization = validArchiveAuthorization();
  const stateDigest = sha256Canonical(state);
  authorization.objects[0] = {
    proofType: state.schemaVersion,
    canonicalDigest: stateDigest,
    exactKey: `control-evidence/v1/${state.schemaVersion}/${stateDigest.replace(":", "-")}`,
    contentDigest: stateDigest,
    contentSizeBytes: JSON.stringify(state).length
  };
  assert.doesNotThrow(() => validateEvidenceArchiveAuthorization(authorization));
  for (const change of [
    { schemaVersion: "approval-revocations.v1" },
    { sequence: -1 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { revokedAuthorizationIds: ["same", "same"] },
    { revokedAuthorizationIds: Array.from({ length: 10001 }, (_, i) => `auth-${i}`) },
    { revokedAuthorizationDigests: ["unverified"] },
    { nonce: "online-response-is-not-the-state" }
  ]) {
    assert.throws(() => validateContract("i0-revocation-state.v1", { ...state, ...change }), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

test("archive authorization closes over every known control-evidence proof type only", () => {
  for (const proofType of knownArchiveProofTypes) {
    const candidate = validArchiveAuthorization();
    candidate.objects[0].proofType = proofType;
    candidate.objects[0].exactKey = `control-evidence/v1/${proofType}/${candidate.objects[0].canonicalDigest.replace(":", "-")}`;
    assert.doesNotThrow(() => validateEvidenceArchiveAuthorization(candidate), proofType);
  }
  for (const proofType of [
    "snapshot.enc",
    "purpose-claim.v1",
    "execution-purpose-envelope.v1",
    "custody-receipt.v2",
    "release-aggregate-proof.v2",
    "s1-exit-evidence.v2"
  ]) {
    const candidate = validArchiveAuthorization();
    candidate.objects[0].proofType = proofType;
    candidate.objects[0].exactKey = `control-evidence/v1/${proofType}/${candidate.objects[0].canonicalDigest.replace(":", "-")}`;
    assert.throws(() => validateEvidenceArchiveAuthorization(candidate), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

test("archive access receipt records actual actions and a terminal isolated session", () => {
  const writerAuthorization = validArchiveAuthorization();
  assert.doesNotThrow(() =>
    validateEvidenceArchiveAccessReceipt(validArchiveAccessReceipt(writerAuthorization), {
      authorization: writerAuthorization
    })
  );
  const readerAuthorization = validArchiveAuthorization("archive-readback-reader");
  assert.doesNotThrow(() =>
    validateEvidenceArchiveAccessReceipt(validArchiveAccessReceipt(readerAuthorization), {
      authorization: readerAuthorization
    })
  );
});

test("archive access receipt is unusable without its exact authorization", () => {
  assert.throws(() => validateEvidenceArchiveAccessReceipt(validArchiveAccessReceipt()), {
    code: "EVIDENCE_ARCHIVE_AUTHORIZATION_REQUIRED"
  });
});

test("archive session stays within its bound authorization lifetime", () => {
  const authorization = validArchiveAuthorization();
  const before = validArchiveAccessReceipt(authorization);
  before.session.issuedAt = "2026-09-02T23:59:00.000Z";
  before.session.expiresAt = "2026-09-03T00:09:00.000Z";
  assert.throws(() => validateEvidenceArchiveAccessReceipt(before, { authorization }), {
    code: "EVIDENCE_ARCHIVE_ACCESS_INVALID"
  });

  const after = validArchiveAccessReceipt(authorization);
  after.session.issuedAt = "2026-09-03T00:15:00.001Z";
  after.session.expiresAt = "2026-09-03T00:25:00.001Z";
  after.session.terminalAt = "2026-09-03T00:20:00.000Z";
  after.issuedAt = "2026-09-03T00:21:00.000Z";
  assert.throws(() => validateEvidenceArchiveAccessReceipt(after, { authorization }), {
    code: "EVIDENCE_ARCHIVE_ACCESS_INVALID"
  });

  const exactExpiry = validArchiveAccessReceipt(authorization);
  exactExpiry.session.issuedAt = authorization.notAfter;
  exactExpiry.session.expiresAt = "2026-09-03T00:30:00.000Z";
  exactExpiry.session.terminalAt = "2026-09-03T00:20:00.000Z";
  exactExpiry.issuedAt = "2026-09-03T00:21:00.000Z";
  assert.throws(() => validateEvidenceArchiveAccessReceipt(exactExpiry, { authorization }), {
    code: "EVIDENCE_ARCHIVE_ACCESS_INVALID"
  });

  const boundary = validArchiveAccessReceipt(authorization);
  boundary.session.issuedAt = "2026-09-03T00:14:59.999Z";
  boundary.session.expiresAt = "2026-09-03T00:29:59.999Z";
  boundary.session.terminalAt = "2026-09-03T00:20:00.000Z";
  boundary.issuedAt = "2026-09-03T00:21:00.000Z";
  assert.doesNotThrow(() => validateEvidenceArchiveAccessReceipt(boundary, { authorization }));
});

test("archive reader cannot self-read as writer or claim a successful receipt without observation", () => {
  const authorization = validArchiveAuthorization("archive-readback-reader");
  for (const mutate of [
    (value) => (value.session.principal = authorization.identities.writer),
    (value) => (value.issuer = value.session.principal),
    (value) => (value.observationDigest = null),
    (value) => (value.actions[0].action = "oss:PutObject")
  ]) {
    const candidate = validArchiveAccessReceipt(authorization);
    mutate(candidate);
    assert.throws(() => validateEvidenceArchiveAccessReceipt(candidate, { authorization }));
  }
});

test("archive reader receipt requires both Head and Get for every frozen object", () => {
  const authorization = validArchiveAuthorization("archive-readback-reader");
  const candidate = validArchiveAccessReceipt(authorization);
  candidate.actions = candidate.actions.filter(({ action }) => action !== "oss:HeadObject");
  assert.throws(() => validateEvidenceArchiveAccessReceipt(candidate, { authorization }), {
    code: "EVIDENCE_ARCHIVE_ACCESS_INVALID"
  });
});

test("archive receipt requires one result for every authorized exact key", () => {
  const authorization = validArchiveAuthorization("archive-readback-reader");
  authorization.objects.push({
    proofType: "external-change-approval.v1",
    canonicalDigest: digest("2"),
    exactKey: `control-evidence/v1/external-change-approval.v1/${digest("2").replace(":", "-")}`,
    contentDigest: digest("2"),
    contentSizeBytes: 4096
  });
  const candidate = validArchiveAccessReceipt(authorization);
  for (const action of ["oss:HeadObject", "oss:GetObject"]) {
    candidate.actions.push({
      objectKey: authorization.objects[1].exactKey,
      action,
      result: "SUCCESS",
      conditionalCreate: false,
      requestId: `second-${action}`
    });
  }
  candidate.objectResults.push({
    ...candidate.objectResults[0],
    etag: "FEDCBA9876543210FEDCBA9876543210"
  });
  assert.throws(() => validateEvidenceArchiveAccessReceipt(candidate, { authorization }), {
    code: "EVIDENCE_ARCHIVE_ACCESS_INVALID"
  });
});

test("archive receipts cannot add a reference to their own later archive receipt", () => {
  const candidate = { ...validArchiveAccessReceipt(), laterArchiveReceiptDigest: digest("f") };
  assert.throws(() => validateContract("evidence-archive-access-receipt.v1", candidate), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("bootstrap readback accepts only private locked OSS custody with separated identities", () => {
  assert.doesNotThrow(() => validateEvidenceCustodyBootstrapReadback(validBootstrapReadback()));
  for (const mutate of [
    (value) => (value.custodyBackend = "github-actions"),
    (value) => {
      value.bucket.acl = "public-read";
      value.bucket.worm.retentionDays = 180;
    },
    (value) => (value.identities.reader = value.identities.writer)
  ]) {
    const candidate = validBootstrapReadback();
    mutate(candidate);
    assert.throws(() => validateEvidenceCustodyBootstrapReadback(candidate));
  }
});

test("prebuild sanitized input accepts an unexpired non-qualification snapshot with independent authority", () => {
  assert.doesNotThrow(() =>
    validatePrebuildSanitizedInputBinding(validPrebuildBinding(), {
      now: "2026-09-04T00:00:00.000Z"
    })
  );
});

test("prebuild sanitized input rejects expiry, unavailable custody, missing authority, and invalid bounds", () => {
  for (const mutate of [
    (value) => (value.snapshotExpiresAt = "2026-09-03T00:00:00.000Z"),
    (value) => (value.custody.available = false),
    (value) => delete value.readDecryptUseAuthority.authorityDigest,
    (value) =>
      (value.readDecryptUseAuthority.consumerPrincipal =
        value.readDecryptUseAuthority.sourceProducerPrincipal),
    (value) => (value.capacityUpperBounds.plaintextBytes = -1),
    (value) => (value.capacityUpperBounds.restoredDatabaseBytes = null)
  ]) {
    const candidate = validPrebuildBinding();
    mutate(candidate);
    assert.throws(() =>
      validatePrebuildSanitizedInputBinding(candidate, { now: "2026-09-04T00:00:00.000Z" })
    );
  }
});

test("prebuild byte upper bounds cover the known ciphertext and plaintext length", () => {
  for (const field of ["ciphertextBytes", "plaintextBytes"]) {
    const below = validPrebuildBinding();
    below.capacityUpperBounds[field] = 8191;
    assert.throws(
      () =>
        validatePrebuildSanitizedInputBinding(below, {
          now: "2026-09-04T00:00:00.000Z"
        }),
      { code: "PREBUILD_SANITIZED_INPUT_INVALID" }
    );

    for (const validBound of [8192, 8193]) {
      const candidate = validPrebuildBinding();
      candidate.capacityUpperBounds[field] = validBound;
      assert.doesNotThrow(() =>
        validatePrebuildSanitizedInputBinding(candidate, {
          now: "2026-09-04T00:00:00.000Z"
        })
      );
    }
  }

  for (const [field, invalidBound] of [
    ["ciphertextBytes", 1073741825],
    ["plaintextBytes", 1099511627777],
    ["plaintextBytes", 8192.5],
    ["plaintextBytes", "8192"]
  ]) {
    const candidate = validPrebuildBinding();
    candidate.capacityUpperBounds[field] = invalidBound;
    assert.throws(
      () =>
        validatePrebuildSanitizedInputBinding(candidate, {
          now: "2026-09-04T00:00:00.000Z"
        }),
      { code: "CONTRACT_SCHEMA_INVALID" }
    );
  }
});

test("prebuild input rejects current attempt, Producer, and build-proof claims", () => {
  for (const field of ["currentReleaseAttemptId", "producerCompletionDigest", "buildProofDigest"]) {
    const candidate = validPrebuildBinding();
    candidate[field] = digest("a");
    assert.throws(() => validateContract("prebuild-sanitized-input-binding.v1", candidate), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

test("every Task 4 archive and prebuild schema accepts its positive fixture", () => {
  for (const [schemaId, value] of [
    ["evidence-archive-authorization.v1", validArchiveAuthorization()],
    ["evidence-archive-access-receipt.v1", validArchiveAccessReceipt()],
    ["evidence-custody-bootstrap-readback.v1", validBootstrapReadback()],
    ["prebuild-sanitized-input-binding.v1", validPrebuildBinding()]
  ]) {
    assert.doesNotThrow(() => validateContract(schemaId, value), schemaId);
  }
});
