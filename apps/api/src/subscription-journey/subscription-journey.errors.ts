export type SubscriptionJourneyErrorCode =
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
