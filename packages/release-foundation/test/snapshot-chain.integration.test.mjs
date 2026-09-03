import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSnapshotOwnership,
  verifyOwnershipMap
} from "../src/snapshot/normalize-ownership.mjs";
import {
  assertSnapshotSchemaDiffResult,
  restoreSanitizedSnapshot
} from "../src/snapshot/restore-sanitized.mjs";
import { sha256Bytes, sha256Canonical, snapshotBundleDigest } from "../src/index.mjs";

// @database-test: the source-gate launcher owns the target; unit cases use capability doubles.

test("snapshot ownership rejects an unmapped source owner", async () => {
  await assert.rejects(
    () =>
      normalizeSnapshotOwnership({
        ownershipMap: {
          schemaVersion: "ownership-map.v1",
          mapId: "stage1-snapshot-owner-map",
          mapVersion: "1",
          sourceOwners: ["subscription", "subscription_saas"],
          targetOwnerProfile: "migrate",
          schemas: ["public"],
          objectClasses: ["schema", "table"],
          excludedExtensions: ["pgcrypto"]
        },
        target: {
          databaseIdentityDigest: `sha256:${"1".repeat(64)}`,
          migrationRole: "s1m_111111111111111111111111",
          runtimeRole: "s1r_111111111111111111111111"
        },
        inventory: {
          databaseIdentityDigest: `sha256:${"1".repeat(64)}`,
          objects: [
            {
              objectClass: "table",
              schemaName: "public",
              objectName: "customer",
              owner: "unknown_owner",
              extensionName: null
            }
          ]
        },
        transferOwnership: async () => assert.fail("unknown owner must not be transferred"),
        readInventory: async () => assert.fail("unknown owner must stop before reread")
      }),
    { code: "SNAPSHOT_OWNER_UNMAPPED" }
  );
});

test("ownership verification rejects runtime ownership and wrong database", () => {
  const ownershipMap = {
    schemaVersion: "ownership-map.v1",
    mapId: "stage1-snapshot-owner-map",
    mapVersion: "1",
    sourceOwners: ["subscription", "subscription_saas"],
    targetOwnerProfile: "migrate",
    schemas: ["public"],
    objectClasses: ["schema", "table"],
    excludedExtensions: ["pgcrypto"]
  };
  const target = {
    databaseIdentityDigest: `sha256:${"1".repeat(64)}`,
    migrationRole: "s1m_111111111111111111111111",
    runtimeRole: "s1r_111111111111111111111111"
  };
  assert.throws(
    () =>
      verifyOwnershipMap({
        ownershipMap,
        target,
        inventory: {
          databaseIdentityDigest: `sha256:${"2".repeat(64)}`,
          objects: []
        }
      }),
    { code: "SNAPSHOT_OWNERSHIP_TARGET_MISMATCH" }
  );
  assert.throws(
    () =>
      verifyOwnershipMap({
        ownershipMap,
        target,
        inventory: {
          databaseIdentityDigest: target.databaseIdentityDigest,
          objects: [
            {
              objectClass: "table",
              schemaName: "public",
              objectName: "customer",
              owner: target.runtimeRole,
              extensionName: null
            }
          ]
        }
      }),
    { code: "SNAPSHOT_RUNTIME_OWNER_FORBIDDEN" }
  );
});

test("approved extension objects are observed but excluded from owner normalization", async () => {
  const ownershipMap = {
    schemaVersion: "ownership-map.v1",
    mapId: "stage1-snapshot-owner-map",
    mapVersion: "1",
    sourceOwners: ["subscription", "subscription_saas"],
    targetOwnerProfile: "migrate",
    schemas: ["public"],
    objectClasses: ["function", "schema", "table"],
    excludedExtensions: ["pgcrypto"]
  };
  const target = {
    databaseIdentityDigest: `sha256:${"1".repeat(64)}`,
    migrationRole: "s1m_111111111111111111111111",
    runtimeRole: "s1r_111111111111111111111111"
  };
  let transferCount = 0;
  const inventory = {
    databaseIdentityDigest: target.databaseIdentityDigest,
    objects: [
      {
        objectClass: "schema",
        schemaName: "public",
        objectName: "public",
        owner: target.migrationRole,
        extensionName: null
      },
      {
        objectClass: "table",
        schemaName: "public",
        objectName: "_prisma_migrations",
        owner: target.migrationRole,
        extensionName: null
      },
      {
        objectClass: "function",
        schemaName: "public",
        objectName: "gen_random_uuid()",
        owner: "s1p_controlled_provisioner",
        extensionName: "pgcrypto"
      }
    ]
  };
  const observation = await normalizeSnapshotOwnership({
    ownershipMap,
    target,
    inventory,
    transferOwnership: async () => {
      transferCount += 1;
    },
    readInventory: async () => inventory
  });
  assert.equal(transferCount, 0);
  assert.equal(observation.objectCounts.function, 1);
});

