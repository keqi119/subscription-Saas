import { readFileSync } from "node:fs";

import { canonicalJson } from "../canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../digest.mjs";
import { validateContract } from "../schema-registry.mjs";

const DAY_MS = 86_400_000;
const addressingPolicy = JSON.parse(
  readFileSync(
    new URL(
      "../../../../release/contracts/policies/snapshot-object-addressing.v2.json",
      import.meta.url
    ),
    "utf8"
  )
);

function contractError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function instant(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw contractError("CONTRACT_TIME_INVALID", { value });
  return timestamp;
}

function canonicalBase64(value) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw contractError("SNAPSHOT_ENCRYPTION_BINARY_INVALID");
  }
  return bytes;
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateProducerCryptoAuthorizationV1(authorization) {
  validateContract("producer-crypto-run-authorization.v1", authorization);
  const issuedAt = instant(authorization.issuedAt);
  const notBefore = instant(authorization.notBefore);
  const notAfter = instant(authorization.notAfter);
  const allocatedAt = instant(authorization.snapshotAllocatedAt);
  const expectedContext = {
    repositoryId: authorization.repository.id,
    sourceSha: authorization.sourceSha,
    releaseAttemptId: authorization.releaseAttemptId,
    snapshotRunId: authorization.snapshotRunId,
    sanitizationContractDigest: authorization.kms.context.sanitizationContractDigest,
    expiresAt: new Date(allocatedAt + 30 * DAY_MS).toISOString()
  };
  if (
    authorization.producer.runId !== authorization.snapshotRunId ||
    !same(authorization.kms.context, expectedContext) ||
    authorization.kms.contextDigest !== sha256Canonical(expectedContext) ||
    authorization.kms.keyId !== authorization.kms.keyAliasReadbackId ||
    new Set([
      authorization.issuer.principal,
      authorization.issuer.roleArn,
      authorization.issuer.publisherBrokerPrincipal
    ]).size !== 3 ||
    instant(authorization.prerequisites.completedAt) > issuedAt ||
    issuedAt > notBefore ||
    notBefore > notAfter ||
    notAfter - notBefore > 900_000 ||
    authorization.session.requestedDurationSeconds * 1000 > notAfter - notBefore ||
    allocatedAt > issuedAt
  ) {
    throw contractError("PRODUCER_CRYPTO_AUTHORIZATION_INVALID");
  }
  return authorization;
}

function validateSnapshotEncryptionEnvelopeV1(envelope, { authorization } = {}) {
  validateContract("snapshot-encryption-envelope.v1", envelope);
  const payloadPolicy = addressingPolicy.outputs.find(
    ({ filename }) => filename === "snapshot.enc"
  );
  const expectedKey = `snapshot-slots/v2/${envelope.releaseAttemptId}/${envelope.snapshotRunId}/snapshot.enc`;
  const expectedContext = {
    repositoryId: "1253231368",
    sourceSha: envelope.sourceSha,
    releaseAttemptId: envelope.releaseAttemptId,
    snapshotRunId: envelope.snapshotRunId,
    sanitizationContractDigest: envelope.sanitizationContractDigest,
    expiresAt: envelope.expiresAt
  };
  const expectedContextDigest = sha256Canonical(expectedContext);
  const expectedAad = {
    ...expectedContext,
    snapshotDigest: envelope.snapshotDigest,
    kmsContextDigest: expectedContextDigest
  };
  const { digest: aadDigest, ...actualAad } = envelope.gcmAad;
  const nonce = canonicalBase64(envelope.nonceBase64);
  const tag = canonicalBase64(envelope.authenticationTagBase64);
  const wrappedDek = canonicalBase64(envelope.wrappedDek.ciphertextBase64);
  if (
    envelope.slotObjectKey !== expectedKey ||
    envelope.ciphertextSizeBytes > payloadPolicy.maxSizeBytes ||
    nonce.byteLength !== 12 ||
    tag.byteLength !== 16 ||
    wrappedDek.byteLength === 0 ||
    envelope.wrappedDek.digest !== sha256Bytes(wrappedDek) ||
    envelope.kmsKeyReadback.keyId !== envelope.kmsKeyReadback.aliasReadbackKeyId ||
    !same(envelope.kmsContext, expectedContext) ||
    envelope.kmsContextDigest !== expectedContextDigest ||
    !same(actualAad, expectedAad) ||
    aadDigest !== sha256Canonical(expectedAad) ||
    instant(envelope.expiresAt) - instant(envelope.snapshotAllocatedAt) !== 30 * DAY_MS
  ) {
    throw contractError("SNAPSHOT_ENCRYPTION_ENVELOPE_INVALID");
  }
  if (authorization) {
    validateProducerCryptoAuthorizationV1(authorization);
    if (
      authorization.releaseAttemptId !== envelope.releaseAttemptId ||
      authorization.snapshotRunId !== envelope.snapshotRunId ||
      authorization.sourceSha !== envelope.sourceSha ||
      authorization.snapshotAllocatedAt !== envelope.snapshotAllocatedAt ||
      authorization.kms.contextDigest !== envelope.kmsContextDigest ||
      authorization.kms.keyId !== envelope.kmsKeyReadback.keyId
    ) {
      throw contractError("SNAPSHOT_ENCRYPTION_AUTHORIZATION_MISMATCH");
    }
  }
  return envelope;
}

