import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api";
import {
  getAdminStage2HandoverESignDisplay,
  getAdminStage2HandoverESignErrorMessage,
  loadAdminStage2HandoverESign,
  retryAdminStage2HandoverArchive,
  retryAdminStage2PlatformSeal,
  startAdminStage2HandoverESign,
  validateAdminStage2HandoverVoidReason,
  voidAdminStage2HandoverESign,
  type AdminStage2HandoverSignedDocumentState,
  type AdminStage2HandoverESignStatus
} from "../src/lib/admin-stage2-handover-esign";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Admin Stage 2 handover eSign API", () => {
  it.each([
    ["load", loadAdminStage2HandoverESign, "GET", "/handover-work-orders/work%20order/esign"],
    ["start", startAdminStage2HandoverESign, "POST", "/handover-work-orders/work%20order/esign"],
    [
      "platform seal retry",
      retryAdminStage2PlatformSeal,
      "POST",
      "/handover-work-orders/work%20order/esign/platform-seal/retry"
    ],
    [
      "archive retry",
      retryAdminStage2HandoverArchive,
      "POST",
      "/handover-work-orders/work%20order/esign/archive/retry"
    ]
  ])("uses the typed %s endpoint without adding sensitive parameters", async (_name, action, method, path) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(esignStatus()), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await action("work order");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3001/api${path}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      method
    });
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toMatch(
      /signUrl|providerTransactionId|objectKey|bucket|idCard|fullPhone/i
    );
  });

  it("posts an explicit bounded reason when an Admin voids a recoverable task", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(esignStatus({ taskId: null })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await voidAdminStage2HandoverESign("work order", "客户拒签后重新核验签署材料");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/handover-work-orders/work%20order/esign/void"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ reason: "客户拒签后重新核验签署材料" }),
      credentials: "include",
      method: "POST"
    });
  });

  it("types archive retry as the signed-document state returned by the backend", async () => {
    const archiveState = signedDocumentState();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(archiveState), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })
    ));

    const result: AdminStage2HandoverSignedDocumentState =
      await retryAdminStage2HandoverArchive("work-order");

    expect(result).toEqual(archiveState);
    expect(result).not.toHaveProperty("customerSigner");
  });
});

describe("Admin Stage 2 handover eSign display", () => {
  it("offers eSign creation only when readiness passes and no task exists", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus());

    expect(display).toMatchObject({
      archive: { label: "待签署完成" },
      customer: { label: "待发起" },
      platform: { label: "待发起" },
      readiness: { label: "签署条件已就绪" },
      startAvailable: true
    });
    expect(display.platformActionLabel).toBeNull();
    expect(display.archiveRetryAvailable).toBe(false);
  });

  it("maps blocker codes to concise Chinese without exposing backend messages", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      blockers: [
        {
          code: "CUSTOMER_READINESS_STALE",
          message: "provider account 998877 raw readiness expired"
        },
        {
          code: "SOURCE_PDF_TOO_LARGE",
          message: "private storage object path should not be rendered"
        }
      ],
      ready: false
    }));

    expect(display.readiness).toMatchObject({
      detail: "客户电子签状态已过期，请刷新认证状态；交接 PDF 超出签署大小限制",
      label: "暂不可发起"
    });
    expect(JSON.stringify(display)).not.toMatch(/998877|private storage|provider account/i);
  });

  it("offers the initial platform seal only after the customer signs", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      customerSigner: signer({ signedAt: "2026-07-27T08:00:00.000Z", status: "SIGNED" }),
      platformSigner: signer({ retryAvailable: true }),
      status: "SIGNING",
      taskId: "task-private-id"
    }));

    expect(display.customer.label).toBe("已签署");
    expect(display.platform.label).toBe("待平台盖章");
    expect(display.platformActionLabel).toBe("发起平台盖章");
    expect(display.startAvailable).toBe(false);
    expect(JSON.stringify(display)).not.toContain("task-private-id");
  });

  it("offers a platform seal retry after a failed attempt without exposing the provider error", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      customerSigner: signer({ status: "SIGNED" }),
      platformSigner: signer({
        attemptCount: 2,
        lastErrorCode: "FADADA_PROVIDER_SECRET_RAW_FAILURE",
        retryAvailable: true
      }),
      status: "SIGNING",
      taskId: "task-private-id"
    }));

    expect(display.platform).toMatchObject({
      detail: "平台盖章未完成，请重试",
      label: "平台盖章失败"
    });
    expect(display.platformActionLabel).toBe("重试平台盖章");
    expect(JSON.stringify(display)).not.toContain("FADADA_PROVIDER_SECRET_RAW_FAILURE");
  });

  it("shows terminal tasks that require rebuilding as an explicit Admin intervention state", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      canVoid: true,
      ready: true,
      rebuildRequired: true,
      status: "FAILED",
      taskId: "task-private-id"
    }));

    expect(display.readiness).toEqual({
      color: "red",
      detail: "当前签署任务需先作废后才能重新发起",
      label: "签署任务需处理"
    });
    expect(display.startAvailable).toBe(false);
    expect(display.platformActionLabel).toBeNull();
    expect(display.voidAvailable).toBe(true);
  });

  it("shows a non-force-void escalation when a provider transaction prevents local recovery", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      canVoid: false,
      ready: false,
      rebuildRequired: true,
      status: "FAILED",
      taskId: "task-private-id"
    }));

    expect(display.readiness).toEqual({
      color: "red",
      detail: "供应商已受理该签署交易，不能在本地强制作废，请联系管理员核验处理",
      label: "签署任务需人工处理"
    });
    expect(display.voidAvailable).toBe(false);
    expect(JSON.stringify(display)).not.toMatch(/transaction|provider|task-private-id/i);
  });

  it.each([
    ["CREATED", "签署任务创建中", "processing"],
    ["WAITING_CUSTOMER", "待客户签署", "warning"],
    ["SIGNING", "签署进行中", "processing"],
    ["COMPLETED", "签署已完成", "success"],
    ["FAILED", "签署失败", "error"],
    ["CANCELLED", "签署任务已作废", "default"],
    ["EXPIRED", "签署任务已过期", "error"]
  ])("shows task lifecycle %s instead of create-readiness blockers", (status, label, color) => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      blockers: [{
        code: "ACTIVE_ESIGN_TASK_CONFLICT",
        message: "An active task exists"
      }],
      ready: false,
      status,
      taskId: "task-private-id"
    }));

    expect(display.readiness).toMatchObject({ color, detail: null, label });
    expect(JSON.stringify(display.readiness)).not.toContain("已有进行中的电子签任务");
  });

  it("keeps completed signing distinct from a retryable signed-file archive", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      archiveStatus: "FAILED",
      customerSigner: signer({ status: "SIGNED" }),
      platformSigner: signer({ attemptCount: 1, status: "SIGNED" }),
      signedArtifactAvailable: false,
      status: "COMPLETED",
      taskId: "task-private-id"
    }));

    expect(display.customer.label).toBe("已签署");
    expect(display.platform.label).toBe("已盖章");
    expect(display.archive.label).toBe("签署文件归档失败");
    expect(display.archiveRetryAvailable).toBe(true);
    expect(display.startAvailable).toBe(false);
  });

  it("reports an archived signed artifact as complete without offering delivery confirmation", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      archiveStatus: "ARCHIVED",
      customerSigner: signer({ status: "SIGNED" }),
      platformSigner: signer({ status: "SIGNED" }),
      signedArtifactAvailable: true,
      status: "COMPLETED",
      taskId: "task-private-id"
    }));

    expect(display.archive.label).toBe("签署文件已归档");
    expect(display.archiveRetryAvailable).toBe(false);
    expect(JSON.stringify(display)).not.toMatch(/确认交付|delivery|lease|billing|payment/i);
  });
});

