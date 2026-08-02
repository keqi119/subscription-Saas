export interface DeliveryConfirmationDefaults {
  deliveredAt: string;
  deliveredAtSource: "STAGE2_COMPLETED_AT";
  fieldWorkOrderId: string;
  handoverMileageKm: number;
  handoverMileageSource: "FIELD_WORK_ORDER";
  stage2HandoverId: string;
}

export interface VehicleMileageReadingView {
  deltaKm: number;
  id: string;
  mileageKm: number;
  order?: { id: string; orderNo: string } | null;
  recordedAt: string;
  sourceRecordId: string;
  sourceType: string;
  status: string;
}

const SOURCE_PRESENTATIONS: Record<string, { color: string; label: string }> = {
  DELIVERY_BASELINE: { color: "cyan", label: "交付基线" },
  LEGACY_MIGRATION: { color: "default", label: "历史数据迁移" },
  MANUAL_CORRECTION: { color: "orange", label: "人工更正" },
  MONTHLY_REVIEW: { color: "blue", label: "月度里程复核" },
  RETURN_CONFIRMATION: { color: "purple", label: "退车确认" },
  VEHICLE_INITIALIZATION: { color: "green", label: "车辆初始化" }
};

const STATUS_PRESENTATIONS: Record<string, { color: string; label: string }> = {
  ACTIVE: { color: "green", label: "有效" },
  VOIDED: { color: "default", label: "已作废" }
};

export function getDeliveryConfirmationSourceHints(
  defaults: DeliveryConfirmationDefaults | null | undefined
) {
  return defaults
    ? {
        deliveredAt: "来源：Stage 2 双方签署完成时间",
        handoverMileageKm: "来源：Field 现场交接里程"
      }
    : {
        deliveredAt: "等待 Stage 2 双方签署完成时间",
        handoverMileageKm: "等待 Field 现场交接里程"
      };
}

export function getDeliveryConfirmationAdjustmentState(
  values: {
    deliveredAt?: string | null;
    handoverMileageKm?: number | null;
  },
  defaults: DeliveryConfirmationDefaults | null | undefined
) {
  if (!defaults) {
    return { deliveredAt: false, handoverMileageKm: false };
  }
  const deliveredAt = values.deliveredAt
    ? new Date(values.deliveredAt).getTime() !== new Date(defaults.deliveredAt).getTime()
    : false;
  return {
    deliveredAt,
    handoverMileageKm:
      values.handoverMileageKm !== undefined &&
      values.handoverMileageKm !== null &&
      values.handoverMileageKm !== defaults.handoverMileageKm
  };
}

export function getVehicleMileageSourcePresentation(sourceType: string) {
  return SOURCE_PRESENTATIONS[sourceType] ?? { color: "default", label: sourceType || "未知来源" };
}

export function getVehicleMileageStatusPresentation(status: string) {
  return STATUS_PRESENTATIONS[status] ?? { color: "default", label: status || "未知状态" };
}

export function buildVehicleMileageTimelineItem(reading: VehicleMileageReadingView) {
  const source = getVehicleMileageSourcePresentation(reading.sourceType);
  const status = getVehicleMileageStatusPresentation(reading.status);
  const deltaPrefix = reading.deltaKm > 0 ? "+" : "";
  return {
    color: source.color,
    deltaText: `${deltaPrefix}${reading.deltaKm.toLocaleString("zh-CN")} km`,
    mileageText: `${reading.mileageKm.toLocaleString("zh-CN")} km`,
    orderText: reading.order?.orderNo ?? null,
    recordedAt: reading.recordedAt,
    sourceLabel: source.label,
    sourceRecordId: reading.sourceRecordId,
    statusColor: status.color,
    statusLabel: status.label
  };
}
