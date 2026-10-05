import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sha256Bytes, sha256Canonical, validateContract } from "../src/index.mjs";
import {
  validateProducerCryptoAuthorization,
  validateProducerCryptoUseProof,
  validateSnapshotEncryptionEnvelope
} from "../src/snapshot/producer-crypto-contracts.mjs";
import * as cryptoContracts from "../src/snapshot/producer-crypto-contracts.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const sourceSha = "b".repeat(40);
const allocatedAt = "2026-09-03T00:00:00.000Z";
const expiresAt = "2026-10-03T00:00:00.000Z";

let publicReadbackKeys;
function publicReadbacks() {
  publicReadbackKeys ??= generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
  const profile = JSON.parse(
    readFileSync(
      new URL("../../../release/contracts/manual-stage1-profile.v2.json", import.meta.url)
    )
  );
  profile.ownerId = "fixture-public-key-reader";
  const principal = { platform: "posix", uid: 1001 };
  const hostFingerprint = digest("d");
  const keyFingerprint = sha256Bytes(
    publicReadbackKeys.publicKey.export({ type: "spki", format: "der" })
  );
  const publicKeyPem = publicReadbackKeys.publicKey.export({ type: "spki", format: "pem" });
  const creation = {
    kind: "h1-snapshot-key-creation-readback",
    ownerId: profile.ownerId,
    principal: { ...principal },
    hostFingerprint,
    profileDigest: sha256Canonical(profile),
    createdAt: "2026-09-01T10:50:23.296Z",
    algorithm: "RSA-OAEP-SHA256",
    modulusLength: 3072,
    publicExponent: 65537,
    keyRef: "snapshot-rsa3072.pk8.der",
    keyFingerprint,
    publicKeyPem,
    softwareKeyExportable: true,
    challengeDomain: "subscription-saas/H1-snapshot-key-creation/v1",
    challengeDigest: digest("a"),
    wrappedChallengeDigest: digest("b"),
    roundtripVerified: true,
    promotionEligible: false
  };
  // Host records use insertion-order JSON.stringify, not canonical ordering.
  const creationRawDigest = sha256Bytes(Buffer.from(JSON.stringify(creation)));
  const recovery = {
    kind: "h1-snapshot-key-recovery-readback",
    verifiedAt: "2026-09-01T10:50:24.762Z",
    ownerId: profile.ownerId,
    hostFingerprint,
    profileDigest: creation.profileDigest,
    keyFingerprint,
    creationReadbackRawDigest: creationRawDigest,
    publicKeyPem,
    primaryVolumeClosed: true,
    sameHostIndependentEncryptedVolumeRestore: true,
    offHostRecoveryVerified: false,
    challengeDomain: "subscription-saas/H1-snapshot-independent-recovery/v1",
    challengeDigest: digest("c"),
    wrappedChallengeDigest: digest("e"),
    roundtripVerified: true,
    promotionEligible: false
  };
  return { creation, recovery, creationRawDigest, profile, hostFingerprint, principal };
}
function checkPublicReadbacks(value) {
  assert.equal(
    typeof cryptoContracts.validateH1SnapshotPublicKeyReadbacks,
    "function",
    "shared public-key original verifier must exist"
  );
  return cryptoContracts.validateH1SnapshotPublicKeyReadbacks(value);
}

test("H1 PUBLIC binds real SPKI key and original insertion-order raw digest without granting authority", () => {
  const value = publicReadbacks();
  assert.notEqual(value.creationRawDigest, sha256Canonical(value.creation));
  assert.equal(checkPublicReadbacks(value), undefined);
  assert.equal(value.creation.softwareKeyExportable, true);
  assert.equal(value.recovery.offHostRecoveryVerified, false);
});

