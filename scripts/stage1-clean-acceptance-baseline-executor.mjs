import { createHash } from "node:crypto";

import {
  buildStage1CleanAcceptanceManifest,
  classifyStage1CleanAcceptanceBaseline,
  hashStage1CleanAcceptanceManifest,
  isStage1CleanAcceptanceBaselineSafe,
  redactStage1CleanAcceptanceError
} from "./stage1-clean-acceptance-baseline-core.mjs";
import {
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  loadStage1CleanAcceptanceSourceSnapshot,
  loadStage1CleanAcceptanceTargetSnapshot
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";

const APPLY_CONFIRMATION = "STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY";
const APPLY_TRANSACTION_ATTEMPTS = 3;
const SHA256 = /^[0-9a-f]{64}$/;
const MODES = new Set(["dry-run", "apply", "replay"]);

export async function executeStage1CleanAcceptanceBaseline(options = {}) {
  try {
    return await execute(options);
  } catch (error) {
    fail(redactStage1CleanAcceptanceError(error).code);
  }
}

async function execute(options) {
  requireOptions(options);
  const approved = requireApproval(options);
  const generatedAt = approved?.generatedAt ?? options.generatedAt;
  const hashSalt = approved?.hashSalt ?? options.hashSalt;
  if (approved && (options.generatedAt !== generatedAt || options.hashSalt !== hashSalt))
    fail("MANIFEST_STALE");
  const asOf = parseInstant(generatedAt);

  const source = await readSource(options.sourcePrisma, options.selection, asOf);
  const target = await readTarget(options.targetPrisma);
  const targetForManifest =
    options.mode === "replay" ? emptyTargetEvidence(target.snapshot) : target.snapshot;
  const classification = classifyStage1CleanAcceptanceBaseline(
    { ...source.snapshot, target: targetForManifest },
    options.selection
  );
  const context = buildContext(options, generatedAt, hashSalt, source, target);
  const manifest = buildStage1CleanAcceptanceManifest(classification, context);
  const manifestSha256 = hashStage1CleanAcceptanceManifest(manifest);

  if (options.mode === "dry-run") {
    return {
      manifest,
      manifestSha256,
      mode: "dry-run",
      safe: manifest.safeToApply === true
    };
  }
  if (manifestSha256 !== options.approvedManifestSha256) fail("MANIFEST_STALE");

  if (options.mode === "apply") {
    await applyWithFreshTransactionRecovery(options, source, generatedAt, hashSalt, manifest);

    await verifyCommittedTarget(options.targetPrisma, manifest, options.approvedManifestSha256);
    return result("apply", options.approvedManifestSha256, total(manifest.counts), 1);
  }

  await options.targetPrisma.$transaction(
    async (tx) => {
      await advisoryLock(tx);
      await validateStage1CleanAcceptanceTargetBaseline(tx, {
        approvedManifest: manifest,
        approvedManifestSha256: options.approvedManifestSha256
      });
    },
    { isolationLevel: "Serializable" }
  );

  await verifyCommittedTarget(options.targetPrisma, manifest, options.approvedManifestSha256);
  return result("replay", options.approvedManifestSha256, 0, 0);
}

async function applyWithFreshTransactionRecovery(options, source, generatedAt, hashSalt, manifest) {
  for (let attempt = 1; attempt <= APPLY_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      await options.targetPrisma.$transaction(
        async (tx) => {
          await advisoryLock(tx);
          const lockedTarget = await readTargetWithinTransaction(tx);
          const lockedClassification = classifyStage1CleanAcceptanceBaseline(
            { ...source.snapshot, target: lockedTarget.snapshot },
            options.selection
          );
          const lockedContext = buildContext(options, generatedAt, hashSalt, source, lockedTarget);
          assertApprovedManifest(
            lockedClassification,
            lockedContext,
            options.approvedManifestSha256
          );
          await applyStage1CleanAcceptanceBaseline(tx, lockedClassification, {
            gitSha: options.gitSha,
            imageRef: options.imageRef,
            manifestSha256: options.approvedManifestSha256
          });
        },
        { isolationLevel: "Serializable" }
      );
      return;
    } catch (error) {
      if (
        await targetMatchesApprovedBaseline(
          options.targetPrisma,
          manifest,
          options.approvedManifestSha256
        )
      ) {
        fail("MANIFEST_STALE");
      }
      if (isSerializationFailure(error) && attempt < APPLY_TRANSACTION_ATTEMPTS) continue;
      throw error;
    }
  }
}

