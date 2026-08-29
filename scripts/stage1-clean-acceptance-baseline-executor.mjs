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
  if (approved && (options.generatedAt !== generatedAt || options.hashSalt !== hashSalt)) fail("MANIFEST_STALE");
  const asOf = parseInstant(generatedAt);

  const source = await readSource(options.sourcePrisma, options.selection, asOf);
  const target = await readTarget(options.targetPrisma);
  const targetForManifest = options.mode === "replay" ? emptyTargetEvidence(target.snapshot) : target.snapshot;
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
    await options.targetPrisma.$transaction(async (tx) => {
      await advisoryLock(tx);
      const lockedTarget = await readTargetWithinTransaction(tx);
      const lockedClassification = classifyStage1CleanAcceptanceBaseline(
        { ...source.snapshot, target: lockedTarget.snapshot },
        options.selection
      );
      const lockedContext = buildContext(options, generatedAt, hashSalt, source, lockedTarget);
      assertApprovedManifest(lockedClassification, lockedContext, options.approvedManifestSha256);
      await applyStage1CleanAcceptanceBaseline(tx, lockedClassification, {
        gitSha: options.gitSha,
        imageRef: options.imageRef,
        manifestSha256: options.approvedManifestSha256
      });
    }, { isolationLevel: "Serializable" });

    await verifyCommittedTarget(options.targetPrisma, manifest, options.approvedManifestSha256);
    return result("apply", options.approvedManifestSha256, total(manifest.counts), 1);
  }

  await options.targetPrisma.$transaction(async (tx) => {
    await advisoryLock(tx);
    const lockedTarget = await readTargetWithinTransaction(tx);
    assertReplayForbiddenCounts(lockedTarget.snapshot);
    const audit = await loadBaselineAudit(tx, options.approvedManifestSha256);
    if (audit.length !== 1) fail("MANIFEST_STALE");
    const targetRows = await loadStage1CleanAcceptanceSourceSnapshot(
      tx,
      options.selection,
      { asOf }
    );
    const replayClassification = classifyStage1CleanAcceptanceBaseline(
      { ...targetRows, target: emptyTargetEvidence(lockedTarget.snapshot) },
      options.selection
    );
    const replayContext = buildContext(options, generatedAt, hashSalt, source, lockedTarget);
    assertApprovedManifest(replayClassification, replayContext, options.approvedManifestSha256);
  }, { isolationLevel: "Serializable" });

  await verifyCommittedTarget(options.targetPrisma, manifest, options.approvedManifestSha256);
  return result("replay", options.approvedManifestSha256, 0, 0);
}

export async function applyStage1CleanAcceptanceBaseline(tx, classification, context = {}) {
  if (!isStage1CleanAcceptanceBaselineSafe(classification)) fail("MANIFEST_CLASSIFICATION_INVALID");
  if (
    !SHA256.test(context.manifestSha256 ?? "") ||
    !/^[0-9a-f]{40}$/.test(context.gitSha ?? "") ||
    !/^.+@sha256:[0-9a-f]{64}$/.test(context.imageRef ?? "")
  ) fail("MANIFEST_CONTEXT_INVALID");
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
  await insert(tx.customerESignProviderAccount, customer.customerESignProviderAccounts);

  await insert(tx.depositRule, catalog.depositRules);
  await insert(tx.product, catalog.products);
  await insert(tx.productVersion, catalog.productVersions);
  await insert(tx.vehicleModelDefinition, vehicle.vehicleModelDefinitions);
  await insert(tx.vehiclePackage, catalog.vehiclePackages);
  await insert(tx.vehiclePackageModelMember, catalog.vehiclePackageModelMembers);
  await insert(tx.mileagePackage, catalog.mileagePackages);
  await insert(tx.energyPackage, catalog.energyPackages);
  await insert(tx.benefitPackage, catalog.benefitPackages);
  await insert(tx.subscriptionPlan, catalog.subscriptionPlans);
  await insert(tx.productPriceRule, catalog.productPriceRules);

  await insert(tx.fileObject, templates.fileObjects);
  await insert(tx.contractVersion, templates.contractVersions);
  await insert(tx.notificationTemplate, templates.notificationTemplates);

  await insert(tx.assetOwner, vehicle.assetOwners);
  await insert(tx.vehicle, vehicle.vehicles);
  await insert(tx.vehicleListingProfile, vehicle.vehicleListingProfiles);
  await insert(tx.vehicleListingMedia, vehicle.vehicleListingMedia);
  await insert(tx.vehicleListingPlan, vehicle.vehicleListingPlans);
  await insert(tx.vehicleDocumentBatch, vehicle.vehicleDocumentBatches);
  await insert(tx.vehicleInsurancePolicy, vehicle.vehicleInsurancePolicies);
  await insert(tx.vehicleDocument, vehicle.vehicleDocuments);
  await insert(tx.vehicleInsuranceCoverage, vehicle.vehicleInsuranceCoverages);
  await insert(tx.vehicleListingSourceBinding, vehicle.vehicleListingSourceBindings);
  await insert(tx.vehicleSalePriceHistory, vehicle.vehicleSalePriceHistories);
  await insert(tx.vehicleOwnershipPeriod, vehicle.vehicleOwnershipPeriods);
  await insert(tx.vehicleAssetCostProfile, vehicle.vehicleAssetCostProfiles);
  await insert(tx.vehicleCostLedgerEntry, vehicle.vehicleCostLedgerEntries);

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
      beforeSnapshot: null,
      entityId: null,
      entityType: "stage1_acceptance_baseline",
      module: "stage1_acceptance_baseline"
    }
  });
}

