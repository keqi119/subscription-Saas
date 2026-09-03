import { createHmac } from "node:crypto";

import { canonicalJson } from "../canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../digest.mjs";
import { assertCustodyComplete } from "../evidence-custody.mjs";
import { validateContract } from "../schema-registry.mjs";
import {
  assertReadOnlySnapshotSource,
  fingerprintSourceSnapshot
} from "./source-readonly-guard.mjs";
import { scanSanitizedArtifact } from "./scan-artifact.mjs";

function snapshotError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function immutable(value) {
  const clone = JSON.parse(canonicalJson(value));
  const freeze = (entry) => {
    if (entry && typeof entry === "object" && !Object.isFrozen(entry)) {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(clone);
}

function addUtcDays(value, days) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function assertContractSemantics(contract) {
  validateContract("sanitization-contract.v1", contract);
  if (
    canonicalJson([...contract.source.keyTables].sort()) !==
      canonicalJson(contract.source.keyTables) ||
    canonicalJson([...contract.source.knownMigrationHeads].sort()) !==
      canonicalJson(contract.source.knownMigrationHeads) ||
    contract.lifecycle.reviewAfterDays > contract.lifecycle.expiresAfterDays
  ) {
    throw snapshotError("SNAPSHOT_CONTRACT_ORDER_INVALID");
  }
  const keys = contract.transformations.map(({ table, column }) => `${table}\u0000${column}`);
  if (new Set(keys).size !== keys.length) {
    throw snapshotError("SNAPSHOT_CONTRACT_TRANSFORMATION_DUPLICATE");
  }
  for (const rule of contract.transformations) {
    if (
      (rule.method === "deterministic-token" && !rule.keyReference) ||
      (rule.method === "fixed-disabled-value" && !rule.fixedValue) ||
      (["null-out", "redact-url"].includes(rule.method) &&
        (rule.keyReference !== undefined || rule.fixedValue !== undefined))
    ) {
      throw snapshotError("SNAPSHOT_CONTRACT_TRANSFORMATION_INVALID");
    }
  }
}

export function transformRecord(record, { table, contract, tokenizationKey }) {
  assertContractSemantics(contract);
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    typeof table !== "string"
  ) {
    throw snapshotError("SNAPSHOT_TRANSFORM_INPUT_INVALID");
  }
  const output = { ...record };
  for (const rule of contract.transformations.filter((entry) => entry.table === table)) {
    if (!(rule.column in output) || output[rule.column] === null) continue;
    if (rule.method === "deterministic-token") {
      if (!Buffer.isBuffer(tokenizationKey) || tokenizationKey.byteLength < 8) {
        throw snapshotError("SNAPSHOT_TOKENIZATION_KEY_INVALID");
      }
      output[rule.column] = `snap_${createHmac("sha256", tokenizationKey)
        .update(String(output[rule.column]), "utf8")
        .digest("hex")
        .slice(0, 24)}`;
    } else if (rule.method === "fixed-disabled-value") {
      output[rule.column] = rule.fixedValue;
    } else if (rule.method === "null-out") {
      output[rule.column] = null;
    } else if (rule.method === "redact-url") {
      output[rule.column] = "snapshot://redacted";
    }
  }
  return immutable(output);
}

export function verifySnapshotMetadata({
  metadata,
  contract,
  ownershipMap,
  dump,
  scan,
  knownMigrationHeads = contract?.source?.knownMigrationHeads,
  now = new Date()
}) {
  assertContractSemantics(contract);
  try {
    validateContract("snapshot-metadata.v1", metadata);
  } catch (error) {
    throw snapshotError("SNAPSHOT_METADATA_INVALID", { cause: error?.code });
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw snapshotError("SNAPSHOT_CLOCK_INVALID");
  }
  if (Date.parse(metadata.expiresAt) <= now.getTime()) throw snapshotError("SNAPSHOT_EXPIRED");
  if (
    Date.parse(metadata.createdAt) > now.getTime() ||
    Date.parse(metadata.reviewAt) <= Date.parse(metadata.createdAt) ||
    Date.parse(metadata.expiresAt) <= Date.parse(metadata.createdAt)
  ) {
    throw snapshotError("SNAPSHOT_LIFECYCLE_INVALID");
  }
  if (metadata.sanitizationContractDigest !== sha256Canonical(contract)) {
    throw snapshotError("SNAPSHOT_CONTRACT_DRIFT");
  }
  if (
    metadata.ownershipMapDigest !== sha256Canonical(ownershipMap) ||
    metadata.ownershipContractVersion !== ownershipMap?.mapVersion
  ) {
    throw snapshotError("SNAPSHOT_OWNERSHIP_CONTRACT_DRIFT");
  }
  if (!knownMigrationHeads.includes(metadata.sourceMigrationHead)) {
    throw snapshotError("SNAPSHOT_MIGRATION_HEAD_UNKNOWN");
  }
  if (metadata.dumpDigest !== sha256Bytes(Buffer.from(dump))) {
    throw snapshotError("SNAPSHOT_DUMP_DIGEST_MISMATCH");
  }
  if (
    scan?.status !== "PASSED" ||
    scan.findingsCount !== 0 ||
    metadata.scanSubjectDigest !== metadata.dumpDigest ||
    scan.subjectDigest !== metadata.dumpDigest ||
    scan.contractDigest !== metadata.sanitizationContractDigest ||
    metadata.scanDigest !== sha256Canonical(scan)
  ) {
    throw snapshotError("SNAPSHOT_SCAN_INVALID");
  }
  if (
    metadata.sourceFingerprintBeforeDigest !== metadata.sourceFingerprintAfterDigest ||
    metadata.owner !== contract.lifecycle.owner ||
    canonicalJson(metadata.readers) !== canonicalJson(contract.lifecycle.readers) ||
    metadata.accessPolicyRef !== contract.lifecycle.accessPolicyRef
  ) {
    throw snapshotError("SNAPSHOT_METADATA_SOURCE_MISMATCH");
  }
  return metadata;
}

export function snapshotBundleDigest(bundle) {
  return sha256Canonical({
    dumpDigest: sha256Bytes(bundle.dump),
    metadataDigest: sha256Canonical(bundle.metadata),
    privilegeObservationDigest: sha256Canonical(bundle.privilegeObservation),
    fingerprintObservationDigest: sha256Canonical(bundle.fingerprintObservation),
    scanDigest: sha256Canonical(bundle.scan)
  });
}

export async function exportSanitizedSnapshot({
  contract,
  ownershipMap,
  source,
  workspace,
  publisher,
  secretReference,
  tokenizationSecretReference,
  workflowRunRef,
  now = () => new Date(),
  ...forbidden
}) {
  if (
    Object.keys(forbidden).length > 0 ||
    workspace?.trustPolicy !== "isolated-sanitization-workspace/v1" ||
    publisher?.trustPolicy !== "snapshot-final-bundle/v1" ||
    typeof source?.openReadOnlySnapshot !== "function" ||
    typeof source?.exportRaw !== "function" ||
    typeof source?.closeSnapshot !== "function" ||
    typeof workspace?.restoreRaw !== "function" ||
    typeof workspace?.applyTransformations !== "function" ||
    typeof workspace?.exportSanitized !== "function" ||
    typeof workspace?.destroy !== "function" ||
    typeof publisher?.publishFinalBundle !== "function" ||
    typeof tokenizationSecretReference !== "string" ||
    !/^secret:\/\/[a-z0-9][a-z0-9./_-]+$/.test(tokenizationSecretReference) ||
    typeof workflowRunRef !== "string" ||
    !workflowRunRef
  ) {
    throw snapshotError("SNAPSHOT_EXPORT_INPUT_INVALID");
  }
  assertContractSemantics(contract);
  validateContract("ownership-map.v1", ownershipMap);
  let opened = false;
  let workspaceDestroyed = false;
  let primaryError;
  try {
    const createdAt = now();
    const privilegeObservation = await assertReadOnlySnapshotSource({
      source,
      secretReference,
      ownershipMap,
      now: createdAt
    });
    const snapshot = await source.openReadOnlySnapshot({ secretReference });
    opened = true;
    if (
      snapshot?.isolationLevel !== "REPEATABLE READ" ||
      snapshot.readOnly !== true ||
      snapshot.deferrable !== true ||
      typeof snapshot.snapshotId !== "string" ||
      !snapshot.snapshotId
    ) {
      throw snapshotError("SNAPSHOT_SOURCE_TRANSACTION_INVALID");
    }
    const before = await fingerprintSourceSnapshot({
      source,
      snapshotId: snapshot.snapshotId,
      keyTables: contract.source.keyTables,
      now: createdAt
    });
    const raw = await source.exportRaw({ snapshotId: snapshot.snapshotId });
    if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
      throw snapshotError("SNAPSHOT_RAW_EXPORT_INVALID");
    }
    await workspace.restoreRaw(Buffer.from(raw));
    await workspace.applyTransformations({
      contract,
      tokenizationSecretReference,
      sourceDatabaseAccess: "forbidden"
    });
    const sanitized = Buffer.from(await workspace.exportSanitized());
    const scan = await scanSanitizedArtifact({ bytes: sanitized, contract, scannedAt: createdAt });
    const after = await fingerprintSourceSnapshot({
      source,
      snapshotId: snapshot.snapshotId,
      keyTables: contract.source.keyTables,
      now: createdAt
    });
    const beforeIdentityDigest = sha256Canonical(before.identity);
    const afterIdentityDigest = sha256Canonical(after.identity);
    if (beforeIdentityDigest !== afterIdentityDigest) {
      throw snapshotError("SNAPSHOT_SOURCE_FINGERPRINT_CHANGED");
    }
    const metadata = immutable({
      schemaVersion: "snapshot-metadata.v1",
      dumpDigest: sha256Bytes(sanitized),
      sourceMigrationHead: before.identity.migrationHead,
      sourcePrivilegeObservationDigest: sha256Canonical(privilegeObservation),
      sourceFingerprintBeforeDigest: beforeIdentityDigest,
      sourceFingerprintAfterDigest: afterIdentityDigest,
      sanitizationContractDigest: sha256Canonical(contract),
      ownershipMapDigest: sha256Canonical(ownershipMap),
      ownershipContractVersion: ownershipMap.mapVersion,
      scanDigest: sha256Canonical(scan),
      scanSubjectDigest: scan.subjectDigest,
      exportToolVersion: contract.tools.exporterVersion,
      scanToolVersion: contract.tools.scannerVersion,
      createdAt: createdAt.toISOString(),
      reviewAt: addUtcDays(createdAt, contract.lifecycle.reviewAfterDays).toISOString(),
      expiresAt: addUtcDays(createdAt, contract.lifecycle.expiresAfterDays).toISOString(),
      owner: contract.lifecycle.owner,
      readers: contract.lifecycle.readers,
      accessPolicyRef: contract.lifecycle.accessPolicyRef,
      workflowRunRef
    });
    verifySnapshotMetadata({
      metadata,
      contract,
      ownershipMap,
      dump: sanitized,
      scan,
      now: createdAt
    });
    const bundle = Object.freeze({
      dump: sanitized,
      metadata,
      privilegeObservation,
      fingerprintObservation: after,
      scan
    });
    try {
      await source.closeSnapshot();
      opened = false;
      await workspace.destroy();
      workspaceDestroyed = true;
    } catch (error) {
      throw snapshotError("SNAPSHOT_SECURE_CLEANUP_FAILED", { cause: error?.code });
    }
    const receipt = await publisher.publishFinalBundle(bundle);
    const expectedBundleDigest = snapshotBundleDigest(bundle);
    try {
      assertCustodyComplete(receipt, expectedBundleDigest);
    } catch (error) {
      throw snapshotError("SNAPSHOT_CUSTODY_INVALID", { cause: error?.code });
    }
    if (
      receipt.owner !== contract.lifecycle.owner ||
      canonicalJson(receipt.readers) !== canonicalJson(contract.lifecycle.readers)
    ) {
      throw snapshotError("SNAPSHOT_CUSTODY_INVALID");
    }
    return metadata;
  } catch (error) {
    primaryError = error;
    if (error?.code?.startsWith("SNAPSHOT_")) throw error;
    throw snapshotError("SNAPSHOT_PUBLICATION_INCOMPLETE_FORBIDDEN", {
      cause: error?.code ?? error?.message
    });
  } finally {
    const cleanupErrors = [];
    if (opened) {
      await source.closeSnapshot().catch((error) => cleanupErrors.push(error));
    }
    if (!workspaceDestroyed) {
      await workspace.destroy().catch((error) => cleanupErrors.push(error));
    }
    if (!primaryError && cleanupErrors.length > 0) {
      throw snapshotError("SNAPSHOT_SECURE_CLEANUP_FAILED");
    }
  }
}
