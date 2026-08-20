import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException
} from "@nestjs/common";
import { AuditAction, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { AuditService } from "../src/audit/audit.service";
import {
  type AssetAccountingApprovalCommandOutcome,
  type AssetAccountingCostCommandOutcome,
  type BusinessExceptionSubjectIdentity,
  type DecideExceptionApprovalCommand,
  type ExpireExceptionApprovalCommand,
  type RequestExceptionApprovalCommand,
  type RequireCurrentApprovedExceptionCommand
} from "../src/asset-accounting/asset-accounting.repository";
import {
  ASSET_ACCOUNTING_PERMISSION,
  ASSET_ACCOUNTING_SERVICE_CODE,
  AssetAccountingService,
  type AssetAccountingCommandContext,
  type BusinessExceptionAuthorityResolver
} from "../src/asset-accounting/asset-accounting.service";
import type {
  BusinessExceptionApprovalSnapshot,
  VehicleCostLedgerEntrySnapshot
} from "../src/asset-accounting/asset-accounting.types";

const IDS = {
  actor: "00000000-0000-4000-8000-000000000101",
  approval: "00000000-0000-4000-8000-000000000102",
  decider: "00000000-0000-4000-8000-000000000103",
  entry: "00000000-0000-4000-8000-000000000104",
  order: "00000000-0000-4000-8000-000000000105",
  source: "00000000-0000-4000-8000-000000000106",
  vehicle: "00000000-0000-4000-8000-000000000107",
  workOrder: "00000000-0000-4000-8000-000000000108"
} as const;

const CONFIRMED_AT = new Date("2026-08-20T10:00:00.000Z");
const OCCURRED_ON = new Date("2026-08-19T00:00:00.000Z");

describe("AssetAccountingService", () => {
  it("requires an authenticated actor, the exact plan permission, and one matching source header", async () => {
    const harness = serviceHarness();
    const command = appendServiceCommand("guarded-append");

    await expectServiceCode(
      harness.service.appendCost(command, context(null, ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM)),
      ForbiddenException,
      ASSET_ACCOUNTING_SERVICE_CODE.AUTHENTICATION_REQUIRED
    );
    await expectServiceCode(
      harness.service.appendCost(command, context(IDS.actor, "unrelated:permission")),
      ForbiddenException,
      ASSET_ACCOUNTING_SERVICE_CODE.PERMISSION_REQUIRED
    );
    await expectServiceCode(
      harness.service.appendCost(command, {
        ...context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM),
        idempotencyKey: [command.source.key]
      }),
      BadRequestException,
      ASSET_ACCOUNTING_SERVICE_CODE.IDEMPOTENCY_KEY_INVALID
    );
    await expectServiceCode(
      harness.service.appendCost(command, {
        ...context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM),
        idempotencyKey: "different-key"
      }),
      BadRequestException,
      ASSET_ACCOUNTING_SERVICE_CODE.IDEMPOTENCY_KEY_MISMATCH
    );
    await expectServiceCode(
      harness.service.appendCost(
        { ...command, source: { ...command.source, type: " " } },
        context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM)
      ),
      BadRequestException,
      ASSET_ACCOUNTING_SERVICE_CODE.INVALID_SOURCE
    );

    expect(harness.transactions).toHaveLength(0);
    expect(harness.repository.operations).toHaveLength(0);
  });

  it("runs cost commands at READ COMMITTED, emits one exact transaction-local audit, and audits replay zero", async () => {
    const harness = serviceHarness();
    const append = appendServiceCommand("audited-append");
    const requestContext = context(
      IDS.actor,
      ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM,
      append.source.key
    );

    const created = await harness.service.appendCost(append, requestContext);
    harness.repository.appendOutcome = { outcome: costEntry(), wrote: false };
    const replay = await harness.service.appendCost(append, requestContext);

    expect(created).toEqual(publicCostEntry());
    expect(replay).toEqual(created);
    expect(created).not.toHaveProperty("wrote");
    expect(created).not.toHaveProperty("receipt");
    expect(harness.transactions).toEqual([
      Prisma.TransactionIsolationLevel.ReadCommitted,
      Prisma.TransactionIsolationLevel.ReadCommitted
    ]);
    expect(harness.repository.lastAppendActor).toBe(IDS.actor);
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]).toEqual({
      client: harness.tx,
      input: {
        action: AuditAction.CREATE,
        after: {
          fact: publicCostEntry(),
          permission: ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM,
          reason: "Confirmed ACTUAL_COST vehicle cost fact.",
          requestContext: {
            idempotencyKey: append.source.key,
            ipAddress: "203.0.113.8",
            requestId: "request-asset-accounting",
            userAgent: "asset-accounting-test"
          },
          snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          source: append.source
        },
        before: undefined,
        entityId: IDS.entry,
        entityType: "vehicle_cost_ledger_entry",
        ipAddress: "203.0.113.8",
        module: "asset_accounting",
        operatorId: IDS.actor,
        userAgent: "asset-accounting-test"
      }
    });
  });

  it("uses the reverse permission and keeps source ownership inside the repository boundary", async () => {
    const harness = serviceHarness();
    harness.repository.reverseOutcome = {
      outcome: {
        ...costEntry(),
        amountCents: -100n,
        entryKind: "REVERSAL",
        id: randomUUID(),
        reversalOfEntryId: IDS.entry
      },
      wrote: true
    };
    const command = {
      confirmedAt: new Date("2026-08-20T11:00:00.000Z"),
      originalEntryId: IDS.entry,
      source: source("audited-reverse")
    };

    const reversed = await harness.service.reverseCost(
      command,
      context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.COST_REVERSE, command.source.key)
    );

    expect(reversed).toMatchObject({ amountCents: "-100", entryKind: "REVERSAL" });
    expect(harness.repository.operations.slice(0, 1)).toEqual(["repository-reverse"]);
    expect(harness.audits[0]?.input).toMatchObject({
      action: AuditAction.CREATE,
      after: {
        permission: ASSET_ACCOUNTING_PERMISSION.COST_REVERSE,
        reason: `Reversed vehicle cost fact ${IDS.entry}.`,
        source: command.source
      },
      entityType: "vehicle_cost_ledger_entry"
    });
  });

  it("returns JSON-safe reads and summaries without private repository envelopes", async () => {
    const harness = serviceHarness();
    const readContext = context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.COST_VIEW, undefined);

    await expect(harness.service.getEntry(IDS.entry, readContext)).resolves.toEqual(
      publicCostEntry()
    );
    await expect(harness.service.listVehicleEntries(IDS.vehicle, readContext)).resolves.toEqual([
      publicCostEntry()
    ]);
    await expect(harness.service.listOrderEntries(IDS.order, readContext)).resolves.toEqual([
      publicCostEntry()
    ]);
    await expect(harness.service.listWorkOrderEntries(IDS.workOrder, readContext)).resolves.toEqual(
      [publicCostEntry()]
    );
    await expect(
      harness.service.summarizeOrderCostFacts(IDS.order, readContext)
    ).resolves.toMatchObject({
      byActionType: { ACTUAL_COST: { amountCents: "100", count: 1 } },
      totalAmountCents: "100"
    });

    harness.repository.entry = null;
    await expectServiceCode(
      harness.service.getEntry(IDS.entry, readContext),
      NotFoundException,
      ASSET_ACCOUNTING_SERVICE_CODE.COST_ENTRY_NOT_FOUND
    );
  });

  it("requires an unreversed ACTUAL_COST only when the work order requires cost confirmation", async () => {
    const harness = serviceHarness();
    harness.workOrder.costConfirmationRequired = true;
    harness.repository.entries = [
      costEntry(),
      {
        ...costEntry(),
        amountCents: -100n,
        entryKind: "REVERSAL",
        id: randomUUID(),
        reversalOfEntryId: IDS.entry
      }
    ];

    await expectServiceCode(
      harness.service.assertWorkOrderCostConfirmed(harness.tx, IDS.workOrder),
      ConflictException,
      ASSET_ACCOUNTING_SERVICE_CODE.WORK_ORDER_COST_NOT_CONFIRMED
    );
    harness.repository.entries = [costEntry()];
    await expect(
      harness.service.assertWorkOrderCostConfirmed(harness.tx, IDS.workOrder)
    ).resolves.toBe(true);

    harness.workOrder.costConfirmationRequired = false;
    harness.repository.entries = [];
    const listCalls = harness.repository.workOrderListCalls;
    await expect(
      harness.service.assertWorkOrderCostConfirmed(harness.tx, IDS.workOrder)
    ).resolves.toBe(true);
    expect(harness.repository.workOrderListCalls).toBe(listCalls);
  });

  it("takes source then subject ownership before every owning resolver and never accepts a client hash", async () => {
    const harness = serviceHarness();
    const command = requestServiceCommand("approval-request");
    const resolver = resolverWithTimeline(harness, { revision: 1, state: "PENDING" });

    const requested = await harness.service.requestApprovalInTransaction(
      harness.tx,
      command,
      context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST, command.source.key),
      resolver
    );

    expect(harness.repository.operations.slice(0, 3)).toEqual([
      "source-subject-lock",
      "owning-resolver",
      "repository-request"
    ]);
    expect(harness.repository.lastRequest).toMatchObject({
      authoritySnapshot: { revision: 1, state: "PENDING" },
      requestedBy: IDS.actor
    });
    expect(harness.repository.lastRequest).not.toHaveProperty("subjectSnapshotHash");
    expect(requested).not.toHaveProperty("decisionComment");
    expect(requested).not.toHaveProperty("wrote");
    expect(harness.audits[0]?.input).toMatchObject({
      action: AuditAction.CREATE,
      after: {
        permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
        reason: command.requestReason,
        source: command.source
      },
      entityType: "business_exception_approval"
    });
  });

  it("forbids requester/decider equality even with ADMIN permissions and audits decisions without public comments", async () => {
    const harness = serviceHarness();
    const command = decideServiceCommand("approval-decision");
    harness.currentApproval.requestedBy = IDS.actor;

    await expectServiceCode(
      harness.service.decideApprovalInTransaction(
        harness.tx,
        command,
        {
          ...context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE, command.source.key),
          permissions: ["ADMIN", ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE]
        },
        resolverWithTimeline(harness, { revision: 1, state: "PENDING" })
      ),
      ConflictException,
      ASSET_ACCOUNTING_SERVICE_CODE.SELF_APPROVAL_FORBIDDEN
    );
    expect(harness.audits).toHaveLength(0);

    harness.currentApproval.requestedBy = IDS.actor;
    const decided = await harness.service.decideApprovalInTransaction(
      harness.tx,
      command,
      context(IDS.decider, ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE, command.source.key),
      resolverWithTimeline(harness, { revision: 1, state: "PENDING" })
    );
    expect(decided).not.toHaveProperty("decisionComment");
    expect(harness.audits[0]?.input).toMatchObject({
      action: AuditAction.APPROVE,
      after: {
        fact: expect.not.objectContaining({ decisionComment: expect.anything() }),
        permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE,
        reason: command.decisionComment
      },
      before: expect.not.objectContaining({ decisionComment: expect.anything() })
    });
  });

  it("audits explicit expiry once and stale require commits expiry, returns false, and audits replay zero", async () => {
    const harness = serviceHarness();
    const expire = expireServiceCommand("approval-expire");
    const expireContext = context(
      IDS.decider,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
      expire.source.key
    );
    const expired = await harness.service.expireStaleApprovalsInTransaction(
      harness.tx,
      expire,
      expireContext,
      resolverWithTimeline(harness, { revision: 2, state: "CHANGED" })
    );
    expect(expired).not.toHaveProperty("decisionComment");
    expect(harness.audits).toHaveLength(1);

    harness.audits.length = 0;
    harness.repository.requireOutcome = {
      expiredApproval: { ...approvalSnapshot(), status: "EXPIRED", version: 2 },
      valid: false
    };
    const requireCommand = requireServiceCommand("approval-require");
    const requireContext = context(
      IDS.decider,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
      requireCommand.source.key
    );
    const valid = await harness.service.requireApprovedExceptionInTransaction(
      harness.tx,
      requireCommand,
      requireContext,
      resolverWithTimeline(harness, { revision: 2, state: "CHANGED" })
    );
    expect(valid).toBe(false);
    expect(harness.audits).toHaveLength(1);

    harness.receiptExists = true;
    const replay = await harness.service.requireApprovedExceptionInTransaction(
      harness.tx,
      requireCommand,
      requireContext,
      resolverWithTimeline(harness, { revision: 2, state: "CHANGED" })
    );
    expect(replay).toBe(false);
    expect(harness.audits).toHaveLength(1);
  });

  it("lets audit failures reject the caller so cost and approval state can roll back", async () => {
    const harness = serviceHarness();
    harness.auditError = new Error("AUDIT_WRITE_FAILED");
    const append = appendServiceCommand("audit-failure-cost");
    await expect(
      harness.service.appendCost(
        append,
        context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM, append.source.key)
      )
    ).rejects.toThrow("AUDIT_WRITE_FAILED");

    const request = requestServiceCommand("audit-failure-approval");
    await expect(
      harness.service.requestApprovalInTransaction(
        harness.tx,
        request,
        context(IDS.actor, ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST, request.source.key),
        resolverWithTimeline(harness, { revision: 1 })
      )
    ).rejects.toThrow("AUDIT_WRITE_FAILED");
  });
});

