import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import type { ClosureCaseQueryDto } from "./subscription-closure.dto";

const FORBIDDEN_KEYS = new Set([
  "approvalcomment",
  "decisioncomment",
  "commandenvelope",
  "providerpayload",
  "callbackpayload",
  "requestsnapshot",
  "responsesnapshot",
  "payloadsnapshot",
  "outcomesnapshot"
]);

const WORK_ORDER_INCLUDE = {
  costLedgerEntries: true,
  events: { orderBy: [{ sequence: "asc" as const }, { id: "asc" as const }] },
  evidence: { orderBy: [{ recordedAt: "asc" as const }, { id: "asc" as const }] },
  restrictions: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] }
};

const AGGREGATE_INCLUDE = {
  commandReceipts: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
  currentDocuments: {
    include: { documentRevision: true },
    orderBy: { documentType: "asc" as const }
  },
  currentSettlementRevision: true,
  documentRevisions: {
    orderBy: [{ documentType: "asc" as const }, { revisionNumber: "asc" as const }]
  },
  events: { orderBy: [{ sequence: "asc" as const }, { id: "asc" as const }] },
  recoveryAssetWorkOrder: { include: WORK_ORDER_INCLUDE },
  reconditioningAssetWorkOrder: { include: WORK_ORDER_INCLUDE },
  returnAssetWorkOrder: { include: WORK_ORDER_INCLUDE },
  returnHandoverWorkOrder: true,
  settlementRevisions: { orderBy: [{ revisionNumber: "asc" as const }, { id: "asc" as const }] },
  vehicleReturn: {
    include: { damages: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] } }
  }
} satisfies Prisma.SubscriptionClosureCaseInclude;

type AggregateRecord = Prisma.SubscriptionClosureCaseGetPayload<{
  include: typeof AGGREGATE_INCLUDE;
}>;

@Injectable()
export class SubscriptionClosureProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async getAdminById(id: string) {
    const closureCase = await this.prisma.subscriptionClosureCase.findUnique({
      include: AGGREGATE_INCLUDE,
      where: { id }
    });
    if (!closureCase) throw new NotFoundException("Subscription closure case not found.");
    return this.adminProjection(closureCase);
  }

  async getAdminByOrder(orderId: string) {
    const closureCase = await this.prisma.subscriptionClosureCase.findFirst({
      include: AGGREGATE_INCLUDE,
      orderBy: [{ retiredAt: "asc" }, { createdAt: "desc" }, { id: "asc" }],
      where: { orderId, retiredAt: null }
    });
    if (!closureCase) throw new NotFoundException("Subscription closure case not found.");
    return this.adminProjection(closureCase);
  }

  async listAdmin(query: ClosureCaseQueryDto) {
    const cases = await this.prisma.subscriptionClosureCase.findMany({
      include: AGGREGATE_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: query.limit,
      where: {
        contractId: query.contractId,
        customerId: query.customerId,
        orderId: query.orderId,
        status: query.status,
        vehicleId: query.vehicleId
      }
    });
    return Promise.all(cases.map((item) => this.adminProjection(item)));
  }

  async getCustomerByOrder(orderId: string, customerId: string) {
    const closureCase = await this.prisma.subscriptionClosureCase.findFirst({
      include: AGGREGATE_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      where: { customerId, orderId, retiredAt: null }
    });
    return closureCase ? projectSubscriptionClosureCustomer(toAggregate(closureCase)) : null;
  }

  private async adminProjection(closureCase: AggregateRecord) {
    const audits = await this.prisma.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        OR: [
          { entityId: closureCase.id },
          { entityId: { in: closureCase.events.map(({ id }) => id) } }
        ]
      }
    });
    const approvals = await this.prisma.businessExceptionApproval.findMany({
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      where: {
        subjectId: closureCase.id,
        subjectType: { in: ["RECOVERY_CASE", "SETTLEMENT_CASE"] }
      }
    });
    return projectSubscriptionClosureAdmin({ ...toAggregate(closureCase), approvals, audits });
  }
}

export function sanitizeSubscriptionClosurePublic(value: unknown): unknown {
  return sanitize(value, new Set<object>());
}

