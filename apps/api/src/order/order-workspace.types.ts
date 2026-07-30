export type OrderWorkspaceTabKey =
  | "overview"
  | "contract"
  | "handover"
  | "entitlement"
  | "service"
  | "finance"
  | "change";

export type OrderWorkspaceState =
  | "BLOCKED"
  | "ACTION_REQUIRED"
  | "FAILED"
  | "PROCESSING"
  | "WAITING_EXTERNAL"
  | "READY"
  | "COMPLETED"
  | "NOT_STARTED"
  | "UNAVAILABLE";

export type OrderWorkspaceGuideCategory = Exclude<OrderWorkspaceTabKey, "overview">;

export type OrderWorkspaceTarget = {
  actionCode: string;
  targetTab: OrderWorkspaceGuideCategory;
  targetRecordId: string | null;
};

export type OrderWorkspaceGuideItem = {
  category: OrderWorkspaceGuideCategory;
  state: OrderWorkspaceState;
  priority: number;
  actionCode: string | null;
  reasonCode: string;
  targetTab: OrderWorkspaceGuideCategory;
  targetRecordId: string | null;
  blocking: boolean;
  updatedAt: string | null;
  additionalCount: number;
};

export type OrderWorkspaceSummary = {
  asOf: string;
  header: {
    orderId: string;
    orderNo: string;
    orderStatus: string;
    customerLabel: string;
    currentVehicleLabel: string | null;
    ownerLabel: string | null;
  };
  guidance: OrderWorkspaceGuideItem[];
  primaryAction: OrderWorkspaceTarget | null;
  tabBadges: Array<{
    tab: OrderWorkspaceTabKey;
    count: number;
    attentionCount: number;
  }>;
  recentActivity: Array<{
    id: string;
    category: OrderWorkspaceGuideCategory | "order";
    title: string;
    occurredAt: string;
    targetTab: OrderWorkspaceTabKey;
    targetRecordId: string | null;
  }>;
};

export type OrderWorkspaceDetail = {
  actualDeliveryAt?: unknown;
  actualReturnAt?: unknown;
  application?: OrderWorkspaceApplicationDetail | null;
  changes?: OrderWorkspaceChangeDetail[];
  contract?: OrderWorkspaceContractDetail | null;
  contractId?: unknown;
  contracts?: OrderWorkspaceContractDetail[];
  createdAt?: unknown;
  creditReviewStatus?: unknown;
  customer?: OrderWorkspaceCustomerDetail | null;
  customerConfirmedAt?: unknown;
  customerId?: unknown;
  depositAmount?: unknown;
  depositStatus?: unknown;
  finalDepositAmount?: unknown;
  finalPlanConfirmedAt?: unknown;
  id?: unknown;
  mileageLimitKm?: unknown;
  modelCodeSnapshot?: unknown;
  modelDefinitionIdSnapshot?: unknown;
  modelDisplayName?: unknown;
  modelDisplayNameSnapshot?: unknown;
  modelDisplaySource?: unknown;
  monthlyFeeAmount?: unknown;
  orderNo?: unknown;
  orderSource?: unknown;
  orderStatus?: unknown;
  periodMonths?: unknown;
  productReviewStatus?: unknown;
  quote?: OrderWorkspaceQuoteDetail | null;
  quoteSnapshot?: unknown;
  riskResult?: OrderWorkspaceRiskDetail | null;
  vehicle?: OrderWorkspaceVehicleDetail | null;
  vehicleReviewStatus?: unknown;
};

export type OrderWorkspaceApplicationDetail = {
  applicationNo?: unknown;
  id?: unknown;
  status?: unknown;
};

export type OrderWorkspaceChangeDetail = {
  afterSnapshot?: unknown;
  approvedAt?: unknown;
  approvedBy?: unknown;
  beforeSnapshot?: unknown;
  changeType?: unknown;
  createdAt?: unknown;
  createdBy?: unknown;
  executedAt?: unknown;
  id?: unknown;
  reason?: unknown;
  status?: unknown;
  updatedAt?: unknown;
};

export type OrderWorkspaceContractDetail = {
  archivedAt?: unknown;
  contractNo?: unknown;
  contractTitle?: unknown;
  createdAt?: unknown;
  fileId?: unknown;
  id?: unknown;
  signedAt?: unknown;
  status?: unknown;
  updatedAt?: unknown;
};

export type OrderWorkspaceCustomerDetail = {
  grade?: unknown;
  id?: unknown;
  identity?: {
    id?: unknown;
    idCardNoPresent?: unknown;
  } | null;
  mobile?: unknown;
  name?: unknown;
  profile?: {
    residenceAddress?: unknown;
  } | null;
};

export type OrderWorkspaceQuoteDetail = {
  id?: unknown;
  quoteNo?: unknown;
  status?: unknown;
};

export type OrderWorkspaceRiskDetail = {
  applicationId?: unknown;
  approvedAt?: unknown;
  approvedBy?: unknown;
  approvedDepositAmount?: unknown;
  createdAt?: unknown;
  defaultRate?: unknown;
  grade?: unknown;
  id?: unknown;
  maxVehiclePurchasePriceAmount?: unknown;
  remark?: unknown;
  result?: unknown;
  score?: unknown;
  updatedAt?: unknown;
};

export type OrderWorkspaceVehicleDetail = {
  batteryCapacityKwh?: unknown;
  batteryUsageType?: unknown;
  batteryUsageTypeLabel?: unknown;
  brand?: unknown;
  currentMileageKm?: unknown;
  currentSalePriceAmount?: unknown;
  documents?: OrderWorkspaceVehicleDocumentDetail[];
  id?: unknown;
  insuranceClaims?: OrderWorkspaceInsuranceClaimDetail[];
  insurancePolicies?: OrderWorkspaceVehicleInsurancePolicyDetail[];
  model?: unknown;
  modelCode?: unknown;
  modelDefinitionId?: unknown;
  modelDisplayName?: unknown;
  modelYear?: unknown;
  plateNo?: unknown;
  series?: unknown;
  status?: unknown;
  vehicleNo?: unknown;
  vin?: unknown;
};

export type OrderWorkspaceVehicleInsurancePolicyDetail = {
  createdAt?: unknown;
  currency?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  id?: unknown;
  insuredAmount?: unknown;
  insuredName?: unknown;
  insurerName?: unknown;
  policyHolderName?: unknown;
  policyNo?: unknown;
  policyStatus?: unknown;
  policyType?: unknown;
  premiumAmount?: unknown;
  remark?: unknown;
  renewalReminderAt?: unknown;
  updatedAt?: unknown;
  vehicleId?: unknown;
};

export type OrderWorkspaceVehicleDocumentDetail = {
  customerVisible?: unknown;
  description?: unknown;
  documentStatus?: unknown;
  documentType?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  fileName?: unknown;
  fileSize?: unknown;
  id?: unknown;
  mimeType?: unknown;
  originalName?: unknown;
  title?: unknown;
};

export type OrderWorkspaceInsuranceClaimDetail = {
  acceptedAt?: unknown;
  accidentAt?: unknown;
  approvedAmount?: unknown;
  claimNo?: unknown;
  claimStatus?: unknown;
  closedAt?: unknown;
  estimatedAmount?: unknown;
  id?: unknown;
  insurerClaimNo?: unknown;
  orderId?: unknown;
  paidAmount?: unknown;
  policyId?: unknown;
  remark?: unknown;
  serviceCaseId?: unknown;
  submittedAt?: unknown;
  vehicleId?: unknown;
};
