import { SubscriptionChangeStatus, SubscriptionChangeType } from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  normalizeManagedOtherRequest,
  SubscriptionManagedOtherService
} from "../src/subscription-change/subscription-managed-other.service";

describe("SubscriptionManagedOtherService", () => {
  it("normalizes only the explicit record-only contact-preference operation", () => {
    expect(
      normalizeManagedOtherRequest({
        beforeSnapshot: { preferredChannel: "SMS" },
        evidence: [{ fileId: "76fe601a-1d4c-45de-b6ba-4a4d1ba518d8" }],
        operation: "UPDATE_CONTACT_PREFERENCE",
        operationPayload: { preferredChannel: "WECHAT" }
      })
    ).toMatchObject({
      beforeSnapshot: { preferredChannel: "SMS" },
      operation: "UPDATE_CONTACT_PREFERENCE",
      operationPayload: { preferredChannel: "WECHAT" },
      requiresSignedSupplement: false
    });
  });

  it.each([
    "EXTENSION",
    "VEHICLE_SWAP",
    "EARLY_TERMINATION",
    "UPDATE_PRICE",
    "EDIT_HISTORICAL_BILL",
    "UPDATE_CONTRACT_SEGMENT"
  ])("routes the sensitive %s operation to its dedicated workflow", (operation) => {
    expect(() =>
      normalizeManagedOtherRequest({
        beforeSnapshot: { stable: true },
        evidence: [{ reference: "approval-evidence" }],
        operation,
        operationPayload: { requested: true }
      })
    ).toThrowError(
      expect.objectContaining({ code: "MANAGED_OTHER_DEDICATED_CHANGE_REQUIRED" })
    );
  });

  it("rejects an unapproved generic patch operation", () => {
    expect(() =>
      normalizeManagedOtherRequest({
        beforeSnapshot: { stable: true },
        evidence: [{ reference: "approval-evidence" }],
        operation: "PATCH_ARBITRARY_FIELDS",
        operationPayload: { patch: { anything: true } }
      })
    ).toThrowError(expect.objectContaining({ code: "MANAGED_OTHER_OPERATION_NOT_ALLOWED" }));
  });

  it("approves an immutable operation request before scheduling", async () => {
    const harness = managedHarness();

    await expect(
      harness.service.approve(
        harness.change.id,
        {
          approvalReason: "Evidence reviewed",
          approvalReference: "APR-20260827-001",
          idempotencyKey: "managed-approve-1",
          version: 0
        },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ status: SubscriptionChangeStatus.SCHEDULED, version: 1 });

    expect(harness.change.managedOtherDetail.approvedOperationSnapshot).toMatchObject({
      approval: {
        approvalReason: "Evidence reviewed",
        approvalReference: "APR-20260827-001",
        approvedBy: harness.actor.id
      },
      request: {
        operation: "UPDATE_CONTACT_PREFERENCE",
        operationPayload: { preferredChannel: "WECHAT" }
      }
    });
    expect(harness.change.managedOtherDetail.afterSnapshot).toBeNull();
  });

  it("stores one immutable execution result and replays the exact command", async () => {
    const harness = managedHarness();
    await harness.service.approve(
      harness.change.id,
      {
        approvalReason: "Evidence reviewed",
        approvalReference: "APR-20260827-002",
        idempotencyKey: "managed-approve-2",
        version: 0
      },
      harness.actor,
      harness.context
    );

    const first = await harness.service.execute(
      harness.change.id,
      {
        executionNote: "Preference fact recorded",
        idempotencyKey: "managed-execute-1",
        version: 1
      },
      harness.actor,
      harness.context
    );
    const immutableResult = harness.change.managedOtherDetail.afterSnapshot;
    const replay = await harness.service.execute(
      harness.change.id,
      {
        executionNote: "Preference fact recorded",
        idempotencyKey: "managed-execute-1",
        version: 1
      },
      harness.actor,
      harness.context
    );

    expect(first).toMatchObject({ status: SubscriptionChangeStatus.COMPLETED, version: 2 });
    expect(replay).toMatchObject({ status: SubscriptionChangeStatus.COMPLETED, version: 2 });
    expect(harness.change.managedOtherDetail.afterSnapshot).toEqual(immutableResult);
    expect(immutableResult).toMatchObject({
      executedBy: harness.actor.id,
      executionMode: "IMMUTABLE_FACT_ONLY",
      operation: "UPDATE_CONTACT_PREFERENCE",
      operationResult: { preferredChannel: "WECHAT" }
    });
  });

  it("requires an archived customer-signed supplement for a rights-changing operation", async () => {
    const harness = managedHarness({ operation: "RECORD_SERVICE_ACCOMMODATION" });

    await expect(
      harness.service.approve(
        harness.change.id,
        {
          approvalReason: "Commercial accommodation approved",
          approvalReference: "APR-20260827-003",
          idempotencyKey: "managed-approve-rights",
          version: 0
        },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "MANAGED_OTHER_SIGNED_SUPPLEMENT_REQUIRED" });
    expect(harness.change.status).toBe(SubscriptionChangeStatus.DRAFT);
  });

  it("executes a rights-changing operation only with its approved signed supplement", async () => {
    const harness = managedHarness({
      operation: "RECORD_SERVICE_ACCOMMODATION",
      signedSupplement: true
    });

    await expect(
      harness.service.approve(
        harness.change.id,
        {
          approvalReason: "Commercial accommodation approved",
          approvalReference: "APR-20260827-004",
          idempotencyKey: "managed-approve-signed-rights",
          supplementContractId: "contract-supplement",
          version: 0
        },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({
      contractId: "contract-supplement",
      status: SubscriptionChangeStatus.SCHEDULED,
      version: 1
    });

    await expect(
      harness.service.execute(
        harness.change.id,
        {
          executionNote: "Approved accommodation fact recorded",
          idempotencyKey: "managed-execute-signed-rights",
          version: 1
        },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ status: SubscriptionChangeStatus.COMPLETED, version: 2 });
    expect(harness.change.managedOtherDetail.afterSnapshot).toMatchObject({
      executionMode: "IMMUTABLE_FACT_ONLY",
      supplementContractId: "contract-supplement"
    });
  });

  it("does not execute before the approved effective boundary", async () => {
    const harness = managedHarness({
      effectiveDate: new Date("2026-10-01T00:00:00.000Z"),
      now: new Date("2026-09-30T15:59:59.000Z")
    });
    await harness.service.approve(
      harness.change.id,
      {
        approvalReason: "Evidence reviewed",
        approvalReference: "APR-20260827-004",
        idempotencyKey: "managed-approve-future",
        version: 0
      },
      harness.actor,
      harness.context
    );

    await expect(
      harness.service.execute(
        harness.change.id,
        {
          executionNote: "Too early",
          idempotencyKey: "managed-execute-early",
          version: 1
        },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "MANAGED_OTHER_EFFECTIVE_TIME_NOT_REACHED" });
    expect(harness.change.managedOtherDetail.afterSnapshot).toBeNull();
  });
});

function managedHarness(
  options: {
    effectiveDate?: Date;
    now?: Date;
    operation?: string;
    signedSupplement?: boolean;
  } = {}
) {
  const now = options.now ?? new Date("2026-09-30T16:00:01.000Z");
  const actor = {
    id: "operator-1",
    menus: [],
    name: "Managed change operator",
    permissions: [
      PermissionCode.SUBSCRIPTION_CHANGE_APPROVE,
      PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE
    ],
    roles: ["OP"],
    username: "operator"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const operation = options.operation ?? "UPDATE_CONTACT_PREFERENCE";
  const operationPayload =
    operation === "UPDATE_CONTACT_PREFERENCE"
      ? { preferredChannel: "WECHAT" }
      : { description: "Provide a governed non-financial service accommodation" };
  const supplement = options.signedSupplement
    ? {
        archivedAt: now,
        esignTasks: [{ signedDocumentObjectKey: "contracts/managed-other-signed.pdf" }],
        fileId: "file-supplement",
        id: "contract-supplement",
        signedAt: now,
        status: "ARCHIVED"
      }
    : null;
  const change = {
    changeNo: "SCO-MANAGED-1",
    changeType: SubscriptionChangeType.MANAGED_OTHER,
    contractId: null as string | null,
    createdBy: actor.id,
    id: "change-managed-1",
    managedOtherDetail: {
      afterSnapshot: null as Record<string, unknown> | null,
      approvedOperationSnapshot: {
        approval: null,
        request: { operation, operationPayload }
      },
      beforeSnapshot: { preferredChannel: "SMS" },
      changeOrderId: "change-managed-1",
      effectiveDate: options.effectiveDate ?? new Date("2026-09-30T00:00:00.000Z"),
      evidenceSnapshot: [{ reference: "customer-request-managed-1" }],
      id: "detail-managed-1",
      reason: "Customer service preference request",
      supplementContract: null as typeof supplement,
      supplementContractId: null as string | null
    },
    order: {
      contractId: "contract-base",
      customerId: "customer-1",
      id: "order-1",
      orderNo: "ORD-1"
    },
    orderId: "order-1",
    status: SubscriptionChangeStatus.DRAFT,
    updatedBy: actor.id,
    version: 0
  };
  const commands = new Map<string, Record<string, unknown>>();
  const tx = {
    $queryRaw: vi.fn(async () => []),
    contract: {
      findFirst: vi.fn(async () => supplement)
    },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const command = { id: `command-${commands.size + 1}`, ...data };
        commands.set(commandKey(data), command);
        return command;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        commands.get(commandKey(nestedCommandKey(where))) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const command = [...commands.values()].find((item) => item.id === where.id);
        if (command) Object.assign(command, data);
        return command;
      })
    },
    subscriptionChangeOrder: {
      findUnique: vi.fn(async () => change),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyUpdate(change, data);
        return change;
      })
    },
    subscriptionManagedOtherChangeDetail: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(change.managedOtherDetail, data);
        if (data.supplementContractId === supplement?.id) {
          change.managedOtherDetail.supplementContract = supplement;
        }
        return change.managedOtherDetail;
      })
    }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    subscriptionChangeCommand: tx.subscriptionChangeCommand,
    subscriptionChangeOrder: tx.subscriptionChangeOrder
  };
  const service = new SubscriptionManagedOtherService(
    prisma as never,
    { write: vi.fn(async () => undefined) } as never,
    { enabled: true, now: () => now, quoteValidityHours: 72 } as never
  );
  return { actor, change, context, service, tx };
}

function nestedCommandKey(where: Record<string, unknown>) {
  return where.actorId_operation_idempotencyKey as Record<string, unknown>;
}

function commandKey(value: Record<string, unknown>) {
  return `${String(value.actorId)}:${String(value.operation)}:${String(value.idempotencyKey)}`;
}

function applyUpdate(target: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (key === "version" && value && typeof value === "object" && "increment" in value) {
      target.version = Number(target.version) + Number(value.increment);
    } else {
      target[key] = value;
    }
  }
}