test("H1 PUBLIC rejects mismatched identity, raw digest, historical order and extra data", () => {
  for (const mutate of [
    (v) => {
      v.creation.ownerId = "different-owner";
    },
    (v) => {
      v.creation.principal.uid++;
    },
    (v) => {
      v.hostFingerprint = digest("f");
    },
    (v) => {
      v.profile.ownerId += "-changed";
    },
    (v) => {
      v.recovery.profileDigest = digest("f");
    },
    (v) => {
      v.recovery.keyFingerprint = digest("f");
    },
    (v) => {
      v.creationRawDigest = sha256Canonical(v.creation);
    },
    (v) => {
      v.recovery.verifiedAt = v.creation.createdAt;
    },
    (v) => {
      v.recovery.challengeDigest = v.creation.challengeDigest;
    },
    (v) => {
      v.recovery.wrappedChallengeDigest = v.creation.wrappedChallengeDigest;
    },
    (v) => {
      v.recovery.offHostRecoveryVerified = true;
    },
    (v) => {
      v.creation.approved = true;
    },
    (v) => {
      v.now = "2026-09-01T10:50:25.000Z";
    }
  ]) {
    const value = publicReadbacks();
    mutate(value);
    assert.throws(() => checkPublicReadbacks(value), { code: "H1_SNAPSHOT_PUBLIC_KEY_INVALID" });
  }
  const value = publicReadbacks();
  let reads = 0;
  Object.defineProperty(value.creation, "publicKeyPem", {
    enumerable: true,
    get() {
      reads++;
      return "secret";
    }
  });
  assert.throws(() => checkPublicReadbacks(value), { code: "H1_SNAPSHOT_PUBLIC_KEY_INVALID" });
  assert.equal(reads, 0);
});

test("H1 PUBLIC rejects private keys, PKCS1 public keys and additional PEM material", () => {
  publicReadbacks();
  for (const pem of [
    publicReadbackKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicReadbackKeys.privateKey.export({ type: "pkcs1", format: "pem" }),
    publicReadbackKeys.publicKey.export({ type: "pkcs1", format: "pem" }),
    publicReadbackKeys.publicKey.export({ type: "spki", format: "pem" }) + "unexpected",
    publicReadbackKeys.publicKey.export({ type: "spki", format: "pem" }).repeat(2)
  ]) {
    const value = publicReadbacks();
    value.creation.publicKeyPem = value.recovery.publicKeyPem = pem;
    assert.throws(() => checkPublicReadbacks(value), { code: "H1_SNAPSHOT_PUBLIC_KEY_INVALID" });
  }
});

test("H1 PUBLIC checks actual SPKI algorithm, RSA size and fingerprint rather than metadata claims", () => {
  const value = publicReadbacks();
  value.creation.keyFingerprint = value.recovery.keyFingerprint = digest("f");
  assert.throws(() => checkPublicReadbacks(value), { code: "H1_SNAPSHOT_PUBLIC_KEY_INVALID" });
  for (const keys of [
    generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 }),
    generateKeyPairSync("ed25519")
  ]) {
    const changed = publicReadbacks();
    changed.creation.publicKeyPem = changed.recovery.publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem"
    });
    changed.creation.keyFingerprint = changed.recovery.keyFingerprint = sha256Bytes(
      keys.publicKey.export({ type: "spki", format: "der" })
    );
    assert.throws(() => checkPublicReadbacks(changed), { code: "H1_SNAPSHOT_PUBLIC_KEY_INVALID" });
  }
});

function localAuthorization() {
  const original = validAuthorization();
  const { kms, session, ...authorization } = original;
  authorization.schemaVersion = "producer-crypto-run-authorization.v2";
  authorization.issuer.cryptoPrincipal = authorization.issuer.roleArn;
  delete authorization.issuer.roleArn;
  authorization.localKey = {
    kind: "local-rsa-oaep-sha256.v1",
    keyFingerprint: digest("a"),
    keyReadbackDigest: digest("b"),
    recoveryReadbackDigest: digest("c"),
    action: "local:GenerateAndWrapDataKey",
    keySpec: "AES_256",
    maxCalls: 1,
    context: kms.context,
    contextDigest: kms.contextDigest
  };
  authorization.execution = session;
  authorization.handoff = {
    protocol: "public-key-object-v1",
    publicKeyOnly: true,
    privateKey: false
  };
  authorization.prerequisites = {
    changePlanDigest: digest("9"),
    externalChangeApprovalDigest: digest("a"),
    applyProofDigest: digest("b"),
    keyReadbackDigest: digest("b"),
    recoveryReadbackDigest: digest("c"),
    admissionPolicyReadbackDigest: digest("d"),
    readbackDigest: digest("e"),
    completedAt: original.prerequisites.completedAt
  };
  return authorization;
}

