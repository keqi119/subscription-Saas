export interface PortalCatalogVehicle {
  available: boolean;
  batteryCapacityKwh: number | null;
  batteryHealthCheckedAt?: string | null;
  batteryHealthPercent?: number | null;
  batteryUsageType: string;
  batteryUsageTypeLabel: string;
  brand: string;
  city: string | null;
  conditionGrade?: string | null;
  conditionSummary?: string | null;
  coverImageUrl: string | null;
  currentMileageKm: number;
  customerModelDisplayName?: string | null;
  customerTags?: string[];
  displayName: string;
  estimatedRangeKm?: number | null;
  gallery: PortalCatalogVehicleMedia[];
  hasFireDamage?: boolean | null;
  hasFloodDamage?: boolean | null;
  hasMajorAccident?: boolean | null;
  id: string;
  mileageKm?: number;
  model: string | null;
  modelDefinition?: PortalModelDefinitionSummary | null;
  modelDefinitionId?: string | null;
  modelCode?: string | null;
  modelDisplayName?: string | null;
  modelYear: number | null;
  monthlyFeeFromAmount?: number | null;
  registrationDate?: string | null;
  sellingPoints?: string[];
  series: string | null;
  shortTitle?: string | null;
  statusLabel: string;
  subtitle?: string | null;
  tags: string[];
}

export interface PortalModelDefinitionSummary {
  customerDisplayName?: string | null;
  displayName: string;
  id: string;
  modelCode: string;
}

export interface PortalCatalogVehicleMedia {
  caption: string | null;
  category: string;
  id: string;
  isCover: boolean;
  previewUrl: string;
  sortOrder: number;
}

export interface PortalSubscriptionPlan {
  benefitDescription: string;
  canSubmit: boolean;
  depositDescription: string;
  displayRemark?: string | null;
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
  recommended?: boolean;
  sortOrder?: number;
  subscriptionPeriodMonths: number;
  subscriptionPeriodRange: {
    max: number;
    min: number;
  };
}

export interface PortalCatalogVehicleDetail extends PortalCatalogVehicle {
  applicationNotice: string;
  applicationProcess: string[];
  battery: {
    capacityKwh: number | null;
    checkedAt: string | null;
    cycleCount?: number | null;
    estimatedRangeKm: number | null;
    healthPercent: number | null;
    remark: string | null;
    usageType: string;
    usageTypeLabel: string;
    warrantyUntil?: string | null;
  };
  condition: {
    grade: string | null;
    hasFireDamage: boolean | null;
    hasFloodDamage: boolean | null;
    hasMajorAccident: boolean | null;
    hasStructuralDamage: boolean | null;
    knownDefectsSummary: string | null;
    summary: string | null;
  };
  conditionReportSummary: {
    defectSummary: string | null;
    id: string;
    inspectionDate: string | null;
    inspectorName: string | null;
    inspectorOrg: string | null;
    itemCount: number;
    overallGrade: string | null;
    reportNo: string;
    summary: string | null;
  } | null;
  coreHighlights: string[];
  depositNotice: string;
  faq: Array<{
    answer: string;
    question: string;
  }>;
  feeDescription: string;
  serviceHighlights: string[];
  submitButtonText: string;
  subscriptionPlans: PortalSubscriptionPlan[];
  vehicle: {
    batteryCapacityKwh: number | null;
    brand: string;
    city: string | null;
    currentMileageKm: number;
    displayName: string;
    id: string;
    model: string | null;
    modelCode?: string | null;
    modelDefinition?: PortalModelDefinitionSummary | null;
    modelDefinitionId?: string | null;
    modelDisplayName?: string | null;
    modelYear: number | null;
    registrationDate: string | null;
    series: string | null;
  };
  vehicleHistorySummary: string;
}

