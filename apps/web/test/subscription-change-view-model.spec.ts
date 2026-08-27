import { describe, expect, it } from "vitest";

import type { AdminSubscriptionChange } from "../src/lib/subscription-change-api";
import {
  getLatestFailedSubscriptionChangeJob,
  getSubscriptionChangeContractDates,
  getSubscriptionChangeNextAction,
  getSubscriptionChangePriceApproval
} from "../src/lib/subscription-change-view-model";

function change(
  input: Partial<AdminSubscriptionChange> = {}
): AdminSubscriptionChange {
  return {
    automationJobs: [],
    changeNo: "CHG202608050001",
    changeType: "EXTENSION",
    completionDeadlineAt: "2026-09-03T15:59:59.000Z",
    contract: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    currentQuote: null,
    extensionMonths: 6,
    id: "change-1",
    order: {
      id: "order-1",
      orderNo: "ORD202608050001",
      vehicle: { plateNo: "沪A12345" }
    },
    orderId: "order-1",
    priceOverrideApprovedAt: null,
    priceOverrideApprovedBy: null,
    priceOverrideReason: null,
    pricingMode: "CURRENT_VERSION",
    quotes: [],
    renewalConsideration: null,
    sourceSegment: {
      endDate: "2026-09-02T00:00:00.000Z",
      id: "segment-1",
      monthlyFeeAmount: "100000",
      startDate: "2026-03-03T00:00:00.000Z"
    },
    status: "DRAFT",
    targetEndDate: "2027-03-02T00:00:00.000Z",
    targetSegment: null,
    targetStartDate: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    version: 0,
    ...input
  };
}

