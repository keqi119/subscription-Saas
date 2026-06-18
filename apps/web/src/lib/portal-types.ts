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
  nextAction: string;
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
  modelYear: number | null;
  series: string | null;
  vehicleModel: string | null;
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
    modelYear: number | null;
    series: string | null;
    vehicleModel: string | null;
  } | null;
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

