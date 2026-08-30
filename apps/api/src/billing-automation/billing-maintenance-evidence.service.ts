import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { BillingAutomationService } from "./billing-automation.service";
import {
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION
} from "./billing-maintenance-forbidden-domains";
import { BillingMaintenanceEvidenceRepository } from "./billing-maintenance-evidence.repository";
import {
  BillingMaintenanceEnqueueSummary,
  BillingMaintenanceEvidenceError,
  BillingMaintenanceEvidenceSource,
  BillingMaintenanceReconciliationSummary,
  CompletedBillingMaintenanceFactInput,
  hashBillingMaintenanceDatabaseIdentity,
  hashBillingMaintenanceValue
} from "./billing-maintenance-evidence.types";

const HEX_64 = /^[0-9a-f]{64}$/;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

@Injectable()
export class BillingMaintenanceEvidenceService {
  constructor(
    private readonly billing: BillingAutomationService,
    private readonly repository: BillingMaintenanceEvidenceRepository,
    private readonly config: ConfigService
  ) {}

  async runMaintenance() {
    if (this.config.get<string>("BILLING_MAINTENANCE_EVIDENCE_ENABLED") !== "true") {
      return this.runOrdinaryMaintenance();
    }

    const configured = this.readConfiguredSource();
    const captured = await this.repository.runInObservationTransaction(async (tx) => {
      await this.repository.acquireEvidenceRunLock(tx, configured.evidenceRunId);
      const databaseIdentity = await this.repository.loadDatabaseIdentity(tx);
      const actualDatabaseIdentitySha256 = hashBillingMaintenanceDatabaseIdentity(databaseIdentity);
      if (actualDatabaseIdentitySha256 !== configured.databaseIdentitySha256) {
        throw new BillingMaintenanceEvidenceError(
          "BILLING_MAINTENANCE_DATABASE_IDENTITY_MISMATCH",
          "Billing maintenance database identity does not match the configured source."
        );
      }

      const source: BillingMaintenanceEvidenceSource = {
        ...configured,
        forbiddenDomainSetSha256: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
        forbiddenDomainSetVersion: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION
      };
      const existing = await this.repository.findCompletedFacts(tx, source.evidenceRunId);
      const sequence = nextSequence(existing, source);
      if (sequence === null) return this.runOrdinaryMaintenance();

      const cycleStartedAt = await this.repository.readDatabaseTime(tx);
      const beforeCounts = await this.repository.loadForbiddenCounts(tx);
      const reconciliation = await this.billing.reconcileSchedules({ dryRun: false });
      const reconciliationCompletedAt = await this.repository.readDatabaseTime(tx);
      const enqueue = await this.billing.enqueueDueSchedules();
      const enqueueCompletedAt = await this.repository.readDatabaseTime(tx);
      const afterCounts = await this.repository.loadForbiddenCounts(tx);
      const completedAt = await this.repository.readDatabaseTime(tx);
      const fact: CompletedBillingMaintenanceFactInput = {
        ...source,
        afterCounts,
        afterCountsSha256: hashBillingMaintenanceValue(afterCounts),
        beforeCounts,
        beforeCountsSha256: hashBillingMaintenanceValue(beforeCounts),
        blockedCount: reconciliation.blockedCount,
        completedAt,
        cycleStartedAt,
        enqueueCompletedAt,
        enqueueSummary: safeEnqueueSummary(enqueue),
        reconciliationCompletedAt,
        reconciliationSummary: safeReconciliationSummary(reconciliation),
        sequence,
        status: "COMPLETED"
      };
      await this.repository.insertCompletedFact(tx, fact);
      return reconciliation;
    });

    return captured;
  }

  private async runOrdinaryMaintenance() {
    const reconciliation = await this.billing.reconcileSchedules({ dryRun: false });
    await this.billing.enqueueDueSchedules();
    return reconciliation;
  }

