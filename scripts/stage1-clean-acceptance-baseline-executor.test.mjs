import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  executeStage1CleanAcceptanceBaseline,
  validateStage1CleanAcceptanceTargetBaseline
} from "./stage1-clean-acceptance-baseline-executor.mjs";

const VEHICLE_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COST_PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const LEDGER_ID_1 = "55555555-5555-4555-8555-555555555555";
const LEDGER_ID_2 = "66666666-6666-4666-8666-666666666666";
const GENERATED_AT = "2026-08-30T12:00:00.000Z";
const HASH_SALT = "1".repeat(64);
const GIT_SHA = "2".repeat(40);
const IMAGE_REF = `registry.example/api@sha256:${"3".repeat(64)}`;
const APPLY_ENV = "STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY";
const TEST_SCHEMA_ROW = {
  tableName: "user",
  columnName: "id",
  dataType: "uuid",
  isNullable: "NO",
  ordinalPosition: 1,
  columnDefault: null,
  udtName: "uuid"
};
const TEST_CANONICAL_METADATA = {
  canonicalMigrationChecksums: [
    { checksum: "a".repeat(64), migrationName: "20260830000000_acceptance" }
  ],
  canonicalSchemaFingerprintSha256: createHash("sha256")
    .update(JSON.stringify([TEST_SCHEMA_ROW]))
    .digest("hex")
};

const NOTIFICATION_CODES = [
  "APPLICATION_SUBMITTED_IN_APP",
  "APPLICATION_SUBMITTED_WECHAT",
  "AUTO_DEBIT_FAILURE_IN_APP",
  "AUTO_DEBIT_FAILURE_SMS",
  "AUTO_DEBIT_FAILURE_WECHAT",
  "CONTRACT_PENDING_IN_APP",
  "CONTRACT_PENDING_WECHAT",
  "FINAL_PLAN_READY_IN_APP",
  "FINAL_PLAN_READY_WECHAT",
  "HANDOVER_ESIGN_PENDING_IN_APP",
  "HANDOVER_ESIGN_PENDING_WECHAT",
  "MILEAGE_REVIEW_DUE_IN_APP",
  "MILEAGE_REVIEW_DUE_WECHAT",
  "PAYMENT_PENDING_IN_APP",
  "PAYMENT_PENDING_WECHAT",
  "SERVICE_CASE_UPDATE_IN_APP",
  "SERVICE_CASE_UPDATE_WECHAT"
];

test("canonical metadata injection is unavailable outside the Node test runner", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
  const previous = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target)),
      (error) => error?.message === "MANIFEST_CONTEXT_INVALID"
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

test("dry-run starts a RepeatableRead source transaction with tagged READ ONLY and makes zero writes", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});

  const result = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));

  assert.equal(result.mode, "dry-run");
  assert.equal(result.safe, true);
  assert.equal(source.transactions[0].isolationLevel, "RepeatableRead");
  assert.match(source.transactions[0].calls[0].sql, /^SET TRANSACTION READ ONLY$/);
  assert.equal(source.calls.some(isWrite), false);
  assert.equal(target.calls.some(isWrite), false);
  assert.equal(target.rows.auditLog?.length ?? 0, 0);
});

test("apply rejects missing confirmation or malformed approval before a target transaction starts", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const transactionCount = target.transactions.length;
  const previous = process.env[APPLY_ENV];
  delete process.env[APPLY_ENV];
  try {
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      }),
      (error) => error?.message === "MANIFEST_CONTEXT_INVALID"
    );
    assert.equal(target.transactions.length, transactionCount);

    process.env[APPLY_ENV] = "1";
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: "0".repeat(64)
      }),
      (error) => error?.message === "MANIFEST_STALE"
    );
    assert.equal(target.transactions.length, transactionCount);
  } finally {
    restoreEnv(previous);
  }
});

test("apply rejects a source snapshot changed since the approved manifest without writing target rows", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  source.rows.user[0].name = "Changed after approval";
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      }),
      (error) => error?.message === "MANIFEST_STALE"
    );
    assert.equal(target.calls.some(isWrite), false);
    assert.equal(
      target.transactions.some((entry) => entry.isolationLevel === "Serializable"),
      false
    );
  } finally {
    restoreEnv(previous);
  }
});

test("apply first transaction SQL locks through a materialized CTE returning a supported scalar", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await executeStage1CleanAcceptanceBaseline({
      ...baseOptions("apply", source, target),
      approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    });

    const writeTx = target.transactions.find((entry) => entry.isolationLevel === "Serializable");
    assert.ok(writeTx);
    const firstCall = writeTx.calls[0];
    assert.equal(firstCall.operation, "$queryRaw");
    assert.equal(
      firstCall.sql.replace(/\s+/g, " ").trim(),
      "WITH lock_call AS MATERIALIZED ( SELECT pg_advisory_xact_lock(hashtext(?)) ) SELECT 1::int AS locked FROM lock_call"
    );
    assert.deepEqual(firstCall.values, ["stage1-clean-acceptance-baseline:apply"]);
  } finally {
    restoreEnv(previous);
  }
});

