import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { PermissionCode } from "@subscription-saas/shared";
import {
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  buildDeliveryHandoverPdfRenderModel,
  STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT
} from "../src/delivery-handover/delivery-handover-pdf-render-model";
import {
  DeliveryHandoverPdfRendererService,
  STAGE2_HANDOVER_PDF_HARD_MAX_BYTES,
  STAGE2_HANDOVER_PDF_MAX_PAGES,
  STAGE2_HANDOVER_PDF_TARGET_BYTES
} from "../src/delivery-handover/delivery-handover-pdf-renderer.service";
import { PermissionsGuard } from "../src/auth/permissions.guard";
import { HandoverWorkOrderAdminController } from "../src/handover-work-order/handover-work-order.controller";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { Stage2HandoverWorkflowRepository } from "../src/handover-work-order/stage2-handover-workflow.repository";

const pdfKitMock = vi.hoisted(() => {
  interface FakePageOptions {
    info?: Record<string, unknown>;
    margin?: number;
    margins?: { bottom?: number; left?: number; right?: number; top?: number };
    size?: string | [number, number];
  }

  class FakePDFDocument {
    static imageCalls: Array<{ image: Buffer | string; pageNumber: number }> = [];
    static options: FakePageOptions = {};
    static rectCalls: Array<{
      height: number;
      pageHeight: number;
      pageNumber: number;
      pageWidth: number;
      width: number;
      x: number;
      y: number;
    }> = [];
    static textCalls: Array<{
      height: number;
      pageHeight: number;
      pageNumber: number;
      pageWidth: number;
      text: string;
      x: number;
      y: number;
    }> = [];

    static startCapture() {
      FakePDFDocument.imageCalls = [];
      FakePDFDocument.options = {};
      FakePDFDocument.rectCalls = [];
      FakePDFDocument.textCalls = [];
      return {
        imageCalls: FakePDFDocument.imageCalls,
        rectCalls: FakePDFDocument.rectCalls,
        textCalls: FakePDFDocument.textCalls
      };
    }

    info: Record<string, unknown> = {};
    page = {
      height: 841.89,
      margins: { bottom: 45, left: 45, right: 45, top: 45 },
      width: 595.28
    };
    x = 45;
    y = 45;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    private pageNumber = 1;

    constructor(options: FakePageOptions = {}) {
      FakePDFDocument.options = options;
      const margin = options.margin ?? 45;
      const [width, height] = Array.isArray(options.size) ? options.size : [595.28, 841.89];
      this.page = {
        height,
        margins: { bottom: margin, left: margin, right: margin, top: margin },
        width
      };
      this.x = margin;
      this.y = margin;
    }

    addPage(options?: FakePageOptions) {
      this.pageNumber += 1;
      const pageOptions = options ?? FakePDFDocument.options;
      const [width, height] = Array.isArray(pageOptions.size)
        ? pageOptions.size
        : pageOptions.size?.toUpperCase() === "A4"
          ? [595.28, 841.89]
          : [612, 792];
      const defaultMargin = pageOptions.margin ?? 72;
      this.page = {
        height,
        margins: {
          bottom: pageOptions.margins?.bottom ?? defaultMargin,
          left: pageOptions.margins?.left ?? defaultMargin,
          right: pageOptions.margins?.right ?? defaultMargin,
          top: pageOptions.margins?.top ?? defaultMargin
        },
        width
      };
      this.x = this.page.margins.left;
      this.y = this.page.margins.top;
      this.emit("pageAdded");
      return this;
    }

    emit(eventName: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(eventName) ?? []) {
        listener(...args);
      }
    }

    end() {
      this.emit("data", Buffer.from("%PDF-fake-stage2-output\n%%EOF"));
      this.emit("end");
    }

    fillColor() {
      return this;
    }

    font() {
      return this;
    }

    fontSize() {
      return this;
    }

    heightOfString(text: string) {
      return Math.max(12, Math.ceil(String(text).length / 48) * 14);
    }

    image(image: Buffer | string) {
      FakePDFDocument.imageCalls.push({ image, pageNumber: this.pageNumber });
      return this;
    }

    lineTo() {
      return this;
    }

    moveDown(lines = 1) {
      this.y += 12 * Number(lines);
      return this;
    }

    moveTo() {
      return this;
    }

    on(eventName: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(eventName, [...(this.listeners.get(eventName) ?? []), listener]);
      return this;
    }

    rect(x: number, y: number, width: number, height: number) {
      FakePDFDocument.rectCalls.push({
        height,
        pageHeight: this.page.height,
        pageNumber: this.pageNumber,
        pageWidth: this.page.width,
        width,
        x,
        y
      });
      return this;
    }

    stroke() {
      return this;
    }

    text(text: string, xOrOptions?: number | Record<string, unknown>, y?: number) {
      if (typeof xOrOptions === "number") {
        this.x = xOrOptions;
      }
      if (typeof y === "number") {
        this.y = y;
      }
      const height = this.heightOfString(text);
      FakePDFDocument.textCalls.push({
        height,
        pageHeight: this.page.height,
        pageNumber: this.pageNumber,
        pageWidth: this.page.width,
        text,
        x: this.x,
        y: this.y
      });
      this.y += height;
      return this;
    }
  }

  return { FakePDFDocument };
});

vi.mock("pdfkit", () => ({ default: pdfKitMock.FakePDFDocument }));

