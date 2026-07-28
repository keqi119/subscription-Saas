import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ApiError } from "../src/lib/api";
import {
  createAdminStage2DeliveryVerifier,
  getAdminStage2HandoverESignDisplay,
  getAdminStage2HandoverESignErrorMessage,
  getAdminStage2HandoverWorkflowDisplay,
  loadAdminStage2HandoverESign,
  reconcileAdminStage2CustomerSignature,
  retryAdminStage2HandoverArchive,
  retryAdminStage2PlatformSeal,
  retryAdminStage2WorkflowJob,
  startAdminStage2HandoverESign,
  validateAdminStage2HandoverFallbackReason,
  validateAdminStage2HandoverVoidReason,
  voidAdminStage2HandoverESign,
  type AdminStage2HandoverSignedDocumentState,
  type AdminStage2HandoverESignStatus,
  type AdminStage2HandoverWorkflowContext,
  type AdminStage2HandoverWorkflowJob,
  type AdminStage2HandoverWorkflowStepKey,
  type AdminStage2HandoverWorkflowJobType
} from "../src/lib/admin-stage2-handover-esign";
import {
  buildAdminStage2HandoverPdfDownloadUrl,
  getAdminStage2HandoverDocumentDownload
} from "../src/lib/admin-stage2-handover-pdf";

afterEach(() => {
  vi.unstubAllGlobals();
});

const repoRoot = join(__dirname, "..", "..", "..");
const orderPagePath = join(repoRoot, "apps/web/src/app/orders/[id]/page.tsx");

describe("Admin Stage 2 handover eSign API", () => {
  it.each([
    ["load", loadAdminStage2HandoverESign, "GET", "/handover-work-orders/work%20order/esign"],
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

  it("posts the exact reviewed artifact and bounded reason for Admin fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(esignStatus()), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      acknowledgement: true as const,
      artifactVersion: 3,
      reason: "Field 经办人超过十五分钟未推进",
      sourcePdfHash: "b".repeat(64)
    };

    await startAdminStage2HandoverESign("work order", input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/handover-work-orders/work%20order/esign"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify(input),
      credentials: "include",
      method: "POST"
    });
  });

  it("builds the authenticated Admin PDF preview/download link from the work-order id", () => {
    expect(buildAdminStage2HandoverPdfDownloadUrl("work order")).toBe(
      "http://localhost:3001/api/handover-work-orders/work%20order/pdf/download"
    );
  });

  it("uses the authoritative signed PDF as the primary download after Stage 2 archive", () => {
    expect(
      getAdminStage2HandoverDocumentDownload({
        archiveStatus: "ARCHIVED",
        handoverStatus: "ARCHIVED",
        signedArtifactAvailable: true,
        sourceDownloadUrl: "/api/handover-work-orders/work%20order/pdf/download",
        workOrderId: "work order"
      })
    ).toEqual({
      kind: "SIGNED",
      label: "下载已签署 PDF",
      url: "http://localhost:3001/api/handover-work-orders/work%20order/esign/signed-document/download"
    });
  });

  it("does not let a generic e-sign artifact promote the Stage 2 signed PDF", () => {
    expect(
      getAdminStage2HandoverDocumentDownload({
        archiveStatus: "ARCHIVED",
        handoverStatus: "SIGNED",
        signedArtifactAvailable: true,
        sourceDownloadUrl: "/api/handover-work-orders/work%20order/pdf/download",
        workOrderId: "work order"
      })
    ).toEqual({
      kind: "SOURCE",
      label: "查看待签原件",
      url: "http://localhost:3001/api/handover-work-orders/work%20order/pdf/download"
    });
  });

  it("labels the source PDF explicitly while the signed PDF archive is unavailable", () => {
    expect(
      getAdminStage2HandoverDocumentDownload({
        archiveStatus: "FAILED",
        handoverStatus: "SIGNED",
        signedArtifactAvailable: false,
        sourceDownloadUrl: "/api/handover-work-orders/work%20order/pdf/download",
        workOrderId: "work order"
      })
    ).toEqual({
      kind: "SOURCE",
      label: "查看待签原件",
      url: "http://localhost:3001/api/handover-work-orders/work%20order/pdf/download"
    });
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

  it.each([
    [
      "dead-letter retry",
      () => retryAdminStage2WorkflowJob("work order", "job/id"),
      "/handover-work-orders/work%20order/workflow-jobs/job%2Fid/retry"
    ],
    [
      "typed customer reconciliation",
      () => reconcileAdminStage2CustomerSignature("work order"),
      "/handover-work-orders/work%20order/workflow/reconcile-customer"
    ]
  ])("uses the approved %s recovery endpoint", async (_name, action, path) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await action();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3001/api${path}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      method: "POST"
    });
  });
});

