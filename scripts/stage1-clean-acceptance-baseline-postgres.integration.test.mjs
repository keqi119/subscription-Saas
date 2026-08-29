import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { classifyStage1CleanAcceptanceBaseline } from "./stage1-clean-acceptance-baseline-core.mjs";
import {
  applyStage1CleanAcceptanceBaseline,
  executeStage1CleanAcceptanceBaseline,
  validateStage1CleanAcceptanceTargetBaseline
} from "./stage1-clean-acceptance-baseline-executor.mjs";
import {
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  loadStage1CleanAcceptanceSourceSnapshot,
  loadStage1CleanAcceptanceTargetSnapshot
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";

const ADMIN_DATABASE_URL_ENV = "STAGE1_ACCEPTANCE_INTEGRATION_ADMIN_DATABASE_URL";
const DATABASE_NAME = /^subscription_saas_test_stage1_(source|target)_[a-f0-9]{32}$/;
const GENERATED_AT = "2026-08-30T12:00:00.000Z";
const GIT_SHA = "a".repeat(40);
const HASH_SALT = "b".repeat(64);
const IMAGE_REF = `registry.example/stage1-acceptance@sha256:${"c".repeat(64)}`;
const PASSWORD_HASH = "$2b$12$stage1.acceptance.fixture.hash";
const repoRoot = resolve(import.meta.dirname, "..");
const apiRoot = resolve(repoRoot, "apps/api");
const requireFromApi = createRequire(resolve(apiRoot, "package.json"));
const { Pool } = requireFromApi("pg");
const adminDatabaseUrl = process.env[ADMIN_DATABASE_URL_ENV]?.trim() || null;
const integrationTest = adminDatabaseUrl ? test : test.skip;

const IDS = Object.freeze({
  admin: uuid(1),
  role: uuid(2),
  permission: uuid(3),
  menu: uuid(4),
  userRole: uuid(5),
  rolePermission: uuid(6),
  roleMenu: uuid(7),
  customer: uuid(8),
  customerAccount: uuid(9),
  customerIdentity: uuid(10),
  customerProfile: uuid(11),
  customerESign: uuid(12),
  depositRule: uuid(13),
  product: uuid(14),
  productVersion: uuid(15),
  model: uuid(16),
  vehiclePackage: uuid(17),
  vehiclePackageMember: uuid(18),
  mileagePackage: uuid(19),
  energyPackage: uuid(20),
  benefitPackage: uuid(21),
  subscriptionPlan: uuid(22),
  priceRule: uuid(23),
  owner: uuid(24),
  vehicle: uuid(25),
  listingProfile: uuid(26),
  listingMedia: uuid(27),
  listingPlan: uuid(28),
  documentBatch: uuid(29),
  insurancePolicy: uuid(30),
  vehicleDocument: uuid(31),
  insuranceCoverage: uuid(32),
  sourceBinding: uuid(33),
  salePriceHistory: uuid(34),
  ownershipPeriod: uuid(35),
  costProfile: uuid(36),
  costOriginal: uuid(37),
  costReversal: uuid(38)
});

const NOTIFICATION_CODES = Object.freeze([
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
]);

test("PostgreSQL integration harness has no generic database URL fallback", () => {
  assert.equal(ADMIN_DATABASE_URL_ENV, "STAGE1_ACCEPTANCE_INTEGRATION_ADMIN_DATABASE_URL");
  if (!adminDatabaseUrl) assert.equal(integrationTest, test.skip);
});

test("disposable database names must match the exact source/target test prefixes", () => {
  for (const kind of ["source", "target"]) {
    assert.doesNotThrow(() =>
      assertDisposableDatabaseName(`subscription_saas_test_stage1_${kind}_${"a".repeat(32)}`)
    );
  }
  for (const unsafe of [
    "postgres",
    "subscription_saas_staging",
    "subscription_saas_test_stage1_source_abc",
    `subscription_saas_test_stage1_target_${"a".repeat(32)}_extra`
  ]) {
    assert.throws(() => assertDisposableDatabaseName(unsafe), /UNSAFE_INTEGRATION_DATABASE_NAME/);
  }
});

integrationTest(
  "real PostgreSQL proves migrations, rollback, stale guards, locking, replay, and validation",
  { timeout: 240_000 },
  async (t) => {
    try {
      const harness = await createPostgresHarness(adminDatabaseUrl);
      t.after(() => harness.close());
      await harness.migrateBoth();
      await harness.assertCanonicalMigrations();
      await harness.seedSource();

      const beforeDryRun = await harness.businessCounts();
      assertAllWhitelistDelegatesPresent(beforeDryRun.source);
      assertEmptyDatabaseCounts(beforeDryRun.target);
      const dryRun = await harness.execute("dry-run");
      assert.equal(dryRun.safe, true);
      assert.equal(dryRun.manifest.safeToApply, true);
      assert.match(dryRun.manifestSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(await harness.businessCounts(), beforeDryRun);

      await harness.mutateAndRestoreSourceFact(async () => {
        await assert.rejects(
          harness.execute("apply", dryRun),
          (error) => error?.message === "MANIFEST_STALE"
        );
        assertEmptyDatabaseCounts((await harness.businessCounts()).target);
      });
      await harness.assertForeignKeyRollback();
      assertEmptyDatabaseCounts((await harness.businessCounts()).target);

      const concurrent = await Promise.allSettled([
        harness.execute("apply", dryRun, 0),
        harness.execute("apply", dryRun, 1)
      ]);
      const fulfilled = concurrent.filter((result) => result.status === "fulfilled");
      const rejected = concurrent.filter((result) => result.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason?.message, "MANIFEST_STALE");
      assert.equal(fulfilled[0].value.auditCreated, 1);

      await harness.assertCopiedBaseline(dryRun);
      const beforeReplay = await harness.businessCounts();
      const replay = await harness.execute("replay", dryRun);
      assert.equal(replay.inserted, 0);
      assert.equal(replay.auditCreated, 0);
      assert.deepEqual(await harness.businessCounts(), beforeReplay);
      await harness.validateTarget(dryRun);

      await harness.withForbiddenRow(async () => {
        await assert.rejects(
          harness.execute("replay", dryRun),
          (error) => error?.message === "MANIFEST_STALE"
        );
        await assert.rejects(
          harness.validateTarget(dryRun),
          (error) => error?.message === "MANIFEST_STALE"
        );
      });
      await harness.validateTarget(dryRun);
    } catch (error) {
      throw new Error(safeIntegrationError(error));
    }
  }
);

async function createPostgresHarness(connectionString) {
  const adminPool = new Pool({ connectionString, max: 1 });
  let adminClient;
  try {
    adminClient = await adminPool.connect();
  } catch {
    await adminPool.end();
    throw new Error("INTEGRATION_ADMIN_CONNECTION_FAILED");
  }
  const createdDatabases = new Set();
  let closed = false;
  const suffix = randomUUID().replaceAll("-", "");
  const sourceName = `subscription_saas_test_stage1_source_${suffix}`;
  const targetName = `subscription_saas_test_stage1_target_${suffix}`;
  const sourceUrl = databaseUrlFor(connectionString, sourceName);
  const targetUrl = databaseUrlFor(connectionString, targetName);
  const clients = [];
  try {
    await createDatabase(sourceName);
    await createDatabase(targetName);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    assertCanonicalMigrations,
    assertCopiedBaseline,
    assertForeignKeyRollback,
    businessCounts,
    close: cleanup,
    execute,
    migrateBoth: async () => {
      deployMigrations(sourceUrl);
      deployMigrations(targetUrl);
      clients.push(
        await createPrismaClient(sourceUrl),
        await createPrismaClient(targetUrl),
        await createPrismaClient(sourceUrl),
        await createPrismaClient(targetUrl)
      );
    },
    mutateAndRestoreSourceFact,
    seedSource,
    validateTarget,
    withForbiddenRow
  };

  async function createDatabase(name) {
    assertDisposableDatabaseName(name);
    const existing = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      name
    ]);
    if (existing.rowCount !== 0) throw new Error("INTEGRATION_DATABASE_NAME_COLLISION");
    createdDatabases.add(name);
    await adminClient.query(`CREATE DATABASE ${quoteDatabaseName(name)}`);
  }

  async function cleanup() {
    if (closed) return;
    closed = true;
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
    let cleanupError;
    for (const name of [...createdDatabases].reverse()) {
      assertDisposableDatabaseName(name);
      try {
        const existing = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [
          name
        ]);
        if (existing.rowCount === 0) {
          createdDatabases.delete(name);
          continue;
        }
        await adminClient.query(`DROP DATABASE ${quoteDatabaseName(name)} WITH (FORCE)`);
        createdDatabases.delete(name);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    adminClient.release();
    await adminPool.end();
    if (cleanupError) throw new Error("INTEGRATION_DATABASE_CLEANUP_FAILED");
  }

  async function assertCanonicalMigrations() {
    const expected = canonicalMigrationCatalog();
    assert.equal(expected.length, 124);
    for (const prisma of [clients[0], clients[1]]) {
      const actual = await prisma.$queryRawUnsafe(`
        SELECT migration_name AS "migrationName", checksum, finished_at AS "finishedAt",
               rolled_back_at AS "rolledBackAt", applied_steps_count AS "appliedStepsCount"
        FROM "_prisma_migrations" ORDER BY migration_name ASC
      `);
      assert.equal(actual.length, expected.length);
      assert.deepEqual(
        actual.map(({ migrationName, checksum }) => ({ migrationName, checksum })),
        expected
      );
      assert.ok(actual.every((row) => row.finishedAt instanceof Date));
      assert.ok(actual.every((row) => row.rolledBackAt === null));
      assert.ok(actual.every((row) => row.appliedStepsCount === 1));
    }
  }

  async function seedSource() {
    const prisma = clients[0];
    const effectiveFrom = new Date("2026-01-01T00:00:00.000Z");
    const approvedAt = new Date("2026-08-01T00:00:00.000Z");
    const occurredOn = new Date("2026-08-15T00:00:00.000Z");
    const confirmedAt = new Date("2026-08-15T08:00:00.000Z");
    const responsibilitySnapshot = { authority: "fixture", responsiblePartyType: "CUSTOMER" };

    await prisma.permission.create({
      data: {
        id: IDS.permission,
        code: "acceptance:all",
        name: "Acceptance",
        module: "acceptance",
        action: "all"
      }
    });
    await prisma.menu.create({
      data: { id: IDS.menu, code: "acceptance", name: "Acceptance", path: "/acceptance" }
    });
    await prisma.role.create({ data: { id: IDS.role, code: "ADMIN", name: "Administrator" } });
    await prisma.user.create({
      data: {
        id: IDS.admin,
        username: "keqi_119",
        name: "Acceptance Admin",
        passwordHash: PASSWORD_HASH
      }
    });
    await prisma.rolePermission.create({
      data: { id: IDS.rolePermission, roleId: IDS.role, permissionId: IDS.permission }
    });
    await prisma.roleMenu.create({
      data: { id: IDS.roleMenu, roleId: IDS.role, menuId: IDS.menu }
    });
    await prisma.userRole.create({
      data: { id: IDS.userRole, userId: IDS.admin, roleId: IDS.role }
    });

    await prisma.customer.create({
      data: {
        id: IDS.customer,
        customerNo: "ACCEPTANCE-CUSTOMER",
        name: "Acceptance Customer",
        mobile: "18616570212",
        status: "ACTIVE",
        ownerUserId: IDS.admin
      }
    });
    await prisma.customerAccount.create({
      data: {
        id: IDS.customerAccount,
        customerId: IDS.customer,
        phone: "18616570212",
        accountStatus: "ACTIVE"
      }
    });
    await prisma.customerIdentity.create({
      data: {
        id: IDS.customerIdentity,
        customerId: IDS.customer,
        realnameVerified: true,
        verifiedAt: approvedAt
      }
    });
    await prisma.customerProfile.create({
      data: { id: IDS.customerProfile, customerId: IDS.customer, monthlyIncomeAmount: 2000000n }
    });
    await prisma.customerESignProviderAccount.create({
      data: {
        id: IDS.customerESign,
        customerId: IDS.customer,
        provider: "ESIGN",
        providerOpenId: "acceptance-provider-open-id",
        registrationStatus: "REGISTERED",
        realNameStatus: "VERIFIED",
        verifiedAt: approvedAt,
        certBindingStatus: "BOUND",
        certBoundAt: approvedAt
      }
    });

    await prisma.depositRule.create({
      data: {
        id: IDS.depositRule,
        grade: "A",
        depositAmount: 500000n,
        defaultRate: "0.100000",
        effectiveFrom
      }
    });
    await prisma.product.create({
      data: {
        id: IDS.product,
        productNo: "ACCEPTANCE-PRODUCT",
        name: "Acceptance Product",
        productType: "SUBSCRIPTION",
        status: "ACTIVE",
        description: "approved"
      }
    });
    await prisma.productVersion.create({
      data: {
        id: IDS.productVersion,
        productId: IDS.product,
        versionNo: "1",
        effectiveFrom,
        status: "ACTIVE",
        approvedBy: IDS.admin,
        approvedAt
      }
    });
    await prisma.vehicleModelDefinition.create({
      data: {
        id: IDS.model,
        modelCode: "ACCEPTANCE-MODEL",
        brand: "Acceptance",
        modelName: "Model",
        displayName: "Acceptance Model",
        enabled: true,
        portalVisible: true
      }
    });
    await prisma.vehiclePackage.create({
      data: {
        id: IDS.vehiclePackage,
        packageNo: "ACCEPTANCE-VEHICLE",
        packageName: "Acceptance Vehicle",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        modelDefinitionId: IDS.model,
        minPeriodMonths: 12,
        maxPeriodMonths: 36
      }
    });
    await prisma.vehiclePackageModelMember.create({
      data: {
        id: IDS.vehiclePackageMember,
        vehiclePackageId: IDS.vehiclePackage,
        modelDefinitionId: IDS.model
      }
    });
    await prisma.mileagePackage.create({
      data: {
        id: IDS.mileagePackage,
        packageNo: "ACCEPTANCE-MILEAGE",
        packageName: "Acceptance Mileage",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        monthlyMileageKm: 1500,
        overMileageFeeAmount: 100n
      }
    });
    await prisma.energyPackage.create({
      data: {
        id: IDS.energyPackage,
        packageNo: "ACCEPTANCE-ENERGY",
        packageName: "Acceptance Energy",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        monthlyEnergyKwh: 500
      }
    });
    await prisma.benefitPackage.create({
      data: {
        id: IDS.benefitPackage,
        packageNo: "ACCEPTANCE-BENEFIT",
        packageName: "Acceptance Benefit",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        benefitType: "WASH_CAR",
        benefitCount: 1
      }
    });
    await prisma.subscriptionPlan.create({
      data: {
        id: IDS.subscriptionPlan,
        planNo: "ACCEPTANCE-PLAN",
        planName: "Acceptance Plan",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        vehiclePackageId: IDS.vehiclePackage,
        mileagePackageId: IDS.mileagePackage,
        energyPackageId: IDS.energyPackage,
        benefitPackageId: IDS.benefitPackage,
        monthlyFeeMode: "FIXED_AMOUNT",
        baseMonthlyFeeAmount: 350000n,
        minPeriodMonths: 12,
        maxPeriodMonths: 36,
        status: "ACTIVE",
        effectiveFrom
      }
    });
    await prisma.productPriceRule.create({
      data: {
        id: IDS.priceRule,
        productVersionId: IDS.productVersion,
        modelDefinitionId: IDS.model,
        minPeriodMonths: 12,
        maxPeriodMonths: 36,
        baseMileageKm: 1500,
        overMileageFeeAmount: 100n
      }
    });

    const templateTypes = ["DELIVERY_HANDOVER", "SUBSCRIPTION_EXTENSION", "SUBSCRIPTION_STANDARD"];
    const fileRows = templateTypes.map((templateType, index) => ({
      id: uuid(100 + index),
      bucket: "acceptance",
      objectKey: `templates/${templateType}.pdf`,
      originalName: `${templateType}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: BigInt(1000 + index),
      contentSha256: createHash("sha256").update(templateType).digest("hex"),
      uploadedBy: IDS.admin
    }));
    await prisma.fileObject.createMany({ data: fileRows });
    await prisma.contractVersion.createMany({
      data: templateTypes.map((templateType, index) => ({
        id: uuid(110 + index),
        templateName: `Acceptance ${templateType}`,
        versionNo: "1",
        businessType: "SUBSCRIPTION",
        templateType,
        contentTemplate: `acceptance-${templateType}`,
        fileId: fileRows[index].id,
        effectiveFrom,
        status: "ACTIVE",
        approvedBy: IDS.admin,
        approvedAt
      }))
    });
    await prisma.notificationTemplate.createMany({
      data: NOTIFICATION_CODES.map((templateCode, index) => ({
        id: uuid(130 + index),
        templateCode,
        channel: "IN_APP",
        templateType: "SYSTEM",
        templateStatus: "ACTIVE",
        title: `Acceptance ${index}`,
        content: "acceptance"
      }))
    });

    await prisma.assetOwner.create({
      data: {
        id: IDS.owner,
        ownerNo: "ACCEPTANCE-OWNER",
        name: "Acceptance Owner",
        ownerType: "PLATFORM",
        status: "ACTIVE",
        createdBy: IDS.admin,
        updatedBy: IDS.admin
      }
    });
    await prisma.vehicle.create({
      data: {
        id: IDS.vehicle,
        vehicleNo: "ACCEPTANCE-VEHICLE-001",
        vin: "ACCEPTANCEVIN0000001",
        plateNo: "沪A00001",
        brand: "Acceptance",
        modelDefinitionId: IDS.model,
        purchasePriceAmount: 20000000n,
        currentSalePriceAmount: 18000000n,
        currentSalePriceInitializedAt: approvedAt,
        currentSalePriceReviewedAt: approvedAt,
        salePriceStatus: "EFFECTIVE",
        status: "AVAILABLE"
      }
    });
    await prisma.vehicleListingProfile.create({
      data: {
        id: IDS.listingProfile,
        vehicleId: IDS.vehicle,
        listingStatus: "PUBLISHED",
        portalVisible: true,
        displayName: "Acceptance Vehicle",
        publishedAt: approvedAt
      }
    });
    await prisma.vehicleListingMedia.create({
      data: {
        id: IDS.listingMedia,
        vehicleId: IDS.vehicle,
        listingProfileId: IDS.listingProfile,
        fileName: "cover.jpg",
        mediaCategory: "COVER",
        isCover: true
      }
    });
    await prisma.vehicleListingPlan.create({
      data: {
        id: IDS.listingPlan,
        vehicleId: IDS.vehicle,
        listingProfileId: IDS.listingProfile,
        subscriptionPlanId: IDS.subscriptionPlan,
        visible: true,
        recommended: true
      }
    });
    await prisma.vehicleDocumentBatch.create({
      data: {
        id: IDS.documentBatch,
        vehicleId: IDS.vehicle,
        documentType: "VEHICLE_LICENSE",
        versionNo: 1,
        uploadedBy: IDS.admin
      }
    });
    await prisma.vehicleInsurancePolicy.create({
      data: {
        id: IDS.insurancePolicy,
        policyNo: "ACCEPTANCE-POLICY",
        vehicleId: IDS.vehicle,
        policyType: "COMMERCIAL",
        policyStatus: "ACTIVE",
        effectiveFrom,
        effectiveTo: new Date("2027-12-31T00:00:00.000Z")
      }
    });
    await prisma.vehicleDocument.create({
      data: {
        id: IDS.vehicleDocument,
        vehicleId: IDS.vehicle,
        batchId: IDS.documentBatch,
        policyId: IDS.insurancePolicy,
        documentType: "VEHICLE_LICENSE",
        documentStatus: "ACTIVE",
        fileName: "license.pdf",
        mimeType: "application/pdf",
        bucket: "acceptance",
        objectKey: "vehicle/license.pdf",
        customerVisible: true
      }
    });
    await prisma.vehicleInsuranceCoverage.create({
      data: {
        id: IDS.insuranceCoverage,
        policyId: IDS.insurancePolicy,
        coverageType: "VEHICLE_DAMAGE",
        insuredAmount: 18000000n
      }
    });
    await prisma.vehicleListingSourceBinding.create({
      data: {
        id: IDS.sourceBinding,
        vehicleId: IDS.vehicle,
        section: "CONFIGURATION_SHEET",
        documentId: IDS.vehicleDocument
      }
    });
    await prisma.vehicleSalePriceHistory.create({
      data: {
        id: IDS.salePriceHistory,
        vehicleId: IDS.vehicle,
        beforeSalePriceAmount: null,
        afterSalePriceAmount: 18000000n,
        reviewType: "INITIAL_POOL",
        effectiveFrom,
        reason: "acceptance"
      }
    });
    await prisma.vehicleOwnershipPeriod.create({
      data: {
        id: IDS.ownershipPeriod,
        vehicleId: IDS.vehicle,
        assetOwnerId: IDS.owner,
        startedAt: effectiveFrom,
        startReason: "INITIAL_ACQUISITION",
        startSourceType: "ACCEPTANCE_FIXTURE",
        startSourceId: uuid(200),
        startSourceKey: "initial",
        startSnapshot: { authority: "fixture" },
        startConfirmedBy: IDS.admin,
        startConfirmedAt: approvedAt,
        createdBy: IDS.admin
      }
    });
    await prisma.vehicleAssetCostProfile.create({
      data: {
        id: IDS.costProfile,
        vehicleId: IDS.vehicle,
        profileStatus: "ACTIVE",
        depreciationMethod: "STRAIGHT_LINE",
        depreciationStartDate: effectiveFrom,
        usefulLifeMonths: 60,
        residualValueAmount: 5000000n
      }
    });
    const sharedCost = {
      vehicleId: IDS.vehicle,
      orderId: null,
      contractId: null,
      customerId: IDS.customer,
      assetOwnerId: IDS.owner,
      workOrderId: null,
      evidenceId: null,
      responsibilitySnapshot,
      actionType: "ACTUAL_COST",
      costCategory: "OTHER",
      responsiblePartyType: "CUSTOMER",
      responsiblePartyId: IDS.customer,
      occurredOn,
      accountingPeriod: "2026-08",
      confirmedAt,
      confirmedBy: IDS.admin,
      sourceType: "ACCEPTANCE_FIXTURE"
    };
    await prisma.vehicleCostLedgerEntry.create({
      data: {
        ...sharedCost,
        id: IDS.costOriginal,
        entryKind: "ORIGINAL",
        amountCents: 1000n,
        reversalOfEntryId: null,
        sourceId: uuid(201),
        sourceKey: "original"
      }
    });
    await prisma.vehicleCostLedgerEntry.create({
      data: {
        ...sharedCost,
        id: IDS.costReversal,
        entryKind: "REVERSAL",
        amountCents: -1000n,
        reversalOfEntryId: IDS.costOriginal,
        sourceId: uuid(202),
        sourceKey: "reversal"
      }
    });
  }

  async function businessCounts() {
    const [source, target] = await Promise.all([
      targetMetadata(clients[0]),
      targetMetadata(clients[1])
    ]);
    return {
      source: { forbidden: source.forbiddenCounts, whitelist: source.tableCounts },
      target: { forbidden: target.forbiddenCounts, whitelist: target.tableCounts }
    };
  }

  async function execute(mode, approved, pairIndex = 0) {
    const previous = process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY;
    if (mode !== "dry-run") process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY = "1";
    try {
      return await executeStage1CleanAcceptanceBaseline({
        approvedManifest: approved?.manifest,
        approvedManifestSha256: approved?.manifestSha256,
        generatedAt: GENERATED_AT,
        gitSha: GIT_SHA,
        hashSalt: HASH_SALT,
        imageRef: IMAGE_REF,
        mode,
        selection: selection(),
        sourcePrisma: clients[pairIndex === 0 ? 0 : 2],
        targetPrisma: clients[pairIndex === 0 ? 1 : 3]
      });
    } finally {
      if (previous === undefined) delete process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY;
      else process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY = previous;
    }
  }

  async function mutateAndRestoreSourceFact(work) {
    const original = await clients[0].product.findUniqueOrThrow({
      select: { description: true, updatedAt: true },
      where: { id: IDS.product }
    });
    await clients[0].product.update({
      data: { description: "temporarily changed", updatedAt: new Date("2026-08-30T11:59:00.000Z") },
      where: { id: IDS.product }
    });
    try {
      await work();
    } finally {
      await clients[0].product.update({ data: original, where: { id: IDS.product } });
    }
    const restored = await clients[0].product.findUniqueOrThrow({
      select: { description: true, updatedAt: true },
      where: { id: IDS.product }
    });
    assert.deepEqual(restored, original);
  }

  async function assertForeignKeyRollback() {
    const sourceSnapshot = await clients[0].$transaction(
      async (tx) => {
        await tx.$queryRaw`SET TRANSACTION READ ONLY`;
        return loadStage1CleanAcceptanceSourceSnapshot(tx, selection(), {
          asOf: new Date(GENERATED_AT)
        });
      },
      { isolationLevel: "RepeatableRead" }
    );
    const targetSnapshot = await targetMetadata(clients[1]);
    const classification = classifyStage1CleanAcceptanceBaseline(
      { ...sourceSnapshot, target: targetSnapshot },
      selection()
    );
    assert.equal(classification.safeToApply, true);
    classification.rows.vehicle.vehicleListingSourceBindings[0].documentId = uuid(999);
    await assert.rejects(
      clients[1].$transaction(
        (tx) =>
          applyStage1CleanAcceptanceBaseline(tx, classification, {
            gitSha: GIT_SHA,
            imageRef: IMAGE_REF,
            manifestSha256: "d".repeat(64)
          }),
        { isolationLevel: "Serializable" }
      ),
      (error) => postgresCode(error) === "23503"
    );
    assertEmptyDatabaseCounts((await businessCounts()).target);
  }

  async function assertCopiedBaseline(approved) {
    const counts = await businessCounts();
    assert.deepEqual(counts.target.whitelist, counts.source.whitelist);
    assert.equal(counts.target.whitelist.fileObject, 3);
    assert.equal(counts.target.whitelist.contractVersion, 3);
    assert.equal(counts.target.whitelist.notificationTemplate, NOTIFICATION_CODES.length);
    assert.equal(counts.target.whitelist.vehicleCostLedgerEntry, 2);
    assert.equal(counts.target.forbidden.auditLog, 1);
    assert.ok(
      Object.entries(counts.target.forbidden).every(([key, value]) =>
        key === "auditLog" ? value === 1 : value === 0
      )
    );

    const [sourceUser, targetUser] = await Promise.all([
      clients[0].user.findUniqueOrThrow({ where: { id: IDS.admin } }),
      clients[1].user.findUniqueOrThrow({ where: { id: IDS.admin } })
    ]);
    assert.equal(targetUser.id, sourceUser.id);
    assert.equal(digest(targetUser.passwordHash), digest(sourceUser.passwordHash));
    assert.equal(targetUser.passwordHash.length, PASSWORD_HASH.length);

    const targetRows = await loadStage1CleanAcceptanceSourceSnapshot(clients[1], selection(), {
      asOf: new Date(GENERATED_AT)
    });
    assert.equal(typeof targetRows.customer.customerProfiles[0].monthlyIncomeAmount, "bigint");
    assert.ok(targetRows.vehicle.vehicles[0].createdAt instanceof Date);
    assert.equal(targetRows.vehicle.vehicleCostLedgerEntries.length, 2);
    assert.equal(
      targetRows.vehicle.vehicleCostLedgerEntries[1].reversalOfEntryId,
      IDS.costOriginal
    );
    assert.equal(targetRows.vehicle.vehicleDocuments[0].policyId, IDS.insurancePolicy);
    assert.equal(
      targetRows.vehicle.vehicleListingSourceBindings[0].documentId,
      IDS.vehicleDocument
    );

    const sqlNull = await clients[1].$queryRawUnsafe(
      `
      SELECT
        (SELECT provider_snapshot IS NULL FROM customer_esign_provider_account WHERE id = $1::uuid) AS "eSign",
        (SELECT snapshot IS NULL FROM vehicle_model_definition WHERE id = $2::uuid) AS "model",
        (SELECT provider_config IS NULL AND variables IS NULL FROM notification_template LIMIT 1) AS "notification",
        (SELECT onboarding_snapshot IS NULL FROM asset_owner WHERE id = $3::uuid) AS "owner",
        (SELECT selling_points IS NULL AND customer_tags IS NULL AND service_highlights IS NULL
                AND faq_snapshot IS NULL FROM vehicle_listing_profile WHERE id = $6::uuid) AS "listing",
        (SELECT snapshot IS NULL FROM vehicle_insurance_policy WHERE id = $7::uuid) AS "policy",
        (SELECT end_snapshot IS NULL AND start_snapshot IS NOT NULL
           FROM vehicle_ownership_period WHERE id = $8::uuid) AS "ownership",
        (SELECT snapshot IS NULL FROM vehicle_asset_cost_profile WHERE id = $4::uuid) AS "costProfile",
        (SELECT asset_owner_snapshot IS NULL AND evidence_snapshot IS NULL FROM vehicle_cost_ledger_entry WHERE id = $5::uuid) AS "costLedger"
    `,
      IDS.customerESign,
      IDS.model,
      IDS.owner,
      IDS.costProfile,
      IDS.costOriginal,
      IDS.listingProfile,
      IDS.insurancePolicy,
      IDS.ownershipPeriod
    );
    assert.deepEqual(sqlNull, [
      {
        eSign: true,
        model: true,
        notification: true,
        owner: true,
        listing: true,
        policy: true,
        ownership: true,
        costProfile: true,
        costLedger: true
      }
    ]);
    await validateTarget(approved);
  }

  async function validateTarget(approved) {
    return clients[1].$transaction(
      async (tx) => {
        await tx.$queryRaw`SET TRANSACTION READ ONLY`;
        return validateStage1CleanAcceptanceTargetBaseline(tx, {
          approvedManifest: approved.manifest,
          approvedManifestSha256: approved.manifestSha256
        });
      },
      { isolationLevel: "RepeatableRead" }
    );
  }

  async function withForbiddenRow(work) {
    const id = randomUUID();
    const sensitivePhone = `199${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const sensitiveHash = createHash("sha256").update(randomUUID()).digest("hex");
    await clients[1].customerVerificationCode.create({
      data: {
        id,
        phone: sensitivePhone,
        purpose: "LOGIN",
        codeHash: sensitiveHash,
        expiresAt: new Date("2026-08-30T13:00:00.000Z")
      }
    });
    try {
      await work();
    } finally {
      await clients[1].customerVerificationCode.delete({ where: { id } });
    }
  }
}

async function createPrismaClient(databaseUrl) {
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  return new PrismaClient({ adapter: new PrismaPg(databaseUrl) });
}

function deployMigrations(databaseUrl) {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    executable,
    [
      "--filter",
      "@subscription-saas/api",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
      timeout: 60_000
    }
  );
  if (result.status !== 0) throw new Error("INTEGRATION_MIGRATION_DEPLOY_FAILED");
}

function canonicalMigrationCatalog() {
  const migrationsRoot = resolve(apiRoot, "prisma/migrations");
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      migrationName: entry.name,
      checksum: createHash("sha256")
        .update(readFileSync(resolve(migrationsRoot, entry.name, "migration.sql")))
        .digest("hex")
    }))
    .sort((left, right) => left.migrationName.localeCompare(right.migrationName));
}

async function targetMetadata(prisma) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SET TRANSACTION READ ONLY`;
      return loadStage1CleanAcceptanceTargetSnapshot(tx);
    },
    { isolationLevel: "RepeatableRead" }
  );
}

function assertAllWhitelistDelegatesPresent(counts) {
  assert.equal(Object.keys(counts.whitelist).length, 40);
  assert.ok(Object.values(counts.whitelist).every((count) => count > 0));
  assert.equal(Object.keys(counts.forbidden).length, STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES.length);
  assert.ok(Object.values(counts.forbidden).every((count) => count === 0));
}

function assertEmptyDatabaseCounts(counts) {
  assert.ok(Object.values(counts.whitelist).every((count) => count === 0));
  assert.ok(Object.values(counts.forbidden).every((count) => count === 0));
}

function selection() {
  return { adminUsername: "keqi_119", customerPhone: "18616570212", vehicleIds: [IDS.vehicle] };
}

function databaseUrlFor(adminUrl, databaseName) {
  assertDisposableDatabaseName(databaseName);
  const value = new URL(adminUrl);
  value.pathname = `/${databaseName}`;
  value.searchParams.delete("schema");
  return value.toString();
}

function assertDisposableDatabaseName(value) {
  if (typeof value !== "string" || !DATABASE_NAME.test(value)) {
    throw new Error("UNSAFE_INTEGRATION_DATABASE_NAME");
  }
}

function quoteDatabaseName(value) {
  assertDisposableDatabaseName(value);
  return `"${value}"`;
}

function postgresCode(error) {
  return error?.code ?? error?.cause?.code ?? error?.meta?.driverAdapterError?.cause?.originalCode;
}

function safeIntegrationError(error) {
  const message = error?.message;
  if (/^[A-Z0-9_]+$/.test(message ?? "")) return message;
  const code = postgresCode(error);
  if (/^[0-9A-Z]{5}$/.test(code ?? "")) return `INTEGRATION_POSTGRES_${code}`;
  return error?.name === "AssertionError"
    ? "INTEGRATION_ASSERTION_FAILED"
    : "STAGE1_ACCEPTANCE_POSTGRES_INTEGRATION_FAILED";
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
