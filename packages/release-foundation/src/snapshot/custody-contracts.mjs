import { readFileSync } from "node:fs";

import { canonicalJson } from "../canonical-json.mjs";
import { sha256Canonical } from "../digest.mjs";
import { validateContract } from "../schema-registry.mjs";

const DAY_MS = 86_400_000;
const contractRoot = new URL("../../../../release/contracts/", import.meta.url);

function loadPolicy(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, contractRoot), "utf8"));
}

function contractError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function instant(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw contractError("CONTRACT_TIME_INVALID", { value });
  return timestamp;
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function exactSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

export function validateSnapshotCustody(custody, { allowProvisional = false } = {}) {
  validateContract("snapshot-private-custody.v1", custody);
  const cloudPolicy = loadPolicy("snapshot-cloud-policy.v1.json");
  validateContract("snapshot-cloud-policy.v1", cloudPolicy);
  const expectedKey = `snapshot-slots/v2/${custody.releaseAttemptId}/${custody.snapshotRunId}/snapshot.enc`;
  const expectedReadback = {
    key: custody.object.key,
    version: custody.object.version,
    etag: custody.object.etag,
    digest: custody.object.ciphertextDigest,
    sizeBytes: custody.object.ciphertextSizeBytes
  };
  if (
    custody.object.key !== expectedKey ||
    !same(custody.headReadback, expectedReadback) ||
    !same(custody.getReadback, expectedReadback) ||
    custody.identities.writer === custody.identities.reader ||
    custody.bucket.region !== cloudPolicy.region
  ) {
    const code =
      custody.identities.writer === custody.identities.reader
        ? "SNAPSHOT_CUSTODY_IDENTITY_NOT_INDEPENDENT"
        : "SNAPSHOT_CUSTODY_OBJECT_READBACK_INVALID";
    throw contractError(code);
  }
  const modified = instant(custody.worm.lastModified);
  const readback = instant(custody.worm.readbackAt);
  const retainUntil = instant(custody.worm.retainUntil);
  const calculatedRetainUntil = modified + custody.worm.retentionDays * DAY_MS;
  if (
    custody.worm.state !== cloudPolicy.bucket.worm.state ||
    modified > readback ||
    retainUntil !== calculatedRetainUntil
  ) {
    throw contractError("SNAPSHOT_CUSTODY_WORM_READBACK_INVALID");
  }
  if (custody.worm.retentionDays < cloudPolicy.bucket.worm.retentionDays) {
    throw contractError("SNAPSHOT_CUSTODY_RETENTION_TOO_SHORT");
  }
  if (custody.terminalAt === null || custody.provisional) {
    if (custody.terminalAt !== null || custody.provisional !== true) {
      throw contractError("SNAPSHOT_CUSTODY_PROVISIONAL_STATE_INVALID");
    }
    if (!allowProvisional) {
      throw contractError("SNAPSHOT_CUSTODY_TERMINAL_REVALIDATION_REQUIRED");
    }
  } else if (custody.provisional !== false || instant(custody.terminalAt) > readback) {
    throw contractError("SNAPSHOT_CUSTODY_TERMINAL_INVALID");
  }
  const required = Math.max(
    instant(custody.expiresAt) + 180 * DAY_MS,
    custody.terminalAt === null ? 0 : instant(custody.terminalAt) + 180 * DAY_MS,
    instant(custody.downstreamRetainUntil),
    custody.legalHoldUntil === null ? 0 : instant(custody.legalHoldUntil)
  );
  if (retainUntil < required) throw contractError("SNAPSHOT_CUSTODY_RETENTION_TOO_SHORT");
  return custody;
}

export function validateSnapshotDestructionReceipt(receipt) {
  validateContract("snapshot-destruction-receipt.v1", receipt);
  const expectedBacking = `/var/lib/subscription-saas/snapshot-volumes/${receipt.releaseAttemptId}.luks`;
  const expectedMapper = `subscription-s1-${receipt.releaseAttemptId}`;
  if (
    receipt.volume.backingFile !== expectedBacking ||
    receipt.volume.mapper !== expectedMapper ||
    !exactSet(receipt.volume.keySlotsBefore, receipt.volume.keySlotsInvalidated) ||
    instant(receipt.residualScan.performedAt) > instant(receipt.processTerminal.terminalAt) ||
    instant(receipt.processTerminal.terminalAt) > instant(receipt.issuedAt)
  ) {
    throw contractError("SNAPSHOT_DESTRUCTION_INCOMPLETE");
  }
  return receipt;
}

export function validateSnapshotRetentionReceipt(receipt) {
  validateContract("snapshot-retention-receipt.v1", receipt);
  const expectedKey = `snapshot-slots/v2/${receipt.releaseAttemptId}/${receipt.snapshotRunId}/snapshot.enc`;
  const expectedDisposition =
    receipt.action === "DELETE_CIPHERTEXT_AND_DISABLE_KEY_ACCESS"
      ? ["DELETED", "DISABLED"]
      : ["TRANSFERRED", "TRANSFERRED"];
  if (
    receipt.object.key !== expectedKey ||
    instant(receipt.appliedAt) < instant(receipt.eligibleAt) ||
    instant(receipt.terminalReadback.verifiedAt) < instant(receipt.appliedAt) ||
    receipt.terminalReadback.objectAccessDisposition !== expectedDisposition[0] ||
    receipt.terminalReadback.keyAccessDisposition !== expectedDisposition[1]
  ) {
    throw contractError("SNAPSHOT_RETENTION_DISPOSITION_INVALID");
  }
  return receipt;
}

export function validateLineageStoragePolicy(
  policy = loadPolicy("evidence-lineage-storage-policy.v1.json")
) {
  validateContract("evidence-lineage-storage-policy.v1", policy);
  const authoritative = loadPolicy("evidence-lineage-storage-policy.v1.json");
  if (!same(policy, authoritative)) throw contractError("LINEAGE_STORAGE_POLICY_MISMATCH");
  return policy;
}

export function validateLineageAccessReadback(readback) {
  validateContract("evidence-lineage-access-readback.v1", readback);
  const policy = validateLineageStoragePolicy();
  const matrixEntry = policy.matrix.find(({ jobId }) => jobId === readback.job.id);
  if (
    !matrixEntry ||
    matrixEntry.permissionProfile !== readback.job.permissionProfile ||
    matrixEntry.environment !== readback.job.environment ||
    matrixEntry.lineageNodeKind !== readback.job.lineageNodeKind ||
    instant(readback.prerequisite.approvalIssuedAt) > instant(readback.prerequisite.appliedAt) ||
    instant(readback.prerequisite.appliedAt) > instant(readback.observationAt) ||
    instant(readback.worm.readbackAt) > instant(readback.observationAt)
  ) {
    throw contractError("LINEAGE_ACCESS_PREREQUISITE_INVALID");
  }
  const requiredDenied =
    readback.job.permissionProfile === "lineage-create-only-writer"
      ? ["Head", "Get", ...policy.deniedActions]
      : ["Put", ...policy.deniedActions];
  if (!exactSet(readback.deniedActions, requiredDenied)) {
    throw contractError("LINEAGE_ACCESS_ACTION_SCOPE_INVALID");
  }
  for (const object of readback.exactObjects) {
    if (object.digest !== object.expectedDigest || /[*?]/.test(object.key)) {
      throw contractError("LINEAGE_ACCESS_OBJECT_INVALID");
    }
    if (object.addressingKind === "claim") {
      if (
        object.rawProofType === null ||
        object.rawProofDigest === null ||
        object.objectType !== "purpose-claim.v1" ||
        object.key !== `evidence/claims/v1/${object.rawProofType}/${object.rawProofDigest.slice(7)}`
      ) {
        throw contractError("LINEAGE_CLAIM_KEY_INVALID");
      }
    } else if (
      object.rawProofType !== null ||
      object.rawProofDigest !== null ||
      object.key !==
        `evidence/v1/${readback.releaseAttemptId}/${readback.rcWorkflowRunId}/${object.objectType}/${object.digest.slice(7)}`
    ) {
      throw contractError("LINEAGE_OBJECT_KEY_INVALID");
    }
  }
  const expectedTypes = {
    purpose: ["execution-purpose-envelope.v1", "purpose-claim.v1"],
    custody: ["custody-receipt.v2"],
    aggregate: ["release-aggregate-proof.v2"],
    exit: ["s1-exit-evidence.v2"]
  }[readback.job.lineageNodeKind];
  if (
    !exactSet(
      readback.exactObjects.map(({ objectType }) => objectType),
      expectedTypes
    )
  ) {
    throw contractError("LINEAGE_ACCESS_NODE_OBJECTS_INVALID");
  }
  return readback;
}

export function validateLineageRetentionReceipt(receipt) {
  validateContract("evidence-lineage-retention-receipt.v1", receipt);
  const required = Math.max(
    instant(receipt.latestWholeLineageRetainUntil),
    receipt.legalHoldUntil === null ? 0 : instant(receipt.legalHoldUntil)
  );
  const expectedDisposition = receipt.action === "DELETE" ? "DELETED" : "TRANSFERRED";
  const objectKeys = new Set();
  const invalidObject = receipt.objects.some((object) => {
    if (objectKeys.has(object.key)) return true;
    objectKeys.add(object.key);
    if (object.addressingKind === "claim") {
      return (
        object.objectType !== "purpose-claim.v1" ||
        object.rawProofType === null ||
        object.rawProofDigest === null ||
        object.key !== `evidence/claims/v1/${object.rawProofType}/${object.rawProofDigest.slice(7)}`
      );
    }
    return (
      object.rawProofType !== null ||
      object.rawProofDigest !== null ||
      object.key !==
        `evidence/v1/${receipt.releaseAttemptId}/${receipt.rcWorkflowRunId}/${object.objectType}/${object.digest.slice(7)}`
    );
  });
  if (
    instant(receipt.appliedAt) < required ||
    instant(receipt.terminalReadback.verifiedAt) < instant(receipt.appliedAt) ||
    receipt.terminalReadback.disposition !== expectedDisposition ||
    invalidObject
  ) {
    throw contractError("LINEAGE_RETENTION_DISPOSITION_INVALID");
  }
  return receipt;
}

export function validateEvidenceArchiveAuthorization(authorization) {
  validateContract("evidence-archive-authorization.v1", authorization);
  const { management, writer, reader } = authorization.identities;
  const expectedActions =
    authorization.profile === "archive-create-only-writer"
      ? ["oss:PutObject"]
      : ["oss:HeadObject", "oss:GetObject", "oss:GetBucketAcl", "oss:GetBucketWorm"];
  const expectedPrincipal =
    authorization.profile === "archive-create-only-writer" ? writer : reader;
  if (
    new Set([authorization.issuer.id, management, writer, reader]).size !== 4 ||
    authorization.executor.principal !== expectedPrincipal ||
    !exactSet(authorization.permissions.actions, expectedActions) ||
    authorization.permissions.conditionalCreate !==
      (authorization.profile === "archive-create-only-writer") ||
    (authorization.profile === "archive-create-only-writer" &&
      authorization.chain.predecessorTerminalReceiptDigest !== null) ||
    (authorization.profile === "archive-readback-reader" &&
      authorization.chain.predecessorTerminalReceiptDigest === null) ||
    instant(authorization.notAfter) <= instant(authorization.issuedAt)
  ) {
    throw contractError("EVIDENCE_ARCHIVE_AUTHORIZATION_INVALID");
  }
  const keys = new Set();
  for (const object of authorization.objects) {
    const expectedKey = `control-evidence/v1/${object.proofType}/${object.canonicalDigest}`;
    if (object.exactKey !== expectedKey || keys.has(expectedKey)) {
      throw contractError("EVIDENCE_ARCHIVE_OBJECT_SCOPE_INVALID");
    }
    keys.add(expectedKey);
  }
  return authorization;
}

export function validateEvidenceArchiveAccessReceipt(receipt, { authorization } = {}) {
  validateContract("evidence-archive-access-receipt.v1", receipt);
  if (!authorization) throw contractError("EVIDENCE_ARCHIVE_AUTHORIZATION_REQUIRED");
  const issuedAt = instant(receipt.session.issuedAt);
  const expiresAt = instant(receipt.session.expiresAt);
  const terminalAt = instant(receipt.session.terminalAt);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 900_000 ||
    terminalAt < issuedAt ||
    (receipt.session.terminalState === "REVOKED" && terminalAt > expiresAt) ||
    (receipt.session.terminalState === "EXPIRED" && terminalAt < expiresAt) ||
    instant(receipt.issuedAt) < terminalAt
  ) {
    throw contractError("EVIDENCE_ARCHIVE_SESSION_INVALID");
  }
  validateEvidenceArchiveAuthorization(authorization);
  const authorizationIssuedAt = instant(authorization.issuedAt);
  const authorizationNotAfter = instant(authorization.notAfter);
  const expectedActions =
    authorization.profile === "archive-create-only-writer"
      ? ["oss:PutObject"]
      : ["oss:HeadObject", "oss:GetObject"];
  const authorizedObjects = new Map(
    authorization.objects.map((object) => [object.exactKey, object])
  );
  if (
    receipt.authorizationDigest !== sha256Canonical(authorization) ||
    issuedAt < authorizationIssuedAt ||
    issuedAt >= authorizationNotAfter ||
    receipt.operationId !== authorization.operationId ||
    receipt.profile !== authorization.profile ||
    receipt.issuer !== authorization.issuer.id ||
    receipt.issuer === receipt.session.principal ||
    receipt.session.principal !== authorization.executor.principal ||
    receipt.actions.length !== authorization.objects.length * expectedActions.length ||
    receipt.actions.some(
      (action) =>
        !expectedActions.includes(action.action) ||
        action.conditionalCreate !== (authorization.profile === "archive-create-only-writer") ||
        !authorizedObjects.has(action.objectKey)
    ) ||
    authorization.objects.some((object) =>
      expectedActions.some(
        (expectedAction) =>
          receipt.actions.filter(
            (action) => action.objectKey === object.exactKey && action.action === expectedAction
          ).length !== 1
      )
    ) ||
    receipt.objectResults.length !== authorization.objects.length ||
    new Set(receipt.objectResults.map(({ objectKey }) => objectKey)).size !==
      receipt.objectResults.length ||
    !exactSet(
      receipt.objectResults.map(({ objectKey }) => objectKey),
      authorization.objects.map(({ exactKey }) => exactKey)
    ) ||
    receipt.objectResults.some((result) => {
      const expected = authorizedObjects.get(result.objectKey);
      return (
        !expected ||
        expected.contentDigest !== result.contentDigest ||
        expected.contentSizeBytes !== result.contentSizeBytes
      );
    }) ||
    (authorization.profile === "archive-readback-reader" && receipt.observationDigest === null) ||
    (authorization.profile === "archive-create-only-writer" && receipt.observationDigest !== null)
  ) {
    throw contractError("EVIDENCE_ARCHIVE_ACCESS_INVALID");
  }
  return receipt;
}

