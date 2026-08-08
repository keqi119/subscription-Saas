export const RIGHTS_DOCUMENT_TYPES = [
  "VEHICLE_REGISTRATION_CERTIFICATE",
  "VEHICLE_LICENSE",
  "VEHICLE_INSPECTION_REPORT",
  "VEHICLE_PURCHASE_AGREEMENT",
  "MOTOR_VEHICLE_INVOICE",
  "OWNER_IDENTITY_DOCUMENT",
  "VEHICLE_CONFIGURATION_SHEET",
  "PURCHASE_PAYMENT_VOUCHER"
] as const;

export const OTHER_INTERNAL_DOCUMENT_TYPES = [
  "INSPECTION_CERTIFICATE",
  "VEHICLE_AUTHORIZATION",
  "OTHER"
] as const;

export type RightsDocumentType = (typeof RIGHTS_DOCUMENT_TYPES)[number];
export type OtherInternalDocumentType = (typeof OTHER_INTERNAL_DOCUMENT_TYPES)[number];

export interface VehicleDocumentView {
  createdAt: string;
  deletedAt?: string | null;
  documentStatus: string;
  documentType: string;
  fileName: string;
  fileSize: number | null;
  id: string;
  mimeType: string | null;
  originalName: string | null;
  previewUrl: string;
  title: string | null;
  updatedAt: string;
  uploadedBy: string | null;
  vehicleId: string;
}

export interface VehicleDocumentBatchView {
  createdAt: string;
  documentType: string;
  id: string;
  items: VehicleDocumentView[];
  uploadedBy: string | null;
  vehicleId: string;
  versionNo: number;
}

export interface RightsDocumentGroup {
  batches: VehicleDocumentBatchView[];
  documentType: RightsDocumentType;
  label: string;
}

export const RIGHTS_DOCUMENT_LABELS = {
  MOTOR_VEHICLE_INVOICE: "机动车发票",
  OWNER_IDENTITY_DOCUMENT: "车主信息",
  PURCHASE_PAYMENT_VOUCHER: "车辆采购支付凭证",
  VEHICLE_CONFIGURATION_SHEET: "车辆配置单",
  VEHICLE_INSPECTION_REPORT: "车辆检测报告",
  VEHICLE_LICENSE: "车辆行驶证",
  VEHICLE_PURCHASE_AGREEMENT: "车辆购买合同及附属协议",
  VEHICLE_REGISTRATION_CERTIFICATE: "机动车登记证"
} as const satisfies Record<RightsDocumentType, string>;

const RIGHTS_DOCUMENT_TYPE_SET = new Set<string>(RIGHTS_DOCUMENT_TYPES);
const OTHER_INTERNAL_DOCUMENT_TYPE_SET = new Set<string>(OTHER_INTERNAL_DOCUMENT_TYPES);
const MULTI_FILE_DOCUMENT_TYPE_SET = new Set<string>([
  "VEHICLE_PURCHASE_AGREEMENT",
  "OWNER_IDENTITY_DOCUMENT",
  "PURCHASE_PAYMENT_VOUCHER"
]);
const PRODUCT_REUSABLE_DOCUMENT_TYPE_SET = new Set<string>([
  "VEHICLE_CONFIGURATION_SHEET",
  "VEHICLE_INSPECTION_REPORT"
]);

export function getRightsDocumentCompleteness(
  batches: readonly VehicleDocumentBatchView[]
): { completed: number; missingTypes: RightsDocumentType[]; total: 8 } {
  const completedTypes = new Set<RightsDocumentType>();
  for (const batch of batches) {
    if (
      isRightsDocumentType(batch.documentType) &&
      batch.items.some(isActiveDocument)
    ) {
      completedTypes.add(batch.documentType);
    }
  }

  return {
    completed: completedTypes.size,
    missingTypes: RIGHTS_DOCUMENT_TYPES.filter((type) => !completedTypes.has(type)),
    total: 8
  };
}

export function getRightsDocumentGroups(
  batches: readonly VehicleDocumentBatchView[]
): RightsDocumentGroup[] {
  return RIGHTS_DOCUMENT_TYPES.map((documentType) => ({
    batches: batches
      .filter((batch) => batch.documentType === documentType)
      .sort((left, right) => right.versionNo - left.versionNo),
    documentType,
    label: RIGHTS_DOCUMENT_LABELS[documentType]
  }));
}

export function getOtherInternalDocumentBatches(
  batches: readonly VehicleDocumentBatchView[]
): VehicleDocumentBatchView[] {
  return batches
    .filter((batch) => OTHER_INTERNAL_DOCUMENT_TYPE_SET.has(batch.documentType))
    .sort((left, right) => {
      const typeOrder =
        OTHER_INTERNAL_DOCUMENT_TYPES.indexOf(left.documentType as OtherInternalDocumentType) -
        OTHER_INTERNAL_DOCUMENT_TYPES.indexOf(right.documentType as OtherInternalDocumentType);
      return typeOrder || right.versionNo - left.versionNo;
    });
}

export function getActiveBatchFileCount(batch: VehicleDocumentBatchView) {
  return batch.items.filter(isActiveDocument).length;
}

export function getDocumentBatchFileLimit(documentType: string) {
  return MULTI_FILE_DOCUMENT_TYPE_SET.has(documentType) ? 20 : 1;
}

export function isAdditiveRightsDocumentType(documentType: string) {
  return documentType === "PURCHASE_PAYMENT_VOUCHER";
}

export function isProductReusableDocument(document: VehicleDocumentView) {
  return (
    PRODUCT_REUSABLE_DOCUMENT_TYPE_SET.has(document.documentType) &&
    document.mimeType?.startsWith("image/") === true &&
    isActiveDocument(document)
  );
}

export function canArchiveDocument(document: VehicleDocumentView, boundDocumentIds: ReadonlySet<string>) {
  return isActiveDocument(document) && !boundDocumentIds.has(document.id);
}

export function canDeleteVehicleDocument(
  document: VehicleDocumentView,
  boundDocumentIds: ReadonlySet<string>
) {
  return canArchiveDocument(document, boundDocumentIds);
}

export function canArchiveDocumentBatch(
  batch: VehicleDocumentBatchView,
  boundDocumentIds: ReadonlySet<string>
) {
  const activeDocuments = batch.items.filter(isActiveDocument);
  return (
    activeDocuments.length > 0 &&
    activeDocuments.every((document) => !boundDocumentIds.has(document.id))
  );
}

export function buildVehicleDocumentBatchFormData(
  documentType: RightsDocumentType,
  files: readonly File[]
) {
  const fileLimit = getDocumentBatchFileLimit(documentType);
  if (files.length === 0) {
    throw new Error("at least one vehicle document file is required");
  }
  if (files.length > fileLimit) {
    throw new Error(`vehicle document batch cannot exceed ${fileLimit} files`);
  }

  const formData = new FormData();
  formData.append("documentType", documentType);
  for (const file of files) {
    formData.append("files", file, file.name);
  }
  return formData;
}

export function isRightsDocumentType(value: string): value is RightsDocumentType {
  return RIGHTS_DOCUMENT_TYPE_SET.has(value);
}

function isActiveDocument(document: VehicleDocumentView) {
  return document.documentStatus === "ACTIVE" && !document.deletedAt;
}
