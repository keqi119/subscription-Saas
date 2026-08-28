import {
  ContractStatus,
  ESignDocumentType,
  ESignSigningStage,
  ESignTaskStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { Stage3ExtensionArchiveService } from "../src/esign/stage3-extension-archive.service";

describe("early-termination Stage 3 archive", () => {
  it("requires retained provider-signed PDF evidence before scheduling and replays idempotently", async () => {
    const state = {
      change: {
        changeType: SubscriptionChangeType.EARLY_TERMINATION,
        completionDeadlineAt: new Date("2026-09-15T02:00:00.000Z"),
        contract: { id: "contract-early" },
        contractId: "contract-early",
        earlyTerminationDetail: {
          agreementContractId: "contract-early",
          closureCaseId: "closure-early"
        },
        id: "change-early",
        orderId: "order-1",
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
        version: 4
      },
      contract: {
        archivedAt: null as Date | null,
        id: "contract-early",
        signedAt: null as Date | null,
        status: ContractStatus.GENERATED
      }
    };
    const task = {
      contractId: "contract-early",
      documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
      id: "task-early",
      signedDocumentObjectKey: "signed/early-termination.pdf",
      signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
      sourceId: "change-early",
      sourceKey: "subscription-change:change-early:esign:attempt:1",
      sourceType: "EARLY_TERMINATION_SUPPLEMENT",
      taskStatus: ESignTaskStatus.COMPLETED
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ now: new Date("2026-08-27T04:00:00.000Z") }]),
      contract: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(state.contract, data);
          return state.contract;
        })
      },
      contractESignTask: { findUnique: vi.fn(async () => task) },
      subscriptionChangeOrder: {
        findUnique: vi.fn(async () => state.change),
        updateMany: vi.fn(
          async ({
            data,
            where
          }: {
            data: Record<string, unknown>;
            where: { version: number };
          }) => {
            if (where.version !== state.change.version) return { count: 0 };
            Object.assign(state.change, data);
            if (data.version && typeof data.version === "object") state.change.version += 1;
            return { count: 1 };
          }
        )
      }
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx))
    };
    const service = new Stage3ExtensionArchiveService(
      prisma as never,
      { write: vi.fn(async () => undefined) } as never
    );
    const input = {
      completedAt: new Date("2026-08-27T03:59:59.000Z"),
      contractId: "contract-early",
      source: "CALLBACK" as const,
      taskId: "task-early"
    };

    await expect(service.finalizeArchivedContract(input)).resolves.toEqual({
      changeOrderId: "change-early",
      outcome: "SCHEDULED"
    });
    expect(state.contract).toMatchObject({
      signedAt: input.completedAt,
      status: ContractStatus.ARCHIVED
    });
    expect(state.change.status).toBe(SubscriptionChangeStatus.SCHEDULED);

    await expect(service.finalizeArchivedContract(input)).resolves.toEqual({
      changeOrderId: "change-early",
      outcome: "DUPLICATE"
    });
    expect(tx.subscriptionChangeOrder.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects a completed task that is not source-bound to the early-termination change", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      contractESignTask: {
        findUnique: vi.fn(async () => ({
          contractId: "contract-early",
          documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
          signedDocumentObjectKey: "signed/early-termination.pdf",
          signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
          sourceId: "another-change",
          sourceKey: "subscription-change:another-change:esign:attempt:1",
          sourceType: "EARLY_TERMINATION_SUPPLEMENT",
          taskStatus: ESignTaskStatus.COMPLETED
        }))
      },
      subscriptionChangeOrder: {
        findUnique: vi.fn(async () => ({
          changeType: SubscriptionChangeType.EARLY_TERMINATION,
          contractId: "contract-early",
          id: "change-early"
        }))
      }
    };
    const service = new Stage3ExtensionArchiveService(
      {
        $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx))
      } as never,
      { write: vi.fn(async () => undefined) } as never
    );

    await expect(
      service.finalizeArchivedContract({
        completedAt: new Date("2026-08-27T03:59:59.000Z"),
        contractId: "contract-early",
        source: "CALLBACK",
        taskId: "task-foreign"
      })
    ).rejects.toMatchObject({ code: "STAGE3_SIGNED_ARTIFACT_REQUIRED" });
  });

  it("rejects scheduling when the signed PDF has not been retained", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ now: new Date("2026-08-27T04:00:00.000Z") }]),
      contractESignTask: {
        findUnique: vi.fn(async () => ({
          contractId: "contract-early",
          documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
          id: "task-early",
          signedDocumentObjectKey: null,
          signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
          taskStatus: ESignTaskStatus.COMPLETED
        }))
      },
      subscriptionChangeOrder: {
        findUnique: vi.fn(async () => ({
          changeType: SubscriptionChangeType.EARLY_TERMINATION,
          contractId: "contract-early",
          id: "change-early"
        }))
      }
    };
    const service = new Stage3ExtensionArchiveService(
      {
        $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx))
      } as never,
      { write: vi.fn(async () => undefined) } as never
    );

    await expect(
      service.finalizeArchivedContract({
        completedAt: new Date("2026-08-27T03:59:59.000Z"),
        contractId: "contract-early",
        source: "CALLBACK",
        taskId: "task-early"
      })
    ).rejects.toMatchObject({ code: "STAGE3_SIGNED_ARTIFACT_REQUIRED" });
  });
});
