import { existsSync, readFileSync } from "node:fs";

import { parseStage1CleanAcceptanceSelection } from "./stage1-clean-acceptance-baseline-core.mjs";
import { loadLocalMigrationChecksums } from "./prisma-migration-checksums.mjs";

const FORBIDDEN_DOMAIN_DEFINITION = loadStage1AcceptanceForbiddenDomainDefinition();

export function loadStage1AcceptanceForbiddenDomainDefinition(moduleUrl = import.meta.url) {
  const candidates = [
    new URL(
      "../apps/api/src/billing-automation/stage1-acceptance-forbidden-domains.json",
      moduleUrl
    ),
    new URL(
      "../apps/api/dist/src/billing-automation/stage1-acceptance-forbidden-domains.json",
      moduleUrl
    )
  ];
  const asset = candidates.find((candidate) => existsSync(candidate));
  if (!asset) throw new Error("STAGE1_ACCEPTANCE_FORBIDDEN_DOMAIN_DEFINITION_MISSING");
  const parsed = JSON.parse(readFileSync(asset, "utf8"));
  if (
    typeof parsed?.version !== "string" ||
    !/^stage1-acceptance-forbidden-domains\/v[1-9][0-9]*$/.test(parsed.version) ||
    !Array.isArray(parsed.domains) ||
    parsed.domains.length === 0 ||
    parsed.domains.some(
      (domain) =>
        typeof domain?.delegate !== "string" ||
        !/^[a-z][A-Za-z0-9]*$/.test(domain.delegate) ||
        typeof domain?.table !== "string" ||
        !/^[a-z][a-z0-9_]*$/.test(domain.table)
    )
  ) {
    throw new Error("STAGE1_ACCEPTANCE_FORBIDDEN_DOMAIN_DEFINITION_INVALID");
  }
  return parsed;
}

export const STAGE1_ACCEPTANCE_CANONICAL_SCHEMA_FINGERPRINT_SHA256 =
  "6264cda46cd5d17b5c2bd14bb8d2da95fc6420e7c066bf474dcb030c672613be";

const REQUIRED_CONTRACT_TEMPLATE_TYPES = Object.freeze([
  "DELIVERY_HANDOVER",
  "SUBSCRIPTION_EXTENSION",
  "SUBSCRIPTION_STANDARD"
]);

