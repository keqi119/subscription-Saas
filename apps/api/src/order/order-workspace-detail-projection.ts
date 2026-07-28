import { PermissionCode } from "@subscription-saas/shared";

import type { OrderWorkspaceDetail } from "./order-workspace.types";

const WORKSPACE_DETAIL_BASE_FIELDS = [
  "actualDeliveryAt",
  "actualReturnAt",
  "createdAt",
  "creditReviewStatus",
  "customerConfirmedAt",
  "depositAmount",
  "depositStatus",
  "finalDepositAmount",
  "finalPlanConfirmedAt",
  "id",
  "mileageLimitKm",
  "monthlyFeeAmount",
  "orderNo",
  "orderSource",
  "orderStatus",
  "periodMonths",
  "productReviewStatus",
  "vehicleReviewStatus"
] as const;

const WORKSPACE_APPLICATION_FIELDS = ["applicationNo", "id", "status"] as const;
const WORKSPACE_CHANGE_FIELDS = [
  "approvedAt",
  "approvedBy",
  "changeType",
  "createdAt",
  "createdBy",
  "executedAt",
  "id",
  "orderId",
  "reason",
  "status",
  "updatedAt",
  "updatedBy"
] as const;
const WORKSPACE_CONTRACT_FIELDS = [
  "archivedAt",
  "contractNo",
  "contractTitle",
  "createdAt",
  "fileId",
  "id",
  "signedAt",
  "status",
  "updatedAt"
] as const;
const WORKSPACE_CUSTOMER_FIELDS = ["grade", "id", "mobile", "name"] as const;
const WORKSPACE_CUSTOMER_IDENTITY_FIELDS = ["id", "idCardNoPresent"] as const;
const WORKSPACE_CUSTOMER_PROFILE_FIELDS = ["residenceAddress"] as const;
const WORKSPACE_QUOTE_FIELDS = ["id", "quoteNo", "status"] as const;
const WORKSPACE_RISK_FIELDS = [
  "applicationId",
  "approvedAt",
  "approvedBy",
  "approvedDepositAmount",
  "createdAt",
  "customerId",
  "defaultRate",
  "grade",
  "id",
  "maxVehiclePurchasePriceAmount",
  "remark",
  "result",
  "score",
  "updatedAt"
] as const;
const WORKSPACE_VEHICLE_FIELDS = [
  "batteryCapacityKwh",
  "batteryUsageType",
  "batteryUsageTypeLabel",
  "brand",
  "currentMileageKm",
  "currentSalePriceAmount",
  "id",
  "model",
  "modelDefinitionId",
  "modelYear",
  "plateNo",
  "series",
  "status",
  "vehicleModel",
  "vehicleNo",
  "vin"
] as const;
const WORKSPACE_VEHICLE_ORDER_FIELDS = [
  "legacyVehicleModelSnapshot",
  "modelDisplayName",
  "modelDisplayNameSnapshot",
  "modelDisplaySource",
  "vehicleModel"
] as const;
const WORKSPACE_VEHICLE_INSURANCE_POLICY_FIELDS = [
  "createdAt",
  "currency",
  "effectiveFrom",
  "effectiveTo",
  "id",
  "insuredAmount",
  "insuredName",
  "insurerName",
  "policyHolderName",
  "policyNo",
  "policyStatus",
  "policyType",
  "premiumAmount",
  "remark",
  "renewalReminderAt",
  "updatedAt",
  "vehicleId"
] as const;
const WORKSPACE_VEHICLE_DOCUMENT_FIELDS = [
  "customerVisible",
  "description",
  "documentStatus",
  "documentType",
  "effectiveFrom",
  "effectiveTo",
  "fileName",
  "fileSize",
  "id",
  "mimeType",
  "originalName",
  "title"
] as const;
const WORKSPACE_INSURANCE_CLAIM_FIELDS = [
  "acceptedAt",
  "accidentAt",
  "approvedAmount",
  "claimNo",
  "claimStatus",
  "closedAt",
  "customerId",
  "estimatedAmount",
  "id",
  "insurerClaimNo",
  "orderId",
  "paidAmount",
  "policyId",
  "remark",
  "serviceCaseId",
  "submittedAt",
  "vehicleId"
] as const;

