/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  QuerySignerStatusInput
} from "../src/esign/esign.provider";
import { ESignService } from "../src/esign/esign.service";
import { loadFadadaConfig } from "../src/esign/fadada/fadada.config";
import { FadadaESignProvider } from "../src/esign/fadada/fadada-esign.provider";
import { MockESignProvider } from "../src/esign/mock-esign.provider";
import { Stage2HandoverWorkflowService } from "../src/handover-work-order/stage2-handover-workflow.service";

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

  it("queries exact platform H2 against the persisted H1 task binding", async () => {
    const platformTransactionId = `${TASK_NO}H2`;
    const harness = fadadaPlatformHarness({
      resultCode: "3000",
      resultDesc: "completed",
      status: "SIGNED"
    });

    await expect(
      harness.provider.querySignerStatus({
        contractId: TASK_NO,
        providerCustomerId: "platform-customer-1",
        providerTaskId: TRANSACTION_ID,
        providerTransactionId: platformTransactionId,
        signerId: "stage2-platform-signer-1",
        slotId: "STAGE2_HANDOVER_PLATFORM",
        taskId: QUERY_INPUT.taskId
      })
    ).resolves.toEqual({
      resultCode: "3000",
      resultDescription: "completed",
      status: "SIGNED"
    });
    expect(harness.apiClient.querySignResult).toHaveBeenCalledWith({
      contractId: TASK_NO,
      customerId: "platform-customer-1",
      transactionId: platformTransactionId
    });
  });

  it("mock tracks the exact H2 platform operation before reporting it signed", async () => {
    const provider = new MockESignProvider(mockConfig());
    const platformTransactionId = `${TASK_NO}H2`;
    const platformQuery: QuerySignerStatusInput = {
      contractId: TASK_NO,
      providerCustomerId: "platform-customer-1",
      providerTaskId: TRANSACTION_ID,
      providerTransactionId: platformTransactionId,
      signerId: "stage2-platform-signer-1",
      slotId: "STAGE2_HANDOVER_PLATFORM",
      taskId: QUERY_INPUT.taskId
    };

    await expect(
      provider.querySignerStatus(platformQuery)
    ).resolves.toEqual({ status: "UNKNOWN" });
    await provider.autoSealTask({
      contractId: "contract-stage2-1",
      documentType: "DELIVERY_HANDOVER",
      platformCustomerId: "platform-customer-1",
      providerEnvelopeId: TASK_NO,
      providerTaskId: TRANSACTION_ID,
      signerId: platformQuery.signerId,
      signingSlots: [{
        documentType: "DELIVERY_HANDOVER",
        keyword: "stage2-handover-platform",
        providerActionType: "PLATFORM_AUTO_SEAL",
        required: true,
        signerRole: "PLATFORM",
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        slotId: "STAGE2_HANDOVER_PLATFORM"
      }],
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: QUERY_INPUT.taskId,
      taskNo: TASK_NO,
      transactionId: platformTransactionId
    });

    await expect(
      provider.querySignerStatus(platformQuery)
    ).resolves.toEqual({
      resultCode: "3000",
      resultDescription:
        "Mock Stage 2 platform seal completed.",
      status: "SIGNED"
    });
    await expect(
      provider.querySignerStatus({
        ...platformQuery,
        providerTaskId: "OTHERH1"
      })
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("refreshes the exact expired Fadada H1 entry without uploading or creating a new transaction", async () => {
    const expiresAt = new Date("2026-07-28T02:30:00.000Z");
    const apiClient = {
      createExternalSignUrl: vi.fn(async () => ({
        raw: { result: "success" },
        signUrl: "https://testsign.fadada.com/refreshed-h1",
        signUrlExpiresAt: expiresAt
      })),
      uploadDocs: vi.fn()
    };
    const pdfArtifactService = {
      getContractPdfArtifact: vi.fn(async () => ({
        buffer: Buffer.from("%PDF-stage2-source"),
        fileName: "handover.pdf",
        objectKey: "private/stage2/source.pdf",
        size: 18,
        slotCoordinates: [
          {
            documentType: "DELIVERY_HANDOVER",
            pageNumber: 3,
            signingStage: "STAGE2_DELIVERY_HANDOVER",
            slotId: "STAGE2_HANDOVER_CUSTOMER",
            x: 220,
            y: 980
          },
          {
            documentType: "DELIVERY_HANDOVER",
            pageNumber: 3,
            signingStage: "STAGE2_DELIVERY_HANDOVER",
            slotId: "STAGE2_HANDOVER_PLATFORM",
            x: 580,
            y: 980
          }
        ],
        source: "GENERATED"
      }))
    };
    const prisma = {
      contractESignSigner: {
        findFirst: vi.fn(async () => ({
          customerId: "customer-1",
          deletedAt: null,
          documentType: ESignDocumentType.DELIVERY_HANDOVER,
          id: QUERY_INPUT.signerId,
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerTransactionId: TRANSACTION_ID,
          signUrl: "https://testsign.fadada.com/expired-h1",
          signUrlExpiresAt: new Date("2026-07-28T01:00:00.000Z"),
          signerType: "CUSTOMER",
          slotId: "STAGE2_HANDOVER_CUSTOMER",
          task: {
            contract: {
              contractTitle: "Delivery handover confirmation",
              customer: {
                mobile: "13800138000",
                name: "Customer"
              },
              id: "contract-stage2-1"
            },
            contractId: "contract-stage2-1",
            deletedAt: null,
            documentType: ESignDocumentType.DELIVERY_HANDOVER,
            documentName: "Delivery handover confirmation",
            id: QUERY_INPUT.taskId,
            provider: ESignProviderType.FADADA,
            providerEnvelopeId: TASK_NO,
            providerTaskId: TRANSACTION_ID,
            requestSnapshot: {
              sourcePdfHash: "b".repeat(64)
            },
            signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
            taskNo: TASK_NO
          },
          taskId: QUERY_INPUT.taskId
        }))
      },
      customerESignProviderAccount: {
        findFirst: vi.fn(async () => ({
          providerCustomerId: "fadada-customer-1"
        }))
      }
    };
    const provider = new FadadaESignProvider(
      loadFadadaConfig(fadadaConfig()),
      apiClient as never,
      pdfArtifactService as never,
      prisma as never
    );
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-07-28T02:00:00.000Z"));

    try {
      await expect(
        provider.getSignerUrl({
          contractId: TASK_NO,
          providerTaskId: TRANSACTION_ID,
          redirectUrl:
            "http://localhost:3000/portal/handover-reviews/work-order-1",
          signerId: QUERY_INPUT.signerId,
          taskId: QUERY_INPUT.taskId
        })
      ).resolves.toEqual({
        expiresAt,
        rawResponse: {
          providerSignerId: TRANSACTION_ID,
          refreshed: true
        },
        signUrl: "https://testsign.fadada.com/refreshed-h1"
      });
    } finally {
      now.mockRestore();
    }

    expect(apiClient.createExternalSignUrl).toHaveBeenCalledWith({
      contractId: TASK_NO,
      customerId: "fadada-customer-1",
      docTitle: "Delivery handover confirmation",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      returnUrl:
        "http://localhost:3000/portal/handover-reviews/work-order-1",
      signaturePositions: [{
        pagenum: 3,
        x: 220,
        y: 980
      }],
      signerMobile: "13800138000",
      signerName: "Customer",
      transactionId: TRANSACTION_ID
    });
    expect(apiClient.uploadDocs).not.toHaveBeenCalled();
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

describe("Stage 2 customer completion reconciliation", () => {
  it("customer callback and query converge on one customer-signed transition", async () => {
    const harness = customerTransitionHarness();
    const input = {
      completedAt: new Date("2026-07-28T02:00:00.000Z"),
      eSignTaskId: "stage2-task-1",
      providerTransactionId: TRANSACTION_ID
    };

    await Promise.all([
      (harness.service as any).reconcileCustomerSigned({
        ...input,
        source: "CALLBACK"
      }),
      (harness.service as any).reconcileCustomerSigned({
        ...input,
        source: "QUERY"
      })
    ]);

    expect(harness.customerSigner).toMatchObject({
      signedAt: input.completedAt,
      signerStatus: ESignSignerStatus.SIGNED
    });
    expect(harness.platformSigner).toMatchObject({
      signedAt: null,
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(harness.task).toMatchObject({
      completedAt: null,
      taskStatus: ESignTaskStatus.SIGNING
    });
    expect(harness.handover).toMatchObject({
      completedAt: null,
      customerSignedAt: input.completedAt,
      status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
    });
    expect(
      [...harness.jobs.values()].filter(
        (job) =>
          job.jobType ===
          VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM
      )
    ).toHaveLength(1);
  });

  it("writes AUTO_SEAL_PLATFORM and cancels obsolete customer checks in the customer-completion transaction", async () => {
    const harness = customerTransitionHarness();

    await (harness.service as any).reconcileCustomerSigned({
      completedAt: new Date("2026-07-28T02:00:00.000Z"),
      eSignTaskId: "stage2-task-1",
      providerTransactionId: TRANSACTION_ID,
      source: "QUERY"
    });

    expect(harness.transactionOptions).toEqual([
      {
        isolationLevel: "Serializable"
      }
    ]);
    expect(
      harness.jobs.get(
        `platform-seal:stage2-task-1:${TASK_NO}H2`
      )
    ).toMatchObject({
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      jobType: VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
      payload: {
        platformTransactionId: `${TASK_NO}H2`
      },
      workOrderId: "work-order-1"
    });
    expect(
      harness.jobs.get(
        "customer-reconcile:stage2-task-1:" + TRANSACTION_ID
      )
    ).toMatchObject({
      jobStatus: VehicleHandoverWorkflowJobStatus.CANCELLED
    });
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
    expect(harness.downstream.vehicleDeliveryUpdate).not.toHaveBeenCalled();
    expect(harness.downstream.leaseCreate).not.toHaveBeenCalled();
    expect(harness.downstream.billingWrite).not.toHaveBeenCalled();
    expect(harness.downstream.paymentWrite).not.toHaveBeenCalled();
    expect(harness.downstream.accountingWrite).not.toHaveBeenCalled();
    expect(harness.downstream.depreciationWrite).not.toHaveBeenCalled();
  });
});

describe("Stage 2 customer provider polling", () => {
  it("uses customer due intervals of 2m, 10m, 30m, then 6h without consuming attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date("2026-07-28T02:00:00.000Z")
    );
    try {
      const harness = customerPollingHarness();
      const expectedDelays = [
        10 * 60 * 1000,
        30 * 60 * 1000,
        6 * 60 * 60 * 1000,
        6 * 60 * 60 * 1000
      ];

      for (const [pollCount, expectedDelay] of
        expectedDelays.entries()) {
        const result = await harness.service.handle(
          customerWorkflowJob({
            resultSnapshot:
              pollCount === 0 ? null : { pollCount }
          })
        );

        expect(result).toEqual({
          availableAt: new Date(
            Date.now() + expectedDelay
          ),
          kind: "OBSERVED_SIGNING",
          result: {
            pollCount: pollCount + 1,
            providerStatus: "SIGNING",
            resultCode: "1000"
          }
        });
      }

      expect(
        harness.stage2ESignService
          .reconcileCustomerSignature
      ).toHaveBeenCalledTimes(4);
      expect(
        harness.repository.reschedule
      ).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Stage 2 platform completion reconciliation", () => {
  it("enqueues ARCHIVE_SIGNED_PDF after exact platform completion", async () => {
    const harness = customerTransitionHarness();
    const completedAt = new Date("2026-07-28T02:05:00.000Z");
    Object.assign(harness.customerSigner, {
      signedAt: new Date("2026-07-28T02:00:00.000Z"),
      signerStatus: ESignSignerStatus.SIGNED
    });
    Object.assign(harness.platformSigner, {
      providerTransactionId: `${TASK_NO}H2`,
      signerStatus: ESignSignerStatus.SIGNING
    });
    Object.assign(harness.handover, {
      customerSignedAt: harness.customerSigner.signedAt,
      status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
    });
    harness.task.taskStatus = ESignTaskStatus.SIGNING;

    await (harness.service as any).reconcilePlatformSigned({
      completedAt,
      eSignTaskId: harness.task.id,
      providerTransactionId: `${TASK_NO}H2`,
      source: "QUERY"
    });

    expect(harness.platformSigner).toMatchObject({
      signedAt: completedAt,
      signerStatus: ESignSignerStatus.SIGNED
    });
    expect(harness.task).toMatchObject({
      completedAt,
      taskStatus: ESignTaskStatus.COMPLETED
    });
    expect(harness.handover).toMatchObject({
      completedAt,
      platformSignedAt: completedAt,
      status: DeliveryHandoverStatus.SIGNED
    });
    expect(harness.jobs.get(
      "archive:stage2-task-1:3"
    )).toMatchObject({
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      jobType:
        VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF,
      payload: {
        artifactVersion: 3
      },
      workOrderId: "work-order-1"
    });
    expect(harness.downstream.vehicleDeliveryUpdate).not.toHaveBeenCalled();
    expect(harness.downstream.leaseCreate).not.toHaveBeenCalled();
    expect(harness.downstream.billingWrite).not.toHaveBeenCalled();
    expect(harness.downstream.paymentWrite).not.toHaveBeenCalled();
    expect(harness.downstream.accountingWrite).not.toHaveBeenCalled();
    expect(harness.downstream.depreciationWrite).not.toHaveBeenCalled();
  });

  it("platform callback and query converge on one deterministic archive job", async () => {
    const harness = customerTransitionHarness();
    Object.assign(harness.customerSigner, {
      signedAt: new Date("2026-07-28T02:00:00.000Z"),
      signerStatus: ESignSignerStatus.SIGNED
    });
    Object.assign(harness.platformSigner, {
      providerTransactionId: `${TASK_NO}H2`,
      signerStatus: ESignSignerStatus.SIGNING
    });
    Object.assign(harness.handover, {
      customerSignedAt: harness.customerSigner.signedAt,
      status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
    });
    harness.task.taskStatus = ESignTaskStatus.SIGNING;
    const input = {
      completedAt: new Date("2026-07-28T02:05:00.000Z"),
      eSignTaskId: harness.task.id,
      providerTransactionId: `${TASK_NO}H2`
    };

    await Promise.all([
      (harness.service as any).reconcilePlatformSigned({
        ...input,
        source: "CALLBACK"
      }),
      (harness.service as any).reconcilePlatformSigned({
        ...input,
        source: "QUERY"
      })
    ]);

    expect(
      [...harness.jobs.values()].filter(
        (job) =>
          job.jobType ===
          VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF
      )
    ).toHaveLength(1);
  });
});

describe("Stage 2 platform workflow polling", () => {
  it("enqueues RECONCILE_PLATFORM_SEAL for a pending provider result", async () => {
    const harness = platformWorkflowHarness();

    const result = await harness.service.handle(
      platformWorkflowJob(
        VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM
      )
    );

    expect(
      harness.stage2ESignService.retryPlatformSeal
    ).toHaveBeenCalledWith(
      "work-order-1",
      undefined,
      `${TASK_NO}H2`
    );
    expect(harness.repository.enqueue).toHaveBeenCalledWith(
      harness.prisma,
      {
        eSignTaskId: "stage2-task-1",
        handoverId: "handover-1",
        idempotencyKey:
          `platform-reconcile:stage2-task-1:${TASK_NO}H2`,
        jobType:
          VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL,
        payload: {
          platformTransactionId: `${TASK_NO}H2`
        },
        workOrderId: "work-order-1"
      }
    );
    expect(result).toEqual({
      kind: "COMPLETED",
      result: {
        providerStatus: "SIGNING",
        reconciliationEnqueued: true
      }
    });
  });

  it("defers active H2 reconciliation without consuming an attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date("2026-07-28T02:00:00.000Z")
    );
    try {
      const harness = platformWorkflowHarness();

      const result = await harness.service.handle(
        platformWorkflowJob(
          VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL
        )
      );

      expect(result).toEqual({
        availableAt: new Date(
          Date.now() + 2 * 60 * 1000
        ),
        kind: "OBSERVED_SIGNING",
        result: {
          providerStatus: "SIGNING",
          resultCode: "1000"
        }
      });
    } finally {
      vi.useRealTimers();
    }
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
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        id: QUERY_INPUT.signerId,
        providerActionType:
          ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
        providerTransactionId: TRANSACTION_ID,
        signerType: ESignSignerType.CUSTOMER,
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

function fadadaPlatformHarness(
  remote: {
    resultCode: string;
    resultDesc: string;
    status: "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN";
  }
) {
  const platformTransactionId = `${TASK_NO}H2`;
  const apiClient = {
    querySignResult: vi.fn(async () => ({
      contractId: TASK_NO,
      providerContractId: TASK_NO,
      providerCustomerId: "platform-customer-1",
      providerTransactionId: platformTransactionId,
      raw: {},
      transactionId: platformTransactionId,
      ...remote
    }))
  };
  const prisma = {
    contractESignSigner: {
      findFirst: vi.fn(async () => ({
        customerId: null,
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        id: "stage2-platform-signer-1",
        providerActionType:
          ESignProviderActionType.PLATFORM_AUTO_SEAL,
        providerTransactionId: platformTransactionId,
        signerType: ESignSignerType.PLATFORM,
        slotId: ESignSlotId.STAGE2_HANDOVER_PLATFORM,
        taskId: QUERY_INPUT.taskId
      }))
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
      findFirst: vi.fn()
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
    FADADA_REQUEST_TIMEOUT_MS: "5000",
    FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
    FADADA_SIGN_NOTIFY_URL:
      "https://api.example.test/esign/callback/fadada"
  });
}

function mockConfig() {
  return new ConfigService({
    PORTAL_BASE_URL: "http://localhost:3000"
  });
}

function customerTransitionHarness() {
  const customerSigner = {
    customerId: "customer-1",
    deletedAt: null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: "stage2-customer-signer-1",
    providerActionType:
      ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
    providerTransactionId: TRANSACTION_ID,
    required: true,
    signedAt: null as Date | null,
    signerStatus: ESignSignerStatus.SIGNING,
    signerType: ESignSignerType.CUSTOMER,
    slotId: ESignSlotId.STAGE2_HANDOVER_CUSTOMER,
    taskId: "stage2-task-1"
  };
  const platformSigner = {
    customerId: null,
    deletedAt: null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: "stage2-platform-signer-1",
    providerActionType:
      ESignProviderActionType.PLATFORM_AUTO_SEAL,
    providerTransactionId: null,
    required: true,
    signedAt: null as Date | null,
    signerStatus: ESignSignerStatus.PENDING,
    signerType: ESignSignerType.PLATFORM,
    slotId: ESignSlotId.STAGE2_HANDOVER_PLATFORM,
    taskId: "stage2-task-1"
  };
  const contract = {
    id: "contract-stage2-1",
    signedAt: null as Date | null,
    status: ContractStatus.SIGNING
  };
  const task = {
    completedAt: null as Date | null,
    contract,
    contractId: contract.id,
    deletedAt: null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: "stage2-task-1",
    provider: ESignProviderType.FADADA,
    providerEnvelopeId: TASK_NO,
    providerTaskId: TRANSACTION_ID,
    signers: [customerSigner, platformSigner],
    signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
    taskNo: TASK_NO,
    taskStatus:
      ESignTaskStatus.WAITING_CUSTOMER as ESignTaskStatus
  };
  const handover = {
    artifactVersion: 3,
    completedAt: null as Date | null,
    customerSignedAt: null as Date | null,
    deletedAt: null,
    handoverContractId: contract.id,
    handoverESignTaskId: task.id,
    id: "handover-1",
    platformSignedAt: null as Date | null,
    status: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE
  };
  const jobs = new Map<string, Record<string, any>>([
    [
      "customer-reconcile:stage2-task-1:" + TRANSACTION_ID,
      {
        completedAt: null,
        eSignTaskId: task.id,
        handoverId: handover.id,
        idempotencyKey:
          "customer-reconcile:stage2-task-1:" + TRANSACTION_ID,
        jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
        jobType:
          VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
        payload: {
          customerTransactionId: TRANSACTION_ID
        },
        workOrderId: "work-order-1"
      }
    ]
  ]);
  const transactionOptions: unknown[] = [];
  let transactionDepth = 0;
  const downstream = {
    accountingWrite: vi.fn(),
    billingWrite: vi.fn(),
    depreciationWrite: vi.fn(),
    leaseCreate: vi.fn(),
    paymentWrite: vi.fn(),
    vehicleDeliveryUpdate: vi.fn()
  };
  const prisma: any = {
    $transaction: vi.fn(
      async (
        operation: (tx: any) => Promise<unknown>,
        options: unknown
      ) => {
        transactionOptions.push(options);
        transactionDepth += 1;
        try {
          return await operation(prisma);
        } finally {
          transactionDepth -= 1;
        }
      }
    ),
    contract: {
      update: vi.fn(async ({ data }: any) => {
        Object.assign(contract, data);
        return contract;
      })
    },
    contractESignSigner: {
      updateMany: vi.fn(async ({ data, where }: any) => {
        const signer = [customerSigner, platformSigner].find(
          (item) =>
            item.id === where.id &&
            item.taskId === where.taskId &&
            (
              where.providerTransactionId === undefined ||
              item.providerTransactionId ===
                where.providerTransactionId
            ) &&
            (
              where.signerStatus === undefined ||
              where.signerStatus.in?.includes(item.signerStatus)
            )
        );
        if (!signer) {
          return { count: 0 };
        }
        Object.assign(signer, data);
        return { count: 1 };
      })
    },
    contractESignTask: {
      findUnique: vi.fn(async () => ({
        ...task,
        signers: [customerSigner, platformSigner]
      })),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(task, data);
        return task;
      })
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => handover),
      updateMany: vi.fn(async ({ data, where }: any) => {
        if (
          where.id !== handover.id ||
          where.handoverContractId !==
            handover.handoverContractId ||
          where.handoverESignTaskId !==
            handover.handoverESignTaskId
        ) {
          return { count: 0 };
        }
        Object.assign(handover, data);
        return { count: 1 };
      })
    },
    vehicleHandoverWorkflowJob: {
      updateMany: vi.fn(async ({ data, where }: any) => {
        let count = 0;
        for (const job of jobs.values()) {
          if (
            job.workOrderId === where.workOrderId &&
            job.eSignTaskId === where.eSignTaskId &&
            job.jobStatus === where.jobStatus &&
            where.jobType.in.includes(job.jobType)
          ) {
            Object.assign(job, data);
            count += 1;
          }
        }
        return { count };
      }),
      upsert: vi.fn(async ({ create, where }: any) => {
        if (transactionDepth === 0) {
          throw new Error(
            "workflow job was not written transactionally"
          );
        }
        const key = where.idempotencyKey;
        const existing = jobs.get(key);
        if (existing) {
          return existing;
        }
        const created = {
          ...create,
          idempotencyKey: key,
          jobStatus: VehicleHandoverWorkflowJobStatus.PENDING
        };
        jobs.set(key, created);
        return created;
      })
    },
    vehicleHandoverWorkOrder: {
      findMany: vi.fn(async () => [{
        handoverId: handover.id,
        id: "work-order-1"
      }])
    },
    vehicleDelivery: {
      update: downstream.vehicleDeliveryUpdate
    },
    leaseContract: {
      create: downstream.leaseCreate
    },
    receivableBill: {
      create: downstream.billingWrite
    },
    paymentRecord: {
      create: downstream.paymentWrite
    },
    accountingEntry: {
      create: downstream.accountingWrite
    },
    depreciationEntry: {
      create: downstream.depreciationWrite
    }
  };
  const provider = {
    autoSealTask: vi.fn(),
    createSignTask: vi.fn(),
    getSignerUrl: vi.fn(),
    querySignerStatus: vi.fn(),
    verifyCallback: vi.fn()
  };
  const service = new ESignService(
    { write: vi.fn() } as never,
    new ConfigService(),
    provider as never,
    prisma as never
  );

  return {
    customerSigner,
    downstream,
    handover,
    jobs,
    platformSigner,
    provider,
    service,
    task,
    transactionOptions
  };
}

function customerPollingHarness() {
  const repository = {
    enqueue: vi.fn(),
    renewLease: vi.fn(async () => true),
    reschedule: vi.fn()
  };
  const stage2ESignService = {
    reconcileCustomerSignature: vi.fn(async () => ({
      resultCode: "1000",
      status: "SIGNING"
    }))
  };
  const service = new Stage2HandoverWorkflowService(
    {} as never,
    new ConfigService({
      STAGE2_HANDOVER_WORKER_LEASE_MS: "120000",
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    }),
    repository as never,
    {} as never
  );
  Object.assign(service as object, {
    stage2ESignService
  });
  return {
    repository,
    service,
    stage2ESignService
  };
}

function platformWorkflowHarness() {
  const prisma = {};
  const repository = {
    enqueue: vi.fn(),
    renewLease: vi.fn(async () => true)
  };
  const stage2ESignService = {
    reconcilePlatformSeal: vi.fn(async () => ({
      resultCode: "1000",
      status: "SIGNING"
    })),
    retryPlatformSeal: vi.fn(async () => ({
      platformSigner: {
        status: ESignSignerStatus.SIGNING
      },
      status: ESignTaskStatus.SIGNING
    }))
  };
  const service = new Stage2HandoverWorkflowService(
    prisma as never,
    new ConfigService({
      STAGE2_HANDOVER_WORKER_LEASE_MS: "120000",
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    }),
    repository as never,
    {} as never
  );
  Object.assign(service as object, {
    stage2ESignService
  });
  return {
    prisma,
    repository,
    service,
    stage2ESignService
  };
}

function customerWorkflowJob(
  overrides: Record<string, unknown> = {}
) {
  return {
    attemptCount: 0,
    availableAt: new Date("2026-07-28T02:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-07-28T01:58:00.000Z"),
    eSignTaskId: "stage2-task-1",
    handoverId: "handover-1",
    id: "customer-reconcile-job-1",
    idempotencyKey:
      `customer-reconcile:stage2-task-1:${TRANSACTION_ID}`,
    jobStatus: VehicleHandoverWorkflowJobStatus.PROCESSING,
    jobType:
      VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-07-28T02:02:00.000Z"),
    leaseToken: "00000000-0000-4000-8000-000000000001",
    maxAttempts: 5,
    payload: {
      customerTransactionId: TRANSACTION_ID
    },
    resultSnapshot: null,
    startedAt: new Date("2026-07-28T02:00:00.000Z"),
    updatedAt: new Date("2026-07-28T02:00:00.000Z"),
    workOrderId: "work-order-1",
    ...overrides
  } as any;
}

function platformWorkflowJob(
  jobType:
    | typeof VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM
    | typeof VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL
) {
  return {
    ...customerWorkflowJob(),
    eSignTaskId: "stage2-task-1",
    handoverId: "handover-1",
    id: `platform-job-${jobType}`,
    idempotencyKey:
      `platform:${jobType}:stage2-task-1:${TASK_NO}H2`,
    jobType,
    payload: {
      platformTransactionId: `${TASK_NO}H2`
    },
    resultSnapshot: null,
    workOrderId: "work-order-1"
  } as never;
}