describe("Admin Stage 2 handover eSign display", () => {
  it("omits every manual workflow mutation on the normal path", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus());

    expect(display).toMatchObject({
      archive: { label: "待签署完成" },
      customer: { label: "待发起" },
      platform: { label: "待发起" },
      readiness: { label: "签署条件已就绪" },
      startAvailable: false
    });
    expect(display.platformActionLabel).toBeNull();
    expect(display.archiveRetryAvailable).toBe(false);
  });

  it("shows the backend-authorized Admin fallback only when Field initiation is unavailable", () => {
    const fallback = getAdminStage2HandoverESignDisplay(esignStatus({
      canAdminInitiate: true
    }));
    const normal = getAdminStage2HandoverESignDisplay(esignStatus({
      canAdminInitiate: false
    }));

    expect(fallback.startAvailable).toBe(true);
    expect(normal.startAvailable).toBe(false);
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

  it("does not expose a manual platform-seal action after the customer signs", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      customerSigner: signer({ signedAt: "2026-07-27T08:00:00.000Z", status: "SIGNED" }),
      platformSigner: stage2PlatformSigner({ retryAvailable: true }),
      status: "SIGNING",
      taskId: "task-private-id"
    }));

    expect(display.customer.label).toBe("已签署");
    expect(display.platform.label).toBe("待平台盖章");
    expect(display.platformActionLabel).toBeNull();
    expect(display.startAvailable).toBe(false);
    expect(JSON.stringify(display)).not.toContain("task-private-id");
  });

  it("keeps provider errors generic without exposing a manual retry", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      customerSigner: signer({ status: "SIGNED" }),
      platformSigner: stage2PlatformSigner({
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
    expect(display.platformActionLabel).toBeNull();
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
      platformSigner: stage2PlatformSigner({ attemptCount: 1, status: "SIGNED" }),
      signedArtifactAvailable: false,
      status: "COMPLETED",
      taskId: "task-private-id"
    }));

    expect(display.customer.label).toBe("已签署");
    expect(display.platform.label).toBe("已盖章");
    expect(display.archive.label).toBe("签署文件归档失败");
    expect(display.archiveRetryAvailable).toBe(false);
    expect(display.startAvailable).toBe(false);
  });

  it("reports an archived signed artifact as complete without offering delivery confirmation", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      archiveStatus: "ARCHIVED",
      customerSigner: signer({ status: "SIGNED" }),
      platformSigner: stage2PlatformSigner({ status: "SIGNED" }),
      signedArtifactAvailable: true,
      status: "COMPLETED",
      taskId: "task-private-id"
    }));

    expect(display.archive.label).toBe("签署文件已归档");
    expect(display.archiveRetryAvailable).toBe(false);
    expect(JSON.stringify(display)).not.toMatch(/确认交付|delivery|lease|billing|payment/i);
  });

  it("keeps void and reissue unavailable after provider signing completes", () => {
    const display = getAdminStage2HandoverESignDisplay(esignStatus({
      canVoid: true,
      customerSigner: signer({ status: "SIGNED" }),
      platformSigner: stage2PlatformSigner({ status: "SIGNED" }),
      status: "COMPLETED",
      taskId: "task-private-id"
    }));

    expect(display.voidAvailable).toBe(false);
  });
});