function serviceHarness() {
  const audits: Array<{ client: unknown; input: Record<string, unknown> }> = [];
  const transactions: unknown[] = [];
  const workOrder = { costConfirmationRequired: true, id: IDS.workOrder };
  const currentApproval: Record<string, unknown> = {
    ...approvalSnapshot(),
    decisionComment: null,
    requestedBy: IDS.actor
  };
  const harness = {
    auditError: undefined as Error | undefined,
    audits,
    currentApproval,
    receiptExists: false,
    repository: undefined as unknown as FakeRepository,
    service: undefined as unknown as AssetAccountingService,
    transactions,
    tx: undefined as unknown as Prisma.TransactionClient,
    workOrder
  };
  const tx = {
    assetAccountingCommandReceipt: {
      findUnique: async () => (harness.receiptExists ? { id: randomUUID() } : null)
    },
    assetWorkOrder: {
      findUnique: async () => workOrder
    },
    businessExceptionApproval: {
      findUnique: async () => currentApproval
    }
  } as unknown as Prisma.TransactionClient;
  const repository = new FakeRepository();
  const prisma = {
    $transaction: async <T>(
      callback: (transaction: Prisma.TransactionClient) => Promise<T>,
      options: { isolationLevel: unknown }
    ) => {
      transactions.push(options.isolationLevel);
      return callback(tx);
    }
  };
  const audit = {
    write: async (input: Record<string, unknown>, client: unknown) => {
      if (harness.auditError) throw harness.auditError;
      audits.push({ client, input });
    }
  };
  harness.repository = repository;
  harness.tx = tx;
  harness.service = new AssetAccountingService(
    prisma as never,
    repository as never,
    audit as unknown as AuditService
  );
  return harness;
}