function validateProducerCryptoUseProofV1(proof, { authorization, envelope } = {}) {
  validateContract("producer-crypto-use-proof.v1", proof);
  if (!authorization || !envelope) {
    throw contractError("PRODUCER_CRYPTO_USE_CONTEXT_REQUIRED");
  }
  if (
    proof.publishable !== true ||
    proof.request.callCount !== 1 ||
    proof.request.outcome !== "SUCCESS" ||
    !["REVOKED", "EXPIRED"].includes(proof.session.terminalState) ||
    proof.session.terminalAt === null ||
    proof.session.terminalReceiptDigest === null ||
    proof.cleanup.coreDumpDisabled !== true ||
    proof.cleanup.memoryLocked !== true ||
    proof.cleanup.keyBufferClear !== "BEST_EFFORT_COMPLETED" ||
    proof.cleanup.processExitedAt === null
  ) {
    throw contractError("PRODUCER_CRYPTO_USE_NOT_PUBLISHABLE");
  }
  const sessionIssued = instant(proof.session.issuedAt);
  const sessionExpires = instant(proof.session.expiresAt);
  const processExited = instant(proof.cleanup.processExitedAt);
  const terminalAt = instant(proof.session.terminalAt);
  const proofIssued = instant(proof.issuedAt);
  if (
    sessionExpires <= sessionIssued ||
    sessionExpires - sessionIssued > 900_000 ||
    processExited < sessionIssued ||
    terminalAt < processExited ||
    proofIssued < terminalAt ||
    (proof.session.terminalState === "EXPIRED" && terminalAt < sessionExpires) ||
    (proof.session.terminalState === "REVOKED" && terminalAt > sessionExpires)
  ) {
    throw contractError("PRODUCER_CRYPTO_USE_SEQUENCE_INVALID");
  }
  validateProducerCryptoAuthorizationV1(authorization);
  validateSnapshotEncryptionEnvelopeV1(envelope, { authorization });
  if (
    proof.authorizationDigest !== sha256Canonical(authorization) ||
    proof.prerequisiteReadbackDigest !== authorization.prerequisites.readbackDigest ||
    proof.request.keyId !== authorization.kms.keyId ||
    proof.request.contextDigest !== authorization.kms.contextDigest ||
    proof.encryption.envelopeDigest !== sha256Canonical(envelope) ||
    proof.encryption.ciphertextDigest !== envelope.ciphertextDigest ||
    proof.encryption.wrappedDekDigest !== envelope.wrappedDek.digest ||
    sessionIssued < instant(authorization.notBefore) ||
    sessionIssued >= instant(authorization.notAfter) ||
    sessionExpires - sessionIssued > authorization.session.requestedDurationSeconds * 1000
  ) {
    throw contractError("PRODUCER_CRYPTO_USE_AUTHORIZATION_MISMATCH");
  }
  return proof;
}

