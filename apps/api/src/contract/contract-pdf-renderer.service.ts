import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

import {
  ContractPdfAppendixRow,
  ContractPdfRenderDiagnostics,
  ContractPdfRenderModel,
  ContractPdfValue
} from "./contract-pdf-render-model";

export const CONTRACT_PDF_RENDER_EMPTY_TEMPLATE = "CONTRACT_PDF_RENDER_EMPTY_TEMPLATE";
export const CONTRACT_PDF_RENDER_PLATFORM_SEAL_KEYWORD_MISSING = "CONTRACT_PDF_RENDER_PLATFORM_SEAL_KEYWORD_MISSING";
export const CONTRACT_PDF_RENDER_CUSTOMER_SIGNATURE_KEYWORD_MISSING =
  "CONTRACT_PDF_RENDER_CUSTOMER_SIGNATURE_KEYWORD_MISSING";
export const CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED = "CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED";
export const CONTRACT_PDF_RENDER_BUILTIN_FONT_NOT_ALLOWED = "CONTRACT_PDF_RENDER_BUILTIN_FONT_NOT_ALLOWED";
export const CONTRACT_PDF_RENDER_NOT_PDF = "CONTRACT_PDF_RENDER_NOT_PDF";
export const CONTRACT_PDF_RENDER_TOO_LARGE = "CONTRACT_PDF_RENDER_TOO_LARGE";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = "A4";
const EMPTY_VALUE = "-";
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;

export interface ContractPdfRenderOptions {
  allowBuiltinFontForAsciiOnlyTests?: boolean;
  cjkFontPath?: string;
  maxBytes?: number;
  pageSize?: PDFKit.PDFDocumentOptions["size"];
}

export interface ContractPdfRenderResult {
  buffer: Buffer;
  contentType: "application/pdf";
  diagnostics: ContractPdfRenderDiagnostics;
  fileName: string;
}

@Injectable()
export class ContractPdfRendererService {
  async render(
    model: ContractPdfRenderModel,
    options: ContractPdfRenderOptions = {}
  ): Promise<ContractPdfRenderResult> {
    const diagnostics = buildDiagnostics(model);
    validateModel(model, diagnostics);
    const fontPath = resolveFontPath(options, diagnostics);
    const buffer = await renderPdf(model, diagnostics, fontPath, options);
    validatePdfBuffer(buffer, options.maxBytes ?? DEFAULT_MAX_BYTES);

    return {
      buffer,
      contentType: "application/pdf",
      diagnostics,
      fileName: `${sanitizeFileName(model.contractNo)}.pdf`
    };
  }
}

function buildDiagnostics(model: ContractPdfRenderModel): ContractPdfRenderDiagnostics {
  const renderText = [
    model.contractId,
    model.contractNo,
    model.orderNo,
    model.templateName,
    model.templateVersion,
    model.contentTemplate,
    model.signingAnchors.platformSealKeyword,
    model.signingAnchors.customerSignatureKeyword,
    ...model.appendix.sections.flatMap((section) => [
      section.title,
      ...section.rows.flatMap((row) => [row.label, formatValue(row.value)])
    ])
  ].join("\n");

  return {
    hasAppendix: model.appendix.sections.some((section) => section.rows.length > 0),
    hasCjkContent: CJK_PATTERN.test(renderText),
    hasCustomerSignatureKeyword: model.signingAnchors.customerSignatureKeyword.trim().length > 0,
    hasLegalBody: model.contentTemplate.trim().length > 0,
    hasPlatformSealKeyword: model.signingAnchors.platformSealKeyword.trim().length > 0
  };
}

function validateModel(model: ContractPdfRenderModel, diagnostics: ContractPdfRenderDiagnostics) {
  if (!diagnostics.hasLegalBody) {
    throw new Error(`${CONTRACT_PDF_RENDER_EMPTY_TEMPLATE}: contentTemplate is required`);
  }
  if (!diagnostics.hasPlatformSealKeyword) {
    throw new Error(`${CONTRACT_PDF_RENDER_PLATFORM_SEAL_KEYWORD_MISSING}: platform seal keyword is required`);
  }
  if (!diagnostics.hasCustomerSignatureKeyword) {
    throw new Error(`${CONTRACT_PDF_RENDER_CUSTOMER_SIGNATURE_KEYWORD_MISSING}: customer signature keyword is required`);
  }
  if (!model.contractNo.trim()) {
    throw new Error("CONTRACT_PDF_RENDER_CONTRACT_NO_MISSING: contractNo is required");
  }
}

function resolveFontPath(options: ContractPdfRenderOptions, diagnostics: ContractPdfRenderDiagnostics) {
  const configured = options.cjkFontPath?.trim();
  if (configured) {
    assertUsableFont(configured);
    return configured;
  }

  if (diagnostics.hasCjkContent) {
    throw new Error(`${CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED}: configured CJK font path is required`);
  }
  if (!options.allowBuiltinFontForAsciiOnlyTests) {
    throw new Error(`${CONTRACT_PDF_RENDER_BUILTIN_FONT_NOT_ALLOWED}: built-in font is test-only for ASCII content`);
  }

  return undefined;
}

