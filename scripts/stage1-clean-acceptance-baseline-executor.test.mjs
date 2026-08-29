import assert from "node:assert/strict";
import test from "node:test";

import {
  executeStage1CleanAcceptanceBaseline
} from "./stage1-clean-acceptance-baseline-executor.mjs";

const VEHICLE_ID = "11111111-1111-4111-8111-111111111111";
const GENERATED_AT = "2026-08-30T12:00:00.000Z";
const HASH_SALT = "1".repeat(64);
const GIT_SHA = "2".repeat(40);
const IMAGE_REF = `registry.example/api@sha256:${"3".repeat(64)}`;
const APPLY_ENV = "STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY";

const NOTIFICATION_CODES = [
  "APPLICATION_SUBMITTED_IN_APP", "APPLICATION_SUBMITTED_WECHAT",
  "AUTO_DEBIT_FAILURE_IN_APP", "AUTO_DEBIT_FAILURE_SMS", "AUTO_DEBIT_FAILURE_WECHAT",
  "CONTRACT_PENDING_IN_APP", "CONTRACT_PENDING_WECHAT",
  "FINAL_PLAN_READY_IN_APP", "FINAL_PLAN_READY_WECHAT",
  "HANDOVER_ESIGN_PENDING_IN_APP", "HANDOVER_ESIGN_PENDING_WECHAT",
  "MILEAGE_REVIEW_DUE_IN_APP", "MILEAGE_REVIEW_DUE_WECHAT",
  "PAYMENT_PENDING_IN_APP", "PAYMENT_PENDING_WECHAT",
  "SERVICE_CASE_UPDATE_IN_APP", "SERVICE_CASE_UPDATE_WECHAT"
];

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
    assert.equal(target.transactions.some((entry) => entry.isolationLevel === "Serializable"), false);
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
    assert.match(writeTx.calls[0].sql, /pg_advisory_xact_lock\(hashtext\('stage1-clean-acceptance-baseline:apply'\)\)/);
    assertOrder(writeTx.calls, [
      "permission", "menu", "role", "rolePermission", "roleMenu", "user", "userRole",
      "customer", "customerAccount", "customerIdentity", "customerProfile", "customerESignProviderAccount",
      "depositRule", "product", "productVersion", "vehicleModelDefinition",
      "vehiclePackage", "vehiclePackageModelMember", "mileagePackage", "energyPackage", "benefitPackage", "subscriptionPlan", "productPriceRule",
      "fileObject", "contractVersion", "notificationTemplate", "assetOwner", "vehicle",
      "vehicleListingProfile", "vehicleListingMedia", "vehicleListingPlan",
      "vehicleDocumentBatch", "vehicleInsurancePolicy", "vehicleDocument", "vehicleInsuranceCoverage",
      "vehicleListingSourceBinding", "vehicleSalePriceHistory", "vehicleOwnershipPeriod", "auditLog"
    ]);
    assert.equal(target.rows.user[0].id, "admin-user");
    assert.equal(target.rows.user[0].passwordHash, "argon2-secret-hash");
    assert.equal(target.rows.vehicle[0].createdAt.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(target.rows.auditLog.length, 1);
    const audit = target.rows.auditLog[0];
    assert.equal(audit.entityType, "stage1_acceptance_baseline");
    assert.equal(audit.action, "CREATE");
    assert.deepEqual(Object.keys(audit.afterSnapshot).sort(), ["counts", "gitSha", "imageRef", "manifestSha256", "summary"]);
    assert.equal(JSON.stringify(audit).includes("argon2-secret-hash"), false);
    assert.equal(JSON.stringify(audit).includes(HASH_SALT), false);
    assert.equal(JSON.stringify(result).includes("passwordHash"), false);
    assert.equal(JSON.stringify(result).includes("rowDigests"), false);
    assert.equal(JSON.stringify(result).includes(HASH_SALT), false);
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
      ...baseOptions("apply", source, target), approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    });
    const writesBefore = target.calls.filter(isWrite).length;
    const replay = await executeStage1CleanAcceptanceBaseline({
      ...baseOptions("replay", source, target), approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    });
    assert.deepEqual(replay, {
      auditCreated: 0, deleted: 0, inserted: 0,
      manifestSha256: dry.manifestSha256, mode: "replay", safe: true, updated: 0
    });
    assert.equal(target.calls.filter(isWrite).length, writesBefore);

    target.rows.user[0].name = "tampered";
    await assert.rejects(
      executeStage1CleanAcceptanceBaseline({
        ...baseOptions("replay", source, target), approvedManifest: dry.manifest,
        approvedManifestSha256: dry.manifestSha256
      }),
      (error) => error?.message === "MANIFEST_STALE"
    );
    assert.equal(target.calls.some((call) => ["update", "upsert", "delete"].includes(call.operation)), false);
  } finally {
    restoreEnv(previous);
  }
});

