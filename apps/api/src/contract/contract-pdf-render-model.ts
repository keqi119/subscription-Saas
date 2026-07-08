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

export interface ContractPdfSigningAnchors {
  customerSignatureKeyword: string;
  platformSealKeyword: string;
  platformSealOffsetX?: number;
  platformSealOffsetY?: number;
}

export interface ContractPdfRenderDiagnostics {
  hasAppendix: boolean;
  hasCjkContent: boolean;
  hasCustomerSignatureKeyword: boolean;
  hasLegalBody: boolean;
  hasPlatformSealKeyword: boolean;
}

export interface ContractPdfRenderModel {
  appendix: ContractPdfAppendix;
  contentTemplate: string;
  contractId: string;
  contractNo: string;
  generatedAt: Date | string;
  orderNo: string;
  signingAnchors: ContractPdfSigningAnchors;
  templateName: string;
  templateVersion: string;
}
