import {
  BadRequestException,
  ConflictException,
  Logger,
  UnauthorizedException
} from "@nestjs/common";
import {
  ContractStatus,
  FieldOperatorAuditEventType,
  UserStatus,
  VehicleHandoverEventType,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDeliveryHandoverEvidencePackage } from "../src/delivery-handover/delivery-handover-evidence-manifest";
import { VehicleAvailabilityPurpose } from "../src/asset-operations/vehicle-availability";
import {
  DeliveryEvidenceVideoQualityError,
  type PreparedDeliveryEvidenceArtifacts
} from "../src/delivery-handover/delivery-handover-evidence-artifact.service";
import { projectFieldHandoverWorkflow } from "../src/handover-work-order/field-handover-workflow-projection";
import {
  HANDOVER_P0_CAPABILITY_ERROR_CODE,
  HandoverWorkOrderService
} from "../src/handover-work-order/handover-work-order.service";
import {
  buildBoundHandoverFactSnapshot,
  buildPhysicalHandoverFactSnapshot
} from "../src/handover-work-order/handover-explicit-facts";
import {
  SubscriptionClosureRepository,
  type SubscriptionClosureAuthorityRequirement
} from "../src/subscription-closure/subscription-closure.repository";

function explicitAccessoryItems() {
  return [
    { code: "CHARGING_CABLE", name: "充电线", quantity: 1, state: "PRESENT" as const }
  ];
}

function explicitHandoverFacts() {
  return {
    accessoryItems: explicitAccessoryItems(),
    keyState: "COMPLETE",
    primaryKeyCount: 1,
    registrationDocumentState: "HANDED_OVER",
    spareKeyCount: 1,
    vehicleConditionConfirmed: true
  } as const;
}

function handoverFactBinding(source: Record<string, unknown>) {
  const physical = buildPhysicalHandoverFactSnapshot(source);
  const bound = buildBoundHandoverFactSnapshot(physical.snapshot, null);
  return { handoverFactHash: bound.hash, handoverFacts: bound.snapshot };
}

describe("Field handover workflow projection", () => {
  const base = {
    handover: null,
    task: null,
    workOrderStatus: "CUSTOMER_CONFIRMED"
  } as const;

  it.each([
    {
      expected: ["HANDOVER_PDF_GENERATING", "交接单生成中", "ACTIVE"],
      facts: base,
      name: "customer-confirmed without a Stage 2 source"
    },
    {
      expected: ["ESIGN_INITIATION_PENDING", "待发起签署", "ACTIVE"],
      facts: {
        ...base,
        handover: {
          archiveStatus: "NOT_STARTED",
          archivedAt: null,
          signedDocumentFileId: null,
          signedPdfHash: null,
          sourceDocumentFileId: "source-file-1",
          status: "SOURCE_GENERATED",
          updatedAt: new Date("2026-08-16T08:00:00.000Z")
        }
      },
      name: "generated PDF without an eSign task"
    },
    {
      expected: ["CUSTOMER_SIGNATURE_PENDING", "待客户签署", "ACTIVE"],
      facts: {
        ...base,
        handover: {
          archiveStatus: "NOT_STARTED",
          archivedAt: null,
          signedDocumentFileId: null,
          signedPdfHash: null,
          sourceDocumentFileId: "source-file-1",
          status: "PENDING_CUSTOMER_SIGNATURE",
          updatedAt: new Date("2026-08-16T08:00:00.000Z")
        },
        task: {
          signers: [
            { signedAt: null, signerStatus: "SIGNING", slotId: "STAGE2_HANDOVER_CUSTOMER" },
            { signedAt: null, signerStatus: "PENDING", slotId: "STAGE2_HANDOVER_PLATFORM" }
          ],
          taskStatus: "WAITING_CUSTOMER"
        }
      },
      name: "customer signature pending"
    },
    {
      expected: ["PLATFORM_SEAL_PENDING", "平台盖章中", "ACTIVE"],
      facts: {
        ...base,
        handover: {
          archiveStatus: "NOT_STARTED",
          archivedAt: null,
          signedDocumentFileId: null,
          signedPdfHash: null,
          sourceDocumentFileId: "source-file-1",
          status: "PENDING_PLATFORM_SEAL",
          updatedAt: new Date("2026-08-16T08:00:00.000Z")
        },
        task: {
          signers: [
            { signedAt: new Date("2026-08-16T08:05:00.000Z"), signerStatus: "SIGNED", slotId: "STAGE2_HANDOVER_CUSTOMER" },
            { signedAt: null, signerStatus: "PENDING", slotId: "STAGE2_HANDOVER_PLATFORM" }
          ],
          taskStatus: "SIGNING"
        }
      },
      name: "platform seal pending"
    },
    {
      expected: ["ARCHIVE_PENDING", "签署完成，归档中", "ACTIVE"],
      facts: {
        ...base,
        handover: {
          archiveStatus: "PENDING",
          archivedAt: null,
          signedDocumentFileId: null,
          signedPdfHash: null,
          sourceDocumentFileId: "source-file-1",
          status: "SIGNED",
          updatedAt: new Date("2026-08-16T08:00:00.000Z")
        },
        task: {
          signers: [
            { signedAt: new Date("2026-08-16T08:05:00.000Z"), signerStatus: "SIGNED", slotId: "STAGE2_HANDOVER_CUSTOMER" },
            { signedAt: new Date("2026-08-16T08:06:00.000Z"), signerStatus: "SIGNED", slotId: "STAGE2_HANDOVER_PLATFORM" }
          ],
          taskStatus: "COMPLETED"
        }
      },
      name: "signed document awaiting archive"
    },
    {
      expected: ["ARCHIVE_FAILED", "归档异常", "ACTIVE"],
      facts: {
        ...base,
        handover: {
          archiveStatus: "FAILED",
          archivedAt: null,
          signedDocumentFileId: null,
          signedPdfHash: null,
          sourceDocumentFileId: "source-file-1",
          status: "SIGNED",
          updatedAt: new Date("2026-08-16T08:00:00.000Z")
        },
        task: {
          signers: [
            { signedAt: new Date("2026-08-16T08:05:00.000Z"), signerStatus: "SIGNED", slotId: "STAGE2_HANDOVER_CUSTOMER" },
            { signedAt: new Date("2026-08-16T08:06:00.000Z"), signerStatus: "SIGNED", slotId: "STAGE2_HANDOVER_PLATFORM" }
          ],
          taskStatus: "COMPLETED"
        }
      },
      name: "archive failure"
    },
    {
      expected: ["COMPLETED", "已完成", "ENDED"],
      facts: {
        ...base,
        handover: {
          archiveStatus: "ARCHIVED",
          archivedAt: new Date("2026-08-16T08:10:00.000Z"),
          signedDocumentFileId: "signed-file-1",
          signedPdfHash: "a".repeat(64),
          sourceDocumentFileId: "source-file-1",
          status: "ARCHIVED",
          updatedAt: new Date("2026-08-16T08:10:00.000Z")
        },
        task: {
          signers: [
            { signedAt: new Date("2026-08-16T08:05:00.000Z"), signerStatus: "SIGNED", slotId: "STAGE2_HANDOVER_CUSTOMER" },
            { signedAt: new Date("2026-08-16T08:06:00.000Z"), signerStatus: "SIGNED", slotId: "STAGE2_HANDOVER_PLATFORM" }
          ],
          taskStatus: "COMPLETED"
        }
      },
      name: "fully archived handover"
    },
    ...(["CANCELLED", "VOIDED", "FAILED"] as const).map((status) => ({
      expected: [status, status === "CANCELLED" ? "已取消" : status === "VOIDED" ? "已作废" : "处理失败", "ENDED"],
      facts: { ...base, workOrderStatus: status },
      name: `terminal ${status.toLowerCase()} work order`
    })),
    {
      expected: ["INCONSISTENT", "状态异常，请联系运营", "ACTIVE"],
      facts: {
        ...base,
        handover: {
          archiveStatus: "ARCHIVED",
          archivedAt: null,
          signedDocumentFileId: null,
          signedPdfHash: null,
          sourceDocumentFileId: "source-file-1",
          status: "ARCHIVED",
          updatedAt: new Date("2026-08-16T08:00:00.000Z")
        }
      },
      name: "contradictory archived handover"
    }
  ])("projects $name", ({ expected, facts }) => {
    expect(projectFieldHandoverWorkflow(facts)).toMatchObject({
      displayStatus: expected[0],
      displayStatusLabel: expected[1],
      taskGroup: expected[2]
    });
  });
});

