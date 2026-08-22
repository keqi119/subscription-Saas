import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";
import { canonicalSubscriptionClosureJson } from "../src/subscription-closure/subscription-closure.domain";

const IDS = {
  actor: "20000000-0000-4000-8000-000000000001",
  bill: "20000000-0000-4000-8000-000000000002",
  case: "20000000-0000-4000-8000-000000000003",
  collection: "20000000-0000-4000-8000-000000000004",
  customer: "20000000-0000-4000-8000-000000000005",
  job: "20000000-0000-4000-8000-000000000006",
  order: "20000000-0000-4000-8000-000000000007",
  vehicle: "20000000-0000-4000-8000-000000000008",
  vehicleReturn: "20000000-0000-4000-8000-000000000009"
} as const;

describe("SubscriptionClosureService recovery assessment scheduling", () => {
  it("freezes the earliest unsettled overdue bill and D+7 Shanghai boundary on exact replay", async () => {
    const harness = recoveryScheduleHarness();

    const first = await harness.service.scheduleRecoveryAssessmentInTransaction(
      harness.tx as never,
      {
        closureCaseId: IDS.case,
        orderId: IDS.order,
        scheduledAt: new Date("2026-09-03T03:00:00.000Z")
      }
    );
    harness.setBoundary({
      dueDate: new Date("2026-09-02T00:00:00.000Z"),
      id: "20000000-0000-4000-8000-000000000010"
    });
    const replay = await harness.service.scheduleRecoveryAssessmentInTransaction(
      harness.tx as never,
      {
        closureCaseId: IDS.case,
        orderId: IDS.order,
        scheduledAt: new Date("2026-09-03T03:00:00.000Z")
      }
    );

    expect(first).toMatchObject({
      availableAt: new Date("2026-09-07T16:00:00.000Z"),
      billId: IDS.bill,
      dueDate: "2026-09-01T00:00:00.000Z",
      scheduled: true
    });
    expect(replay).toEqual(first);
    expect(harness.tx.receivableBill.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        where: expect.objectContaining({ orderId: IDS.order, remainingAmount: { gt: 0n } })
      })
    );
    expect(harness.tx.subscriptionAutomationJob.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ update: {} })
    );
  });

  it("does not schedule when the order has no unsettled overdue bill", async () => {
    const harness = recoveryScheduleHarness({ boundary: null });

    await expect(
      harness.service.scheduleRecoveryAssessmentInTransaction(harness.tx as never, {
        closureCaseId: IDS.case,
        orderId: IDS.order,
        scheduledAt: new Date("2026-09-03T03:00:00.000Z")
      })
    ).resolves.toEqual({ scheduled: false });
    expect(harness.tx.subscriptionAutomationJob.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when an existing stable job has drifted immutable authority", async () => {
    const harness = recoveryScheduleHarness();
    const input = {
      closureCaseId: IDS.case,
      orderId: IDS.order,
      scheduledAt: new Date("2026-09-03T03:00:00.000Z")
    };

    await harness.service.scheduleRecoveryAssessmentInTransaction(harness.tx as never, input);
    harness.mutateStoredJob((job) => ({
      ...job,
      payload: { ...job.payload, actorId: "20000000-0000-4000-8000-000000000099" }
    }));

    await expect(
      harness.service.scheduleRecoveryAssessmentInTransaction(harness.tx as never, input)
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_RECOVERY_JOB_AUTHORITY_INVALID" }
    });
  });
});

describe("SubscriptionClosureService recovery assessment", () => {
  it("escalates only from immutable job authority and stores server-resolved facts", async () => {
    const harness = recoveryHarness();

    await expect(harness.service.assessRecoveryJob(recoveryInput())).resolves.toMatchObject({
      action: "ASSESSED",
      wrote: true
    });

    expect(harness.timeline.slice(0, 3)).toEqual([
      "source:assessment",
      "coordinator:ranked-pass",
      "execute:prepared-escalation"
    ]);
    expect(harness.repository.escalatePreparedRecoveryInTransaction).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        actorId: IDS.actor,
        closureCaseId: IDS.case,
        detailSnapshot: expect.objectContaining({
          collectionCases: [
            expect.objectContaining({
              actions: [
                expect.objectContaining({
                  actionType: "PROMISE_TO_PAY",
                  promisedAmount: 900n,
                  promisedPayAt: new Date("2026-09-09Z")
                })
              ],
              id: IDS.collection
            })
          ],
          extension: null,
          governingBill: {
            billId: IDS.bill,
            dueDate: new Date("2026-09-01T00:00:00.000Z")
          },
          legalRestrictions: [],
          liveDisputes: [],
          overdueBills: [expect.objectContaining({ id: IDS.bill, remainingAmount: 900n })],
          plannedRecoveryAssetWorkOrderId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          vehicle: expect.objectContaining({ id: IDS.vehicle, status: "LEASED" })
        }),
        expectedStatus: "PREPARING_RETURN",
        expectedVersion: 2,
        source: {
          id: IDS.job,
          key: "closure-recovery-assessment:case:D7",
          type: "CLOSURE_RECOVERY_ASSESSMENT_D7"
        }
      }),
      expect.anything(),
      expect.any(Function)
    );
    const call = harness.repository.escalatePreparedRecoveryInTransaction.mock
      .calls[0] as unknown as readonly [
      unknown,
      { detailSnapshot: Readonly<Record<string, unknown>> }
    ];
    const detail = call[1].detailSnapshot;
    expect(detail).not.toHaveProperty("authoritySnapshot");
    expect(detail).not.toHaveProperty("authoritySnapshotHash");
  });

  it("rejects client-supplied authority or hash fields before opening a transaction", async () => {
    const harness = recoveryHarness();

    await expect(
      harness.service.assessRecoveryJob({
        ...recoveryInput(),
        authoritySnapshot: { forged: true }
      } as never)
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_RECOVERY_CLIENT_AUTHORITY_FORBIDDEN" }
    });
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["VOLUNTARY_RETURNED", { returned: true }],
    ["OVERDUE_DEBT_SETTLED", { bills: [] }],
    ["LIVE_DISPUTE", { dispute: true }],
    ["APPROVED_EXTENSION", { extension: true }]
  ] as const)(
    "returns business no-op %s without creating a second case",
    async (reason, options) => {
      const harness = recoveryHarness(options);

      await expect(harness.service.assessRecoveryJob(recoveryInput())).resolves.toEqual({
        action: "NO_OP",
        reason
      });
      expect(harness.repository.escalatePreparedRecoveryInTransaction).not.toHaveBeenCalled();
    }
  );

  it("durably replays the first no-op reason when server facts later change", async () => {
    const harness = recoveryHarness({ dispute: true });

    await expect(harness.service.assessRecoveryJob(recoveryInput())).resolves.toEqual({
      action: "NO_OP",
      reason: "LIVE_DISPUTE"
    });
    expect(harness.repository.appendSourcePreparedEventInTransaction).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        afterStatus: "PREPARING_RETURN",
        detailSnapshot: expect.objectContaining({
          reason: "LIVE_DISPUTE",
          recoveryAction: "ASSESSMENT_NO_OP"
        }),
        eventType: "NOTE_ADDED"
      }),
      expect.anything(),
      expect.any(Function)
    );

    harness.tx.collectionCase.findMany.mockResolvedValue([]);
    harness.tx.receivableBill.findMany.mockResolvedValue([]);
    await expect(harness.service.assessRecoveryJob(recoveryInput())).resolves.toEqual({
      action: "NO_OP",
      reason: "LIVE_DISPUTE"
    });
    expect(harness.repository.appendSourcePreparedEventInTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("SubscriptionClosureService durable recovery business actions", () => {
  it("persists the paused stage and resumes only that server-read stage", async () => {
    const harness = recoveryActionHarness();

    await harness.service.actOnRecovery({
      action: "PAUSE",
      actorId: IDS.actor,
      closureCaseId: IDS.case,
      idempotencyKey: "pause-1",
      occurredAt: new Date("2026-09-08T01:00:00.000Z"),
      reason: "awaiting field confirmation"
    });
    expect(harness.repository.appendEvent).toHaveBeenLastCalledWith(
      harness.tx,
      expect.objectContaining({
        afterStatus: "PAUSED",
        detailSnapshot: expect.objectContaining({
          pausedFromStatus: "RECOVERY_APPROVED",
          recoveryAction: "PAUSE"
        })
      }),
      expect.any(Function)
    );

    harness.caseRow.status = "PAUSED";
    harness.caseRow.version = 5;
    await harness.service.actOnRecovery({
      action: "RESUME",
      actorId: IDS.actor,
      closureCaseId: IDS.case,
      idempotencyKey: "resume-1",
      occurredAt: new Date("2026-09-08T02:00:00.000Z"),
      reason: "field confirmation received"
    });
    expect(harness.repository.appendEvent).toHaveBeenLastCalledWith(
      harness.tx,
      expect.objectContaining({
        afterStatus: "RECOVERY_APPROVED",
        detailSnapshot: expect.objectContaining({
          recoveryAction: "RESUME",
          resumedStage: "RECOVERY_APPROVED"
        }),
        expectedStatus: "PAUSED"
      }),
      expect.any(Function)
    );
  });

  it.each([
    ["REJECT", "REJECTED"],
    ["CANCEL", "CANCELLED"],
    ["MANUAL_TAKEOVER", "MANUAL_TAKEOVER"]
  ] as const)("records %s as an explicit business state", async (action, target) => {
    const harness = recoveryActionHarness({ status: "RECOVERY_ASSESSMENT_PENDING" });
    await harness.service.actOnRecovery({
      action,
      actorId: IDS.actor,
      closureCaseId: IDS.case,
      idempotencyKey: `action-${action}`,
      occurredAt: new Date("2026-09-08T01:00:00.000Z"),
      reason: "administrator decision"
    });
    expect(harness.repository.appendEvent).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({ afterStatus: target }),
      expect.any(Function)
    );
  });

  it("exactly replays a recovery action and rejects command drift", async () => {
    const harness = recoveryActionHarness({ status: "RECOVERY_ASSESSMENT_PENDING" });
    const command = {
      action: "PAUSE" as const,
      actorId: IDS.actor,
      closureCaseId: IDS.case,
      idempotencyKey: "pause-exact",
      occurredAt: new Date("2026-09-08T01:00:00.000Z"),
      reason: "awaiting field confirmation"
    };

    await expect(harness.service.actOnRecovery(command)).resolves.toEqual({
      action: "PAUSE",
      wrote: true
    });
    await expect(harness.service.actOnRecovery(command)).resolves.toEqual({
      action: "PAUSE",
      wrote: false
    });
    await expect(
      harness.service.actOnRecovery({ ...command, reason: "changed reason" })
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" }
    });
    await expect(
      harness.service.actOnRecovery({ ...command, action: "CANCEL" })
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" }
    });
    expect(harness.repository.appendEvent).toHaveBeenCalledTimes(1);
  });
});

