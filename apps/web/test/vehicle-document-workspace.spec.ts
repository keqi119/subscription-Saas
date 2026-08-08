import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  OTHER_INTERNAL_DOCUMENT_TYPES,
  RIGHTS_DOCUMENT_TYPES,
  buildVehicleDocumentBatchFormData,
  canArchiveDocument,
  canArchiveDocumentBatch,
  canDeleteVehicleDocument,
  getActiveBatchFileCount,
  getDocumentBatchFileLimit,
  getOtherInternalDocumentBatches,
  getRightsDocumentCompleteness,
  getRightsDocumentGroups,
  isAdditiveRightsDocumentType,
  isProductReusableDocument,
  type RightsDocumentType,
  type VehicleDocumentBatchView,
  type VehicleDocumentView
} from "../src/lib/vehicle-document-workspace";

const repoRoot = join(__dirname, "..", "..", "..");

describe("vehicle rights document workspace model", () => {
  it("keeps the exact approved eight-type order", () => {
    expect(RIGHTS_DOCUMENT_TYPES).toEqual([
      "VEHICLE_REGISTRATION_CERTIFICATE",
      "VEHICLE_LICENSE",
      "VEHICLE_INSPECTION_REPORT",
      "VEHICLE_PURCHASE_AGREEMENT",
      "MOTOR_VEHICLE_INVOICE",
      "OWNER_IDENTITY_DOCUMENT",
      "VEHICLE_CONFIGURATION_SHEET",
      "PURCHASE_PAYMENT_VOUCHER"
    ]);
  });

  it("counts a multi-file payment batch as one completed category", () => {
    const result = getRightsDocumentCompleteness([
      batchFixture("PURCHASE_PAYMENT_VOUCHER", ["receipt-1", "receipt-2"])
    ]);

    expect(result.completed).toBe(1);
    expect(result.total).toBe(8);
    expect(result.missingTypes).not.toContain("PURCHASE_PAYMENT_VOUCHER");
  });

  it("counts only non-deleted active files toward completeness", () => {
    const archived = batchFixture("VEHICLE_LICENSE", ["archived"]);
    archived.items[0]!.documentStatus = "ARCHIVED";
    const deleted = batchFixture("MOTOR_VEHICLE_INVOICE", ["deleted"]);
    deleted.items[0]!.deletedAt = "2026-08-08T00:00:00.000Z";

    const result = getRightsDocumentCompleteness([archived, deleted]);

    expect(result.completed).toBe(0);
    expect(result.missingTypes).toContain("VEHICLE_LICENSE");
    expect(result.missingTypes).toContain("MOTOR_VEHICLE_INVOICE");
  });

  it.each([
    "VEHICLE_PURCHASE_AGREEMENT",
    "OWNER_IDENTITY_DOCUMENT",
    "PURCHASE_PAYMENT_VOUCHER"
  ] as const)("allows a multi-file %s batch", (documentType) => {
    expect(getDocumentBatchFileLimit(documentType)).toBe(20);
  });

  it("keeps replacement documents single-file and payment vouchers additive", () => {
    expect(getDocumentBatchFileLimit("VEHICLE_CONFIGURATION_SHEET")).toBe(1);
    expect(isAdditiveRightsDocumentType("PURCHASE_PAYMENT_VOUCHER")).toBe(true);
    expect(isAdditiveRightsDocumentType("VEHICLE_PURCHASE_AGREEMENT")).toBe(false);
  });

  it("marks only configuration and inspection images as reusable", () => {
    expect(isProductReusableDocument(imageDoc("VEHICLE_CONFIGURATION_SHEET"))).toBe(true);
    expect(isProductReusableDocument(imageDoc("VEHICLE_INSPECTION_REPORT"))).toBe(true);
    expect(isProductReusableDocument(pdfDoc("VEHICLE_CONFIGURATION_SHEET"))).toBe(false);
    expect(isProductReusableDocument(imageDoc("MOTOR_VEHICLE_INVOICE"))).toBe(false);
  });

  it("groups every rights type in approved order and versions newest first", () => {
    const versionOne = batchFixture("VEHICLE_LICENSE", ["license-front"], 1);
    const versionThree = batchFixture("VEHICLE_LICENSE", ["license-back"], 3);

    const groups = getRightsDocumentGroups([versionOne, versionThree]);

    expect(groups.map((group) => group.documentType)).toEqual(RIGHTS_DOCUMENT_TYPES);
    expect(
      groups
        .find((group) => group.documentType === "VEHICLE_LICENSE")
        ?.batches.map((batch) => batch.versionNo)
    ).toEqual([3, 1]);
    expect(getActiveBatchFileCount(versionThree)).toBe(1);
  });

  it("separates legacy internal materials from completeness", () => {
    expect(OTHER_INTERNAL_DOCUMENT_TYPES).toEqual([
      "INSPECTION_CERTIFICATE",
      "VEHICLE_AUTHORIZATION",
      "OTHER"
    ]);
    const other = OTHER_INTERNAL_DOCUMENT_TYPES.map((type, index) =>
      batchFixture(type, [`legacy-${index}`])
    );

    expect(getOtherInternalDocumentBatches(other).map((batch) => batch.documentType)).toEqual(
      OTHER_INTERNAL_DOCUMENT_TYPES
    );
    expect(getRightsDocumentCompleteness(other).completed).toBe(0);
  });

  it("prevents file or batch archive while an exact source document is bound", () => {
    const batch = batchFixture("VEHICLE_CONFIGURATION_SHEET", ["configuration"]);
    const document = batch.items[0]!;

    expect(canArchiveDocument(document, new Set([document.id]))).toBe(false);
    expect(canArchiveDocumentBatch(batch, new Set([document.id]))).toBe(false);
    expect(canArchiveDocument(document, new Set())).toBe(true);
    expect(canArchiveDocumentBatch(batch, new Set())).toBe(true);
  });

  it("allows deleting only active, unbound rights-document files", () => {
    const batch = batchFixture("VEHICLE_CONFIGURATION_SHEET", ["configuration"]);
    const activeDocument = batch.items[0]!;
    const archivedDocument = documentFixture("VEHICLE_LICENSE", "archived");
    archivedDocument.documentStatus = "ARCHIVED";

    expect(canDeleteVehicleDocument(activeDocument, new Set())).toBe(true);
    expect(canDeleteVehicleDocument(activeDocument, new Set([activeDocument.id]))).toBe(false);
    expect(canDeleteVehicleDocument(archivedDocument, new Set())).toBe(false);
  });

  it("builds one multipart batch with repeated files and no visibility field", () => {
    const formData = buildVehicleDocumentBatchFormData("PURCHASE_PAYMENT_VOUCHER", [
      new File(["receipt-1"], "receipt-1.pdf", { type: "application/pdf" }),
      new File(["receipt-2"], "receipt-2.jpg", { type: "image/jpeg" })
    ]);

    expect(formData.get("documentType")).toBe("PURCHASE_PAYMENT_VOUCHER");
    expect(formData.getAll("files")).toHaveLength(2);
    expect(Array.from(formData.keys())).toEqual(["documentType", "files", "files"]);
  });

  it("does not define a customer visibility field or UI switch", () => {
    const modelSource = readFileSync(
      join(repoRoot, "apps/web/src/lib/vehicle-document-workspace.ts"),
      "utf8"
    );
    const componentSource = readFileSync(
      join(repoRoot, "apps/web/src/components/vehicle-workspace/vehicle-documents-tab.tsx"),
      "utf8"
    );

    expect(modelSource).not.toContain("customerVisible");
    expect(componentSource).not.toContain("customerVisible");
    expect(componentSource).not.toContain("客户可见");
    expect(componentSource).toContain("/document-batches");
    expect(componentSource).toContain("/listing-source-bindings");
    expect(componentSource).toContain("/vehicle-document-batches/");
    expect(componentSource).toContain("删除错误文件");
    expect(componentSource).toContain("/vehicle-documents/${document.id}");
    expect(componentSource).toContain("await Promise.all([loadWorkspace(), onVehicleChanged()])");
  });
});