export interface PortalVehicleConditionReport {
  accident: {
    hasFireDamage: boolean | null;
    hasFloodDamage: boolean | null;
    hasMajorAccident: boolean | null;
    hasStructuralDamage: boolean | null;
  };
  battery: {
    checkedAt: string | null;
    cycleCount: number | null;
    estimatedRangeKm: number | null;
    healthPercent: number | null;
    remark: string | null;
    warrantyUntil: string | null;
  };
  customerSummary: string | null;
  inspectionDate: string | null;
  inspectorName: string | null;
  inspectorOrg: string | null;
  items: PortalVehicleConditionReportItem[];
  odometerKm: number | null;
  overallGrade: string | null;
  repairSuggestion: string | null;
  reportNo: string;
  safetyConclusion: string | null;
  sections: {
    brakeSummary: string | null;
    chassisSummary: string | null;
    exteriorSummary: string | null;
    glassLightSummary: string | null;
    interiorSummary: string | null;
    tireSummary: string | null;
  };
  summary: string | null;
  vehicle: {
    brand: string;
    city: string | null;
    displayName: string;
    id: string;
    model: string | null;
    modelYear: number | null;
    series: string | null;
  };
}

export interface PortalVehicleConditionReportItem {
  affectsSafety: boolean;
  area: string;
  description: string | null;
  id: string;
  itemType: string;
  media: Array<{
    caption: string | null;
    category: string;
    id: string;
    previewUrl: string;
  }>;
  partName: string | null;
  repairRequired: boolean;
  result: string;
  severity: string;
  sortOrder: number;
  title: string | null;
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
  materialComplete: boolean;
  materials: PortalApplicationMaterialGroup[];
  missingMaterials: PortalMissingMaterial[];
  nextStepHint: string;
  ordersGenerated: boolean;
  profileMaterialsAvailable: boolean;
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
  source?: "APPLICATION_UPLOAD" | "CUSTOMER_PROFILE" | string;
  sourceLabel?: string;
  uploadedAt: string;
}

export interface PortalMissingMaterial {
  label: string;
  type: string;
}

export interface PortalMissingProfileField {
  key: "idCardNo" | "mobile" | "name";
  label: string;
  reason: "INVALID" | "MISSING" | "PLACEHOLDER";
}

export interface PortalCustomerProfile {
  idCardNoMasked: string | null;
  idCardNoPresent: boolean;
  missingProfileFields: PortalMissingProfileField[];
  mobile: string | null;
  name: string;
  profileComplete: boolean;
}

export interface PortalMaterialCompleteness {
  canSubmit: boolean;
  complete: boolean;
  completedCount: number;
  missingMaterials: PortalMissingMaterial[];
  requiredCount: number;
  stronglyRecommendedUploadBeforeSubmit: boolean;
}

export interface PortalProfileMaterialRequirement {
  label: string;
  required: boolean;
  type: string;
}

export interface PortalProfileMaterial {
  createdAt: string;
  fileName: string;
  fileSize: number | null;
  id: string;
  label: string;
  materialStatus: string;
  materialStatusLabel: string;
  materialType: string;
  mimeType: string | null;
  originalName: string | null;
  previewUrl: string;
  remark: string | null;
  updatedAt: string;
}

export interface PortalApplicationPrecheck {
  actions: Array<{
    key: string;
    label: string;
    url?: string;
  }>;
  canSubmit: boolean;
  materialComplete: boolean;
  missingProfileFields: PortalMissingProfileField[];
  missingMaterials: PortalMissingMaterial[];
  profileComplete: boolean;
  warnings: string[];
}

export interface PortalApplicationProgress {
  applicationId: string;
  applicationNo: string;
  currentStep: string;
  materialSupplementHints: PortalApplicationMaterialSupplementHint[];
  nextAction: string;
  nextActionTarget: PortalApplicationNextActionTarget | null;
  overallStatus: string;
  steps: PortalApplicationProgressStep[];
}

export interface PortalApplicationNextActionTarget {
  label: string;
  url: string;
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
  documentType: "DELIVERY_HANDOVER" | "SUBSCRIPTION_CONTRACT" | null;
  hasSignedDocument: boolean;
  id: string;
  orderNo: string;
  signedAt: string | null;
  signingStage: "STAGE1_SUBSCRIPTION_CONTRACT" | "STAGE2_DELIVERY_HANDOVER" | null;
  signStatus: string | null;
  workOrderId: string | null;
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
  documentType: "DELIVERY_HANDOVER" | "SUBSCRIPTION_CONTRACT" | null;
  hasEvidenceDocument: boolean;
  hasSignedDocument: boolean;
  id: string;
  provider: string;
  signers: PortalContractESignSigner[];
  signingStage: "STAGE1_SUBSCRIPTION_CONTRACT" | "STAGE2_DELIVERY_HANDOVER" | null;
  signUrlExpiresAt: string | null;
  taskNo: string;
  taskStatus: string;
  workOrderId: string | null;
}

