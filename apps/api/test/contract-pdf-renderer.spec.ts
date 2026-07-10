import { describe, expect, it } from "vitest";

import {
  CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED,
  CONTRACT_PDF_RENDER_EMPTY_TEMPLATE,
  CONTRACT_PDF_RENDER_TOO_LARGE,
  ContractPdfRendererService
} from "../src/contract/contract-pdf-renderer.service";
import { ContractPdfRenderModel, ContractPdfSigningSlot } from "../src/contract/contract-pdf-render-model";

const ASCII_STAGE1_SIGNING_SLOTS: ContractPdfSigningSlot[] = [
  {
    documentType: "CONTRACT_BODY",
    keyword: "Body customer signature slot",
    label: "Customer signature",
    signerRole: "CUSTOMER",
    slotId: "STAGE1_BODY_CUSTOMER",
    stage: "STAGE1_CONTRACT",
    title: "Contract body signing area"
  },
  {
    documentType: "CONTRACT_BODY",
    keyword: "Body platform seal slot",
    label: "Platform seal",
    offsetX: 60,
    offsetY: 0,
    signerRole: "PLATFORM",
    slotId: "STAGE1_BODY_PLATFORM",
    stage: "STAGE1_CONTRACT",
    title: "Contract body signing area"
  },
  {
    documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
    keyword: "Attachment 1 customer signature slot",
    label: "Customer signature",
    signerRole: "CUSTOMER",
    slotId: "STAGE1_ATTACHMENT1_CUSTOMER",
    stage: "STAGE1_CONTRACT",
    title: "Attachment 1 signing area"
  },
  {
    documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
    keyword: "Attachment 1 platform seal slot",
    label: "Platform seal",
    offsetX: 60,
    offsetY: 0,
    signerRole: "PLATFORM",
    slotId: "STAGE1_ATTACHMENT1_PLATFORM",
    stage: "STAGE1_CONTRACT",
    title: "Attachment 1 signing area"
  }
];

const CJK_STAGE1_SIGNING_SLOTS: ContractPdfSigningSlot[] = [
  {
    ...ASCII_STAGE1_SIGNING_SLOTS[0]!,
    keyword: "合同正文-订阅方签字",
    label: "订阅方签字",
    title: "合同正文签署区"
  },
  {
    ...ASCII_STAGE1_SIGNING_SLOTS[1]!,
    keyword: "合同正文-服务提供方盖章",
    label: "服务提供方盖章",
    title: "合同正文签署区"
  },
  {
    ...ASCII_STAGE1_SIGNING_SLOTS[2]!,
    keyword: "附件1订阅方案-订阅方签字",
    label: "订阅方签字",
    title: "附件1订阅方案签署区"
  },
  {
    ...ASCII_STAGE1_SIGNING_SLOTS[3]!,
    keyword: "附件1订阅方案-服务提供方盖章",
    label: "服务提供方盖章",
    title: "附件1订阅方案签署区"
  }
];