const WORKSPACE_QUOTE_SNAPSHOT_FIELDS = [
  "benefitPackageId",
  "benefitPackagePriceAmount",
  "cancelledAt",
  "confirmedAt",
  "createdAt",
  "energyLimitCount",
  "energyLimitKwh",
  "energyPackageId",
  "energyPackagePriceAmount",
  "expiredAt",
  "id",
  "mileageLimitKm",
  "mileagePackageId",
  "mileagePackagePriceAmount",
  "monthlyFeeAmount",
  "monthlyFeeCapAmount",
  "monthlyFeeRate",
  "overMileageFeeAmount",
  "periodMonths",
  "productId",
  "productVersionId",
  "quoteNo",
  "status",
  "subscriptionPlanId",
  "updatedAt",
  "vehicleBaseFeeAmount",
  "vehicleBaseFeeCapAmount",
  "vehiclePackageId"
] as const;
const WORKSPACE_QUOTE_PRICING_FIELDS = [
  "benefitPackagePriceAmount",
  "energyPackagePriceAmount",
  "fixedRate",
  "mileagePackagePriceAmount",
  "monthlyFeeAmount",
  "vehicleBaseFeeAmount",
  "vehicleBaseFeeCapAmount",
  "vehicleBaseFeeMode",
  "vehicleBaseFeeModeLabel"
] as const;
const WORKSPACE_QUOTE_PACKAGE_SNAPSHOT_FIELDS = [
  "monthlyFeeCapAmount",
  "subscriptionPlanId",
  "vehicleBaseFeeAmount",
  "vehicleBaseFeeCapAmount",
  "vehicleBaseFeeMode",
  "vehicleBaseFeeModeLabel"
] as const;
const WORKSPACE_QUOTE_PACKAGE_FIELDS = [
  "benefitCount",
  "benefitType",
  "configName",
  "description",
  "id",
  "maxPurchasePriceAmount",
  "minPurchasePriceAmount",
  "monthlyEnergyCount",
  "monthlyEnergyKwh",
  "monthlyFeeRate",
  "monthlyMileageKm",
  "overMileageFeeAmount",
  "packageName",
  "packageNo",
  "priceAmount",
  "productId",
  "productVersionId",
  "status",
  "vehicleModel"
] as const;
const WORKSPACE_QUOTE_SUBSCRIPTION_PLAN_FIELDS = [
  "baseMonthlyFeeAmount",
  "benefitPackageId",
  "effectiveFrom",
  "effectiveTo",
  "energyPackageId",
  "id",
  "maxPeriodMonths",
  "mileagePackageId",
  "minPeriodMonths",
  "monthlyFeeCapRate",
  "monthlyFeeMode",
  "monthlyFeeModeLabel",
  "monthlyFeeRate",
  "planName",
  "planNo",
  "productId",
  "productVersionId",
  "status",
  "vehiclePackageId"
] as const;
const WORKSPACE_QUOTE_PRODUCT_FIELDS = [
  "id",
  "name",
  "productNo",
  "productType",
  "status"
] as const;
const WORKSPACE_QUOTE_PRODUCT_VERSION_FIELDS = [
  "effectiveFrom",
  "effectiveTo",
  "id",
  "productId",
  "status",
  "versionNo"
] as const;
const WORKSPACE_QUOTE_RISK_TOP_LEVEL_FIELDS = [
  "customerGrade",
  "defaultRate",
  "depositAmount",
  "depositDescription",
  "depositStatus",
  "finalDepositAmount",
  "riskResultId",
  "riskScore"
] as const;
const WORKSPACE_QUOTE_DEPOSIT_RULE_FIELDS = [
  "customerGrade",
  "defaultRate",
  "depositAmount",
  "depositDescription",
  "depositRuleId",
  "grade",
  "id",
  "status"
] as const;
const WORKSPACE_QUOTE_VEHICLE_TOP_LEVEL_FIELDS = [
  "assetLocation",
  "batteryCapacityKwh",
  "batteryUsageType",
  "batteryUsageTypeLabel",
  "brand",
  "currentMileageKm",
  "currentSalePriceAmount",
  "legacyVehicleModelCodeSnapshot",
  "legacyVehicleModelSnapshot",
  "model",
  "modelDefinitionIdSnapshot",
  "modelDisplayName",
  "modelDisplayNameSnapshot",
  "modelDisplaySource",
  "modelYear",
  "plateNo",
  "series",
  "vehicleId",
  "vehicleModel",
  "vehicleNo",
  "vehiclePurchasePriceAmount",
  "vehicleSalePriceAmount",
  "vin"
] as const;
const WORKSPACE_QUOTE_VEHICLE_FIELDS = [
  "assetLocation",
  "batteryCapacityKwh",
  "batteryUsageType",
  "batteryUsageTypeLabel",
  "brand",
  "currentMileageKm",
  "currentSalePriceAmount",
  "id",
  "model",
  "modelDefinitionId",
  "modelYear",
  "plateNo",
  "series",
  "status",
  "vehicleModel",
  "vehicleNo",
  "vin"
] as const;
const WORKSPACE_CHANGE_AFTER_FIELDS = [
  "action",
  "changeStage",
  "changeType",
  "contractCancelled",
  "nextStep",
  "orderSource",
  "orderStatus",
  "periodMonths",
  "vehicleReleased"
] as const;
const WORKSPACE_CHANGE_AFTER_PRODUCT_FIELDS = [
  "benefitPackageId",
  "benefitPackagePriceAmount",
  "energyPackageId",
  "energyPackagePriceAmount",
  "mileagePackageId",
  "mileagePackagePriceAmount",
  "monthlyFeeAmount",
  "overMileageFeeAmount",
  "productId",
  "productVersionId",
  "subscriptionPlanId",
  "vehicleBaseFeeAmount",
  "vehicleBaseFeeCapAmount",
  "vehiclePackageId"
] as const;
const WORKSPACE_CHANGE_AFTER_VEHICLE_FIELDS = [
  "vehicleId",
  "vehicleStatus"
] as const;
const WORKSPACE_PRODUCT_SNAPSHOT_PERMISSIONS = [
  PermissionCode.QUOTE_VIEW,
  PermissionCode.PRODUCT_VIEW,
  PermissionCode.PRODUCT_VERSION_VIEW,
  PermissionCode.SUBSCRIPTION_PLAN_VIEW,
  PermissionCode.VEHICLE_PACKAGE_VIEW,
  PermissionCode.MILEAGE_PACKAGE_VIEW,
  PermissionCode.ENERGY_PACKAGE_VIEW,
  PermissionCode.BENEFIT_PACKAGE_VIEW
] as const;