// v1 is retained solely for validating historical originals; new execution is v2/local.
export function validateProducerCryptoAuthorization(authorization) {
  if (authorization?.schemaVersion === "producer-crypto-run-authorization.v1")
    return validateProducerCryptoAuthorizationV1(authorization);
  validateContract("producer-crypto-run-authorization.v2", authorization);
  const allocatedAt = instant(authorization.snapshotAllocatedAt);
  const key = authorization.localKey;
  const expectedContext = {
    repositoryId: authorization.repository.id,
    sourceSha: authorization.sourceSha,
    releaseAttemptId: authorization.releaseAttemptId,
    snapshotRunId: authorization.snapshotRunId,
    sanitizationContractDigest: key.context.sanitizationContractDigest,
    expiresAt: new Date(allocatedAt + 30 * DAY_MS).toISOString()
  };
  const issued = instant(authorization.issuedAt),
    before = instant(authorization.notBefore),
    after = instant(authorization.notAfter);
  if (
    authorization.producer.runId !== authorization.snapshotRunId ||
    !same(key.context, expectedContext) ||
    key.contextDigest !== sha256Canonical(expectedContext) ||
    key.keyReadbackDigest !== authorization.prerequisites.keyReadbackDigest ||
    key.recoveryReadbackDigest !== authorization.prerequisites.recoveryReadbackDigest ||
    new Set([
      authorization.issuer.principal,
      authorization.issuer.cryptoPrincipal,
      authorization.issuer.publisherBrokerPrincipal
    ]).size !== 3 ||
    instant(authorization.prerequisites.completedAt) > issued ||
    allocatedAt > issued ||
    issued > before ||
    before >= after ||
    after - before > 900_000 ||
    authorization.execution.requestedDurationSeconds * 1000 > after - before
  ) {
    throw contractError("PRODUCER_CRYPTO_AUTHORIZATION_INVALID");
  }
  return authorization;
}

export function validateSnapshotEncryptionEnvelope(envelope, { authorization } = {}) {
  if (envelope?.schemaVersion === "snapshot-encryption-envelope.v1")
    return validateSnapshotEncryptionEnvelopeV1(envelope, { authorization });
  validateContract("snapshot-encryption-envelope.v2", envelope);
  const payloadPolicy = addressingPolicy.outputs.find(
    ({ filename }) => filename === "snapshot.enc"
  );
  const context = {
    repositoryId: "1253231368",
    sourceSha: envelope.sourceSha,
    releaseAttemptId: envelope.releaseAttemptId,
    snapshotRunId: envelope.snapshotRunId,
    sanitizationContractDigest: envelope.sanitizationContractDigest,
    expiresAt: envelope.expiresAt
  };
  const contextDigest = sha256Canonical(context);
  const aad = {
    ...context,
    snapshotDigest: envelope.snapshotDigest,
    contextDigest,
    keyFingerprint: envelope.localKeyReadback.keyFingerprint
  };
  const { digest, ...actualAad } = envelope.gcmAad;
  const wrapped = canonicalBase64(envelope.wrappedDek.ciphertextBase64);
  if (
    envelope.slotObjectKey !==
      `snapshot-slots/v2/${envelope.releaseAttemptId}/${envelope.snapshotRunId}/snapshot.enc` ||
    envelope.ciphertextSizeBytes > payloadPolicy.maxSizeBytes ||
    canonicalBase64(envelope.nonceBase64).length !== 12 ||
    canonicalBase64(envelope.authenticationTagBase64).length !== 16 ||
    wrapped.length !== 384 ||
    envelope.wrappedDek.digest !== sha256Bytes(wrapped) ||
    !same(envelope.context, context) ||
    envelope.contextDigest !== contextDigest ||
    !same(actualAad, aad) ||
    digest !== sha256Canonical(aad) ||
    instant(envelope.expiresAt) - instant(envelope.snapshotAllocatedAt) !== 30 * DAY_MS
  ) {
    throw contractError("SNAPSHOT_ENCRYPTION_ENVELOPE_INVALID");
  }
  if (authorization) {
    validateProducerCryptoAuthorization(authorization);
    if (
      authorization.schemaVersion !== "producer-crypto-run-authorization.v2" ||
      envelope.authorizationDigest !== sha256Canonical(authorization) ||
      authorization.releaseAttemptId !== envelope.releaseAttemptId ||
      authorization.snapshotRunId !== envelope.snapshotRunId ||
      authorization.sourceSha !== envelope.sourceSha ||
      authorization.snapshotAllocatedAt !== envelope.snapshotAllocatedAt ||
      !same(authorization.localKey.context, context) ||
      authorization.localKey.contextDigest !== contextDigest ||
      !same(envelope.localKeyReadback, {
        kind: authorization.localKey.kind,
        keyFingerprint: authorization.localKey.keyFingerprint,
        keyReadbackDigest: authorization.localKey.keyReadbackDigest,
        recoveryReadbackDigest: authorization.localKey.recoveryReadbackDigest
      })
    ) {
      throw contractError("SNAPSHOT_ENCRYPTION_AUTHORIZATION_MISMATCH");
    }
  }
  return envelope;
}