test("an intermediate createMany failure rolls back all rows and the audit", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {}, { failCreateMany: "vehicleDocument" });
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    await assert.rejects(executeStage1CleanAcceptanceBaseline({
      ...baseOptions("apply", source, target), approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    }), (error) => error?.message === "STAGE1_ACCEPTANCE_ERROR");
    assert.deepEqual(target.rows, {});
  } finally {
    restoreEnv(previous);
  }
});

test("concurrent apply attempts are serialized by the transaction advisory lock", async () => {
  const source = createDatabaseFake("subscription_saas_staging", sourceRows());
  const target = createDatabaseFake("subscription_saas_staging_acceptance_test", {}, { serializeTransactions: true });
  const dry = await executeStage1CleanAcceptanceBaseline(baseOptions("dry-run", source, target));
  const previous = process.env[APPLY_ENV];
  process.env[APPLY_ENV] = "1";
  try {
    const options = {
      ...baseOptions("apply", source, target), approvedManifest: dry.manifest,
      approvedManifestSha256: dry.manifestSha256
    };
    const settled = await Promise.allSettled([
      executeStage1CleanAcceptanceBaseline(options),
      executeStage1CleanAcceptanceBaseline(options)
    ]);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(settled.find((entry) => entry.status === "rejected").reason.message, "MANIFEST_STALE");
    assert.equal(target.rows.auditLog.length, 1);
  } finally {
    restoreEnv(previous);
  }
});

