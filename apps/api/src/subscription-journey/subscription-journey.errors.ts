export type SubscriptionJourneyErrorCode =
  | "FINAL_PLAN_REVISION_STALE"
  | "JOURNEY_APPLICATION_CREDIT_NOT_APPROVED"
  | "JOURNEY_APPLICATION_MATERIALS_INCOMPLETE"
  | "JOURNEY_APPLICATION_NOT_FOUND"
  | "JOURNEY_APPLICATION_PRODUCT_INVALID"
  | "JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE"
  | "JOURNEY_CONFIGURATION_ERROR"
  | "JOURNEY_CONTRACT_TEMPLATE_INACTIVE"
  | "JOURNEY_CUSTOMER_PLAN_CONFIRMATION_REQUIRED"
  | "JOURNEY_EXECUTION_ERROR"
  | "JOURNEY_HANDLER_NOT_READY"
  | "JOURNEY_INVALID_TRANSITION"
  | "JOURNEY_IDEMPOTENCY_CONFLICT"
  | "JOURNEY_LEASE_LOST"
  | "JOURNEY_MANUAL_TASK_ALREADY_OPEN"
  | "JOURNEY_NOT_FOUND"
  | "JOURNEY_OPTIMISTIC_LOCK_CONFLICT"
  | "JOURNEY_SENSITIVE_PAYLOAD";

export class SubscriptionJourneyError extends Error {
  readonly code: SubscriptionJourneyErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: {
    code: SubscriptionJourneyErrorCode;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = "SubscriptionJourneyError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export function journeyError(
  code: SubscriptionJourneyErrorCode,
  message: string,
  retryable = false,
  retryAfterMs?: number
) {
  return new SubscriptionJourneyError({
    code,
    message,
    retryable,
    retryAfterMs
  });
}
