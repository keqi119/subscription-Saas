import {
  DeliveryHandoverPdfEvidenceSummaryItem,
  DeliveryHandoverPdfRenderModel
} from "../src/delivery-handover/delivery-handover-pdf-render-model";

export interface DeterministicStage2PdfIdentity {
  documentNo?: string;
  generatedAt?: string;
  handoverId?: string;
  manifestHash?: string;
  workOrderId?: string;
}

export function createDeterministicStage2PdfModel(
  identity: DeterministicStage2PdfIdentity = {}
): DeliveryHandoverPdfRenderModel {
  return {
    confirmationText: "Customer confirms the bound evidence package.",
    customer: {
      address: "1 Test Road",
      idNumber: "ID-001",
      mobile: "13800000000",
      name: "Test Customer"
    },
    customerReview: {
      confirmedAt: "2026-07-25 09:00:00",
      objectionStatus: "NO_OBJECTION"
    },
    documentNo:
      identity.documentNo ?? "HDV-0123456789abcdef0123456789abcdef",
    evidencePackage: {
      files: [],
      manifestHash: identity.manifestHash ?? `sha256:${"a".repeat(64)}`,
      packageId: identity.handoverId ?? "handover-deterministic-1",
      schemaVersion: 1,
      stats: {
        fileCount: 0,
        photoCount: 0,
        videoCount: 0
      }
    },
    evidenceSummary: {
      itemCount: 14,
      items: evidenceSummaryItems()
    },
    fees: {
      otherFees: "0",
      paidRent: "1000",
      vehicleDeposit: "5000",
      violationDeposit: "0"
    },
    fieldFacts: {
      accessoryChecklistText: "keys, tools",
      damageDescription: "-",
      damageStatus: "NO_VISIBLE_DAMAGE",
      energyLevelText: "80%",
      fieldNotes: "ready",
      fuelLevelText: "-",
      handoverMileageKm: "1200 km"
    },
    generatedAt: identity.generatedAt ?? "2026-07-25T10:00:00.000Z",
    handoverDate: "2026-07-25 08:00:00",
    handoverId: identity.handoverId ?? "handover-deterministic-1",
    handoverPlace: "Test Center",
    operationTips: ["Inspect the vehicle.", "Keep the signed copy."],
    orderNo: "ORD-DETERMINISTIC-1",
    platform: {
      contactName: "Test Operator",
      contactPhone: "13900001111",
      legalName: "Subscription SaaS"
    },
    specialNotices: ["Traffic and damage rules apply."],
    stage1ContractNo: "S1-DETERMINISTIC-1",
    templateName: "Delivery Handover",
    templateVersion: "V1.0",
    vehicle: {
      brandModel: "Test EV",
      plateNo: "TEST-001",
      vin: "LTESTVIN123456789"
    },
    workOrderId: identity.workOrderId ?? "work-order-deterministic-1"
  };
}

function evidenceSummaryItems(): DeliveryHandoverPdfEvidenceSummaryItem[] {
  return Array.from({ length: 14 }, (_, index) => ({
    evidenceType: `EVIDENCE_${index + 1}`,
    fileCount: 0,
    fileRequired: false,
    files: [],
    id: `evidence-${index + 1}`,
    isConditional: false,
    isRequired: true,
    reviewStatus: "APPROVED",
    status: "APPROVED",
    title: `Evidence ${index + 1}`
  }));
}
