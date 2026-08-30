import { Injectable } from "@nestjs/common";
import { BillingMaintenanceCycleFactStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { BILLING_MAINTENANCE_FORBIDDEN_DOMAINS } from "./billing-maintenance-forbidden-domains";
import {
  BillingMaintenanceDatabaseIdentity,
  BillingMaintenanceEvidenceError,
  CompletedBillingMaintenanceFactInput
} from "./billing-maintenance-evidence.types";

export type BillingMaintenanceObservationTransaction = Prisma.TransactionClient;

@Injectable()
export class BillingMaintenanceEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInObservationTransaction<T>(
    operation: (tx: BillingMaintenanceObservationTransaction) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 120_000
    });
  }

  async acquireEvidenceRunLock(
    tx: BillingMaintenanceObservationTransaction,
    evidenceRunId: string
  ) {
    const lockIdentity = `billing-maintenance-evidence:${evidenceRunId}`;
    const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
      WITH lock_call AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))
      )
      SELECT TRUE AS "locked"
      FROM lock_call
    `);
    if (row?.locked !== true) databaseResponseInvalid();
  }

  async loadDatabaseIdentity(
    tx: BillingMaintenanceObservationTransaction
  ): Promise<BillingMaintenanceDatabaseIdentity> {
    const [row] = await tx.$queryRaw<
      Array<{ databaseName: string; systemIdentifier: string }>
    >(Prisma.sql`
      SELECT
        current_database() AS "databaseName",
        (pg_control_system()).system_identifier::text AS "systemIdentifier"
    `);
    if (
      typeof row?.databaseName !== "string" ||
      row.databaseName.length === 0 ||
      !/^[0-9]+$/.test(row.systemIdentifier)
    ) {
      databaseResponseInvalid();
    }
    return row;
  }

  async findCompletedFacts(tx: BillingMaintenanceObservationTransaction, evidenceRunId: string) {
    return tx.billingMaintenanceCycleFact.findMany({
      orderBy: { sequence: "asc" },
      select: {
        databaseIdentitySha256: true,
        evidenceRunId: true,
        forbiddenDomainSetSha256: true,
        forbiddenDomainSetVersion: true,
        imageDigest: true,
        releaseSha: true,
        sequence: true,
        status: true
      },
      where: {
        evidenceRunId,
        status: BillingMaintenanceCycleFactStatus.COMPLETED
      }
    });
  }

  async readDatabaseTime(tx: BillingMaintenanceObservationTransaction): Promise<Date> {
    const [row] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
      SELECT clock_timestamp() AS "now"
    `);
    if (!(row?.now instanceof Date) || !Number.isFinite(row.now.getTime())) {
      databaseResponseInvalid();
    }
    return row.now;
  }

  async loadForbiddenCounts(
    tx: BillingMaintenanceObservationTransaction
  ): Promise<Record<string, number>> {
    const statements = BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.map(
      ({ delegate, table }) =>
        Prisma.sql`
        SELECT ${delegate}::text AS "delegate", COUNT(*)::bigint AS "count"
        FROM ${Prisma.raw(quoteIdentifier(table))}
      `
    );
    const rows = await tx.$queryRaw<Array<{ count: bigint; delegate: string }>>(
      Prisma.sql`${Prisma.join(statements, " UNION ALL ")}`
    );
    const allowedDelegates = new Set(
      BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.map(({ delegate }) => delegate)
    );
    const countsByDelegate = new Map<string, number>();
    for (const row of rows) {
      const count = Number(row?.count);
      if (
        !row ||
        !allowedDelegates.has(row.delegate) ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        countsByDelegate.has(row.delegate)
      ) {
        databaseResponseInvalid();
      }
      countsByDelegate.set(row.delegate, count);
    }
    if (countsByDelegate.size !== BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.length) {
      databaseResponseInvalid();
    }

    const counts: Record<string, number> = {};
    for (const { delegate } of BILLING_MAINTENANCE_FORBIDDEN_DOMAINS) {
      const count = countsByDelegate.get(delegate);
      if (count === undefined) databaseResponseInvalid();
      counts[delegate] = count;
    }
    return counts;
  }

  async insertCompletedFact(
    tx: BillingMaintenanceObservationTransaction,
    input: CompletedBillingMaintenanceFactInput
  ) {
    return tx.billingMaintenanceCycleFact.create({
      data: {
        ...input,
        afterCounts: input.afterCounts as Prisma.InputJsonValue,
        beforeCounts: input.beforeCounts as Prisma.InputJsonValue,
        createdAt: input.completedAt,
        enqueueSummary: input.enqueueSummary as unknown as Prisma.InputJsonValue,
        reconciliationSummary: input.reconciliationSummary as unknown as Prisma.InputJsonValue,
        status: BillingMaintenanceCycleFactStatus.COMPLETED
      }
    });
  }
}

function quoteIdentifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new BillingMaintenanceEvidenceError(
      "BILLING_MAINTENANCE_DATABASE_RESPONSE_INVALID",
      "Billing maintenance database metadata is invalid."
    );
  }
  return `"${value}"`;
}

function databaseResponseInvalid(): never {
  throw new BillingMaintenanceEvidenceError(
    "BILLING_MAINTENANCE_DATABASE_RESPONSE_INVALID",
    "Billing maintenance database response is invalid."
  );
}
