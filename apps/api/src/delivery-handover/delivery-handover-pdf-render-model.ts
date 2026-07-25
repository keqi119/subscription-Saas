import {
  buildDeliveryHandoverEvidencePackage,
  DeliveryHandoverEvidenceManifestFile,
  DeliveryHandoverEvidencePackage,
  STAGE2_EVIDENCE_CONFIRMATION_TEXT
} from "./delivery-handover-evidence-manifest";

export const STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT = 14;

const EMPTY_VALUE = "-";
const UNSAFE_KEY_PATTERN = /(bucket|objectKey|signUrl|signingUrl|storageKey|url)$/i;

export interface DeliveryHandoverPdfRenderModelInput {
  documentNo: string;
  evidenceChecklist?: unknown;
  evidencePackage?: DeliveryHandoverEvidencePackage;
  generatedAt?: Date | string | null;
  handover?: unknown;
  order?: unknown;
  platform?: {
    contactName?: null | string;
    contactPhone?: null | string;
    legalName?: null | string;
  };
  template?: unknown;
  workOrder?: unknown;
}

export interface DeliveryHandoverPdfRenderModel {
  confirmationText: string;
  customer: {
    address: string;
    idNumberMasked: string;
    mobileMasked: string;
    name: string;
  };
  customerReview: {
    confirmedAt: string;
    objectionStatus: string;
  };
  documentNo: string;
  evidenceSummary: {
    itemCount: number;
    items: DeliveryHandoverPdfEvidenceSummaryItem[];
  };
  evidencePackage: {
    files: DeliveryHandoverEvidenceManifestFile[];
    manifestHash: string;
    packageId: string;
    schemaVersion: number;
    stats: DeliveryHandoverEvidencePackage["stats"];
  };
  fees: {
    otherFees: string;
    paidRent: string;
    vehicleDeposit: string;
    violationDeposit: string;
  };
  fieldFacts: {
    accessoryChecklistText: string;
    damageDescription: string;
    damageStatus: string;
    energyLevelText: string;
    fieldNotes: string;
    fuelLevelText: string;
    handoverMileageKm: string;
  };
  generatedAt: string;
  handoverDate: string;
  handoverId: string;
  handoverPlace: string;
  operationTips: string[];
  orderNo: string;
  platform: {
    contactName: string;
    contactPhone: string;
    legalName: string;
  };
  specialNotices: string[];
  stage1ContractNo: string;
  templateName: string;
  templateVersion: string;
  vehicle: {
    brandModel: string;
    plateNo: string;
    vinSuffix: string;
  };
  workOrderId: string;
}

export interface DeliveryHandoverPdfEvidenceSummaryItem {
  evidenceType: string;
  fileCount: number;
  fileRequired: boolean;
  files: DeliveryHandoverPdfEvidenceSummaryFile[];
  id: string;
  isConditional: boolean;
  isRequired: boolean;
  reviewStatus: string;
  status: string;
  title: string;
}

export interface DeliveryHandoverPdfEvidenceSummaryFile {
  displayName: string;
  evidenceFileId: string;
  fileId: string;
  mediaType: string;
  mimeType: string;
  sizeBytes: number | null;
  uploadedAt: string;
}

