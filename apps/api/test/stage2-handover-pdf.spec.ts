import { Readable } from "node:stream";

import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  DeliveryHandoverStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  buildDeliveryHandoverPdfRenderModel,
  STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT
} from "../src/delivery-handover/delivery-handover-pdf-render-model";
import { DeliveryHandoverPdfRendererService } from "../src/delivery-handover/delivery-handover-pdf-renderer.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";

const pdfKitMock = vi.hoisted(() => {
  class FakePDFDocument {
    static textCalls: Array<{ pageNumber: number; text: string }> = [];

    static startCapture() {
      FakePDFDocument.textCalls = [];
      return { textCalls: FakePDFDocument.textCalls };
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

    addPage() {
      this.pageNumber += 1;
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
      this.emit("data", Buffer.from("%PDF-fake-stage2-output"));
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

    rect() {
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
      FakePDFDocument.textCalls.push({ pageNumber: this.pageNumber, text });
      this.y += this.heightOfString(text);
      return this;
    }
  }

  return { FakePDFDocument };
});

vi.mock("pdfkit", () => ({ default: pdfKitMock.FakePDFDocument }));

describe("Stage 2 handover PDF renderer", () => {
  it("builds a safe handover render model with 14 evidence summary rows and masked customer identifiers", () => {
    const model = buildDeliveryHandoverPdfRenderModel(createRenderModelInput());
    const serialized = JSON.stringify(model);

    expect(model.documentNo).toBe("HDV-STAGE2-PDF-001");
    expect(model.customer.idNumberMasked).toBe("**************5678");
    expect(model.customer.mobileMasked).toBe("138****5678");
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
    const { textCalls } = pdfKitMock.FakePDFDocument.startCapture();

    const result = await renderer.render(buildDeliveryHandoverPdfRenderModel(createRenderModelInput()), {
      cjkFontPath: process.execPath
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
    expect(visibleText).toContain("承租方");
    expect(visibleText).toContain("出租方");
    expect(visibleText).not.toContain("Render Diagnostics");
  });
});

describe("HandoverWorkOrderService Stage 2 PDF generation", () => {
  it("creates a generated handover contract PDF artifact without starting any e-sign task", async () => {
    const harness = createServiceHarness();

    const result = await harness.service.generateStage2HandoverPdf("work-order-1", "admin-1");

    expect(result.status).toBe("GENERATED");
    expect(result.artifactId).toBe("file-pdf-1");
    expect(result.documentNo).toMatch(/^HDV\d{14}[A-Z2-9]{4}$/);
    expect(result.downloadUrl).toBe("/api/handover-work-orders/work-order-1/pdf/download");
    expect(harness.prisma.contract.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessType: BusinessType.SUBSCRIPTION,
        contractVersionId: "template-handover-v1",
        contractTitle: "车辆交接确认单 V1.0",
        customerId: "customer-1",
        orderId: "order-1",
        status: ContractStatus.GENERATED
      })
    });
    expect(harness.storageService.putGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
    expect(harness.prisma.fileObject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bucket: "application-materials",
        mimeType: "application/pdf",
        objectKey: "contracts/contract-stage2-1/generated/handover.pdf",
        originalName: "handover.pdf",
        uploadedBy: "admin-1"
      })
    });
    expect(harness.prisma.vehicleDeliveryHandover.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        handoverContractId: "contract-stage2-1",
        sourceDocumentFileId: "file-pdf-1",
        sourceObjectKey: "contracts/contract-stage2-1/generated/handover.pdf",
        status: DeliveryHandoverStatus.SOURCE_GENERATED,
        updatedBy: "admin-1"
      }),
      where: { id: "handover-1" }
    });
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
  });

  it("blocks regeneration after the source PDF has been linked", async () => {
    const harness = createServiceHarness({
      handover: {
        handoverContractId: "existing-contract",
        sourceDocumentFileId: "existing-file"
      }
    });

    await expect(harness.service.generateStage2HandoverPdf("work-order-1", "admin-1"))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(harness.storageService.putGeneratedContractPdfArtifact).not.toHaveBeenCalled();
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
});

