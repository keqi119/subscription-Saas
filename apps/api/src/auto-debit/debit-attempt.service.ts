import { Inject, Injectable } from "@nestjs/common";
import {
  BillStatus,
  DebitAttemptStatus,
  DebitRetrySlot,
  PaymentChannel,
  PaymentMandateStatus,
  PaymentOrderStatus,
  PaymentProviderType,
  Prisma,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { createHash } from "node:crypto";

import { createBusinessNo } from "../common/business-number";
import { FinanceService } from "../finance/finance.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  BillingAutomationError,
  ClaimedBillingAutomationJob
} from "../billing-automation/billing-automation.types";
import {
  DebitProviderResult,
  MandateDebitProvider,
  MANDATE_DEBIT_PROVIDER,
  ProviderSnapshot
} from "./auto-debit-provider";

const UNRESOLVED_ATTEMPT_STATUSES = new Set<DebitAttemptStatus>([
  DebitAttemptStatus.CREATED,
  DebitAttemptStatus.SUBMITTING,
  DebitAttemptStatus.PROCESSING,
  DebitAttemptStatus.UNKNOWN
]);

@Injectable()
export class DebitAttemptService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MANDATE_DEBIT_PROVIDER)
    private readonly provider: MandateDebitProvider,
    private readonly finance: FinanceService
  ) {}

  async submitBillDebit(job: ClaimedBillingAutomationJob) {
    const retrySlot = retrySlotFromJob(job);
    const prepared = await this.prepareSubmission(job, retrySlot);
    if (prepared.kind === "skipped") {
      return { action: "SKIPPED", reason: prepared.reason };
    }
    if (prepared.kind === "query") {
      return {
        action: "QUERY_ENQUEUED",
        attemptId: prepared.attempt.id,
        status: prepared.attempt.status
      };
    }

    let result: DebitProviderResult;
    try {
      result = await this.provider.submitDebit({
        amount: prepared.attempt.requestedAmount,
        currency: "CNY",
        providerMandateId: prepared.providerMandateId,
        providerOutTradeNo: prepared.attempt.providerOutTradeNo,
        subject: prepared.subject
      });
    } catch {
      const unknown = await this.persistUnknown(prepared.attempt.id);
      return {
        action: "QUERY_ENQUEUED",
        attemptId: unknown.id,
        status: unknown.status
      };
    }

    if (result.providerOutTradeNo !== prepared.attempt.providerOutTradeNo) {
      const unknown = await this.persistUnknown(prepared.attempt.id);
      return {
        action: "QUERY_ENQUEUED",
        attemptId: unknown.id,
        status: unknown.status
      };
    }
    const updated = await this.persistProviderResult(prepared.attempt.id, result);
    return {
      action: UNRESOLVED_ATTEMPT_STATUSES.has(updated.status)
        ? "SUBMITTED"
        : "RESOLVED",
      attemptId: updated.id,
      status: updated.status
    };
  }

  async queryDebitAttempt(job: ClaimedBillingAutomationJob) {
    const attemptId = attemptIdFromJob(job);
    const attempt = await this.prisma.debitAttempt.findUnique({
      include: {
        bill: { select: { billNo: true } },
        mandate: { select: { providerMandateId: true } }
      },
      where: { id: attemptId }
    });
    if (!attempt) {
      return { action: "SKIPPED", reason: "DEBIT_ATTEMPT_MISSING" };
    }
    if (!UNRESOLVED_ATTEMPT_STATUSES.has(attempt.status)) {
      return {
        action: "RESOLVED",
        attemptId: attempt.id,
        status: attempt.status
      };
    }

    let result: DebitProviderResult;
    try {
      result = await this.provider.queryDebit({
        providerOutTradeNo: attempt.providerOutTradeNo,
        providerSnapshot: providerSnapshot(
          attempt.responseSnapshot ?? attempt.requestSnapshot
        ),
        providerTransactionId: attempt.providerTransactionId ?? undefined
      });
    } catch {
      const unknown = await this.persistUnknown(attempt.id);
      return {
        action: "PENDING_QUERY",
        attemptId: unknown.id,
        status: unknown.status
      };
    }

    if (providerTransactionMissing(result)) {
      return this.resubmitKnownMissing(attempt);
    }
    if (result.providerOutTradeNo !== attempt.providerOutTradeNo) {
      const unknown = await this.persistUnknown(attempt.id);
      return {
        action: "PENDING_QUERY",
        attemptId: unknown.id,
        status: unknown.status
      };
    }

    const updated = await this.persistProviderResult(attempt.id, result);
    return {
      action: UNRESOLVED_ATTEMPT_STATUSES.has(updated.status)
        ? "PENDING_QUERY"
        : "RESOLVED",
      attemptId: updated.id,
      status: updated.status
    };
  }

  private async resubmitKnownMissing(
    attempt: Prisma.DebitAttemptGetPayload<{
      include: {
        bill: { select: { billNo: true } };
        mandate: { select: { providerMandateId: true } };
      };
    }>
  ) {
    if (!attempt.mandate.providerMandateId) {
      throw configurationError("Active mandate provider reference is missing.");
    }
    await this.prisma.debitAttempt.update({
      data: {
        errorSnapshot: Prisma.JsonNull,
        lastErrorCode: null,
        lastErrorMessage: null,
        status: DebitAttemptStatus.SUBMITTING,
        submittedAt: new Date()
      },
      where: { id: attempt.id }
    });
    try {
      const result = await this.provider.submitDebit({
        amount: attempt.requestedAmount,
        currency: "CNY",
        providerMandateId: attempt.mandate.providerMandateId,
        providerOutTradeNo: attempt.providerOutTradeNo,
        subject: `Auto debit ${attempt.bill.billNo}`
      });
      const updated = await this.persistProviderResult(attempt.id, result);
      return {
        action: UNRESOLVED_ATTEMPT_STATUSES.has(updated.status)
          ? "PENDING_QUERY"
          : "RESOLVED",
        attemptId: updated.id,
        status: updated.status
      };
    } catch {
      const unknown = await this.persistUnknown(attempt.id);
      return {
        action: "PENDING_QUERY",
        attemptId: unknown.id,
        status: unknown.status
      };
    }
  }

  private async prepareSubmission(
    job: ClaimedBillingAutomationJob,
    retrySlot: DebitRetrySlot
  ): Promise<PreparedSubmission> {
    if (!job.billId) {
      return { kind: "skipped", reason: "BILL_SETTLED_OR_MISSING" };
    }
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, "receivable_bill", job.billId!);
      const bill = await tx.receivableBill.findUnique({
        select: {
          billNo: true,
          billStatus: true,
          customerId: true,
          deletedAt: true,
          id: true,
          orderId: true,
          remainingAmount: true
        },
        where: { id: job.billId! }
      });
      if (
        !bill ||
        bill.deletedAt ||
        bill.remainingAmount <= 0n ||
        bill.billStatus === BillStatus.PAID ||
        bill.billStatus === BillStatus.CANCELLED
      ) {
        return { kind: "skipped", reason: "BILL_SETTLED_OR_MISSING" };
      }

      const existing = await tx.debitAttempt.findUnique({
        where: { idempotencyKey: job.idempotencyKey }
      });
      if (existing) {
        if (UNRESOLVED_ATTEMPT_STATUSES.has(existing.status)) {
          await enqueueQueryJob(tx, existing);
          return { attempt: existing, kind: "query" };
        }
        return { kind: "skipped", reason: "DEBIT_ATTEMPT_ALREADY_RESOLVED" };
      }

      const mandate = await tx.paymentMandate.findFirst({
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
        where: {
          orderId: bill.orderId,
          status: PaymentMandateStatus.ACTIVE
        }
      });
      if (!mandate?.providerMandateId) {
        return { kind: "skipped", reason: "ACTIVE_MANDATE_MISSING" };
      }
      await lockRow(tx, "payment_mandate", mandate.id);
      const lockedMandate = await tx.paymentMandate.findUnique({
        where: { id: mandate.id }
      });
      if (
        !lockedMandate ||
        lockedMandate.status !== PaymentMandateStatus.ACTIVE ||
        !lockedMandate.providerMandateId
      ) {
        return { kind: "skipped", reason: "ACTIVE_MANDATE_MISSING" };
      }

      const providerOutTradeNo = buildProviderOutTradeNo(job.idempotencyKey);
      const paymentOrder = await tx.paymentOrder.create({
        data: {
          amount: bill.remainingAmount,
          customerId: bill.customerId,
          items: {
            create: {
              amount: bill.remainingAmount,
              billId: bill.id
            }
          },
          orderId: bill.orderId,
          paidAmount: 0n,
          paymentChannel: channelForProvider(lockedMandate.provider),
          paymentOrderNo: createBusinessNo("PAY"),
          paymentStatus: PaymentOrderStatus.PENDING,
          provider: lockedMandate.provider,
          providerTradeNo: providerOutTradeNo,
          requestSnapshot: toJson({
            billId: bill.id,
            idempotencyKey: job.idempotencyKey,
            retrySlot
          }),
          subject: `Auto debit ${bill.billNo}`
        }
      });
      const attempt = await tx.debitAttempt.create({
        data: {
          billId: bill.id,
          customerId: bill.customerId,
          debitAttemptNo: createBusinessNo("DBT"),
          idempotencyKey: job.idempotencyKey,
          mandateId: lockedMandate.id,
          orderId: bill.orderId,
          paymentOrderId: paymentOrder.id,
          providerOutTradeNo,
          requestSnapshot: toJson({
            amount: bill.remainingAmount.toString(),
            billId: bill.id,
            kind: "auto-debit-request",
            providerOutTradeNo,
            retrySlot
          }),
          requestedAmount: bill.remainingAmount,
          retrySlot,
          status: DebitAttemptStatus.SUBMITTING,
          submittedAt: new Date()
        }
      });
      return {
        attempt,
        kind: "submit",
        providerMandateId: lockedMandate.providerMandateId,
        subject: `Auto debit ${bill.billNo}`
      };
    });
  }

  private persistUnknown(attemptId: string) {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.debitAttempt.update({
        data: {
          errorSnapshot: toJson({ code: "PROVIDER_RESULT_UNKNOWN" }),
          lastErrorCode: "PROVIDER_RESULT_UNKNOWN",
          lastErrorMessage: "Debit result requires provider query.",
          status: DebitAttemptStatus.UNKNOWN
        },
        where: { id: attemptId }
      });
      await tx.paymentOrder.update({
        data: {
          errorSnapshot: toJson({ code: "PROVIDER_RESULT_UNKNOWN" }),
          paymentStatus: PaymentOrderStatus.PENDING
        },
        where: { id: attempt.paymentOrderId }
      });
      await enqueueQueryJob(tx, attempt);
      return attempt;
    });
  }

  private async persistProviderResult(
    attemptId: string,
    result: DebitProviderResult
  ) {
    const current = await this.prisma.debitAttempt.findUnique({
      where: { id: attemptId }
    });
    if (!current) {
      throw configurationError("Debit attempt is missing.");
    }
    if (!UNRESOLVED_ATTEMPT_STATUSES.has(current.status)) {
      return current;
    }
    const status = attemptStatus(result, current.retrySlot);
    if (status === DebitAttemptStatus.SUCCEEDED) {
      if (result.confirmedAmount !== current.requestedAmount) {
        return this.prisma.$transaction((tx) =>
          this.persistAmountMismatch(tx, current, result)
        );
      }
      const resolvedAt = result.resolvedAt ?? new Date();
      await this.finance.settlePaymentOrder({
        callbackPayload: result.providerSnapshot,
        debitAttempt: {
          confirmedAmount: result.confirmedAmount,
          id: current.id,
          providerTransactionId: result.providerTransactionId,
          resolvedAt,
          responseSnapshot: result.providerSnapshot
        },
        eventType: "AUTO_DEBIT_SUCCESS",
        operatorId: null,
        paidAmount: result.confirmedAmount,
        paidAt: resolvedAt,
        paymentOrderId: current.paymentOrderId,
        providerTradeNo: current.providerOutTradeNo,
        providerTransactionId: result.providerTransactionId
      });
      return this.prisma.debitAttempt.findUniqueOrThrow({
        where: { id: current.id }
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const terminal = !UNRESOLVED_ATTEMPT_STATUSES.has(status);
      const now = new Date();
      const attempt = await tx.debitAttempt.update({
        data: {
          acceptedAt:
            status === DebitAttemptStatus.PROCESSING
              ? current.acceptedAt ?? now
              : current.acceptedAt,
          confirmedAmount: result.confirmedAmount,
          errorSnapshot:
            result.errorCode || result.errorMessage
              ? toJson({ code: result.errorCode, message: result.errorMessage })
              : Prisma.JsonNull,
          lastErrorCode: result.errorCode ?? null,
          lastErrorMessage: result.errorMessage ?? null,
          providerTransactionId: result.providerTransactionId,
          resolvedAt: terminal ? result.resolvedAt ?? now : null,
          responseSnapshot: toJson(result.providerSnapshot),
          status
        },
        where: { id: current.id }
      });
      await tx.paymentOrder.update({
        data: {
          errorSnapshot:
            result.errorCode || result.errorMessage
              ? toJson({ code: result.errorCode, message: result.errorMessage })
              : Prisma.JsonNull,
          paymentStatus: failedAttemptStatus(status)
            ? PaymentOrderStatus.FAILED
            : PaymentOrderStatus.PENDING,
          providerTransactionId: result.providerTransactionId,
          responseSnapshot: toJson(result.providerSnapshot)
        },
        where: { id: current.paymentOrderId }
      });
      if (UNRESOLVED_ATTEMPT_STATUSES.has(status)) {
        await enqueueQueryJob(tx, attempt);
      }
      return attempt;
    });
  }

  private async persistAmountMismatch(
    tx: Prisma.TransactionClient,
    current: Prisma.DebitAttemptGetPayload<Record<string, never>>,
    result: DebitProviderResult
  ) {
    const errorSnapshot = toJson({
      code: "DEBIT_AMOUNT_MISMATCH",
      confirmedAmount: result.confirmedAmount.toString(),
      requestedAmount: current.requestedAmount.toString()
    });
    const attempt = await tx.debitAttempt.update({
      data: {
        confirmedAmount: result.confirmedAmount,
        errorSnapshot,
        lastErrorCode: "DEBIT_AMOUNT_MISMATCH",
        lastErrorMessage: "Confirmed debit amount does not match request.",
        providerTransactionId: result.providerTransactionId,
        resolvedAt: result.resolvedAt ?? new Date(),
        responseSnapshot: toJson(result.providerSnapshot),
        status: DebitAttemptStatus.FAILED_FINAL
      },
      where: { id: current.id }
    });
    await tx.paymentOrder.update({
      data: {
        errorSnapshot,
        paymentStatus: PaymentOrderStatus.FAILED,
        providerTransactionId: result.providerTransactionId,
        responseSnapshot: toJson(result.providerSnapshot)
      },
      where: { id: current.paymentOrderId }
    });
    return attempt;
  }
}

