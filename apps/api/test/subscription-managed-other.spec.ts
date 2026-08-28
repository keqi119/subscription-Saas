import { ContractStatus, SubscriptionChangeStatus, SubscriptionChangeType } from "@prisma/client";
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
    ).toThrowError(expect.objectContaining({ code: "MANAGED_OTHER_DEDICATED_CHANGE_REQUIRED" }));
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

  it("rejects managed-other writes when its exact rollout flag is disabled", async () => {
    const harness = managedHarness({ enabled: false });

    await expect(
      harness.service.approve(
        harness.change.id,
        {
          approvalReason: "Must not bypass rollout guard",
          approvalReference: "APR-DISABLED",
          idempotencyKey: "managed-disabled",
          version: 0
        },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({
      code: "SUBSCRIPTION_MANAGED_OTHER_DISABLED",
      status: 503
    });
    expect(harness.tx.subscriptionChangeCommand.create).not.toHaveBeenCalled();
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

  it("approves a rights-changing operation into the workflow-owned contract stage", async () => {
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
    ).resolves.toMatchObject({
      contractId: null,
      status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
      version: 1
    });
  });

  it("rejects a manually supplied supplement contract ID", async () => {
    const harness = managedHarness({ operation: "RECORD_SERVICE_ACCOMMODATION" });

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
    ).rejects.toMatchObject({ code: "MANAGED_OTHER_MANUAL_SUPPLEMENT_FORBIDDEN" });
  });

  it("generates a PDF supplement and starts provider e-sign without a manual contract ID", async () => {
    const harness = managedHarness({ operation: "RECORD_SERVICE_ACCOMMODATION" });
    await harness.service.approve(
      harness.change.id,
      {
        approvalReason: "Commercial accommodation approved",
        approvalReference: "APR-20260827-005",
        idempotencyKey: "managed-approve-generated-rights",
        version: 0
      },
      harness.actor,
      harness.context
    );

    await expect(
      harness.service.generate(
        harness.change.id,
        { idempotencyKey: "managed-generate-rights", version: 1 },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({
      fileId: "generated-pdf-file",
      id: "contract-generated",
      status: ContractStatus.GENERATED
    });
    expect(harness.change).toMatchObject({
      contractId: "contract-generated",
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
      version: 2
    });

    const start = vi.fn(async () => ({ id: "task-managed" }));
    const replay = vi.fn(async () => ({ id: "task-managed" }));
    await expect(
      harness.service.startOrRetryESign(
        harness.change.id,
        { idempotencyKey: "managed-esign-rights", version: 2 },
        harness.actor,
        start,
        replay
      )
    ).resolves.toEqual({ id: "task-managed" });
    await expect(
      harness.service.startOrRetryESign(
        harness.change.id,
        { idempotencyKey: "managed-esign-rights", version: 2 },
        harness.actor,
        start,
        replay
      )
    ).resolves.toEqual({ id: "task-managed" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("recovers the same PDF supplement reservation after object storage succeeds but finalize fails", async () => {
    const harness = managedHarness({ operation: "RECORD_SERVICE_ACCOMMODATION" });
    await harness.service.approve(
      harness.change.id,
      {
        approvalReason: "Commercial accommodation approved",
        approvalReference: "APR-20260827-RECOVER",
        idempotencyKey: "managed-approve-recover",
        version: 0
      },
      harness.actor,
      harness.context
    );
    harness.artifactWriter.writeGeneratedContractPdfArtifact.mockImplementationOnce(async () => {
      harness.failNextTransaction(new Error("transient finalize failure"));
      return generatedManagedOtherArtifact();
    });

    await expect(
      harness.service.generate(
        harness.change.id,
        { idempotencyKey: "managed-generate-recover", version: 1 },
        harness.actor,
        harness.context
      )
    ).rejects.toThrow("transient finalize failure");
    expect(harness.change).toMatchObject({
      contractId: "contract-generated",
      status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
      version: 1
    });

    await expect(
      harness.service.generate(
        harness.change.id,
        { idempotencyKey: "managed-generate-recover", version: 1 },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ fileId: "generated-pdf-file", id: "contract-generated" });
    expect(harness.change).toMatchObject({
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
      version: 2
    });
    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledTimes(2);
  });

  it("executes a rights-changing operation only after its generated supplement is archived", async () => {
    const harness = managedHarness({ operation: "RECORD_SERVICE_ACCOMMODATION" });

    await harness.service.approve(
      harness.change.id,
      {
        approvalReason: "Commercial accommodation approved",
        approvalReference: "APR-20260827-006",
        idempotencyKey: "managed-approve-executable-rights",
        version: 0
      },
      harness.actor,
      harness.context
    );
    await harness.service.generate(
      harness.change.id,
      { idempotencyKey: "managed-generate-executable-rights", version: 1 },
      harness.actor,
      harness.context
    );
    harness.archiveGeneratedSupplement();

    await expect(
      harness.service.execute(
        harness.change.id,
        {
          executionNote: "Approved accommodation fact recorded",
          idempotencyKey: "managed-execute-signed-rights",
          version: 3
        },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ status: SubscriptionChangeStatus.COMPLETED, version: 4 });
    expect(harness.change.managedOtherDetail.afterSnapshot).toMatchObject({
      executionMode: "IMMUTABLE_FACT_ONLY",
      supplementContractId: "contract-generated"
    });
  });

  it("rejects execution when the archived supplement snapshot no longer matches the approved facts", async () => {
    const harness = managedHarness({ operation: "RECORD_SERVICE_ACCOMMODATION" });
    await harness.service.approve(
      harness.change.id,
      {
        approvalReason: "Commercial accommodation approved",
        approvalReference: "APR-20260827-DRIFT",
        idempotencyKey: "managed-approve-drift",
        version: 0
      },
      harness.actor,
      harness.context
    );
    await harness.service.generate(
      harness.change.id,
      { idempotencyKey: "managed-generate-drift", version: 1 },
      harness.actor,
      harness.context
    );
    harness.archiveGeneratedSupplement();
    harness.change.managedOtherDetail.supplementContract!.contractSnapshot = {
      approvedOperationSnapshot: { tampered: true },
      beforeSnapshot: harness.change.managedOtherDetail.beforeSnapshot,
      evidenceSnapshot: harness.change.managedOtherDetail.evidenceSnapshot
    };

    await expect(
      harness.service.execute(
        harness.change.id,
        {
          executionNote: "Must not execute a different signed agreement",
          idempotencyKey: "managed-execute-drift",
          version: 3
        },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "MANAGED_OTHER_SIGNED_FACT_DRIFT" });
    expect(harness.change.managedOtherDetail.afterSnapshot).toBeNull();
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
    enabled?: boolean;
    now?: Date;
    operation?: string;
  } = {}
) {
  const now = options.now ?? new Date("2026-09-30T16:00:01.000Z");
  const actor = {
    id: "operator-1",
    menus: [],
    name: "Managed change operator",
    permissions: [
      PermissionCode.SUBSCRIPTION_CHANGE_APPROVE,
      PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY,
      PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE,
      PermissionCode.CONTRACT_GENERATE
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
  type ManagedSupplement = {
    archivedAt: Date | null;
    contractNo: string;
    contractSnapshot: Record<string, unknown>;
    esignTasks: Array<{ signedDocumentObjectKey: string }>;
    fileId: string | null;
    id: string;
    signedAt: Date | null;
    status: ContractStatus;
  };
  let supplement: ManagedSupplement | null = null;
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
      supplementContract: null as ManagedSupplement | null,
      supplementContractId: null as string | null
    },
    order: {
      contract: {
        contractNo: "CON-BASE",
        id: "contract-base",
        status: ContractStatus.SIGNED
      },
      contractId: "contract-base",
      customerId: "customer-1",
      id: "order-1",
      orderNo: "ORD-1"
    },
    orderId: "order-1",
    status: SubscriptionChangeStatus.DRAFT as SubscriptionChangeStatus,
    updatedBy: actor.id,
    version: 0
  };
  const commands = new Map<string, Record<string, unknown>>();
  let nextTransactionError: Error | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    contract: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        supplement = {
          archivedAt: null,
          contractNo: "CON-GENERATED",
          contractSnapshot: data.contractSnapshot as Record<string, unknown>,
          esignTasks: [],
          fileId: null,
          id: "contract-generated",
          signedAt: null,
          status: ContractStatus.GENERATED
        };
        return supplement;
      }),
      findFirst: vi.fn(async () => supplement),
      findUnique: vi.fn(async () => supplement),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!supplement) throw new Error("supplement missing");
        Object.assign(supplement, data);
        return supplement;
      }),
      updateMany: vi.fn(async () => ({ count: supplement ? 1 : 0 }))
    },
    contractVersion: {
      findFirst: vi.fn(async () => ({
        contentTemplate: "Managed-other supplement template",
        id: "template-supplement",
        templateName: "Managed other supplement",
        templateType: "SUBSCRIPTION_EXTENSION",
        versionNo: "1"
      })),
      findUnique: vi.fn(async () => ({
        contentTemplate: "Managed-other supplement template",
        id: "template-supplement",
        templateName: "Managed other supplement",
        templateType: "SUBSCRIPTION_EXTENSION",
        versionNo: "1"
      }))
    },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const command = { id: `command-${commands.size + 1}`, ...data };
        commands.set(commandKey(data), command);
        return command;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          commands.get(commandKey(nestedCommandKey(where))) ?? null
      ),
      update: vi.fn(
        async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
          const command = [...commands.values()].find((item) => item.id === where.id);
          if (command) Object.assign(command, data);
          return command;
        }
      ),
      deleteMany: vi.fn(async () => ({ count: 1 }))
    },
    subscriptionChangeOrder: {
      findUnique: vi.fn(async () => change),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyUpdate(change, data);
        if (data.contractId === supplement?.id) {
          change.managedOtherDetail.supplementContract = supplement;
        }
        return change;
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyUpdate(change, data);
        return { count: 1 };
      })
    },
    subscriptionManagedOtherChangeDetail: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(change.managedOtherDetail, data);
        if (data.supplementContractId === supplement?.id) {
          change.managedOtherDetail.supplementContract = supplement;
        }
        return change.managedOtherDetail;
      }),
      updateMany: vi.fn(async () => ({ count: 1 }))
    }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
      if (nextTransactionError) {
        const error = nextTransactionError;
        nextTransactionError = null;
        throw error;
      }
      return operation(tx);
    }),
    contract: tx.contract,
    subscriptionChangeCommand: tx.subscriptionChangeCommand,
    subscriptionChangeOrder: tx.subscriptionChangeOrder
  };
  const artifactWriter = {
    writeGeneratedContractPdfArtifact: vi.fn(async () => generatedManagedOtherArtifact())
  };
  const service = new SubscriptionManagedOtherService(
    prisma as never,
    { write: vi.fn(async () => undefined) } as never,
    {
      enabled: true,
      managedOtherEnabled: options.enabled ?? true,
      now: () => now,
      quoteValidityHours: 72
    } as never,
    artifactWriter as never
  );
  return {
    actor,
    artifactWriter,
    archiveGeneratedSupplement: () => {
      if (!supplement) throw new Error("supplement missing");
      supplement.archivedAt = now;
      supplement.esignTasks = [{ signedDocumentObjectKey: "contracts/managed-other/signed.pdf" }];
      supplement.signedAt = now;
      supplement.status = ContractStatus.ARCHIVED;
      change.managedOtherDetail.supplementContract = supplement;
      change.status = SubscriptionChangeStatus.SCHEDULED;
      change.version = 3;
    },
    change,
    context,
    failNextTransaction: (error: Error) => {
      nextTransactionError = error;
    },
    service,
    tx
  };
}

function generatedManagedOtherArtifact() {
  return {
    bucket: "test-contracts",
    diagnostics: {},
    fileId: "generated-pdf-file",
    mimeType: "application/pdf",
    objectKey: "contracts/managed-other/generated.pdf",
    originalName: "managed-other.pdf",
    sizeBytes: 128
  };
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
