import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE1_ACCEPTANCE_CANONICAL_SCHEMA_FINGERPRINT_SHA256,
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  countStage1CleanAcceptanceForbiddenDomains,
  discoverStage1CleanAcceptanceVehicleCandidates,
  loadStage1CleanAcceptanceSourceSnapshot,
  loadStage1CleanAcceptanceTargetSnapshot
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";
import { loadLocalMigrationChecksums } from "./prisma-migration-checksums.mjs";

const CANONICAL_MIGRATIONS = await loadLocalMigrationChecksums();

function appliedMigrationRows(migrations = CANONICAL_MIGRATIONS) {
  return migrations.map((row, index) => ({
    appliedStepsCount: 1,
    checksum: row.checksum,
    finishedAt: new Date("2026-08-30T00:00:00.000Z"),
    id: `migration-${String(index).padStart(3, "0")}`,
    migrationName: row.migrationName,
    rolledBackAt: null,
    startedAt: new Date("2026-08-30T00:00:00.000Z")
  }));
}

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
  assetOwner: fields(
    "id ownerNo name legalName registrationIdentifier ownerType status onboardingSnapshot createdAt updatedAt createdBy updatedBy"
  ),
  benefitPackage: fields(
    "id packageNo packageName productId productVersionId benefitType benefitCount priceAmount description status remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  contractVersion: fields(
    "id templateName versionNo businessType templateType contentTemplate fileId effectiveFrom effectiveTo status approvedBy approvedAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customer: fields(
    "id customerNo name mobile customerType sourceChannel grade riskScore status ownerUserId remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customerAccount: fields(
    "id customerId phone phoneVerifiedAt wechatOpenId wechatUnionId accountStatus lastLoginAt lastLoginIp lastUserAgent createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customerESignProviderAccount: fields(
    "id customerId provider accountType source providerOpenId providerCustomerId registrationStatus realNameStatus verificationSerialNo verificationTransactionNo verifiedAt realNameProviderStatus realNameProviderStatusSource realNameProviderVerifiedAt certBindingStatus certBindingSource certBoundAt certSerialNo providerStatusLastRefreshedAt readinessBlockingCode readinessBlockingReason lastErrorCode lastErrorMessage providerSnapshot createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customerIdentity: fields(
    "id customerId idCardNo idCardFrontFileId idCardBackFileId driverLicenseNo driverLicenseFileId licenseValidUntil realnameVerified verifiedAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  customerProfile: fields(
    "id customerId occupation companyName monthlyIncomeAmount socialSecurityMonths housingFundMonths residenceAddress residenceProvince residenceCity residenceDistrict residenceDetail emergencyContactName emergencyContactMobile createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  depositRule: fields(
    "id grade depositAmount customerRatio defaultRate effectiveFrom effectiveTo status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  energyPackage: fields(
    "id packageNo packageName productId productVersionId monthlyEnergyKwh monthlyEnergyCount priceAmount stationScope serviceDescription status remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  fileObject: fields(
    "id bucket objectKey originalName mimeType sizeBytes contentSha256 uploadedBy createdAt"
  ),
  menu: fields(
    "id code name path icon sortOrder permissionCode parentId status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  mileagePackage: fields(
    "id packageNo packageName productId productVersionId monthlyMileageKm overMileageFeeAmount priceAmount status remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  notificationTemplate: fields(
    "id templateCode channel templateType templateStatus title description providerTemplateId content variables providerConfig createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  permission: fields(
    "id code name module action description status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  product: fields(
    "id productNo name productType status description createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  productPriceRule: fields(
    "id productVersionId modelDefinitionId monthlyFeeRate minPeriodMonths maxPeriodMonths baseMileageKm overMileageFeeAmount energyLimitKwh energyLimitCount status createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  productVersion: fields(
    "id productId versionNo effectiveFrom effectiveTo status approvedBy approvedAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  role: fields("id code name description status createdAt updatedAt createdBy updatedBy deletedAt"),
  roleMenu: fields("id roleId menuId createdAt createdBy deletedAt"),
  rolePermission: fields("id roleId permissionId createdAt createdBy deletedAt"),
  subscriptionPlan: fields(
    "id planNo planName productId productVersionId vehiclePackageId mileagePackageId energyPackageId benefitPackageId monthlyFeeMode baseMonthlyFeeAmount monthlyFeeRate monthlyFeeCapRate minPeriodMonths maxPeriodMonths status effectiveFrom effectiveTo remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  user: fields(
    "id username name mobile email passwordHash status lastLoginAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  userRole: fields("id userId roleId createdAt createdBy deletedAt"),
  vehicle: fields(
    "id vehicleNo vin plateNo brand series model modelYear modelDefinitionId batteryCapacityKwh batteryUsageType acquisitionMode purchasePriceAmount purchaseDate currentSalePriceAmount currentSalePriceInitializedAt currentSalePriceReviewedAt nextSalePriceReviewAt salePriceReinitRequiredAt salePriceStatus registrationDate latestRegistrationDate status currentMileageKm assetLocation remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleAssetCostProfile: fields(
    "id vehicleId profileStatus depreciationMethod depreciationStartDate usefulLifeMonths residualValueAmount capitalCostRateBps annualInsuranceCostAmount annualMaintenanceReserveAmount otherMonthlyCostAmount remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleCostLedgerEntry: fields(
    "id vehicleId orderId contractId customerId assetOwnerId workOrderId evidenceId assetOwnerSnapshot evidenceSnapshot responsibilitySnapshot entryKind actionType costCategory amountCents responsiblePartyType responsiblePartyId occurredOn accountingPeriod confirmedAt confirmedBy reversalOfEntryId sourceType sourceId sourceKey createdAt"
  ),
  vehicleDocument: fields(
    "id vehicleId batchId policyId documentType documentStatus fileName originalName mimeType fileSize bucket objectKey title description effectiveFrom effectiveTo customerVisible createdAt updatedAt uploadedBy deletedAt"
  ),
  vehicleDocumentBatch: fields("id vehicleId documentType versionNo createdAt uploadedBy"),
  vehicleInsuranceCoverage: fields(
    "id policyId coverageType coverageName insuredAmount deductibleAmount remark createdAt updatedAt deletedAt"
  ),
  vehicleInsurancePolicy: fields(
    "id policyNo vehicleId policyType policyStatus insurerName policyHolderName insuredName effectiveFrom effectiveTo renewalReminderAt premiumAmount insuredAmount currency remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleListingMedia: fields(
    "id vehicleId listingProfileId fileName originalName mimeType fileSize bucket objectKey mediaCategory caption sortOrder isCover customerVisible uploadedBy createdAt updatedAt deletedAt"
  ),
  vehicleListingPlan: fields(
    "id vehicleId listingProfileId subscriptionPlanId visible recommended sortOrder displayMonthlyFeeAmount displayRemark createdAt updatedAt deletedAt"
  ),
  vehicleListingProfile: fields(
    "id vehicleId listingStatus portalVisible displayName shortTitle subtitle sellingPoints customerTags highlightSummary conditionGrade conditionSummary hasMajorAccident hasFloodDamage hasFireDamage hasStructuralDamage knownDefectsSummary batteryHealthPercent batteryHealthCheckedAt estimatedRangeKm batteryRemark serviceHighlights feeDescription applicationNotice faqSnapshot sortOrder publishedAt unpublishedAt createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleListingSourceBinding: fields(
    "id vehicleId section documentId createdAt createdBy updatedAt updatedBy"
  ),
  vehicleModelDefinition: fields(
    "id modelCode brand series modelName modelYear variantName displayName customerDisplayName energyType bodyType seatCount driveType batteryCapacityKwh officialRangeKm enabled portalVisible sortOrder remark snapshot createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehicleOwnershipPeriod: fields(
    "id vehicleId assetOwnerId startedAt endedAt startReason endReason startSourceType startSourceId startSourceKey endSourceType endSourceId endSourceKey startSnapshot endSnapshot startConfirmedBy startConfirmedAt endConfirmedBy endConfirmedAt createdAt updatedAt createdBy"
  ),
  vehiclePackage: fields(
    "id packageNo packageName productId productVersionId modelDefinitionId vehicleModelName brand series configName minPurchasePriceAmount maxPurchasePriceAmount monthlyFeeRate minPeriodMonths maxPeriodMonths status remark createdAt updatedAt createdBy updatedBy deletedAt"
  ),
  vehiclePackageModelMember: fields("id vehiclePackageId modelDefinitionId createdAt createdBy"),
  vehicleSalePriceHistory: fields(
    "id vehicleId beforeSalePriceAmount afterSalePriceAmount reviewType reviewQuarter effectiveFrom effectiveTo reason remark createdAt createdBy"
  )
});

