import {
  BillStatus,
  ContractStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  buildEarlyTerminationEstimate,
  earlyTerminationCompletionOutcome,
  SubscriptionEarlyTerminationChangeService
} from "../src/subscription-change/subscription-early-termination-change.service";
import { subscriptionChangeAllowedActions } from "../src/subscription-change/subscription-change.domain";

describe("SubscriptionEarlyTerminationChangeService", () => {
  it("rejects early-termination writes when its exact rollout flag is disabled", async () => {
    const harness = serviceHarness({ enabled: false });

    await expect(
      harness.service.createEstimate(
        harness.change.id,
        { idempotencyKey: "early-disabled", version: 2 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({
      code: "SUBSCRIPTION_EARLY_TERMINATION_DISABLED",
      status: 503
    });
    expect(harness.tx.subscriptionChangeOrder.update).not.toHaveBeenCalled();
  });

  it("builds a revisioned contract-based estimate without cancelling future bills", () => {
    const estimate = buildEarlyTerminationEstimate({
      bills: [
        {
          amount: 80_000n,
          billStatus: BillStatus.PENDING,
          dueDate: new Date("2026-09-01T00:00:00.000Z"),
          id: "bill-earned",
          remainingAmount: 80_000n
        },
        {
          amount: 100_000n,
          billStatus: BillStatus.PENDING,
          dueDate: new Date("2026-10-01T00:00:00.000Z"),
          id: "bill-future",
          remainingAmount: 100_000n
        }
      ],
      contractId: "contract-base",
      contractSnapshot: { earlyTerminationFeeAmount: "30000" },
      depositAmount: 50_000n,
      effectiveDate: new Date("2026-09-30T00:00:00.000Z"),
      previousRevision: 0,
      sourceSegmentId: "segment-base"
    });

    expect(estimate).toMatchObject({
      accruedReceivableAmount: "80000",
      contractId: "contract-base",
      depositAppliedAmount: "50000",
      earlyTerminationChargeAmount: "30000",
      estimatedAmountDue: "60000",
      estimatedRefundAmount: "0",
      futureBillBoundary: {
        amount: "100000",
        billIds: ["bill-future"],
        cancelOnlyAtExecution: true
      },
      pendingInspection: true,
      revision: 1,
      sourceSegmentId: "segment-base"
    });
  });

  it.each([
    ["PREPARING_RETURN", "WAITING"],
    ["PENDING_SETTLEMENT", "WAITING"],
    ["TERMINATED", "COMPLETED"],
    ["MANUAL_TAKEOVER", "MANUAL_TAKEOVER"],
    ["CANCELLED", "CANCELLED"]
  ] as const)("maps Closure %s to change outcome %s", (closureStatus, expected) => {
    expect(earlyTerminationCompletionOutcome(closureStatus)).toBe(expected);
  });

  it("keeps governed cancellation visible without advertising a missing execute route", () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.SCHEDULED });

    expect(
      subscriptionChangeAllowedActions(
        {
          changeType: SubscriptionChangeType.EARLY_TERMINATION,
          status: SubscriptionChangeStatus.SCHEDULED
        },
        harness.actor
      )
    ).toEqual(["CANCEL"]);
  });

  it("persists an immutable estimate revision and publishes that revision", async () => {
    const harness = serviceHarness({
      now: new Date("2026-09-29T15:00:00.000Z"),
      status: SubscriptionChangeStatus.DRAFT
    });

    const estimated = await harness.service.createEstimate(
      harness.change.id,
      { idempotencyKey: "termination-estimate-1", version: 2 },
      harness.actor,
      harness.context
    );

    expect(estimated.estimate).toMatchObject({ revision: 2 });
    expect(harness.change).toMatchObject({
      earlyTerminationDetail: { estimatedSettlementRevision: 2 },
      status: SubscriptionChangeStatus.QUOTED,
      version: 3
    });
    await harness.service.publishCustomerConfirmation(
      harness.change.id,
      { idempotencyKey: "termination-publish-1", version: 3 },
      harness.actor,
      harness.context
    );
    expect(harness.change.customerConfirmationPublishedAt).toEqual(
      new Date("2026-09-29T15:00:00.000Z")
    );
    expect(harness.change.version).toBe(4);
  });

  it("rejects publishing an already published estimate with a new current-version command", async () => {
    const harness = serviceHarness({
      now: new Date("2026-09-29T15:00:00.000Z"),
      status: SubscriptionChangeStatus.QUOTED
    });
    const publishedAt = new Date("2026-09-29T14:00:00.000Z");
    harness.change.customerConfirmationPublishedAt = publishedAt;

    await expect(
      harness.service.publishCustomerConfirmation(
        harness.change.id,
        { idempotencyKey: "termination-republish", version: 2 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "EARLY_TERMINATION_ALREADY_PUBLISHED" });
    expect(harness.change.customerConfirmationPublishedAt).toEqual(publishedAt);
    expect(harness.change.version).toBe(2);
  });

  it.each([
    ["ACCEPT", SubscriptionChangeStatus.CUSTOMER_CONFIRMED],
    ["REJECT", SubscriptionChangeStatus.CANCELLED],
    ["DISPUTE", SubscriptionChangeStatus.MANUAL_TAKEOVER]
  ] as const)("records customer %s without executing Closure", async (decision, expectedStatus) => {
    const harness = serviceHarness({
      now: new Date("2026-09-29T15:00:00.000Z"),
      status: SubscriptionChangeStatus.QUOTED
    });
    harness.change.customerConfirmationPublishedAt = new Date("2026-09-29T00:00:00.000Z");

    await harness.service.decide(
      harness.change.id,
      {
        decision,
        idempotencyKey: `termination-${decision.toLowerCase()}-1`,
        quoteId: harness.change.id,
        reason: decision === "ACCEPT" ? undefined : "Customer response",
        revision: 1,
        version: 2
      },
      { customerId: "customer-1" },
      harness.context
    );

    expect(harness.change.status).toBe(expectedStatus);
    expect(harness.closure.executeEarlyTermination).not.toHaveBeenCalled();
    expect(harness.tx.receivableBill.updateMany).not.toHaveBeenCalled();
  });

  it("replays an exact customer decision and rejects idempotency payload drift", async () => {
    const harness = serviceHarness({
      now: new Date("2026-09-29T15:00:00.000Z"),
      status: SubscriptionChangeStatus.QUOTED
    });
    harness.change.customerConfirmationPublishedAt = new Date("2026-09-29T00:00:00.000Z");
    const input = {
      decision: "REJECT" as const,
      idempotencyKey: "termination-reject-replay-1",
      quoteId: harness.change.id,
      reason: "Customer no longer needs the vehicle",
      revision: 1,
      version: 2
    };

    const first = await harness.service.decide(
      harness.change.id,
      input,
      { customerId: "customer-1" },
      harness.context
    );
    const replay = await harness.service.decide(
      harness.change.id,
      input,
      { customerId: "customer-1" },
      harness.context
    );

    expect(replay).toEqual(first);
    expect(harness.change.version).toBe(3);
    await expect(
      harness.service.decide(
        harness.change.id,
        { ...input, reason: "A different reason" },
        { customerId: "customer-1" },
        harness.context
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
    await expect(
      harness.service.decide(
        harness.change.id,
        { ...input, quoteId: "another-change" },
        { customerId: "customer-1" },
        harness.context
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
  });

  it("hides and rejects customer decisions at the completion deadline", async () => {
    const harness = serviceHarness({
      now: new Date("2026-09-29T16:00:00.000Z"),
      status: SubscriptionChangeStatus.QUOTED
    });
    harness.change.customerConfirmationPublishedAt = new Date("2026-09-29T15:00:00.000Z");

    await expect(
      harness.service.getPortalChange(harness.change.id, { customerId: "customer-1" })
    ).resolves.toMatchObject({ allowedActions: [] });
    await expect(
      harness.service.decide(
        harness.change.id,
        {
          decision: "ACCEPT",
          idempotencyKey: "termination-expired-decision",
          quoteId: harness.change.id,
          revision: 1,
          version: 2
        },
        { customerId: "customer-1" },
        harness.context
      )
    ).rejects.toMatchObject({ code: "EARLY_TERMINATION_DECISION_DEADLINE_PASSED" });
    expect(harness.change.status).toBe(SubscriptionChangeStatus.QUOTED);
    expect(harness.change.version).toBe(2);
  });

  it("generates a PDF agreement and waits for provider e-sign before scheduling", async () => {
    const harness = serviceHarness({ now: new Date("2026-09-29T15:00:00.000Z") });

    const agreement = await harness.service.generate(
      harness.change.id,
      { idempotencyKey: "termination-agreement-1", version: 2 },
      harness.actor,
      harness.context
    );

    expect(harness.closure.initiateEarlyTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveAt: new Date("2026-09-29T16:00:00.000Z"),
        idempotencyKey: "early-termination-change:change-1:closure",
        orderId: harness.change.orderId,
        reason: "Customer relocation"
      }),
      expect.any(Function)
    );
    expect(agreement).toMatchObject({
      fileId: "generated-pdf-file-1",
      status: ContractStatus.GENERATED
    });
    expect(harness.change).toMatchObject({
      contractId: "agreement-contract-1",
      earlyTerminationDetail: {
        agreementContractId: "agreement-contract-1",
        closureCaseId: "closure-1"
      },
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
      version: 3
    });
    await expect(
      harness.service.generate(
        harness.change.id,
        { idempotencyKey: "termination-agreement-1", version: 2 },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ id: "agreement-contract-1", fileId: "generated-pdf-file-1" });
    expect(harness.closure.initiateEarlyTermination).toHaveBeenCalledOnce();
    expect(harness.closure.archiveEarlyTerminationAgreement).not.toHaveBeenCalled();
    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
  });

  it("recovers the same PDF agreement reservation after object storage succeeds but finalize fails", async () => {
    const harness = serviceHarness({ now: new Date("2026-09-29T15:00:00.000Z") });
    harness.artifactWriter.writeGeneratedContractPdfArtifact.mockImplementationOnce(async () => {
      harness.failNextTransaction(new Error("transient finalize failure"));
      return generatedEarlyTerminationArtifact();
    });

    await expect(
      harness.service.generate(
        harness.change.id,
        { idempotencyKey: "termination-agreement-recover", version: 2 },
        harness.actor,
        harness.context
      )
    ).rejects.toThrow("transient finalize failure");
    expect(harness.change).toMatchObject({
      contractId: "agreement-contract-1",
      status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
      version: 2
    });

    await expect(
      harness.service.generate(
        harness.change.id,
        { idempotencyKey: "termination-agreement-recover", version: 2 },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({
      fileId: "generated-pdf-file-1",
      id: "agreement-contract-1"
    });
    expect(harness.change).toMatchObject({
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
      version: 3
    });
    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledTimes(2);
  });

  it("rejects an effective business date whose Shanghai boundary has already passed", async () => {
    const harness = serviceHarness();

    await expect(
      harness.service.generate(
        harness.change.id,
        { idempotencyKey: "termination-agreement-too-late", version: 2 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "EARLY_TERMINATION_EFFECTIVE_DATE_TOO_SOON" });
    expect(harness.closure.initiateEarlyTermination).not.toHaveBeenCalled();
  });

  it("starts the provider e-sign task for the generated PDF agreement", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT });
    harness.change.earlyTerminationDetail.closureCaseId = "closure-1";
    harness.change.earlyTerminationDetail.agreementContractId = "agreement-contract-1";
    harness.change.earlyTerminationDetail.agreementContract = {
      contractSnapshot: {},
      fileId: "generated-pdf-file-1",
      id: "agreement-contract-1",
      status: ContractStatus.GENERATED
    };
    harness.change.contractId = "agreement-contract-1";
    const start = vi.fn(async () => ({ id: "esign-task-1", taskStatus: "WAITING_CUSTOMER" }));
    const replay = vi.fn(async () => ({ id: "esign-task-1", taskStatus: "WAITING_CUSTOMER" }));

    await expect(
      harness.service.startOrRetryESign(
        harness.change.id,
        { idempotencyKey: "termination-esign-1", version: 2 },
        harness.actor,
        start,
        replay
      )
    ).resolves.toMatchObject({ id: "esign-task-1", taskStatus: "WAITING_CUSTOMER" });
    expect(start).toHaveBeenCalledWith("agreement-contract-1");
  });

  it("does not stop billing or execute return before the signed agreement effective time", async () => {
    const harness = serviceHarness({
      now: new Date("2026-09-29T15:59:59.000Z"),
      status: SubscriptionChangeStatus.SCHEDULED
    });
    harness.change.earlyTerminationDetail.closureCaseId = "closure-1";
    harness.change.earlyTerminationDetail.agreementContractId = "agreement-contract-1";
    harness.change.contractId = "agreement-contract-1";

    await expect(
      harness.service.execute(
        harness.change.id,
        { idempotencyKey: "termination-execute-early", version: 2 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "EARLY_TERMINATION_EFFECTIVE_TIME_NOT_REACHED" });
    expect(harness.closure.executeEarlyTermination).not.toHaveBeenCalled();
    expect(harness.tx.receivableBill.updateMany).not.toHaveBeenCalled();
    expect(harness.change.status).toBe(SubscriptionChangeStatus.SCHEDULED);
  });

  it("delegates the effective boundary to Closure and atomically enters EXECUTING", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.SCHEDULED });
    harness.change.earlyTerminationDetail.closureCaseId = "closure-1";
    harness.change.earlyTerminationDetail.agreementContractId = "agreement-contract-1";
    harness.change.contractId = "agreement-contract-1";

    await expect(
      harness.service.execute(
        harness.change.id,
        { idempotencyKey: "termination-execute-1", version: 2 },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ closureCaseId: "closure-1", wrote: true });
    expect(harness.closure.executeEarlyTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "early-termination-change:change-1:execute"
      }),
      expect.any(Function)
    );
    expect(harness.change).toMatchObject({
      status: SubscriptionChangeStatus.EXECUTING,
      version: 3
    });
    await expect(
      harness.service.execute(
        harness.change.id,
        { idempotencyKey: "termination-execute-1", version: 2 },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ closureCaseId: "closure-1" });
    expect(harness.tx.receivableBill.updateMany).not.toHaveBeenCalled();
  });

  it("does not archive or execute when the customer-signed agreement facts drift before first execution", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.SCHEDULED });
    harness.change.earlyTerminationDetail.closureCaseId = "closure-1";
    harness.change.earlyTerminationDetail.agreementContractId = "agreement-contract-1";
    harness.change.contractId = "agreement-contract-1";
    Object.assign(harness.change.earlyTerminationDetail.reasonSnapshot, {
      currentEstimate: {
        estimatedAmountDue: "999999",
        revision: 1
      },
      reason: "Customer relocation"
    });

    await expect(
      harness.service.execute(
        harness.change.id,
        { idempotencyKey: "termination-execute-signed-drift", version: 2 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "EARLY_TERMINATION_SIGNED_FACT_DRIFT" });
    expect(harness.closure.archiveEarlyTerminationAgreement).not.toHaveBeenCalled();
    expect(harness.closure.executeEarlyTermination).not.toHaveBeenCalled();
    expect(harness.change.status).toBe(SubscriptionChangeStatus.SCHEDULED);
  });

  it("automatically advances a due scheduled change with a stable internal command", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.SCHEDULED });
    harness.change.earlyTerminationDetail.closureCaseId = "closure-1";
    harness.change.earlyTerminationDetail.agreementContractId = "agreement-contract-1";
    harness.change.contractId = "agreement-contract-1";

    await expect(harness.service.progress(harness.change.id)).resolves.toMatchObject({
      outcome: "EXECUTING"
    });

    expect(harness.closure.executeEarlyTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "early-termination-change:change-1:execute"
      }),
      expect.any(Function)
    );
  });

  it("leaves a future scheduled change waiting without touching Closure", async () => {
    const harness = serviceHarness({
      now: new Date("2026-09-29T15:59:59.000Z"),
      status: SubscriptionChangeStatus.SCHEDULED
    });

    await expect(harness.service.progress(harness.change.id)).resolves.toEqual({
      changeOrderId: harness.change.id,
      outcome: "WAITING"
    });
    expect(harness.closure.executeEarlyTermination).not.toHaveBeenCalled();
  });

  it("moves a failed scheduled execution to governed manual takeover", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.SCHEDULED });

    await expect(
      harness.service.markManualTakeover(harness.change.id, {
        code: "SUBSCRIPTION_CLOSURE_AUTHORITY_MISMATCH",
        message: "Closure authority changed."
      })
    ).resolves.toEqual({ updated: true });
    expect(harness.change).toMatchObject({
      failureCode: "SUBSCRIPTION_CLOSURE_AUTHORITY_MISMATCH",
      status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
      version: 3
    });
  });

  it("cancels the exact pre-execution Closure attempt and releases the active-change slot", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED });
    harness.change.earlyTerminationDetail.closureCaseId = "closure-1";

    await harness.service.cancel(
      harness.change.id,
      { idempotencyKey: "termination-cancel-1", reason: "Customer withdrew", version: 2 },
      harness.actor,
      harness.context
    );

    expect(harness.closure.cancelEarlyTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        closureCaseId: "closure-1",
        idempotencyKey: "early-termination-change:change-1:cancel"
      }),
      expect.any(Function)
    );
    expect(harness.change).toMatchObject({
      cancelReason: "Customer withdrew",
      status: SubscriptionChangeStatus.CANCELLED,
      version: 3
    });
    await expect(
      harness.service.cancel(
        harness.change.id,
        { idempotencyKey: "termination-cancel-1", reason: "Customer withdrew", version: 2 },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ status: SubscriptionChangeStatus.CANCELLED });
    expect(harness.closure.cancelEarlyTermination).toHaveBeenCalledOnce();
    expect(harness.tx.receivableBill.updateMany).not.toHaveBeenCalled();
  });

  it("cancels a generated agreement and its active e-sign task before archival", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT });
    harness.change.contractId = "agreement-contract-1";
    harness.change.earlyTerminationDetail.agreementContractId = "agreement-contract-1";
    harness.change.earlyTerminationDetail.agreementContract.status = ContractStatus.GENERATED;

    await harness.service.cancel(
      harness.change.id,
      { idempotencyKey: "termination-cancel-generated", reason: "Customer withdrew", version: 2 },
      harness.actor,
      harness.context
    );

    expect(harness.tx.contractESignTask.updateMany).toHaveBeenCalledWith({
      data: {
        cancelledAt: new Date("2026-09-30T00:00:01.000Z"),
        taskStatus: "CANCELLED",
        updatedBy: "operator-1"
      },
      where: {
        contractId: "agreement-contract-1",
        taskStatus: { in: ["CREATED", "WAITING_CUSTOMER", "SIGNING", "FAILED"] }
      }
    });
    expect(harness.tx.contract.updateMany).toHaveBeenCalledWith({
      data: { status: ContractStatus.CANCELLED, updatedBy: "operator-1" },
      where: { id: "agreement-contract-1", status: ContractStatus.GENERATED }
    });
  });

  it("preserves an archived agreement as historical evidence when cancelling the remaining workflow", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.MANUAL_TAKEOVER });
    harness.change.contractId = "agreement-contract-1";
    harness.change.earlyTerminationDetail.agreementContractId = "agreement-contract-1";
    harness.change.earlyTerminationDetail.closureCaseId = "closure-1";
    harness.change.earlyTerminationDetail.agreementContract.status = ContractStatus.ARCHIVED;

    await harness.service.cancel(
      harness.change.id,
      {
        idempotencyKey: "termination-cancel-after-archive",
        reason: "Close stale request without rewriting signed evidence",
        version: 2
      },
      harness.actor,
      harness.context
    );

    expect(harness.tx.contract.updateMany).not.toHaveBeenCalled();
    expect(harness.change.earlyTerminationDetail.agreementContract.status).toBe(
      ContractStatus.ARCHIVED
    );
    expect(harness.change.status).toBe(SubscriptionChangeStatus.CANCELLED);
  });

  it("completes only after the linked Closure reaches TERMINATED", async () => {
    const harness = serviceHarness({ status: SubscriptionChangeStatus.EXECUTING });
    harness.change.earlyTerminationDetail.closureCaseId = "closure-1";
    harness.tx.subscriptionClosureCase.findUnique.mockResolvedValue({
      id: "closure-1",
      status: "TERMINATED"
    });

    await expect(harness.service.reconcile(harness.change.id)).resolves.toMatchObject({
      outcome: "COMPLETED"
    });
    expect(harness.change.status).toBe(SubscriptionChangeStatus.COMPLETED);
  });
});