describe("HandoverWorkOrderService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates and exactly replays RETURN_INBOUND only through a caller-owned P0 capability", async () => {
    const harness = createHandoverWorkOrderHarness();
    const source = {
      id: randomUUID(),
      key: "closure:return-inbound:v1",
      type: "SUBSCRIPTION_CLOSURE"
    };
    const command = { actorId: harness.admin.id, orderId: harness.orderId, source };
    const firstCapability = await harness.service.prepareReturnInboundInTransaction(
      harness.prisma as never,
      command
    );

    const created = await harness.service.createReturnInboundInTransaction(
      harness.prisma as never,
      command,
      firstCapability
    );
    const replayCapability = await harness.service.prepareReturnInboundInTransaction(
      harness.prisma as never,
      command
    );
    const replay = await harness.service.createReturnInboundInTransaction(
      harness.prisma as never,
      command,
      replayCapability
    );

    expect(replay).toEqual(created);
    expect(created).toMatchObject({
      handoverId: null,
      handoverType: "RETURN_INBOUND",
      orderId: harness.orderId,
      status: "DRAFT",
      vehicleDeliveryId: null
    });
    expect(harness.state.workOrders).toHaveLength(1);
    expect(harness.state.events).toHaveLength(1);
    expect(
      harness.lockQueries
        .filter(({ sql }) => sql.includes(" FOR "))
        .slice(0, 3)
        .map(({ sql }) => sql.match(/FROM "([a-z_]+)"/)?.[1])
    ).toEqual(["subscription_order", "vehicle_handover_work_order", "user"]);
    await expect(
      harness.service.createReturnInboundInTransaction(
        harness.prisma as never,
        command,
        firstCapability
      )
    ).rejects.toMatchObject({
      response: { code: HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID }
    });
  });

  it("attests and mutates RETURN_INBOUND after coordinator locks without taking another lock", async () => {
    const harness = createHandoverWorkOrderHarness();
    const command = {
      actorId: randomUUID(),
      orderId: randomUUID(),
      source: {
        id: randomUUID(),
        key: "normal-expiry:return-inbound:coordinated",
        type: "SUBSCRIPTION_EXPIRY"
      }
    };
    harness.state.order.id = command.orderId;
    harness.state.users.push({
      deletedAt: null,
      id: command.actorId,
      name: "coordinator actor",
      status: UserStatus.ACTIVE
    });
    const sourceCapability = await harness.service.prepareReturnInboundInTransaction(
      harness.prisma as never,
      command
    );
    const workOrderId = "10000000-0000-4000-8000-000000000001";
    const targetRepository = new SubscriptionClosureRepository();
    const foreignRepository = new SubscriptionClosureRepository();
    const foreignIssueSession = targetRepository.createAuthoritySessionInTransaction(
      harness.prisma as never
    );
    const targetRequirement = harness.service.createReturnInboundAuthorityRequirement(
      foreignIssueSession,
      command,
      workOrderId
    );
    const lockQueriesBeforeForeignIssue = [...harness.lockQueries];
    await expect(
      foreignRepository.prepareAuthorityInTransaction(
        harness.prisma as never,
        foreignIssueSession,
        targetRequirement.locks,
        [targetRequirement]
      )
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID" }
    });
    expect(harness.lockQueries).toEqual(lockQueriesBeforeForeignIssue);
    expect(harness.state.workOrders).toHaveLength(0);
    expect(harness.state.events).toHaveLength(0);
    const { proof, session } = await prepareCoordinatorProof(
      harness.prisma as never,
      (authoritySession) =>
        harness.service.createReturnInboundAuthorityRequirement(
          authoritySession,
          command,
          workOrderId
        )
    );
    const lockQueryCount = harness.lockQueries.length;
    const prepared = await harness.service.attestReturnInboundAuthorityInTransaction(
      harness.prisma as never,
      session,
      command,
      sourceCapability,
      proof,
      workOrderId
    );

    await expect(
      harness.service.createPreparedReturnInboundInTransaction(harness.prisma as never, prepared)
    ).resolves.toMatchObject({ orderId: command.orderId, handoverType: "RETURN_INBOUND" });
    expect(harness.lockQueries).toHaveLength(lockQueryCount);
    await expect(
      harness.service.createPreparedReturnInboundInTransaction(harness.prisma as never, prepared)
    ).rejects.toMatchObject({
      response: { code: HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID }
    });
    await expect(
      harness.service.createPreparedReturnInboundInTransaction(
        harness.prisma as never,
        Object.freeze({}) as never
      )
    ).rejects.toMatchObject({
      response: { code: HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID }
    });
  });

  it("updates the exact RETURN_INBOUND schedule only through a governed caller-owned capability", async () => {
    const harness = createHandoverWorkOrderHarness();
    const createCommand = {
      actorId: harness.admin.id,
      orderId: harness.orderId,
      source: {
        id: randomUUID(),
        key: "normal-expiry:return-inbound",
        type: "SUBSCRIPTION_EXPIRY"
      }
    };
    const createCapability = await harness.service.prepareReturnInboundInTransaction(
      harness.prisma as never,
      createCommand
    );
    const created = await harness.service.createReturnInboundInTransaction(
      harness.prisma as never,
      createCommand,
      createCapability
    );
    const updateCommand = {
      actorId: harness.admin.id,
      deliveryLocation: "静安旺旺大厦",
      orderId: harness.orderId,
      scheduledAt: new Date("2026-07-23T02:00:00.000Z"),
      source: {
        id: randomUUID(),
        key: "legacy-prepare-return",
        type: "SUBSCRIPTION_CLOSURE"
      },
      workOrderId: created.id
    };
    const updateCapability = await harness.service.prepareGovernedReturnInboundUpdateInTransaction(
      harness.prisma as never,
      updateCommand
    );

    await expect(
      harness.service.updateGovernedReturnInboundInTransaction(
        harness.prisma as never,
        updateCommand,
        updateCapability
      )
    ).resolves.toMatchObject({
      deliveryLocation: "静安旺旺大厦",
      id: created.id,
      scheduledAt: new Date("2026-07-23T02:00:00.000Z")
    });
    expect(harness.state.workOrders).toHaveLength(1);
    await expect(
      harness.service.updateGovernedReturnInboundInTransaction(
        harness.prisma as never,
        updateCommand,
        updateCapability
      )
    ).rejects.toMatchObject({
      response: { code: HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID }
    });
  });

  it("prepares the governed source before coordinator authority and updates without relocking", async () => {
    const harness = createHandoverWorkOrderHarness();
    const createCommand = {
      actorId: randomUUID(),
      orderId: randomUUID(),
      source: {
        id: randomUUID(),
        key: "normal-expiry:return-inbound:managed",
        type: "SUBSCRIPTION_EXPIRY"
      }
    };
    harness.state.order.id = createCommand.orderId;
    harness.state.users.push({
      deletedAt: null,
      id: createCommand.actorId,
      name: "managed coordinator actor",
      status: UserStatus.ACTIVE
    });
    const createSource = await harness.service.prepareReturnInboundInTransaction(
      harness.prisma as never,
      createCommand
    );
    const createWorkOrderId = "10000000-0000-4000-8000-000000000002";
    const { proof: createProof, session: createSession } = await prepareCoordinatorProof(
      harness.prisma as never,
      (authoritySession) =>
        harness.service.createReturnInboundAuthorityRequirement(
          authoritySession,
          createCommand,
          createWorkOrderId
        )
    );
    const createPrepared = await harness.service.attestReturnInboundAuthorityInTransaction(
      harness.prisma as never,
      createSession,
      createCommand,
      createSource,
      createProof,
      createWorkOrderId
    );
    const created = await harness.service.createPreparedReturnInboundInTransaction(
      harness.prisma as never,
      createPrepared
    );
    const updateCommand = {
      actorId: createCommand.actorId,
      deliveryLocation: "managed center",
      orderId: createCommand.orderId,
      scheduledAt: new Date("2026-07-23T02:00:00.000Z"),
      source: {
        id: randomUUID(),
        key: "legacy-prepare-return",
        type: "SUBSCRIPTION_CLOSURE"
      },
      workOrderId: created.id
    };
    const updateSource =
      await harness.service.prepareGovernedReturnInboundSourceInTransaction(
        harness.prisma as never,
        updateCommand
      );
    const targetRepository = new SubscriptionClosureRepository();
    const foreignRepository = new SubscriptionClosureRepository();
    const foreignIssueSession = targetRepository.createAuthoritySessionInTransaction(
      harness.prisma as never
    );
    const targetRequirement = harness.service.createGovernedReturnInboundAuthorityRequirement(
      foreignIssueSession,
      updateCommand
    );
    const lockQueriesBeforeForeignIssue = [...harness.lockQueries];
    await expect(
      foreignRepository.prepareAuthorityInTransaction(
        harness.prisma as never,
        foreignIssueSession,
        targetRequirement.locks,
        [targetRequirement]
      )
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID" }
    });
    expect(harness.lockQueries).toEqual(lockQueriesBeforeForeignIssue);
    expect(harness.state.workOrders).toHaveLength(1);
    expect(harness.state.events).toHaveLength(1);
    const { proof: updateProof, session: updateSession } = await prepareCoordinatorProof(
      harness.prisma as never,
      (authoritySession) =>
        harness.service.createGovernedReturnInboundAuthorityRequirement(
          authoritySession,
          updateCommand
        )
    );
    const lockQueryCount = harness.lockQueries.length;
    const updatePrepared =
      await harness.service.attestGovernedReturnInboundAuthorityInTransaction(
        harness.prisma as never,
        updateSession,
        updateCommand,
        updateSource,
        updateProof
      );

    await expect(
      harness.service.updatePreparedGovernedReturnInboundInTransaction(
        harness.prisma as never,
        updatePrepared
      )
    ).resolves.toMatchObject({ id: created.id, deliveryLocation: "managed center" });
    expect(harness.lockQueries).toHaveLength(lockQueryCount);
  });

  it("rejects forged and retargeted coordinator attestations before specialist mutation", async () => {
    const harness = createHandoverWorkOrderHarness();
    const actorId = randomUUID();
    const orderId = randomUUID();
    harness.state.order.id = orderId;
    harness.state.users.push({
      deletedAt: null,
      id: actorId,
      name: "proof-negative actor",
      status: UserStatus.ACTIVE
    });
    const command = {
      actorId,
      orderId,
      source: {
        id: randomUUID(),
        key: "normal-expiry:return-inbound:proof-negative",
        type: "SUBSCRIPTION_EXPIRY"
      }
    };
    const sourceCapability = await harness.service.prepareReturnInboundInTransaction(
      harness.prisma as never,
      command
    );
    const { proof: wrongProof, session: wrongSession } = await prepareCoordinatorProof(
      harness.prisma as never,
      (authoritySession) =>
        harness.service.createReturnInboundAuthorityRequirement(
          authoritySession,
          command,
          randomUUID()
        )
    );

    for (const proof of [wrongProof, wrongProof, Object.freeze({})] as const) {
      await expect(
        harness.service.attestReturnInboundAuthorityInTransaction(
          harness.prisma as never,
          wrongSession,
          command,
          sourceCapability,
          proof as never,
          randomUUID()
        )
      ).rejects.toMatchObject({
        response: { code: HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID }
      });
    }
    const foreign = createHandoverWorkOrderHarness();
    const foreignCommand = {
      actorId: randomUUID(),
      orderId: randomUUID(),
      source: { id: randomUUID(), key: "foreign-instance", type: "SUBSCRIPTION_EXPIRY" }
    };
    foreign.state.order.id = foreignCommand.orderId;
    foreign.state.users.push({
      deletedAt: null,
      id: foreignCommand.actorId,
      name: "foreign proof actor",
      status: UserStatus.ACTIVE
    });
    const foreignSource = await foreign.service.prepareReturnInboundInTransaction(
      foreign.prisma as never,
      foreignCommand
    );
    const foreignWorkOrderId = randomUUID();
    const { proof: foreignInstanceProof, session: foreignSession } = await prepareCoordinatorProof(
      foreign.prisma as never,
      (authoritySession) =>
        harness.service.createReturnInboundAuthorityRequirement(
          authoritySession,
          foreignCommand,
          foreignWorkOrderId
        )
    );
    await expect(
      foreign.service.attestReturnInboundAuthorityInTransaction(
        foreign.prisma as never,
        foreignSession,
        foreignCommand,
        foreignSource,
        foreignInstanceProof,
        foreignWorkOrderId
      )
    ).rejects.toMatchObject({
      response: { code: HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID }
    });
    expect(harness.state.workOrders).toHaveLength(0);
    expect(harness.state.events).toHaveLength(0);
    expect(foreign.state.workOrders).toHaveLength(0);
  });

  it("consumes a P0 capability before reading a throwing command source", async () => {
    const harness = createHandoverWorkOrderHarness();
    const source = {
      id: randomUUID(),
      key: "closure:return-inbound:normalization",
      type: "SUBSCRIPTION_CLOSURE"
    };
    const command = { actorId: harness.admin.id, orderId: harness.orderId, source };
    const capability = await harness.service.prepareReturnInboundInTransaction(
      harness.prisma as never,
      command
    );
    const malformed = Object.defineProperty({ ...command }, "source", {
      get() {
        throw new TypeError("throwing specialist source getter");
      }
    }) as typeof command;

    await expect(
      harness.service.createReturnInboundInTransaction(
        harness.prisma as never,
        malformed,
        capability
      )
    ).rejects.toThrow("throwing specialist source getter");
    await expect(
      harness.service.createReturnInboundInTransaction(
        harness.prisma as never,
        command,
        capability
      )
    ).rejects.toMatchObject({
      response: { code: HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID }
    });
    expect(harness.state.workOrders).toHaveLength(0);
    expect(harness.state.events).toHaveLength(0);
  });

  it("rejects forged, foreign-instance, wrong-transaction, and payload-drift P0 capabilities", async () => {
    const harness = createHandoverWorkOrderHarness();
    const foreign = createHandoverWorkOrderHarness();
    const source = {
      id: randomUUID(),
      key: "closure:return-inbound:guarded",
      type: "SUBSCRIPTION_CLOSURE"
    };
    const capability = await harness.service.prepareReturnInboundInTransaction(
      harness.prisma as never,
      { actorId: harness.admin.id, orderId: harness.orderId, source }
    );

    for (const [service, tx, candidate, command] of [
      [harness.service, harness.prisma, Object.freeze({}), { actorId: harness.admin.id, orderId: harness.orderId, source }],
      [foreign.service, harness.prisma, capability, { actorId: harness.admin.id, orderId: harness.orderId, source }],
      [harness.service, foreign.prisma, capability, { actorId: harness.admin.id, orderId: harness.orderId, source }],
      [
        harness.service,
        harness.prisma,
        await harness.service.prepareReturnInboundInTransaction(harness.prisma as never, {
          actorId: harness.admin.id,
          orderId: harness.orderId,
          source
        }),
        { actorId: harness.admin.id, orderId: "different-order", source }
      ]
    ] as const) {
      await expect(
        service.createReturnInboundInTransaction(tx as never, command, candidate as never)
      ).rejects.toMatchObject({
        response: { code: HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID }
      });
    }
    expect(harness.state.workOrders).toHaveLength(0);
  });

  it("creates one active delivery-outbound work order, links Stage 2 handover, and initializes evidence checklist", async () => {
    const harness = createHandoverWorkOrderHarness();

    const workOrder = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);

    expect(workOrder).toMatchObject({
      handoverId: "handover-1",
      handoverType: "DELIVERY_OUTBOUND",
      orderId: harness.orderId,
      status: "DRAFT",
      vehicleDeliveryId: "delivery-1"
    });
    expect(harness.evidenceService.initializeChecklist).toHaveBeenCalledWith(
      harness.orderId,
      "handover-1",
      expect.any(Object)
    );

    await expect(
      harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id)
    ).rejects.toThrow("进行中的交付工单");

    await harness.service.voidOrCancel(workOrder.id, "CANCELLED", harness.admin.id, "重新派单");
    const replacement = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    expect(replacement.id).toBe("work-order-2");
  });

  it("creates or reuses one Journey handover only after authoritative prerequisites pass", async () => {
    const harness = createHandoverWorkOrderHarness();

    const first = await harness.service.createJourneyHandoverInTransaction(
      harness.prisma as never,
      harness.orderId,
      harness.admin.id,
      "journey:journey-1:step:HANDOVER_AND_STAGE2_CREATION:revision:1"
    );
    const duplicate = await harness.service.createJourneyHandoverInTransaction(
      harness.prisma as never,
      harness.orderId,
      harness.admin.id,
      "journey:journey-1:step:HANDOVER_AND_STAGE2_CREATION:revision:1"
    );

    expect(duplicate.id).toBe(first.id);
    expect(harness.state.workOrders).toHaveLength(1);
    expect(first).toMatchObject({
      handoverId: "handover-1",
      metadata: expect.objectContaining({
        journeySourceKey:
          "journey:journey-1:step:HANDOVER_AND_STAGE2_CREATION:revision:1"
      }),
      vehicleDeliveryId: "delivery-1"
    });
    expect(
      harness.financeService.evaluateInitialBillSettlement
    ).toHaveBeenCalledTimes(2);
  });

  it("does not create a Journey handover for partial payment or incomplete delivery prerequisites", async () => {
    const partial = createHandoverWorkOrderHarness();
    partial.financeService.evaluateInitialBillSettlement.mockResolvedValueOnce({
      paid: false,
      remainingAmount: 100n
    });
    await expect(
      partial.service.createJourneyHandoverInTransaction(
        partial.prisma as never,
        partial.orderId,
        partial.admin.id,
        "journey:journey-1:handover"
      )
    ).rejects.toThrow();
    expect(partial.state.workOrders).toHaveLength(0);

    for (const mutate of [
      (harness: ReturnType<typeof createHandoverWorkOrderHarness>) => {
        harness.state.order.contract.status = ContractStatus.SIGNED;
      },
      (harness: ReturnType<typeof createHandoverWorkOrderHarness>) => {
        harness.state.order.vehicle.insurancePolicies = [];
      }
    ]) {
      const harness = createHandoverWorkOrderHarness();
      mutate(harness);
      await expect(
        harness.service.createJourneyHandoverInTransaction(
          harness.prisma as never,
          harness.orderId,
          harness.admin.id,
          "journey:journey-1:handover"
        )
      ).rejects.toThrow();
      expect(harness.state.workOrders).toHaveLength(0);
    }
  });

  it("creates the Journey handover before an order-level vehicle inspection exists", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.vehicleInspection = null;

    const workOrder = await harness.service.createJourneyHandoverInTransaction(
      harness.prisma as never,
      harness.orderId,
      harness.admin.id,
      "journey:journey-1:handover"
    );

    expect(workOrder).toMatchObject({
      handoverId: "handover-1",
      orderId: harness.orderId,
      status: "DRAFT",
      vehicleDeliveryId: "delivery-1"
    });
    expect(harness.state.workOrders).toHaveLength(1);
  });

  it("creates the Stage 2 delivery record in the same Journey transaction when absent", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.prisma.vehicleDelivery.findUnique.mockResolvedValueOnce(null as never);

    const workOrder = await harness.service.createJourneyHandoverInTransaction(
      harness.prisma as never,
      harness.orderId,
      harness.admin.id,
      "journey:journey-1:handover"
    );

    expect(harness.prisma.vehicleDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId: "customer-1",
        deliveryStatus: "PENDING",
        orderId: harness.orderId,
        vehicleId: "vehicle-1"
      })
    });
    expect(harness.prisma.subscriptionOrder.update).toHaveBeenCalledWith({
      data: {
        orderStatus: "PENDING_DELIVERY",
        updatedBy: harness.admin.id
      },
      where: { id: harness.orderId }
    });
    expect(workOrder.vehicleDeliveryId).toBe("delivery-1");
  });

  it("maps serializable create conflicts to a retryable domain conflict", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.prisma.$transaction.mockRejectedValueOnce({ code: "P2034" });

    await expect(
      harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.handoverService.getOrCreateDraftHandover).not.toHaveBeenCalled();
    expect(harness.evidenceService.initializeChecklist).not.toHaveBeenCalled();
  });

  it("assigns internal and external operators without storing plaintext external tokens", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);

    const internal = await harness.service.assignInternalOperator(draft.id, harness.internalUser.id, harness.admin.id);
    expect(internal).toMatchObject({
      assignedInternalUserId: harness.internalUser.id,
      operatorType: "INTERNAL",
      status: "ASSIGNED"
    });

    const external = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        organization: "外包交付合作方",
        phone: "13900001111"
      },
      harness.admin.id
    );

    expect(external.accessToken).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(harness.state.workOrders[0]!.accessTokenHash).toBeTruthy();
    expect(harness.state.workOrders[0]!.accessTokenHash).not.toBe(external.accessToken);
    expect(JSON.stringify(harness.state.workOrders[0]!)).not.toContain(external.accessToken);
  });

  it("enqueues one durable notification from the persisted external assignment event", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(
      harness.orderId,
      "DELIVERY_OUTBOUND",
      harness.admin.id
    );

    await harness.service.assignExternalOperator(
      draft.id,
      { name: "External field operator", phone: "13900001111" },
      harness.admin.id
    );

    const assignmentEvent = harness.state.events.find(
      (event) =>
        event.eventType === VehicleHandoverEventType.EXTERNAL_OPERATOR_ASSIGNED
    );
    expect(assignmentEvent?.id).toBeTruthy();
    expect(harness.workflowRepository.enqueue).toHaveBeenCalledWith(
      harness.prisma,
      expect.objectContaining({
        handoverId: draft.handoverId,
        idempotencyKey: `field-assigned:${draft.id}:${assignmentEvent!.id}`,
        jobType:
          VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED,
        maxAttempts: 6,
        payload: { assignmentEventId: assignmentEvent!.id },
        workOrderId: draft.id
      })
    );
    expect(harness.state.workflowJobs).toHaveLength(1);
  });

  it("rolls back the external assignment when its audit event cannot be persisted", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(
      harness.orderId,
      "DELIVERY_OUTBOUND",
      harness.admin.id
    );
    harness.prisma.vehicleHandoverEvent.create.mockRejectedValueOnce(
      new Error("audit unavailable")
    );

    await expect(
      harness.service.assignExternalOperator(
        draft.id,
        { name: "External field operator", phone: "13900001111" },
        harness.admin.id
      )
    ).rejects.toThrow("audit unavailable");

    expect(harness.state.workOrders[0]).toMatchObject({
      externalOperatorPhone: null,
      operatorType: "INTERNAL",
      status: "DRAFT"
    });
    expect(harness.state.workflowJobs).toEqual([]);
  });

  it("rolls back the external assignment and event when notification enqueue fails", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(
      harness.orderId,
      "DELIVERY_OUTBOUND",
      harness.admin.id
    );
    const eventCount = harness.state.events.length;
    harness.workflowRepository.enqueue.mockRejectedValueOnce(
      new Error("workflow enqueue unavailable")
    );

    await expect(
      harness.service.assignExternalOperator(
        draft.id,
        { name: "External field operator", phone: "13900001111" },
        harness.admin.id
      )
    ).rejects.toThrow("workflow enqueue unavailable");

    expect(harness.state.workOrders[0]).toMatchObject({
      externalOperatorPhone: null,
      operatorType: "INTERNAL",
      status: "DRAFT"
    });
    expect(harness.state.events).toHaveLength(eventCount);
    expect(harness.state.workflowJobs).toEqual([]);
  });

  it("verifies external access, updates access timestamps, and returns only a limited masked task view", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      harness.admin.id
    );

    const view = await harness.service.verifyExternalAccess(assigned.accessToken);

    expect(view).toMatchObject({
      id: draft.id,
      orderNo: "ORD202607210001",
      status: "ASSIGNED"
    });
    expect(view.customer.mobileMasked).toBe("186****0212");
    expect(view.vehicle.vinSuffix).toBe("888888");
    expect(harness.state.workOrders[0]!.firstAccessedAt).toBeInstanceOf(Date);
    expect(harness.state.workOrders[0]!.lastAccessedAt).toBeInstanceOf(Date);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("TEST_ID_CARD_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("18616570212");
    expect(serialized).not.toContain("monthlyFeeAmount");
    expect(serialized).not.toContain("contractId");
    expect(serialized).not.toContain("signUrl");
  });

  it("rejects revoked and expired external tokens", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      harness.admin.id
    );

    await harness.service.revokeExternalAccess(draft.id, harness.admin.id);
    await expect(harness.service.verifyExternalAccess(assigned.accessToken)).rejects.toThrow(UnauthorizedException);

    const expiredHarness = createHandoverWorkOrderHarness();
    const expiredDraft = await expiredHarness.service.createDraft(
      expiredHarness.orderId,
      "DELIVERY_OUTBOUND",
      expiredHarness.admin.id
    );
    const expired = await expiredHarness.service.assignExternalOperator(
      expiredDraft.id,
      {
        expiresAt: new Date("2026-07-20T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      expiredHarness.admin.id
    );
    await expect(expiredHarness.service.verifyExternalAccess(expired.accessToken)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects an external token when it is revoked or reassigned during access refresh", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      { name: "External field operator", phone: "13900001111" },
      harness.admin.id
    );
    harness.prisma.vehicleHandoverWorkOrder.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.verifyExternalAccess(assigned.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("rejects an external token revoked after the conditional access refresh", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      { name: "External field operator", phone: "13900001111" },
      harness.admin.id
    );
    harness.prisma.vehicleHandoverWorkOrder.findUnique.mockImplementationOnce(async () => {
      Object.assign(harness.state.workOrders[0]!, {
        accessTokenRevokedAt: harness.now,
        reviewVersion: 2
      });
      return harness.state.workOrders[0]!;
    });

    await expect(harness.service.verifyExternalAccess(assigned.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("lists active tasks newest-first before ended history regardless of legacy token state", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        deliveryLocation: "上海市测试交付点",
        externalOperatorName: "现场交付员",
        externalOperatorPhone: "13800000000",
        fieldOperatorName: "现场交付员",
        fieldOperatorPhone: "13800000000",
        id: "work-order-visible-late",
        operatorType: "EXTERNAL",
        createdAt: new Date("2026-07-23T01:00:00.000Z"),
        scheduledAt: new Date("2026-07-23T02:00:00.000Z"),
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        deliveryLocation: "上海市测试交付点",
        externalOperatorName: "现场交付员",
        externalOperatorPhone: "13800000000",
        fieldOperatorName: "现场交付员",
        fieldOperatorPhone: "13800000000",
        id: "work-order-visible-early",
        operatorType: "EXTERNAL",
        createdAt: new Date("2026-07-22T01:00:00.000Z"),
        scheduledAt: new Date("2026-07-22T02:00:00.000Z"),
        status: "FIELD_IN_PROGRESS"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13900000000",
        fieldOperatorPhone: "13900000000",
        id: "work-order-other-phone",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-20T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        fieldOperatorPhone: "13800000000",
        id: "work-order-expired",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        accessTokenRevokedAt: harness.now,
        externalOperatorPhone: "13800000000",
        fieldOperatorPhone: "13800000000",
        id: "work-order-revoked",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        fieldOperatorPhone: "13800000000",
        id: "work-order-completed",
        operatorType: "EXTERNAL",
        status: "FIELD_COMPLETED",
        updatedAt: new Date("2026-07-24T08:00:00.000Z")
      }
    );

    const list = await harness.service.listFieldAccessibleWorkOrders("+86 138-0000-0000");

    expect(list.map((item) => item.id)).toEqual([
      "work-order-visible-late",
      "work-order-visible-early",
      "work-order-expired",
      "work-order-revoked",
      "work-order-completed"
    ]);
    expect(list[0]).toMatchObject({
      customer: {
        mobileMasked: "186****0212"
      },
      evidenceProgress: {
        uploaded: 1
      },
      orderNo: "ORD202607210001",
      vehicle: {
        vinSuffix: "888888"
      }
    });

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("TEST_ID_CARD_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("18616570212");
    expect(serialized).not.toContain("monthlyFeeAmount");
    expect(serialized).not.toContain("contractId");
    expect(serialized).not.toContain("signUrl");
    expect(serialized).not.toContain("oss/internal/evidence.jpg");
  });

  it("keeps terminal tasks as history but does not end Stage 2 before authoritative archive", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13900000000",
        fieldOperatorPhone: "13900000000",
        id: "work-order-other-phone",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        fieldOperatorPhone: "13800000000",
        id: "work-order-cancelled",
        operatorType: "EXTERNAL",
        status: "CANCELLED",
        updatedAt: new Date("2026-07-23T08:00:00.000Z")
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        fieldOperatorPhone: "13800000000",
        id: "work-order-ops-reviewed",
        operatorType: "EXTERNAL",
        status: "OPS_REVIEWED",
        updatedAt: new Date("2026-07-24T08:00:00.000Z")
      },
      {
        ...baseWorkOrder(harness),
        externalOperatorPhone: "13800000000",
        fieldOperatorPhone: "13800000000",
        id: "work-order-failed",
        operatorType: "EXTERNAL",
        status: "FAILED",
        updatedAt: new Date("2026-07-22T08:00:00.000Z")
      },
      {
        ...baseWorkOrder(harness),
        externalOperatorPhone: "13800000000",
        fieldOperatorPhone: "13800000000",
        id: "work-order-voided",
        operatorType: "EXTERNAL",
        status: "VOIDED",
        updatedAt: new Date("2026-07-21T08:00:00.000Z")
      },
      {
        ...baseWorkOrder(harness),
        externalOperatorPhone: "13800000000",
        fieldOperatorPhone: "13800000000",
        id: "work-order-field-completed",
        operatorType: "EXTERNAL",
        status: "FIELD_COMPLETED",
        updatedAt: new Date("2026-07-20T08:00:00.000Z")
      }
    );

    await expect(harness.service.listFieldAccessibleWorkOrders("13800000000")).resolves.toEqual([
      expect.objectContaining({ id: "work-order-field-completed", status: "FIELD_COMPLETED", taskGroup: "ACTIVE" }),
      expect.objectContaining({ id: "work-order-ops-reviewed", status: "OPS_REVIEWED", taskGroup: "ACTIVE" }),
      expect.objectContaining({ id: "work-order-cancelled", status: "CANCELLED", taskGroup: "ENDED" }),
      expect.objectContaining({ id: "work-order-failed", status: "FAILED", taskGroup: "ENDED" }),
      expect.objectContaining({ id: "work-order-voided", status: "VOIDED", taskGroup: "ENDED" })
    ]);
    await expect(
      harness.service.getFieldAccessibleWorkOrder("work-order-ops-reviewed", "13800000000")
    ).resolves.toMatchObject({
      displayStatus: "HANDOVER_PDF_GENERATING",
      id: "work-order-ops-reviewed",
      status: "OPS_REVIEWED",
      taskGroup: "ACTIVE"
    });
  });

  it("projects a historically customer-confirmed but fully archived Stage 2 task as completed", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      assignedInternalUserId: harness.internalUser.id,
      fieldOperatorName: "内部交付员",
      fieldOperatorPhone: harness.internalUser.mobile,
      id: "work-order-archived-stage2",
      operatorType: "INTERNAL",
      status: "CUSTOMER_CONFIRMED"
    });
    Object.assign(harness.prisma, {
      contractESignTask: {
        findFirst: vi.fn(async ({ where }: { where: { taskStatus?: { in?: string[] } } }) =>
          where.taskStatus?.in?.includes("COMPLETED")
            ? {
                id: "stage2-task-archived",
                signers: [
                  {
                    signedAt: new Date("2026-08-16T08:05:00.000Z"),
                    signerStatus: "SIGNED",
                    slotId: "STAGE2_HANDOVER_CUSTOMER"
                  },
                  {
                    signedAt: new Date("2026-08-16T08:06:00.000Z"),
                    signerStatus: "SIGNED",
                    slotId: "STAGE2_HANDOVER_PLATFORM"
                  }
                ],
                taskStatus: "COMPLETED"
              }
            : null
        )
      },
      vehicleDeliveryHandover: {
        findFirst: vi.fn(async () => ({
          archiveStatus: "ARCHIVED",
          archivedAt: new Date("2026-08-16T08:10:00.000Z"),
          handoverContractId: "handover-contract-archived",
          handoverESignTaskId: "stage2-task-archived",
          id: "handover-1",
          signedDocumentFileId: "signed-file-archived",
          signedPdfHash: "a".repeat(64),
          sourceDocumentFileId: "source-file-archived",
          status: "ARCHIVED",
          updatedAt: new Date("2026-08-16T08:10:00.000Z")
        }))
      }
    });

    const [item] = await harness.service.listFieldAccessibleWorkOrders(
      harness.internalUser.mobile
    );

    expect(item).toMatchObject({
      completedAt: "2026-08-16T08:10:00.000Z",
      displayStatus: "COMPLETED",
      displayStatusLabel: "已完成",
      status: "CUSTOMER_CONFIRMED",
      taskGroup: "ENDED"
    });
    expect(JSON.stringify(item)).not.toMatch(
      /provider|signUrl|transactionId|signedPdfHash|signedDocumentFileId/i
    );
  });

  it("denies stale internal snapshots after the assigned user is disabled or deleted", async () => {
    const harness = createHandoverWorkOrderHarness();
    for (const [id, status, deletedAt] of [
      ["user-disabled", "DISABLED", null],
      ["user-deleted", "ACTIVE", harness.now]
    ] as const) {
      harness.state.users.push({
        deletedAt,
        id,
        mobile: "13800000000",
        name: id,
        status
      });
      harness.state.workOrders.push({
        ...baseWorkOrder(harness),
        assignedInternalUserId: id,
        fieldOperatorName: id,
        fieldOperatorPhone: "13800000000",
        id: `work-order-${id}`,
        operatorType: "INTERNAL",
        status: "ASSIGNED"
      });
    }

    await expect(
      harness.service.listFieldAccessibleWorkOrders("13800000000")
    ).resolves.toEqual([]);
    await expect(
      harness.service.getFieldAccessibleWorkOrder(
        "work-order-user-disabled",
        "13800000000"
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      harness.service.getFieldAccessibleWorkOrder(
        "work-order-user-deleted",
        "13800000000"
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("projects safe read-only workflow jobs in Admin work-order responses", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(baseWorkOrder(harness));
    harness.state.workflowJobs.push({
      attemptCount: 2,
      availableAt: new Date("2026-08-01T06:10:00.000Z"),
      createdAt: new Date("2026-08-01T06:00:00.000Z"),
      id: "workflow-job-current",
      idempotencyKey: "field-assigned:secret-task:1",
      jobStatus: "PENDING",
      jobType: "NOTIFY_FIELD_HANDOVER_ASSIGNED",
      lastErrorCode: "SMS_PROVIDER_NOT_CONFIGURED",
      lastErrorMessage: "private provider detail",
      maxAttempts: 6,
      payload: { phone: "13900001111", providerTransactionId: "PRIVATE-H2" },
      updatedAt: new Date("2026-08-01T06:05:00.000Z"),
      workOrderId: "work-order-1"
    });

    const [summary] = await harness.service.listByOrder(harness.orderId);

    expect(summary).toBeDefined();
    if (!summary) {
      throw new Error("expected projected work order");
    }
    expect(summary.workflowJobs).toEqual([
      {
        attemptCount: 2,
        availableAt: "2026-08-01T06:10:00.000Z",
        createdAt: "2026-08-01T06:00:00.000Z",
        id: "workflow-job-current",
        jobStatus: "PENDING",
        jobType: "NOTIFY_FIELD_HANDOVER_ASSIGNED",
        lastErrorCode: "SMS_PROVIDER_NOT_CONFIGURED",
        maxAttempts: 6,
        updatedAt: "2026-08-01T06:05:00.000Z"
      }
    ]);
    const projectedJob = summary.workflowJobs[0];
    expect(projectedJob).toBeDefined();
    if (!projectedJob) {
      throw new Error("expected projected workflow job");
    }
    expect(Object.keys(projectedJob).join("|")).not.toMatch(
      /phone|payload|provider|message|objectKey|token|url/i
    );
    expect(JSON.stringify(projectedJob)).not.toMatch(
      /13900001111|PRIVATE-H2|private provider detail|secret-task/i
    );
  });

  it("projects authenticated Field task receipt and falls back to historical view audits", async () => {
    const harness = createHandoverWorkOrderHarness();
    const firstOpenedAt = new Date("2026-08-02T07:52:52.000Z");
    const lastOpenedAt = new Date("2026-08-02T08:03:46.000Z");
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      firstAccessedAt: firstOpenedAt,
      lastAccessedAt: lastOpenedAt
    });

    const [persistedSummary] = await harness.service.listByOrder(harness.orderId);
    expect(persistedSummary?.fieldReceipt).toEqual({
      firstOpenedAt,
      lastOpenedAt,
      status: "OPENED"
    });

    harness.state.workOrders[0]!.firstAccessedAt = null;
    harness.state.workOrders[0]!.lastAccessedAt = null;
    harness.state.fieldOperatorAuditLogs.push(
      {
        createdAt: firstOpenedAt,
        eventType: FieldOperatorAuditEventType.TASK_VIEWED,
        workOrderId: "work-order-1"
      },
      {
        createdAt: lastOpenedAt,
        eventType: FieldOperatorAuditEventType.TASK_VIEWED,
        workOrderId: "work-order-1"
      }
    );

    const [historicalSummary] = await harness.service.listByOrder(harness.orderId);
    expect(historicalSummary?.fieldReceipt).toEqual({
      firstOpenedAt,
      lastOpenedAt,
      status: "OPENED"
    });
  });

  it("returns safe field task detail only for the assigned phone", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.evidenceService.setChecklist({
      blockingReasons: [],
      items: [
        {
          allowedMediaTypes: ["VIDEO"],
          evidenceType: "WALKAROUND_VIDEO",
          fileRequired: true,
          files: [
            {
              file: {
                id: "file-1",
                mimeType: "video/quicktime",
                objectKey: "oss/internal/walkaround.mov",
                originalName: "walkaround.mov",
                sizeBytes: 1024
              },
              fileId: "file-1",
              id: "evidence-file-1",
              mediaType: "VIDEO",
              metadata: {
                detectedCodec: "h264",
                sourceSha256: `sha256:${"a".repeat(64)}`,
                videoBitRateBps: 8_000_000,
                videoFrameRate: 30,
                videoHeightPx: 1080,
                videoQualityStatus: "PASSED",
                videoWidthPx: 1920
              },
              objectKey: "oss/internal/walkaround.mov",
              uploadedAt: harness.now,
              uploadedBy: { id: "user-admin" }
            }
          ],
          id: "evidence-item-1",
          isConditional: false,
          isRequired: true,
          orderId: harness.orderId,
          requirementLevel: "REQUIRED",
          reviewStatus: "PENDING",
          status: "UPLOADED",
          title: "车辆车头正面"
        }
      ],
      ready: false
    });
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      ...explicitHandoverFacts(),
      deliveryLocation: "上海市测试交付点",
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      fieldNotes: "客户现场确认车辆外观",
      fuelLevelText: null,
      handoverMileageKm: 28500,
      id: "work-order-visible",
      noVisibleDamageDeclared: true,
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    const detail = await harness.service.getFieldAccessibleWorkOrder("work-order-visible", "13800000000");

    expect(detail).toMatchObject({
      fieldFacts: {
        energyLevelText: "80%",
        handoverMileageKm: 28500,
        noVisibleDamageDeclared: true
      },
      id: "work-order-visible",
      orderNo: "ORD202607210001"
    });
    expect(detail.evidenceChecklist.items[0]).toMatchObject({
      fileCount: 1,
      files: [
        {
          file: {
            id: "file-1",
            mimeType: "video/quicktime",
            originalName: "walkaround.mov",
            sizeBytes: 1024
          },
          mediaType: "VIDEO",
          metadata: {
            videoHeightPx: 1080,
            videoQualityStatus: "PASSED",
            videoWidthPx: 1920
          }
        }
      ]
    });
    expect(JSON.stringify(detail)).not.toMatch(/oss\/internal|sourceSha256|detectedCodec/);

    await expect(
      harness.service.getFieldAccessibleWorkOrder("work-order-visible", "13900000000")
    ).rejects.toThrow(UnauthorizedException);
  });

  it("allows a field session to start and update only its assigned work order", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "ASSIGNED"
    });

    const started = await harness.service.startFieldAccessibleWorkOrder(
      "work-order-visible",
      "13800000000",
      "field-session-1"
    );
    const updated = await harness.service.updateFieldAccessibleFacts(
      "work-order-visible",
      "13800000000",
      {
        accessoryItems: explicitAccessoryItems(),
        damageDeclared: false,
        energyLevelText: "80%",
        handoverMileageKm: 28600,
        keyState: "COMPLETE",
        noVisibleDamageDeclared: true,
        primaryKeyCount: 1,
        registrationDocumentState: "HANDED_OVER",
        spareKeyCount: 1,
        vehicleConditionConfirmed: true
      },
      "field-session-1"
    );

    expect(started).toMatchObject({ status: "FIELD_IN_PROGRESS" });
    expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
      harness.prisma,
      "vehicle-1",
      VehicleAvailabilityPurpose.DELIVERY,
      expect.any(Date)
    );
    expect(updated).toMatchObject({
      accessoryItems: explicitAccessoryItems(),
      handoverFactHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      handoverFactRevision: 1,
      energyLevelText: "80%",
      handoverMileageKm: 28600,
      noVisibleDamageDeclared: true
    });
    await harness.service.updateFieldAccessibleFacts(
      "work-order-visible",
      "13800000000",
      { handoverMileageKm: 28700 },
      "field-session-1"
    );
    expect(harness.state.workOrders[0]!).toMatchObject({
      energyLevelText: "80%",
      handoverMileageKm: 28700
    });
    await expect(
      harness.service.updateFieldAccessibleFacts("work-order-visible", "13900000000", { handoverMileageKm: 1 })
    ).rejects.toThrow(UnauthorizedException);
  });

  it.each([
    {
      invoke: (harness: ReturnType<typeof createHandoverWorkOrderHarness>) =>
        harness.service.startFieldAccessibleWorkOrder(
          "work-order-visible",
          "13800000000",
          "field-session-1"
        ),
      label: "field-session start",
      status: "ASSIGNED"
    },
    {
      invoke: (harness: ReturnType<typeof createHandoverWorkOrderHarness>) =>
        harness.service.startFieldWork("work-order-visible", harness.admin.id),
      label: "direct field-work start",
      status: "ASSIGNED"
    },
    {
      invoke: (harness: ReturnType<typeof createHandoverWorkOrderHarness>) =>
        harness.service.updateFieldFacts(
          "work-order-visible",
          { handoverMileageKm: 100 },
          harness.admin.id
        ),
      label: "draft field-facts start",
      status: "DRAFT"
    }
  ])("blocks $label before handover state writes", async ({ invoke, status }) => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status
    });
    harness.assetOperationsService.assertVehicleAvailable.mockRejectedValueOnce(
      new Error("VEHICLE_OPERATIONALLY_RESTRICTED")
    );
    harness.prisma.vehicleHandoverWorkOrder.updateMany.mockClear();

    await expect(invoke(harness)).rejects.toThrow("VEHICLE_OPERATIONALLY_RESTRICTED");

    expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
      harness.prisma,
      "vehicle-1",
      VehicleAvailabilityPurpose.DELIVERY,
      expect.any(Date)
    );
    expect(harness.prisma.$queryRaw).toHaveBeenCalled();
    expect(harness.prisma.vehicleHandoverWorkOrder.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      invoke: (harness: ReturnType<typeof createHandoverWorkOrderHarness>) =>
        harness.service.startFieldAccessibleWorkOrder(
          "work-order-visible",
          "13800000000",
          "field-session-1"
        ),
      status: "ASSIGNED"
    },
    {
      invoke: (harness: ReturnType<typeof createHandoverWorkOrderHarness>) =>
        harness.service.startFieldWork("work-order-visible", harness.admin.id),
      status: "ASSIGNED"
    },
    {
      invoke: (harness: ReturnType<typeof createHandoverWorkOrderHarness>) =>
        harness.service.updateFieldFacts(
          "work-order-visible",
          { handoverMileageKm: 100 },
          harness.admin.id
        ),
      status: "DRAFT"
    }
  ])("uses READ COMMITTED only for guarded field-work transitions", async ({ invoke, status }) => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status
    });

    await invoke(harness);

    expect(harness.prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted"
    });
  });

  it("keeps non-start field-fact updates SERIALIZABLE", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      id: "work-order-visible",
      status: "FIELD_IN_PROGRESS"
    });

    await harness.service.updateFieldFacts(
      "work-order-visible",
      { handoverMileageKm: 100 },
      harness.admin.id
    );

    expect(harness.prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "Serializable"
    });
  });

  it("atomically uploads and attaches evidence through field-session ownership without exposing storage fields", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    const attached = await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("front.jpg", "image/jpeg")],
      {},
      "field-session-1"
    );

    expect(JSON.stringify(attached)).not.toContain("delivery-evidence/work-order-visible");
    expect(harness.storageService.putDeliveryEvidenceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: "front.jpg",
        workOrderId: "work-order-visible"
      })
    );
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceType: "VEHICLE_FRONT",
        mediaType: "PHOTO"
      })
    );
    expect(harness.storageService.putDeliveryEvidenceDerivativeFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "PHOTO_PREVIEW",
        workOrderId: "work-order-visible"
      })
    );
    expect(harness.evidenceService.attachEvidenceFile).toHaveBeenCalledWith(
      "evidence-item-owned",
      "file-1",
      "PHOTO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({
        photoPreviewFileId: "file-2",
        processingStatus: "READY",
        sourceSha256: expect.stringMatching(/^sha256:/)
      })
    );
    expect(attached).toMatchObject({ id: "evidence-item-owned", status: "UPLOADED" });
    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13900000000",
        "evidence-item-owned",
        [uploadFile("unauthorized.jpg", "image/jpeg")],
        {},
        "other-field-session"
      )
    ).rejects.toThrow(UnauthorizedException);
  });

  it("attaches a prepared multipart source without uploading the full video again", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      id: "work-order-visible",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "walkaround-item",
      orderId: harness.orderId
    });
    harness.evidenceService.validateEvidenceFileMutation.mockResolvedValueOnce({
      allowsMultiple: false,
      currentFileCount: 0,
      evidenceType: "WALKAROUND_VIDEO",
      itemId: "walkaround-item"
    });
    const prepared = (await harness.artifactService.prepareUpload({
      evidenceType: "WALKAROUND_VIDEO",
      file: { mimetype: "video/quicktime", originalname: "IMG_0284.MOV", size: 1024 },
      mediaType: "VIDEO"
    })) as PreparedDeliveryEvidenceArtifacts;

    const attached = await harness.service.attachPreparedFieldVideoFromStoredSource({
      actorId: "field-session-1",
      detectedMimeType: "video/quicktime",
      evidenceItemId: "walkaround-item",
      originalName: "IMG_0284.MOV",
      partCount: 28,
      prepared,
      sizeBytes: 1024,
      storedSource: {
        bucket: "oss:video-bucket",
        objectKey: "oss:field-video/upload-sessions/session/source"
      },
      uploadLeaseOwner: "worker-lease-1",
      uploadSessionId: "upload-session-1",
      workOrderId: "work-order-visible"
    });

    expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
    expect(harness.storageService.putDeliveryEvidenceFileFromPath).not.toHaveBeenCalled();
    expect(harness.storageService.putDeliveryEvidenceDerivativeFromPath).toHaveBeenCalledOnce();
    expect(harness.evidenceService.attachEvidenceFile).toHaveBeenCalledWith(
      "walkaround-item",
      "file-1",
      "VIDEO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({
        processingStatus: "READY",
        videoFrameFileIds: ["file-2"]
      })
    );
    expect(harness.prisma.fieldEvidenceVideoUploadSession.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "COMPLETED" }),
      where: {
        id: "upload-session-1",
        leaseOwner: "worker-lease-1",
        status: "PROCESSING"
      }
    });
    expect(harness.state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "FIELD_VIDEO_UPLOAD_COMPLETED" })
      ])
    );
    expect(attached).toMatchObject({ id: "walkaround-item", status: "UPLOADED" });
  });

  it("returns an actionable 422 before storing a low-resolution walkaround", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "walkaround-item",
      orderId: harness.orderId
    });
    harness.evidenceService.validateEvidenceFileMutation.mockResolvedValueOnce({
      allowsMultiple: false,
      currentFileCount: 0,
      evidenceType: "WALKAROUND_VIDEO",
      itemId: "walkaround-item"
    });
    harness.artifactService.prepareUpload.mockRejectedValueOnce(
      new DeliveryEvidenceVideoQualityError(480, 360)
    );

    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "walkaround-item",
        [uploadFile("low.mov", "video/quicktime")],
        {},
        "field-session-1"
      )
    ).rejects.toMatchObject({
      response: {
        message: expect.stringContaining("检测到 480×360")
      },
      status: 422
    });
    expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
    expect(harness.storageService.putDeliveryEvidenceFileFromPath).not.toHaveBeenCalled();
    expect(harness.evidenceService.attachEvidenceFile).not.toHaveBeenCalled();
  });

  it("uploads and replaces singleton evidence through one field operation", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    const result = await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("front-replacement.jpg", "image/jpeg")],
      { replaceEvidenceFileId: "evidence-file-original" },
      "field-session-1"
    );

    expect(harness.evidenceService.replaceEvidenceFile).toHaveBeenCalledWith(
      "evidence-item-owned",
      "evidence-file-original",
      "file-1",
      "PHOTO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({ processingStatus: "READY" })
    );
    expect(result).toMatchObject({ id: "evidence-item-owned", status: "UPLOADED" });
    expect(harness.state.events).toContainEqual(expect.objectContaining({
      eventType: "EVIDENCE_FILE_REPLACED"
    }));
  });

  it("uses the disk-backed storage path for field evidence uploads", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [{
        mimetype: "video/mp4",
        originalname: "walkaround.mp4",
        path: "C:/tmp/nonexistent-multer-upload.tmp",
        size: 1024
      }],
      {},
      "field-session-1"
    );

    expect(harness.storageService.putDeliveryEvidenceFileFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "C:/tmp/nonexistent-multer-upload.tmp",
        sizeBytes: 1024
      })
    );
    expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
  });

  it("enforces 10 MiB photo and 300 MiB video upload limits before storage", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("photo-at-limit.jpg", "image/jpeg", 10 * 1024 * 1024)],
      {},
      "field-session-1"
    );
    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("video-at-limit.mp4", "video/mp4", 300 * 1024 * 1024)],
      {},
      "field-session-1"
    );
    harness.storageService.putDeliveryEvidenceFile.mockClear();
    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("photo-over-limit.jpg", "image/jpeg", 10 * 1024 * 1024 + 1)],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("图片不能超过 10MB");
    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("video-over-limit.mp4", "video/mp4", 300 * 1024 * 1024 + 1)],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("视频不能超过 300MB");
    expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
  });

  it("accepts iPhone HEIC and MOV files when the browser omits MIME types", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("vehicle-front.heic", "")],
      {},
      "field-session-1"
    );
    await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
      "work-order-visible",
      "13800000000",
      "evidence-item-owned",
      [uploadFile("vehicle-walkaround.mov", "")],
      {},
      "field-session-1"
    );

    expect(harness.storageService.putDeliveryEvidenceFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ contentType: "image/heic", originalName: "vehicle-front.heic" })
    );
    expect(harness.storageService.putDeliveryEvidenceFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ contentType: "video/quicktime", originalName: "vehicle-walkaround.mov" })
    );
    expect(harness.evidenceService.attachEvidenceFile).toHaveBeenNthCalledWith(
      1,
      "evidence-item-owned",
      "file-1",
      "PHOTO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({ photoPreviewFileId: "file-2" })
    );
    expect(harness.evidenceService.attachEvidenceFile).toHaveBeenNthCalledWith(
      2,
      "evidence-item-owned",
      "file-3",
      "VIDEO",
      undefined,
      expect.any(Object),
      "field-session-1",
      expect.objectContaining({ videoFrameFileIds: ["file-4"] })
    );
  });

  it("rolls back the upload relation and removes only the new object when audit persistence fails", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });
    harness.prisma.vehicleHandoverEvent.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("front.jpg", "image/jpeg")],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("audit unavailable");

    expect(harness.state.fileObjects).toEqual([]);
    expect(harness.state.workOrders[0]?.reviewVersion).toBe(0);
    expect(harness.storageService.deleteObject).toHaveBeenCalledWith(
      "application-materials",
      expect.stringContaining("delivery-evidence/work-order-visible")
    );
  });

  it("rejects a stale concurrent upload before linking the stored object", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });
    harness.prisma.vehicleHandoverWorkOrder.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("front.jpg", "image/jpeg")],
        {},
        "field-session-1"
      )
    ).rejects.toThrow(ConflictException);

    expect(harness.evidenceService.attachEvidenceFile).not.toHaveBeenCalled();
    expect(harness.state.fileObjects).toEqual([]);
    expect(harness.storageService.deleteObject).toHaveBeenCalledTimes(2);
  });

  it("requires evidence files to remain ACTIVE before previewing or downloading them", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      id: "work-order-visible",
      status: "FIELD_IN_PROGRESS"
    });

    await expect(
      harness.service.previewEvidenceFile("work-order-visible", "evidence-file-removed")
    ).rejects.toThrow();

    expect(harness.prisma.vehicleDeliveryEvidenceFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "evidence-file-removed",
          lifecycleStatus: "ACTIVE"
        })
      })
    );
  });

  it("repairs historical evidence artifacts once and verifies derivative file objects before treating them as ready", async () => {
    const harness = createHandoverWorkOrderHarness();
    const workOrder = {
      ...baseWorkOrder(harness),
      id: "work-order-visible",
      status: "FIELD_IN_PROGRESS"
    };
    const evidenceFile = {
      evidenceItem: {
        evidenceType: "VEHICLE_FRONT",
        handoverId: "handover-1",
        orderId: harness.orderId
      },
      file: {
        bucket: "application-materials",
        mimeType: "image/jpeg",
        objectKey: "delivery-evidence/legacy/front.jpg",
        originalName: "legacy-front.jpg",
        sizeBytes: 5n
      },
      id: "evidence-file-legacy",
      lifecycleStatus: "ACTIVE",
      mediaType: "PHOTO",
      metadata: null
    };
    harness.state.workOrders.push(workOrder);
    harness.state.evidenceFiles.push(evidenceFile);

    const repaired = await harness.service.prepareExistingEvidenceFileArtifacts(
      workOrder.id,
      evidenceFile.id,
      harness.admin.id
    );

    expect(repaired).toMatchObject({
      alreadyReady: false,
      evidenceFileId: evidenceFile.id,
      processingStatus: "READY"
    });
    expect(harness.storageService.getObject).toHaveBeenCalledWith(
      "application-materials",
      "delivery-evidence/legacy/front.jpg"
    );
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledTimes(1);
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledWith(
      expect.objectContaining({ qualityPolicy: "LEGACY_REPAIR" })
    );
    expect(harness.state.fileObjects).toHaveLength(1);
    expect(evidenceFile.metadata).toMatchObject({
      photoPreviewFileId: "file-1",
      processingStatus: "READY"
    });

    const second = await harness.service.prepareExistingEvidenceFileArtifacts(
      workOrder.id,
      evidenceFile.id,
      harness.admin.id
    );
    expect(second).toMatchObject({
      evidenceFileId: evidenceFile.id,
      processingStatus: "READY"
    });
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledTimes(1);

    harness.state.fileObjects.splice(0);
    await harness.service.prepareExistingEvidenceFileArtifacts(
      workOrder.id,
      evidenceFile.id,
      harness.admin.id
    );
    expect(harness.artifactService.prepareUpload).toHaveBeenCalledTimes(2);
  });

  it("rejects the legacy external file-id binding route before evidence can bypass artifact processing", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "External field operator",
        phone: "13900001111"
      },
      harness.admin.id
    );

    await expect(harness.service.attachEvidenceFileWithExternalToken(
      assigned.accessToken,
      "evidence-item-owned",
      { fileId: "unsafe-existing-file", mediaType: "PHOTO" }
    )).rejects.toThrow(BadRequestException);
    expect(harness.evidenceService.attachEvidenceFile).not.toHaveBeenCalled();
  });

  it("records legacy token operators as display names instead of UUID actor ids", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        name: "External field operator",
        phone: "13900001111"
      },
      harness.admin.id
    );

    await harness.service.startFieldWorkByToken(assigned.accessToken);

    expect(harness.state.events).toContainEqual(expect.objectContaining({
      actorDisplay: "External field operator",
      actorId: null,
      eventType: "FIELD_STARTED"
    }));
  });

  it("rejects SVG and mismatched active-content MIME types before storage", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
    harness.state.evidenceItems.push({
      handoverId: "handover-1",
      id: "evidence-item-owned",
      orderId: harness.orderId
    });

    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("active.svg", "image/svg+xml")],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("现场证据仅支持安全的图片或视频文件");
    await expect(
      harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
        "work-order-visible",
        "13800000000",
        "evidence-item-owned",
        [uploadFile("disguised.jpg", "text/html")],
        {},
        "field-session-1"
      )
    ).rejects.toThrow("现场证据仅支持安全的图片或视频文件");
    expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
  });

  it("declares no visible damage and submits field evidence without Stage 2 side effects", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      ...explicitHandoverFacts(),
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      handoverMileageKm: 28600,
      id: "work-order-visible",
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    await harness.service.declareFieldAccessibleNoVisibleDamage(
      "work-order-visible",
      "13800000000",
      "现场确认"
    );
    const submitted = await harness.service.submitFieldAccessibleEvidence(
      "work-order-visible",
      "13800000000",
      "field-session-1"
    );

    expect(harness.evidenceService.declareNoVisibleDamage).toHaveBeenCalledWith(
      harness.orderId,
      undefined,
      "handover-1",
      "现场确认",
      expect.any(Object)
    );
    expect(submitted).toMatchObject({
      fieldSubmittedAt: expect.any(Date),
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.handoverService.assertDeliveryCanBeConfirmed).not.toHaveBeenCalled();
    expect(harness.handoverService.isDeliveryReady).not.toHaveBeenCalled();
  });

  it("returns field-session readiness blockers for incomplete facts or damage close-up evidence", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.evidenceService.setFieldReadiness({
      blockingDetails: [],
      blockingReasons: ["请上传损伤/瑕疵近拍"],
      handoverId: "handover-1",
      orderId: harness.orderId,
      ready: false
    });
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      ...explicitHandoverFacts(),
      damageDeclared: true,
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      handoverMileageKm: 28600,
      id: "work-order-visible",
      noVisibleDamageDeclared: false,
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    const readiness = await harness.service.getFieldAccessibleReadiness("work-order-visible", "13800000000");

    expect(readiness.ready).toBe(false);
    expect(readiness.blockingReasons).toContain("请上传损伤/瑕疵近拍");
  });

  it("retracts a stale no-visible-damage declaration when field work switches to damage", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      ...explicitHandoverFacts(),
      damageDeclared: false,
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      handoverMileageKm: 28600,
      id: "work-order-visible",
      noVisibleDamageDeclared: true,
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    const updated = await harness.service.updateFieldAccessibleFacts(
      "work-order-visible",
      "13800000000",
      {
        damageDeclared: true,
        noVisibleDamageDeclared: false
      },
      "field-session-1"
    );

    expect(updated).toMatchObject({
      damageDeclared: true,
      noVisibleDamageDeclared: false
    });
    expect(harness.evidenceService.retractNoVisibleDamageDeclaration).toHaveBeenCalledWith(
      harness.orderId,
      "field-session-1",
      "handover-1",
      expect.any(Object)
    );
  });

  it("requires field facts, evidence completeness, and a resolved damage state before customer review", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    await harness.service.assignInternalOperator(draft.id, harness.internalUser.id, harness.admin.id);
    await harness.service.startFieldWork(draft.id, harness.internalUser.id);

    await expect(harness.service.submitEvidence(draft.id, harness.internalUser.id)).rejects.toThrow(BadRequestException);

    await harness.service.updateFieldFacts(draft.id, {
      accessoryItems: explicitAccessoryItems(),
      deliveryLocation: "上海市测试交付点",
      energyLevelText: "80%",
      handoverMileageKm: 28500,
      keyState: "COMPLETE",
      noVisibleDamageDeclared: true,
      primaryKeyCount: 1,
      registrationDocumentState: "HANDED_OVER",
      spareKeyCount: 1,
      vehicleConditionConfirmed: true
    }, harness.internalUser.id);

    harness.evidenceService.setFieldComplete(false);
    await expect(harness.service.submitEvidence(draft.id, harness.internalUser.id)).rejects.toThrow("证据尚未完整");

    harness.evidenceService.setFieldComplete(true);
    const submitted = await harness.service.submitEvidence(draft.id, harness.internalUser.id);
    expect(submitted).toMatchObject({
      fieldSubmittedAt: expect.any(Date),
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.evidenceService.assertFieldEvidenceComplete).toHaveBeenCalledWith(
      harness.orderId,
      "handover-1",
      expect.objectContaining({ noVisibleDamageDeclared: true })
    );
  });

  it("allows approval review without blocking Stage 2 but returns a rejection to evidence preparation", async () => {
    const harness = createReadyForCustomerReviewHarness();
    harness.state.vehicleInspection = null;

    await expect(harness.service.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow("客户尚未确认");

    const manifestHash = (await harness.service.getCurrentEvidencePackage("work-order-1")).manifestHash;
    const confirmed = await harness.service.customerConfirmNoObjection(
      "work-order-1",
      "customer-1",
      manifestHash
    );
    expect(confirmed).toMatchObject({
      customerConfirmedAt: expect.any(Date),
      status: "CUSTOMER_CONFIRMED"
    });

    await expect(harness.service.markOpsReviewPending("work-order-1", harness.admin.id)).rejects.toThrow(
      BadRequestException
    );

    await harness.service.markCustomerSigned("work-order-1", new Date("2026-07-21T04:10:00.000Z"), harness.admin.id);
    await harness.service.markOpsReviewPending("work-order-1", harness.admin.id);
    await expect(harness.service.assertReadyForStage2Pdf(harness.orderId)).resolves.toBeUndefined();
    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).resolves.toBeUndefined();

    await harness.service.markOpsReviewRejected("work-order-1", harness.admin.id, "抽检后补材料");
    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).rejects.toThrow();
    expect(harness.state.workOrders[0]).toMatchObject({
      customerConfirmedAt: null,
      opsReviewStatus: "REJECTED",
      status: "FIELD_IN_PROGRESS"
    });
    expect(harness.state.vehicleInspection).toBeNull();
  });

  it("blocks customer confirmation until the registration-document exception is approved", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      registrationDocumentState: "NOT_AVAILABLE"
    });
    Reflect.set(harness.service, "registrationExceptionService", {
      getGate: vi.fn(async () => ({
        allowed: false,
        approval: null,
        documentPresent: false,
        snapshotHash: `sha256:${"4".repeat(64)}`
      }))
    });
    const manifestHash = (
      await harness.service.getCurrentEvidencePackage("work-order-1")
    ).manifestHash;

    await expect(
      harness.service.customerConfirmNoObjection(
        "work-order-1",
        "customer-1",
        manifestHash
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_REGISTRATION_EXCEPTION_REQUIRED"
      })
    });
    expect(harness.state.workOrders[0]).toMatchObject({
      customerConfirmedAt: null,
      status: "CUSTOMER_REVIEWING"
    });
  });

  it("reopens a confirmed review when an approved authority snapshot changes the manifest", async () => {
    const harness = createConfirmedWorkOrderHarness();
    const physicalFacts = buildPhysicalHandoverFactSnapshot(
      harness.state.workOrders[0]!
    );
    Object.assign(harness.state.workOrders[0]!, {
      handoverFactHash: physicalFacts.hash,
      handoverFactRevision: 1,
      handoverFactSnapshot: physicalFacts.snapshot
    });
    Reflect.set(harness.service, "registrationExceptionService", {
      getGate: vi.fn(async () => ({
        allowed: true,
        approval: {
          approvalNo: "BEA-REG-1",
          decidedAt: harness.now,
          decidedBy: harness.admin.id,
          decision: "APPROVE",
          id: "approval-registration-1",
          requestReason: "行驶证补发中",
          requestedAt: harness.now,
          requestedBy: harness.admin.id,
          status: "APPROVED",
          subjectSnapshotHash: `sha256:${"5".repeat(64)}`,
          version: 1
        },
        documentPresent: false,
        snapshotHash: `sha256:${"5".repeat(64)}`
      }))
    });

    const reopened = await harness.service.reopenConfirmedReview(
      "work-order-1",
      harness.admin.id,
      "行驶证例外批准后重新确认"
    );

    expect(reopened).toMatchObject({
      customerConfirmedAt: null,
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.state.reviewAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "review-attempt-confirmed", status: "VOIDED" }),
        expect.objectContaining({ attemptNo: 2, status: "CUSTOMER_REVIEWING" })
      ])
    );
  });

  it("reopens a legacy confirmed unsigned handover for explicit fact upgrade", async () => {
    const harness = createConfirmedWorkOrderHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessoryItems: null,
      fieldOperatorPhone: "13800000000",
      handoverFactHash: null,
      handoverFactRevision: 0,
      handoverFactSnapshot: null,
      keyState: null,
      operatorType: "EXTERNAL",
      primaryKeyCount: null,
      registrationDocumentState: null,
      spareKeyCount: null,
      vehicleConditionConfirmed: null
    });

    const reopened = await harness.service.reopenConfirmedReview(
      "work-order-1",
      harness.admin.id,
      "升级交接确认字段"
    );

    expect(reopened).toMatchObject({
      customerConfirmedAt: null,
      status: "FIELD_IN_PROGRESS"
    });
    await expect(
      harness.service.updateFieldAccessibleFacts(
        "work-order-1",
        "13800000000",
        {
          accessoryItems: explicitAccessoryItems(),
          keyState: "COMPLETE",
          primaryKeyCount: 1,
          registrationDocumentState: "HANDED_OVER",
          spareKeyCount: 1,
          vehicleConditionConfirmed: true
        },
        "field-session-upgrade"
      )
    ).resolves.toMatchObject({ handoverFactRevision: 1 });
  });

  it("blocks ops review pending before post-signing work-order states", async () => {
    const blockedStatuses = [
      "DRAFT",
      "ASSIGNED",
      "FIELD_IN_PROGRESS",
      "EVIDENCE_SUBMITTED",
      "CUSTOMER_REVIEWING",
      "CUSTOMER_CONFIRMED",
      "CUSTOMER_OBJECTED",
      "VOIDED",
      "FAILED",
      "CANCELLED"
    ];

    for (const status of blockedStatuses) {
      const harness = createConfirmedWorkOrderHarness();
      Object.assign(harness.state.workOrders[0]!, { status });

      await expect(harness.service.markOpsReviewPending("work-order-1", harness.admin.id)).rejects.toThrow(
        BadRequestException
      );
    }
  });

  it("rejects ops review decisions unless the work order is pending ops review", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(baseWorkOrder(harness));

    await expect(
      harness.service.markOpsReviewApproved("work-order-1", harness.admin.id)
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.markOpsReviewRejected("work-order-1", harness.admin.id)
    ).rejects.toThrow(BadRequestException);
  });

  it("allows ops review pending after customer signing, platform seal, or field completion", async () => {
    const allowedStatuses = ["CUSTOMER_SIGNED", "PLATFORM_SEALED", "FIELD_COMPLETED", "OPS_REVIEW_PENDING", "OPS_REVIEWED"];

    for (const status of allowedStatuses) {
      const harness = createConfirmedWorkOrderHarness();
      Object.assign(harness.state.workOrders[0]!, {
        fieldCompletedAt: harness.now,
        opsReviewStatus: status === "OPS_REVIEW_PENDING" ? "PENDING" : "NOT_REQUIRED",
        status
      });

      const updated = await harness.service.markOpsReviewPending("work-order-1", harness.admin.id);

      expect(updated).toMatchObject({
        opsReviewStatus: "PENDING",
        status: "OPS_REVIEW_PENDING"
      });
    }
  });

  it("publishes readiness and decides the exact aggregate review in the same transaction", async () => {
    const harness = createReadyForCustomerReviewHarness();
    harness.state.vehicleInspection = null;
    const manifestHash = (
      await harness.service.getCurrentEvidencePackage("work-order-1")
    ).manifestHash;
    await harness.service.customerConfirmNoObjection(
      "work-order-1",
      "customer-1",
      manifestHash
    );
    await harness.service.markCustomerSigned(
      "work-order-1",
      harness.now,
      harness.admin.id
    );

    await harness.service.markOpsReviewPending(
      "work-order-1",
      harness.admin.id
    );
    expect(
      harness.evidenceService.recordJourneyEvidenceReady
    ).toHaveBeenCalledWith(harness.prisma, {
      handoverId: "handover-1",
      manifestHash,
      orderId: harness.orderId,
      workOrderId: "work-order-1"
    });

    await harness.service.markOpsReviewApproved(
      "work-order-1",
      harness.admin.id,
      "approved"
    );
    expect(
      harness.journeySignal.completeHandoverEvidenceDecision
    ).toHaveBeenCalledWith(harness.prisma, {
      actorId: harness.admin.id,
      decision: "APPROVED",
      manifestHash,
      notes: "approved",
      orderId: harness.orderId,
      workOrderId: "work-order-1"
    });
    expect(harness.state.vehicleInspection).toMatchObject({
      inspectedAt: harness.now,
      orderId: harness.orderId,
      status: "PASSED"
    });
  });

  it("converges a customer-confirmed work order only after a complete authoritative Stage 2 archive", async () => {
    const harness = createConfirmedWorkOrderHarness();
    setCompleteArchivedHandover(harness);

    const result = await harness.service.reconcileArchivedStage2JourneyEvidence(
      "work-order-1"
    );

    const manifestHash = buildDeliveryHandoverEvidencePackage({
      ...handoverFactBinding(harness.state.workOrders[0]!),
      evidenceChecklist: harness.evidenceService.getCurrentChecklist(),
      handoverId: "handover-1",
      orderId: harness.orderId,
      workOrderId: "work-order-1"
    }).manifestHash;
    expect(result).toEqual({
      manifestHash,
      outcome: "SIGNALLED",
      workOrderId: "work-order-1"
    });
    expect(harness.state.workOrders[0]).toMatchObject({
      fieldCompletedAt: harness.now,
      opsReviewStatus: "PENDING",
      status: "OPS_REVIEW_PENDING"
    });
    expect(
      harness.evidenceService.recordJourneyEvidenceReady
    ).toHaveBeenCalledWith(
      harness.prisma,
      {
        handoverId: "handover-1",
        manifestHash,
        orderId: harness.orderId,
        workOrderId: "work-order-1"
      },
      { readinessMode: "FIELD_COMPLETENESS" }
    );
    expect(
      harness.state.events.filter(
        (event) => event.eventType === VehicleHandoverEventType.OPS_REVIEW_UPDATED
      )
    ).toHaveLength(1);
  });

  it.each([
    ["archivedAt", null],
    ["signedDocumentFileId", null],
    ["signedObjectKey", null],
    ["signedPdfHash", null]
  ])("rejects archive convergence when %s is missing", async (field, value) => {
    const harness = createConfirmedWorkOrderHarness();
    setCompleteArchivedHandover(harness);
    Object.assign(harness.state.handover, { [field]: value });

    await expect(
      harness.service.reconcileArchivedStage2JourneyEvidence("work-order-1")
    ).rejects.toThrow("STAGE2_HANDOVER_ARCHIVE_INCOMPLETE");
    expect(
      harness.evidenceService.recordJourneyEvidenceReady
    ).not.toHaveBeenCalled();
    expect(harness.state.workOrders[0]).toMatchObject({
      opsReviewStatus: "NOT_REQUIRED",
      status: "CUSTOMER_CONFIRMED"
    });
  });

  it.each(["CUSTOMER_OBJECTED", "VOIDED", "FAILED", "CANCELLED"])(
    "rejects archived convergence from %s",
    async (status) => {
      const harness = createConfirmedWorkOrderHarness();
      setCompleteArchivedHandover(harness);
      Object.assign(harness.state.workOrders[0]!, {
        customerObjectedAt:
          status === "CUSTOMER_OBJECTED" ? harness.now : null,
        status
      });

      await expect(
        harness.service.reconcileArchivedStage2JourneyEvidence("work-order-1")
      ).rejects.toThrow(BadRequestException);
      expect(
        harness.evidenceService.recordJourneyEvidenceReady
      ).not.toHaveBeenCalled();
    }
  );

  it("replays the stable readiness signal without duplicating the ops-review event", async () => {
    const harness = createConfirmedWorkOrderHarness();
    setCompleteArchivedHandover(harness);

    const first = await harness.service.reconcileArchivedStage2JourneyEvidence(
      "work-order-1"
    );
    const second = await harness.service.reconcileArchivedStage2JourneyEvidence(
      "work-order-1"
    );

    expect(first.outcome).toBe("SIGNALLED");
    expect(second).toEqual({ ...first, outcome: "ALREADY_READY" });
    expect(
      harness.state.events.filter(
        (event) => event.eventType === VehicleHandoverEventType.OPS_REVIEW_UPDATED
      )
    ).toHaveLength(1);
    expect(
      harness.evidenceService.recordJourneyEvidenceReady
    ).toHaveBeenCalledTimes(2);
    expect(
      harness.evidenceService.recordJourneyEvidenceReady
    ).toHaveBeenNthCalledWith(
      2,
      harness.prisma,
      {
        handoverId: "handover-1",
        manifestHash: first.manifestHash,
        orderId: harness.orderId,
        workOrderId: "work-order-1"
      },
      { readinessMode: "FIELD_COMPLETENESS" }
    );
  });

  it("scans only complete archives stranded at the Stage 2 Journey step", async () => {
    const harness = createConfirmedWorkOrderHarness();
    setCompleteArchivedHandover(harness);
    harness.prisma.vehicleHandoverWorkOrder.findMany.mockResolvedValueOnce([
      { id: "work-order-1" }
    ]);

    const result = await harness.service
      .reconcileArchivedStage2JourneyEvidenceBatch(10);

    expect(
      harness.prisma.vehicleHandoverWorkOrder.findMany
    ).toHaveBeenCalledWith({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: { id: true },
      take: 10,
      where: {
        handover: {
          is: {
            archiveStatus: "ARCHIVED",
            archivedAt: { not: null },
            deletedAt: null,
            signedDocumentFileId: { not: null },
            signedObjectKey: { not: null },
            signedPdfHash: { not: null },
            status: "ARCHIVED"
          }
        },
        handoverType: "DELIVERY_OUTBOUND",
        order: {
          is: {
            subscriptionJourney: {
              is: {
                currentStepCode: "HANDOVER_AND_STAGE2_CREATION",
                status: { notIn: ["COMPLETED", "CANCELLED"] }
              }
            }
          }
        },
        status: {
          in: [
            "CUSTOMER_CONFIRMED",
            "SIGNING",
            "CUSTOMER_SIGNED",
            "PLATFORM_SEALED",
            "FIELD_COMPLETED",
            "OPS_REVIEW_PENDING"
          ]
        }
      }
    });
    expect(result).toEqual({ failed: 0, processed: 1, scanned: 1 });
  });

  it("continues bounded archive convergence after one candidate fails", async () => {
    const harness = createConfirmedWorkOrderHarness();
    setCompleteArchivedHandover(harness);
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(
      () => undefined
    );
    harness.prisma.vehicleHandoverWorkOrder.findMany.mockResolvedValueOnce([
      { id: "missing-work-order" },
      { id: "work-order-1" }
    ]);

    await expect(
      harness.service.reconcileArchivedStage2JourneyEvidenceBatch(2)
    ).resolves.toEqual({ failed: 1, processed: 1, scanned: 2 });
    expect(
      harness.evidenceService.recordJourneyEvidenceReady
    ).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      errorCode: "STAGE2_ARCHIVE_CONVERGENCE_FAILED",
      operation: "RECONCILE_ARCHIVED_STAGE2_EVIDENCE",
      workOrderId: "missing-work-order"
    });
    warn.mockRestore();
  });

  it("blocks Stage 2 signing when the customer objects or the work order is cancelled", async () => {
    const harness = createReadyForCustomerReviewHarness();

    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议");

    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).rejects.toThrow("客户存在异议");
    expect(harness.state.workOrders[0]!).toMatchObject({
      customerObjectionReason: "车辆外观有异议",
      status: "CUSTOMER_OBJECTED"
    });

    const cancelledHarness = createReadyForCustomerReviewHarness();
    await cancelledHarness.service.voidOrCancel("work-order-1", "CANCELLED", cancelledHarness.admin.id, "取消测试");
    await expect(cancelledHarness.service.assertReadyForStage2Pdf(cancelledHarness.orderId)).rejects.toThrow("交付工单已终止");
  });

  it("requires Admin intervention before an objected handover can be resubmitted to customer review", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      operatorType: "EXTERNAL"
    });

    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议", "右前轮毂需复核");

    await expect(
      harness.service.submitFieldAccessibleEvidence("work-order-1", "13800000000", "field-session-1")
    ).rejects.toThrow(BadRequestException);

    await harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id, "已受理");
    await harness.service.requestCustomerObjectionResubmission("work-order-1", harness.admin.id, {
      note: "请现场重拍右前轮毂",
      targetEvidenceItemIds: [],
      targetFieldKeys: ["fieldNotes"]
    });

    await expect(
      harness.service.submitFieldAccessibleEvidence("work-order-1", "13800000000", "field-session-1")
    ).rejects.toThrow("请至少更新一项后台要求复检的现场资料");

    await harness.service.updateFieldAccessibleFacts(
      "work-order-1",
      "13800000000",
      { fieldNotes: "右前轮毂已完成复检" },
      "field-session-1"
    );

    const resubmitted = await harness.service.submitFieldAccessibleEvidence(
      "work-order-1",
      "13800000000",
      "field-session-1"
    );
    expect(resubmitted).toMatchObject({
      customerObjectedAt: expect.any(Date),
      customerObjectionReason: "车辆外观有异议",
      status: "CUSTOMER_OBJECTED"
    });
    expect(resubmitted.metadata).toMatchObject({
      handoverReviewAdminStatus: "RESUBMITTED_PENDING_ADMIN"
    });
    expect(resubmitted).toMatchObject({
      adminReviewStatus: "RESUBMITTED_PENDING_ADMIN"
    });
    await expect(harness.service.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow("现场资料已重新提交");
    await expect(harness.service.customerConfirmNoObjection(
      "work-order-1",
      "customer-1",
      `sha256:${"0".repeat(64)}`
    )).rejects.toThrow(
      "客户已提交异议"
    );

    await harness.service.sendCustomerObjectionBackToReview(
      "work-order-1",
      harness.admin.id,
      "已送回客户复核"
    );

    expect(harness.state.workOrders[0]!).toMatchObject({
      customerObjectedAt: null,
      customerObjectionReason: null,
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.state.reviewAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptNo: 1,
          customerObjectionReason: "车辆外观有异议",
          status: "RESUBMITTED_PENDING_ADMIN"
        }),
        expect.objectContaining({
          attemptNo: 2,
          status: "CUSTOMER_REVIEWING"
        })
      ])
    );
    const refreshedManifestHash =
      (await harness.service.getCurrentEvidencePackage("work-order-1")).manifestHash;
    await expect(harness.service.customerConfirmNoObjection(
      "work-order-1",
      "customer-1",
      refreshedManifestHash
    )).resolves.toMatchObject({
      status: "CUSTOMER_CONFIRMED"
    });
    expect(harness.state.events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "CUSTOMER_OBJECTED",
      "OBJECTION_ACKNOWLEDGED",
      "RESUBMISSION_REQUESTED",
      "FIELD_FACTS_UPDATED",
      "FIELD_RESUBMITTED",
      "SENT_BACK_TO_CUSTOMER_REVIEW",
      "CUSTOMER_CONFIRMED"
    ]));
  });

  it("rejects skipped, repeated, and regressive objection transitions", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      operatorType: "EXTERNAL"
    });
    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议");

    await expect(
      harness.service.requestCustomerObjectionResubmission("work-order-1", harness.admin.id, {
        note: "请重检",
        targetEvidenceItemIds: [],
        targetFieldKeys: []
      })
    ).rejects.toThrow("请先受理客户异议");

    await harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id, "已受理");
    await expect(
      harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id, "重复受理")
    ).rejects.toThrow("当前异议状态不能重复受理");
    await expect(
      harness.service.sendCustomerObjectionBackToReview("work-order-1", harness.admin.id, "跳步送回")
    ).rejects.toThrow("现场资料重新提交后，后台才能送回客户复核");
  });

  it("normalizes legacy customer-reviewing objections when Admin requests field resubmission", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      adminReviewStatus: "ACKNOWLEDGED",
      customerObjectedAt: harness.now,
      customerObjectionReason: "legacy objection",
      status: "CUSTOMER_REVIEWING"
    });

    const requested = await harness.service.requestCustomerObjectionResubmission(
      "work-order-1",
      harness.admin.id,
      {
        note: "recheck legacy objection",
        targetEvidenceItemIds: [],
        targetFieldKeys: ["fieldNotes"]
      }
    );

    expect(requested).toMatchObject({
      fieldResubmissionRequested: true,
      status: "CUSTOMER_OBJECTED"
    });
  });

  it("allows field edits for legacy active objections with resubmission already requested", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      adminReviewStatus: "RESUBMISSION_REQUESTED",
      customerObjectedAt: harness.now,
      customerObjectionReason: "legacy objection",
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      operatorType: "EXTERNAL",
      status: "CUSTOMER_REVIEWING"
    });

    await expect(
      harness.service.updateFieldAccessibleFacts(
        "work-order-1",
        "13800000000",
        { fieldNotes: "legacy recheck updated" },
        "field-session-1"
      )
    ).resolves.toMatchObject({
      fieldNotes: "legacy recheck updated",
      status: "CUSTOMER_REVIEWING"
    });
  });

  it("returns recheck guidance before a legacy objection recheck is resubmitted", async () => {
    const harness = createReadyForCustomerReviewHarness();
    Object.assign(harness.state.workOrders[0]!, {
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      externalOperatorPhone: "13800000000",
      fieldOperatorPhone: "13800000000",
      operatorType: "EXTERNAL"
    });
    harness.evidenceService.setChecklist({
      blockingReasons: [],
      items: [
        {
          evidenceType: "FRONT_INTERIOR",
          files: [],
          id: "evidence-item-front-interior",
          isRequired: true,
          reviewStatus: "PENDING",
          status: "UPLOADED",
          title: "前排内饰"
        }
      ],
      ready: false
    });

    await harness.service.customerObject(
      "work-order-1",
      "customer-1",
      "损伤不认可",
      "驾驶位座椅内饰有烫伤未标记"
    );
    await harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id, "已受理");
    await harness.service.requestCustomerObjectionResubmission("work-order-1", harness.admin.id, {
      note: "客户异议，请重新车检",
      targetEvidenceItemIds: ["evidence-item-front-interior"],
      targetFieldKeys: ["damageDeclared", "noVisibleDamageDeclared"]
    });

    Object.assign(harness.state.workOrders[0]!, { status: "CUSTOMER_REVIEWING" });

    const detail = await harness.service.getFieldAccessibleWorkOrder("work-order-1", "13800000000");

    expect(detail.reviewContext).toMatchObject({
      adminNote: "客户异议，请重新车检",
      customerObjectionDetails: "驾驶位座椅内饰有烫伤未标记",
      customerObjectionReason: "损伤不认可",
      requestedEvidenceItems: [
        {
          id: "evidence-item-front-interior",
          title: "前排内饰"
        }
      ],
      requestedFieldKeys: ["damageDeclared", "noVisibleDamageDeclared"]
    });
  });

  it("rejects stale objection transitions without writing an audit event", async () => {
    const harness = createReadyForCustomerReviewHarness();
    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议");
    const eventCount = harness.state.events.length;
    harness.prisma.vehicleHandoverWorkOrder.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      harness.service.acknowledgeCustomerObjection("work-order-1", harness.admin.id)
    ).rejects.toThrow("交接复核状态已更新，请刷新后重试");

    expect(harness.state.events).toHaveLength(eventCount);
    expect(harness.state.workOrders[0]?.adminReviewStatus).toBe("NONE");
  });

  it("lists only actionable customer objections in the Admin review queue", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(
      {
        ...baseWorkOrder(harness),
        adminReviewStatus: "ACKNOWLEDGED",
        customerObjectedAt: harness.now,
        customerObjectionReason: "车辆外观",
        id: "work-order-objected",
        status: "CUSTOMER_OBJECTED"
      },
      {
        ...baseWorkOrder(harness),
        adminReviewStatus: "RESOLVED",
        customerConfirmedAt: harness.now,
        id: "work-order-confirmed",
        status: "CUSTOMER_CONFIRMED"
      }
    );

    const queue = await harness.service.listAdminReviewQueue();

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: "work-order-objected",
      objection: { reason: "车辆外观" }
    });
  });

  it("keeps field completion tied to customer signing and delivery confirmation tied to completed Stage 2 signing", async () => {
    const harness = createConfirmedWorkOrderHarness();

    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).rejects.toThrow(BadRequestException);

    await harness.service.markCustomerSigned("work-order-1", new Date("2026-07-21T04:10:00.000Z"), harness.admin.id);
    expect(harness.state.workOrders[0]!).toMatchObject({
      fieldCompletedAt: expect.any(Date),
      status: "CUSTOMER_SIGNED"
    });
    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).rejects.toThrow(BadRequestException);

    harness.state.handover.status = "SIGNED";
    harness.state.handover.archiveStatus = "FAILED";
    await harness.service.markPlatformSealed("work-order-1", new Date("2026-07-21T04:12:00.000Z"), harness.admin.id);
    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).resolves.toBeUndefined();
    await harness.service.markFieldCompleted("work-order-1", new Date("2026-07-21T04:15:00.000Z"), harness.admin.id);
    expect(harness.state.events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "CUSTOMER_SIGNED",
      "PLATFORM_SEALED",
      "FIELD_COMPLETED"
    ]));
  });

  it("rejects signing and completion state jumps from a draft work order", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(baseWorkOrder(harness));

    await expect(
      harness.service.markCustomerSigned("work-order-1", harness.now, harness.admin.id)
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.markPlatformSealed("work-order-1", harness.now, harness.admin.id)
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.markFieldCompleted("work-order-1", harness.now, harness.admin.id)
    ).rejects.toThrow(BadRequestException);
  });

  it("requires an explicit customer-signed state before platform sealing", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      status: "SIGNING"
    });

    await expect(
      harness.service.markPlatformSealed("work-order-1", harness.now, harness.admin.id)
    ).rejects.toThrow(BadRequestException);
    expect(harness.state.events).toEqual([]);
  });
});