interface SkippedSubmission {
  kind: "skipped";
  reason: string;
}

interface QuerySubmission {
  attempt: Prisma.DebitAttemptGetPayload<Record<string, never>>;
  kind: "query";
}

interface ReadySubmission {
  attempt: Prisma.DebitAttemptGetPayload<Record<string, never>>;
  kind: "submit";
  providerMandateId: string;
  subject: string;
}

type PreparedSubmission = SkippedSubmission | QuerySubmission | ReadySubmission;

function retrySlotFromJob(job: ClaimedBillingAutomationJob) {
  const value = jsonField(job.payload, "retrySlot");
  if (!Object.values(DebitRetrySlot).includes(value as DebitRetrySlot)) {
    throw configurationError("Debit retry slot is missing or invalid.");
  }
  return value as DebitRetrySlot;
}

function attemptIdFromJob(job: ClaimedBillingAutomationJob) {
  const value = jsonField(job.payload, "debitAttemptId");
  if (typeof value !== "string" || !value) {
    throw configurationError("Debit attempt id is missing.");
  }
  return value;
}

function jsonField(value: Prisma.JsonValue | null, field: string) {
  return value && !Array.isArray(value) && typeof value === "object"
    ? value[field]
    : undefined;
}

function attemptStatus(
  result: DebitProviderResult,
  retrySlot: DebitRetrySlot
): DebitAttemptStatus {
  switch (result.status) {
    case "PROCESSING":
      return DebitAttemptStatus.PROCESSING;
    case "UNKNOWN":
      return DebitAttemptStatus.UNKNOWN;
    case "SUCCEEDED":
      return DebitAttemptStatus.SUCCEEDED;
    case "FAILED_FINAL":
      return DebitAttemptStatus.FAILED_FINAL;
    case "FAILED_RETRYABLE":
      return retrySlot === DebitRetrySlot.D3
        ? DebitAttemptStatus.FAILED_FINAL
        : DebitAttemptStatus.FAILED_RETRYABLE;
  }
}

