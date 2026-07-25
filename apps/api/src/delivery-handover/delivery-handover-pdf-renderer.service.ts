import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";

import {
  DeliveryHandoverPdfRenderModel,
  STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT
} from "./delivery-handover-pdf-render-model";

export const STAGE2_HANDOVER_PDF_RENDER_CJK_FONT_REQUIRED =
  "STAGE2_HANDOVER_PDF_RENDER_CJK_FONT_REQUIRED";
export const STAGE2_HANDOVER_PDF_RENDER_NOT_PDF = "STAGE2_HANDOVER_PDF_RENDER_NOT_PDF";
export const STAGE2_HANDOVER_PDF_RENDER_TOO_MANY_PAGES =
  "STAGE2_HANDOVER_PDF_RENDER_TOO_MANY_PAGES";
export const STAGE2_HANDOVER_PDF_RENDER_TOO_LARGE = "STAGE2_HANDOVER_PDF_RENDER_TOO_LARGE";
export const STAGE2_HANDOVER_PDF_TARGET_BYTES = 15 * 1024 * 1024;
export const STAGE2_HANDOVER_PDF_HARD_MAX_BYTES = 18 * 1024 * 1024;
export const STAGE2_HANDOVER_PDF_MAX_PAGES = 100;

const DEFAULT_PAGE_SIZE = "A4";
const EMPTY_VALUE = "-";
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
const FADADA_COORDINATE_HEIGHT = 1131;
const FADADA_COORDINATE_WIDTH = 800;
const TABLE_LABEL_WIDTH = 92;

export type DeliveryHandoverPdfSigningSlotId =
  | "STAGE2_HANDOVER_CUSTOMER"
  | "STAGE2_HANDOVER_PLATFORM";

export interface DeliveryHandoverPdfSigningSlotCoordinate {
  coordinateSource: "PDFKIT_RENDERER";
  coordinateSystem: "FADADA_800_1131_TOP_LEFT";
  documentType: "DELIVERY_HANDOVER_CONFIRMATION";
  height: number;
  pageNumber: number;
  pdfPageHeight: number;
  pdfPageWidth: number;
  signingStage: "STAGE2_DELIVERY_HANDOVER";
  slotId: DeliveryHandoverPdfSigningSlotId;
  width: number;
  x: number;
  y: number;
}

export interface DeliveryHandoverPdfRenderOptions {
  cjkFontPath?: string;
  evidencePackageUrl?: string;
  loadAsset?: (fileId: string) => Promise<Buffer>;
  maxBytes?: number;
  maxPages?: number;
  pageSize?: PDFKit.PDFDocumentOptions["size"];
}

export interface DeliveryHandoverPdfRenderDiagnostics {
  evidenceFileCount: number;
  evidenceItemCount: number;
  hasCjkContent: boolean;
  hasCustomerSignatureArea: boolean;
  hasEvidenceSummary: boolean;
  hasPlatformSealArea: boolean;
  pageCount: number;
  photoCount: number;
  targetBytesExceeded: boolean;
  videoCount: number;
}

export interface DeliveryHandoverPdfRenderResult {
  buffer: Buffer;
  contentType: "application/pdf";
  diagnostics: DeliveryHandoverPdfRenderDiagnostics;
  fileName: string;
  slotCoordinates: DeliveryHandoverPdfSigningSlotCoordinate[];
}