test("apply serializes, writes parents before children, preserves scalars, and emits one redacted audit", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    const result = await executeStage1CleanAcceptanceBaseline({
      ...baseOptions("apply", source, target),
      approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    });

    const writeTx = target.transactions.find((entry) => entry.isolationLevel === "Serializable");
    assert.ok(writeTx);
    assert.match(writeTx.calls[0].sql, /pg_advisory_xact_lock\(hashtext\(\?\)\)/);
    assertOrder(writeTx.calls, [
      "permission",
      "menu",
      "role",
      "rolePermission",
      "roleMenu",
      "user",
      "userRole",
      "customer",
      "customerAccount",
      "customerIdentity",
      "customerProfile",
      "customerESignProviderAccount",
      "depositRule",
      "product",
      "productVersion",
      "vehicleModelDefinition",
      "vehiclePackage",
      "vehiclePackageModelMember",
      "mileagePackage",
      "energyPackage",
      "benefitPackage",
      "subscriptionPlan",
      "productPriceRule",
      "fileObject",
      "contractVersion",
      "notificationTemplate",
      "assetOwner",
      "vehicle",
      "vehicleListingProfile",
      "vehicleListingMedia",
      "vehicleListingPlan",
      "vehicleDocumentBatch",
      "vehicleInsurancePolicy",
      "vehicleDocument",
      "vehicleInsuranceCoverage",
      "vehicleListingSourceBinding",
      "vehicleSalePriceHistory",
      "vehicleOwnershipPeriod",
      "vehicleAssetCostProfile",
      "vehicleCostLedgerEntry",
      "auditLog"
    ]);
    assert.equal(target.rows.user[0].id, ADMIN_ID);
    assert.equal(target.rows.user[0].passwordHash, "argon2-secret-hash");
    assert.equal(target.rows.vehicle[0].createdAt.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(target.rows.auditLog.length, 1);
    const audit = target.rows.auditLog[0];
    assert.equal(audit.entityType, "stage1_acceptance_baseline");
    assert.equal(audit.action, "CREATE");
    assert.deepEqual(Object.keys(audit.afterSnapshot).sort(), [
      "counts",
      "gitSha",
      "imageRef",
      "manifestSha256",
      "summary"
    ]);
    assert.equal(JSON.stringify(audit).includes("argon2-secret-hash"), false);
    assert.equal(JSON.stringify(audit).includes(HASH_SALT), false);
    assert.equal(JSON.stringify(result).includes("passwordHash"), false);
    assert.equal(JSON.stringify(result).includes("rowDigests"), false);
    assert.equal(JSON.stringify(result).includes(HASH_SALT), false);
    const jsonWrites = Object.fromEntries(
      writeTx.calls
        .filter((call) => call.operation === "createMany")
        .map((call) => [call.delegate, call.data])
    );
    assert.equal(
      Object.hasOwn(jsonWrites.customerESignProviderAccount[0], "providerSnapshot"),
      false
    );
    assert.equal(Object.hasOwn(jsonWrites.notificationTemplate[0], "variables"), false);
    assert.deepEqual(jsonWrites.notificationTemplate[0].providerConfig, { provider: "test" });
    assert.equal(Object.hasOwn(jsonWrites.assetOwner[0], "onboardingSnapshot"), false);
    assert.equal(Object.hasOwn(jsonWrites.vehicleListingProfile[0], "sellingPoints"), false);
    assert.deepEqual(jsonWrites.vehicleListingProfile[0].serviceHighlights, { roadside: true });
    assert.equal(Object.hasOwn(jsonWrites.vehicleInsurancePolicy[0], "snapshot"), false);
    assert.deepEqual(jsonWrites.vehicleOwnershipPeriod[0].startSnapshot, { ownerId: OWNER_ID });
    assert.equal(Object.hasOwn(jsonWrites.vehicleOwnershipPeriod[0], "endSnapshot"), false);
    assert.equal(Object.hasOwn(jsonWrites.vehicleAssetCostProfile[0], "snapshot"), false);
    assert.equal(Object.hasOwn(jsonWrites.vehicleCostLedgerEntry[0], "assetOwnerSnapshot"), false);
    assert.equal(Object.hasOwn(jsonWrites.vehicleCostLedgerEntry[0], "evidenceSnapshot"), false);
    assert.deepEqual(jsonWrites.vehicleCostLedgerEntry[0].responsibilitySnapshot, {
      party: "PLATFORM"
    });
    assert.deepEqual(result, {
      auditCreated: 1,
      deleted: 0,
      inserted: Object.values(dry.manifest.counts).reduce((sum, value) => sum + value, 0),
      manifestSha256: dry.manifestSha256,
      mode: "apply",
      safe: true,
      updated: 0
    });
  } finally {
    restoreEnv(previous);
  }
});

test("replay proves the approved target without any writer or repair call", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await executeStage1CleanAcceptanceBaseline({
      ...baseOptions("apply", source, target),
      approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    });
    const writesBefore = target.calls.filter(isWrite).length;
    const replay = await executeStage1CleanAcceptanceBaseline({
      ...baseOptions("replay", source, target),
      approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    });
    assert.deepEqual(replay, {
      auditCreated: 0,
      deleted: 0,
      inserted: 0,
      manifestSha256: dry.manifestSha256,
      mode: "replay",
      safe: true,
      updated: 0
    });
    assert.equal(target.calls.filter(isWrite).length, writesBefore);

    target.rows.user[0].name = "tampered";
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("replay", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      }),
      (error) => error?.message === "MANIFEST_STALE"
    );
    assert.equal(
      target.calls.some((call) => ["update", "upsert", "delete"].includes(call.operation)),
      false
    );
  } finally {
    restoreEnv(previous);
  }
});