function baseOptions(mode, source, target) {
  return {
    generatedAt: GENERATED_AT,
    gitSha: GIT_SHA,
    hashSalt: HASH_SALT,
    imageRef: IMAGE_REF,
    mode,
    selection: { adminUsername: "keqi_119", customerPhone: "18616570212", vehicleIds: [VEHICLE_ID] },
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
    rolePermission: [{ id: "role-permission-1", roleId: "role-1", permissionId: "permission-1", deletedAt: null }],
    roleMenu: [{ id: "role-menu-1", roleId: "role-1", menuId: "menu-1", deletedAt: null }],
    user: [{ id: "admin-user", username: "keqi_119", name: "Admin", passwordHash: "argon2-secret-hash", status: "ACTIVE", createdAt: at, updatedAt: at, deletedAt: null }],
    userRole: [{ id: "user-role-1", userId: "admin-user", roleId: "role-1", deletedAt: null }],
    customer: [{ id: "customer-1", customerNo: "C1", name: "Customer", mobile: "18616570212", status: "ACTIVE", deletedAt: null }],
    customerAccount: [{ id: "account-1", customerId: "customer-1", phone: "18616570212", accountStatus: "ACTIVE", deletedAt: null }],
    customerIdentity: [{ id: "identity-1", customerId: "customer-1", deletedAt: null }],
    customerProfile: [{ id: "profile-1", customerId: "customer-1", deletedAt: null }],
    customerESignProviderAccount: [{ id: "esign-1", customerId: "customer-1", providerOpenId: "open-1", registrationStatus: "REGISTERED", realNameStatus: "VERIFIED", certBindingStatus: "BOUND", deletedAt: null }],
    depositRule: [{ id: "deposit-1", grade: "A", status: "ACTIVE", effectiveFrom: at, effectiveTo: null, deletedAt: null }],
    product: [{ id: "product-1", productNo: "P1", productType: "SUBSCRIPTION", status: "ACTIVE", deletedAt: null }],
    productVersion: [{ id: "version-1", productId: "product-1", versionNo: "1", status: "ACTIVE", deletedAt: null }],
    vehicleModelDefinition: [model],
    vehiclePackage: [{ id: "vehicle-package-1", productId: "product-1", productVersionId: "version-1", modelDefinitionId: "model-1", status: "ACTIVE", deletedAt: null }],
    vehiclePackageModelMember: [{ id: "member-1", vehiclePackageId: "vehicle-package-1", modelDefinitionId: "model-1" }],
    mileagePackage: [{ id: "mileage-1", productId: "product-1", productVersionId: "version-1", status: "ACTIVE", deletedAt: null }],
    energyPackage: [{ id: "energy-1", productId: "product-1", productVersionId: "version-1", status: "ACTIVE", deletedAt: null }],
    benefitPackage: [{ id: "benefit-1", productId: "product-1", productVersionId: "version-1", status: "ACTIVE", deletedAt: null }],
    subscriptionPlan: [{ id: "plan-1", productId: "product-1", productVersionId: "version-1", vehiclePackageId: "vehicle-package-1", mileagePackageId: "mileage-1", energyPackageId: "energy-1", benefitPackageId: "benefit-1", status: "ACTIVE", effectiveFrom: at, effectiveTo: null, deletedAt: null }],
    productPriceRule: [{ id: "price-1", productVersionId: "version-1", modelDefinitionId: "model-1", status: "ACTIVE", deletedAt: null }],
    fileObject: ["SUBSCRIPTION_STANDARD", "DELIVERY_HANDOVER", "SUBSCRIPTION_EXTENSION"].map((type, index) => ({ id: `file-${index}`, bucket: "contracts", objectKey: `${type}.pdf`, originalName: `${type}.pdf`, mimeType: "application/pdf", sizeBytes: 10n, contentSha256: "a".repeat(64), createdAt: at })),
    contractVersion: ["SUBSCRIPTION_STANDARD", "DELIVERY_HANDOVER", "SUBSCRIPTION_EXTENSION"].map((type, index) => ({ id: `contract-version-${index}`, templateType: type, templateName: type, businessType: "SUBSCRIPTION", fileId: `file-${index}`, approvedBy: "admin-user", approvedAt: at, effectiveFrom: at, effectiveTo: null, status: "ACTIVE", deletedAt: null })),
    notificationTemplate: NOTIFICATION_CODES.map((code, index) => ({ id: `notification-${index}`, templateCode: code, templateStatus: "ACTIVE", deletedAt: null })),
    assetOwner: [{ id: "owner-1", ownerNo: "OWNER-1", status: "ACTIVE" }],
    vehicle: [{ id: VEHICLE_ID, vehicleNo: "VEH-1", modelDefinitionId: "model-1", currentSalePriceAmount: 100000n, salePriceStatus: "EFFECTIVE", status: "AVAILABLE", createdAt: at, updatedAt: at, deletedAt: null }],
    vehicleListingProfile: [{ id: "listing-1", vehicleId: VEHICLE_ID, listingStatus: "PUBLISHED", portalVisible: true, deletedAt: null }],
    vehicleListingMedia: [{ id: "media-1", vehicleId: VEHICLE_ID, listingProfileId: "listing-1", deletedAt: null }],
    vehicleListingPlan: [{ id: "listing-plan-1", vehicleId: VEHICLE_ID, listingProfileId: "listing-1", subscriptionPlanId: "plan-1", deletedAt: null }],
    vehicleDocumentBatch: [{ id: "batch-1", vehicleId: VEHICLE_ID }],
    vehicleInsurancePolicy: [{ id: "policy-1", vehicleId: VEHICLE_ID, deletedAt: null }],
    vehicleDocument: [{ id: "document-1", vehicleId: VEHICLE_ID, batchId: "batch-1", policyId: "policy-1", deletedAt: null }],
    vehicleInsuranceCoverage: [{ id: "coverage-1", policyId: "policy-1", deletedAt: null }],
    vehicleListingSourceBinding: [{ id: "binding-1", vehicleId: VEHICLE_ID, documentId: "document-1" }],
    vehicleSalePriceHistory: [{ id: "sale-1", vehicleId: VEHICLE_ID }],
    vehicleOwnershipPeriod: [{ id: "ownership-1", vehicleId: VEHICLE_ID, assetOwnerId: "owner-1", endedAt: null }],
    vehicleAssetCostProfile: [], vehicleCostLedgerEntry: []
  };
  return rows;
}

