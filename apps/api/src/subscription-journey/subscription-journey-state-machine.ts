import { journeyError } from "./subscription-journey.errors";

export const JOURNEY_STEP_SEQUENCE = [
  "APPLICATION_VALIDATION",
  "FINAL_PLAN_DECISION",
  "CUSTOMER_PLAN_CONFIRMATION",
  "FINAL_VEHICLE_ALLOCATION",
  "ORDER_AND_CONTRACT_CREATION",
  "FADADA_SIGNING_AND_ARCHIVE",
  "INITIAL_BILLING",
  "CUSTOMER_JSAPI_PAYMENT",
  "HANDOVER_AND_STAGE2_CREATION",
  "DELIVERY_EVIDENCE_DECISION",
  "AUTHORITATIVE_ACTIVATION"
] as const;

export type JourneyStepCode = (typeof JOURNEY_STEP_SEQUENCE)[number];
export type JourneyStepStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_CUSTOMER"
  | "WAITING_MANUAL"
  | "RETRY_SCHEDULED"
  | "EXCEPTION"
  | "COMPLETED"
  | "SKIPPED"
  | "CANCELLED";
export type JourneyStatus =
  | "RUNNING"
  | "WAITING_CUSTOMER"
  | "WAITING_MANUAL"
  | "RETRY_SCHEDULED"
  | "PAUSED"
  | "EXCEPTION"
  | "COMPLETED"
  | "CANCELLED";
export type JourneyManualTaskType =
  | "FINAL_PLAN_DECISION"
  | "FINAL_VEHICLE_ALLOCATION"
  | "DELIVERY_EVIDENCE_DECISION";

const MANUAL_TASK_BY_STEP: Partial<
  Record<JourneyStepCode, JourneyManualTaskType>
> = {
  DELIVERY_EVIDENCE_DECISION: "DELIVERY_EVIDENCE_DECISION",
  FINAL_PLAN_DECISION: "FINAL_PLAN_DECISION",
  FINAL_VEHICLE_ALLOCATION: "FINAL_VEHICLE_ALLOCATION"
};

const RESUMABLE_STATUSES = new Set<JourneyStatus>([
  "RUNNING",
  "WAITING_CUSTOMER",
  "WAITING_MANUAL",
  "RETRY_SCHEDULED",
  "EXCEPTION"
]);

export function nextStep(
  current: JourneyStepCode,
  status: JourneyStepStatus
): JourneyStepCode | null {
  if (status !== "COMPLETED" && status !== "SKIPPED") {
    return current;
  }
  const index = JOURNEY_STEP_SEQUENCE.indexOf(current);
  return JOURNEY_STEP_SEQUENCE[index + 1] ?? null;
}

export function assertTransition(
  current: JourneyStepCode,
  next: JourneyStepCode
): void {
  if (nextStep(current, "COMPLETED") !== next) {
    throw invalidTransition();
  }
}

export function assertJourneyStatusTransition(
  current: JourneyStatus,
  next: JourneyStatus,
  pausedFromStatus?: JourneyStatus
): void {
  if (current === "COMPLETED" || current === "CANCELLED") {
    throw invalidTransition();
  }
  if (next === "CANCELLED") {
    return;
  }
  if (current === "PAUSED") {
    if (pausedFromStatus === next && RESUMABLE_STATUSES.has(next)) {
      return;
    }
    throw invalidTransition();
  }
  if (next === "PAUSED") {
    return;
  }
  if (
    (current === "RUNNING" &&
      [
        "WAITING_CUSTOMER",
        "WAITING_MANUAL",
        "RETRY_SCHEDULED",
        "EXCEPTION",
        "COMPLETED"
      ].includes(next)) ||
    (current !== "RUNNING" && next === "RUNNING")
  ) {
    return;
  }
  throw invalidTransition();
}

export function manualTaskTypeFor(
  step: JourneyStepCode
): JourneyManualTaskType | null {
  return MANUAL_TASK_BY_STEP[step] ?? null;
}

function invalidTransition() {
  return journeyError(
    "JOURNEY_INVALID_TRANSITION",
    "The requested subscription journey transition is not allowed."
  );
}