test("target-only validation proves per-table rows, fingerprints, forbidden domains, and the exact audit", async () => {
  const metadata = {
    migrationRows: [
      {
        id: "migration-1",
        checksum: "a".repeat(64),
        migrationName: "20260830000000_acceptance",
        startedAt: new Date(0),
        finishedAt: new Date(1),
        rolledBackAt: null,
        appliedStepsCount: 1
      }
    ],
    schemaRows: [TEST_SCHEMA_ROW]
  };
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {}, metadata);
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await executeStage1CleanAcceptanceBaseline({
      ...baseOptions("apply", source, target),
      approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    });
    const sourceCallsBefore = source.calls.length;
    const result = await target.client.$transaction(
      (tx) =>
        validateStage1CleanAcceptanceTargetBaseline(tx, {
          approvedManifest: dry.manifest,
          approvedManifestSha256: dry.manifestSha256,
          canonicalMetadata: TEST_CANONICAL_METADATA
        }),
      { isolationLevel: "RepeatableRead" }
    );
    assert.equal(result.safe, true);
    assert.equal(result.manifestSha256, dry.manifestSha256);
    assert.deepEqual(result.counts, dry.manifest.counts);
    assert.deepEqual(Object.keys(result.target).sort(), [
      "databaseDigest",
      "migrationCatalogDigest",
      "schemaDigest"
    ]);
    assert.equal(JSON.stringify(result).includes(HASH_SALT), false);
    assert.equal(JSON.stringify(result).includes(VEHICLE_ID), false);
    assert.equal(source.calls.length, sourceCallsBefore);

    const mutations = [
      (rows) => rows.menu.push({ ...structuredClone(rows.menu[0]), id: "extra-menu" }),
      (rows) => {
        rows.permission.pop();
        rows.menu.push({ ...structuredClone(rows.menu[0]), id: "replacement-menu" });
      },
      (rows) => {
        rows.application = [{ id: "forbidden" }];
      },
      (rows) => {
        rows.auditLog[0].afterSnapshot.summary = "tampered";
      },
      (_rows, currentMetadata) =>
        currentMetadata.migrationRows.push({
          ...currentMetadata.migrationRows[0],
          id: "migration-2",
          migrationName: "0002"
        }),
      (_rows, currentMetadata) =>
        currentMetadata.schemaRows.push({
          ...currentMetadata.schemaRows[0],
          columnName: "tampered",
          ordinalPosition: 2
        })
    ];
    for (const mutate of mutations) {
      const caseMetadata = structuredClone(metadata);
      const caseSource = createDatabaseFake("subscription_saas_staging", sourceRows());
      const caseTarget = createDatabaseFake(
        "subscription_saas_staging_acceptance_test",
        {},
        caseMetadata
      );
      const caseDry = await executeStage1CleanAcceptanceBaseline(
        baseOptions("dry-run", caseSource, caseTarget)
      );
      await executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", caseSource, caseTarget),
        approvedManifest: caseDry.manifest,
        approvedManifestSha256: caseDry.manifestSha256
      });
      mutate(caseTarget.rows, caseMetadata);
      await assert.rejects(
        caseTarget.client.$transaction((tx) =>
          validateStage1CleanAcceptanceTargetBaseline(tx, {
            approvedManifest: caseDry.manifest,
            approvedManifestSha256: caseDry.manifestSha256,
            canonicalMetadata: TEST_CANONICAL_METADATA
          })
        ),
        (error) => error?.message === "MANIFEST_STALE"
      );
    }
  } finally {
    restoreEnv(previous);
  }
});

test("replay rejects any one-field mutation of the unique baseline audit contract", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await executeStage1CleanAcceptanceBaseline({
      ...baseOptions("apply", source, target),
      approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    });
    const pristine = structuredClone(target.rows.auditLog[0]);
    const mutations = [
      (row) => (row.module = "other"),
      (row) => (row.entityType = "other"),
      (row) => (row.action = "UPDATE"),
      (row) => (row.entityId = "11111111-1111-4111-8111-111111111111"),
      (row) => (row.operatorId = "22222222-2222-4222-8222-222222222222"),
      (row) => (row.ipAddress = "127.0.0.1"),
      (row) => (row.userAgent = "tampered"),
      (row) => (row.beforeSnapshot = {}),
      (row) => (row.afterSnapshot.counts = { ...row.afterSnapshot.counts, access: 999 }),
      (row) => (row.afterSnapshot.gitSha = "f".repeat(40)),
      (row) => (row.afterSnapshot.imageRef = `other@sha256:${"f".repeat(64)}`),
      (row) => (row.afterSnapshot.manifestSha256 = "0".repeat(64)),
      (row) => (row.afterSnapshot.summary = "other"),
      (row) => (row.afterSnapshot.extra = true),
      (row) => delete row.afterSnapshot.counts
    ];
    for (const mutate of mutations) {
      target.rows.auditLog[0] = structuredClone(pristine);
      mutate(target.rows.auditLog[0]);
      await assert.rejects(
        executeStage1CleanAcceptanceBaseline({
          ...baseOptions("replay", source, target),
          approvedManifest: dry.manifest,
          approvedManifestSha256: dry.manifestSha256
        }),
        (error) => error?.message === "MANIFEST_STALE"
      );
    }
    target.rows.auditLog[0] = pristine;
  } finally {
    restoreEnv(previous);
  }
});

test("required ownership and cost-ledger JSON rejects null or undefined and rolls back the target transaction", async () => {
  const cases = [
    ["vehicleOwnershipPeriod", "startSnapshot", null],
    ["vehicleOwnershipPeriod", "startSnapshot", undefined],
    ["vehicleCostLedgerEntry", "responsibilitySnapshot", null],
    ["vehicleCostLedgerEntry", "responsibilitySnapshot", undefined]
  ];
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    for (const [delegate, field, value] of cases) {
      const rows = sourceRows();
      rows[delegate][0][field] = value;
      const source = createDatabaseFake("subscription_saas_staging", rows);
      const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
      const dry = await executeStage1CleanAcceptanceBaseline(
        baseOptions("dry-run", source, target)
      );
      assert.equal(dry.safe, true);
      await assert.rejects(
        executeStage1CleanAcceptanceBaseline({
          ...baseOptions("apply", source, target),
          approvedManifest: dry.manifest,
          approvedManifestSha256: dry.manifestSha256
        }),
        (error) => error?.message === "MANIFEST_CLASSIFICATION_INVALID"
      );
      const writeTx = target.transactions.find((entry) => entry.isolationLevel === "Serializable");
      assert.ok(writeTx);
      assert.match(writeTx.calls[0].sql, /pg_advisory_xact_lock/);
      const expectedPrecedingDelegate =
        delegate === "vehicleOwnershipPeriod"
          ? "vehicleSalePriceHistory"
          : "vehicleAssetCostProfile";
      assert.ok(
        writeTx.calls.some(
          (call) => call.operation === "createMany" && call.delegate === expectedPrecedingDelegate
        )
      );
      assert.equal(
        writeTx.calls.some((call) => call.delegate === "auditLog" && isWrite(call)),
        false
      );
      assert.deepEqual(target.rows, {});
    }
  } finally {
    restoreEnv(previous);
  }
});