function createReadyForCustomerReviewHarness() {
  const harness = createHandoverWorkOrderHarness();
  harness.state.workOrders.push({
    ...baseWorkOrder(harness),
    accessoryChecklist: { chargingCable: true, keys: 2 },
    accessoryItems: explicitAccessoryItems(),
    energyLevelText: "80%",
    fieldSubmittedAt: harness.now,
    handoverMileageKm: 28500,
    keyState: "COMPLETE",
    noVisibleDamageDeclared: true,
    primaryKeyCount: 1,
    registrationDocumentState: "HANDED_OVER",
    spareKeyCount: 1,
    status: "CUSTOMER_REVIEWING",
    vehicleConditionConfirmed: true
  });
  return harness;
}

function createConfirmedWorkOrderHarness() {
  const harness = createReadyForCustomerReviewHarness();
  Object.assign(harness.state.workOrders[0]!, {
    customerConfirmedAt: harness.now,
    status: "CUSTOMER_CONFIRMED"
  });
  const evidencePackage = buildDeliveryHandoverEvidencePackage({
    ...handoverFactBinding(harness.state.workOrders[0]!),
    evidenceChecklist: harness.evidenceService.getCurrentChecklist(),
    handoverId: "handover-1",
    orderId: harness.orderId,
    workOrderId: "work-order-1"
  });
  harness.state.handover.manifestHash = evidencePackage.manifestHash.replace(
    /^sha256:/,
    ""
  );
  harness.state.reviewAttempts.push({
    attemptNo: 1,
    evidenceSnapshot: {
      evidencePackage: {
        manifest: evidencePackage.manifest,
        manifestHash: evidencePackage.manifestHash,
        stats: evidencePackage.stats
      }
    },
    handoverId: "handover-1",
    id: "review-attempt-confirmed",
    orderId: harness.orderId,
    status: "CUSTOMER_CONFIRMED",
    workOrderId: "work-order-1"
  });
  return harness;
}