test("restore revokes its one-use capability before migration may reconnect", async () => {
  const events = [];
  const input = restoreFixture(events);
  const result = await restoreSanitizedSnapshot(input);
  assert.equal(result.schemaVersion, "restored-snapshot-record.v1");
  assert.deepEqual(events, [
    "grant",
    "restore",
    "inventory-before",
    "inventory-after",
    "revoke-membership",
    "revoke-secret",
    "restore-connect-refused",
    "migration-reconnect",
    "custody"
  ]);
});

test("expired snapshot is rejected before restore capability is granted", async () => {
  const events = [];
  const input = restoreFixture(events);
  input.now = new Date("2026-10-03T08:00:00.000Z");
  await assert.rejects(() => restoreSanitizedSnapshot(input), { code: "SNAPSHOT_EXPIRED" });
  assert.deepEqual(events, []);
});

test("restore credential still active blocks migration", async () => {
  const events = [];
  const input = restoreFixture(events);
  input.adapters.canRestoreConnect = async () => true;
  await assert.rejects(() => restoreSanitizedSnapshot(input), {
    code: "RESTORE_CREDENTIAL_STILL_ACTIVE"
  });
  assert.equal(events.includes("migration-reconnect"), false);
});

test("snapshot schema drift fails with the dedicated source-chain error", () => {
  assert.throws(() => assertSnapshotSchemaDiffResult({ exitCode: 2, signal: null }), {
    code: "SNAPSHOT_SCHEMA_DIFF"
  });
  assert.equal(assertSnapshotSchemaDiffResult({ exitCode: 0, signal: null }), true);
});

