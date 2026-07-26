import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  CustomerAccountStatus,
  ESignProviderCertBindingSource,
  ESignProviderCertBindingStatus,
  ESignProviderAccountStatus,
  ESignProviderAccountType,
  ESignProviderType,
  ESignProviderRealNameStatusSource,
  ESignRealNameStatus,
  ESignSignerStatus,
  ESignSignerType,
  ESignTaskStatus,
  OrderStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { RequestUser } from "../src/auth/auth.types";
import { ESignProvider, ESignProviderActionResult, ESignSlotId } from "../src/esign/esign.provider";
import { ESignService } from "../src/esign/esign.service";
import type {
  ApprovedSigningPlanRef,
  EnterpriseSealView,
  SealAuthorityView,
  SignaturePolicyEngineInput,
  SignaturePolicyView
} from "../src/esign/enterprise-seal/enterprise-seal.types";
import { SignaturePolicyEngine } from "../src/esign/enterprise-seal/signature-policy-engine";
import { toApprovedSigningPlanRef } from "../src/esign/enterprise-seal/signing-plan-compiler";
import { buildFadadaMsgDigest } from "../src/esign/fadada/fadada-digest";
import { FadadaESignProvider } from "../src/esign/fadada/fadada-esign.provider";
import { loadFadadaConfig } from "../src/esign/fadada/fadada.config";
import { MockESignProvider } from "../src/esign/mock-esign.provider";
import { CurrentCustomer } from "../src/portal/portal-auth.types";

