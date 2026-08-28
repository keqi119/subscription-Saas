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

describe("managed-other Stage 3 archive", () => {
  it("archives provider-signed PDF evidence before scheduling the approved change", async () => {
    const state = {
      change: {
        changeType: SubscriptionChangeType.MANAGED_OTHER,
        completionDeadlineAt: new Date("2026-09-15T02:00:00.000Z"),
        contract: { id: "contract-managed" },
        contractId: "contract-managed",
        id: "change-managed",
        managedOtherDetail: { supplementContractId: "contract-managed" },
        orderId: "order-1",
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
        version: 2
      },
      contract: {
        archivedAt: null as Date | null,
        id: "contract-managed",
        signedAt: null as Date | null,
        status: ContractStatus.GENERATED
      }
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ now: new Date("2026-08-27T04:00:00.000Z") }]),
      contract: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(state.contract, data);
          return state.contract;
        })
      },
      contractESignTask: {
        findUnique: vi.fn(async () => ({
          contractId: "contract-managed",
          documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
          id: "task-managed",
          signedDocumentObjectKey: "signed/managed-other.pdf",
          signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
          sourceId: "change-managed",
          sourceKey: "subscription-change:change-managed:esign:attempt:1",
          sourceType: "MANAGED_OTHER_SUPPLEMENT",
          taskStatus: ESignTaskStatus.COMPLETED
        }))
      },
      subscriptionChangeOrder: {
        findUnique: vi.fn(async () => state.change),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const nextVersion =
            data.version && typeof data.version === "object"
              ? state.change.version + 1
              : state.change.version;
          Object.assign(state.change, data, { version: nextVersion });
          return { count: 1 };
        })
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
        contractId: "contract-managed",
        source: "CALLBACK",
        taskId: "task-managed"
      })
    ).resolves.toEqual({ changeOrderId: "change-managed", outcome: "SCHEDULED" });
    expect(state.contract.status).toBe(ContractStatus.ARCHIVED);
    expect(state.change).toMatchObject({
      status: SubscriptionChangeStatus.SCHEDULED,
      version: 3
    });
  });
});
