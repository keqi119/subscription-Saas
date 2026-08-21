import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  AssetWorkOrderEventType,
  AssetWorkOrderPriority,
  AssetWorkOrderStatus,
  AssetWorkOrderType,
  AuditAction,
  Prisma,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  VehicleStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { AssetAccountingService } from "../src/asset-accounting/asset-accounting.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { VehicleAvailabilityPurpose } from "../src/asset-operations/vehicle-availability";
import { AuditService } from "../src/audit/audit.service";
import { PrismaService } from "../src/prisma/prisma.service";

const NOW = new Date("2026-08-20T04:00:00.000Z");

describe("AssetOperationsService", () => {
  it("executes a prepared caller-owned create capability once in the exact transaction", async () => {
    const harness = createHarness();
    const capability = await harness.service.prepareCallerOwnedTransaction(
      harness.tx as never,
      harness.source
    );
    const command = { ...fullCreateCommand(harness), assetOwnerId: null };

    const result = await harness.service.createWorkOrderInTransaction(
      harness.tx as never,
      command,
      harness.context,
      capability
    );

    expect(result.workOrder.id).toBe(harness.ids.workOrderId);
    expect(harness.sequence[0]).toBe("source-lock");
    expect(harness.sequence.at(-1)).toBe("repository-write");
    expect(harness.sequence.slice(1, -1)).toEqual([
      "authority:subscription_order",
      "authority:vehicle",
      "authority:contract",
      "authority:customer"
    ]);
    expect(harness.auditInputs).toHaveLength(2);
    await expect(
      harness.service.createWorkOrderInTransaction(
        harness.tx as never,
        command,
        harness.context,
        capability
      )
    ).rejects.toMatchObject({
      response: { code: "ASSET_OPERATION_CALLER_CAPABILITY_INVALID" }
    });
  });

  it("uses the real repository for one source lock and exactly one ranked authority pass", async () => {
    const harness = createRealRepositoryCreateHarness();
    const capability = await harness.service.prepareCallerOwnedTransaction(
      harness.tx,
      harness.command.source
    );

    await harness.service.createWorkOrderInTransaction(
      harness.tx,
      harness.command,
      harness.context,
      capability
    );

    expect(harness.sourceLocks).toHaveLength(1);
    expect(harness.authorityTables).toEqual([
      "subscription_order",
      "vehicle",
      "contract",
      "asset_owner",
      "customer"
    ]);
  });

  it("consumes a service capability before reading a throwing source", async () => {
    const harness = createHarness();
    const capability = await harness.service.prepareCallerOwnedTransaction(
      harness.tx as never,
      harness.source
    );
    const command = { ...fullCreateCommand(harness), assetOwnerId: null };
    const malformed = Object.defineProperty({ ...command }, "source", {
      get() {
        throw new TypeError("throwing operation service source getter");
      }
    }) as typeof command;

    await expect(
      harness.service.createWorkOrderInTransaction(
        harness.tx as never,
        malformed,
        harness.context,
        capability
      )
    ).rejects.toThrow("throwing operation service source getter");
    await expect(
      harness.service.createWorkOrderInTransaction(
        harness.tx as never,
        command,
        harness.context,
        capability
      )
    ).rejects.toMatchObject({
      response: { code: "ASSET_OPERATION_CALLER_CAPABILITY_INVALID" }
    });
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("rejects forged, foreign-instance, and wrong-transaction create capabilities", async () => {
    const harness = createHarness();
    const capability = await harness.service.prepareCallerOwnedTransaction(
      harness.tx as never,
      harness.source
    );
    const foreignHarness = createHarness();

    for (const [service, tx, candidate] of [
      [harness.service, harness.tx, Object.freeze({})],
      [foreignHarness.service, harness.tx, capability],
      [harness.service, foreignHarness.tx, capability]
    ] as const) {
      await expect(
        service.createWorkOrderInTransaction(
          tx as never,
          fullCreateCommand(harness),
          harness.context,
          candidate as never
        )
      ).rejects.toMatchObject({
        response: { code: "ASSET_OPERATION_CALLER_CAPABILITY_INVALID" }
      });
    }
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("locks the source, validates one live cross-linked authority aggregate, then writes", async () => {
    const harness = createHarness();

    const result = await harness.service.createWorkOrder(
      {
        assetOwnerId: harness.ids.assetOwnerId,
        contractId: harness.ids.contractId,
        costConfirmationRequired: false,
        customerId: harness.ids.customerId,
        description: "return inspection",
        metadata: { request: "task-4" },
        occurredAt: NOW,
        orderId: harness.ids.orderId,
        priority: AssetWorkOrderPriority.NORMAL,
        relatedWorkOrderId: null,
        source: harness.source,
        vehicleId: harness.ids.vehicleId,
        workOrderType: AssetWorkOrderType.RECONDITIONING
      },
      harness.context
    );

    expect(harness.sequence[0]).toBe("source-lock");
    expect(harness.sequence.at(-1)).toBe("repository-write");
    expect(harness.sequence.slice(1, -1)).toEqual([
      "authority:asset_owner",
      "authority:contract",
      "authority:customer",
      "authority:subscription_order",
      "authority:vehicle"
    ]);
    expect(result.workOrder.authoritySnapshot).toEqual({
      assetOwner: {
        id: harness.ids.assetOwnerId,
        name: "Platform Owner",
        ownerNo: "AO-1",
        ownerType: "PLATFORM",
        status: "ACTIVE"
      },
      contract: {
        contractNo: "CT-1",
        customerId: harness.ids.customerId,
        id: harness.ids.contractId,
        orderId: harness.ids.orderId,
        status: "ACTIVE"
      },
      customer: {
        customerNo: "CU-1",
        id: harness.ids.customerId,
        name: "Customer",
        status: "ACTIVE"
      },
      order: {
        contractId: harness.ids.contractId,
        customerId: harness.ids.customerId,
        id: harness.ids.orderId,
        orderNo: "SO-1",
        orderStatus: "ACTIVE",
        vehicleId: harness.ids.vehicleId
      },
      relatedWorkOrder: null,
      vehicle: {
        id: harness.ids.vehicleId,
        plateNo: "沪A00001",
        status: VehicleStatus.RETURNED,
        vehicleNo: "V-1",
        vin: "VIN-1"
      }
    });
    expect(harness.auditInputs).toHaveLength(2);
    expect(harness.auditInputs).toEqual([
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "asset_work_order",
        ipAddress: "127.0.0.1",
        module: "asset_operations",
        operatorId: harness.ids.actorId,
        userAgent: "vitest"
      }),
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "asset_work_order_event"
      })
    ]);
  });

  it("rejects cross-ID drift before the repository command or audit can write", async () => {
    const harness = createHarness();
    harness.tx.subscriptionOrder.findUnique.mockResolvedValue({
      contractId: harness.ids.contractId,
      customerId: harness.ids.customerId,
      deletedAt: null,
      id: harness.ids.orderId,
      orderNo: "SO-1",
      orderStatus: "ACTIVE",
      vehicleId: randomUUID()
    });

    await expect(
      harness.service.createWorkOrder(fullCreateCommand(harness), harness.context)
    ).rejects.toMatchObject({ response: { code: "ASSET_OPERATION_AUTHORITY_MISMATCH" } });
    expect(harness.sequence).not.toContain("repository-write");
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("rejects an order whose reciprocal contract pointer identifies another contract", async () => {
    const harness = createHarness();
    harness.tx.subscriptionOrder.findUnique.mockResolvedValue({
      contractId: randomUUID(),
      customerId: harness.ids.customerId,
      deletedAt: null,
      id: harness.ids.orderId,
      orderNo: "SO-1",
      orderStatus: "ACTIVE",
      vehicleId: harness.ids.vehicleId
    });

    await expect(
      harness.service.createWorkOrder(fullCreateCommand(harness), harness.context)
    ).rejects.toMatchObject({ response: { code: "ASSET_OPERATION_AUTHORITY_MISMATCH" } });
    expect(harness.repository.createWorkOrder).not.toHaveBeenCalled();
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("rejects order and contract customer drift when the command omits customer", async () => {
    const harness = createHarness();
    harness.tx.subscriptionOrder.findUnique.mockResolvedValue({
      contractId: harness.ids.contractId,
      customerId: randomUUID(),
      deletedAt: null,
      id: harness.ids.orderId,
      orderNo: "SO-1",
      orderStatus: "ACTIVE",
      vehicleId: harness.ids.vehicleId
    });

    await expect(
      harness.service.createWorkOrder(
        { ...fullCreateCommand(harness), customerId: null },
        harness.context
      )
    ).rejects.toMatchObject({ response: { code: "ASSET_OPERATION_AUTHORITY_MISMATCH" } });
    expect(harness.repository.createWorkOrder).not.toHaveBeenCalled();
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("keeps an omitted asset owner null instead of inferring the current owner", async () => {
    const harness = createHarness();
    const command = { ...fullCreateCommand(harness), assetOwnerId: null };

    const result = await harness.service.createWorkOrder(command, harness.context);

    expect(result.workOrder.assetOwnerId).toBeNull();
    expect(result.workOrder.authoritySnapshot).toMatchObject({ assetOwner: null });
    expect(harness.sequence).not.toContain("authority:vehicle_ownership_period");
  });

  it("does not duplicate audit rows for an exact repository replay", async () => {
    const harness = createHarness({ wrote: false });

    await harness.service.createWorkOrder(fullCreateCommand(harness), harness.context);

    expect(harness.auditInputs).toHaveLength(0);
  });

  it("checks cost-required pending-cost closure after the current-header lock and before writes", async () => {
    const harness = createHarness();
    Object.assign(harness.workOrder, {
      costConfirmationRequired: true,
      status: AssetWorkOrderStatus.PENDING_COST_CONFIRMATION,
      version: 3
    });

    await harness.service.transitionWorkOrder(
      {
        closeReason: "cost settled",
        detailSnapshot: { reason: "close" },
        expectedVersion: 3,
        occurredAt: NOW,
        solution: "completed",
        source: nextSource(harness, "cost-gated-close"),
        targetStatus: AssetWorkOrderStatus.CLOSED,
        workOrderId: harness.ids.workOrderId
      },
      harness.context
    );

    expect(harness.assetAccountingService.assertWorkOrderCostConfirmed).toHaveBeenCalledOnce();
    expect(harness.assetAccountingService.assertWorkOrderCostConfirmed).toHaveBeenCalledWith(
      harness.tx,
      harness.ids.workOrderId
    );
    expect(harness.sequence.indexOf("source-lock")).toBeLessThan(
      harness.sequence.indexOf("authority:asset_work_order")
    );
    expect(harness.sequence.indexOf("authority:asset_work_order")).toBeLessThan(
      harness.sequence.indexOf("cost-confirmation-gate")
    );
    expect(harness.sequence.indexOf("cost-confirmation-gate")).toBeLessThan(
      harness.sequence.indexOf("repository-transition")
    );
  });

  it.each([
    ["no-cost direct close", AssetWorkOrderStatus.PENDING_ACCEPTANCE, false, true],
    ["non-close transition", AssetWorkOrderStatus.PENDING_COST_CONFIRMATION, true, true],
    ["exact close replay", AssetWorkOrderStatus.CLOSED, true, false]
  ] as const)("does not run the cost gate for %s", async (_label, status, costRequired, wrote) => {
    const harness = createHarness({ wrote });
    Object.assign(harness.workOrder, {
      costConfirmationRequired: costRequired,
      status,
      version: status === AssetWorkOrderStatus.PENDING_ACCEPTANCE ? 2 : 3
    });

    await harness.service.transitionWorkOrder(
      {
        closeReason: "complete",
        detailSnapshot: { reason: "ungated" },
        expectedVersion: harness.workOrder.version,
        occurredAt: NOW,
        solution: "complete",
        source: nextSource(harness, `ungated-${status}`),
        targetStatus:
          status === AssetWorkOrderStatus.PENDING_COST_CONFIRMATION
            ? AssetWorkOrderStatus.CANCELLED
            : AssetWorkOrderStatus.CLOSED,
        workOrderId: harness.ids.workOrderId
      },
      harness.context
    );

    expect(harness.assetAccountingService.assertWorkOrderCostConfirmed).not.toHaveBeenCalled();
  });

  it.each([
    ["vehicle", "ASSET_OPERATION_VEHICLE_NOT_FOUND"],
    ["subscriptionOrder", "ASSET_OPERATION_ORDER_NOT_FOUND"],
    ["contract", "ASSET_OPERATION_CONTRACT_NOT_FOUND"],
    ["customer", "ASSET_OPERATION_CUSTOMER_NOT_FOUND"],
    ["assetOwner", "ASSET_OPERATION_ASSET_OWNER_NOT_FOUND"]
  ] as const)("rejects a non-live %s before a create write", async (model, code) => {
    const harness = createHarness();
    harness.tx[model].findUnique.mockResolvedValue(null as never);

    await expect(
      harness.service.createWorkOrder(fullCreateCommand(harness), harness.context)
    ).rejects.toMatchObject({ response: { code } });
    expect(harness.repository.createWorkOrder).not.toHaveBeenCalled();
  });

  it("revalidates the live header aggregate and evidence file before append", async () => {
    const staleHeader = createHarness();
    staleHeader.tx.customer.findUnique.mockResolvedValue({
      customerNo: "CU-1",
      deletedAt: NOW,
      id: staleHeader.ids.customerId,
      name: "Customer",
      status: "ACTIVE"
    } as never);
    await expect(
      staleHeader.service.appendNote(
        {
          note: "must not append",
          occurredAt: NOW,
          source: nextSource(staleHeader, "stale-header"),
          workOrderId: staleHeader.ids.workOrderId
        },
        staleHeader.context
      )
    ).rejects.toMatchObject({ response: { code: "ASSET_OPERATION_CUSTOMER_NOT_FOUND" } });
    expect(staleHeader.repository.appendNote).not.toHaveBeenCalled();

    const missingFile = createHarness();
    missingFile.tx.fileObject.findUnique.mockResolvedValue(null as never);
    await expect(
      missingFile.service.appendEvidence(
        {
          action: AssetWorkOrderEvidenceAction.ATTACH,
          capturedAt: NOW,
          captureMetadata: null,
          contentSha256: "a".repeat(64),
          eventId: null,
          evidenceType: AssetWorkOrderEvidenceType.PHOTO,
          fileId: missingFile.ids.fileId,
          occurredAt: NOW,
          source: nextSource(missingFile, "missing-file"),
          supersedesEvidenceId: null,
          workOrderId: missingFile.ids.workOrderId
        },
        missingFile.context
      )
    ).rejects.toMatchObject({ response: { code: "ASSET_WORK_ORDER_FILE_NOT_FOUND" } });
    expect(missingFile.repository.appendEvidence).not.toHaveBeenCalled();
  });

  it("audits every newly written command fact and event in the command transaction", async () => {
    const harness = createHarness();
    const cases = [
      {
        entityTypes: ["asset_work_order", "asset_work_order_event"],
        run: () =>
          harness.service.assignWorkOrder(
            {
              assignedUserId: harness.ids.actorId,
              detailSnapshot: { reason: "dispatch" },
              expectedVersion: 0,
              occurredAt: NOW,
              scheduledAt: null,
              slaDueAt: null,
              source: nextSource(harness, "assign"),
              workOrderId: harness.ids.workOrderId
            },
            harness.context
          )
      },
      {
        entityTypes: ["asset_work_order", "asset_work_order_event"],
        run: () =>
          harness.service.transitionWorkOrder(
            {
              closeReason: null,
              detailSnapshot: { reason: "start" },
              expectedVersion: 0,
              occurredAt: NOW,
              solution: null,
              source: nextSource(harness, "transition"),
              targetStatus: AssetWorkOrderStatus.IN_PROGRESS,
              workOrderId: harness.ids.workOrderId
            },
            harness.context
          )
      },
      {
        entityTypes: ["asset_work_order_event"],
        run: () =>
          harness.service.appendNote(
            {
              note: "field note",
              occurredAt: NOW,
              source: nextSource(harness, "note"),
              workOrderId: harness.ids.workOrderId
            },
            harness.context
          )
      },
      {
        entityTypes: ["asset_work_order_evidence", "asset_work_order_event"],
        run: () =>
          harness.service.appendEvidence(
            {
              action: AssetWorkOrderEvidenceAction.ATTACH,
              capturedAt: NOW,
              captureMetadata: { station: "A" },
              contentSha256: "a".repeat(64),
              eventId: null,
              evidenceType: AssetWorkOrderEvidenceType.PHOTO,
              fileId: harness.ids.fileId,
              occurredAt: NOW,
              source: nextSource(harness, "evidence"),
              supersedesEvidenceId: null,
              workOrderId: harness.ids.workOrderId
            },
            harness.context
          )
      },
      {
        entityTypes: ["vehicle_operational_restriction", "asset_work_order_event"],
        run: () =>
          harness.service.createRestriction(
            {
              conditionsSnapshot: { releaseCondition: "inspection" },
              evidenceSnapshot: { evidenceIds: [harness.ids.fileId] },
              occurredAt: NOW,
              restrictionType: VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT,
              scopes: [VehicleOperationalRestrictionScope.ALLOCATION],
              severity: VehicleOperationalRestrictionSeverity.BLOCKING,
              source: nextSource(harness, "restriction"),
              startedAt: NOW,
              vehicleId: harness.ids.vehicleId,
              workOrderId: harness.ids.workOrderId
            },
            harness.context
          )
      },
      {
        entityTypes: ["vehicle_operational_restriction", "asset_work_order_event"],
        run: () =>
          harness.service.releaseRestriction(
            {
              occurredAt: NOW,
              releaseReason: "inspection complete",
              releaseSnapshot: { evidenceIds: [harness.ids.fileId] },
              restrictionId: harness.ids.restrictionId,
              source: nextSource(harness, "release"),
              targetStatus: VehicleOperationalRestrictionStatus.RELEASED
            },
            {
              ...harness.context,
              permissions: ["vehicle_restriction:release"]
            }
          )
      }
    ];

    for (const item of cases) {
      harness.auditInputs.splice(0);
      await item.run();
      expect(
        harness.auditInputs.map((entry) => (entry as { entityType: string }).entityType)
      ).toEqual(item.entityTypes);
    }
  });

  it("captures the select-faithful full locked preimage for assignment and transition audits", async () => {
    const assignmentHarness = createHarness();

    await assignmentHarness.service.assignWorkOrder(
      {
        assignedUserId: assignmentHarness.ids.actorId,
        detailSnapshot: { reason: "dispatch" },
        expectedVersion: 0,
        occurredAt: NOW,
        scheduledAt: null,
        slaDueAt: null,
        source: nextSource(assignmentHarness, "assignment-before"),
        workOrderId: assignmentHarness.ids.workOrderId
      },
      assignmentHarness.context
    );

    expect((assignmentHarness.auditInputs[0] as { before: unknown }).before).toEqual(
      auditSnapshot(assignmentHarness.workOrder)
    );

    const transitionHarness = createHarness();
    await transitionHarness.service.transitionWorkOrder(
      {
        closeReason: null,
        detailSnapshot: { reason: "start" },
        expectedVersion: 0,
        occurredAt: NOW,
        solution: null,
        source: nextSource(transitionHarness, "transition-before"),
        targetStatus: AssetWorkOrderStatus.IN_PROGRESS,
        workOrderId: transitionHarness.ids.workOrderId
      },
      transitionHarness.context
    );

    expect((transitionHarness.auditInputs[0] as { before: unknown }).before).toEqual(
      auditSnapshot(transitionHarness.workOrder)
    );
  });

  it("locks an explicitly related work order as authority without inferring one", async () => {
    const harness = createHarness();
    (harness.workOrder as { relatedWorkOrderId: string | null }).relatedWorkOrderId = randomUUID();

    await harness.service.appendNote(
      {
        note: "related authority",
        occurredAt: NOW,
        source: nextSource(harness, "related-authority"),
        workOrderId: harness.ids.workOrderId
      },
      harness.context
    );

    expect(harness.sequence.filter((entry) => entry === "authority:asset_work_order")).toHaveLength(
      2
    );
  });

  it("locks the current mutable header exclusively NOWAIT while related authority stays shared", async () => {
    const harness = createHarness();
    const relatedWorkOrderId = randomUUID();
    (harness.workOrder as { relatedWorkOrderId: string | null }).relatedWorkOrderId =
      relatedWorkOrderId;

    await harness.service.appendNote(
      {
        note: "exclusive current header",
        occurredAt: NOW,
        source: nextSource(harness, "exclusive-current-header"),
        workOrderId: harness.ids.workOrderId
      },
      harness.context
    );

    const workOrderLocks = harness.lockQueries.filter(({ sql }) =>
      sql.includes('FROM "asset_work_order"')
    );
    expect(workOrderLocks.map(({ id }) => id)).toEqual(
      [harness.ids.workOrderId, relatedWorkOrderId].sort()
    );
    expect(workOrderLocks.find(({ id }) => id === harness.ids.workOrderId)?.sql).toContain(
      "FOR UPDATE NOWAIT"
    );
    expect(workOrderLocks.find(({ id }) => id === relatedWorkOrderId)?.sql).toContain(
      "FOR SHARE NOWAIT"
    );
  });

  it.each([
    VehicleOperationalRestrictionType.LEGAL_HOLD,
    VehicleOperationalRestrictionType.OWNERSHIP_EXCEPTION,
    VehicleOperationalRestrictionType.EVIDENCE_EXCEPTION
  ])("requires approve_release for high-risk %s without writing", async (restrictionType) => {
    const harness = createHarness({ restrictionType });

    await expect(
      harness.service.releaseRestriction(
        {
          occurredAt: NOW,
          releaseReason: "approved evidence",
          releaseSnapshot: { evidenceIds: [harness.ids.fileId] },
          restrictionId: harness.ids.restrictionId,
          source: nextSource(harness, "high-risk-release"),
          targetStatus: VehicleOperationalRestrictionStatus.RELEASED
        },
        { ...harness.context, permissions: ["vehicle_restriction:release"] }
      )
    ).rejects.toMatchObject({
      response: { code: "VEHICLE_RESTRICTION_RELEASE_FORBIDDEN" },
      status: 403
    });
    expect(harness.repository.releaseRestriction).not.toHaveBeenCalled();
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("rejects a restriction whose linked work order belongs to another vehicle before writing", async () => {
    const harness = createHarness();

    await expect(
      harness.service.createRestriction(
        {
          conditionsSnapshot: { releaseCondition: "inspection" },
          evidenceSnapshot: null,
          occurredAt: NOW,
          restrictionType: VehicleOperationalRestrictionType.REINSPECTION_PENDING,
          scopes: [VehicleOperationalRestrictionScope.INVENTORY_RELEASE],
          severity: VehicleOperationalRestrictionSeverity.BLOCKING,
          source: nextSource(harness, "wrong-work-order-vehicle"),
          startedAt: NOW,
          vehicleId: randomUUID(),
          workOrderId: harness.ids.workOrderId
        },
        harness.context
      )
    ).rejects.toMatchObject({ response: { code: "ASSET_OPERATION_AUTHORITY_MISMATCH" } });
    expect(harness.repository.createRestriction).not.toHaveBeenCalled();
  });

  it("rejects release when the linked work order belongs to another live vehicle", async () => {
    const harness = createHarness();
    harness.restriction.vehicleId = randomUUID();

    await expect(
      harness.service.releaseRestriction(
        {
          occurredAt: NOW,
          releaseReason: "must not release",
          releaseSnapshot: { evidenceIds: [harness.ids.fileId] },
          restrictionId: harness.ids.restrictionId,
          source: nextSource(harness, "release-wrong-work-order-vehicle"),
          targetStatus: VehicleOperationalRestrictionStatus.RELEASED
        },
        { ...harness.context, permissions: ["vehicle_restriction:release"] }
      )
    ).rejects.toMatchObject({ response: { code: "ASSET_OPERATION_AUTHORITY_MISMATCH" } });
    expect(harness.repository.releaseRestriction).not.toHaveBeenCalled();
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("allows high-risk release only with approve_release and audits it once", async () => {
    const harness = createHarness({
      restrictionType: VehicleOperationalRestrictionType.LEGAL_HOLD
    });

    await harness.service.releaseRestriction(
      {
        occurredAt: NOW,
        releaseReason: "legal clearance",
        releaseSnapshot: { approvalId: randomUUID() },
        restrictionId: harness.ids.restrictionId,
        source: nextSource(harness, "approved-high-risk-release"),
        targetStatus: VehicleOperationalRestrictionStatus.RELEASED
      },
      { ...harness.context, permissions: ["vehicle_restriction:approve_release"] }
    );

    expect(harness.auditInputs).toHaveLength(2);
  });

  it("returns an ordered, sanitized work-order projection with effective evidence and restrictions", async () => {
    const harness = createHarness();
    const projection = await harness.service.getWorkOrderDetail(harness.ids.workOrderId);

    expect(projection).toMatchObject({
      evidence: {
        all: [{ id: harness.ids.evidenceId }, { id: harness.ids.supersedingEvidenceId }],
        effective: [{ id: harness.ids.supersedingEvidenceId }]
      },
      events: [{ sequence: 1 }, { sequence: 2 }],
      restrictions: {
        active: [{ id: harness.ids.restrictionId }],
        all: [{ id: harness.ids.restrictionId }, { id: harness.ids.releasedRestrictionId }]
      },
      source: harness.source,
      specialistDeepLink: `/handover-work-orders/${harness.source.id}`
    });
    expect(projection.events.at(0)?.detailSnapshot).toEqual({ note: "public" });
    expect(projection.restrictions.active.at(0)?.conditionsSnapshot).toEqual({
      condition: "inspect"
    });
    expect(projection.restrictions.active.at(0)).toMatchObject({
      source: harness.source,
      specialistDeepLink: `/handover-work-orders/${harness.source.id}`
    });
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("returns JSON-safe decimal file sizes in all and effective evidence", async () => {
    const harness = createHarness();

    const projection = await harness.service.getWorkOrderDetail(harness.ids.workOrderId);

    expect(() => JSON.stringify(projection)).not.toThrow();
    expect(projection.evidence.all.map(({ fileSizeBytes }) => fileSizeBytes)).toEqual(["12", "13"]);
    expect(projection.evidence.effective.map(({ fileSizeBytes }) => fileSizeBytes)).toEqual(["13"]);
  });

  it("projects vehicle work orders, restrictions, and deterministic availability without writes", async () => {
    const harness = createHarness();

    const [workOrders, restrictions, availability] = await Promise.all([
      harness.service.listVehicleWorkOrders(harness.ids.vehicleId),
      harness.service.listVehicleRestrictions(harness.ids.vehicleId),
      harness.service.getVehicleAvailability(
        harness.ids.vehicleId,
        VehicleAvailabilityPurpose.ALLOCATION
      )
    ]);

    expect(workOrders[0]).toMatchObject({
      source: harness.source,
      specialistDeepLink: `/handover-work-orders/${harness.source.id}`
    });
    expect(restrictions).toMatchObject({
      active: [{ id: harness.ids.restrictionId }],
      all: [{ id: harness.ids.restrictionId }, { id: harness.ids.releasedRestrictionId }]
    });
    expect(availability).toEqual({
      available: false,
      purpose: VehicleAvailabilityPurpose.ALLOCATION,
      reasons: [
        {
          code: "ACTIVE_OPERATIONAL_RESTRICTION",
          restrictionId: harness.ids.restrictionId,
          sourceId: harness.source.id,
          sourceType: harness.source.type,
          workOrderId: harness.ids.workOrderId
        },
        { code: "LIFECYCLE_STATUS_BLOCKED" },
        { code: "SALE_PRICE_NOT_EFFECTIVE" },
        { code: "SALE_PRICE_NOT_POSITIVE" }
      ]
    });
    expect(harness.auditInputs).toHaveLength(0);
  });

  it("keeps the real lifecycle status by default and overrides only that evaluator field", async () => {
    const harness = createHarness();
    const snapshot = {
      activeRestrictions: [],
      activeSubscriptionPeriods: [],
      vehicle: {
        currentSalePriceAmount: 100n,
        deletedAt: null,
        id: harness.ids.vehicleId,
        salePriceStatus: "EFFECTIVE" as const,
        status: VehicleStatus.REVIEW_RESERVED
      }
    };
    vi.mocked(harness.repository.loadAvailabilitySnapshot).mockResolvedValue(snapshot);

    await expect(
      harness.service.assertVehicleAvailable(
        harness.tx as never,
        harness.ids.vehicleId,
        VehicleAvailabilityPurpose.ALLOCATION,
        NOW
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "VEHICLE_NOT_AVAILABLE",
        reasons: [{ code: "LIFECYCLE_STATUS_BLOCKED" }]
      })
    });

    await expect(
      harness.service.assertVehicleAvailable(
        harness.tx as never,
        harness.ids.vehicleId,
        VehicleAvailabilityPurpose.ALLOCATION,
        NOW,
        VehicleStatus.AVAILABLE
      )
    ).resolves.toEqual({
      available: true,
      purpose: VehicleAvailabilityPurpose.ALLOCATION,
      reasons: []
    });
    expect(snapshot.vehicle.status).toBe(VehicleStatus.REVIEW_RESERVED);
  });

  it.each([
    {
      label: "missing vehicle",
      snapshot: { activeRestrictions: [], activeSubscriptionPeriods: [], vehicle: null },
      expectedCode: "VEHICLE_NOT_FOUND"
    },
    {
      label: "deleted vehicle",
      snapshot: {
        activeRestrictions: [],
        activeSubscriptionPeriods: [],
        vehicle: {
          currentSalePriceAmount: 100n,
          deletedAt: NOW,
          id: "vehicle-1",
          salePriceStatus: "EFFECTIVE",
          status: VehicleStatus.REVIEW_RESERVED
        }
      },
      expectedCode: "VEHICLE_DELETED"
    },
    {
      label: "invalid price",
      snapshot: {
        activeRestrictions: [],
        activeSubscriptionPeriods: [],
        vehicle: {
          currentSalePriceAmount: 0n,
          deletedAt: null,
          id: "vehicle-1",
          salePriceStatus: "PENDING_INITIALIZE",
          status: VehicleStatus.REVIEW_RESERVED
        }
      },
      expectedCode: "SALE_PRICE_NOT_EFFECTIVE"
    },
    {
      label: "open occupancy",
      snapshot: {
        activeRestrictions: [],
        activeSubscriptionPeriods: [{ id: "period-1", orderId: "order-1" }],
        vehicle: {
          currentSalePriceAmount: 100n,
          deletedAt: null,
          id: "vehicle-1",
          salePriceStatus: "EFFECTIVE",
          status: VehicleStatus.REVIEW_RESERVED
        }
      },
      expectedCode: "ACTIVE_SUBSCRIPTION_PERIOD"
    },
    {
      label: "blocking restriction",
      snapshot: {
        activeRestrictions: [
          {
            id: "restriction-1",
            restrictionType: VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT,
            scopes: [VehicleOperationalRestrictionScope.ALLOCATION],
            severity: VehicleOperationalRestrictionSeverity.BLOCKING,
            sourceId: "source-1",
            sourceKey: "source-key-1",
            sourceType: "TEST",
            workOrderId: null
          }
        ],
        activeSubscriptionPeriods: [],
        vehicle: {
          currentSalePriceAmount: 100n,
          deletedAt: null,
          id: "vehicle-1",
          salePriceStatus: "EFFECTIVE",
          status: VehicleStatus.REVIEW_RESERVED
        }
      },
      expectedCode: "ACTIVE_OPERATIONAL_RESTRICTION"
    }
  ])("does not let a lifecycle override mask $label", async ({ expectedCode, snapshot }) => {
    const harness = createHarness();
    vi.mocked(harness.repository.loadAvailabilitySnapshot).mockResolvedValueOnce(snapshot as never);

    const error = await harness.service
      .assertVehicleAvailable(
        harness.tx as never,
        harness.ids.vehicleId,
        VehicleAvailabilityPurpose.ALLOCATION,
        NOW,
        VehicleStatus.AVAILABLE
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      reasons: expect.arrayContaining([expect.objectContaining({ code: expectedCode })])
    });
  });
});

function nextSource(harness: ReturnType<typeof createHarness>, label: string) {
  const id = randomUUID();
  return { id, key: `task-4:${label}:${id}`, type: "STAGE1C_TASK4_TEST" };
}

function auditSnapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function fullCreateCommand(harness: ReturnType<typeof createHarness>) {
  return {
    assetOwnerId: harness.ids.assetOwnerId,
    contractId: harness.ids.contractId,
    costConfirmationRequired: false,
    customerId: harness.ids.customerId,
    description: "return inspection",
    metadata: { request: "task-4" },
    occurredAt: NOW,
    orderId: harness.ids.orderId,
    priority: AssetWorkOrderPriority.NORMAL,
    relatedWorkOrderId: null,
    source: harness.source,
    vehicleId: harness.ids.vehicleId,
    workOrderType: AssetWorkOrderType.RECONDITIONING
  };
}

function createHarness(
  options: { restrictionType?: VehicleOperationalRestrictionType; wrote?: boolean } = {}
) {
  const ids = {
    actorId: randomUUID(),
    assetOwnerId: randomUUID(),
    contractId: randomUUID(),
    customerId: randomUUID(),
    evidenceId: randomUUID(),
    eventId: randomUUID(),
    fileId: randomUUID(),
    orderId: randomUUID(),
    releasedRestrictionId: randomUUID(),
    restrictionId: randomUUID(),
    supersedingEvidenceId: randomUUID(),
    vehicleId: randomUUID(),
    workOrderId: randomUUID()
  };
  const source = {
    id: randomUUID(),
    key: `task-4:${randomUUID()}`,
    type: "VEHICLE_HANDOVER_WORK_ORDER"
  };
  const sequence: string[] = [];
  const lockQueries: Array<{ id: string | undefined; sql: string }> = [];
  const auditInputs: unknown[] = [];
  const workOrder = {
    acceptedAt: null,
    assetOwnerId: ids.assetOwnerId,
    authoritySnapshot: {},
    assignedUserId: null,
    cancelledAt: null,
    closeReason: null,
    closedAt: null,
    contractId: ids.contractId,
    costConfirmationRequired: false,
    costConfirmedAt: null,
    createSourceId: source.id,
    createSourceKey: source.key,
    createSourceType: source.type,
    createdAt: NOW,
    createdBy: ids.actorId,
    customerId: ids.customerId,
    description: "return inspection",
    id: ids.workOrderId,
    metadata: {},
    orderId: ids.orderId,
    priority: AssetWorkOrderPriority.NORMAL,
    relatedWorkOrderId: null,
    scheduledAt: null,
    slaDueAt: null,
    solution: null,
    startedAt: null,
    status: AssetWorkOrderStatus.PENDING,
    updatedAt: NOW,
    updatedBy: ids.actorId,
    vehicleId: ids.vehicleId,
    version: 0,
    workOrderNo: "AWO-1",
    workOrderType: AssetWorkOrderType.RECONDITIONING
  };
  const event = {
    actorId: ids.actorId,
    afterStatus: AssetWorkOrderStatus.PENDING,
    beforeStatus: null,
    detailSnapshot: { __assetOperationCommandV1: { internal: true }, note: "public" },
    eventType: AssetWorkOrderEventType.CREATED,
    id: ids.eventId,
    occurredAt: NOW,
    recordedAt: NOW,
    sequence: 1,
    sourceId: source.id,
    sourceKey: source.key,
    sourceType: source.type,
    workOrderId: ids.workOrderId
  };
  const activeRestriction = {
    conditionsSnapshot: { __assetOperationCommandV1: { internal: true }, condition: "inspect" },
    createdAt: NOW,
    createdBy: ids.actorId,
    evidenceSnapshot: null,
    id: ids.restrictionId,
    releaseReason: null,
    releaseSnapshot: null,
    releaseSourceId: null,
    releaseSourceKey: null,
    releaseSourceType: null,
    releasedAt: null,
    releasedBy: null,
    restrictionType:
      options.restrictionType ?? VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT,
    scopes: [VehicleOperationalRestrictionScope.ALLOCATION],
    severity: VehicleOperationalRestrictionSeverity.BLOCKING,
    startSourceId: source.id,
    startSourceKey: source.key,
    startSourceType: source.type,
    startedAt: NOW,
    status: VehicleOperationalRestrictionStatus.ACTIVE,
    updatedAt: NOW,
    updatedBy: ids.actorId,
    vehicleId: ids.vehicleId,
    workOrderId: ids.workOrderId
  };
  const releasedRestriction = {
    ...activeRestriction,
    id: ids.releasedRestrictionId,
    releaseReason: "done",
    releaseSnapshot: { __assetOperationCommandV1: { internal: true }, evidence: "ok" },
    releaseSourceId: randomUUID(),
    releaseSourceKey: "released",
    releaseSourceType: "STAGE1C_TASK4_TEST",
    releasedAt: NOW,
    releasedBy: ids.actorId,
    status: VehicleOperationalRestrictionStatus.RELEASED
  };
  const evidence = [
    {
      action: AssetWorkOrderEvidenceAction.ATTACH,
      actorId: ids.actorId,
      capturedAt: NOW,
      captureMetadata: null,
      contentSha256: "a".repeat(64),
      eventId: null,
      evidenceType: AssetWorkOrderEvidenceType.PHOTO,
      fileBucket: "asset-evidence",
      fileId: ids.fileId,
      fileMimeType: "image/jpeg",
      fileObjectKey: "task-4/photo.jpg",
      fileSizeBytes: 12n,
      id: ids.evidenceId,
      recordedAt: NOW,
      sourceId: randomUUID(),
      sourceKey: "evidence-1",
      sourceType: "STAGE1C_TASK4_TEST",
      supersedesEvidenceId: null,
      workOrderId: ids.workOrderId
    },
    {
      action: AssetWorkOrderEvidenceAction.SUPERSEDE,
      actorId: ids.actorId,
      capturedAt: NOW,
      captureMetadata: null,
      contentSha256: "b".repeat(64),
      eventId: null,
      evidenceType: AssetWorkOrderEvidenceType.PHOTO,
      fileBucket: "asset-evidence",
      fileId: ids.fileId,
      fileMimeType: "image/jpeg",
      fileObjectKey: "task-4/photo-v2.jpg",
      fileSizeBytes: 13n,
      id: ids.supersedingEvidenceId,
      recordedAt: new Date(NOW.getTime() + 1),
      sourceId: randomUUID(),
      sourceKey: "evidence-2",
      sourceType: "STAGE1C_TASK4_TEST",
      supersedesEvidenceId: ids.evidenceId,
      workOrderId: ids.workOrderId
    }
  ];
  const tx = {
    $queryRaw: vi.fn(async (query: { strings: readonly string[]; values?: readonly unknown[] }) => {
      const sql = query.strings.join("?");
      const match = sql.match(/FROM "([a-z_]+)"/);
      if (match) {
        sequence.push(`authority:${match[1]}`);
        lockQueries.push({
          id: query.values?.find((value): value is string => typeof value === "string"),
          sql
        });
      }
      return [{ id: randomUUID() }];
    }),
    assetOwner: {
      findUnique: vi.fn(async () => ({
        id: ids.assetOwnerId,
        name: "Platform Owner",
        ownerNo: "AO-1",
        ownerType: "PLATFORM",
        status: "ACTIVE"
      }))
    },
    assetWorkOrder: {
      findUnique: vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) =>
        select
          ? Object.fromEntries(
              Object.entries(select)
                .filter(([, included]) => included)
                .map(([key]) => [key, workOrder[key as keyof typeof workOrder]])
            )
          : structuredClone(workOrder)
      )
    },
    contract: {
      findUnique: vi.fn(async () => ({
        contractNo: "CT-1",
        customerId: ids.customerId,
        deletedAt: null,
        id: ids.contractId,
        orderId: ids.orderId,
        status: "ACTIVE"
      }))
    },
    customer: {
      findUnique: vi.fn(async () => ({
        customerNo: "CU-1",
        deletedAt: null,
        id: ids.customerId,
        name: "Customer",
        status: "ACTIVE"
      }))
    },
    fileObject: {
      findUnique: vi.fn(async () => ({
        bucket: "asset-evidence",
        id: ids.fileId,
        mimeType: "image/jpeg",
        objectKey: "task-4/photo.jpg",
        originalName: "photo.jpg",
        sizeBytes: 12n
      }))
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => ({
        contractId: ids.contractId,
        customerId: ids.customerId,
        deletedAt: null,
        id: ids.orderId,
        orderNo: "SO-1",
        orderStatus: "ACTIVE",
        vehicleId: ids.vehicleId
      }))
    },
    user: {
      findUnique: vi.fn(async () => ({
        deletedAt: null,
        id: ids.actorId,
        name: "Operator",
        status: "ACTIVE",
        username: "operator"
      }))
    },
    vehicle: {
      findUnique: vi.fn(async () => ({
        deletedAt: null,
        id: ids.vehicleId,
        plateNo: "沪A00001",
        status: VehicleStatus.RETURNED,
        vehicleNo: "V-1",
        vin: "VIN-1"
      }))
    },
    vehicleOperationalRestriction: {
      findMany: vi.fn(async () => [activeRestriction, releasedRestriction]),
      findUnique: vi.fn(async () => activeRestriction)
    }
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx))
  } as unknown as PrismaService;
  const repository = {
    appendEvidence: vi.fn(async () => ({
      evidence: evidence[0],
      event,
      workOrder,
      wrote: options.wrote ?? true
    })),
    appendNote: vi.fn(async () => ({ event, workOrder, wrote: options.wrote ?? true })),
    assignWorkOrder: vi.fn(async () => ({ event, workOrder, wrote: options.wrote ?? true })),
    createWorkOrder: vi.fn(async (_tx, command) => {
      sequence.push("repository-write");
      const createdWorkOrder = {
        ...command,
        acceptedAt: null,
        assignedUserId: null,
        cancelledAt: null,
        closeReason: null,
        closedAt: null,
        costConfirmedAt: null,
        createSourceId: command.source.id,
        createSourceKey: command.source.key,
        createSourceType: command.source.type,
        createdAt: NOW,
        createdBy: command.actorId,
        id: ids.workOrderId,
        scheduledAt: null,
        slaDueAt: null,
        solution: null,
        startedAt: null,
        status: AssetWorkOrderStatus.PENDING,
        updatedAt: NOW,
        updatedBy: command.actorId,
        version: 0,
        workOrderNo: "AWO-1"
      };
      return {
        event: { ...event, sourceId: command.source.id, sourceKey: command.source.key },
        workOrder: createdWorkOrder,
        wrote: options.wrote ?? true
      };
    }),
    createRestriction: vi.fn(async () => ({
      event,
      restriction: activeRestriction,
      workOrder,
      wrote: options.wrote ?? true
    })),
    getWorkOrderDetail: vi.fn(async () => ({
      evidence,
      events: [{ ...event, sequence: 2 }, event],
      restrictions: [activeRestriction, releasedRestriction],
      workOrder
    })),
    listWorkOrdersByVehicle: vi.fn(async () => [workOrder]),
    lockCallerOwnedCreateAuthority: vi.fn(async (_tx, command) => {
      for (const table of [
        command.orderId ? "subscription_order" : null,
        "vehicle",
        command.contractId ? "contract" : null,
        command.relatedWorkOrderId ? "asset_work_order" : null,
        command.assetOwnerId ? "asset_owner" : null,
        command.customerId ? "customer" : null
      ]) {
        if (table) sequence.push(`authority:${table}`);
      }
      return Object.freeze({});
    }),
    loadAvailabilitySnapshot: vi.fn(async () => ({
      activeRestrictions: [
        {
          id: activeRestriction.id,
          restrictionType: activeRestriction.restrictionType,
          scopes: activeRestriction.scopes,
          severity: activeRestriction.severity,
          sourceId: activeRestriction.startSourceId,
          sourceKey: activeRestriction.startSourceKey,
          sourceType: activeRestriction.startSourceType,
          workOrderId: activeRestriction.workOrderId
        }
      ],
      activeSubscriptionPeriods: [],
      vehicle: {
        currentSalePriceAmount: null,
        deletedAt: null,
        id: ids.vehicleId,
        salePriceStatus: "PENDING_INITIALIZE",
        status: VehicleStatus.RETURNED
      }
    })),
    lockSourceOwnership: vi.fn(async () => {
      sequence.push("source-lock");
    }),
    prepareCallerOwnedCommand: vi.fn(async () => {
      sequence.push("source-lock");
      return Object.freeze({});
    }),
    lockWorkOrderForCommand: vi.fn(
      async (client: typeof tx, workOrderId: string, authorityRows: readonly unknown[]) => {
        const realRepository = new AssetOperationsRepository();
        return realRepository.lockWorkOrderForCommand(
          client as never,
          workOrderId,
          authorityRows as never
        );
      }
    ),
    releaseRestriction: vi.fn(async () => ({
      event,
      restriction: { ...activeRestriction, status: VehicleOperationalRestrictionStatus.RELEASED },
      workOrder,
      wrote: options.wrote ?? true
    })),
    transitionWorkOrder: vi.fn(async () => {
      sequence.push("repository-transition");
      return { event, workOrder, wrote: options.wrote ?? true };
    })
  } as unknown as AssetOperationsRepository;
  const auditService = {
    write: vi.fn(async (input: unknown) => {
      auditInputs.push(input);
    })
  } as unknown as AuditService;
  const assetAccountingService = {
    assertWorkOrderCostConfirmed: vi.fn(async () => {
      sequence.push("cost-confirmation-gate");
      return true;
    })
  } as unknown as AssetAccountingService;
  const context = {
    actorId: ids.actorId,
    ipAddress: "127.0.0.1",
    permissions: ["asset_work_order:manage"],
    userAgent: "vitest"
  };
  return {
    assetAccountingService,
    auditInputs,
    context,
    ids,
    lockQueries,
    repository,
    restriction: activeRestriction,
    sequence,
    service: new AssetOperationsService(prisma, repository, auditService, assetAccountingService),
    source,
    tx,
    workOrder
  };
}

function createRealRepositoryCreateHarness() {
  const base = createHarness();
  const authorityTables: string[] = [];
  const sourceLocks: string[] = [];
  const tx = base.tx as unknown as Prisma.TransactionClient & {
    $queryRaw: (query: Prisma.Sql) => Promise<unknown[]>;
  };
  const mutableTx = tx as unknown as Record<string, unknown>;
  mutableTx.$queryRaw = vi.fn(async (query: Prisma.Sql) => {
    const sql = query.strings.join("?");
    if (sql.includes("current_setting('transaction_isolation')")) {
      return [{ isolationLevel: "read committed", transactionId: "one-pass-tx" }];
    }
    if (sql.includes("txid_current()")) {
      return [{ transactionId: "one-pass-tx" }];
    }
    if (sql.includes("transaction_timestamp()")) return [{ transactionNow: NOW }];
    if (sql.includes("pg_advisory_xact_lock")) {
      if (String(query.values[0]).includes("source-ownership")) {
        sourceLocks.push(String(query.values[0]));
      }
      return [{ locked: true }];
    }
    const table = sql.match(/FROM "([a-z_]+)"/)?.[1];
    if (table) authorityTables.push(table);
    return [{ id: query.values.find((value) => typeof value === "string") ?? randomUUID() }];
  });
  mutableTx.assetWorkOrder = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...base.workOrder,
      ...data,
      id: base.ids.workOrderId
    })),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      "workOrderNo" in where ? null : base.workOrder
    )
  };
  mutableTx.assetWorkOrderEvent = {
    aggregate: vi.fn(async () => ({ _max: { sequence: null } })),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: base.ids.eventId,
      recordedAt: NOW
    })),
    findFirst: vi.fn(async () => null)
  };
  mutableTx.vehicleOperationalRestriction = {
    findFirst: vi.fn(async () => null)
  };
  const auditService = {
    write: vi.fn(async () => undefined)
  } as unknown as AuditService;
  const repository = new AssetOperationsRepository(() => "AWO-ONEPASS");
  const command = fullCreateCommand(base);
  return {
    authorityTables,
    command,
    context: base.context,
    service: new AssetOperationsService(
      {} as PrismaService,
      repository,
      auditService,
      base.assetAccountingService
    ),
    sourceLocks,
    tx
  };
}
