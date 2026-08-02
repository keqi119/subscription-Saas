import { describe, expect, it } from "vitest";

import {
  buildFieldEvidenceCaptureView,
  buildFieldHandoverDetailView,
  buildFieldHandoverTaskCard,
  formatFieldHandoverType,
  formatFieldWorkOrderStatus,
  getFieldHandoverSubmitBlockers,
  resolveFieldHandoverFactsAfterRefresh,
  validateFieldHandoverFactsInput
} from "../src/lib/field-handover-view-model";
import type {
  FieldHandoverWorkOrderDetail,
  FieldHandoverWorkOrderListItem
} from "../src/lib/field-handover-api";

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

  it("builds an evidence capture view with 14 safe checklist items and progress copy", () => {
    const detail = buildFieldHandoverDetailView({
      ...sampleTask(),
      evidenceChecklist: {
        blockingReasons: [],
        items: sampleEvidenceItems({ noVisibleDamageDeclared: true }),
        ready: false
      },
      fieldFacts: {
        accessoryChecklist: { chargingCable: true, keys: 2 },
        damageDeclared: false,
        deliveryLocation: "上海交付中心",
        fieldNotes: "safe note",
        handoverMileageKm: 1200,
        noVisibleDamageDeclared: true,
        scheduledAt: "2026-07-22T10:00:00.000Z"
      }
    });
    const capture = buildFieldEvidenceCaptureView({
      ...sampleDetail(),
      evidenceChecklist: {
        blockingReasons: [],
        items: sampleEvidenceItems({ noVisibleDamageDeclared: true }),
        ready: false
      }
    });

    expect(detail.nextStepText).toBe("下一步：提交后等待客户确认");
    expect(capture.evidenceItems).toHaveLength(14);
    expect(capture.progressText).toBe("资料完成度：13 / 13");
    expect(capture.fieldFactsStatus).toBe("现场信息：已完整");
    expect(capture.damageStateLabel).toBe("损伤状态：无可见损伤");
    expect(capture.canEdit).toBe(true);
    expect(capture.evidenceItems[0]).toMatchObject({
      allowsMultiple: false,
      requiredText: "必传",
      showUpload: true,
      statusLabel: "已上传",
      title: "客户与车辆正面合影",
      uploadLabel: "替换资料",
      uploadAccept: "image/*"
    });
    expect(capture.evidenceItems[0]?.files[0]).toMatchObject({
      displayName: "0.jpg",
      evidenceFileId: "evidence-file-0"
    });
    expect(
      capture.evidenceItems.find((item) => item.evidenceType === "WALKAROUND_VIDEO")
    ).toMatchObject({
      files: [
        expect.objectContaining({
          videoQualityText: "视频清晰度：1920×1080（符合环绕视频最低要求）"
        })
      ],
      uploadAccept: "video/*"
    });
    expect(
      capture.evidenceItems.find((item) => item.evidenceType === "NO_VISIBLE_DAMAGE_DECLARATION")
    ).toMatchObject({
      showDeclarationComplete: true,
      showUpload: false,
      statusLabel: "声明已完成"
    });
    expect(
      capture.evidenceItems.find((item) => item.evidenceType === "DAMAGE_STATIC_CLOSEUP")
    ).toMatchObject({
      allowsMultiple: true,
      uploadLabel: "继续添加"
    });
    expect(JSON.stringify(capture)).not.toMatch(
      /esign|pdf|signingUrl|objectKey|token|cookie|deposit|payment/i
    );
    expect(JSON.stringify(capture)).not.toContain(FULL_PHONE_SHOULD_NOT_RENDER);
    expect(JSON.stringify(capture)).not.toContain(ID_NUMBER_SHOULD_NOT_RENDER);
  });

  it("validates mileage, mutually exclusive damage states, and damage close-up blockers", () => {
    expect(
      validateFieldHandoverFactsInput(
        {
          accessoryChecklistText: "",
          damageDeclared: true,
          energyLevelText: "",
          handoverMileageKm: 0,
          noVisibleDamageDeclared: true
        },
        { requireComplete: true }
      )
    ).toEqual([
      "请填写交接里程",
      "请填写能源/油量状态",
      "请填写随车物品清单",
      "损伤状态冲突，请选择存在损伤或无可见损伤"
    ]);

    expect(
      getFieldHandoverSubmitBlockers({
        ...sampleDetail(),
        evidenceChecklist: {
          blockingReasons: [],
          items: sampleEvidenceItems({ damageDeclared: true, missingDamageCloseup: true }),
          ready: false
        },
        fieldFacts: {
          ...sampleDetail().fieldFacts,
          damageDeclared: true,
          noVisibleDamageDeclared: false
        }
      })
    ).toContain("请上传损伤/瑕疵近拍");
  });

  it("keeps submitted or terminal work orders read-only in the capture view", () => {
    const view = buildFieldEvidenceCaptureView({
      ...sampleDetail(),
      status: "CUSTOMER_REVIEWING"
    });

    expect(view.canEdit).toBe(false);
    expect(view.lockedMessage).toBe("当前交接任务已提交或不可继续编辑");
    expect(view.showStartAction).toBe(false);
    expect(view.showSaveAction).toBe(false);
    expect(view.showSubmitAction).toBe(false);
    expect(view.evidenceItems.every((item) => item.showUpload === false)).toBe(true);
  });

  it("labels historical video quality without inventing dimensions and ignores photo metadata", () => {
    const detail = sampleDetail();
    const items = sampleEvidenceItems({ noVisibleDamageDeclared: true });
    const walkaround = items.find((item) => item.evidenceType === "WALKAROUND_VIDEO")!;
    const photo = items.find((item) => item.evidenceType === "VEHICLE_FRONT")!;
    walkaround.files[0]!.metadata = { artifactVersion: 1 };
    photo.files[0]!.metadata = { videoHeightPx: 1080, videoWidthPx: 1920 };
    const capture = buildFieldEvidenceCaptureView({
      ...detail,
      evidenceChecklist: { blockingReasons: [], items, ready: false }
    });

    expect(
      capture.evidenceItems.find((item) => item.evidenceType === "WALKAROUND_VIDEO")
        ?.files[0]?.videoQualityText
    ).toBe("视频清晰度：历史资料未记录");
    expect(
      capture.evidenceItems.find((item) => item.evidenceType === "VEHICLE_FRONT")
        ?.files[0]?.videoQualityText
    ).toBeNull();
  });

  it("preserves a local facts draft during upload reconciliation refresh", () => {
    const draft = {
      accessoryChecklistText: "本地未保存清单",
      energyLevelText: "本地 70%",
      fieldNotes: "上传期间编辑的草稿",
      handoverMileageKm: 321
    };

    expect(
      resolveFieldHandoverFactsAfterRefresh(
        draft,
        {
          accessoryChecklist: { chargingCable: true },
          energyLevelText: "服务端 50%",
          fieldNotes: "服务端旧备注",
          handoverMileageKm: 123
        },
        true
      )
    ).toEqual(draft);
    expect(
      resolveFieldHandoverFactsAfterRefresh(
        draft,
        {
          energyLevelText: "服务端 50%",
          fieldNotes: "服务端旧备注",
          handoverMileageKm: 123
        },
        false
      )
    ).toMatchObject({
      energyLevelText: "服务端 50%",
      fieldNotes: "服务端旧备注",
      handoverMileageKm: 123
    });
  });

  it("preserves all local facts after a damage-state refresh", () => {
    const draft = {
      accessoryChecklistText: "两把钥匙、充电线",
      damageDeclared: true,
      deliveryLocation: "上海交付中心 B 区",
      energyLevelText: "72%",
      fieldNotes: "右前轮毂轻微划痕",
      fuelLevelText: "满油",
      handoverMileageKm: 321,
      noVisibleDamageDeclared: false,
      scheduledAt: "2026-07-26T07:30:00.000Z"
    };

    expect(
      resolveFieldHandoverFactsAfterRefresh(
        draft,
        {
          accessoryChecklist: {},
          damageDeclared: true,
          deliveryLocation: "",
          energyLevelText: "",
          fieldNotes: "",
          fuelLevelText: "",
          handoverMileageKm: null,
          noVisibleDamageDeclared: false,
          scheduledAt: null
        },
        true
      )
    ).toEqual(draft);
  });

  it("reopens legacy customer-reviewing objections when Admin requested field resubmission", () => {
    const view = buildFieldEvidenceCaptureView({
      ...sampleDetail(),
      adminReviewStatus: "RESUBMISSION_REQUESTED",
      fieldResubmissionRequested: true,
      status: "CUSTOMER_REVIEWING"
    });

    expect(view.canEdit).toBe(true);
    expect(view.lockedMessage).toBeNull();
    expect(view.showStartAction).toBe(false);
    expect(view.showSaveAction).toBe(true);
    expect(view.showSubmitAction).toBe(true);
    expect(view.evidenceItems.some((item) => item.showUpload)).toBe(true);
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

function sampleDetail(): FieldHandoverWorkOrderDetail {
  return {
    ...sampleTask(),
    evidenceChecklist: {
      blockingReasons: [],
      items: sampleEvidenceItems({ noVisibleDamageDeclared: true }),
      ready: false
    },
    fieldFacts: {
      accessoryChecklist: { chargingCable: true, keys: 2 },
      damageDeclared: false,
      deliveryLocation: "上海交付中心",
      energyLevelText: "80%",
      fieldNotes: "safe note",
      handoverMileageKm: 1200,
      noVisibleDamageDeclared: true,
      scheduledAt: "2026-07-22T10:00:00.000Z"
    },
    status: "FIELD_IN_PROGRESS"
  } as FieldHandoverWorkOrderDetail;
}

function sampleEvidenceItems(options: {
  damageDeclared?: boolean;
  missingDamageCloseup?: boolean;
  noVisibleDamageDeclared?: boolean;
}) {
  const titles = [
    ["CUSTOMER_WITH_VEHICLE_FRONT", "客户与车辆正面合影", ["PHOTO"]],
    ["VEHICLE_FRONT", "车辆车头正面", ["PHOTO"]],
    ["VEHICLE_REAR", "车辆车尾正面", ["PHOTO"]],
    ["VIN_OR_FRAME_NUMBER", "车架号 / VIN", ["PHOTO"]],
    ["ODOMETER_DASHBOARD", "仪表台公里数", ["PHOTO"]],
    ["INTERIOR_REAR", "后排内饰", ["PHOTO"]],
    ["INTERIOR_FRONT", "前排内饰", ["PHOTO"]],
    ["WALKAROUND_VIDEO", "车辆环绕视频", ["VIDEO"]],
    ["WHEEL_CLOSEUP_FRONT_LEFT", "左前轮毂近拍", ["PHOTO", "VIDEO"]],
    ["WHEEL_CLOSEUP_FRONT_RIGHT", "右前轮毂近拍", ["PHOTO", "VIDEO"]],
    ["WHEEL_CLOSEUP_REAR_LEFT", "左后轮毂近拍", ["PHOTO", "VIDEO"]],
    ["WHEEL_CLOSEUP_REAR_RIGHT", "右后轮毂近拍", ["PHOTO", "VIDEO"]],
    ["DAMAGE_STATIC_CLOSEUP", "损伤/瑕疵静态近拍", ["PHOTO", "VIDEO"]],
    ["NO_VISIBLE_DAMAGE_DECLARATION", "无可见损伤声明", []]
  ] as const;

  return titles.map(([evidenceType, title, allowedMediaTypes], index) => {
    const isDamageCloseup = evidenceType === "DAMAGE_STATIC_CLOSEUP";
    const isNoDamage = evidenceType === "NO_VISIBLE_DAMAGE_DECLARATION";
    const isVideo = evidenceType === "WALKAROUND_VIDEO";
    const hasFile =
      !isNoDamage &&
      (!isDamageCloseup || (options.damageDeclared && !options.missingDamageCloseup));
    return {
      allowsMultiple: isDamageCloseup,
      allowedMediaTypes,
      declaredNoDamage: isNoDamage ? options.noVisibleDamageDeclared === true : null,
      evidenceType,
      fileCount: hasFile ? 1 : 0,
      fileRequired: !isNoDamage,
      files: hasFile
        ? [
            {
              displayName: `${index}.${isVideo ? "mov" : "jpg"}`,
              evidenceFileId: `evidence-file-${index}`,
              file: {
                id: `file-${index}`,
                mimeType: isVideo ? "video/quicktime" : "image/jpeg",
                originalName: `${index}.${isVideo ? "mov" : "jpg"}`,
                sizeBytes: 1000
              },
              mediaType: isVideo ? "VIDEO" : "PHOTO",
              metadata: isVideo
                ? {
                    videoHeightPx: 1080,
                    videoQualityStatus: "PASSED",
                    videoWidthPx: 1920
                  }
                : null,
              previewUrl: `/api/field/handover/work-orders/work-order-1/evidence-files/evidence-file-${index}/preview`
            }
          ]
        : [],
      id: `evidence-item-${index + 1}`,
      isConditional: isDamageCloseup || isNoDamage,
      isRequired: !isDamageCloseup && !isNoDamage,
      requirementLevel: isDamageCloseup || isNoDamage ? "CONDITIONAL" : "REQUIRED",
      reviewStatus:
        isNoDamage && options.noVisibleDamageDeclared
          ? "APPROVED"
          : hasFile
            ? "PENDING"
            : "NOT_STARTED",
      status:
        isNoDamage && options.noVisibleDamageDeclared
          ? "APPROVED"
          : hasFile
            ? "UPLOADED"
            : "NOT_STARTED",
      title
    };
  });
}
