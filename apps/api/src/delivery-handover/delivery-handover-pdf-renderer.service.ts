import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

import {
  DeliveryHandoverPdfRenderModel,
  STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT
} from "./delivery-handover-pdf-render-model";

export const STAGE2_HANDOVER_PDF_RENDER_CJK_FONT_REQUIRED =
  "STAGE2_HANDOVER_PDF_RENDER_CJK_FONT_REQUIRED";
export const STAGE2_HANDOVER_PDF_RENDER_NOT_PDF = "STAGE2_HANDOVER_PDF_RENDER_NOT_PDF";
export const STAGE2_HANDOVER_PDF_RENDER_TOO_LARGE = "STAGE2_HANDOVER_PDF_RENDER_TOO_LARGE";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = "A4";
const EMPTY_VALUE = "-";
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
const TABLE_LABEL_WIDTH = 92;

export interface DeliveryHandoverPdfRenderOptions {
  cjkFontPath?: string;
  maxBytes?: number;
  pageSize?: PDFKit.PDFDocumentOptions["size"];
}

export interface DeliveryHandoverPdfRenderDiagnostics {
  evidenceItemCount: number;
  hasCjkContent: boolean;
  hasCustomerSignatureArea: boolean;
  hasEvidenceSummary: boolean;
  hasPlatformSealArea: boolean;
}

export interface DeliveryHandoverPdfRenderResult {
  buffer: Buffer;
  contentType: "application/pdf";
  diagnostics: DeliveryHandoverPdfRenderDiagnostics;
  fileName: string;
}

@Injectable()
export class DeliveryHandoverPdfRendererService {
  async render(
    model: DeliveryHandoverPdfRenderModel,
    options: DeliveryHandoverPdfRenderOptions = {}
  ): Promise<DeliveryHandoverPdfRenderResult> {
    const diagnostics = buildDiagnostics(model);
    validateRenderModel(model, diagnostics);
    const fontPath = resolveFontPath(options, diagnostics);
    const buffer = await renderPdf(model, fontPath, options);
    validatePdfBuffer(buffer, options.maxBytes ?? DEFAULT_MAX_BYTES);

    return {
      buffer,
      contentType: "application/pdf",
      diagnostics,
      fileName: `${sanitizeFileName(model.documentNo)}.pdf`
    };
  }
}

function buildDiagnostics(model: DeliveryHandoverPdfRenderModel): DeliveryHandoverPdfRenderDiagnostics {
  const searchable = JSON.stringify(model);
  return {
    evidenceItemCount: model.evidenceSummary.items.length,
    hasCjkContent: CJK_PATTERN.test(searchable),
    hasCustomerSignatureArea: true,
    hasEvidenceSummary: model.evidenceSummary.items.length === STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT,
    hasPlatformSealArea: true
  };
}

function validateRenderModel(
  model: DeliveryHandoverPdfRenderModel,
  diagnostics: DeliveryHandoverPdfRenderDiagnostics
) {
  if (!model.documentNo.trim()) {
    throw new Error("STAGE2_HANDOVER_PDF_DOCUMENT_NO_MISSING: documentNo is required");
  }
  if (!diagnostics.hasEvidenceSummary) {
    throw new Error("STAGE2_HANDOVER_PDF_EVIDENCE_SUMMARY_INCOMPLETE: 14 evidence summary rows are required");
  }
}

function resolveFontPath(
  options: DeliveryHandoverPdfRenderOptions,
  diagnostics: DeliveryHandoverPdfRenderDiagnostics
) {
  const configured = options.cjkFontPath?.trim();
  if (configured) {
    assertUsableFont(configured);
    return configured;
  }

  if (diagnostics.hasCjkContent) {
    throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_CJK_FONT_REQUIRED}: configured CJK font path is required`);
  }

  return undefined;
}

function assertUsableFont(fontPath: string) {
  try {
    if (!fs.statSync(fontPath).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_CJK_FONT_REQUIRED}: configured CJK font path is not usable`);
  }
}

