import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";

import { DeliveryHandoverPdfRendererService } from "../src/delivery-handover/delivery-handover-pdf-renderer.service";
import { createDeterministicStage2PdfModel } from "./stage2-handover-pdf-real-render.fixture";

interface CapturedPageGeometry {
  pageHeight: number;
  pageMargins: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  };
  pageNumber: number;
  pageWidth: number;
}

interface CapturedBorder extends CapturedPageGeometry {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface CapturedText extends CapturedPageGeometry {
  height: number;
  text: string;
  x: number;
  y: number;
}

type PdfMethod = (
  this: PDFKit.PDFDocument,
  ...args: unknown[]
) => unknown;

describe("Stage 2 handover PDF real PDFKit geometry", () => {
  it("keeps every signing-table border and date row inside the final page when the source page is short", async () => {
    const prototype = PDFDocument.prototype as unknown as Record<
      "addPage" | "rect" | "text",
      PdfMethod
    >;
    const originalAddPage = prototype.addPage;
    const originalRect = prototype.rect;
    const originalText = prototype.text;
    const borders: CapturedBorder[] = [];
    const dateRows: CapturedText[] = [];
    let pageNumber = 0;

    prototype.addPage = function (...args) {
      pageNumber += 1;
      return Reflect.apply(originalAddPage, this, args);
    };
    prototype.rect = function (...args) {
      const [x, y, width, height] = args.map(Number) as [
        number,
        number,
        number,
        number
      ];
      borders.push({
        height,
        ...capturePage(this, pageNumber),
        width,
        x,
        y
      });
      return Reflect.apply(originalRect, this, args);
    };
    prototype.text = function (...args) {
      const text = String(args[0] ?? "");
      if (text.includes("日期")) {
        const x = typeof args[1] === "number" ? args[1] : this.x;
        const y = typeof args[2] === "number" ? args[2] : this.y;
        const options =
          args[3] && typeof args[3] === "object"
            ? (args[3] as PDFKit.Mixins.TextOptions)
            : {};
        dateRows.push({
          height: this.heightOfString(text, options),
          ...capturePage(this, pageNumber),
          text,
          x,
          y
        });
      }
      return Reflect.apply(originalText, this, args);
    };

    try {
      const result = await new DeliveryHandoverPdfRendererService().render(
        createDeterministicStage2PdfModel(),
        {
          evidencePackageUrl:
            "https://portal.example.test/portal/handover-reviews/real-pdfkit",
          pageSize: [595.28, 320]
        }
      );
      const finalPageNumber = Math.max(
        ...borders.map((border) => border.pageNumber)
      );
      const finalPageBorders = borders.filter(
        (border) => border.pageNumber === finalPageNumber
      );
      const finalPageDateRows = dateRows.filter(
        (row) => row.pageNumber === finalPageNumber
      );

      expect(result.buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(result.slotCoordinates.map((slot) => slot.pageNumber)).toEqual([
        finalPageNumber - 1,
        finalPageNumber - 1
      ]);
      expect(finalPageBorders).toHaveLength(12);
      expect(finalPageDateRows).toHaveLength(2);
      expect(finalPageBorders[0]).toMatchObject({
        pageHeight: expect.any(Number),
        pageMargins: {
          bottom: 45,
          left: 45,
          right: 45,
          top: 45
        }
      });
      expect(finalPageBorders[0]!.pageHeight).toBeGreaterThan(320);

      for (const border of finalPageBorders) {
        expectInsidePage(border, border.width, border.height);
      }
      for (const row of finalPageDateRows) {
        expectInsidePage(row, 0, row.height);
      }
    } finally {
      prototype.addPage = originalAddPage;
      prototype.rect = originalRect;
      prototype.text = originalText;
    }
  });
});

function capturePage(
  doc: PDFKit.PDFDocument,
  pageNumber: number
): CapturedPageGeometry {
  return {
    pageHeight: doc.page.height,
    pageMargins: { ...doc.page.margins },
    pageNumber,
    pageWidth: doc.page.width
  };
}

function expectInsidePage(
  item: CapturedPageGeometry & { x: number; y: number },
  width: number,
  height: number
) {
  expect(item.x).toBeGreaterThanOrEqual(item.pageMargins.left);
  expect(item.y).toBeGreaterThanOrEqual(item.pageMargins.top);
  expect(item.x + width).toBeLessThanOrEqual(
    item.pageWidth - item.pageMargins.right
  );
  expect(item.y + height).toBeLessThanOrEqual(
    item.pageHeight - item.pageMargins.bottom
  );
}