class FakeRepository {
  readonly operations: string[] = [];
  appendOutcome: AssetAccountingCostCommandOutcome = { outcome: costEntry(), wrote: true };
  reverseOutcome: AssetAccountingCostCommandOutcome = { outcome: costEntry(), wrote: true };
  requestOutcome: AssetAccountingApprovalCommandOutcome = {
    outcome: approvalSnapshot(),
    wrote: true
  };
  decideOutcome: AssetAccountingApprovalCommandOutcome = {
    outcome: {
      ...approvalSnapshot(),
      decision: "APPROVED",
      decisionComment: "private",
      status: "APPROVED",
      version: 1
    },
    wrote: true
  };
  expireOutcome: AssetAccountingApprovalCommandOutcome = {
    outcome: { ...approvalSnapshot(), expiryReason: "changed", status: "EXPIRED", version: 1 },
    wrote: true
  };
  requireOutcome:
    | Readonly<{ approval: BusinessExceptionApprovalSnapshot; valid: true }>
    | Readonly<{ expiredApproval: BusinessExceptionApprovalSnapshot; valid: false }> = {
    approval: { ...approvalSnapshot(), decision: "APPROVED", status: "APPROVED", version: 1 },
    valid: true
  };
  entry: VehicleCostLedgerEntrySnapshot | null = costEntry();
  entries: VehicleCostLedgerEntrySnapshot[] = [costEntry()];
  lastAppendActor?: string;
  lastRequest?: RequestExceptionApprovalCommand;
  workOrderListCalls = 0;