async function readSource(prisma, selection, asOf) {
  return prisma.$transaction(async (tx) => {
    await readOnly(tx);
    const databaseName = await loadDatabaseName(tx);
    const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(tx, selection, { asOf });
    const metadata = await loadStage1CleanAcceptanceTargetSnapshot(tx);
    return { context: digestContext(databaseName, metadata), snapshot };
  }, { isolationLevel: "RepeatableRead" });
}

async function readTarget(prisma) {
  return prisma.$transaction(async (tx) => {
    await readOnly(tx);
    return readTargetWithinTransaction(tx);
  }, { isolationLevel: "RepeatableRead" });
}

async function readTargetWithinTransaction(tx) {
  const databaseName = await loadDatabaseName(tx);
  const snapshot = await loadStage1CleanAcceptanceTargetSnapshot(tx);
  return { context: digestContext(databaseName, snapshot), snapshot };
}

async function verifyCommittedTarget(prisma, manifest, manifestSha256) {
  await prisma.$transaction(async (tx) => {
    await readOnly(tx);
    const snapshot = await loadStage1CleanAcceptanceTargetSnapshot(tx);
    assertAllowedCounts(snapshot.tableCounts, manifest.counts);
    assertReplayForbiddenCounts(snapshot);
    const audit = await loadBaselineAudit(tx, manifestSha256);
    if (audit.length !== 1) fail("MANIFEST_STALE");
  }, { isolationLevel: "RepeatableRead" });
}

async function loadBaselineAudit(tx, manifestSha256) {
  const rows = await tx.auditLog.findMany({
    select: { action: true, afterSnapshot: true, entityType: true },
    where: { action: "CREATE", entityType: "stage1_acceptance_baseline" }
  });
  return rows.filter((row) => row?.afterSnapshot?.manifestSha256 === manifestSha256);
}

function assertApprovedManifest(classification, context, approvedSha256) {
  const manifest = buildStage1CleanAcceptanceManifest(classification, context);
  if (hashStage1CleanAcceptanceManifest(manifest) !== approvedSha256) fail("MANIFEST_STALE");
}

function requireOptions(options) {
  if (!MODES.has(options.mode) || typeof options.sourcePrisma?.$transaction !== "function" || typeof options.targetPrisma?.$transaction !== "function") {
    fail("MANIFEST_CONTEXT_INVALID");
  }
}

function requireApproval(options) {
  if (options.mode === "dry-run") return undefined;
  if (process.env[APPLY_CONFIRMATION] !== "1") fail("MANIFEST_CONTEXT_INVALID");
  if (!options.approvedManifest || typeof options.approvedManifest !== "object" || Array.isArray(options.approvedManifest)) {
    fail("MANIFEST_CONTEXT_INVALID");
  }
  if (!SHA256.test(options.approvedManifestSha256 ?? "")) fail("MANIFEST_CONTEXT_INVALID");
  if (hashStage1CleanAcceptanceManifest(options.approvedManifest) !== options.approvedManifestSha256) {
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
    migrationCatalogDigest: digest("stage1-acceptance:migrations:", stableJson(snapshot.migrationCatalog)),
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

function assertAllowedCounts(actual, domainCounts) {
  const expectedTotal = total(domainCounts);
  if (total(actual) !== expectedTotal) fail("MANIFEST_STALE");
}

async function insert(delegate, rows) {
  if (rows.length > 0) await delegate.createMany({ data: rows });
}

async function readOnly(tx) {
  await tx.$queryRaw`SET TRANSACTION READ ONLY`;
}

async function advisoryLock(tx) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('stage1-clean-acceptance-baseline:apply'))`;
}

async function loadDatabaseName(tx) {
  const rows = await tx.$queryRaw`SELECT current_database() AS "databaseName"`;
  const databaseName = rows?.[0]?.databaseName;
  if (typeof databaseName !== "string" || databaseName.length === 0) fail("DATABASE_IDENTITY_INVALID");
  return databaseName;
}

function parseInstant(value) {
  if (typeof value !== "string") fail("MANIFEST_CONTEXT_INVALID");
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) fail("MANIFEST_CONTEXT_INVALID");
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
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fail(code) {
  throw new Error(code);
}