export function projectOrderWorkspaceDetail(
  rawDetail: Record<string, unknown>,
  permissions: ReadonlySet<string>
): OrderWorkspaceDetail {
  return projectOrderWorkspaceDetailInternal(rawDetail, permissions, true);
}

function projectOrderWorkspaceDetailInternal(
  rawDetail: Record<string, unknown>,
  permissions: ReadonlySet<string>,
  includeChanges: boolean
): OrderWorkspaceDetail {
  const detail = pickWorkspaceFields(rawDetail, WORKSPACE_DETAIL_BASE_FIELDS);

  if (
    permissions.has(PermissionCode.CUSTOMER_VIEW) ||
    permissions.has(PermissionCode.PAYMENT_CREATE)
  ) {
    copyWorkspaceField(detail, rawDetail, "customerId");
  }

  if (permissions.has(PermissionCode.CUSTOMER_VIEW)) {
    const customer = projectWorkspaceRecord(
      rawDetail.customer,
      WORKSPACE_CUSTOMER_FIELDS
    );
    if (isWorkspaceRecord(customer) && isWorkspaceRecord(rawDetail.customer)) {
      assignProjectedRecord(
        customer,
        "identity",
        rawDetail.customer.identity,
        WORKSPACE_CUSTOMER_IDENTITY_FIELDS
      );
      assignProjectedRecord(
        customer,
        "profile",
        rawDetail.customer.profile,
        WORKSPACE_CUSTOMER_PROFILE_FIELDS
      );
    }
    assignProjectedValue(detail, "customer", customer);
  }

  if (permissions.has(PermissionCode.RISK_VIEW)) {
    assignProjectedRecord(
      detail,
      "riskResult",
      rawDetail.riskResult,
      WORKSPACE_RISK_FIELDS
    );
  }

  if (permissions.has(PermissionCode.APPLICATION_VIEW)) {
    assignProjectedRecord(
      detail,
      "application",
      rawDetail.application,
      WORKSPACE_APPLICATION_FIELDS
    );
  }

  if (permissions.has(PermissionCode.QUOTE_VIEW)) {
    assignProjectedRecord(detail, "quote", rawDetail.quote, WORKSPACE_QUOTE_FIELDS);
    assignProjectedValue(
      detail,
      "quoteSnapshot",
      projectWorkspaceQuoteSnapshot(rawDetail.quoteSnapshot, permissions)
    );
  }

  if (permissions.has(PermissionCode.CONTRACT_VIEW)) {
    assignProjectedRecord(
      detail,
      "contract",
      rawDetail.contract,
      WORKSPACE_CONTRACT_FIELDS
    );
    copyWorkspaceField(detail, rawDetail, "contractId");
    assignProjectedArray(
      detail,
      "contracts",
      rawDetail.contracts,
      WORKSPACE_CONTRACT_FIELDS
    );
  }

  if (
    includeChanges &&
    permissions.has(PermissionCode.ORDER_CHANGE_VIEW) &&
    Array.isArray(rawDetail.changes)
  ) {
    detail.changes = rawDetail.changes
      .filter(isWorkspaceRecord)
      .map((change) => projectOrderChangeView(change, permissions));
  }

  if (permissions.has(PermissionCode.VEHICLE_VIEW)) {
    for (const field of WORKSPACE_VEHICLE_ORDER_FIELDS) {
      copyWorkspaceField(detail, rawDetail, field);
    }
    const vehicle = projectWorkspaceRecord(
      rawDetail.vehicle,
      WORKSPACE_VEHICLE_FIELDS
    );
    if (isWorkspaceRecord(vehicle) && isWorkspaceRecord(rawDetail.vehicle)) {
      const hasInsuranceView = permissions.has(
        PermissionCode.VEHICLE_INSURANCE_VIEW
      );
      if (hasInsuranceView) {
        assignProjectedArray(
          vehicle,
          "insurancePolicies",
          rawDetail.vehicle.insurancePolicies,
          WORKSPACE_VEHICLE_INSURANCE_POLICY_FIELDS
        );
      }
      if (
        hasInsuranceView &&
        permissions.has(PermissionCode.VEHICLE_DOCUMENT_VIEW)
      ) {
        assignProjectedArray(
          vehicle,
          "documents",
          rawDetail.vehicle.documents,
          WORKSPACE_VEHICLE_DOCUMENT_FIELDS
        );
      }
      if (
        hasInsuranceView &&
        permissions.has(PermissionCode.INSURANCE_CLAIM_VIEW)
      ) {
        assignProjectedArray(
          vehicle,
          "insuranceClaims",
          rawDetail.vehicle.insuranceClaims,
          WORKSPACE_INSURANCE_CLAIM_FIELDS
        );
      }
    }
    assignProjectedValue(detail, "vehicle", vehicle);
  }

  return detail as OrderWorkspaceDetail;
}

