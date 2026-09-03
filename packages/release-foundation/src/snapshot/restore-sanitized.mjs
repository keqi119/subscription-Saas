import { canonicalJson } from "../canonical-json.mjs";
import { sha256Canonical } from "../digest.mjs";
import { assertCustodyComplete } from "../evidence-custody.mjs";
import { snapshotBundleDigest, verifySnapshotMetadata } from "./export-sanitized.mjs";
import { normalizeSnapshotOwnership } from "./normalize-ownership.mjs";

const rolePattern = /^s1x_[0-9a-f]{24}$/;
const secretReferencePattern =
  /^(?:secret:\/\/[a-z0-9][a-z0-9./_-]+|\.release-local\/runs\/[0-9a-f-]+\/[a-z0-9.-]+(?:\/source)?\/restore\.json)$/;

function restoreError(code, details) {
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

function assertRestoreIdentity(identity, target) {
  if (
    identity?.profile !== "restore" ||
    !rolePattern.test(identity.role ?? "") ||
    !secretReferencePattern.test(identity.secretReference ?? "") ||
    identity.role === target.migrationRole ||
    identity.role === target.runtimeRole ||
    identity.superuser !== false ||
    identity.createdb !== false ||
    identity.createrole !== false ||
    identity.bypassrls !== false
  ) {
    throw restoreError("RESTORE_IDENTITY_INVALID");
  }
}

function assertAdapters(adapters) {
  const methods = [
    "grantTemporaryMembership",
    "restoreDump",
    "readOwnershipInventory",
    "transferOwnership",
    "revokeMembership",
    "revokeCredential",
    "canRestoreConnect",
    "verifyMigrationReconnect",
    "custodyOwnershipProof"
  ];
  if (
    adapters?.trustPolicy !== "snapshot-restore-adapters/v1" ||
    methods.some((method) => typeof adapters[method] !== "function")
  ) {
    throw restoreError("SNAPSHOT_RESTORE_ADAPTERS_INVALID");
  }
}

function verifyArtifact({ artifact, contract, ownershipMap, now }) {
  verifySnapshotMetadata({
    metadata: artifact?.metadata,
    contract,
    ownershipMap,
    dump: artifact?.dump,
    scan: artifact?.scan,
    now
  });
  if (
    artifact.metadata.sourcePrivilegeObservationDigest !==
      sha256Canonical(artifact.privilegeObservation) ||
    artifact.metadata.sourceFingerprintAfterDigest !==
      sha256Canonical(artifact.fingerprintObservation?.identity)
  ) {
    throw restoreError("SNAPSHOT_ARTIFACT_OBSERVATION_MISMATCH");
  }
  const bundleDigest = snapshotBundleDigest(artifact);
  try {
    assertCustodyComplete(artifact.custodyReceipt, bundleDigest);
  } catch (error) {
    throw restoreError("SNAPSHOT_CUSTODY_INVALID", { cause: error?.code });
  }
  return bundleDigest;
}

export function assertSnapshotSchemaDiffResult({ exitCode, signal }) {
  if (signal || exitCode !== 0) {
    throw restoreError("SNAPSHOT_SCHEMA_DIFF", { exitCode, signal: signal ?? null });
  }
  return true;
}

export async function restoreSanitizedSnapshot({
  artifact,
  contract,
  ownershipMap,
  target,
  restoreIdentity,
  adapters,
  now = new Date()
}) {
  const bundleDigest = verifyArtifact({ artifact, contract, ownershipMap, now });
  if (
    !/^s1ci_[0-9a-f]{24}$/.test(target?.databaseName ?? "") ||
    !/^[0-9]+$/.test(target?.databaseOid ?? "")
  ) {
    throw restoreError("SNAPSHOT_RESTORE_TARGET_INVALID");
  }
  assertRestoreIdentity(restoreIdentity, target);
  assertAdapters(adapters);
  let membershipGranted = false;
  let membershipRevoked = false;
  let credentialRevoked = false;
  try {
    await adapters.grantTemporaryMembership({
      databaseName: target.databaseName,
      databaseOid: target.databaseOid,
      restoreRole: restoreIdentity.role,
      migrationRole: target.migrationRole
    });
    membershipGranted = true;
    await adapters.restoreDump({
      dump: artifact.dump,
      dumpDigest: artifact.metadata.dumpDigest,
      target: {
        databaseName: target.databaseName,
        databaseOid: target.databaseOid,
        databaseIdentityDigest: target.databaseIdentityDigest
      },
      restoreSecretReference: restoreIdentity.secretReference,
      options: Object.freeze({ noOwner: true, noAcl: true, role: target.migrationRole })
    });
    const before = await adapters.readOwnershipInventory({ phase: "before" });
    const ownershipObservation = await normalizeSnapshotOwnership({
      ownershipMap,
      target,
      inventory: before,
      transferOwnership: adapters.transferOwnership,
      readInventory: () => adapters.readOwnershipInventory({ phase: "after" }),
      now
    });
    await adapters.revokeMembership({
      restoreRole: restoreIdentity.role,
      migrationRole: target.migrationRole
    });
    membershipRevoked = true;
    await adapters.revokeCredential({ secretReference: restoreIdentity.secretReference });
    credentialRevoked = true;
    if (await adapters.canRestoreConnect({ restoreIdentity, target })) {
      throw restoreError("RESTORE_CREDENTIAL_STILL_ACTIVE");
    }
    if (
      (await adapters.verifyMigrationReconnect({
        target,
        ownershipObservation
      })) !== true
    ) {
      throw restoreError("MIGRATION_OWNER_RECONNECT_FAILED");
    }
    const ownershipObservationDigest = sha256Canonical(ownershipObservation);
    const custody = await adapters.custodyOwnershipProof({
      ownershipObservation,
      ownershipObservationDigest,
      snapshotBundleDigest: bundleDigest
    });
    if (
      custody?.complete !== true ||
      custody.contentDigest !== ownershipObservationDigest ||
      custody.readbackDigest !== ownershipObservationDigest
    ) {
      throw restoreError("SNAPSHOT_OWNERSHIP_CUSTODY_INCOMPLETE");
    }
    return immutable({
      schemaVersion: "restored-snapshot-record.v1",
      databaseIdentityDigest: target.databaseIdentityDigest,
      snapshotBundleDigest: bundleDigest,
      ownershipObservationDigest,
      ownershipCustodyDigest: sha256Canonical(custody),
      restoreIdentityFingerprint: sha256Canonical({ role: restoreIdentity.role }),
      migrationOwnerFingerprint: sha256Canonical({ role: target.migrationRole }),
      restoredAt: now.toISOString()
    });
  } finally {
    const failures = [];
    if (membershipGranted && !membershipRevoked) {
      await adapters
        .revokeMembership({
          restoreRole: restoreIdentity.role,
          migrationRole: target.migrationRole
        })
        .catch((error) => failures.push(error));
    }
    if (membershipGranted && !credentialRevoked) {
      await adapters
        .revokeCredential({ secretReference: restoreIdentity.secretReference })
        .catch((error) => failures.push(error));
    }
    if (failures.length > 0) throw restoreError("RESTORE_REVOCATION_FAILED");
  }
}
