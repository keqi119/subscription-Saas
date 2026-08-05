import {
  ContractPdfDocumentType,
  ContractPdfRenderDiagnostics,
  ContractPdfRenderModel,
  ContractPdfSignerRole,
  ContractPdfSigningStage,
  ContractPdfSigningSlotCoordinate,
  ContractPdfStage1SigningSlotOccurrences
} from "./contract-pdf-render-model";

export const CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE = "CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE";
export const CONTRACT_PDF_ARTIFACT_APPENDIX_MISSING = "CONTRACT_PDF_ARTIFACT_APPENDIX_MISSING";
export const CONTRACT_PDF_ARTIFACT_EXISTING_FILE = "CONTRACT_PDF_ARTIFACT_EXISTING_FILE";
export const CONTRACT_PDF_ARTIFACT_LEGAL_BODY_MISSING = "CONTRACT_PDF_ARTIFACT_LEGAL_BODY_MISSING";
export const CONTRACT_PDF_ARTIFACT_PROTECTED_STATUS = "CONTRACT_PDF_ARTIFACT_PROTECTED_STATUS";
export const CONTRACT_PDF_ARTIFACT_RENDER_ANCHOR_MISSING =
  "CONTRACT_PDF_ARTIFACT_RENDER_ANCHOR_MISSING";
export const CONTRACT_PDF_ARTIFACT_SLOT_COORDINATE_INVALID =
  "CONTRACT_PDF_ARTIFACT_SLOT_COORDINATE_INVALID";
export const CONTRACT_PDF_ARTIFACT_SLOT_COORDINATE_MISSING =
  "CONTRACT_PDF_ARTIFACT_SLOT_COORDINATE_MISSING";
export const CONTRACT_PDF_ARTIFACT_STORAGE_OBJECT_EXISTS =
  "CONTRACT_PDF_ARTIFACT_STORAGE_OBJECT_EXISTS";
export const CONTRACT_PDF_ARTIFACT_TOO_LARGE = "CONTRACT_PDF_ARTIFACT_TOO_LARGE";
export const CONTRACT_PDF_GENERATED_ARTIFACT_SOURCE = "GENERATED_CONTRACT_PDF";

export interface ContractPdfArtifactWriteInput {
  allowBuiltinFontForAsciiOnlyTests?: boolean;
  allowRegenerate?: boolean;
  cjkFontPath?: string;
  contractStatus?: string;
  existingContractFileId?: null | string;
  maxBytes?: number;
  recoverExistingObject?: boolean;
  renderModel: ContractPdfRenderModel;
  uploadedBy?: null | string;
}

export interface ContractPdfArtifactAnchorOccurrences {
  stage1SigningSlots: ContractPdfStage1SigningSlotOccurrences;
}

export interface ContractPdfArtifactSlotCoordinateDiagnostic extends ContractPdfSigningSlotCoordinate {
  documentType: ContractPdfDocumentType;
  signerRole: ContractPdfSignerRole;
  signingStage: ContractPdfSigningStage;
}

export interface ContractPdfArtifactDiagnostics {
  anchorOccurrences: ContractPdfArtifactAnchorOccurrences;
  renderDiagnostics: ContractPdfRenderDiagnostics;
  searchableTextPdfRequired: true;
  signingStage: ContractPdfSigningStage;
  slotCoordinates: ContractPdfArtifactSlotCoordinateDiagnostic[];
  source: typeof CONTRACT_PDF_GENERATED_ARTIFACT_SOURCE;
  textExtractionVerified: false;
}

export interface ContractPdfArtifactWriteResult {
  bucket: string;
  diagnostics: ContractPdfArtifactDiagnostics;
  fileId: string;
  mimeType: "application/pdf";
  objectKey: string;
  originalName: string;
  sizeBytes: number;
}

export interface GeneratedContractPdfStorageResult {
  bucket: string;
  contentType: "application/pdf";
  objectKey: string;
  originalName: string;
  sizeBytes: number;
}