describe("Stage 2 handover PDF renderer", () => {
  it("builds a safe handover render model with full signing-party identifiers and VIN", () => {
    const model = buildDeliveryHandoverPdfRenderModel(createRenderModelInput());
    const serialized = JSON.stringify(model);

    expect(model.documentNo).toBe("HDV-STAGE2-PDF-001");
    expect(model.customer.idNumber).toBe("110101199001015678");
    expect(model.customer.mobile).toBe("13812345678");
    expect(model.vehicle.vin).toBe("LTESTVIN123456789");
    expect(model.evidenceSummary.items).toHaveLength(STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT);
    expect(model.evidenceSummary.items[0]?.files[0]).toMatchObject({
      displayName: "front.jpg",
      evidenceFileId: "evidence-file-1",
      fileId: "file-1",
      mediaType: "PHOTO"
    });
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("application-materials");
    expect(serialized).not.toContain("signUrl");
    expect(serialized).not.toContain("oss://");
  });

  it("renders visible handover sections, evidence summary, and signature areas without debug text", async () => {
    const renderer = new DeliveryHandoverPdfRendererService();
    const { imageCalls, textCalls } = pdfKitMock.FakePDFDocument.startCapture();
    const loadAsset = vi.fn(async () => Buffer.from("synthetic-jpeg"));

    const result = await renderer.render(buildDeliveryHandoverPdfRenderModel(createRenderModelInput()), {
      cjkFontPath: process.execPath,
      evidencePackageUrl: "https://portal.example.test/portal/handover-reviews/work-order-1",
      loadAsset
    });
    const visibleText = textCalls.map((call) => call.text).join("\n");

    expect(result.contentType).toBe("application/pdf");
    expect(result.fileName).toBe("HDV-STAGE2-PDF-001.pdf");
    expect(result.diagnostics).toMatchObject({
      evidenceItemCount: STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT,
      hasCustomerSignatureArea: true,
      hasEvidenceSummary: true,
      hasPlatformSealArea: true
    });
    expect(visibleText).toContain("车辆交接确认单");
    expect(visibleText).toContain("车辆基本信息");
    expect(visibleText).toContain("车况确认");
    expect(visibleText).toContain("证据摘要");
    expect(visibleText).toContain("证据包声明");
    expect(visibleText).toContain("照片证据附件");
    expect(visibleText).toContain("视频证据附件");
    expect(visibleText).toContain("sha256:");
    expect(visibleText).toContain("https://portal.example.test/portal/handover-reviews/work-order-1");
    expect(visibleText).toContain("原始大小");
    expect(visibleText).toContain("上传时间");
    expect(visibleText).toContain("详见照片/视频证据附件");
    expect(visibleText).toContain("承租方");
    expect(visibleText).toContain("出租方");
    expect(visibleText).toContain("身份证号：110101199001015678");
    expect(visibleText).toContain("联系电话：13812345678");
    expect(visibleText).toContain("联系电话：13900001111");
    expect(visibleText).toContain("车架号（VIN）");
    expect(visibleText).toContain("LTESTVIN123456789");
    expect(visibleText).not.toContain("138****5678");
    expect(visibleText).not.toContain("139****1111");
    expect(visibleText).not.toContain("车架号（后6位）");
    expect(visibleText).not.toContain("APPROVED/APPROVED");
    expect(visibleText).not.toContain("Render Diagnostics");
    expect(imageCalls).toHaveLength(17);
    expect(loadAsset).toHaveBeenCalledTimes(17);
    expect(loadAsset).not.toHaveBeenCalledWith("file-8");
    const evidenceFiles = buildDeliveryHandoverPdfRenderModel(createRenderModelInput()).evidencePackage.files;
    for (const file of evidenceFiles) {
      expect(visibleText).toContain(file.evidenceFileId);
      expect(visibleText.split(file.sourceSha256)).toHaveLength(2);
    }
  });

  it("binds stable PDFKit metadata and file-ID input to the reserved generation time", async () => {
    const renderer = new DeliveryHandoverPdfRendererService();
    const model = buildDeliveryHandoverPdfRenderModel(createRenderModelInput());
    pdfKitMock.FakePDFDocument.startCapture();

    await renderer.render(model, {
      cjkFontPath: process.execPath,
      evidencePackageUrl:
        "https://portal.example.test/portal/handover-reviews/work-order-1",
      loadAsset: async () => Buffer.from("synthetic-jpeg")
    });

    expect(pdfKitMock.FakePDFDocument.options).toMatchObject({
      info: {
        CreationDate: new Date("2026-07-25T10:00:00.000Z"),
        Creator: "Stage 2 Delivery Handover PDF Renderer",
        Keywords: "delivery,handover,stage2,pdf",
        ModDate: new Date("2026-07-25T10:00:00.000Z"),
        Producer: "Subscription SaaS",
        Subject: "Stage 2 delivery handover PDF source artifact",
        Title: "HDV-STAGE2-PDF-001"
      }
    });
  });

  it("emits exactly two bounded signing slots at the final signature boxes without visible metadata", async () => {
    const renderer = new DeliveryHandoverPdfRendererService();
    const { rectCalls, textCalls } = pdfKitMock.FakePDFDocument.startCapture();
    const model = buildDeliveryHandoverPdfRenderModel(createRenderModelInput());

    const result = await renderer.render(model, {
      cjkFontPath: process.execPath,
      evidencePackageUrl: "https://portal.example.test/portal/handover-reviews/work-order-1",
      loadAsset: async () => Buffer.from("synthetic-jpeg")
    });
    const coordinates = result.slotCoordinates;
    const visibleText = textCalls.map((call) => call.text).join("\n");

    expect(coordinates).toHaveLength(2);
    expect(coordinates.map((coordinate) => coordinate.slotId).sort()).toEqual([
      "STAGE2_HANDOVER_CUSTOMER",
      "STAGE2_HANDOVER_PLATFORM"
    ]);
    for (const slotId of ["STAGE2_HANDOVER_CUSTOMER", "STAGE2_HANDOVER_PLATFORM"]) {
      expect(coordinates.filter((coordinate) => coordinate.slotId === slotId)).toHaveLength(1);
    }

    const finalPageNumber = result.diagnostics.pageCount - 1;
    const finalPageSignatureBoxes = rectCalls
      .filter((call) => call.pageNumber === result.diagnostics.pageCount)
      .filter((call) => call.height >= 144);

    expect(finalPageSignatureBoxes).toHaveLength(2);
    coordinates.forEach((coordinate, index) => {
      const signatureBox = finalPageSignatureBoxes[index]!;
      const numericValues = [
        coordinate.x,
        coordinate.y,
        coordinate.width,
        coordinate.height,
        coordinate.pdfPageWidth,
        coordinate.pdfPageHeight
      ] as number[];

      expect(coordinate.documentType).toBe("DELIVERY_HANDOVER");
      expect(coordinate.signingStage).toBe("STAGE2_DELIVERY_HANDOVER");
      expect(coordinate.coordinateSystem).toBe("FADADA_800_1131_TOP_LEFT");
      expect(coordinate.pageNumber).toBe(finalPageNumber);
      expect(Number.isInteger(coordinate.pageNumber)).toBe(true);
      expect(numericValues.every(Number.isFinite)).toBe(true);
      expect(coordinate.pdfPageWidth).toBe(595.28);
      expect(coordinate.pdfPageHeight).toBe(841.89);
      expect(signatureBox.height).toBeGreaterThanOrEqual(144);
      expect(coordinate.x).toBeCloseTo(
        ((signatureBox.x + signatureBox.width / 2) / 595.28) * 800,
        3
      );
      expect(coordinate.y).toBeCloseTo(
        ((signatureBox.y + signatureBox.height / 2) / 841.89) * 1131,
        3
      );
      expect(coordinate.width).toBeCloseTo((signatureBox.width / 595.28) * 800, 3);
      expect(coordinate.height).toBeCloseTo((signatureBox.height / 841.89) * 1131, 3);
      expect(coordinate.x - coordinate.width / 2).toBeGreaterThanOrEqual(0);
      expect(coordinate.x + coordinate.width / 2).toBeLessThanOrEqual(800);
      expect(coordinate.y - coordinate.height / 2).toBeGreaterThanOrEqual(0);
      expect(coordinate.y + coordinate.height / 2).toBeLessThanOrEqual(1131);
    });
    expect(new Set(coordinates.map((coordinate) => coordinate.pageNumber))).toEqual(
      new Set([finalPageNumber])
    );

    const signatureRowBottom = Math.max(
      ...finalPageSignatureBoxes.map((signatureBox) => signatureBox.y + signatureBox.height)
    );
    const signatureDetailText = textCalls.filter((call) =>
      call.pageNumber === result.diagnostics.pageCount &&
      (
        call.text.includes(model.customer.idNumber) ||
        call.text.includes(model.customer.mobile) ||
        call.text.includes(model.platform.contactName) ||
        call.text.includes(model.platform.contactPhone) ||
        call.text.includes("日期")
      )
    );

    expect(signatureDetailText).toHaveLength(6);
    for (const detailText of signatureDetailText) {
      expect(detailText.y).toBeGreaterThan(signatureRowBottom);
    }

    for (const hiddenValue of [
      "STAGE2_HANDOVER_CUSTOMER",
      "STAGE2_HANDOVER_PLATFORM",
      "STAGE2_DELIVERY_HANDOVER",
      "FADADA_800_1131_TOP_LEFT",
      "Render Diagnostics",
      "objectKey",
      "application-materials",
      "signUrl",
      "oss://",
      "fadada"
    ]) {
      expect(visibleText.toLowerCase()).not.toContain(hiddenValue.toLowerCase());
    }
  });

  it("creates a bounded final signing page for a short supported page", async () => {
    const renderer = new DeliveryHandoverPdfRendererService();
    const model = buildDeliveryHandoverPdfRenderModel(createRenderModelInput());
    const { rectCalls, textCalls } = pdfKitMock.FakePDFDocument.startCapture();

    const result = await renderer.render(model, {
      cjkFontPath: process.execPath,
      evidencePackageUrl: "https://portal.example.test/portal/handover-reviews/work-order-1",
      loadAsset: async () => Buffer.from("synthetic-jpeg"),
      pageSize: [595.28, 320]
    });
    const visibleText = textCalls.map((call) => call.text).join("\n");
    const finalPageNumber = result.diagnostics.pageCount - 1;
    const finalPagePdfKitNumber = result.diagnostics.pageCount;
    const finalPageTableBorders = rectCalls.filter(
      (call) => call.pageNumber === finalPagePdfKitNumber
    );
    const finalPageSignatureBoxes = finalPageTableBorders.filter(
      (call) => call.height >= 144
    );
    const finalPageDateText = textCalls.filter(
      (call) => call.pageNumber === finalPagePdfKitNumber && call.text.includes("日期")
    );

    expect(result.slotCoordinates.map((coordinate) => coordinate.pageNumber)).toEqual([
      finalPageNumber,
      finalPageNumber
    ]);
    expect(finalPageNumber).toBeGreaterThan(0);
    expect(finalPageTableBorders).toHaveLength(12);
    expect(finalPageSignatureBoxes).toHaveLength(2);
    expect(finalPageDateText).toHaveLength(2);
    for (const border of finalPageTableBorders) {
      expect(border.x).toBeGreaterThanOrEqual(45);
      expect(border.y).toBeGreaterThanOrEqual(45);
      expect(border.x + border.width).toBeLessThanOrEqual(border.pageWidth - 45);
      expect(border.y + border.height).toBeLessThanOrEqual(border.pageHeight - 45);
    }
    for (const dateText of finalPageDateText) {
      expect(dateText.x).toBeGreaterThanOrEqual(45);
      expect(dateText.y).toBeGreaterThanOrEqual(45);
      expect(dateText.x).toBeLessThanOrEqual(dateText.pageWidth - 45);
      expect(dateText.y + dateText.height).toBeLessThanOrEqual(dateText.pageHeight - 45);
    }
    result.slotCoordinates.forEach((coordinate, index) => {
      const signatureBox = finalPageSignatureBoxes[index]!;
      expect(coordinate.pdfPageHeight).toBeGreaterThan(320);
      expect(coordinate.pdfPageHeight).toBe(signatureBox.pageHeight);
      expect(coordinate.pdfPageWidth).toBe(signatureBox.pageWidth);
      expect(coordinate.x).toBeCloseTo(
        ((signatureBox.x + signatureBox.width / 2) / signatureBox.pageWidth) * 800,
        3
      );
      expect(coordinate.y).toBeCloseTo(
        ((signatureBox.y + signatureBox.height / 2) / signatureBox.pageHeight) * 1131,
        3
      );
      expect(coordinate.width).toBeCloseTo((signatureBox.width / signatureBox.pageWidth) * 800, 3);
      expect(coordinate.height).toBeCloseTo((signatureBox.height / signatureBox.pageHeight) * 1131, 3);
    });
    for (const tip of model.operationTips) {
      expect(visibleText).toContain(tip);
    }
    for (const hiddenValue of [
      "STAGE2_HANDOVER_CUSTOMER",
      "STAGE2_HANDOVER_PLATFORM",
      "STAGE2_DELIVERY_HANDOVER",
      "FADADA_800_1131_TOP_LEFT",
      "Render Diagnostics"
    ]) {
      expect(visibleText).not.toContain(hiddenValue);
    }
  });

  it("lays out photo evidence four per page", async () => {
    const renderer = new DeliveryHandoverPdfRendererService();
    const model = buildDeliveryHandoverPdfRenderModel(createRenderModelInput());
    const { imageCalls } = pdfKitMock.FakePDFDocument.startCapture();

    await renderer.render(model, {
      cjkFontPath: process.execPath,
      evidencePackageUrl: "https://portal.example.test/portal/handover-reviews/work-order-1",
      loadAsset: async () => Buffer.from("synthetic-jpeg")
    });

    const photoCalls = imageCalls.slice(0, model.evidencePackage.stats.photoCount);
    const photoCountsByPage = [...photoCalls.reduce((counts, call) => {
      counts.set(call.pageNumber, (counts.get(call.pageNumber) ?? 0) + 1);
      return counts;
    }, new Map<number, number>()).values()];
    expect(photoCountsByPage).toEqual([4, 4, 4, 1]);
  });

  it("uses the approved 15 MiB target, 18 MiB hard limit, and 100-page ceiling", () => {
    expect(STAGE2_HANDOVER_PDF_TARGET_BYTES).toBe(15 * 1024 * 1024);
    expect(STAGE2_HANDOVER_PDF_HARD_MAX_BYTES).toBe(18 * 1024 * 1024);
    expect(STAGE2_HANDOVER_PDF_MAX_PAGES).toBe(100);
  });

  it("fails closed when the rendered byte or page budget is exceeded", async () => {
    const renderer = new DeliveryHandoverPdfRendererService();
    const model = buildDeliveryHandoverPdfRenderModel(createRenderModelInput());
    const options = {
      cjkFontPath: process.execPath,
      evidencePackageUrl: "https://portal.example.test/portal/handover-reviews/work-order-1",
      loadAsset: vi.fn(async () => Buffer.from("synthetic-jpeg"))
    };

    await expect(renderer.render(model, { ...options, maxBytes: 5 }))
      .rejects.toThrow("STAGE2_HANDOVER_PDF_RENDER_TOO_LARGE");
    await expect(renderer.render(model, { ...options, maxPages: 1 }))
      .rejects.toThrow("STAGE2_HANDOVER_PDF_RENDER_TOO_MANY_PAGES");
  });
});