export function projectSubscriptionClosureAdmin(value: unknown) {
  return sanitizeSubscriptionClosurePublic(value) as Record<string, unknown>;
}

export function projectSubscriptionClosureCustomer(value: unknown) {
  const aggregate = asRecord(value);
  const nestedClosureCase = asRecord(aggregate.closureCase);
  const closureCase = Object.keys(nestedClosureCase).length > 0 ? nestedClosureCase : aggregate;
  const documents = asRecordArray(aggregate.currentDocuments).map((entry) => {
    const revision = asRecord(entry.documentRevision);
    return Object.keys(revision).length > 0 ? revision : entry;
  });
  const settlement = asRecordArray(aggregate.settlementRevisions).at(-1) ?? null;
  const vehicleReturn = asRecord(aggregate.vehicleReturn);
  const evidenceReferences = asRecordArray(aggregate.workOrders).flatMap((workOrder) =>
    asRecordArray(workOrder.evidence)
      .filter((evidence) => typeof evidence.fileId === "string" && evidence.fileId.length > 0)
      .map((evidence) => ({
        evidenceType: evidence.evidenceType,
        fileId: evidence.fileId,
        id: evidence.id
      }))
  );
  const status = typeof closureCase.status === "string" ? closureCase.status : "";
  return sanitizeSubscriptionClosurePublic({
    caseNo: closureCase.caseNo,
    closureType: closureCase.closureType,
    effectiveAt: closureCase.effectiveAt,
    evidenceReferences,
    finalDisposition: closureCase.finalDisposition,
    nextAction: customerNextAction(status),
    physicalControlMode: closureCase.physicalControlMode,
    returnAppointment:
      Object.keys(vehicleReturn).length > 0
        ? { location: vehicleReturn.returnLocation, scheduledAt: vehicleReturn.scheduledAt }
        : null,
    settlement: settlement
      ? {
          amountDueCents: settlement.amountDueCents,
          amountRefundableCents: settlement.amountRefundableCents,
          stage: settlement.stage
        }
      : null,
    signedReferences: documents
      .filter((entry) => typeof entry.signedFileId === "string" && entry.signedFileId.length > 0)
      .map((entry) => ({
        documentType: entry.documentType,
        fileId: entry.signedFileId,
        stage: entry.stage
      })),
    status
  }) as Record<string, unknown>;
}

function toAggregate(closureCase: AggregateRecord) {
  return {
    closureCase,
    commandReceipts: closureCase.commandReceipts,
    currentDocuments: closureCase.currentDocuments,
    currentSettlement: closureCase.currentSettlementRevision,
    documentRevisions: closureCase.documentRevisions,
    events: closureCase.events,
    settlementRevisions: closureCase.settlementRevisions,
    vehicleReturn: closureCase.vehicleReturn,
    workOrders: [
      closureCase.returnAssetWorkOrder,
      closureCase.recoveryAssetWorkOrder,
      closureCase.reconditioningAssetWorkOrder
    ].filter(Boolean),
    handoverWorkOrder: closureCase.returnHandoverWorkOrder
  };
}

function sanitize(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (value === undefined) return undefined;
  if (typeof value !== "object") return String(value);
  if (ancestors.has(value)) throw new TypeError("subscription closure projection contains a cycle");
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, next));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenProjectionKey(key)) continue;
    const sanitized = sanitize(entry, next);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function isForbiddenProjectionKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (FORBIDDEN_KEYS.has(normalized)) return true;
  if (normalized.includes("approval") && normalized.includes("comment")) return true;
  if (normalized.includes("command") && /(envelope|payload|request)/.test(normalized)) return true;
  return normalized.includes("provider") && /(callback|payload|request|response)/.test(normalized);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function customerNextAction(status: string) {
  if (status === "PREPARING_RETURN") return "等待退车安排";
  if (status === "RETURN_INSPECTION" || status === "RECONDITIONING") return "车辆检查处理中";
  if (status === "PENDING_SETTLEMENT") return "等待最终结算";
  if (status === "COMPLETED" || status === "TERMINATED" || status === "CANCELLED")
    return "流程已结束";
  if (status.startsWith("RECOVERY_")) return "请联系服务团队";
  return "等待平台处理";
}