  private readConfiguredSource(): Omit<
    BillingMaintenanceEvidenceSource,
    "forbiddenDomainSetSha256" | "forbiddenDomainSetVersion"
  > {
    const evidenceRunId = this.config.get<string>("BILLING_MAINTENANCE_EVIDENCE_RUN_ID");
    const releaseSha = this.config.get<string>("BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA");
    const imageDigest = this.config.get<string>("BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST");
    const databaseIdentitySha256 = this.config.get<string>(
      "BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256"
    );
    if (
      !evidenceRunId ||
      !HEX_64.test(evidenceRunId) ||
      !releaseSha ||
      !RELEASE_SHA.test(releaseSha) ||
      !imageDigest ||
      !IMAGE_DIGEST.test(imageDigest) ||
      !databaseIdentitySha256 ||
      !HEX_64.test(databaseIdentitySha256)
    ) {
      throw new BillingMaintenanceEvidenceError(
        "BILLING_MAINTENANCE_EVIDENCE_CONFIGURATION_INVALID",
        "Billing maintenance evidence configuration is invalid."
      );
    }
    return { databaseIdentitySha256, evidenceRunId, imageDigest, releaseSha };
  }
}

function nextSequence(
  existing: Array<BillingMaintenanceEvidenceSource & { sequence: number; status: string }>,
  source: BillingMaintenanceEvidenceSource
): 1 | 2 | null {
  for (const fact of existing) {
    if (
      fact.status !== "COMPLETED" ||
      fact.evidenceRunId !== source.evidenceRunId ||
      fact.releaseSha !== source.releaseSha ||
      fact.imageDigest !== source.imageDigest ||
      fact.databaseIdentitySha256 !== source.databaseIdentitySha256 ||
      fact.forbiddenDomainSetVersion !== source.forbiddenDomainSetVersion ||
      fact.forbiddenDomainSetSha256 !== source.forbiddenDomainSetSha256
    ) {
      throw new BillingMaintenanceEvidenceError(
        "BILLING_MAINTENANCE_SOURCE_BINDING_CONFLICT",
        "Billing maintenance evidence source binding conflicts with an existing fact."
      );
    }
  }
  if (existing.length === 0) return 1;
  if (existing.length === 1 && existing[0]?.sequence === 1) return 2;
  if (existing.length === 2 && existing[0]?.sequence === 1 && existing[1]?.sequence === 2) {
    return null;
  }
  throw new BillingMaintenanceEvidenceError(
    "BILLING_MAINTENANCE_SEQUENCE_INVALID",
    "Billing maintenance evidence sequence is invalid."
  );
}

function safeReconciliationSummary(input: {
  blockedCount: number;
  createdCount: number;
  eligibleCount: number;
  existingCount: number;
  items: Array<{ action: string; blockerCode: string | null }>;
  leaseActivationCount: number;
}): BillingMaintenanceReconciliationSummary {
  const summary = {
    blockedCount: safeCount(input.blockedCount),
    blockerCodes: [
      ...new Set(
        input.items
          .filter((item) => item.action === "BLOCKED")
          .map((item) => item.blockerCode)
          .filter(
            (code): code is string =>
              typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
          )
      )
    ].sort(),
    createdCount: safeCount(input.createdCount),
    eligibleCount: safeCount(input.eligibleCount),
    existingCount: safeCount(input.existingCount),
    leaseActivationCount: safeCount(input.leaseActivationCount)
  };
  if (summary.blockerCodes.length > summary.blockedCount) responseInvalid();
  return summary;
}

function safeEnqueueSummary(input: {
  dueCount: number;
  enqueuedCount: number;
}): BillingMaintenanceEnqueueSummary {
  return {
    dueCount: safeCount(input.dueCount),
    enqueuedCount: safeCount(input.enqueuedCount)
  };
}

function safeCount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) responseInvalid();
  return value;
}

function responseInvalid(): never {
  throw new BillingMaintenanceEvidenceError(
    "BILLING_MAINTENANCE_DATABASE_RESPONSE_INVALID",
    "Billing maintenance operation returned an invalid summary."
  );
}