const REQUIRED_NOTIFICATION_TEMPLATE_CODES = Object.freeze([
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

export const STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES = Object.freeze(
  FORBIDDEN_DOMAIN_DEFINITION.domains.map(({ delegate }) => delegate)
);

const SELECT = Object.freeze({
  assetOwner: scalarSelect(
    "id ownerNo name legalName registrationIdentifier ownerType status onboardingSnapshot createdAt updatedAt createdBy updatedBy"
  ),
  benefitPackage: scalarSelect(
    "id packageNo packageName productId productVersionId benefitType benefitCount priceAmount description status remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  contractVersion: scalarSelect(
    "id templateName versionNo businessType templateType contentTemplate fileId effectiveFrom effectiveTo status approvedBy approvedAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customer: scalarSelect(
    "id customerNo name mobile customerType sourceChannel grade riskScore status ownerUserId remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customerAccount: scalarSelect(
    "id customerId phone phoneVerifiedAt wechatOpenId wechatUnionId accountStatus lastLoginAt lastLoginIp lastUserAgent createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customerESignProviderAccount: scalarSelect(
    "id customerId provider accountType source providerOpenId providerCustomerId registrationStatus realNameStatus verificationSerialNo verificationTransactionNo verifiedAt realNameProviderStatus realNameProviderStatusSource realNameProviderVerifiedAt certBindingStatus certBindingSource certBoundAt certSerialNo providerStatusLastRefreshedAt readinessBlockingCode readinessBlockingReason lastErrorCode lastErrorMessage providerSnapshot createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customerIdentity: scalarSelect(
    "id customerId idCardNo idCardFrontFileId idCardBackFileId driverLicenseNo driverLicenseFileId licenseValidUntil realnameVerified verifiedAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customerProfile: scalarSelect(
    "id customerId occupation companyName monthlyIncomeAmount socialSecurityMonths housingFundMonths residenceAddress residenceProvince residenceCity residenceDistrict residenceDetail emergencyContactName emergencyContactMobile createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  depositRule: scalarSelect(
    "id grade depositAmount customerRatio defaultRate effectiveFrom effectiveTo status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  energyPackage: scalarSelect(
    "id packageNo packageName productId productVersionId monthlyEnergyKwh monthlyEnergyCount priceAmount stationScope serviceDescription status remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  fileObject: scalarSelect(
    "id bucket objectKey originalName mimeType sizeBytes contentSha256 uploadedBy createdAt"
  ),
  menu: scalarSelect(
    "id code name path icon sortOrder permissionCode parentId status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  mileagePackage: scalarSelect(
    "id packageNo packageName productId productVersionId monthlyMileageKm overMileageFeeAmount priceAmount status remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  notificationTemplate: scalarSelect(
    "id templateCode channel templateType templateStatus title description providerTemplateId content variables providerConfig createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  permission: scalarSelect(
    "id code name module action description status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  product: scalarSelect(
    "id productNo name productType status description createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  productPriceRule: scalarSelect(
    "id productVersionId modelDefinitionId monthlyFeeRate minPeriodMonths maxPeriodMonths baseMileageKm overMileageFeeAmount energyLimitKwh energyLimitCount status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  productVersion: scalarSelect(
    "id productId versionNo effectiveFrom effectiveTo status approvedBy approvedAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  role: scalarSelect(
    "id code name description status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  roleMenu: scalarSelect("id roleId menuId createdAt createdBy deletedAt"),
  rolePermission: scalarSelect("id roleId permissionId createdAt createdBy deletedAt"),
  subscriptionPlan: scalarSelect(
    "id planNo planName productId productVersionId vehiclePackageId mileagePackageId energyPackageId benefitPackageId monthlyFeeMode baseMonthlyFeeAmount monthlyFeeRate monthlyFeeCapRate minPeriodMonths maxPeriodMonths status effectiveFrom effectiveTo remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  user: scalarSelect(
    "id username name mobile email passwordHash status lastLoginAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  userRole: scalarSelect("id userId roleId createdAt createdBy deletedAt"),
  vehicle: scalarSelect(
    "id vehicleNo vin plateNo brand series model modelYear modelDefinitionId batteryCapacityKwh batteryUsageType acquisitionMode purchasePriceAmount purchaseDate currentSalePriceAmount currentSalePriceInitializedAt currentSalePriceReviewedAt nextSalePriceReviewAt salePriceReinitRequiredAt salePriceStatus registrationDate latestRegistrationDate status currentMileageKm assetLocation remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleAssetCostProfile: scalarSelect(
    "id vehicleId profileStatus depreciationMethod depreciationStartDate usefulLifeMonths residualValueAmount capitalCostRateBps annualInsuranceCostAmount annualMaintenanceReserveAmount otherMonthlyCostAmount remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleCostLedgerEntry: scalarSelect(
    "id vehicleId orderId contractId customerId assetOwnerId workOrderId evidenceId assetOwnerSnapshot evidenceSnapshot responsibilitySnapshot entryKind actionType costCategory amountCents responsiblePartyType responsiblePartyId occurredOn accountingPeriod confirmedAt confirmedBy reversalOfEntryId sourceType sourceId sourceKey createdAt"
  ),
  vehicleDocument: scalarSelect(
    "id vehicleId batchId policyId documentType documentStatus fileName originalName mimeType fileSize bucket objectKey title description effectiveFrom effectiveTo customerVisible createdAt updatedAt uploadedBy deletedAt"
  ),
  vehicleDocumentBatch: scalarSelect("id vehicleId documentType versionNo createdAt uploadedBy"),
  vehicleInsuranceCoverage: scalarSelect(
    "id policyId coverageType coverageName insuredAmount deductibleAmount remark createdAt updatedAt deletedAt"
  ),
  vehicleInsurancePolicy: scalarSelect(
    "id policyNo vehicleId policyType policyStatus insurerName policyHolderName insuredName effectiveFrom effectiveTo renewalReminderAt premiumAmount insuredAmount currency remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleListingMedia: scalarSelect(
    "id vehicleId listingProfileId fileName originalName mimeType fileSize bucket objectKey mediaCategory caption sortOrder isCover customerVisible uploadedBy createdAt updatedAt deletedAt"
  ),
  vehicleListingPlan: scalarSelect(
    "id vehicleId listingProfileId subscriptionPlanId visible recommended sortOrder displayMonthlyFeeAmount displayRemark createdAt updatedAt deletedAt"
  ),
  vehicleListingProfile: scalarSelect(
    "id vehicleId listingStatus portalVisible displayName shortTitle subtitle sellingPoints customerTags highlightSummary conditionGrade conditionSummary hasMajorAccident hasFloodDamage hasFireDamage hasStructuralDamage knownDefectsSummary batteryHealthPercent batteryHealthCheckedAt estimatedRangeKm batteryRemark serviceHighlights feeDescription applicationNotice faqSnapshot sortOrder publishedAt unpublishedAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleListingSourceBinding: scalarSelect(
    "id vehicleId section documentId createdAt createdBy updatedAt updatedBy"
  ),
  vehicleModelDefinition: scalarSelect(
    "id modelCode brand series modelName modelYear variantName displayName customerDisplayName energyType bodyType seatCount driveType batteryCapacityKwh officialRangeKm enabled portalVisible sortOrder remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleOwnershipPeriod: scalarSelect(
    "id vehicleId assetOwnerId startedAt endedAt startReason endReason startSourceType startSourceId startSourceKey endSourceType endSourceId endSourceKey startSnapshot endSnapshot startConfirmedBy startConfirmedAt endConfirmedBy endConfirmedAt createdAt updatedAt createdBy"
  ),
  vehiclePackage: scalarSelect(
    "id packageNo packageName productId productVersionId modelDefinitionId vehicleModelName brand series configName minPurchasePriceAmount maxPurchasePriceAmount monthlyFeeRate minPeriodMonths maxPeriodMonths status remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehiclePackageModelMember: scalarSelect(
    "id vehiclePackageId modelDefinitionId createdAt createdBy"
  ),
  vehicleSalePriceHistory: scalarSelect(
    "id vehicleId beforeSalePriceAmount afterSalePriceAmount reviewType reviewQuarter effectiveFrom effectiveTo reason remark createdAt createdBy"
  )
});

export const STAGE1_ACCEPTANCE_WHITELIST_DELEGATES = Object.freeze(Object.keys(SELECT).sort());

export async function loadStage1CleanAcceptanceSourceSnapshot(tx, inputSelection, options = {}) {
  const selection = parseStage1CleanAcceptanceSelection(inputSelection);
  const asOf = resolveAsOf(options.asOf);
  const evaluationDate = acceptanceEvaluationDate(asOf);
  const access = await loadAccess(tx);
  const customer = await loadCustomer(tx);
  const catalog = await loadCatalog(tx, evaluationDate);
  const templates = await loadTemplates(tx, asOf, evaluationDate);
  const vehicle = await loadVehicle(tx, selection.vehicleIds, asOf, evaluationDate, catalog);
  return { access, asOf, catalog, customer, evaluationDate, templates, vehicle };
}

export async function discoverStage1CleanAcceptanceVehicleCandidates(tx, options = {}) {
  const asOf = resolveAsOf(options.asOf);
  const evaluationDate = acceptanceEvaluationDate(asOf);
  const catalog = await loadCatalog(tx, evaluationDate);
  const { guardedWhere } = vehicleEligibilityFilters(
    asOf,
    evaluationDate,
    ids(catalog.subscriptionPlans)
  );
  const candidates = sortById(
    await tx.vehicle.findMany({
      select: { id: true, salePriceStatus: true, status: true },
      where: guardedWhere
    })
  );
  const unblocked = [];
  for (const candidate of candidates) {
    const blockers = await applicationBlockerCounts(tx, candidate.id, asOf);
    if (blockers.activeApplicationCount === 0 && blockers.activeReviewReservationCount === 0) {
      unblocked.push(candidate);
    }
  }
  return unblocked;
}

function resolveAsOf(value) {
  if (value === undefined) return new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("MANIFEST_CONTEXT_INVALID");
  }
  return new Date(value.getTime());
}

function acceptanceEvaluationDate(asOf) {
  return new Date(`${asOf.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

export async function countStage1CleanAcceptanceForbiddenDomains(tx) {
  return countDelegates(tx, STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES);
}

export async function loadStage1CleanAcceptanceTargetSnapshot(tx) {
  const tableCountKeys = [...STAGE1_ACCEPTANCE_WHITELIST_DELEGATES];
  const forbiddenCountKeys = [...STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES];
  const tableCounts = await countDelegates(tx, tableCountKeys);
  const forbiddenCounts = await countStage1CleanAcceptanceForbiddenDomains(tx);
  const migrationCatalog = sortMetadata(
    await tx.$queryRaw`
    SELECT
      "id" AS "id",
      "checksum" AS "checksum",
      "finished_at" AS "finishedAt",
      "migration_name" AS "migrationName",
      "rolled_back_at" AS "rolledBackAt",
      "started_at" AS "startedAt",
      "applied_steps_count" AS "appliedStepsCount"
    FROM "_prisma_migrations"
    WHERE "migration_name" LIKE ${"%"}
    ORDER BY "migration_name" ASC, "id" ASC
  `
  );
  const schemaFingerprint = await tx.$queryRaw`
    SELECT encode(
      sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
        'columnDefault', column_default,
        'columnName', column_name,
        'dataType', data_type,
        'isNullable', is_nullable,
        'ordinalPosition', ordinal_position,
        'tableName', table_name,
        'udtName', udt_name
      ) ORDER BY table_name ASC, ordinal_position ASC)::text, '[]'), 'UTF8')),
      'hex'
    ) AS "schemaFingerprintSha256"
    FROM information_schema.columns
    WHERE table_schema = ${"public"}
  `;
  const canonicalMigrationChecksums = await loadLocalMigrationChecksums();
  const schemaCanonical =
    exactCanonicalMigrationCatalog(migrationCatalog, canonicalMigrationChecksums) &&
    schemaFingerprint.length === 1 &&
    schemaFingerprint[0]?.schemaFingerprintSha256 ===
      STAGE1_ACCEPTANCE_CANONICAL_SCHEMA_FINGERPRINT_SHA256;
  return {
    forbiddenCountKeys,
    forbiddenCounts,
    migrationCatalog,
    schemaCanonical,
    schemaFingerprint,
    tableCountKeys,
    tableCounts
  };
}

async function loadAccess(tx) {
  const users = await find(tx, "user", {
    deletedAt: null,
    status: "ACTIVE",
    username: "keqi_119"
  });
  const roles = await find(tx, "role", {
    deletedAt: null,
    status: "ACTIVE"
  });
  const permissions = await find(tx, "permission", {
    deletedAt: null,
    status: "ACTIVE"
  });
  const menus = await find(tx, "menu", {
    deletedAt: null,
    status: "ACTIVE"
  });
  const roleIds = ids(roles);
  const userRoles = await find(tx, "userRole", {
    deletedAt: null,
    roleId: { in: roleIds },
    userId: { in: ids(users) }
  });
  const rolePermissions = await find(tx, "rolePermission", {
    deletedAt: null,
    permissionId: { in: ids(permissions) },
    roleId: { in: roleIds }
  });
  const roleMenus = await find(tx, "roleMenu", {
    deletedAt: null,
    menuId: { in: ids(menus) },
    roleId: { in: roleIds }
  });
  return { menus, permissions, roleMenus, rolePermissions, roles, userRoles, users };
}

async function loadCustomer(tx) {
  const candidateCustomerAccounts = await find(tx, "customerAccount", {
    accountStatus: "ACTIVE",
    deletedAt: null,
    phone: "18616570212"
  });
  const candidateCustomerIds = ids(candidateCustomerAccounts, "customerId");
  const candidateCustomers = await find(tx, "customer", {
    deletedAt: null,
    id: { in: candidateCustomerIds },
    status: "ACTIVE"
  });
  const activeCustomerIds = new Set(ids(candidateCustomers));
  const customerAccounts = candidateCustomerAccounts.filter((row) =>
    activeCustomerIds.has(row.customerId)
  );
  const selectedCustomerIds = ids(customerAccounts, "customerId");
  const customers = candidateCustomers.filter((row) => selectedCustomerIds.includes(row.id));
  const customerIdentities = await find(tx, "customerIdentity", {
    customerId: { in: selectedCustomerIds },
    deletedAt: null
  });
  const customerProfiles = await find(tx, "customerProfile", {
    customerId: { in: selectedCustomerIds },
    deletedAt: null
  });
  const customerESignProviderAccounts = await find(tx, "customerESignProviderAccount", {
    certBindingStatus: "BOUND",
    customerId: { in: selectedCustomerIds },
    deletedAt: null,
    OR: [{ providerOpenId: { not: "" } }, { providerCustomerId: { not: "" } }],
    realNameStatus: "VERIFIED",
    registrationStatus: "REGISTERED"
  });
  return {
    customerAccounts,
    customerESignProviderAccounts,
    customerIdentities,
    customerProfiles,
    customers
  };
}

async function loadCatalog(tx, asOf) {
  const subscriptionPlans = await find(tx, "subscriptionPlan", {
    deletedAt: null,
    effectiveFrom: { lte: asOf },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
    product: {
      deletedAt: null,
      productType: "SUBSCRIPTION",
      status: "ACTIVE"
    },
    productVersion: {
      deletedAt: null,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
      status: "ACTIVE"
    },
    status: "ACTIVE"
  });
  const productIds = ids(subscriptionPlans, "productId");
  const productVersionIds = ids(subscriptionPlans, "productVersionId");
  const products = await find(tx, "product", {
    deletedAt: null,
    id: { in: productIds },
    productType: "SUBSCRIPTION",
    status: "ACTIVE"
  });
  const productVersions = await find(tx, "productVersion", {
    deletedAt: null,
    effectiveFrom: { lte: asOf },
    id: { in: productVersionIds },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
    productId: { in: productIds },
    status: "ACTIVE"
  });
  const depositRules = await find(tx, "depositRule", {
    deletedAt: null,
    effectiveFrom: { lte: asOf },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
    status: "ACTIVE"
  });
  const vehiclePackages = await find(
    tx,
    "vehiclePackage",
    activeIds(ids(subscriptionPlans, "vehiclePackageId"))
  );
  const vehiclePackageModelMembers = await find(tx, "vehiclePackageModelMember", {
    vehiclePackageId: { in: ids(vehiclePackages) }
  });
  const mileagePackages = await find(
    tx,
    "mileagePackage",
    activeIds(ids(subscriptionPlans, "mileagePackageId"))
  );
  const energyPackages = await find(
    tx,
    "energyPackage",
    activeIds(ids(subscriptionPlans, "energyPackageId"))
  );
  const benefitPackages = await find(
    tx,
    "benefitPackage",
    activeIds(compactIds(subscriptionPlans, "benefitPackageId"))
  );
  const productPriceRules = await find(tx, "productPriceRule", {
    deletedAt: null,
    productVersionId: { in: ids(productVersions) },
    status: "ACTIVE"
  });
  return {
    benefitPackages,
    depositRules,
    energyPackages,
    mileagePackages,
    productPriceRules,
    productVersions,
    products,
    subscriptionPlans,
    vehiclePackageModelMembers,
    vehiclePackages
  };
}

async function loadTemplates(tx, asOf, evaluationDate) {
  const contractVersions = await find(tx, "contractVersion", {
    approvedAt: { lte: asOf },
    approvedBy: { not: null },
    businessType: "SUBSCRIPTION",
    deletedAt: null,
    effectiveFrom: { lte: evaluationDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: evaluationDate } }],
    status: "ACTIVE",
    templateType: { in: [...REQUIRED_CONTRACT_TEMPLATE_TYPES] }
  });
  const fileObjects = await find(tx, "fileObject", {
    id: { in: compactIds(contractVersions, "fileId") }
  });
  const notificationTemplates = await find(tx, "notificationTemplate", {
    deletedAt: null,
    templateCode: { in: [...REQUIRED_NOTIFICATION_TEMPLATE_CODES] },
    templateStatus: "ACTIVE"
  });
  return {
    contractVersions,
    fileObjects,
    notificationTemplates,
    requiredContractTemplateTypes: [...REQUIRED_CONTRACT_TEMPLATE_TYPES],
    requiredNotificationTemplateCodes: [...REQUIRED_NOTIFICATION_TEMPLATE_CODES]
  };
}

async function loadVehicle(tx, vehicleIds, asOf, evaluationDate, catalog) {
  const catalogPlanIds = ids(catalog.subscriptionPlans);
  const {
    activeAssetWorkOrderWhere,
    activeServiceCaseWhere,
    blockingRestrictionWhere,
    guardedWhere,
    historicalVehicleRelationWhere,
    overlappingSubscriptionPeriodWhere,
    currentCommercialPolicyWhere,
    currentCompulsoryTrafficPolicyWhere,
    currentVehicleLicenseWhere,
    visibleRetainedListingPlanWhere
  } = vehicleEligibilityFilters(asOf, evaluationDate, catalogPlanIds);
  const diagnostics = sortById(
    await tx.vehicle.findMany({
      select: {
        _count: {
          select: {
            assetWorkOrders: { where: activeAssetWorkOrderWhere },
            documents: { where: currentVehicleLicenseWhere },
            deliveries: { where: historicalVehicleRelationWhere },
            operationalRestrictions: { where: blockingRestrictionWhere },
            orders: { where: historicalVehicleRelationWhere },
            insurancePolicies: {
              where: {
                OR: [currentCommercialPolicyWhere, currentCompulsoryTrafficPolicyWhere]
              }
            },
            listingPlans: { where: visibleRetainedListingPlanWhere },
            returns: { where: historicalVehicleRelationWhere },
            serviceCases: { where: activeServiceCaseWhere },
            subscriptionPeriods: { where: overlappingSubscriptionPeriodWhere }
          }
        },
        currentSalePriceAmount: true,
        id: true,
        salePriceStatus: true,
        status: true
      },
      where: { id: { in: vehicleIds } }
    })
  );
  const guardedVehicles = sortById(
    await tx.vehicle.findMany({
      select: { id: true },
      where: {
        ...guardedWhere,
        id: { in: vehicleIds }
      }
    })
  );
  if (!sameIds(diagnostics, vehicleIds) || !sameIds(guardedVehicles, vehicleIds)) {
    throw new Error("VEHICLE_NOT_ELIGIBLE");
  }
  const applicationCounts = {};
  for (const vehicleId of vehicleIds) {
    applicationCounts[vehicleId] = await applicationBlockerCounts(tx, vehicleId, asOf);
    if (
      applicationCounts[vehicleId].activeApplicationCount !== 0 ||
      applicationCounts[vehicleId].activeReviewReservationCount !== 0
    ) {
      throw new Error("VEHICLE_NOT_ELIGIBLE");
    }
  }
  const vehicles = await find(tx, "vehicle", { id: { in: vehicleIds } });
  if (!sameIds(vehicles, vehicleIds)) throw new Error("VEHICLE_NOT_ELIGIBLE");
  const eligibilityEvidence = Object.fromEntries(
    diagnostics.map((row) => [
      row.id,
      {
        activeApplicationCount: applicationCounts[row.id].activeApplicationCount,
        activeAssetWorkOrderCount: row._count.assetWorkOrders,
        activeReviewReservationCount: applicationCounts[row.id].activeReviewReservationCount,
        activeServiceCaseCount: row._count.serviceCases,
        blockingRestrictionCount: row._count.operationalRestrictions,
        currentSalePricePositive: row.currentSalePriceAmount > 0,
        deliveryCount: row._count.deliveries,
        orderCount: row._count.orders,
        overlappingSubscriptionPeriodCount: row._count.subscriptionPeriods,
        currentCommercialPolicyCount: 0,
        currentCompulsoryTrafficPolicyCount: 0,
        currentLicenseCount: row._count.documents,
        requiredDocumentsAndInsuranceReady: guardedVehicles.some(({ id }) => id === row.id),
        returnCount: row._count.returns,
        salePriceStatusEffective: row.salePriceStatus === "EFFECTIVE",
        visibleRetainedListingPlanCount: row._count.listingPlans
      }
    ])
  );
  const vehicleOwnershipPeriods = await find(tx, "vehicleOwnershipPeriod", {
    endedAt: null,
    vehicleId: { in: vehicleIds }
  });
  const assetOwners = await find(tx, "assetOwner", {
    id: { in: ids(vehicleOwnershipPeriods, "assetOwnerId") },
    status: "ACTIVE"
  });
  const vehicleModelDefinitions = await find(tx, "vehicleModelDefinition", {
    deletedAt: null,
    enabled: true,
    id: {
      in: [
        ...new Set([...catalogModelDefinitionIds(catalog), ...ids(vehicles, "modelDefinitionId")])
      ].sort()
    },
    portalVisible: true
  });
  const vehicleListingProfiles = await find(tx, "vehicleListingProfile", {
    deletedAt: null,
    listingStatus: "PUBLISHED",
    portalVisible: true,
    vehicleId: { in: vehicleIds }
  });
  const vehicleListingMedia = await find(tx, "vehicleListingMedia", {
    customerVisible: true,
    deletedAt: null,
    listingProfileId: { in: ids(vehicleListingProfiles) },
    vehicleId: { in: vehicleIds }
  });
  const vehicleListingPlans = await find(tx, "vehicleListingPlan", {
    deletedAt: null,
    listingProfileId: { in: ids(vehicleListingProfiles) },
    subscriptionPlanId: { in: catalogPlanIds },
    visible: true,
    vehicleId: { in: vehicleIds }
  });
  const vehicleInsurancePolicies = await find(tx, "vehicleInsurancePolicy", {
    deletedAt: null,
    effectiveFrom: { lte: evaluationDate },
    effectiveTo: { gte: evaluationDate },
    policyStatus: "ACTIVE",
    policyType: { in: ["COMMERCIAL", "COMPULSORY_TRAFFIC"] },
    vehicleId: { in: vehicleIds }
  });
  const vehicleInsuranceCoverages = await find(tx, "vehicleInsuranceCoverage", {
    deletedAt: null,
    policyId: { in: ids(vehicleInsurancePolicies) }
  });
  for (const vehicleId of vehicleIds) {
    const policies = vehicleInsurancePolicies.filter((row) => row.vehicleId === vehicleId);
    eligibilityEvidence[vehicleId].currentCommercialPolicyCount = policies.filter(
      (row) => row.policyType === "COMMERCIAL"
    ).length;
    eligibilityEvidence[vehicleId].currentCompulsoryTrafficPolicyCount = policies.filter(
      (row) => row.policyType === "COMPULSORY_TRAFFIC"
    ).length;
  }
  const vehicleLicenseDocuments = await find(tx, "vehicleDocument", {
    AND: [
      { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: evaluationDate } }] },
      { OR: [{ effectiveTo: null }, { effectiveTo: { gte: evaluationDate } }] }
    ],
    customerVisible: true,
    deletedAt: null,
    documentStatus: "ACTIVE",
    documentType: "VEHICLE_LICENSE",
    vehicleId: { in: vehicleIds }
  });
  const insuranceDocumentReferences = vehicleInsurancePolicies.map((policy) => ({
    documentType:
      policy.policyType === "COMPULSORY_TRAFFIC"
        ? "COMPULSORY_INSURANCE_POLICY"
        : "COMMERCIAL_INSURANCE_POLICY",
    policyId: policy.id,
    vehicleId: policy.vehicleId
  }));
  const vehicleInsuranceDocuments = await find(tx, "vehicleDocument", {
    AND: [
      { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: evaluationDate } }] },
      { OR: [{ effectiveTo: null }, { effectiveTo: { gte: evaluationDate } }] }
    ],
    customerVisible: true,
    deletedAt: null,
    documentStatus: "ACTIVE",
    OR: insuranceDocumentReferences
  });
  const vehicleListingSourceBindings = await find(tx, "vehicleListingSourceBinding", {
    vehicleId: { in: vehicleIds }
  });
  const vehicleListingSourceDocuments = await find(tx, "vehicleDocument", {
    id: { in: ids(vehicleListingSourceBindings, "documentId") }
  });
  const vehicleDocuments = sortById(
    [
      ...vehicleLicenseDocuments,
      ...vehicleInsuranceDocuments,
      ...vehicleListingSourceDocuments
    ].filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index)
  );
  const vehicleDocumentBatches = await find(tx, "vehicleDocumentBatch", {
    id: { in: compactIds(vehicleDocuments, "batchId") }
  });
  const vehicleSalePriceHistories = await find(tx, "vehicleSalePriceHistory", {
    effectiveFrom: { lte: evaluationDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: evaluationDate } }],
    vehicleId: { in: vehicleIds }
  });
  const vehicleAssetCostProfiles = await find(tx, "vehicleAssetCostProfile", {
    deletedAt: null,
    profileStatus: "ACTIVE",
    vehicleId: { in: vehicleIds }
  });
  const vehicleCostLedgerEntries = await find(tx, "vehicleCostLedgerEntry", {
    vehicleId: { in: vehicleIds }
  });
  return {
    assetOwners,
    eligibilityEvidence,
    vehicleAssetCostProfiles,
    vehicleCostLedgerEntries,
    vehicleDocumentBatches,
    vehicleDocuments,
    vehicleInsuranceCoverages,
    vehicleInsurancePolicies,
    vehicleListingMedia,
    vehicleListingPlans,
    vehicleListingProfiles,
    vehicleListingSourceBindings,
    vehicleModelDefinitions,
    vehicleOwnershipPeriods,
    vehicleSalePriceHistories,
    vehicles
  };
}

function vehicleEligibilityFilters(asOf, evaluationDate, catalogPlanIds = []) {
  const activeAssetWorkOrderWhere = {
    status: { notIn: ["CANCELLED", "CLOSED"] }
  };
  const activeServiceCaseWhere = {
    caseStatus: { notIn: ["CANCELLED", "CLOSED", "RESOLVED"] },
    deletedAt: null
  };
  const blockingRestrictionWhere = {
    scopes: { has: "ALLOCATION" },
    severity: "BLOCKING",
    startedAt: { lte: asOf },
    status: "ACTIVE"
  };
  const overlappingSubscriptionPeriodWhere = {
    OR: [{ endedAt: null }, { endedAt: { gt: asOf } }],
    startedAt: { lte: asOf }
  };
  const historicalVehicleRelationWhere = { deletedAt: null };
  const currentVehicleLicenseWhere = {
    customerVisible: true,
    deletedAt: null,
    documentStatus: "ACTIVE",
    documentType: "VEHICLE_LICENSE",
    AND: [
      { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: evaluationDate } }] },
      { OR: [{ effectiveTo: null }, { effectiveTo: { gte: evaluationDate } }] }
    ]
  };
  const currentInsurancePolicyWhere = {
    coverages: { some: { deletedAt: null } },
    deletedAt: null,
    effectiveFrom: { lte: evaluationDate },
    effectiveTo: { gte: evaluationDate },
    policyStatus: "ACTIVE"
  };
  const currentCommercialPolicyWhere = {
    ...currentInsurancePolicyWhere,
    policyType: "COMMERCIAL"
  };
  const currentCompulsoryTrafficPolicyWhere = {
    ...currentInsurancePolicyWhere,
    policyType: "COMPULSORY_TRAFFIC"
  };
  const visibleRetainedListingPlanWhere = {
    deletedAt: null,
    subscriptionPlanId: { in: catalogPlanIds },
    visible: true
  };
  return {
    activeAssetWorkOrderWhere,
    activeServiceCaseWhere,
    blockingRestrictionWhere,
    guardedWhere: {
      assetWorkOrders: { none: activeAssetWorkOrderWhere },
      currentSalePriceAmount: { gt: 0 },
      deletedAt: null,
      deliveries: { none: historicalVehicleRelationWhere },
      documents: { some: currentVehicleLicenseWhere },
      AND: [
        { insurancePolicies: { some: currentCommercialPolicyWhere } },
        { insurancePolicies: { some: currentCompulsoryTrafficPolicyWhere } }
      ],
      listingProfile: {
        is: {
          deletedAt: null,
          listingStatus: "PUBLISHED",
          plans: { some: visibleRetainedListingPlanWhere },
          portalVisible: true
        }
      },
      modelDefinition: {
        is: { deletedAt: null, enabled: true, portalVisible: true }
      },
      operationalRestrictions: { none: blockingRestrictionWhere },
      orders: { none: historicalVehicleRelationWhere },
      returns: { none: historicalVehicleRelationWhere },
      salePriceStatus: "EFFECTIVE",
      serviceCases: { none: activeServiceCaseWhere },
      status: "AVAILABLE",
      subscriptionPeriods: { none: overlappingSubscriptionPeriodWhere }
    },
    historicalVehicleRelationWhere,
    overlappingSubscriptionPeriodWhere,
    currentCommercialPolicyWhere,
    currentCompulsoryTrafficPolicyWhere,
    currentVehicleLicenseWhere,
    visibleRetainedListingPlanWhere
  };
}

async function applicationBlockerCounts(tx, vehicleId, asOf) {
  const activeStatus = { notIn: ["CANCELLED", "REJECTED"] };
  const activeApplicationCount = await tx.application.count({
    where: {
      deletedAt: null,
      OR: [
        { finalVehicleId: vehicleId },
        { intentVehicleId: vehicleId },
        { softReservedVehicleId: vehicleId }
      ],
      status: activeStatus
    }
  });
  const activeReviewReservationCount = await tx.application.count({
    where: {
      deletedAt: null,
      softReservationExpiresAt: { gt: asOf },
      softReservedVehicleId: vehicleId,
      status: activeStatus,
      vehicleReviewStatus: { in: ["APPROVED", "NEED_MORE_INFO", "PENDING"] }
    }
  });
  return { activeApplicationCount, activeReviewReservationCount };
}

function exactCanonicalMigrationCatalog(applied, canonical) {
  if (!Array.isArray(canonical) || canonical.length === 0 || applied.length !== canonical.length) {
    return false;
  }
  const expected = new Map();
  for (const row of canonical) {
    if (
      typeof row?.migrationName !== "string" ||
      !/^[0-9a-f]{64}$/.test(row?.checksum ?? "") ||
      expected.has(row.migrationName)
    ) {
      return false;
    }
    expected.set(row.migrationName, row.checksum);
  }
  const seen = new Set();
  return applied.every((row) => {
    const name = row?.migrationName;
    if (typeof name !== "string" || seen.has(name)) return false;
    seen.add(name);
    return (
      expected.get(name) === row.checksum &&
      row.finishedAt != null &&
      row.rolledBackAt == null &&
      row.appliedStepsCount === 1
    );
  });
}

async function find(tx, delegate, where) {
  return sortById(await tx[delegate].findMany({ select: SELECT[delegate], where }));
}

async function countDelegates(tx, delegates) {
  const entries = [];
  for (const delegate of delegates) {
    const result = await tx[delegate].count({ select: { _all: true } });
    entries.push([delegate, result._all]);
  }
  return Object.fromEntries(entries);
}

function scalarSelect(value) {
  return Object.freeze(Object.fromEntries(value.split(" ").map((field) => [field, true])));
}

function activeIds(values) {
  return { deletedAt: null, id: { in: values }, status: "ACTIVE" };
}

function ids(rows, field = "id") {
  return [
    ...new Set(rows.map((row) => row?.[field]).filter((value) => typeof value === "string"))
  ].sort();
}

function compactIds(rows, field) {
  return ids(
    rows.filter((row) => row?.[field] !== null),
    field
  );
}

function catalogModelDefinitionIds(catalog) {
  return ids(
    [
      ...catalog.vehiclePackages,
      ...catalog.vehiclePackageModelMembers,
      ...catalog.productPriceRules
    ],
    "modelDefinitionId"
  );
}

function sameIds(rows, expectedIds) {
  return (
    rows.length === expectedIds.length && ids(rows).every((id, index) => id === expectedIds[index])
  );
}

function sortById(rows) {
  return [...rows].sort((left, right) =>
    String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
  );
}

function sortMetadata(rows) {
  return [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