describe("ESignService", () => {
  it("creates a mock e-sign task for a generated contract", async () => {
    const { service, state } = createESignFixture();

    const result = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(result).toMatchObject({
      contractId: "contract-1",
      provider: ESignProviderType.MOCK,
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    expect(result.providerTaskId).toMatch(/^mock_ESG/);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.tasks).toHaveLength(1);
    expect(state.signers[0]).toMatchObject({
      signerStatus: ESignSignerStatus.SIGNING,
      signerType: ESignSignerType.CUSTOMER
    });
  });

  it("persists provider signer identifiers and sign URLs from a Fadada provider result", async () => {
    const signUrlExpiresAt = new Date("2026-01-02T03:34:05.000Z");
    const provider: ESignProvider = {
      createSignTask: vi.fn(async () => ({
        documentObjectKey: "contracts/contract-1.pdf",
        providerEnvelopeId: "ESG-1",
        providerTaskId: "ESG-1-1",
        rawResponse: { provider: "fadada" },
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt,
        signers: [{
          customerId: "customer-1",
          providerSignerId: "ESG-1-1",
          signUrl: "https://sign.example.test/customer",
          signUrlExpiresAt,
          signerType: "CUSTOMER" as const
        }]
      })),
      getSignerUrl: vi.fn(),
      verifyCallback: vi.fn()
    };
    const { service, state } = createESignFixture({ ESIGN_PROVIDER: "fadada" }, provider);

    const result = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(result).toMatchObject({
      provider: ESignProviderType.FADADA,
      providerTaskId: "ESG-1-1",
      signUrl: "https://sign.example.test/customer"
    });
    expect(state.tasks[0]).toMatchObject({
      documentObjectKey: "contracts/contract-1.pdf",
      providerEnvelopeId: "ESG-1",
      providerTaskId: "ESG-1-1",
      signUrl: "https://sign.example.test/customer"
    });
    expect(state.signers[0]).toMatchObject({
      providerSignerId: "ESG-1-1",
      signerStatus: ESignSignerStatus.SIGNING,
      signUrl: "https://sign.example.test/customer"
    });
  });

  it("keeps legacy provider input when Stage 1 multi-slot flag is disabled", async () => {
    const provider: ESignProvider = {
      createSignTask: vi.fn(async (input) => ({
        providerEnvelopeId: input.taskNo,
        providerTaskId: buildTestTransactionId(input.taskNo, 1),
        signUrl: "https://sign.example.test/customer"
      })),
      getSignerUrl: vi.fn(),
      verifyCallback: vi.fn()
    };
    const { service, state } = createESignFixture({ ESIGN_PROVIDER: "fadada" }, provider);

    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(provider.createSignTask).toHaveBeenCalledWith(expect.not.objectContaining({
      signingSlots: expect.anything()
    }));
    expect(state.signers).toHaveLength(1);
    expect(state.signers[0]!.snapshot).not.toMatchObject({
      signingStage: "STAGE1_CONTRACT"
    });
  });

  it("creates Stage 1 slot rows from slot-capable provider results", async () => {
    const provider = stage1SlotProvider();
    const { service, state } = createESignFixture({
      ESIGN_PROVIDER: "fadada",
      ESIGN_STAGE1_MULTI_SLOT_ENABLED: "true"
    }, provider);

    const result = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(result.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(provider.createSignTask).toHaveBeenCalledWith(expect.objectContaining({
      signingStage: "STAGE1_CONTRACT",
      signingSlots: expect.arrayContaining([
        expect.objectContaining({ slotId: "STAGE1_BODY_CUSTOMER" }),
        expect.objectContaining({ slotId: "STAGE1_BODY_PLATFORM" }),
        expect.objectContaining({ slotId: "STAGE1_ATTACHMENT1_CUSTOMER" }),
        expect.objectContaining({ slotId: "STAGE1_ATTACHMENT1_PLATFORM" })
      ])
    }));
    expect(state.signers).toHaveLength(4);
    expect(state.signers.filter((signer) => signer.signerType === ESignSignerType.CUSTOMER)).toHaveLength(2);
    expect(state.signers.filter((signer) => signer.signerType === ESignSignerType.PLATFORM)).toHaveLength(2);
    expect(state.signers.filter((signer) => signer.providerSignerId === "CUSTS1")).toHaveLength(2);
    expect(state.signers.filter((signer) => signer.providerSignerId === "PLATS1")).toHaveLength(2);
    expect(state.signers.find((signer) => readSnapshotField(signer.snapshot, "slotId") === "STAGE1_BODY_CUSTOMER")).toMatchObject({
      signerStatus: ESignSignerStatus.SIGNING,
      signUrl: "https://sign.example.test/customer-stage1"
    });
    expect(state.signers.find((signer) => readSnapshotField(signer.snapshot, "slotId") === "STAGE1_ATTACHMENT1_PLATFORM")).toMatchObject({
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(state.signers.map((signer) => signer.snapshot)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentType: "CONTRACT_BODY",
        keyword: "合同正文-订阅方签字",
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerTransactionId: "CUSTS1",
        signingStage: "STAGE1_CONTRACT",
        slotId: "STAGE1_BODY_CUSTOMER"
      }),
      expect.objectContaining({
        documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
        keyword: "附件1订阅方案-服务提供方盖章",
        providerActionType: "PLATFORM_AUTO_SEAL",
        providerTransactionId: "PLATS1",
        signingStage: "STAGE1_CONTRACT",
        slotId: "STAGE1_ATTACHMENT1_PLATFORM"
      })
    ]));
  });

  it("completes Stage 1 slot rows by provider transaction before completing the task", async () => {
    const provider = stage1SlotProvider();
    const { service, state } = createESignFixture({
      ESIGN_PROVIDER: "fadada",
      ESIGN_STAGE1_MULTI_SLOT_ENABLED: "true"
    }, provider);
    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const customerResult = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "CUSTS1"
    }));
    const customerSignedAt = state.signers.find((signer) => signer.providerSignerId === "CUSTS1")!.signedAt;
    const duplicateCustomerResult = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "CUSTS1"
    }));

    expect(customerResult).toMatchObject({ handled: true });
    expect(duplicateCustomerResult).toMatchObject({ handled: true });
    expect(state.signers.filter((signer) => signer.providerSignerId === "CUSTS1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ signerStatus: ESignSignerStatus.SIGNED, signedAt: customerSignedAt }),
      expect.objectContaining({ signerStatus: ESignSignerStatus.SIGNED, signedAt: customerSignedAt })
    ]));
    expect(state.signers.filter((signer) => signer.providerSignerId === "PLATS1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ signerStatus: ESignSignerStatus.PENDING }),
      expect.objectContaining({ signerStatus: ESignSignerStatus.PENDING })
    ]));
    expect(state.tasks[0]).toMatchObject({
      completedAt: null,
      taskStatus: ESignTaskStatus.SIGNING
    });
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);

    const platformResult = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "PLATS1"
    }));

    expect(platformResult).toMatchObject({ handled: true });
    expect(state.signers.every((signer) => signer.signerStatus === ESignSignerStatus.SIGNED)).toBe(true);
    expect(state.tasks[0]).toMatchObject({
      completedAt: expect.any(Date),
      taskStatus: ESignTaskStatus.COMPLETED
    });
    expect(state.contracts[0]).toMatchObject({
      signedAt: expect.any(Date),
      status: ContractStatus.SIGNED
    });
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("completes Stage 2 handover slots without running Stage 1 order side effects", async () => {
    const verifier = new FadadaESignProvider(loadFadadaConfig(fadadaConfigService()));
    const { prisma, service, state } = createESignFixture({ ESIGN_PROVIDER: "fadada" }, {
      createSignTask: vi.fn(),
      getSignerUrl: vi.fn(),
      verifyCallback: verifier.verifyCallback.bind(verifier)
    });
    const handoverContract = createContract("handover-contract-1", "customer-1", "order-1", "ORD-1");
    handoverContract.contractNo = "HDV-1";
    handoverContract.contractTitle = "车辆交付交接确认书";
    handoverContract.order.contractId = "contract-1";
    handoverContract.order.orderStatus = OrderStatus.PENDING_DELIVERY;
    state.contracts.push(handoverContract);
    state.deliveryHandovers.push({
      archiveStatus: "NOT_STARTED",
      completedAt: null,
      deletedAt: null,
      handoverContractId: handoverContract.id,
      handoverESignTaskId: "stage2-task-1",
      id: "handover-1",
      orderId: "order-1",
      status: "PENDING_CUSTOMER_SIGNATURE"
    });
    state.tasks.push({
      callbackSnapshot: null,
      cancelledAt: null,
      completedAt: null,
      contractId: handoverContract.id,
      createdAt: new Date(),
      customerId: "customer-1",
      deletedAt: null,
      documentName: "车辆交付交接确认书",
      errorSnapshot: null,
      evidenceObjectKey: null,
      failedAt: null,
      id: "stage2-task-1",
      orderId: "order-1",
      provider: ESignProviderType.FADADA,
      providerEnvelopeId: "HDV-PROVIDER-1",
      providerTaskId: null,
      requestSnapshot: { signingStage: "STAGE2_DELIVERY_HANDOVER" },
      responseSnapshot: null,
      signUrl: null,
      signUrlExpiresAt: null,
      signedDocumentObjectKey: null,
      startedAt: new Date(),
      taskNo: "ESG-STAGE2-1",
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER,
      updatedAt: new Date()
    });
    state.signers.push(
      {
        customerId: "customer-1",
        deletedAt: null,
        id: "stage2-signer-customer",
        providerSignerId: "CUSTH1",
        rejectReason: null,
        rejectedAt: null,
        signedAt: null,
        signerIdNoMasked: null,
        signerName: "张三",
        signerPhone: "13800000000",
        signerStatus: ESignSignerStatus.SIGNING,
        signerType: ESignSignerType.CUSTOMER,
        signUrl: "https://sign.example.test/stage2-customer",
        signUrlExpiresAt: null,
        snapshot: {
          documentType: "DELIVERY_HANDOVER",
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          required: true,
          signingStage: "STAGE2_DELIVERY_HANDOVER",
          slotId: "STAGE2_HANDOVER_CUSTOMER"
        },
        taskId: "stage2-task-1"
      },
      {
        customerId: null,
        deletedAt: null,
        id: "stage2-signer-platform",
        providerSignerId: "PLATH1",
        rejectReason: null,
        rejectedAt: null,
        signedAt: null,
        signerIdNoMasked: null,
        signerName: "Platform",
        signerPhone: null,
        signerStatus: ESignSignerStatus.PENDING,
        signerType: ESignSignerType.PLATFORM,
        signUrl: null,
        signUrlExpiresAt: null,
        snapshot: {
          documentType: "DELIVERY_HANDOVER",
          providerActionType: "PLATFORM_AUTO_SEAL",
          required: true,
          signingStage: "STAGE2_DELIVERY_HANDOVER",
          slotId: "STAGE2_HANDOVER_PLATFORM"
        },
        taskId: "stage2-task-1"
      }
    );

    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: "HDV-PROVIDER-1",
      resultCode: "3000",
      transactionId: "CUSTH1"
    }));

    expect(state.tasks.find((task) => task.id === "stage2-task-1")).toMatchObject({
      completedAt: null,
      taskStatus: ESignTaskStatus.SIGNING
    });
    expect(handoverContract.order.orderStatus).toBe(OrderStatus.PENDING_DELIVERY);

    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: "HDV-PROVIDER-1",
      resultCode: "3000",
      transactionId: "PLATH1"
    }));

    expect(state.tasks.find((task) => task.id === "stage2-task-1")).toMatchObject({
      completedAt: expect.any(Date),
      taskStatus: ESignTaskStatus.COMPLETED
    });
    expect(handoverContract).toMatchObject({
      signedAt: expect.any(Date),
      status: ContractStatus.SIGNED
    });
    expect(state.deliveryHandovers[0]).toMatchObject({
      completedAt: expect.any(Date),
      customerSignedAt: expect.any(Date),
      platformSignedAt: expect.any(Date),
      status: "SIGNED"
    });
    expect(handoverContract.order.orderStatus).toBe(OrderStatus.PENDING_DELIVERY);
    expect(prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an invalid Stage 2 digest before mutating typed signer, task, contract, or handover state", async () => {
    const harness = createTypedStage2CallbackFixture();
    const before = snapshotTypedStage2State(harness.state);
    const payload = {
      ...fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3000",
        transactionId: harness.customerTransactionId
      }),
      msg_digest: "invalid"
    };

    const result = await harness.service.handleCallback("fadada", payload);

    expect(result).toEqual({ handled: false, reason: "UNVERIFIED" });
    expect(snapshotTypedStage2State(harness.state)).toEqual(before);
    expect(harness.prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
    expect(harness.notificationService.notifyCustomer).not.toHaveBeenCalled();
  });

  it("handles a Stage 2 customer callback before the platform transaction exists", async () => {
    const harness = createTypedStage2CallbackFixture();
    harness.platformSigner.providerTransactionId = null;

    const result = await harness.service.handleCallback(
      "fadada",
      fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3000",
        transactionId: harness.customerTransactionId
      })
    );

    expect(result).toMatchObject({
      handled: true,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: harness.task.id
    });
    expect(harness.customerSigner.signerStatus).toBe(ESignSignerStatus.SIGNED);
    expect(harness.platformSigner).toMatchObject({
      providerTransactionId: null,
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(harness.task).toMatchObject({
      completedAt: null,
      taskStatus: ESignTaskStatus.SIGNING
    });
    expect(harness.handover).toMatchObject({
      completedAt: null,
      status: "PENDING_PLATFORM_SEAL"
    });
    expect(harness.state.callbackLogs).toHaveLength(1);
    expect(harness.state.callbackLogs[0]).toMatchObject({
      handled: true,
      handledAt: expect.any(Date)
    });
  });

  it("correlates a Stage 2 customer callback by typed transaction and dedupes the canonical sanitized payload", async () => {
    const harness = createTypedStage2CallbackFixture({
      customerProviderSignerId: "LEGACY-CUSTOMER-ID"
    });
    const payload = {
      ...fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3000",
        transactionId: `  ${harness.customerTransactionId}  `
      }),
      authorization: "Bearer callback-secret",
      certNo: "CERT-NO-ORIGINAL",
      certNumber: "CERT-NUMBER-ORIGINAL",
      idCard: "ID-CARD-ORIGINAL",
      id_number: "310101199001011234",
      identityNo: "IDENTITY-NO-ORIGINAL",
      mobile: "13800000000",
      nestedIdentity: {
        CertificateNo: "CERTIFICATE-NO-ORIGINAL",
        IDCard: "NESTED-ID-CARD-ORIGINAL"
      },
      otp: "123456"
    };

    const first = await harness.service.handleCallback("fadada", payload);
    const signedAt = harness.customerSigner.signedAt;
    const duplicate = await harness.service.handleCallback(
      "fadada",
      Object.fromEntries(Object.entries(payload).reverse())
    );

    expect(first).toMatchObject({
      handled: true,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: harness.task.id
    });
    expect(duplicate).toMatchObject({
      handled: true,
      idempotent: true,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: harness.task.id
    });
    expect(harness.customerSigner).toMatchObject({
      providerSignerId: "LEGACY-CUSTOMER-ID",
      signerStatus: ESignSignerStatus.SIGNED,
      signedAt
    });
    expect(harness.platformSigner.signerStatus).toBe(ESignSignerStatus.PENDING);
    expect(harness.state.callbackLogs).toHaveLength(1);
    expect(harness.state.callbackLogs[0]).toMatchObject({
      handled: true,
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      providerTransactionId: harness.customerTransactionId,
      taskId: harness.task.id,
      verified: true
    });
    const loggedPayload = JSON.stringify(harness.state.callbackLogs[0]!.payload);
    expect(loggedPayload).not.toContain("callback-secret");
    expect(loggedPayload).not.toContain("310101199001011234");
    expect(loggedPayload).not.toContain("13800000000");
    expect(loggedPayload).not.toContain("123456");
    expect(loggedPayload).not.toContain("CERT-NO-ORIGINAL");
    expect(loggedPayload).not.toContain("CERT-NUMBER-ORIGINAL");
    expect(loggedPayload).not.toContain("ID-CARD-ORIGINAL");
    expect(loggedPayload).not.toContain("IDENTITY-NO-ORIGINAL");
    expect(loggedPayload).not.toContain("CERTIFICATE-NO-ORIGINAL");
    expect(loggedPayload).not.toContain("NESTED-ID-CARD-ORIGINAL");
    expect(loggedPayload).not.toContain("download.example.test");
    expect(loggedPayload).not.toContain("view.example.test");
    expect(loggedPayload).not.toContain("msg_digest");
    const callbackSnapshot = JSON.stringify(harness.task.callbackSnapshot);
    expect(callbackSnapshot).not.toContain("CERT-NO-ORIGINAL");
    expect(callbackSnapshot).not.toContain("CERT-NUMBER-ORIGINAL");
    expect(callbackSnapshot).not.toContain("ID-CARD-ORIGINAL");
    expect(callbackSnapshot).not.toContain("IDENTITY-NO-ORIGINAL");
    expect(callbackSnapshot).not.toContain("CERTIFICATE-NO-ORIGINAL");
    expect(callbackSnapshot).not.toContain("NESTED-ID-CARD-ORIGINAL");
    expect(JSON.stringify(first)).not.toContain("sign.example.test");
    expect(harness.prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
    expect(harness.notificationService.notifyCustomer).not.toHaveBeenCalled();
  });

  it("keeps a failed Stage 2 platform callback retryable without failing the task or handover", async () => {
    const harness = createTypedStage2CallbackFixture();
    harness.customerSigner.signerStatus = ESignSignerStatus.SIGNED;
    harness.customerSigner.signedAt = new Date("2026-07-26T01:05:00.000Z");
    const freshClaimExpiresAt = new Date(Date.now() + 60_000);
    harness.platformSigner.claimExpiresAt = freshClaimExpiresAt;
    harness.task.taskStatus = ESignTaskStatus.SIGNING;
    harness.handover.customerSignedAt = harness.customerSigner.signedAt;
    harness.handover.status = "PENDING_PLATFORM_SEAL";

    const result = await harness.service.handleCallback(
      "fadada",
      fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3001",
        resultDesc: "platform seal failed",
        transactionId: harness.platformTransactionId
      })
    );

    expect(result).toMatchObject({
      handled: true,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: harness.task.id
    });
    expect(harness.platformSigner).toMatchObject({
      claimExpiresAt: freshClaimExpiresAt,
      lastErrorCode: "FADADA_STAGE2_PLATFORM_SEAL_FAILED",
      nextRetryAt: expect.any(Date),
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(harness.task.taskStatus).toBe(ESignTaskStatus.SIGNING);
    expect(harness.handover.status).toBe("PENDING_PLATFORM_SEAL");
    expect(harness.stage1Contract.order.orderStatus).toBe(
      OrderStatus.PENDING_DELIVERY
    );
    expect(harness.prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
  });

  it("keeps an unknown Stage 2 platform callback retryable and records a bounded error", async () => {
    const harness = createTypedStage2CallbackFixture();
    harness.customerSigner.signerStatus = ESignSignerStatus.SIGNED;
    harness.customerSigner.signedAt = new Date("2026-07-26T01:05:00.000Z");
    const freshClaimExpiresAt = new Date(Date.now() + 60_000);
    harness.platformSigner.claimExpiresAt = freshClaimExpiresAt;
    harness.task.taskStatus = ESignTaskStatus.SIGNING;
    harness.handover.customerSignedAt = harness.customerSigner.signedAt;
    harness.handover.status = "PENDING_PLATFORM_SEAL";

    const result = await harness.service.handleCallback(
      "fadada",
      fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3999",
        resultDesc: "unknown platform result",
        transactionId: harness.platformTransactionId
      })
    );

    expect(result).toMatchObject({
      handled: false,
      reason: "UNKNOWN_RESULT_CODE",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: harness.task.id
    });
    expect(harness.platformSigner).toMatchObject({
      claimExpiresAt: freshClaimExpiresAt,
      lastErrorCode: "FADADA_STAGE2_PLATFORM_RESULT_UNKNOWN",
      nextRetryAt: expect.any(Date),
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(harness.task.taskStatus).toBe(ESignTaskStatus.SIGNING);
    expect(harness.handover.status).toBe("PENDING_PLATFORM_SEAL");
    expect(harness.prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
  });

  it("retries an identical Stage 2 callback when the recorded callback transaction rolled back", async () => {
    const harness = createTypedStage2CallbackFixture();
    harness.platformSigner.providerTransactionId = null;
    const payload = fadadaCallbackPayload({
      contractId: harness.providerContractId,
      resultCode: "3000",
      transactionId: harness.customerTransactionId
    });
    harness.prisma.$transaction.mockRejectedValueOnce(
      new Error("simulated callback transaction rollback")
    );

    await expect(
      harness.service.handleCallback("fadada", payload)
    ).rejects.toThrow("simulated callback transaction rollback");

    expect(harness.state.callbackLogs).toHaveLength(1);
    expect(harness.state.callbackLogs[0]).toMatchObject({
      handled: false,
      handledAt: null,
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(harness.customerSigner.signerStatus).toBe(ESignSignerStatus.SIGNING);

    const retried = await harness.service.handleCallback("fadada", payload);

    expect(retried).toMatchObject({
      handled: true,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: harness.task.id
    });
    expect(retried).not.toHaveProperty("idempotent");
    expect(harness.state.callbackLogs).toHaveLength(1);
    expect(harness.state.callbackLogs[0]).toMatchObject({
      handled: true,
      handledAt: expect.any(Date)
    });
    expect(harness.customerSigner.signerStatus).toBe(ESignSignerStatus.SIGNED);
    expect(harness.platformSigner.providerTransactionId).toBeNull();
  });

  it("lets an overlapping identical callback recover an in-flight callback that rolls back", async () => {
    const harness = createTypedStage2CallbackFixture();
    const payload = fadadaCallbackPayload({
      contractId: harness.providerContractId,
      resultCode: "3000",
      transactionId: harness.customerTransactionId
    });
    let firstTransactionEntered!: () => void;
    let rejectFirstTransaction!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstTransactionEntered = resolve;
    });
    const rejected = new Promise<void>((resolve) => {
      rejectFirstTransaction = resolve;
    });
    harness.prisma.$transaction.mockImplementationOnce(async () => {
      firstTransactionEntered();
      await rejected;
      throw new Error("simulated overlapping callback rollback");
    });

    const first = harness.service.handleCallback("fadada", payload);
    await entered;
    const second = await harness.service.handleCallback(
      "fadada",
      Object.fromEntries(Object.entries(payload).reverse())
    );
    rejectFirstTransaction();

    await expect(first).rejects.toThrow(
      "simulated overlapping callback rollback"
    );
    expect(second).toMatchObject({
      handled: true,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: harness.task.id
    });
    expect(second).not.toHaveProperty("idempotent");
    expect(harness.state.callbackLogs).toHaveLength(1);
    expect(harness.state.callbackLogs[0]).toMatchObject({
      handled: true,
      handledAt: expect.any(Date)
    });
    expect(harness.customerSigner.signerStatus).toBe(ESignSignerStatus.SIGNED);
  });

  it("records an unknown Stage 2 transaction safely without mutating the typed task", async () => {
    const harness = createTypedStage2CallbackFixture();
    const before = snapshotTypedStage2State(harness.state);
    const payload = fadadaCallbackPayload({
      contractId: harness.providerContractId,
      resultCode: "3000",
      transactionId: "UNKNOWNSTAGE2H1"
    });

    const result = await harness.service.handleCallback("fadada", payload);

    expect(result).toEqual({ handled: false, reason: "TASK_NOT_FOUND" });
    expect(snapshotTypedStage2State(harness.state)).toEqual(before);
    expect(harness.state.callbackLogs).toHaveLength(1);
    expect(harness.state.callbackLogs[0]).toMatchObject({
      errorMessage: "ESIGN_CALLBACK_TRANSACTION_NOT_FOUND",
      handled: true,
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      providerTransactionId: "UNKNOWNSTAGE2H1",
      taskId: harness.task.id,
      verified: true
    });
  });

  it("canonically dedupes a verified callback when both transaction and contract are unknown", async () => {
    const harness = createTypedStage2CallbackFixture();
    const before = snapshotTypedStage2State(harness.state);
    const payload = fadadaCallbackPayload({
      contractId: "UNKNOWNPROVIDERCONTRACT",
      resultCode: "3000",
      transactionId: "UNKNOWNPROVIDERTRANSACTION"
    });

    const first = await harness.service.handleCallback("fadada", payload);
    const duplicate = await harness.service.handleCallback(
      "fadada",
      Object.fromEntries(Object.entries(payload).reverse())
    );

    expect(first).toEqual({ handled: false, reason: "TASK_NOT_FOUND" });
    expect(duplicate).toEqual({
      handled: true,
      idempotent: true
    });
    expect(snapshotTypedStage2State(harness.state)).toEqual(before);
    expect(harness.state.callbackLogs).toHaveLength(1);
    expect(harness.state.callbackLogs[0]).toMatchObject({
      errorMessage: "ESIGN_CALLBACK_TRANSACTION_NOT_FOUND",
      handled: true,
      handledAt: expect.any(Date),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      providerTransactionId: "UNKNOWNPROVIDERTRANSACTION",
      taskId: null,
      verified: true
    });
  });

  it("never falls back to legacy task correlation for a typed Stage 2 task", async () => {
    const harness = createTypedStage2CallbackFixture();
    harness.customerSigner.providerTransactionId = null;
    const before = snapshotTypedStage2State(harness.state);
    const payload = fadadaCallbackPayload({
      contractId: "",
      resultCode: "3000",
      transactionId: harness.task.providerTaskId
    });

    const result = await harness.service.handleCallback("fadada", payload);

    expect(result).toEqual({ handled: false, reason: "TASK_NOT_FOUND" });
    expect(snapshotTypedStage2State(harness.state)).toEqual(before);
    expect(harness.state.callbackLogs).toHaveLength(1);
    expect(harness.state.callbackLogs[0]).toMatchObject({
      errorMessage: "ESIGN_CALLBACK_TRANSACTION_NOT_FOUND",
      handled: true,
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      taskId: harness.task.id,
      verified: true
    });
    expect(harness.prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
    expect(harness.notificationService.notifyCustomer).not.toHaveBeenCalled();
  });

  it.each([
    {
      firstSlot: "STAGE2_HANDOVER_PLATFORM",
      firstTransactionKey: "platformTransactionId"
    },
    {
      firstSlot: "STAGE2_HANDOVER_CUSTOMER",
      firstTransactionKey: "customerTransactionId"
    }
  ] as const)(
    "completes Stage 2 only after both required typed signers when $firstSlot arrives first",
    async ({ firstSlot, firstTransactionKey }) => {
      const harness = createTypedStage2CallbackFixture();
      const stage1Before = {
        contract: {
          signedAt: harness.stage1Contract.signedAt,
          status: harness.stage1Contract.status
        },
        orderStatus: harness.stage1Contract.order.orderStatus,
        task: {
          completedAt: harness.stage1Task.completedAt,
          taskStatus: harness.stage1Task.taskStatus
        }
      };
      const secondTransactionId = firstSlot === "STAGE2_HANDOVER_CUSTOMER"
        ? harness.platformTransactionId
        : harness.customerTransactionId;
      const otherSignerStatusBefore = firstSlot === "STAGE2_HANDOVER_CUSTOMER"
        ? harness.platformSigner.signerStatus
        : harness.customerSigner.signerStatus;

      await harness.service.handleCallback("fadada", fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3000",
        transactionId: harness[firstTransactionKey]
      }));

      const firstSigner = firstSlot === "STAGE2_HANDOVER_CUSTOMER"
        ? harness.customerSigner
        : harness.platformSigner;
      const otherSigner = firstSlot === "STAGE2_HANDOVER_CUSTOMER"
        ? harness.platformSigner
        : harness.customerSigner;
      expect(firstSigner.signerStatus).toBe(ESignSignerStatus.SIGNED);
      expect(otherSigner.signerStatus).toBe(otherSignerStatusBefore);
      expect(harness.task).toMatchObject({
        completedAt: null,
        taskStatus: ESignTaskStatus.SIGNING
      });
      expect(harness.handover).toMatchObject({
        completedAt: null,
        status: firstSlot === "STAGE2_HANDOVER_CUSTOMER"
          ? "PENDING_PLATFORM_SEAL"
          : "PENDING_CUSTOMER_SIGNATURE"
      });
      expect(harness.stage2Contract.status).toBe(ContractStatus.SIGNING);

      await harness.service.handleCallback("fadada", fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3000",
        transactionId: secondTransactionId
      }));

      expect(harness.customerSigner.signerStatus).toBe(ESignSignerStatus.SIGNED);
      expect(harness.platformSigner.signerStatus).toBe(ESignSignerStatus.SIGNED);
      expect(harness.task).toMatchObject({
        completedAt: expect.any(Date),
        taskStatus: ESignTaskStatus.COMPLETED
      });
      expect(harness.stage2Contract).toMatchObject({
        signedAt: expect.any(Date),
        status: ContractStatus.SIGNED
      });
      expect(harness.handover).toMatchObject({
        completedAt: expect.any(Date),
        customerSignedAt: expect.any(Date),
        platformSignedAt: expect.any(Date),
        status: "SIGNED"
      });
      expect({
        contract: {
          signedAt: harness.stage1Contract.signedAt,
          status: harness.stage1Contract.status
        },
        orderStatus: harness.stage1Contract.order.orderStatus,
        task: {
          completedAt: harness.stage1Task.completedAt,
          taskStatus: harness.stage1Task.taskStatus
        }
      }).toEqual(stage1Before);
      expect(harness.stage1Contract.order.orderStatus).toBe(OrderStatus.PENDING_DELIVERY);
      expect(harness.prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
      expect(harness.notificationService.notifyCustomer).not.toHaveBeenCalled();
    }
  );

  it("reconciles the exact Stage 2 signer set after concurrent customer and platform callbacks conflict", async () => {
    const harness = createTypedStage2CallbackFixture();
    const runTransaction = harness.prisma.$transaction.getMockImplementation()!;
    let initialTransactionCount = 0;
    let releaseInitialTransactions!: () => void;
    const initialTransactionsReady = new Promise<void>((resolve) => {
      releaseInitialTransactions = resolve;
    });
    const transactionOptions: unknown[] = [];
    harness.prisma.$transaction.mockImplementation(
      async (input: unknown, options?: unknown) => {
        transactionOptions.push(options);
        initialTransactionCount += 1;
        const attempt = initialTransactionCount;
        if (attempt <= 2) {
          if (attempt === 2) {
            releaseInitialTransactions();
          }
          await initialTransactionsReady;
          if (attempt === 2) {
            throw Object.assign(new Error("serialization conflict"), {
              code: "P2034"
            });
          }
        }
        return runTransaction(input);
      }
    );

    const [customerResult, platformResult] = await Promise.all([
      harness.service.handleCallback("fadada", fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3000",
        transactionId: harness.customerTransactionId
      })),
      harness.service.handleCallback("fadada", fadadaCallbackPayload({
        contractId: harness.providerContractId,
        resultCode: "3000",
        transactionId: harness.platformTransactionId
      }))
    ]);

    expect(customerResult).toMatchObject({ handled: true });
    expect(platformResult).toMatchObject({ handled: true });
    expect(initialTransactionCount).toBe(3);
    expect(transactionOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ isolationLevel: "Serializable" })
      ])
    );
    expect(harness.customerSigner.signerStatus).toBe(ESignSignerStatus.SIGNED);
    expect(harness.platformSigner.signerStatus).toBe(ESignSignerStatus.SIGNED);
    expect(harness.task).toMatchObject({
      completedAt: expect.any(Date),
      taskStatus: ESignTaskStatus.COMPLETED
    });
    expect(harness.stage2Contract).toMatchObject({
      signedAt: expect.any(Date),
      status: ContractStatus.SIGNED
    });
    expect(harness.handover).toMatchObject({
      completedAt: expect.any(Date),
      customerSignedAt: expect.any(Date),
      platformSignedAt: expect.any(Date),
      status: "SIGNED"
    });
    expect(harness.prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
    expect(harness.notificationService.notifyCustomer).not.toHaveBeenCalled();
  });

  it("keeps Stage 1 slot rows unchanged for unknown or mismatched callbacks", async () => {
    const provider = stage1SlotProvider();
    const { service, state } = createESignFixture({
      ESIGN_PROVIDER: "fadada",
      ESIGN_STAGE1_MULTI_SLOT_ENABLED: "true"
    }, provider);
    await service.createTaskForContract("contract-1", adminUser(), requestContext());
    const before = state.signers.map((signer) => ({
      providerSignerId: signer.providerSignerId,
      signedAt: signer.signedAt,
      signerStatus: signer.signerStatus
    }));

    const unknown = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "UNKNOWNS1"
    }));
    const mismatch = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: "different-provider-contract",
      resultCode: "3000",
      transactionId: "CUSTS1"
    }));

    expect(unknown).toMatchObject({ handled: false, reason: "TASK_NOT_FOUND" });
    expect(mismatch).toMatchObject({ handled: false, reason: "TASK_NOT_FOUND" });
    expect(state.signers.map((signer) => ({
      providerSignerId: signer.providerSignerId,
      signedAt: signer.signedAt,
      signerStatus: signer.signerStatus
    }))).toEqual(before);
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("preflights the signing PDF before calling the provider when Fadada is enabled", async () => {
    const provider: ESignProvider = {
      createSignTask: vi.fn(async () => ({
        providerEnvelopeId: "ESG-1",
        providerTaskId: "ESG-1-1",
        signUrl: "https://sign.example.test/customer"
      })),
      getSignerUrl: vi.fn(),
      verifyCallback: vi.fn()
    };
    const preflightContractPdfArtifact = vi.fn(async () => {
      throw new Error("CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED: generated contract artifact is required");
    });
    const { service, state } = createESignFixture(
      { ESIGN_PROVIDER: "fadada", FADADA_ENABLED: "true" },
      provider,
      { contractPdfArtifactService: { preflightContractPdfArtifact } }
    );

    await expect(service.createTaskForContract("contract-1", adminUser(), requestContext())).rejects.toThrow(
      /CONTRACT_PDF_ARTIFACT_GENERATED_REQUIRED/
    );

    expect(preflightContractPdfArtifact).toHaveBeenCalledWith("contract-1", expect.objectContaining({
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD"
    }));
    expect(provider.createSignTask).not.toHaveBeenCalled();
    expect(state.tasks).toHaveLength(0);
    expect(state.contracts[0]!.status).toBe(ContractStatus.GENERATED);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("blocks Fadada task creation when the customer provider binding is not verified", async () => {
    const provider: ESignProvider = {
      createSignTask: vi.fn(async () => {
        throw new Error("provider should not be called");
      }),
      getSignerUrl: vi.fn(),
      verifyCallback: vi.fn()
    };
    const { service, state } = createESignFixture(
      { ESIGN_PROVIDER: "fadada", FADADA_ENABLED: "true" },
      provider,
      { providerAccounts: [] }
    );

    await expect(service.createTaskForContract("contract-1", adminUser(), requestContext())).rejects.toThrow(
      /FADADA_CUSTOMER_SIGNING_NOT_READY/
    );

    expect(provider.createSignTask).not.toHaveBeenCalled();
    expect(state.tasks).toHaveLength(0);
    expect(state.contracts[0]!.status).toBe(ContractStatus.GENERATED);
  });

  it("blocks Fadada task creation when local VERIFIED has no provider cert-bound evidence", async () => {
    const provider: ESignProvider = {
      createSignTask: vi.fn(async () => {
        throw new Error("provider should not be called");
      }),
      getSignerUrl: vi.fn(),
      verifyCallback: vi.fn()
    };
    const localOnlyAccount = createProviderAccount("customer-1", {
      certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
      certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
      certBoundAt: null,
      realNameProviderStatusSource: ESignProviderRealNameStatusSource.UNKNOWN
    });
    const { service, state } = createESignFixture(
      { ESIGN_PROVIDER: "fadada", FADADA_ENABLED: "true" },
      provider,
      { providerAccounts: [localOnlyAccount] }
    );

    await expect(service.createTaskForContract("contract-1", adminUser(), requestContext())).rejects.toThrow(
      /FADADA_CERT_NOT_BOUND/
    );

    expect(provider.createSignTask).not.toHaveBeenCalled();
    expect(state.tasks).toHaveLength(0);
    expect(state.contracts[0]!.status).toBe(ContractStatus.GENERATED);
  });

  it("requires generated artifact preflight before enterprise auto seal provider calls", async () => {
    const provider = enterpriseAutoSealProvider();
    const preflightContractPdfArtifact = vi.fn(async () => ({
      preflight: {
        enterpriseAutoSealEnabled: true,
        fadadaEnabled: true,
        generatedContractArtifact: true,
        maxBytes: 20 * 1024 * 1024,
        purpose: "FADADA_UPLOAD",
        source: "CONTRACT_FILE",
        textExtractionVerified: false
      }
    }));
    const { service } = createESignFixture(
      {
        ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true",
        ESIGN_PROVIDER: "fadada",
        FADADA_ENABLED: "true"
      },
      provider,
      { contractPdfArtifactService: { preflightContractPdfArtifact } }
    );

    await service.createTaskForContract("contract-1", adminUser(), requestContext(), approvedPlanRef());

    expect(preflightContractPdfArtifact).toHaveBeenCalledWith("contract-1", expect.objectContaining({
      enterpriseAutoSealEnabled: true,
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true
    }));
    expect(provider.createSignTask).toHaveBeenCalledOnce();
  });

  it("requires Stage 1 slot coordinates before slot-aware provider calls", async () => {
    const provider = stage1SlotProvider();
    const preflightContractPdfArtifact = vi.fn(async () => {
      throw new Error("CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING: generated slot coordinates are required");
    });
    const { service, state } = createESignFixture(
      {
        ESIGN_PROVIDER: "fadada",
        ESIGN_STAGE1_MULTI_SLOT_ENABLED: "true",
        FADADA_ENABLED: "true"
      },
      provider,
      { contractPdfArtifactService: { preflightContractPdfArtifact } }
    );

    await expect(service.createTaskForContract("contract-1", adminUser(), requestContext())).rejects.toThrow(
      /CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING/
    );

    expect(preflightContractPdfArtifact).toHaveBeenCalledWith("contract-1", expect.objectContaining({
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage1SlotCoordinates: true
    }));
    expect(provider.createSignTask).not.toHaveBeenCalled();
    expect(state.tasks).toHaveLength(0);
    expect(state.contracts[0]!.status).toBe(ContractStatus.GENERATED);
  });

  it("passes generated Stage 1 slot coordinates into slot-aware provider input", async () => {
    const provider = stage1SlotProvider();
    const slotCoordinates = stage1SlotCoordinates();
    const preflightContractPdfArtifact = vi.fn(async () => ({
      slotCoordinates,
      preflight: {
        fadadaEnabled: true,
        generatedContractArtifact: true,
        maxBytes: 20 * 1024 * 1024,
        purpose: "FADADA_UPLOAD",
        source: "CONTRACT_FILE",
        stage1SlotCoordinatesVerified: true,
        textExtractionVerified: false
      }
    }));
    const { service } = createESignFixture(
      {
        ESIGN_PROVIDER: "fadada",
        ESIGN_STAGE1_MULTI_SLOT_ENABLED: "true",
        FADADA_ENABLED: "true"
      },
      provider,
      { contractPdfArtifactService: { preflightContractPdfArtifact } }
    );

    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(provider.createSignTask).toHaveBeenCalledWith(expect.objectContaining({
      signingSlotCoordinates: slotCoordinates
    }));
  });

  it("keeps Stage 1 task incomplete after customer-only coordinate transaction callback", async () => {
    const provider = stage1CustomerOnlyProvider();
    const { service, state } = createESignFixture({
      ESIGN_PROVIDER: "fadada",
      ESIGN_STAGE1_MULTI_SLOT_ENABLED: "true"
    }, provider);
    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const customerResult = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "CUSTS1"
    }));
    const duplicateResult = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "CUSTS1"
    }));

    expect(customerResult).toMatchObject({ handled: true });
    expect(duplicateResult).toMatchObject({ handled: true });
    expect(state.signers.filter((signer) => signer.providerSignerId === "CUSTS1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ signerStatus: ESignSignerStatus.SIGNED }),
      expect.objectContaining({ signerStatus: ESignSignerStatus.SIGNED })
    ]));
    expect(state.signers.filter((signer) => signer.signerType === ESignSignerType.PLATFORM)).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerSignerId: null, signerStatus: ESignSignerStatus.PENDING }),
      expect.objectContaining({ providerSignerId: null, signerStatus: ESignSignerStatus.PENDING })
    ]));
    expect(state.tasks[0]).toMatchObject({
      completedAt: null,
      taskStatus: ESignTaskStatus.SIGNING
    });
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("triggers Stage 1 platform auto seal once after customer coordinate callback when flags are enabled", async () => {
    const provider = stage1CustomerThenPlatformAutoSealProvider();
    const slotCoordinates = stage1SlotCoordinates();
    const preflightContractPdfArtifact = vi.fn(async () => ({
      slotCoordinates,
      preflight: {
        enterpriseAutoSealEnabled: true,
        fadadaEnabled: true,
        generatedContractArtifact: true,
        maxBytes: 20 * 1024 * 1024,
        purpose: "FADADA_UPLOAD",
        source: "CONTRACT_FILE",
        stage1SlotCoordinatesVerified: true,
        textExtractionVerified: false
      }
    }));
    const { service, state } = createESignFixture(
      {
        ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true",
        ESIGN_PROVIDER: "fadada",
        ESIGN_STAGE1_MULTI_SLOT_ENABLED: "true",
        FADADA_ENABLED: "true"
      },
      provider,
      { contractPdfArtifactService: { preflightContractPdfArtifact } }
    );
    await service.createTaskForContract("contract-1", adminUser(), requestContext());
    const platformTransactionId = buildTestTransactionId(state.tasks[0]!.taskNo, 2);

    const customerResult = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "CUSTS1"
    }));
    const duplicateCustomerResult = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "CUSTS1"
    }));

    expect(customerResult).toMatchObject({ handled: true });
    expect(duplicateCustomerResult).toMatchObject({ handled: true, idempotent: true });
    expect(provider.autoSealTask).toHaveBeenCalledOnce();
    expect(provider.autoSealTask).toHaveBeenCalledWith(expect.objectContaining({
      providerEnvelopeId: state.tasks[0]!.providerEnvelopeId,
      signingSlotCoordinates: [
        { pageNumber: 0, slotId: "STAGE1_BODY_PLATFORM", x: 521, y: 731 },
        { pageNumber: 2, slotId: "STAGE1_ATTACHMENT1_PLATFORM", x: 523, y: 733 }
      ],
      signingStage: "STAGE1_CONTRACT",
      taskId: state.tasks[0]!.id,
      transactionId: platformTransactionId
    }));
    expect(state.signers.filter((signer) => signer.providerSignerId === "CUSTS1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ signerStatus: ESignSignerStatus.SIGNED }),
      expect.objectContaining({ signerStatus: ESignSignerStatus.SIGNED })
    ]));
    expect(state.signers.filter((signer) => signer.providerSignerId === platformTransactionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ signerStatus: ESignSignerStatus.SIGNED, signerType: ESignSignerType.PLATFORM }),
      expect.objectContaining({ signerStatus: ESignSignerStatus.SIGNED, signerType: ESignSignerType.PLATFORM })
    ]));
    expect(state.tasks[0]).toMatchObject({
      completedAt: expect.any(Date),
      taskStatus: ESignTaskStatus.COMPLETED
    });
    expect(state.contracts[0]).toMatchObject({
      signedAt: expect.any(Date),
      status: ContractStatus.SIGNED
    });
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("stores enterprise signing plan metadata without making B5 evaluate policy", async () => {
    const provider: ESignProvider = {
      createSignTask: vi.fn(async (input) => ({
        providerEnvelopeId: input.taskNo,
        providerTaskId: `${input.taskNo}-1`,
        signUrl: "https://sign.example.test/customer",
        signers: [{
          customerId: "customer-1",
          providerSignerId: `${input.taskNo}-customer`,
          signUrl: "https://sign.example.test/customer",
          signerType: "CUSTOMER" as const
        }]
      })),
      getSignerUrl: vi.fn(),
      verifyCallback: vi.fn()
    };
    const { service, state } = createESignFixture({ ESIGN_PROVIDER: "fadada" }, provider);

    const result = await service.createTaskForContract(
      "contract-1",
      adminUser(),
      requestContext(),
      approvedPlanRef()
    );

    expect(result.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(state.tasks[0]!.requestSnapshot).toMatchObject({
      enterpriseSigningPlan: {
        executionMode: "SEQUENTIAL",
        planHash: "sha256:abc123",
        policyId: "policy-1",
        signingPlanId: "signing-plan-1",
        stepSummary: [
          { required: true, signerRole: "CUSTOMER", stepOrder: 1 },
          { required: true, signerRole: "ENTERPRISE_SEAL", stepOrder: 2 }
        ]
      }
    });
    expect(provider.createSignTask).toHaveBeenCalledWith(expect.not.objectContaining({
      policy: expect.anything(),
      sealAuthority: expect.anything()
    }));
    expect(provider.createSignTask).toHaveBeenCalledWith(expect.objectContaining({
      signers: [expect.objectContaining({
        customerId: "customer-1",
        signerType: "CUSTOMER"
      })]
    }));
  });

  it("creates a pending platform signer when enterprise auto seal is enabled", async () => {
    const provider = enterpriseAutoSealProvider();
    const { service, state } = createESignFixture({
      ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true",
      ESIGN_PROVIDER: "fadada"
    }, provider);

    const result = await service.createTaskForContract(
      "contract-1",
      adminUser(),
      requestContext(),
      approvedPlanRef()
    );

    expect(result.signers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signerStatus: ESignSignerStatus.SIGNING,
        signerType: ESignSignerType.CUSTOMER
      }),
      expect.objectContaining({
        signerStatus: ESignSignerStatus.PENDING,
        signerType: ESignSignerType.PLATFORM
      })
    ]));
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(provider.createSignTask).toHaveBeenCalledWith(expect.objectContaining({
      signers: [expect.objectContaining({ signerType: "CUSTOMER" })]
    }));
  });

  it("waits for platform auto seal before finalizing a Fadada customer callback", async () => {
    const provider = enterpriseAutoSealProvider();
    const { service, state } = createESignFixture({
      ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true",
      ESIGN_PLATFORM_SEAL_KEYWORD: "出租方盖章",
      ESIGN_PROVIDER: "fadada"
    }, provider);
    const task = await service.createTaskForContract(
      "contract-1",
      adminUser(),
      requestContext(),
      approvedPlanRef()
    );

    const result = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));

    expect(result).toMatchObject({ handled: true });
    expect(provider.autoSealTask).toHaveBeenCalledOnce();
    expect(provider.autoSealTask).toHaveBeenCalledWith(expect.objectContaining({
      placement: {
        keyword: "出租方盖章",
        type: "KEYWORD"
      }
    }));
    expect(state.signers.find((signer) => signer.signerType === ESignSignerType.CUSTOMER)).toMatchObject({
      signerStatus: ESignSignerStatus.SIGNED
    });
    expect(state.signers.find((signer) => signer.signerType === ESignSignerType.PLATFORM)).toMatchObject({
      providerSignerId: "ESG1S2",
      signerStatus: ESignSignerStatus.SIGNED
    });
    expect(state.tasks[0]).toMatchObject({
      taskStatus: ESignTaskStatus.COMPLETED
    });
    expect(state.contracts[0]).toMatchObject({
      signedAt: expect.any(Date),
      status: ContractStatus.SIGNED
    });
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("fails platform auto seal before provider call when the approved keyword is missing", async () => {
    const provider = enterpriseAutoSealProvider();
    const { service, state } = createESignFixture({
      ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true",
      ESIGN_PROVIDER: "fadada"
    }, provider);
    const task = await service.createTaskForContract(
      "contract-1",
      adminUser(),
      requestContext(),
      approvedPlanRef()
    );

    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));

    expect(provider.autoSealTask).not.toHaveBeenCalled();
    expect(state.signers.find((signer) => signer.signerType === ESignSignerType.CUSTOMER)).toMatchObject({
      signerStatus: ESignSignerStatus.SIGNED
    });
    expect(state.signers.find((signer) => signer.signerType === ESignSignerType.PLATFORM)).toMatchObject({
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(state.tasks[0]).toMatchObject({
      completedAt: null,
      taskStatus: ESignTaskStatus.SIGNING
    });
    expect(state.tasks[0]!.errorSnapshot).toMatchObject({
      errorMessage: "ESIGN_PLATFORM_SEAL_KEYWORD_MISSING",
      resultCode: "PLATFORM_SEAL_POSITIONING_MISSING",
      status: "FAILED"
    });
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("keeps contract and order pending when platform auto seal fails", async () => {
    const provider = enterpriseAutoSealProvider({ status: "FAILED", resultCode: "NO_SEAL", resultDescription: "seal missing" });
    const { service, state } = createESignFixture({
      ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true",
      ESIGN_PLATFORM_SEAL_KEYWORD: "出租方盖章",
      ESIGN_PROVIDER: "fadada"
    }, provider);
    const task = await service.createTaskForContract(
      "contract-1",
      adminUser(),
      requestContext(),
      approvedPlanRef()
    );

    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));

    expect(state.signers.find((signer) => signer.signerType === ESignSignerType.CUSTOMER)).toMatchObject({
      signerStatus: ESignSignerStatus.SIGNED
    });
    expect(state.signers.find((signer) => signer.signerType === ESignSignerType.PLATFORM)).toMatchObject({
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(state.tasks[0]).toMatchObject({
      completedAt: null,
      taskStatus: ESignTaskStatus.SIGNING
    });
    expect(state.tasks[0]!.errorSnapshot).toMatchObject({
      resultCode: "NO_SEAL"
    });
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("does not duplicate platform auto seal or order advancement for duplicate callbacks", async () => {
    const provider = enterpriseAutoSealProvider();
    const { prisma, service, state } = createESignFixture({
      ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED: "true",
      ESIGN_PLATFORM_SEAL_KEYWORD: "出租方盖章",
      ESIGN_PROVIDER: "fadada"
    }, provider);
    const task = await service.createTaskForContract(
      "contract-1",
      adminUser(),
      requestContext(),
      approvedPlanRef()
    );

    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));
    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));

    expect(provider.autoSealTask).toHaveBeenCalledTimes(1);
    expect(prisma.subscriptionOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("validates the C4 policy to B5 execution reference loop without provider policy decisions", async () => {
    const policyEngine = new SignaturePolicyEngine();
    const policyInput = enterprisePolicyInput();
    const decision = policyEngine.evaluate(policyInput);
    const plan = policyEngine.compile({
      contractId: "contract-1",
      decision,
      orderId: "order-1",
      policy: policyInput.policy!,
      seal: policyInput.seal
    });
    const samePlan = policyEngine.compile({
      contractId: "contract-1",
      decision,
      orderId: "order-1",
      policy: policyInput.policy!,
      seal: policyInput.seal
    });
    const provider: ESignProvider = {
      createSignTask: vi.fn(async (input) => ({
        providerEnvelopeId: input.taskNo,
        providerTaskId: `${input.taskNo}-1`,
        signUrl: "https://sign.example.test/customer",
        signers: [{
          customerId: "customer-1",
          providerSignerId: `${input.taskNo}-customer`,
          signUrl: "https://sign.example.test/customer",
          signerType: "CUSTOMER" as const
        }]
      })),
      getSignerUrl: vi.fn(),
      verifyCallback: vi.fn()
    };
    const { prisma, service, state } = createESignFixture({ ESIGN_PROVIDER: "fadada" }, provider);

    expect(decision).toMatchObject({ code: "ALLOW", compileAllowed: true });
    expect(samePlan).toEqual(plan);

    await service.createTaskForContract(
      "contract-1",
      adminUser(),
      requestContext(),
      toApprovedSigningPlanRef(plan)
    );

    expect(provider.createSignTask).toHaveBeenCalledWith(expect.objectContaining({
      approvedSigningPlan: expect.objectContaining({
        planHash: plan.hash,
        signingPlanId: plan.planId
      })
    }));
    expect(provider.createSignTask).toHaveBeenCalledWith(expect.not.objectContaining({
      authorities: expect.anything(),
      policy: expect.anything(),
      seal: expect.anything()
    }));
    expect(state.tasks[0]!.requestSnapshot).toMatchObject({
      enterpriseSigningPlan: {
        planHash: plan.hash,
        signingPlanId: plan.planId
      }
    });
    expect(JSON.stringify(state.tasks[0]!.requestSnapshot)).not.toContain("customer-secret-1");
    expect(JSON.stringify(state.tasks[0]!.requestSnapshot)).not.toContain("fadada-seal-secret-1");
    expect(prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("returns the existing active task instead of creating duplicates", async () => {
    const { service, state } = createESignFixture();

    const first = await service.createTaskForContract("contract-1", adminUser(), requestContext());
    const second = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(second.id).toBe(first.id);
    expect(state.tasks).toHaveLength(1);
  });

  it("lists and reads only contracts owned by the portal customer", async () => {
    const { service } = createESignFixture();

    const ownContracts = await service.listPortalContracts(currentCustomer("customer-1"));

    expect(ownContracts).toHaveLength(1);
    expect(ownContracts[0]).toMatchObject({ id: "contract-1", orderNo: "ORD-1" });
    await expect(service.getPortalContract("contract-2", currentCustomer("customer-1"))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("exposes signed artifact availability without leaking storage object keys", async () => {
    const { service, state } = createESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());
    state.tasks[0]!.signedDocumentObjectKey = "contracts/contract-1/esign/fadada/signed/2026/secret.pdf";
    state.contracts[0]!.status = ContractStatus.SIGNED;

    const adminView = await service.getTask(task.id, adminUser());
    const portalView = await service.getPortalContract("contract-1", currentCustomer("customer-1"));

    expect(adminView).toMatchObject({
      hasEvidenceDocument: false,
      hasSignedDocument: true
    });
    expect(adminView).not.toHaveProperty("signedDocumentObjectKey");
    expect(portalView.signTask).toMatchObject({
      hasEvidenceDocument: false,
      hasSignedDocument: true
    });
    expect(portalView.signTask).not.toHaveProperty("signedDocumentObjectKey");
  });

  it("exposes safe Stage 1 signer slot metadata for Admin display grouping", async () => {
    const provider = stage1SlotProvider();
    const { service } = createESignFixture({
      ESIGN_PROVIDER: "fadada",
      ESIGN_STAGE1_MULTI_SLOT_ENABLED: "true"
    }, provider);

    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());
    const adminView = await service.getTask(task.id, adminUser());

    expect(adminView.signers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerSignerId: "CUSTS1",
        signerType: ESignSignerType.CUSTOMER,
        slotId: "STAGE1_BODY_CUSTOMER"
      }),
      expect.objectContaining({
        providerActionType: "PLATFORM_AUTO_SEAL",
        providerSignerId: "PLATS1",
        signerType: ESignSignerType.PLATFORM,
        slotId: "STAGE1_ATTACHMENT1_PLATFORM"
      })
    ]));
    expect(adminView.signers[0]).not.toHaveProperty("signUrl");
    expect(adminView.signers[0]).not.toHaveProperty("signerIdNoMasked");
  });

  it("returns a portal signing link for the current customer's active task", async () => {
    const { service } = createESignFixture();
    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.startPortalSigning("contract-1", currentCustomer("customer-1"));

    expect(result.mock).toBe(true);
    expect(result.signUrl).toContain("/portal/contracts/contract-1/sign?taskId=");
    await expect(service.startPortalSigning("contract-1", currentCustomer("customer-2"))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("returns an existing Fadada portal signing URL when local expiry is absent", async () => {
    const provider: ESignProvider = {
      createSignTask: vi.fn(async () => ({
        providerEnvelopeId: "ESG-1",
        providerTaskId: "ESG-1-1",
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt: undefined
      })),
      getSignerUrl: vi.fn(async () => {
        throw new Error("stored signUrl should be reused");
      }),
      verifyCallback: vi.fn()
    };
    const { service } = createESignFixture(
      { ESIGN_PROVIDER: "fadada", FADADA_ENABLED: "true" },
      provider
    );
    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.startPortalSigning("contract-1", currentCustomer("customer-1"));

    expect(result).toMatchObject({
      mock: false,
      signUrl: "https://sign.example.test/customer"
    });
    expect(provider.getSignerUrl).not.toHaveBeenCalled();
  });

  it("blocks portal signing links when Fadada readiness is no longer cert-bound", async () => {
    const provider: ESignProvider = {
      createSignTask: vi.fn(async () => ({
        providerEnvelopeId: "ESG-1",
        providerTaskId: "ESG-1-1",
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt: new Date(Date.now() + 60_000)
      })),
      getSignerUrl: vi.fn(async () => ({
        signUrl: "https://sign.example.test/refreshed"
      })),
      verifyCallback: vi.fn()
    };
    const { service, state } = createESignFixture(
      { ESIGN_PROVIDER: "fadada", FADADA_ENABLED: "true" },
      provider
    );
    await service.createTaskForContract("contract-1", adminUser(), requestContext());
    state.providerAccounts[0] = createProviderAccount("customer-1", {
      certBindingSource: ESignProviderCertBindingSource.UNKNOWN,
      certBindingStatus: ESignProviderCertBindingStatus.UNKNOWN,
      certBoundAt: null,
      certSerialNo: null,
      readinessBlockingCode: "FADADA_CERT_NOT_BOUND",
      readinessBlockingReason: "certificate binding is not provider-confirmed"
    });

    await expect(service.startPortalSigning("contract-1", currentCustomer("customer-1"))).rejects.toThrow(
      /FADADA_CERT_NOT_BOUND/
    );

    expect(provider.getSignerUrl).not.toHaveBeenCalled();
  });

  it("mock-sign completes signer, task, contract, order and callback log", async () => {
    const { service, state } = createESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.mockSignTask(task.id, currentCustomer("customer-1"), requestContext());

    expect(result.task.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(state.signers[0]!.signerStatus).toBe(ESignSignerStatus.SIGNED);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNED);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(state.callbackLogs).toHaveLength(1);
    expect(state.callbackLogs[0]).toMatchObject({
      handled: true,
      verified: true
    });
  });

  it("rejects mock-sign when mock provider is not enabled", async () => {
    const { service } = createESignFixture({
      ESIGN_MOCK_ENABLED: "false",
      ESIGN_PROVIDER: "esign"
    });
    const task = await createESignFixture().service.createTaskForContract("contract-1", adminUser(), requestContext());

    await expect(service.mockSignTask(task.id, currentCustomer("customer-1"), requestContext())).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it("handles completed callbacks idempotently", async () => {
    const { service, state } = createESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const first = await service.handleCallback("mock", {
      eventType: "SIGN_COMPLETED",
      providerTaskId: task.providerTaskId
    });
    const second = await service.handleCallback("mock", {
      eventType: "SIGN_COMPLETED",
      providerTaskId: task.providerTaskId
    });

    expect(first).toMatchObject({ handled: true });
    expect(second).toMatchObject({ handled: true });
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNED);
    expect(state.callbackLogs).toHaveLength(2);
    expect(state.callbackLogs.every((log) => log.handled)).toBe(true);
  });

  it("handles a valid Fadada 3000 callback idempotently", async () => {
    const { service, state } = createFadadaESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());
    const first = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));
    const firstSignedAt = state.signers[0]!.signedAt;
    const firstCompletedAt = state.tasks[0]!.completedAt;

    const second = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));

    expect(first).toMatchObject({ handled: true });
    expect(second).toMatchObject({ handled: true, idempotent: true });
    expect(state.signers[0]).toMatchObject({ signerStatus: ESignSignerStatus.SIGNED });
    expect(state.signers[0]!.signedAt).toBe(firstSignedAt);
    expect(state.tasks[0]).toMatchObject({
      completedAt: firstCompletedAt,
      taskStatus: ESignTaskStatus.COMPLETED
    });
    expect(state.contracts[0]).toMatchObject({
      signedAt: expect.any(Date),
      status: ContractStatus.SIGNED
    });
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(state.callbackLogs).toHaveLength(2);
    expect(state.callbackLogs.every((log) => log.handled && log.verified)).toBe(true);
    expect(state.callbackLogs[0]!.payload).toMatchObject({
      download_url: "[redacted-url]",
      viewpdf_url: "[redacted-url]"
    });
  });

  it("rejects invalid Fadada callback digests without advancing state", async () => {
    const { prisma, service, state } = createFadadaESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());
    vi.clearAllMocks();

    const result = await service.handleCallback("fadada", {
      ...fadadaCallbackPayload({
        contractId: state.tasks[0]!.providerEnvelopeId!,
        resultCode: "3000",
        transactionId: task.providerTaskId
      }),
      msg_digest: "bad-digest"
    });

    expect(result).toMatchObject({ handled: false, reason: "UNVERIFIED" });
    expect(prisma.contractESignSigner.findFirst).not.toHaveBeenCalled();
    expect(prisma.contractESignTask.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
    expect(state.signers[0]!.signerStatus).not.toBe(ESignSignerStatus.SIGNED);
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(state.callbackLogs).toHaveLength(1);
    expect(state.callbackLogs[0]).toMatchObject({
      handled: true,
      payload: {
        download_url: "[redacted-url]",
        viewpdf_url: "[redacted-url]"
      },
      verified: false
    });
  });

  it("keeps invalid Fadada callback rejection non-500 when callback log write fails", async () => {
    const { prisma, service, state } = createFadadaESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());
    vi.clearAllMocks();
    prisma.contractESignCallbackLog.create.mockRejectedValueOnce(new Error("callback log unavailable"));

    const result = await service.handleCallback("fadada", {
      ...fadadaCallbackPayload({
        contractId: state.tasks[0]!.providerEnvelopeId!,
        resultCode: "3000",
        transactionId: task.providerTaskId
      }),
      msg_digest: "bad-digest"
    });

    expect(result).toMatchObject({ handled: false, reason: "UNVERIFIED" });
    expect(prisma.contractESignSigner.findFirst).not.toHaveBeenCalled();
    expect(prisma.contractESignTask.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscriptionOrder.updateMany).not.toHaveBeenCalled();
    expect(state.signers[0]!.signerStatus).not.toBe(ESignSignerStatus.SIGNED);
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(state.callbackLogs).toHaveLength(0);
  });

  it("marks Fadada 3001 callbacks as failed without advancing the order", async () => {
    const { service, state } = createFadadaESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3001",
      resultDesc: "provider sign failed",
      transactionId: task.providerTaskId
    }));

    expect(result).toMatchObject({ handled: true, resultCode: "3001" });
    expect(state.tasks[0]).toMatchObject({
      failedAt: expect.any(Date),
      taskStatus: ESignTaskStatus.FAILED
    });
    expect(state.signers[0]!.signerStatus).not.toBe(ESignSignerStatus.SIGNED);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(state.callbackLogs[0]).toMatchObject({
      eventType: "FADADA_SIGN_FAILED",
      handled: true,
      verified: true
    });
  });

  it("marks Fadada 3003 callbacks as rejected without advancing the order", async () => {
    const { service, state } = createFadadaESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3003",
      resultDesc: "customer rejected",
      transactionId: task.providerTaskId
    }));

    expect(result).toMatchObject({ handled: true, resultCode: "3003" });
    expect(state.tasks[0]).toMatchObject({
      failedAt: expect.any(Date),
      taskStatus: ESignTaskStatus.FAILED
    });
    expect(state.signers[0]).toMatchObject({
      rejectReason: "customer rejected",
      rejectedAt: expect.any(Date),
      signerStatus: ESignSignerStatus.REJECTED
    });
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("logs unknown Fadada result codes without advancing state", async () => {
    const { service, state } = createFadadaESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3999",
      resultDesc: "unknown result",
      transactionId: task.providerTaskId
    }));

    expect(result).toMatchObject({ handled: false, reason: "UNKNOWN_RESULT_CODE", resultCode: "3999" });
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(state.callbackLogs[0]).toMatchObject({
      eventType: "FADADA_SIGN_UNKNOWN",
      handled: false,
      verified: true
    });
  });

  it("logs valid Fadada callbacks for unknown transactions without advancing state", async () => {
    const { service, state } = createFadadaESignFixture();
    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: "unknown-contract",
      resultCode: "3000",
      transactionId: "unknown-transaction"
    }));

    expect(result).toMatchObject({ handled: false, reason: "TASK_NOT_FOUND" });
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(state.callbackLogs[0]).toMatchObject({
      errorMessage: "ESIGN_CALLBACK_TRANSACTION_NOT_FOUND",
      handled: true,
      handledAt: expect.any(Date),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      providerTaskId: "unknown-transaction",
      providerTransactionId: "unknown-transaction",
      taskId: null,
      verified: true
    });
  });

  it("isolates unknown Fadada transactions even when the contract id matches", async () => {
    const { service, state } = createFadadaESignFixture();
    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: "unknowntransaction"
    }));

    expect(result).toMatchObject({ handled: false, reason: "TASK_NOT_FOUND" });
    expect(state.signers[0]!.signerStatus).not.toBe(ESignSignerStatus.SIGNED);
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(state.callbackLogs[0]).toMatchObject({
      errorMessage: "ESIGN_CALLBACK_TRANSACTION_NOT_FOUND",
      handled: true,
      handledAt: expect.any(Date),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      providerTaskId: "unknowntransaction",
      providerTransactionId: "unknowntransaction",
      taskId: null,
      verified: true
    });
  });

  it("isolates Fadada callbacks when a known transaction has a mismatched contract id", async () => {
    const { service, state } = createFadadaESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: "different-provider-contract",
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));

    expect(result).toMatchObject({ handled: false, reason: "TASK_NOT_FOUND" });
    expect(state.signers[0]!.signerStatus).not.toBe(ESignSignerStatus.SIGNED);
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(state.callbackLogs[0]).toMatchObject({
      errorMessage: "ESIGN_CALLBACK_TRANSACTION_NOT_FOUND",
      handled: true,
      handledAt: expect.any(Date),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      providerTaskId: task.providerTaskId,
      providerTransactionId: task.providerTaskId,
      taskId: null,
      verified: true
    });
  });

  it("does not downgrade completed Fadada tasks from later failure or rejection callbacks", async () => {
    const { service, state } = createFadadaESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());
    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: task.providerTaskId
    }));
    const signedAt = state.contracts[0]!.signedAt;

    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3001",
      transactionId: task.providerTaskId
    }));
    await service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3003",
      transactionId: task.providerTaskId
    }));

    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(state.signers[0]!.signerStatus).toBe(ESignSignerStatus.SIGNED);
    expect(state.contracts[0]).toMatchObject({
      signedAt,
      status: ContractStatus.SIGNED
    });
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(state.callbackLogs).toHaveLength(3);
    expect(state.callbackLogs.slice(1).every((log) => log.handled && log.errorMessage)).toBe(true);
  });

  it("does not auto-upgrade failed or rejected Fadada tasks from later success callbacks", async () => {
    const failed = createFadadaESignFixture();
    const failedTask = await failed.service.createTaskForContract("contract-1", adminUser(), requestContext());
    await failed.service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: failed.state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3001",
      transactionId: failedTask.providerTaskId
    }));
    await failed.service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: failed.state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: failedTask.providerTaskId
    }));

    const rejected = createFadadaESignFixture();
    const rejectedTask = await rejected.service.createTaskForContract("contract-1", adminUser(), requestContext());
    await rejected.service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: rejected.state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3003",
      transactionId: rejectedTask.providerTaskId
    }));
    await rejected.service.handleCallback("fadada", fadadaCallbackPayload({
      contractId: rejected.state.tasks[0]!.providerEnvelopeId!,
      resultCode: "3000",
      transactionId: rejectedTask.providerTaskId
    }));

    expect(failed.state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.FAILED);
    expect(failed.state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(rejected.state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.FAILED);
    expect(rejected.state.signers[0]!.signerStatus).toBe(ESignSignerStatus.REJECTED);
    expect(rejected.state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("requires a signable contract status before creating a task", async () => {
    const { service, state } = createESignFixture();
    state.contracts[0]!.status = ContractStatus.SIGNED;

    await expect(service.createTaskForContract("contract-1", adminUser(), requestContext())).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

function createTypedStage2CallbackFixture(options: {
  customerProviderSignerId?: string;
} = {}) {
  const verifier = new FadadaESignProvider(loadFadadaConfig(fadadaConfigService()));
  const harness = createESignFixture({ ESIGN_PROVIDER: "fadada" }, {
    createSignTask: vi.fn(),
    getSignerUrl: vi.fn(),
    verifyCallback: verifier.verifyCallback.bind(verifier)
  });
  const stage1Contract = harness.state.contracts[0]!;
  stage1Contract.signedAt = new Date("2026-07-26T00:00:00.000Z");
  stage1Contract.status = ContractStatus.SIGNED;
  stage1Contract.order.orderStatus = OrderStatus.PENDING_DELIVERY;

  const stage1Task: FakeTask = {
    callbackSnapshot: null,
    cancelledAt: null,
    completedAt: new Date("2026-07-26T00:00:00.000Z"),
    contractId: stage1Contract.id,
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
    customerId: stage1Contract.customerId,
    deletedAt: null,
    documentName: "Subscription contract",
    documentType: "SUBSCRIPTION_CONTRACT",
    errorSnapshot: null,
    evidenceObjectKey: null,
    failedAt: null,
    id: "stage1-task-existing",
    orderId: stage1Contract.orderId,
    provider: ESignProviderType.FADADA,
    providerEnvelopeId: "STAGE1PROVIDER",
    providerTaskId: "STAGE1CUSTOMER",
    requestSnapshot: { signingStage: "STAGE1_CONTRACT" },
    responseSnapshot: null,
    signUrl: null,
    signUrlExpiresAt: null,
    signedDocumentObjectKey: null,
    signingStage: "STAGE1_SUBSCRIPTION_CONTRACT",
    startedAt: new Date("2026-07-25T00:00:00.000Z"),
    taskNo: "ESGSTAGE1",
    taskStatus: ESignTaskStatus.COMPLETED,
    updatedAt: new Date("2026-07-26T00:00:00.000Z")
  };
  harness.state.tasks.push(stage1Task);

  const stage2Contract = createContract(
    "handover-contract-typed",
    stage1Contract.customerId,
    stage1Contract.orderId,
    stage1Contract.order.orderNo
  );
  stage2Contract.contractNo = "HDV-TYPED-1";
  stage2Contract.contractTitle = "Delivery handover confirmation";
  stage2Contract.order = stage1Contract.order;
  stage2Contract.status = ContractStatus.SIGNING;
  harness.state.contracts.push(stage2Contract);

  const providerContractId = "HDVPROVIDER1";
  const customerTransactionId = "HDVTYPEDH1";
  const platformTransactionId = "HDVTYPEDH2";
  const task: FakeTask = {
    callbackSnapshot: null,
    cancelledAt: null,
    completedAt: null,
    contractId: stage2Contract.id,
    createdAt: new Date("2026-07-26T01:00:00.000Z"),
    customerId: stage1Contract.customerId,
    deletedAt: null,
    documentName: "Delivery handover confirmation",
    documentType: "DELIVERY_HANDOVER",
    errorSnapshot: null,
    evidenceObjectKey: null,
    failedAt: null,
    id: "stage2-task-typed",
    orderId: stage1Contract.orderId,
    provider: ESignProviderType.FADADA,
    providerEnvelopeId: providerContractId,
    providerTaskId: customerTransactionId,
    requestSnapshot: {
      signingStage: "STAGE2_DELIVERY_HANDOVER"
    },
    responseSnapshot: null,
    signUrl: null,
    signUrlExpiresAt: null,
    signedDocumentObjectKey: null,
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    startedAt: new Date("2026-07-26T01:00:00.000Z"),
    taskNo: "ESGSTAGE2",
    taskStatus: ESignTaskStatus.WAITING_CUSTOMER,
    updatedAt: new Date("2026-07-26T01:00:00.000Z")
  };
  harness.state.tasks.push(task);

  const customerSigner: FakeSigner = {
    customerId: stage1Contract.customerId,
    deletedAt: null,
    documentType: "DELIVERY_HANDOVER",
    id: "stage2-signer-customer-typed",
    providerActionType: "CUSTOMER_MANUAL_SIGN",
    providerSignerId:
      options.customerProviderSignerId ?? "LEGACY-CUSTOMER-ID",
    providerTransactionId: customerTransactionId,
    rejectReason: null,
    rejectedAt: null,
    required: true,
    signedAt: null,
    signerIdNoMasked: null,
    signerName: "Customer",
    signerPhone: "13800000000",
    signerStatus: ESignSignerStatus.SIGNING,
    signerType: ESignSignerType.CUSTOMER,
    signUrl: "https://sign.example.test/stage2-customer",
    signUrlExpiresAt: null,
    slotId: "STAGE2_HANDOVER_CUSTOMER",
    snapshot: null,
    taskId: task.id
  };
  const platformSigner: FakeSigner = {
    customerId: null,
    deletedAt: null,
    documentType: "DELIVERY_HANDOVER",
    id: "stage2-signer-platform-typed",
    providerActionType: "PLATFORM_AUTO_SEAL",
    providerSignerId: "LEGACY-PLATFORM-ID",
    providerTransactionId: platformTransactionId,
    rejectReason: null,
    rejectedAt: null,
    required: true,
    signedAt: null,
    signerIdNoMasked: null,
    signerName: "Platform",
    signerPhone: null,
    signerStatus: ESignSignerStatus.PENDING,
    signerType: ESignSignerType.PLATFORM,
    signUrl: null,
    signUrlExpiresAt: null,
    slotId: "STAGE2_HANDOVER_PLATFORM",
    snapshot: null,
    taskId: task.id
  };
  harness.state.signers.push(customerSigner, platformSigner);

  const handover: FakeDeliveryHandover = {
    archiveStatus: "NOT_STARTED",
    completedAt: null,
    customerSignedAt: null,
    deletedAt: null,
    handoverContractId: stage2Contract.id,
    handoverESignTaskId: task.id,
    id: "handover-typed",
    orderId: stage1Contract.orderId,
    platformSignedAt: null,
    status: "PENDING_CUSTOMER_SIGNATURE"
  };
  harness.state.deliveryHandovers.push(handover);

  return {
    ...harness,
    customerSigner,
    customerTransactionId,
    handover,
    platformSigner,
    platformTransactionId,
    providerContractId,
    stage1Contract,
    stage1Task,
    stage2Contract,
    task
  };
}

function snapshotTypedStage2State(state: FakeState) {
  return {
    contracts: state.contracts.map((contract) => ({
      id: contract.id,
      signedAt: contract.signedAt,
      status: contract.status
    })),
    handovers: state.deliveryHandovers.map((handover) => ({
      completedAt: handover.completedAt,
      customerSignedAt: handover.customerSignedAt,
      id: handover.id,
      platformSignedAt: handover.platformSignedAt,
      status: handover.status
    })),
    signers: state.signers.map((signer) => ({
      id: signer.id,
      signedAt: signer.signedAt,
      signerStatus: signer.signerStatus
    })),
    tasks: state.tasks.map((task) => ({
      callbackSnapshot: task.callbackSnapshot,
      completedAt: task.completedAt,
      id: task.id,
      taskStatus: task.taskStatus
    }))
  };
}

function createESignFixture(
  env: Record<string, string> = {},
  providerOverride?: ESignProvider,
  options: {
    contractPdfArtifactService?: {
      preflightContractPdfArtifact: ReturnType<typeof vi.fn>;
    };
    providerAccounts?: FakeProviderAccount[];
  } = {}
) {
  const state = {
    callbackLogs: [] as FakeCallbackLog[],
    contracts: [
      createContract("contract-1", "customer-1", "order-1", "ORD-1"),
      createContract("contract-2", "customer-2", "order-2", "ORD-2")
    ],
    deliveryHandovers: [] as FakeDeliveryHandover[],
    providerAccounts: options.providerAccounts ?? [createProviderAccount("customer-1")],
    signers: [] as FakeSigner[],
    tasks: [] as FakeTask[]
  };

  const prisma = {
    $transaction: vi.fn(async (input: unknown) => {
      if (typeof input === "function") {
        return (input as (tx: typeof prisma) => unknown)(prisma);
      }
      return Promise.all(input as Array<Promise<unknown>>);
    }),
    contract: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const contract = state.contracts.find((item) =>
          matchesWhere(item, where) &&
          (where.customerId === undefined || item.customerId === where.customerId)
        );
        return contract ? hydrateContract(state, contract) : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.contracts
          .filter((contract) =>
            matchesWhere(contract, where) &&
            (where.customerId === undefined || contract.customerId === where.customerId)
          )
          .map((contract) => hydrateContract(state, contract))
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        if (!contract) {
          throw new Error("contract not found");
        }
        Object.assign(contract, data);
        return hydrateContract(state, contract);
      })
    },
    contractESignCallbackLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const payloadHash = (data.payloadHash as string | null | undefined) ?? null;
        const duplicate = payloadHash
          ? state.callbackLogs.find((item) =>
              item.provider === data.provider && item.payloadHash === payloadHash
            )
          : null;
        if (duplicate) {
          throw Object.assign(new Error("callback log unique constraint"), {
            code: "P2002"
          });
        }
        const log: FakeCallbackLog = {
          errorMessage: null,
          eventType: (data.eventType as string | null | undefined) ?? null,
          handled: Boolean(data.handled),
          handledAt: (data.handledAt as Date | null | undefined) ?? null,
          id: `callback-${state.callbackLogs.length + 1}`,
          payload: data.payload,
          payloadHash,
          provider: data.provider as ESignProviderType,
          providerTaskId: (data.providerTaskId as string | null | undefined) ?? null,
          providerTransactionId:
            (data.providerTransactionId as string | null | undefined) ?? null,
          receivedAt: new Date(),
          taskId: (data.taskId as string | null | undefined) ?? null,
          verified: Boolean(data.verified)
        };
        state.callbackLogs.push(log);
        return log;
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const log = state.callbackLogs.find((item) => item.id === where.id);
        if (!log) {
          throw new Error("callback log not found");
        }
        Object.assign(log, data);
        return log;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const composite = where.provider_payloadHash as
          | { payloadHash?: string; provider?: ESignProviderType }
          | undefined;
        if (composite?.payloadHash && composite.provider) {
          return state.callbackLogs.find((item) =>
            item.provider === composite.provider &&
            item.payloadHash === composite.payloadHash
          ) ?? null;
        }
        return null;
      })
    },
    contractESignSigner: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const signer = state.signers.find((item) => matchesWhere(item, where));
        if (!signer) {
          return null;
        }
        const task = state.tasks.find((item) => item.id === signer.taskId);
        return {
          ...signer,
          task: task ? hydrateTask(state, task) : null
        };
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const signer = state.signers.find((item) => matchesWhere(item, where));
        if (!signer) {
          return null;
        }
        const task = state.tasks.find((item) => item.id === signer.taskId);
        return {
          ...signer,
          task: task ? hydrateTask(state, task) : null
        };
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const signer = state.signers.find((item) => item.id === where.id);
        if (!signer) {
          throw new Error("signer not found");
        }
        Object.assign(signer, data);
        return signer;
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.signers.filter((signer) => matchesWhere(signer, where));
        rows.forEach((signer) => Object.assign(signer, data));
        return { count: rows.length };
      })
    },
    contractESignTask: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const task: FakeTask = {
          callbackSnapshot: null,
          cancelledAt: null,
          completedAt: null,
          contractId: data.contractId as string,
          createdAt: new Date(),
          customerId: (data.customerId as string | null | undefined) ?? null,
          deletedAt: null,
          documentName: (data.documentName as string | null | undefined) ?? null,
          errorSnapshot: null,
          evidenceObjectKey: null,
          failedAt: null,
          id: `task-${state.tasks.length + 1}`,
          orderId: (data.orderId as string | null | undefined) ?? null,
          provider: data.provider as ESignProviderType,
          providerEnvelopeId: null,
          providerTaskId: null,
          requestSnapshot: data.requestSnapshot,
          responseSnapshot: null,
          documentType: (data.documentType as string | undefined) ?? "SUBSCRIPTION_CONTRACT",
          signUrl: null,
          signUrlExpiresAt: null,
          signingStage:
            (data.signingStage as string | undefined) ??
            "STAGE1_SUBSCRIPTION_CONTRACT",
          signedDocumentObjectKey: null,
          startedAt: null,
          taskNo: data.taskNo as string,
          taskStatus: data.taskStatus as ESignTaskStatus,
          updatedAt: new Date()
        };
        state.tasks.push(task);
        const signerInputs = ((data.signers as { create?: Array<Record<string, unknown>> } | undefined)?.create ?? []);
        signerInputs.forEach((signerInput) => {
          state.signers.push({
            customerId: (signerInput.customerId as string | null | undefined) ?? null,
            deletedAt: null,
            documentType:
              (signerInput.documentType as string | null | undefined) ?? null,
            id: `signer-${state.signers.length + 1}`,
            providerActionType:
              (signerInput.providerActionType as string | null | undefined) ?? null,
            providerSignerId: null,
            providerTransactionId: null,
            rejectReason: null,
            rejectedAt: null,
            required: (signerInput.required as boolean | undefined) ?? true,
            signedAt: null,
            signerIdNoMasked: null,
            signerName: (signerInput.signerName as string | null | undefined) ?? null,
            signerPhone: (signerInput.signerPhone as string | null | undefined) ?? null,
            signerStatus: signerInput.signerStatus as ESignSignerStatus,
            signerType: signerInput.signerType as ESignSignerType,
            signUrl: null,
            signUrlExpiresAt: null,
            slotId: (signerInput.slotId as string | null | undefined) ?? null,
            snapshot: signerInput.snapshot,
            taskId: task.id
          });
        });
        return hydrateTask(state, task);
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const task = state.tasks.find((item) => matchesWhere(item, where));
        return task ? hydrateTask(state, task) : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.tasks.filter((task) => matchesWhere(task, where)).map((task) => hydrateTask(state, task))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const task = state.tasks.find((item) => item.id === where.id);
        return task ? hydrateTask(state, task) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const task = state.tasks.find((item) => item.id === where.id);
        if (!task) {
          throw new Error("task not found");
        }
        return hydrateTask(state, task);
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const task = state.tasks.find((item) => item.id === where.id);
        if (!task) {
          throw new Error("task not found");
        }
        Object.assign(task, data);
        return hydrateTask(state, task);
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.tasks.filter((task) => matchesWhere(task, where));
        rows.forEach((task) => Object.assign(task, data));
        return { count: rows.length };
      })
    },
    customerESignProviderAccount: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.providerAccounts.find((account) => matchesWhere(account, where)) ?? null
      )
    },
    subscriptionOrder: {
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.contracts
          .map((contract) => contract.order)
          .filter((order) => matchesWhere(order, where));
        rows.forEach((order) => Object.assign(order, data));
        return { count: rows.length };
      })
    },
    vehicleDeliveryHandover: {
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.deliveryHandovers.filter((handover) => matchesWhere(handover, where));
        rows.forEach((handover) => Object.assign(handover, data));
        return { count: rows.length };
      })
    }
  };

  const configService = new ConfigService({
    API_BASE_URL: "http://localhost:3001/api",
    ESIGN_MOCK_ENABLED: "true",
    ESIGN_PROVIDER: "mock",
    ESIGN_SIGN_URL_EXPIRES_SECONDS: "1800",
    PORTAL_BASE_URL: "http://localhost:3000",
    ...env
  });
  const auditService = { write: vi.fn(async () => undefined) };
  const notificationService = { notifyCustomer: vi.fn(async () => undefined) };
  const contractPdfArtifactService = options.contractPdfArtifactService ?? {
    preflightContractPdfArtifact: vi.fn(async () => undefined)
  };
  const service = new ESignService(
    auditService as never,
    configService,
    providerOverride ?? new MockESignProvider(configService),
    prisma as never,
    notificationService as never,
    contractPdfArtifactService as never
  );

  return {
    auditService,
    contractPdfArtifactService,
    notificationService,
    prisma,
    service,
    state
  };
}