const SOURCE_DELEGATES = Object.freeze(Object.keys(SOURCE_SCALAR_FIELDS));

test("source loader uses complete explicit scalar selects and fixed whitelist filters", async () => {
  const fake = createPrismaFake();
  const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(fake.tx, selection([]));

  assert.ok(snapshot.asOf instanceof Date);
  assert.deepEqual(
    snapshot.templates.requiredContractTemplateTypes,
    REQUIRED_CONTRACT_TEMPLATE_TYPES
  );
  assert.deepEqual(
    snapshot.templates.requiredNotificationTemplateCodes,
    REQUIRED_NOTIFICATION_TEMPLATE_CODES
  );
  assert.deepEqual(Object.keys(snapshot.vehicle.eligibilityEvidence), []);

  const findCalls = fake.calls.filter(({ operation }) => operation === "findMany");
  assert.deepEqual(
    [...new Set(findCalls.map(({ delegate }) => delegate))].sort(),
    [...SOURCE_DELEGATES].sort()
  );
  assert.equal(
    fake.calls.some(({ delegate }) => EXPECTED_FORBIDDEN_DELEGATES.includes(delegate)),
    false
  );
  assert.equal(
    fake.calls.some(
      ({ operation }) => operation.startsWith("$execute") || operation === "$queryRaw"
    ),
    false
  );

  for (const call of findCalls) {
    assert.equal(hasKeyDeep(call.args, "include"), false, `${call.delegate} must not use include`);
    assert.ok(
      call.args.select && typeof call.args.select === "object",
      `${call.delegate} requires select`
    );
    if (call.delegate !== "vehicle") {
      assert.deepEqual(Object.keys(call.args.select).sort(), SOURCE_SCALAR_FIELDS[call.delegate]);
    }
  }

  const vehicleCalls = findCalls.filter(({ delegate }) => delegate === "vehicle");
  assert.equal(vehicleCalls.length, 3);
  assert.deepEqual(Object.keys(vehicleCalls[0].args.select).sort(), [
    "_count",
    "currentSalePriceAmount",
    "id",
    "salePriceStatus",
    "status"
  ]);
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
  assert.equal(planWhere.productVersion.effectiveFrom.lte, snapshot.evaluationDate);
  assert.equal(planWhere.productVersion.OR[1].effectiveTo.gte, snapshot.evaluationDate);
  assert.equal(planWhere.effectiveFrom.lte, snapshot.evaluationDate);

  const productVersionWhere = findCall(fake, "productVersion").args.where;
  assert.equal(productVersionWhere.effectiveFrom.lte, snapshot.evaluationDate);
  assert.equal(productVersionWhere.OR[1].effectiveTo.gte, snapshot.evaluationDate);

  const contractWhere = findCall(fake, "contractVersion").args.where;
  assert.deepEqual(contractWhere.templateType.in, REQUIRED_CONTRACT_TEMPLATE_TYPES);
  assert.equal(contractWhere.approvedAt.lte, snapshot.asOf);
  assert.equal(contractWhere.effectiveFrom.lte, snapshot.evaluationDate);
  const notificationWhere = findCall(fake, "notificationTemplate").args.where;
  assert.deepEqual(notificationWhere.templateCode.in, REQUIRED_NOTIFICATION_TEMPLATE_CODES);
  assert.equal(notificationWhere.templateStatus, "ACTIVE");
});

