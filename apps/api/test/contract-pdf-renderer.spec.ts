import { describe, expect, it } from "vitest";

import {
  CONTRACT_PDF_RENDER_CUSTOMER_SIGNATURE_KEYWORD_MISSING,
  CONTRACT_PDF_RENDER_CJK_FONT_REQUIRED,
  CONTRACT_PDF_RENDER_EMPTY_TEMPLATE,
  CONTRACT_PDF_RENDER_PLATFORM_SEAL_KEYWORD_MISSING,
  CONTRACT_PDF_RENDER_TOO_LARGE,
  ContractPdfRendererService
} from "../src/contract/contract-pdf-renderer.service";
import { ContractPdfRenderModel } from "../src/contract/contract-pdf-render-model";

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
      hasPlatformSealKeyword: true
    });
  });

  it("fails when contentTemplate is empty", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({ contentTemplate: "   " });

    await expect(renderer.render(model, { allowBuiltinFontForAsciiOnlyTests: true }))
      .rejects.toThrow(CONTRACT_PDF_RENDER_EMPTY_TEMPLATE);
  });

  it("fails when platform seal keyword is missing", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({
      signingAnchors: {
        customerSignatureKeyword: "Customer signature",
        platformSealKeyword: ""
      }
    });

    await expect(renderer.render(model, { allowBuiltinFontForAsciiOnlyTests: true }))
      .rejects.toThrow(CONTRACT_PDF_RENDER_PLATFORM_SEAL_KEYWORD_MISSING);
  });

  it("fails when customer signature keyword is missing", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({
      signingAnchors: {
        customerSignatureKeyword: "",
        platformSealKeyword: "Provider seal"
      }
    });

    await expect(renderer.render(model, { allowBuiltinFontForAsciiOnlyTests: true }))
      .rejects.toThrow(CONTRACT_PDF_RENDER_CUSTOMER_SIGNATURE_KEYWORD_MISSING);
  });

  it("fails fast for CJK content without a configured CJK font path", async () => {
    const renderer = new ContractPdfRendererService();
    const model = createAsciiModel({
      contentTemplate: "Synthetic CJK fixture: 服务提供方盖章 / 订阅方盖章/签字",
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

function createAsciiModel(overrides: Partial<ContractPdfRenderModel> = {}): ContractPdfRenderModel {
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