function failedAttemptStatus(status: DebitAttemptStatus) {
  return (
    status === DebitAttemptStatus.FAILED_RETRYABLE ||
    status === DebitAttemptStatus.FAILED_FINAL ||
    status === DebitAttemptStatus.CANCELLED
  );
}

function providerTransactionMissing(result: DebitProviderResult) {
  return (
    result.status === "FAILED_RETRYABLE" &&
    result.errorCode === "PROVIDER_TRANSACTION_NOT_FOUND"
  );
}

async function enqueueQueryJob(
  tx: Pick<Prisma.TransactionClient, "subscriptionAutomationJob">,
  attempt: Prisma.DebitAttemptGetPayload<Record<string, never>>
) {
  return tx.subscriptionAutomationJob.upsert({
    create: {
      billId: attempt.billId,
      idempotencyKey: `debit-query:${attempt.id}`,
      jobType: SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
      orderId: attempt.orderId,
      payload: { debitAttemptId: attempt.id }
    },
    update: {},
    where: { idempotencyKey: `debit-query:${attempt.id}` }
  });
}

function buildProviderOutTradeNo(idempotencyKey: string) {
  const digest = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 29)
    .toUpperCase();
  return `ADT${digest}`;
}

function channelForProvider(provider: PaymentProviderType) {
  return provider === PaymentProviderType.MOCK
    ? PaymentChannel.MOCK
    : PaymentChannel.WECHAT_AUTO_DEBIT;
}

function providerSnapshot(value: Prisma.JsonValue | null): ProviderSnapshot {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw configurationError("Debit attempt provider snapshot is missing.");
  }
  return value as ProviderSnapshot;
}

async function lockRow(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  table: "payment_mandate" | "receivable_bill",
  id: string
) {
  if (table === "receivable_bill") {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "receivable_bill" WHERE "id" = ${id}::uuid FOR UPDATE
    `);
    return;
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "payment_mandate" WHERE "id" = ${id}::uuid FOR UPDATE
  `);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item
    )
  ) as Prisma.InputJsonValue;
}

function configurationError(message: string) {
  return new BillingAutomationError({
    code: "BILLING_CONFIGURATION_ERROR",
    message,
    retryable: false
  });
}
