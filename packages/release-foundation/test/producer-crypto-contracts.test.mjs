import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sha256Bytes, sha256Canonical, validateContract } from "../src/index.mjs";
import {
  validateProducerCryptoAuthorization,
  validateProducerCryptoUseProof,
  validateSnapshotEncryptionEnvelope
} from "../src/snapshot/producer-crypto-contracts.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const sourceSha = "b".repeat(40);
const allocatedAt = "2026-09-03T00:00:00.000Z";
const expiresAt = "2026-10-03T00:00:00.000Z";

function validAuthorization() {
  const context = {
    repositoryId: "1253231368",
    sourceSha,
    releaseAttemptId: "attempt-20260903-001",
    snapshotRunId: "9001",
    sanitizationContractDigest: digest("1"),
    expiresAt
  };
  return {
    schemaVersion: "producer-crypto-run-authorization.v1",
    authorizationId: "crypto-authorization-001",
    executionPurpose: "release-candidate",
    repository: { name: "keqi119/subscription-Saas", id: "1253231368" },
    sourceSha,
    releaseAttemptId: context.releaseAttemptId,
    snapshotRunId: context.snapshotRunId,
    snapshotAllocatedAt: allocatedAt,
    producer: {
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      runId: "9001",
      runAttempt: 1,
      jobId: "snapshot-data",
      phase: "encryption",
      pendingDeploymentId: "deployment-001",
      environment: {
        name: "stage1-snapshot-export",
        id: "environment-001",
        policyIdentityDigest: digest("0")
      }
    },
    bindings: {
      dispatchAuthorizationDigest: digest("2"),
      sourceGateEvidenceDigest: digest("3"),
      buildProofDigest: digest("4"),
      buildBundleDigest: digest("5"),
      repositoryContractDigest: digest("6"),
      adapterExecutableDigest: digest("7"),
      cryptoExecutableDigest: digest("8")
    },
    issuer: {
      issuerId: "producer-crypto-issuer",
      principal: "acs:ram::123456789012:role/producer-crypto-issuer",
      roleArn: "acs:ram::123456789012:role/producer-crypto-generate-only",
      publisherBrokerPrincipal: "acs:ram::123456789012:role/snapshot-publisher-broker"
    },
    kms: {
      region: "cn-shanghai",
      endpoint: "kms.cn-shanghai.aliyuncs.com",
      keyId: "key-actual-001",
      keyAlias: "alias/stage1-snapshot-custody",
      keyAliasReadbackId: "key-actual-001",
      action: "kms:GenerateDataKey",
      keySpec: "AES_256",
      maxCalls: 1,
      context,
      contextDigest: sha256Canonical(context),
      allowedActions: ["kms:GenerateDataKey"],
      deniedActions: [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:AsymmetricDecrypt",
        "kms:ManageKey",
        "oss:*",
        "database:*",
        "jit:*",
        "sts:AssumeRole"
      ]
    },
    session: { requestedDurationSeconds: 600, maxDurationSeconds: 900 },
    handoff: {
      protocol: "sealed-fd-v1",
      sealedFdOnly: true,
      environment: false,
      argv: false,
      stdin: false,
      workspace: false
    },
    prerequisites: {
      changePlanDigest: digest("9"),
      externalChangeApprovalDigest: digest("a"),
      applyProofDigest: digest("c"),
      providerReadbackDigest: digest("d"),
      rolePolicyReadbackDigest: digest("e"),
      keyPolicyReadbackDigest: digest("f"),
      sessionPolicyReadbackDigest: digest("0"),
      readbackDigest: digest("1"),
      completedAt: "2026-09-03T00:04:00.000Z"
    },
    issuedAt: "2026-09-03T00:05:00.000Z",
    notBefore: "2026-09-03T00:05:00.000Z",
    notAfter: "2026-09-03T00:15:00.000Z",
    revocationPolicyDigest: digest("2"),
    custodyAuthorizationDigest: digest("3")
  };
}