  async lockBusinessExceptionSourceAndSubject(
    tx: Prisma.TransactionClient,
    sourceValue: unknown,
    subjectValue: BusinessExceptionSubjectIdentity
  ) {
    void tx;
    void sourceValue;
    void subjectValue;
    this.operations.push("source-subject-lock");
  }

  async appendCostEntry(_tx: Prisma.TransactionClient, command: { actorId: string }) {
    this.operations.push("repository-append");
    this.lastAppendActor = command.actorId;
    return this.appendOutcome;
  }

  async reverseCostEntry() {
    this.operations.push("repository-reverse");
    return this.reverseOutcome;
  }

  async getCostEntry() {
    return this.entry;
  }

  async listVehicleEntries() {
    return this.entries;
  }

  async listOrderEntries() {
    return this.entries;
  }

  async listWorkOrderEntries() {
    this.workOrderListCalls += 1;
    return this.entries;
  }

  async requestExceptionApproval(
    _tx: Prisma.TransactionClient,
    command: RequestExceptionApprovalCommand
  ) {
    this.operations.push("repository-request");
    this.lastRequest = command;
    return this.requestOutcome;
  }

  async decideExceptionApproval(
    tx: Prisma.TransactionClient,
    command: DecideExceptionApprovalCommand
  ) {
    void tx;
    void command;
    this.operations.push("repository-decide");
    return this.decideOutcome;
  }