function hydrateContract(state: FakeState, contract: FakeContract) {
  return {
    ...contract,
    esignTasks: state.tasks
      .filter((task) => task.contractId === contract.id && !task.deletedAt)
      .map((task) => ({
        ...task,
        signers: state.signers.filter((signer) => signer.taskId === task.id && !signer.deletedAt)
      }))
  };
}

function hydrateTask(state: FakeState, task: FakeTask) {
  const contract = state.contracts.find((item) => item.id === task.contractId);
  if (!contract) {
    throw new Error("contract not found");
  }

  return {
    ...task,
    callbacks: state.callbackLogs
      .filter((log) => log.taskId === task.id)
      .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime()),
    contract,
    signers: state.signers.filter((signer) => signer.taskId === task.id && !signer.deletedAt)
  };
}

function createContract(id: string, customerId: string, orderId: string, orderNo: string): FakeContract {
  return {
    archivedAt: null,
    businessType: "SUBSCRIPTION",
    contractNo: id === "contract-1" ? "CON-1" : "CON-2",
    contractSnapshot: {},
    contractTitle: "订阅合同",
    contractVersionId: "contract-version-1",
    createdAt: new Date(),
    customer: {
      id: customerId,
      mobile: customerId === "customer-1" ? "13800000000" : "13900000000",
      name: customerId === "customer-1" ? "张三" : "李四"
    },
    customerId,
    deletedAt: null,
    fileId: null,
    id,
    order: {
      application: { applicationNo: "APP-1", id: "application-1", salesUserId: "user-sales" },
      contractId: id,
      deletedAt: null,
      id: orderId,
      orderNo,
      orderStatus: OrderStatus.PENDING_SIGN,
      quote: { id: "quote-1", quoteNo: "QUO-1" },
      vehicle: {
        assetLocation: "上海",
        batteryCapacityKwh: 75,
        batteryUsageType: "BUYOUT",
        brand: "NIO",
        currentMileageKm: 1200,
        modelYear: 2025,
        series: "ES6",
        vehicleModel: "ES6"
      }
    },
    orderId,
    signedAt: null,
    status: ContractStatus.GENERATED,
    updatedAt: new Date()
  };
}