test("the fake rejects a reversal that changes trigger-protected accounting facts", async () => {
  const rows = sourceRows();
  rows.vehicleCostLedgerEntry[1].customerId = null;
  rows.vehicleCostLedgerEntry[1].actionType = "WRITE_OFF";
  rows.vehicleCostLedgerEntry[1].assetOwnerSnapshot = { ownerNo: "CHANGED" };
  const source = createDatabaseFake("subscription_saas_staging", rows);
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {});
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  assert.equal(dry.safe, true);
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      }),
      (error) => error?.message === "STAGE1_ACCEPTANCE_ERROR"
    );
    assert.deepEqual(target.rows, {});
  } finally {
    restoreEnv(previous);
  }
});

test("an intermediate createMany failure rolls back all rows and the audit", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake(
    "subscription_saas_staging_acceptance_test",
    {},
    { failCreateMany: "vehicleDocument" }
  );
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      }),
      (error) => error?.message === "STAGE1_ACCEPTANCE_ERROR"
    );
    assert.deepEqual(target.rows, {});
  } finally {
    restoreEnv(previous);
  }
});

test("concurrent apply attempts are serialized by the transaction advisory lock", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake(
    "subscription_saas_staging_acceptance_test",
    {},
    { serializeTransactions: true }
  );
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    const options = {
      ...baseOptions("apply", source, target),
      approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    };
    const settled = await Promise.allSettled([
      executeStage1CleanAcceptanceBaseline(options),
      executeStage1CleanAcceptanceBaseline(options)
    ]);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(
      settled.find((entry) => entry.status === "rejected").reason.message,
      "MANIFEST_STALE"
    );
    assert.equal(target.rows.auditLog.length, 1);
  } finally {
    restoreEnv(previous);
  }
});

test("apply turns an old-snapshot serialization outcome into MANIFEST_STALE after fresh exact validation", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake(
    "subscription_saas_staging_acceptance_test",
    {},
    {
      serializableFailures: [{ code: "40001", publishWorkingAsCompetitor: true }]
    }
  );
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      }),
      (error) => error?.message === "MANIFEST_STALE"
    );
    const serializable = target.transactions.filter(
      ({ isolationLevel }) => isolationLevel === "Serializable"
    );
    assert.equal(serializable.length, 1);
    assert.match(serializable[0].calls[0].sql, /pg_advisory_xact_lock/);
    assert.equal(target.rows.auditLog.length, 1);
    assert.ok(
      target.transactions.some(
        ({ isolationLevel, calls }) =>
          isolationLevel === "RepeatableRead" && /^SET TRANSACTION READ ONLY$/.test(calls[0]?.sql)
      )
    );
  } finally {
    restoreEnv(previous);
  }
});

test("apply retries serialization failures in fresh locked transactions and succeeds", async () => {
  for (const code of ["40001", "P2034"]) {
    const source = createDatabaseFake("subscription_saas_staging", sourceRows());
    const target = createDatabaseFake(
      "subscription_saas_staging_acceptance_test",
      {},
      {
        serializableFailures: [{ code }]
      }
    );
    const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
    const previous = process.env[APPLY_ENV];
    process.env[APPLY_ENV] = "1";
    try {
      const result = await executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      });
      assert.equal(result.safe, true);
      const serializable = target.transactions.filter(
        ({ isolationLevel }) => isolationLevel === "Serializable"
      );
      assert.equal(serializable.length, 2);
      assert.ok(serializable.every(({ calls }) => /pg_advisory_xact_lock/.test(calls[0]?.sql)));
      assert.equal(target.rows.auditLog.length, 1);
    } finally {
      restoreEnv(previous);
    }
  }
});

test("apply never treats a non-approved unique violation as success", async () => {
  for (const code of ["23505", "P2002"]) {
    const source = createDatabaseFake("subscription_saas_staging", sourceRows());
    const target = createDatabaseFake(
      "subscription_saas_staging_acceptance_test",
      {},
      {
        serializableFailures: [{ code }]
      }
    );
    const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
    const previous = process.env[APPLY_ENV];
    process.env[APPLY_ENV] = "1";
    try {
      await assert.rejects(
        executeStage1CleanAcceptanceBaseline({
          ...baseOptions("apply", source, target),
          approvedManifest: dry.manifest,
          approvedManifestSha256: dry.manifestSha256
        }),
        (error) => error?.message === "STAGE1_ACCEPTANCE_ERROR"
      );
      assert.equal(
        target.transactions.filter(({ isolationLevel }) => isolationLevel === "Serializable")
          .length,
        1
      );
      assert.deepEqual(target.rows, {});
    } finally {
      restoreEnv(previous);
    }
  }
});

test("apply bounds serialization recovery to three fresh transactions", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake(
    "subscription_saas_staging_acceptance_test",
    {},
    {
      serializableFailures: [{ code: "40001" }, { code: "40001" }, { code: "40001" }]
    }
  );
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("apply", source, target),
        approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      }),
      (error) => error?.message === "STAGE1_ACCEPTANCE_ERROR"
    );
    const serializable = target.transactions.filter(
      ({ isolationLevel }) => isolationLevel === "Serializable"
    );
    assert.equal(serializable.length, 3);
    assert.ok(serializable.every(({ calls }) => /pg_advisory_xact_lock/.test(calls[0]?.sql)));
    assert.deepEqual(target.rows, {});
  } finally {
    restoreEnv(previous);
  }
});

