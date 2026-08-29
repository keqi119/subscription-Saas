import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
  vehicle: { select: { status: true } },
  vehicleReturn: {
    include: { damages: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] } }
  }
} satisfies Prisma.SubscriptionClosureCaseInclude;

type AggregateRecord = Prisma.SubscriptionClosureCaseGetPayload<{
  include: typeof AGGREGATE_INCLUDE;
}>;

@Injectable()
export class SubscriptionClosureProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService
  ) {}

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
    if (!closureCase) return null;
    const governed = await this.governedProjection(
      closureCase.id,
      closureCase.contractId,
      closureCase.orderId,
      true
    );
    return projectSubscriptionClosureCustomer({
      ...toAggregate(closureCase),
      ...governed,
      returnThreeStageEnabled: this.returnThreeStageEnabled(closureCase, governed)
    });
  }

  private async adminProjection(closureCase: AggregateRecord) {
    const [audits, approvals, governed] = await Promise.all([this.prisma.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        OR: [
          { entityId: closureCase.id },
          { entityId: { in: closureCase.events.map(({ id }) => id) } }
        ]
      }
    }), this.prisma.businessExceptionApproval.findMany({
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      where: {
        subjectId: closureCase.id,
        subjectType: { in: ["RECOVERY_CASE", "SETTLEMENT_CASE"] }
      }
    }), this.governedProjection(
      closureCase.id,
      closureCase.contractId,
      closureCase.orderId,
      false
    )]);
    return projectSubscriptionClosureAdmin({
      ...toAggregate(closureCase),
      ...governed,
      allowedActions: governedAllowedActions(closureCase, governed),
      approvals,
      audits,
      returnThreeStageEnabled: this.returnThreeStageEnabled(closureCase, governed)
    });
  }

  private returnThreeStageEnabled(
    closureCase: AggregateRecord,
    governed: Readonly<Record<string, unknown>>
  ) {
    return (
      this.config?.get<string>("SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED") === "true" ||
      Boolean(closureCase.currentChecklistRevisionId) ||
      Boolean(closureCase.currentDeltaRevisionId) ||
      [
        "checklistRevisions",
        "deltaRevisions",
        "chargeLines",
        "customerResponses",
        "receivableDispositions",
        "evidenceLinks",
        "evidencePackages"
      ].some((key) => Array.isArray(governed[key]) && governed[key].length > 0)
    );
  }

  private async governedProjection(
    closureCaseId: string,
    contractId: string,
    orderId: string,
    customerOnly: boolean
  ) {
    const [
      checklistRevisions,
      evidenceLinks,
      deltaRevisions,
      clauses,
      chargeLines,
      customerResponses,
      disputes,
      dispositions,
      legalCases,
      evidencePackages,
      receivableBills,
      returnManifestTask
    ] = await Promise.all([
      this.prisma.vehicleReturnChecklistRevision.findMany({
        include: { items: { orderBy: { itemCode: "asc" as const } } },
        orderBy: [{ revisionNumber: "asc" as const }, { id: "asc" as const }],
        where: { closureCaseId }
      }),
      this.prisma.vehicleReturnEvidenceLink.findMany({
        orderBy: [{ recordedAt: "asc" as const }, { id: "asc" as const }],
        where: {
          closureCaseId,
          ...(customerOnly ? { visibility: "CUSTOMER_VISIBLE" as const } : {})
        }
      }),
      this.prisma.vehicleConditionDeltaRevision.findMany({
        include: { items: { orderBy: { itemCode: "asc" as const } } },
        orderBy: [{ revisionNumber: "asc" as const }, { id: "asc" as const }],
        where: { closureCaseId }
      }),
      this.prisma.contractChargeClauseSnapshot.findMany({
        orderBy: [{ clauseCode: "asc" as const }, { clauseVersion: "asc" as const }],
        where: { contractId }
      }),
      this.prisma.subscriptionClosureChargeLine.findMany({
        orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
        where: { closureCaseId }
      }),
      this.prisma.subscriptionClosureCustomerResponse.findMany({
        orderBy: [{ respondedAt: "asc" as const }, { id: "asc" as const }],
        where: { closureCaseId }
      }),
      this.prisma.subscriptionClosureChargeDispute.findMany({
        include: { decision: true },
        orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
        where: { closureCaseId }
      }),
      this.prisma.subscriptionClosureReceivableDisposition.findMany({
        orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
        where: { closureCaseId }
      }),
      this.prisma.subscriptionClosureLegalCollectionCase.findMany({
        include: { events: { orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }] } },
        orderBy: [{ openedAt: "asc" as const }, { id: "asc" as const }],
        where: { closureCaseId }
      }),
      this.prisma.subscriptionClosureEvidencePackageExport.findMany({
        orderBy: [{ version: "asc" as const }, { id: "asc" as const }],
        where: { closureCaseId }
      }),
      this.prisma.receivableBill.findMany({
        orderBy: [{ dueDate: "asc" as const }, { createdAt: "asc" as const }],
        select: {
          amount: true,
          billNo: true,
          billStatus: true,
          billType: true,
          dueDate: true,
          id: true,
          paidAmount: true,
          remainingAmount: true
        },
        where: { deletedAt: null, orderId }
      }),
      this.prisma.contractESignTask.findFirst({
        orderBy: [{ createdAt: "desc" as const }, { id: "asc" as const }],
        select: {
          id: true,
          provider: true,
          providerTaskId: true,
          signUrl: true,
          signUrlExpiresAt: true,
          taskStatus: true
        },
        where: {
          deletedAt: null,
          documentType: "RETURN_MANIFEST",
          signingStage: "STAGE6_RETURN_MANIFEST",
          sourceId: closureCaseId,
          sourceKey: { startsWith: "return-manifest-esign" },
          sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
        }
      })
    ]);
    return {
      chargeLines,
      checklistRevisions,
      contractChargeClauses: clauses,
      customerResponses,
      deltaRevisions,
      disputes,
      evidenceLinks,
      evidencePackages,
      legalCases,
      receivableBills,
      receivableDispositions: dispositions,
      returnManifestTask
    };
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
  const settlementRevisions = asRecordArray(aggregate.settlementRevisions);
  const latestSettlement = settlementRevisions.at(-1) ?? null;
  const settlement =
    latestSettlement && ["FINALIZED", "SETTLED"].includes(String(latestSettlement.stage))
      ? latestSettlement
      : [...settlementRevisions]
          .reverse()
          .find((entry) => ["FINALIZED", "SETTLED"].includes(String(entry.stage))) ?? null;
  const finalizedSettlement =
    settlement?.stage === "SETTLED"
      ? settlementRevisions.find((entry) => entry.id === settlement.supersedesRevisionId) ?? null
      : settlement?.stage === "FINALIZED"
        ? settlement
        : null;
  const pricingSettlementRevisionId =
    finalizedSettlement?.supersedesRevisionId;
  const checklist = asRecordArray(aggregate.checklistRevisions).at(-1) ?? null;
  const hasUnpublishedSuccessor =
    latestSettlement?.stage === "PROPOSED" && latestSettlement.id !== settlement?.id;
  const delta = hasUnpublishedSuccessor
    ? null
    : asRecordArray(aggregate.deltaRevisions).at(-1) ?? null;
  const responseSettlementId =
    settlement?.stage === "SETTLED" ? settlement.supersedesRevisionId : settlement?.id;
  const customerResponse =
    [...asRecordArray(aggregate.customerResponses)]
      .reverse()
      .find((response) => response.settlementRevisionId === responseSettlementId) ?? null;
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
  const financialStatus = closureCase.financialStatus;
  const chargeLines = asRecordArray(aggregate.chargeLines).filter(
    (line) =>
      line.status === "FINAL" &&
      typeof pricingSettlementRevisionId === "string" &&
      line.settlementRevisionId === pricingSettlementRevisionId
  );
  const visibleChargeLineIds = new Set(chargeLines.map((line) => String(line.id)));
  const disputes = asRecordArray(aggregate.disputes).filter((entry) =>
    visibleChargeLineIds.has(String(entry.chargeLineId))
  );
  const blockingDisputeLineIds = new Set(
    disputes
      .filter((entry) => entry.status !== "REJECTED_BY_PLATFORM")
      .map((entry) => entry.chargeLineId)
      .filter((id): id is string => typeof id === "string")
  );
  const blockingDisputeBillIds = new Set(
    chargeLines
      .filter((line) => blockingDisputeLineIds.has(String(line.id)))
      .map((line) => line.billId)
      .filter((id): id is string => typeof id === "string")
  );
  const dispositions = asRecordArray(aggregate.receivableDispositions);
  const supersededDispositionIds = new Set(
    dispositions
      .map((entry) => entry.supersedesDispositionId)
      .filter((id): id is string => typeof id === "string")
  );
  const legalCollectionBillIds = new Set(
    dispositions
      .filter(
        (entry) =>
          !supersededDispositionIds.has(String(entry.id)) &&
          entry.disposition === "LEGAL_COLLECTION"
      )
      .map((entry) => entry.billId)
      .filter((id): id is string => typeof id === "string")
  );
  const payableBillIds = new Set(
    asRecordArray(aggregate.receivableBills)
      .filter(
        (bill) =>
          ["PENDING", "PARTIALLY_PAID", "OVERDUE"].includes(String(bill.billStatus)) &&
          /^\d+$/.test(String(bill.remainingAmount ?? "")) &&
          BigInt(String(bill.remainingAmount)) > 0n
      )
      .map((bill) => bill.id)
      .filter((id): id is string => typeof id === "string")
  );
  const undisputedPayableBillIds = [...payableBillIds]
    .filter(
      (billId) =>
        !blockingDisputeBillIds.has(billId) && !legalCollectionBillIds.has(billId)
    )
    .sort();
  return sanitizeSubscriptionClosurePublic({
    allowedActions: customerAllowedActions({
      customerResponse,
      financialStatus,
      payableBillIds: undisputedPayableBillIds,
      settlement
    }),
    caseNo: closureCase.caseNo,
    checklist,
    contractChargeClauses: asRecordArray(aggregate.contractChargeClauses).map((clause) => ({
      chargeType: clause.chargeType,
      clauseCode: clause.clauseCode,
      id: clause.id,
      pricingSnapshot: clause.pricingSnapshot,
      sourceTextLocator: clause.sourceTextLocator,
      status: clause.status,
      unit: clause.unit
    })),
    closureCaseId: closureCase.id,
    closureType: closureCase.closureType,
    effectiveAt: closureCase.effectiveAt,
    evidenceReferences,
    evidenceLinks: aggregate.evidenceLinks,
    financialStatus,
    finalDisposition: closureCase.finalDisposition,
    nextAction: customerNextAction(
      status,
      financialStatus,
      customerResponse,
      undisputedPayableBillIds,
      blockingDisputeLineIds.size
    ),
    physicalControlMode: closureCase.physicalControlMode,
    returnThreeStageEnabled: aggregate.returnThreeStageEnabled === true,
    returnAppointment:
      Object.keys(vehicleReturn).length > 0
        ? { location: vehicleReturn.returnLocation, scheduledAt: vehicleReturn.scheduledAt }
        : null,
    returnManifestSigning: aggregate.returnManifestTask
      ? {
          expiresAt: asRecord(aggregate.returnManifestTask).signUrlExpiresAt,
          mock: asRecord(aggregate.returnManifestTask).provider === "MOCK",
          provider: asRecord(aggregate.returnManifestTask).provider,
          signUrl: asRecord(aggregate.returnManifestTask).signUrl,
          taskId: asRecord(aggregate.returnManifestTask).id,
          taskStatus: asRecord(aggregate.returnManifestTask).taskStatus
        }
      : null,
    settlement: settlement
      ? {
          amountDueCents: settlement.amountDueCents,
          amountRefundableCents: settlement.amountRefundableCents,
          id: settlement.id,
          pricingSettlementRevisionId,
          resultHash: settlement.resultHash,
          stage: settlement.stage
        }
      : null,
    chargeLines,
    customerResponse,
    delta,
    disputes,
    payableBillIds: undisputedPayableBillIds,
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
  if (value instanceof Prisma.Decimal) return value.toString();
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

export function governedAllowedActions(
  closureCase: Readonly<Record<string, unknown>>,
  governed: Readonly<Record<string, unknown>>
) {
  const status = String(closureCase.status ?? "");
  const checklist = asRecordArray(governed.checklistRevisions).at(-1);
  const delta = asRecordArray(governed.deltaRevisions).at(-1);
  const currentSettlement = asRecord(closureCase.currentSettlementRevision);
  const settlementStage = String(currentSettlement.stage ?? "");
  const responseSettlementId =
    settlementStage === "SETTLED"
      ? currentSettlement.supersedesRevisionId
      : currentSettlement.id;
  const responses = asRecordArray(governed.customerResponses);
  const response = [...responses]
    .reverse()
    .find((item) => item.settlementRevisionId === responseSettlementId);
  const disputes = asRecordArray(governed.disputes);
  const currentResponseIds = new Set(
    responses
      .filter((item) => item.settlementRevisionId === responseSettlementId)
      .map((item) => String(item.id))
  );
  const currentDisputes = disputes.filter(
    (item) =>
      currentResponseIds.size === 0 || currentResponseIds.has(String(item.customerResponseId))
  );
  const blockingDisputes = currentDisputes.filter((item) =>
    ["OPEN", "ACCEPTED_BY_PLATFORM"].includes(String(item.status))
  );
  const receivableBills = asRecordArray(governed.receivableBills);
  const unpaidBills = receivableBills.filter(
    (bill) => nonNegativeBigInt(bill.remainingAmount) > 0n
  );
  const dispositions = asRecordArray(governed.receivableDispositions);
  const supersededDispositionIds = new Set(
    dispositions
      .map((item) => item.supersedesDispositionId)
      .filter((id): id is string => typeof id === "string")
  );
  const latestDispositionByBill = new Map(
    dispositions
      .filter((item) => !supersededDispositionIds.has(String(item.id)))
      .map((item) => [String(item.billId), item])
  );
  const unpaidBillsManaged = unpaidBills.every((bill) => {
    const disposition = latestDispositionByBill.get(String(bill.id));
    return (
      disposition !== undefined &&
      ["DISPUTED", "COLLECTION_PENDING", "LEGAL_COLLECTION"].includes(
        String(disposition.disposition)
      )
    );
  });
  const responseReady =
    settlementStage === "SETTLED" ||
    (settlementStage === "FINALIZED" &&
      response !== undefined &&
      response.settlementHash === currentSettlement.resultHash &&
      response.status !== "PENDING");
  const settlementReady = ["FINALIZED", "SETTLED"].includes(settlementStage);
  const deltaReady =
    delta !== undefined &&
    asRecordArray(delta.items).every((item) => item.responsibility !== "UNDETERMINED");
  const workOrders = [
    closureCase.returnAssetWorkOrder,
    closureCase.recoveryAssetWorkOrder,
    closureCase.reconditioningAssetWorkOrder
  ].map(asRecord);
  const activeRestrictions = workOrders
    .flatMap((workOrder) => asRecordArray(workOrder.restrictions))
    .some((restriction) => restriction.status === "ACTIVE");
  const inventoryReleased =
    asRecord(closureCase.vehicle).status === "AVAILABLE" && !activeRestrictions;
  const operationalCompleted = Boolean(closureCase.operationalCompletedAt);
  const actions: string[] = [];
  if (status === "PREPARING_RETURN") {
    actions.push("CAPTURE_RETURN_CHECKLIST");
  }
  if (checklist) actions.push("UPLOAD_RETURN_EVIDENCE");
  const currentReturnManifest = asRecordArray(closureCase.currentDocuments)
    .map((entry) => asRecord(entry.documentRevision))
    .find((entry) => entry.documentType === "RETURN_MANIFEST");
  const evidenceLinks = asRecordArray(governed.evidenceLinks);
  const supersededEvidenceLinkIds = new Set(
    evidenceLinks
      .map((entry) => entry.supersedesLinkId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  const unilateralSealReady = evidenceLinks.some(
    (entry) =>
      !supersededEvidenceLinkIds.has(String(entry.id)) &&
      entry.evidencePurpose === "UNILATERAL_ATTESTATION_SEAL" &&
      typeof entry.evidenceId === "string"
  );
  const receiptAuthorityReady =
    checklist &&
    (((checklist.attestationMode === "CUSTOMER_REFUSED" ||
      checklist.attestationMode === "CUSTOMER_ABSENT") &&
      unilateralSealReady) ||
      currentReturnManifest?.stage === "ARCHIVED");
  if (status === "PREPARING_RETURN" && receiptAuthorityReady) {
    actions.push("CONFIRM_PHYSICAL_RECEIPT");
  }
  if (status === "RETURN_INSPECTION") {
    actions.push("RECORD_RETURN_INSPECTION", "GENERATE_CONDITION_DELTA");
  }
  if (
    delta &&
    ["RETURN_INSPECTION", "RECONDITIONING", "PENDING_SETTLEMENT"].includes(status) &&
    (!settlementStage ||
      (settlementStage === "FINALIZED" &&
        currentDisputes.some((item) => item.status === "ACCEPTED_BY_PLATFORM")))
  ) {
    actions.push("PROPOSE_SETTLEMENT");
  }
  if (
    delta &&
    settlementStage === "PROPOSED" &&
    ["RETURN_INSPECTION", "RECONDITIONING", "PENDING_SETTLEMENT"].includes(status)
  ) {
    actions.push("PREVIEW_CONTRACT_PRICING", "FINALIZE_CONTRACT_PRICING");
  }
  if (status === "PENDING_SETTLEMENT" && settlementReady) {
    if (checklist && delta) actions.push("EXPORT_EVIDENCE_PACKAGE");
    if (unpaidBills.length > 0) actions.push("RECORD_RECEIVABLE_DISPOSITION");
    if (settlementStage === "FINALIZED" && !response) actions.push("RECORD_NO_RESPONSE");
    if (currentDisputes.some((item) => item.status === "OPEN")) actions.push("DECIDE_DISPUTE");
    if (
      settlementStage === "FINALIZED" &&
      responseReady &&
      blockingDisputes.length === 0 &&
      unpaidBills.length === 0
    ) {
      actions.push("SETTLE_FINANCIAL");
    }
    if (closureCase.physicalControlledAt && !inventoryReleased && !operationalCompleted) {
      actions.push("RELEASE_INVENTORY");
    }
    const legalCases = asRecordArray(governed.legalCases);
    const activeLegalBillIds = new Set(
      legalCases
        .filter((item) => !item.closedAt)
        .map((item) => String(item.billId))
    );
    if (
      asRecordArray(governed.evidencePackages).length > 0 &&
      unpaidBills.some((bill) => !activeLegalBillIds.has(String(bill.id)))
    ) {
      actions.push("TRANSFER_LEGAL_COLLECTION");
    }
    if (legalCases.some((item) => !item.closedAt)) actions.push("RECORD_LEGAL_EVENT");
    if (
      !operationalCompleted &&
      closureCase.physicalControlledAt &&
      inventoryReleased &&
      deltaReady &&
      responseReady &&
      blockingDisputes.length === 0 &&
      (unpaidBills.length === 0 || unpaidBillsManaged)
    ) {
      actions.push("COMPLETE_OPERATIONS");
    }
  }
  return actions;
}

function customerAllowedActions(input: {
  customerResponse: Record<string, unknown> | null;
  financialStatus: unknown;
  payableBillIds: readonly string[];
  settlement: Record<string, unknown> | null;
}) {
  const actions: string[] = [];
  if (input.settlement?.stage === "FINALIZED" && !input.customerResponse) {
    actions.push("ACCEPT_SETTLEMENT", "DISPUTE_CHARGE_LINES");
  }
  if (
    ["ACCEPTED", "PARTIALLY_DISPUTED", "DISPUTED"].includes(
      String(input.customerResponse?.status ?? "")
    ) &&
    input.payableBillIds.length > 0 &&
    input.settlement?.stage !== "SETTLED" &&
    !["SETTLED", "WRITTEN_OFF"].includes(String(input.financialStatus ?? ""))
  ) {
    actions.push("PAY_UNDISPUTED_BILLS");
  }
  return actions;
}

function customerNextAction(
  status: string,
  financialStatus: unknown,
  customerResponse: Record<string, unknown> | null,
  payableBillIds: readonly string[],
  blockingDisputeCount: number
) {
  if (status === "PENDING_SETTLEMENT") {
    if (financialStatus === "LEGAL_COLLECTION") return "未清账单已进入法务处理";
    if (!customerResponse) return "请确认最终退车结算方案或逐项提出争议";
    if (
      payableBillIds.length === 0 ||
      financialStatus === "SETTLED" ||
      financialStatus === "WRITTEN_OFF"
    ) {
      return "账单已处理，等待平台完成结算";
    }
    if (customerResponse.status === "ACCEPTED") return "请支付待结算账单";
    if (
      customerResponse.status === "DISPUTED" ||
      customerResponse.status === "PARTIALLY_DISPUTED"
    ) {
      if (blockingDisputeCount === 0 && payableBillIds.length > 0) {
        return "争议已处理，请支付仍有效账单";
      }
      return "争议处理中；车辆回收流程不会因此中断";
    }
  }
  if (status === "PREPARING_RETURN") return "等待退车安排";
  if (status === "RETURN_INSPECTION" || status === "RECONDITIONING") return "车辆检查处理中";
  if (status === "PENDING_SETTLEMENT") return "等待最终结算";
  if (status === "COMPLETED" || status === "TERMINATED" || status === "CANCELLED")
    return "流程已结束";
  if (status.startsWith("RECOVERY_")) return "请联系服务团队";
  return "等待平台处理";
}

function nonNegativeBigInt(value: unknown) {
  try {
    const parsed = BigInt(String(value ?? "0"));
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}
