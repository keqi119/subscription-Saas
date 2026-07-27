import { ConfigService } from "@nestjs/config";
import {
  ESignDocumentType,
  ESignProviderType,
  ESignSigningStage
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  QuerySignerStatusInput
} from "../src/esign/esign.provider";
import { loadFadadaConfig } from "../src/esign/fadada/fadada.config";
import { FadadaESignProvider } from "../src/esign/fadada/fadada-esign.provider";
import { MockESignProvider } from "../src/esign/mock-esign.provider";

const TASK_NO = "ESG20260726080000ABCD";
const TRANSACTION_ID = "ESG20260726080000ABCDH1";
const QUERY_INPUT: QuerySignerStatusInput = {
  contractId: TASK_NO,
  providerCustomerId: "fadada-customer-1",
  providerTaskId: TRANSACTION_ID,
  providerTransactionId: TRANSACTION_ID,
  signerId: "stage2-customer-signer-1",
  slotId: "STAGE2_HANDOVER_CUSTOMER",
  taskId: "stage2-task-1"
};

describe("Stage 2 provider signer status query", () => {
  it("queries the locally bound provider contract, customer, and signer transaction", async () => {
    const harness = fadadaHarness({
      resultCode: "3000",
      resultDesc: "completed",
      status: "SIGNED"
    });

    await expect(
      harness.provider.querySignerStatus(QUERY_INPUT)
    ).resolves.toEqual({
      resultCode: "3000",
      resultDescription: "completed",
      status: "SIGNED"
    });
    expect(harness.apiClient.querySignResult).toHaveBeenCalledWith({
      contractId: TASK_NO,
      customerId: "fadada-customer-1",
      transactionId: TRANSACTION_ID
    });
  });

  it("maps only resultCode 3000 to SIGNED", async () => {
    const harness = fadadaHarness({
      resultCode: "2999",
      resultDesc: "unrecognized completion",
      status: "SIGNED"
    });

    await expect(
      harness.provider.querySignerStatus(QUERY_INPUT)
    ).resolves.toMatchObject({
      resultCode: "2999",
      status: "UNKNOWN"
    });
  });

  it("maps active provider states to SIGNING without consuming an attempt", async () => {
    const harness = fadadaHarness({
      resultCode: "1000",
      resultDesc: "active",
      status: "SIGNING"
    });

    await expect(
      harness.provider.querySignerStatus(QUERY_INPUT)
    ).resolves.toEqual({
      resultCode: "1000",
      resultDescription: "active",
      status: "SIGNING"
    });
    expect(
      harness.prisma.contractESignSigner.updateMany
    ).not.toHaveBeenCalled();
  });

  it("fails closed on a mismatched transaction, customer, slot, or unknown result", async () => {
    const harness = fadadaHarness({
      resultCode: "3000",
      resultDesc: "completed",
      status: "SIGNED"
    });
    const remoteMismatches = [
      { providerContractId: "OTHER-CONTRACT" },
      { providerCustomerId: "other-customer" },
      { providerTransactionId: "OTHERTRANSACTION" }
    ];

    for (const mismatch of remoteMismatches) {
      harness.apiClient.querySignResult.mockResolvedValueOnce({
        ...exactRemoteResult({
          resultCode: "3000",
          resultDesc: "completed",
          status: "SIGNED"
        }),
        ...mismatch
      });
      await expect(
        harness.provider.querySignerStatus(QUERY_INPUT)
      ).resolves.toMatchObject({ status: "UNKNOWN" });
    }

    await expect(
      harness.provider.querySignerStatus({
        ...QUERY_INPUT,
        slotId: "STAGE2_HANDOVER_PLATFORM"
      })
    ).resolves.toMatchObject({ status: "UNKNOWN" });

    harness.apiClient.querySignResult.mockResolvedValueOnce(
      exactRemoteResult({
        resultCode: "3999",
        resultDesc: "unknown",
        status: "UNKNOWN"
      })
    );
    await expect(
      harness.provider.querySignerStatus(QUERY_INPUT)
    ).resolves.toMatchObject({ status: "UNKNOWN" });
  });

  it("mock queries only exact operations that createSignTask actually created", async () => {
    const provider = new MockESignProvider(mockConfig());

    await expect(
      provider.querySignerStatus({
        ...QUERY_INPUT,
        providerCustomerId: "customer-1"
      })
    ).resolves.toEqual({ status: "UNKNOWN" });
    await expect(
      provider.getSignerUrl({
        contractId: TASK_NO,
        providerTaskId: TRANSACTION_ID,
        signerId: QUERY_INPUT.signerId,
        taskId: QUERY_INPUT.taskId
      })
    ).rejects.toThrow(/MOCK_SIGNER_OPERATION_NOT_FOUND/);

    await provider.createSignTask({
      contractId: "contract-stage2-1",
      documentName: "Delivery handover confirmation",
      documentType: "DELIVERY_HANDOVER",
      signers: [{
        customerId: "customer-1",
        signerId: QUERY_INPUT.signerId,
        signerType: "CUSTOMER"
      }],
      signingSlots: [{
        documentType: "DELIVERY_HANDOVER",
        keyword: "stage2-handover-customer",
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        required: true,
        signerRole: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        slotId: "STAGE2_HANDOVER_CUSTOMER"
      }],
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      sourcePdfHash: "b".repeat(64),
      taskId: QUERY_INPUT.taskId,
      taskNo: TASK_NO,
      transactionId: TRANSACTION_ID
    });

    const mockQuery = {
      ...QUERY_INPUT,
      providerCustomerId: "customer-1"
    };
    await expect(
      provider.querySignerStatus(mockQuery)
    ).resolves.toEqual({
      resultCode: "MOCK_SIGNING",
      resultDescription: "Mock customer signing operation is active.",
      status: "SIGNING"
    });
    await expect(
      provider.querySignerStatus({
        ...mockQuery,
        signerId: "other-signer"
      })
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("refreshes an expired Stage 1 URL created by the mock provider", async () => {
    const provider = new MockESignProvider(mockConfig());
    const createdAt = Date.parse("2026-07-27T08:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(createdAt);

    try {
      const created = await provider.createSignTask({
        contractId: "contract-stage1-created",
        documentName: "Subscription contract",
        documentType: "CONTRACT_BODY",
        signers: [{
          customerId: "customer-1",
          signerId: "stage1-customer-signer-created",
          signerType: "CUSTOMER"
        }],
        signingStage: "STAGE1_CONTRACT",
        taskId: "stage1-task-created",
        taskNo: "ESG_STAGE1_CREATED"
      });
      const originalExpiry = created.signUrlExpiresAt!;
      now.mockReturnValue(originalExpiry.getTime() + 60_000);

      const refreshed = await provider.getSignerUrl({
        contractId: "contract-stage1-created",
        providerTaskId: created.providerTaskId,
        signerId: "stage1-customer-signer-created",
        taskId: "stage1-task-created"
      });

      expect(refreshed.signUrl).toBe(created.signUrl);
      expect(refreshed.expiresAt!.getTime()).toBeGreaterThan(
        originalExpiry.getTime()
      );
      expect(refreshed.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      now.mockRestore();
    }
  });

  it("preserves legacy Stage 1 mock URL synthesis without creating Stage 2 acceptance", async () => {
    const provider = new MockESignProvider(mockConfig());

    await expect(
      provider.getSignerUrl({
        contractId: "contract-stage1-1",
        providerTaskId: "mock_ESG_STAGE1_1",
        signerId: "stage1-customer-signer-1",
        taskId: "stage1-task-1"
      })
    ).resolves.toMatchObject({
      signUrl:
        "http://localhost:3000/portal/contracts/contract-stage1-1/sign?taskId=stage1-task-1"
    });
    await expect(
      provider.querySignerStatus({
        contractId: "contract-stage1-1",
        providerCustomerId: "customer-1",
        providerTaskId: "mock_ESG_STAGE1_1",
        providerTransactionId: "MOCKSTAGE1TX",
        signerId: "stage1-customer-signer-1",
        slotId: "STAGE2_HANDOVER_CUSTOMER",
        taskId: "stage1-task-1"
      })
    ).resolves.toEqual({ status: "UNKNOWN" });
  });
});

function fadadaHarness(
  remote: {
    resultCode: string;
    resultDesc: string;
    status: "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN";
  }
) {
  const apiClient = {
    querySignResult: vi.fn(async () => exactRemoteResult(remote))
  };
  const prisma = {
    contractESignSigner: {
      findFirst: vi.fn(async () => ({
        customerId: "customer-1",
        id: QUERY_INPUT.signerId,
        providerTransactionId: TRANSACTION_ID,
        slotId: "STAGE2_HANDOVER_CUSTOMER",
        taskId: QUERY_INPUT.taskId
      })),
      updateMany: vi.fn()
    },
    contractESignTask: {
      findFirst: vi.fn(async () => ({
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        id: QUERY_INPUT.taskId,
        provider: ESignProviderType.FADADA,
        providerEnvelopeId: TASK_NO,
        providerTaskId: TRANSACTION_ID,
        signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
        taskNo: TASK_NO
      }))
    },
    customerESignProviderAccount: {
      findFirst: vi.fn(async () => ({
        providerCustomerId: "fadada-customer-1"
      }))
    }
  };
  return {
    apiClient,
    prisma,
    provider: new FadadaESignProvider(
      loadFadadaConfig(fadadaConfig()),
      apiClient as never,
      undefined,
      prisma as never
    )
  };
}

function exactRemoteResult(
  result: {
    resultCode: string;
    resultDesc: string;
    status: "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN";
  }
) {
  return {
    contractId: TASK_NO,
    providerContractId: TASK_NO,
    providerCustomerId: "fadada-customer-1",
    providerTransactionId: TRANSACTION_ID,
    raw: {},
    transactionId: TRANSACTION_ID,
    ...result
  };
}

function fadadaConfig() {
  return new ConfigService({
    FADADA_API_VERSION: "2.0",
    FADADA_APP_ID: "app-123",
    FADADA_APP_SECRET: "secret-xyz",
    FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
    FADADA_ENABLED: "1",
    FADADA_ENV: "sandbox",
    FADADA_REQUEST_TIMEOUT_MS: "5000"
  });
}

function mockConfig() {
  return new ConfigService({
    PORTAL_BASE_URL: "http://localhost:3000"
  });
}