function baseOptions(mode, source, target) {
  return {
    canonicalMetadata: TEST_CANONICAL_METADATA,
    generatedAt: GENERATED_AT,
    gitSha: GIT_SHA,
    hashSalt: HASH_SALT,
    imageRef: IMAGE_REF,
    mode,
    selection: {
      adminUsername: "keqi_119",
      customerPhone: "18616570212",
      vehicleIds: [VEHICLE_ID]
    },
    sourcePrisma: source.client,
    targetPrisma: target.client
  };
}

function sourceRows() {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const model = { id: "model-1", deletedAt: null, enabled: true, portalVisible: true };
  const rows = {
    permission: [{ id: "permission-1", code: "stage1:read", status: "ACTIVE", deletedAt: null }],
    menu: [{ id: "menu-1", code: "stage1", parentId: null, status: "ACTIVE", deletedAt: null }],
    role: [{ id: "role-1", code: "ADMIN", status: "ACTIVE", deletedAt: null }],
    rolePermission: [
      { id: "role-permission-1", roleId: "role-1", permissionId: "permission-1", deletedAt: null }
    ],
    roleMenu: [{ id: "role-menu-1", roleId: "role-1", menuId: "menu-1", deletedAt: null }],
    user: [
      {
        id: ADMIN_ID,
        username: "keqi_119",
        name: "Admin",
        passwordHash: "argon2-secret-hash",
        status: "ACTIVE",
        createdAt: at,
        updatedAt: at,
        deletedAt: null
      }
    ],
    userRole: [{ id: "user-role-1", userId: ADMIN_ID, roleId: "role-1", deletedAt: null }],
    customer: [
      {
        id: CUSTOMER_ID,
        customerNo: "C1",
        name: "Customer",
        mobile: "18616570212",
        ownerUserId: ADMIN_ID,
        status: "ACTIVE",
        deletedAt: null
      }
    ],
    customerAccount: [
      {
        id: "account-1",
        customerId: CUSTOMER_ID,
        phone: "18616570212",
        accountStatus: "ACTIVE",
        deletedAt: null
      }
    ],
    customerIdentity: [{ id: "identity-1", customerId: CUSTOMER_ID, deletedAt: null }],
    customerProfile: [{ id: "profile-1", customerId: CUSTOMER_ID, deletedAt: null }],
    customerESignProviderAccount: [
      {
        id: "esign-1",
        customerId: CUSTOMER_ID,
        providerOpenId: "open-1",
        providerSnapshot: null,
        registrationStatus: "REGISTERED",
        realNameStatus: "VERIFIED",
        certBindingStatus: "BOUND",
        deletedAt: null
      }
    ],
    depositRule: [
      {
        id: "deposit-1",
        grade: "A",
        status: "ACTIVE",
        effectiveFrom: at,
        effectiveTo: null,
        deletedAt: null
      }
    ],
    product: [
      {
        id: "product-1",
        productNo: "P1",
        productType: "SUBSCRIPTION",
        status: "ACTIVE",
        deletedAt: null
      }
    ],
    productVersion: [
      { id: "version-1", productId: "product-1", versionNo: "1", status: "ACTIVE", deletedAt: null }
    ],
    vehicleModelDefinition: [{ ...model, snapshot: null }],
    vehiclePackage: [
      {
        id: "vehicle-package-1",
        productId: "product-1",
        productVersionId: "version-1",
        modelDefinitionId: "model-1",
        status: "ACTIVE",
        deletedAt: null
      }
    ],
    vehiclePackageModelMember: [
      { id: "member-1", vehiclePackageId: "vehicle-package-1", modelDefinitionId: "model-1" }
    ],
    mileagePackage: [
      {
        id: "mileage-1",
        productId: "product-1",
        productVersionId: "version-1",
        status: "ACTIVE",
        deletedAt: null
      }
    ],
    energyPackage: [
      {
        id: "energy-1",
        productId: "product-1",
        productVersionId: "version-1",
        status: "ACTIVE",
        deletedAt: null
      }
    ],
    benefitPackage: [
      {
        id: "benefit-1",
        productId: "product-1",
        productVersionId: "version-1",
        status: "ACTIVE",
        deletedAt: null
      }
    ],
    subscriptionPlan: [
      {
        id: "plan-1",
        productId: "product-1",
        productVersionId: "version-1",
        vehiclePackageId: "vehicle-package-1",
        mileagePackageId: "mileage-1",
        energyPackageId: "energy-1",
        benefitPackageId: "benefit-1",
        status: "ACTIVE",
        effectiveFrom: at,
        effectiveTo: null,
        deletedAt: null
      }
    ],
    productPriceRule: [
      {
        id: "price-1",
        productVersionId: "version-1",
        modelDefinitionId: "model-1",
        status: "ACTIVE",
        deletedAt: null
      }
    ],
    fileObject: ["SUBSCRIPTION_STANDARD", "DELIVERY_HANDOVER", "SUBSCRIPTION_EXTENSION"].map(
      (type, index) => ({
        id: `file-${index}`,
        bucket: "contracts",
        objectKey: `${type}.pdf`,
        originalName: `${type}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10n,
        contentSha256: "a".repeat(64),
        uploadedBy: ADMIN_ID,
        createdAt: at
      })
    ),
    contractVersion: ["SUBSCRIPTION_STANDARD", "DELIVERY_HANDOVER", "SUBSCRIPTION_EXTENSION"].map(
      (type, index) => ({
        id: `contract-version-${index}`,
        templateType: type,
        templateName: type,
        businessType: "SUBSCRIPTION",
        fileId: `file-${index}`,
        approvedBy: ADMIN_ID,
        approvedAt: at,
        effectiveFrom: at,
        effectiveTo: null,
        status: "ACTIVE",
        deletedAt: null
      })
    ),
    notificationTemplate: NOTIFICATION_CODES.map((code, index) => ({
      id: `notification-${index}`,
      templateCode: code,
      templateStatus: "ACTIVE",
      variables: null,
      providerConfig: index === 0 ? { provider: "test" } : null,
      deletedAt: null
    })),
    assetOwner: [
      {
        id: OWNER_ID,
        ownerNo: "OWNER-1",
        status: "ACTIVE",
        onboardingSnapshot: null,
        createdBy: ADMIN_ID,
        updatedBy: ADMIN_ID
      }
    ],
    vehicle: [
      {
        id: VEHICLE_ID,
        vehicleNo: "VEH-1",
        modelDefinitionId: "model-1",
        currentSalePriceAmount: 100000n,
        salePriceStatus: "EFFECTIVE",
        status: "AVAILABLE",
        createdAt: at,
        updatedAt: at,
        deletedAt: null
      }
    ],
    vehicleListingProfile: [
      {
        id: "listing-1",
        vehicleId: VEHICLE_ID,
        listingStatus: "PUBLISHED",
        portalVisible: true,
        sellingPoints: null,
        customerTags: null,
        serviceHighlights: { roadside: true },
        faqSnapshot: null,
        deletedAt: null
      }
    ],
    vehicleListingMedia: [
      { id: "media-1", vehicleId: VEHICLE_ID, listingProfileId: "listing-1", deletedAt: null }
    ],
    vehicleListingPlan: [
      {
        id: "listing-plan-1",
        vehicleId: VEHICLE_ID,
        listingProfileId: "listing-1",
        subscriptionPlanId: "plan-1",
        deletedAt: null
      }
    ],
    vehicleDocumentBatch: [{ id: "batch-1", vehicleId: VEHICLE_ID }],
    vehicleInsurancePolicy: [
      { id: "policy-1", vehicleId: VEHICLE_ID, snapshot: null, deletedAt: null }
    ],
    vehicleDocument: [
      {
        id: "document-1",
        vehicleId: VEHICLE_ID,
        batchId: "batch-1",
        policyId: "policy-1",
        deletedAt: null
      }
    ],
    vehicleInsuranceCoverage: [{ id: "coverage-1", policyId: "policy-1", deletedAt: null }],
    vehicleListingSourceBinding: [
      { id: "binding-1", vehicleId: VEHICLE_ID, documentId: "document-1" }
    ],
    vehicleSalePriceHistory: [{ id: "sale-1", vehicleId: VEHICLE_ID }],
    vehicleOwnershipPeriod: [
      {
        id: "ownership-1",
        vehicleId: VEHICLE_ID,
        assetOwnerId: OWNER_ID,
        startedAt: at,
        endedAt: null,
        startReason: "INITIAL_ACQUISITION",
        endReason: null,
        startSourceType: "BASELINE",
        startSourceId: VEHICLE_ID,
        startSourceKey: "ownership:start",
        endSourceType: null,
        endSourceId: null,
        endSourceKey: null,
        startSnapshot: { ownerId: OWNER_ID },
        endSnapshot: null,
        startConfirmedBy: ADMIN_ID,
        startConfirmedAt: at,
        endConfirmedBy: null,
        endConfirmedAt: null,
        createdAt: at,
        updatedAt: at,
        createdBy: ADMIN_ID
      }
    ],
    vehicleAssetCostProfile: [
      {
        id: COST_PROFILE_ID,
        vehicleId: VEHICLE_ID,
        profileStatus: "ACTIVE",
        depreciationMethod: "STRAIGHT_LINE",
        depreciationStartDate: at,
        usefulLifeMonths: 60,
        residualValueAmount: 10000n,
        capitalCostRateBps: null,
        annualInsuranceCostAmount: null,
        annualMaintenanceReserveAmount: null,
        otherMonthlyCostAmount: null,
        remark: null,
        snapshot: null,
        createdAt: at,
        updatedAt: at,
        createdBy: null,
        updatedBy: null,
        deletedAt: null
      }
    ],
    vehicleCostLedgerEntry: [
      {
        id: LEDGER_ID_1,
        vehicleId: VEHICLE_ID,
        orderId: null,
        contractId: null,
        customerId: CUSTOMER_ID,
        assetOwnerId: OWNER_ID,
        workOrderId: null,
        evidenceId: null,
        assetOwnerSnapshot: null,
        evidenceSnapshot: null,
        responsibilitySnapshot: { party: "PLATFORM" },
        entryKind: "ORIGINAL",
        actionType: "ACTUAL_COST",
        costCategory: "OTHER",
        amountCents: 10000n,
        responsiblePartyType: "PLATFORM",
        responsiblePartyId: null,
        occurredOn: at,
        accountingPeriod: "2026-01",
        confirmedAt: at,
        confirmedBy: ADMIN_ID,
        reversalOfEntryId: null,
        sourceType: "BASELINE",
        sourceId: VEHICLE_ID,
        sourceKey: "cost:original",
        createdAt: at
      },
      {
        id: LEDGER_ID_2,
        vehicleId: VEHICLE_ID,
        orderId: null,
        contractId: null,
        customerId: CUSTOMER_ID,
        assetOwnerId: OWNER_ID,
        workOrderId: null,
        evidenceId: null,
        assetOwnerSnapshot: null,
        evidenceSnapshot: null,
        responsibilitySnapshot: { party: "PLATFORM" },
        entryKind: "REVERSAL",
        actionType: "ACTUAL_COST",
        costCategory: "OTHER",
        amountCents: -10000n,
        responsiblePartyType: "PLATFORM",
        responsiblePartyId: null,
        occurredOn: at,
        accountingPeriod: "2026-01",
        confirmedAt: at,
        confirmedBy: ADMIN_ID,
        reversalOfEntryId: LEDGER_ID_1,
        sourceType: "BASELINE",
        sourceId: VEHICLE_ID,
        sourceKey: "cost:reversal",
        createdAt: at
      }
    ]
  };
  return rows;
}

function createDatabaseFake(databaseName, initialRows, options = {}) {
  const state = { rows: structuredClone(initialRows) };
  const calls = [];
  const transactions = [];
  let queue = Promise.resolve();
  let serializableAttempt = 0;

  const client = createClient(() => state.rows, calls, options);
  client.$transaction = async (callback, transactionOptions = {}) => {
    const run = async () => {
      const working = structuredClone(state.rows);
      const txCalls = [];
      const tx = createClient(() => working, txCalls, options);
      tx.__databaseName = databaseName;
      const record = { calls: txCalls, isolationLevel: transactionOptions.isolationLevel };
      transactions.push(record);
      try {
        const value = await callback(tx);
        if (transactionOptions.isolationLevel === "Serializable") {
          const failure = options.serializableFailures?.[serializableAttempt];
          serializableAttempt += 1;
          if (failure) {
            if (failure.publishWorkingAsCompetitor) state.rows = working;
            const error = new Error(`injected database outcome ${failure.code}`);
            error.code = failure.code;
            throw error;
          }
        }
        state.rows = working;
        return value;
      } catch (error) {
        throw error;
      } finally {
        calls.push(...txCalls);
      }
    };
    if (!options.serializeTransactions || transactionOptions.isolationLevel !== "Serializable")
      return run();
    const pending = queue.then(run, run);
    queue = pending.catch(() => undefined);
    return pending;
  };
  client.__databaseName = databaseName;

  return {
    calls,
    client,
    get rows() {
      return state.rows;
    },
    transactions
  };
}

function createClient(getRows, calls, options) {
  const own = {
    async $queryRaw(strings, ...values) {
      const sql = strings.raw ? strings.raw.join("?") : strings.join("?");
      calls.push({ operation: "$queryRaw", sql, values: structuredClone(values) });
      if (/current_database/i.test(sql)) return [{ databaseName: this.__databaseName }];
      if (/_prisma_migrations/i.test(sql))
        return structuredClone(
          options.migrationRows ?? [
            {
              id: "migration-1",
              checksum: "a".repeat(64),
              migrationName: "20260830000000_acceptance",
              startedAt: new Date(0),
              finishedAt: new Date(1),
              rolledBackAt: null,
              appliedStepsCount: 1
            }
          ]
        );
      if (/information_schema\.columns/i.test(sql))
        return structuredClone(options.schemaRows ?? [TEST_SCHEMA_ROW]);
      return [];
    },
    async $executeRaw() {
      calls.push({ operation: "$executeRaw" });
      throw new Error("write raw is forbidden");
    }
  };
  return new Proxy(own, {
    get(target, property, receiver) {
      if (Reflect.has(target, property) || typeof property !== "string")
        return Reflect.get(target, property, receiver);
      return {
        async count() {
          calls.push({ delegate: property, operation: "count" });
          return { _all: (getRows()[property] ?? []).length };
        },
        async findMany(args = {}) {
          calls.push({ args, delegate: property, operation: "findMany" });
          const rows = structuredClone(getRows()[property] ?? []);
          if (property === "vehicle" && args.select?._count) {
            return rows.map((row) => ({
              id: row.id,
              status: row.status,
              salePriceStatus: row.salePriceStatus,
              currentSalePriceAmount: row.currentSalePriceAmount,
              _count: {
                assetWorkOrders: 0,
                deliveries: 0,
                operationalRestrictions: 0,
                orders: 0,
                returns: 0,
                serviceCases: 0,
                subscriptionPeriods: 0
              }
            }));
          }
          if (
            property === "vehicle" &&
            Object.keys(args.select ?? {}).length === 1 &&
            args.select?.id
          ) {
            return rows.map(({ id }) => ({ id }));
          }
          return rows;
        },
        async createMany({ data }) {
          calls.push({ data: structuredClone(data), delegate: property, operation: "createMany" });
          if (options.failCreateMany === property) throw new Error(`injected ${property} failure`);
          for (const row of data) validateFakeCreateInput(property, row, getRows(), data);
          getRows()[property] = [
            ...(getRows()[property] ?? []),
            ...data.map((row) => normalizeFakeStoredRow(property, row))
          ];
          return { count: data.length };
        },
        async create({ data }) {
          calls.push({ data: structuredClone(data), delegate: property, operation: "create" });
          if (property === "auditLog" && Object.hasOwn(data, "beforeSnapshot")) {
            throw new TypeError("AuditLog.beforeSnapshot must be omitted for database null");
          }
          const stored =
            property === "auditLog"
              ? {
                  entityId: null,
                  operatorId: null,
                  ipAddress: null,
                  userAgent: null,
                  beforeSnapshot: null,
                  ...structuredClone(data)
                }
              : structuredClone(data);
          getRows()[property] = [...(getRows()[property] ?? []), stored];
          return structuredClone(stored);
        },
        async update() {
          calls.push({ delegate: property, operation: "update" });
        },
        async upsert() {
          calls.push({ delegate: property, operation: "upsert" });
        },
        async delete() {
          calls.push({ delegate: property, operation: "delete" });
        }
      };
    }
  });
}

function validateFakeCreateInput(delegate, row, rows, batch) {
  const nullableJsonFields =
    {
      assetOwner: ["onboardingSnapshot"],
      customerESignProviderAccount: ["providerSnapshot"],
      notificationTemplate: ["variables", "providerConfig"],
      vehicleAssetCostProfile: ["snapshot"],
      vehicleCostLedgerEntry: ["assetOwnerSnapshot", "evidenceSnapshot"],
      vehicleInsurancePolicy: ["snapshot"],
      vehicleListingProfile: ["sellingPoints", "customerTags", "serviceHighlights", "faqSnapshot"],
      vehicleModelDefinition: ["snapshot"],
      vehicleOwnershipPeriod: ["endSnapshot"]
    }[delegate] ?? [];
  for (const field of nullableJsonFields) {
    if (Object.hasOwn(row, field) && row[field] === null) {
      throw new TypeError(`${delegate}.${field} top-level null is not a Prisma JSON create input`);
    }
  }
  const requiredJsonFields =
    {
      vehicleCostLedgerEntry: ["responsibilitySnapshot"],
      vehicleOwnershipPeriod: ["startSnapshot"]
    }[delegate] ?? [];
  for (const field of requiredJsonFields) {
    if (row[field] === null || row[field] === undefined)
      throw new TypeError(`${delegate}.${field} is required`);
  }

  if (delegate === "vehicleAssetCostProfile") {
    requireNonEmptyString(row.depreciationMethod, `${delegate}.depreciationMethod`);
    requireDate(row.depreciationStartDate, `${delegate}.depreciationStartDate`);
    if (!Number.isInteger(row.usefulLifeMonths))
      throw new TypeError(`${delegate}.usefulLifeMonths is required`);
    if (typeof row.residualValueAmount !== "bigint")
      throw new TypeError(`${delegate}.residualValueAmount is required`);
  }
  if (delegate === "vehicleCostLedgerEntry") {
    for (const field of [
      "entryKind",
      "actionType",
      "costCategory",
      "responsiblePartyType",
      "accountingPeriod",
      "sourceType",
      "sourceId",
      "sourceKey"
    ]) {
      requireNonEmptyString(row[field], `${delegate}.${field}`);
    }
    if (typeof row.amountCents !== "bigint")
      throw new TypeError(`${delegate}.amountCents is required`);
    requireDate(row.occurredOn, `${delegate}.occurredOn`);
    requireDate(row.confirmedAt, `${delegate}.confirmedAt`);
    validateFakeReversalContract(row, rows, batch);
  }

  const has = (target, id) => (rows[target] ?? []).some((item) => item.id === id);
  const optional = (target, id) => id == null || has(target, id);
  if (delegate === "productVersion" && !optional("user", row.approvedBy))
    throw new Error("dangling ProductVersion.approvedBy");
  if (delegate === "contractVersion" && !optional("user", row.approvedBy))
    throw new Error("dangling ContractVersion.approvedBy");
  if (delegate === "vehicleListingSourceBinding" && !has("vehicleDocument", row.documentId))
    throw new Error("dangling binding document");
  if (delegate === "vehicleCostLedgerEntry") {
    const ledgerIds = new Set([
      ...(rows.vehicleCostLedgerEntry ?? []).map(({ id }) => id),
      ...batch.map(({ id }) => id)
    ]);
    if (
      !has("vehicle", row.vehicleId) ||
      !optional("customer", row.customerId) ||
      !optional("assetOwner", row.assetOwnerId) ||
      !has("user", row.confirmedBy) ||
      (row.reversalOfEntryId != null && !ledgerIds.has(row.reversalOfEntryId)) ||
      [row.orderId, row.contractId, row.workOrderId, row.evidenceId].some((value) => value != null)
    ) {
      throw new Error("dangling cost ledger endpoint");
    }
  }
}

function validateFakeReversalContract(row, rows, batch) {
  if (row.entryKind !== "REVERSAL") return;
  const candidates = [...(rows.vehicleCostLedgerEntry ?? []), ...batch];
  const original = candidates.find((item) => item.id === row.reversalOfEntryId);
  if (!original || original.entryKind === "REVERSAL") throw new Error("invalid reversal target");
  if (row.amountCents !== -original.amountCents) throw new Error("invalid reversal amount");
  const protectedFields = [
    "vehicleId",
    "orderId",
    "contractId",
    "customerId",
    "assetOwnerId",
    "workOrderId",
    "occurredOn",
    "accountingPeriod",
    "actionType",
    "costCategory",
    "responsiblePartyType",
    "responsiblePartyId",
    "assetOwnerSnapshot",
    "evidenceId",
    "evidenceSnapshot",
    "responsibilitySnapshot"
  ];
  if (protectedFields.some((field) => !isDeepStrictEqual(row[field], original[field]))) {
    throw new Error("reversal must preserve trigger-protected facts");
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} is required`);
}

function requireDate(value, field) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new TypeError(`${field} is required`);
}

function normalizeFakeStoredRow(delegate, row) {
  const stored = structuredClone(row);
  const nullableJsonFields =
    {
      assetOwner: ["onboardingSnapshot"],
      customerESignProviderAccount: ["providerSnapshot"],
      notificationTemplate: ["variables", "providerConfig"],
      vehicleAssetCostProfile: ["snapshot"],
      vehicleCostLedgerEntry: ["assetOwnerSnapshot", "evidenceSnapshot"],
      vehicleInsurancePolicy: ["snapshot"],
      vehicleListingProfile: ["sellingPoints", "customerTags", "serviceHighlights", "faqSnapshot"],
      vehicleModelDefinition: ["snapshot"],
      vehicleOwnershipPeriod: ["endSnapshot"]
    }[delegate] ?? [];
  for (const field of nullableJsonFields) {
    if (!Object.hasOwn(stored, field)) stored[field] = null;
  }
  return stored;
}

function isWrite(call) {
  return ["create", "createMany", "update", "upsert", "delete", "$executeRaw"].includes(
    call.operation
  );
}

function assertOrder(calls, expected) {
  const actual = calls.filter(isWrite).map((call) => call.delegate);
  assert.deepEqual(actual, expected);
}

function restoreEnv(value) {
  if (value === undefined) delete process.env[APPLY_ENV];
  else process.env[APPLY_ENV] = value;
}
