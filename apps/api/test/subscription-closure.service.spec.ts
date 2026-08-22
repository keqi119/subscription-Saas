import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscriptionEffectiveBoundaryOwner } from "../src/subscription-change/subscription-effective-boundary";
import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";
import { canonicalSubscriptionClosureJson } from "../src/subscription-closure/subscription-closure.domain";
import { subscriptionClosureCaseNo } from "../src/subscription-closure/subscription-closure.repository";

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
  beforeEach(() => {
    vi.spyOn(subscriptionEffectiveBoundaryOwner, "prepareInTransaction").mockResolvedValue({
      capability: Object.freeze({}),
      requirement: Object.freeze({
        command: Object.freeze({ orderId: IDS.order }),
        key: "effective-boundary-stop",
        locks: Object.freeze([])
      })
    } as never);
    vi.spyOn(subscriptionEffectiveBoundaryOwner, "applyPreparedInTransaction").mockResolvedValue(
      Object.freeze({}) as never
    );
    vi.spyOn(subscriptionEffectiveBoundaryOwner, "validatePreparedInTransaction").mockResolvedValue(
      Object.freeze({}) as never
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays an existing case with its immutable actor after that actor becomes inactive", async () => {
    const tx = createTransaction() as never as {
      subscriptionClosureCase: { findFirst: ReturnType<typeof vi.fn> };
      user: { findFirst: ReturnType<typeof vi.fn> };
    } & Prisma.TransactionClient;
    tx.subscriptionClosureCase.findFirst.mockResolvedValue({
      createSourceId: IDS.segment,
      createSourceKey: "normal-closure-case",
      createSourceType: "SUBSCRIPTION_EXPIRY",
      createdBy: IDS.actor,
      effectiveAt: new Date("2026-09-02T16:00:00.000Z"),
      id: IDS.closureCase,
      returnAssetWorkOrderId: IDS.assetWorkOrder,
      returnHandoverWorkOrderId: IDS.handoverWorkOrder,
      vehicleReturnId: IDS.return
    });
    tx.user.findFirst.mockResolvedValue(null);
    const handover = {
      attestReturnInboundAuthorityInTransaction: vi.fn(async () => Object.freeze({})),
      createReturnInboundAuthorityRequirement: vi.fn(() => ({ key: "handover-create" })),
      prepareReturnInboundInTransaction: vi.fn(async () => Object.freeze({ kind: "source" }))
    };
    const assetOperations = {
      createAuthorityRequirement: vi.fn(() => ({ key: "asset-create" })),
      prepareCallerOwnedTransaction: vi.fn(async () => Object.freeze({ kind: "source" }))
    };
    const authoritySession = Object.freeze({ kind: "authority-session" });
    const repository = {
      bindAuthorityRequirement: vi.fn((_session, requirement) => requirement),
      consumeAuthorityAttestationInTransaction: vi.fn(async () => undefined),
      createAuthoritySessionInTransaction: vi.fn(() => authoritySession),
      prepareAuthorityInTransaction: vi.fn(
        async () => new Map([["handover-create", Object.freeze({})]])
      ),
      prepareSourceInTransaction: vi.fn(async () => Object.freeze({}))
    };
    const service = new SubscriptionClosureService(
      repository as never,
      handover as never,
      assetOperations as never,
      {} as never
    );

    await expect(
      service.prepareNormalExpiryInTransaction(tx, {
        decisionAt: new Date("2026-09-03T16:00:00.000Z"),
        orderId: IDS.order,
        segmentId: IDS.segment
      })
    ).resolves.toBeDefined();
    expect(handover.prepareReturnInboundInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ actorId: IDS.actor })
    );
    expect(tx.user.findFirst).not.toHaveBeenCalled();
  });

  it("owns every source before ranked authority and creates the linked return facts once", async () => {
    const timeline: string[] = [];
    const authority = new Map(
      [
        "asset-create",
        "case-create",
        "effective-boundary-stop",
        "handover-create",
        "manifest-create"
      ].map((key) => [key, Object.freeze({ key })])
    );
    const authoritySession = Object.freeze({ kind: "authority-session" });
    const repository = {
      appendPreparedDocumentRevisionInTransaction: vi.fn(async () => ({
        outcome: {
          closureCaseId: IDS.closureCase,
          id: IDS.manifest,
          revisionNumber: 1
        },
        wrote: true
      })),
      bindAuthorityRequirement: vi.fn((_session, requirement) => requirement),
      createAuthoritySessionInTransaction: vi.fn(() => authoritySession),
      createPreparedCaseInTransaction: vi.fn(
        async (_tx, _session, _command, _source, _proof, caseId) => ({
          outcome: {
            caseNo: "CLS-1",
            currentDocuments: {},
            id: caseId,
            version: 0
          },
          wrote: true
        })
      ),
      consumeAuthorityAttestationInTransaction: vi.fn(async (_tx, _capability, key) => {
        timeline.push(`attest:${key}`);
      }),
      prepareAuthorityInTransaction: vi.fn(async () => {
        timeline.push("authority");
        return authority;
      }),
      prepareSourceInTransaction: vi.fn(async (_tx, source) => {
        timeline.push(`source:${source.key}`);
        return Object.freeze({ key: source.key });
      })
    };
    const handover = {
      attestReturnInboundAuthorityInTransaction: vi.fn(
        async (_tx, _session, _command, _source, _proof, workOrderId) => {
          timeline.push("domain-attest:specialist");
          return Object.freeze({ kind: "prepared-handover", workOrderId });
        }
      ),
      createPreparedReturnInboundInTransaction: vi.fn(async (_tx, capability) => {
        timeline.push("create:specialist");
        return { id: capability.workOrderId };
      }),
      createReturnInboundAuthorityRequirement: vi.fn(() => ({ key: "handover-create" })),
      prepareReturnInboundInTransaction: vi.fn(async () => {
        timeline.push("source:return-inbound-handover");
        return Object.freeze({ kind: "handover" });
      })
    };
    const assetOperations = {
      attestCallerOwnedCreateAuthorityInTransaction: vi.fn(
        async (_tx, _session, _command, _context, _source, _proof, workOrderId) => {
          timeline.push("domain-attest:common");
          return Object.freeze({ kind: "prepared-asset", workOrderId });
        }
      ),
      createPreparedWorkOrderInTransaction: vi.fn(async (_tx, capability) => {
        timeline.push("create:common");
        return { workOrder: { id: capability.workOrderId } };
      }),
      createAuthorityRequirement: vi.fn(() => ({ key: "asset-create" })),
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

    expect(
      timeline.filter(
        (entry) =>
          entry.startsWith("source:") || entry === "authority" || entry.startsWith("domain-attest:")
      )
    ).toEqual([
      "source:normal-closure-case",
      "source:return-inbound-asset-work-order",
      "source:return-inbound-handover",
      "source:return-manifest:1",
      "authority",
      "domain-attest:specialist",
      "domain-attest:common"
    ]);
    expect(result).toEqual({
      closureCaseId: expect.any(String),
      returnAssetWorkOrderId: expect.any(String),
      returnHandoverWorkOrderId: expect.any(String),
      returnManifestRevisionId: IDS.manifest
    });
    expect(repository.createPreparedCaseInTransaction).toHaveBeenCalledWith(
      tx,
      authoritySession,
      expect.objectContaining({
        returnAssetWorkOrderId: result.returnAssetWorkOrderId,
        returnHandoverWorkOrderId: result.returnHandoverWorkOrderId,
        vehicleReturnId: IDS.return
      }),
      expect.anything(),
      authority.get("case-create"),
      result.closureCaseId,
      expect.any(Function)
    );
    expect(repository.appendPreparedDocumentRevisionInTransaction).toHaveBeenCalledWith(
      tx,
      authoritySession,
      expect.objectContaining({
        documentType: "RETURN_MANIFEST",
        expectedCurrentRevisionId: null,
        expectedVersion: 0,
        generatedAt: new Date("2026-09-02T16:00:01.000Z"),
        handoverWorkOrderId: result.returnHandoverWorkOrderId,
        vehicleReturnId: IDS.return
      }),
      expect.anything(),
      authority.get("manifest-create"),
      expect.any(Function)
    );
    expect(repository.prepareAuthorityInTransaction).toHaveBeenCalledTimes(1);
    expect(repository.prepareAuthorityInTransaction).toHaveBeenCalledWith(
      tx,
      authoritySession,
      expect.arrayContaining([
        { id: IDS.order, mode: "UPDATE", table: "subscription_order" },
        { id: IDS.vehicle, mode: "SHARE", table: "vehicle" },
        { id: IDS.contract, mode: "SHARE", table: "contract" },
        { id: IDS.segment, mode: "UPDATE", table: "subscription_contract_segment" },
        { id: IDS.customer, mode: "SHARE", table: "customer" },
        { id: IDS.actor, mode: "SHARE", table: "user" }
      ]),
      expect.arrayContaining([
        expect.objectContaining({ key: "asset-create" }),
        expect.objectContaining({ key: "case-create" }),
        expect.objectContaining({ key: "handover-create" }),
        expect.objectContaining({ key: "manifest-create" })
      ])
    );
    expect(timeline.filter((entry) => entry === "authority")).toHaveLength(1);
    expect(tx.contractESignTask.findMany).toHaveBeenCalledTimes(1);
    expect(tx.fileObject.findUnique).not.toHaveBeenCalled();
  });

  it("replays immutable manifest revision one after the current family advances", async () => {
    const tx = createTransaction() as never as {
      subscriptionClosureCase: { findFirst: ReturnType<typeof vi.fn> };
      subscriptionClosureCurrentDocument: { findUnique: ReturnType<typeof vi.fn> };
      subscriptionClosureDocumentRevision: { findFirst: ReturnType<typeof vi.fn> };
      contractESignTask: { findMany: ReturnType<typeof vi.fn> };
      fileObject: { findUnique: ReturnType<typeof vi.fn> };
    } & Prisma.TransactionClient;
    tx.subscriptionClosureCase.findFirst.mockResolvedValue({
      createSourceId: IDS.segment,
      createSourceKey: "normal-closure-case",
      createSourceType: "SUBSCRIPTION_EXPIRY",
      createdBy: IDS.actor,
      effectiveAt: new Date("2026-09-02T16:00:00.000Z"),
      id: IDS.closureCase,
      returnAssetWorkOrderId: IDS.assetWorkOrder,
      returnHandoverWorkOrderId: IDS.handoverWorkOrder,
      vehicleReturnId: IDS.return
    });
    const caseNo = subscriptionClosureCaseNo({
      id: IDS.segment,
      key: "normal-closure-case",
      type: "SUBSCRIPTION_EXPIRY"
    });
    const revisionDocumentSnapshot = {
      assetWorkOrderId: IDS.assetWorkOrder,
      caseNo,
      closureCaseId: IDS.closureCase,
      contractId: IDS.contract,
      customerId: IDS.customer,
      documentType: "RETURN_MANIFEST",
      handoverWorkOrderId: IDS.handoverWorkOrder,
      orderId: IDS.order,
      segmentId: IDS.segment,
      vehicleId: IDS.vehicle,
      vehicleReturnId: IDS.return
    };
    const revisionOne = {
      archivedAt: null,
      archivedBy: null,
      closureCaseId: IDS.closureCase,
      contractESignTaskId: IDS.esignTask,
      documentSnapshot: revisionDocumentSnapshot,
      documentType: "RETURN_MANIFEST",
      generatedAt: new Date("2026-09-02T16:00:01.000Z"),
      generatedBy: IDS.actor,
      handoverWorkOrderId: IDS.handoverWorkOrder,
      id: IDS.manifest,
      signedAt: null,
      signedBy: null,
      signedFileHash: null,
      signedFileId: null,
      sourceFileHash: createHash("sha256")
        .update(canonicalSubscriptionClosureJson(revisionDocumentSnapshot))
        .digest("hex"),
      sourceFileId: IDS.file,
      stage: "GENERATED",
      vehicleReturnId: IDS.return
    };
    tx.subscriptionClosureDocumentRevision.findFirst.mockResolvedValue(revisionOne);
    tx.contractESignTask.findMany.mockResolvedValue([
      {
        contractId: IDS.contract,
        customerId: IDS.customer,
        deletedAt: null,
        documentName: `${caseNo}-return-manifest-r1.json`,
        documentObjectKey: `subscription-closure/${IDS.closureCase}/return-manifest-r1.json`,
        documentType: "DELIVERY_HANDOVER",
        id: IDS.esignTask,
        orderId: IDS.order,
        requestSnapshot: {
          closureCaseId: IDS.closureCase,
          documentSnapshotHash: createHash("sha256")
            .update(canonicalSubscriptionClosureJson(revisionOne.documentSnapshot))
            .digest("hex"),
          documentType: "RETURN_MANIFEST",
          returnManifestSource: {
            id: IDS.segment,
            key: "return-manifest:1",
            type: "SUBSCRIPTION_EXPIRY"
          },
          revisionNumber: 1,
          sourceFileHash: revisionOne.sourceFileHash,
          sourceFileId: revisionOne.sourceFileId
        },
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        sourceId: IDS.segment,
        sourceKey: "return-manifest:1",
        sourceType: "SUBSCRIPTION_EXPIRY"
      }
    ]);
    tx.fileObject.findUnique.mockResolvedValue({
      bucket: "subscription-closure",
      id: IDS.file,
      mimeType: "application/json",
      objectKey: `subscription-closure/${IDS.closureCase}/return-manifest-r1.json`,
      originalName: `${caseNo}-return-manifest-r1.json`,
      sizeBytes: BigInt(
        Buffer.byteLength(canonicalSubscriptionClosureJson(revisionOne.documentSnapshot))
      ),
      uploadedBy: IDS.actor
    });
    tx.subscriptionClosureCurrentDocument.findUnique.mockResolvedValue({
      documentRevision: {
        ...revisionOne,
        archivedAt: new Date("2026-09-04T00:00:00.000Z"),
        archivedBy: IDS.actor,
        id: "10000000-0000-4000-8000-000000000099",
        signedAt: new Date("2026-09-03T00:00:00.000Z"),
        signedBy: IDS.actor,
        signedFileHash: "b".repeat(64),
        signedFileId: "10000000-0000-4000-8000-000000000098",
        stage: "ARCHIVED"
      }
    });
    const appendDocumentRevision = vi.fn(async () => ({ outcome: revisionOne, wrote: false }));
    const authority = new Map(
      [
        "asset-create",
        "case-create",
        "effective-boundary-stop",
        "handover-create",
        "manifest-create"
      ].map((key) => [key, Object.freeze({ key })])
    );
    const authoritySession = Object.freeze({ kind: "authority-session" });
    const repository = {
      appendPreparedDocumentRevisionInTransaction: appendDocumentRevision,
      bindAuthorityRequirement: vi.fn((_session, requirement) => requirement),
      consumeAuthorityAttestationInTransaction: vi.fn(async () => undefined),
      createAuthoritySessionInTransaction: vi.fn(() => authoritySession),
      createPreparedCaseInTransaction: vi.fn(async () => ({
        outcome: { caseNo: "CLS-1", id: IDS.closureCase, version: 2 },
        wrote: false
      })),
      prepareAuthorityInTransaction: vi.fn(async () => authority),
      prepareSourceInTransaction: vi.fn(async () => Object.freeze({}))
    };
    const service = new SubscriptionClosureService(
      repository as never,
      {
        attestReturnInboundAuthorityInTransaction: vi.fn(async () => Object.freeze({})),
        createPreparedReturnInboundInTransaction: vi.fn(async () => ({
          id: IDS.handoverWorkOrder
        })),
        createReturnInboundAuthorityRequirement: vi.fn(() => ({ key: "handover-create" })),
        prepareReturnInboundInTransaction: vi.fn(async () => Object.freeze({}))
      } as never,
      {
        attestCallerOwnedCreateAuthorityInTransaction: vi.fn(async () => Object.freeze({})),
        createPreparedWorkOrderInTransaction: vi.fn(async () => ({
          workOrder: { id: IDS.assetWorkOrder }
        })),
        createAuthorityRequirement: vi.fn(() => ({ key: "asset-create" })),
        prepareCallerOwnedTransaction: vi.fn(async () => Object.freeze({}))
      } as never,
      {} as never
    );
    const prepared = await service.prepareNormalExpiryInTransaction(tx, {
      decisionAt: new Date("2026-09-05T00:00:00.000Z"),
      orderId: IDS.order,
      segmentId: IDS.segment
    });

    await service.completeNormalExpiryInTransaction(
      tx,
      {
        decisionAt: new Date("2026-09-05T00:00:00.000Z"),
        orderId: IDS.order,
        segmentId: IDS.segment,
        vehicleReturnId: IDS.return
      },
      prepared
    );

    expect(appendDocumentRevision).toHaveBeenCalledWith(
      tx,
      authoritySession,
      expect.objectContaining({
        actorId: IDS.actor,
        archivedAt: null,
        sourceFileId: IDS.file,
        stage: "GENERATED"
      }),
      expect.anything(),
      authority.get("manifest-create"),
      expect.any(Function)
    );
    expect(tx.contractESignTask.findMany).toHaveBeenCalledTimes(2);
    expect(tx.fileObject.findUnique).toHaveBeenCalledTimes(2);
    expect(tx.fileObject.findUnique.mock.invocationCallOrder[1]).toBeGreaterThan(
      repository.prepareAuthorityInTransaction.mock.invocationCallOrder[0]!
    );
  });

  it("binds legacy prepare-return to the managed case's exact return and specialist records", async () => {
    const authorityAttestation = Object.freeze({ kind: "managed-authority" });
    const authoritySession = Object.freeze({ kind: "authority-session" });
    const repository = {
      bindAuthorityRequirement: vi.fn((_session, requirement) => requirement),
      consumeAuthorityAttestationInTransaction: vi.fn(async () => undefined),
      createAuthoritySessionInTransaction: vi.fn(() => authoritySession),
      prepareAuthorityInTransaction: vi.fn(
        async () => new Map([["managed-return", authorityAttestation]])
      )
    };
    const governedCapability = Object.freeze({ kind: "governed-specialist" });
    const governedSource = Object.freeze({ kind: "governed-source" });
    const handover = {
      attestGovernedReturnInboundAuthorityInTransaction: vi.fn(async () => governedCapability),
      createGovernedReturnInboundAuthorityRequirement: vi.fn(() => ({ key: "managed-return" })),
      prepareGovernedReturnInboundSourceInTransaction: vi.fn(async () => governedSource),
      updatePreparedGovernedReturnInboundInTransaction: vi.fn(async () => ({
        id: IDS.handoverWorkOrder
      }))
    };
    const tx = {
      subscriptionClosureCase: {
        findFirst: vi.fn(async () => ({
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
    expect(handover.prepareGovernedReturnInboundSourceInTransaction).toHaveBeenCalledBefore(
      repository.prepareAuthorityInTransaction
    );
    expect(handover.prepareGovernedReturnInboundSourceInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        workOrderId: IDS.handoverWorkOrder
      })
    );
    expect(handover.attestGovernedReturnInboundAuthorityInTransaction).toHaveBeenCalledWith(
      tx,
      authoritySession,
      expect.objectContaining({ workOrderId: IDS.handoverWorkOrder }),
      governedSource,
      authorityAttestation
    );
    expect(handover.updatePreparedGovernedReturnInboundInTransaction).toHaveBeenCalledWith(
      tx,
      governedCapability
    );
  });
});

function createTransaction() {
  const esignTasks: Array<Record<string, unknown>> = [];
  return {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      const sql = query.strings.join("?");
      if (sql.includes("clock_timestamp")) {
        return [{ now: new Date("2026-09-02T16:00:01.000Z") }];
      }
      return [{ id: "locked" }];
    }),
    contractESignTask: {
      create: vi.fn(async ({ data }) => {
        const task = { deletedAt: null, ...data };
        esignTasks.push(task);
        return task;
      }),
      findMany: vi.fn(async () => esignTasks)
    },
    fileObject: {
      create: vi.fn(async ({ data }) => data),
      findUnique: vi.fn(async () => null)
    },
    lease: {
      findUnique: vi.fn(async () => ({ id: "10000000-0000-4000-8000-000000000014" }))
    },
    subscriptionClosureCase: {
      findFirst: vi.fn(async () => null),
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
    subscriptionClosureDocumentRevision: {
      findFirst: vi.fn(async () => null)
    },
    subscriptionChangeOrder: {
      findMany: vi.fn(async () => [])
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
    renewalConsideration: {
      findMany: vi.fn(async () => [])
    },
    user: {
      findFirst: vi.fn(async () => ({ id: IDS.actor }))
    },
    vehicleReturn: {
      findUnique: vi.fn(async ({ where }) =>
        ("id" in where && where.id === IDS.return) ||
        ("orderId" in where && where.orderId === IDS.order)
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
