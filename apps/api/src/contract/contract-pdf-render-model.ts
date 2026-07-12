export type ContractPdfValue = boolean | Date | number | string | null | undefined;

export interface ContractPdfAppendixRow {
  label: string;
  redaction?: {
    applied: boolean;
    reason?: string;
  };
  value: ContractPdfValue;
}

export interface ContractPdfAppendixSection {
  rows: ContractPdfAppendixRow[];
  title: string;
}

export interface ContractPdfAppendix {
  sections: ContractPdfAppendixSection[];
}

export type ContractPdfSigningStage = "STAGE1_CONTRACT";

export type ContractPdfDocumentType = "ATTACHMENT1_SUBSCRIPTION_PLAN" | "CONTRACT_BODY";

export type ContractPdfSigningSlotId =
  | "STAGE1_ATTACHMENT1_CUSTOMER"
  | "STAGE1_ATTACHMENT1_PLATFORM"
  | "STAGE1_BODY_CUSTOMER"
  | "STAGE1_BODY_PLATFORM";

export type ContractPdfSignerRole = "CUSTOMER" | "PLATFORM";

export interface ContractPdfSigningSlot {
  documentType: ContractPdfDocumentType;
  keyword: string;
  label: string;
  offsetX?: number;
  offsetY?: number;
  signerRole: ContractPdfSignerRole;
  slotId: ContractPdfSigningSlotId;
  stage: ContractPdfSigningStage;
  title: string;
}

export type ContractPdfSigningSlotCoordinateSource = "PDFKIT_RENDERER";
export type ContractPdfSigningSlotCoordinateSystem = "FADADA_800_1131_TOP_LEFT";

export interface ContractPdfSigningSlotCoordinate {
  coordinateSource: ContractPdfSigningSlotCoordinateSource;
  coordinateSystem: ContractPdfSigningSlotCoordinateSystem;
  height: number;
  keyword: string;
  pageNumber: number;
  pdfPageHeight: number;
  pdfPageWidth: number;
  slotId: ContractPdfSigningSlotId;
  width: number;
  x: number;
  y: number;
}

export interface ContractPdfSigningAnchors {
  customerSignatureKeyword: string;
  platformSealKeyword: string;
  platformSealOffsetX?: number;
  platformSealOffsetY?: number;
}

export interface ContractPdfSubscriberPartyInfo {
  subscriberContactAddress: ContractPdfValue;
  subscriberContactName: ContractPdfValue;
  subscriberContactPhone: ContractPdfValue;
  subscriberEmail: ContractPdfValue;
  subscriberIdNumber: ContractPdfValue;
  subscriberName: ContractPdfValue;
  subscriberWechat: ContractPdfValue;
}

export type ContractPdfStage1SigningSlotOccurrences = Record<ContractPdfSigningSlotId, number>;

export interface ContractPdfRenderDiagnostics {
  hasAppendix: boolean;
  hasCjkContent: boolean;
  hasCustomerSignatureKeyword: boolean;
  hasLegalBody: boolean;
  hasPlatformSealKeyword: boolean;
  hasStage1SigningSlots: boolean;
  stage1SigningSlotOccurrences: ContractPdfStage1SigningSlotOccurrences;
}

export interface ContractPdfRenderModel {
  appendix: ContractPdfAppendix;
  contentTemplate: string;
  contractId: string;
  contractNo: string;
  generatedAt: Date | string;
  orderNo: string;
  /**
   * Legacy two-anchor compatibility metadata. Stage 1 PDF generation must use
   * signingSlots instead of rendering this metadata as placement text.
   */
  signingAnchors?: ContractPdfSigningAnchors;
  signingSlots: ContractPdfSigningSlot[];
  signingStage: ContractPdfSigningStage;
  subscriberParty?: ContractPdfSubscriberPartyInfo;
  templateName: string;
  templateVersion: string;
}

export const STAGE1_BODY_CUSTOMER_KEYWORD = "合同正文-订阅方签字";
export const STAGE1_BODY_PLATFORM_KEYWORD = "合同正文-服务提供方盖章";
export const STAGE1_ATTACHMENT1_CUSTOMER_KEYWORD = "附件1订阅方案-订阅方签字";
export const STAGE1_ATTACHMENT1_PLATFORM_KEYWORD = "附件1订阅方案-服务提供方盖章";

export const STAGE1_CONTRACT_PDF_REQUIRED_SLOT_IDS: ContractPdfSigningSlotId[] = [
  "STAGE1_BODY_CUSTOMER",
  "STAGE1_BODY_PLATFORM",
  "STAGE1_ATTACHMENT1_CUSTOMER",
  "STAGE1_ATTACHMENT1_PLATFORM"
];

export const STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS: ContractPdfSigningSlot[] = [
  {
    documentType: "CONTRACT_BODY",
    keyword: STAGE1_BODY_CUSTOMER_KEYWORD,
    label: "订阅方签字",
    signerRole: "CUSTOMER",
    slotId: "STAGE1_BODY_CUSTOMER",
    stage: "STAGE1_CONTRACT",
    title: "合同正文签署区"
  },
  {
    documentType: "CONTRACT_BODY",
    keyword: STAGE1_BODY_PLATFORM_KEYWORD,
    label: "服务提供方盖章",
    offsetX: 60,
    offsetY: 0,
    signerRole: "PLATFORM",
    slotId: "STAGE1_BODY_PLATFORM",
    stage: "STAGE1_CONTRACT",
    title: "合同正文签署区"
  },
  {
    documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
    keyword: STAGE1_ATTACHMENT1_CUSTOMER_KEYWORD,
    label: "订阅方签字",
    signerRole: "CUSTOMER",
    slotId: "STAGE1_ATTACHMENT1_CUSTOMER",
    stage: "STAGE1_CONTRACT",
    title: "附件1订阅方案签署区"
  },
  {
    documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
    keyword: STAGE1_ATTACHMENT1_PLATFORM_KEYWORD,
    label: "服务提供方盖章",
    offsetX: 60,
    offsetY: 0,
    signerRole: "PLATFORM",
    slotId: "STAGE1_ATTACHMENT1_PLATFORM",
    stage: "STAGE1_CONTRACT",
    title: "附件1订阅方案签署区"
  }
];

export function createStage1ContractPdfSigningSlots(): ContractPdfSigningSlot[] {
  return STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS.map((slot) => ({ ...slot }));
}

export function createEmptyStage1SigningSlotOccurrences(): ContractPdfStage1SigningSlotOccurrences {
  return {
    STAGE1_ATTACHMENT1_CUSTOMER: 0,
    STAGE1_ATTACHMENT1_PLATFORM: 0,
    STAGE1_BODY_CUSTOMER: 0,
    STAGE1_BODY_PLATFORM: 0
  };
}
