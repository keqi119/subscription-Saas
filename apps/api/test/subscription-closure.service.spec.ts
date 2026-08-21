import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";

const IDS = {
  actor: "10000000-0000-4000-8000-000000000001",
  assetWorkOrder: "10000000-0000-4000-8000-000000000002",
  closureCase: "10000000-0000-4000-8000-000000000003",
  contract: "10000000-0000-4000-8000-000000000004",
  customer: "10000000-0000-4000-8000-000000000005",
  esignTask: "10000000-0000-4000-8000-000000000006",
  file: "10000000-0000-4000-8000-000000000007",
  handoverWorkOrder: "10000000-0000-4000-8000-000000000008",
  manifest: "10000000-0000-4000-8000-000000000009",
  order: "10000000-0000-4000-8000-000000000010",
  return: "10000000-0000-4000-8000-000000000011",
  segment: "10000000-0000-4000-8000-000000000012",
  vehicle: "10000000-0000-4000-8000-000000000013"
} as const;

describe("SubscriptionClosureService normal expiry", () => {
  it("owns every source before ranked authority and creates the linked return facts once", async () => {
    const timeline: string[] = [];
    const repository = {
      appendDocumentRevision: vi.fn(async () => ({
        outcome: {
          closureCaseId: IDS.closureCase,
          id: IDS.manifest,
          revisionNumber: 1
        },
        wrote: true
      })),
      createCase: vi.fn(async () => ({
        outcome: {
          caseNo: "CLS-1",
          currentDocuments: {},
          id: IDS.closureCase,
          version: 0
        },
        wrote: true
      })),
      lockAuthorityRows: vi.fn(async () => {
        timeline.push("authority");
      }),
      lockSourceOwnership: vi.fn(async (_tx, source) => {
        timeline.push(`source:${source.key}`);
      })
    };
    const handover = {
      createReturnInboundInTransaction: vi.fn(async () => {
        timeline.push("create:specialist");
        return { id: IDS.handoverWorkOrder };
      }),
      prepareReturnInboundInTransaction: vi.fn(async () => {
        timeline.push("source:return-inbound-handover");
        return Object.freeze({ kind: "handover" });
      })
    };
    const assetOperations = {
      createWorkOrderInTransaction: vi.fn(async () => {
        timeline.push("create:common");
        return { workOrder: { id: IDS.assetWorkOrder } };
      }),
      prepareCallerOwnedTransaction: vi.fn(async () => {
        timeline.push("source:return-inbound-asset-work-order");
        return Object.freeze({ kind: "asset" });
      })
    };
    const tx = createTransaction();
    const service = new SubscriptionClosureService(
      repository as never,
      handover as never,
      assetOperations as never,
      { write: vi.fn(async () => undefined) } as never
    );

    const capability = await service.prepareNormalExpiryInTransaction(tx, {
      decisionAt: new Date("2026-09-02T16:00:00.000Z"),
      orderId: IDS.order,
      segmentId: IDS.segment
    });
    expect(tx.user.findFirst).toHaveBeenNthCalledWith(1, {
      select: { id: true },
      where: { deletedAt: null, id: IDS.actor, status: "ACTIVE" }
    });
    const result = await service.completeNormalExpiryInTransaction(
      tx,
      {
        decisionAt: new Date("2026-09-02T16:00:00.000Z"),
        orderId: IDS.order,
        segmentId: IDS.segment,
        vehicleReturnId: IDS.return
      },
      capability
    );

    expect(timeline.slice(0, 5)).toEqual([
      "source:return-inbound-handover",
      "source:return-inbound-asset-work-order",
      "source:normal-closure-case",
      "source:return-manifest:1",
      "authority"
    ]);
    expect(result).toEqual({
      closureCaseId: IDS.closureCase,
      returnAssetWorkOrderId: IDS.assetWorkOrder,
      returnHandoverWorkOrderId: IDS.handoverWorkOrder,
      returnManifestRevisionId: IDS.manifest
    });
    expect(repository.createCase).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        returnAssetWorkOrderId: IDS.assetWorkOrder,
        returnHandoverWorkOrderId: IDS.handoverWorkOrder,
        vehicleReturnId: IDS.return
      }),
      expect.any(Function)
    );
    expect(repository.appendDocumentRevision).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        documentType: "RETURN_MANIFEST",
        expectedCurrentRevisionId: null,
        expectedVersion: 0,
        generatedAt: new Date("2026-09-02T16:00:01.000Z"),
        handoverWorkOrderId: IDS.handoverWorkOrder,
        vehicleReturnId: IDS.return
      }),
      expect.any(Function)
    );
  });

  it("binds legacy prepare-return to the managed case's exact return and specialist records", async () => {
    const repository = {
      lockAuthorityRows: vi.fn(async () => undefined),
      lockSourceOwnership: vi.fn(async () => undefined)
    };
    const governedCapability = Object.freeze({ kind: "governed-specialist" });
    const handover = {
      prepareGovernedReturnInboundUpdateInTransaction: vi.fn(async () => governedCapability),
      updateGovernedReturnInboundInTransaction: vi.fn(async () => ({
        id: IDS.handoverWorkOrder
      }))
    };
    const tx = {
      subscriptionClosureCase: {
        findUnique: vi.fn(async () => ({
          closureType: "NORMAL_COMPLETION",
          id: IDS.closureCase,
          physicalControlMode: "VOLUNTARY_RETURN",
          returnHandoverWorkOrderId: IDS.handoverWorkOrder,
          vehicleReturnId: IDS.return
        }))
      },
      vehicleHandoverWorkOrder: {
        findUnique: vi.fn(async () => ({
          handoverType: "RETURN_INBOUND",
          id: IDS.handoverWorkOrder,
          orderId: IDS.order
        }))
      },
      vehicleReturn: {
        findUnique: vi.fn(async () => ({
          deletedAt: null,
          id: IDS.return,
          orderId: IDS.order
        }))
      }
    } as unknown as Prisma.TransactionClient;
    const service = new SubscriptionClosureService(
      repository as never,
      handover as never,
      {} as never,
      {} as never
    );
    const input = {
      actorId: IDS.actor,
      orderId: IDS.order,
      returnLocation: "静安旺旺大厦",
      scheduledAt: new Date("2026-09-03T02:00:00.000Z")
    };

    const capability = await service.prepareManagedReturnInTransaction(tx, input);
    const result = await service.completeManagedReturnInTransaction(
      tx,
      { ...input, vehicleReturnId: IDS.return },
      capability!
    );

    expect(result).toEqual({ handoverWorkOrderId: IDS.handoverWorkOrder });
    expect(repository.lockSourceOwnership).toHaveBeenCalledBefore(repository.lockAuthorityRows);
    expect(handover.prepareGovernedReturnInboundUpdateInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        workOrderId: IDS.handoverWorkOrder
      })
    );
    expect(handover.updateGovernedReturnInboundInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ workOrderId: IDS.handoverWorkOrder }),
      governedCapability
    );
  });
});