function validEnvelope(authorization = validAuthorization()) {
  const kmsContext = structuredClone(authorization.kms.context);
  const kmsContextDigest = sha256Canonical(kmsContext);
  const aad = { ...kmsContext, snapshotDigest: digest("4"), kmsContextDigest };
  const wrappedDekBytes = Buffer.alloc(64, 3);
  return {
    schemaVersion: "snapshot-encryption-envelope.v1",
    algorithm: "AES-256-GCM",
    releaseAttemptId: authorization.releaseAttemptId,
    snapshotRunId: authorization.snapshotRunId,
    sourceSha: authorization.sourceSha,
    snapshotDigest: aad.snapshotDigest,
    sanitizationContractDigest: kmsContext.sanitizationContractDigest,
    slotObjectKey: `snapshot-slots/v2/${authorization.releaseAttemptId}/${authorization.snapshotRunId}/snapshot.enc`,
    nonceBase64: Buffer.alloc(12, 1).toString("base64"),
    authenticationTagBase64: Buffer.alloc(16, 2).toString("base64"),
    ciphertextDigest: digest("6"),
    ciphertextSizeBytes: 8192,
    wrappedDek: {
      ciphertextBase64: wrappedDekBytes.toString("base64"),
      digest: sha256Bytes(wrappedDekBytes)
    },
    kmsKeyReadback: {
      region: "cn-shanghai",
      keyId: authorization.kms.keyId,
      alias: "alias/stage1-snapshot-custody",
      aliasReadbackKeyId: authorization.kms.keyId
    },
    kmsContext,
    kmsContextDigest,
    gcmAad: { ...aad, digest: sha256Canonical(aad) },
    snapshotAllocatedAt: authorization.snapshotAllocatedAt,
    expiresAt: authorization.kms.context.expiresAt
  };
}

function validUseProof(authorization = validAuthorization()) {
  const envelope = validEnvelope(authorization);
  return {
    schemaVersion: "producer-crypto-use-proof.v1",
    publishable: true,
    failureKind: null,
    authorizationDigest: sha256Canonical(authorization),
    prerequisiteReadbackDigest: authorization.prerequisites.readbackDigest,
    dataObservationDigest: digest("8"),
    request: {
      requestId: "kms-request-001",
      action: "kms:GenerateDataKey",
      keySpec: "AES_256",
      keyId: authorization.kms.keyId,
      contextDigest: authorization.kms.contextDigest,
      callCount: 1,
      outcome: "SUCCESS"
    },
    session: {
      fingerprint: digest("9"),
      issuedAt: "2026-09-03T00:05:30.000Z",
      expiresAt: "2026-09-03T00:15:00.000Z",
      terminalState: "REVOKED",
      terminalAt: "2026-09-03T00:08:00.000Z",
      terminalReceiptDigest: digest("a")
    },
    encryption: {
      envelopeDigest: sha256Canonical(envelope),
      ciphertextDigest: envelope.ciphertextDigest,
      wrappedDekDigest: envelope.wrappedDek.digest
    },
    cleanup: {
      coreDumpDisabled: true,
      memoryLocked: true,
      keyBufferClear: "BEST_EFFORT_COMPLETED",
      processExitedAt: "2026-09-03T00:07:30.000Z"
    },
    issuer: "producer-crypto-proof-signer",
    issuedAt: "2026-09-03T00:08:10.000Z"
  };
}

test("snapshot slot policy freezes exact filenames and fail-closed size ceilings", () => {
  const policy = JSON.parse(
    readFileSync(
      new URL(
        "../../../release/contracts/policies/snapshot-object-addressing.v2.json",
        import.meta.url
      )
    )
  );
  assert.deepEqual(policy.outputs, [
    { filename: "snapshot.enc", maxSizeBytes: 1073741824 },
    { filename: "encryption-envelope.json", maxSizeBytes: 1048576 },
    { filename: "snapshot-proof.json", maxSizeBytes: 1048576 },
    { filename: "diagnostics.redacted.json", maxSizeBytes: 1048576 },
    { filename: "data-result.json", maxSizeBytes: 1048576 }
  ]);
  assert.equal(policy.exactKeysOnly, true);
});

test("producer crypto authorization accepts only the pre-existing generate-only phase", () => {
  assert.doesNotThrow(() => validateProducerCryptoAuthorization(validAuthorization()));
  for (const mutate of [
    (value) => (value.producer.phase = "publisher"),
    (value) => value.kms.allowedActions.push("kms:Decrypt"),
    (value) => (value.session.requestedDurationSeconds = 901),
    (value) => (value.issuer.principal = value.issuer.publisherBrokerPrincipal),
    (value) => (value.issuer.principal = value.issuer.roleArn),
    (value) => (value.snapshotRunId = "9002"),
    (value) => delete value.producer.environment.policyIdentityDigest,
    (value) => (value.prerequisites.completedAt = "2026-09-03T00:06:00.000Z")
  ]) {
    const candidate = validAuthorization();
    mutate(candidate);
    assert.throws(() => validateProducerCryptoAuthorization(candidate));
  }
});