function setCompleteArchivedHandover(
  harness: ReturnType<typeof createHandoverWorkOrderHarness>
) {
  Object.assign(harness.state.handover, {
    archiveStatus: "ARCHIVED",
    archivedAt: harness.now,
    completedAt: harness.now,
    signedDocumentFileId: "signed-file-1",
    signedObjectKey: "handover/signed/stage2.pdf",
    signedPdfHash: "a".repeat(64),
    status: "ARCHIVED"
  });
}

function baseWorkOrder(harness: ReturnType<typeof createHandoverWorkOrderHarness>) {
  return {
    accessTokenExpiresAt: null,
    accessTokenHash: null,
    accessTokenRevokedAt: null,
    adminReviewStatus: "NONE",
    accessoryChecklist: null,
    accessoryItems: null,
    assignedInternalUserId: null,
    createdAt: harness.now,
    customerConfirmedAt: null,
    customerObjectedAt: null,
    customerObjectionReason: null,
    customerReviewStartedAt: null,
    damageDeclared: null,
    deliveryLocation: null,
    energyLevelText: null,
    externalOperatorName: null,
    externalOperatorOrganization: null,
    externalOperatorPhone: null,
    fieldOperatorName: null,
    fieldOperatorPhone: null,
    fieldCompletedAt: null,
    fieldNotes: null,
    fieldStartedAt: null,
    fieldSubmittedAt: null,
    firstAccessedAt: null,
    fuelLevelText: null,
    handoverId: "handover-1",
    handoverFactHash: null,
    handoverFactRevision: 0,
    handoverFactSnapshot: null,
    handoverMileageKm: null,
    handoverType: "DELIVERY_OUTBOUND",
    id: "work-order-1",
    keyState: null,
    lastAccessedAt: null,
    metadata: null,
    noVisibleDamageDeclared: null,
    operatorType: "INTERNAL",
    opsReviewNotes: null,
    opsReviewStatus: "NOT_REQUIRED",
    opsReviewedAt: null,
    opsReviewedBy: null,
    orderId: harness.orderId,
    primaryKeyCount: null,
    registrationDocumentRemarks: null,
    registrationDocumentState: null,
    reviewVersion: 0,
    scheduledAt: null,
    spareKeyCount: null,
    status: "DRAFT",
    updatedAt: harness.now,
    vehicleConditionConfirmed: null,
    vehicleConditionRemarks: null,
    vehicleDeliveryId: "delivery-1"
  };
}