test("source loader uses one date-only evaluation day while preserving approvedAt as an instant", async () => {
  const fake = createPrismaFake();
  const approvedAsOf = new Date("2026-08-30T12:34:56.000Z");

  const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(fake.tx, selection([]), {
    asOf: approvedAsOf
  });

  assert.equal(snapshot.asOf.toISOString(), "2026-08-30T12:34:56.000Z");
  assert.equal(snapshot.evaluationDate.toISOString(), "2026-08-30T00:00:00.000Z");
  for (const delegate of ["subscriptionPlan", "productVersion", "depositRule", "contractVersion"]) {
    const call = findCall(fake, delegate);
    assert.equal(call.args.where.effectiveFrom.lte.toISOString(), "2026-08-30T00:00:00.000Z");
    assert.equal(call.args.where.OR[1].effectiveTo.gte.toISOString(), "2026-08-30T00:00:00.000Z");
  }
  assert.equal(
    findCall(fake, "contractVersion").args.where.approvedAt.lte.toISOString(),
    "2026-08-30T12:34:56.000Z"
  );

  await assert.rejects(
    loadStage1CleanAcceptanceSourceSnapshot(fake.tx, selection([]), { asOf: new Date("invalid") }),
    (error) => error?.message === "MANIFEST_CONTEXT_INVALID"
  );
});