function localEnvelope(authorization = localAuthorization()) {
  const old = validEnvelope();
  const { kmsKeyReadback, kmsContext, kmsContextDigest, ...envelope } = old;
  envelope.schemaVersion = "snapshot-encryption-envelope.v2";
  envelope.authorizationDigest = sha256Canonical(authorization);
  envelope.context = authorization.localKey.context;
  envelope.contextDigest = authorization.localKey.contextDigest;
  envelope.localKeyReadback = {
    kind: authorization.localKey.kind,
    keyFingerprint: authorization.localKey.keyFingerprint,
    keyReadbackDigest: authorization.localKey.keyReadbackDigest,
    recoveryReadbackDigest: authorization.localKey.recoveryReadbackDigest
  };
  const bytes = Buffer.alloc(384, 3);
  envelope.wrappedDek = { ciphertextBase64: bytes.toString("base64"), digest: sha256Bytes(bytes) };
  const aad = {
    ...envelope.context,
    snapshotDigest: envelope.snapshotDigest,
    contextDigest: envelope.contextDigest,
    keyFingerprint: authorization.localKey.keyFingerprint
  };
  envelope.gcmAad = { ...aad, digest: sha256Canonical(aad) };
  return envelope;
}

test("v2 local contracts bind authorization, independent key readback and recovery", () => {
  const authorization = localAuthorization();
  const envelope = localEnvelope(authorization);
  assert.equal(validateProducerCryptoAuthorization(authorization), authorization);
  assert.equal(validateSnapshotEncryptionEnvelope(envelope, { authorization }), envelope);
  const changed = structuredClone(envelope);
  changed.authorizationDigest = digest("f");
  assert.throws(() => validateSnapshotEncryptionEnvelope(changed, { authorization }), {
    code: "SNAPSHOT_ENCRYPTION_AUTHORIZATION_MISMATCH"
  });
  const mismatched = structuredClone(authorization);
  mismatched.prerequisites.recoveryReadbackDigest = digest("f");
  assert.throws(() => validateProducerCryptoAuthorization(mismatched), {
    code: "PRODUCER_CRYPTO_AUTHORIZATION_INVALID"
  });
});

function localUseProof(
  authorization = localAuthorization(),
  envelope = localEnvelope(authorization)
) {
  const original = validUseProof();
  const { session, ...proof } = original;
  proof.schemaVersion = "producer-crypto-use-proof.v2";
  proof.authorizationDigest = sha256Canonical(authorization);
  proof.prerequisiteReadbackDigest = authorization.prerequisites.readbackDigest;
  proof.request = {
    requestId: "fixture-local-generation",
    action: "local:GenerateAndWrapDataKey",
    keySpec: "AES_256",
    keyFingerprint: authorization.localKey.keyFingerprint,
    contextDigest: authorization.localKey.contextDigest,
    callCount: 1,
    outcome: "SUCCESS"
  };
  proof.execution = {
    ...session,
    terminalState: "ADMISSION_CLOSED",
    processExitCode: 0,
    processSignal: null,
    processExitRecordDigest: digest("b")
  };
  proof.encryption = {
    envelopeDigest: sha256Canonical(envelope),
    ciphertextDigest: envelope.ciphertextDigest,
    wrappedDekDigest: envelope.wrappedDek.digest
  };
  return proof;
}

test("v2 local proof observes process exit and admission closure without cloud revocation", () => {
  const authorization = localAuthorization(),
    envelope = localEnvelope(authorization),
    proof = localUseProof(authorization, envelope);
  assert.equal(validateProducerCryptoUseProof(proof, { authorization, envelope }), proof);
  for (const state of ["REVOKED", "EXPIRED", "UNKNOWN", "ACTIVE"]) {
    const changed = structuredClone(proof);
    changed.execution.terminalState = state;
    assert.throws(() => validateProducerCryptoUseProof(changed, { authorization, envelope }));
  }
  const failed = {
    schemaVersion: proof.schemaVersion,
    publishable: false,
    failureKind: "INTERRUPTED_UNKNOWN",
    authorizationDigest: proof.authorizationDigest,
    prerequisiteReadbackDigest: proof.prerequisiteReadbackDigest,
    issuer: proof.issuer,
    issuedAt: proof.issuedAt
  };
  assert.doesNotThrow(() => validateContract("producer-crypto-use-proof.v2", failed));
  assert.throws(() => validateProducerCryptoUseProof(failed, { authorization, envelope }), {
    code: "PRODUCER_CRYPTO_USE_NOT_PUBLISHABLE"
  });
  const uncleared = structuredClone(proof);
  uncleared.cleanup.memoryLocked = false;
  assert.throws(() => validateProducerCryptoUseProof(uncleared, { authorization, envelope }));
});