  async expireExceptionApproval(
    tx: Prisma.TransactionClient,
    command: ExpireExceptionApprovalCommand
  ) {
    void tx;
    void command;
    this.operations.push("repository-expire");
    return this.expireOutcome;
  }

  async requireCurrentApprovedException(
    tx: Prisma.TransactionClient,
    command: RequireCurrentApprovedExceptionCommand
  ) {
    void tx;
    void command;
    this.operations.push("repository-require");
    return this.requireOutcome;
  }
}

function resolverWithTimeline(
  harness: ReturnType<typeof serviceHarness>,
  snapshot: Record<string, string | number>
): BusinessExceptionAuthorityResolver {
  return async (tx) => {
    expect(tx).toBe(harness.tx);
    harness.repository.operations.push("owning-resolver");
    return snapshot;
  };
}

function appendServiceCommand(key: string) {
  return {
    actionType: "ACTUAL_COST" as const,
    accountingPeriod: "2026-08",
    amountCents: 100n,
    assetOwnerId: null,
    assetOwnerSnapshot: null,
    confirmedAt: CONFIRMED_AT,
    contractId: null,
    costCategory: "REPAIR" as const,
    customerId: null,
    evidenceId: null,
    evidenceSnapshot: null,
    occurredOn: OCCURRED_ON,
    orderId: IDS.order,
    responsiblePartyId: null,
    responsiblePartyType: "PLATFORM" as const,
    responsibilitySnapshot: { basis: "inspection" },
    source: source(key),
    vehicleId: IDS.vehicle,
    workOrderId: IDS.workOrder
  };
}

function requestServiceCommand(key: string) {
  return {
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION" as const,
    requestEvidenceSnapshot: { evidenceRevision: 1 },
    requestReason: "registration evidence is pending",
    requestedAt: CONFIRMED_AT,
    source: source(key),
    subject: subject()
  };
}

