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

    expect(harness.repository.escalateRecovery).toHaveBeenCalledWith(
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
      expect.any(Function)
    );
    const call = harness.repository.escalateRecovery.mock.calls[0] as unknown as readonly [
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
      expect(harness.repository.escalateRecovery).not.toHaveBeenCalled();
    }
  );

  it("durably replays the first no-op reason when server facts later change", async () => {
    const harness = recoveryHarness({ dispute: true });

    await expect(harness.service.assessRecoveryJob(recoveryInput())).resolves.toEqual({
      action: "NO_OP",
      reason: "LIVE_DISPUTE"
    });
    expect(harness.repository.appendEvent).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        afterStatus: "PREPARING_RETURN",
        detailSnapshot: expect.objectContaining({
          reason: "LIVE_DISPUTE",
          recoveryAction: "ASSESSMENT_NO_OP"
        }),
        eventType: "NOTE_ADDED"
      }),
      expect.any(Function)
    );

    harness.tx.collectionCase.findMany.mockResolvedValue([]);
    harness.tx.receivableBill.findMany.mockResolvedValue([]);
    await expect(harness.service.assessRecoveryJob(recoveryInput())).resolves.toEqual({
      action: "NO_OP",
      reason: "LIVE_DISPUTE"
    });
    expect(harness.repository.appendEvent).toHaveBeenCalledTimes(1);
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
    expect(harness.accounting.requestApprovalInTransaction).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        exceptionType: "RECOVERY_EXECUTION_APPROVAL",
        subject: {
          subjectField: "recoveryExecution",
          subjectId: IDS.case,
          subjectType: "RECOVERY_CASE"
        }
      }),
      expect.objectContaining({ actorId: IDS.actor }),
      expect.any(Function)
    );
    expect(harness.resolvedAuthority).toEqual({
      closureCaseId: IDS.case,
      orderId: IDS.order,
      recoveryAssetWorkOrderId: "20000000-0000-4000-8000-000000000021",
      recoveryAuthorityRevisionId: "20000000-0000-4000-8000-000000000022",
      recoveryAuthoritySnapshotHash: "a".repeat(64),
      recoveryContextSnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      vehicleId: IDS.vehicle
    });
    expect(harness.repository.appendEvent).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        afterStatus: "RECOVERY_APPROVAL_PENDING",
        expectedStatus: "RECOVERY_ASSESSMENT_PENDING"
      }),
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
    expect(approved.repository.appendEvent).toHaveBeenCalledWith(
      approved.tx,
      expect.objectContaining({ afterStatus: "RECOVERY_APPROVED" }),
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
    expect(rejected.repository.appendEvent).toHaveBeenCalledWith(
      rejected.tx,
      expect.objectContaining({ afterStatus: "REJECTED" }),
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
          recoveryAuthorityRevisionId: "20000000-0000-4000-8000-000000000022"
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
    appendEvent: vi.fn(async (_tx, command) => {
      receipt = { payloadSnapshot: command };
      return { outcome: { case: { id: IDS.case } }, wrote: true };
    }),
    escalateRecovery: vi.fn(async () => ({ outcome: { case: { id: IDS.case } }, wrote: true }))
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
  return { prisma, repository, service, tx };
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

function recoveryApprovalHarness(options: { decision?: "APPROVED" | "REJECTED" } = {}) {
  const plannedWorkOrderId = "20000000-0000-4000-8000-000000000021";
  const revisionId = "20000000-0000-4000-8000-000000000022";
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
  const currentDocument = {
    documentRevision: {
      archivedAt: new Date("2026-09-08T02:00:00.000Z"),
      documentSnapshot: {
        caseNo: "CLS-1",
        closureCaseId: IDS.case,
        contractId: caseRow.contractId,
        customerId: IDS.customer,
        documentType: "RECOVERY_AUTHORITY",
        finalDisposition: "TERMINATE",
        orderId: IDS.order,
        physicalControlMode: "RECOVERY",
        recoveryAssetWorkOrderId: plannedWorkOrderId,
        recoveryWorkOrderType: "RECOVERY",
        vehicleId: IDS.vehicle,
        vehicleReturnId: IDS.vehicleReturn
      },
      documentSnapshotHash: "a".repeat(64),
      documentType: "RECOVERY_AUTHORITY",
      id: revisionId,
      stage: "ARCHIVED"
    }
  };
  const tx = {
    ...recoveryApprovalContextTx(plannedWorkOrderId),
    subscriptionClosureCase: { findUnique: vi.fn(async () => caseRow) },
    subscriptionClosureCurrentDocument: { findUnique: vi.fn(async () => currentDocument) },
    subscriptionClosureEvent: { findFirst: vi.fn(async () => assessment) }
  };
  let resolvedAuthority: unknown;
  const accounting = {
    decideApprovalInTransaction: vi.fn(async (_tx, _command, _context, resolver) => {
      resolvedAuthority = await resolver();
      return {
        decision: options.decision,
        id: "20000000-0000-4000-8000-000000000020",
        status: options.decision,
        version: 1
      };
    }),
    requestApprovalInTransaction: vi.fn(async (_tx, _command, _context, resolver) => {
      resolvedAuthority = await resolver();
      return {
        id: "20000000-0000-4000-8000-000000000020",
        status: "PENDING",
        version: 0
      };
    })
  };
  const repository = {
    appendEvent: vi.fn(async () => ({ outcome: { case: caseRow }, wrote: true }))
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
  const revision = {
    archivedAt: new Date("2026-09-08T02:00:00.000Z"),
    documentSnapshot: {
      closureCaseId: IDS.case,
      orderId: IDS.order,
      recoveryAssetWorkOrderId: plannedWorkOrderId,
      recoveryWorkOrderType: "RECOVERY",
      vehicleId: IDS.vehicle
    },
    documentSnapshotHash: "a".repeat(64),
    documentType: "RECOVERY_AUTHORITY",
    id: "20000000-0000-4000-8000-000000000022",
    stage: "ARCHIVED"
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
    subscriptionClosureCurrentDocument: {
      findUnique: vi.fn(async () => ({ documentRevision: revision }))
    },
    subscriptionClosureEvent: {
      findFirst: vi.fn(async () => ({
        detailSnapshot: { plannedRecoveryAssetWorkOrderId: plannedWorkOrderId }
      }))
    },
    subscriptionContractSegment: {
      findFirst: vi.fn(async () =>
        options.extension ? { id: "20000000-0000-4000-8000-000000000025", status: "ACTIVE" } : null
      )
    }
  };
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
  return { accounting, operations, repository, service, session, timeline, tx };
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
  const recoveryAuthority = {
    closureCaseId: IDS.case,
    orderId: IDS.order,
    recoveryAssetWorkOrderId: workOrder.id,
    recoveryAuthorityRevisionId: "20000000-0000-4000-8000-000000000022",
    recoveryAuthoritySnapshotHash: "a".repeat(64),
    recoveryContextSnapshotHash: recoveryApprovalContextHash(workOrder.id),
    vehicleId: IDS.vehicle
  };
  const approval = {
    decidedAt: new Date("2026-09-08T05:00:00.000Z"),
    decidedBy: IDS.actor,
    id: "20000000-0000-4000-8000-000000000020",
    requestedBy: "20000000-0000-4000-8000-000000000023",
    subjectSnapshot: recoveryAuthority,
    subjectSnapshotHash: createHash("sha256")
      .update(JSON.stringify(recoveryAuthority))
      .digest("hex")
  };
  const revision = {
    archivedAt: new Date("2026-09-08T04:00:00.000Z"),
    documentSnapshot: {
      closureCaseId: IDS.case,
      orderId: IDS.order,
      recoveryAssetWorkOrderId: workOrder.id,
      recoveryWorkOrderType: "RECOVERY",
      vehicleId: IDS.vehicle
    },
    documentSnapshotHash: "a".repeat(64),
    documentType: "RECOVERY_AUTHORITY",
    id: recoveryAuthority.recoveryAuthorityRevisionId,
    stage: "ARCHIVED"
  };
  const tx = {
    ...recoveryApprovalContextTx(workOrder.id),
    assetWorkOrder: { findUnique: vi.fn(async () => workOrder) },
    businessExceptionApproval: {
      findFirst: vi.fn(async () => approval),
      findUnique: vi.fn(async () => approval)
    },
    subscriptionClosureCase: { findUnique: vi.fn(async () => caseRow) },
    subscriptionClosureCommandReceipt: { findUnique: vi.fn(async () => null) },
    subscriptionClosureCurrentDocument: {
      findUnique: vi.fn(async () => ({ documentRevision: revision }))
    },
    subscriptionClosureEvent: {
      findFirst: vi.fn(async () => ({
        detailSnapshot: { plannedRecoveryAssetWorkOrderId: workOrder.id }
      }))
    }
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
  return { accounting, caseRow, operations, repository, service, session, tx, workOrder };
}

function recoveryApprovalContextTx(plannedWorkOrderId: string) {
  void plannedWorkOrderId;
  return {
    collectionCase: { findMany: vi.fn(async () => []) },
    receivableBill: {
      findMany: vi.fn(async () => [
        {
          billStatus: "OVERDUE",
          dueDate: new Date("2026-09-01T00:00:00.000Z"),
          id: IDS.bill,
          remainingAmount: 900n
        }
      ])
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