describe("HandoverWorkOrderService Stage 2 PDF generation", () => {
  it("builds the current manifest from local metadata without storage or mutation calls", async () => {
    const harness = createServiceHarness();

    await expect(
      harness.service.getCurrentEvidencePackage("work-order-1")
    ).resolves.toMatchObject({
      manifestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });

    expect(harness.storageService.getObject).not.toHaveBeenCalled();
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath).not.toHaveBeenCalled();
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
    expect(harness.prisma.contract.update).not.toHaveBeenCalled();
    expect(harness.prisma.fileObject.create).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDeliveryHandover.updateMany).not.toHaveBeenCalled();
  });

  it("creates a generated handover contract PDF artifact without starting any e-sign task", async () => {
    const harness = createServiceHarness();

    const result = await harness.service.generateStage2HandoverPdf("work-order-1", "admin-1");

    expect(result.status).toBe("GENERATED");
    expect(result.artifactId).toBe("file-pdf-1");
    expect(result.documentNo).toMatch(/^HDV-[0-9a-f]{32}$/);
    expect(result.downloadUrl).toBe("/api/handover-work-orders/work-order-1/pdf/download");
    expect(harness.prisma.contract.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.contract.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessType: BusinessType.SUBSCRIPTION,
        contractVersionId: "template-handover-v1",
        contractTitle: "车辆交接确认单 V1.0",
        customerId: "customer-1",
        fileId: "file-pdf-1",
        orderId: "order-1",
        status: ContractStatus.GENERATED
      })
    });
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath).toHaveBeenCalledOnce();
    expect(harness.storageService.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(harness.prisma.fileObject.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.fileObject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bucket: "application-materials",
        mimeType: "application/pdf",
        objectKey: expect.stringMatching(
          /^contracts\/[0-9a-f-]{36}\/generated\/handover-v2-[0-9a-f]{64}\.pdf$/
        ),
        originalName: "handover.pdf",
        uploadedBy: "admin-1"
      })
    });
    expect(harness.prisma.contract.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contractSnapshot: expect.objectContaining({
          stage2HandoverPdfArtifact: {
            artifactKind: "stage2-handover-pdf-source",
            artifactVersion: 2,
            documentType: "DELIVERY_HANDOVER",
            fileId: "file-pdf-1",
            pageCount: 10,
            rendererVersion: 2,
            signingStage: "STAGE2_DELIVERY_HANDOVER",
            slotCoordinates: stage2ArtifactCoordinates(),
            sourcePdfHash: createHash("sha256")
              .update(Buffer.from("%PDF-stage2-output"))
              .digest("hex")
          }
        }),
        fileId: "file-pdf-1"
      })
    });
    expect(harness.prisma.vehicleDeliveryHandover.update)
      .toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        artifactVersion: 2,
        handoverContractId: "contract-stage2-1",
        manifestHash: currentManifestDigest(),
        sourceDocumentFileId: "file-pdf-1",
        sourceObjectKey: expect.stringMatching(
          /^contracts\/[0-9a-f-]{36}\/generated\/handover-v2-[0-9a-f]{64}\.pdf$/
        ),
        sourcePdfHash: createHash("sha256")
          .update(Buffer.from("%PDF-stage2-output"))
          .digest("hex"),
        status: DeliveryHandoverStatus.SOURCE_GENERATED,
        updatedBy: "admin-1"
      }),
      where: { id: "handover-1" }
    });
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
  });

  it(
    "generates the Stage 2 source PDF when the Stage 1 contract is archived",
    async () => {
      const harness = createServiceHarness();
      Object.assign(harness.records.handover.stage1Contract, {
        status: ContractStatus.ARCHIVED
      });

      await expect(
        ensureStage2HandoverPdf(
          harness.service,
          "work-order-1",
          harness.currentManifestHash
        )
      ).resolves.toMatchObject({ status: "GENERATED" });
    }
  );

  it(
    "rejects Stage 2 source PDF generation before the Stage 1 contract is signed",
    async () => {
      const harness = createServiceHarness();
      Object.assign(harness.records.handover.stage1Contract, {
        status: ContractStatus.GENERATED
      });

      await expect(
        ensureStage2HandoverPdf(
          harness.service,
          "work-order-1",
          harness.currentManifestHash
        )
      ).rejects.toThrow("Stage 1 合同尚未完成签署");
      expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
    }
  );

  it("reuses a source artifact with the same manifest hash and source PDF hash", async () => {
    const harness = createServiceHarness();
    linkCompleteSourceArtifact(harness);

    const result = await ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash
    );

    expect(result).toMatchObject({
      artifactId: "file-pdf-1",
      status: "GENERATED",
      workOrderId: "work-order-1"
    });
    expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
    expect(harness.prisma.fileObject.create).not.toHaveBeenCalled();
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath)
      .not.toHaveBeenCalled();
    expect(harness.workflowJobs).toHaveLength(1);
    expect(harness.workflowJobs[0]).toMatchObject({
      idempotencyKey: "field-notify:work-order-1:2",
      jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY
    });
  });

  it("supersedes a valid unsigned legacy renderer artifact before generating the current version", async () => {
    const harness = createServiceHarness();
    linkCompleteSourceArtifact(harness, {
      artifactVersion: 1,
      rendererVersion: null
    });

    const result = await ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash
    );

    expect(result).toMatchObject({
      artifactVersion: 2,
      status: "GENERATED"
    });
    expect(harness.prisma.contract.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: ContractStatus.CANCELLED
      }),
      where: { id: "contract-stage2-1" }
    });
    expect(harness.renderer.renderToFile).toHaveBeenCalledOnce();
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath)
      .toHaveBeenCalledOnce();
  });

  it("rejects reuse when the handover is not SOURCE_GENERATED", async () => {
    const harness = createServiceHarness();
    linkCompleteSourceArtifact(harness);
    harness.records.handover.status = DeliveryHandoverStatus.DRAFT;

    await expect(
      ensureStage2HandoverPdf(
        harness.service,
        "work-order-1",
        harness.currentManifestHash
      )
    ).rejects.toThrow("artifact binding is invalid");

    expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
    expect(harness.workflowJobs).toEqual([]);
  });

  it("rejects reuse when the Contract artifact snapshot does not match the handover", async () => {
    const harness = createServiceHarness();
    linkCompleteSourceArtifact(harness);
    const snapshot = harness.records.handover.handoverContract
      .contractSnapshot as Record<string, unknown>;
    snapshot.stage2HandoverPdfArtifact = {
      artifactVersion: 2,
      fileId: "different-file",
      sourcePdfHash: "f".repeat(64)
    };

    await expect(
      ensureStage2HandoverPdf(
        harness.service,
        "work-order-1",
        harness.currentManifestHash
      )
    ).rejects.toThrow("artifact binding is invalid");

    expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
    expect(harness.workflowJobs).toEqual([]);
  });

  it("does not duplicate Contract, FileObject, storage object, or next job on retry", async () => {
    const harness = createServiceHarness();

    const first = await ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash
    );
    const repeated = await ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash
    );

    expect(repeated.artifactId).toBe(first.artifactId);
    expect(harness.prisma.contract.create).toHaveBeenCalledTimes(1);
    expect(harness.prisma.fileObject.create).toHaveBeenCalledTimes(1);
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath)
      .toHaveBeenCalledTimes(1);
    expect(harness.workflowJobs).toHaveLength(1);
  });

  it("retries only source finalization after a PostgreSQL serialization conflict", async () => {
    const harness = createServiceHarness();
    const runTransaction =
      harness.transaction.getMockImplementation()!;
    harness.transaction
      .mockImplementationOnce(runTransaction)
      .mockRejectedValueOnce({ code: "P2034" })
      .mockImplementation(runTransaction);

    await expect(
      ensureStage2HandoverPdf(
        harness.service,
        "work-order-1",
        harness.currentManifestHash
      )
    ).resolves.toMatchObject({ status: "GENERATED" });

    expect(harness.transaction).toHaveBeenCalledTimes(3);
    expect(harness.renderer.renderToFile).toHaveBeenCalledTimes(1);
    expect(
      harness.storageService.putGeneratedContractPdfArtifactFromPath
    ).toHaveBeenCalledTimes(1);
    expect(harness.prisma.contract.create).toHaveBeenCalledTimes(1);
    expect(harness.workflowJobs).toHaveLength(1);
  });

  it("renders with the persisted deterministic Contract creation time", async () => {
    const harness = createServiceHarness();

    await ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash
    );

    const renderModel = harness.renderer.renderToFile.mock.calls[0]?.[0] as
      | { generatedAt: string }
      | undefined;
    expect(renderModel?.generatedAt).toBe("2026-07-25T10:00:00.000Z");
    expect(harness.prisma.contract.create).toHaveBeenCalledTimes(1);
  });

  it("reserves globally distinct Contract numbers for legacy-suffix collisions and retries", async () => {
    const [firstIdentity, secondIdentity] =
      LEGACY_STAGE2_CONTRACT_NUMBER_COLLISION;
    const persistedContractNumbers = new Set<string>();
    const createHarness = (
      identity: typeof LEGACY_STAGE2_CONTRACT_NUMBER_COLLISION[number]
    ) => {
      const harness = createServiceHarness();
      harness.records.workOrder.id = identity.workOrderId;
      const createContract =
        harness.prisma.contract.create.getMockImplementation()!;
      harness.prisma.contract.create.mockImplementation(async (args) => {
        const contractNo = String(args.data.contractNo);
        if (persistedContractNumbers.has(contractNo)) {
          throw Object.assign(
            new Error(`Duplicate Contract number: ${contractNo}`),
            { code: "P2002" }
          );
        }
        persistedContractNumbers.add(contractNo);
        return createContract(args);
      });
      return harness;
    };
    const first = createHarness(firstIdentity);
    const second = createHarness(secondIdentity);
    const firstManifestHash = (await first.service.getCurrentEvidencePackage(firstIdentity.workOrderId)).manifestHash;
    const secondManifestHash = (await second.service.getCurrentEvidencePackage(secondIdentity.workOrderId)).manifestHash;

    await expect(
      ensureStage2HandoverPdf(
        first.service,
        firstIdentity.workOrderId,
        firstManifestHash
      )
    ).resolves.toMatchObject({ status: "GENERATED" });
    await expect(
      ensureStage2HandoverPdf(
        second.service,
        secondIdentity.workOrderId,
        secondManifestHash
      )
    ).resolves.toMatchObject({ status: "GENERATED" });
    await expect(
      ensureStage2HandoverPdf(
        second.service,
        secondIdentity.workOrderId,
        secondManifestHash
      )
    ).resolves.toMatchObject({ status: "GENERATED" });

    const contractNumbers = [
      first.prisma.contract.create.mock.calls[0]?.[0].data.contractNo,
      second.prisma.contract.create.mock.calls[0]?.[0].data.contractNo
    ];
    expect(firstIdentity.legacyContractNo).toBe(secondIdentity.legacyContractNo);
    expect(contractNumbers).toEqual([
      expect.stringMatching(/^HDV-[0-9a-f]{32}$/),
      expect.stringMatching(/^HDV-[0-9a-f]{32}$/)
    ]);
    expect(new Set(contractNumbers).size).toBe(2);
    expect(second.prisma.contract.create).toHaveBeenCalledTimes(1);
  });

  it("does not expose a Contract when rendering fails", async () => {
    const harness = createServiceHarness();
    harness.renderer.renderToFile.mockRejectedValueOnce(
      new Error("synthetic render failure")
    );

    await expect(
      ensureStage2HandoverPdf(
        harness.service,
        "work-order-1",
        harness.currentManifestHash
      )
    ).rejects.toThrow("synthetic render failure");

    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
    expect(harness.prisma.contract.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.fileObject.create).not.toHaveBeenCalled();
    expect(harness.records.handover.handoverContractId).toBeNull();
  });

  it("retries with the reserved template and render identity after the active template changes", async () => {
    const harness = createServiceHarness();
    harness.renderer.renderToFile.mockRejectedValueOnce(
      new Error("synthetic first render failure")
    );

    await expect(
      ensureStage2HandoverPdf(
        harness.service,
        "work-order-1",
        harness.currentManifestHash
      )
    ).rejects.toThrow("synthetic first render failure");
    const firstRenderModel = harness.renderer.renderToFile.mock.calls[0]?.[0] as
      { documentNo: string; generatedAt: string; templateVersion: string };

    Object.assign(harness.records.template, {
      id: "template-handover-v2",
      status: ContractVersionStatus.INACTIVE,
      templateName: "车辆交接确认单新版",
      versionNo: "V2.0"
    });

    await expect(
      ensureStage2HandoverPdf(
        harness.service,
        "work-order-1",
        harness.currentManifestHash
      )
    ).resolves.toMatchObject({ status: "GENERATED" });
    const retryRenderModel = harness.renderer.renderToFile.mock.calls[1]?.[0] as
      { documentNo: string; generatedAt: string; templateVersion: string };

    expect(retryRenderModel.documentNo).toBe(firstRenderModel.documentNo);
    expect(retryRenderModel.generatedAt).toBe(firstRenderModel.generatedAt);
    expect(retryRenderModel.templateVersion).toBe("V1.0");
    expect(harness.prisma.contract.create).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the current manifest differs from the queued hash", async () => {
    const harness = createServiceHarness();

    await expect(
      ensureStage2HandoverPdf(
        harness.service,
        "work-order-1",
        `sha256:${"f".repeat(64)}`
      )
    ).rejects.toThrow("queued manifest");

    expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath)
      .not.toHaveBeenCalled();
    expect(harness.workflowJobs).toEqual([]);
  });

  it("enqueues one NOTIFY_FIELD_ESIGN_READY job in the artifact transaction", async () => {
    const harness = createServiceHarness();

    await ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash
    );

    expect(harness.workflowJobs).toHaveLength(1);
    expect(harness.workflowJobs[0]).toMatchObject({
      handoverId: "handover-1",
      idempotencyKey: "field-notify:work-order-1:2",
      jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
      jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
      payload: {
        artifactVersion: 2,
        manifestHash: harness.currentManifestHash,
        sourcePdfHash: createHash("sha256")
          .update(harness.generatedPdfBuffer)
          .digest("hex")
      },
      workOrderId: "work-order-1"
    });
    expect(harness.workflowEnqueueObservedArtifact).toEqual({
      artifactVersion: 2,
      handoverContractId: "contract-stage2-1",
      sourceDocumentFileId: "file-pdf-1"
    });
  });

  it("does not finalize or enqueue when the PDF worker lease is lost", async () => {
    const harness = createServiceHarness();
    harness.prisma.$executeRaw.mockResolvedValueOnce(0);

    await expect(
      ensureStage2HandoverPdf(
        harness.service,
        "work-order-1",
        harness.currentManifestHash,
        {
          assertLease: vi.fn(async () => undefined),
          jobId: "workflow-job-pdf",
          leaseMs: 120_000,
          leaseToken: "lease-token-pdf"
        }
      )
    ).rejects.toThrow("LEASE_LOST");

    expect(harness.prisma.vehicleDeliveryHandover.update)
      .not.toHaveBeenCalled();
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
    expect(harness.prisma.contract.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.fileObject.create).not.toHaveBeenCalled();
    expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath)
      .not.toHaveBeenCalled();
    expect(harness.workflowJobs).toEqual([]);
  });

  it("keeps the finalized bytes intact when a stale upload completes after its replacement", async () => {
    const harness = createServiceHarness();
    const stalePdf = Buffer.from("%PDF-stale-worker-output");
    const winnerPdf = Buffer.from("%PDF-replacement-output");
    const staleUploadEntered = deferred<void>();
    const releaseStaleUpload = deferred<void>();
    const storedObjects = new Map<string, Buffer>();
    harness.renderer.renderToFile
      .mockImplementationOnce(() => renderPdfFile(stalePdf))
      .mockImplementationOnce(() => renderPdfFile(winnerPdf));
    harness.storageService.putGeneratedContractPdfArtifactFromPath
      .mockImplementation(async (input: {
        contentType: "application/pdf";
        filePath: string;
        objectKey: string;
        originalName: string;
        sizeBytes: number;
      }) => {
        const bytes = await readFile(input.filePath);
        if (bytes.equals(stalePdf)) {
          staleUploadEntered.resolve();
          await releaseStaleUpload.promise;
        }
        storedObjects.set(input.objectKey, bytes);
        return {
          bucket: "application-materials",
          contentType: input.contentType,
          objectKey: input.objectKey,
          originalName: input.originalName,
          sizeBytes: input.sizeBytes,
          stored: {
            driver: "local",
            key: `application-materials/${input.objectKey}`
          }
        };
      });

    let staleLeaseChecks = 0;
    const stale = ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash,
      {
        assertLease: vi.fn(async () => {
          staleLeaseChecks += 1;
          if (staleLeaseChecks >= 3) {
            throw new Error("STAGE2_HANDOVER_WORKFLOW_LEASE_LOST");
          }
        }),
        jobId: "workflow-job-stale",
        leaseMs: 120_000,
        leaseToken: "lease-token-stale"
      }
    );
    await staleUploadEntered.promise;

    const winner = await ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash,
      {
        assertLease: vi.fn(async () => undefined),
        jobId: "workflow-job-winner",
        leaseMs: 120_000,
        leaseToken: "lease-token-winner"
      }
    );
    releaseStaleUpload.resolve();
    await expect(stale).rejects.toThrow("LEASE_LOST");

    const winnerObjectKey = String(harness.records.handover.sourceObjectKey);
    const winnerBytes = storedObjects.get(winnerObjectKey);
    expect(winner.status).toBe("GENERATED");
    expect(winnerBytes).toBeDefined();
    expect(
      createHash("sha256").update(winnerBytes!).digest("hex")
    ).toBe(
      (harness.records.handover as Record<string, unknown>).sourcePdfHash
    );
  });

  it("blocks regeneration after the source PDF has been linked", async () => {
    const harness = createServiceHarness({
      handover: {
        handoverContractId: "existing-contract",
        sourceDocumentFileId: "existing-file"
      }
    });

    await expect(
      harness.service.generateStage2HandoverPdf("work-order-1", "admin-1")
    ).rejects.toThrow("artifact binding is invalid");
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath).not.toHaveBeenCalled();
  });

  it("reuses the deterministic source when another request wins the handover claim", async () => {
    const harness = createServiceHarness();
    harness.prisma.vehicleDeliveryHandover.updateMany.mockImplementationOnce(
      async ({ data }) => {
        Object.assign(harness.records.handover, data);
        return { count: 0 };
      }
    );

    await expect(
      harness.service.generateStage2HandoverPdf("work-order-1", "admin-1")
    ).resolves.toMatchObject({
      artifactId: "file-pdf-1",
      status: "GENERATED"
    });

    expect(harness.storageService.deleteObject).not.toHaveBeenCalled();
  });

  it("rejects evidence derivatives predicted to exceed the 15 MiB target before rendering", async () => {
    const harness = createServiceHarness({ derivativeSizeBytes: 1024 * 1024 });

    await expect(
      harness.service.generateStage2HandoverPdf("work-order-1", "admin-1")
    ).rejects.toThrow("15 MiB");

    expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
    expect(harness.storageService.putGeneratedContractPdfArtifactFromPath).not.toHaveBeenCalled();
  });

  it("downloads the generated PDF through FileObject storage without exposing object keys", async () => {
    const harness = createServiceHarness({
      handover: {
        sourceDocumentFileId: "file-pdf-1"
      }
    });

    const downloaded = await harness.service.downloadStage2HandoverPdf("work-order-1");

    expect(downloaded.filename).toBe("handover.pdf");
    expect(downloaded.mimeType).toBe("application/pdf");
    expect(harness.storageService.getObject).toHaveBeenCalledWith(
      "application-materials",
      "contracts/contract-stage2-1/generated/handover.pdf"
    );
    expect(downloaded).not.toHaveProperty("objectKey");
  });

  it("keeps a schema-v1 generated PDF downloadable as historical read-only evidence", async () => {
    const harness = createServiceHarness({
      handover: { sourceDocumentFileId: "file-pdf-1" }
    });
    Object.assign(harness.records.workOrder, {
      accessoryItems: null,
      handoverFactHash: null,
      handoverFactRevision: 0,
      keyState: null,
      primaryKeyCount: null,
      registrationDocumentState: null,
      spareKeyCount: null,
      vehicleConditionConfirmed: null
    });
    const contractSnapshot = harness.records.handover.handoverContract
      .contractSnapshot as Record<string, unknown>;
    contractSnapshot.evidencePackage = {
      manifest: { schemaVersion: 1 },
      manifestHash: harness.currentManifestHash
    };

    await expect(
      harness.service.downloadStage2HandoverPdf("work-order-1")
    ).resolves.toMatchObject({ filename: "handover.pdf" });
  });

  it("downloads the authoritative archived signed PDF through its linked FileObject", async () => {
    const harness = createServiceHarness({
      handover: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        signedDocumentFileId: "file-signed-pdf-1",
        signedObjectKey: "contracts/contract-stage2-1/signed/handover.pdf",
        signedPdfHash: "a".repeat(64),
        status: DeliveryHandoverStatus.ARCHIVED
      }
    });

    const downloaded = await harness.service.downloadStage2SignedHandoverPdf(
      "work-order-1"
    );

    expect(downloaded.filename).toBe("handover-signed.pdf");
    expect(downloaded.mimeType).toBe("application/pdf");
    expect(harness.storageService.getObject).toHaveBeenCalledWith(
      "application-materials",
      "contracts/contract-stage2-1/signed/handover.pdf"
    );
    expect(downloaded).not.toHaveProperty("objectKey");
  });

  it("pins the signed PDF response MIME type to the verified FileObject", async () => {
    const harness = createServiceHarness({
      handover: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        signedDocumentFileId: "file-signed-pdf-1",
        signedObjectKey: "contracts/contract-stage2-1/signed/handover.pdf",
        signedPdfHash: "a".repeat(64),
        status: DeliveryHandoverStatus.ARCHIVED
      }
    });
    harness.storageService.getObject.mockResolvedValueOnce({
      contentLength: harness.generatedPdfBuffer.length,
      contentType: "image/png",
      stream: Readable.from([harness.generatedPdfBuffer])
    });

    await expect(
      harness.service.downloadStage2SignedHandoverPdf("work-order-1")
    ).resolves.toMatchObject({ mimeType: "application/pdf" });
  });

  it("refuses the signed PDF download until the typed Stage 2 archive is complete", async () => {
    const harness = createServiceHarness({
      handover: {
        archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
        signedDocumentFileId: "file-signed-pdf-1",
        signedObjectKey: "contracts/contract-stage2-1/signed/handover.pdf",
        signedPdfHash: "a".repeat(64),
        status: DeliveryHandoverStatus.SIGNED
      }
    });

    await expect(
      harness.service.downloadStage2SignedHandoverPdf("work-order-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_SIGNED_DOCUMENT_NOT_ARCHIVED"
      })
    });
    expect(harness.storageService.getObject).not.toHaveBeenCalled();
  });

  it("refuses the signed PDF when its linked FileObject has a different object key", async () => {
    const harness = createServiceHarness({
      handover: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        signedDocumentFileId: "file-signed-pdf-1",
        signedObjectKey: "contracts/contract-stage2-1/signed/handover.pdf",
        signedPdfHash: "a".repeat(64),
        status: DeliveryHandoverStatus.ARCHIVED
      }
    });
    harness.records.signedFileObject.objectKey =
      "contracts/contract-stage2-1/signed/other.pdf";

    await expect(
      harness.service.downloadStage2SignedHandoverPdf("work-order-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_SIGNED_DOCUMENT_MISSING"
      })
    });
    expect(harness.storageService.getObject).not.toHaveBeenCalled();
  });

  it("refuses the signed PDF when its linked FileObject is not a PDF", async () => {
    const harness = createServiceHarness({
      handover: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        signedDocumentFileId: "file-signed-pdf-1",
        signedObjectKey: "contracts/contract-stage2-1/signed/handover.pdf",
        signedPdfHash: "a".repeat(64),
        status: DeliveryHandoverStatus.ARCHIVED
      }
    });
    harness.records.signedFileObject.mimeType = "image/png";

    await expect(
      harness.service.downloadStage2SignedHandoverPdf("work-order-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_SIGNED_DOCUMENT_MISSING"
      })
    });
    expect(harness.storageService.getObject).not.toHaveBeenCalled();
  });

  it("refuses to download a generated PDF after its manifest hash becomes stale", async () => {
    const harness = createServiceHarness({
      handover: {
        handoverContract: {
          contractSnapshot: {
            evidencePackage: { manifestHash: `sha256:${"f".repeat(64)}` }
          }
        },
        sourceDocumentFileId: "file-pdf-1"
      }
    });

    await expect(harness.service.downloadStage2HandoverPdf("work-order-1"))
      .rejects.toThrow("源 PDF 已因证据变化失效");
    expect(harness.storageService.getObject).not.toHaveBeenCalled();
  });
});

