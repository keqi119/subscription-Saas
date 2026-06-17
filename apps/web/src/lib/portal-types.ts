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

export interface PortalApplicationProgress {
  applicationId: string;
  applicationNo: string;
  currentStep: string;
  materialSupplementHints: PortalApplicationMaterialSupplementHint[];
  nextAction: string;
  overallStatus: string;
  steps: PortalApplicationProgressStep[];
}

export interface PortalApplicationProgressStep {
  key: string;
  label: string;
  message?: string;
  status: "DONE" | "CURRENT" | "FAILED" | "PENDING";
  time: string | null;
}

export interface PortalApplicationMaterialSupplementHint {
  materialGroupId: string;
  materialName: string;
  materialType: string;
  message: string;
}

export interface PortalFinalPlan {
  applicationId: string;
  applicationNo: string;
  changes?: PortalFinalPlanChange[];
  finalPlanStatus: "NOT_READY" | "PENDING_CONFIRM" | "CONFIRMED" | "REJECTED";
  importantNotes?: string[];
  nextAction: string;
  order?: null | {
    orderId: string;
    orderNo: string;
  };
  pricing?: {
    currency: string;
    finalDepositAmount: number | null;
    monthlyFeeAmount: number | null;
  };
  rejectedReason?: string | null;
  subscriptionPlan?: {
    packageSummary: string[];
    periodMonths: number | null;
    planName: string | null;
    planNo: string | null;
  };
  vehicle?: {
    batteryCapacityKwh: number | null;
    batteryUsageType: string | null;
    batteryUsageTypeLabel: string | null;
    brand: string | null;
    city: string | null;
    currentMileageKm: number | null;
    displayName: string;
    model: string | null;
    modelYear: number | null;
    series: string | null;
  };
}

export interface PortalFinalPlanChange {
  field: string;
  label: string;
  message: string;
}

export interface PortalContractListItem {
  contractNo: string;
  contractStatus: string;
  createdAt: string;
  id: string;
  orderNo: string;
  signedAt: string | null;
  signStatus: string | null;
}

export interface PortalContractDetail extends PortalContractListItem {
  canSign: boolean;
  customer: {
    mobile: string;
    name: string;
  };
  order: {
    id: string;
    orderNo: string;
    orderStatus: string;
  };
  signTask: PortalContractESignTask | null;
  vehicle: PortalContractVehicleSummary | null;
}

export interface PortalContractESignTask {
  completedAt: string | null;
  id: string;
  provider: string;
  signers: PortalContractESignSigner[];
  signUrlExpiresAt: string | null;
  taskNo: string;
  taskStatus: string;
}

export interface PortalContractESignSigner {
  signedAt: string | null;
  signerName: string | null;
  signerPhone: string | null;
  signerStatus: string;
  signerType: string;
}

export interface PortalContractVehicleSummary {
  batteryCapacityKwh: number | null;
  batteryUsageType: string | null;
  brand: string | null;
  city: string | null;
  currentMileageKm: number | null;
  displayName: string;
  model: string | null;
  modelYear: number | null;
  series: string | null;
}

export interface PortalSigningStartResponse {
  expiresAt: string | null;
  mock: boolean;
  provider: string;
  signUrl: string;
  taskId: string;
  taskStatus: string;
}

export interface PortalPayableBill {
  amount: number;
  billId: string;
  billNo: string;
  billStatus: string;
  billType: string;
  dueDate: string | null;
  orderId: string;
  orderNo: string;
  orderStatus: string;
  paidAmount: number;
  periodEnd: string | null;
  periodStart: string | null;
  remainingAmount: number;
}

export interface PortalPaymentOrder {
  amount: number;
  callbacks: PortalPaymentCallback[];
  cashierUrl: string | null;
  cashierUrlExpiresAt: string | null;
  createdAt: string | null;
  customerId: string | null;
  id: string;
  items: PortalPaymentOrderItem[];
  jsapiParams?: PortalWeChatJsapiParams;
  orderId: string | null;
  orderNo: string | null;
  orderStatus: string | null;
  paidAmount: number;
  paidAt: string | null;
  paymentChannel: string;
  paymentOrderNo: string;
  paymentRecord: {
    id: string;
    paymentNo: string;
  } | null;
  paymentStatus: string;
  provider: string;
  providerPrepayId: string | null;
  providerTradeNo: string | null;
  providerTransactionId: string | null;
  requiresWechatBinding?: boolean;
  subject: string | null;
  wechatAuthUrl?: string;
  wechatBindingExpiresIn?: number;
}

export interface PortalPaymentOrderItem {
  amount: number;
  billId: string;
  billNo: string;
  billStatus: string;
  billType: string;
  dueDate: string | null;
  id: string;
  orderNo: string;
  paidAmount: number;
  remainingAmount: number;
}

export interface PortalPaymentCallback {
  eventType: string | null;
  handled: boolean;
  id: string;
  receivedAt: string | null;
  verified: boolean;
}

export interface PortalWeChatBinding {
  bound: boolean;
  wechatOpenIdMasked: string | null;
}

export interface PortalWeChatJsapiParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
}