async function targetMatchesApprovedBaseline(prisma, manifest, manifestSha256) {
  try {
    await verifyCommittedTarget(prisma, manifest, manifestSha256);
    return true;
  } catch (error) {
    if (error?.message === "MANIFEST_STALE") return false;
    throw error;
  }
}

function isSerializationFailure(error) {
  return hasDatabaseErrorCode(error, new Set(["40001", "P2034"]));
}

function hasDatabaseErrorCode(error, accepted) {
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value))
      continue;
    seen.add(value);
    for (const code of [value.code, value.originalCode]) {
      if (typeof code === "string" && accepted.has(code)) return true;
    }
    for (const key of ["cause", "meta", "driverAdapterError", "error"]) {
      if (value[key] !== undefined) pending.push(value[key]);
    }
  }
  return false;
}

export async function applyStage1CleanAcceptanceBaseline(tx, classification, context = {}) {
  if (!isStage1CleanAcceptanceBaselineSafe(classification)) fail("MANIFEST_CLASSIFICATION_INVALID");
  if (
    !SHA256.test(context.manifestSha256 ?? "") ||
    !/^[0-9a-f]{40}$/.test(context.gitSha ?? "") ||
    !/^.+@sha256:[0-9a-f]{64}$/.test(context.imageRef ?? "")
  )
    fail("MANIFEST_CONTEXT_INVALID");
  const { access, customer, catalog, templates, vehicle } = classification.rows;

  await insert(tx.permission, access.permissions);
  await insert(tx.menu, access.menus);
  await insert(tx.role, access.roles);
  await insert(tx.rolePermission, access.rolePermissions);
  await insert(tx.roleMenu, access.roleMenus);
  await insert(tx.user, access.users);
  await insert(tx.userRole, access.userRoles);

  await insert(tx.customer, customer.customers);
  await insert(tx.customerAccount, customer.customerAccounts);
  await insert(tx.customerIdentity, customer.customerIdentities);
  await insert(tx.customerProfile, customer.customerProfiles);
  await insert(
    tx.customerESignProviderAccount,
    customer.customerESignProviderAccounts,
    adaptCustomerESignProviderAccount
  );

  await insert(tx.depositRule, catalog.depositRules);
  await insert(tx.product, catalog.products);
  await insert(tx.productVersion, catalog.productVersions);
  await insert(
    tx.vehicleModelDefinition,
    vehicle.vehicleModelDefinitions,
    adaptVehicleModelDefinition
  );
  await insert(tx.vehiclePackage, catalog.vehiclePackages);
  await insert(tx.vehiclePackageModelMember, catalog.vehiclePackageModelMembers);
  await insert(tx.mileagePackage, catalog.mileagePackages);
  await insert(tx.energyPackage, catalog.energyPackages);
  await insert(tx.benefitPackage, catalog.benefitPackages);
  await insert(tx.subscriptionPlan, catalog.subscriptionPlans);
  await insert(tx.productPriceRule, catalog.productPriceRules);

  await insert(tx.fileObject, templates.fileObjects);
  await insert(tx.contractVersion, templates.contractVersions);
  await insert(tx.notificationTemplate, templates.notificationTemplates, adaptNotificationTemplate);

  await insert(tx.assetOwner, vehicle.assetOwners, adaptAssetOwner);
  await insert(tx.vehicle, vehicle.vehicles);
  await insert(
    tx.vehicleListingProfile,
    vehicle.vehicleListingProfiles,
    adaptVehicleListingProfile
  );
  await insert(tx.vehicleListingMedia, vehicle.vehicleListingMedia);
  await insert(tx.vehicleListingPlan, vehicle.vehicleListingPlans);
  await insert(tx.vehicleDocumentBatch, vehicle.vehicleDocumentBatches);
  await insert(
    tx.vehicleInsurancePolicy,
    vehicle.vehicleInsurancePolicies,
    adaptVehicleInsurancePolicy
  );
  await insert(tx.vehicleDocument, vehicle.vehicleDocuments);
  await insert(tx.vehicleInsuranceCoverage, vehicle.vehicleInsuranceCoverages);
  await insert(tx.vehicleListingSourceBinding, vehicle.vehicleListingSourceBindings);
  await insert(tx.vehicleSalePriceHistory, vehicle.vehicleSalePriceHistories);
  await insert(
    tx.vehicleOwnershipPeriod,
    vehicle.vehicleOwnershipPeriods,
    adaptVehicleOwnershipPeriod
  );
  await insert(
    tx.vehicleAssetCostProfile,
    vehicle.vehicleAssetCostProfiles,
    adaptVehicleAssetCostProfile
  );
  await insert(
    tx.vehicleCostLedgerEntry,
    vehicle.vehicleCostLedgerEntries,
    adaptVehicleCostLedgerEntry
  );

  await tx.auditLog.create({
    data: {
      action: "CREATE",
      afterSnapshot: {
        counts: classification.counts,
        gitSha: context.gitSha,
        imageRef: context.imageRef,
        manifestSha256: context.manifestSha256,
        summary: "STAGE1_CLEAN_ACCEPTANCE_BASELINE"
      },
      entityId: null,
      entityType: "stage1_acceptance_baseline",
      module: "stage1_acceptance_baseline"
    }
  });
}