describe("HandoverWorkOrderAdminController signed Stage 2 PDF download", () => {
  const handler =
    HandoverWorkOrderAdminController.prototype.downloadStage2SignedDocument;
  const controllerClass = HandoverWorkOrderAdminController;

  it("streams the verified signed PDF for a DELIVERY_VIEW user", async () => {
    const stream = Readable.from([Buffer.from("%PDF-signed")]);
    const handoverService = {
      downloadStage2SignedHandoverPdf: vi.fn(async () => ({
        filename: "handover-signed.pdf",
        mimeType: "application/pdf",
        sizeBytes: 11,
        stream
      }))
    };
    const controller = new HandoverWorkOrderAdminController(
      handoverService as never,
      {} as never,
      {} as never,
      {} as never
    );
    const response = { setHeader: vi.fn() };
    const guard = new PermissionsGuard(new Reflector());

    const result = await executeStage2SignedDocumentRoute(
      guard,
      controller,
      [PermissionCode.DELIVERY_VIEW],
      response as never
    );

    expect(handoverService.downloadStage2SignedHandoverPdf).toHaveBeenCalledWith(
      "work-order-1"
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/pdf"
    );
    expect(response.setHeader).toHaveBeenCalledWith("Content-Length", "11");
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      "attachment; filename*=UTF-8''handover-signed.pdf"
    );
    expect((result as unknown as { getStream(): Readable }).getStream()).toBe(
      stream
    );
  });

  it("denies the signed PDF route before invoking the download service without DELIVERY_VIEW", () => {
    const handoverService = {
      downloadStage2SignedHandoverPdf: vi.fn()
    };
    const controller = new HandoverWorkOrderAdminController(
      handoverService as never,
      {} as never,
      {} as never,
      {} as never
    );
    const guard = new PermissionsGuard(new Reflector());

    expect(() =>
      executeStage2SignedDocumentRoute(guard, controller, [], {
        setHeader: vi.fn()
      } as never)
    ).toThrow(ForbiddenException);
    expect(handoverService.downloadStage2SignedHandoverPdf).not.toHaveBeenCalled();
  });

  function executeStage2SignedDocumentRoute(
    guard: PermissionsGuard,
    controller: HandoverWorkOrderAdminController,
    permissions: PermissionCode[],
    response: never
  ) {
    guard.canActivate(stage2SignedDocumentContext(permissions));
    return controller.downloadStage2SignedDocument("work-order-1", response);
  }

  function stage2SignedDocumentContext(permissions: PermissionCode[]) {
    return {
      getClass: () => controllerClass,
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({ user: { permissions } })
      })
    } as never;
  }
});

