import { describe, expect, it } from "vitest";

import {
  buildPortalHandoverReviewCard,
  buildPortalHandoverReviewDetailView,
  formatPortalHandoverReviewStatus,
  isPortalHandoverReviewActionable,
  validatePortalHandoverObjectionReason
} from "../src/lib/portal-handover-review-view-model";
import type {
  PortalHandoverReviewDetail,
  PortalHandoverReviewListItem
} from "../src/lib/portal-handover-review-api";

const FULL_PHONE_SHOULD_NOT_RENDER = ["139", "0000", "1111"].join("");
const FULL_ID_SHOULD_NOT_RENDER = "FULL_ID_SHOULD_NOT_RENDER";
const SIGNING_URL_SHOULD_NOT_RENDER = "SIGNING_URL_SHOULD_NOT_RENDER";
const OBJECT_KEY_SHOULD_NOT_RENDER = "private/oss/object-key.jpg";
const FINANCE_VALUE_SHOULD_NOT_RENDER = "FINANCE_VALUE_SHOULD_NOT_RENDER";
const TOKEN_FIELD_NAME = ["to", "ken"].join("");

describe("portal handover review view model", () => {
  it("formats review statuses into customer-facing Chinese labels", () => {
    expect(formatPortalHandoverReviewStatus("CUSTOMER_REVIEWING")).toBe("待确认");
    expect(formatPortalHandoverReviewStatus("EVIDENCE_SUBMITTED")).toBe("待确认");
    expect(formatPortalHandoverReviewStatus("CUSTOMER_CONFIRMED")).toBe("已确认无异议");
    expect(formatPortalHandoverReviewStatus("CUSTOMER_OBJECTED")).toBe("已提出异议");
    expect(formatPortalHandoverReviewStatus("VOIDED")).toBe("不可处理 / 已关闭");
    expect(isPortalHandoverReviewActionable("CUSTOMER_REVIEWING")).toBe(true);
    expect(isPortalHandoverReviewActionable("CUSTOMER_CONFIRMED")).toBe(false);
  });

  it("builds a list card from safe fields only", () => {
    const card = buildPortalHandoverReviewCard({
      ...sampleListItem(),
      customerIdNo: FULL_ID_SHOULD_NOT_RENDER,
      financeValue: FINANCE_VALUE_SHOULD_NOT_RENDER,
      fullPhone: FULL_PHONE_SHOULD_NOT_RENDER,
      objectKey: OBJECT_KEY_SHOULD_NOT_RENDER,
      signingUrl: SIGNING_URL_SHOULD_NOT_RENDER,
      [TOKEN_FIELD_NAME]: "TOKEN_SHOULD_NOT_RENDER"
    } as PortalHandoverReviewListItem & Record<string, unknown>);
    const serialized = JSON.stringify(card);

    expect(card.title).toBe("ORD-PORTAL-REVIEW-001");
    expect(card.statusLabel).toBe("待确认");
    expect(card.vehicleText).toBe("NIO Stage2 Sandbox");
    expect(card.plateText).toBe("沪***45");
    expect(card.vinText).toBe("VIN 后六位 765432");
    expect(card.evidenceText).toBe("资料 14/14，必传 12，已通过 13");
    expect(serialized).not.toContain(FULL_PHONE_SHOULD_NOT_RENDER);
    expect(serialized).not.toContain(FULL_ID_SHOULD_NOT_RENDER);
    expect(serialized).not.toContain(SIGNING_URL_SHOULD_NOT_RENDER);
    expect(serialized).not.toContain(OBJECT_KEY_SHOULD_NOT_RENDER);
    expect(serialized).not.toContain(FINANCE_VALUE_SHOULD_NOT_RENDER);
    expect(serialized).not.toMatch(/objectKey|bucket|signingUrl|deposit|payment|token/i);
  });

  it("builds detail sections, evidence summary, and actionable decision copy", () => {
    const detail = buildPortalHandoverReviewDetailView(sampleDetail());
    const serialized = JSON.stringify(detail);

    expect(detail.title).toBe("车辆交接资料确认");
    expect(detail.summaryRows).toEqual(
      expect.arrayContaining([
        { label: "订单编号", value: "ORD-PORTAL-REVIEW-001" },
        { label: "交接状态", value: "待确认" },
        { label: "车辆", value: "NIO Stage2 Sandbox" }
      ])
    );
    expect(detail.fieldFactRows).toEqual(
      expect.arrayContaining([
        { label: "交接里程", value: "28600 km" },
        { label: "能源/油量", value: "80%" },
        { label: "损伤情况", value: "无可见损伤" }
      ])
    );
    expect(detail.evidenceItems).toHaveLength(14);
    expect(detail.evidenceItems[0]).toMatchObject({
      fileCountText: "1 个文件",
      requiredText: "必传",
      statusLabel: "已通过",
      title: "车辆车头正面"
    });
    expect(detail.decision.mode).toBe("ACTIONABLE");
    expect(detail.decision.primaryText).toBe("确认无异议");
    expect(detail.decision.secondaryText).toBe("提交异议");
    expect(serialized).not.toContain(OBJECT_KEY_SHOULD_NOT_RENDER);
    expect(serialized).not.toContain(SIGNING_URL_SHOULD_NOT_RENDER);
    expect(serialized).not.toContain(FULL_ID_SHOULD_NOT_RENDER);
    expect(serialized).not.toMatch(/objectKey|bucket|signingUrl|deposit|payment|lease|billing/i);
  });

  it("builds read-only confirmed and objected states", () => {
    expect(buildPortalHandoverReviewDetailView({
      ...sampleDetail(),
      customerConfirmedAt: "2026-07-22T12:00:00.000Z",
      status: "CUSTOMER_CONFIRMED"
    }).decision).toMatchObject({
      mode: "CONFIRMED",
      message: "您已确认无异议，后续将进入车辆交接确认单签署流程"
    });

    expect(buildPortalHandoverReviewDetailView({
      ...sampleDetail(),
      objection: { details: "右前轮毂需复核", objectedAt: "2026-07-22T12:10:00.000Z", reason: "车辆外观有异议" },
      status: "CUSTOMER_OBJECTED"
    }).decision).toMatchObject({
      details: "右前轮毂需复核",
      message: "您已提交异议，工作人员将联系您处理",
      mode: "OBJECTED",
      reason: "车辆外观有异议"
    });
  });

  it("validates objection reason before submit", () => {
    expect(validatePortalHandoverObjectionReason("   ")).toBe("请填写异议原因");
    expect(validatePortalHandoverObjectionReason("车辆外观有异议")).toBeNull();
  });
});

