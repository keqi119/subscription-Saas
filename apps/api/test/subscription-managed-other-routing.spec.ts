import { ESignDocumentType, ESignSigningStage, SubscriptionChangeType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { resolveContractESignProfile } from "../src/esign/esign.service";
import { SubscriptionChangeController } from "../src/subscription-change/subscription-change.controller";

describe("managed-other supplement routing", () => {
  it("uses the Stage 3 provider protocol with a distinct governed source", () => {
    expect(
      resolveContractESignProfile({
        subscriptionChange: {
          changeType: SubscriptionChangeType.MANAGED_OTHER,
          id: "change-managed"
        }
      })
    ).toEqual({
      documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
      forceMultiSlot: true,
      providerSigningStage: "STAGE1_CONTRACT",
      signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
      sourceType: "MANAGED_OTHER_SUPPLEMENT"
    });
  });

  it("dispatches generation and e-sign through the managed-other workflow", async () => {
    const extension = { startOrRetryESign: vi.fn() };
    const extensionContract = { generate: vi.fn() };
    const esign = {
      createTaskForContract: vi.fn(async () => ({ id: "task-managed" })),
      findActiveTaskForContract: vi.fn(async () => null),
      getTask: vi.fn()
    };
    const changeService = {
      getWorkflowChangeType: vi.fn(async () => SubscriptionChangeType.MANAGED_OTHER)
    };
    const managed = {
      generate: vi.fn(async () => ({ id: "contract-managed" })),
      startOrRetryESign: vi.fn(
        async (
          _id: string,
          _input: unknown,
          _actor: unknown,
          start: (contractId: string) => Promise<unknown>
        ) => start("contract-managed")
      )
    };
    const controller = new SubscriptionChangeController(
      extension as never,
      extensionContract as never,
      esign as never,
      changeService as never,
      undefined,
      undefined,
      managed as never
    );
    const request = {
      headers: { "user-agent": "vitest" },
      ip: "127.0.0.1",
      user: { id: "operator-1", permissions: [] }
    };

    await controller.generateExtensionContract(
      "change-managed",
      { version: 1 },
      "generate-managed",
      request as never
    );
    await controller.startESign(
      "change-managed",
      { version: 2 },
      "esign-managed",
      request as never
    );

    expect(managed.generate).toHaveBeenCalledOnce();
    expect(managed.startOrRetryESign).toHaveBeenCalledOnce();
    expect(extensionContract.generate).not.toHaveBeenCalled();
    expect(extension.startOrRetryESign).not.toHaveBeenCalled();
    expect(esign.createTaskForContract).toHaveBeenCalledWith("contract-managed", request.user, {
      ipAddress: "127.0.0.1",
      userAgent: "vitest"
    });
  });
});