function createDatabaseFake(databaseName, initialRows, options = {}) {
  const state = { rows: structuredClone(initialRows) };
  const calls = [];
  const transactions = [];
  let queue = Promise.resolve();

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
        state.rows = working;
        return value;
      } catch (error) {
        throw error;
      } finally {
        calls.push(...txCalls);
      }
    };
    if (!options.serializeTransactions || transactionOptions.isolationLevel !== "Serializable") return run();
    const pending = queue.then(run, run);
    queue = pending.catch(() => undefined);
    return pending;
  };
  client.__databaseName = databaseName;

  return {
    calls,
    client,
    get rows() { return state.rows; },
    transactions
  };
}

function createClient(getRows, calls, options) {
  const own = {
    async $queryRaw(strings) {
      const sql = strings.raw ? strings.raw.join("?") : strings.join("?");
      calls.push({ operation: "$queryRaw", sql });
      if (/current_database/i.test(sql)) return [{ databaseName: this.__databaseName }];
      if (/_prisma_migrations/i.test(sql)) return [{ id: "migration-1", checksum: "checksum", migrationName: "0001", startedAt: new Date(0), finishedAt: new Date(1), rolledBackAt: null, appliedStepsCount: 1 }];
      if (/information_schema\.columns/i.test(sql)) return [{ tableName: "user", columnName: "id", dataType: "uuid", isNullable: "NO", ordinalPosition: 1, columnDefault: null, udtName: "uuid" }];
      return [];
    },
    async $executeRaw() {
      calls.push({ operation: "$executeRaw" });
      throw new Error("write raw is forbidden");
    }
  };
  return new Proxy(own, {
    get(target, property, receiver) {
      if (Reflect.has(target, property) || typeof property !== "string") return Reflect.get(target, property, receiver);
      return {
        async count() {
          calls.push({ delegate: property, operation: "count" });
          return { _all: (getRows()[property] ?? []).length };
        },
        async findMany(args = {}) {
          calls.push({ args, delegate: property, operation: "findMany" });
          const rows = structuredClone(getRows()[property] ?? []);
          if (property === "vehicle" && args.select?._count) {
            return rows.map((row) => ({ id: row.id, status: row.status, salePriceStatus: row.salePriceStatus, currentSalePriceAmount: row.currentSalePriceAmount, _count: { operationalRestrictions: 0, subscriptionPeriods: 0 } }));
          }
          if (property === "vehicle" && Object.keys(args.select ?? {}).length === 1 && args.select?.id) {
            return rows.map(({ id }) => ({ id }));
          }
          return rows;
        },
        async createMany({ data }) {
          calls.push({ data: structuredClone(data), delegate: property, operation: "createMany" });
          if (options.failCreateMany === property) throw new Error(`injected ${property} failure`);
          getRows()[property] = [...(getRows()[property] ?? []), ...structuredClone(data)];
          return { count: data.length };
        },
        async create({ data }) {
          calls.push({ data: structuredClone(data), delegate: property, operation: "create" });
          getRows()[property] = [...(getRows()[property] ?? []), structuredClone(data)];
          return structuredClone(data);
        },
        async update() { calls.push({ delegate: property, operation: "update" }); },
        async upsert() { calls.push({ delegate: property, operation: "upsert" }); },
        async delete() { calls.push({ delegate: property, operation: "delete" }); }
      };
    }
  });
}

function isWrite(call) {
  return ["create", "createMany", "update", "upsert", "delete", "$executeRaw"].includes(call.operation);
}

function assertOrder(calls, expected) {
  const actual = calls.filter(isWrite).map((call) => call.delegate);
  assert.deepEqual(actual, expected);
}

function restoreEnv(value) {
  if (value === undefined) delete process.env[APPLY_ENV];
  else process.env[APPLY_ENV] = value;
}
