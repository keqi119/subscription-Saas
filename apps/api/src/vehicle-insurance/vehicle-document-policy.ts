import { BadRequestException } from "@nestjs/common";
import { VehicleDocumentType } from "@prisma/client";

export const INTERNAL_RIGHTS_DOCUMENT_TYPES: ReadonlySet<VehicleDocumentType> = new Set([
  VehicleDocumentType.VEHICLE_REGISTRATION_CERTIFICATE,
  VehicleDocumentType.VEHICLE_LICENSE,
  VehicleDocumentType.VEHICLE_INSPECTION_REPORT,
  VehicleDocumentType.VEHICLE_PURCHASE_AGREEMENT,
  VehicleDocumentType.MOTOR_VEHICLE_INVOICE,
  VehicleDocumentType.OWNER_IDENTITY_DOCUMENT,
  VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET,
  VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER
]);

export const ADDITIVE_DOCUMENT_TYPES: ReadonlySet<VehicleDocumentType> = new Set([
  VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER
]);

export const MAX_VEHICLE_DOCUMENT_BATCH_FILES = 20;

export function assertVehicleDocumentVisibility(
  documentType: VehicleDocumentType,
  customerVisible: boolean | undefined
) {
  if (INTERNAL_RIGHTS_DOCUMENT_TYPES.has(documentType) && customerVisible === true) {
    throw new BadRequestException("internal vehicle rights documents cannot be customer visible");
  }
}

export function normalizeVehicleDocumentVisibility(
  documentType: VehicleDocumentType,
  customerVisible: boolean | undefined
) {
  assertVehicleDocumentVisibility(documentType, customerVisible);
  return INTERNAL_RIGHTS_DOCUMENT_TYPES.has(documentType) ? false : (customerVisible ?? false);
}
