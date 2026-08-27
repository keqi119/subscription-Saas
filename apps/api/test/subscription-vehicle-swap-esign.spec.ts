import { ESignDocumentType, ESignSigningStage, SubscriptionChangeType } from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { resolveContractESignProfile } from "../src/esign/esign.service";
import { SubscriptionChangeController } from "../src/subscription-change/subscription-change.controller";

describe("vehicle-swap supplement e-sign mapping", () => {
  it("uses the Stage 3 slot protocol with a distinct governed vehicle-swap source", () => {
    expect(
      resolveContractESignProfile({
        subscriptionChange: {
          changeType: SubscriptionChangeType.VEHICLE_SWAP,
          id: "change-swap"
        }
      })
    ).toEqual({
      documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
      forceMultiSlot: true,
      providerSigningStage: "STAGE1_CONTRACT",
      signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
      sourceType: "VEHICLE_SWAP_SUPPLEMENT"
    });
  });

  it("dispatches supplement generation and e-sign start through the swap contract service", async () => {
    const extension = { startOrRetryESign: vi.fn() };
    const extensionContract = { generate: vi.fn() };
    const esign = {
      createTaskForContract: vi.fn(async () => ({ id: "task-swap" })),
      findActiveTaskForContract: vi.fn(async () => null),
      getTask: vi.fn()
    };
    const changeService = {
      getChangeType: vi.fn(async () => SubscriptionChangeType.VEHICLE_SWAP)
    };
    const swapContract = {
      generate: vi.fn(async () => ({ id: "contract-swap" })),
      startOrRetryESign: vi.fn(
        async (
          _id: string,
          _input: unknown,
          _actor: unknown,
          start: (contractId: string) => Promise<unknown>
        ) => start("contract-swap")
      )
    };
    const controller = new SubscriptionChangeController(
      extension as never,
      extensionContract as never,
      esign as never,
      changeService as never,
      swapContract as never
    );
    const request = {
      headers: { "user-agent": "vitest" },
      ip: "127.0.0.1",
      user: {
        id: "operator-1",
        menus: [],
        name: "Operator",
        permissions: [
          PermissionCode.CONTRACT_GENERATE,
          PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY
        ],
        roles: ["OP"],
        username: "operator"
      }
    };

    await controller.generateExtensionContract(
      "change-swap",
      { version: 3 },
      "generate-swap",
      request as never
    );
    await controller.startESign("change-swap", { version: 4 }, "esign-swap", request as never);

    expect(swapContract.generate).toHaveBeenCalledOnce();
    expect(swapContract.startOrRetryESign).toHaveBeenCalledOnce();
    expect(extensionContract.generate).not.toHaveBeenCalled();
    expect(extension.startOrRetryESign).not.toHaveBeenCalled();
    expect(esign.createTaskForContract).toHaveBeenCalledWith("contract-swap", request.user, {
      ipAddress: "127.0.0.1",
      userAgent: "vitest"
    });
  });
});