export interface DeliveryHandoverPdfRenderFileResult {
  cleanup: () => Promise<void>;
  contentType: "application/pdf";
  diagnostics: DeliveryHandoverPdfRenderDiagnostics;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  slotCoordinates: DeliveryHandoverPdfSigningSlotCoordinate[];
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
    const rendered = await renderPdf(model, fontPath, options);
    if (!rendered.buffer) {
      throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_NOT_PDF}: renderer buffer is missing`);
    }
    validatePdfBuffer(rendered.buffer, options.maxBytes ?? STAGE2_HANDOVER_PDF_HARD_MAX_BYTES);
    validatePageCount(rendered.pageCount, options.maxPages ?? STAGE2_HANDOVER_PDF_MAX_PAGES);

    return {
      buffer: rendered.buffer,
      contentType: "application/pdf",
      diagnostics: {
        ...diagnostics,
        pageCount: rendered.pageCount,
        targetBytesExceeded: rendered.buffer.length > STAGE2_HANDOVER_PDF_TARGET_BYTES
      },
      fileName: `${sanitizeFileName(model.documentNo)}.pdf`,
      slotCoordinates: rendered.slotCoordinates
    };
  }

  async renderToFile(
    model: DeliveryHandoverPdfRenderModel,
    options: DeliveryHandoverPdfRenderOptions = {}
  ): Promise<DeliveryHandoverPdfRenderFileResult> {
    const diagnostics = buildDiagnostics(model);
    validateRenderModel(model, diagnostics);
    const fontPath = resolveFontPath(options, diagnostics);
    const directory = await mkdtemp(path.join(os.tmpdir(), "stage2-handover-pdf-"));
    const filePath = path.join(directory, `${sanitizeFileName(model.documentNo)}.pdf`);
    const cleanup = () => rm(directory, { force: true, recursive: true });

    try {
      const rendered = await renderPdf(model, fontPath, options, filePath);
      const fileStat = await stat(filePath);
      await validatePdfFile(filePath, fileStat.size, options.maxBytes ?? STAGE2_HANDOVER_PDF_HARD_MAX_BYTES);
      validatePageCount(rendered.pageCount, options.maxPages ?? STAGE2_HANDOVER_PDF_MAX_PAGES);

      return {
        cleanup,
        contentType: "application/pdf",
        diagnostics: {
          ...diagnostics,
          pageCount: rendered.pageCount,
          targetBytesExceeded: fileStat.size > STAGE2_HANDOVER_PDF_TARGET_BYTES
        },
        fileName: `${sanitizeFileName(model.documentNo)}.pdf`,
        filePath,
        sizeBytes: fileStat.size,
        slotCoordinates: rendered.slotCoordinates
      };
    } catch (error) {
      await Promise.allSettled([cleanup()]);
      throw error;
    }
  }
}

function buildDiagnostics(model: DeliveryHandoverPdfRenderModel): DeliveryHandoverPdfRenderDiagnostics {
  const searchable = JSON.stringify(model);
  return {
    evidenceFileCount: model.evidencePackage.stats.fileCount,
    evidenceItemCount: model.evidenceSummary.items.length,
    hasCjkContent: CJK_PATTERN.test(searchable),
    hasCustomerSignatureArea: true,
    hasEvidenceSummary: model.evidenceSummary.items.length === STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT,
    hasPlatformSealArea: true,
    pageCount: 0,
    photoCount: model.evidencePackage.stats.photoCount,
    targetBytesExceeded: false,
    videoCount: model.evidencePackage.stats.videoCount
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
  options: DeliveryHandoverPdfRenderOptions,
  outputPath?: string
) {
  const evidencePackageUrl = options.evidencePackageUrl?.trim();
  if (!evidencePackageUrl) {
    throw new Error("STAGE2_HANDOVER_PDF_EVIDENCE_PACKAGE_URL_REQUIRED: protected evidence package URL is required");
  }
  if (model.evidencePackage.files.length > 0 && !options.loadAsset) {
    throw new Error("STAGE2_HANDOVER_PDF_ASSET_LOADER_REQUIRED: derivative asset loader is required");
  }

  const doc = new PDFDocument({
    autoFirstPage: true,
    margin: 45,
    size: options.pageSize ?? DEFAULT_PAGE_SIZE
  });
  let pageCount = 1;
  const chunks: Buffer[] = [];
  const slotCoordinates: DeliveryHandoverPdfSigningSlotCoordinate[] = [];
  const output = outputPath ? fs.createWriteStream(outputPath, { flags: "wx" }) : null;
  const done = new Promise<Buffer | null>((resolve, reject) => {
    if (output) {
      doc.pipe(output);
      output.on("finish", () => resolve(null));
      output.on("error", reject);
    } else {
      doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    }
    doc.on("error", reject);
  });
  doc.on("pageAdded", () => {
    pageCount += 1;
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
    ["车架号（VIN）", model.vehicle.vin],
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

  writeSection(doc, "五、证据包声明");
  writeEvidencePackageDeclaration(doc, model, evidencePackageUrl);

  writeSection(doc, "六、证据摘要");
  writeEvidenceSummaryTable(doc, model);

  await writePhotoAttachments(doc, model, options.loadAsset!);
  await writeVideoAttachments(doc, model, evidencePackageUrl, options.loadAsset!);

  doc.addPage();
  writeSection(doc, "操作提示");
  model.operationTips.forEach((tip) => writeParagraph(doc, tip));

  ensureSpace(doc, 230);
  writeSection(doc, "九、签字确认");
  writeParagraph(doc, model.confirmationText);
  writeSignatureArea(doc, model, slotCoordinates, () => pageCount - 1);
  validateSigningSlotCoordinates(slotCoordinates, pageCount - 1);

  doc.end();
  const buffer = await done;
  return { buffer, pageCount, slotCoordinates };
}

function writeEvidencePackageDeclaration(
  doc: PDFKit.PDFDocument,
  model: DeliveryHandoverPdfRenderModel,
  evidencePackageUrl: string
) {
  writeParagraph(
    doc,
    "本确认单、下列全量照片附件、全量视频清单及关键帧共同构成一个不可分割的交接证据包。原始文件以清单中的 SHA-256 摘要绑定，签署后任何文件变化都会形成不同的证据包摘要。"
  );
  writeKeyValueTable(doc, [
    ["证据包编号", model.evidencePackage.packageId],
    ["清单版本", String(model.evidencePackage.schemaVersion)],
    ["证据包摘要", model.evidencePackage.manifestHash],
    ["文件统计", `${model.evidencePackage.stats.fileCount} 个文件（照片 ${model.evidencePackage.stats.photoCount}，视频 ${model.evidencePackage.stats.videoCount}）`],
    ["受保护查阅地址", evidencePackageUrl]
  ]);
}

async function writePhotoAttachments(
  doc: PDFKit.PDFDocument,
  model: DeliveryHandoverPdfRenderModel,
  loadAsset: (fileId: string) => Promise<Buffer>
) {
  const photos = model.evidencePackage.files.filter((file) => file.mediaType === "PHOTO");
  const columns = 2;
  const photosPerPage = 4;
  for (let index = 0; index < photos.length; index += photosPerPage) {
    doc.addPage();
    writeSection(doc, `七、照片证据附件（第 ${Math.floor(index / photosPerPage) + 1} 页）`);
    const pagePhotos = photos.slice(index, index + photosPerPage);
    const gap = 14;
    const cellWidth = (contentWidth(doc) - gap) / 2;
    const imageHeight = 150;
    const metadataHeight = 112;
    const rowGap = 16;
    const cellBlockHeight = imageHeight + metadataHeight;
    const startY = doc.y;

    for (let cellIndex = 0; cellIndex < pagePhotos.length; cellIndex += 1) {
      const file = pagePhotos[cellIndex]!;
      const derivativeFileId = file.derivativeFileIds[0];
      if (!derivativeFileId) {
        throw new Error(`STAGE2_HANDOVER_PDF_DERIVATIVE_MISSING: ${file.evidenceFileId}`);
      }
      const columnIndex = cellIndex % columns;
      const rowIndex = Math.floor(cellIndex / columns);
      const x = doc.page.margins.left + columnIndex * (cellWidth + gap);
      const y = startY + rowIndex * (cellBlockHeight + rowGap);
      const preview = await loadAsset(derivativeFileId);
      doc.rect(x, y, cellWidth, imageHeight).stroke();
      doc.image(preview, x + 5, y + 5, {
        align: "center",
        fit: [cellWidth - 10, imageHeight - 10],
        valign: "center"
      });
      const metadataY = y + imageHeight + 8;
      doc.fontSize(9).text(file.evidenceTitle, x, metadataY, { width: cellWidth });
      doc.fontSize(8).text(`证据文件 ID：${file.evidenceFileId}`, x, doc.y + 3, { width: cellWidth });
      doc.fontSize(8).text(`文件：${file.originalName}`, x, doc.y + 3, { width: cellWidth });
      doc.text(`原始大小：${formatFileSize(file.sourceSizeBytes)}`, x, doc.y + 3, { width: cellWidth });
      doc.text(`上传时间：${file.uploadedAt}`, x, doc.y + 3, { width: cellWidth });
      doc.text(`SHA-256：${file.sourceSha256}`, x, doc.y + 3, {
        lineBreak: true,
        width: cellWidth
      });
    }
    const rowCount = Math.ceil(pagePhotos.length / columns);
    doc.y = startY + rowCount * cellBlockHeight + Math.max(0, rowCount - 1) * rowGap;
    resetCursorX(doc);
  }
}

async function writeVideoAttachments(
  doc: PDFKit.PDFDocument,
  model: DeliveryHandoverPdfRenderModel,
  evidencePackageUrl: string,
  loadAsset: (fileId: string) => Promise<Buffer>
) {
  const videos = model.evidencePackage.files.filter((file) => file.mediaType === "VIDEO");
  for (let videoIndex = 0; videoIndex < videos.length; videoIndex += 1) {
    const file = videos[videoIndex]!;
    doc.addPage();
    writeSection(doc, `八、视频证据附件（${videoIndex + 1}/${videos.length}）`);
    writeKeyValueTable(doc, [
      ["证据项", file.evidenceTitle],
      ["证据文件 ID", file.evidenceFileId],
      ["原始文件", file.originalName],
      ["视频时长", formatDuration(file.videoDurationMs)],
      ["原始大小", formatFileSize(file.sourceSizeBytes)],
      ["上传时间", file.uploadedAt],
      ["原始文件摘要", file.sourceSha256],
      ["受保护查阅地址", evidencePackageUrl]
    ]);
    writeParagraph(
      doc,
      "下列关键帧用于在签署文件中识别视频内容；完整原始视频按上述 SHA-256 摘要归档，并可通过受保护地址查阅。"
    );

    const gap = 12;
    const cellWidth = (contentWidth(doc) - gap) / 2;
    const frameHeight = 155;
    const startY = doc.y;
    for (let frameIndex = 0; frameIndex < file.derivativeFileIds.length; frameIndex += 1) {
      const frameId = file.derivativeFileIds[frameIndex]!;
      const column = frameIndex % 2;
      const row = Math.floor(frameIndex / 2);
      const x = doc.page.margins.left + column * (cellWidth + gap);
      const y = startY + row * (frameHeight + 30);
      const frame = await loadAsset(frameId);
      doc.rect(x, y, cellWidth, frameHeight).stroke();
      doc.image(frame, x + 5, y + 5, {
        align: "center",
        fit: [cellWidth - 10, frameHeight - 10],
        valign: "center"
      });
      doc.fontSize(8.5).text(`关键帧 ${frameIndex + 1}`, x, y + frameHeight + 6, {
        align: "center",
        width: cellWidth
      });
    }
    doc.y = startY + Math.ceil(file.derivativeFileIds.length / 2) * (frameHeight + 30);
    resetCursorX(doc);
  }
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
    ["承租方", `${model.customer.name} / ${model.customer.mobile} / ${model.customer.idNumber}`],
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
      files: item.files.length > 0
        ? `${item.files.length} 个文件，详见照片/视频证据附件`
        : EMPTY_VALUE,
      requirement: item.fileRequired ? "必需" : item.isConditional ? "条件项" : "可选",
      status: formatEvidenceStatus(item.status, item.reviewStatus),
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

function writeSignatureArea(
  doc: PDFKit.PDFDocument,
  model: DeliveryHandoverPdfRenderModel,
  slotCoordinates: DeliveryHandoverPdfSigningSlotCoordinate[],
  getPageNumber: () => number
) {
  ensureSpace(doc, 170);
  resetCursorX(doc);
  const width = contentWidth(doc);
  const columnWidth = width / 2;
  const rowHeight = 30;
  const headers = ["承租方", "出租方"];
  const rows = [
    ["（签字/手印）", "（盖章）"],
    [`身份证号：${model.customer.idNumber}`, `经办人：${model.platform.contactName}`],
    [`联系电话：${model.customer.mobile}`, `联系电话：${model.platform.contactPhone}`],
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
      if (rowIndex === 0) {
        slotCoordinates.push(buildSigningSlotCoordinate({
          boxHeight: rowHeight,
          boxWidth: columnWidth,
          boxX: x,
          boxY: y,
          page: doc.page,
          pageNumber: getPageNumber(),
          slotId: columnIndex === 0 ? "STAGE2_HANDOVER_CUSTOMER" : "STAGE2_HANDOVER_PLATFORM"
        }));
      }
      doc.fontSize(9.5).text(cell, x + 8, y + 8, { width: columnWidth - 16 });
    });
  });
  doc.y = startY + rowHeight * (rows.length + 1);
  resetCursorX(doc);
  doc.moveDown(0.5);
}

function buildSigningSlotCoordinate(input: {
  boxHeight: number;
  boxWidth: number;
  boxX: number;
  boxY: number;
  page: PDFKit.PDFPage;
  pageNumber: number;
  slotId: DeliveryHandoverPdfSigningSlotId;
}): DeliveryHandoverPdfSigningSlotCoordinate {
  return {
    coordinateSource: "PDFKIT_RENDERER",
    coordinateSystem: "FADADA_800_1131_TOP_LEFT",
    documentType: "DELIVERY_HANDOVER_CONFIRMATION",
    height: toFadadaCoordinate(input.boxHeight, input.page.height, FADADA_COORDINATE_HEIGHT),
    pageNumber: input.pageNumber,
    pdfPageHeight: roundCoordinate(input.page.height),
    pdfPageWidth: roundCoordinate(input.page.width),
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    slotId: input.slotId,
    width: toFadadaCoordinate(input.boxWidth, input.page.width, FADADA_COORDINATE_WIDTH),
    x: toFadadaCoordinate(input.boxX + input.boxWidth / 2, input.page.width, FADADA_COORDINATE_WIDTH),
    y: toFadadaCoordinate(input.boxY + input.boxHeight / 2, input.page.height, FADADA_COORDINATE_HEIGHT)
  };
}

function validateSigningSlotCoordinates(
  coordinates: DeliveryHandoverPdfSigningSlotCoordinate[],
  finalPageNumber: number
) {
  const requiredSlotIds: DeliveryHandoverPdfSigningSlotId[] = [
    "STAGE2_HANDOVER_CUSTOMER",
    "STAGE2_HANDOVER_PLATFORM"
  ];
  for (const slotId of requiredSlotIds) {
    const matchingCoordinates = coordinates.filter((coordinate) => coordinate.slotId === slotId);
    if (matchingCoordinates.length !== 1) {
      throw new Error(`STAGE2_HANDOVER_PDF_SIGNING_SLOT_INVALID: ${slotId} must appear exactly once`);
    }
    validateSigningSlotCoordinate(matchingCoordinates[0]!, finalPageNumber);
  }
  if (coordinates.length !== requiredSlotIds.length) {
    throw new Error("STAGE2_HANDOVER_PDF_SIGNING_SLOT_INVALID: exactly two signing slots are required");
  }
}

function validateSigningSlotCoordinate(
  coordinate: DeliveryHandoverPdfSigningSlotCoordinate,
  finalPageNumber: number
) {
  const finiteValues = [
    coordinate.x,
    coordinate.y,
    coordinate.width,
    coordinate.height,
    coordinate.pdfPageWidth,
    coordinate.pdfPageHeight
  ];
  const isValid =
    coordinate.coordinateSource === "PDFKIT_RENDERER" &&
    coordinate.coordinateSystem === "FADADA_800_1131_TOP_LEFT" &&
    coordinate.documentType === "DELIVERY_HANDOVER_CONFIRMATION" &&
    coordinate.signingStage === "STAGE2_DELIVERY_HANDOVER" &&
    Number.isInteger(coordinate.pageNumber) &&
    coordinate.pageNumber === finalPageNumber &&
    finiteValues.every(Number.isFinite) &&
    coordinate.width > 0 &&
    coordinate.height > 0 &&
    coordinate.pdfPageWidth > 0 &&
    coordinate.pdfPageHeight > 0 &&
    coordinate.x - coordinate.width / 2 >= 0 &&
    coordinate.x + coordinate.width / 2 <= FADADA_COORDINATE_WIDTH &&
    coordinate.y - coordinate.height / 2 >= 0 &&
    coordinate.y + coordinate.height / 2 <= FADADA_COORDINATE_HEIGHT;

  if (!isValid) {
    throw new Error(`STAGE2_HANDOVER_PDF_SIGNING_SLOT_INVALID: ${coordinate.slotId} coordinate is invalid`);
  }
}

function toFadadaCoordinate(value: number, pdfDimension: number, fadadaDimension: number) {
  return roundCoordinate((value / pdfDimension) * fadadaDimension);
}

function roundCoordinate(value: number) {
  return Math.round(value * 1000) / 1000;
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

function formatDuration(value: number | null) {
  if (!value) {
    return EMPTY_VALUE;
  }
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatFileSize(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatEvidenceStatus(status: string, reviewStatus: string) {
  const values = Array.from(new Set(
    [status, reviewStatus].filter((value) => value && value !== EMPTY_VALUE)
  ));
  return values.length > 0 ? values.join("/") : EMPTY_VALUE;
}

function validatePdfBuffer(buffer: Buffer, maxBytes: number) {
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_NOT_PDF}: renderer output is not a PDF`);
  }
  if (!buffer.subarray(Math.max(0, buffer.length - 1024)).includes(Buffer.from("%%EOF"))) {
    throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_NOT_PDF}: renderer output is truncated`);
  }
  if (buffer.length > maxBytes) {
    throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_TOO_LARGE}: renderer output exceeds max bytes`);
  }
}

