import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  BusinessExceptionApprovalStatus,
  BusinessExceptionDecision,
  BusinessExceptionSubjectType,
  BusinessExceptionType,
  Prisma,
  VehicleDocumentStatus,
  VehicleDocumentType
} from "@prisma/client";

import {
  AssetAccountingCommandContext,
  AssetAccountingService
} from "../asset-accounting/asset-accounting.service";
import { hashBusinessExceptionSnapshot } from "../asset-accounting/asset-accounting.domain";
import type { BusinessExceptionSnapshot } from "../asset-accounting/asset-accounting.types";
import { PrismaService } from "../prisma/prisma.service";

export const STAGE2_REGISTRATION_EXCEPTION_SUBJECT_FIELD =
  "vehicleRegistrationDocumentReadiness";
export const STAGE2_REGISTRATION_DOCUMENT_MISSING =
  "STAGE2_REGISTRATION_DOCUMENT_MISSING";

type RegistrationDatabase = Prisma.TransactionClient | PrismaService;

const approvalProjection = {
  approvalNo: true,
  decidedAt: true,
  decidedBy: true,
  decision: true,
  id: true,
  requestReason: true,
  requestedAt: true,
  requestedBy: true,
  status: true,
  subjectSnapshotHash: true,
  version: true
} satisfies Prisma.BusinessExceptionApprovalSelect;

export interface Stage2RegistrationGate {
  allowed: boolean;
  approval: null | Prisma.BusinessExceptionApprovalGetPayload<{
    select: typeof approvalProjection;
  }>;
  documentPresent: boolean;
  snapshotHash: string;
}

export interface Stage2RegistrationExceptionCommandContext {
  actorId: string;
  idempotencyKey: string;
  ipAddress?: string;
  permissions: readonly string[];
  userAgent?: string;
}