function deferred<T>() {
  let resolve!: (value?: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value as T);
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function renderPdfFile(buffer: Buffer) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stage2-handover-test-")
  );
  const filePath = path.join(directory, "handover.pdf");
  await writeFile(filePath, buffer);
  return {
    cleanup: vi.fn(async () => rm(directory, { force: true, recursive: true })),
    contentType: "application/pdf" as const,
    diagnostics: {
      evidenceFileCount: 14,
      evidenceItemCount: STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT,
      hasCustomerSignatureArea: true,
      hasEvidenceSummary: true,
      hasPlatformSealArea: true,
      pageCount: 10,
      photoCount: 13,
      targetBytesExceeded: false,
      videoCount: 1
    },
    fileName: "handover.pdf",
    filePath,
    sizeBytes: buffer.length,
    slotCoordinates: stage2ArtifactCoordinates()
  };
}

function createRenderModelInput() {
  const generatedAt = new Date("2026-07-25T10:00:00.000Z");
  const evidenceTypes = [
    "CUSTOMER_WITH_VEHICLE_FRONT",
    "VEHICLE_FRONT",
    "VEHICLE_REAR",
    "VIN_OR_FRAME_NUMBER",
    "ODOMETER_DASHBOARD",
    "INTERIOR_REAR",
    "INTERIOR_FRONT",
    "WALKAROUND_VIDEO",
    "WHEEL_CLOSEUP_FRONT_LEFT",
    "WHEEL_CLOSEUP_FRONT_RIGHT",
    "WHEEL_CLOSEUP_REAR_LEFT",
    "WHEEL_CLOSEUP_REAR_RIGHT",
    "DAMAGE_STATIC_CLOSEUP",
    "NO_VISIBLE_DAMAGE_DECLARATION"
  ];
  return {
    documentNo: "HDV-STAGE2-PDF-001",
    evidenceChecklist: {
      items: Array.from({ length: STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT }, (_, index) => ({
        evidenceType: evidenceTypes[index],
        fileRequired: index !== 13,
        files: [
          {
            file: {
              id: `file-${index + 1}`,
              mimeType: index === 7 ? "video/mp4" : "image/jpeg",
              objectKey: `application-materials/delivery-evidence/${index + 1}/front.jpg`,
              originalName: index === 0 ? "front.jpg" : `evidence-${index + 1}.jpg`,
              sizeBytes: 1024 + index
            },
            fileId: `file-${index + 1}`,
          id: `evidence-file-${index + 1}`,
            mediaType: index === 7 ? "VIDEO" : "PHOTO",
            metadata: {
              artifactVersion: 1,
              detectedMimeType: index === 7 ? "video/mp4" : "image/jpeg",
              photoPreviewFileId: index === 7 ? null : `preview-file-${index + 1}`,
              processedAt: generatedAt.toISOString(),
              processingStatus: "READY",
              sourceSha256: `sha256:${String(index + 1).padStart(64, "0")}`,
              sourceSizeBytes: 1024 + index,
              videoDurationMs: index === 7 ? 20_000 : null,
              videoFrameFileIds: index === 7
                ? ["frame-8-1", "frame-8-2", "frame-8-3", "frame-8-4"]
                : []
            },
            objectKey: `application-materials/raw/${index + 1}`,
            uploadedAt: generatedAt
          }
        ],
        id: `item-${index + 1}`,
        isConditional: index >= 12,
        isRequired: index < 12,
        reviewStatus: "APPROVED",
        status: "APPROVED",
        title: index === 0 ? "客户与车辆正面合影" : `证据项 ${index + 1}`
      }))
    },
    generatedAt,
    handover: {
      id: "handover-1",
      stage1ContractNo: "CON-STAGE1-001",
      stage1SignedAt: new Date("2026-07-20T12:00:00.000Z")
    },
    order: {
      customer: {
        identity: {
          idCardNo: "110101199001015678"
        },
        mobile: "13812345678",
        name: "张三",
        registeredAddress: "上海市浦东新区"
      },
      id: "order-1",
      orderNo: "ORD-001",
      vehicle: {
        brand: "小鹏",
        model: "G6",
        plateNo: "沪A12345",
        vin: "LTESTVIN123456789"
      }
    },
    platform: {
      legalName: "测试汽车订阅服务有限公司"
    },
    template: {
      templateName: "车辆交接确认单",
      versionNo: "V1.0"
    },
    workOrder: {
      accessoryChecklist: ["行驶证", "钥匙", "随车工具"],
      accessoryItems: [
        { code: "CHARGING_CABLE", name: "充电线", quantity: 1, state: "PRESENT" }
      ],
      customerConfirmedAt: new Date("2026-07-24T09:00:00.000Z"),
      damageDeclared: false,
      deliveryLocation: "上海虹桥交付中心",
      energyLevelText: "电量 88%",
      externalOperatorName: "李交付",
      externalOperatorPhone: "13900001111",
      fieldNotes: "车辆外观检查无异常。",
      fieldSubmittedAt: new Date("2026-07-24T08:30:00.000Z"),
      fuelLevelText: null,
      handoverMileageKm: 1288,
      handoverFactRevision: 1,
      id: "work-order-1",
      keyState: "COMPLETE",
      noVisibleDamageDeclared: true,
      primaryKeyCount: 1,
      registrationDocumentState: "HANDED_OVER",
      scheduledAt: new Date("2026-07-24T08:00:00.000Z"),
      spareKeyCount: 1,
      status: "CUSTOMER_CONFIRMED",
      vehicleConditionConfirmed: true,
      vehicleConditionRemarks: "车况已现场确认"
    }
  };
}