function createProviderAccount(
  customerId: string,
  overrides: Partial<FakeProviderAccount> = {}
): FakeProviderAccount {
  return {
    accountType: ESignProviderAccountType.PERSONAL,
    certBindingSource: ESignProviderCertBindingSource.QUERY_CERT,
    certBindingStatus: ESignProviderCertBindingStatus.BOUND,
    certBoundAt: new Date("2026-07-14T00:05:00.000Z"),
    certSerialNo: "CERT-SEQUENCE-1",
    customerId,
    deletedAt: null,
    id: `provider-account-${customerId}`,
    provider: ESignProviderType.FADADA,
    providerCustomerId: `fadada-${customerId}`,
    providerStatusLastRefreshedAt: new Date("2026-07-14T00:05:00.000Z"),
    readinessBlockingCode: null,
    readinessBlockingReason: null,
    realNameProviderStatus: "2",
    realNameProviderStatusSource: ESignProviderRealNameStatusSource.QUERY,
    realNameProviderVerifiedAt: new Date("2026-07-14T00:00:00.000Z"),
    realNameStatus: ESignRealNameStatus.VERIFIED,
    registrationStatus: ESignProviderAccountStatus.REGISTERED,
    ...overrides
  };
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) {
      return true;
    }
    if (key === "OR" && Array.isArray(expected)) {
      return expected.some((item) => matchesWhere(row, item as Record<string, unknown>));
    }
    if (key === "task" && expected && typeof expected === "object") {
      return true;
    }
    if (key === "deletedAt" && expected === null) {
      return row.deletedAt === null;
    }
    if (expected && typeof expected === "object" && "in" in expected) {
      return Array.isArray((expected as { in: unknown[] }).in) &&
        (expected as { in: unknown[] }).in.includes(row[key]);
    }
    if (key === "providerCustomerId" && expected && typeof expected === "object") {
      const notValue = (expected as Record<string, unknown>).not;
      if (notValue === null) {
        return row.providerCustomerId !== null && row.providerCustomerId !== undefined;
      }
    }
    if (
      key === "id" ||
      key === "contractId" ||
      key === "customerId" ||
      key === "orderId" ||
      key === "providerEnvelopeId" ||
      key === "providerSignerId" ||
      key === "providerTransactionId" ||
      key === "slotId" ||
      key === "taskId" ||
      key === "taskNo"
    ) {
      return row[key] === expected;
    }
    if (
      key === "accountType" ||
      key === "certBindingSource" ||
      key === "certBindingStatus" ||
      key === "documentType" ||
      key === "provider" ||
      key === "providerActionType" ||
      key === "providerTaskId" ||
      key === "required" ||
      key === "realNameProviderStatusSource" ||
      key === "realNameStatus" ||
      key === "registrationStatus" ||
      key === "signingStage" ||
      key === "taskStatus" ||
      key === "signerType"
    ) {
      return row[key] === expected;
    }
    if (key === "orderStatus") {
      return row[key] === expected;
    }
    if (key === "contractId" && row.contractId === expected) {
      return true;
    }
    return true;
  });
}

