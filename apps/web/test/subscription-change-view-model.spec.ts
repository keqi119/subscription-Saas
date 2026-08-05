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
});
