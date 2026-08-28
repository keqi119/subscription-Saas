import {
  BusinessExceptionApprovalStatus,
  BusinessExceptionDecision,
  BusinessExceptionSubjectType,
  BusinessExceptionType,
  VehicleDocumentStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { hashBusinessExceptionSnapshot } from "../src/asset-accounting/asset-accounting.domain";
import {
  STAGE2_REGISTRATION_EXCEPTION_SUBJECT_FIELD,
  Stage2HandoverRegistrationExceptionService,
  resolveRegistrationAuthority
} from "../src/handover-work-order/stage2-handover-registration-exception.service";

describe("Stage2HandoverRegistrationExceptionService", () => {
  it("blocks a missing registration document without an exact approved exception", async () => {
    const harness = createHarness();

    const gate = await harness.service.getGate(harness.workOrderId);

    expect(gate).toMatchObject({
      allowed: false,
      approval: null,
      documentPresent: false
    });
    expect(gate.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("allows a usable active registration document without an exception", async () => {
    const harness = createHarness({
      documents: [registrationDocument({ objectKey: "vehicle/license-v1.pdf" })]
    });

    await expect(harness.service.getGate(harness.workOrderId)).resolves.toMatchObject({
      allowed: true,
      approval: null,
      documentPresent: true
    });
    expect(harness.prisma.businessExceptionApproval.findFirst).not.toHaveBeenCalled();
  });

  it("requires an exact approval when the physical registration document was not handed over", async () => {
    const harness = createHarness({
      documents: [registrationDocument({ objectKey: "vehicle/license-v1.pdf" })],
      registrationDocumentState: "NOT_AVAILABLE"
    });

    await expect(harness.service.getGate(harness.workOrderId)).resolves.toMatchObject({
      allowed: false,
      approval: null,
      documentPresent: true
    });
    const authority = await resolveRegistrationAuthority(
      harness.prisma as never,
      harness.workOrderId
    );
    harness.state.approvedSnapshotHash = authority.snapshotHash;

    await expect(harness.service.getGate(harness.workOrderId)).resolves.toMatchObject({
      allowed: true,
      approval: { id: "approval-1" },
      documentPresent: true
    });
  });

  it("allows only an approval bound to the exact current document-ledger snapshot", async () => {
    const harness = createHarness({
      documents: [
        registrationDocument({
          deletedAt: new Date("2026-08-27T08:00:00.000Z"),
          documentStatus: VehicleDocumentStatus.ARCHIVED,
          objectKey: "vehicle/license-removed.pdf"
        })
      ]
    });
    const authority = await resolveRegistrationAuthority(
      harness.prisma as never,
      harness.workOrderId
    );
    harness.state.approvedSnapshotHash = authority.snapshotHash;

    await expect(harness.service.getGate(harness.workOrderId)).resolves.toMatchObject({
      allowed: true,
      approval: { id: "approval-1" },
      documentPresent: false
    });

    harness.state.documents[0] = registrationDocument({
      deletedAt: new Date("2026-08-28T08:00:00.000Z"),
      documentStatus: VehicleDocumentStatus.ARCHIVED,
      id: "document-2",
      objectKey: "vehicle/license-removed-v2.pdf",
      updatedAt: new Date("2026-08-28T08:00:00.000Z")
    });

    await expect(harness.service.getGate(harness.workOrderId)).resolves.toMatchObject({
      allowed: false,
      approval: null,
      documentPresent: false
    });
  });

  it("requests and decides through the governed business-exception ledger", async () => {
    const harness = createHarness();
    const context = commandContext();

    await harness.service.request(
      harness.workOrderId,
      "行驶证补录存在外部阻断",
      context
    );
    await harness.service.decide(
      harness.workOrderId,
      "approval-1",
      {
        comment: "已核验车辆及登记信息，批准本次交付兜底",
        decision: BusinessExceptionDecision.APPROVED,
        expectedVersion: 0
      },
      { ...context, idempotencyKey: "registration-decision-1" }
    );

    expect(harness.assetAccountingService.requestApprovalInTransaction)
      .toHaveBeenCalledWith(
        harness.tx,
        expect.objectContaining({
          exceptionType: BusinessExceptionType.VEHICLE_REGISTRATION_DOCUMENT_MISSING,
          requestReason: "行驶证补录存在外部阻断",
          subject: {
            subjectField: STAGE2_REGISTRATION_EXCEPTION_SUBJECT_FIELD,
            subjectId: harness.workOrderId,
            subjectType: BusinessExceptionSubjectType.HANDOVER_WORK_ORDER
          }
        }),
        expect.objectContaining({ idempotencyKey: "registration-request-1" }),
        expect.any(Function)
      );
    expect(harness.assetAccountingService.decideApprovalInTransaction)
      .toHaveBeenCalledWith(
        harness.tx,
        expect.objectContaining({
          approvalId: "approval-1",
          decision: BusinessExceptionDecision.APPROVED,
          expectedVersion: 0
        }),
        expect.objectContaining({ idempotencyKey: "registration-decision-1" }),
        expect.any(Function)
      );

    const requestResolver = harness.assetAccountingService
      .requestApprovalInTransaction.mock.calls[0]![3];
    const snapshot = await requestResolver(harness.tx);
    expect(hashBusinessExceptionSnapshot(snapshot)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot)).not.toContain("objectKey");
  });

  it("rejects a new exception request once a usable document exists", async () => {
    const harness = createHarness({
      documents: [registrationDocument({ objectKey: "vehicle/license-v1.pdf" })],
      resolveRequestAuthority: true
    });

    await expect(
      harness.service.request(
        harness.workOrderId,
        "不应再申请兜底",
        commandContext()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_REGISTRATION_EXCEPTION_NOT_REQUIRED"
      })
    });
  });
});

function createHarness(overrides: {
  documents?: ReturnType<typeof registrationDocument>[];
  registrationDocumentState?: "HANDED_OVER" | "NOT_AVAILABLE";
  resolveRequestAuthority?: boolean;
} = {}) {
  const workOrderId = "00000000-0000-4000-8000-000000000101";
  const tx = {} as Record<string, unknown>;
  const state = {
    approvedSnapshotHash: null as null | string,
    documents: overrides.documents ?? []
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
      Object.assign(tx, prisma);
      return callback(tx);
    }),
    businessExceptionApproval: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (
          where.status === BusinessExceptionApprovalStatus.APPROVED &&
          where.subjectSnapshotHash === state.approvedSnapshotHash
        ) {
          return approval();
        }
        return null;
      })
    },
    vehicleDocument: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const sorted = [...state.documents].sort(
          (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
        );
        if (where.documentStatus === VehicleDocumentStatus.ACTIVE) {
          return sorted.find(
            (document) =>
              document.documentStatus === VehicleDocumentStatus.ACTIVE &&
              document.deletedAt === null &&
              Boolean(document.objectKey)
          ) ?? null;
        }
        return sorted[0] ?? null;
      })
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async () => ({
        handoverFactRevision: 1,
        id: workOrderId,
        order: {
          id: "00000000-0000-4000-8000-000000000102",
          vehicleId: "00000000-0000-4000-8000-000000000103"
        },
        orderId: "00000000-0000-4000-8000-000000000102",
        registrationDocumentState:
          overrides.registrationDocumentState ?? "HANDED_OVER"
      }))
    }
  };
  Object.assign(tx, prisma);
  const assetAccountingService = {
    decideApprovalInTransaction: vi.fn(async () => approval()),
    requestApprovalInTransaction: vi.fn(
      async (
        transaction: unknown,
        _command: unknown,
        _context: unknown,
        resolver: (database: unknown) => Promise<unknown>
      ) => {
        if (overrides.resolveRequestAuthority) await resolver(transaction);
        return approval();
      }
    )
  };
  const service = new Stage2HandoverRegistrationExceptionService(
    prisma as never,
    assetAccountingService as never
  );
  return {
    assetAccountingService,
    prisma,
    service,
    state,
    tx,
    workOrderId
  };
}