export function projectOrderChangeView(
  rawChange: Record<string, unknown>,
  permissions: ReadonlySet<string>
): Record<string, unknown> {
  const result = pickWorkspaceFields(rawChange, WORKSPACE_CHANGE_FIELDS);
  assignProjectedValue(
    result,
    "beforeSnapshot",
    projectOrderChangeBeforeSnapshot(rawChange.beforeSnapshot, permissions)
  );
  assignProjectedValue(
    result,
    "afterSnapshot",
    projectOrderChangeAfterSnapshot(rawChange.afterSnapshot, permissions)
  );
  return result;
}

export function projectWorkspaceQuoteSnapshot(
  value: unknown,
  permissions: ReadonlySet<string>
): Record<string, unknown> | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isWorkspaceRecord(value)) {
    return undefined;
  }

  const result = pickWorkspaceFields(value, WORKSPACE_QUOTE_SNAPSHOT_FIELDS);
  assignProjectedValue(
    result,
    "packageSnapshot",
    projectQuotePackageSnapshot(value.packageSnapshot, permissions)
  );
  assignProjectedValue(
    result,
    "pricing",
    projectQuotePricing(value.pricing, permissions)
  );
  assignProjectedRecord(
    result,
    "subscriptionPlan",
    value.subscriptionPlan,
    WORKSPACE_QUOTE_SUBSCRIPTION_PLAN_FIELDS
  );

  const productVersion = projectWorkspaceRecord(
    value.productVersion,
    WORKSPACE_QUOTE_PRODUCT_VERSION_FIELDS
  );
  if (isWorkspaceRecord(productVersion) && isWorkspaceRecord(value.productVersion)) {
    assignProjectedRecord(
      productVersion,
      "product",
      value.productVersion.product,
      WORKSPACE_QUOTE_PRODUCT_FIELDS
    );
  }
  assignProjectedValue(result, "productVersion", productVersion);

  if (permissions.has(PermissionCode.CUSTOMER_VIEW)) {
    copyWorkspaceField(result, value, "customerId");
    assignProjectedRecord(result, "customer", value.customer, WORKSPACE_CUSTOMER_FIELDS);
  }

  if (permissions.has(PermissionCode.APPLICATION_VIEW)) {
    copyWorkspaceField(result, value, "applicationId");
    assignProjectedRecord(
      result,
      "application",
      value.application,
      WORKSPACE_APPLICATION_FIELDS
    );
  }

  if (permissions.has(PermissionCode.RISK_VIEW)) {
    for (const field of WORKSPACE_QUOTE_RISK_TOP_LEVEL_FIELDS) {
      copyWorkspaceField(result, value, field);
    }
    assignProjectedRecord(
      result,
      "depositRuleSnapshot",
      value.depositRuleSnapshot,
      WORKSPACE_QUOTE_DEPOSIT_RULE_FIELDS
    );
    assignProjectedRecord(result, "riskResult", value.riskResult, WORKSPACE_RISK_FIELDS);
  }

  if (permissions.has(PermissionCode.VEHICLE_VIEW)) {
    for (const field of WORKSPACE_QUOTE_VEHICLE_TOP_LEVEL_FIELDS) {
      copyWorkspaceField(result, value, field);
    }
    assignProjectedRecord(
      result,
      "vehicle",
      value.vehicle,
      WORKSPACE_QUOTE_VEHICLE_FIELDS
    );
    assignProjectedRecord(
      result,
      "vehicleSnapshot",
      value.vehicleSnapshot,
      WORKSPACE_QUOTE_VEHICLE_FIELDS
    );
  }

  return result;
}

