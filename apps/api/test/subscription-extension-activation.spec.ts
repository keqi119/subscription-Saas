import {
  ContractSegmentStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { NotificationService } from "../src/notification/notification.service";
import { SubscriptionExtensionActivationService } from "../src/subscription-change/subscription-extension-activation.service";

describe("SubscriptionExtensionActivationService", () => {
  it("activates the scheduled segment, completes the prior segment, and enqueues stable continuation jobs", async () => {
    const harness = createActivationHarness();

    await expect(
      harness.service.activate("segment-extension", new Date("2026-09-03T00:00:00.000Z"))
    ).resolves.toEqual({
      changeStatus: SubscriptionChangeStatus.EXECUTING,
      segmentStatus: ContractSegmentStatus.ACTIVE
    });

    expect(harness.state.source.status).toBe(ContractSegmentStatus.COMPLETED);
    expect(harness.state.target.status).toBe(ContractSegmentStatus.ACTIVE);
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.EXECUTING);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          changeStatus: SubscriptionChangeStatus.EXECUTING,
          segmentStatus: ContractSegmentStatus.ACTIVE
        }),
        entityId: "segment-extension",
        entityType: "subscription_contract_segment"
      }),
      expect.anything()
    );
    expect(harness.enqueued.map((job) => [job.jobType, job.idempotencyKey])).toEqual([
      [
        SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
        "extension-billing-resume:order-1:segment-extension"
      ],
      [
        SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE,
        "extension-effective-notice:order-1:segment-extension"
      ],
      [
        SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
        "extension-entitlement:order-1:segment-extension:2026-09-03:MILEAGE:KM"
      ]
    ]);
  });

  it("moves the change to COMPLETED only after every continuation job has completed", async () => {
    const harness = createActivationHarness();
    await harness.service.activate("segment-extension", new Date("2026-09-03T00:00:00.000Z"));

    harness.jobs.push(
      ...harness.enqueued.map((job, index) => ({
        ...job,
        id: `job-${index + 1}`,
        jobStatus: SubscriptionAutomationJobStatus.COMPLETED
      }))
    );

    await expect(harness.service.completeIfReady("change-1")).resolves.toEqual({
      completed: true
    });
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.COMPLETED);
    expect(harness.auditService.write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ status: SubscriptionChangeStatus.COMPLETED }),
        entityId: "change-1",
        entityType: "subscription_change_order"
      }),
      expect.anything()
    );
  });

  it("moves the change to manual takeover after a continuation job exhausts retries", async () => {
    const harness = createActivationHarness();
    await harness.service.activate(
      "segment-extension",
      new Date("2026-09-03T00:00:00.000Z")
    );

    await harness.service.markManualTakeover(
      {
        changeOrderId: "change-1",
        id: "job-dead",
        jobType: SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME
      },
      { code: "SUBSCRIPTION_CHANGE_JOB_FAILED", message: "billing unavailable" }
    );

    expect(harness.state.change).toMatchObject({
      failureCode: "SUBSCRIPTION_CHANGE_JOB_FAILED",
      failureMessage: "billing unavailable",
      status: SubscriptionChangeStatus.MANUAL_TAKEOVER
    });
    expect(harness.auditService.write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          failureCode: "SUBSCRIPTION_CHANGE_JOB_FAILED",
          status: SubscriptionChangeStatus.MANUAL_TAKEOVER
        }),
        entityId: "change-1"
      }),
      expect.anything()
    );
  });

  it("moves a scheduled change to manual takeover when the activation job itself exhausts retries", async () => {
    const harness = createActivationHarness();

    await harness.service.markManualTakeover(
      {
        changeOrderId: "change-1",
        id: "job-activate-dead",
        jobType: SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE
      },
      { code: "SUBSCRIPTION_CHANGE_JOB_FAILED", message: "activation conflict" }
    );

    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.MANUAL_TAKEOVER);
  });

  it("enqueues an account-period renewal even when the extension has no grant components", async () => {
    const harness = createActivationHarness({ packageSnapshot: {} });

    await harness.service.activate(
      "segment-extension",
      new Date("2026-09-03T00:00:00.000Z")
    );

    expect(harness.enqueued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey:
            "extension-entitlement:order-1:segment-extension:2026-09-03:ACCOUNT",
          jobType: SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
          payload: { periodStart: "2026-09-03" }
        })
      ])
    );
  });
});