test("v2 successful cleanup accepts unlocked memory only with observed swap disabled", () => {
  const authorization = localAuthorization(),
    envelope = localEnvelope(authorization),
    locked = localUseProof(authorization, envelope);
  assert.doesNotThrow(() => validateProducerCryptoUseProof(locked, { authorization, envelope }));

  const swapProtected = structuredClone(locked);
  swapProtected.cleanup.memoryLocked = false;
  swapProtected.cleanup.hostSwapDisabled = true;
  assert.doesNotThrow(() =>
    validateProducerCryptoUseProof(swapProtected, { authorization, envelope })
  );

  for (const flag of [undefined, false, null]) {
    const unprotected = structuredClone(swapProtected);
    if (flag === undefined) delete unprotected.cleanup.hostSwapDisabled;
    else unprotected.cleanup.hostSwapDisabled = flag;
    assert.throws(() => validateProducerCryptoUseProof(unprotected, { authorization, envelope }), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }

  const disguisedFailure = structuredClone(swapProtected);
  disguisedFailure.publishable = false;
  disguisedFailure.failureKind = "FAILED";
  assert.throws(() => validateContract("producer-crypto-use-proof.v2", disguisedFailure), {
    code: "CONTRACT_SCHEMA_INVALID"
  });

  for (const flag of [true, false, null]) {
    const failed = structuredClone(disguisedFailure);
    failed.cleanup.hostSwapDisabled = flag;
    failed.cleanup.keyBufferClear = "FAILED";
    assert.doesNotThrow(() => validateContract("producer-crypto-use-proof.v2", failed));
  }
});

test("v2 publishability requires independent successful process terminal facts", () => {
  const authorization = localAuthorization(),
    envelope = localEnvelope(authorization),
    proof = localUseProof(authorization, envelope);
  for (const field of ["processExitCode", "processSignal", "processExitRecordDigest"]) {
    const missing = structuredClone(proof);
    delete missing.execution[field];
    assert.throws(() => validateProducerCryptoUseProof(missing, { authorization, envelope }), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
  for (const terminal of [
    { processExitCode: 1, processSignal: null },
    { processExitCode: null, processSignal: "SIGTERM" }
  ]) {
    const rejected = structuredClone(proof);
    Object.assign(rejected.execution, terminal, { processExitRecordDigest: digest("b") });
    assert.throws(() => validateProducerCryptoUseProof(rejected, { authorization, envelope }), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

test("v2 non-publishable failure and UNKNOWN preserve observed process exit records", () => {
  const authorization = localAuthorization(),
    envelope = localEnvelope(authorization);
  for (const [failureKind, code, signal, record] of [
    ["FAILED", 1, null, digest("b")],
    ["FAILED", null, "SIGTERM", digest("c")],
    ["INTERRUPTED_UNKNOWN", null, null, null]
  ]) {
    const proof = localUseProof(authorization, envelope);
    proof.publishable = false;
    proof.failureKind = failureKind;
    Object.assign(proof.execution, {
      processExitCode: code,
      processSignal: signal,
      processExitRecordDigest: record
    });
    assert.doesNotThrow(() => validateContract("producer-crypto-use-proof.v2", proof));
    assert.throws(() => validateProducerCryptoUseProof(proof, { authorization, envelope }), {
      code: "PRODUCER_CRYPTO_USE_NOT_PUBLISHABLE"
    });
  }
});

test("historical v1 originals remain read-only verifiable without rewriting their digests", () => {
  const authorization = validAuthorization(),
    envelope = validEnvelope(authorization),
    proof = validUseProof(authorization);
  const before = sha256Canonical({ authorization, envelope, proof });
  validateProducerCryptoAuthorization(authorization);
  validateSnapshotEncryptionEnvelope(envelope, { authorization });
  validateProducerCryptoUseProof(proof, { authorization, envelope });
  assert.equal(sha256Canonical({ authorization, envelope, proof }), before);
});

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
