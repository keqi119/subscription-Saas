import { describe, expect, it } from "vitest";

import {
  buildMileageReviewSettlementView,
  getMileageReviewActions,
  getMileageReviewPresentation,
  getPortalMileageReviewGuidance,
  isMileageReviewOverdue,
  sortMileageReviewQueue,
  validateMileageReviewSubmission,
  type MileageReviewView
} from "../src/lib/mileage-review-view-model";

const now = new Date("2026-09-03T04:00:00.000Z");

describe("mileage review view model", () => {
  it("maps workflow states and derives overdue without persisting a second status", () => {
    expect(getMileageReviewPresentation("PENDING_REVIEW", false)).toEqual({
      color: "blue",
      label: "待后台复核"
    });
    expect(getMileageReviewPresentation("PENDING_SUBMISSION", true)).toEqual({
      color: "red",
      label: "逾期待提交"
    });
    expect(getMileageReviewPresentation("FUTURE_STATE", false)).toEqual({
      color: "default",
      label: "FUTURE_STATE"
    });
    expect(
      isMileageReviewOverdue(
        review({ dueAt: "2026-09-02T15:59:59.000Z", status: "PENDING_SUBMISSION" }),
        now
      )
    ).toBe(true);
    expect(
      isMileageReviewOverdue(
        review({ dueAt: "2026-09-02T15:59:59.000Z", status: "RETURNED" }),
        now
      )
    ).toBe(false);
  });

  it("puts overdue work first and then sorts by scheduled time", () => {
    const items = [
      review({ id: "future", scheduledReviewAt: "2026-09-04T00:00:00.000Z" }),
      review({ id: "later", scheduledReviewAt: "2026-09-03T02:00:00.000Z" }),
      review({
        dueAt: "2026-09-02T00:00:00.000Z",
        id: "overdue",
        scheduledReviewAt: "2026-09-01T00:00:00.000Z"
      }),
      review({ id: "earlier", scheduledReviewAt: "2026-09-03T01:00:00.000Z" })
    ];

    expect(sortMileageReviewQueue(items, now).map((item) => item.id)).toEqual([
      "overdue",
      "earlier",
      "later",
      "future"
    ]);
  });

  it("exposes only actions allowed by state, role, and final-order read-only policy", () => {
    expect(getMileageReviewActions(review(), "PORTAL")).toEqual({
      canConfirm: false,
      canEdit: true,
      canReturn: false,
      canSubmit: true,
      canVoid: false
    });
    expect(
      getMileageReviewActions(
        review({ order: { id: "order", orderNo: "ORD1", orderStatus: "COMPLETED" } }),
        "PORTAL"
      ).canEdit
    ).toBe(false);
    expect(getMileageReviewActions(review({ status: "PENDING_REVIEW" }), "ADMIN")).toMatchObject({
      canConfirm: true,
      canReturn: true,
      canSubmit: false
    });
    expect(getMileageReviewActions(review({ status: "CONFIRMED" }), "ADMIN").canVoid).toBe(true);
  });

  it("requires a cumulative mileage, reading time, and at least one dashboard image", () => {
    expect(
      validateMileageReviewSubmission({
        baselineMileageKm: 10_000,
        evidenceCount: 0,
        readingAt: null,
        submittedMileageKm: 9_999
      })
    ).toEqual([
      "累计里程不能低于本周期基线",
      "请填写里程读取时间",
      "请至少上传一张清晰的仪表盘照片"
    ]);
    expect(
      validateMileageReviewSubmission({
        baselineMileageKm: 10_000,
        evidenceCount: 1,
        readingAt: "2026-09-02T08:00:00.000Z",
        submittedMileageKm: 10_650
      })
    ).toEqual([]);
  });

  it("shows confirmed usage, allowance, overage, and the independent bill link", () => {
    const view = buildMileageReviewSettlementView(
      review({
        allowanceKm: 500,
        consumedAllowanceKm: 500,
        overMileageAmount: "22500",
        overMileageBillId: "bill-1",
        overMileageKm: 150,
        status: "CONFIRMED",
        submittedMileageKm: 10_650
      })
    );

    expect(view).toMatchObject({
      actualUsageKm: 650,
      allowanceKm: 500,
      overMileageAmount: 22500,
      overMileageBillHref: "/portal/bills/bill-1",
      overMileageKm: 150
    });
  });

  it("keeps Portal guidance active until submission and exposes read-only history afterwards", () => {
    expect(getPortalMileageReviewGuidance(review())).toMatchObject({
      actionLabel: "提交本月里程",
      href: "/portal/mileage-reviews/review-1",
      kind: "ACTION"
    });
    expect(getPortalMileageReviewGuidance(review({ status: "PENDING_REVIEW" })).kind).toBe("WAITING");
    expect(
      getPortalMileageReviewGuidance(
        review({ order: { id: "order", orderNo: "ORD1", orderStatus: "COMPLETED" }, status: "CONFIRMED" })
      )
    ).toMatchObject({ kind: "HISTORY", readOnly: true });
  });
});

function review(overrides: Partial<MileageReviewView> = {}): MileageReviewView {
  return {
    allowanceKm: null,
    baselineMileageKm: 10_000,
    consumedAllowanceKm: null,
    cycleNo: 1,
    dueAt: "2026-09-05T15:59:59.000Z",
    evidence: [],
    id: "review-1",
    lockVersion: 0,
    order: { id: "order", orderNo: "ORD1", orderStatus: "ACTIVE" },
    overMileageAmount: null,
    overMileageBillId: null,
    overMileageKm: null,
    periodEnd: "2026-09-01T15:59:59.999Z",
    periodStart: "2026-08-01T16:00:00.000Z",
    readingAt: null,
    scheduledReviewAt: "2026-09-01T16:00:00.000Z",
    status: "PENDING_SUBMISSION",
    submittedMileageKm: null,
    vehicle: { brand: "NIO", id: "vehicle", model: "ET5", plateNo: "沪A12345", vin: "VIN1" },
    version: 1,
    ...overrides
  };
}