test("vehicle eligibility evidence mirrors allocation blockers and rejects partial selections", async () => {
  const vehicleRow = completeVehicleRow();
  const eligible = createPrismaFake({
    rows: {
      vehicle: ({ callIndex }) =>
        callIndex === 0
          ? [
              {
                _count: {
                  assetWorkOrders: 0,
                  documents: 1,
                  deliveries: 0,
                  operationalRestrictions: 0,
                  orders: 0,
                  insurancePolicies: 2,
                  listingPlans: 1,
                  returns: 0,
                  serviceCases: 0,
                  subscriptionPeriods: 0
                },
                currentSalePriceAmount: 12000000n,
                id: VEHICLE_A,
                salePriceStatus: "EFFECTIVE",
                status: "AVAILABLE"
              }
            ]
          : callIndex === 1
            ? [{ id: VEHICLE_A }]
            : [vehicleRow],
      vehicleInsurancePolicy: [
        completeScalarRow("vehicleInsurancePolicy", {
          deletedAt: null,
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "policy-commercial",
          policyStatus: "ACTIVE",
          policyType: "COMMERCIAL",
          vehicleId: VEHICLE_A
        }),
        completeScalarRow("vehicleInsurancePolicy", {
          deletedAt: null,
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "policy-compulsory",
          policyStatus: "ACTIVE",
          policyType: "COMPULSORY_TRAFFIC",
          vehicleId: VEHICLE_A
        })
      ]
    }
  });
  const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(
    eligible.tx,
    selection([VEHICLE_A]),
    { asOf: new Date("2026-08-30T12:00:00.000Z") }
  );
  assert.deepEqual(snapshot.vehicle.vehicles, [vehicleRow]);
  assert.deepEqual(snapshot.vehicle.eligibilityEvidence, {
    [VEHICLE_A]: {
      blockingRestrictionCount: 0,
      activeApplicationCount: 0,
      activeAssetWorkOrderCount: 0,
      activeReviewReservationCount: 0,
      activeServiceCaseCount: 0,
      currentCommercialPolicyCount: 1,
      currentCompulsoryTrafficPolicyCount: 1,
      currentLicenseCount: 1,
      currentSalePricePositive: true,
      deliveryCount: 0,
      orderCount: 0,
      overlappingSubscriptionPeriodCount: 0,
      requiredDocumentsAndInsuranceReady: true,
      returnCount: 0,
      salePriceStatusEffective: true,
      visibleRetainedListingPlanCount: 1
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
  for (const relation of ["orders", "deliveries", "returns", "assetWorkOrders", "serviceCases"]) {
    assert.deepEqual(
      guarded.args.where[relation],
      { none: diagnostic.args.select._count.select[relation].where },
      `${relation} must fail closed`
    );
  }
  assert.equal(guarded.args.where.documents.some.deletedAt, null);
  assert.equal(guarded.args.where.documents.some.documentStatus, "ACTIVE");
  assert.equal(guarded.args.where.documents.some.documentType, "VEHICLE_LICENSE");
  assert.deepEqual(
    guarded.args.where.AND.map(({ insurancePolicies }) => insurancePolicies.some.policyType),
    ["COMMERCIAL", "COMPULSORY_TRAFFIC"]
  );
  assert.deepEqual(guarded.args.where.modelDefinition, {
    is: { deletedAt: null, enabled: true, portalVisible: true }
  });
  assert.deepEqual(guarded.args.where.listingProfile, {
    is: {
      deletedAt: null,
      listingStatus: "PUBLISHED",
      plans: {
        some: { deletedAt: null, subscriptionPlanId: { in: [] }, visible: true }
      },
      portalVisible: true
    }
  });

  const partial = createPrismaFake({
    rows: {
      vehicle: ({ callIndex }) =>
        callIndex === 0
          ? [
              {
                _count: {
                  assetWorkOrders: 0,
                  deliveries: 0,
                  operationalRestrictions: 0,
                  orders: 0,
                  returns: 0,
                  serviceCases: 0,
                  subscriptionPeriods: 0
                },
                currentSalePriceAmount: 12000000n,
                id: VEHICLE_A,
                salePriceStatus: "EFFECTIVE",
                status: "AVAILABLE"
              },
              {
                _count: {
                  assetWorkOrders: 0,
                  deliveries: 0,
                  operationalRestrictions: 1,
                  orders: 0,
                  returns: 0,
                  serviceCases: 0,
                  subscriptionPeriods: 0
                },
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

test("vehicle eligibility rejects every governed process blocker", async () => {
  for (const blocker of [
    "assetWorkOrders",
    "deliveries",
    "operationalRestrictions",
    "orders",
    "returns",
    "serviceCases",
    "subscriptionPeriods"
  ]) {
    const counts = Object.fromEntries(
      [
        "assetWorkOrders",
        "deliveries",
        "operationalRestrictions",
        "orders",
        "returns",
        "serviceCases",
        "subscriptionPeriods"
      ].map((name) => [name, name === blocker ? 1 : 0])
    );
    const fake = createPrismaFake({
      rows: {
        vehicle: ({ callIndex }) =>
          callIndex === 0
            ? [
                {
                  _count: counts,
                  currentSalePriceAmount: 12000000n,
                  id: VEHICLE_A,
                  salePriceStatus: "EFFECTIVE",
                  status: "AVAILABLE"
                }
              ]
            : []
      }
    });
    await assert.rejects(
      loadStage1CleanAcceptanceSourceSnapshot(fake.tx, selection([VEHICLE_A])),
      (error) => error?.message === "VEHICLE_NOT_ELIGIBLE",
      blocker
    );
  }
});

test("vehicle discovery reuses the strict guard without an id filter and returns only stable minimal fields", async () => {
  const laterId = "22222222-2222-4222-8222-222222222222";
  const fake = createPrismaFake({
    rows: {
      vehicle: () => [
        { id: laterId, salePriceStatus: "EFFECTIVE", status: "AVAILABLE" },
        { id: VEHICLE_A, salePriceStatus: "EFFECTIVE", status: "AVAILABLE" }
      ]
    }
  });
  const asOf = new Date("2026-08-30T12:34:56.000Z");

  const candidates = await discoverStage1CleanAcceptanceVehicleCandidates(fake.tx, { asOf });

  assert.deepEqual(candidates, [
    { id: VEHICLE_A, salePriceStatus: "EFFECTIVE", status: "AVAILABLE" },
    { id: laterId, salePriceStatus: "EFFECTIVE", status: "AVAILABLE" }
  ]);
  const discovery = findCall(fake, "vehicle");
  assert.equal(hasKeyDeep(discovery.args.where, "id"), false);
  assert.deepEqual(Object.keys(discovery.args.select).sort(), ["id", "salePriceStatus", "status"]);
  assert.equal(discovery.args.where.deletedAt, null);
  assert.deepEqual(discovery.args.where.currentSalePriceAmount, { gt: 0 });
  assert.equal(discovery.args.where.salePriceStatus, "EFFECTIVE");
  assert.equal(discovery.args.where.status, "AVAILABLE");
  assert.deepEqual(discovery.args.where.modelDefinition, {
    is: { deletedAt: null, enabled: true, portalVisible: true }
  });
  assert.deepEqual(discovery.args.where.listingProfile, {
    is: {
      deletedAt: null,
      listingStatus: "PUBLISHED",
      plans: {
        some: { deletedAt: null, subscriptionPlanId: { in: [] }, visible: true }
      },
      portalVisible: true
    }
  });
  assert.deepEqual(discovery.args.where.operationalRestrictions.none.startedAt, { lte: asOf });
  assert.deepEqual(discovery.args.where.subscriptionPeriods.none.startedAt, { lte: asOf });

  await assert.rejects(
    discoverStage1CleanAcceptanceVehicleCandidates(fake.tx, { asOf: new Date("invalid") }),
    (error) => error?.message === "MANIFEST_CONTEXT_INVALID"
  );
});

test("source loader returns endpoint-closed access/customer rows and catalog model union in stable order", async () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const product = completeScalarRow("product", {
    createdAt: now,
    deletedAt: null,
    description: null,
    id: "product-1",
    name: "Subscription",
    productNo: "PROD-1",
    productType: "SUBSCRIPTION",
    status: "ACTIVE",
    updatedAt: now
  });
  const productVersion = completeScalarRow("productVersion", {
    createdAt: now,
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "product-version-1",
    productId: product.id,
    status: "ACTIVE",
    updatedAt: now,
    versionNo: "1.0"
  });
  const subscriptionPlan = completeScalarRow("subscriptionPlan", {
    baseMonthlyFeeAmount: 1000n,
    benefitPackageId: "benefit-1",
    createdAt: now,
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    energyPackageId: "energy-1",
    id: "plan-1",
    maxPeriodMonths: 36,
    mileagePackageId: "mileage-1",
    minPeriodMonths: 12,
    monthlyFeeMode: "FIXED_AMOUNT",
    planName: "Plan",
    planNo: "PLAN-1",
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    status: "ACTIVE",
    updatedAt: now,
    vehiclePackageId: "package-1"
  });
  const dataset = {
    user: [
      completeScalarRow("user", {
        createdAt: now,
        deletedAt: null,
        id: "user-admin",
        name: "Admin",
        passwordHash: "hash",
        status: "ACTIVE",
        updatedAt: now,
        username: "keqi_119"
      }),
      completeScalarRow("user", {
        createdAt: now,
        deletedAt: now,
        id: "user-deleted",
        name: "Deleted",
        passwordHash: "hash",
        status: "ACTIVE",
        updatedAt: now,
        username: "deleted"
      })
    ],
    role: [
      completeScalarRow("role", {
        code: "ADMIN",
        createdAt: now,
        deletedAt: null,
        id: "role-admin",
        name: "Admin",
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("role", {
        code: "OPERATIONS",
        createdAt: now,
        deletedAt: null,
        id: "role-inactive",
        name: "Inactive",
        status: "INACTIVE",
        updatedAt: now
      }),
      completeScalarRow("role", {
        code: "DELETED",
        createdAt: now,
        deletedAt: now,
        id: "role-deleted",
        name: "Deleted",
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    permission: [
      completeScalarRow("permission", {
        action: "read",
        code: "permission:b",
        createdAt: now,
        deletedAt: null,
        id: "permission-b",
        module: "acceptance",
        name: "B",
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("permission", {
        action: "read",
        code: "permission:a",
        createdAt: now,
        deletedAt: null,
        id: "permission-a",
        module: "acceptance",
        name: "A",
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("permission", {
        action: "read",
        code: "permission:old",
        createdAt: now,
        deletedAt: null,
        id: "permission-inactive",
        module: "acceptance",
        name: "Old",
        status: "INACTIVE",
        updatedAt: now
      }),
      completeScalarRow("permission", {
        action: "read",
        code: "permission:deleted",
        createdAt: now,
        deletedAt: now,
        id: "permission-deleted",
        module: "acceptance",
        name: "Deleted",
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    menu: [
      completeScalarRow("menu", {
        code: "menu:child",
        createdAt: now,
        deletedAt: null,
        id: "menu-b",
        name: "Child",
        parentId: "menu-a",
        path: "/child",
        sortOrder: 2,
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("menu", {
        code: "menu:root",
        createdAt: now,
        deletedAt: null,
        id: "menu-a",
        name: "Root",
        parentId: null,
        path: "/",
        sortOrder: 1,
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("menu", {
        code: "menu:old",
        createdAt: now,
        deletedAt: null,
        id: "menu-inactive",
        name: "Old",
        parentId: null,
        path: "/old",
        sortOrder: 3,
        status: "INACTIVE",
        updatedAt: now
      }),
      completeScalarRow("menu", {
        code: "menu:deleted",
        createdAt: now,
        deletedAt: now,
        id: "menu-deleted",
        name: "Deleted",
        parentId: null,
        path: "/deleted",
        sortOrder: 4,
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    userRole: [
      completeScalarRow("userRole", {
        createdAt: now,
        deletedAt: null,
        id: "user-role-valid",
        roleId: "role-admin",
        userId: "user-admin"
      }),
      completeScalarRow("userRole", {
        createdAt: now,
        deletedAt: null,
        id: "user-role-dangling",
        roleId: "role-inactive",
        userId: "user-admin"
      })
    ],
    rolePermission: [
      completeScalarRow("rolePermission", {
        createdAt: now,
        deletedAt: null,
        id: "grant-b",
        permissionId: "permission-b",
        roleId: "role-admin"
      }),
      completeScalarRow("rolePermission", {
        createdAt: now,
        deletedAt: null,
        id: "grant-a",
        permissionId: "permission-a",
        roleId: "role-admin"
      }),
      completeScalarRow("rolePermission", {
        createdAt: now,
        deletedAt: null,
        id: "grant-dangling",
        permissionId: "permission-inactive",
        roleId: "role-inactive"
      })
    ],
    roleMenu: [
      completeScalarRow("roleMenu", {
        createdAt: now,
        deletedAt: null,
        id: "role-menu-b",
        menuId: "menu-b",
        roleId: "role-admin"
      }),
      completeScalarRow("roleMenu", {
        createdAt: now,
        deletedAt: null,
        id: "role-menu-a",
        menuId: "menu-a",
        roleId: "role-admin"
      }),
      completeScalarRow("roleMenu", {
        createdAt: now,
        deletedAt: null,
        id: "role-menu-dangling",
        menuId: "menu-inactive",
        roleId: "role-inactive"
      })
    ],
    customerAccount: [
      completeScalarRow("customerAccount", {
        accountStatus: "ACTIVE",
        createdAt: now,
        customerId: "customer-active",
        deletedAt: null,
        id: "account-active",
        phone: "18616570212",
        updatedAt: now
      }),
      completeScalarRow("customerAccount", {
        accountStatus: "DISABLED",
        createdAt: now,
        customerId: "customer-inactive",
        deletedAt: null,
        id: "account-disabled",
        phone: "18600000000",
        updatedAt: now
      })
    ],
    customer: [
      completeScalarRow("customer", {
        createdAt: now,
        customerNo: "CUS-1",
        customerType: "PERSONAL",
        deletedAt: null,
        id: "customer-active",
        mobile: "18616570212",
        name: "Active",
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("customer", {
        createdAt: now,
        customerNo: "CUS-2",
        customerType: "PERSONAL",
        deletedAt: null,
        id: "customer-inactive",
        mobile: "18600000000",
        name: "Inactive",
        status: "FROZEN",
        updatedAt: now
      })
    ],
    customerIdentity: [
      completeScalarRow("customerIdentity", {
        createdAt: now,
        customerId: "customer-active",
        deletedAt: null,
        id: "identity-b",
        realnameVerified: true,
        updatedAt: now
      }),
      completeScalarRow("customerIdentity", {
        createdAt: now,
        customerId: "customer-inactive",
        deletedAt: null,
        id: "identity-dangling",
        realnameVerified: true,
        updatedAt: now
      })
    ],
    customerProfile: [
      completeScalarRow("customerProfile", {
        createdAt: now,
        customerId: "customer-active",
        deletedAt: null,
        id: "profile-b",
        updatedAt: now
      }),
      completeScalarRow("customerProfile", {
        createdAt: now,
        customerId: "customer-inactive",
        deletedAt: null,
        id: "profile-dangling",
        updatedAt: now
      })
    ],
    customerESignProviderAccount: [
      completeScalarRow("customerESignProviderAccount", {
        accountType: "PERSONAL",
        certBindingSource: "CALLBACK",
        certBindingStatus: "BOUND",
        createdAt: now,
        customerId: "customer-active",
        deletedAt: null,
        id: "esign-b",
        provider: "FADADA",
        providerOpenId: "open-active",
        realNameProviderStatusSource: "CALLBACK",
        realNameStatus: "VERIFIED",
        registrationStatus: "REGISTERED",
        source: "SYSTEM_REGISTER",
        updatedAt: now
      }),
      completeScalarRow("customerESignProviderAccount", {
        accountType: "PERSONAL",
        certBindingSource: "CALLBACK",
        certBindingStatus: "BOUND",
        createdAt: now,
        customerId: "customer-inactive",
        deletedAt: null,
        id: "esign-dangling",
        provider: "FADADA",
        providerOpenId: "open-inactive",
        realNameProviderStatusSource: "CALLBACK",
        realNameStatus: "VERIFIED",
        registrationStatus: "REGISTERED",
        source: "SYSTEM_REGISTER",
        updatedAt: now
      }),
      completeScalarRow("customerESignProviderAccount", {
        accountType: "PERSONAL",
        certBindingSource: "CALLBACK",
        certBindingStatus: "UNBOUND",
        createdAt: now,
        customerId: "customer-active",
        deletedAt: null,
        id: "esign-inactive",
        provider: "FADADA",
        providerOpenId: "open-unbound",
        realNameProviderStatusSource: "CALLBACK",
        realNameStatus: "VERIFIED",
        registrationStatus: "REGISTERED",
        source: "SYSTEM_REGISTER",
        updatedAt: now
      }),
      completeScalarRow("customerESignProviderAccount", {
        accountType: "PERSONAL",
        certBindingSource: "CALLBACK",
        certBindingStatus: "BOUND",
        createdAt: now,
        customerId: "customer-active",
        deletedAt: now,
        id: "esign-deleted",
        provider: "FADADA",
        providerOpenId: "open-deleted",
        realNameProviderStatusSource: "CALLBACK",
        realNameStatus: "VERIFIED",
        registrationStatus: "REGISTERED",
        source: "SYSTEM_REGISTER",
        updatedAt: now
      })
    ],
    subscriptionPlan: [
      subscriptionPlan,
      {
        ...subscriptionPlan,
        id: "plan-inactive-package",
        planName: "Inactive package",
        planNo: "PLAN-2",
        vehiclePackageId: "package-inactive"
      },
      {
        ...subscriptionPlan,
        id: "plan-deleted-package",
        planName: "Deleted package",
        planNo: "PLAN-3",
        vehiclePackageId: "package-deleted"
      }
    ],
    product: [product],
    productVersion: [productVersion],
    depositRule: [
      completeScalarRow("depositRule", {
        createdAt: now,
        defaultRate: 0.1,
        deletedAt: null,
        depositAmount: 1000n,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        grade: "A",
        id: "deposit-1",
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    vehiclePackage: [
      completeScalarRow("vehiclePackage", {
        createdAt: now,
        deletedAt: null,
        id: "package-1",
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: "model-package",
        packageName: "Package",
        packageNo: "PKG-1",
        productId: product.id,
        productVersionId: productVersion.id,
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("vehiclePackage", {
        createdAt: now,
        deletedAt: null,
        id: "package-inactive",
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: "model-inactive",
        packageName: "Inactive",
        packageNo: "PKG-2",
        productId: product.id,
        productVersionId: productVersion.id,
        status: "INACTIVE",
        updatedAt: now
      }),
      completeScalarRow("vehiclePackage", {
        createdAt: now,
        deletedAt: now,
        id: "package-deleted",
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: "model-deleted",
        packageName: "Deleted",
        packageNo: "PKG-3",
        productId: product.id,
        productVersionId: productVersion.id,
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    vehiclePackageModelMember: [
      completeScalarRow("vehiclePackageModelMember", {
        createdAt: now,
        id: "member-1",
        modelDefinitionId: "model-member",
        vehiclePackageId: "package-1"
      })
    ],
    mileagePackage: [
      completeScalarRow("mileagePackage", {
        createdAt: now,
        deletedAt: null,
        id: "mileage-1",
        monthlyMileageKm: 1000,
        overMileageFeeAmount: 1n,
        packageName: "Mileage",
        packageNo: "MILE-1",
        priceAmount: 1n,
        productId: product.id,
        productVersionId: productVersion.id,
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    energyPackage: [
      completeScalarRow("energyPackage", {
        createdAt: now,
        deletedAt: null,
        id: "energy-1",
        packageName: "Energy",
        packageNo: "ENERGY-1",
        priceAmount: 1n,
        productId: product.id,
        productVersionId: productVersion.id,
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    benefitPackage: [
      completeScalarRow("benefitPackage", {
        benefitType: "OTHER",
        createdAt: now,
        deletedAt: null,
        id: "benefit-1",
        packageName: "Benefit",
        packageNo: "BEN-1",
        priceAmount: 1n,
        productId: product.id,
        productVersionId: productVersion.id,
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    productPriceRule: [
      completeScalarRow("productPriceRule", {
        baseMileageKm: 1000,
        createdAt: now,
        deletedAt: null,
        id: "price-1",
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: "model-price",
        monthlyFeeRate: 0.1,
        overMileageFeeAmount: 1n,
        productVersionId: productVersion.id,
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("productPriceRule", {
        baseMileageKm: 1000,
        createdAt: now,
        deletedAt: null,
        id: "price-deleted-model",
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: "model-deleted",
        monthlyFeeRate: 0.1,
        overMileageFeeAmount: 1n,
        productVersionId: productVersion.id,
        status: "ACTIVE",
        updatedAt: now
      }),
      completeScalarRow("productPriceRule", {
        baseMileageKm: 1000,
        createdAt: now,
        deletedAt: null,
        id: "price-inactive",
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: "model-inactive",
        monthlyFeeRate: 0.1,
        overMileageFeeAmount: 1n,
        productVersionId: productVersion.id,
        status: "INACTIVE",
        updatedAt: now
      }),
      completeScalarRow("productPriceRule", {
        baseMileageKm: 1000,
        createdAt: now,
        deletedAt: now,
        id: "price-deleted",
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: "model-deleted",
        monthlyFeeRate: 0.1,
        overMileageFeeAmount: 1n,
        productVersionId: productVersion.id,
        status: "ACTIVE",
        updatedAt: now
      })
    ],
    vehicleModelDefinition: [
      completeScalarRow("vehicleModelDefinition", {
        brand: "NIO",
        createdAt: now,
        deletedAt: null,
        displayName: "Member",
        enabled: true,
        id: "model-member",
        modelCode: "MEMBER",
        modelName: "Member",
        portalVisible: true,
        sortOrder: 2,
        updatedAt: now
      }),
      completeScalarRow("vehicleModelDefinition", {
        brand: "NIO",
        createdAt: now,
        deletedAt: null,
        displayName: "Package",
        enabled: true,
        id: "model-package",
        modelCode: "PACKAGE",
        modelName: "Package",
        portalVisible: true,
        sortOrder: 1,
        updatedAt: now
      }),
      completeScalarRow("vehicleModelDefinition", {
        brand: "NIO",
        createdAt: now,
        deletedAt: null,
        displayName: "Price",
        enabled: true,
        id: "model-price",
        modelCode: "PRICE",
        modelName: "Price",
        portalVisible: true,
        sortOrder: 3,
        updatedAt: now
      }),
      completeScalarRow("vehicleModelDefinition", {
        brand: "NIO",
        createdAt: now,
        deletedAt: null,
        displayName: "Inactive",
        enabled: false,
        id: "model-inactive",
        modelCode: "INACTIVE",
        modelName: "Inactive",
        portalVisible: true,
        sortOrder: 4,
        updatedAt: now
      }),
      completeScalarRow("vehicleModelDefinition", {
        brand: "NIO",
        createdAt: now,
        deletedAt: now,
        displayName: "Deleted",
        enabled: true,
        id: "model-deleted",
        modelCode: "DELETED",
        modelName: "Deleted",
        portalVisible: true,
        sortOrder: 5,
        updatedAt: now
      })
    ]
  };
  const fake = createPrismaFake({ rows: dataset });
  const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(fake.tx, selection([]));

  assert.deepEqual(
    snapshot.access.users.map(({ id }) => id),
    ["user-admin"]
  );
  assert.deepEqual(
    snapshot.access.roles.map(({ id }) => id),
    ["role-admin"]
  );
  assert.deepEqual(
    snapshot.access.permissions.map(({ id }) => id),
    ["permission-a", "permission-b"]
  );
  assert.deepEqual(
    snapshot.access.menus.map(({ id }) => id),
    ["menu-a", "menu-b"]
  );
  assert.deepEqual(
    snapshot.access.userRoles.map(({ id }) => id),
    ["user-role-valid"]
  );
  assert.deepEqual(
    snapshot.access.rolePermissions.map(({ id }) => id),
    ["grant-a", "grant-b"]
  );
  assert.deepEqual(
    snapshot.access.roleMenus.map(({ id }) => id),
    ["role-menu-a", "role-menu-b"]
  );
  assert.deepEqual(
    snapshot.customer.customers.map(({ id }) => id),
    ["customer-active"]
  );
  assert.deepEqual(
    snapshot.customer.customerIdentities.map(({ id }) => id),
    ["identity-b"]
  );
  assert.deepEqual(
    snapshot.customer.customerProfiles.map(({ id }) => id),
    ["profile-b"]
  );
  assert.deepEqual(
    snapshot.customer.customerESignProviderAccounts.map(({ id }) => id),
    ["esign-b"]
  );
  assert.deepEqual(
    snapshot.catalog.subscriptionPlans.map(({ id }) => id),
    ["plan-1", "plan-deleted-package", "plan-inactive-package"]
  );
  assert.deepEqual(
    snapshot.catalog.vehiclePackages.map(({ id }) => id),
    ["package-1"]
  );
  assert.deepEqual(
    snapshot.catalog.productPriceRules.map(({ id }) => id),
    ["price-1", "price-deleted-model"]
  );
  assert.deepEqual(
    snapshot.vehicle.vehicleModelDefinitions.map(({ id }) => id),
    ["model-member", "model-package", "model-price"]
  );
});

test("source loader drops a fixed-phone account and children when its Customer endpoint is inactive or deleted", async () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  for (const endpoint of [
    { deletedAt: null, id: "customer-inactive", status: "FROZEN" },
    { deletedAt: now, id: "customer-deleted", status: "ACTIVE" }
  ]) {
    const fake = createPrismaFake({
      rows: {
        customer: [
          completeScalarRow("customer", {
            createdAt: now,
            customerNo: `CUS-${endpoint.id}`,
            customerType: "PERSONAL",
            deletedAt: endpoint.deletedAt,
            id: endpoint.id,
            mobile: "18616570212",
            name: endpoint.id,
            status: endpoint.status,
            updatedAt: now
          })
        ],
        customerAccount: [
          completeScalarRow("customerAccount", {
            accountStatus: "ACTIVE",
            createdAt: now,
            customerId: endpoint.id,
            deletedAt: null,
            id: `account-${endpoint.id}`,
            phone: "18616570212",
            updatedAt: now
          })
        ],
        customerESignProviderAccount: [
          completeScalarRow("customerESignProviderAccount", {
            accountType: "PERSONAL",
            certBindingSource: "CALLBACK",
            certBindingStatus: "BOUND",
            createdAt: now,
            customerId: endpoint.id,
            deletedAt: null,
            id: `esign-${endpoint.id}`,
            provider: "FADADA",
            providerOpenId: `open-${endpoint.id}`,
            realNameProviderStatusSource: "CALLBACK",
            realNameStatus: "VERIFIED",
            registrationStatus: "REGISTERED",
            source: "SYSTEM_REGISTER",
            updatedAt: now
          })
        ],
        customerIdentity: [
          completeScalarRow("customerIdentity", {
            createdAt: now,
            customerId: endpoint.id,
            deletedAt: null,
            id: `identity-${endpoint.id}`,
            realnameVerified: true,
            updatedAt: now
          })
        ],
        customerProfile: [
          completeScalarRow("customerProfile", {
            createdAt: now,
            customerId: endpoint.id,
            deletedAt: null,
            id: `profile-${endpoint.id}`,
            updatedAt: now
          })
        ]
      }
    });

    const snapshot = await loadStage1CleanAcceptanceSourceSnapshot(fake.tx, selection([]));
    assert.deepEqual(snapshot.customer, {
      customerAccounts: [],
      customerESignProviderAccounts: [],
      customerIdentities: [],
      customerProfiles: [],
      customers: []
    });
  }
});

test("target loader counts exact whitelist and verifies the fixed local canonical facts", async () => {
  assert.deepEqual(STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES, EXPECTED_FORBIDDEN_DELEGATES);
  assert.equal(Object.isFrozen(STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES), true);

  const fake = createPrismaFake({
    counts: { auditLog: 0, customer: 2, subscriptionOrder: 3, vehicle: 1 },
    rawResults: [
      appliedMigrationRows(),
      [
        {
          schemaFingerprintSha256: STAGE1_ACCEPTANCE_CANONICAL_SCHEMA_FINGERPRINT_SHA256
        }
      ]
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
  assert.equal(target.migrationCatalog.length, 125);
  assert.equal(
    target.schemaFingerprint[0].schemaFingerprintSha256,
    "6264cda46cd5d17b5c2bd14bb8d2da95fc6420e7c066bf474dcb030c672613be"
  );

  const countCalls = fake.calls.filter(({ operation }) => operation === "count");
  assert.deepEqual(
    [...new Set(countCalls.map(({ delegate }) => delegate))].sort(),
    [...new Set([...SOURCE_DELEGATES, ...EXPECTED_FORBIDDEN_DELEGATES])].sort()
  );
  assert.ok(
    countCalls.every(({ args }) => assert.deepEqual(args, { select: { _all: true } }) === undefined)
  );

  const rawCalls = fake.calls.filter(({ operation }) => operation === "$queryRaw");
  assert.equal(rawCalls.length, 2);
  assert.ok(rawCalls.every(({ strings }) => Array.isArray(strings) && Array.isArray(strings.raw)));
  assert.deepEqual(
    rawCalls.map(({ values }) => values),
    [["%"], ["public"]]
  );
  assert.equal(
    rawCalls.some(({ strings }) => strings.join("?").includes("SELECT *")),
    false
  );
  assert.equal(
    fake.calls.some(
      ({ operation }) =>
        operation.startsWith("create") ||
        operation.startsWith("update") ||
        operation.startsWith("delete") ||
        operation === "$executeRaw"
    ),
    false
  );

  const forbiddenOnly = createPrismaFake({ counts: { auditLog: 1 } });
  const forbiddenCounts = await countStage1CleanAcceptanceForbiddenDomains(forbiddenOnly.tx);
  assert.deepEqual(Object.keys(forbiddenCounts), EXPECTED_FORBIDDEN_DELEGATES);
  assert.equal(forbiddenCounts.auditLog, 1);
  assert.equal(forbiddenOnly.calls.length, EXPECTED_FORBIDDEN_DELEGATES.length);
});

test("target loader rejects missing, unknown, duplicate, mismatched, and drifted canonical facts", async () => {
  const migrations = appliedMigrationRows();
  const cases = [
    { name: "missing", migrations: [] },
    {
      name: "unknown",
      migrations: migrations.map((row, index) =>
        index === 0 ? { ...row, migrationName: "unknown" } : row
      )
    },
    { name: "duplicate", migrations: [...migrations, { ...migrations[0], id: "migration-x" }] },
    {
      name: "mismatch",
      migrations: migrations.map((row, index) =>
        index === 0 ? { ...row, checksum: "0".repeat(64) } : row
      )
    },
    {
      name: "drift",
      migrations,
      schema: [{ schemaFingerprintSha256: "0".repeat(64) }]
    }
  ];
  for (const item of cases) {
    const fake = createPrismaFake({
      rawResults: [
        item.migrations,
        item.schema ?? [
          { schemaFingerprintSha256: STAGE1_ACCEPTANCE_CANONICAL_SCHEMA_FINGERPRINT_SHA256 }
        ]
      ]
    });
    const snapshot = await loadStage1CleanAcceptanceTargetSnapshot(fake.tx);
    assert.equal(snapshot.schemaCanonical, false, item.name);
  }
});

function fields(value) {
  return value.split(" ").sort();
}

function completeScalarRow(delegate, overrides) {
  return {
    ...Object.fromEntries(SOURCE_SCALAR_FIELDS[delegate].map((field) => [field, null])),
    ...overrides
  };
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
        return args?.select ? { _all: counts[delegate] ?? 0 } : (counts[delegate] ?? 0);
      },
      async findMany(args) {
        const callIndex = findManyCallIndex++;
        calls.push({ args, callIndex, delegate, operation: "findMany" });
        const result = rows[delegate];
        if (typeof result === "function") {
          return structuredClone(result({ args, callIndex }));
        }
        return structuredClone(
          (result ?? [])
            .filter((row) => matchesWhere(row, args.where ?? {}))
            .map((row) => projectSelectedRow(row, args.select))
        );
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
  const call = fake.calls.find(
    (item) => item.delegate === delegate && item.operation === "findMany"
  );
  assert.ok(call, `missing ${delegate}.findMany`);
  return call;
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasKeyDeep(item, key));
}

function projectSelectedRow(row, select) {
  return Object.fromEntries(
    Object.entries(select).map(([field, selected]) => {
      assert.ok(Object.hasOwn(row, field), `fake row is missing selected field ${field}`);
      return [field, selected === true ? row[field] : projectNestedSelection(row[field], selected)];
    })
  );
}

function projectNestedSelection(value, selected) {
  if (!selected?.select) return value;
  if (Array.isArray(value)) return value.map((item) => projectSelectedRow(item, selected.select));
  return projectSelectedRow(value, selected.select);
}

function matchesWhere(row, where) {
  if (!row) return false;
  return Object.entries(where).every(([field, expected]) => {
    if (field === "AND") return expected.every((clause) => matchesWhere(row, clause));
    if (field === "OR") return expected.some((clause) => matchesWhere(row, clause));
    const actual = row[field];
    if (expected === null || typeof expected !== "object" || expected instanceof Date) {
      return sameScalar(actual, expected);
    }
    if (Object.hasOwn(expected, "in"))
      return expected.in.some((value) => sameScalar(actual, value));
    if (Object.hasOwn(expected, "not")) return actual != null && !sameScalar(actual, expected.not);
    const comparisons = [];
    if (Object.hasOwn(expected, "lte")) comparisons.push(actual <= expected.lte);
    if (Object.hasOwn(expected, "gte")) comparisons.push(actual >= expected.gte);
    if (Object.hasOwn(expected, "gt")) comparisons.push(actual > expected.gt);
    if (comparisons.length > 0) return comparisons.every(Boolean);
    if (Object.hasOwn(expected, "is")) return matchesWhere(actual, expected.is);
    if (Object.hasOwn(expected, "none")) {
      return Array.isArray(actual) && actual.every((item) => !matchesWhere(item, expected.none));
    }
    return matchesWhere(actual, expected);
  });
}

function sameScalar(left, right) {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
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