test("producer run allocation cannot postdate authorization issuance", () => {
  const late = validAuthorization();
  late.snapshotAllocatedAt = "2026-09-04T00:00:00.000Z";
  late.kms.context.expiresAt = "2026-10-04T00:00:00.000Z";
  late.kms.contextDigest = sha256Canonical(late.kms.context);
  const lateEnvelope = validEnvelope(late);
  const lateProof = validUseProof(late);
  assert.throws(() => validateProducerCryptoAuthorization(late), {
    code: "PRODUCER_CRYPTO_AUTHORIZATION_INVALID"
  });
  assert.throws(
    () =>
      validateProducerCryptoUseProof(lateProof, { authorization: late, envelope: lateEnvelope }),
    { code: "PRODUCER_CRYPTO_AUTHORIZATION_INVALID" }
  );

  const boundary = validAuthorization();
  boundary.snapshotAllocatedAt = boundary.issuedAt;
  boundary.kms.context.expiresAt = "2026-10-03T00:05:00.000Z";
  boundary.kms.contextDigest = sha256Canonical(boundary.kms.context);
  const boundaryEnvelope = validEnvelope(boundary);
  const boundaryProof = validUseProof(boundary);
  assert.doesNotThrow(() => validateProducerCryptoAuthorization(boundary));
  assert.doesNotThrow(() =>
    validateProducerCryptoUseProof(boundaryProof, {
      authorization: boundary,
      envelope: boundaryEnvelope
    })
  );
});