function createServiceHarness(options: {
  derivativeSizeBytes?: number;
  handover?: Partial<Record<string, unknown>>;
} = {}) {
  const generatedPdfBuffer = Buffer.from("%PDF-stage2-output");
  const currentManifestHash = buildDeliveryHandoverPdfRenderModel(
    createRenderModelInput()
  ).evidencePackage.manifestHash;
  const derivativeIds = createRenderModelInput().evidenceChecklist.items.flatMap((item) => {
    const metadata = item.files[0]!.metadata;
    return metadata.photoPreviewFileId
      ? [metadata.photoPreviewFileId]
      : metadata.videoFrameFileIds;
  });
  const records = {
    contract: {
      contractNo: "CON-STAGE1-001",
      id: "contract-stage1-1",
      signedAt: new Date("2026-07-20T12:00:00.000Z"),
      status: ContractStatus.SIGNED
    },
    fileObject: {
      bucket: "application-materials",
      id: "file-pdf-1",
      mimeType: "application/pdf",
      objectKey: "contracts/contract-stage2-1/generated/handover.pdf",
      originalName: "handover.pdf",
      sizeBytes: BigInt(generatedPdfBuffer.length)
    },
    signedFileObject: {
      bucket: "application-materials",
      id: "file-signed-pdf-1",
      mimeType: "application/pdf",
      objectKey: "contracts/contract-stage2-1/signed/handover.pdf",
      originalName: "handover-signed.pdf",
      sizeBytes: BigInt(generatedPdfBuffer.length)
    },
    derivativeFileObjects: derivativeIds.map((id) => ({
      bucket: "application-materials",
      id,
      mimeType: "image/jpeg",
      objectKey: `delivery-evidence/work-order-1/derivatives/${id}.jpg`,
      originalName: `${id}.jpg`,
      sizeBytes: BigInt(options.derivativeSizeBytes ?? 1024)
    })),
    handover: {
      deletedAt: null,
      handoverContractId: null,
      handoverESignTaskId: null,
      handoverContract: {
        contractSnapshot: {
          evidencePackage: { manifestHash: currentManifestHash }
        }
      },
      id: "handover-1",
      orderId: "order-1",
      sourceDocumentFileId: null,
      sourceObjectKey: null,
      stage1ContractId: "contract-stage1-1",
      stage1Contract: {
        contractNo: "CON-STAGE1-001",
        id: "contract-stage1-1",
        signedAt: new Date("2026-07-20T12:00:00.000Z"),
        status: ContractStatus.SIGNED
      },
      status: DeliveryHandoverStatus.DRAFT,
      ...options.handover
    },
    order: {
      customer: {
        id: "customer-1",
        idNumber: "110101199001015678",
        mobile: "13812345678",
        name: "张三",
        registeredAddress: "上海市浦东新区"
      },
      customerId: "customer-1",
      deletedAt: null,
      id: "order-1",
      orderNo: "ORD-001",
      vehicle: {
        brand: "小鹏",
        model: "G6",
        plateNo: "沪A12345",
        vin: "LTESTVIN123456789"
      }
    },
    template: {
      businessType: BusinessType.SUBSCRIPTION,
      contentTemplate: "车辆交接确认单模板",
      id: "template-handover-v1",
      status: ContractVersionStatus.ACTIVE,
      templateName: "车辆交接确认单",
      templateType: ContractTemplateType.DELIVERY_HANDOVER,
      versionNo: "V1.0"
    },
    workOrder: {
      accessoryChecklist: ["行驶证", "钥匙", "随车工具"],
      accessoryItems: [
        { code: "CHARGING_CABLE", name: "充电线", quantity: 1, state: "PRESENT" }
      ],
      customerConfirmedAt: new Date("2026-07-24T09:00:00.000Z"),
      damageDeclared: false,
      deliveryLocation: "上海虹桥交付中心",
      energyLevelText: "电量 88%",
      fieldSubmittedAt: new Date("2026-07-24T08:30:00.000Z"),
      fuelLevelText: null,
      handoverId: "handover-1",
      handoverMileageKm: 1288,
      handoverFactRevision: 1,
      id: "work-order-1",
      keyState: "COMPLETE",
      noVisibleDamageDeclared: true,
      orderId: "order-1",
      primaryKeyCount: 1,
      registrationDocumentState: "HANDED_OVER",
      scheduledAt: new Date("2026-07-24T08:00:00.000Z"),
      spareKeyCount: 1,
      status: "CUSTOMER_CONFIRMED",
      vehicleConditionConfirmed: true,
      vehicleConditionRemarks: "车况已现场确认"
    }
  };
  const workflowJobs: Array<Record<string, unknown>> = [];
  let workflowEnqueueObservedArtifact: null | Record<string, unknown> = null;
  let persistedStage2Contract: null | Record<string, unknown> = null;
  const templatesById = new Map([
    [records.template.id, { ...records.template }]
  ]);

  const prisma = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join(" ") ?? "";
      if (sql.includes('AS "availableAt"')) {
        return [{ availableAt: new Date("2026-07-25T10:00:00.000Z") }];
      }
      if (sql.includes("SELECT now()")) {
        return [{ now: new Date("2026-07-25T10:00:00.000Z") }];
      }
      return [records.handover];
    }),
    contract: {
      create: vi.fn(async ({ data }) => {
        const created = {
          ...data,
          createdAt: new Date("2026-07-25T10:00:00.000Z"),
          id: "contract-stage2-1",
          updatedAt: new Date("2026-07-25T10:00:00.000Z")
        };
        records.handover.handoverContract = created;
        return created;
      }),
      delete: vi.fn(async () => {
        const deleted = persistedStage2Contract;
        persistedStage2Contract = null;
        return deleted;
      }),
      findUnique: vi.fn(async ({ where }) => {
        if (persistedStage2Contract?.id === where.id) {
          return persistedStage2Contract;
        }
        return records.handover.handoverContractId === where.id
          ? records.handover.handoverContract
          : null;
      }),
      upsert: vi.fn(async ({ create, update }) => {
        if (!persistedStage2Contract) {
          persistedStage2Contract = await prisma.contract.create({
            data: create
          });
        } else {
          Object.assign(persistedStage2Contract, update);
          records.handover.handoverContract = persistedStage2Contract as never;
        }
        return persistedStage2Contract;
      }),
      update: vi.fn(async ({ data }) => {
        Object.assign(records.handover.handoverContract, data);
        return records.handover.handoverContract;
      })
    },
    contractESignTask: {
      create: vi.fn(async () => ({}))
    },
    contractVersion: {
      findFirst: vi.fn(async ({ where }: {
        where?: { id?: string };
      } = {}) =>
        where?.id
          ? templatesById.get(where.id) ?? null
          : records.template.status === ContractVersionStatus.ACTIVE
            ? records.template
            : null
      )
    },
    fileObject: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: {
        data: Record<string, unknown>;
      }) => {
        Object.assign(records.fileObject, data, { id: "file-pdf-1" });
        return records.fileObject;
      }),
      findMany: vi.fn(async ({ where }) =>
        records.derivativeFileObjects.filter((fileObject) => where.id.in.includes(fileObject.id))
      ),
      findUnique: vi.fn(async ({ where }) =>
        where.id === "file-pdf-1"
          ? records.fileObject
          : where.id === "file-signed-pdf-1"
            ? records.signedFileObject
            : null
      ),
      upsert: vi.fn(async ({ create }) => prisma.fileObject.create({ data: create }))
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => records.order),
      update: vi.fn(async () => ({}))
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => records.handover),
      update: vi.fn(async ({ data }) => {
        Object.assign(records.handover, data);
        return records.handover;
      }),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(records.handover, data);
        return { count: 1 };
      })
    },
    vehicleHandoverWorkflowJob: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async ({ create, where }) => {
        const existing = workflowJobs.find(
          (job) => job.idempotencyKey === where.idempotencyKey
        );
        if (existing) {
          return existing;
        }
        workflowEnqueueObservedArtifact = {
          artifactVersion: (records.handover as Record<string, unknown>)
            .artifactVersion,
          handoverContractId: records.handover.handoverContractId,
          sourceDocumentFileId: records.handover.sourceDocumentFileId
        };
        const job = {
          ...create,
          id: `workflow-job-${workflowJobs.length + 1}`,
          jobStatus: VehicleHandoverWorkflowJobStatus.PENDING
        };
        workflowJobs.push(job);
        return job;
      })
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async () => records.workOrder)
    }
  };
  const transaction = vi.fn(
    async (
      callback: (transaction: typeof prisma) => Promise<unknown>
    ) => callback(prisma)
  );
  Object.assign(prisma, {
    $transaction: transaction
  });

  const deliveryEvidenceService = {
    assertFieldEvidenceComplete: vi.fn(async () => undefined),
    getChecklist: vi.fn(async () => createRenderModelInput().evidenceChecklist)
  };
  const renderer = {
    renderToFile: vi.fn(async (renderModel: unknown) => {
      void renderModel;
      const directory = await mkdtemp(path.join(os.tmpdir(), "stage2-handover-test-"));
      const filePath = path.join(directory, "handover.pdf");
      await writeFile(filePath, generatedPdfBuffer);
      return {
        cleanup: vi.fn(async () => rm(directory, { force: true, recursive: true })),
        contentType: "application/pdf",
        diagnostics: {
          evidenceFileCount: 14,
          evidenceItemCount: STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT,
          hasCustomerSignatureArea: true,
          hasEvidenceSummary: true,
          hasPlatformSealArea: true,
          pageCount: 10,
          photoCount: 13,
          targetBytesExceeded: false,
          videoCount: 1
        },
        fileName: "handover.pdf",
        filePath,
        sizeBytes: generatedPdfBuffer.length,
        slotCoordinates: stage2ArtifactCoordinates()
      };
    })
  };
  const storageService = {
    deleteObject: vi.fn(async () => undefined),
    getObject: vi.fn(async () => ({
      contentLength: generatedPdfBuffer.length,
      contentType: "application/pdf",
      stream: Readable.from([generatedPdfBuffer])
    })),
    putGeneratedContractPdfArtifact: vi.fn(async () => ({
      bucket: "application-materials",
      contentType: "application/pdf",
      objectKey: "contracts/contract-stage2-1/generated/handover.pdf",
      originalName: "handover.pdf",
      sizeBytes: generatedPdfBuffer.length,
      stored: { driver: "local", key: "application-materials/contracts/contract-stage2-1/generated/handover.pdf" }
    })),
    putGeneratedContractPdfArtifactFromPath: vi.fn(async (input: {
      contentType: "application/pdf";
      filePath: string;
      objectKey: string;
      originalName: string;
      sizeBytes: number;
    }) => ({
      bucket: "application-materials",
      contentType: input.contentType,
      objectKey: input.objectKey,
      originalName: input.originalName,
      sizeBytes: input.sizeBytes,
      stored: {
        driver: "local",
        key: `application-materials/${input.objectKey}`
      }
    }))
  };
  const workflowRepository = new Stage2HandoverWorkflowRepository(
    prisma as never
  );

  return {
    currentManifestHash,
    generatedPdfBuffer,
    prisma,
    records,
    renderer,
    service: new HandoverWorkOrderService(
      prisma as never,
      deliveryEvidenceService as never,
      undefined,
      storageService as never,
      renderer as never,
      new ConfigService({
        CONTRACT_PDF_CJK_FONT_PATH: process.execPath,
        STAGE2_HANDOVER_PUBLIC_WEB_BASE_URL: "https://portal.example.test"
      }),
      undefined,
      workflowRepository
    ),
    storageService,
    transaction,
    get workflowEnqueueObservedArtifact() {
      return workflowEnqueueObservedArtifact;
    },
    workflowJobs
  };
}