function batchFixture(
  documentType: string,
  fileIds: string[],
  versionNo = 1
): VehicleDocumentBatchView {
  return {
    createdAt: "2026-08-08T00:00:00.000Z",
    documentType,
    id: `batch-${documentType}-${versionNo}`,
    items: fileIds.map((id) => documentFixture(documentType, id)),
    uploadedBy: "user-1",
    vehicleId: "vehicle-1",
    versionNo
  };
}

function documentFixture(documentType: string, id: string): VehicleDocumentView {
  return {
    createdAt: "2026-08-08T00:00:00.000Z",
    deletedAt: null,
    documentStatus: "ACTIVE",
    documentType,
    fileName: `${id}.jpg`,
    fileSize: 5,
    id,
    mimeType: "image/jpeg",
    originalName: `${id}.jpg`,
    previewUrl: `/api/vehicle-documents/${id}/preview`,
    title: null,
    updatedAt: "2026-08-08T00:00:00.000Z",
    uploadedBy: "user-1",
    vehicleId: "vehicle-1"
  };
}

function imageDoc(documentType: RightsDocumentType) {
  return documentFixture(documentType, "image");
}

function pdfDoc(documentType: RightsDocumentType) {
  return {
    ...documentFixture(documentType, "pdf"),
    fileName: "document.pdf",
    mimeType: "application/pdf",
    originalName: "document.pdf"
  };
}
