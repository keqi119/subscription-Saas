export const LEASE_ACTIVATION_CLOCK = Symbol("LEASE_ACTIVATION_CLOCK");

export type LeaseActivationClock = () => Date;

export type LeaseActivationCondition =
  | "CONTRACT_SIGNED"
  | "DEPOSIT_PAID"
  | "FIRST_RENT_PAID"
  | "DAMAGE_EVIDENCE_MISSING"
  | "HANDOVER_EVIDENCE_MISSING"
  | "HANDOVER_EVIDENCE_REJECTED"
  | "HANDOVER_EVIDENCE_REVIEW_PENDING"
  | "HANDOVER_SIGNED_MISSING"
  | "DELIVERY_CONFIRMED"
  | "INSPECTION_PASSED";

export type LeaseActivationWarningCondition =
  | "HANDOVER_ARCHIVE_FAILED"
  | "HANDOVER_ARCHIVED_MISSING";

export interface LeaseActivationResult {
  canActivate: boolean;
  missingConditions: LeaseActivationCondition[];
  reason?: string;
  warningConditions?: LeaseActivationWarningCondition[];
}

export interface LeaseStatusView {
  activatedAt: string | null;
  canActivate: boolean;
  leaseId: string | null;
  missingConditions: LeaseActivationCondition[];
  orderId: string;
  status: "NOT_ACTIVE" | "READY" | "ACTIVE" | "RETURN_DUE";
  warningConditions?: LeaseActivationWarningCondition[];
}