function decideServiceCommand(key: string) {
  return {
    approvalId: IDS.approval,
    decidedAt: new Date("2026-08-20T10:10:00.000Z"),
    decision: "APPROVED" as const,
    decisionComment: "approved after manual evidence review",
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION" as const,
    expectedVersion: 0,
    source: source(key),
    subject: subject()
  };
}

function expireServiceCommand(key: string) {
  return {
    approvalId: IDS.approval,
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION" as const,
    expectedVersion: 1,
    expiredAt: new Date("2026-08-20T10:20:00.000Z"),
    expiryReason: "authoritative snapshot changed",
    source: source(key),
    subject: subject()
  };
}

function requireServiceCommand(key: string) {
  return expireServiceCommand(key);
}

function source(key: string) {
  return { id: IDS.source, key, type: "ASSET_WORK_ORDER" };
}

function subject(): BusinessExceptionSubjectIdentity {
  return {
    subjectField: "registrationDocument",
    subjectId: IDS.vehicle,
    subjectType: "VEHICLE"
  };
}

function context(
  actorId: string | null,
  permission: string,
  idempotencyKey: string | undefined = "guarded-append"
): AssetAccountingCommandContext {
  return {
    actorId,
    idempotencyKey,
    ipAddress: "203.0.113.8",
    permissions: [permission],
    requestId: "request-asset-accounting",
    userAgent: "asset-accounting-test"
  };
}

function costEntry(): VehicleCostLedgerEntrySnapshot {
  return {
    actionType: "ACTUAL_COST",
    accountingPeriod: "2026-08",
    amountCents: 100n,
    assetOwnerId: null,
    assetOwnerSnapshot: undefined,
    confirmedAt: CONFIRMED_AT,
    confirmedBy: IDS.actor,
    contractId: null,
    costCategory: "REPAIR",
    customerId: null,
    entryKind: "ORIGINAL",
    evidenceId: null,
    evidenceSnapshot: undefined,
    id: IDS.entry,
    occurredOn: OCCURRED_ON,
    orderId: IDS.order,
    responsiblePartyId: null,
    responsiblePartyType: "PLATFORM",
    responsibilitySnapshot: { basis: "inspection" },
    reversalOfEntryId: null,
    sourceId: IDS.source,
    sourceKey: "audited-append",
    sourceType: "ASSET_WORK_ORDER",
    vehicleId: IDS.vehicle,
    workOrderId: IDS.workOrder
  };
}

function publicCostEntry() {
  return {
    ...costEntry(),
    amountCents: "100",
    confirmedAt: CONFIRMED_AT.toISOString(),
    occurredOn: OCCURRED_ON.toISOString()
  };
}

function approvalSnapshot(): BusinessExceptionApprovalSnapshot {
  return {
    approvalNo: `BEA-${IDS.approval}`,
    decidedAt: null,
    decidedBy: null,
    decision: null,
    decisionComment: null,
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION",
    expiredAt: null,
    expiredBy: null,
    expiryReason: null,
    id: IDS.approval,
    requestEvidenceSnapshot: { evidenceRevision: 1 },
    requestReason: "registration evidence is pending",
    requestedAt: CONFIRMED_AT,
    requestedBy: IDS.actor,
    requestSourceId: IDS.source,
    requestSourceKey: "approval-request",
    requestSourceType: "ASSET_WORK_ORDER",
    status: "PENDING",
    subjectField: "registrationDocument",
    subjectId: IDS.vehicle,
    subjectSnapshot: { revision: 1, state: "PENDING" },
    subjectSnapshotHash: "a".repeat(64),
    subjectType: "VEHICLE",
    version: 0
  };
}

async function expectServiceCode(
  promise: Promise<unknown>,
  type:
    | typeof BadRequestException
    | typeof ConflictException
    | typeof ForbiddenException
    | typeof NotFoundException,
  code: string
) {
  try {
    await promise;
    throw new Error(`Expected service error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code });
  }
}