describe("SubscriptionClosureService recovery execution approval", () => {
  it("uses one database clock and never treats a future pending bill as recovery debt", async () => {
    const harness = recoveryApprovalHarness({ futureOnly: true });

    await expect(
      harness.service.requestRecoveryExecutionApproval({
        actorId: IDS.actor,
        closureCaseId: IDS.case,
        idempotencyKey: "future-debt-is-not-authority",
        reason: "must remain overdue",
        requestedAt: new Date("2026-09-08T03:00:00.000Z")
      })
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH" }
    });
    expect(harness.tx.receivableBill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dueDate: { lt: expect.any(Date) } })
      })
    );
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(harness.accounting.requestApprovalInTransaction).not.toHaveBeenCalled();
  });

  it("requests the Stage1C-C recovery approval from the server-resolved archived authority", async () => {
    const harness = recoveryApprovalHarness();

    await expect(
      harness.service.requestRecoveryExecutionApproval({
        actorId: IDS.actor,
        closureCaseId: IDS.case,
        idempotencyKey: "request-1",
        reason: "field recovery is required",
        requestedAt: new Date("2026-09-08T03:00:00.000Z")
      })
    ).resolves.toMatchObject({ approvalId: "20000000-0000-4000-8000-000000000020" });
    expect(harness.accounting.requestPreparedApprovalInTransaction).toHaveBeenCalledWith(
      harness.tx,
      expect.anything()
    );
    expect(harness.accounting.requestApprovalInTransaction).not.toHaveBeenCalled();
    expect(harness.resolvedAuthority).toEqual({
      closureCaseId: IDS.case,
      orderId: IDS.order,
      recoveryAssetWorkOrderId: "20000000-0000-4000-8000-000000000021",
      recoveryAuthorityRevisionId: harness.chain.ids.archivedRevisionId,
      recoveryAuthoritySnapshotHash: harness.chain.documentHash,
      recoveryContextSnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      vehicleId: IDS.vehicle
    });
    expect(harness.repository.appendSourcePreparedEventInTransaction).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        afterStatus: "RECOVERY_APPROVAL_PENDING",
        expectedStatus: "RECOVERY_ASSESSMENT_PENDING"
      }),
      expect.anything(),
      expect.any(Function)
    );
  });

  it("records a separate administrator decision as APPROVED or REJECTED business state", async () => {
    const approved = recoveryApprovalHarness({ decision: "APPROVED" });
    await approved.service.decideRecoveryExecutionApproval({
      actorId: "20000000-0000-4000-8000-000000000023",
      approvalId: "20000000-0000-4000-8000-000000000020",
      closureCaseId: IDS.case,
      decision: "APPROVED",
      decisionComment: "approved by administrator",
      decidedAt: new Date("2026-09-08T04:00:00.000Z"),
      expectedApprovalVersion: 0,
      idempotencyKey: "decide-1"
    });
    expect(approved.repository.appendSourcePreparedEventInTransaction).toHaveBeenCalledWith(
      approved.tx,
      expect.objectContaining({ afterStatus: "RECOVERY_APPROVED" }),
      expect.anything(),
      expect.any(Function)
    );

    const rejected = recoveryApprovalHarness({ decision: "REJECTED" });
    await rejected.service.decideRecoveryExecutionApproval({
      actorId: "20000000-0000-4000-8000-000000000023",
      approvalId: "20000000-0000-4000-8000-000000000020",
      closureCaseId: IDS.case,
      decision: "REJECTED",
      decisionComment: "recovery is not proportionate",
      decidedAt: new Date("2026-09-08T04:00:00.000Z"),
      expectedApprovalVersion: 0,
      idempotencyKey: "decide-2"
    });
    expect(rejected.repository.appendSourcePreparedEventInTransaction).toHaveBeenCalledWith(
      rejected.tx,
      expect.objectContaining({ afterStatus: "REJECTED" }),
      expect.anything(),
      expect.any(Function)
    );
  });
});