const LEGACY_STAGE2_CONTRACT_NUMBER_COLLISION = [
  {
    legacyContractNo: "HDV20260725100000DM3S",
    manifestHash:
      "sha256:c4465dd5ffcdc94647571897fe415a84e71b5b7ac416968eaf4cdedc23ab6120",
    workOrderId: "00000000-0000-4000-8000-0000000005cc"
  },
  {
    legacyContractNo: "HDV20260725100000DM3S",
    manifestHash:
      "sha256:6fad20112c5eaa2be0173b6294f92eaa56ab6634a5484634c3886e6ade637c9e",
    workOrderId: "00000000-0000-4000-8000-000000000da6"
  }
] as const;

function ensureStage2HandoverPdf(
  service: HandoverWorkOrderService,
  workOrderId: string,
  expectedManifestHash: string,
  lease?: {
    assertLease(): Promise<void>;
    jobId: string;
    leaseMs: number;
    leaseToken: string;
  }
) {
  return (
    service as HandoverWorkOrderService & {
      ensureStage2HandoverPdf(
        id: string,
        manifestHash: string,
        options?: { lease?: typeof lease }
      ): ReturnType<HandoverWorkOrderService["generateStage2HandoverPdf"]>;
    }
  ).ensureStage2HandoverPdf(
    workOrderId,
    expectedManifestHash,
    lease ? { lease } : undefined
  );
}

