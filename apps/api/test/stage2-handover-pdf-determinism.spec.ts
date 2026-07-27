import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DeliveryHandoverPdfRendererService } from "../src/delivery-handover/delivery-handover-pdf-renderer.service";
import { createDeterministicStage2PdfModel } from "./stage2-handover-pdf-real-render.fixture";

describe("Stage 2 handover real PDF determinism", () => {
  it("renders byte-identical PDFs for the same reservation and source binding", async () => {
    const renderer = new DeliveryHandoverPdfRendererService();
    const model = createDeterministicStage2PdfModel();

    const first = await renderer.render(model, renderOptions());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await renderer.render(model, renderOptions());

    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(sha256(second.buffer)).toBe(sha256(first.buffer));
  });

  it("changes the PDF identity when the reserved generation time changes", async () => {
    const renderer = new DeliveryHandoverPdfRendererService();
    const original = await renderer.render(
      createDeterministicStage2PdfModel(),
      renderOptions()
    );
    const changed = await renderer.render(
      createDeterministicStage2PdfModel({
        generatedAt: "2026-07-25T10:00:01.000Z"
      }),
      renderOptions()
    );

    expect(changed.buffer.equals(original.buffer)).toBe(false);
    expect(sha256(changed.buffer)).not.toBe(sha256(original.buffer));
  });
});

function renderOptions() {
  return {
    evidencePackageUrl:
      "https://portal.example.test/portal/handover-reviews/work-order-deterministic-1"
  };
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
