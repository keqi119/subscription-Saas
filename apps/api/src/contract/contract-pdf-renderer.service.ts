import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

import {
  ContractPdfAppendixRow,
  ContractPdfRenderDiagnostics,
  ContractPdfRenderModel,
  ContractPdfSigningSlot,
  ContractPdfSigningSlotCoordinate,
  ContractPdfSigningSlotId,
  ContractPdfSubscriberPartyInfo,
  ContractPdfValue
} from "./contract-pdf-render-model";

export const CONTRACT_PDF_RENDER_EMPTY_TEMPLATE = "CONTRACT_PDF_RENDER_EMPTY_TEMPLATE";
export const CONTRACT_PDF_RENDER_PLATFORM_SEAL_KEYWORD_MISSING = "CONTRACT_PDF_RENDER_PLATFORM_SEAL_KEYWORD_MISSING";
export const CONTRACT_PDF_RENDER_CUSTOMER_SIGNATURE_KEYWORD_MISSING =
  "CONTRACT_PDF_RENDER_CUSTOMER_SIGNATURE_KEYWORD_MISSING";
export const CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED = "CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED";
export const CONTRACT_PDF_RENDER_BUILTIN_FONT_NOT_ALLOWED = "CONTRACT_PDF_RENDER_BUILTIN_FONT_NOT_ALLOWED";
export const CONTRACT_PDF_RENDER_NOT_PDF = "CONTRACT_PDF_RENDER_NOT_PDF";
export const CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_MISSING = "CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_MISSING";
export const CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_NOT_UNIQUE =
  "CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_NOT_UNIQUE";
export const CONTRACT_PDF_RENDER_SUBSCRIBER_ID_NUMBER_MISSING =
  "CONTRACT_PDF_RENDER_SUBSCRIBER_ID_NUMBER_MISSING";
export const CONTRACT_PDF_RENDER_TOO_LARGE = "CONTRACT_PDF_RENDER_TOO_LARGE";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = "A4";
const EMPTY_VALUE = "-";
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
const FADADA_COORDINATE_WIDTH = 800;
const FADADA_COORDINATE_HEIGHT = 1131;
const SIGNING_BLANK_WIDTH = 180;
const SIGNING_BLANK_HEIGHT = 18;
const SIGNING_BLANK_GAP = 12;
const SIGNING_KEYWORD_LINE_HEIGHT = 14;
const SIGNING_SLOT_VERTICAL_SEPARATION = 90;
const STAGE1_REQUIRED_SLOT_IDS: ContractPdfSigningSlotId[] = [
  "STAGE1_BODY_CUSTOMER",
  "STAGE1_BODY_PLATFORM",
  "STAGE1_ATTACHMENT1_CUSTOMER",
  "STAGE1_ATTACHMENT1_PLATFORM"
];

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
  slotCoordinates: ContractPdfSigningSlotCoordinate[];
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
    const { buffer, slotCoordinates } = await renderPdf(model, fontPath, options);
    validatePdfBuffer(buffer, options.maxBytes ?? DEFAULT_MAX_BYTES);

    return {
      buffer,
      contentType: "application/pdf",
      diagnostics,
      fileName: `${sanitizeFileName(model.contractNo)}.pdf`,
      slotCoordinates
    };
  }
}