function projectOrderChangeBeforeSnapshot(
  value: unknown,
  permissions: ReadonlySet<string>
): Record<string, unknown> | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isWorkspaceRecord(value)) {
    return undefined;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "order") ||
    Object.prototype.hasOwnProperty.call(value, "requestedChange")
  ) {
    const result: Record<string, unknown> = {};
    if (isWorkspaceRecord(value.order)) {
      result.order = projectOrderWorkspaceDetailInternal(
        value.order,
        permissions,
        false
      );
    } else if (value.order === null) {
      result.order = null;
    }
    assignProjectedValue(
      result,
      "requestedChange",
      projectOrderChangeAfterSnapshot(value.requestedChange, permissions)
    );
    return result;
  }

  return projectOrderWorkspaceDetailInternal(value, permissions, false);
}

function projectOrderChangeAfterSnapshot(
  value: unknown,
  permissions: ReadonlySet<string>
): Record<string, unknown> | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isWorkspaceRecord(value)) {
    return undefined;
  }

  const result = pickWorkspaceFields(value, WORKSPACE_CHANGE_AFTER_FIELDS);
  const hasProductSnapshotView = WORKSPACE_PRODUCT_SNAPSHOT_PERMISSIONS.some(
    (permission) => permissions.has(permission)
  );
  if (hasProductSnapshotView) {
    for (const field of WORKSPACE_CHANGE_AFTER_PRODUCT_FIELDS) {
      copyWorkspaceField(result, value, field);
    }
    assignProjectedValue(
      result,
      "packageSnapshot",
      projectQuotePackageSnapshot(value.packageSnapshot, permissions)
    );
    assignProjectedValue(
      result,
      "pricing",
      projectQuotePricing(value.pricing, permissions)
    );
    assignProjectedValue(
      result,
      "quoteSnapshot",
      projectWorkspaceQuoteSnapshot(value.quoteSnapshot, permissions)
    );
  }
  if (permissions.has(PermissionCode.VEHICLE_VIEW)) {
    for (const field of WORKSPACE_CHANGE_AFTER_VEHICLE_FIELDS) {
      copyWorkspaceField(result, value, field);
    }
  }
  if (isWorkspaceRecord(value.order)) {
    result.order = projectOrderWorkspaceDetailInternal(
      value.order,
      permissions,
      false
    );
  } else if (value.order === null) {
    result.order = null;
  }
  return result;
}