function createTransaction() {
  return {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      const sql = query.strings.join("?");
      if (sql.includes("clock_timestamp")) {
        return [{ now: new Date("2026-09-02T16:00:01.000Z") }];
      }
      return [{ id: "locked" }];
    }),
    contractESignTask: {
      create: vi.fn(async () => ({ id: IDS.esignTask }))
    },
    fileObject: {
      create: vi.fn(async () => ({ id: IDS.file }))
    },
    lease: {
      findUnique: vi.fn(async () => ({ id: "10000000-0000-4000-8000-000000000014" }))
    },
    subscriptionClosureCase: {
      findUnique: vi.fn(async () => null)
    },
    subscriptionContractSegment: {
      findUnique: vi.fn(async () => ({
        createdBy: IDS.actor,
        endDate: new Date("2026-09-02T00:00:00.000Z"),
        id: IDS.segment,
        orderId: IDS.order,
        sequenceNo: 1
      }))
    },
    subscriptionClosureCurrentDocument: {
      findUnique: vi.fn(async () => null)
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => ({
        contractId: IDS.contract,
        createdBy: IDS.actor,
        customerId: IDS.customer,
        id: IDS.order,
        orderNo: "ORD-1",
        updatedBy: IDS.actor,
        vehicleId: IDS.vehicle
      }))
    },
    user: {
      findFirst: vi.fn(async () => ({ id: IDS.actor }))
    },
    vehicleReturn: {
      findUnique: vi.fn(async ({ where }) =>
        "id" in where && where.id === IDS.return
          ? {
              customerId: IDS.customer,
              deletedAt: null,
              id: IDS.return,
              orderId: IDS.order,
              vehicleId: IDS.vehicle
            }
          : null
      )
    }
  } as unknown as Prisma.TransactionClient;
}
