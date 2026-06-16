export interface PortalCatalogVehicle {
  available: boolean;
  batteryCapacityKwh: number | null;
  batteryUsageType: string;
  batteryUsageTypeLabel: string;
  brand: string;
  city: string | null;
  coverImageUrl: string | null;
  currentMileageKm: number;
  displayName: string;
  gallery: string[];
  id: string;
  model: string | null;
  modelYear: number | null;
  series: string | null;
  statusLabel: string;
  tags: string[];
}

export interface PortalSubscriptionPlan {
  benefitDescription: string;
  canSubmit: boolean;
  depositDescription: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  energyDescription: string;
  mileageDescription: string;
  monthlyFeeAmount: number | null;
  monthlyFeeDescription: string;
  packageSummary: string[];
  periodOptions: number[];
  planId: string;
  planName: string;
  planNo: string;
  subscriptionPeriodMonths: number;
  subscriptionPeriodRange: {
    max: number;
    min: number;
  };
}

export interface PortalCatalogVehicleDetail extends PortalCatalogVehicle {
  depositNotice: string;
  submitButtonText: string;
  subscriptionPlans: PortalSubscriptionPlan[];
}

export interface PortalApplicationListItem {
  applicationNo: string;
  createdAt: string;
  depositStatus: string;
  id: string;
  plan: PortalApplicationPlanSnapshot;
  planConfirmStatus: string;
  reviewStatus: {
    credit: string;
    material: string;
    product: string;
    vehicle: string;
  };
  status: string;
  submittedAt: string | null;
  vehicle: PortalApplicationVehicleSnapshot;
}

export interface PortalApplicationDetail extends PortalApplicationListItem {
  canCancel: boolean;
  finalDepositAmount: number | null;
  materials: PortalApplicationMaterialGroup[];
  nextStepHint: string;
  ordersGenerated: boolean;
  rejectedReason: string | null;
  salesUser: { name: string } | null;
  softReservationExpiresAt: string | null;
}

export interface PortalApplicationPlanSnapshot {
  depositDescription: string;
  id: string | null;
  monthlyFeeAmount: number | null;
  monthlyFeeDescription: string;
  planName: string | null;
  subscriptionPeriodMonths: number | null;
}

export interface PortalApplicationVehicleSnapshot {
  batteryCapacityKwh: number | null;
  batteryUsageType: string | null;
  batteryUsageTypeLabel: string | null;
  brand: string | null;
  city: string | null;
  currentMileageKm: number | null;
  displayName: string;
  id: string | null;
  model: string | null;
  series: string | null;
}

export interface PortalApplicationMaterialGroup {
  files: PortalApplicationMaterialFile[];
  id: string;
  materialGroupId: string;
  materialName: string;
  materialType: string;
  required: boolean;
  reviewComment: string | null;
  reviewedAt: string | null;
  reviewStatus: string;
  status: string;
}

export interface PortalApplicationMaterialFile {
  fileName: string;
  fileRecordId: string;
  id: string;
  materialType: string;
  mimeType: string | null;
  previewUrl: string;
  sizeBytes: number;
  uploadedAt: string;
}