describe("SubscriptionClosureService approved recovery execution", () => {
  it("uses one source-first ranked pass, inserts the exact planned AWO, then restriction without relock", async () => {
    const harness = recoveryExecutionHarness();

    await expect(
      harness.service.executeApprovedRecovery({
        actorId: IDS.actor,
        approvalId: "20000000-0000-4000-8000-000000000020",
        closureCaseId: IDS.case,
        expectedApprovalVersion: 1,
        idempotencyKey: "execute-1",
        occurredAt: new Date("2026-09-08T05:00:00.000Z")
      })
    ).resolves.toMatchObject({
      action: "RECOVERY_STARTED",
      recoveryAssetWorkOrderId: "20000000-0000-4000-8000-000000000021"
    });
    expect(harness.timeline).toEqual([
      "source:approval",
      "source:stale-event",
      "source:event",
      "source:restriction",
      "source:asset",
      "coordinator:ranked-pass",
      "attest:asset-create",
      "attest:approval",
      "execute:approval",
      "execute:asset-create",
      "attest:restriction",
      "execute:restriction",
      "execute:event"
    ]);
    expect(harness.operations.attestPreparedRestrictionCreateInTransaction).toHaveBeenCalledWith(
      harness.tx,
      harness.session,
      expect.objectContaining({
        restrictionType: "RECOVERY_IN_PROGRESS",
        workOrderId: "20000000-0000-4000-8000-000000000021"
      }),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        vehicleId: IDS.vehicle,
        workOrderId: "20000000-0000-4000-8000-000000000021"
      }),
      expect.anything()
    );
    expect(harness.repository.appendPreparedEventInTransaction).toHaveBeenCalledWith(
      harness.tx,
      harness.session,
      expect.objectContaining({
        afterStatus: "RECOVERY_IN_PROGRESS",
        recoveryAssetWorkOrderId: "20000000-0000-4000-8000-000000000021"
      }),
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      "recovery-execution"
    );
  });

  it("exactly replays successful recovery execution and rejects command drift", async () => {
    const harness = recoveryExecutionHarness();
    const command = {
      actorId: IDS.actor,
      approvalId: "20000000-0000-4000-8000-000000000020",
      closureCaseId: IDS.case,
      expectedApprovalVersion: 1,
      idempotencyKey: "execute-exact",
      occurredAt: new Date("2026-09-08T05:00:00.000Z")
    };

    await expect(harness.service.executeApprovedRecovery(command)).resolves.toMatchObject({
      action: "RECOVERY_STARTED",
      wrote: true
    });
    await expect(harness.service.executeApprovedRecovery(command)).resolves.toEqual({
      action: "RECOVERY_STARTED",
      recoveryAssetWorkOrderId: "20000000-0000-4000-8000-000000000021",
      wrote: false
    });
    await expect(
      harness.service.executeApprovedRecovery({
        ...command,
        occurredAt: new Date(command.occurredAt.getTime() + 1)
      })
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" }
    });
    expect(harness.operations.createPreparedWorkOrderInTransaction).toHaveBeenCalledTimes(1);
    expect(harness.operations.createPreparedRestrictionInTransaction).toHaveBeenCalledTimes(1);
  });

  it("durably expires a drifted approval into PAUSED without creating recovery mutations", async () => {
    const harness = recoveryExecutionHarness({ validApproval: false });
    const command = {
      actorId: IDS.actor,
      approvalId: "20000000-0000-4000-8000-000000000020",
      closureCaseId: IDS.case,
      expectedApprovalVersion: 1,
      idempotencyKey: "execute-stale",
      occurredAt: new Date("2026-09-08T05:00:00.000Z")
    };

    await expect(harness.service.executeApprovedRecovery(command)).resolves.toMatchObject({
      action: "APPROVAL_EXPIRED",
      wrote: true
    });
    await expect(harness.service.executeApprovedRecovery(command)).resolves.toEqual({
      action: "APPROVAL_EXPIRED",
      wrote: false
    });
    await expect(
      harness.service.executeApprovedRecovery({
        ...command,
        occurredAt: new Date(command.occurredAt.getTime() + 1)
      })
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT" }
    });
    expect(harness.operations.createPreparedWorkOrderInTransaction).not.toHaveBeenCalled();
    expect(harness.operations.createPreparedRestrictionInTransaction).not.toHaveBeenCalled();
    expect(harness.repository.appendPreparedEventInTransaction).toHaveBeenCalledWith(
      harness.tx,
      harness.session,
      expect.objectContaining({
        afterStatus: "PAUSED",
        detailSnapshot: expect.objectContaining({
          pausedFromStatus: "RECOVERY_APPROVED",
          reason: "APPROVAL_STALE"
        })
      }),
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      "recovery-approval-stale"
    );
  });

  it("durably expires an approval when an extension becomes live before execution", async () => {
    const harness = recoveryExecutionHarness({ extension: true, validApproval: false });

    await expect(
      harness.service.executeApprovedRecovery({
        actorId: IDS.actor,
        approvalId: "20000000-0000-4000-8000-000000000020",
        closureCaseId: IDS.case,
        expectedApprovalVersion: 1,
        idempotencyKey: "execute-extension-stale",
        occurredAt: new Date("2026-09-08T05:00:00.000Z")
      })
    ).resolves.toEqual({ action: "APPROVAL_EXPIRED", wrote: true });
    expect(harness.operations.createPreparedWorkOrderInTransaction).not.toHaveBeenCalled();
    expect(harness.operations.createPreparedRestrictionInTransaction).not.toHaveBeenCalled();
  });
});

describe("SubscriptionClosureService recovery execution evidence and costs", () => {
  it("records evidence and actual cost through one prepared authority pass bound to the recovery AWO", async () => {
    const harness = recoveryEvidenceHarness();
    const occurredAt = new Date("2026-09-08T06:00:00.000Z");

    await expect(
      harness.service.recordRecoveryExecution({
        actorId: IDS.actor,
        closureCaseId: IDS.case,
        costs: [
          {
            actionType: "ACTUAL_COST",
            accountingPeriod: "2026-09",
            amountCents: 8000n,
            assetOwnerId: null,
            assetOwnerSnapshot: null,
            confirmedAt: occurredAt,
            costCategory: "OTHER",
            evidenceId: null,
            evidenceSnapshot: { basis: "field-recovery" },
            occurredOn: new Date("2026-09-08T00:00:00.000Z"),
            reason: "field recovery transport",
            responsiblePartyId: IDS.customer,
            responsiblePartyType: "CUSTOMER",
            responsibilitySnapshot: { basis: "approved recovery" }
          }
        ],
        evidence: [
          {
            action: "ATTACH",
            capturedAt: occurredAt,
            captureMetadata: { location: "recovery-site" },
            contentSha256: "a".repeat(64),
            eventId: null,
            evidenceType: "OTHER",
            fileId: null,
            occurredAt,
            supersedesEvidenceId: null
          }
        ],
        idempotencyKey: "field-visit-1",
        occurredAt
      })
    ).resolves.toMatchObject({ costCount: 1, evidenceCount: 1, wrote: true });

    expect(harness.repository.prepareAuthorityInTransaction).toHaveBeenCalledTimes(1);
    expect(harness.operations.evidenceAuthorityRequirement).toHaveBeenCalledWith(
      harness.session,
      expect.objectContaining({
        captureMetadata: expect.objectContaining({
          closureCaseId: IDS.case,
          recoveryApprovalId: "20000000-0000-4000-8000-000000000020",
          recoveryAssetWorkOrderId: harness.workOrder.id,
          recoveryAuthorityRevisionId: harness.chain.ids.archivedRevisionId
        }),
        workOrderId: harness.workOrder.id
      }),
      IDS.actor,
      expect.objectContaining({ workOrderId: harness.workOrder.id }),
      "recovery-execution-evidence:field-visit-1:0"
    );
    expect(harness.accounting.appendCostAuthorityRequirement).toHaveBeenCalledWith(
      harness.session,
      expect.objectContaining({
        contractId: harness.caseRow.contractId,
        customerId: IDS.customer,
        orderId: IDS.order,
        vehicleId: IDS.vehicle,
        workOrderId: harness.workOrder.id
      }),
      expect.anything(),
      { authoritativeOrderId: IDS.order },
      "recovery-execution-cost:field-visit-1:0"
    );
    expect(harness.repository.appendPreparedEventInTransaction).toHaveBeenCalledWith(
      harness.tx,
      harness.session,
      expect.objectContaining({
        afterStatus: "RECOVERY_IN_PROGRESS",
        eventType: "NOTE_ADDED"
      }),
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      "recovery-execution-record"
    );
  });
});