test("producer crypto authorization rejects future proof and v1/v2 authority fields", () => {
  for (const field of [
    "environmentObservationDigest",
    "ciphertextDigest",
    "wrappedDek",
    "useProofDigest",
    "exactCapabilityApprovalVersion"
  ]) {
    const candidate = validAuthorization();
    candidate[field] = digest("f");
    assert.throws(() => validateProducerCryptoAuthorization(candidate), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

test("encryption envelope validates fixed context, allocation expiry, AAD, and binary bounds", () => {
  const authorization = validAuthorization();
  assert.doesNotThrow(() =>
    validateSnapshotEncryptionEnvelope(validEnvelope(authorization), { authorization })
  );
  for (const mutate of [
    (value) => (value.expiresAt = "2026-10-03T00:00:00.001Z"),
    (value) => (value.kmsContext.sourceSha = "c".repeat(40)),
    (value) => (value.gcmAad.digest = digest("0")),
    (value) => (value.nonceBase64 = Buffer.alloc(11, 1).toString("base64")),
    (value) => (value.wrappedDek.ciphertextBase64 = Buffer.alloc(64, 4).toString("base64")),
    (value) => (value.ciphertextSizeBytes = 1073741825)
  ]) {
    const candidate = validEnvelope(authorization);
    mutate(candidate);
    assert.throws(() => validateSnapshotEncryptionEnvelope(candidate, { authorization }));
  }
});

test("encryption envelope rejects plaintext key material with public schema error intact", () => {
  const candidate = { ...validEnvelope(), plaintextDek: "secret" };
  assert.throws(
    () => validateContract("snapshot-encryption-envelope.v1", candidate),
    (error) => {
      assert.equal(error.code, "CONTRACT_SCHEMA_INVALID");
      assert.ok(error.details.errors.some(({ keyword }) => keyword === "additionalProperties"));
      return true;
    }
  );
});

test("encryption envelope keeps only the canonical 96-bit nonce representation", () => {
  const authorization = validAuthorization();
  const envelope = validEnvelope(authorization);
  delete envelope.nonceUniqueness;
  assert.doesNotThrow(() => validateSnapshotEncryptionEnvelope(envelope, { authorization }));

  const legacy = validEnvelope(authorization);
  legacy.nonceUniqueness = {
    scope: "kms-key-and-snapshot-run",
    uniquenessProofDigest: digest("5")
  };
  assert.throws(() => validateContract("snapshot-encryption-envelope.v1", legacy), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("producer crypto use proof requires one successful call, cleanup, and terminal session", () => {
  const authorization = validAuthorization();
  const envelope = validEnvelope(authorization);
  const proof = validUseProof(authorization);
  assert.doesNotThrow(() => validateProducerCryptoUseProof(proof, { authorization, envelope }));
  for (const mutate of [
    (value) => (value.request.callCount = 2),
    (value) => (value.request.outcome = "INTERRUPTED_UNKNOWN"),
    (value) => (value.cleanup.keyBufferClear = "UNKNOWN"),
    (value) => (value.session.terminalState = "ACTIVE"),
    (value) => (value.session.terminalAt = "2026-09-03T00:07:00.000Z")
  ]) {
    const candidate = validUseProof(authorization);
    mutate(candidate);
    assert.throws(() => validateProducerCryptoUseProof(candidate, { authorization, envelope }));
  }
});

test("producer crypto success proof is unusable without its authorization and envelope", () => {
  const authorization = validAuthorization();
  const envelope = validEnvelope(authorization);
  const proof = validUseProof(authorization);
  assert.throws(() => validateProducerCryptoUseProof(proof), {
    code: "PRODUCER_CRYPTO_USE_CONTEXT_REQUIRED"
  });
  assert.throws(() => validateProducerCryptoUseProof(proof, { authorization }), {
    code: "PRODUCER_CRYPTO_USE_CONTEXT_REQUIRED"
  });
  const wrongEnvelope = structuredClone(envelope);
  wrongEnvelope.ciphertextDigest = digest("0");
  assert.throws(() =>
    validateProducerCryptoUseProof(proof, { authorization, envelope: wrongEnvelope })
  );
});

test("producer crypto authorization bounds issuance while session duration remains separate", () => {
  const authorization = validAuthorization();
  const envelope = validEnvelope(authorization);
  const delayed = validUseProof(authorization);
  delayed.session.issuedAt = "2026-09-03T00:14:59.999Z";
  delayed.session.expiresAt = "2026-09-03T00:24:59.999Z";
  delayed.cleanup.processExitedAt = "2026-09-03T00:20:00.000Z";
  delayed.session.terminalAt = "2026-09-03T00:21:00.000Z";
  delayed.issuedAt = "2026-09-03T00:22:00.000Z";
  assert.doesNotThrow(() => validateProducerCryptoUseProof(delayed, { authorization, envelope }));

  const atExpiry = structuredClone(delayed);
  atExpiry.session.issuedAt = authorization.notAfter;
  assert.throws(() => validateProducerCryptoUseProof(atExpiry, { authorization, envelope }));

  const overlong = structuredClone(delayed);
  overlong.session.expiresAt = "2026-09-03T00:25:00.000Z";
  assert.throws(() => validateProducerCryptoUseProof(overlong, { authorization, envelope }));
});

test("producer crypto use proof preserves a closed non-publishable UNKNOWN failure record", () => {
  const authorization = validAuthorization();
  const success = validUseProof(authorization);
  const failure = {
    ...success,
    publishable: false,
    failureKind: "INTERRUPTED_UNKNOWN",
    dataObservationDigest: null,
    request: {
      requestId: null,
      action: "kms:GenerateDataKey",
      keySpec: "AES_256",
      keyId: null,
      contextDigest: null,
      callCount: 1,
      outcome: "SUCCESS"
    },
    session: {
      ...success.session,
      terminalState: "ACTIVE",
      terminalAt: null,
      terminalReceiptDigest: null
    },
    encryption: null,
    cleanup: {
      coreDumpDisabled: true,
      memoryLocked: true,
      keyBufferClear: null,
      processExitedAt: null
    }
  };
  assert.doesNotThrow(() => validateContract("producer-crypto-use-proof.v1", failure));

  const duplicateCall = structuredClone(failure);
  duplicateCall.request.callCount = 2;
  duplicateCall.request.outcome = "INTERRUPTED_UNKNOWN";
  assert.doesNotThrow(() => validateContract("producer-crypto-use-proof.v1", duplicateCall));
  assert.throws(
    () =>
      validateProducerCryptoUseProof(failure, {
        authorization,
        envelope: validEnvelope(authorization)
      }),
    {
      code: "PRODUCER_CRYPTO_USE_NOT_PUBLISHABLE"
    }
  );
});

test("producer crypto failure shape permits unavailable facts without accepting success fields", () => {
  const authorization = validAuthorization();
  const failedBeforeRequest = {
    ...validUseProof(authorization),
    publishable: false,
    failureKind: "FAILED"
  };
  delete failedBeforeRequest.dataObservationDigest;
  delete failedBeforeRequest.request;
  delete failedBeforeRequest.session;
  delete failedBeforeRequest.encryption;
  delete failedBeforeRequest.cleanup;
  assert.doesNotThrow(() => validateContract("producer-crypto-use-proof.v1", failedBeforeRequest));
  assert.throws(
    () =>
      validateProducerCryptoUseProof(failedBeforeRequest, {
        authorization,
        envelope: validEnvelope(authorization)
      }),
    { code: "PRODUCER_CRYPTO_USE_NOT_PUBLISHABLE" }
  );

  const mislabeledSuccess = validUseProof(authorization);
  mislabeledSuccess.publishable = false;
  mislabeledSuccess.failureKind = "FAILED";
  assert.throws(() => validateContract("producer-crypto-use-proof.v1", mislabeledSuccess), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("producer crypto use proof schema rejects secret-bearing fields", () => {
  const candidate = { ...validUseProof(), plaintextDek: "secret" };
  assert.throws(() => validateContract("producer-crypto-use-proof.v1", candidate), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});