export async function validateStage1CleanAcceptanceTargetBaseline(tx, options = {}) {
  const approvedManifest = options.approvedManifest;
  const approvedManifestSha256 = options.approvedManifestSha256;
  if (
    !approvedManifest ||
    typeof approvedManifest !== "object" ||
    Array.isArray(approvedManifest) ||
    !SHA256.test(approvedManifestSha256 ?? "") ||
    hashStage1CleanAcceptanceManifest(approvedManifest) !== approvedManifestSha256
  ) {
    fail("MANIFEST_STALE");
  }

  const asOf = parseInstant(approvedManifest.generatedAt);
  const vehicleIds = (await tx.vehicle.findMany({ select: { id: true } }))
    .map((row) => row?.id)
    .filter((id) => typeof id === "string")
    .sort();
  const selection = {
    adminUsername: "keqi_119",
    customerPhone: "18616570212",
    vehicleIds
  };
  const databaseName = await loadDatabaseName(tx);
  const targetSnapshot = await loadStage1CleanAcceptanceTargetSnapshot(tx);
  const targetRows = await loadStage1CleanAcceptanceSourceSnapshot(tx, selection, { asOf });
  const classification = classifyStage1CleanAcceptanceBaseline(
    { ...targetRows, target: emptyTargetEvidence(targetSnapshot) },
    selection
  );
  if (!isStage1CleanAcceptanceBaselineSafe(classification)) fail("MANIFEST_STALE");
  assertExactAllowedCounts(targetSnapshot.tableCounts, classification.rows);
  assertReplayForbiddenCounts(targetSnapshot);

  const target = digestContext(databaseName, targetSnapshot);
  const rebuiltManifest = buildStage1CleanAcceptanceManifest(classification, {
    generatedAt: approvedManifest.generatedAt,
    gitSha: approvedManifest.gitSha,
    hashSalt: approvedManifest.hashSalt,
    imageRef: approvedManifest.imageRef,
    source: approvedManifest.source,
    target
  });
  if (hashStage1CleanAcceptanceManifest(rebuiltManifest) !== approvedManifestSha256) {
    fail("MANIFEST_STALE");
  }
  const audit = await loadBaselineAudit(
    tx,
    rebuiltManifest,
    approvedManifestSha256,
    approvedManifest
  );
  if (audit.length !== 1) fail("MANIFEST_STALE");

  return {
    counts: rebuiltManifest.counts,
    manifestSha256: approvedManifestSha256,
    safe: true,
    target
  };
}

