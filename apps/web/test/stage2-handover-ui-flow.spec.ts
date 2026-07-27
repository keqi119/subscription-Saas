import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startFieldHandoverWorkOrder,
  startFieldHandoverESign,
  submitFieldHandoverEvidence,
  updateFieldHandoverFacts
} from "../src/lib/field-handover-api";
import type { FieldHandoverWorkOrderDetail } from "../src/lib/field-handover-api";
import { buildFieldEvidenceCaptureView } from "../src/lib/field-handover-view-model";
import {
  confirmPortalHandoverReview,
  getPortalHandoverESign,
  getPortalHandoverReview,
  listPortalHandoverReviews,
  objectPortalHandoverReview,
  startPortalHandoverSigning
} from "../src/lib/portal-handover-review-api";
import type {
  PortalHandoverReviewDetail,
  Stage2PortalESignView
} from "../src/lib/portal-handover-review-api";
import {
  buildPortalHandoverReviewDetailView,
  validatePortalHandoverObjectionReason
} from "../src/lib/portal-handover-review-view-model";

const repoRoot = join(__dirname, "..", "..", "..");
const SENSITIVE_OBJECT_KEY = "SYNTHETIC_OBJECT_KEY_SHOULD_NOT_RENDER";
const SENSITIVE_SIGNING_URL = "SYNTHETIC_SIGNING_URL_SHOULD_NOT_RENDER";
const SENSITIVE_FULL_ID = "SYNTHETIC_FULL_ID_SHOULD_NOT_RENDER";
const INTENTIONAL_SIGNING_URL = "https://provider.example/stage2/customer-sign";
const SOURCE_PDF_HASH = "b".repeat(64);