describe("extension effective notice", () => {
  it("creates one in-app notice when a recovered worker repeats the same idempotency key", async () => {
    const records: Array<Record<string, unknown>> = [];
    const prisma = {
      notificationRecord: {
        create: vi.fn(async ({ data }) => {
          const record = { id: `notice-${records.length + 1}`, ...data };
          records.push(record);
          return record;
        }),
        findUnique: vi.fn(async ({ where }) =>
          records.find((record) => record.notificationNo === where.notificationNo) ?? null
        )
      }
    };
    const service = new NotificationService(
      { get: vi.fn(() => "https://staging-app.subauto.keybox.cloud") } as never,
      { send: vi.fn() } as never,
      prisma as never
    );
    const input = {
      changeOrderId: "change-1",
      contractedThrough: "2027-03-02",
      customerId: "customer-1",
      idempotencyKey: "extension-effective-notice:order-1:segment-extension",
      orderNo: "ORD-1",
      segmentId: "segment-extension"
    };

    await service.notifyExtensionEffectiveInApp(input);
    await service.notifyExtensionEffectiveInApp(input);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      customerId: "customer-1",
      notificationType: "SYSTEM",
      payload: expect.objectContaining({
        contractedThrough: "2027-03-02",
        segmentId: "segment-extension"
      }),
      url: "https://staging-app.subauto.keybox.cloud/portal/subscription-changes/change-1"
    });
  });
});

function createActivationHarness(
  planSnapshot: Record<string, unknown> = {
    packageSnapshot: {
      mileagePackage: { monthlyMileageKm: 1800 }
    }
  }
) {
  const state = {
    change: {
      id: "change-1",
      orderId: "order-1",
      status: SubscriptionChangeStatus.SCHEDULED,
      version: 3
    },
    source: {
      completedAt: null as Date | null,
      id: "segment-base",
      status: ContractSegmentStatus.ACTIVE
    },
    target: {
      endDate: new Date("2027-03-02T00:00:00.000Z"),
      id: "segment-extension",
      orderId: "order-1",
      planSnapshot,
      sourceChangeOrder: null as unknown,
      startDate: new Date("2026-09-03T00:00:00.000Z"),
      status: ContractSegmentStatus.SCHEDULED
    }
  };
  state.target.sourceChangeOrder = {
    ...state.change,
    sourceSegment: state.source
  };
  const enqueued: Array<Record<string, unknown>> = [];
  const jobs: Array<Record<string, unknown>> = [];
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(prisma)),
    subscriptionAutomationJob: {
      findMany: vi.fn(async ({ where }) =>
        jobs.filter((job) =>
          job.changeOrderId === where.changeOrderId && where.jobType.in.includes(job.jobType)
        )
      )
    },
    subscriptionChangeOrder: {
      findUnique: vi.fn(async () => state.change),
      updateMany: vi.fn(async ({ data, where }) => {
        if (
          where.status?.in &&
          !where.status.in.includes(state.change.status)
        ) return { count: 0 };
        if (
          typeof where.status === "string" &&
          state.change.status !== where.status
        ) return { count: 0 };
        Object.assign(state.change, {
          ...data,
          version: data.version?.increment
            ? state.change.version + data.version.increment
            : state.change.version
        });
        return { count: 1 };
      })
    },
    subscriptionContractSegment: {
      findUnique: vi.fn(async () => state.target),
      updateMany: vi.fn(async ({ data, where }) => {
        const segment = where.id === state.source.id ? state.source : state.target;
        if (where.status && segment.status !== where.status) return { count: 0 };
        Object.assign(segment, data);
        return { count: 1 };
      })
    }
  };
  const repository = {
    enqueue: vi.fn(async (_tx, input) => {
      enqueued.push(input);
      return { id: `queued-${enqueued.length}`, ...input };
    })
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new SubscriptionExtensionActivationService(
    prisma as never,
    repository as never,
    { resumeForExtension: vi.fn() } as never,
    { notifyExtensionEffectiveInApp: vi.fn() } as never,
    auditService as never
  );
  return { auditService, enqueued, jobs, service, state };
}