function buildTestTransactionId(taskNo: string, index: number) {
  const suffix = `S${index}`;
  const normalized = taskNo.replace(/[^A-Za-z0-9]/g, "");
  return `${normalized.slice(0, 32 - suffix.length)}${suffix}`;
}

function readSnapshotField(snapshot: unknown, key: string) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return undefined;
  }
  return (snapshot as Record<string, unknown>)[key];
}

function stage1SlotCoordinates() {
  return [
    { pageNumber: 0, slotId: "STAGE1_BODY_CUSTOMER", x: 520, y: 730 },
    { pageNumber: 0, slotId: "STAGE1_BODY_PLATFORM", x: 521, y: 731 },
    { pageNumber: 2, slotId: "STAGE1_ATTACHMENT1_CUSTOMER", x: 522, y: 732 },
    { pageNumber: 2, slotId: "STAGE1_ATTACHMENT1_PLATFORM", x: 523, y: 733 }
  ];
}

function stage1SlotProvider() {
  const verifier = new FadadaESignProvider(loadFadadaConfig(fadadaConfigService()));
  return {
    createSignTask: vi.fn(async (input) => {
      const actions: ESignProviderActionResult[] = [
        {
          coveredSlotIds: ["STAGE1_BODY_CUSTOMER", "STAGE1_ATTACHMENT1_CUSTOMER"],
          providerActionType: "CUSTOMER_MANUAL_SIGN" as const,
          providerSignerId: "CUSTS1",
          providerTransactionId: "CUSTS1",
          signerType: "CUSTOMER" as const,
          signingStage: "STAGE1_CONTRACT" as const,
          signUrl: "https://sign.example.test/customer-stage1",
          signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z")
        },
        {
          coveredSlotIds: ["STAGE1_BODY_PLATFORM", "STAGE1_ATTACHMENT1_PLATFORM"],
          providerActionType: "PLATFORM_AUTO_SEAL" as const,
          providerSignerId: "PLATS1",
          providerTransactionId: "PLATS1",
          signerType: "PLATFORM" as const,
          signingStage: "STAGE1_CONTRACT" as const
        }
      ];
      return {
        actions,
        providerEnvelopeId: input.taskNo,
        providerTaskId: "CUSTS1",
        rawResponse: { provider: "fadada", stage1Slots: true },
        signUrl: "https://sign.example.test/customer-stage1",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z")
      };
    }),
    getSignerUrl: vi.fn(),
    verifyCallback: vi.fn((payload) => verifier.verifyCallback(payload))
  } satisfies ESignProvider & {
    createSignTask: ReturnType<typeof vi.fn>;
  };
}

