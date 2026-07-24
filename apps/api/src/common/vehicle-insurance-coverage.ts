import {
  VehicleInsurancePolicyStatus,
  VehicleInsurancePolicyType
} from "@prisma/client";

export interface InsurancePolicyCoverageInput {
  deletedAt?: Date | null;
  effectiveFrom: Date;
  effectiveTo: Date;
  id: string;
  policyStatus: VehicleInsurancePolicyStatus;
  policyType: VehicleInsurancePolicyType;
}

export interface PolicyTypeCoverage {
  covered: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  policyId: string | null;
}

export interface VehicleInsuranceCoverageResult {
  commercial: PolicyTypeCoverage;
  compulsoryTraffic: PolicyTypeCoverage;
  covered: boolean;
  evaluationDate: Date;
}

export function resolveVehicleInsuranceCoverage(
  policies: readonly InsurancePolicyCoverageInput[],
  evaluationDate: Date
): VehicleInsuranceCoverageResult {
  const evaluationDateKey = dateKey(evaluationDate);
  const candidates = policies.filter(
    (policy) =>
      !policy.deletedAt &&
      policy.policyStatus === VehicleInsurancePolicyStatus.ACTIVE &&
      dateKey(policy.effectiveFrom) <= evaluationDateKey &&
      evaluationDateKey <= dateKey(policy.effectiveTo)
  );
  const compulsoryTraffic = selectCoverage(
    candidates,
    VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
  );
  const commercial = selectCoverage(candidates, VehicleInsurancePolicyType.COMMERCIAL);

  return {
    commercial,
    compulsoryTraffic,
    covered: compulsoryTraffic.covered && commercial.covered,
    evaluationDate
  };
}

function selectCoverage(
  policies: readonly InsurancePolicyCoverageInput[],
  policyType: VehicleInsurancePolicyType
): PolicyTypeCoverage {
  const selected = policies
    .filter((policy) => policy.policyType === policyType)
    .sort(
      (left, right) =>
        right.effectiveFrom.getTime() - left.effectiveFrom.getTime() ||
        right.effectiveTo.getTime() - left.effectiveTo.getTime() ||
        left.id.localeCompare(right.id)
    )[0];

  if (!selected) {
    return {
      covered: false,
      effectiveFrom: null,
      effectiveTo: null,
      policyId: null
    };
  }

  return {
    covered: true,
    effectiveFrom: selected.effectiveFrom,
    effectiveTo: selected.effectiveTo,
    policyId: selected.id
  };
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}
