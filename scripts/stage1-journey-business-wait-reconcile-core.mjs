export const LEGACY_APPLICATION_BUSINESS_WAIT_CODES = new Set([
  "JOURNEY_APPLICATION_CREDIT_NOT_APPROVED",
  "JOURNEY_APPLICATION_MATERIALS_INCOMPLETE"
]);

export function classifyBusinessWaitReconciliation(row) {
  if (
    row.exceptionStatus !== "OPEN" ||
    row.currentStepCode !== "APPLICATION_VALIDATION" ||
    row.currentStepStatus !== "EXCEPTION" ||
    row.journeyStatus !== "EXCEPTION"
  ) {
    return classification(
      "NONE",
      null,
      "journey is not an open application-validation exception",
      []
    );
  }

  const exceptionCodes = uniqueStrings(row.exceptionCodes);
  if (
    exceptionCodes.length === 0 ||
    exceptionCodes.some((code) => !LEGACY_APPLICATION_BUSINESS_WAIT_CODES.has(code))
  ) {
    return classification(
      "REPORT_ONLY",
      null,
      "open exception code is outside the legacy business-wait allowlist",
      []
    );
  }

  const readiness = classifyCurrentApplicationFacts(row);
  return classification(
    "REVALIDATE_APPLICATION",
    readiness.outcome,
    "legacy business-wait exception can use the canonical validator",
    readiness.reasonCodes
  );
}

export function summarizeBusinessWaitReconciliation(rows) {
  const counts = {
    NONE: 0,
    REPORT_ONLY: 0,
    REVALIDATE_APPLICATION: 0
  };
  const results = rows.map((row) => {
    const result = classifyBusinessWaitReconciliation(row);
    counts[result.action] += 1;
    return {
      action: result.action,
      applicationId: row.applicationId,
      currentFactVersion: row.currentFactVersion,
      journeyId: row.journeyId,
      oldErrorCodes: uniqueStrings(row.exceptionCodes),
      proposedOutcome: result.proposedOutcome,
      reason: result.reason,
      reasonCodes: result.reasonCodes
    };
  });
  return { counts, results };
}

function classifyCurrentApplicationFacts(row) {
  const rejected = [];
  if (row.applicationStatus === "CANCELLED") {
    rejected.push("APPLICATION_CANCELLED");
  } else if (row.applicationStatus === "REJECTED") {
    rejected.push("APPLICATION_REJECTED");
  } else if (row.materialReviewStatus === "REJECTED") {
    rejected.push("MATERIAL_REVIEW_REJECTED");
  } else if (row.creditReviewStatus === "REJECTED") {
    rejected.push("CREDIT_REVIEW_REJECTED");
  } else if (row.depositStatus === "REJECTED") {
    rejected.push("DEPOSIT_REJECTED");
  }
  if (rejected.length > 0) {
    return { outcome: "REJECTED", reasonCodes: rejected };
  }

  const customer = [];
  if (row.materialReviewStatus === "NEED_MORE_INFO") {
    customer.push("MATERIAL_SUPPLEMENT_REQUIRED");
  }
  if (row.creditReviewStatus === "NEED_MORE_INFO") {
    customer.push("CREDIT_SUPPLEMENT_REQUIRED");
  }
  if (customer.length > 0) {
    return { outcome: "WAITING_CUSTOMER", reasonCodes: customer };
  }

  const manual = [];
  if (row.materialReviewStatus !== "APPROVED") {
    manual.push("MATERIAL_REVIEW_PENDING");
  }
  if (row.creditReviewStatus !== "APPROVED") {
    manual.push("CREDIT_REVIEW_PENDING");
  }
  if (row.depositStatus !== "CONFIRMED" || !row.finalDepositAmountPresent) {
    manual.push("DEPOSIT_CONFIRMATION_PENDING");
  }
  if (manual.length > 0) {
    return { outcome: "WAITING_MANUAL", reasonCodes: manual };
  }
  return { outcome: "READY", reasonCodes: [] };
}

function classification(action, proposedOutcome, reason, reasonCodes) {
  return { action, proposedOutcome, reason, reasonCodes };
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string"))].sort();
}
