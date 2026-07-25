import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmPortalHandoverReview,
  getPortalHandoverReview,
  getPortalHandoverReviewErrorMessage,
  listPortalHandoverReviews,
  objectPortalHandoverReview
} from "../src/lib/portal-handover-review-api";
import { PORTAL_API_BASE_URL, PortalApiError } from "../src/lib/portal-api";

describe("portal handover review API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses customer-scoped Portal handover review endpoints with cookies included", async () => {
    const fetchMock = mockJsonSequence([
      [{ id: "review-1", orderNo: "ORD-PORTAL-001" }],
      { id: "review-1", orderNo: "ORD-PORTAL-001" },
      { id: "review-1", status: "CUSTOMER_CONFIRMED" },
      { id: "review-1", status: "CUSTOMER_OBJECTED" }
    ]);

    await listPortalHandoverReviews();
    await getPortalHandoverReview("review/with space");
    await confirmPortalHandoverReview("review-1", true, `sha256:${"a".repeat(64)}`);
    await objectPortalHandoverReview("review-1", {
      details: "右前轮毂需复核",
      reason: "车辆外观有异议"
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${PORTAL_API_BASE_URL}/portal/handover-reviews`,
      `${PORTAL_API_BASE_URL}/portal/handover-reviews/review%2Fwith%20space`,
      `${PORTAL_API_BASE_URL}/portal/handover-reviews/review-1/confirm`,
      `${PORTAL_API_BASE_URL}/portal/handover-reviews/review-1/object`
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ credentials: "include" }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          acknowledgement: true,
          manifestHash: `sha256:${"a".repeat(64)}`
        }),
        credentials: "include",
        method: "POST"
      })
    );
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ details: "右前轮毂需复核", reason: "车辆外观有异议" }),
        credentials: "include",
        method: "POST"
      })
    );
  });

  it("normalizes Portal review action errors into customer-friendly copy", () => {
    expect(getPortalHandoverReviewErrorMessage(new PortalApiError("Unauthorized", 401))).toBe(
      "登录状态已过期，请重新登录"
    );
    expect(getPortalHandoverReviewErrorMessage(new PortalApiError("交付复核不存在。", 404))).toBe(
      "交接确认事项不存在或已关闭"
    );
    expect(getPortalHandoverReviewErrorMessage(new PortalApiError("客户已确认无异议。", 400))).toBe(
      "客户已确认无异议。"
    );
    expect(getPortalHandoverReviewErrorMessage(new Error("network"))).toBe("操作失败，请稍后重试");
  });
});

function mockJsonSequence(bodies: unknown[]) {
  const fetchMock = vi.fn().mockImplementation(() => {
    const body = bodies.shift() ?? {};
    return Promise.resolve(new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200
    }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
