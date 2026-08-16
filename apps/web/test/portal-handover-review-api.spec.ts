import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmPortalHandoverReview,
  getPortalHandoverReview,
  getPortalHandoverESign,
  getPortalHandoverESignErrorMessage,
  getPortalHandoverReviewErrorMessage,
  listPortalHandoverReviews,
  objectPortalHandoverReview,
  startPortalHandoverSigning
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

  it("loads safe Stage 2 status separately and only returns a sign URL from the intentional start action", async () => {
    const status = {
      archiveStatus: "NOT_STARTED",
      blockers: [],
      capability: {
        canStartSigning: true,
        reentryAvailableAt: null,
        reentryRemainingSeconds: 0
      },
      createdAt: "2026-07-27T08:00:00.000Z",
      customerSigner: {
        signedAt: null,
        slotId: "STAGE2_HANDOVER_CUSTOMER",
        status: "PENDING"
      },
      documentType: "DELIVERY_HANDOVER",
      handoverId: "handover-1",
      platformSigner: {
        signedAt: null,
        slotId: "STAGE2_HANDOVER_PLATFORM",
        status: "PENDING"
      },
      ready: true,
      signedArtifactAvailable: false,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      status: "WAITING_CUSTOMER",
      taskId: "task-1",
      updatedAt: "2026-07-27T08:00:00.000Z",
      workOrderId: "review-1"
    };
    const start = {
      expiresAt: "2026-07-27T08:30:00.000Z",
      signUrl: "https://provider.example/sign/customer"
    };
    const fetchMock = mockJsonSequence([status, start]);

    const loadedStatus = await getPortalHandoverESign("review/with space");
    const signingStart = await startPortalHandoverSigning("review/with space");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${PORTAL_API_BASE_URL}/portal/handover-reviews/review%2Fwith%20space/esign`,
      `${PORTAL_API_BASE_URL}/portal/handover-reviews/review%2Fwith%20space/esign/signing/start`
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      credentials: "include"
    }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      credentials: "include",
      method: "POST"
    }));
    expect(JSON.stringify(loadedStatus)).not.toContain("signUrl");
    expect(signingStart).toEqual(start);
  });

  it("maps Stage 2 signing failures without exposing backend or provider details", () => {
    expect(getPortalHandoverESignErrorMessage(new PortalApiError("Unauthorized", 401))).toBe(
      "登录状态已过期，请重新登录"
    );
    expect(getPortalHandoverESignErrorMessage(
      new PortalApiError("FADADA_CUSTOMER_SIGNING_NOT_READY: provider transaction missing", 400)
    )).toBe("当前暂不能发起签署，请刷新状态后重试");
    expect(getPortalHandoverESignErrorMessage(new PortalApiError("Forbidden", 403))).toBe(
      "车辆交接确认单签署事项不存在或不可用"
    );
    expect(getPortalHandoverESignErrorMessage(new PortalApiError("provider unavailable", 502))).toBe(
      "签署服务暂不可用，请稍后重试"
    );
    expect(getPortalHandoverESignErrorMessage(new Error("network"))).toBe(
      "签署服务暂不可用，请稍后重试"
    );
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