@Injectable()
export class Stage2HandoverRegistrationExceptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assetAccountingService: AssetAccountingService
  ) {}

  async getGate(
    workOrderId: string,
    db: RegistrationDatabase = this.prisma
  ): Promise<Stage2RegistrationGate> {
    const authority = await resolveRegistrationAuthority(db, workOrderId);
    if (authority.documentPresent) {
      return {
        allowed: true,
        approval: null,
        documentPresent: true,
        snapshotHash: authority.snapshotHash
      };
    }

    const approval = await db.businessExceptionApproval.findFirst({
      orderBy: { createdAt: "desc" },
      select: approvalProjection,
      where: {
        exceptionType: BusinessExceptionType.VEHICLE_REGISTRATION_DOCUMENT_MISSING,
        status: BusinessExceptionApprovalStatus.APPROVED,
        subjectField: STAGE2_REGISTRATION_EXCEPTION_SUBJECT_FIELD,
        subjectId: workOrderId,
        subjectSnapshotHash: authority.snapshotHash,
        subjectType: BusinessExceptionSubjectType.HANDOVER_WORK_ORDER
      }
    });

    return {
      allowed: Boolean(approval),
      approval,
      documentPresent: false,
      snapshotHash: authority.snapshotHash
    };
  }

  async getState(workOrderId: string): Promise<Stage2RegistrationGate & {
    latestApproval: Stage2RegistrationGate["approval"];
  }> {
    const gate = await this.getGate(workOrderId);
    const latestApproval = await this.prisma.businessExceptionApproval.findFirst({
      orderBy: { createdAt: "desc" },
      select: approvalProjection,
      where: {
        exceptionType: BusinessExceptionType.VEHICLE_REGISTRATION_DOCUMENT_MISSING,
        subjectField: STAGE2_REGISTRATION_EXCEPTION_SUBJECT_FIELD,
        subjectId: workOrderId,
        subjectType: BusinessExceptionSubjectType.HANDOVER_WORK_ORDER
      }
    });
    return { ...gate, latestApproval };
  }

  request(
    workOrderId: string,
    reason: string,
    context: Stage2RegistrationExceptionCommandContext
  ) {
    const requestedAt = new Date();
    return this.prisma.$transaction(
      (tx) =>
        this.assetAccountingService.requestApprovalInTransaction(
          tx,
          {
            exceptionType:
              BusinessExceptionType.VEHICLE_REGISTRATION_DOCUMENT_MISSING,
            requestEvidenceSnapshot: {
              blockerCode: STAGE2_REGISTRATION_DOCUMENT_MISSING
            },
            requestReason: reason,
            requestedAt,
            source: registrationSource(
              workOrderId,
              context.idempotencyKey,
              "REQUEST"
            ),
            subject: registrationSubject(workOrderId)
          },
          assetContext(context),
          async (lockedTx) => {
            const authority = await resolveRegistrationAuthority(
              lockedTx,
              workOrderId
            );
            if (authority.documentPresent) {
              throw new BadRequestException({
                code: "STAGE2_REGISTRATION_EXCEPTION_NOT_REQUIRED",
                message: "A usable vehicle registration document is already present."
              });
            }
            return authority.snapshot;
          }
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  decide(
    workOrderId: string,
    approvalId: string,
    input: {
      comment: string;
      decision: BusinessExceptionDecision;
      expectedVersion: number;
    },
    context: Stage2RegistrationExceptionCommandContext
  ) {
    const decidedAt = new Date();
    return this.prisma.$transaction(
      (tx) =>
        this.assetAccountingService.decideApprovalInTransaction(
          tx,
          {
            approvalId,
            decidedAt,
            decision: input.decision,
            decisionComment: input.comment,
            exceptionType:
              BusinessExceptionType.VEHICLE_REGISTRATION_DOCUMENT_MISSING,
            expectedVersion: input.expectedVersion,
            source: registrationSource(
              workOrderId,
              context.idempotencyKey,
              "DECIDE"
            ),
            subject: registrationSubject(workOrderId)
          },
          assetContext(context),
          async (lockedTx) =>
            (await resolveRegistrationAuthority(lockedTx, workOrderId)).snapshot
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }
}

export async function resolveRegistrationAuthority(
  db: RegistrationDatabase,
  workOrderId: string
): Promise<{
  documentPresent: boolean;
  snapshot: BusinessExceptionSnapshot;
  snapshotHash: string;
}> {
  const workOrder = await db.vehicleHandoverWorkOrder.findUnique({
    select: {
      id: true,
      order: { select: { id: true, vehicleId: true } },
      orderId: true
    },
    where: { id: workOrderId }
  });
  if (!workOrder) {
    throw new NotFoundException({
      code: "STAGE2_HANDOVER_WORK_ORDER_NOT_FOUND",
      message: "The Stage 2 handover work order was not found."
    });
  }
  const vehicleId = workOrder.order.vehicleId;
  const [activeDocument, ledgerHead] = vehicleId
    ? await Promise.all([
        db.vehicleDocument.findFirst({
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: registrationDocumentProjection,
          where: {
            deletedAt: null,
            documentStatus: VehicleDocumentStatus.ACTIVE,
            documentType: VehicleDocumentType.VEHICLE_LICENSE,
            objectKey: { not: "" },
            vehicleId
          }
        }),
        db.vehicleDocument.findFirst({
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: registrationDocumentProjection,
          where: {
            documentType: VehicleDocumentType.VEHICLE_LICENSE,
            vehicleId
          }
        })
      ])
    : [null, null];
  const snapshot: BusinessExceptionSnapshot = {
    activeDocument: projectDocument(activeDocument),
    documentLedgerHead: projectDocument(ledgerHead),
    documentType: VehicleDocumentType.VEHICLE_LICENSE,
    orderId: workOrder.orderId,
    schemaVersion: 1,
    vehicleId,
    workOrderId: workOrder.id
  };
  return {
    documentPresent: Boolean(activeDocument),
    snapshot,
    snapshotHash: hashBusinessExceptionSnapshot(snapshot)
  };
}

const registrationDocumentProjection = {
  batchId: true,
  deletedAt: true,
  documentStatus: true,
  fileName: true,
  fileSize: true,
  id: true,
  mimeType: true,
  updatedAt: true
} satisfies Prisma.VehicleDocumentSelect;

function projectDocument(
  document: null | Prisma.VehicleDocumentGetPayload<{
    select: typeof registrationDocumentProjection;
  }>
) {
  if (!document) return null;
  return {
    batchId: document.batchId,
    deletedAt: document.deletedAt,
    documentStatus: document.documentStatus,
    fileName: document.fileName,
    fileSize: document.fileSize,
    id: document.id,
    mimeType: document.mimeType,
    updatedAt: document.updatedAt
  };
}

function registrationSubject(workOrderId: string) {
  return {
    subjectField: STAGE2_REGISTRATION_EXCEPTION_SUBJECT_FIELD,
    subjectId: workOrderId,
    subjectType: BusinessExceptionSubjectType.HANDOVER_WORK_ORDER
  } as const;
}

function registrationSource(
  workOrderId: string,
  key: string,
  operation: "DECIDE" | "REQUEST"
) {
  return {
    id: workOrderId,
    key,
    type: `STAGE2_REGISTRATION_EXCEPTION_${operation}`
  };
}

function assetContext(
  context: Stage2RegistrationExceptionCommandContext
): AssetAccountingCommandContext {
  return {
    actorId: context.actorId,
    idempotencyKey: context.idempotencyKey,
    ipAddress: context.ipAddress,
    permissions: context.permissions,
    userAgent: context.userAgent
  };
}