function registrationDocument(
  overrides: Partial<{
    deletedAt: Date | null;
    documentStatus: VehicleDocumentStatus;
    id: string;
    objectKey: string;
    updatedAt: Date;
  }> = {}
) {
  return {
    batchId: "00000000-0000-4000-8000-000000000105",
    deletedAt: null,
    documentStatus: VehicleDocumentStatus.ACTIVE,
    fileName: "license.pdf",
    fileSize: 1024,
    id: "document-1",
    mimeType: "application/pdf",
    objectKey: "",
    updatedAt: new Date("2026-08-27T08:00:00.000Z"),
    ...overrides
  };
}

function approval() {
  return {
    approvalNo: "BEA202608280001",
    decidedAt: new Date("2026-08-28T08:30:00.000Z"),
    decidedBy: "00000000-0000-4000-8000-000000000201",
    decision: BusinessExceptionDecision.APPROVED,
    id: "approval-1",
    requestReason: "registration missing",
    requestedAt: new Date("2026-08-28T08:00:00.000Z"),
    requestedBy: "00000000-0000-4000-8000-000000000202",
    status: BusinessExceptionApprovalStatus.APPROVED,
    subjectSnapshotHash: "a".repeat(64),
    version: 1
  };
}

function commandContext() {
  return {
    actorId: "00000000-0000-4000-8000-000000000201",
    idempotencyKey: "registration-request-1",
    permissions: [
      "business_exception:request",
      "business_exception:approve"
    ]
  };
}