export function buildDeliveryHandoverPdfRenderModel(
  input: DeliveryHandoverPdfRenderModelInput
): DeliveryHandoverPdfRenderModel {
  const order = asRecord(input.order);
  const customer = asRecord(order?.customer);
  const identity = asRecord(customer?.identity);
  const profile = asRecord(customer?.profile);
  const vehicle = asRecord(order?.vehicle);
  const workOrder = asRecord(input.workOrder);
  const handover = asRecord(input.handover);
  const template = asRecord(input.template);
  const generatedAt = toIso(input.generatedAt) ?? new Date().toISOString();
  const evidenceItems = normalizeEvidenceSummary(input.evidenceChecklist);
  const evidencePackage = input.evidencePackage ?? buildDeliveryHandoverEvidencePackage({
    evidenceChecklist: input.evidenceChecklist,
    handoverId: readString(handover, "id") ?? "",
    orderId: readString(order, "id") ?? "",
    workOrderId: readString(workOrder, "id") ?? ""
  });
  const noVisibleDamageDeclared = readBoolean(workOrder, "noVisibleDamageDeclared");
  const damageDeclared = readBoolean(workOrder, "damageDeclared");

  const model: DeliveryHandoverPdfRenderModel = {
    confirmationText:
      `${STAGE2_EVIDENCE_CONFIRMATION_TEXT} 本人确认本次签署对应证据包 ${evidencePackage.manifest.evidencePackageId} 及 ${evidencePackage.manifestHash}。`,
    customer: {
      address:
        readString(profile, "residenceAddress") ??
        readString(customer, "registeredAddress") ??
        EMPTY_VALUE,
      idNumberMasked: maskIdNumber(readString(identity, "idCardNo") ?? readString(customer, "idNumber")),
      mobileMasked: maskPhone(readString(customer, "mobile")) ?? EMPTY_VALUE,
      name: readString(customer, "name") ?? EMPTY_VALUE
    },
    customerReview: {
      confirmedAt: formatDateTime(readDate(workOrder, "customerConfirmedAt")),
      objectionStatus: readDate(workOrder, "customerObjectedAt") ? "客户存在异议" : "客户已确认无异议"
    },
    documentNo: normalizeText(input.documentNo) ?? EMPTY_VALUE,
    evidenceSummary: {
      itemCount: evidenceItems.length,
      items: evidenceItems
    },
    evidencePackage: {
      files: evidencePackage.manifest.files,
      manifestHash: evidencePackage.manifestHash,
      packageId: evidencePackage.manifest.evidencePackageId,
      schemaVersion: evidencePackage.manifest.schemaVersion,
      stats: evidencePackage.stats
    },
    fees: {
      otherFees: formatCurrencyLike(order?.otherFeeAmount),
      paidRent: formatCurrencyLike(order?.monthlyFeeAmount),
      vehicleDeposit: formatCurrencyLike(order?.depositAmount),
      violationDeposit: EMPTY_VALUE
    },
    fieldFacts: {
      accessoryChecklistText: formatAccessoryChecklist(workOrder?.accessoryChecklist),
      damageDescription: normalizeText(readString(workOrder, "fieldNotes")) ?? EMPTY_VALUE,
      damageStatus: damageDeclared === true
        ? "现场声明存在损伤"
        : noVisibleDamageDeclared === true
          ? "已声明无可见损伤"
          : EMPTY_VALUE,
      energyLevelText: readString(workOrder, "energyLevelText") ?? EMPTY_VALUE,
      fieldNotes: readString(workOrder, "fieldNotes") ?? EMPTY_VALUE,
      fuelLevelText: readString(workOrder, "fuelLevelText") ?? EMPTY_VALUE,
      handoverMileageKm: formatMileage(workOrder?.handoverMileageKm)
    },
    generatedAt,
    handoverDate: formatDateTime(readDate(workOrder, "scheduledAt") ?? readDate(workOrder, "fieldSubmittedAt")),
    handoverId: readString(handover, "id") ?? EMPTY_VALUE,
    handoverPlace: readString(workOrder, "deliveryLocation") ?? EMPTY_VALUE,
    operationTips: [
      "交车时务必围绕车辆拍摄 360度环绕视频 及 45度角特写照片，清晰记录车辆外观、轮胎、内饰和随车物品。",
      "本交接单一式两份，承租方与出租方各执一份，电子签核版本与纸质签字版本具有同等确认效力。",
      "电子签核需确保使用具有法律效力的第三方电子合同平台。"
    ],
    orderNo: readString(order, "orderNo") ?? EMPTY_VALUE,
    platform: {
      contactName:
        normalizeText(input.platform?.contactName) ??
        readString(workOrder, "externalOperatorName") ??
        EMPTY_VALUE,
      contactPhone:
        maskPhone(input.platform?.contactPhone) ??
        maskPhone(readString(workOrder, "externalOperatorPhone")) ??
        EMPTY_VALUE,
      legalName: normalizeText(input.platform?.legalName) ?? "汽车订阅平台"
    },
    specialNotices: [
      "违章处理：交付后发生的交通违法、罚款、记分及相关处理责任以合同约定和交接时间为准。",
      "事故处理：发生事故、剐蹭、损伤或保险理赔事项时，承租方应及时通知出租方并配合留存证据。",
      "限行/禁行：承租方应自行了解并遵守车辆使用地限行、禁行及停车管理要求。",
      "还车标准：还车时车辆、随车证件、钥匙、工具和附件应按本单记载状态返还。"
    ],
    stage1ContractNo:
      readString(handover, "stage1ContractNo") ??
      readString(asRecord(handover?.stage1Contract), "contractNo") ??
      EMPTY_VALUE,
    templateName: readString(template, "templateName") ?? "车辆交接确认单",
    templateVersion: readString(template, "versionNo") ?? EMPTY_VALUE,
    vehicle: {
      brandModel: [readString(vehicle, "brand"), readString(vehicle, "model")].filter(Boolean).join(" ") || EMPTY_VALUE,
      plateNo: readString(vehicle, "plateNo") ?? EMPTY_VALUE,
      vinSuffix: suffix(readString(vehicle, "vin"), 6) ?? EMPTY_VALUE
    },
    workOrderId: readString(workOrder, "id") ?? EMPTY_VALUE
  };

  assertNoUnsafeKeys(model);
  return model;
}