describe("Admin Stage 2 workflow timeline and recovery", () => {
  it("renders one stable timeline from customer confirmation through archive", () => {
    const display = getAdminStage2HandoverWorkflowDisplay(
      esignStatus({
        archiveStatus: "PENDING",
        customerSigner: signer({ status: "SIGNED" }),
        platformSigner: stage2PlatformSigner({ status: "SIGNED" }),
        status: "COMPLETED",
        taskId: "task-private-id"
      }),
      {
        customerConfirmedAt: "2026-07-27T07:00:00.000Z",
        pdfStatus: "GENERATED"
      }
    );

    expect(display.steps.map(({ label, state }) => ({ label, state }))).toEqual([
      { label: "客户已确认", state: "complete" },
      { label: "交接确认单已生成", state: "complete" },
      { label: "经办人已发起签署", state: "complete" },
      { label: "客户已签署", state: "complete" },
      { label: "平台已盖章", state: "complete" },
      { label: "签署文件归档中", state: "current" }
    ]);
    expect(display.deliveryConfirmationAvailable).toBe(true);
  });

  it("uses exact H1 and H2 signing as the delivery gate independently of archive", () => {
    const signedWithFailedArchive = getAdminStage2HandoverWorkflowDisplay(esignStatus({
      archiveStatus: "FAILED",
      customerSigner: signer({ status: "SIGNED" }),
      platformSigner: stage2PlatformSigner({ status: "SIGNED" }),
      signedArtifactAvailable: false,
      status: "COMPLETED",
      taskId: "task-private-id"
    }));
    const archivedWithIncompleteH2 = getAdminStage2HandoverWorkflowDisplay(esignStatus({
      archiveStatus: "ARCHIVED",
      customerSigner: signer({ status: "SIGNED" }),
      platformSigner: stage2PlatformSigner({ status: "PENDING" }),
      signedArtifactAvailable: true
    }));

    expect(signedWithFailedArchive.deliveryConfirmationAvailable).toBe(true);
    expect(archivedWithIncompleteH2.deliveryConfirmationAvailable).toBe(false);
  });

  it("rechecks exact signing completion before opening or submitting delivery", async () => {
    const loadESignStatus = vi
      .fn()
      .mockResolvedValueOnce(esignStatus({
        archiveStatus: "FAILED",
        customerSigner: signer({ status: "SIGNED" }),
        platformSigner: stage2PlatformSigner({ status: "SIGNED" }),
        signedArtifactAvailable: false,
        status: "COMPLETED",
        taskId: "task-private-id"
      }))
      .mockResolvedValueOnce(esignStatus({
        archiveStatus: "ARCHIVED",
        customerSigner: signer({ status: "SIGNED" }),
        platformSigner: stage2PlatformSigner({ status: "PENDING" }),
        signedArtifactAvailable: true,
        status: "COMPLETED",
        taskId: "task-private-id"
      }));
    const verifier = createAdminStage2DeliveryVerifier({
      loadESignStatus,
      loadWorkOrders: vi.fn(async () => [
        { id: "work-order-id", status: "CUSTOMER_CONFIRMED" }
      ])
    });

    await expect(verifier.verify("order-id")).resolves.toEqual({
      allowed: true,
      reason: "SIGNED"
    });
    await expect(verifier.verify("order-id")).resolves.toEqual({
      allowed: false,
      reason: "NOT_SIGNED"
    });
  });

  it.each([
    ["GENERATE_SOURCE_PDF", "RETRY_JOB", "重试生成交接确认单"],
    ["NOTIFY_FIELD_ESIGN_READY", "RETRY_JOB", "重发经办人通知"],
    ["NOTIFY_CUSTOMER_ESIGN_READY", "RETRY_JOB", "重发客户通知"],
    ["RECONCILE_CUSTOMER_SIGNATURE", "RECONCILE_CUSTOMER", "核对客户签署状态"],
    ["AUTO_SEAL_PLATFORM", "RETRY_JOB", "重试平台盖章"],
    ["RECONCILE_PLATFORM_SEAL", "RETRY_JOB", "重试平台盖章"],
    ["ARCHIVE_SIGNED_PDF", "RETRY_JOB", "重试签署文件归档"]
  ] as const)(
    "maps a DEAD_LETTER %s row to only its matching action",
    (jobType, kind, label) => {
      const display = getAdminStage2HandoverWorkflowDisplay(esignStatus({
        canReconcileCustomer:
          jobType === "RECONCILE_CUSTOMER_SIGNATURE",
        workflowJobs: [workflowJob({ jobType })]
      }));

      expect(display.recoveries).toEqual([
        {
          jobId: "workflow-job-id",
          jobType,
          kind,
          label
        }
      ]);
    }
  );

  it("hides invalid H1 reconcile after rejection or failure", () => {
    const display = getAdminStage2HandoverWorkflowDisplay(esignStatus({
      canReconcileCustomer: false,
      customerSigner: signer({ status: "REJECTED" }),
      rebuildRequired: true,
      status: "FAILED",
      taskId: "task-private-id",
      workflowJobs: [
        workflowJob({ jobType: "RECONCILE_CUSTOMER_SIGNATURE" })
      ]
    }));

    expect(display.recoveries).toEqual([]);
  });

  it("renders no recovery controls for pending, processing, completed, or cancelled jobs", () => {
    const display = getAdminStage2HandoverWorkflowDisplay(esignStatus({
      workflowJobs: [
        workflowJob({ jobStatus: "PENDING" }),
        workflowJob({ id: "job-2", jobStatus: "PROCESSING" }),
        workflowJob({ id: "job-3", jobStatus: "COMPLETED" }),
        workflowJob({ id: "job-4", jobStatus: "CANCELLED" })
      ]
    }));

    expect(display.recoveries).toEqual([]);
  });

  it("suppresses a historical dead letter when a newer replacement for the logical step is active", () => {
    const display = getAdminStage2HandoverWorkflowDisplay(esignStatus({
      workflowJobs: [
        workflowJob({
          id: "dead-platform-seal",
          jobType: "AUTO_SEAL_PLATFORM",
          updatedAt: "2026-07-27T10:00:00.000Z"
        }),
        workflowJob({
          id: "replacement-platform-reconcile",
          jobStatus: "PROCESSING",
          jobType: "RECONCILE_PLATFORM_SEAL",
          updatedAt: "2026-07-27T10:05:00.000Z"
        })
      ]
    }));

    expect(display.recoveries).toEqual([]);
  });

  it.each(completedRecoveryFixtures())(
    "suppresses a stale $jobType dead letter after $step is authoritatively complete",
    ({ context, jobType, status, step }) => {
      const display = getAdminStage2HandoverWorkflowDisplay(
        esignStatus({
          ...status,
          workflowJobs: [workflowJob({ jobType })]
        }),
        context
      );

      expect(display.recoveries).toEqual([]);
      expect(display.steps.find(({ key }) => key === step)?.state).toBe(
        "complete"
      );
    }
  );

  it("selects only the newest authoritative actionable dead letter", () => {
    const display = getAdminStage2HandoverWorkflowDisplay(esignStatus({
      workflowJobs: [
        workflowJob({
          id: "older-pdf-dead-letter",
          jobType: "GENERATE_SOURCE_PDF",
          updatedAt: "2026-07-27T10:00:00.000Z"
        }),
        workflowJob({
          id: "current-archive-dead-letter",
          jobType: "ARCHIVE_SIGNED_PDF",
          updatedAt: "2026-07-27T10:05:00.000Z"
        })
      ]
    }));

    expect(display.recoveries).toEqual([
      {
        jobId: "current-archive-dead-letter",
        jobType: "ARCHIVE_SIGNED_PDF",
        kind: "RETRY_JOB",
        label: "重试签署文件归档"
      }
    ]);
  });

  it("fails recovery closed when the newest workflow job type is unknown", () => {
    const display = getAdminStage2HandoverWorkflowDisplay(esignStatus({
      workflowJobs: [
        workflowJob({
          id: "older-known-dead-letter",
          updatedAt: "2026-07-27T10:00:00.000Z"
        }),
        {
          ...workflowJob({
            id: "newer-unknown-dead-letter",
            updatedAt: "2026-07-27T10:05:00.000Z"
          }),
          jobType: "UNKNOWN_FUTURE_JOB"
        } as unknown as AdminStage2HandoverWorkflowJob
      ]
    }));

    expect(display.recoveries).toEqual([]);
  });

  it("renders the compact workflow timeline with only backend-authorized Admin controls", () => {
    const source = readFileSync(orderPagePath, "utf8");

    expect(source).toContain("Stage2HandoverWorkflowCell");
    expect(source).toContain("getAdminStage2HandoverWorkflowDisplay");
    expect(source).toContain("display.recoveries.map");
    expect(source).toContain(
      "createAdminStage2DeliveryConfirmationController"
    );
    expect(source).toContain('boundary: "MODAL_OPEN"');
    expect(source).toContain('boundary: "BEFORE_POST"');
    expect(source).toContain("retryAdminStage2WorkflowJob");
    expect(source).toContain("reconcileAdminStage2CustomerSignature");
    expect(source).toContain("startAdminStage2HandoverESign");
    expect(source).toContain("voidAdminStage2HandoverESign");
    expect(source).toContain("作废并重新发起");
    expect(source).toContain("后台兜底发起签署");
    expect(source).toContain('canRecoverWorkflow={permissions.has("delivery:confirm")}');
    expect(source).toContain("客户签署与平台盖章完成后才可确认交付");
    expect(source).toContain("确认后台兜底发起签署");
    expect(source).toContain("已核对当前交接确认单");
    expect(source).toContain("PDF 版本");
    expect(source).toContain("SHA-256");
    expect(source).toContain("预览/下载 PDF");
    expect(source).not.toContain("function Stage2HandoverPdfCell");
    expect(source).not.toContain("function Stage2HandoverESignCell");
    expect(source).not.toContain("onGeneratePdf=");
    expect(source).toContain("onStartESign=");
    expect(source).toContain("onVoidESign=");
    expect(source).not.toContain("onRetryPlatformSeal=");
    expect(source).not.toContain("onRetryESignArchive=");
  });
});

