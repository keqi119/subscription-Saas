export interface MileageSettlement {
  actualUsageKm: number;
  consumedAllowanceKm: number;
  unusedAllowanceKm: number;
  overMileageKm: number;
  overMileageAmount: bigint;
}

export function calculateMileageSettlement(input: {
  baselineMileageKm: number;
  submittedMileageKm: number;
  allowanceKm: number;
  overMileageFeeAmount: bigint;
}): MileageSettlement {
  assertMileageValues([
    input.baselineMileageKm,
    input.submittedMileageKm,
    input.allowanceKm
  ]);
  if (input.overMileageFeeAmount < 0n) {
    throw new RangeError("Over-mileage fee must be non-negative.");
  }
  if (input.submittedMileageKm < input.baselineMileageKm) {
    throw new RangeError(
      "Submitted mileage cannot be lower than the confirmed baseline."
    );
  }

  const actualUsageKm = input.submittedMileageKm - input.baselineMileageKm;
  const consumedAllowanceKm = Math.min(actualUsageKm, input.allowanceKm);
  const overMileageKm = Math.max(actualUsageKm - input.allowanceKm, 0);

  return {
    actualUsageKm,
    consumedAllowanceKm,
    unusedAllowanceKm: input.allowanceKm - consumedAllowanceKm,
    overMileageKm,
    overMileageAmount: BigInt(overMileageKm) * input.overMileageFeeAmount
  };
}

function assertMileageValues(values: number[]) {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("Mileage values must be non-negative safe integers.");
  }
}
