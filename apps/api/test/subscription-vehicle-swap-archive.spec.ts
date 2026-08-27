import {
  ContractStatus,
  ESignDocumentType,
  ESignSigningStage,
  ESignTaskStatus,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { Stage3ExtensionArchiveService } from "../src/esign/stage3-extension-archive.service";

describe("vehicle-swap Stage 3 archive", () => {
  it("archives signed evidence and schedules the swap without creating an extension segment", async () => {
    const state = {
      change: {
        changeType: SubscriptionChangeType.VEHICLE_SWAP,
        completionDeadlineAt: new Date("2026-09-15T02:00:00.000Z"),
        confirmedQuote: {
          id: "quote-swap",
          status: SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED
        },
        contract: { id: "contract-swap" },
        contractId: "contract-swap",
        id: "change-swap",
        orderId: "order-1",
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
        vehicleSwapDetail: {
          targetVehicle: { id: "vehicle-target", status: VehicleStatus.REVIEW_RESERVED },
          targetVehicleId: "vehicle-target"
        },
        version: 4
      },
      contract: {
        archivedAt: null as Date | null,
        id: "contract-swap",
        signedAt: null as Date | null,
        status: ContractStatus.SIGNED
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
          contractId: "contract-swap",
          documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
          id: "task-swap",
          signedDocumentObjectKey: "signed/swap.pdf",
          signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
          taskStatus: ESignTaskStatus.COMPLETED
        }))
      },
      subscriptionChangeOrder: {
        findUnique: vi.fn(async () => state.change),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(state.change, data);
          if (data.version && typeof data.version === "object") state.change.version += 1;
          return state.change;
        })
      },
      subscriptionContractSegment: {
        create: vi.fn(),
        findFirst: vi.fn(async () => null)
      }
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx))
    };
    const service = new Stage3ExtensionArchiveService(
      prisma as never,
      { write: vi.fn(async () => undefined) } as never
    );

    const result = await service.finalizeArchivedContract({
      completedAt: new Date("2026-08-27T03:59:59.000Z"),
      contractId: "contract-swap",
      source: "CALLBACK",
      taskId: "task-swap"
    });

    expect(result).toEqual({ changeOrderId: "change-swap", outcome: "SCHEDULED" });
    expect(state.contract.status).toBe(ContractStatus.ARCHIVED);
    expect(state.change.status).toBe(SubscriptionChangeStatus.SCHEDULED);
    expect(tx.subscriptionContractSegment.create).not.toHaveBeenCalled();
  });
});