async function readSource(prisma, selection, asOf) {
  return prisma.$transaction(
    async (tx) => {
      await readOnly(tx);
      const databaseName = await loadDatabaseName(tx);
      const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(tx, selection, { asOf });
      const metadata = await loadStage1CleanAcceptanceTargetSnapshot(tx);
      return { context: digestContext(databaseName, metadata), snapshot };
    },
    { isolationLevel: "RepeatableRead" }
  );
}

async function readTarget(prisma) {
  return prisma.$transaction(
    async (tx) => {
      await readOnly(tx);
      return readTargetWithinTransaction(tx);
    },
    { isolationLevel: "RepeatableRead" }
  );
}

async function readTargetWithinTransaction(tx) {
  const databaseName = await loadDatabaseName(tx);
  const snapshot = await loadStage1CleanAcceptanceTargetSnapshot(tx);
  return { context: digestContext(databaseName, snapshot), snapshot };
}

async function verifyCommittedTarget(prisma, manifest, manifestSha256) {
  await prisma.$transaction(
    async (tx) => {
      await readOnly(tx);
      await validateStage1CleanAcceptanceTargetBaseline(tx, {
        approvedManifest: manifest,
        approvedManifestSha256: manifestSha256
      });
    },
    { isolationLevel: "RepeatableRead" }
  );
}

async function loadBaselineAudit(tx, manifest, manifestSha256, context) {
  const rows = await tx.auditLog.findMany({
    select: {
      action: true,
      afterSnapshot: true,
      beforeSnapshot: true,
      entityId: true,
      entityType: true,
      ipAddress: true,
      module: true,
      operatorId: true,
      userAgent: true
    }
  });
  const expected = {
    action: "CREATE",
    afterSnapshot: {
      counts: manifest.counts,
      gitSha: context.gitSha,
      imageRef: context.imageRef,
      manifestSha256,
      summary: "STAGE1_CLEAN_ACCEPTANCE_BASELINE"
    },
    beforeSnapshot: null,
    entityId: null,
    entityType: "stage1_acceptance_baseline",
    ipAddress: null,
    module: "stage1_acceptance_baseline",
    operatorId: null,
    userAgent: null
  };
  return rows.filter((row) => stableJson(row) === stableJson(expected));
}

function assertApprovedManifest(classification, context, approvedSha256) {
  const manifest = buildStage1CleanAcceptanceManifest(classification, context);
  if (hashStage1CleanAcceptanceManifest(manifest) !== approvedSha256) fail("MANIFEST_STALE");
}

function requireOptions(options) {
  if (
    !MODES.has(options.mode) ||
    typeof options.sourcePrisma?.$transaction !== "function" ||
    typeof options.targetPrisma?.$transaction !== "function"
  ) {
    fail("MANIFEST_CONTEXT_INVALID");
  }
}

function requireApproval(options) {
  if (options.mode === "dry-run") return undefined;
  if (process.env[APPLY_CONFIRMATION] !== "1") fail("MANIFEST_CONTEXT_INVALID");
  if (
    !options.approvedManifest ||
    typeof options.approvedManifest !== "object" ||
    Array.isArray(options.approvedManifest)
  ) {
    fail("MANIFEST_CONTEXT_INVALID");
  }
  if (!SHA256.test(options.approvedManifestSha256 ?? "")) fail("MANIFEST_CONTEXT_INVALID");
  if (
    hashStage1CleanAcceptanceManifest(options.approvedManifest) !== options.approvedManifestSha256
  ) {
    fail("MANIFEST_STALE");
  }
  return options.approvedManifest;
}

