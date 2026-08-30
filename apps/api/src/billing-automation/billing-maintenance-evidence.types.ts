import { createHash } from "node:crypto";

export const BILLING_MAINTENANCE_DATABASE_IDENTITY_VERSION =
  "billing-maintenance-database-identity/v1" as const;

export type BillingMaintenanceEvidenceErrorCode =
  | "BILLING_MAINTENANCE_DATABASE_IDENTITY_MISMATCH"
  | "BILLING_MAINTENANCE_DATABASE_RESPONSE_INVALID"
  | "BILLING_MAINTENANCE_EVIDENCE_CONFIGURATION_INVALID"
  | "BILLING_MAINTENANCE_SEQUENCE_INVALID"
  | "BILLING_MAINTENANCE_SOURCE_BINDING_CONFLICT";

export class BillingMaintenanceEvidenceError extends Error {
  readonly code: BillingMaintenanceEvidenceErrorCode;

  constructor(code: BillingMaintenanceEvidenceErrorCode, message: string) {
    super(message);
    this.name = "BillingMaintenanceEvidenceError";
    this.code = code;
  }
}

export interface BillingMaintenanceDatabaseIdentity {
  databaseName: string;
  systemIdentifier: string;
}

export interface BillingMaintenanceEvidenceSource {
  databaseIdentitySha256: string;
  evidenceRunId: string;
  forbiddenDomainSetSha256: string;
  forbiddenDomainSetVersion: string;
  imageDigest: string;
  releaseSha: string;
}

export interface BillingMaintenanceReconciliationSummary {
  blockedCount: number;
  blockerCodes: string[];
  createdCount: number;
  eligibleCount: number;
  existingCount: number;
  leaseActivationCount: number;
}

export interface BillingMaintenanceEnqueueSummary {
  dueCount: number;
  enqueuedCount: number;
}

export interface CompletedBillingMaintenanceFactInput extends BillingMaintenanceEvidenceSource {
  afterCounts: Record<string, number>;
  afterCountsSha256: string;
  beforeCounts: Record<string, number>;
  beforeCountsSha256: string;
  blockedCount: number;
  completedAt: Date;
  cycleStartedAt: Date;
  enqueueCompletedAt: Date;
  enqueueSummary: BillingMaintenanceEnqueueSummary;
  reconciliationCompletedAt: Date;
  reconciliationSummary: BillingMaintenanceReconciliationSummary;
  sequence: 1 | 2;
  status: "COMPLETED";
}

export function canonicalBillingMaintenanceJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashBillingMaintenanceValue(value: unknown): string {
  return createHash("sha256").update(canonicalBillingMaintenanceJson(value), "utf8").digest("hex");
}

export function hashBillingMaintenanceDatabaseIdentity(
  identity: BillingMaintenanceDatabaseIdentity
): string {
  return hashBillingMaintenanceValue({
    databaseName: identity.databaseName,
    systemIdentifier: identity.systemIdentifier,
    version: BILLING_MAINTENANCE_DATABASE_IDENTITY_VERSION
  });
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}