async function prepareCoordinatorProof(
  tx: Parameters<SubscriptionClosureRepository["prepareAuthorityInTransaction"]>[0],
  requirementFactory: (
    session: ReturnType<SubscriptionClosureRepository["createAuthoritySessionInTransaction"]>
  ) => SubscriptionClosureAuthorityRequirement
) {
  const repository = new SubscriptionClosureRepository();
  const session = repository.createAuthoritySessionInTransaction(tx);
  const requirement = requirementFactory(session);
  const proofs = await repository.prepareAuthorityInTransaction(
    tx,
    session,
    requirement.locks,
    [requirement]
  );
  return { proof: proofs.get(requirement.key)!, session };
}

function createHandoverWorkOrderHarness() {
  const now = new Date("2026-07-21T08:00:00.000Z");
  const orderId = "order-1";
  const admin = { id: "admin-1" };
  const internalUser = { id: "user-field-1", mobile: "13800000000" };
  const state = {
    handover: {
      archiveStatus: "NOT_STARTED",
      archivedAt: null as Date | null,
      completedAt: null as Date | null,
      deletedAt: null,
      id: "handover-1",
      manifestHash: null as string | null,
      orderId,
      signedDocumentFileId: null as string | null,
      signedObjectKey: null as string | null,
      signedPdfHash: null as string | null,
      status: "DRAFT",
      vehicleDeliveryId: "delivery-1"
    },
    order: {
      contract: {
        archivedAt: new Date("2026-07-21T07:00:00.000Z"),
        deletedAt: null,
        fileId: "file-contract-archived",
        id: "contract-stage1",
        status: ContractStatus.ARCHIVED as ContractStatus
      },
      contractId: "contract-stage1",
      customer: {
        id: "customer-1",
        idCardNo: "TEST_ID_CARD_SHOULD_NOT_LEAK",
        mobile: "18616570212",
        name: "李柯"
      },
      customerId: "customer-1",
      deletedAt: null,
      id: orderId,
      monthlyFeeAmount: 399900n,
      orderNo: "ORD202607210001",
      orderStatus: "PENDING_PAYMENT",
      vehicle: {
        brand: "Tesla",
        deletedAt: null,
        id: "vehicle-1",
        insurancePolicies: [
          {
            deletedAt: null,
            effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            effectiveTo: new Date("2026-12-31T00:00:00.000Z"),
            id: "insurance-compulsory",
            policyStatus: "ACTIVE",
            policyType: "COMPULSORY_TRAFFIC"
          },
          {
            deletedAt: null,
            effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            effectiveTo: new Date("2026-12-31T00:00:00.000Z"),
            id: "insurance-commercial",
            policyStatus: "ACTIVE",
            policyType: "COMMERCIAL"
          }
        ],
        model: "Model 3",
        plateNo: "沪A12345",
        status: "RESERVED",
        vin: "LFPH3AC12N123888888"
      },
      vehicleId: "vehicle-1",
      startDate: new Date("2026-07-22T00:00:00.000Z")
    },
    users: [
      {
        deletedAt: null,
        id: admin.id,
        name: "管理员",
        status: UserStatus.ACTIVE
      },
      {
        deletedAt: null,
        id: internalUser.id,
        mobile: internalUser.mobile,
        name: "内部交付员",
        status: UserStatus.ACTIVE
      }
    ] as Array<{
      deletedAt: Date | null;
      id: string;
      mobile?: string;
      name: string;
      status: UserStatus;
    }>,
    vehicleDelivery: {
      deletedAt: null,
      deliveryLocation: "上海市测试交付点",
      id: "delivery-1",
      orderId,
      scheduledAt: new Date("2026-07-22T02:00:00.000Z")
    },
    vehicleInspection: {
      deletedAt: null,
      id: "inspection-1",
      inspectedAt: now,
      orderId,
      status: "PASSED"
    } as {
      createdBy?: string | null;
      deletedAt: Date | null;
      id: string;
      inspectedAt: Date | null;
      orderId: string;
      status: "PENDING" | "PASSED" | "FAILED";
      updatedBy?: string | null;
    } | null,
    evidenceItems: [] as Array<Record<string, unknown>>,
    evidenceFiles: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    fieldOperatorAuditLogs: [] as Array<Record<string, unknown>>,
    fileObjects: [] as Array<Record<string, unknown>>,
    reviewAttempts: [] as Array<Record<string, unknown>>,
    workOrders: [] as Array<Record<string, unknown>>,
    workflowJobs: [] as Array<Record<string, unknown>>
  };
  const lockQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const evidenceService = createEvidenceService();
  const handoverService = {
    getOrCreateDraftHandover: vi.fn(async () => state.handover),
    isDeliveryReady: vi.fn(),
    assertDeliveryCanBeConfirmed: vi.fn(async (
      _orderId: string,
      _db: unknown,
      currentEvidenceManifestDigest: string
    ) => {
      if (
        (state.handover.status !== "SIGNED" &&
          state.handover.status !== "ARCHIVED") ||
        state.handover.manifestHash !== currentEvidenceManifestDigest
      ) {
        throw new BadRequestException("交付交接确认书尚未完成签署。");
      }
    })
  };
  const prisma = {
    fieldOperatorAuditLog: {
      aggregate: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const rows = state.fieldOperatorAuditLogs.filter(
          (row) =>
            row.workOrderId === where.workOrderId &&
            row.eventType === where.eventType
        );
        const createdTimes = rows
          .map((row) => row.createdAt)
          .filter((value): value is Date => value instanceof Date)
          .sort((left, right) => left.getTime() - right.getTime());
        return {
          _max: { createdAt: createdTimes.at(-1) ?? null },
          _min: { createdAt: createdTimes[0] ?? null }
        };
      })
    },
    subscriptionOrder: {
      findFirst: vi.fn(async () => state.order),
      findUnique: vi.fn(async () => state.order),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.order, data);
        return state.order;
      })
    },
    vehicleInspection: {
      findUnique: vi.fn(async () => state.vehicleInspection),
      upsert: vi.fn(async ({
        create,
        update
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (state.vehicleInspection) {
          Object.assign(state.vehicleInspection, update);
        } else {
          state.vehicleInspection = {
            createdBy: String(create.createdBy),
            deletedAt: null,
            id: "inspection-1",
            inspectedAt: create.inspectedAt as Date,
            orderId: String(create.orderId),
            status: create.status as "PASSED",
            updatedBy: String(create.updatedBy)
          };
        }
        return state.vehicleInspection;
      })
    },
    user: {
      findFirst: vi.fn(async ({
        where
      }: {
        where: { deletedAt?: null; id?: string; status?: UserStatus };
      }) =>
        state.users.find((user) =>
          user.id === where.id &&
          (where.deletedAt === undefined || user.deletedAt === where.deletedAt) &&
          (where.status === undefined || user.status === where.status)
        ) ?? null
      )
    },
    vehicleDelivery: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.vehicleDelivery, data);
        return state.vehicleDelivery;
      }),
      findUnique: vi.fn(async () => state.vehicleDelivery)
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        (!where.id || where.id === state.handover.id)
          ? state.handover
          : null
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        (!where.id || where.id === state.handover.id)
          ? state.handover
          : null
      )
    },
    fileObject: {
      count: vi.fn(async ({ where }: { where: { id?: { in?: string[] } } }) => {
        const ids = where.id?.in ?? [];
        return state.fileObjects.filter((fileObject) => ids.includes(String(fileObject.id))).length;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const fileObject = {
          ...data,
          id: `file-${state.fileObjects.length + 1}`
        };
        state.fileObjects.push(fileObject);
        return fileObject;
      })
    },
    fieldEvidenceVideoUploadSession: {
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    vehicleDeliveryEvidenceItem: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.evidenceItems.find((item) => matchesEvidenceItemWhere(item, where)) ?? null
      )
    },
    vehicleDeliveryEvidenceFile: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.evidenceFiles.find((file) =>
          (!where.id || file.id === where.id) &&
          (!where.lifecycleStatus || file.lifecycleStatus === where.lifecycleStatus)
        ) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id?: string } }) => {
        const evidenceFile = state.evidenceFiles.find((row) => row.id === where.id);
        if (!evidenceFile) {
          throw new Error("evidence file not found");
        }
        Object.assign(evidenceFile, data);
        return evidenceFile;
      })
    },
    vehicleHandoverWorkOrder: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const workOrder = {
          ...baseWorkOrder({ now, orderId } as ReturnType<typeof createHandoverWorkOrderHarness>),
          ...data,
          id: data.id ?? `work-order-${state.workOrders.length + 1}`
        };
        state.workOrders.push(workOrder);
        return workOrder;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return state.workOrders.find((row) => matchesWorkOrderWhere(row, where)) ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.workOrders
          .filter((workOrder) => matchesWorkOrderWhere(workOrder, where))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.workOrders.find((workOrder) => workOrder.id === where.id) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id?: string } }) => {
        const workOrder = state.workOrders.find((row) => row.id === where.id);
        if (!workOrder) {
          throw new Error("work order not found");
        }
        Object.assign(workOrder, applyAtomicUpdates(workOrder, data), { updatedAt: now });
        return workOrder;
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.workOrders.filter((workOrder) => matchesWorkOrderWhere(workOrder, where));
        for (const workOrder of rows) {
          Object.assign(workOrder, applyAtomicUpdates(workOrder, data), { updatedAt: now });
        }
        return { count: rows.length };
      })
    },
    vehicleHandoverEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const event = {
          ...data,
          createdAt: now,
          id: `handover-event-${state.events.length + 1}`
        };
        state.events.push(event);
        return event;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.events.filter((event) => matchesHandoverEventWhere(event, where))
      )
    },
    vehicleHandoverReviewAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const attempt = {
          ...data,
          createdAt: now,
          id: `review-attempt-${state.reviewAttempts.length + 1}`,
          updatedAt: now
        };
        state.reviewAttempts.push(attempt);
        return attempt;
      }),
      findFirst: vi.fn(async ({ orderBy, where }: { orderBy?: Record<string, string>; where: Record<string, unknown> }) => {
        const rows = state.reviewAttempts.filter((attempt) => matchesReviewAttemptWhere(attempt, where));
        return sortReviewAttempts(rows, orderBy)[0] ?? null;
      }),
      findMany: vi.fn(async ({ orderBy, where }: { orderBy?: Record<string, string>; where: Record<string, unknown> }) =>
        sortReviewAttempts(state.reviewAttempts.filter((attempt) => matchesReviewAttemptWhere(attempt, where)), orderBy)
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id?: string } }) => {
        const attempt = state.reviewAttempts.find((row) => row.id === where.id);
        if (!attempt) {
          throw new Error("review attempt not found");
        }
        Object.assign(attempt, data, { updatedAt: now });
        return attempt;
      })
    },
    vehicleHandoverWorkflowJob: {
      findFirst: vi.fn(async ({ where }: { where: { jobStatus?: string; workOrderId?: string } }) =>
        state.workflowJobs.find(
          (job) =>
            job.workOrderId === where.workOrderId &&
            (!where.jobStatus || job.jobStatus === where.jobStatus)
        ) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { workOrderId?: string } }) =>
        state.workflowJobs
          .filter((job) => job.workOrderId === where.workOrderId)
          .sort(
            (left, right) =>
              new Date(String(right.updatedAt)).getTime() -
              new Date(String(left.updatedAt)).getTime()
          )
      ),
      updateMany: vi.fn(async ({ data, where }: {
        data: Record<string, unknown>;
        where: { jobStatus?: { in?: string[] }; workOrderId?: string };
      }) => {
        let count = 0;
        for (const job of state.workflowJobs) {
          if (
            job.workOrderId === where.workOrderId &&
            (!where.jobStatus?.in || where.jobStatus.in.includes(String(job.jobStatus)))
          ) {
            Object.assign(job, data, { updatedAt: now });
            count += 1;
          }
        }
        return { count };
      })
    },
    $queryRaw: vi.fn(async (query: { sql?: string; strings?: readonly string[]; values?: readonly unknown[] }) => {
      const sql = query.sql ?? query.strings?.join("?") ?? "";
      const values = query.values ?? [];
      lockQueries.push({ sql, values });
      if (sql.includes("current_setting('transaction_isolation')")) {
        return [{ isolationLevel: "read committed", transactionId: "handover-capability-tx" }];
      }
      if (sql.includes("txid_current()")) {
        return [{ transactionId: "handover-capability-tx" }];
      }
      if (sql.includes("pg_advisory_xact_lock")) return [{ locked: true }];
      if (sql.includes('AS "authorityTable"')) {
        const rows: Array<{ authorityTable: string; requestedId: string }> = [];
        for (let index = 0; index < values.length; index += 2) {
          rows.push({
            authorityTable: String(values[index]),
            requestedId: String(values[index + 1])
          });
        }
        return rows;
      }
      if (sql.includes('FROM "vehicle_handover_work_order"')) {
        if (sql.includes('WHERE "id"')) {
          return state.workOrders
            .filter((row) => row.id === values[0])
            .map((row) => ({ id: row.id }));
        }
        return state.workOrders
          .filter((row) => row.orderId === values[0] && row.handoverType === "RETURN_INBOUND")
          .map((row) => ({ id: row.id }));
      }
      return [{ id: "vehicle-1" }];
    }),
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => {
      const snapshots = {
        events: structuredClone(state.events),
        evidenceFiles: structuredClone(state.evidenceFiles),
        fileObjects: structuredClone(state.fileObjects),
        reviewAttempts: structuredClone(state.reviewAttempts),
        workOrders: structuredClone(state.workOrders),
        workflowJobs: structuredClone(state.workflowJobs)
      };
      try {
        return await callback(prisma);
      } catch (error) {
        state.events.splice(0, state.events.length, ...snapshots.events);
        state.evidenceFiles.splice(0, state.evidenceFiles.length, ...snapshots.evidenceFiles);
        state.fileObjects.splice(0, state.fileObjects.length, ...snapshots.fileObjects);
        state.reviewAttempts.splice(0, state.reviewAttempts.length, ...snapshots.reviewAttempts);
        state.workOrders.splice(0, state.workOrders.length, ...snapshots.workOrders);
        state.workflowJobs.splice(0, state.workflowJobs.length, ...snapshots.workflowJobs);
        throw error;
      }
    })
  };
  const storageService = {
    deleteObject: vi.fn(async () => undefined),
    getObject: vi.fn(async () => ({
      contentLength: 5,
      contentType: "image/jpeg",
      stream: Readable.from([Buffer.from("photo")])
    })),
    putDeliveryEvidenceDerivativeFromPath: vi.fn(async (input: Record<string, unknown>) => ({
      bucket: "application-materials",
      objectKey: `delivery-evidence/${input.workOrderId}/2026/derivatives/preview.jpg`,
      stored: { driver: "local", key: "local-derivative-key", size: input.sizeBytes }
    })),
    putDeliveryEvidenceFileFromPath: vi.fn(async (input: Record<string, unknown>) => ({
      bucket: "application-materials",
      objectKey: `delivery-evidence/${input.workOrderId}/2026/video.mp4`,
      stored: { driver: "local", key: "local-stream-key", size: input.sizeBytes }
    })),
    putDeliveryEvidenceFile: vi.fn(async (input: Record<string, unknown>) => ({
      bucket: "application-materials",
      objectKey: `delivery-evidence/${input.workOrderId}/2026/front.jpg`,
      stored: { driver: "local", key: "local-key", size: 5 }
    }))
  };
  const artifactService = {
    prepareUpload: vi.fn(async (input: {
      evidenceType: string;
      file: { mimetype?: string; originalname?: string; size: number };
      mediaType: "PHOTO" | "VIDEO";
    }) => {
      const extension = input.file.originalname?.split(".").pop()?.toLowerCase();
      const detectedMimeType = input.mediaType === "PHOTO"
        ? extension === "heic"
          ? "image/heic"
          : extension === "heif"
            ? "image/heif"
            : input.file.mimetype || "image/jpeg"
        : extension === "mov"
          ? "video/quicktime"
          : extension === "m4v"
            ? "video/x-m4v"
            : input.file.mimetype || "video/mp4";
      return {
        cleanup: vi.fn(async () => undefined),
        derivatives: input.mediaType === "PHOTO"
          ? [{
              contentType: "image/jpeg",
              filePath: "C:/tmp/stage2-photo-preview.jpg",
              kind: "PHOTO_PREVIEW",
              originalName: "front-preview.jpg",
              sizeBytes: 8
            }]
          : [{
              contentType: "image/jpeg",
              filePath: "C:/tmp/stage2-video-frame-01.jpg",
              kind: "VIDEO_FRAME",
              originalName: "video-frame-01.jpg",
              sizeBytes: 8
            }],
        metadata: {
          artifactVersion: 1,
          detectedCodec: input.mediaType === "VIDEO" ? "h264" : null,
          detectedMimeType,
          processedAt: "2026-07-25T00:00:00.000Z",
          processingStatus: "READY",
          sourceSha256: `sha256:${"a".repeat(64)}`,
          sourceSizeBytes: input.file.size,
          videoBitRateBps: input.mediaType === "VIDEO" ? 8_000_000 : null,
          videoDurationMs: input.mediaType === "VIDEO" ? 1_000 : null,
          videoFrameRate: input.mediaType === "VIDEO" ? 30 : null,
          videoHeightPx: input.mediaType === "VIDEO" ? 1080 : null,
          videoQualityStatus:
            input.evidenceType === "WALKAROUND_VIDEO" ? "PASSED" : null,
          videoWidthPx: input.mediaType === "VIDEO" ? 1920 : null
        }
      };
    })
  };
  const workflowRepository = {
    enqueue: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => {
      const existing = state.workflowJobs.find(
        (job) => job.idempotencyKey === input.idempotencyKey
      );
      if (existing) {
        return existing;
      }
      const job = {
        ...input,
        attemptCount: 0,
        availableAt: now,
        createdAt: now,
        id: `workflow-job-${state.workflowJobs.length + 1}`,
        jobStatus: "PENDING",
        updatedAt: now
      };
      state.workflowJobs.push(job);
      return job;
    })
  };
  const financeService = {
    evaluateInitialBillSettlement: vi.fn(async () => ({
      paid: true,
      remainingAmount: 0n
    }))
  };
  const journeySignal = {
    completeHandoverEvidenceDecision: vi.fn(async () => undefined)
  };
  const assetOperationsService = {
    assertVehicleAvailable: vi.fn(async () => undefined)
  };
  const service = new HandoverWorkOrderService(
    prisma as never,
    evidenceService as never,
    handoverService as never,
    storageService as never,
    undefined,
    undefined,
    artifactService as never,
    workflowRepository as never,
    financeService as never,
    journeySignal as never,
    assetOperationsService as never
  );

  return {
    admin,
    assetOperationsService,
    artifactService,
    evidenceService,
    financeService,
    handoverService,
    internalUser,
    journeySignal,
    lockQueries,
    now,
    orderId,
    prisma,
    service,
    state,
    storageService,
    workflowRepository
  };
}

