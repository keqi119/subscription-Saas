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

export function validateProducerCryptoAuthorization(authorization) {
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
    authorization.session.requestedDurationSeconds * 1000 > notAfter - notBefore
  ) {
    throw contractError("PRODUCER_CRYPTO_AUTHORIZATION_INVALID");
  }
  return authorization;
}

export function validateSnapshotEncryptionEnvelope(envelope, { authorization } = {}) {
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
    validateProducerCryptoAuthorization(authorization);
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

export function validateProducerCryptoUseProof(proof, { authorization, envelope } = {}) {
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
  validateProducerCryptoAuthorization(authorization);
  validateSnapshotEncryptionEnvelope(envelope, { authorization });
  if (
    proof.authorizationDigest !== sha256Canonical(authorization) ||
    proof.prerequisiteReadbackDigest !== authorization.prerequisites.readbackDigest ||
    proof.request.keyId !== authorization.kms.keyId ||
    proof.request.contextDigest !== authorization.kms.contextDigest ||
    proof.encryption.envelopeDigest !== sha256Canonical(envelope) ||
    proof.encryption.ciphertextDigest !== envelope.ciphertextDigest ||
    proof.encryption.wrappedDekDigest !== envelope.wrappedDek.digest ||
    sessionIssued < instant(authorization.notBefore) ||
    sessionExpires > instant(authorization.notAfter)
  ) {
    throw contractError("PRODUCER_CRYPTO_USE_AUTHORIZATION_MISMATCH");
  }
  return proof;
}