function recoveryInput() {
  return {
    actorId: IDS.actor,
    closureCaseId: IDS.case,
    governingBillId: IDS.bill,
    governingDueDate: new Date("2026-09-01T00:00:00.000Z"),
    jobId: IDS.job,
    jobKey: "closure-recovery-assessment:case:D7",
    orderId: IDS.order
  };
}

function recoveryScheduleHarness(
  options: { boundary?: { dueDate: Date; id: string } | null } = {}
) {
  let boundary =
    options.boundary === undefined
      ? { dueDate: new Date("2026-09-01T00:00:00.000Z"), id: IDS.bill }
      : options.boundary;
  let storedJob:
    | {
        availableAt: Date;
        billId: string;
        id: string;
        idempotencyKey: string;
        jobType: string;
        orderId: string;
        payload: Readonly<Record<string, unknown>>;
      }
    | undefined;
  const tx = {
    receivableBill: { findFirst: vi.fn(async () => boundary) },
    subscriptionAutomationJob: {
      upsert: vi.fn(async ({ create }) => {
        storedJob ??= {
          availableAt: create.availableAt,
          billId: create.billId,
          id: IDS.job,
          idempotencyKey: create.idempotencyKey,
          jobType: create.jobType,
          orderId: create.orderId,
          payload: create.payload
        };
        return storedJob;
      })
    },
    subscriptionClosureCase: {
      findUnique: vi.fn(async () => ({
        closureType: "NORMAL_COMPLETION",
        createdBy: IDS.actor,
        id: IDS.case,
        orderId: IDS.order,
        physicalControlMode: "VOLUNTARY_RETURN",
        status: "PREPARING_RETURN"
      }))
    }
  };
  const service = new SubscriptionClosureService(
    {} as never,
    {} as never,
    {} as never,
    { write: vi.fn(async () => undefined) } as never
  );
  return {
    mutateStoredJob(mutate: (job: NonNullable<typeof storedJob>) => NonNullable<typeof storedJob>) {
      if (!storedJob) throw new Error("Expected stored recovery job");
      storedJob = mutate(storedJob);
    },
    service,
    setBoundary(value: { dueDate: Date; id: string } | null) {
      boundary = value;
    },
    tx
  };
}

function recoveryHarness(
  options: {
    bills?: readonly unknown[];
    dispute?: boolean;
    extension?: boolean;
    returned?: boolean;
  } = {}
) {
  const timeline: string[] = [];
  let receipt: Readonly<{ payloadSnapshot: unknown }> | null = null;
  const bills = options.bills ?? [
    {
      billNo: "BILL-1",
      billStatus: "OVERDUE",
      dueDate: new Date("2026-09-01Z"),
      id: IDS.bill,
      remainingAmount: 900n
    }
  ];
  const job = {
    availableAt: new Date("2026-09-07T16:00:00.000Z"),
    billId: IDS.bill,
    id: IDS.job,
    idempotencyKey: "closure-recovery-assessment:case:D7",
    jobType: "CLOSURE_RECOVERY_ASSESSMENT_D7",
    orderId: IDS.order,
    payload: {
      actorId: IDS.actor,
      billId: IDS.bill,
      closureCaseId: IDS.case,
      dueDate: "2026-09-01T00:00:00.000Z",
      snapshotVersion: 1
    }
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ now: new Date("2026-09-08T00:00:00.000Z") }]),
    collectionCase: {
      findMany: vi.fn(async () => [
        {
          actions: options.dispute
            ? [
                {
                  actionResult: "DISPUTED",
                  actionType: "CUSTOMER_DISPUTE",
                  createdAt: new Date("2026-09-06Z"),
                  id: "action-1"
                }
              ]
            : [
                {
                  actionResult: "CUSTOMER_PROMISED",
                  actionType: "PROMISE_TO_PAY",
                  createdAt: new Date("2026-09-05Z"),
                  id: "action-1",
                  promisedAmount: 900n,
                  promisedPayAt: new Date("2026-09-09Z")
                }
              ],
          bills: [],
          caseNo: "COL-1",
          caseStatus: "ACTIVE",
          id: IDS.collection,
          totalOverdueAmount: 900n
        }
      ])
    },
    receivableBill: { findMany: vi.fn(async () => bills) },
    subscriptionAutomationJob: { findUnique: vi.fn(async () => job) },
    subscriptionClosureCommandReceipt: { findUnique: vi.fn(async () => receipt) },
    subscriptionClosureCase: {
      findUnique: vi.fn(async () => ({
        closureType: "NORMAL_COMPLETION",
        createdBy: IDS.actor,
        customerId: IDS.customer,
        finalDisposition: "COMPLETE",
        id: IDS.case,
        orderId: IDS.order,
        physicalControlledAt: null,
        physicalControlMode: "VOLUNTARY_RETURN",
        status: "PREPARING_RETURN",
        vehicleId: IDS.vehicle,
        vehicleReturnId: IDS.vehicleReturn,
        version: 2
      }))
    },
    subscriptionContractSegment: {
      findFirst: vi.fn(async () =>
        options.extension
          ? {
              id: "20000000-0000-4000-8000-000000000010",
              startDate: new Date("2026-09-03Z"),
              status: "SCHEDULED"
            }
          : null
      )
    },
    vehicle: {
      findUnique: vi.fn(async () => ({ id: IDS.vehicle, status: "LEASED", vehicleNo: "VEH-1" }))
    },
    vehicleOperationalRestriction: { findMany: vi.fn(async () => []) },
    vehicleReturn: {
      findUnique: vi.fn(async () => ({
        id: IDS.vehicleReturn,
        returnStatus: options.returned ? "CONFIRMED" : "PENDING",
        returnedAt: options.returned ? new Date("2026-09-07Z") : null
      }))
    }
  };
  const repository = {
    appendSourcePreparedEventInTransaction: vi.fn(async (_tx, command) => {
      receipt = { payloadSnapshot: command };
      return { outcome: { case: { id: IDS.case } }, wrote: true };
    }),
    escalatePreparedRecoveryInTransaction: vi.fn(async () => {
      timeline.push("execute:prepared-escalation");
      return { outcome: { case: { id: IDS.case } }, wrote: true };
    }),
    lockAuthorityRows: vi.fn(async () => {
      timeline.push("coordinator:ranked-pass");
    }),
    prepareSourceInTransaction: vi.fn(async () => {
      timeline.push("source:assessment");
      return Object.freeze({ source: true });
    })
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
  };
  const service = new SubscriptionClosureService(
    repository as never,
    {} as never,
    {} as never,
    { write: vi.fn(async () => undefined) } as never,
    prisma as never
  );
  return { prisma, repository, service, timeline, tx };
}

function recoveryActionHarness(options: { status?: string } = {}) {
  const receipts = new Map<string, Readonly<{ payloadSnapshot: unknown }>>();
  const caseRow = {
    closureType: "NORMAL_COMPLETION",
    finalDisposition: "TERMINATE",
    id: IDS.case,
    physicalControlMode: "RECOVERY",
    status: options.status ?? "RECOVERY_APPROVED",
    version: 4
  };
  const tx = {
    subscriptionClosureCommandReceipt: {
      findUnique: vi.fn(
        async ({ where }) => receipts.get(where.sourceType_sourceId_sourceKey.sourceKey) ?? null
      )
    },
    subscriptionClosureCase: { findUnique: vi.fn(async () => caseRow) },
    subscriptionClosureEvent: {
      findFirst: vi.fn(async () => ({
        detailSnapshot: {
          pausedFromStatus: "RECOVERY_APPROVED",
          recoveryAction: "PAUSE"
        }
      }))
    }
  };
  const repository = {
    appendEvent: vi.fn(async (_tx, command) => {
      receipts.set(command.source.key, { payloadSnapshot: command });
      return { outcome: { case: caseRow }, wrote: true };
    })
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
  };
  const service = new SubscriptionClosureService(
    repository as never,
    {} as never,
    {} as never,
    { write: vi.fn(async () => undefined) } as never,
    prisma as never
  );
  return { caseRow, prisma, repository, service, tx };
}

