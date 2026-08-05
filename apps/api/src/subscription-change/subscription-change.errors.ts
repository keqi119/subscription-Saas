import { HttpException, HttpStatus } from "@nestjs/common";

export type ContractSegmentErrorCode =
  | "BASE_SEGMENT_SOURCE_INCOMPLETE"
  | "CONTRACT_SEGMENT_INVALID_DATE_RANGE"
  | "BILLING_PERIOD_CROSSES_SEGMENT"
  | "CONTRACT_SEGMENT_NOT_CONTIGUOUS"
  | "CONTRACT_SEGMENT_NOT_FOUND"
  | "CONTRACT_SEGMENT_OVERLAP"
  | "ORDER_NOT_FOUND";

export class ContractSegmentError extends Error {
  readonly code: ContractSegmentErrorCode;
  readonly context?: { changeOrderId?: string; segmentId?: string };

  constructor(
    code: ContractSegmentErrorCode,
    message: string,
    context?: { changeOrderId?: string; segmentId?: string }
  ) {
    super(message);
    this.name = "ContractSegmentError";
    this.code = code;
    this.context = context;
  }
}

export class SubscriptionChangeError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.CONFLICT
  ) {
    super({ code, message }, status);
  }
}
