export type ContractSegmentErrorCode =
  | "BASE_SEGMENT_SOURCE_INCOMPLETE"
  | "CONTRACT_SEGMENT_INVALID_DATE_RANGE"
  | "CONTRACT_SEGMENT_NOT_CONTIGUOUS"
  | "CONTRACT_SEGMENT_NOT_FOUND"
  | "CONTRACT_SEGMENT_OVERLAP"
  | "ORDER_NOT_FOUND";

export class ContractSegmentError extends Error {
  readonly code: ContractSegmentErrorCode;

  constructor(code: ContractSegmentErrorCode, message: string) {
    super(message);
    this.name = "ContractSegmentError";
    this.code = code;
  }
}