function recoveryApprovalHarness(
  options: { decision?: "APPROVED" | "REJECTED"; futureOnly?: boolean } = {}
) {
  const plannedWorkOrderId = "20000000-0000-4000-8000-000000000021";
  const caseRow = {
    caseNo: "CLS-1",
    closureType: "NORMAL_COMPLETION",
    contractId: "20000000-0000-4000-8000-000000000024",
    customerId: IDS.customer,
    finalDisposition: "TERMINATE",
    id: IDS.case,
    orderId: IDS.order,
    physicalControlMode: "RECOVERY",
    status: options.decision ? "RECOVERY_APPROVAL_PENDING" : "RECOVERY_ASSESSMENT_PENDING",
    vehicleId: IDS.vehicle,
    vehicleReturnId: IDS.vehicleReturn,
    version: options.decision ? 4 : 3
  };
  const assessment = {
    detailSnapshot: { plannedRecoveryAssetWorkOrderId: plannedWorkOrderId }
  };
  const approvalRow = {
    id: "20000000-0000-4000-8000-000000000020",
    requestedBy: IDS.actor,
    status: "PENDING",
    version: 0
  };
  const tx = {
    ...recoveryApprovalContextTx(plannedWorkOrderId, { futureOnly: options.futureOnly }),
    $queryRaw: vi.fn(async () => [{ now: new Date("2026-09-08T00:00:00.000Z") }]),
    assetAccountingCommandReceipt: { findUnique: vi.fn(async () => null) },
    businessExceptionApproval: { findUnique: vi.fn(async () => approvalRow) },
    subscriptionClosureCase: { findUnique: vi.fn(async () => caseRow) },
    subscriptionClosureCommandReceipt: { findUnique: vi.fn(async () => null) },
    subscriptionClosureEvent: { findFirst: vi.fn(async () => assessment) }
  };
  const chain = attachUnitRecoveryAuthorityChain(tx, caseRow, assessment, plannedWorkOrderId);
  let resolvedAuthority: unknown;
  const accountingCapability = Object.freeze({ accountingCapability: true });
  const preparedCapability = Object.freeze({ preparedCapability: true });
  const requirement = {
    key: options.decision ? "recovery-approval-decision" : "recovery-approval-request",
    locks: [
      { id: IDS.case, mode: "UPDATE", table: "subscription_closure_case" },
      { id: IDS.actor, mode: "SHARE", table: "user" }
    ]
  };
  const accounting = {
    attestPreparedApprovalDecisionInTransaction: vi.fn(
      async (_tx, _session, _command, _context, authority) => {
        resolvedAuthority = authority;
        return preparedCapability;
      }
    ),
    attestPreparedApprovalRequestInTransaction: vi.fn(
      async (_tx, _session, _command, _context, authority) => {
        resolvedAuthority = authority;
        return preparedCapability;
      }
    ),
    decideApprovalAuthorityRequirement: vi.fn(() => requirement),
    decideApprovalInTransaction: vi.fn(async (_tx, _command, _context, resolver) => {
      resolvedAuthority = await resolver();
      return {
        decision: options.decision,
        id: "20000000-0000-4000-8000-000000000020",
        status: options.decision,
        version: 1
      };
    }),
    decidePreparedApprovalInTransaction: vi.fn(async () => ({
      decision: options.decision,
      id: approvalRow.id,
      status: options.decision,
      version: 1
    })),
    prepareCallerOwnedTransaction: vi.fn(async () => accountingCapability),
    requestApprovalAuthorityRequirement: vi.fn(() => requirement),
    requestApprovalInTransaction: vi.fn(async (_tx, _command, _context, resolver) => {
      resolvedAuthority = await resolver();
      return {
        id: "20000000-0000-4000-8000-000000000020",
        status: "PENDING",
        version: 0
      };
    }),
    requestPreparedApprovalInTransaction: vi.fn(async () => ({
      id: approvalRow.id,
      status: "PENDING",
      subjectSnapshotHash: "b".repeat(64),
      version: 0
    }))
  };
  const session = Object.freeze({ session: true });
  const repository = {
    appendEvent: vi.fn(async () => ({ outcome: { case: caseRow }, wrote: true })),
    appendSourcePreparedEventInTransaction: vi.fn(async () => ({
      outcome: { case: caseRow },
      wrote: true
    })),
    createAuthoritySessionInTransaction: vi.fn(() => session),
    prepareAuthorityInTransaction: vi.fn(
      async () => new Map([[requirement.key, Object.freeze({ proof: true })]])
    ),
    prepareSourceInTransaction: vi.fn(async () => Object.freeze({ source: true }))
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
  };
  const service = new SubscriptionClosureService(
    repository as never,
    {} as never,
    {} as never,
    { write: vi.fn(async () => undefined) } as never,
    prisma as never,
    undefined,
    accounting as never
  );
  return {
    accounting,
    get resolvedAuthority() {
      return resolvedAuthority;
    },
    chain,
    repository,
    service,
    tx
  };
}

