import { canonicalJson } from "../canonical-json.mjs";
import { sha256Canonical } from "../digest.mjs";
import { validateContract } from "../schema-registry.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const rolePattern = /^s1[rm]_[0-9a-f]{24}$/;

function ownershipError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function assertTarget(target) {
  if (
    !digestPattern.test(target?.databaseIdentityDigest ?? "") ||
    !rolePattern.test(target?.migrationRole ?? "") ||
    !rolePattern.test(target?.runtimeRole ?? "") ||
    target.migrationRole === target.runtimeRole
  ) {
    throw ownershipError("SNAPSHOT_OWNERSHIP_TARGET_INVALID");
  }
}

function assertMapSemantics(ownershipMap) {
  validateContract("ownership-map.v1", ownershipMap);
  for (const values of [
    ownershipMap.sourceOwners,
    ownershipMap.schemas,
    ownershipMap.objectClasses,
    ownershipMap.excludedExtensions
  ]) {
    if (canonicalJson([...values].sort()) !== canonicalJson(values)) {
      throw ownershipError("SNAPSHOT_OWNERSHIP_MAP_ORDER_INVALID");
    }
  }
}

function normalizedObjects(inventory) {
  if (!Array.isArray(inventory?.objects)) {
    throw ownershipError("SNAPSHOT_OWNERSHIP_INVENTORY_INVALID");
  }
  const objects = inventory.objects.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(["extensionName", "objectClass", "objectName", "owner", "schemaName"]) ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(entry.schemaName ?? "") ||
      typeof entry.objectName !== "string" ||
      entry.objectName.length === 0 ||
      typeof entry.owner !== "string" ||
      entry.owner.length === 0 ||
      (entry.extensionName !== null && !/^[a-z][a-z0-9_]{0,62}$/.test(entry.extensionName ?? ""))
    ) {
      throw ownershipError("SNAPSHOT_OWNERSHIP_INVENTORY_INVALID");
    }
    return { ...entry };
  });
  const keys = objects.map(
    ({ objectClass, schemaName, objectName }) =>
      `${objectClass}\u0000${schemaName}\u0000${objectName}`
  );
  if (new Set(keys).size !== keys.length) {
    throw ownershipError("SNAPSHOT_OWNERSHIP_INVENTORY_DUPLICATE");
  }
  return objects.sort((left, right) =>
    `${left.objectClass}\u0000${left.schemaName}\u0000${left.objectName}`.localeCompare(
      `${right.objectClass}\u0000${right.schemaName}\u0000${right.objectName}`
    )
  );
}

function assertMappedObject(entry, ownershipMap, target, { allowSourceOwner }) {
  if (!ownershipMap.objectClasses.includes(entry.objectClass)) {
    throw ownershipError("SNAPSHOT_OBJECT_CLASS_UNMAPPED", { objectClass: entry.objectClass });
  }
  if (!ownershipMap.schemas.includes(entry.schemaName)) {
    throw ownershipError("SNAPSHOT_CROSS_SCHEMA_OBJECT_FORBIDDEN", {
      schemaName: entry.schemaName
    });
  }
  if (
    entry.extensionName !== null &&
    !ownershipMap.excludedExtensions.includes(entry.extensionName)
  ) {
    throw ownershipError("SNAPSHOT_EXTENSION_UNMAPPED", { extensionName: entry.extensionName });
  }
  if (entry.owner === target.runtimeRole) {
    throw ownershipError("SNAPSHOT_RUNTIME_OWNER_FORBIDDEN", { objectName: entry.objectName });
  }
  if (entry.extensionName !== null) {
    return Object.freeze({ ownerNormalizationExcluded: true });
  }
  if (
    entry.owner !== target.migrationRole &&
    !(allowSourceOwner && ownershipMap.sourceOwners.includes(entry.owner))
  ) {
    throw ownershipError("SNAPSHOT_OWNER_UNMAPPED", {
      objectName: entry.objectName,
      owner: entry.owner
    });
  }
  return Object.freeze({ ownerNormalizationExcluded: false });
}

export function verifyOwnershipMap({ ownershipMap, target, inventory, now = new Date() }) {
  assertMapSemantics(ownershipMap);
  assertTarget(target);
  if (inventory?.databaseIdentityDigest !== target.databaseIdentityDigest) {
    throw ownershipError("SNAPSHOT_OWNERSHIP_TARGET_MISMATCH");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw ownershipError("SNAPSHOT_OWNERSHIP_CLOCK_INVALID");
  }
  const objects = normalizedObjects(inventory);
  objects.forEach((entry) =>
    assertMappedObject(entry, ownershipMap, target, { allowSourceOwner: false })
  );
  if (
    !objects.some(
      ({ objectClass, schemaName, objectName }) =>
        objectClass === "schema" && schemaName === "public" && objectName === "public"
    ) ||
    !objects.some(
      ({ objectClass, schemaName, objectName }) =>
        objectClass === "table" && schemaName === "public" && objectName === "_prisma_migrations"
    )
  ) {
    throw ownershipError("SNAPSHOT_REQUIRED_OWNER_OBJECT_MISSING");
  }
  const counts = Object.fromEntries(
    [...new Set(objects.map(({ objectClass }) => objectClass))]
      .sort()
      .map((objectClass) => [
        objectClass,
        objects.filter((entry) => entry.objectClass === objectClass).length
      ])
  );
  return Object.freeze({
    schemaVersion: "ownership-observation.v1",
    databaseIdentityDigest: target.databaseIdentityDigest,
    ownershipMapDigest: sha256Canonical(ownershipMap),
    ownershipMapVersion: ownershipMap.mapVersion,
    targetOwnerProfile: ownershipMap.targetOwnerProfile,
    targetOwnerFingerprint: sha256Canonical({ role: target.migrationRole }),
    objectCounts: counts,
    objectInventoryDigest: sha256Canonical(objects),
    observedAt: now.toISOString()
  });
}

export async function normalizeSnapshotOwnership({
  ownershipMap,
  target,
  inventory,
  transferOwnership,
  readInventory,
  now = new Date()
}) {
  assertMapSemantics(ownershipMap);
  assertTarget(target);
  if (
    inventory?.databaseIdentityDigest !== target.databaseIdentityDigest ||
    typeof transferOwnership !== "function" ||
    typeof readInventory !== "function"
  ) {
    throw ownershipError("SNAPSHOT_OWNERSHIP_TARGET_MISMATCH");
  }
  const objects = normalizedObjects(inventory);
  for (const entry of objects) {
    const mapping = assertMappedObject(entry, ownershipMap, target, { allowSourceOwner: true });
    if (!mapping.ownerNormalizationExcluded && entry.owner !== target.migrationRole) {
      await transferOwnership({
        databaseIdentityDigest: target.databaseIdentityDigest,
        object: Object.freeze({ ...entry }),
        fromOwner: entry.owner,
        toOwner: target.migrationRole,
        ownershipMapDigest: sha256Canonical(ownershipMap)
      });
    }
  }
  return verifyOwnershipMap({
    ownershipMap,
    target,
    inventory: await readInventory(),
    now
  });
}