describe("Admin Stage 2 handover eSign safe errors", () => {
  it.each([
    [new ApiError("raw readiness details", 400, "STAGE2_HANDOVER_ESIGN_NOT_READY"), "交接材料尚未满足电子签条件"],
    [new ApiError("raw rebuild details", 409, "STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED"), "当前签署任务需先作废后才能重新发起"],
    [new ApiError("raw fallback denial", 400, "STAGE2_HANDOVER_ADMIN_FALLBACK_NOT_ELIGIBLE"), "Field 经办人仍可处理且尚未超过 15 分钟"],
    [new ApiError("raw stale review", 409, "STAGE2_HANDOVER_ADMIN_REVIEW_STALE"), "交接确认单已更新，请重新核对后发起"],
    [new ApiError("raw invalid reason", 400, "STAGE2_HANDOVER_ADMIN_FALLBACK_REASON_INVALID"), "兜底原因需为 3-500 个字符"],
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

describe("Admin Stage 2 handover fallback reason", () => {
  it.each([
    ["", "请填写兜底发起原因"],
    ["ab", "兜底原因需为 3-500 个字符"],
    ["a".repeat(501), "兜底原因需为 3-500 个字符"],
    [" Field 经办人超过十五分钟未推进 ", null]
  ])("validates the explicit reason boundary", (reason, expected) => {
    expect(validateAdminStage2HandoverFallbackReason(reason)).toBe(expected);
  });
});

function esignStatus(
  overrides: Partial<AdminStage2HandoverESignStatus> = {}
): AdminStage2HandoverESignStatus {
  return {
    archiveStatus: "NOT_STARTED",
    blockers: [],
    canAdminInitiate: false,
    canReconcileCustomer: false,
    canVoid: false,
    createdAt: null,
    customerSigner: signer(),
    documentType: "DELIVERY_HANDOVER",
    handoverId: "handover-private-id",
    platformSigner: stage2PlatformSigner(),
    ready: true,
    rebuildRequired: false,
    signedArtifactAvailable: false,
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    sourceArtifact: {
      artifactVersion: 3,
      createdAt: "2026-07-27T08:00:00.000Z",
      sourcePdfHash: "b".repeat(64)
    },
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
  const status = overrides.status ?? "PENDING";
  const signedAt =
    overrides.signedAt !== undefined
      ? overrides.signedAt
      : status === "SIGNED"
        ? "2026-07-27T08:59:00.000Z"
        : null;
  return {
    attemptCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    nextRetryAt: null,
    retryAvailable: false,
    signedAt,
    slotId: "STAGE2_HANDOVER_CUSTOMER",
    status,
    ...overrides
  };
}

function stage2PlatformSigner(
  overrides: Partial<AdminStage2HandoverESignStatus["platformSigner"]> = {}
): AdminStage2HandoverESignStatus["platformSigner"] {
  return signer({
    slotId: "STAGE2_HANDOVER_PLATFORM",
    ...overrides
  });
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

function workflowJob(
  overrides: Partial<AdminStage2HandoverWorkflowJob> & {
    jobType?: AdminStage2HandoverWorkflowJobType;
  } = {}
): AdminStage2HandoverWorkflowJob {
  return {
    attemptCount: 5,
    id: "workflow-job-id",
    jobStatus: "DEAD_LETTER",
    jobType: "GENERATE_SOURCE_PDF",
    maxAttempts: 5,
    updatedAt: "2026-07-27T10:00:00.000Z",
    ...overrides
  };
}

function completedRecoveryFixtures(): Array<{
  context?: AdminStage2HandoverWorkflowContext;
  jobType: AdminStage2HandoverWorkflowJobType;
  status: Partial<AdminStage2HandoverESignStatus>;
  step: AdminStage2HandoverWorkflowStepKey;
}> {
  return [
    {
      context: { pdfStatus: "GENERATED" },
      jobType: "GENERATE_SOURCE_PDF",
      status: {},
      step: "SOURCE_PDF"
    },
    {
      jobType: "NOTIFY_FIELD_ESIGN_READY",
      status: { taskId: "stage2-task-current" },
      step: "FIELD_INITIATION"
    },
    {
      jobType: "NOTIFY_CUSTOMER_ESIGN_READY",
      status: { customerSigner: signer({ status: "SIGNED" }) },
      step: "CUSTOMER_SIGNATURE"
    },
    {
      jobType: "RECONCILE_CUSTOMER_SIGNATURE",
      status: { customerSigner: signer({ status: "SIGNED" }) },
      step: "CUSTOMER_SIGNATURE"
    },
    {
      jobType: "AUTO_SEAL_PLATFORM",
      status: { platformSigner: stage2PlatformSigner({ status: "SIGNED" }) },
      step: "PLATFORM_SEAL"
    },
    {
      jobType: "RECONCILE_PLATFORM_SEAL",
      status: { platformSigner: stage2PlatformSigner({ status: "SIGNED" }) },
      step: "PLATFORM_SEAL"
    },
    {
      jobType: "ARCHIVE_SIGNED_PDF",
      status: {
        archiveStatus: "ARCHIVED",
        signedArtifactAvailable: true
      },
      step: "ARCHIVE"
    }
  ];
}