function recoveryExecutionHarness(options: { extension?: boolean; validApproval?: boolean } = {}) {
  const timeline: string[] = [];
  let executionReceiptPayload: unknown = null;
  let staleReceipt = false;
  let staleReceiptPayload: unknown = null;
  const session = Object.freeze({ session: true });
  const caseRow = {
    caseNo: "CLS-1",
    closureType: "NORMAL_COMPLETION",
    contractId: "20000000-0000-4000-8000-000000000024",
    customerId: IDS.customer,
    finalDisposition: "TERMINATE",
    id: IDS.case,
    orderId: IDS.order,
    physicalControlMode: "RECOVERY",
    recoveryAssetWorkOrderId: null as string | null,
    status: "RECOVERY_APPROVED",
    vehicleId: IDS.vehicle,
    vehicleReturnId: IDS.vehicleReturn,
    version: 5
  };
  const plannedWorkOrderId = "20000000-0000-4000-8000-000000000021";
  const assessment = {
    detailSnapshot: { plannedRecoveryAssetWorkOrderId: plannedWorkOrderId }
  };
  const tx = {
    ...recoveryApprovalContextTx(plannedWorkOrderId),
    assetWorkOrder: { findUnique: vi.fn(async () => null) },
    subscriptionClosureCase: { findUnique: vi.fn(async () => caseRow) },
    subscriptionClosureCommandReceipt: {
      findUnique: vi.fn(async ({ where }) => {
        const sourceKey = String(where.sourceType_sourceId_sourceKey.sourceKey);
        if (staleReceipt && sourceKey.includes("approval-stale")) {
          return { id: "stale-receipt", payloadSnapshot: staleReceiptPayload };
        }
        return executionReceiptPayload && sourceKey.includes("execution-state")
          ? { id: "execution-receipt", payloadSnapshot: executionReceiptPayload }
          : null;
      })
    },
    subscriptionClosureEvent: { findFirst: vi.fn(async () => assessment) },
    subscriptionContractSegment: {
      findFirst: vi.fn(async () =>
        options.extension ? { id: "20000000-0000-4000-8000-000000000025", status: "ACTIVE" } : null
      )
    }
  };
  const chain = attachUnitRecoveryAuthorityChain(tx, caseRow, assessment, plannedWorkOrderId);
  const proof = (key: string) => Object.freeze({ key });
  const repository = {
    appendPreparedEventInTransaction: vi.fn(async (_tx, _session, eventCommand) => {
      timeline.push("execute:event");
      if (options.validApproval === false) {
        staleReceipt = true;
        staleReceiptPayload = eventCommand;
        caseRow.status = "PAUSED";
      } else {
        executionReceiptPayload = eventCommand;
        caseRow.recoveryAssetWorkOrderId = plannedWorkOrderId;
        caseRow.status = "RECOVERY_IN_PROGRESS";
      }
      return { wrote: true };
    }),
    bindAuthorityRequirement: vi.fn((_session, requirement) => requirement),
    createAuthoritySessionInTransaction: vi.fn(() => session),
    lockAuthorityRows: vi.fn(async () => undefined),
    lockSourceOwnership: vi.fn(async () => undefined),
    prepareAuthorityInTransaction: vi.fn(async () => {
      timeline.push("coordinator:ranked-pass");
      return new Map([
        ["asset-create", proof("asset-create")],
        ["recovery-approval", proof("recovery-approval")],
        ["return-inspection-restriction", proof("return-inspection-restriction")],
        ["recovery-execution", proof("recovery-execution")],
        ["recovery-approval-stale", proof("recovery-approval-stale")]
      ]);
    }),
    prepareSourceInTransaction: vi.fn(async (_tx, source) => {
      const kind = String(source.key).includes("approval-stale")
        ? "stale-event"
        : String(source.key).includes("execution-state")
          ? "event"
          : "unknown";
      timeline.push(`source:${kind}`);
      return Object.freeze({ kind });
    })
  };
  const operations = {
    attestCallerOwnedCreateAuthorityInTransaction: vi.fn(async () => {
      timeline.push("attest:asset-create");
      return Object.freeze({ prepared: "asset" });
    }),
    attestPreparedRestrictionCreateInTransaction: vi.fn(async () => {
      timeline.push("attest:restriction");
      return Object.freeze({ prepared: "restriction" });
    }),
    createAuthorityRequirement: vi.fn(() => ({ key: "asset-create", locks: [] })),
    createPreparedRestrictionInTransaction: vi.fn(async () => {
      timeline.push("execute:restriction");
      return { restriction: { id: "restriction-1" }, wrote: true };
    }),
    createPreparedWorkOrderInTransaction: vi.fn(async () => {
      timeline.push("execute:asset-create");
      return { workOrder: { id: plannedWorkOrderId }, wrote: true };
    }),
    prepareCallerOwnedTransaction: vi.fn(async (_tx, source) => {
      const kind = String(source.key).includes("work-order") ? "asset" : "restriction";
      timeline.push(`source:${kind}`);
      return Object.freeze({ kind });
    }),
    restrictionCreateAuthorityRequirement: vi.fn(() => ({
      key: "return-inspection-restriction",
      locks: []
    }))
  };
  const accounting = {
    approvedExceptionAuthorityRequirement: vi.fn(() => ({
      key: "recovery-approval",
      locks: []
    })),
    attestPreparedApprovedExceptionInTransaction: vi.fn(async () => {
      timeline.push("attest:approval");
      return Object.freeze({ prepared: "approval" });
    }),
    prepareCallerOwnedTransaction: vi.fn(async () => {
      timeline.push("source:approval");
      return Object.freeze({ kind: "approval" });
    }),
    requirePreparedApprovedExceptionInTransaction: vi.fn(async () => {
      timeline.push("execute:approval");
      return options.validApproval ?? true;
    })
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
  };
  const service = new SubscriptionClosureService(
    repository as never,
    {} as never,
    operations as never,
    { write: vi.fn(async () => undefined) } as never,
    prisma as never,
    undefined,
    accounting as never
  );
  return { accounting, chain, operations, repository, service, session, timeline, tx };
}

function recoveryEvidenceHarness() {
  const session = Object.freeze({ session: true });
  const caseRow = {
    caseNo: "CLS-1",
    closureType: "NORMAL_COMPLETION",
    contractId: "20000000-0000-4000-8000-000000000024",
    customerId: IDS.customer,
    finalDisposition: "TERMINATE",
    id: IDS.case,
    orderId: IDS.order,
    physicalControlMode: "RECOVERY",
    recoveryAssetWorkOrderId: "20000000-0000-4000-8000-000000000021",
    status: "RECOVERY_IN_PROGRESS",
    vehicleId: IDS.vehicle,
    vehicleReturnId: IDS.vehicleReturn,
    version: 6
  };
  const workOrder = {
    assetOwnerId: null,
    contractId: caseRow.contractId,
    customerId: IDS.customer,
    id: caseRow.recoveryAssetWorkOrderId,
    orderId: IDS.order,
    relatedWorkOrderId: null,
    status: "OPEN",
    vehicleId: IDS.vehicle,
    workOrderType: "RECOVERY"
  };
  const assessment = {
    detailSnapshot: { plannedRecoveryAssetWorkOrderId: workOrder.id }
  };
  const approvalRef: {
    current?: {
      decidedAt: Date;
      decidedBy: string;
      id: string;
      requestedBy: string;
      subjectSnapshot: Readonly<Record<string, unknown>>;
      subjectSnapshotHash: string;
    };
  } = {};
  const tx = {
    ...recoveryApprovalContextTx(workOrder.id),
    assetWorkOrder: { findUnique: vi.fn(async () => workOrder) },
    businessExceptionApproval: {
      findFirst: vi.fn(async () => approvalRef.current),
      findUnique: vi.fn(async () => approvalRef.current)
    },
    subscriptionClosureCase: { findUnique: vi.fn(async () => caseRow) },
    subscriptionClosureCommandReceipt: { findUnique: vi.fn(async () => null) },
    subscriptionClosureEvent: { findFirst: vi.fn(async () => assessment) }
  };
  const chain = attachUnitRecoveryAuthorityChain(tx, caseRow, assessment, workOrder.id);
  const recoveryAuthority = {
    closureCaseId: IDS.case,
    orderId: IDS.order,
    recoveryAssetWorkOrderId: workOrder.id,
    recoveryAuthorityRevisionId: chain.ids.archivedRevisionId,
    recoveryAuthoritySnapshotHash: chain.documentHash,
    recoveryContextSnapshotHash: recoveryApprovalContextHash(workOrder.id),
    vehicleId: IDS.vehicle
  };
  approvalRef.current = {
    decidedAt: new Date("2026-09-08T05:00:00.000Z"),
    decidedBy: IDS.actor,
    id: "20000000-0000-4000-8000-000000000020",
    requestedBy: "20000000-0000-4000-8000-000000000023",
    subjectSnapshot: recoveryAuthority,
    subjectSnapshotHash: createHash("sha256")
      .update(JSON.stringify(recoveryAuthority))
      .digest("hex")
  };
  const proof = (key: string) => Object.freeze({ key });
  const repository = {
    appendPreparedEventInTransaction: vi.fn(async () => ({ wrote: true })),
    bindAuthorityRequirement: vi.fn((_session, requirement) => requirement),
    createAuthoritySessionInTransaction: vi.fn(() => session),
    prepareAuthorityInTransaction: vi.fn(
      async () =>
        new Map([
          ["recovery-execution-evidence:field-visit-1:0", proof("evidence")],
          ["recovery-execution-cost:field-visit-1:0", proof("cost")],
          ["recovery-execution-record", proof("event")]
        ])
    ),
    prepareSourceInTransaction: vi.fn(async () => Object.freeze({ source: "event" }))
  };
  const operations = {
    appendPreparedEvidenceInTransaction: vi.fn(async () => ({ wrote: true })),
    attestPreparedEvidenceInTransaction: vi.fn(async () => Object.freeze({ prepared: "evidence" })),
    evidenceAuthorityRequirement: vi.fn((_session, _command, _actor, _authority, key) => ({
      key,
      locks: []
    })),
    prepareCallerOwnedTransaction: vi.fn(async () => Object.freeze({ source: "evidence" }))
  };
  const accounting = {
    appendCostAuthorityRequirement: vi.fn((_session, _command, _context, _authority, key) => ({
      key,
      locks: []
    })),
    appendPreparedCostInTransaction: vi.fn(async () => ({ wrote: true })),
    attestPreparedAppendCostInTransaction: vi.fn(async () => Object.freeze({ prepared: "cost" })),
    prepareCallerOwnedTransaction: vi.fn(async () => Object.freeze({ source: "cost" }))
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
  };
  const service = new SubscriptionClosureService(
    repository as never,
    {} as never,
    operations as never,
    { write: vi.fn(async () => undefined) } as never,
    prisma as never,
    undefined,
    accounting as never
  );
  return { accounting, caseRow, chain, operations, repository, service, session, tx, workOrder };
}

