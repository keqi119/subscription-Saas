export const LEASE_ACTIVATION_CLOCK = Symbol("LEASE_ACTIVATION_CLOCK");

export type LeaseActivationClock = () => Date;

export type LeaseActivationCondition =
  | "CONTRACT_SIGNED"
  | "DEPOSIT_PAID"
  | "FIRST_RENT_PAID"
  | "DELIVERY_CONFIRMED"
  | "INSPECTION_PASSED";

export interface LeaseActivationResult {
  canActivate: boolean;
  missingConditions: LeaseActivationCondition[];
  reason?: string;
}

export interface LeaseStatusView {
  activatedAt: string | null;
  canActivate: boolean;
  leaseId: string | null;
  missingConditions: LeaseActivationCondition[];
  orderId: string;
  status: "NOT_ACTIVE" | "READY" | "ACTIVE";
}