function restoreFixture(events) {
  const digest = (character) => `sha256:${character.repeat(64)}`;
  const ownershipMap = {
    schemaVersion: "ownership-map.v1",
    mapId: "stage1-snapshot-owner-map",
    mapVersion: "1",
    sourceOwners: ["subscription", "subscription_saas"],
    targetOwnerProfile: "migrate",
    schemas: ["public"],
    objectClasses: ["schema", "table"],
    excludedExtensions: ["pgcrypto"]
  };
  const contract = {
    schemaVersion: "sanitization-contract.v1",
    contractId: "stage1-staging-snapshot",
    contractVersion: "1",
    source: {
      allowedEnvironment: "staging",
      keyTables: ["public.customer"],
      knownMigrationHeads: ["20260901010000_stage1_schema_drift_convergence"]
    },
    transformations: [
      {
        table: "public.customer",
        column: "mobile",
        method: "deterministic-token",
        keyReference: "secret://stage1-snapshot-export/tokenization-key"
      }
    ],
    scanRules: ["china-mobile"],
    tools: { exporterVersion: "snapshot-export/1", scannerVersion: "snapshot-scan/1" },
    lifecycle: {
      owner: "release-engineering",
      readers: ["release", "qa", "security", "audit"],
      reviewAfterDays: 30,
      expiresAfterDays: 30,
      accessPolicyRef: "policy://stage1-sanitized-snapshot"
    }
  };
  const dump = Buffer.from("sanitized custom dump fixture");
  const dumpDigest = sha256Bytes(dump);
  const contractDigest = sha256Canonical(contract);
  const scan = {
    schemaVersion: "sanitization-scan.v1",
    subjectDigest: dumpDigest,
    contractDigest,
    scannerVersion: "snapshot-scan/1",
    status: "PASSED",
    findingsCount: 0,
    scannedAt: "2026-09-02T08:00:00.000Z"
  };
  const privilegeObservation = {
    schemaVersion: "source-privilege-observation.v1",
    capabilityDigest: digest("7")
  };
  const fingerprintObservation = {
    schemaVersion: "source-fingerprint.v1",
    identity: {
      migrationHead: "20260901010000_stage1_schema_drift_convergence",
      databaseIdentityFingerprint: digest("8")
    }
  };
  const target = {
    databaseName: `s1ci_${"1".repeat(24)}`,
    databaseOid: "19001",
    databaseIdentityDigest: digest("1"),
    migrationRole: `s1m_${"1".repeat(24)}`,
    runtimeRole: `s1r_${"1".repeat(24)}`
  };
  const metadata = {
    schemaVersion: "snapshot-metadata.v1",
    dumpDigest,
    sourceMigrationHead: "20260901010000_stage1_schema_drift_convergence",
    sourcePrivilegeObservationDigest: sha256Canonical(privilegeObservation),
    sourceFingerprintBeforeDigest: sha256Canonical(fingerprintObservation.identity),
    sourceFingerprintAfterDigest: sha256Canonical(fingerprintObservation.identity),
    sanitizationContractDigest: contractDigest,
    ownershipMapDigest: sha256Canonical(ownershipMap),
    ownershipContractVersion: "1",
    scanDigest: sha256Canonical(scan),
    scanSubjectDigest: dumpDigest,
    exportToolVersion: "snapshot-export/1",
    scanToolVersion: "snapshot-scan/1",
    createdAt: "2026-09-02T08:00:00.000Z",
    reviewAt: "2026-10-02T08:00:00.000Z",
    expiresAt: "2026-10-02T08:00:00.000Z",
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    accessPolicyRef: "policy://stage1-sanitized-snapshot",
    workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/1"
  };
  const artifactWithoutCustody = {
    dump,
    metadata,
    scan,
    privilegeObservation,
    fingerprintObservation
  };
  const bundleDigest = snapshotBundleDigest(artifactWithoutCustody);
  const artifact = {
    ...artifactWithoutCustody,
    custodyReceipt: {
      schemaVersion: "custody-receipt.v1",
      receiptId: "ea4d51a1-4e63-491a-80ca-fc478b2fd53f",
      contentDigest: bundleDigest,
      contentSizeBytes: 1,
      storeRef: "artifact://release/sanitized-snapshot",
      uploadedAt: "2026-09-02T08:00:00.000Z",
      readbackAt: "2026-09-02T08:00:00.000Z",
      readbackDigest: bundleDigest,
      owner: "release-engineering",
      readers: ["release", "qa", "security", "audit"],
      retainUntil: "2027-03-01T08:00:00.000Z",
      expiryDisposition: "review",
      attestationRef: "attestation://release/sanitized-snapshot"
    }
  };
  return {
    artifact: { ...artifact, metadata },
    contract,
    ownershipMap,
    target,
    restoreIdentity: {
      profile: "restore",
      role: `s1x_${"1".repeat(24)}`,
      secretReference: "secret://runner/restore/one-use",
      superuser: false,
      createdb: false,
      createrole: false,
      bypassrls: false
    },
    adapters: {
      trustPolicy: "snapshot-restore-adapters/v1",
      async grantTemporaryMembership() {
        events.push("grant");
      },
      async restoreDump() {
        events.push("restore");
      },
      async readOwnershipInventory({ phase }) {
        events.push(`inventory-${phase}`);
        return {
          databaseIdentityDigest: target.databaseIdentityDigest,
          objects: [
            {
              objectClass: "schema",
              schemaName: "public",
              objectName: "public",
              owner: target.migrationRole,
              extensionName: null
            },
            {
              objectClass: "table",
              schemaName: "public",
              objectName: "_prisma_migrations",
              owner: target.migrationRole,
              extensionName: null
            }
          ]
        };
      },
      async transferOwnership() {
        assert.fail("no normalization should be necessary after --no-owner --role");
      },
      async revokeMembership() {
        events.push("revoke-membership");
      },
      async revokeCredential() {
        events.push("revoke-secret");
      },
      async canRestoreConnect() {
        events.push("restore-connect-refused");
        return false;
      },
      async verifyMigrationReconnect() {
        events.push("migration-reconnect");
        return true;
      },
      async custodyOwnershipProof({ ownershipObservationDigest }) {
        events.push("custody");
        return {
          complete: true,
          contentDigest: ownershipObservationDigest,
          readbackDigest: ownershipObservationDigest
        };
      }
    },
    now: new Date("2026-09-02T08:00:00.000Z")
  };
}