function recoveryApprovalContextTx(
  plannedWorkOrderId: string,
  options: { futureOnly?: boolean } = {}
) {
  void plannedWorkOrderId;
  return {
    $queryRaw: vi.fn(async () => [{ now: new Date("2026-09-08T00:00:00.000Z") }]),
    collectionCase: { findMany: vi.fn(async () => []) },
    receivableBill: {
      findMany: vi.fn(async ({ where }) => {
        const dueDate = new Date(
          options.futureOnly ? "2026-10-01T00:00:00.000Z" : "2026-09-01T00:00:00.000Z"
        );
        const upperBound = where?.dueDate?.lt;
        if (upperBound instanceof Date && dueDate.getTime() >= upperBound.getTime()) return [];
        return [
          {
            billStatus: options.futureOnly ? "PENDING" : "OVERDUE",
            dueDate,
            id: IDS.bill,
            remainingAmount: 900n
          }
        ];
      })
    },
    subscriptionContractSegment: { findFirst: vi.fn(async () => null) },
    vehicle: {
      findUnique: vi.fn(async () => ({ id: IDS.vehicle, status: "LEASED", vehicleNo: "VEH-1" }))
    },
    vehicleOperationalRestriction: { findMany: vi.fn(async () => []) },
    vehicleReturn: {
      findUnique: vi.fn(async () => ({
        id: IDS.vehicleReturn,
        returnStatus: "PENDING",
        returnedAt: null
      }))
    }
  };
}

function recoveryApprovalContextHash(plannedWorkOrderId: string) {
  const assessmentDetail = { plannedRecoveryAssetWorkOrderId: plannedWorkOrderId };
  const assessmentSnapshotHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(assessmentDetail))
    .digest("hex");
  return createHash("sha256")
    .update(
      canonicalSubscriptionClosureJson({
        assessmentSnapshotHash,
        bills: [
          {
            billStatus: "OVERDUE",
            dueDate: new Date("2026-09-01T00:00:00.000Z"),
            id: IDS.bill,
            remainingAmount: 900n
          }
        ],
        collectionCases: [],
        extension: null,
        legalRestrictions: [],
        vehicle: { id: IDS.vehicle, status: "LEASED", vehicleNo: "VEH-1" },
        vehicleReturn: {
          id: IDS.vehicleReturn,
          returnStatus: "PENDING",
          returnedAt: null
        }
      })
    )
    .digest("hex");
}

