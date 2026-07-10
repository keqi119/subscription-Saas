import { Injectable } from "@nestjs/common";
import path from "node:path";

import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  ContractPdfRenderModel,
  ContractPdfSigningSlot,
  ContractPdfSigningSlotId,
  ContractPdfValue,
  STAGE1_CONTRACT_PDF_REQUIRED_SLOT_IDS,
  STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS
} from "./contract-pdf-render-model";
import { ContractPdfRendererService } from "./contract-pdf-renderer.service";
import {
  CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE,
  CONTRACT_PDF_ARTIFACT_APPENDIX_MISSING,
  CONTRACT_PDF_ARTIFACT_EXISTING_FILE,
  CONTRACT_PDF_ARTIFACT_LEGAL_BODY_MISSING,
  CONTRACT_PDF_ARTIFACT_PROTECTED_STATUS,
  CONTRACT_PDF_ARTIFACT_RENDER_ANCHOR_MISSING,
  CONTRACT_PDF_ARTIFACT_STORAGE_OBJECT_EXISTS,
  CONTRACT_PDF_ARTIFACT_TOO_LARGE,
  ContractPdfArtifactAnchorOccurrences,
  ContractPdfArtifactDiagnostics,
  ContractPdfArtifactWriteInput,
  ContractPdfArtifactWriteResult
} from "./contract-pdf-artifact.types";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const PROTECTED_CONTRACT_STATUSES = new Set(["ARCHIVED", "CANCELLED", "SIGNED", "TERMINATED"]);

@Injectable()
export class ContractPdfArtifactWriterService {
  constructor(
    private readonly renderer: ContractPdfRendererService,
    private readonly storageService: StorageService,
    private readonly prisma: PrismaService
  ) {}

  async writeGeneratedContractPdfArtifact(input: ContractPdfArtifactWriteInput): Promise<ContractPdfArtifactWriteResult> {
    validateContractStatus(input.contractStatus);
    validateExistingFile(input);
    const anchorOccurrences = validateAnchorUniqueness(input.renderModel);

    const renderResult = await this.renderer.render(input.renderModel, {
      allowBuiltinFontForAsciiOnlyTests: input.allowBuiltinFontForAsciiOnlyTests,
      cjkFontPath: input.cjkFontPath,
      maxBytes: input.maxBytes
    });
    validateRenderDiagnostics(renderResult.diagnostics);
    validateMaxBytes(renderResult.buffer, input.maxBytes ?? DEFAULT_MAX_BYTES);

    const objectKey = buildGeneratedContractPdfObjectKey(input.renderModel, renderResult.fileName);
    const existingArtifact = await this.prisma.fileObject.findFirst({
      where: {
        objectKey
      }
    });
    if (existingArtifact) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_STORAGE_OBJECT_EXISTS}: generated contract PDF object already exists`);
    }

    const stored = await this.storageService.putGeneratedContractPdfArtifact({
      buffer: renderResult.buffer,
      contentType: renderResult.contentType,
      contractId: input.renderModel.contractId,
      metadata: buildStorageMetadata(input.renderModel),
      objectKey,
      originalName: renderResult.fileName
    });

    try {
      const fileObject = await this.prisma.fileObject.create({
        data: {
          bucket: stored.bucket,
          mimeType: stored.contentType,
          objectKey: stored.objectKey,
          originalName: stored.originalName,
          sizeBytes: BigInt(stored.sizeBytes),
          uploadedBy: input.uploadedBy ?? null
        }
      });
      const diagnostics: ContractPdfArtifactDiagnostics = {
        anchorOccurrences,
        renderDiagnostics: renderResult.diagnostics,
        searchableTextPdfRequired: true,
        textExtractionVerified: false
      };

      return {
        bucket: stored.bucket,
        diagnostics,
        fileId: fileObject.id,
        mimeType: "application/pdf",
        objectKey: stored.objectKey,
        originalName: stored.originalName,
        sizeBytes: stored.sizeBytes
      };
    } catch (error) {
      await cleanupStoredObject(this.storageService, stored.bucket, stored.objectKey);
      throw error;
    }
  }
}

function validateContractStatus(status: string | undefined) {
  if (status && PROTECTED_CONTRACT_STATUSES.has(status)) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_PROTECTED_STATUS}: contract status ${status} cannot regenerate signing PDF`);
  }
}