async function renderPdf(
  model: DeliveryHandoverPdfRenderModel,
  fontPath: string | undefined,
  options: DeliveryHandoverPdfRenderOptions
) {
  const doc = new PDFDocument({
    autoFirstPage: true,
    margin: 45,
    size: options.pageSize ?? DEFAULT_PAGE_SIZE
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font(fontPath ?? "Helvetica");
  doc.info.Title = model.documentNo;
  doc.info.Subject = "Stage 2 delivery handover PDF source artifact";
  doc.info.Keywords = "delivery,handover,stage2,pdf";

  writeTitle(doc, "车辆交接确认单");
  writeMetadata(doc, model);
  writeSection(doc, "一、车辆基本信息");
  writeKeyValueTable(doc, [
    ["车牌号码", model.vehicle.plateNo],
    ["车辆品牌/型号", model.vehicle.brandModel],
    ["车架号（后6位）", model.vehicle.vinSuffix],
    ["当前里程数", model.fieldFacts.handoverMileageKm],
    ["油量/电量", joinValues([model.fieldFacts.fuelLevelText, model.fieldFacts.energyLevelText])],
    ["随车证件", model.fieldFacts.accessoryChecklistText]
  ]);

  writeSection(doc, "二、车况确认（核心条款）");
  writeParagraph(doc, "车辆外观、内饰及随车物品以现场确认和证据摘要为准。已有损伤、瑕疵或补充说明如下：");
  writeKeyValueTable(doc, [
    ["仪表盘故障灯", EMPTY_VALUE],
    ["空调/暖风", EMPTY_VALUE],
    ["灯光系统", EMPTY_VALUE],
    ["轮胎/备胎", EMPTY_VALUE],
    ["内饰清洁度", EMPTY_VALUE],
    ["随车工具", model.fieldFacts.accessoryChecklistText],
    ["损伤状态", model.fieldFacts.damageStatus],
    ["备注", model.fieldFacts.fieldNotes]
  ]);

  writeSection(doc, "三、费用及押金确认");
  writeKeyValueTable(doc, [
    ["车辆押金", model.fees.vehicleDeposit],
    ["违章押金", model.fees.violationDeposit],
    ["已付租金", model.fees.paidRent],
    ["其他费用", model.fees.otherFees]
  ]);

  writeSection(doc, "四、特别约定与告知");
  model.specialNotices.forEach((notice) => writeParagraph(doc, notice));

  writeSection(doc, "五、证据摘要");
  writeEvidenceSummaryTable(doc, model);

  ensureSpace(doc, 230);
  writeSection(doc, "六、签字确认");
  writeParagraph(doc, model.confirmationText);
  writeSignatureArea(doc, model);

  writeSection(doc, "操作提示");
  model.operationTips.forEach((tip) => writeParagraph(doc, tip));

  doc.end();
  return done;
}

function writeTitle(doc: PDFKit.PDFDocument, title: string) {
  resetCursorX(doc);
  doc.fontSize(20).text(title, doc.page.margins.left, doc.y, { align: "center", width: contentWidth(doc) });
  doc.moveDown(0.8);
}

function writeMetadata(doc: PDFKit.PDFDocument, model: DeliveryHandoverPdfRenderModel) {
  writeKeyValueTable(doc, [
    ["单据编号", model.documentNo],
    ["交接日期", model.handoverDate],
    ["交接地点", model.handoverPlace],
    ["订单编号", model.orderNo],
    ["合同编号", model.stage1ContractNo],
    ["生成时间", model.generatedAt],
    ["承租方", `${model.customer.name} / ${model.customer.mobileMasked} / ${model.customer.idNumberMasked}`],
    ["出租方", model.platform.legalName],
    ["客户确认", `${model.customerReview.objectionStatus} / ${model.customerReview.confirmedAt}`]
  ]);
}

function writeSection(doc: PDFKit.PDFDocument, title: string) {
  ensureSpace(doc, 42);
  resetCursorX(doc);
  doc.moveDown(0.6);
  doc.fontSize(13).text(title, doc.page.margins.left, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.35);
}

function writeParagraph(doc: PDFKit.PDFDocument, text: string) {
  ensureSpace(doc, 34);
  resetCursorX(doc);
  doc.fontSize(10).text(text, doc.page.margins.left, doc.y, {
    lineGap: 3,
    width: contentWidth(doc)
  });
  doc.moveDown(0.25);
}

function writeKeyValueTable(doc: PDFKit.PDFDocument, rows: Array<[string, string]>) {
  resetCursorX(doc);
  const width = contentWidth(doc);
  for (const [label, value] of rows) {
    const normalizedValue = value || EMPTY_VALUE;
    const valueWidth = width - TABLE_LABEL_WIDTH;
    const rowHeight = Math.max(
      26,
      doc.heightOfString(normalizedValue, { width: valueWidth - 12 }) + 12,
      doc.heightOfString(label, { width: TABLE_LABEL_WIDTH - 12 }) + 12
    );
    ensureSpace(doc, rowHeight + 6);
    const y = doc.y;
    doc.rect(doc.page.margins.left, y, TABLE_LABEL_WIDTH, rowHeight).stroke();
    doc.rect(doc.page.margins.left + TABLE_LABEL_WIDTH, y, valueWidth, rowHeight).stroke();
    doc.fontSize(9.5).text(label, doc.page.margins.left + 6, y + 7, { width: TABLE_LABEL_WIDTH - 12 });
    doc.text(normalizedValue, doc.page.margins.left + TABLE_LABEL_WIDTH + 6, y + 7, { width: valueWidth - 12 });
    doc.y = y + rowHeight;
  }
  resetCursorX(doc);
  doc.moveDown(0.25);
}

function writeEvidenceSummaryTable(doc: PDFKit.PDFDocument, model: DeliveryHandoverPdfRenderModel) {
  resetCursorX(doc);
  const width = contentWidth(doc);
  const columns = [
    { key: "title", title: "证据项", width: width * 0.34 },
    { key: "requirement", title: "要求", width: width * 0.17 },
    { key: "status", title: "状态", width: width * 0.17 },
    { key: "fileCount", title: "文件数", width: width * 0.12 },
    { key: "files", title: "文件摘要", width: width * 0.2 }
  ] as const;

  writeEvidenceHeader(doc, columns);
  for (const item of model.evidenceSummary.items) {
    const rowValues = {
      fileCount: String(item.fileCount),
      files: item.files.map((file) => `${file.displayName}/${file.mediaType}`).join("; ") || EMPTY_VALUE,
      requirement: item.fileRequired ? "必需" : item.isConditional ? "条件项" : "可选",
      status: `${item.status}/${item.reviewStatus}`,
      title: item.title
    };
    const rowHeight = Math.max(
      28,
      ...columns.map((column) => doc.heightOfString(rowValues[column.key], { width: column.width - 8 }) + 12)
    );
    ensureSpace(doc, rowHeight + 30);
    if (doc.y < doc.page.margins.top + 5) {
      writeEvidenceHeader(doc, columns);
    }
    const y = doc.y;
    let x = doc.page.margins.left;
    for (const column of columns) {
      doc.rect(x, y, column.width, rowHeight).stroke();
      doc.fontSize(8.5).text(rowValues[column.key], x + 4, y + 6, { width: column.width - 8 });
      x += column.width;
    }
    doc.y = y + rowHeight;
  }
  resetCursorX(doc);
  doc.moveDown(0.25);
}

function writeEvidenceHeader(
  doc: PDFKit.PDFDocument,
  columns: ReadonlyArray<{ title: string; width: number }>
) {
  ensureSpace(doc, 36);
  resetCursorX(doc);
  const y = doc.y;
  let x = doc.page.margins.left;
  for (const column of columns) {
    doc.rect(x, y, column.width, 24).stroke();
    doc.fontSize(9).text(column.title, x + 4, y + 7, { width: column.width - 8 });
    x += column.width;
  }
  doc.y = y + 24;
}

function writeSignatureArea(doc: PDFKit.PDFDocument, model: DeliveryHandoverPdfRenderModel) {
  ensureSpace(doc, 170);
  resetCursorX(doc);
  const width = contentWidth(doc);
  const columnWidth = width / 2;
  const rowHeight = 30;
  const headers = ["承租方", "出租方"];
  const rows = [
    ["（签字/手印）", "（盖章）"],
    [`身份证号：${model.customer.idNumberMasked}`, `经办人：${model.platform.contactName}`],
    [`联系电话：${model.customer.mobileMasked}`, `联系电话：${model.platform.contactPhone}`],
    ["日期：      年    月    日", "日期：      年    月    日"]
  ];
  const startY = doc.y;

  headers.forEach((header, index) => {
    const x = doc.page.margins.left + index * columnWidth;
    doc.rect(x, startY, columnWidth, rowHeight).stroke();
    doc.fontSize(10).text(header, x + 8, startY + 8, { align: "center", width: columnWidth - 16 });
  });

  rows.forEach((row, rowIndex) => {
    const y = startY + rowHeight * (rowIndex + 1);
    row.forEach((cell, columnIndex) => {
      const x = doc.page.margins.left + columnIndex * columnWidth;
      doc.rect(x, y, columnWidth, rowHeight).stroke();
      doc.fontSize(9.5).text(cell, x + 8, y + 8, { width: columnWidth - 16 });
    });
  });
  doc.y = startY + rowHeight * (rows.length + 1);
  resetCursorX(doc);
  doc.moveDown(0.5);
}

function ensureSpace(doc: PDFKit.PDFDocument, neededHeight: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) {
    doc.addPage();
    resetCursorX(doc);
  }
}

function resetCursorX(doc: PDFKit.PDFDocument) {
  doc.x = doc.page.margins.left;
}

function contentWidth(doc: PDFKit.PDFDocument) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function joinValues(values: string[]) {
  const filtered = values.filter((value) => value && value !== EMPTY_VALUE);
  return filtered.length ? filtered.join(" / ") : EMPTY_VALUE;
}

function validatePdfBuffer(buffer: Buffer, maxBytes: number) {
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_NOT_PDF}: renderer output is not a PDF`);
  }
  if (buffer.length > maxBytes) {
    throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_TOO_LARGE}: renderer output exceeds max bytes`);
  }
}

function sanitizeFileName(value: string) {
  const parsed = path.parse(value.replace(/[\\/]+/g, "_"));
  const base = parsed.name.replace(/[^\w.-]+/g, "_").slice(0, 120) || "handover";
  return base;
}
