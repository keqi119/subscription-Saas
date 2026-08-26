const TERMINAL_STATUSES = new Set(["CANCELLED", "COMPLETED"]);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function classifyFinalPlanOrderReconciliation(row) {
  if (TERMINAL_STATUSES.has(row.journeyStatus)) {
    return { action: "NONE", reason: "terminal journeys are immutable" };
  }
  if (row.currentStepCode === "CUSTOMER_PLAN_CONFIRMATION") {
    if (row.steps?.FINAL_VEHICLE_ALLOCATION !== "PENDING") {
      return {
        action: "REPORT_ONLY",
        reason: "customer confirmation has no pending vehicle-allocation step"
      };
    }
    return {
      action: "RETURN_TO_VEHICLE_ALLOCATION",
      reason: "vehicle allocation is still pending before customer confirmation"
    };
  }
  if (row.currentStepCode === "FINAL_VEHICLE_ALLOCATION") {
    if (!row.finalVehicleId || row.softReservedVehicleId !== row.finalVehicleId) {
      return {
        action: "REPORT_ONLY",
        reason: "final vehicle is not held by the application soft reservation"
      };
    }
    if (
      !Number.isSafeInteger(row.finalPlanRevision) ||
      row.finalPlanRevision < 1 ||
      row.customerConfirmedPlanRevision !== row.finalPlanRevision
    ) {
      return {
        action: "REPORT_ONLY",
        reason: "customer confirmation revision does not match the final plan"
      };
    }
    if (!HASH_PATTERN.test(row.finalPlanCommercialHash ?? "")) {
      return { action: "REPORT_ONLY", reason: "final-plan commercial hash is unavailable" };
    }
    if (!HASH_PATTERN.test(row.customerConfirmationCommercialHash ?? "")) {
      return {
        action: "REPORT_ONLY",
        reason: "confirmed commercial hash is unavailable"
      };
    }
    if (row.customerConfirmationCommercialHash !== row.finalPlanCommercialHash) {
      return {
        action: "REPORT_ONLY",
        reason: "confirmed commercial hash does not match the final plan"
      };
    }
    if (row.steps?.CUSTOMER_PLAN_CONFIRMATION !== "COMPLETED") {
      return {
        action: "REPORT_ONLY",
        reason: "customer-confirmation step is not completed"
      };
    }
    return {
      action: "ADVANCE_WITHOUT_RECONFIRMATION",
      reason: "confirmed revision, commercial hash, and soft reservation match"
    };
  }
  return {
    action: "NONE",
    reason: "journey is outside the affected final-plan steps"
  };
}

export function summarizeFinalPlanOrderReconciliation(rows) {
  const results = rows.map((row) => ({
    applicationId: row.applicationId,
    journeyId: row.journeyId,
    ...classifyFinalPlanOrderReconciliation(row)
  }));
  return {
    counts: results.reduce(
      (counts, result) => ({ ...counts, [result.action]: (counts[result.action] ?? 0) + 1 }),
      {}
    ),
    results
  };
}
