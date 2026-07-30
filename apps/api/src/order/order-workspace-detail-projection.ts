import { Prisma } from "@prisma/client";
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
  "modelCode",
  "modelDefinitionId",
  "modelDisplayName",
  "modelYear",
  "plateNo",
  "series",
  "status",
  "vehicleNo",
  "vin"
] as const;
const WORKSPACE_VEHICLE_ORDER_FIELDS = [
  "modelCodeSnapshot",
  "modelDefinitionIdSnapshot",
  "modelDisplayName",
  "modelDisplayNameSnapshot",
  "modelDisplaySource"
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
  "cancelledAt",
  "confirmedAt",
  "createdAt",
  "expiredAt",
  "id",
  "monthlyFeeAmount",
  "periodMonths",
  "quoteNo",
  "status",
  "updatedAt"
] as const;
const WORKSPACE_QUOTE_BENEFIT_PACKAGE_FIELDS = [
  "benefitPackageId",
  "benefitPackagePriceAmount"
] as const;
const WORKSPACE_QUOTE_ENERGY_PACKAGE_FIELDS = [
  "energyLimitCount",
  "energyLimitKwh",
  "energyPackageId",
  "energyPackagePriceAmount"
] as const;
const WORKSPACE_QUOTE_MILEAGE_PACKAGE_FIELDS = [
  "mileageLimitKm",
  "mileagePackageId",
  "mileagePackagePriceAmount",
  "overMileageFeeAmount"
] as const;
const WORKSPACE_QUOTE_VEHICLE_PACKAGE_FIELDS = [
  "vehicleBaseFeeAmount",
  "vehicleBaseFeeCapAmount",
  "monthlyFeeCapAmount",
  "monthlyFeeRate",
  "vehiclePackageId"
] as const;
const WORKSPACE_QUOTE_PRICING_FIELDS = ["monthlyFeeAmount"] as const;
const WORKSPACE_VEHICLE_PACKAGE_PRICING_FIELDS = [
  "fixedRate",
  "vehicleBaseFeeAmount",
  "vehicleBaseFeeCapAmount",
  "vehicleBaseFeeMode",
  "vehicleBaseFeeModeLabel"
] as const;
const WORKSPACE_MILEAGE_PACKAGE_PRICING_FIELDS = [
  "mileagePackagePriceAmount"
] as const;
const WORKSPACE_ENERGY_PACKAGE_PRICING_FIELDS = [
  "energyPackagePriceAmount"
] as const;
const WORKSPACE_BENEFIT_PACKAGE_PRICING_FIELDS = [
  "benefitPackagePriceAmount"
] as const;
const WORKSPACE_VEHICLE_PACKAGE_SNAPSHOT_FIELDS = [
  "monthlyFeeCapAmount",
  "vehicleBaseFeeAmount",
  "vehicleBaseFeeCapAmount",
  "vehicleBaseFeeMode",
  "vehicleBaseFeeModeLabel"
] as const;
const WORKSPACE_QUOTE_PACKAGE_BASE_FIELDS = [
  "id",
  "packageName",
  "packageNo",
  "priceAmount",
  "status"
] as const;
const WORKSPACE_QUOTE_VEHICLE_PACKAGE_RECORD_FIELDS = [
  ...WORKSPACE_QUOTE_PACKAGE_BASE_FIELDS,
  "configName",
  "maxPurchasePriceAmount",
  "minPurchasePriceAmount",
  "modelCode",
  "modelDefinitionId",
  "modelDisplayName",
  "monthlyFeeRate",
] as const;
const WORKSPACE_QUOTE_MILEAGE_PACKAGE_RECORD_FIELDS = [
  ...WORKSPACE_QUOTE_PACKAGE_BASE_FIELDS,
  "monthlyMileageKm",
  "overMileageFeeAmount"
] as const;
const WORKSPACE_QUOTE_ENERGY_PACKAGE_RECORD_FIELDS = [
  ...WORKSPACE_QUOTE_PACKAGE_BASE_FIELDS,
  "monthlyEnergyCount",
  "monthlyEnergyKwh",
] as const;
const WORKSPACE_QUOTE_BENEFIT_PACKAGE_RECORD_FIELDS = [
  ...WORKSPACE_QUOTE_PACKAGE_BASE_FIELDS,
  "benefitCount",
  "benefitType",
  "description"
] as const;
const WORKSPACE_QUOTE_SUBSCRIPTION_PLAN_FIELDS = [
  "baseMonthlyFeeAmount",
  "effectiveFrom",
  "effectiveTo",
  "id",
  "maxPeriodMonths",
  "minPeriodMonths",
  "monthlyFeeCapRate",
  "monthlyFeeMode",
  "monthlyFeeModeLabel",
  "monthlyFeeRate",
  "planName",
  "planNo",
  "status"
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
  "model",
  "modelCode",
  "modelCodeSnapshot",
  "modelDefinitionId",
  "modelDefinitionIdSnapshot",
  "modelDisplayName",
  "modelDisplayNameSnapshot",
  "modelDisplaySource",
  "modelYear",
  "plateNo",
  "series",
  "vehicleId",
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
  "modelCode",
  "modelCodeSnapshot",
  "modelDefinitionId",
  "modelDefinitionIdSnapshot",
  "modelDisplayName",
  "modelDisplayNameSnapshot",
  "modelYear",
  "plateNo",
  "series",
  "status",
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
const WORKSPACE_CHANGE_AFTER_QUOTE_FIELDS = [
  "monthlyFeeAmount"
] as const;
const WORKSPACE_CHANGE_AFTER_BENEFIT_PACKAGE_FIELDS = [
  "benefitPackageId",
  "benefitPackagePriceAmount"
] as const;
const WORKSPACE_CHANGE_AFTER_ENERGY_PACKAGE_FIELDS = [
  "energyPackageId",
  "energyPackagePriceAmount"
] as const;
const WORKSPACE_CHANGE_AFTER_MILEAGE_PACKAGE_FIELDS = [
  "mileagePackageId",
  "mileagePackagePriceAmount",
  "overMileageFeeAmount"
] as const;
const WORKSPACE_CHANGE_AFTER_VEHICLE_PACKAGE_FIELDS = [
  "vehicleBaseFeeAmount",
  "vehicleBaseFeeCapAmount",
  "vehiclePackageId"
] as const;
const WORKSPACE_CHANGE_AFTER_SUBSCRIPTION_PLAN_FIELDS = [
  "subscriptionPlanId"
] as const;
const WORKSPACE_CHANGE_AFTER_PRODUCT_FIELDS = ["productId"] as const;
const WORKSPACE_CHANGE_AFTER_PRODUCT_VERSION_FIELDS = [
  "productVersionId"
] as const;
const WORKSPACE_CHANGE_AFTER_VEHICLE_FIELDS = [
  "vehicleId",
  "vehicleStatus"
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

  const result: Record<string, unknown> = {};
  if (permissions.has(PermissionCode.QUOTE_VIEW)) {
    copyWorkspaceFields(result, value, WORKSPACE_QUOTE_SNAPSHOT_FIELDS);
  }
  if (permissions.has(PermissionCode.BENEFIT_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_QUOTE_BENEFIT_PACKAGE_FIELDS
    );
  }
  if (permissions.has(PermissionCode.ENERGY_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_QUOTE_ENERGY_PACKAGE_FIELDS
    );
  }
  if (permissions.has(PermissionCode.MILEAGE_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_QUOTE_MILEAGE_PACKAGE_FIELDS
    );
  }
  if (permissions.has(PermissionCode.VEHICLE_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_QUOTE_VEHICLE_PACKAGE_FIELDS
    );
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
  if (permissions.has(PermissionCode.SUBSCRIPTION_PLAN_VIEW)) {
    copyWorkspaceField(result, value, "subscriptionPlanId");
    assignProjectedRecord(
      result,
      "subscriptionPlan",
      value.subscriptionPlan,
      WORKSPACE_QUOTE_SUBSCRIPTION_PLAN_FIELDS
    );
  }
  if (permissions.has(PermissionCode.PRODUCT_VIEW)) {
    copyWorkspaceField(result, value, "productId");
    assignProjectedRecord(
      result,
      "product",
      value.product,
      WORKSPACE_QUOTE_PRODUCT_FIELDS
    );
  }
  if (permissions.has(PermissionCode.PRODUCT_VERSION_VIEW)) {
    copyWorkspaceField(result, value, "productVersionId");
    assignProjectedValue(
      result,
      "productVersion",
      projectQuoteProductVersion(value.productVersion, permissions)
    );
  }

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

function projectQuoteProductVersion(
  value: unknown,
  permissions: ReadonlySet<string>
): Record<string, unknown> | null | undefined {
  const result = projectWorkspaceRecord(
    value,
    WORKSPACE_QUOTE_PRODUCT_VERSION_FIELDS
  );
  if (
    isWorkspaceRecord(result) &&
    isWorkspaceRecord(value) &&
    permissions.has(PermissionCode.PRODUCT_VIEW)
  ) {
    copyWorkspaceField(result, value, "productId");
    assignProjectedRecord(
      result,
      "product",
      value.product,
      WORKSPACE_QUOTE_PRODUCT_FIELDS
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
  if (permissions.has(PermissionCode.QUOTE_VIEW)) {
    copyWorkspaceFields(result, value, WORKSPACE_CHANGE_AFTER_QUOTE_FIELDS);
    assignProjectedValue(
      result,
      "quoteSnapshot",
      projectWorkspaceQuoteSnapshot(value.quoteSnapshot, permissions)
    );
  }
  if (permissions.has(PermissionCode.BENEFIT_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_CHANGE_AFTER_BENEFIT_PACKAGE_FIELDS
    );
  }
  if (permissions.has(PermissionCode.ENERGY_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_CHANGE_AFTER_ENERGY_PACKAGE_FIELDS
    );
  }
  if (permissions.has(PermissionCode.MILEAGE_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_CHANGE_AFTER_MILEAGE_PACKAGE_FIELDS
    );
  }
  if (permissions.has(PermissionCode.VEHICLE_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_CHANGE_AFTER_VEHICLE_PACKAGE_FIELDS
    );
  }
  if (permissions.has(PermissionCode.SUBSCRIPTION_PLAN_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_CHANGE_AFTER_SUBSCRIPTION_PLAN_FIELDS
    );
    assignProjectedRecord(
      result,
      "subscriptionPlan",
      value.subscriptionPlan,
      WORKSPACE_QUOTE_SUBSCRIPTION_PLAN_FIELDS
    );
  }
  if (permissions.has(PermissionCode.PRODUCT_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_CHANGE_AFTER_PRODUCT_FIELDS
    );
    assignProjectedRecord(
      result,
      "product",
      value.product,
      WORKSPACE_QUOTE_PRODUCT_FIELDS
    );
  }
  if (permissions.has(PermissionCode.PRODUCT_VERSION_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_CHANGE_AFTER_PRODUCT_VERSION_FIELDS
    );
    assignProjectedValue(
      result,
      "productVersion",
      projectQuoteProductVersion(value.productVersion, permissions)
    );
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

  const result: Record<string, unknown> = {};
  if (permissions.has(PermissionCode.BENEFIT_PACKAGE_VIEW)) {
    assignProjectedRecord(
      result,
      "benefitPackage",
      value.benefitPackage,
      WORKSPACE_QUOTE_BENEFIT_PACKAGE_RECORD_FIELDS
    );
  }
  if (permissions.has(PermissionCode.ENERGY_PACKAGE_VIEW)) {
    assignProjectedRecord(
      result,
      "energyPackage",
      value.energyPackage,
      WORKSPACE_QUOTE_ENERGY_PACKAGE_RECORD_FIELDS
    );
  }
  if (permissions.has(PermissionCode.MILEAGE_PACKAGE_VIEW)) {
    assignProjectedRecord(
      result,
      "mileagePackage",
      value.mileagePackage,
      WORKSPACE_QUOTE_MILEAGE_PACKAGE_RECORD_FIELDS
    );
  }
  if (permissions.has(PermissionCode.VEHICLE_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_VEHICLE_PACKAGE_SNAPSHOT_FIELDS
    );
    assignProjectedRecord(
      result,
      "vehiclePackage",
      value.vehiclePackage,
      WORKSPACE_QUOTE_VEHICLE_PACKAGE_RECORD_FIELDS
    );
  }
  assignProjectedValue(
    result,
    "pricing",
    projectQuotePricing(value.pricing, permissions)
  );
  if (permissions.has(PermissionCode.SUBSCRIPTION_PLAN_VIEW)) {
    copyWorkspaceField(result, value, "subscriptionPlanId");
    assignProjectedRecord(
      result,
      "subscriptionPlan",
      value.subscriptionPlan,
      WORKSPACE_QUOTE_SUBSCRIPTION_PLAN_FIELDS
    );
  }
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
  if (value === null) {
    return null;
  }
  if (!isWorkspaceRecord(value)) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  if (permissions.has(PermissionCode.QUOTE_VIEW)) {
    copyWorkspaceFields(result, value, WORKSPACE_QUOTE_PRICING_FIELDS);
  }
  if (permissions.has(PermissionCode.BENEFIT_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_BENEFIT_PACKAGE_PRICING_FIELDS
    );
  }
  if (permissions.has(PermissionCode.ENERGY_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_ENERGY_PACKAGE_PRICING_FIELDS
    );
  }
  if (permissions.has(PermissionCode.MILEAGE_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_MILEAGE_PACKAGE_PRICING_FIELDS
    );
  }
  if (permissions.has(PermissionCode.VEHICLE_PACKAGE_VIEW)) {
    copyWorkspaceFields(
      result,
      value,
      WORKSPACE_VEHICLE_PACKAGE_PRICING_FIELDS
    );
  }
  if (permissions.has(PermissionCode.VEHICLE_VIEW)) {
    copyWorkspaceField(result, value, "currentSalePriceAmount");
  }
  return result;
}

function copyWorkspaceFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  fields: readonly string[]
) {
  for (const field of fields) {
    copyWorkspaceField(target, source, field);
  }
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
  if (!Object.prototype.hasOwnProperty.call(source, field)) {
    return;
  }
  const scalar = serializeWorkspaceScalar(source[field]);
  if (scalar !== undefined) {
    target[field] = scalar;
  }
}

function serializeWorkspaceScalar(
  value: unknown
): boolean | number | string | null | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (value instanceof Prisma.Decimal) {
    return value.toString();
  }
  return undefined;
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
  if (
    value === undefined ||
    (isWorkspaceRecord(value) && Object.keys(value).length === 0)
  ) {
    return;
  }
  target[field] = value;
}

function isWorkspaceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