function createRenderModelInput() {
  const generatedAt = new Date("2026-07-25T10:00:00.000Z");
  return {
    documentNo: "HDV-STAGE2-PDF-001",
    evidenceChecklist: {
      items: Array.from({ length: STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT }, (_, index) => ({
        evidenceType: `EVIDENCE_${index + 1}`,
        fileRequired: index !== 13,
        files: [
          {
            file: {
              id: `file-${index + 1}`,
              mimeType: "image/jpeg",
              objectKey: `application-materials/delivery-evidence/${index + 1}/front.jpg`,
              originalName: index === 0 ? "front.jpg" : `evidence-${index + 1}.jpg`,
              sizeBytes: 1024 + index
            },
            fileId: `file-${index + 1}`,
            id: `evidence-file-${index + 1}`,
            mediaType: "PHOTO",
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
        idNumber: "110101199001015678",
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
      id: "work-order-1",
      noVisibleDamageDeclared: true,
      scheduledAt: new Date("2026-07-24T08:00:00.000Z"),
      status: "CUSTOMER_CONFIRMED"
    }
  };
}

function createServiceHarness(options: {
  handover?: Partial<Record<string, unknown>>;
} = {}) {
  const generatedPdfBuffer = Buffer.from("%PDF-stage2-output");
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
    handover: {
      deletedAt: null,
      handoverContractId: null,
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
      customerConfirmedAt: new Date("2026-07-24T09:00:00.000Z"),
      damageDeclared: false,
      deliveryLocation: "上海虹桥交付中心",
      energyLevelText: "电量 88%",
      fieldSubmittedAt: new Date("2026-07-24T08:30:00.000Z"),
      fuelLevelText: null,
      handoverId: "handover-1",
      handoverMileageKm: 1288,
      id: "work-order-1",
      noVisibleDamageDeclared: true,
      orderId: "order-1",
      scheduledAt: new Date("2026-07-24T08:00:00.000Z"),
      status: "CUSTOMER_CONFIRMED"
    }
  };

  const prisma = {
    contract: {
      create: vi.fn(async ({ data }) => ({
        ...data,
        createdAt: new Date("2026-07-25T10:00:00.000Z"),
        id: "contract-stage2-1",
        updatedAt: new Date("2026-07-25T10:00:00.000Z")
      })),
      update: vi.fn(async () => ({}))
    },
    contractESignTask: {
      create: vi.fn(async () => ({}))
    },
    contractVersion: {
      findFirst: vi.fn(async () => records.template)
    },
    fileObject: {
      create: vi.fn(async () => records.fileObject),
      findUnique: vi.fn(async ({ where }) => where.id === "file-pdf-1" ? records.fileObject : null)
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => records.order),
      update: vi.fn(async () => ({}))
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => records.handover),
      update: vi.fn(async () => ({ ...records.handover, sourceDocumentFileId: "file-pdf-1" }))
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async () => records.workOrder)
    }
  };

  const deliveryEvidenceService = {
    assertFieldEvidenceComplete: vi.fn(async () => undefined),
    getChecklist: vi.fn(async () => createRenderModelInput().evidenceChecklist)
  };
  const renderer = {
    render: vi.fn(async () => ({
      buffer: generatedPdfBuffer,
      contentType: "application/pdf",
      diagnostics: {
        evidenceItemCount: STAGE2_HANDOVER_PDF_EVIDENCE_ITEM_COUNT,
        hasCustomerSignatureArea: true,
        hasEvidenceSummary: true,
        hasPlatformSealArea: true
      },
      fileName: "handover.pdf"
    }))
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
    }))
  };

  return {
    prisma,
    service: new HandoverWorkOrderService(
      prisma as never,
      deliveryEvidenceService as never,
      undefined,
      storageService as never,
      renderer as never,
      new ConfigService({ CONTRACT_PDF_CJK_FONT_PATH: process.execPath })
    ),
    storageService
  };
}