function serviceHarness(
  options: {
    enabled?: boolean;
    now?: Date;
    status?: SubscriptionChangeStatus;
  } = {}
) {
  const now = options.now ?? new Date("2026-09-30T00:00:01.000Z");
  const actor = {
    id: "operator-1",
    menus: [],
    name: "Operator",
    permissions: [
      PermissionCode.SUBSCRIPTION_CHANGE_CANCEL,
      PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY,
      PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE,
      PermissionCode.SUBSCRIPTION_CHANGE_QUOTE,
      PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT,
      PermissionCode.CONTRACT_GENERATE
    ],
    roles: ["OP"],
    username: "operator"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const change = {
    changeNo: "SCO-EARLY-1",
    changeType: SubscriptionChangeType.EARLY_TERMINATION,
    completionDeadlineAt: new Date("2026-09-29T16:00:00.000Z"),
    contractId: null as string | null,
    customerConfirmationPublishedAt: null as Date | null,
    earlyTerminationDetail: {
      agreementContract: {
        contractSnapshot: {
          agreementFacts: {
            closureCaseId: "closure-1",
            effectiveDate: "2026-09-30T00:00:00.000Z",
            estimate: null,
            estimateRevision: 1,
            reason: "Customer relocation"
          }
        },
        fileId: "generated-pdf-file-1",
        id: "agreement-contract-1",
        status: ContractStatus.ARCHIVED
      } as {
        contractSnapshot: Record<string, unknown>;
        fileId: string | null;
        id: string;
        status: ContractStatus;
      },
      agreementContractId: null as string | null,
      changeOrderId: "change-1",
      closureCaseId: null as string | null,
      effectiveDate: new Date("2026-09-30T00:00:00.000Z"),
      estimatedSettlementRevision: 1,
      id: "detail-1",
      reasonSnapshot: {
        estimates: [{ revision: 1 }],
        reason: "Customer relocation"
      }
    },
    id: "change-1",
    order: {
      contract: {
        contractSnapshot: { earlyTerminationFeeAmount: "30000" },
        contractNo: "CON-BASE-1",
        contractVersionId: "contract-version-1",
        id: "contract-base",
        status: ContractStatus.SIGNED
      },
      customerId: "customer-1",
      depositAmount: 50_000n,
      finalDepositAmount: null,
      id: "order-1",
      orderNo: "ORD-1"
    },
    orderId: "order-1",
    sourceSegment: { id: "segment-base" },
    status: options.status ?? SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
    updatedBy: "operator-1",
    version: 2
  };
  const commands: Array<Record<string, unknown>> = [];
  let nextTransactionError: Error | null = null;
  let agreementContract: Record<string, unknown> & {
    contractSnapshot: Record<string, unknown>;
    fileId: string | null;
    id: string;
    status: ContractStatus;
  } = change.earlyTerminationDetail.agreementContract;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    contract: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        agreementContract = {
          ...data,
          contractSnapshot: data.contractSnapshot ?? {},
          fileId: null,
          id: "agreement-contract-1",
          status: ContractStatus.GENERATED
        } as typeof agreementContract;
        change.earlyTerminationDetail.agreementContract = agreementContract;
        return agreementContract;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        agreementContract.id === where.id ? agreementContract : null
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(agreementContract, data);
        change.earlyTerminationDetail.agreementContract = agreementContract;
        return agreementContract;
      }),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    contractESignTask: {
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    contractVersion: {
      findFirst: vi.fn(async () => ({
        contentTemplate: "Early termination supplement legal terms",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        id: "supplement-template-1",
        templateName: "Subscription supplement",
        templateType: "SUBSCRIPTION_EXTENSION",
        versionNo: "1"
      })),
      findUnique: vi.fn(async () => ({
        contentTemplate: "Early termination supplement legal terms",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        id: "supplement-template-1",
        templateName: "Subscription supplement",
        templateType: "SUBSCRIPTION_EXTENSION",
        versionNo: "1"
      }))
    },
    receivableBill: {
      findMany: vi.fn(async () => [
        {
          amount: 80_000n,
          billStatus: BillStatus.PENDING,
          dueDate: new Date("2026-09-01T00:00:00.000Z"),
          id: "bill-earned",
          remainingAmount: 80_000n
        }
      ]),
      updateMany: vi.fn(async () => ({ count: 0 }))
    },
    subscriptionContractSegment: {
      findFirst: vi.fn(async () => ({ id: "segment-base" }))
    },
    subscriptionChangeOrder: {
      findUnique: vi.fn(async () => change),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyChangeUpdate(change, data);
        return change;
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyChangeUpdate(change, data);
        return { count: 1 };
      })
    },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const command = {
          ...data,
          completedAt: null,
          id: `command-${commands.length + 1}`,
          resourceId: null,
          resourceType: null
        };
        commands.push(command);
        return command;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const identity = where.actorId_operation_idempotencyKey as
          | { actorId: string; idempotencyKey: string; operation: string }
          | undefined;
        return identity
          ? (commands.find(
              (command) =>
                command.actorId === identity.actorId &&
                command.idempotencyKey === identity.idempotencyKey &&
                command.operation === identity.operation
            ) ?? null)
          : null;
      }),
      update: vi.fn(
        async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
          const command = commands.find((item) => item.id === where.id);
          if (!command) throw new Error("command missing");
          Object.assign(command, data);
          return command;
        }
      ),
      deleteMany: vi.fn(async () => ({ count: 1 }))
    },
    subscriptionClosureCase: {
      findUnique: vi.fn(async () => ({ id: "closure-1", status: "PREPARING_RETURN" }))
    },
    subscriptionEarlyTerminationChangeDetail: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(change.earlyTerminationDetail, data);
        return change.earlyTerminationDetail;
      }),
      updateMany: vi.fn(async () => ({ count: 1 }))
    }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
      if (nextTransactionError) {
        const error = nextTransactionError;
        nextTransactionError = null;
        throw error;
      }
      return operation(tx);
    }),
    contract: {
      findUnique: tx.contract.findUnique,
      findUniqueOrThrow: vi.fn(async () => agreementContract)
    },
    contractESignTask: {
      findFirst: vi.fn(async () => ({ id: "provider-esign-task-1" }))
    },
    subscriptionClosureCurrentDocument: {
      findUnique: vi.fn(async () => ({
        documentRevision: {
          contractESignTask: { id: "esign-task-1", taskStatus: "COMPLETED" }
        }
      }))
    },
    subscriptionChangeCommand: tx.subscriptionChangeCommand,
    subscriptionChangeOrder: tx.subscriptionChangeOrder
  };
  const closure = {
    archiveEarlyTerminationAgreement: vi.fn(
      async (_input: unknown, adapter?: (client: typeof tx, result: unknown) => Promise<void>) => {
        const result = {
          archivedRevisionId: "agreement-archived-1",
          generatedRevisionId: "agreement-generated-1",
          signedFileHash: "a".repeat(64),
          signedFileId: "signed-file-1",
          signedRevisionId: "agreement-signed-1",
          wrote: true
        };
        await adapter?.(tx, result);
        return result;
      }
    ),
    cancelEarlyTermination: vi.fn(
      async (_input: unknown, adapter: (client: typeof tx, result: unknown) => Promise<void>) => {
        const result = { closureCaseId: "closure-1", wrote: true };
        await adapter(tx, result);
        return result;
      }
    ),
    executeEarlyTermination: vi.fn(
      async (_input: unknown, adapter: (client: typeof tx, result: unknown) => Promise<void>) => {
        const result = {
          closureCaseId: "closure-1",
          returnAssetWorkOrderId: "asset-work-order-1",
          returnHandoverWorkOrderId: "handover-work-order-1",
          returnManifestRevisionId: "return-manifest-1",
          vehicleReturnId: "vehicle-return-1",
          wrote: true
        };
        await adapter(tx, result);
        return result;
      }
    ),
    initiateEarlyTermination: vi.fn(
      async (_input: unknown, adapter: (client: typeof tx, result: unknown) => Promise<void>) => {
        const result = {
          authoritySnapshotHash: "b".repeat(64),
          closureCaseId: "closure-1",
          wrote: true
        };
        await adapter(tx, result);
        return result;
      }
    )
  };
  const artifactWriter = {
    writeGeneratedContractPdfArtifact: vi.fn(async () => generatedEarlyTerminationArtifact())
  };
  const service = new SubscriptionEarlyTerminationChangeService(
    prisma as never,
    closure as never,
    { write: vi.fn(async () => undefined) } as never,
    {
      earlyTerminationEnabled: options.enabled ?? true,
      enabled: true,
      now: () => now,
      quoteValidityHours: 72
    } as never,
    artifactWriter as never,
    { get: vi.fn(() => undefined) } as never
  );
  return {
    actor,
    artifactWriter,
    change,
    closure,
    context,
    failNextTransaction: (error: Error) => {
      nextTransactionError = error;
    },
    service,
    tx
  };
}

function generatedEarlyTerminationArtifact() {
  return {
    bucket: "contracts",
    diagnostics: { hasLegalBody: true },
    fileId: "generated-pdf-file-1",
    mimeType: "application/pdf",
    objectKey: "contracts/generated/early-termination.pdf",
    originalName: "early-termination.pdf",
    sizeBytes: "2048"
  };
}

function applyChangeUpdate(change: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (key === "version" && value && typeof value === "object" && "increment" in value) {
      change.version = Number(change.version) + Number(value.increment);
    } else {
      change[key] = value;
    }
  }
}
