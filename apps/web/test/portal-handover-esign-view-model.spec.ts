import { afterEach, describe, expect, it, vi } from "vitest";

import type { Stage2PortalESignView } from "../src/lib/portal-handover-review-api";
import {
  buildPortalHandoverESignView,
  validatePortalHandoverSigningRedirect
} from "../src/lib/portal-handover-esign-view-model";

describe("Portal Stage 2 handover eSign view model", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      expected: "等待经办人发起签署",
      input: createStatus()
    },
    {
      expected: "待客户签署",
      input: createStatus({
        capability: {
          canStartSigning: true,
          reentryAvailableAt: null,
          reentryRemainingSeconds: 0
        },
        status: "WAITING_CUSTOMER",
        taskId: "task-1"
      })
    },
    {
      expected: "平台盖章处理中",
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
      expected: "平台盖章处理中",
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

  it.each([
    "archiveStatus",
    "handover status",
    "signedDocumentFileId",
    "signedObjectKey",
    "signedPdfHash"
  ])(
    "does not label the archive complete when the API projection is missing %s",
    () => {
      const view = buildPortalHandoverESignView(
        createStatus({
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
          signedArtifactAvailable: false,
          status: "COMPLETED",
          taskId: "task-1"
        })
      );

      expect(view.statusLabel).toBe("平台盖章处理中");
      expect(view.description).toBe(
        "双方已完成签署，正在准备归档文件。"
      );
    }
  );

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

  it("suppresses obsolete signing blockers and exposes the signed PDF in the archived state", () => {
    const signedDocumentPreviewUrl =
      "/api/portal/handover-reviews/review-1/esign/signed-document/preview";
    const view = buildPortalHandoverESignView(
      createStatus({
        archiveStatus: "ARCHIVED",
        blockers: [
          {
            code: "STAGE2_SIGNING_NOT_AVAILABLE",
            message: "Stage 2 signing is not currently available."
          }
        ],
        signedArtifactAvailable: true,
        signedDocumentPreviewUrl,
        status: "COMPLETED",
        taskId: "task-1"
      } as never)
    );

    expect(view.blockers).toEqual([]);
    expect(view).toMatchObject({ signedDocumentPreviewUrl });
  });

  it("accepts HTTPS provider redirects without embedded credentials", () => {
    expect(validatePortalHandoverSigningRedirect("https://provider.example/sign?id=1")).toBe(
      "https://provider.example/sign?id=1"
    );
  });

  it.each([
    "http://localhost:3001/mock-sign?id=1",
    "http://127.0.0.1:3001/mock-sign",
    "http://[::1]:3001/mock-sign"
  ])("allows an HTTP loopback Mock-provider redirect outside production: %s", (url) => {
    vi.stubEnv("NODE_ENV", "development");

    expect(validatePortalHandoverSigningRedirect(url)).toBe(url);
  });

  it.each([
    "http://provider.example/sign",
    "http://localhost.evil.example/sign",
    "javascript:alert(1)",
    "https://user:password@provider.example/sign"
  ])("rejects unsafe or non-loopback signing redirects: %s", (url) => {
    vi.stubEnv("NODE_ENV", "development");

    expect(() => validatePortalHandoverSigningRedirect(url)).toThrow(
      "签署链接无效，请稍后重试"
    );
  });

  it("rejects an HTTP loopback redirect in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => validatePortalHandoverSigningRedirect("http://localhost:3001/mock-sign")).toThrow(
      "签署链接无效，请稍后重试"
    );
  });

  it("rejects credentials even on an HTTPS redirect", () => {
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
    capability: {
      canStartSigning: false,
      reentryAvailableAt: null,
      reentryRemainingSeconds: 0
    },
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
    signedDocumentPreviewUrl: null,
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    status: null,
    taskId: null,
    updatedAt: null,
    workOrderId: "review-1",
    ...overrides
  };
}
