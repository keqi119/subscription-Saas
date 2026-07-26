import { describe, expect, it } from "vitest";

import type { Stage2PortalESignView } from "../src/lib/portal-handover-review-api";
import {
  buildPortalHandoverESignView,
  validatePortalHandoverSigningRedirect
} from "../src/lib/portal-handover-esign-view-model";

describe("Portal Stage 2 handover eSign view model", () => {
  it.each([
    {
      expected: "等待工作人员发起签署",
      input: createStatus()
    },
    {
      expected: "待您签署",
      input: createStatus({
        capability: { canStartSigning: true },
        status: "WAITING_CUSTOMER",
        taskId: "task-1"
      })
    },
    {
      expected: "您已签署，等待平台签署",
      input: createStatus({
        customerSigner: {
          signedAt: "2026-07-27T08:10:00.000Z",
          slotId: "STAGE2_HANDOVER_CUSTOMER",
          status: "SIGNED"
        },
        status: "SIGNING",
        taskId: "task-1"
      })
    },
    {
      expected: "双方已签署，文件归档中",
      input: createStatus({
        archiveStatus: "PENDING",
        customerSigner: {
          signedAt: "2026-07-27T08:10:00.000Z",
          slotId: "STAGE2_HANDOVER_CUSTOMER",
          status: "SIGNED"
        },
        platformSigner: {
          signedAt: "2026-07-27T08:12:00.000Z",
          slotId: "STAGE2_HANDOVER_PLATFORM",
          status: "SIGNED"
        },
        status: "COMPLETED",
        taskId: "task-1"
      })
    },
    {
      expected: "签署已完成",
      input: createStatus({
        archiveStatus: "ARCHIVED",
        customerSigner: {
          signedAt: "2026-07-27T08:10:00.000Z",
          slotId: "STAGE2_HANDOVER_CUSTOMER",
          status: "SIGNED"
        },
        platformSigner: {
          signedAt: "2026-07-27T08:12:00.000Z",
          slotId: "STAGE2_HANDOVER_PLATFORM",
          status: "SIGNED"
        },
        signedArtifactAvailable: true,
        status: "COMPLETED",
        taskId: "task-1"
      })
    }
  ])("maps the lifecycle to customer copy: $expected", ({ expected, input }) => {
    expect(buildPortalHandoverESignView(input).statusLabel).toBe(expected);
  });

  it("maps only known safe blocker codes and replaces unknown values with generic copy", () => {
    const view = buildPortalHandoverESignView(createStatus({
      blockers: [
        {
          code: "CUSTOMER_CONFIRMATION_MISSING",
          message: "Customer no-objection confirmation is required."
        },
        {
          code: "INTERNAL_PROVIDER_TRANSACTION_MISSING",
          message: "FADADA appId and transaction details"
        } as never
      ]
    }));

    expect(view.blockers).toEqual([
      "请先完成车辆交接资料确认",
      "签署暂未开放，请稍后刷新"
    ]);
    expect(JSON.stringify(view)).not.toMatch(/FADADA|appId|transaction/i);
  });

  it("accepts only HTTPS provider redirects without embedded credentials", () => {
    expect(validatePortalHandoverSigningRedirect("https://provider.example/sign?id=1")).toBe(
      "https://provider.example/sign?id=1"
    );
    expect(() => validatePortalHandoverSigningRedirect("http://provider.example/sign")).toThrow(
      "签署链接无效，请稍后重试"
    );
    expect(() => validatePortalHandoverSigningRedirect("javascript:alert(1)")).toThrow(
      "签署链接无效，请稍后重试"
    );
    expect(() => validatePortalHandoverSigningRedirect(
      "https://user:password@provider.example/sign"
    )).toThrow("签署链接无效，请稍后重试");
  });
});

function createStatus(
  overrides: Partial<Stage2PortalESignView> = {}
): Stage2PortalESignView {
  return {
    archiveStatus: null,
    blockers: [],
    capability: { canStartSigning: false },
    createdAt: null,
    customerSigner: {
      signedAt: null,
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      status: null
    },
    documentType: "DELIVERY_HANDOVER",
    handoverId: null,
    platformSigner: {
      signedAt: null,
      slotId: "STAGE2_HANDOVER_PLATFORM",
      status: null
    },
    ready: false,
    signedArtifactAvailable: false,
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    status: null,
    taskId: null,
    updatedAt: null,
    workOrderId: "review-1",
    ...overrides
  };
}