describe("subscription change view model", () => {
  it.each([
    [change(), { enabled: true, kind: "QUOTE", label: "生成正式报价" }],
    [
      change({
        currentQuote: {
          createdBy: "operator-1",
          id: "quote-1",
          monthlyFeeAmount: "90000",
          pricingMode: "APPROVED_DISCOUNT",
          quoteNo: "SCQ001",
          revision: 1,
          status: "FORMAL",
          validUntil: "2099-08-08T00:00:00.000Z"
        },
        pricingMode: "APPROVED_DISCOUNT",
        status: "QUOTED"
      }),
      { enabled: true, kind: "APPROVE_PRICE", label: "审批价格例外" }
    ],
    [
      change({
        currentQuote: {
          createdBy: "operator-1",
          id: "quote-1",
          monthlyFeeAmount: "100000",
          pricingMode: "CURRENT_VERSION",
          quoteNo: "SCQ001",
          revision: 1,
          status: "FORMAL",
          validUntil: "2099-08-08T00:00:00.000Z"
        },
        status: "QUOTED"
      }),
      { enabled: true, kind: "WAIT_CUSTOMER", label: "发布给客户确认" }
    ],
    [
      change({
        currentQuote: {
          createdBy: "operator-1",
          id: "quote-1",
          monthlyFeeAmount: "100000",
          pricingMode: "CURRENT_VERSION",
          quoteNo: "SCQ001",
          revision: 1,
          status: "FORMAL",
          validUntil: "2099-08-08T00:00:00.000Z"
        },
        customerConfirmationPublishedAt: "2026-08-05T01:00:00.000Z",
        status: "QUOTED"
      }),
      { enabled: false, kind: "WAIT_CUSTOMER", label: "等待客户确认" }
    ],
    [
      change({ status: "CUSTOMER_CONFIRMED" }),
      { enabled: true, kind: "GENERATE_CONTRACT", label: "生成补充协议" }
    ],
    [
      change({ contract: { contractNo: "CON001", id: "contract-1", status: "GENERATED" }, status: "SIGNING_OR_PAYMENT" }),
      { enabled: true, kind: "START_ESIGN", label: "发起电子签" }
    ],
    [
      change({ contract: { contractNo: "CON001", id: "contract-1", status: "SIGNING" }, status: "SIGNING_OR_PAYMENT" }),
      { enabled: false, kind: "WAIT_ARCHIVE", label: "等待签署归档" }
    ],
    [
      change({ contract: { archivedAt: "2026-08-06T00:00:00.000Z", contractNo: "CON001", id: "contract-1", status: "ARCHIVED" }, status: "SCHEDULED" }),
      { enabled: false, kind: "WAIT_EFFECTIVE", label: "等待续期生效" }
    ],
    [
      change({ automationJobs: [{ id: "job-1", jobStatus: "DEAD_LETTER", jobType: "EXTENSION_BILLING_RESUME", lastErrorMessage: "timeout" }], status: "FAILED" }),
      { enabled: true, kind: "RETRY", label: "重试失败任务" }
    ],
    [
      change({
        automationJobs: [{ id: "job-1", jobStatus: "DEAD_LETTER", jobType: "EXTENSION_BILLING_RESUME" }],
        manualTakeoverReason: "自动重试已耗尽",
        status: "MANUAL_TAKEOVER"
      }),
      { enabled: true, kind: "RETRY", label: "重试失败任务" }
    ],
    [
      change({ manualTakeoverReason: "供应商持续失败", status: "MANUAL_TAKEOVER" }),
      { enabled: false, kind: "MANUAL", label: "需要人工接管" }
    ],
    [change({ status: "COMPLETED" }), { enabled: false, kind: "DONE", label: "续期已完成" }]
  ] as const)("maps lifecycle state to one explicit next action", (input, expected) => {
    expect(getSubscriptionChangeNextAction(input)).toMatchObject(expected);
  });

  it("keeps original end and contracted-through as distinct facts", () => {
    expect(
      getSubscriptionChangeContractDates(
        change({
          status: "COMPLETED",
          targetSegment: {
            endDate: "2027-03-02T00:00:00.000Z",
            id: "segment-2",
            monthlyFeeAmount: "90000",
            startDate: "2026-09-03T00:00:00.000Z"
          }
        })
      )
    ).toEqual({
      contractedThrough: "2027-03-02T00:00:00.000Z",
      originalEndDate: "2026-09-02T00:00:00.000Z",
      proposedEndDate: "2027-03-02T00:00:00.000Z"
    });
  });

  it("exposes baseline, proposed amount, difference, reason, submitter and approver", () => {
    expect(
      getSubscriptionChangePriceApproval(
        change({
          currentQuote: {
            createdBy: "operator-1",
            id: "quote-1",
            monthlyFeeAmount: "90000",
            priceRuleSnapshot: { baselineMonthlyFeeAmount: "100000" },
            pricingMode: "APPROVED_DISCOUNT",
            quoteNo: "SCQ001",
            revision: 1,
            status: "FORMAL",
            validUntil: "2026-08-08T00:00:00.000Z"
          },
          priceOverrideApprovedBy: "approver-1",
          priceOverrideReason: "续订优惠"
        })
      )
    ).toEqual({
      approvedBy: "approver-1",
      baselineMonthlyFeeAmount: "100000",
      createdBy: "operator-1",
      differenceAmount: "-10000",
      proposedMonthlyFeeAmount: "90000",
      reason: "续订优惠"
    });
  });

  it("does not offer a retry for dead-letter jobs outside the backend allowlist", () => {
    const input = change({
      automationJobs: [{ id: "job-1", jobStatus: "DEAD_LETTER", jobType: "BILL_GENERATE" }],
      manualTakeoverReason: "自动重试已耗尽",
      status: "MANUAL_TAKEOVER"
    });

    expect(getLatestFailedSubscriptionChangeJob(input)).toBeNull();
    expect(getSubscriptionChangeNextAction(input)).toMatchObject({
      enabled: false,
      kind: "MANUAL"
    });
  });

  it.each([
    [
      change({
        allowedActions: ["CREATE_QUOTE"],
        changeType: "VEHICLE_SWAP",
        detail: {
          plannedSwapAt: "2026-09-15T02:00:00.000Z",
          sourceVehicleId: "vehicle-source",
          targetSubscriptionPlanId: "plan-target",
          targetVehicleId: "vehicle-target",
          targetVehiclePackageId: "package-target"
        },
        status: "DRAFT"
      } as never),
      { enabled: true, kind: "QUOTE", label: "生成换车报价" }
    ],
    [
      change({
        allowedActions: ["PUBLISH_CUSTOMER_CONFIRMATION"],
        changeType: "EARLY_TERMINATION",
        detail: {
          effectiveDate: "2026-09-30",
          reasonSnapshot: { currentEstimate: { revision: 1 } }
        },
        status: "QUOTED"
      } as never),
      { enabled: true, kind: "WAIT_CUSTOMER", label: "发布提前结束方案" }
    ],
    [
      change({
        allowedActions: ["APPROVE"],
        changeType: "MANAGED_OTHER",
        detail: {
          approvedOperationSnapshot: {
            approval: null,
            request: { operation: "UPDATE_CONTACT_PREFERENCE" }
          },
          effectiveDate: "2026-09-30"
        },
        status: "DRAFT"
      } as never),
      { enabled: true, kind: "APPROVE_MANAGED_OTHER", label: "审批受控变更" }
    ],
    [
      change({
        allowedActions: ["EXECUTE", "CANCEL"],
        changeType: "MANAGED_OTHER",
        detail: {
          approvedOperationSnapshot: {
            approval: { approvalReference: "APR-1" },
            request: { operation: "UPDATE_CONTACT_PREFERENCE" }
          },
          effectiveDate: "2026-09-30"
        },
        status: "SCHEDULED"
      } as never),
      { enabled: true, kind: "EXECUTE_MANAGED_OTHER", label: "记录受控变更结果" }
    ]
  ] as const)("maps each typed backend action to its governed UI action", (input, expected) => {
    expect(getSubscriptionChangeNextAction(input)).toMatchObject(expected);
  });

  it("does not invent a quote action when the backend did not allow it", () => {
    expect(
      getSubscriptionChangeNextAction(
        change({ allowedActions: [], status: "DRAFT" } as never)
      )
    ).toMatchObject({
      enabled: false,
      kind: "MANUAL",
      reason: "当前状态未开放人工操作"
    });
  });

  it.each([
    change({
      allowedActions: [],
      currentQuote: {
        createdBy: "operator-1",
        id: "quote-1",
        monthlyFeeAmount: "90000",
        pricingMode: "APPROVED_DISCOUNT",
        quoteNo: "SCQ001",
        revision: 1,
        status: "FORMAL",
        validUntil: "2099-08-08T00:00:00.000Z"
      },
      pricingMode: "APPROVED_DISCOUNT",
      status: "QUOTED"
    }),
    change({ allowedActions: [], status: "CUSTOMER_CONFIRMED" }),
    change({
      allowedActions: [],
      contract: { contractNo: "CON001", id: "contract-1", status: "GENERATED" },
      status: "SIGNING_OR_PAYMENT"
    }),
    change({
      allowedActions: [],
      automationJobs: [
        { id: "job-1", jobStatus: "DEAD_LETTER", jobType: "EXTENSION_BILLING_RESUME" }
      ],
      status: "FAILED"
    }),
    change({
      allowedActions: [],
      automationJobs: [
        { id: "job-1", jobStatus: "DEAD_LETTER", jobType: "EXTENSION_BILLING_RESUME" }
      ],
      status: "MANUAL_TAKEOVER"
    })
  ])("does not invent a governed action when allowedActions is empty", (input) => {
    expect(getSubscriptionChangeNextAction(input)).toMatchObject({
      enabled: false,
      kind: "MANUAL",
      reason: "当前状态未开放人工操作"
    });
  });
});
