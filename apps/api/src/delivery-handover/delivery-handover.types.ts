export const DELIVERY_HANDOVER_LEGAL_TEMPLATE_STATUS = "DRAFT_PENDING_LEGAL_APPROVAL" as const;
export type DeliveryHandoverLegalTemplateStatus =
  | typeof DELIVERY_HANDOVER_LEGAL_TEMPLATE_STATUS
  | "APPROVED";

export const DELIVERY_HANDOVER_REQUIRED_RENDER_FIELDS = [
  "order.orderNo",
  "stage1Contract.contractNo",
  "customer.name",
  "customer.mobileMasked",
  "vehicle.vin",
  "vehicle.plateNo",
  "delivery.scheduledAt",
  "delivery.deliveryLocation",
  "delivery.handoverMileageKm"
] as const;

export interface DeliveryHandoverPdfRenderModel {
  customer: {
    mobileMasked: string;
    name: string;
  };
  delivery: {
    deliveryLocation: string | null;
    handoverMileageKm: number | null;
    scheduledAt: string | null;
  };
  legalTemplateStatus: DeliveryHandoverLegalTemplateStatus;
  order: {
    orderNo: string;
  };
  stage1Contract: {
    contractNo: string;
    signedAt: string | null;
  };
  vehicle: {
    brand: string | null;
    model: string | null;
    plateNo: string | null;
    vin: string;
  };
}

export function assertDeliveryHandoverRenderModelReady(model: DeliveryHandoverPdfRenderModel) {
  if (model.legalTemplateStatus !== DELIVERY_HANDOVER_LEGAL_TEMPLATE_STATUS) {
    return;
  }

  throw new Error("DELIVERY_HANDOVER_LEGAL_TEMPLATE_NOT_APPROVED");
}