describe("Stage 2 handover mocked UI flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs field submit to Portal confirmation through the safe eSign status and intentional start boundary", async () => {
    const result = await runMockedStage2HandoverConfirmFlow();

    expect(result.fieldAfterSubmit.canEdit).toBe(false);
    expect(result.fieldAfterSubmit.lockedMessage).toBe("当前交接任务已提交或不可继续编辑");
    expect(result.fieldAfterSubmit.showSaveAction).toBe(false);
    expect(result.fieldAfterSubmit.showSubmitAction).toBe(false);
    expect(result.portalPending.decision.mode).toBe("ACTIONABLE");
    expect(result.portalConfirmed.decision.mode).toBe("CONFIRMED");
    expect(result.portalConfirmed.decision.message).toBe("您已确认无异议，后续将进入车辆交接确认单签署流程");
    expect(result.portalESignStatus.capability.canStartSigning).toBe(true);
    expect(result.fieldESign).toMatchObject({
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: "stage2-task-ui-flow"
    });
    expect(JSON.stringify(result.portalESignStatus)).not.toMatch(/signUrl|signingUrl|provider/i);
    expect(result.signingStart).toEqual({
      expiresAt: "2026-07-22T09:00:00.000Z",
      signUrl: INTENTIONAL_SIGNING_URL
    });
    expect(result.calls).toEqual(expect.arrayContaining([
      expect.stringContaining("/field/handover/work-orders/work-order-ui-flow/submit"),
      expect.stringContaining("/field/handover/work-orders/work-order-ui-flow/esign"),
      expect.stringContaining("/portal/handover-reviews"),
      expect.stringContaining("/portal/handover-reviews/work-order-ui-flow/confirm"),
      expect.stringContaining("/portal/handover-reviews/work-order-ui-flow/esign"),
      expect.stringContaining("/portal/handover-reviews/work-order-ui-flow/esign/signing/start")
    ]));
    expect(result.requests).toEqual(expect.arrayContaining([
      {
        method: "POST",
        url: expect.stringContaining("/field/handover/work-orders/work-order-ui-flow/esign")
      },
      {
        method: "GET",
        url: expect.stringContaining("/portal/handover-reviews/work-order-ui-flow/esign")
      },
      {
        method: "POST",
        url: expect.stringContaining("/portal/handover-reviews/work-order-ui-flow/esign/signing/start")
      }
    ]));
    expect(result.serialized).not.toMatch(/objectKey|bucket|signingUrl|token|cookie|fullId|deposit|payment/i);
    expect(result.portalPageSources).toContain("getPortalHandoverESign");
    expect(result.portalPageSources).toContain("startPortalHandoverSigning");
    expect(result.portalPageSources).toContain(
      "window.location.assign(validatePortalHandoverSigningRedirect(result.signUrl))"
    );
    expect(result.portalPageSources).not.toMatch(
      /objectKey|bucket|storage path|provider|appId|transactionId|setSignUrl|localStorage|sessionStorage|console\.(log|info|debug)|href=\{[^}]*signUrl/i
    );
    expect(result.portalPageSources).not.toMatch(
      /生成.*PDF|确认交付|去支付|付款|账单|confirmDelivery|startDelivery|completeDelivery|\/delivery(?:\/|["'`])|payment|lease|billing/i
    );
    expect(result.fieldPageSource).toContain("startFieldHandoverESign");
    expect(result.fieldPageSource).toContain("发起电子签");
    expect(result.fieldPageSource).not.toMatch(/signUrl|startPortalHandoverSigning/i);
  });

  it("runs Portal objection flow with mocked API calls and keeps the UI read-only", async () => {
    const result = await runMockedStage2HandoverObjectionFlow();

    expect(result.validationMessage).toBe("请填写异议原因");
    expect(result.portalObjected.decision.mode).toBe("OBJECTED");
    expect(result.portalObjected.decision.message).toBe("您已提交异议，工作人员正在处理");
    expect(result.portalESignStatus.capability.canStartSigning).toBe(false);
    expect(JSON.stringify(result.portalESignStatus)).not.toMatch(/signUrl|signingUrl|provider/i);
    expect(result.calls).toEqual(expect.arrayContaining([
      expect.stringContaining("/portal/handover-reviews/work-order-ui-flow/object"),
      expect.stringContaining("/portal/handover-reviews/work-order-ui-flow/esign")
    ]));
    expect(result.requests).not.toEqual(expect.arrayContaining([
      {
        method: "POST",
        url: expect.stringContaining("/portal/handover-reviews/work-order-ui-flow/esign/signing/start")
      }
    ]));
    expect(result.serialized).not.toMatch(/objectKey|bucket|signingUrl|token|cookie|fullId|deposit|payment/i);
    expect(result.portalPageSources).not.toMatch(
      /objectKey|bucket|storage path|provider|appId|transactionId|setSignUrl|localStorage|sessionStorage|console\.(log|info|debug)|href=\{[^}]*signUrl/i
    );
    expect(result.portalPageSources).not.toMatch(
      /生成.*PDF|确认交付|去支付|付款|账单|confirmDelivery|startDelivery|completeDelivery|\/delivery(?:\/|["'`])|payment|lease|billing/i
    );
    expect(result.fieldPageSource).toContain("startFieldHandoverESign");
    expect(result.fieldPageSource).not.toMatch(/signUrl|startPortalHandoverSigning/i);
  });
});

async function runMockedStage2HandoverConfirmFlow() {
  const fetchMock = mockJsonSequence([
    fieldDetail({ status: "FIELD_IN_PROGRESS" }),
    fieldDetail({ status: "FIELD_IN_PROGRESS" }),
    fieldDetail({ status: "CUSTOMER_REVIEWING" }),
    [portalListItem()],
    portalDetail({ status: "CUSTOMER_REVIEWING" }),
    portalDetail({
      customerConfirmedAt: "2026-07-22T08:30:00.000Z",
      readiness: {
        blockingReasons: [],
        readyForDeliveryConfirmation: true,
        readyForStage2ESign: true,
        readyForStage2Pdf: true,
        workOrderId: "work-order-ui-flow"
      },
      status: "CUSTOMER_CONFIRMED"
    }),
    {
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: "stage2-task-ui-flow"
    },
    stage2PortalESignStatus({
      capability: { canStartSigning: true },
      ready: true,
      status: "WAITING_CUSTOMER",
      taskId: "stage2-task-ui-flow"
    }),
    {
      expiresAt: "2026-07-22T09:00:00.000Z",
      signUrl: INTENTIONAL_SIGNING_URL
    }
  ]);

  await startFieldHandoverWorkOrder("work-order-ui-flow");
  await updateFieldHandoverFacts("work-order-ui-flow", {
    accessoryChecklist: { chargingCable: true, keys: 2 },
    damageDeclared: false,
    energyLevelText: "80%",
    handoverMileageKm: 28600,
    noVisibleDamageDeclared: true
  });
  const submitted = await submitFieldHandoverEvidence("work-order-ui-flow");
  const fieldAfterSubmit = buildFieldEvidenceCaptureView(submitted);
  await listPortalHandoverReviews();
  const pending = await getPortalHandoverReview("work-order-ui-flow");
  const portalPending = buildPortalHandoverReviewDetailView(pending);
  const confirmed = await confirmPortalHandoverReview(
    "work-order-ui-flow",
    true,
    `sha256:${"a".repeat(64)}`
  );
  const portalConfirmed = buildPortalHandoverReviewDetailView(confirmed);
  const fieldESign = await startFieldHandoverESign("work-order-ui-flow", {
    acknowledgement: true,
    artifactVersion: 1,
    sourcePdfHash: SOURCE_PDF_HASH
  });
  const portalESignStatus = await getPortalHandoverESign("work-order-ui-flow");
  const signingStart = await startPortalHandoverSigning("work-order-ui-flow");

  return {
    calls: fetchMock.mock.calls.map((call) => String(call[0])),
    fieldPageSource: readFieldHandoverPageSource(),
    fieldAfterSubmit,
    fieldESign,
    portalConfirmed,
    portalESignStatus,
    portalPageSources: readPortalHandoverPageSources(),
    portalPending,
    requests: fetchMock.mock.calls.map(toRequestSummary),
    serialized: JSON.stringify({
      fieldAfterSubmit,
      portalConfirmed,
      portalESignStatus,
      portalPending
    }),
    signingStart
  };
}

async function runMockedStage2HandoverObjectionFlow() {
  const fetchMock = mockJsonSequence([
    portalDetail({ status: "CUSTOMER_REVIEWING" }),
    portalDetail({
      objection: {
        details: "右前轮毂需复核",
        objectedAt: "2026-07-22T08:40:00.000Z",
        reason: "车辆外观有异议"
      },
      readiness: {
        blockingReasons: ["客户存在异议，需后台介入。"],
        readyForDeliveryConfirmation: false,
        readyForStage2ESign: false,
        readyForStage2Pdf: false,
        workOrderId: "work-order-ui-flow"
      },
      status: "CUSTOMER_OBJECTED"
    }),
    stage2PortalESignStatus({
      blockers: [{
        code: "CUSTOMER_OBJECTION_ACTIVE",
        message: "The customer has an active handover objection."
      }]
    })
  ]);

  await getPortalHandoverReview("work-order-ui-flow");
  const validationMessage = validatePortalHandoverObjectionReason("   ");
  const objected = await objectPortalHandoverReview("work-order-ui-flow", {
    details: "右前轮毂需复核",
    reason: "车辆外观有异议"
  });
  const portalObjected = buildPortalHandoverReviewDetailView(objected);
  const portalESignStatus = await getPortalHandoverESign("work-order-ui-flow");

  return {
    calls: fetchMock.mock.calls.map((call) => String(call[0])),
    fieldPageSource: readFieldHandoverPageSource(),
    portalESignStatus,
    portalObjected,
    portalPageSources: readPortalHandoverPageSources(),
    requests: fetchMock.mock.calls.map(toRequestSummary),
    serialized: JSON.stringify({ portalESignStatus, portalObjected }),
    validationMessage
  };
}

function stage2PortalESignStatus(
  overrides: Partial<Stage2PortalESignView> = {}
): Stage2PortalESignView {
  return {
    archiveStatus: "NOT_STARTED",
    blockers: [],
    capability: { canStartSigning: false },
    createdAt: null,
    customerSigner: {
      signedAt: null,
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      status: "PENDING"
    },
    documentType: "DELIVERY_HANDOVER",
    handoverId: "handover-ui-flow",
    platformSigner: {
      signedAt: null,
      slotId: "STAGE2_HANDOVER_PLATFORM",
      status: "PENDING"
    },
    ready: false,
    signedArtifactAvailable: false,
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    status: null,
    taskId: null,
    updatedAt: null,
    workOrderId: "work-order-ui-flow",
    ...overrides
  };
}

function fieldDetail(overrides: Partial<FieldHandoverWorkOrderDetail> = {}): FieldHandoverWorkOrderDetail {
  return {
    customer: {
      displayName: "本地测试客户",
      mobileMasked: "188****0000"
    },
    deliveryLocation: "本地交付测试点",
    evidenceChecklist: {
      blockingReasons: [],
      items: evidenceItems(),
      ready: true
    },
    evidenceProgress: {
      approved: 13,
      required: 12,
      total: 14,
      uploaded: 14
    },
    fieldFacts: {
      accessoryChecklist: { chargingCable: true, keys: 2 },
      damageDeclared: false,
      deliveryLocation: "本地交付测试点",
      energyLevelText: "80%",
      fieldNotes: "本地合成现场资料已提交",
      fieldSubmittedAt: "2026-07-22T08:20:00.000Z",
      handoverMileageKm: 28600,
      noVisibleDamageDeclared: true
    },
    handoverId: "handover-ui-flow",
    handoverType: "DELIVERY_OUTBOUND",
    id: "work-order-ui-flow",
    orderNo: "ORD-STAGE2-UI-FLOW",
    scheduledAt: "2026-07-23T02:00:00.000Z",
    status: "FIELD_IN_PROGRESS",
    vehicle: {
      brand: "NIO",
      model: "Stage2 UI Harness",
      plateMasked: "测***01",
      vinSuffix: "765432"
    },
    ...overrides
  };
}

function portalListItem() {
  return {
    customer: {
      displayName: "本地测试客户",
      mobileMasked: "188****0000"
    },
    deliveryLocation: "本地交付测试点",
    evidenceProgress: {
      approved: 13,
      required: 12,
      total: 14,
      uploaded: 14
    },
    fieldSubmittedAt: "2026-07-22T08:20:00.000Z",
    handoverId: "handover-ui-flow",
    id: "work-order-ui-flow",
    orderNo: "ORD-STAGE2-UI-FLOW",
    scheduledAt: "2026-07-23T02:00:00.000Z",
    status: "CUSTOMER_REVIEWING",
    vehicle: {
      brand: "NIO",
      model: "Stage2 UI Harness",
      plateMasked: "测***01",
      vinSuffix: "765432"
    }
  };
}

function portalDetail(overrides: Partial<PortalHandoverReviewDetail> = {}): PortalHandoverReviewDetail {
  return {
    ...portalListItem(),
    customerIdNo: SENSITIVE_FULL_ID,
    evidenceChecklist: {
      blockingReasons: [],
      items: evidenceItems(),
      ready: true
    },
    fieldFacts: {
      accessoryChecklist: { chargingCable: true, keys: 2 },
      damageDeclared: false,
      deliveryLocation: "本地交付测试点",
      energyLevelText: "80%",
      fieldNotes: "本地合成现场资料已提交",
      fieldSubmittedAt: "2026-07-22T08:20:00.000Z",
      handoverMileageKm: 28600,
      noVisibleDamageDeclared: true
    },
    readiness: {
      blockingReasons: ["客户尚未确认交付无异议。"],
      readyForDeliveryConfirmation: false,
      readyForStage2ESign: false,
      readyForStage2Pdf: false,
      workOrderId: "work-order-ui-flow"
    },
    signingUrl: SENSITIVE_SIGNING_URL,
    status: "CUSTOMER_REVIEWING",
    ...overrides
  } as PortalHandoverReviewDetail & Record<string, unknown>;
}

function evidenceItems() {
  return Array.from({ length: 14 }, (_, index) => ({
    allowedMediaTypes: index === 7 ? ["VIDEO"] : ["PHOTO"],
    evidenceType: `LOCAL_UI_EVIDENCE_${index + 1}`,
    fileCount: index === 12 ? 0 : 1,
    files: index === 12
      ? []
      : [
          {
            file: {
              id: `file-${index + 1}`,
              mimeType: index === 7 ? "video/mp4" : "image/jpeg",
              objectKey: SENSITIVE_OBJECT_KEY,
              originalName: `evidence-${index + 1}.${index === 7 ? "mp4" : "jpg"}`,
              sizeBytes: 1024
            },
            fileId: `file-${index + 1}`,
            id: `evidence-file-${index + 1}`,
            mediaType: index === 7 ? "VIDEO" : "PHOTO",
            objectKey: SENSITIVE_OBJECT_KEY,
            uploadedAt: "2026-07-22T08:20:00.000Z"
          }
        ],
    id: `evidence-item-${index + 1}`,
    isConditional: index >= 12,
    isRequired: index < 12,
    requirementLevel: index < 12 ? "REQUIRED" : "CONDITIONAL",
    reviewStatus: index === 12 ? "NOT_STARTED" : "APPROVED",
    signingUrl: SENSITIVE_SIGNING_URL,
    status: index === 12 ? "NOT_STARTED" : "APPROVED",
    title: index === 0 ? "客户与车辆正面合影" : `本地资料 ${index + 1}`
  }));
}

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

function readFieldHandoverPageSource() {
  return readFileSync(
    join(repoRoot, "apps/web/src/app/field/handover/tasks/[id]/page.tsx"),
    "utf8"
  );
}

function readPortalHandoverPageSources() {
  return [
    "apps/web/src/app/portal/handover-reviews/page.tsx",
    "apps/web/src/app/portal/handover-reviews/[id]/page.tsx"
  ].map((file) => readFileSync(join(repoRoot, file), "utf8")).join("\n");
}

function toRequestSummary(call: unknown[]) {
  const [url, init] = call as [unknown, RequestInit | undefined];
  return {
    method: init?.method ?? "GET",
    url: String(url)
  };
}