function assertUsableFont(fontPath: string) {
  try {
    if (!fs.statSync(fontPath).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new Error(`${CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED}: configured CJK font path is not usable`);
  }
}

async function renderPdf(
  model: ContractPdfRenderModel,
  diagnostics: ContractPdfRenderDiagnostics,
  fontPath: string | undefined,
  options: ContractPdfRenderOptions
) {
  const doc = new PDFDocument({
    autoFirstPage: true,
    margin: 50,
    size: options.pageSize ?? DEFAULT_PAGE_SIZE
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  if (fontPath) {
    doc.font(fontPath);
  } else {
    doc.font("Helvetica");
  }

  doc.info.Title = model.contractNo;
  doc.info.Subject = "Subscription contract signing artifact";
  doc.info.Keywords = "contract,esign";

  writeTitle(doc, "Contract Signing Artifact");
  writeMetadata(doc, model);
  writeSection(doc, "Legal Terms Body");
  writeParagraph(doc, model.contentTemplate);
  writeSection(doc, "Order Snapshot Appendix");
  writeAppendix(doc, model.appendix.sections);
  writeSection(doc, "Signing Anchors");
  writeSigningAnchor(doc, "Customer", model.signingAnchors.customerSignatureKeyword);
  writeSigningAnchor(doc, "Platform", model.signingAnchors.platformSealKeyword);
  if (model.signingAnchors.platformSealOffsetX !== undefined || model.signingAnchors.platformSealOffsetY !== undefined) {
    writeParagraph(
      doc,
      `Platform seal offset: x=${model.signingAnchors.platformSealOffsetX ?? 0}, y=${model.signingAnchors.platformSealOffsetY ?? 0}`
    );
  }
  writeSection(doc, "Render Diagnostics");
  writeParagraph(doc, JSON.stringify(diagnostics));

  doc.end();
  return done;
}

function writeTitle(doc: PDFKit.PDFDocument, text: string) {
  doc.fontSize(18).text(text, { align: "center" });
  doc.moveDown();
}

function writeMetadata(doc: PDFKit.PDFDocument, model: ContractPdfRenderModel) {
  writeSection(doc, "Contract Metadata");
  writeKeyValue(doc, "Contract No", model.contractNo);
  writeKeyValue(doc, "Order No", model.orderNo);
  writeKeyValue(doc, "Template", `${model.templateName} ${model.templateVersion}`);
  writeKeyValue(doc, "Generated At", formatValue(model.generatedAt));
}

function writeSection(doc: PDFKit.PDFDocument, title: string) {
  ensureSpace(doc, 52);
  doc.moveDown(0.5);
  doc.fontSize(13).text(title, { underline: true });
  doc.moveDown(0.4);
}

function writeParagraph(doc: PDFKit.PDFDocument, text: string) {
  ensureSpace(doc, 80);
  doc.fontSize(10).text(text, {
    align: "left",
    lineGap: 4
  });
  doc.moveDown(0.6);
}

function writeAppendix(doc: PDFKit.PDFDocument, sections: ContractPdfRenderModel["appendix"]["sections"]) {
  for (const section of sections) {
    ensureSpace(doc, 60);
    doc.fontSize(11).text(section.title);
    doc.moveDown(0.2);
    for (const row of section.rows) {
      writeAppendixRow(doc, row);
    }
    doc.moveDown(0.5);
  }
}

function writeAppendixRow(doc: PDFKit.PDFDocument, row: ContractPdfAppendixRow) {
  const suffix = row.redaction?.applied ? ` (redacted${row.redaction.reason ? `: ${row.redaction.reason}` : ""})` : "";
  writeKeyValue(doc, row.label, `${formatValue(row.value)}${suffix}`);
}

function writeKeyValue(doc: PDFKit.PDFDocument, label: string, value: string) {
  ensureSpace(doc, 24);
  doc.fontSize(10).text(`${label}: ${value}`, {
    lineGap: 3
  });
}

function writeSigningAnchor(doc: PDFKit.PDFDocument, label: string, keyword: string) {
  ensureSpace(doc, 36);
  doc.fontSize(10).text(`${label}: ${keyword}`, { continued: true });
  doc.text("    ______________________________");
  doc.moveDown(0.8);
}

function ensureSpace(doc: PDFKit.PDFDocument, requiredHeight: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + requiredHeight > bottom) {
    doc.addPage();
  }
}

function formatValue(value: ContractPdfValue) {
  if (value === null || value === undefined || value === "") {
    return EMPTY_VALUE;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function validatePdfBuffer(buffer: Buffer, maxBytes: number) {
  if (buffer.length > maxBytes) {
    throw new Error(`${CONTRACT_PDF_RENDER_TOO_LARGE}: generated PDF exceeds maximum size`);
  }
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8"))) {
    throw new Error(`${CONTRACT_PDF_RENDER_NOT_PDF}: generated PDF must start with %PDF-`);
  }
}

function sanitizeFileName(value: string) {
  const parsed = path.parse(value);
  const base = parsed.name.replace(/[^\w.-]+/g, "_").slice(0, 120) || "contract";
  return base.replace(/^\.+$/, "contract");
}
