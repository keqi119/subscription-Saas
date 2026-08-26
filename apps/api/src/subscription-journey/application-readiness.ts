import {
  ApplicationStatus,
  DepositStatus,
  OrderReviewStatus
} from "@prisma/client";

export type ApplicationReadinessOutcome =
  | "READY"
  | "WAITING_MANUAL"
  | "WAITING_CUSTOMER"
  | "REJECTED";

export type ApplicationReadinessReasonCode =
  | "APPLICATION_CANCELLED"
  | "APPLICATION_REJECTED"
  | "CREDIT_REVIEW_PENDING"
  | "CREDIT_REVIEW_REJECTED"
  | "CREDIT_SUPPLEMENT_REQUIRED"
  | "DEPOSIT_CONFIRMATION_PENDING"
  | "DEPOSIT_REJECTED"
  | "MATERIAL_REVIEW_PENDING"
  | "MATERIAL_REVIEW_REJECTED"
  | "MATERIAL_SUPPLEMENT_REQUIRED"
  | "PRICING_CONFIGURATION_INVALID"
  | "PRODUCT_SELECTION_INVALID"
  | "PRODUCT_SELECTION_REQUIRED"
  | "VEHICLE_SELECTION_INVALID"
  | "VEHICLE_UNAVAILABLE";

export interface ApplicationReadinessResult {
  factVersion: number;
  outcome: ApplicationReadinessOutcome;
  reasonCodes: ApplicationReadinessReasonCode[];
}

interface ApplicationReadinessFacts {
  creditReviewStatus: OrderReviewStatus;
  depositStatus: DepositStatus;
  finalDepositAmount: bigint | null;
  journeyFactVersion: number;
  materialReviewStatus: OrderReviewStatus;
  status: ApplicationStatus;
}

export function classifyApplicationReadiness(
  facts: ApplicationReadinessFacts
): ApplicationReadinessResult {
  const rejected = rejectedReasons(facts);
  if (rejected.length > 0) return result(facts, "REJECTED", rejected);

  const customer = customerReasons(facts);
  if (customer.length > 0) return result(facts, "WAITING_CUSTOMER", customer);

  const manual = manualReasons(facts);
  if (manual.length > 0) return result(facts, "WAITING_MANUAL", manual);

  return result(facts, "READY", []);
}

export function addApplicationReadinessReason(
  readiness: ApplicationReadinessResult,
  reasonCode: ApplicationReadinessReasonCode,
  outcome: Extract<ApplicationReadinessOutcome, "WAITING_MANUAL" | "WAITING_CUSTOMER"> =
    "WAITING_MANUAL"
): ApplicationReadinessResult {
  return {
    factVersion: readiness.factVersion,
    outcome,
    reasonCodes: [...new Set([...readiness.reasonCodes, reasonCode])]
  };
}

function rejectedReasons(
  facts: ApplicationReadinessFacts
): ApplicationReadinessReasonCode[] {
  if (facts.status === ApplicationStatus.CANCELLED) return ["APPLICATION_CANCELLED"];
  if (facts.status === ApplicationStatus.REJECTED) return ["APPLICATION_REJECTED"];
  if (facts.materialReviewStatus === OrderReviewStatus.REJECTED) {
    return ["MATERIAL_REVIEW_REJECTED"];
  }
  if (facts.creditReviewStatus === OrderReviewStatus.REJECTED) {
    return ["CREDIT_REVIEW_REJECTED"];
  }
  if (facts.depositStatus === DepositStatus.REJECTED) return ["DEPOSIT_REJECTED"];
  return [];
}

function customerReasons(
  facts: ApplicationReadinessFacts
): ApplicationReadinessReasonCode[] {
  const reasons: ApplicationReadinessReasonCode[] = [];
  if (facts.materialReviewStatus === OrderReviewStatus.NEED_MORE_INFO) {
    reasons.push("MATERIAL_SUPPLEMENT_REQUIRED");
  }
  if (facts.creditReviewStatus === OrderReviewStatus.NEED_MORE_INFO) {
    reasons.push("CREDIT_SUPPLEMENT_REQUIRED");
  }
  return reasons;
}

function manualReasons(
  facts: ApplicationReadinessFacts
): ApplicationReadinessReasonCode[] {
  const reasons: ApplicationReadinessReasonCode[] = [];
  if (facts.materialReviewStatus !== OrderReviewStatus.APPROVED) {
    reasons.push("MATERIAL_REVIEW_PENDING");
  }
  if (facts.creditReviewStatus !== OrderReviewStatus.APPROVED) {
    reasons.push("CREDIT_REVIEW_PENDING");
  }
  if (
    facts.depositStatus !== DepositStatus.CONFIRMED ||
    facts.finalDepositAmount === null
  ) {
    reasons.push("DEPOSIT_CONFIRMATION_PENDING");
  }
  return reasons;
}

function result(
  facts: ApplicationReadinessFacts,
  outcome: ApplicationReadinessOutcome,
  reasonCodes: ApplicationReadinessReasonCode[]
): ApplicationReadinessResult {
  return { factVersion: facts.journeyFactVersion, outcome, reasonCodes };
}