export interface PortalContractESignSigner {
  signedAt: string | null;
  signerName: string | null;
  signerPhone: string | null;
  signerStatus: string;
  signerType: string;
}

export interface PortalFadadaOnboardingStatus {
  accountType: string;
  blockingCode: string | null;
  blockingMessage: string | null;
  certBound: boolean;
  certSerialNoPresent: boolean;
  customerId: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastProviderCheckAt: string | null;
  nextAction: string;
  provider: string;
  providerCustomerId: string | null;
  providerCustomerIdPresent: boolean;
  providerOpenId: string | null;
  readyForSigning: boolean;
  realNameProviderVerified: boolean;
  realNameStatus: string | null;
  realNameUrl?: string | null;
  registrationStatus: string | null;
  signingEligible: boolean;
  source?: string;
  state: string;
  verifiedAt: string | null;
  verifyUrlMasked?: string | null;
  verifyUrlPresent?: boolean;
  verificationSerialNo: string | null;
  verificationTransactionNo: string | null;
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

export interface PortalNotification {
  channel: string;
  content: string | null;
  createdAt: string;
  notificationId: string;
  notificationNo: string;
  notificationStatus: string;
  notificationType: string;
  readAt: string | null;
  title: string | null;
  url: string | null;
}

export interface PortalNotificationListResponse {
  items: PortalNotification[];
  page: number;
  pageSize: number;
  total: number;
  unreadCount: number;
}

export interface AdminNotificationTemplate {
  channel: string;
  content: string | null;
  createdAt: string;
  description: string | null;
  providerTemplateId: string | null;
  templateCode: string;
  templateId: string;
  templateStatus: string;
  templateType: string;
  title: string;
  updatedAt: string;
  variables: unknown;
}

export interface AdminNotificationRecord {
  channel: string;
  content: string | null;
  createdAt: string;
  customer: {
    customerNo: string;
    mobile: string | null;
    name: string;
  } | null;
  errorMessage: string | null;
  failedAt: string | null;
  notificationId: string;
  notificationNo: string;
  notificationStatus: string;
  notificationType: string;
  providerMessageId: string | null;
  readAt: string | null;
  recipientOpenIdMasked: string | null;
  recipientPhone: string | null;
  sentAt: string | null;
  templateCode: string | null;
  templateTitle: string | null;
  title: string | null;
  url: string | null;
}

export interface AdminNotificationEvent {
  aggregateId: string | null;
  aggregateType: string | null;
  attempts: number;
  createdAt: string;
  customer: {
    customerNo: string;
    mobile: string | null;
    name: string;
  } | null;
  eventId: string;
  eventStatus: string;
  eventType: string;
  lastError: string | null;
  notificationNo: string | null;
  processedAt: string | null;
}

export interface PortalPagedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PortalOrderListItem {
  actualDeliveryAt: string | null;
  billCount: number;
  contractStatus: string | null;
  createdAt: string | null;
  deliveryStatus: string | null;
  id: string;
  orderId: string;
  orderNo: string;
  orderStatus: string;
  payableBillCount: number;
  paymentStatus: string;
  remainingAmount: number;
  subscriptionPlanSummary: PortalOrderPlanSummary;
  vehicleSummary: PortalOrderVehicleSummary | null;
}

export interface PortalOrderDetail extends PortalOrderListItem {
  billingSummary: PortalOrderBillingSummary;
  contractSummary: PortalOrderContractSummary | null;
  depositSummary: PortalDepositAccount;
  deliverySummary: {
    deliveredAt: string | null;
    deliveryStatus: string | null;
    scheduledAt: string | null;
  };
  entitlementSummary: {
    activeGrantCount: number;
    exhaustedGrantCount: number;
    grantCount: number;
  };
  mileageReviewSummary: null | {
    actionUrl: string | null;
    currentReviewId: string;
    cycleNo: number;
    dueAt: string | null;
    hasAction: boolean;
    lockVersion: number;
    overdue: boolean;
    overMileageBillId: string | null;
    scheduledReviewAt: string | null;
    status: string;
  };
  nextAction: string;
  nextActionTarget: null | {
    label: string;
    url: string;
  };
  order: {
    actualDeliveryAt: string | null;
    actualReturnAt: string | null;
    createdAt: string | null;
    endDate: string | null;
    id: string;
    monthlyFeeAmount: number;
    orderNo: string;
    orderSource: string;
    orderStatus: string;
    periodMonths: number;
    startDate: string | null;
  };
}

export interface PortalVehicleDocument {
  createdAt: string;
  description: string | null;
  documentType: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  fileName: string;
  fileSize: number | null;
  id: string;
  mimeType: string | null;
  originalName: string | null;
  policy: {
    insurerName: string | null;
    policyNo: string;
    policyType: string;
  } | null;
  previewUrl: string;
  title: string | null;
}

export interface PortalOrderPlanSummary {
  mileageLimitKm: number;
  monthlyFeeAmount: number;
  overMileageFeeAmount: number;
  periodMonths: number;
  planName: string | null;
  productName: string;
}

export interface PortalOrderVehicleSummary {
  batteryCapacityKwh: number | null;
  batteryUsageType: string | null;
  brand: string | null;
  city: string | null;
  currentMileageKm: number | null;
  displayName: string;
  id: string;
  model: string | null;
  modelCode: string | null;
  modelDefinitionId: string | null;
  modelDisplayName: string | null;
  modelYear: number | null;
  series: string | null;
}

export interface PortalOrderContractSummary {
  contractId: string;
  contractNo: string;
  contractStatus: string;
  createdAt: string | null;
  signedAt: string | null;
}

export interface PortalOrderBillingSummary {
  bills: Array<{
    amount: number;
    billId: string;
    billStatus: string;
    billType: string;
    canPay: boolean;
    paidAmount: number;
    remainingAmount: number;
  }>;
  paidAmount: number;
  payableBillCount: number;
  remainingAmount: number;
  totalAmount: number;
}

export interface PortalBillListItem {
  amount: number;
  billId: string;
  billNo: string;
  billStatus: string;
  billType: string;
  canPay: boolean;
  dueDate: string | null;
  orderId: string;
  orderNo: string;
  orderStatus: string;
  paidAmount: number;
  periodEnd: string | null;
  periodStart: string | null;
  remainingAmount: number;
}

export interface PortalBillDetail extends PortalBillListItem {
  paymentOrders: Array<{
    amount: number;
    paidAmount: number;
    paidAt: string | null;
    paymentChannel: string;
    paymentOrderId: string;
    paymentOrderNo: string;
    paymentStatus: string;
    provider: string;
  }>;
  writeOffs: Array<{
    paymentAmount: number;
    paymentId: string;
    paymentMethod: string;
    paymentNo: string;
    paymentStatus: string;
    receivedAt: string | null;
    remark: string | null;
    writeOffAmount: number;
    writeOffAt: string | null;
    writeOffId: string;
  }>;
}

export interface PortalAutoDebitAvailability {
  enabled: boolean;
  provider: "WECHAT_AUTO_DEBIT" | null;
}

export type PortalPaymentMandateStatus =
  | "PENDING"
  | "ACTIVE"
  | "SUSPENDED"
  | "REVOKED"
  | "EXPIRED"
  | "FAILED";

export interface PortalPaymentMandate {
  effectiveAt: string | null;
  expiresAt: string | null;
  id: string;
  mandateNo: string;
  orderId: string;
  provider: string;
  providerMode: string;
  providerReference: string | null;
  revokedAt: string | null;
  signedAt: string | null;
  status: PortalPaymentMandateStatus;
}

export type PortalDebitAttemptStatus =
  | "CREATED"
  | "SUBMITTING"
  | "PROCESSING"
  | "UNKNOWN"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "CANCELLED";

export type PortalDebitRetrySlot = "DUE" | "D1" | "D3" | "MANUAL";

export interface PortalDebitAttempt {
  acceptedAt: string | null;
  billId: string;
  confirmedAmount: string;
  createdAt: string;
  debitAttemptNo: string;
  id: string;
  orderId: string;
  requestedAmount: string;
  resolvedAt: string | null;
  retrySlot: PortalDebitRetrySlot;
  status: PortalDebitAttemptStatus;
}

export interface PortalDepositOverview {
  accounts: PortalDepositAccount[];
  availableAmount: number;
  totalCollectedAmount: number;
  totalDeductedAmount: number;
  totalFrozenAmount: number;
  totalRefundedAmount: number;
}

export interface PortalDepositAccount {
  collectedAmount: number;
  deductedAmount: number;
  frozenAmount: number;
  lastTransactionAt: string | null;
  orderId: string;
  orderNo: string | null;
  orderStatus: string | null;
  refundedAmount: number;
  remainingAmount: number;
  status: string;
}

export interface PortalDepositTransaction {
  amount: number;
  balanceAfter: number;
  occurredAt: string | null;
  orderId: string;
  orderNo: string;
  remark: string | null;
  transactionId: string;
  transactionStatus: string;
  transactionType: string;
}

export interface PortalEntitlementGrant {
  entitlementType: string;
  grantId: string;
  grantNo: string;
  latestUsageAt: string | null;
  name: string;
  orderId: string;
  orderNo: string;
  remainingAmount: number | null;
  remark: string | null;
  source: string;
  status: string;
  totalAmount: number | null;
  unit: string;
  usedAmount: number | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface PortalEntitlementUsage {
  amount: number;
  entitlementType: string;
  externalRefNo: string | null;
  grantId: string;
  grantName: string;
  grantNo: string;
  occurredAt: string | null;
  orderId: string;
  orderNo: string;
  remark: string | null;
  source: string;
  status: string;
  unit: string;
  usageId: string;
  usageNo: string;
}

export interface PortalServiceCase {
  acceptedAt: string | null;
  actions: PortalServiceCaseAction[];
  attachments: PortalServiceCaseAttachment[];
  canCancel: boolean;
  cancelReason: string | null;
  cancelledAt: string | null;
  caseNo: string;
  caseSource: string;
  caseStatus: string;
  caseType: string;
  closeRemark: string | null;
  closedAt: string | null;
  contactName: string | null;
  contactPhone: string | null;
  createdAt: string | null;
  customer?: {
    customerNo: string;
    id: string;
    mobile: string;
    name: string;
  };
  description: string | null;
  id: string;
  insuranceReportNo: string | null;
  insuranceClaims: PortalInsuranceClaimSummary[];
  locationText: string | null;
  occurredAt: string | null;
  order: {
    id: string;
    orderNo: string;
    orderStatus: string;
  } | null;
  priority: string;
  rescueAddress: string | null;
  rescueType: string | null;
  resolvedAt: string | null;
  title: string | null;
  updatedAt: string | null;
  vehicle: {
    assetLocation: string | null;
    batteryCapacityKwh: number | null;
    batteryUsageType: string | null;
    brand: string | null;
    currentMileageKm: number | null;
    displayName: string;
    id: string;
    model: string | null;
    modelCode: string | null;
    modelDefinitionId: string | null;
    modelDisplayName: string | null;
    modelYear: number | null;
    series: string | null;
  } | null;
}

export interface PortalInsuranceClaimSummary {
  approvedAmount: number | null;
  claimNo: string;
  claimStatus: string;
  closedAt: string | null;
  id: string;
  insurerClaimNo: string | null;
  paidAmount: number | null;
  submittedAt: string | null;
}

export interface PortalServiceCaseAttachment {
  attachmentType: string;
  createdAt: string | null;
  fileName: string;
  fileSize: number | null;
  id: string;
  mimeType: string | null;
  previewUrl: string;
}

export interface PortalServiceCaseAction {
  actionType: string;
  actorName: string | null;
  actorType: string;
  createdAt: string | null;
  fromStatus: string | null;
  id: string;
  remark: string | null;
  toStatus: string | null;
}