function stage1CustomerOnlyProvider() {
  const verifier = new FadadaESignProvider(loadFadadaConfig(fadadaConfigService()));
  return {
    createSignTask: vi.fn(async (input) => {
      const actions: ESignProviderActionResult[] = [{
        coveredSlotIds: ["STAGE1_BODY_CUSTOMER", "STAGE1_ATTACHMENT1_CUSTOMER"],
        providerActionType: "CUSTOMER_MANUAL_SIGN" as const,
        providerSignerId: "CUSTS1",
        providerTransactionId: "CUSTS1",
        signerType: "CUSTOMER" as const,
        signingStage: "STAGE1_CONTRACT" as const,
        signUrl: "https://sign.example.test/customer-stage1",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z")
      }];
      return {
        actions,
        providerEnvelopeId: input.taskNo,
        providerTaskId: "CUSTS1",
        rawResponse: { provider: "fadada", stage1CustomerOnly: true },
        signUrl: "https://sign.example.test/customer-stage1",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z")
      };
    }),
    getSignerUrl: vi.fn(),
    verifyCallback: vi.fn((payload) => verifier.verifyCallback(payload))
  } satisfies ESignProvider & {
    createSignTask: ReturnType<typeof vi.fn>;
  };
}

function stage1CustomerThenPlatformAutoSealProvider() {
  const verifier = new FadadaESignProvider(loadFadadaConfig(fadadaConfigService()));
  const platformSlotIds: ESignSlotId[] = ["STAGE1_BODY_PLATFORM", "STAGE1_ATTACHMENT1_PLATFORM"];
  return {
    autoSealTask: vi.fn(async (input) => ({
      coveredSlotIds: platformSlotIds,
      providerActionType: "PLATFORM_AUTO_SEAL" as const,
      providerSignerId: input.transactionId,
      providerTransactionId: input.transactionId,
      rawResponse: { autoSeal: "ok" },
      signingStage: "STAGE1_CONTRACT" as const,
      status: "COMPLETED" as const
    })),
    createSignTask: vi.fn(async (input) => {
      const actions: ESignProviderActionResult[] = [{
        coveredSlotIds: ["STAGE1_BODY_CUSTOMER", "STAGE1_ATTACHMENT1_CUSTOMER"],
        providerActionType: "CUSTOMER_MANUAL_SIGN" as const,
        providerSignerId: "CUSTS1",
        providerTransactionId: "CUSTS1",
        signerType: "CUSTOMER" as const,
        signingStage: "STAGE1_CONTRACT" as const,
        signUrl: "https://sign.example.test/customer-stage1",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z")
      }];
      return {
        actions,
        providerEnvelopeId: input.taskNo,
        providerTaskId: "CUSTS1",
        rawResponse: { provider: "fadada", stage1CustomerOnly: true },
        signUrl: "https://sign.example.test/customer-stage1",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z")
      };
    }),
    getSignerUrl: vi.fn(),
    verifyCallback: vi.fn((payload) => verifier.verifyCallback(payload))
  } satisfies ESignProvider & {
    autoSealTask: ReturnType<typeof vi.fn>;
    createSignTask: ReturnType<typeof vi.fn>;
  };
}

