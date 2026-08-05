import { ESignDocumentType, ESignSigningStage } from "@prisma/client";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { resolveContractESignProfile } from "../src/esign/esign.service";
import { SubscriptionChangeController } from "../src/subscription-change/subscription-change.controller";

describe("Stage 3 extension e-sign mapping", () => {
  it("uses a dedicated persisted Stage 3 identity with the proven Stage 1 PDF slot protocol", () => {
    expect(resolveContractESignProfile({ subscriptionChange: { id: "change-1" } })).toEqual({
      documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
      forceMultiSlot: true,
      providerSigningStage: "STAGE1_CONTRACT",
      signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION
    });
  });

  it("keeps the original contract mapping unchanged", () => {
    expect(resolveContractESignProfile({ subscriptionChange: null })).toEqual({
      documentType: ESignDocumentType.SUBSCRIPTION_CONTRACT,
      forceMultiSlot: false,
      providerSigningStage: "STAGE1_CONTRACT",
      signingStage: ESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT
    });
  });

  it.each([
    ["startESign", ":id/esign/start"],
    ["retryESign", ":id/esign/retry"],
    ["retryAutomationJob", ":id/jobs/:jobId/retry"]
  ] as const)("exposes the Admin recovery route %s", (method, path) => {
    const handler = SubscriptionChangeController.prototype[method];
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it("starts Stage 3 e-sign through the change-scoped permission boundary", async () => {
    const user = {
      id: "op-1",
      menus: [],
      name: "Operator",
      permissions: ["subscription_change:view", "subscription_change:esign_retry"],
      roles: ["OP"],
      username: "op"
    };
    const service = {
      startOrRetryESign: vi.fn(async (
        _id: string,
        _input: unknown,
        _user: unknown,
        start: (contractId: string) => Promise<unknown>
      ) => start("contract-1"))
    };
    const esign = {
      createTaskForContract: vi.fn(async () => ({ id: "task-1", taskStatus: "WAITING_CUSTOMER" }))
    };
    const controller = new SubscriptionChangeController(
      service as never,
      undefined,
      esign as never
    );

    await expect(
      controller.startESign(
        "change-1",
        { version: 3 },
        "esign-command-1",
        {
          headers: { "user-agent": "vitest" },
          ip: "127.0.0.1",
          user
        } as never
      )
    ).resolves.toMatchObject({ id: "task-1" });
    expect(service.startOrRetryESign).toHaveBeenCalledWith(
      "change-1",
      { idempotencyKey: "esign-command-1", version: 3 },
      user,
      expect.any(Function)
    );
    expect(esign.createTaskForContract).toHaveBeenCalledWith(
      "contract-1",
      user,
      { ipAddress: "127.0.0.1", userAgent: "vitest" }
    );
  });

  it("does not start e-sign after the change leaves its signing state", async () => {
    const service = {
      startOrRetryESign: vi.fn(async () => {
        throw Object.assign(new Error("not allowed"), { status: 409 });
      })
    };
    const esign = { createTaskForContract: vi.fn() };
    const controller = new SubscriptionChangeController(
      service as never,
      undefined,
      esign as never
    );

    await expect(
      controller.retryESign(
        "change-1",
        { version: 0 },
        "esign-command-2",
        {
          headers: {},
          user: {
            id: "op-1",
            menus: [],
            name: "Operator",
            permissions: ["subscription_change:view", "subscription_change:esign_retry"],
            roles: ["OP"],
            username: "op"
          }
        } as never
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(esign.createTaskForContract).not.toHaveBeenCalled();
  });
});