export function validateEvidenceCustodyBootstrapReadback(readback) {
  validateContract("evidence-custody-bootstrap-readback.v1", readback);
  const cloudPolicy = loadPolicy("snapshot-cloud-policy.v1.json");
  validateContract("snapshot-cloud-policy.v1", cloudPolicy);
  if (
    new Set(Object.values(readback.identities)).size !== 3 ||
    readback.bucket.worm.retentionDays < cloudPolicy.bucket.worm.retentionDays ||
    readback.importedOriginals.some(
      (original) =>
        original.objectKey !==
        `control-evidence/v1/${original.subjectType}/${original.originalBytesDigest}`
    )
  ) {
    throw contractError("EVIDENCE_CUSTODY_BOOTSTRAP_INVALID");
  }
  return readback;
}

export function validatePrebuildSanitizedInputBinding(binding, { now } = {}) {
  validateContract("prebuild-sanitized-input-binding.v1", binding);
  const at = instant(now);
  const authority = binding.readDecryptUseAuthority;
  const expectedKey = `snapshot-slots/v2/${binding.snapshotReleaseAttemptId}/${binding.snapshotRunId}/snapshot.enc`;
  if (
    binding.ciphertext.objectKey !== expectedKey ||
    authority.exactObjectKey !== expectedKey ||
    new Set([
      authority.issuer,
      authority.consumerPrincipal,
      authority.sourceProducerPrincipal,
      authority.sourcePublisherPrincipal
    ]).size !== 4 ||
    instant(binding.snapshotExpiresAt) <= at ||
    instant(binding.custody.retainUntil) < instant(binding.snapshotExpiresAt) + 180 * DAY_MS ||
    instant(authority.validFrom) > at ||
    instant(authority.validUntil) <= at ||
    instant(authority.validFrom) >= instant(authority.validUntil) ||
    instant(authority.validUntil) > instant(binding.snapshotExpiresAt) ||
    binding.capacityUpperBounds.ciphertextBytes < binding.ciphertext.sizeBytes
  ) {
    throw contractError("PREBUILD_SANITIZED_INPUT_INVALID");
  }
  return binding;
}
