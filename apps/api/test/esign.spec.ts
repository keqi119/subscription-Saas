import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  CustomerAccountStatus,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignTaskStatus,
  OrderStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { RequestUser } from "../src/auth/auth.types";
import { ESignProvider } from "../src/esign/esign.provider";
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
      handled: false,
      providerTaskId: "unknown-transaction",
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
      handled: false,
      providerTaskId: "unknowntransaction",
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
      handled: false,
      providerTaskId: task.providerTaskId,
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

function createESignFixture(
  env: Record<string, string> = {},
  providerOverride?: ESignProvider,
  options: {
    contractPdfArtifactService?: {
      preflightContractPdfArtifact: ReturnType<typeof vi.fn>;
    };
  } = {}
) {
  const state = {
    callbackLogs: [] as FakeCallbackLog[],
    contracts: [
      createContract("contract-1", "customer-1", "order-1", "ORD-1"),
      createContract("contract-2", "customer-2", "order-2", "ORD-2")
    ],
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
        const log: FakeCallbackLog = {
          errorMessage: null,
          eventType: (data.eventType as string | null | undefined) ?? null,
          handled: Boolean(data.handled),
          handledAt: (data.handledAt as Date | null | undefined) ?? null,
          id: `callback-${state.callbackLogs.length + 1}`,
          payload: data.payload,
          provider: data.provider as ESignProviderType,
          providerTaskId: (data.providerTaskId as string | null | undefined) ?? null,
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
          signUrl: null,
          signUrlExpiresAt: null,
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
            id: `signer-${state.signers.length + 1}`,
            providerSignerId: null,
            rejectReason: null,
            rejectedAt: null,
            signedAt: null,
            signerIdNoMasked: null,
            signerName: (signerInput.signerName as string | null | undefined) ?? null,
            signerPhone: (signerInput.signerPhone as string | null | undefined) ?? null,
            signerStatus: signerInput.signerStatus as ESignSignerStatus,
            signerType: signerInput.signerType as ESignSignerType,
            signUrl: null,
            signUrlExpiresAt: null,
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
      })
    },
    subscriptionOrder: {
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.contracts
          .map((contract) => contract.order)
          .filter((order) => matchesWhere(order, where));
        rows.forEach((order) => Object.assign(order, data));
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
  const contractPdfArtifactService = options.contractPdfArtifactService ?? {
    preflightContractPdfArtifact: vi.fn(async () => undefined)
  };
  const service = new ESignService(
    auditService as never,
    configService,
    providerOverride ?? new MockESignProvider(configService),
    prisma as never,
    undefined,
    contractPdfArtifactService as never
  );

  return { auditService, contractPdfArtifactService, prisma, service, state };
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
    if (
      key === "id" ||
      key === "contractId" ||
      key === "customerId" ||
      key === "orderId" ||
      key === "providerEnvelopeId" ||
      key === "providerSignerId" ||
      key === "taskId" ||
      key === "taskNo"
    ) {
      return row[key] === expected;
    }
    if (key === "provider" || key === "providerTaskId" || key === "taskStatus" || key === "signerType") {
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
  signers: FakeSigner[];
  tasks: FakeTask[];
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
  startedAt: Date | null;
  taskNo: string;
  taskStatus: ESignTaskStatus;
  updatedAt: Date;
}

interface FakeSigner extends Record<string, unknown> {
  customerId: string | null;
  deletedAt: Date | null;
  id: string;
  providerSignerId: string | null;
  rejectReason: string | null;
  rejectedAt: Date | null;
  signedAt: Date | null;
  signerIdNoMasked: string | null;
  signerName: string | null;
  signerPhone: string | null;
  signerStatus: ESignSignerStatus;
  signerType: ESignSignerType;
  signUrl: string | null;
  signUrlExpiresAt: Date | null;
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
  provider: ESignProviderType;
  providerTaskId: string | null;
  receivedAt: Date;
  taskId: string | null;
  verified: boolean;
}