function createFadadaESignFixture() {
  const verifier = new FadadaESignProvider(loadFadadaConfig(fadadaConfigService()));
  const provider: ESignProvider = {
    createSignTask: vi.fn(async (input) => {
      const transactionId = buildTestTransactionId(input.taskNo, 1);
      return {
        providerEnvelopeId: input.taskNo,
        providerTaskId: transactionId,
        rawResponse: { provider: "fadada" },
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z"),
        signers: [{
          customerId: "customer-1",
          providerSignerId: transactionId,
          signUrl: "https://sign.example.test/customer",
          signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z"),
          signerType: "CUSTOMER" as const
        }]
      };
    }),
    getSignerUrl: vi.fn(),
    verifyCallback: vi.fn((payload) => verifier.verifyCallback(payload))
  };

  return createESignFixture({ ESIGN_PROVIDER: "fadada" }, provider);
}

function enterpriseAutoSealProvider(result: {
  providerSignerId?: string;
  rawResponse?: unknown;
  resultCode?: string;
  resultDescription?: string;
  status: "COMPLETED" | "FAILED" | "PENDING";
} = {
  providerSignerId: "ESG1S2",
  rawResponse: { autoSeal: "ok" },
  status: "COMPLETED"
}) {
  const verifier = new FadadaESignProvider(loadFadadaConfig(fadadaConfigService()));
  return {
    autoSealTask: vi.fn(async () => result),
    createSignTask: vi.fn(async (input) => {
      const transactionId = buildTestTransactionId(input.taskNo, 1);
      return {
        providerEnvelopeId: input.taskNo,
        providerTaskId: transactionId,
        rawResponse: { provider: "fadada" },
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z"),
        signers: [{
          customerId: "customer-1",
          providerSignerId: transactionId,
          signUrl: "https://sign.example.test/customer",
          signUrlExpiresAt: new Date("2026-01-02T03:34:05.000Z"),
          signerType: "CUSTOMER" as const
        }]
      };
    }),
    getSignerUrl: vi.fn(),
    verifyCallback: vi.fn((payload) => verifier.verifyCallback(payload))
  } satisfies ESignProvider & {
    autoSealTask: ReturnType<typeof vi.fn>;
  };
}

