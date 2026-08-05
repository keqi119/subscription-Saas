import { ESignDocumentType, ESignSigningStage } from "@prisma/client";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ESignService, resolveContractESignProfile } from "../src/esign/esign.service";
import { PortalContractController } from "../src/portal/portal-contract.controller";
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

  it("exposes the customer-scoped generated extension PDF preview", async () => {
    const handler = PortalContractController.prototype.previewGeneratedContract;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "contracts/:id/generated-document/preview"
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);

    const esign = {
      getPortalGeneratedContractPreview: vi.fn(async () => ({
        buffer: Buffer.from("%PDF-1.4 extension"),
        contentType: "application/pdf",
        filename: "extension.pdf",
        sizeBytes: 18
      }))
    };
    const response = { setHeader: vi.fn() };
    const controller = new PortalContractController(esign as never, {} as never);
    const currentCustomer = {
      accountStatus: "ACTIVE",
      customerAccountId: "account-1",
      customerId: "customer-1",
      phone: "13800000000"
    } as never;

    await expect(
      controller.previewGeneratedContract(
        "contract-1",
        currentCustomer,
        response as never
      )
    ).resolves.toBeDefined();
    expect(esign.getPortalGeneratedContractPreview).toHaveBeenCalledWith(
      "contract-1",
      currentCustomer
    );
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "application/pdf");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Length", "18");
  });

  it("checks portal ownership before reading the generated PDF artifact", async () => {
    const prisma = {
      contract: {
        findFirst: vi.fn(async () => ({ id: "contract-1" }))
      }
    };
    const artifactService = {
      getContractPdfArtifact: vi.fn(async () => ({
        buffer: Buffer.from("%PDF-1.4 extension"),
        contentType: "application/pdf",
        fileName: "extension.pdf",
        size: 18
      }))
    };
    const service = new ESignService(
      {} as never,
      {} as never,
      {} as never,
      prisma as never,
      undefined,
      artifactService as never
    );

    await expect(
      service.getPortalGeneratedContractPreview("contract-1", {
        accountStatus: "ACTIVE",
        customerAccountId: "account-1",
        customerId: "customer-1",
        phone: "13800000000"
      } as never)
    ).resolves.toMatchObject({
      contentType: "application/pdf",
      filename: "extension.pdf",
      sizeBytes: 18
    });
    expect(prisma.contract.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerId: "customer-1", id: "contract-1" })
      })
    );
    expect(artifactService.getContractPdfArtifact).toHaveBeenCalledWith(
      "contract-1",
      { requireGeneratedContractArtifact: true }
    );
  });
});