function linkCompleteSourceArtifact(
  harness: ReturnType<typeof createServiceHarness>,
  options: {
    artifactVersion?: number;
    rendererVersion?: number | null;
  } = {}
) {
  const artifactVersion = options.artifactVersion ?? 2;
  const rendererVersion = options.rendererVersion === undefined
    ? 2
    : options.rendererVersion;
  const sourcePdfHash = createHash("sha256")
    .update(harness.generatedPdfBuffer)
    .digest("hex");
  Object.assign(harness.records.handover, {
    artifactVersion,
    handoverContractId: "contract-stage2-1",
    handoverContract: {
      contractNo: "HDV20260725100000ABCD",
      contractSnapshot: {
        evidencePackage: { manifestHash: harness.currentManifestHash },
        fileId: "file-pdf-1",
        handoverId: "handover-1",
        orderId: "order-1",
        stage2HandoverPdfArtifact: {
          artifactKind: "stage2-handover-pdf-source",
          artifactVersion,
          documentType: "DELIVERY_HANDOVER",
          fileId: "file-pdf-1",
          pageCount: 10,
          ...(rendererVersion === null ? {} : { rendererVersion }),
          signingStage: "STAGE2_DELIVERY_HANDOVER",
          slotCoordinates: stage2ArtifactCoordinates(),
          sourcePdfHash
        },
        workOrderId: "work-order-1"
      },
      createdAt: new Date("2026-07-25T10:00:00.000Z"),
      customerId: "customer-1",
      deletedAt: null,
      fileId: "file-pdf-1",
      id: "contract-stage2-1",
      orderId: "order-1",
      status: ContractStatus.GENERATED
    },
    manifestHash: harness.currentManifestHash.replace(/^sha256:/, ""),
    sourceDocumentFileId: "file-pdf-1",
    sourceObjectKey: harness.records.fileObject.objectKey,
    sourcePdfHash,
    status: DeliveryHandoverStatus.SOURCE_GENERATED
  });
}

function stage2ArtifactCoordinates() {
  return [
    {
      coordinateSource: "PDFKIT_RENDERER",
      coordinateSystem: "FADADA_800_1131_TOP_LEFT",
      documentType: "DELIVERY_HANDOVER",
      height: 90,
      pageNumber: 9,
      pdfPageHeight: 841.89,
      pdfPageWidth: 595.28,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      width: 250,
      x: 210,
      y: 980
    },
    {
      coordinateSource: "PDFKIT_RENDERER",
      coordinateSystem: "FADADA_800_1131_TOP_LEFT",
      documentType: "DELIVERY_HANDOVER",
      height: 90,
      pageNumber: 9,
      pdfPageHeight: 841.89,
      pdfPageWidth: 595.28,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      slotId: "STAGE2_HANDOVER_PLATFORM",
      width: 250,
      x: 590,
      y: 980
    }
  ];
}

function currentManifestDigest() {
  return buildDeliveryHandoverPdfRenderModel(
    createRenderModelInput()
  ).evidencePackage.manifestHash.replace(/^sha256:/, "");
}
