export const LEASE_ACTIVATION_CLOCK = Symbol("LEASE_ACTIVATION_CLOCK");

export type LeaseActivationClock = () => Date;

export type LeaseActivationCondition =
  | "CONTRACT_ARCHIVED_ARTIFACT_MISSING"
  | "DEPOSIT_PAYMENT_MISSING"
  | "FIRST_RENT_PAYMENT_MISSING"
  | "DELIVERY_NOT_READY"
  | "DELIVERY_CHECKLIST_INCOMPLETE"
  | "HANDOVER_ARCHIVED_ARTIFACT_MISSING"
  | "HANDOVER_EVIDENCE_NOT_APPROVED"
  | "DELIVERY_MILEAGE_MISSING"
  | "VEHICLE_MISMATCH"
  | "VEHICLE_NOT_RESERVED"
  | "INSURANCE_NOT_COVERED"
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

export type LeaseActivationEvaluation = LeaseActivationResult;

export interface SubscriptionActivationResult {
  activatedAt: string;
  deliveryId: string;
  deliveryStatus: "DELIVERED";
  journeyStatus: "COMPLETED" | null;
  leaseId: string;
  leaseStatus: "ACTIVE";
  orderId: string;
  orderStatus: "ACTIVE";
  vehicleId: string;
  vehicleStatus: "LEASED";
}

export interface LeaseStatusView {
  activatedAt: string | null;
  canActivate: boolean;
  leaseId: string | null;
  missingConditions: LeaseActivationCondition[];
  orderId: string;
  status: "NOT_ACTIVE" | "READY" | "ACTIVE" | "RETURN_DUE" | "COMPLETED";
  warningConditions?: LeaseActivationWarningCondition[];
}