function createEvidenceService() {
  let fieldComplete = true;
  let fieldReadiness: Record<string, unknown> = {
    blockingDetails: [],
    blockingReasons: [],
    handoverId: "handover-1",
    orderId: "order-1",
    ready: true
  };
  let checklist: Record<string, unknown> = {
    blockingReasons: [],
    items: [
      {
        evidenceType: "VEHICLE_FRONT",
        files: [{
          file: {
            id: "file-default",
            mimeType: "image/jpeg",
            originalName: "front.jpg",
            sizeBytes: 1024
          },
          fileId: "file-default",
          id: "evidence-file-default",
          mediaType: "PHOTO",
          metadata: {
            artifactVersion: 1,
            detectedMimeType: "image/jpeg",
            photoPreviewFileId: "preview-file-default",
            processedAt: "2026-07-22T08:00:00.000Z",
            processingStatus: "READY",
            sourceSha256: `sha256:${"1".repeat(64)}`,
            sourceSizeBytes: 1024,
            videoDurationMs: null,
            videoFrameFileIds: []
          },
          objectKey: "oss/internal/evidence.jpg",
          uploadedAt: new Date("2026-07-22T08:00:00.000Z")
        }],
        id: "evidence-item-default",
        isRequired: true,
        reviewStatus: "PENDING",
        status: "UPLOADED",
        title: "车辆车头正面"
      },
      {
        evidenceType: "VEHICLE_REAR",
        files: [],
        id: "evidence-item-missing",
        isRequired: true,
        reviewStatus: "NOT_STARTED",
        status: "NOT_STARTED",
        title: "车辆车尾正面"
      }
    ],
    ready: false
  };
  return {
    assertFieldEvidenceComplete: vi.fn(async () => {
      if (!fieldComplete) {
        throw new BadRequestException("证据尚未完整");
      }
    }),
    attachEvidenceFile: vi.fn(async (itemId: string) => ({
      fileCount: 1,
      id: itemId,
      status: "UPLOADED"
    })),
    declareNoVisibleDamage: vi.fn(async () => ({
      declaredNoDamage: true,
      evidenceType: "NO_VISIBLE_DAMAGE_DECLARATION",
      status: "APPROVED"
    })),
    getChecklist: vi.fn(async () => checklist),
    getCurrentChecklist() {
      return checklist;
    },
    initializeChecklist: vi.fn(async () => ({ items: [] })),
    recordJourneyEvidenceReady: vi.fn(async () => undefined),
    removeEvidenceFile: vi.fn(async (itemId: string) => ({
      fileCount: 0,
      id: itemId,
      status: "NOT_STARTED"
    })),
    replaceEvidenceFile: vi.fn(async (itemId: string) => ({
      fileCount: 1,
      id: itemId,
      status: "UPLOADED"
    })),
    retractNoVisibleDamageDeclaration: vi.fn(async () => null),
    validateEvidenceFileMutation: vi.fn(async (itemId: string) => ({
      allowsMultiple: false,
      currentFileCount: 1,
      evidenceType: "VEHICLE_FRONT",
      itemId
    })),
    validateFieldEvidenceComplete: vi.fn(async () => fieldReadiness),
    setChecklist(value: Record<string, unknown>) {
      checklist = value;
    },
    setFieldComplete(value: boolean) {
      fieldComplete = value;
    },
    setFieldReadiness(value: Record<string, unknown>) {
      fieldReadiness = value;
    }
  };
}