function validateExistingFile(input: ContractPdfArtifactWriteInput) {
  if (input.existingContractFileId && !input.allowRegenerate) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_EXISTING_FILE}: contract already has a PDF artifact`);
  }
}

function validateAnchorUniqueness(model: ContractPdfRenderModel): ContractPdfArtifactAnchorOccurrences {
  const text = buildRenderModelSearchableText(model);
  validateStage1SigningSlotDefinitions(model.signingSlots);
  const occurrences = buildStage1SlotOccurrences(text, model.signingSlots);

  if (STAGE1_CONTRACT_PDF_REQUIRED_SLOT_IDS.some((slotId) => occurrences.stage1SigningSlots[slotId] !== 1)) {
    throw new Error(
      `${CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE}: Stage 1 signing slots must appear exactly once in the render model`
    );
  }

  return occurrences;
}

function validateRenderDiagnostics(diagnostics: ContractPdfArtifactDiagnostics["renderDiagnostics"]) {
  if (!diagnostics.hasLegalBody) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_LEGAL_BODY_MISSING}: renderer did not confirm legal body`);
  }
  if (!diagnostics.hasAppendix) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_APPENDIX_MISSING}: renderer did not confirm appendix`);
  }
  if (!diagnostics.hasPlatformSealKeyword || !diagnostics.hasCustomerSignatureKeyword || !diagnostics.hasStage1SigningSlots) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_RENDER_ANCHOR_MISSING}: renderer did not confirm Stage 1 signing slots`);
  }
  if (STAGE1_CONTRACT_PDF_REQUIRED_SLOT_IDS.some((slotId) => diagnostics.stage1SigningSlotOccurrences[slotId] !== 1)) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_RENDER_ANCHOR_MISSING}: renderer did not confirm Stage 1 slots`);
  }
}

function validateMaxBytes(buffer: Buffer, maxBytes: number) {
  if (buffer.length > maxBytes) {
    throw new Error(`${CONTRACT_PDF_ARTIFACT_TOO_LARGE}: generated PDF exceeds maximum size`);
  }
}

function buildStorageMetadata(model: ContractPdfRenderModel) {
  return {
    artifactKind: "contract-signing-source",
    contractNo: model.contractNo,
    templateName: model.templateName,
    templateVersion: model.templateVersion
  };
}

function buildGeneratedContractPdfObjectKey(model: ContractPdfRenderModel, fileName: string) {
  return `contracts/${sanitizeKeyPart(model.contractId)}/generated/${sanitizePdfFileName(fileName)}`;
}

function buildRenderModelSearchableText(model: ContractPdfRenderModel) {
  return [
    model.contentTemplate,
    ...model.appendix.sections.flatMap((section) => [
      section.title,
      ...section.rows.flatMap((row) => [row.label, formatValue(row.value)])
    ]),
    ...buildSigningSlotSearchableText(model.signingSlots)
  ].join("\n");
}

function validateStage1SigningSlotDefinitions(slots: ContractPdfSigningSlot[]) {
  for (const slotId of STAGE1_CONTRACT_PDF_REQUIRED_SLOT_IDS) {
    const matchingSlots = slots.filter((slot) => slot.slotId === slotId);
    if (matchingSlots.length !== 1) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE}: ${slotId} must appear exactly once`);
    }

    const actual = matchingSlots[0]!;
    const expected = STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS.find((slot) => slot.slotId === slotId)!;
    if (
      actual.documentType !== expected.documentType ||
      actual.keyword !== expected.keyword ||
      actual.signerRole !== expected.signerRole ||
      actual.stage !== expected.stage
    ) {
      throw new Error(`${CONTRACT_PDF_ARTIFACT_ANCHOR_NOT_UNIQUE}: ${slotId} does not match approved Stage 1 slot`);
    }
  }
}

function buildStage1SlotOccurrences(text: string, slots: ContractPdfSigningSlot[]): ContractPdfArtifactAnchorOccurrences {
  return {
    stage1SigningSlots: {
      STAGE1_ATTACHMENT1_CUSTOMER: countOccurrences(
        text,
        findSlotKeyword(slots, "STAGE1_ATTACHMENT1_CUSTOMER")
      ),
      STAGE1_ATTACHMENT1_PLATFORM: countOccurrences(
        text,
        findSlotKeyword(slots, "STAGE1_ATTACHMENT1_PLATFORM")
      ),
      STAGE1_BODY_CUSTOMER: countOccurrences(text, findSlotKeyword(slots, "STAGE1_BODY_CUSTOMER")),
      STAGE1_BODY_PLATFORM: countOccurrences(text, findSlotKeyword(slots, "STAGE1_BODY_PLATFORM"))
    }
  };
}

function buildSigningSlotSearchableText(slots: ContractPdfSigningSlot[]) {
  return slots.map((slot) => `${slot.title}\n${slot.label}\n${slot.keyword}`);
}

function findSlotKeyword(slots: ContractPdfSigningSlot[], slotId: ContractPdfSigningSlotId) {
  return slots.find((slot) => slot.slotId === slotId)?.keyword.trim() ?? "";
}

function formatValue(value: ContractPdfValue) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function countOccurrences(text: string, keyword: string) {
  if (!keyword) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (index <= text.length) {
    const found = text.indexOf(keyword, index);
    if (found === -1) {
      break;
    }
    count += 1;
    index = found + keyword.length;
  }
  return count;
}

function sanitizePdfFileName(value: string) {
  const normalized = value.replace(/[\\/]+/g, "_");
  const parsed = path.parse(normalized);
  const base = parsed.name.replace(/[^\w.-]+/g, "_").slice(0, 160) || "contract";
  const ext = parsed.ext.replace(/[^\w.]+/g, "").slice(0, 16) || ".pdf";
  return `${base}${ext === "." ? ".pdf" : ext}`;
}

function sanitizeKeyPart(value: string) {
  const safe = value.replace(/[^\w-]+/g, "_").slice(0, 80);
  if (!safe || safe.includes("..")) {
    throw new Error("CONTRACT_PDF_ARTIFACT_INVALID_OBJECT_KEY: generated object key is invalid");
  }
  return safe;
}

async function cleanupStoredObject(storageService: StorageService, bucket: string, objectKey: string) {
  try {
    await storageService.deleteObject(bucket, objectKey);
  } catch {
    // Best-effort only. The caller still receives the FileObject creation failure.
  }
}
