import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  countStage1CleanAcceptanceForbiddenDomains,
  loadStage1CleanAcceptanceSourceSnapshot,
  loadStage1CleanAcceptanceTargetSnapshot
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";

const VEHICLE_A = "11111111-1111-4111-8111-111111111111";

const REQUIRED_CONTRACT_TEMPLATE_TYPES = [
  "DELIVERY_HANDOVER",
  "SUBSCRIPTION_EXTENSION",
  "SUBSCRIPTION_STANDARD"
];

const REQUIRED_NOTIFICATION_TEMPLATE_CODES = [
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

const EXPECTED_FORBIDDEN_DELEGATES = [
  "customerVerificationCode",
  "smsSendLog",
  "fieldOperatorOtp",
  "fieldOperatorSession",
  "fieldOperatorAuditLog",
  "customerProfileMaterial",
  "customerFollowup",
  "application",
  "applicationMaterial",
  "applicationMaterialGroup",
  "applicationMaterialFile",
  "applicationActionLog",
  "riskResult",
  "subscriptionQuote",
  "subscriptionOrder",
  "subscriptionJourney",
  "subscriptionJourneyStep",
  "subscriptionJourneyJob",
  "subscriptionJourneyManualTask",
  "subscriptionJourneyEvent",
  "subscriptionJourneyException",
  "subscriptionJourneyOutbox",
  "orderEntitlementAccount",
  "orderEntitlementGrant",
  "orderEntitlementUsage",
  "receivableBill",
  "billingSchedule",
  "subscriptionAutomationJob",
  "paymentMandate",
  "debitAttempt",
  "paymentRecord",
  "paymentOrder",
  "paymentOrderItem",
  "paymentCallbackLog",
  "paymentWriteOff",
  "depositLedger",
  "collectionCase",
  "collectionCaseBill",
  "collectionAction",
  "serviceCase",
  "serviceCaseAttachment",
  "serviceCaseAction",
  "notificationRecord",
  "notificationEvent",
  "lease",
  "vehicleDelivery",
  "vehicleDeliveryHandover",
  "vehicleHandoverWorkOrder",
  "vehicleHandoverWorkflowJob",
  "vehicleHandoverReviewAttempt",
  "vehicleHandoverEvent",
  "vehicleDeliveryEvidenceItem",
  "vehicleDeliveryEvidenceFile",
  "fieldEvidenceVideoUploadSession",
  "fieldEvidenceVideoUploadPart",
  "vehicleInspection",
  "vehicleReturn",
  "vehicleReturnDamage",
  "contract",
  "contractESignTask",
  "contractESignSigner",
  "contractESignCallbackLog",
  "subscriptionChangeOrder",
  "subscriptionExtensionChangeDetail",
  "subscriptionVehicleSwapChangeDetail",
  "subscriptionEarlyTerminationChangeDetail",
  "subscriptionManagedOtherChangeDetail",
  "subscriptionChangeQuote",
  "subscriptionChangeCommand",
  "subscriptionContractSegment",
  "renewalConsideration",
  "renewalReminder",
  "orderChange",
  "subscriptionClosureCase",
  "subscriptionClosureEvent",
  "subscriptionClosureDocumentRevision",
  "subscriptionClosureCurrentDocument",
  "subscriptionClosureSettlementRevision",
  "vehicleReturnChecklistRevision",
  "vehicleReturnChecklistItem",
  "vehicleReturnEvidenceLink",
  "vehicleConditionDeltaRevision",
  "vehicleConditionDeltaItem",
  "contractChargeClauseSnapshot",
  "subscriptionClosureChargeLine",
  "subscriptionClosureCustomerResponse",
  "subscriptionClosureChargeDispute",
  "subscriptionClosureChargeDisputeDecision",
  "subscriptionClosureReceivableDisposition",
  "subscriptionClosureLegalCollectionCase",
  "subscriptionClosureLegalCollectionEvent",
  "subscriptionClosureEvidencePackageExport",
  "subscriptionClosureCommandReceipt",
  "assetAccountingCommandReceipt",
  "vehicleSubscriptionPeriod",
  "vehicleConditionReport",
  "vehicleConditionReportItem",
  "vehicleMileageReading",
  "orderMileageReview",
  "orderMileageReviewEvidence",
  "assetWorkOrder",
  "assetWorkOrderEvent",
  "assetWorkOrderEvidence",
  "vehicleOperationalRestriction",
  "businessExceptionApproval",
  "insuranceClaim",
  "vehicleBaasContract",
  "vehicleBaasContractAttachment",
  "vehicleBaasCostRecord",
  "vehicleDepreciationPolicy",
  "vehicleDepreciationSchedule",
  "vehicleDepreciationRecord",
  "marketPriceImportBatch",
  "vehicleMarketPriceObservation",
  "vehicleResidualCurve",
  "vehicleResidualCurvePoint",
  "vehicleResidualForecast",
  "vehicleResidualForecastPoint",
  "vehicleValuationReview",
  "residualModelRun",
  "residualModelRunOutput",
  "vehicleCapitalEvent",
  "financingInstrument",
  "financingInstrumentVehicle",
  "vehicleAssetPool",
  "vehicleAssetPoolVehicle",
  "revenueRightAssignment",
  "revenueShareRule",
  "auditLog"
];

const SOURCE_SCALAR_FIELDS = Object.freeze({
  assetOwner: fields("id ownerNo name legalName registrationIdentifier ownerType status onboardingSnapshot createdAt updatedAt createdBy updatedBy"),
  benefitPackage: fields("id packageNo packageName productId productVersionId benefitType benefitCount priceAmount description status remark createdAt updatedAt createdBy updatedBy deletedAt"),
  contractVersion: fields("id templateName versionNo businessType templateType contentTemplate fileId effectiveFrom effectiveTo status approvedBy approvedAt createdAt updatedAt createdBy updatedBy deletedAt"),
  customer: fields("id customerNo name mobile customerType sourceChannel grade riskScore status ownerUserId remark createdAt updatedAt createdBy updatedBy deletedAt"),
  customerAccount: fields("id customerId phone phoneVerifiedAt wechatOpenId wechatUnionId accountStatus lastLoginAt lastLoginIp lastUserAgent createdAt updatedAt createdBy updatedBy deletedAt"),
  customerESignProviderAccount: fields("id customerId provider accountType source providerOpenId providerCustomerId registrationStatus realNameStatus verificationSerialNo verificationTransactionNo verifiedAt realNameProviderStatus realNameProviderStatusSource realNameProviderVerifiedAt certBindingStatus certBindingSource certBoundAt certSerialNo providerStatusLastRefreshedAt readinessBlockingCode readinessBlockingReason lastErrorCode lastErrorMessage providerSnapshot createdAt updatedAt createdBy updatedBy deletedAt"),
  customerIdentity: fields("id customerId idCardNo idCardFrontFileId idCardBackFileId driverLicenseNo driverLicenseFileId licenseValidUntil realnameVerified verifiedAt createdAt updatedAt createdBy updatedBy deletedAt"),
  customerProfile: fields("id customerId occupation companyName monthlyIncomeAmount socialSecurityMonths housingFundMonths residenceAddress residenceProvince residenceCity residenceDistrict residenceDetail emergencyContactName emergencyContactMobile createdAt updatedAt createdBy updatedBy deletedAt"),
  depositRule: fields("id grade depositAmount customerRatio defaultRate effectiveFrom effectiveTo status createdAt updatedAt createdBy updatedBy deletedAt"),
  energyPackage: fields("id packageNo packageName productId productVersionId monthlyEnergyKwh monthlyEnergyCount priceAmount stationScope serviceDescription status remark createdAt updatedAt createdBy updatedBy deletedAt"),
  fileObject: fields("id bucket objectKey originalName mimeType sizeBytes contentSha256 uploadedBy createdAt"),
  menu: fields("id code name path icon sortOrder permissionCode parentId status createdAt updatedAt createdBy updatedBy deletedAt"),
  mileagePackage: fields("id packageNo packageName productId productVersionId monthlyMileageKm overMileageFeeAmount priceAmount status remark createdAt updatedAt createdBy updatedBy deletedAt"),
  notificationTemplate: fields("id templateCode channel templateType templateStatus title description providerTemplateId content variables providerConfig createdAt updatedAt createdBy updatedBy deletedAt"),
  permission: fields("id code name module action description status createdAt updatedAt createdBy updatedBy deletedAt"),
  product: fields("id productNo name productType status description createdAt updatedAt createdBy updatedBy deletedAt"),
  productPriceRule: fields("id productVersionId modelDefinitionId monthlyFeeRate minPeriodMonths maxPeriodMonths baseMileageKm overMileageFeeAmount energyLimitKwh energyLimitCount status createdAt updatedAt createdBy updatedBy deletedAt"),
  productVersion: fields("id productId versionNo effectiveFrom effectiveTo status approvedBy approvedAt createdAt updatedAt createdBy updatedBy deletedAt"),
  role: fields("id code name description status createdAt updatedAt createdBy updatedBy deletedAt"),
  roleMenu: fields("id roleId menuId createdAt createdBy deletedAt"),
  rolePermission: fields("id roleId permissionId createdAt createdBy deletedAt"),
  subscriptionPlan: fields("id planNo planName productId productVersionId vehiclePackageId mileagePackageId energyPackageId benefitPackageId monthlyFeeMode baseMonthlyFeeAmount monthlyFeeRate monthlyFeeCapRate minPeriodMonths maxPeriodMonths status effectiveFrom effectiveTo remark createdAt updatedAt createdBy updatedBy deletedAt"),
  user: fields("id username name mobile email passwordHash status lastLoginAt createdAt updatedAt createdBy updatedBy deletedAt"),
  userRole: fields("id userId roleId createdAt createdBy deletedAt"),
  vehicle: fields("id vehicleNo vin plateNo brand series model modelYear modelDefinitionId batteryCapacityKwh batteryUsageType acquisitionMode purchasePriceAmount purchaseDate currentSalePriceAmount currentSalePriceInitializedAt currentSalePriceReviewedAt nextSalePriceReviewAt salePriceReinitRequiredAt salePriceStatus registrationDate latestRegistrationDate status currentMileageKm assetLocation remark createdAt updatedAt createdBy updatedBy deletedAt"),
  vehicleAssetCostProfile: fields("id vehicleId profileStatus depreciationMethod depreciationStartDate usefulLifeMonths residualValueAmount capitalCostRateBps annualInsuranceCostAmount annualMaintenanceReserveAmount otherMonthlyCostAmount remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"),
  vehicleCostLedgerEntry: fields("id vehicleId orderId contractId customerId assetOwnerId workOrderId evidenceId assetOwnerSnapshot evidenceSnapshot responsibilitySnapshot entryKind actionType costCategory amountCents responsiblePartyType responsiblePartyId occurredOn accountingPeriod confirmedAt confirmedBy reversalOfEntryId sourceType sourceId sourceKey createdAt"),
  vehicleDocument: fields("id vehicleId batchId policyId documentType documentStatus fileName originalName mimeType fileSize bucket objectKey title description effectiveFrom effectiveTo customerVisible createdAt updatedAt uploadedBy deletedAt"),
  vehicleDocumentBatch: fields("id vehicleId documentType versionNo createdAt uploadedBy"),
  vehicleInsuranceCoverage: fields("id policyId coverageType coverageName insuredAmount deductibleAmount remark createdAt updatedAt deletedAt"),
  vehicleInsurancePolicy: fields("id policyNo vehicleId policyType policyStatus insurerName policyHolderName insuredName effectiveFrom effectiveTo renewalReminderAt premiumAmount insuredAmount currency remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"),
  vehicleListingMedia: fields("id vehicleId listingProfileId fileName originalName mimeType fileSize bucket objectKey mediaCategory caption sortOrder isCover customerVisible uploadedBy createdAt updatedAt deletedAt"),
  vehicleListingPlan: fields("id vehicleId listingProfileId subscriptionPlanId visible recommended sortOrder displayMonthlyFeeAmount displayRemark createdAt updatedAt deletedAt"),
  vehicleListingProfile: fields("id vehicleId listingStatus portalVisible displayName shortTitle subtitle sellingPoints customerTags highlightSummary conditionGrade conditionSummary hasMajorAccident hasFloodDamage hasFireDamage hasStructuralDamage knownDefectsSummary batteryHealthPercent batteryHealthCheckedAt estimatedRangeKm batteryRemark serviceHighlights feeDescription applicationNotice faqSnapshot sortOrder publishedAt unpublishedAt createdAt updatedAt createdBy updatedBy deletedAt"),
  vehicleListingSourceBinding: fields("id vehicleId section documentId createdAt createdBy updatedAt updatedBy"),
  vehicleModelDefinition: fields("id modelCode brand series modelName modelYear variantName displayName customerDisplayName energyType bodyType seatCount driveType batteryCapacityKwh officialRangeKm enabled portalVisible sortOrder remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"),
  vehicleOwnershipPeriod: fields("id vehicleId assetOwnerId startedAt endedAt startReason endReason startSourceType startSourceId startSourceKey endSourceType endSourceId endSourceKey startSnapshot endSnapshot startConfirmedBy startConfirmedAt endConfirmedBy endConfirmedAt createdAt updatedAt createdBy"),
  vehiclePackage: fields("id packageNo packageName productId productVersionId modelDefinitionId vehicleModelName brand series configName minPurchasePriceAmount maxPurchasePriceAmount monthlyFeeRate minPeriodMonths maxPeriodMonths status remark createdAt updatedAt createdBy updatedBy deletedAt"),
  vehiclePackageModelMember: fields("id vehiclePackageId modelDefinitionId createdAt createdBy"),
  vehicleSalePriceHistory: fields("id vehicleId beforeSalePriceAmount afterSalePriceAmount reviewType reviewQuarter effectiveFrom effectiveTo reason remark createdAt createdBy")
});

const SOURCE_DELEGATES = Object.freeze(Object.keys(SOURCE_SCALAR_FIELDS));

test("source loader uses complete explicit scalar selects and fixed whitelist filters", async () => {
  const fake = createPrismaFake();
  const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(fake.tx, selection([]));

  assert.ok(snapshot.asOf instanceof Date);
  assert.deepEqual(snapshot.templates.requiredContractTemplateTypes, REQUIRED_CONTRACT_TEMPLATE_TYPES);
  assert.deepEqual(snapshot.templates.requiredNotificationTemplateCodes, REQUIRED_NOTIFICATION_TEMPLATE_CODES);
  assert.deepEqual(Object.keys(snapshot.vehicle.eligibilityEvidence), []);

  const findCalls = fake.calls.filter(({ operation }) => operation === "findMany");
  assert.deepEqual([...new Set(findCalls.map(({ delegate }) => delegate))].sort(), [...SOURCE_DELEGATES].sort());
  assert.equal(fake.calls.some(({ delegate }) => EXPECTED_FORBIDDEN_DELEGATES.includes(delegate)), false);
  assert.equal(fake.calls.some(({ operation }) => operation.startsWith("$execute") || operation === "$queryRaw"), false);

  for (const call of findCalls) {
    assert.equal(hasKeyDeep(call.args, "include"), false, `${call.delegate} must not use include`);
    assert.ok(call.args.select && typeof call.args.select === "object", `${call.delegate} requires select`);
    if (call.delegate !== "vehicle") {
      assert.deepEqual(Object.keys(call.args.select).sort(), SOURCE_SCALAR_FIELDS[call.delegate]);
    }
  }

  const vehicleCalls = findCalls.filter(({ delegate }) => delegate === "vehicle");
  assert.equal(vehicleCalls.length, 3);
  assert.deepEqual(Object.keys(vehicleCalls[0].args.select).sort(), ["_count", "currentSalePriceAmount", "id", "salePriceStatus", "status"]);
  assert.deepEqual(Object.keys(vehicleCalls[1].args.select).sort(), ["id"]);
  assert.deepEqual(Object.keys(vehicleCalls[2].args.select).sort(), SOURCE_SCALAR_FIELDS.vehicle);
  assert.equal(hasKeyDeep(vehicleCalls[0].args.select, "vin"), false);
  assert.equal(hasKeyDeep(vehicleCalls[0].args.select, "plateNo"), false);

  assert.deepEqual(findCall(fake, "user").args.where, {
    deletedAt: null,
    status: "ACTIVE",
    username: "keqi_119"
  });
  assert.deepEqual(findCall(fake, "customerAccount").args.where, {
    accountStatus: "ACTIVE",
    deletedAt: null,
    phone: "18616570212"
  });
  const planWhere = findCall(fake, "subscriptionPlan").args.where;
  assert.equal(planWhere.status, "ACTIVE");
  assert.equal(planWhere.deletedAt, null);
  assert.ok(planWhere.effectiveFrom.lte instanceof Date);
  assert.equal(planWhere.product.productType, "SUBSCRIPTION");
  assert.equal(planWhere.product.status, "ACTIVE");
  assert.equal(planWhere.productVersion.status, "ACTIVE");
  assert.equal(planWhere.effectiveFrom.lte, snapshot.asOf);

  const contractWhere = findCall(fake, "contractVersion").args.where;
  assert.deepEqual(contractWhere.templateType.in, REQUIRED_CONTRACT_TEMPLATE_TYPES);
  assert.equal(contractWhere.approvedAt.lte, snapshot.asOf);
  assert.equal(contractWhere.effectiveFrom.lte, snapshot.asOf);
  const notificationWhere = findCall(fake, "notificationTemplate").args.where;
  assert.deepEqual(notificationWhere.templateCode.in, REQUIRED_NOTIFICATION_TEMPLATE_CODES);
  assert.equal(notificationWhere.templateStatus, "ACTIVE");
});

test("vehicle eligibility evidence mirrors allocation blockers and rejects partial selections", async () => {
  const vehicleRow = completeVehicleRow();
  const eligible = createPrismaFake({
    rows: {
      vehicle: ({ callIndex }) =>
        callIndex === 0
          ? [{
              _count: { operationalRestrictions: 0, subscriptionPeriods: 0 },
              currentSalePriceAmount: 12000000n,
              id: VEHICLE_A,
              salePriceStatus: "EFFECTIVE",
              status: "AVAILABLE"
            }]
          : callIndex === 1
            ? [{ id: VEHICLE_A }]
            : [vehicleRow]
    }
  });
  const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(eligible.tx, selection([VEHICLE_A]));
  assert.deepEqual(snapshot.vehicle.vehicles, [vehicleRow]);
  assert.deepEqual(snapshot.vehicle.eligibilityEvidence, {
    [VEHICLE_A]: {
      blockingRestrictionCount: 0,
      currentSalePricePositive: true,
      overlappingSubscriptionPeriodCount: 0,
      salePriceStatusEffective: true
    }
  });
  const [diagnostic, guarded] = eligible.calls.filter(
    ({ delegate, operation }) => delegate === "vehicle" && operation === "findMany"
  );
  assert.deepEqual(diagnostic.args.select._count.select.operationalRestrictions.where, {
    scopes: { has: "ALLOCATION" },
    severity: "BLOCKING",
    startedAt: { lte: snapshot.asOf },
    status: "ACTIVE"
  });
  assert.deepEqual(diagnostic.args.select._count.select.subscriptionPeriods.where, {
    OR: [{ endedAt: null }, { endedAt: { gt: snapshot.asOf } }],
    startedAt: { lte: snapshot.asOf }
  });
  assert.deepEqual(guarded.args.where.operationalRestrictions, {
    none: diagnostic.args.select._count.select.operationalRestrictions.where
  });
  assert.deepEqual(guarded.args.where.subscriptionPeriods, {
    none: diagnostic.args.select._count.select.subscriptionPeriods.where
  });

  const partial = createPrismaFake({
    rows: {
      vehicle: ({ callIndex }) =>
        callIndex === 0
          ? [
              {
                _count: { operationalRestrictions: 0, subscriptionPeriods: 0 },
                currentSalePriceAmount: 12000000n,
                id: VEHICLE_A,
                salePriceStatus: "EFFECTIVE",
                status: "AVAILABLE"
              },
              {
                _count: { operationalRestrictions: 1, subscriptionPeriods: 0 },
                currentSalePriceAmount: 12000000n,
                id: "22222222-2222-4222-8222-222222222222",
                salePriceStatus: "EFFECTIVE",
                status: "AVAILABLE"
              }
            ]
          : callIndex === 1
            ? [{ id: VEHICLE_A }]
            : []
    }
  });
  await assert.rejects(
    loadStage1CleanAcceptanceSourceSnapshot(
      partial.tx,
      selection([VEHICLE_A, "22222222-2222-4222-8222-222222222222"])
    ),
    (error) => error?.message === "VEHICLE_NOT_ELIGIBLE"
  );
  assert.equal(partial.calls.filter(({ delegate }) => delegate === "vehicle").length, 2);
});

test("target loader counts exact whitelist and forbidden delegates with parameterized fingerprints", async () => {
  assert.deepEqual(STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES, EXPECTED_FORBIDDEN_DELEGATES);
  assert.equal(Object.isFrozen(STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES), true);

  const fake = createPrismaFake({
    counts: { auditLog: 0, customer: 2, subscriptionOrder: 3, vehicle: 1 },
    rawResults: [
      [{ appliedStepsCount: 1, checksum: "checksum-a", finishedAt: new Date("2026-08-30T00:00:00.000Z"), id: "migration-a", migrationName: "20260830000000_acceptance", rolledBackAt: null, startedAt: new Date("2026-08-30T00:00:00.000Z") }],
      [{ columnDefault: null, columnName: "id", dataType: "uuid", isNullable: "NO", ordinalPosition: 1, tableName: "user", udtName: "uuid" }]
    ]
  });
  const target = await loadStage1CleanAcceptanceTargetSnapshot(fake.tx);

  assert.deepEqual(target.forbiddenCountKeys, EXPECTED_FORBIDDEN_DELEGATES);
  assert.deepEqual(Object.keys(target.forbiddenCounts), EXPECTED_FORBIDDEN_DELEGATES);
  assert.equal(target.forbiddenCounts.subscriptionOrder, 3);
  assert.deepEqual(target.tableCountKeys, [...SOURCE_DELEGATES].sort());
  assert.deepEqual(Object.keys(target.tableCounts), [...SOURCE_DELEGATES].sort());
  assert.equal(target.tableCounts.customer, 2);
  assert.equal(target.tableCounts.vehicle, 1);
  assert.equal(target.schemaCanonical, true);
  assert.equal(target.migrationCatalog[0].migrationName, "20260830000000_acceptance");
  assert.equal(target.schemaFingerprint[0].tableName, "user");

  const countCalls = fake.calls.filter(({ operation }) => operation === "count");
  assert.deepEqual([...new Set(countCalls.map(({ delegate }) => delegate))].sort(), [
    ...new Set([...SOURCE_DELEGATES, ...EXPECTED_FORBIDDEN_DELEGATES])
  ].sort());
  assert.ok(countCalls.every(({ args }) => assert.deepEqual(args, { select: { _all: true } }) === undefined));

  const rawCalls = fake.calls.filter(({ operation }) => operation === "$queryRaw");
  assert.equal(rawCalls.length, 2);
  assert.ok(rawCalls.every(({ strings }) => Array.isArray(strings) && Array.isArray(strings.raw)));
  assert.deepEqual(rawCalls.map(({ values }) => values), [["%"], ["public"]]);
  assert.equal(rawCalls.some(({ strings }) => strings.join("?").includes("SELECT *")), false);
  assert.equal(fake.calls.some(({ operation }) => operation.startsWith("create") || operation.startsWith("update") || operation.startsWith("delete") || operation === "$executeRaw"), false);

  const forbiddenOnly = createPrismaFake({ counts: { auditLog: 1 } });
  const forbiddenCounts = await countStage1CleanAcceptanceForbiddenDomains(forbiddenOnly.tx);
  assert.deepEqual(Object.keys(forbiddenCounts), EXPECTED_FORBIDDEN_DELEGATES);
  assert.equal(forbiddenCounts.auditLog, 1);
  assert.equal(forbiddenOnly.calls.length, EXPECTED_FORBIDDEN_DELEGATES.length);
});

function fields(value) {
  return value.split(" ").sort();
}

function selection(vehicleIds) {
  return {
    adminUsername: "keqi_119",
    customerPhone: "18616570212",
    vehicleIds
  };
}

function createPrismaFake({ counts = {}, rawResults = [], rows = {} } = {}) {
  const calls = [];
  const tx = {};
  const delegates = new Set([...SOURCE_DELEGATES, ...EXPECTED_FORBIDDEN_DELEGATES]);
  for (const delegate of delegates) {
    let findManyCallIndex = 0;
    tx[delegate] = {
      async count(args) {
        calls.push({ args, delegate, operation: "count" });
        return { _all: counts[delegate] ?? 0 };
      },
      async findMany(args) {
        const callIndex = findManyCallIndex++;
        calls.push({ args, callIndex, delegate, operation: "findMany" });
        const result = rows[delegate];
        return structuredClone(typeof result === "function" ? result({ args, callIndex }) : result ?? []);
      }
    };
  }
  let rawIndex = 0;
  tx.$queryRaw = async (strings, ...values) => {
    calls.push({ operation: "$queryRaw", strings, values });
    return structuredClone(rawResults[rawIndex++] ?? []);
  };
  return { calls, tx };
}

function findCall(fake, delegate) {
  const call = fake.calls.find((item) => item.delegate === delegate && item.operation === "findMany");
  assert.ok(call, `missing ${delegate}.findMany`);
  return call;
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasKeyDeep(item, key));
}

function completeVehicleRow() {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    acquisitionMode: "OWNED_CASH",
    assetLocation: "Shanghai",
    batteryCapacityKwh: null,
    batteryUsageType: "BUYOUT",
    brand: "NIO",
    createdAt,
    createdBy: null,
    currentMileageKm: 1000,
    currentSalePriceAmount: 12000000n,
    currentSalePriceInitializedAt: createdAt,
    currentSalePriceReviewedAt: createdAt,
    deletedAt: null,
    id: VEHICLE_A,
    latestRegistrationDate: createdAt,
    model: "ET5",
    modelDefinitionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelYear: 2026,
    nextSalePriceReviewAt: createdAt,
    plateNo: "沪A12345",
    purchaseDate: createdAt,
    purchasePriceAmount: 15000000n,
    registrationDate: createdAt,
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: "EFFECTIVE",
    series: "ET5",
    status: "AVAILABLE",
    updatedAt: createdAt,
    updatedBy: null,
    vehicleNo: "VEH-001",
    vin: "LJ1TESTVIN0000001"
  };
}