describe("Admin Stage 2 handover eSign safe errors", () => {
  it.each([
    [new ApiError("raw readiness details", 400, "STAGE2_HANDOVER_ESIGN_NOT_READY"), "交接材料尚未满足电子签条件"],
    [new ApiError("raw rebuild details", 409, "STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED"), "当前签署任务需先作废后才能重新发起"],
    [new ApiError("raw provider rejection with transaction 998877", 502), "电子签服务暂不可用，请稍后重试"],
    [new ApiError("Forbidden", 403), "无发起或重试电子签权限"],
    [new Error("storage object and provider details"), "电子签操作失败，请刷新状态后重试"]
  ])("maps backend failures to readable safe copy", (error, expected) => {
    expect(getAdminStage2HandoverESignErrorMessage(error)).toBe(expected);
    expect(getAdminStage2HandoverESignErrorMessage(error)).not.toMatch(/998877|storage object|provider details/i);
  });

  it("does not infer a trusted backend code from raw message contents", () => {
    expect(getAdminStage2HandoverESignErrorMessage(
      new ApiError("STAGE2_HANDOVER_ESIGN_NOT_READY raw provider text", 400)
    )).toBe("电子签操作失败，请刷新状态后重试");
  });
});

describe("Admin Stage 2 handover eSign void reason", () => {
  it.each([
    ["", "请填写作废原因"],
    ["ab", "作废原因需为 3-500 个字符"],
    ["a".repeat(501), "作废原因需为 3-500 个字符"],
    [" 客户拒签后重新核验材料 ", null]
  ])("validates the explicit reason boundary", (reason, expected) => {
    expect(validateAdminStage2HandoverVoidReason(reason)).toBe(expected);
  });
});

function esignStatus(
  overrides: Partial<AdminStage2HandoverESignStatus> = {}
): AdminStage2HandoverESignStatus {
  return {
    archiveStatus: "NOT_STARTED",
    blockers: [],
    canVoid: false,
    createdAt: null,
    customerSigner: signer(),
    documentType: "DELIVERY_HANDOVER",
    handoverId: "handover-private-id",
    platformSigner: signer(),
    ready: true,
    rebuildRequired: false,
    signedArtifactAvailable: false,
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    status: null,
    taskId: null,
    updatedAt: null,
    workOrderId: "work-order-id",
    ...overrides
  };
}

function signer(
  overrides: Partial<AdminStage2HandoverESignStatus["customerSigner"]> = {}
): AdminStage2HandoverESignStatus["customerSigner"] {
  return {
    attemptCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    nextRetryAt: null,
    retryAvailable: false,
    signedAt: null,
    slotId: "STAGE2_HANDOVER_CUSTOMER",
    status: "PENDING",
    ...overrides
  };
}

function signedDocumentState(): AdminStage2HandoverSignedDocumentState {
  return {
    archiveLastAttemptAt: "2026-07-27T09:00:00.000Z",
    archiveLastError: null,
    archiveRetryCount: 1,
    archiveStatus: "ARCHIVED",
    archivedAt: "2026-07-27T09:00:02.000Z",
    available: true,
    completedAt: "2026-07-27T08:59:00.000Z",
    handoverId: "handover-private-id",
    retryAvailable: false,
    taskId: "task-private-id",
    workOrderId: "work-order-id"
  };
}