async function validatePdfFile(filePath: string, sizeBytes: number, maxBytes: number) {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !header.equals(Buffer.from("%PDF-"))) {
      throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_NOT_PDF}: renderer output is not a PDF`);
    }
    const tail = Buffer.alloc(Math.min(1024, sizeBytes));
    const tailResult = await handle.read(tail, 0, tail.length, sizeBytes - tail.length);
    if (!tail.subarray(0, tailResult.bytesRead).includes(Buffer.from("%%EOF"))) {
      throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_NOT_PDF}: renderer output is truncated`);
    }
  } finally {
    await handle.close();
  }
  if (sizeBytes > maxBytes) {
    throw new Error(`${STAGE2_HANDOVER_PDF_RENDER_TOO_LARGE}: renderer output exceeds max bytes`);
  }
}

function validatePageCount(pageCount: number, maxPages: number) {
  if (pageCount > maxPages) {
    throw new Error(
      `${STAGE2_HANDOVER_PDF_RENDER_TOO_MANY_PAGES}: renderer output has ${pageCount} pages; max is ${maxPages}`
    );
  }
}

function sanitizeFileName(value: string) {
  const parsed = path.parse(value.replace(/[\\/]+/g, "_"));
  const base = parsed.name.replace(/[^\w.-]+/g, "_").slice(0, 120) || "handover";
  return base;
}
