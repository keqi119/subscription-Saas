import { VehicleAssetCostProfile, VehicleDepreciationMethod } from "@prisma/client";

type VehicleCostBasis = {
  purchasePriceAmount: bigint | number;
};

export const MANUAL_DEPRECIATION_UNSUPPORTED_REASON =
  "MANUAL 折旧方法暂未配置手工折旧明细，无法试算 ROA。";

export function buildVehicleAssetCostProfilePreview(
  vehicle: VehicleCostBasis,
  profile: VehicleAssetCostProfile
) {
  const purchasePriceAmount = Number(vehicle.purchasePriceAmount);
  const residualValueAmount = Number(profile.residualValueAmount);
  const depreciableAmount = Math.max(purchasePriceAmount - residualValueAmount, 0);
  const monthlyDepreciationAmount = monthlyDepreciation(profile, depreciableAmount);
  const annualCapitalCostAmount = annualCapitalCostAmountFor(vehicle, profile);
  const monthlyCapitalCostAmount = Math.round(annualCapitalCostAmount / 12);
  const monthlyInsuranceCostAmount = Math.round(amountOrZero(profile.annualInsuranceCostAmount) / 12);
  const monthlyMaintenanceReserveAmount = Math.round(
    amountOrZero(profile.annualMaintenanceReserveAmount) / 12
  );
  const otherMonthlyCostAmount = amountOrZero(profile.otherMonthlyCostAmount);
  const estimatedMonthlyCostAmount =
    monthlyDepreciationAmount === null
      ? null
      : monthlyDepreciationAmount +
        monthlyCapitalCostAmount +
        monthlyInsuranceCostAmount +
        monthlyMaintenanceReserveAmount +
        otherMonthlyCostAmount;

  return {
    annualCapitalCostAmount,
    depreciableAmount,
    estimatedMonthlyCostAmount,
    monthlyCapitalCostAmount,
    monthlyDepreciationAmount,
    monthlyInsuranceCostAmount,
    monthlyMaintenanceReserveAmount,
    otherMonthlyCostAmount,
    purchasePriceAmount,
    residualValueAmount
  };
}

export function buildVehicleAssetPeriodCost(
  vehicle: VehicleCostBasis,
  profile: VehicleAssetCostProfile,
  costDays: number
) {
  const safeCostDays = Math.max(costDays, 0);
  const preview = buildVehicleAssetCostProfilePreview(vehicle, profile);
  const depreciationCostAmount =
    preview.monthlyDepreciationAmount === null
      ? null
      : periodCostFromMonthly(preview.monthlyDepreciationAmount, safeCostDays);
  const capitalCostAmount = periodCostFromAnnual(preview.annualCapitalCostAmount, safeCostDays);
  const insuranceCostAmount = periodCostFromAnnual(
    amountOrZero(profile.annualInsuranceCostAmount),
    safeCostDays
  );
  const maintenanceReserveCostAmount = periodCostFromAnnual(
    amountOrZero(profile.annualMaintenanceReserveAmount),
    safeCostDays
  );
  const otherCostAmount = periodCostFromMonthly(preview.otherMonthlyCostAmount, safeCostDays);
  const operatingCostAmount =
    depreciationCostAmount === null
      ? null
      : depreciationCostAmount +
        capitalCostAmount +
        insuranceCostAmount +
        maintenanceReserveCostAmount +
        otherCostAmount;

  return {
    capitalCostAmount,
    depreciationCostAmount,
    insuranceCostAmount,
    maintenanceReserveCostAmount,
    manualDepreciationUnsupported:
      profile.depreciationMethod === VehicleDepreciationMethod.MANUAL,
    operatingCostAmount,
    otherCostAmount
  };
}

function annualCapitalCostAmountFor(vehicle: VehicleCostBasis, profile: VehicleAssetCostProfile) {
  return Math.round((Number(vehicle.purchasePriceAmount) * (profile.capitalCostRateBps ?? 0)) / 10000);
}

function monthlyDepreciation(profile: VehicleAssetCostProfile, depreciableAmount: number) {
  if (profile.depreciationMethod === VehicleDepreciationMethod.NONE) {
    return 0;
  }
  if (profile.depreciationMethod === VehicleDepreciationMethod.MANUAL) {
    return null;
  }
  return Math.round(depreciableAmount / profile.usefulLifeMonths);
}

function periodCostFromMonthly(monthlyAmount: number, costDays: number) {
  return Math.round((monthlyAmount * 12 * costDays) / 365);
}

function periodCostFromAnnual(annualAmount: number, costDays: number) {
  return Math.round((annualAmount * costDays) / 365);
}

function amountOrZero(value: bigint | number | null | undefined) {
  return value === null || value === undefined ? 0 : Number(value);
}