describe("ContractPdfRendererService", () => {
  it("renders an ASCII synthetic contract PDF with diagnostics", async () => {
    const renderer = new ContractPdfRendererService();

    const result = await renderer.render(createAsciiModel(), {
      allowBuiltinFontForAsciiOnlyTests: true
    });

    expect(result.contentType).toBe("application/pdf");
    expect(result.fileName).toBe("CON-TEST-001.pdf");
    expect(result.buffer.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(result.diagnostics).toMatchObject({
      hasAppendix: true,
      hasCustomerSignatureKeyword: true,
      hasLegalBody: true,
      hasPlatformSealKeyword: true,
      hasStage1SigningSlots: true,
      stage1SigningSlotOccurrences: {
        STAGE1_ATTACHMENT1_CUSTOMER: 1,
        STAGE1_ATTACHMENT1_PLATFORM: 1,
        STAGE1_BODY_CUSTOMER: 1,
        STAGE1_BODY_PLATFORM: 1
      }
    });
  });

  it("fails when contentTemplate is empty", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({ contentTemplate: "   " });

    await expect(renderer.render(model, { allowBuiltinFontForAsciiOnlyTests: true }))
      .rejects.toThrow(CONTRACT_PDF_RENDER_EMPTY_TEMPLATE);
  });

  it("fails when the Stage 1 body platform slot is missing", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({
      signingSlots: ASCII_STAGE1_SIGNING_SLOTS.filter((slot) => slot.slotId !== "STAGE1_BODY_PLATFORM")
    });

    await expect(renderer.render(model, { allowBuiltinFontForAsciiOnlyTests: true }))
      .rejects.toThrow("CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_MISSING");
  });

  it("fails when the Stage 1 attachment 1 customer slot is missing", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({
      signingSlots: ASCII_STAGE1_SIGNING_SLOTS.filter((slot) => slot.slotId !== "STAGE1_ATTACHMENT1_CUSTOMER")
    });

    await expect(renderer.render(model, { allowBuiltinFontForAsciiOnlyTests: true }))
      .rejects.toThrow("CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_MISSING");
  });

  it("fails when a Stage 1 slot keyword is duplicated in the legal body", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({
      contentTemplate: "Synthetic non-legal body accidentally includes Body customer signature slot."
    });

    await expect(renderer.render(model, { allowBuiltinFontForAsciiOnlyTests: true }))
      .rejects.toThrow("CONTRACT_PDF_RENDER_STAGE1_SIGNING_SLOT_NOT_UNIQUE");
  });

  it("fails fast for CJK content without a configured CJK font path", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({
      contentTemplate: "Synthetic CJK fixture 中文 content for Stage 1 contract PDFs",
      signingSlots: CJK_STAGE1_SIGNING_SLOTS.map((slot) => ({ ...slot })),
      signingAnchors: {
        customerSignatureKeyword: "订阅方盖章/签字",
        platformSealKeyword: "服务提供方盖章"
      }
    });

    await expect(renderer.render(model))
      .rejects.toThrow(CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED);
  });

  it("enforces the maximum PDF byte size", async () => {
    const renderer = new ContractPdfRendererService();

    await expect(renderer.render(createAsciiModel(), {
      allowBuiltinFontForAsciiOnlyTests: true,
      maxBytes: 10
    })).rejects.toThrow(CONTRACT_PDF_RENDER_TOO_LARGE);
  });

  it("does not require DB, storage, or provider dependencies", async () => {
    expect(ContractPdfRendererService.length).toBe(0);

    const renderer = new ContractPdfRendererService();
    const result = await renderer.render(createAsciiModel(), {
      allowBuiltinFontForAsciiOnlyTests: true
    });

    expect(result.buffer.length).toBeGreaterThan(0);
  });
});

function createAsciiModel(
  overrides: Omit<Partial<ContractPdfRenderModel>, "signingSlots"> & {
    signingSlots?: ContractPdfSigningSlot[];
    signingStage?: string;
  } = {}
): ContractPdfRenderModel {
  return {
    appendix: {
      sections: [{
        rows: [
          { label: "Order number", value: "ORD-TEST-001" },
          { label: "Plan", value: "Synthetic monthly plan" }
        ],
        title: "Synthetic order snapshot appendix"
      }]
    },
    contentTemplate: "Synthetic non-legal contract body for renderer tests only.",
    contractId: "contract-test-1",
    contractNo: "CON-TEST-001",
    generatedAt: new Date("2026-07-09T00:00:00.000Z"),
    orderNo: "ORD-TEST-001",
    signingStage: "STAGE1_CONTRACT",
    signingSlots: ASCII_STAGE1_SIGNING_SLOTS.map((slot) => ({ ...slot })),
    signingAnchors: {
      customerSignatureKeyword: "Customer signature",
      platformSealKeyword: "Provider seal",
      platformSealOffsetX: 60,
      platformSealOffsetY: 0
    },
    templateName: "Synthetic Renderer Test Template",
    templateVersion: "V0.TEST",
    ...overrides
  };
}