function fadadaConfigService() {
  return new ConfigService({
    ESIGN_PROVIDER: "fadada",
    FADADA_API_VERSION: "2.0",
    FADADA_APP_ID: "app-123",
    FADADA_APP_SECRET: "secret-xyz",
    FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
    FADADA_ENABLED: "false",
    FADADA_ENV: "sandbox",
    FADADA_REQUEST_TIMEOUT_MS: "15000"
  });
}

function fadadaCallbackPayload(input: {
  contractId: string;
  resultCode: string;
  resultDesc?: string;
  transactionId: string | null | undefined;
}) {
  const timestamp = "20260102030405";
  const transactionId = input.transactionId ?? "";
  const msgDigest = buildFadadaMsgDigest({
    appId: "app-123",
    appSecret: "secret-xyz",
    explicitSortString: transactionId,
    timestamp
  });

  return {
    contract_id: input.contractId,
    download_url: "https://download.example.test/file.pdf?token=secret",
    msg_digest: msgDigest,
    result_code: input.resultCode,
    result_desc: input.resultDesc ?? "ok",
    timestamp,
    transaction_id: transactionId,
    viewpdf_url: "https://view.example.test/file.pdf?token=secret"
  };
}

function adminUser(): RequestUser {
  return {
    id: "user-admin",
    menus: [],
    name: "Admin",
    permissions: ["contract:view", "contract:sign"],
    roles: ["admin"],
    username: "admin"
  };
}

function approvedPlanRef(): ApprovedSigningPlanRef {
  return {
    executionMode: "SEQUENTIAL",
    planHash: "sha256:abc123",
    policyId: "policy-1",
    signingPlanId: "signing-plan-1",
    steps: [
      {
        required: true,
        signerRole: "CUSTOMER",
        signerType: "CUSTOMER",
        stepOrder: 1
      },
      {
        required: true,
        sealId: "seal-1",
        signerRole: "ENTERPRISE_SEAL",
        signerType: "PLATFORM",
        stepOrder: 2
      }
    ]
  };
}

function enterprisePolicyInput(overrides: Partial<SignaturePolicyEngineInput> = {}): SignaturePolicyEngineInput {
  return {
    actor: {
      id: "user-admin",
      permissionCodes: ["contract:sign"],
      roleCodes: ["admin"]
    },
    authorities: [enterpriseAuthority()],
    contract: {
      businessType: "SUBSCRIPTION",
      contractTemplateType: "SUBSCRIPTION_STANDARD",
      contractVersionId: "contract-version-1",
      id: "contract-1",
      status: "PENDING_SIGN"
    },
    customer: {
      id: "customer-secret-1",
      status: "ACTIVE"
    },
    customerReadiness: {
      realNameStatus: "VERIFIED",
      signingEligible: true,
      state: "SIGNING_ENABLED"
    },
    order: {
      customerId: "customer-secret-1",
      id: "order-1",
      orderStatus: "PENDING_SIGN"
    },
    policy: enterprisePolicy(),
    seal: enterpriseSeal(),
    source: "ADMIN",
    ...overrides
  };
}

function enterprisePolicy(overrides: Partial<SignaturePolicyView> = {}): SignaturePolicyView {
  return {
    contractTemplateType: "SUBSCRIPTION_STANDARD",
    defaultSealId: "seal-1",
    executionMode: "SEQUENTIAL",
    id: "policy-1",
    policyCode: "SUBSCRIPTION_STANDARD_SEAL",
    policyName: "Subscription standard enterprise seal",
    requiresEnterpriseSeal: true,
    status: "ACTIVE",
    ...overrides
  };
}

function enterpriseSeal(overrides: Partial<EnterpriseSealView> = {}): EnterpriseSealView {
  return {
    id: "seal-1",
    provider: "FADADA",
    providerSealId: "fadada-seal-secret-1",
    sealName: "Company seal",
    sealType: "COMPANY",
    status: "ACTIVE",
    ...overrides
  };
}

function enterpriseAuthority(overrides: Partial<SealAuthorityView> = {}): SealAuthorityView {
  return {
    authorityType: "REQUEST_USE",
    id: "authority-1",
    requiresTwoPersonApproval: false,
    sealId: "seal-1",
    status: "ACTIVE",
    subjectId: "user-admin",
    subjectType: "USER",
    ...overrides
  };
}

function currentCustomer(customerId: string): CurrentCustomer {
  return {
    accountStatus: CustomerAccountStatus.ACTIVE,
    customerAccountId: customerId === "customer-1" ? "account-1" : "account-2",
    customerId,
    phone: customerId === "customer-1" ? "13800000000" : "13900000000"
  };
}

function requestContext() {
  return {
    ipAddress: "127.0.0.1",
    userAgent: "vitest"
  };
}

interface FakeState {
  callbackLogs: FakeCallbackLog[];
  contracts: FakeContract[];
  deliveryHandovers: FakeDeliveryHandover[];
  providerAccounts: FakeProviderAccount[];
  signers: FakeSigner[];
  tasks: FakeTask[];
}

interface FakeProviderAccount extends Record<string, unknown> {
  accountType: ESignProviderAccountType;
  certBindingSource: ESignProviderCertBindingSource;
  certBindingStatus: ESignProviderCertBindingStatus;
  certBoundAt: Date | null;
  certSerialNo: string | null;
  customerId: string;
  deletedAt: Date | null;
  id: string;
  provider: ESignProviderType;
  providerCustomerId: string | null;
  providerStatusLastRefreshedAt: Date | null;
  readinessBlockingCode: string | null;
  readinessBlockingReason: string | null;
  realNameProviderStatus: string | null;
  realNameProviderStatusSource: ESignProviderRealNameStatusSource;
  realNameProviderVerifiedAt: Date | null;
  realNameStatus: ESignRealNameStatus;
  registrationStatus: ESignProviderAccountStatus;
}

interface FakeContract extends Record<string, unknown> {
  archivedAt: Date | null;
  businessType: string;
  contractNo: string;
  contractSnapshot: Record<string, unknown>;
  contractTitle: string;
  contractVersionId: string;
  createdAt: Date;
  customer: { id: string; mobile: string; name: string };
  customerId: string;
  deletedAt: Date | null;
  fileId: string | null;
  id: string;
  order: Record<string, unknown> & {
    contractId: string;
    deletedAt: Date | null;
    id: string;
    orderNo: string;
    orderStatus: OrderStatus;
  };
  orderId: string;
  signedAt: Date | null;
  status: ContractStatus;
  updatedAt: Date;
}

interface FakeTask extends Record<string, unknown> {
  callbackSnapshot: unknown;
  cancelledAt: Date | null;
  completedAt: Date | null;
  contractId: string;
  createdAt: Date;
  customerId: string | null;
  deletedAt: Date | null;
  documentName: string | null;
  documentType?: string;
  errorSnapshot: unknown;
  evidenceObjectKey: string | null;
  failedAt: Date | null;
  id: string;
  orderId: string | null;
  provider: ESignProviderType;
  providerEnvelopeId: string | null;
  providerTaskId: string | null;
  requestSnapshot: unknown;
  responseSnapshot: unknown;
  signUrl: string | null;
  signUrlExpiresAt: Date | null;
  signedDocumentObjectKey: string | null;
  signingStage?: string;
  startedAt: Date | null;
  taskNo: string;
  taskStatus: ESignTaskStatus;
  updatedAt: Date;
}

interface FakeDeliveryHandover extends Record<string, unknown> {
  archiveStatus: string;
  completedAt: Date | null;
  customerSignedAt?: Date | null;
  deletedAt: Date | null;
  handoverContractId: string | null;
  handoverESignTaskId: string | null;
  id: string;
  orderId: string;
  platformSignedAt?: Date | null;
  status: string;
}

interface FakeSigner extends Record<string, unknown> {
  customerId: string | null;
  deletedAt: Date | null;
  documentType?: string | null;
  id: string;
  providerActionType?: string | null;
  providerSignerId: string | null;
  providerTransactionId?: string | null;
  rejectReason: string | null;
  rejectedAt: Date | null;
  required?: boolean;
  signedAt: Date | null;
  signerIdNoMasked: string | null;
  signerName: string | null;
  signerPhone: string | null;
  signerStatus: ESignSignerStatus;
  signerType: ESignSignerType;
  signUrl: string | null;
  signUrlExpiresAt: Date | null;
  slotId?: string | null;
  snapshot: unknown;
  taskId: string;
}

interface FakeCallbackLog extends Record<string, unknown> {
  errorMessage: string | null;
  eventType: string | null;
  handled: boolean;
  handledAt: Date | null;
  id: string;
  payload: unknown;
  payloadHash: string | null;
  provider: ESignProviderType;
  providerTaskId: string | null;
  providerTransactionId: string | null;
  receivedAt: Date;
  taskId: string | null;
  verified: boolean;
}