export function validateProducerCryptoUseProof(proof, { authorization, envelope } = {}) {
  if (proof?.schemaVersion === "producer-crypto-use-proof.v1")
    return validateProducerCryptoUseProofV1(proof, { authorization, envelope });
  validateContract("producer-crypto-use-proof.v2", proof);
  if (!authorization || !envelope) throw contractError("PRODUCER_CRYPTO_USE_CONTEXT_REQUIRED");
  if (!proof.publishable) throw contractError("PRODUCER_CRYPTO_USE_NOT_PUBLISHABLE");
  validateProducerCryptoAuthorization(authorization);
  validateSnapshotEncryptionEnvelope(envelope, { authorization });
  const execution = proof.execution;
  const started = instant(execution.issuedAt),
    expires = instant(execution.expiresAt);
  const exited = instant(proof.cleanup.processExitedAt),
    terminal = instant(execution.terminalAt);
  if (
    expires <= started ||
    expires - started > 900_000 ||
    exited < started ||
    terminal < exited ||
    instant(proof.issuedAt) < terminal ||
    (execution.terminalState === "ADMISSION_EXPIRED" && terminal < expires) ||
    (execution.terminalState === "ADMISSION_CLOSED" && terminal > expires)
  ) {
    throw contractError("PRODUCER_CRYPTO_USE_SEQUENCE_INVALID");
  }
  if (
    authorization.schemaVersion !== "producer-crypto-run-authorization.v2" ||
    envelope.schemaVersion !== "snapshot-encryption-envelope.v2" ||
    proof.authorizationDigest !== sha256Canonical(authorization) ||
    proof.prerequisiteReadbackDigest !== authorization.prerequisites.readbackDigest ||
    proof.request.keyFingerprint !== authorization.localKey.keyFingerprint ||
    proof.request.contextDigest !== authorization.localKey.contextDigest ||
    proof.encryption.envelopeDigest !== sha256Canonical(envelope) ||
    proof.encryption.ciphertextDigest !== envelope.ciphertextDigest ||
    proof.encryption.wrappedDekDigest !== envelope.wrappedDek.digest ||
    started < instant(authorization.notBefore) ||
    started >= instant(authorization.notAfter) ||
    expires > instant(authorization.notAfter) ||
    expires - started > authorization.execution.requestedDurationSeconds * 1000
  ) {
    throw contractError("PRODUCER_CRYPTO_USE_AUTHORIZATION_MISMATCH");
  }
  // Admission closure and process exit are observations, not cloud revocation or physical key erasure.
  return proof;
}