function buildDiagnostics(model: ContractPdfRenderModel): ContractPdfRenderDiagnostics {
  const stage1SigningSlotOccurrences = countStage1SlotOccurrences(model);
  const renderText = [
    model.contractId,
    model.contractNo,
    model.orderNo,
    model.templateName,
    model.templateVersion,
    model.contentTemplate,
    ...buildExtensionTermsSearchableText(model),
    ...buildSigningSlotSearchableText(model.signingSlots),
    ...model.appendix.sections.flatMap((section) => [
      section.title,
      ...section.rows.flatMap((row) => [row.label, formatValue(row.value)])
    ])
  ].join("\n");

  return {
    hasAppendix: model.appendix.sections.some((section) => section.rows.length > 0),
    hasCjkContent: CJK_PATTERN.test(renderText),
    hasCustomerSignatureKeyword: model.signingSlots.some(
      (slot) => slot.signerRole === "CUSTOMER" && slot.keyword.trim().length > 0
    ),
    hasLegalBody: model.contentTemplate.trim().length > 0,
    hasPlatformSealKeyword: model.signingSlots.some(
      (slot) => slot.signerRole === "PLATFORM" && slot.keyword.trim().length > 0
    ),
    hasStage1SigningSlots: STAGE1_REQUIRED_SLOT_IDS.every(
      (slotId) => stage1SigningSlotOccurrences[slotId] === 1
    ),
    stage1SigningSlotOccurrences
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
  validateSubscriberParty(model);
  validateStage1SigningSlots(model, diagnostics);
}

function validateSubscriberParty(model: ContractPdfRenderModel) {
  const idNumber = formatPartyValue(model.subscriberParty?.subscriberIdNumber).trim();
  if (!idNumber) {
    throw new Error(`${CONTRACT_PDF_RENDER_SUBSCRIBER_ID_NUMBER_MISSING}: subscriber ID number is required`);
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
  fontPath: string | undefined,
  options: ContractPdfRenderOptions
) {
  const doc = new PDFDocument({
    autoFirstPage: true,
    margin: 50,
    size: options.pageSize ?? DEFAULT_PAGE_SIZE
  });
  const chunks: Buffer[] = [];
  const slotCoordinates: ContractPdfSigningSlotCoordinate[] = [];
  let currentPageNumber = 0;
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.on("pageAdded", () => {
    currentPageNumber += 1;
  });

  if (fontPath) {
    doc.font(fontPath);
  } else {
    doc.font("Helvetica");
  }

  doc.info.Title = model.contractNo;
  doc.info.Subject = model.agreementKind === "SUBSCRIPTION_EXTENSION"
    ? "Subscription extension agreement signing artifact"
    : "Stage 1 subscription contract signing artifact";
  doc.info.Keywords = "contract,esign";

  writeTitle(
    doc,
    model.agreementKind === "SUBSCRIPTION_EXTENSION"
      ? "汽车订阅服务续订补充协议"
      : "汽车订阅服务合同"
  );
  writeMetadata(doc, model);
  writeExtensionReference(doc, model);
  writeSubscriberPartyInfo(doc, model.subscriberParty);
  writeSection(doc, "合同正文");
  writeParagraph(doc, buildStage1MainBodyText(model.contentTemplate));
  writeSection(doc, "合同正文签署区");
  writeSigningSlots(
    doc,
    model.signingSlots.filter((slot) => slot.documentType === "CONTRACT_BODY"),
    slotCoordinates,
    () => currentPageNumber
  );
  startNewPage(doc);
  writeSection(doc, "附件1：订阅方案 / 交易条件快照");
  writeAppendix(doc, model.appendix.sections);
  writeSection(doc, "附件1签署区");
  writeSigningSlots(
    doc,
    model.signingSlots.filter((slot) => slot.documentType === "ATTACHMENT1_SUBSCRIPTION_PLAN"),
    slotCoordinates,
    () => currentPageNumber
  );

  doc.end();
  const buffer = await done;
  return { buffer, slotCoordinates };
}

function writeTitle(doc: PDFKit.PDFDocument, text: string) {
  doc.fontSize(18).text(text, { align: "center" });
  doc.moveDown();
}

function writeMetadata(doc: PDFKit.PDFDocument, model: ContractPdfRenderModel) {
  writeSection(doc, "合同元信息");
  writeKeyValue(doc, "合同编号", model.contractNo);
  writeKeyValue(doc, "订单编号", model.orderNo);
  writeKeyValue(doc, "合同模板", `${model.templateName} ${model.templateVersion}`);
  writeKeyValue(doc, "生成时间", formatValue(model.generatedAt));
}

function writeExtensionReference(doc: PDFKit.PDFDocument, model: ContractPdfRenderModel) {
  if (model.agreementKind !== "SUBSCRIPTION_EXTENSION" || !model.extensionTerms) {
    return;
  }

  writeSection(doc, "续订补充协议关联信息");
  writeKeyValue(doc, "原合同编号", formatValue(model.extensionTerms.originalContractNo));
  writeKeyValue(doc, "原合同到期日", formatValue(model.extensionTerms.originalEndDate));
  writeKeyValue(doc, "续期起始日", formatValue(model.extensionTerms.extensionStartDate));
  writeKeyValue(doc, "续期结束日", formatValue(model.extensionTerms.extensionEndDate));
  writeKeyValue(doc, "客户确认报价", formatValue(model.extensionTerms.confirmedQuoteNo));
  writeKeyValue(doc, "续期月费（分）", formatValue(model.extensionTerms.monthlyFeeAmount));
}

function buildExtensionTermsSearchableText(model: ContractPdfRenderModel) {
  if (!model.extensionTerms) return [];
  return [
    model.extensionTerms.originalContractNo,
    model.extensionTerms.originalEndDate,
    model.extensionTerms.extensionStartDate,
    model.extensionTerms.extensionEndDate,
    model.extensionTerms.confirmedQuoteNo,
    model.extensionTerms.monthlyFeeAmount,
    JSON.stringify(model.extensionTerms.planSnapshot)
  ].map(formatValue);
}

function writeSubscriberPartyInfo(doc: PDFKit.PDFDocument, party: ContractPdfSubscriberPartyInfo | undefined) {
  if (!party) {
    return;
  }

  writeSection(doc, "乙方（订阅方）信息");
  writePartyKeyValue(doc, "名称", party.subscriberName);
  writePartyKeyValue(doc, "证件号码", party.subscriberIdNumber);
  writePartyKeyValue(doc, "联系地址", party.subscriberContactAddress);
  writePartyKeyValue(doc, "联系人", party.subscriberContactName);
  writePartyKeyValue(doc, "联系电话", party.subscriberContactPhone);
  writePartyKeyValue(doc, "微信号", party.subscriberWechat);
  writePartyKeyValue(doc, "电子邮箱", party.subscriberEmail);
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

function writePartyKeyValue(doc: PDFKit.PDFDocument, label: string, value: ContractPdfValue) {
  ensureSpace(doc, 24);
  doc.fontSize(10).text(`${label}: ${formatPartyValue(value)}`, {
    lineGap: 3
  });
}

function writeSigningSlots(
  doc: PDFKit.PDFDocument,
  slots: ContractPdfSigningSlot[],
  slotCoordinates: ContractPdfSigningSlotCoordinate[],
  getPageNumber: () => number
) {
  ensureSpace(doc, estimateSigningSlotsHeight(slots.length));
  for (const [index, slot] of slots.entries()) {
    if (index > 0) {
      ensureSpace(doc, SIGNING_SLOT_VERTICAL_SEPARATION + 68);
      doc.y += SIGNING_SLOT_VERTICAL_SEPARATION;
    }
    writeSigningSlot(doc, slot, slotCoordinates, getPageNumber);
  }
}

function estimateSigningSlotsHeight(slotCount: number) {
  if (slotCount <= 0) {
    return 0;
  }
  return slotCount * 68 + (slotCount - 1) * SIGNING_SLOT_VERTICAL_SEPARATION;
}

function writeSigningSlot(
  doc: PDFKit.PDFDocument,
  slot: ContractPdfSigningSlot,
  slotCoordinates: ContractPdfSigningSlotCoordinate[],
  getPageNumber: () => number
) {
  ensureSpace(doc, 68);
  const lineTop = doc.y;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const blankWidth = Math.min(SIGNING_BLANK_WIDTH, Math.max(80, right - left - SIGNING_BLANK_GAP));
  const blankX = right - blankWidth;
  const fullRowWidth = Math.max(80, right - left);

  doc.fontSize(10).text(`${slot.title} / ${slot.label}:`, left, lineTop, {
    lineGap: 2,
    width: fullRowWidth
  });
  const keywordBottom = writeVisibleSlotKeywordIfNeeded(doc, slot, left);
  const blankY = keywordBottom + 2;

  doc.moveTo(blankX, blankY + SIGNING_BLANK_HEIGHT - 4)
    .lineTo(right, blankY + SIGNING_BLANK_HEIGHT - 4)
    .stroke();

  slotCoordinates.push(buildSlotCoordinate({
    blankHeight: SIGNING_BLANK_HEIGHT,
    blankWidth,
    blankX,
    blankY,
    page: doc.page,
    pageNumber: getPageNumber(),
    slot
  }));

  doc.x = left;
  doc.y = Math.max(keywordBottom, blankY + SIGNING_BLANK_HEIGHT + 4);
  if (slot.offsetX !== undefined || slot.offsetY !== undefined) {
    doc.fontSize(8).text(`Offset intent: x=${slot.offsetX ?? 0}, y=${slot.offsetY ?? 0}`);
  }
  doc.moveDown(0.8);
}

function writeVisibleSlotKeywordIfNeeded(
  doc: PDFKit.PDFDocument,
  slot: ContractPdfSigningSlot,
  left: number
) {
  if (slot.documentType === "CONTRACT_BODY") {
    return doc.y;
  }

  const keywordTop = doc.y;
  doc.fontSize(10).text(slot.keyword, left, keywordTop, {
    lineBreak: false
  });
  return keywordTop + SIGNING_KEYWORD_LINE_HEIGHT;
}

function buildSlotCoordinate(input: {
  blankHeight: number;
  blankWidth: number;
  blankX: number;
  blankY: number;
  page: PDFKit.PDFPage;
  pageNumber: number;
  slot: ContractPdfSigningSlot;
}): ContractPdfSigningSlotCoordinate {
  const pdfCenterX = input.blankX + input.blankWidth / 2;
  const pdfCenterY = input.blankY + input.blankHeight / 2;

  return {
    coordinateSource: "PDFKIT_RENDERER",
    coordinateSystem: "FADADA_800_1131_TOP_LEFT",
    height: toFadadaCoordinate(input.blankHeight, input.page.height, FADADA_COORDINATE_HEIGHT),
    keyword: input.slot.keyword,
    pageNumber: input.pageNumber,
    pdfPageHeight: roundCoordinate(input.page.height),
    pdfPageWidth: roundCoordinate(input.page.width),
    slotId: input.slot.slotId,
    width: toFadadaCoordinate(input.blankWidth, input.page.width, FADADA_COORDINATE_WIDTH),
    x: toFadadaCoordinate(pdfCenterX, input.page.width, FADADA_COORDINATE_WIDTH),
    y: toFadadaCoordinate(pdfCenterY, input.page.height, FADADA_COORDINATE_HEIGHT)
  };
}

function toFadadaCoordinate(value: number, pdfDimension: number, fadadaDimension: number) {
  return roundCoordinate((value / pdfDimension) * fadadaDimension);
}

function roundCoordinate(value: number) {
  return Math.round(value * 1000) / 1000;
}

function startNewPage(doc: PDFKit.PDFDocument) {
  doc.addPage();
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

function formatPartyValue(value: ContractPdfValue) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function removeTrailingLegacySignatureBlock(contentTemplate: string) {
  return contentTemplate.replace(
    /\s*（以下无正文，系为签署页）\s*[\s\S]*?甲方（服务提供方）[：:][\s\S]*?（服务提供方盖章）[\s\S]*?日期[：:][^\n\r]*(?:\r?\n)+\s*乙方（订阅方）[：:][\s\S]*?（订阅方盖章\/签字）[\s\S]*?日期[：:][^\n\r]*\s*$/u,
    ""
  ).trimEnd();
}

function buildStage1MainBodyText(contentTemplate: string) {
  return removeIndependentAttachment2Section(removeTrailingLegacySignatureBlock(contentTemplate));
}

function removeIndependentAttachment2Section(contentTemplate: string) {
  const lines = contentTemplate.split(/\r?\n/);
  const attachmentStart = lines.findIndex((line) => isIndependentAttachment2Heading(line));
  if (attachmentStart < 0) {
    return contentTemplate;
  }

  return lines.slice(0, attachmentStart).join("\n").trimEnd();
}

function isIndependentAttachment2Heading(line: string) {
  const normalized = line.trim().replace(/\s+/g, "");
  if (!normalized) {
    return false;
  }

  return /^附件(?:2|二)(?:[：:、.-].*)?$/u.test(normalized) ||
    /^《?车辆交接确认单》?$/u.test(normalized) ||
    /^车辆交接确认(?:单|文件|书|表)$/u.test(normalized);
}

function countStage1SlotOccurrences(model: ContractPdfRenderModel) {
  const text = [
    model.contentTemplate,
    ...model.appendix.sections.flatMap((section) => [
      section.title,
      ...section.rows.flatMap((row) => [row.label, formatValue(row.value)])
    ]),
    ...buildSigningSlotSearchableText(model.signingSlots)
  ].join("\n");

  return {
    STAGE1_ATTACHMENT1_CUSTOMER: countOccurrences(
      text,
      findSlotKeyword(model.signingSlots, "STAGE1_ATTACHMENT1_CUSTOMER")
    ),
    STAGE1_ATTACHMENT1_PLATFORM: countOccurrences(
      text,
      findSlotKeyword(model.signingSlots, "STAGE1_ATTACHMENT1_PLATFORM")
    ),
    STAGE1_BODY_CUSTOMER: countOccurrences(text, findSlotKeyword(model.signingSlots, "STAGE1_BODY_CUSTOMER")),
    STAGE1_BODY_PLATFORM: countOccurrences(text, findSlotKeyword(model.signingSlots, "STAGE1_BODY_PLATFORM"))
  };
}

function validateStage1SigningSlots(model: ContractPdfRenderModel, diagnostics: ContractPdfRenderDiagnostics) {
  if (model.signingStage !== "STAGE1_CONTRACT") {
    throw new Error(`${CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_MISSING}: Stage 1 signing stage is required`);
  }

  for (const slotId of STAGE1_REQUIRED_SLOT_IDS) {
    const slots = model.signingSlots.filter((slot) => slot.slotId === slotId);
    if (slots.length !== 1 || slots[0]!.keyword.trim().length === 0) {
      throw new Error(`${CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_MISSING}: ${slotId} is required`);
    }
    if (diagnostics.stage1SigningSlotOccurrences[slotId] !== 1) {
      throw new Error(`${CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_NOT_UNIQUE}: ${slotId} must render exactly once`);
    }
  }
}

function buildSigningSlotSearchableText(slots: ContractPdfSigningSlot[]) {
  return slots.map((slot) => `${slot.title}\n${slot.label}\n${slot.keyword}`);
}

function findSlotKeyword(slots: ContractPdfSigningSlot[], slotId: ContractPdfSigningSlotId) {
  return slots.find((slot) => slot.slotId === slotId)?.keyword.trim() ?? "";
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