function projectQuotePackageSnapshot(
  value: unknown,
  permissions: ReadonlySet<string>
): Record<string, unknown> | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isWorkspaceRecord(value)) {
    return undefined;
  }

  const result = pickWorkspaceFields(
    value,
    WORKSPACE_QUOTE_PACKAGE_SNAPSHOT_FIELDS
  );
  for (const field of [
    "benefitPackage",
    "energyPackage",
    "mileagePackage",
    "vehiclePackage"
  ] as const) {
    assignProjectedRecord(
      result,
      field,
      value[field],
      WORKSPACE_QUOTE_PACKAGE_FIELDS
    );
  }
  assignProjectedValue(
    result,
    "pricing",
    projectQuotePricing(value.pricing, permissions)
  );
  assignProjectedRecord(
    result,
    "subscriptionPlan",
    value.subscriptionPlan,
    WORKSPACE_QUOTE_SUBSCRIPTION_PLAN_FIELDS
  );
  if (permissions.has(PermissionCode.RISK_VIEW)) {
    assignProjectedRecord(
      result,
      "depositRule",
      value.depositRule,
      WORKSPACE_QUOTE_DEPOSIT_RULE_FIELDS
    );
    assignProjectedRecord(
      result,
      "depositRuleSnapshot",
      value.depositRuleSnapshot,
      WORKSPACE_QUOTE_DEPOSIT_RULE_FIELDS
    );
  }
  return result;
}

function projectQuotePricing(
  value: unknown,
  permissions: ReadonlySet<string>
): Record<string, unknown> | null | undefined {
  const result = projectWorkspaceRecord(value, WORKSPACE_QUOTE_PRICING_FIELDS);
  if (
    isWorkspaceRecord(result) &&
    isWorkspaceRecord(value) &&
    permissions.has(PermissionCode.VEHICLE_VIEW)
  ) {
    copyWorkspaceField(result, value, "currentSalePriceAmount");
  }
  return result;
}

function pickWorkspaceFields(
  source: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    copyWorkspaceField(result, source, field);
  }
  return result;
}

function copyWorkspaceField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  field: string
) {
  if (Object.prototype.hasOwnProperty.call(source, field)) {
    target[field] = source[field];
  }
}

function projectWorkspaceRecord(
  value: unknown,
  fields: readonly string[]
): Record<string, unknown> | null | undefined {
  if (value === null) {
    return null;
  }
  return isWorkspaceRecord(value) ? pickWorkspaceFields(value, fields) : undefined;
}

function assignProjectedRecord(
  target: Record<string, unknown>,
  field: string,
  value: unknown,
  fields: readonly string[]
) {
  assignProjectedValue(target, field, projectWorkspaceRecord(value, fields));
}

function assignProjectedArray(
  target: Record<string, unknown>,
  field: string,
  value: unknown,
  fields: readonly string[]
) {
  if (!Array.isArray(value)) {
    return;
  }
  target[field] = value
    .filter(isWorkspaceRecord)
    .map((item) => pickWorkspaceFields(item, fields));
}

function assignProjectedValue(
  target: Record<string, unknown>,
  field: string,
  value: unknown
) {
  if (value !== undefined) {
    target[field] = value;
  }
}

function isWorkspaceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