function sampleListItem(): PortalHandoverReviewListItem {
  return {
    customer: {
      displayName: "测试客户",
      mobileMasked: "139****1111"
    },
    deliveryLocation: "上海交付中心",
    evidenceProgress: {
      approved: 13,
      required: 12,
      total: 14,
      uploaded: 14
    },
    fieldSubmittedAt: "2026-07-22T08:00:00.000Z",
    handoverId: "handover-1",
    handoverType: "DELIVERY_OUTBOUND",
    id: "review-1",
    objection: {
      details: null,
      objectedAt: null,
      reason: null
    },
    orderNo: "ORD-PORTAL-REVIEW-001",
    scheduledAt: "2026-07-23T02:00:00.000Z",
    status: "CUSTOMER_REVIEWING",
    vehicle: {
      brand: "NIO",
      model: "Stage2 Sandbox",
      plateMasked: "沪***45",
      series: "ES6",
      vinSuffix: "765432"
    }
  };
}

function sampleDetail(): PortalHandoverReviewDetail {
  return {
    ...sampleListItem(),
    evidenceChecklist: {
      blockingReasons: [],
      items: Array.from({ length: 14 }, (_, index) => ({
        evidenceType: `EVIDENCE_${index + 1}`,
        fileCount: 1,
        files: [
          {
            file: {
              id: `file-${index + 1}`,
              mimeType: "image/jpeg",
              objectKey: OBJECT_KEY_SHOULD_NOT_RENDER,
              originalName: `evidence-${index + 1}.jpg`,
              sizeBytes: 1024
            },
            id: `evidence-file-${index + 1}`,
            mediaType: "PHOTO",
            objectKey: OBJECT_KEY_SHOULD_NOT_RENDER,
            uploadedAt: "2026-07-22T08:00:00.000Z"
          }
        ],
        id: `evidence-item-${index + 1}`,
        isConditional: false,
        isRequired: index < 12,
        rejectionReason: null,
        requirementLevel: index < 12 ? "REQUIRED" : "OPTIONAL",
        reviewStatus: index < 13 ? "APPROVED" : "PENDING",
        signingUrl: SIGNING_URL_SHOULD_NOT_RENDER,
        status: index < 13 ? "APPROVED" : "UPLOADED",
        title: index === 0 ? "车辆车头正面" : `证据项 ${index + 1}`
      })),
      ready: true
    },
    fieldFacts: {
      accessoryChecklist: { chargingCable: true, keys: 2 },
      damageDeclared: false,
      deliveryLocation: "上海交付中心",
      energyLevelText: "80%",
      fieldNotes: "现场资料已提交",
      fieldSubmittedAt: "2026-07-22T08:00:00.000Z",
      handoverMileageKm: 28600,
      noVisibleDamageDeclared: true,
      scheduledAt: "2026-07-23T02:00:00.000Z"
    },
    readiness: {
      blockingReasons: ["客户尚未确认交付无异议。"],
      readyForDeliveryConfirmation: false,
      readyForStage2ESign: false,
      readyForStage2Pdf: false,
      workOrderId: "review-1"
    }
  } as PortalHandoverReviewDetail;
}