function attachUnitRecoveryAuthorityChain(
  tx: Record<string, unknown> & {
    subscriptionClosureCommandReceipt: Record<string, unknown>;
    subscriptionClosureEvent: Record<string, unknown>;
  },
  caseRow: Readonly<{
    caseNo: string;
    contractId: string;
    customerId: string;
    id: string;
    orderId: string;
    vehicleId: string;
    vehicleReturnId: string;
  }>,
  assessment: Readonly<Record<string, unknown>>,
  plannedWorkOrderId: string
) {
  const idempotencyKey = "unit-authority";
  const stableId = (label: string) => {
    const value = `${caseRow.id}\u0000${idempotencyKey}\u0000${label}`;
    const hex = createHash("sha256").update(`recovery-authority\u0000${value}`).digest("hex");
    const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const ids = {
    archivedRevisionId: stableId("revision-archived"),
    esignEnvelopeId: stableId("esign-envelope"),
    esignProviderTaskId: stableId("esign-provider-task"),
    esignTaskId: stableId("esign-task"),
    generatedRevisionId: stableId("revision-generated"),
    signedFileId: stableId("file-signed"),
    signedRevisionId: stableId("revision-signed"),
    sourceFileId: stableId("file-source")
  };
  const sources = ["generated", "signed", "archived"].map((stage) => ({
    id: caseRow.id,
    key: `recovery-authority:${idempotencyKey}:${stage}`,
    type: "SUBSCRIPTION_CLOSURE"
  }));
  const lifecycleAt = new Date("2026-09-08T02:00:00.000Z");
  const documentSnapshot = {
    caseNo: caseRow.caseNo,
    closureCaseId: caseRow.id,
    contractId: caseRow.contractId,
    customerId: caseRow.customerId,
    documentType: "RECOVERY_AUTHORITY",
    finalDisposition: "TERMINATE",
    orderId: caseRow.orderId,
    physicalControlMode: "RECOVERY",
    recoveryAssetWorkOrderId: plannedWorkOrderId,
    recoveryWorkOrderType: "RECOVERY",
    vehicleId: caseRow.vehicleId,
    vehicleReturnId: caseRow.vehicleReturnId
  };
  const documentCanonical = canonicalSubscriptionClosureJson(documentSnapshot);
  const documentHash = createHash("sha256").update(documentCanonical).digest("hex");
  const signedEnvelope = {
    completedAt: lifecycleAt,
    documentSnapshotHash: documentHash,
    documentType: "RECOVERY_AUTHORITY",
    lifecycleSources: sources,
    signedBy: IDS.actor,
    signedFileId: ids.signedFileId,
    sourceFileHash: documentHash,
    sourceFileId: ids.sourceFileId
  };
  const signedCanonical = canonicalSubscriptionClosureJson(signedEnvelope);
  const signedFileHash = createHash("sha256").update(signedCanonical).digest("hex");
  const commonCommand = {
    actorId: IDS.actor,
    closureCaseId: caseRow.id,
    contractESignTaskId: ids.esignTaskId,
    documentSnapshot,
    documentType: "RECOVERY_AUTHORITY",
    generatedAt: lifecycleAt,
    handoverWorkOrderId: null,
    sourceFileHash: documentHash,
    sourceFileId: ids.sourceFileId,
    vehicleReturnId: null
  };
  const commands = [
    {
      ...commonCommand,
      archivedAt: null,
      archivedBy: null,
      documentRevisionId: ids.generatedRevisionId,
      expectedCurrentRevisionId: null,
      expectedVersion: 0,
      signedAt: null,
      signedBy: null,
      signedFileHash: null,
      signedFileId: null,
      source: sources[0],
      stage: "GENERATED"
    },
    {
      ...commonCommand,
      archivedAt: null,
      archivedBy: null,
      documentRevisionId: ids.signedRevisionId,
      expectedCurrentRevisionId: ids.generatedRevisionId,
      expectedVersion: 1,
      signedAt: lifecycleAt,
      signedBy: IDS.actor,
      signedFileHash,
      signedFileId: ids.signedFileId,
      source: sources[1],
      stage: "SIGNED"
    },
    {
      ...commonCommand,
      archivedAt: lifecycleAt,
      archivedBy: IDS.actor,
      documentRevisionId: ids.archivedRevisionId,
      expectedCurrentRevisionId: ids.signedRevisionId,
      expectedVersion: 2,
      signedAt: lifecycleAt,
      signedBy: IDS.actor,
      signedFileHash,
      signedFileId: ids.signedFileId,
      source: sources[2],
      stage: "ARCHIVED"
    }
  ] as const;
  const revisions = commands.map((command, index) => ({
    archivedAt: command.archivedAt,
    archivedBy: command.archivedBy,
    closureCaseId: caseRow.id,
    contractESignTaskId: ids.esignTaskId,
    createdAt: lifecycleAt,
    documentSnapshot,
    documentSnapshotHash: documentHash,
    documentType: "RECOVERY_AUTHORITY",
    generatedAt: lifecycleAt,
    generatedBy: IDS.actor,
    handoverWorkOrderId: null,
    id: command.documentRevisionId,
    revisionNumber: index + 1,
    signedAt: command.signedAt,
    signedBy: command.signedBy,
    signedFileHash: command.signedFileHash,
    signedFileId: command.signedFileId,
    sourceFileHash: documentHash,
    sourceFileId: ids.sourceFileId,
    sourceId: caseRow.id,
    sourceKey: sources[index]!.key,
    sourceType: "SUBSCRIPTION_CLOSURE",
    stage: command.stage,
    supersedesRevisionId: index === 0 ? null : commands[index - 1]!.documentRevisionId,
    vehicleReturnId: null
  }));
  const outcome = (revision: (typeof revisions)[number]) => ({
    archivedAt: revision.archivedAt?.toISOString() ?? null,
    archivedBy: revision.archivedBy,
    closureCaseId: revision.closureCaseId,
    contractESignTaskId: revision.contractESignTaskId,
    createdAt: revision.createdAt.toISOString(),
    documentSnapshot: revision.documentSnapshot,
    documentSnapshotHash: revision.documentSnapshotHash,
    documentType: revision.documentType,
    generatedAt: revision.generatedAt.toISOString(),
    generatedBy: revision.generatedBy,
    handoverWorkOrderId: revision.handoverWorkOrderId,
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    signedAt: revision.signedAt?.toISOString() ?? null,
    signedBy: revision.signedBy,
    signedFileHash: revision.signedFileHash,
    signedFileId: revision.signedFileId,
    source: {
      id: revision.sourceId,
      key: revision.sourceKey,
      type: revision.sourceType
    },
    sourceFileHash: revision.sourceFileHash,
    sourceFileId: revision.sourceFileId,
    stage: revision.stage,
    supersedesRevisionId: revision.supersedesRevisionId,
    vehicleReturnId: revision.vehicleReturnId
  });
  const events = revisions.map((revision, index) => ({
    actorId: IDS.actor,
    afterStatus: "RECOVERY_ASSESSMENT_PENDING",
    beforeStatus: "RECOVERY_ASSESSMENT_PENDING",
    closureCaseId: caseRow.id,
    detailSnapshot: {
      documentRevisionId: revision.id,
      documentType: "RECOVERY_AUTHORITY",
      revisionNumber: index + 1
    },
    eventType: "DOCUMENT_REVISION_CREATED",
    id: stableId(`event-${index}`),
    occurredAt: new Date(lifecycleAt.getTime() + index + 1),
    recordedAt: lifecycleAt,
    sequence: index + 2,
    sourceId: caseRow.id,
    sourceKey: sources[index]!.key,
    sourceType: "SUBSCRIPTION_CLOSURE"
  }));
  const receipts = revisions.map((revision, index) => ({
    actorId: IDS.actor,
    closureCaseId: caseRow.id,
    commandType: "CREATE_DOCUMENT_REVISION",
    eventId: events[index]!.id,
    outcomeSnapshot: outcome(revision),
    payloadHash: createHash("sha256")
      .update(canonicalSubscriptionClosureJson(commands[index]))
      .digest("hex"),
    payloadSnapshot: commands[index],
    sourceId: caseRow.id,
    sourceKey: sources[index]!.key,
    sourceType: "SUBSCRIPTION_CLOSURE"
  }));
  const audits = events.map((event, index) => ({
    action: "CREATE",
    afterSnapshot: {
      action: "CREATE_DOCUMENT_REVISION",
      closureCaseId: caseRow.id,
      eventId: event.id,
      outcome: outcome(revisions[index]!),
      source: sources[index]
    },
    beforeSnapshot: null,
    createdAt: lifecycleAt,
    entityId: event.id,
    entityType: "subscription_closure_event",
    id: stableId(`audit-${index}`),
    ipAddress: null,
    module: "subscription_closure",
    operatorId: IDS.actor,
    userAgent: null
  }));
  const currentDocument = {
    closureCaseId: caseRow.id,
    documentRevision: revisions[2],
    documentRevisionId: ids.archivedRevisionId,
    documentType: "RECOVERY_AUTHORITY",
    updatedBy: IDS.actor
  };
  tx.subscriptionClosureDocumentRevision = { findMany: vi.fn(async () => revisions) };
  tx.subscriptionClosureCurrentDocument = { findUnique: vi.fn(async () => currentDocument) };
  tx.fileObject = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const source = where.id === ids.sourceFileId;
      if (!source && where.id !== ids.signedFileId) return null;
      return {
        bucket: "subscription-closure",
        id: where.id,
        mimeType: "application/json",
        objectKey: source
          ? `subscription-closure/${caseRow.id}/${ids.generatedRevisionId}-recovery-authority.json`
          : `subscription-closure/${caseRow.id}/${ids.signedRevisionId}-recovery-authority.signed.json`,
        originalName: source
          ? `${caseRow.caseNo}-${ids.generatedRevisionId}-recovery-authority.json`
          : `${caseRow.caseNo}-${ids.signedRevisionId}-recovery-authority.signed.json`,
        sizeBytes: BigInt(Buffer.byteLength(source ? documentCanonical : signedCanonical)),
        uploadedBy: IDS.actor
      };
    })
  };
  tx.contractESignTask = {
    findUnique: vi.fn(async () => ({
      completedAt: lifecycleAt,
      contractId: caseRow.contractId,
      customerId: caseRow.customerId,
      deletedAt: null,
      documentObjectKey: `subscription-closure/${caseRow.id}/${ids.generatedRevisionId}-recovery-authority.json`,
      documentType: "RECOVERY_AUTHORITY",
      id: ids.esignTaskId,
      orderId: caseRow.orderId,
      provider: "OTHER",
      providerEnvelopeId: ids.esignEnvelopeId,
      providerTaskId: ids.esignProviderTaskId,
      requestSnapshot: {
        archivedRevisionId: ids.archivedRevisionId,
        documentSnapshotHash: documentHash,
        documentType: "RECOVERY_AUTHORITY",
        generatedRevisionId: ids.generatedRevisionId,
        lifecycleSources: sources,
        signedRevisionId: ids.signedRevisionId,
        sourceFileHash: documentHash,
        sourceFileId: ids.sourceFileId
      },
      responseSnapshot: {
        completedAt: lifecycleAt,
        completedBy: IDS.actor,
        providerEnvelopeId: ids.esignEnvelopeId,
        providerTaskId: ids.esignProviderTaskId,
        signedFileHash,
        signedFileId: ids.signedFileId
      },
      signedDocumentObjectKey: `subscription-closure/${caseRow.id}/${ids.signedRevisionId}-recovery-authority.signed.json`,
      signingStage: "STAGE5_RECOVERY_AUTHORITY",
      sourceId: caseRow.id,
      sourceKey: sources[2]!.key,
      sourceType: "SUBSCRIPTION_CLOSURE",
      taskStatus: "COMPLETED"
    }))
  };
  tx.subscriptionClosureCommandReceipt.findMany = vi.fn(async () => receipts);
  tx.subscriptionClosureEvent.findMany = vi.fn(async () => events);
  tx.subscriptionClosureEvent.findFirst = vi.fn(async () => assessment);
  tx.auditLog = { findMany: vi.fn(async () => audits) };
  return { currentDocument, documentHash, ids };
}