function matchesEvidenceItemWhere(item: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") {
      return (expected as Array<Record<string, unknown>>).some((branch) => matchesEvidenceItemWhere(item, branch));
    }
    return item[key] === expected;
  });
}

function matchesWorkOrderWhere(workOrder: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND") {
      return (expected as Array<Record<string, unknown>>).every((branch) =>
        matchesWorkOrderWhere(workOrder, branch)
      );
    }
    if (key === "OR") {
      return (expected as Array<Record<string, unknown>>).some((branch) => matchesWorkOrderWhere(workOrder, branch));
    }
    if (key === "metadata" && expected && typeof expected === "object") {
      const predicate = expected as { equals?: unknown; path?: string[] };
      let value: unknown = workOrder.metadata;
      for (const segment of predicate.path ?? []) {
        value =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[segment]
            : undefined;
      }
      return value === predicate.equals;
    }
    if (key === "id") {
      return workOrder.id === expected;
    }
    if (key === "orderId") {
      return workOrder.orderId === expected;
    }
    if (key === "operatorType") {
      return workOrder.operatorType === expected;
    }
    if (key === "externalOperatorPhone") {
      return workOrder.externalOperatorPhone === expected;
    }
    if (key === "fieldOperatorPhone") {
      return workOrder.fieldOperatorPhone === expected;
    }
    if (key === "accessTokenRevokedAt") {
      return workOrder.accessTokenRevokedAt === expected;
    }
    if (key === "accessTokenExpiresAt" && expected === null) {
      return workOrder.accessTokenExpiresAt === null;
    }
    if (key === "accessTokenExpiresAt" && expected && typeof expected === "object" && "gt" in expected) {
      const expiresAt = workOrder.accessTokenExpiresAt as Date | null | undefined;
      return Boolean(expiresAt && expiresAt.getTime() > (expected.gt as Date).getTime());
    }
    if (key === "accessTokenHash") {
      return workOrder.accessTokenHash === expected;
    }
    if (key === "status" && expected && typeof expected === "object" && "notIn" in expected) {
      return !(expected.notIn as unknown[]).includes(workOrder.status);
    }
    if (key === "status") {
      return workOrder.status === expected;
    }
    if (key === "customerObjectedAt" && expected && typeof expected === "object" && "not" in expected) {
      return expected.not === null ? workOrder.customerObjectedAt !== null : true;
    }
    if (key === "handoverType") {
      return workOrder.handoverType === expected;
    }
    if (key === "adminReviewStatus") {
      return workOrder.adminReviewStatus === expected;
    }
    if (key === "reviewVersion") {
      return workOrder.reviewVersion === expected;
    }
    return true;
  });
}

function matchesHandoverEventWhere(event: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => event[key] === expected);
}

function applyAtomicUpdates(
  current: Record<string, unknown>,
  data: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...data };
  const reviewVersion = data.reviewVersion;
  if (reviewVersion && typeof reviewVersion === "object" && "increment" in reviewVersion) {
    next.reviewVersion = Number(current.reviewVersion ?? 0) + Number(reviewVersion.increment);
  }
  return next;
}

function matchesReviewAttemptWhere(attempt: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "workOrderId") {
      return attempt.workOrderId === expected;
    }
    if (key === "id") {
      return attempt.id === expected;
    }
    return true;
  });
}

function sortReviewAttempts(rows: Array<Record<string, unknown>>, orderBy?: Record<string, string>) {
  const direction = orderBy?.attemptNo === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const leftNo = typeof left.attemptNo === "number" ? left.attemptNo : 0;
    const rightNo = typeof right.attemptNo === "number" ? right.attemptNo : 0;
    return (leftNo - rightNo) * direction;
  });
}

function uploadFile(originalname: string, mimetype: string, size = 5) {
  return {
    buffer: Buffer.from("image"),
    mimetype,
    originalname,
    size
  };
}