function buildContext(options, generatedAt, hashSalt, source, target) {
  return {
    generatedAt,
    gitSha: options.gitSha,
    hashSalt,
    imageRef: options.imageRef,
    source: source.context,
    target: target.context
  };
}

function digestContext(databaseName, snapshot) {
  return {
    databaseDigest: digest("stage1-acceptance:database:", databaseName),
    migrationCatalogDigest: digest(
      "stage1-acceptance:migrations:",
      stableJson(snapshot.migrationCatalog)
    ),
    schemaDigest: digest("stage1-acceptance:schema:", stableJson(snapshot.schemaFingerprint))
  };
}

function emptyTargetEvidence(snapshot) {
  return {
    ...snapshot,
    forbiddenCounts: Object.fromEntries(snapshot.forbiddenCountKeys.map((key) => [key, 0])),
    tableCounts: Object.fromEntries(snapshot.tableCountKeys.map((key) => [key, 0]))
  };
}

function assertReplayForbiddenCounts(snapshot) {
  for (const delegate of STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES) {
    const expected = delegate === "auditLog" ? 1 : 0;
    if (snapshot.forbiddenCounts?.[delegate] !== expected) fail("MANIFEST_STALE");
  }
}

function assertExactAllowedCounts(actual, rows) {
  const expected = {
    assetOwner: rows.vehicle.assetOwners.length,
    benefitPackage: rows.catalog.benefitPackages.length,
    contractVersion: rows.templates.contractVersions.length,
    customer: rows.customer.customers.length,
    customerAccount: rows.customer.customerAccounts.length,
    customerESignProviderAccount: rows.customer.customerESignProviderAccounts.length,
    customerIdentity: rows.customer.customerIdentities.length,
    customerProfile: rows.customer.customerProfiles.length,
    depositRule: rows.catalog.depositRules.length,
    energyPackage: rows.catalog.energyPackages.length,
    fileObject: rows.templates.fileObjects.length,
    menu: rows.access.menus.length,
    mileagePackage: rows.catalog.mileagePackages.length,
    notificationTemplate: rows.templates.notificationTemplates.length,
    permission: rows.access.permissions.length,
    product: rows.catalog.products.length,
    productPriceRule: rows.catalog.productPriceRules.length,
    productVersion: rows.catalog.productVersions.length,
    role: rows.access.roles.length,
    roleMenu: rows.access.roleMenus.length,
    rolePermission: rows.access.rolePermissions.length,
    subscriptionPlan: rows.catalog.subscriptionPlans.length,
    user: rows.access.users.length,
    userRole: rows.access.userRoles.length,
    vehicle: rows.vehicle.vehicles.length,
    vehicleAssetCostProfile: rows.vehicle.vehicleAssetCostProfiles.length,
    vehicleCostLedgerEntry: rows.vehicle.vehicleCostLedgerEntries.length,
    vehicleDocument: rows.vehicle.vehicleDocuments.length,
    vehicleDocumentBatch: rows.vehicle.vehicleDocumentBatches.length,
    vehicleInsuranceCoverage: rows.vehicle.vehicleInsuranceCoverages.length,
    vehicleInsurancePolicy: rows.vehicle.vehicleInsurancePolicies.length,
    vehicleListingMedia: rows.vehicle.vehicleListingMedia.length,
    vehicleListingPlan: rows.vehicle.vehicleListingPlans.length,
    vehicleListingProfile: rows.vehicle.vehicleListingProfiles.length,
    vehicleListingSourceBinding: rows.vehicle.vehicleListingSourceBindings.length,
    vehicleModelDefinition: rows.vehicle.vehicleModelDefinitions.length,
    vehicleOwnershipPeriod: rows.vehicle.vehicleOwnershipPeriods.length,
    vehiclePackage: rows.catalog.vehiclePackages.length,
    vehiclePackageModelMember: rows.catalog.vehiclePackageModelMembers.length,
    vehicleSalePriceHistory: rows.vehicle.vehicleSalePriceHistories.length
  };
  if (stableJson(actual) !== stableJson(expected)) fail("MANIFEST_STALE");
}

