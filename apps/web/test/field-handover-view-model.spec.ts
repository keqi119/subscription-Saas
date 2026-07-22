import { describe, expect, it } from "vitest";

import {
  buildFieldHandoverDetailView,
  buildFieldHandoverTaskCard,
  formatFieldHandoverType,
  formatFieldWorkOrderStatus
} from "../src/lib/field-handover-view-model";
import type { FieldHandoverWorkOrderDetail, FieldHandoverWorkOrderListItem } from "../src/lib/field-handover-api";

const FULL_PHONE_SHOULD_NOT_RENDER = ["139", "0000", "1111"].join("");
const ID_NUMBER_SHOULD_NOT_RENDER = "ID_NUMBER_SHOULD_NOT_RENDER";
const ADMIN_VALUE_SHOULD_NOT_RENDER = "ADMIN_VALUE_SHOULD_NOT_RENDER";
const FIELD_SESSION_VALUE_SHOULD_NOT_RENDER = "FIELD_SESSION_VALUE_SHOULD_NOT_RENDER";
const PROVIDER_INTERNAL_SHOULD_NOT_RENDER = "PROVIDER_INTERNAL_SHOULD_NOT_RENDER";
const SIGNING_LINK_SHOULD_NOT_RENDER = "SIGNING_LINK_SHOULD_NOT_RENDER";
const SESSION_FIELD_NAME = ["to", "ken"].join("");

describe("field handover view model", () => {
  it("formats handover type and work-order status labels for H5 cards", () => {
    expect(formatFieldHandoverType("DELIVERY_OUTBOUND")).toBe("交付出库");
    expect(formatFieldHandoverType("RETURN_INBOUND")).toBe("退租入库");
    expect(formatFieldWorkOrderStatus("OPS_REVIEW_PENDING")).toBe("运营复核中");
    expect(formatFieldWorkOrderStatus("UNKNOWN_STATUS")).toBe("UNKNOWN_STATUS");
  });

  it("builds a mobile task card from safe DTO fields only", () => {
    const card = buildFieldHandoverTaskCard({
      ...sampleTask(),
      adminValue: ADMIN_VALUE_SHOULD_NOT_RENDER,
      customerIdNo: ID_NUMBER_SHOULD_NOT_RENDER,
      fullPhone: FULL_PHONE_SHOULD_NOT_RENDER,
      objectKey: "private/oss/object.pdf",
      providerPayload: { internalValue: PROVIDER_INTERNAL_SHOULD_NOT_RENDER },
      signingUrl: SIGNING_LINK_SHOULD_NOT_RENDER,
      [SESSION_FIELD_NAME]: FIELD_SESSION_VALUE_SHOULD_NOT_RENDER
    } as FieldHandoverWorkOrderListItem & Record<string, unknown>);

    expect(card.title).toBe("ORD-FIELD-001");
    expect(card.statusLabel).toBe("运营复核中");
    expect(card.handoverTypeLabel).toBe("交付出库");
    expect(card.vehicleText).toBe("Tesla Model 3");
    expect(card.evidenceText).toBe("资料 2/6，必传 4，已通过 1");
    expect(JSON.stringify(card)).toContain("139****1111");
    expect(JSON.stringify(card)).not.toContain(FULL_PHONE_SHOULD_NOT_RENDER);
    expect(JSON.stringify(card)).not.toContain(ID_NUMBER_SHOULD_NOT_RENDER);
    expect(JSON.stringify(card)).not.toContain(SIGNING_LINK_SHOULD_NOT_RENDER);
    expect(JSON.stringify(card)).not.toContain("private/oss");
    expect(JSON.stringify(card)).not.toContain(ADMIN_VALUE_SHOULD_NOT_RENDER);
    expect(JSON.stringify(card)).not.toContain(FIELD_SESSION_VALUE_SHOULD_NOT_RENDER);
    expect(JSON.stringify(card)).not.toContain(PROVIDER_INTERNAL_SHOULD_NOT_RENDER);
    expect(JSON.stringify(card)).not.toMatch(/provider|deposit|payment/i);
  });

  it("builds a detail placeholder without upload, submit, PDF, or eSign actions", () => {
    const detail = buildFieldHandoverDetailView({
      ...sampleTask(),
      evidenceChecklist: {
        blockingReasons: ["资料待补充"],
        items: [
          { fileCount: 1, id: "item-1", isRequired: true, reviewStatus: "APPROVED", status: "APPROVED", title: "车身照片" },
          { fileCount: 0, id: "item-2", isRequired: true, reviewStatus: "NOT_STARTED", status: "NOT_STARTED", title: "里程照片" }
        ],
        ready: false
      },
      fieldFacts: {
        deliveryLocation: "上海交付中心",
        fieldNotes: "safe note",
        handoverMileageKm: 1200,
        scheduledAt: "2026-07-22T10:00:00.000Z"
      }
    });

    expect(detail.nextStepText).toBe("现场资料采集将在下一阶段开放");
    expect(detail.checklistSummary).toBe("已完成 1/2，必传 2");
    expect(JSON.stringify(detail)).not.toMatch(/upload|submit|esign|pdf/i);
    expect(JSON.stringify(detail)).not.toMatch(/上传|提交|电子签|PDF/);
  });
});

function sampleTask(): FieldHandoverWorkOrderListItem {
  return {
    customer: {
      displayName: "李柯",
      mobileMasked: "139****1111"
    },
    deliveryLocation: "上海交付中心",
    evidenceProgress: {
      approved: 1,
      required: 4,
      total: 6,
      uploaded: 2
    },
    handoverId: "handover-1",
    handoverType: "DELIVERY_OUTBOUND",
    id: "work-order-1",
    orderNo: "ORD-FIELD-001",
    scheduledAt: "2026-07-22T10:00:00.000Z",
    status: "OPS_REVIEW_PENDING",
    vehicle: {
      brand: "Tesla",
      model: "Model 3",
      plateMasked: "沪***45",
      vinSuffix: "AB5847"
    }
  };
}