function normalizeEvidenceSummary(checklist: unknown) {
  const checklistRecord = asRecord(checklist);
  const items = Array.isArray(checklistRecord?.items) ? checklistRecord.items : [];
  return items
    .filter(isPlainObject)
    .slice(0, STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT)
    .map((item, index): DeliveryHandoverPdfEvidenceSummaryItem => {
      const files = Array.isArray(item.files) ? item.files.filter(isPlainObject).map(toSafeEvidenceFile) : [];
      return {
        evidenceType: readString(item, "evidenceType") ?? `EVIDENCE_${index + 1}`,
        fileCount: files.length,
        fileRequired: readBoolean(item, "fileRequired") ?? false,
        files,
        id: readString(item, "id") ?? `evidence-item-${index + 1}`,
        isConditional: readBoolean(item, "isConditional") ?? false,
        isRequired: readBoolean(item, "isRequired") ?? false,
        reviewStatus: readString(item, "reviewStatus") ?? EMPTY_VALUE,
        status: readString(item, "status") ?? EMPTY_VALUE,
        title: readString(item, "title") ?? `证据项 ${index + 1}`
      };
    });
}

function toSafeEvidenceFile(file: Record<string, unknown>): DeliveryHandoverPdfEvidenceSummaryFile {
  const nested = asRecord(file.file);
  return {
    displayName: readString(nested, "originalName") ?? readString(file, "originalName") ?? EMPTY_VALUE,
    evidenceFileId: readString(file, "id") ?? EMPTY_VALUE,
    fileId: readString(file, "fileId") ?? readString(nested, "id") ?? EMPTY_VALUE,
    mediaType: readString(file, "mediaType") ?? EMPTY_VALUE,
    mimeType: readString(nested, "mimeType") ?? readString(file, "mimeType") ?? EMPTY_VALUE,
    sizeBytes: toNumberOrNull(nested?.sizeBytes ?? file.sizeBytes),
    uploadedAt: formatDateTime(toDate(file.uploadedAt))
  };
}

function assertNoUnsafeKeys(value: unknown, path: string[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeKeys(item, [...path, String(index)]));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_KEY_PATTERN.test(key)) {
      throw new Error(`STAGE2_HANDOVER_PDF_UNSAFE_FIELD: ${[...path, key].join(".")}`);
    }
    assertNoUnsafeKeys(entry, [...path, key]);
  }
}

function formatAccessoryChecklist(value: unknown) {
  if (Array.isArray(value)) {
    const entries = value.map((item) => normalizeText(item)).filter(Boolean);
    return entries.length ? entries.join("、") : EMPTY_VALUE;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => Boolean(entry))
      .map(([key]) => key);
    return entries.length ? entries.join("、") : EMPTY_VALUE;
  }
  return normalizeText(value) ?? EMPTY_VALUE;
}

function formatCurrencyLike(value: unknown) {
  const numberValue = toNumberOrNull(value);
  return numberValue === null ? EMPTY_VALUE : `${numberValue / 100} 元`;
}

function formatMileage(value: unknown) {
  const numberValue = toNumberOrNull(value);
  return numberValue === null ? EMPTY_VALUE : `${numberValue} km`;
}

function formatDateTime(value: Date | null) {
  return value ? value.toISOString() : EMPTY_VALUE;
}

function readDate(record: null | Record<string, unknown>, key: string) {
  return toDate(record?.[key]);
}

function toDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIso(value: Date | null | string | undefined) {
  return toDate(value)?.toISOString() ?? null;
}

function maskIdNumber(value: null | string) {
  if (!value) {
    return EMPTY_VALUE;
  }
  if (value.length <= 4) {
    return "****";
  }
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function maskPhone(value: null | string | undefined) {
  if (!value) {
    return null;
  }
  if (value.length < 7) {
    return "***";
  }
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function suffix(value: null | string, length: number) {
  return value ? value.slice(-length) : null;
}

function readString(record: null | Record<string, unknown>, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(record: null | Record<string, unknown>, key: string) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function normalizeText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toNumberOrNull(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return null;
}

function asRecord(value: unknown) {
  return isPlainObject(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