async function insert(delegate, rows, adapt = identity) {
  if (rows.length > 0) await delegate.createMany({ data: rows.map(adapt) });
}

function identity(row) {
  return row;
}

function adaptCustomerESignProviderAccount(row) {
  const { providerSnapshot, ...data } = row;
  return providerSnapshot == null ? data : { ...data, providerSnapshot };
}

function adaptVehicleModelDefinition(row) {
  const { snapshot, ...data } = row;
  return snapshot == null ? data : { ...data, snapshot };
}

function adaptNotificationTemplate(row) {
  const { providerConfig, variables, ...data } = row;
  return {
    ...data,
    ...(variables == null ? {} : { variables }),
    ...(providerConfig == null ? {} : { providerConfig })
  };
}

function adaptAssetOwner(row) {
  const { onboardingSnapshot, ...data } = row;
  return onboardingSnapshot == null ? data : { ...data, onboardingSnapshot };
}

function adaptVehicleListingProfile(row) {
  const { customerTags, faqSnapshot, sellingPoints, serviceHighlights, ...data } = row;
  return {
    ...data,
    ...(sellingPoints == null ? {} : { sellingPoints }),
    ...(customerTags == null ? {} : { customerTags }),
    ...(serviceHighlights == null ? {} : { serviceHighlights }),
    ...(faqSnapshot == null ? {} : { faqSnapshot })
  };
}

function adaptVehicleInsurancePolicy(row) {
  const { snapshot, ...data } = row;
  return snapshot == null ? data : { ...data, snapshot };
}

function adaptVehicleOwnershipPeriod(row) {
  const { endSnapshot, startSnapshot, ...data } = row;
  return {
    ...data,
    startSnapshot: requiredJson(startSnapshot),
    ...(endSnapshot == null ? {} : { endSnapshot })
  };
}

function adaptVehicleAssetCostProfile(row) {
  const { snapshot, ...data } = row;
  return snapshot == null ? data : { ...data, snapshot };
}

function adaptVehicleCostLedgerEntry(row) {
  const { assetOwnerSnapshot, evidenceSnapshot, responsibilitySnapshot, ...data } = row;
  return {
    ...data,
    responsibilitySnapshot: requiredJson(responsibilitySnapshot),
    ...(assetOwnerSnapshot == null ? {} : { assetOwnerSnapshot }),
    ...(evidenceSnapshot == null ? {} : { evidenceSnapshot })
  };
}

function requiredJson(value) {
  if (value === null || value === undefined) fail("MANIFEST_CLASSIFICATION_INVALID");
  return value;
}

async function readOnly(tx) {
  await tx.$queryRaw`SET TRANSACTION READ ONLY`;
}

async function advisoryLock(tx) {
  await tx.$queryRaw`
    WITH lock_call AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtext(${"stage1-clean-acceptance-baseline:apply"}))
    )
    SELECT 1::int AS locked
    FROM lock_call
  `;
}

async function loadDatabaseName(tx) {
  const rows = await tx.$queryRaw`SELECT current_database() AS "databaseName"`;
  const databaseName = rows?.[0]?.databaseName;
  if (typeof databaseName !== "string" || databaseName.length === 0)
    fail("DATABASE_IDENTITY_INVALID");
  return databaseName;
}

function parseInstant(value) {
  if (typeof value !== "string") fail("MANIFEST_CONTEXT_INVALID");
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value)
    fail("MANIFEST_CONTEXT_INVALID");
  return instant;
}

function result(mode, manifestSha256, inserted, auditCreated) {
  return { auditCreated, deleted: 0, inserted, manifestSha256, mode, safe: true, updated: 0 };
}

function total(counts = {}) {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function digest(prefix, value) {
  return createHash("sha256").update(`${prefix}${value}`, "utf8").digest("hex");
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value))
    return value
      .map(canonical)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function fail(code) {
  throw new Error(code);
}
