"use client";

import {
  ClockCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PlusOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SendOutlined,
  UserAddOutlined
} from "@ant-design/icons";
import { Alert, App, Button, Card, Checkbox, DatePicker, Descriptions, Empty, Form, Input, InputNumber, List, Modal, Progress, Select, Space, Spin, Table, Tag, Timeline, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode
} from "react";

import { ActionButton } from "../../../components/action-button";
import {
  OrderTransactionGuide,
  type OrderTransactionGuideItem
} from "../../../components/order-workspace/order-transaction-guide";
import {
  OrderWorkspaceHeader,
  type OrderWorkspaceHeaderAction,
  type OrderWorkspaceHeaderData
} from "../../../components/order-workspace/order-workspace-header";
import {
  OrderWorkspace,
  type OrderWorkspaceTabBadge
} from "../../../components/order-workspace/order-workspace";
import { ProtectedShell } from "../../../components/protected-shell";
import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  DELIVERY_STATUS_LABELS,
  DEPOSIT_TRANSACTION_STATUS_LABELS,
  DEPOSIT_TRANSACTION_TYPE_LABELS,
  ENTITLEMENT_ACCOUNT_STATUS_LABELS,
  ENTITLEMENT_GRANT_SOURCE_LABELS,
  ENTITLEMENT_GRANT_STATUS_LABELS,
  ENTITLEMENT_TYPE_LABELS,
  ENTITLEMENT_UNIT_LABELS,
  ENTITLEMENT_USAGE_SOURCE_LABELS,
  ENTITLEMENT_USAGE_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_CHANGE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  SERVICE_CASE_STATUS_LABELS,
  SERVICE_CASE_TYPE_LABELS,
  STATUS_LABELS,
  VEHICLE_BASE_FEE_MODE_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  VEHICLE_DAMAGE_LEVEL_LABELS,
  VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS,
  VEHICLE_DAMAGE_TYPE_LABELS,
  VEHICLE_RETURN_DAMAGE_STATUS_LABELS,
  VEHICLE_RETURN_STATUS_LABELS,
  VEHICLE_RETURN_TYPE_LABELS,
  labelOf
} from "../../../constants/labels";
import {
  actionAvailability,
  canExecuteOrderChange,
  canGenerateContract as getGenerateContractAvailability
} from "../../../lib/action-guards";
import { apiFetch, ApiError, API_BASE_URL } from "../../../lib/api";
import { formatFieldEvidenceVideoQuality } from "../../../lib/field-handover-video-quality";
import {
  createAdminStage2DeliveryConfirmationController,
  createAdminStage2DeliveryVerifier,
  getAdminStage2HandoverESignDisplay,
  getAdminStage2HandoverESignErrorMessage,
  getAdminStage2HandoverWorkflowDisplay,
  loadAdminStage2HandoverESign,
  loadAdminStage2HandoverESignWithInitialAssignmentPolling,
  reconcileAdminStage2CustomerSignature,
  retryAdminStage2WorkflowJob,
  runAdminStage2WorkflowRecovery,
  startAdminStage2HandoverESign,
  type AdminStage2HandoverESignStatus,
  type AdminStage2HandoverWorkflowJob,
  type AdminStage2HandoverWorkflowRecovery,
  validateAdminStage2HandoverFallbackReason,
  validateAdminStage2HandoverVoidReason,
  voidAdminStage2HandoverESign
} from "../../../lib/admin-stage2-handover-esign";
import {
  buildAdminStage2HandoverPdfDownloadUrl,
  getAdminStage2HandoverDocumentDownload,
  type Stage2HandoverPdfArtifact
} from "../../../lib/admin-stage2-handover-pdf";
import {
  buildOrderWorkspaceLocation,
  buildOrderWorkspaceRecordSelector,
  createOrderWorkspaceConfirmScope,
  getOrderWorkspaceChangeGuard,
  getOrderWorkspaceCustomerPresentation,
  getOrderWorkspaceFallbackRecordIds,
  getOrderWorkspaceFinanceLinks,
  getOrderWorkspaceFocusAttemptKey,
  getOrderWorkspaceRecordIds,
  getVehicleReturnWorkspaceState,
  getVisibleOrderWorkspaceTabs,
  getWorkspaceStatePresentation,
  mergeOrderWorkspaceFocusedServiceCase,
  parseOrderWorkspaceLocation,
  refreshActiveOrderWorkspaceTab,
  shouldLoadOrderWorkspaceFocusedServiceCase,
  type OrderWorkspaceTabKey
} from "../../../lib/admin-order-workspace";
import type { AuthMeResponse } from "../../../lib/auth";
import type {
  PortalPagedResponse,
  PortalServiceCase
} from "../../../lib/portal-types";

interface OrderWorkspaceSummary {
  asOf: string;
  guidance: OrderTransactionGuideItem[];
  header: OrderWorkspaceHeaderData & { orderId: string };
  primaryAction: {
    actionCode: string;
    targetRecordId: string | null;
    targetTab: Exclude<OrderWorkspaceTabKey, "overview">;
  } | null;
  recentActivity: OrderWorkspaceActivity[];
  tabBadges: OrderWorkspaceTabBadge[];
}

interface OrderWorkspaceActivity {
  category: Exclude<OrderWorkspaceTabKey, "overview"> | "order";
  id: string;
  occurredAt: string;
  targetRecordId: string | null;
  targetTab: OrderWorkspaceTabKey;
  title: string;
}

interface OrderDetail {
  actualDeliveryAt?: string | null;
  actualReturnAt?: string | null;
  application?: { applicationNo: string; id: string } | null;
  contract?: { contractNo: string; id: string; status: string } | null;
  createdAt: string;
  creditReviewStatus?: string;
  customer?: { name?: string | null; mobile?: string | null } | null;
  customerId?: string;
  customerConfirmedAt?: string | null;
  depositAmount: number;
  depositStatus?: string;
  finalDepositAmount?: number | null;
  finalPlanConfirmedAt?: string | null;
  id: string;
  mileageLimitKm: number;
  modelCodeSnapshot?: string | null;
  modelDefinitionIdSnapshot?: string | null;
  modelDisplayName?: string | null;
  modelDisplayNameSnapshot?: string | null;
  modelDisplaySource?: string | null;
  monthlyFeeAmount: number;
  orderNo: string;
  orderSource?: string;
  orderStatus: string;
  periodMonths: number;
  productReviewStatus?: string;
  quote?: { quoteNo: string; id: string } | null;
  quoteSnapshot?: unknown;
  vehicle?: {
    batteryCapacityKwh?: number | null;
    batteryUsageType?: string | null;
    batteryUsageTypeLabel?: string | null;
    currentMileageKm?: number | null;
    currentSalePriceAmount?: number | null;
    modelCode?: string | null;
    modelDefinitionId?: string | null;
    modelDisplayName?: string | null;
    plateNo?: string | null;
    status?: string | null;
    vehicleNo?: string;
    vin?: string | null;
  } | null;
  vehiclePurchasePriceAmount: number;
  vehicleReviewStatus?: string;
}

interface FinanceSummary {
  allocatedPaidAmount?: number | null;
  deliveryPaymentSatisfied?: boolean;
  deliveryPaymentStatus?: string | null;
  depositPaidAmount?: number | null;
  depositReceivableAmount?: number | null;
  depositStatus?: string | null;
  firstMonthlyFeePaidAmount?: number | null;
  firstMonthlyFeeReceivableAmount?: number | null;
  firstMonthlyFeeStatus?: string | null;
  isDeliveryPaymentSatisfied?: boolean;
  registeredReceiptAmount?: number | null;
  totalPaidAmount?: number | null;
  totalReceivableAmount?: number | null;
  unallocatedReceiptAmount?: number | null;
}

interface ReceivableBillRow {
  amount?: number | null;
  billNo: string;
  billPeriodEnd?: string | null;
  billPeriodStart?: string | null;
  billStatus: string;
  billType: string;
  dueDate?: string | null;
  id: string;
  paidAmount?: number | null;
  paidAt?: string | null;
  remainingAmount?: number | null;
  remark?: string | null;
}

interface PaymentRecordResponse {
  id: string;
  paymentNo?: string;
}

interface MonthlyRentBillResponse {
  created?: boolean;
  id: string;
}

interface DamageFeeBillResponse extends ReceivableBillRow {
  created?: boolean;
}

interface OrderChangeRow {
  afterSnapshot?: unknown;
  beforeSnapshot?: unknown;
  changeType: string;
  createdAt: string;
  createdBy?: string | null;
  creator?: { name: string } | null;
  executedAt?: string | null;
  id: string;
  reason: string;
  status: string;
}

interface ChangeFormValues {
  reason: string;
}

interface PaymentWriteOffFormItem {
  billId?: string;
  writeOffAmountYuan?: number;
}

interface PaymentFormValues {
  payerAccount?: string;
  payerName?: string;
  paymentAmountYuan?: number;
  paymentMethod?: string;
  paymentProofUrlsText?: string;
  receivedAt?: Dayjs;
  remark?: string;
  writeOffEnabled?: boolean;
  writeOffItems?: PaymentWriteOffFormItem[];
}

interface DeliveryCheck {
  alreadyDelivered?: boolean;
  blockingReasons: string[];
  canConfirmDelivery: boolean;
  canPrepareDelivery: boolean;
  contractSigned: boolean;
  currentSalePriceInitialized: boolean;
  deliveryStatus?: string | null;
  depositRequired?: boolean;
  depositRequiredAmount?: number | null;
  depositReceivedConfirmed: boolean;
  firstMonthlyFeeReceivedConfirmed: boolean;
  insuranceCoverage: {
    commercialCovered: boolean;
    compulsoryTrafficCovered: boolean;
    evaluatedAt: string;
  };
  insuranceValid: boolean;
  orderId: string;
  orderNo: string;
  orderStatus: string;
  vehiclePrepared: boolean;
  vehicleStatus?: string | null;
}

interface VehicleDelivery {
  contractSignedConfirmed?: boolean;
  customerIdentityConfirmed?: boolean;
  deliveredAt?: string | null;
  deliveryLocation?: string | null;
  deliveryNo: string;
  deliveryStatus: string;
  depositReceivedConfirmed?: boolean;
  firstMonthlyFeeReceivedConfirmed?: boolean;
  handoverDocumentsConfirmed?: boolean;
  handoverMileageKm?: number | null;
  id: string;
  insuranceValidConfirmed?: boolean;
  remark?: string | null;
  scheduledAt?: string | null;
  vehiclePhotosConfirmed?: boolean;
  vehiclePreparedConfirmed?: boolean;
}

interface HandoverEvidenceFile {
  displayName?: string | null;
  downloadUrl?: string | null;
  evidenceFileId?: string | null;
  id?: string | null;
  mediaType?: string | null;
  metadata?: Record<string, unknown> | null;
  previewAvailable?: boolean | null;
  previewUrl?: string | null;
  sizeBytes?: number | string | null;
}

interface HandoverEvidenceItem {
  evidenceType?: string | null;
  fileCount?: number | null;
  files?: HandoverEvidenceFile[];
  id?: string | null;
  isConditional?: boolean | null;
  isRequired?: boolean | null;
  rejectionReason?: string | null;
  reviewStatus?: string | null;
  status?: string | null;
  title?: string | null;
}

interface HandoverEvidenceChecklist {
  blockingReasons?: string[];
  items?: HandoverEvidenceItem[];
  ready?: boolean;
}

interface HandoverReviewAttempt {
  adminNotes?: string | null;
  adminStatus?: string | null;
  attemptNo?: number | null;
  customerConfirmedAt?: string | null;
  customerObjectedAt?: string | null;
  customerObjectionDetails?: string | null;
  customerObjectionReason?: string | null;
  customerReviewStartedAt?: string | null;
  fieldSubmittedAt?: string | null;
  id?: string | null;
  status?: string | null;
}

interface HandoverEvent {
  actorDisplay?: string | null;
  actorType?: string | null;
  createdAt?: string | null;
  eventType?: string | null;
  id?: string | null;
}

interface HandoverWorkOrderSummary {
  adminReview?: {
    canAcknowledge?: boolean | null;
    canRequestResubmission?: boolean | null;
    canSendBackToCustomerReview?: boolean | null;
    currentAttemptNo?: number | null;
    status?: string | null;
    totalAttempts?: number | null;
  } | null;
  customer?: { displayName?: string | null; mobileMasked?: string | null } | null;
  customerConfirmedAt?: string | null;
  customerObjectedAt?: string | null;
  customerReviewStartedAt?: string | null;
  deliveryLocation?: string | null;
  evidenceProgress?: { approved?: number | null; required?: number | null; total?: number | null; uploaded?: number | null } | null;
  events?: HandoverEvent[];
  fieldResubmissionRequested?: boolean | null;
  fieldSubmittedAt?: string | null;
  handoverId?: string | null;
  handoverType?: string | null;
  id: string;
  objection?: { adminStatus?: string | null; details?: string | null; objectedAt?: string | null; reason?: string | null } | null;
  operator?: { name?: string | null; phone?: string | null; type?: string | null } | null;
  orderId?: string | null;
  orderNo?: string | null;
  readiness?: { blockingReasons?: string[]; readyForStage2Pdf?: boolean; readyForStage2ESign?: boolean } | null;
  reviewAttempts?: HandoverReviewAttempt[];
  scheduledAt?: string | null;
  stage2Pdf?: Stage2HandoverPdfArtifact | null;
  status?: string | null;
  vehicle?: { brand?: string | null; model?: string | null; plateMasked?: string | null; vinSuffix?: string | null } | null;
  workflowJobs?: AdminStage2HandoverWorkflowJob[];
}

type HandoverWorkOrdersLoadState =
  | "ERROR"
  | "LOADED"
  | "LOADING"
  | "UNKNOWN";

interface AssignExternalHandoverFormValues {
  expiresAt?: Dayjs;
  name: string;
  organization?: string;
  phone: string;
}

interface HandoverResubmissionFormValues {
  note: string;
  targetEvidenceItemIds?: string[];
  targetFieldKeys?: string[];
}

interface Stage2VoidFormValues {
  reason: string;
}

interface Stage2FallbackFormValues {
  acknowledgement?: boolean;
  reason: string;
}

interface HandoverWorkOrderDetail extends HandoverWorkOrderSummary {
  evidenceChecklist?: HandoverEvidenceChecklist | null;
  fieldFacts?: Record<string, unknown> | null;
  readiness?: { blockingReasons?: string[]; readyForStage2Pdf?: boolean; readyForStage2ESign?: boolean } | null;
}

interface PrepareDeliveryFormValues {
  customerIdentityConfirmed?: boolean;
  deliveryLocation?: string;
  depositReceivedConfirmed?: boolean;
  firstMonthlyFeeReceivedConfirmed?: boolean;
  handoverDocumentsConfirmed?: boolean;
  insuranceValidConfirmed?: boolean;
  remark?: string;
  scheduledAt?: Dayjs;
  vehiclePhotosConfirmed?: boolean;
  vehiclePreparedConfirmed?: boolean;
}

interface ConfirmDeliveryFormValues {
  deliveredAt?: Dayjs;
  handoverMileageKm?: number;
  remark?: string;
}

interface ReturnCheck {
  alreadyReturned?: boolean;
  blockingReasons: string[];
  canConfirmReturn: boolean;
  canPrepareReturn: boolean;
  orderId: string;
  orderNo: string;
  orderStatus: string;
  returnStatus?: string | null;
  vehicleId?: string | null;
  vehicleStatus?: string | null;
}

interface VehicleReturnDamage {
  damageLevel: string;
  damageType: string;
  description?: string | null;
  estimatedRepairAmount?: number | null;
  id: string;
  photoUrls?: string[] | null;
  responsibleParty?: string | null;
  status: string;
}

interface VehicleReturn {
  batteryCheckedConfirmed?: boolean;
  chargingEquipmentReturnedConfirmed?: boolean;
  cleaningRequired?: boolean;
  customerItemsClearedConfirmed?: boolean;
  damageFound?: boolean;
  damages?: VehicleReturnDamage[];
  exteriorCheckedConfirmed?: boolean;
  id: string;
  interiorCheckedConfirmed?: boolean;
  keysReturnedConfirmed?: boolean;
  maintenanceRequired?: boolean;
  mileageConfirmed?: boolean;
  remark?: string | null;
  returnLocation?: string | null;
  returnMileageKm?: number | null;
  returnNo: string;
  returnStatus: string;
  returnType: string;
  returnedAt?: string | null;
  scheduledAt?: string | null;
  vehicleDocumentsReturnedConfirmed?: boolean;
  violationCheckedConfirmed?: boolean;
}

interface DepositSettlementDamage {
  billable?: boolean;
  createdAt?: string | null;
  damageLevel: string;
  damageType: string;
  description?: string | null;
  estimatedRepairAmount?: number | null;
  id: string;
  orderId?: string;
  photoUrls?: string[] | null;
  responsibleParty?: string | null;
  returnId?: string;
  status: string;
  updatedAt?: string | null;
  vehicleId?: string;
}

interface DepositLedgerRow {
  amount?: number | null;
  balanceAfter?: number | null;
  billId?: string | null;
  createdAt?: string | null;
  customerId?: string;
  id: string;
  ledgerNo?: string;
  occurredAt?: string | null;
  orderId?: string;
  paymentId?: string | null;
  remark?: string | null;
  snapshot?: unknown;
  transactionStatus: string;
  transactionType: string;
}

interface DepositSettlement {
  availableBalance?: number | null;
  availableDepositBalance?: number | null;
  collectedAmount?: number | null;
  customer?: { id: string; mobile?: string | null; name?: string | null };
  damageFeeAmount?: number | null;
  damageFeeBills?: ReceivableBillRow[];
  damageFeeDeductedAmount?: number | null;
  damageFeePaidAmount?: number | null;
  damageFeeRemainingAmount?: number | null;
  damages?: DepositSettlementDamage[];
  deductibleAmount?: number | null;
  deductedAmount?: number | null;
  depositLedgers?: DepositLedgerRow[];
  latestLedger?: DepositLedgerRow | null;
  orderId: string;
  orderNo: string;
  refundableAmount?: number | null;
  refundedAmount?: number | null;
  releasedAmount?: number | null;
}

interface DeductDepositFormValues {
  amountYuan?: number;
  billId?: string;
  remark?: string;
}

interface RefundDepositFormValues {
  amountYuan?: number;
  remark?: string;
}

interface PrepareReturnFormValues {
  remark?: string;
  returnLocation?: string;
  returnType?: string;
  scheduledAt?: Dayjs;
}

interface ConfirmReturnDamageFormValues {
  damageLevel?: string;
  damageType?: string;
  description?: string;
  estimatedRepairAmount?: number;
  photoUrlsText?: string;
  responsibleParty?: string;
}

interface ConfirmReturnFormValues {
  batteryCheckedConfirmed?: boolean;
  chargingEquipmentReturnedConfirmed?: boolean;
  cleaningRequired?: boolean;
  customerItemsClearedConfirmed?: boolean;
  damageFound?: boolean;
  damages?: ConfirmReturnDamageFormValues[];
  exteriorCheckedConfirmed?: boolean;
  interiorCheckedConfirmed?: boolean;
  keysReturnedConfirmed?: boolean;
  maintenanceRequired?: boolean;
  mileageConfirmed?: boolean;
  remark?: string;
  returnMileageKm?: number;
  returnType?: string;
  returnedAt?: Dayjs;
  vehicleDocumentsReturnedConfirmed?: boolean;
  violationCheckedConfirmed?: boolean;
}

interface OrderEntitlementAccount {
  accountNo: string;
  accountStatus: string;
  createdAt?: string | null;
  customerId: string;
  id: string;
  orderId: string;
  periodEnd?: string | null;
  periodStart?: string | null;
  snapshot?: unknown;
  subscriptionPlanId?: string | null;
}

interface OrderEntitlementGrant {
  entitlementName: string;
  entitlementType: string;
  grantNo: string;
  grantPeriodEnd?: string | null;
  grantPeriodStart?: string | null;
  grantSource: string;
  id: string;
  latestUsageAt?: string | null;
  remainingAmount?: number | null;
  remark?: string | null;
  snapshot?: unknown;
  status: string;
  totalAmount?: number | null;
  unit: string;
  usedAmount?: number | null;
}

interface OrderEntitlementsResponse {
  account: OrderEntitlementAccount | null;
  grants: OrderEntitlementGrant[];
}

interface OrderEntitlementUsage {
  createdAt?: string | null;
  entitlementName: string;
  entitlementType: string;
  externalRefNo?: string | null;
  grantId: string;
  id: string;
  occurredAt?: string | null;
  remark?: string | null;
  scenario?: string | null;
  unit: string;
  usageNo: string;
  usageSource: string;
  usageStatus: string;
  usedAmount?: number | null;
}

interface OrderEntitlementUsageResponse {
  items: OrderEntitlementUsage[];
  page: number;
  pageSize: number;
  total: number;
}

interface ConsumeEntitlementFormValues {
  externalRefNo?: string;
  occurredAt?: Dayjs;
  remark?: string;
  scenario?: string;
  usageSource?: string;
  usedAmount?: number;
}

interface EntitlementOperationFormValues {
  asOfDate?: Dayjs;
  dryRun?: boolean;
}

interface EntitlementOperationItem {
  action?: string | null;
  entitlementName?: string | null;
  entitlementType?: string | null;
  grantCount?: number | null;
  grantId?: string | null;
  grantNo?: string | null;
  orderId?: string | null;
  orderNo?: string | null;
  periodEnd?: string | null;
  periodStart?: string | null;
  reason?: string | null;
  rowKey?: string;
  status?: string | null;
  unit?: string | null;
}

interface EntitlementRenewalGrantPreview {
  entitlementName?: string | null;
  entitlementType?: string | null;
  remainingAmount?: number | null;
  rowKey?: string;
  totalAmount?: number | null;
  unit?: string | null;
  usedAmount?: number | null;
}

interface EntitlementRenewalResponse extends EntitlementOperationItem {
  dryRun?: boolean;
  failedCount?: number | null;
  generatedCount?: number | null;
  grantIds?: string[];
  grants?: EntitlementRenewalGrantPreview[];
  items?: EntitlementOperationItem[];
  skippedCount?: number | null;
}

interface ExpireEntitlementsResponse {
  dryRun?: boolean;
  expiredCount?: number | null;
  items?: EntitlementOperationItem[];
  skippedCount?: number | null;
}

type SnapshotRecord = Record<string, unknown>;

const ORDER_SOURCE_LABELS: Record<string, string> = {
  CUSTOMER_SELF_SERVICE: "客户自动下单",
  SALES_ASSISTED: "销售手动下单"
};

const PRE_CONTRACT_CHANGE_ORDER_STATUSES = new Set([
  "PENDING_REVIEW",
  "PENDING_CUSTOMER_CONFIRMATION",
  "PENDING_CONTRACT",
  "PENDING_SIGN",
  "PENDING_PAYMENT",
  "PENDING_VEHICLE",
  "PENDING_DELIVERY"
]);

const DELIVERY_PREPARE_ORDER_STATUSES = new Set([
  "PENDING_PAYMENT",
  "PENDING_VEHICLE",
  "PENDING_DELIVERY"
]);

const FINANCE_FINAL_ORDER_STATUSES = new Set(["CANCELLED", "TERMINATED", "COMPLETED", "REJECTED"]);

const INITIAL_BILL_TYPES = new Set(["DEPOSIT", "FIRST_MONTHLY_FEE"]);
const TERMINAL_HANDOVER_WORK_ORDER_STATUSES = new Set(["VOIDED", "FAILED", "CANCELLED"]);

const paymentMethodOptions = [
  { label: PAYMENT_METHOD_LABELS.BANK_TRANSFER, value: "BANK_TRANSFER" },
  { label: PAYMENT_METHOD_LABELS.WECHAT, value: "WECHAT" },
  { label: PAYMENT_METHOD_LABELS.ALIPAY, value: "ALIPAY" },
  { label: PAYMENT_METHOD_LABELS.CASH, value: "CASH" },
  { label: PAYMENT_METHOD_LABELS.OTHER, value: "OTHER" }
];

const entitlementUsageSourceOptions = [
  { label: ENTITLEMENT_USAGE_SOURCE_LABELS.MANUAL, value: "MANUAL" },
  { label: ENTITLEMENT_USAGE_SOURCE_LABELS.SYSTEM, value: "SYSTEM" },
  { label: ENTITLEMENT_USAGE_SOURCE_LABELS.THIRD_PARTY, value: "THIRD_PARTY" }
];

const entitlementOperationActionLabels: Record<string, string> = {
  DRY_RUN_FAILED: "试算失败",
  DRY_RUN_GENERATE: "试算可生成",
  DRY_RUN_SKIP: "试算跳过",
  DRY_RUN_EXPIRE: "试算将过期",
  EXPIRED: "已过期",
  FAILED: "失败",
  GENERATED: "已生成",
  SKIPPED_EXISTING: "已存在",
  SKIPPED_NOT_DUE: "未到续发日期"
};

const returnTypeOptions = [
  { label: "正常到期退车", value: "NORMAL_RETURN" },
  { label: "提前终止退车", value: "EARLY_TERMINATION" }
];

const damageTypeOptions = [
  { label: "外观", value: "EXTERIOR" },
  { label: "内饰", value: "INTERIOR" },
  { label: "电池", value: "BATTERY" },
  { label: "轮胎", value: "TIRE" },
  { label: "玻璃", value: "GLASS" },
  { label: "底盘", value: "CHASSIS" },
  { label: "随车设备", value: "EQUIPMENT" },
  { label: "其他", value: "OTHER" }
];

const damageLevelOptions = [
  { label: "轻微", value: "MINOR" },
  { label: "中等", value: "MEDIUM" },
  { label: "严重", value: "SEVERE" }
];

const responsiblePartyOptions = [
  { label: "客户", value: "CUSTOMER" },
  { label: "平台", value: "PLATFORM" },
  { label: "第三方", value: "THIRD_PARTY" },
  { label: "未确认", value: "UNKNOWN" }
];

const reviewStatusColors: Record<string, string> = {
  APPROVED: "green",
  CONFIRMED: "green",
  NEED_MORE_INFO: "orange",
  PENDING: "blue",
  PENDING_CONFIRM: "orange",
  REJECTED: "red"
};

const billStatusColors: Record<string, string> = {
  CANCELLED: "default",
  OVERDUE: "red",
  PAID: "green",
  PARTIALLY_PAID: "orange",
  PENDING: "blue"
};

const entitlementAccountStatusColors: Record<string, string> = {
  ACTIVE: "green",
  CLOSED: "default",
  SUSPENDED: "orange"
};

const entitlementGrantStatusColors: Record<string, string> = {
  ACTIVE: "green",
  CANCELLED: "default",
  EXHAUSTED: "purple",
  EXPIRED: "red"
};

const entitlementUsageStatusColors: Record<string, string> = {
  CANCELLED: "default",
  CONFIRMED: "green"
};

const customerGradeOptions = [
  { label: "A", value: "A" },
  { label: "B", value: "B" },
  { label: "C", value: "C" }
];

function formatYuan(value?: unknown) {
  const amount = toNumber(value);
  if (amount === null) {
    return "-";
  }

  return `${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })} 元`;
}

function centsToYuan(value?: unknown) {
  const amount = toNumber(value);
  return amount === null ? undefined : Number((amount / 100).toFixed(2));
}

function yuanToCents(value?: unknown) {
  const amount = toNumber(value);
  return amount === null ? undefined : Math.round(amount * 100);
}

function formatTime(value?: unknown) {
  return typeof value === "string" && value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function formatHandoverType(value?: string | null) {
  if (value === "DELIVERY_OUTBOUND") {
    return "交付出库";
  }
  if (value === "RETURN_INBOUND") {
    return "退租入库";
  }
  return value || "-";
}

function formatHandoverWorkOrderStatus(value?: string | null) {
  const labels: Record<string, string> = {
    ASSIGNED: "已分配",
    CUSTOMER_CONFIRMED: "客户已确认",
    CUSTOMER_OBJECTED: "客户有异议",
    CUSTOMER_REVIEWING: "客户复核中",
    CUSTOMER_SIGNED: "客户已签署",
    DRAFT: "草稿",
    EVIDENCE_SUBMITTED: "资料已提交",
    FIELD_COMPLETED: "现场已完成",
    FIELD_IN_PROGRESS: "现场处理中",
    OPS_REVIEW_PENDING: "运营复核中",
    OPS_REVIEWED: "运营已复核",
    PLATFORM_SEALED: "平台已盖章",
    SIGNING: "签署中"
  };
  return value ? labels[value] ?? value : "-";
}

function formatAdminReviewStatus(value?: string | null) {
  const labels: Record<string, string> = {
    ACKNOWLEDGED: "已受理异议",
    RESOLVED: "已处理",
    RESUBMISSION_REQUESTED: "已要求现场重提",
    RESUBMITTED_PENDING_ADMIN: "现场已重提，待后台送回",
    SENT_BACK_TO_CUSTOMER_REVIEW: "已送回客户复核"
  };
  return value ? labels[value] ?? value : "无后台处理";
}

function formatHandoverAttemptStatus(value?: string | null) {
  const labels: Record<string, string> = {
    CUSTOMER_CONFIRMED: "客户已确认",
    CUSTOMER_OBJECTED: "客户已提异议",
    CUSTOMER_REVIEWING: "客户复核中",
    RESUBMISSION_REQUESTED: "要求现场重提",
    RESUBMITTED_PENDING_ADMIN: "重提待后台复核",
    SENT_BACK_TO_CUSTOMER_REVIEW: "送回客户复核"
  };
  return value ? labels[value] ?? value : "-";
}

function formatHandoverEventType(value?: string | null) {
  const labels: Record<string, string> = {
    CUSTOMER_CONFIRMED: "客户确认无异议",
    CUSTOMER_OBJECTED: "客户提交异议",
    CUSTOMER_REVIEW_STARTED: "进入客户复核",
    CUSTOMER_SIGNED: "客户完成签署",
    EVIDENCE_FILE_ADDED: "现场新增资料",
    EVIDENCE_FILE_REMOVED: "现场删除资料",
    EVIDENCE_FILE_REPLACED: "现场替换资料",
    EXTERNAL_ACCESS_REVOKED: "撤销 Field 访问",
    EXTERNAL_OPERATOR_ASSIGNED: "指派外部 Field",
    FIELD_FACTS_UPDATED: "更新现场信息",
    FIELD_COMPLETED: "完成现场交接",
    FIELD_RESUBMITTED: "现场复检资料重提",
    FIELD_STARTED: "开始现场采集",
    FIELD_SUBMITTED: "提交现场资料",
    INTERNAL_OPERATOR_ASSIGNED: "指派内部交付员",
    NO_VISIBLE_DAMAGE_DECLARED: "声明无可见损伤",
    OBJECTION_ACKNOWLEDGED: "后台受理异议",
    OPS_REVIEW_UPDATED: "更新运营复核",
    PLATFORM_SEALED: "平台完成盖章",
    RESUBMISSION_REQUESTED: "后台要求现场复检",
    SENT_BACK_TO_CUSTOMER_REVIEW: "后台送回客户复核",
    WORK_ORDER_CREATED: "创建交付工单",
    WORK_ORDER_TERMINATED: "终止交付工单"
  };
  return value ? labels[value] ?? value : "-";
}

function formatHandoverEventActor(event: HandoverEvent) {
  if (event.actorDisplay) {
    return event.actorDisplay;
  }
  const labels: Record<string, string> = {
    ADMIN: "后台人员",
    CUSTOMER: "客户",
    FIELD_OPERATOR: "Field 交付人员",
    SYSTEM: "系统"
  };
  return event.actorType ? labels[event.actorType] ?? event.actorType : "-";
}

const handoverFieldFactOptions = [
  { label: "交接里程", value: "handoverMileageKm" },
  { label: "能源状态", value: "energyLevelText" },
  { label: "油量状态", value: "fuelLevelText" },
  { label: "交接地点", value: "deliveryLocation" },
  { label: "随车物品", value: "accessoryChecklist" },
  { label: "损伤状态", value: "damageDeclared" },
  { label: "无可见损伤声明", value: "noVisibleDamageDeclared" },
  { label: "现场备注", value: "fieldNotes" },
  { label: "预约时间", value: "scheduledAt" }
];

function formatHandoverEvidenceProgress(progress?: HandoverWorkOrderSummary["evidenceProgress"]) {
  if (!progress) {
    return "资料 -";
  }
  return `资料 ${numberOrZero(progress.uploaded)}/${numberOrZero(progress.total)}，必传 ${numberOrZero(progress.required)}`;
}

function isActiveHandoverWorkOrder(workOrder: HandoverWorkOrderSummary) {
  return !TERMINAL_HANDOVER_WORK_ORDER_STATUSES.has(String(workOrder.status ?? ""));
}

function formatHandoverEvidenceStatus(item: HandoverEvidenceItem) {
  if (item.reviewStatus === "REJECTED" || item.status === "REJECTED") {
    return "已驳回";
  }
  if (item.reviewStatus === "APPROVED" || item.status === "APPROVED") {
    return "已通过";
  }
  if (numberOrZero(item.fileCount) > 0 || item.status === "UPLOADED") {
    return "已上传";
  }
  return "待上传";
}

function buildAdminHandoverFileUrl(path?: null | string) {
  if (!path) {
    return null;
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalized = path.startsWith("/api/") ? path.slice(4) : path;
  return `${API_BASE_URL}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

function formatEvidenceFileSize(value?: number | string | null) {
  const size = typeof value === "string" ? Number(value) : value;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return "-";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function numberOrZero(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatDate(value?: unknown) {
  return typeof value === "string" && value ? dayjs(value).format("YYYY-MM-DD") : "-";
}

function hasPositiveAmount(value?: unknown) {
  const amount = toNumber(value);
  return amount !== null && amount > 0;
}

function hasNonNegativeAmount(value?: unknown) {
  const amount = toNumber(value);
  return amount !== null && amount >= 0;
}

function pickPositiveValue(...values: unknown[]) {
  return values.find(hasPositiveAmount);
}

function pickNonNegativeValue(...values: unknown[]) {
  return values.find(hasNonNegativeAmount);
}

function isDeliveryPaymentSatisfied(summary?: FinanceSummary | null) {
  return Boolean(summary?.deliveryPaymentSatisfied ?? summary?.isDeliveryPaymentSatisfied);
}

function validInitialBill(bill: ReceivableBillRow) {
  return INITIAL_BILL_TYPES.has(bill.billType) && bill.billStatus !== "CANCELLED";
}

function validMonthlyRentBill(bill: ReceivableBillRow) {
  return bill.billType === "MONTHLY_RENT" && bill.billStatus !== "CANCELLED";
}

function validDamageFeeBill(bill: ReceivableBillRow) {
  return bill.billType === "DAMAGE_FEE" && bill.billStatus !== "CANCELLED";
}

function getDamageFeeBills(settlement: DepositSettlement | null, bills: ReceivableBillRow[]) {
  const byId = new Map<string, ReceivableBillRow>();

  for (const bill of settlement?.damageFeeBills ?? []) {
    if (validDamageFeeBill(bill)) {
      byId.set(bill.id, bill);
    }
  }

  for (const bill of bills) {
    if (validDamageFeeBill(bill)) {
      byId.set(bill.id, bill);
    }
  }

  return [...byId.values()];
}

function getDepositAvailableBalance(settlement: DepositSettlement | null) {
  return toNumber(settlement?.availableDepositBalance ?? settlement?.availableBalance) ?? 0;
}

function getDamageFeeRemainingAmount(settlement: DepositSettlement | null) {
  return toNumber(settlement?.damageFeeRemainingAmount) ?? 0;
}

function getSuggestedDeductibleAmount(settlement: DepositSettlement | null) {
  return toNumber(settlement?.deductibleAmount) ?? 0;
}

function getSuggestedRefundableAmount(settlement: DepositSettlement | null) {
  return toNumber(settlement?.refundableAmount) ?? 0;
}

function hasBillableCustomerDamage(settlement: DepositSettlement | null) {
  return (settlement?.damages ?? []).some((damage) => {
    if (damage.billable) {
      return true;
    }

    return (
      damage.responsibleParty === "CUSTOMER" &&
      (damage.status === "RECORDED" || damage.status === "CONFIRMED") &&
      hasPositiveAmount(damage.estimatedRepairAmount)
    );
  });
}

function sumBillAmount(bills: ReceivableBillRow[], field: "paidAmount" | "remainingAmount") {
  return bills.reduce((sum, bill) => sum + (toNumber(bill[field]) ?? 0), 0);
}

function formatBillPeriod(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return "-";
  }

  const formattedStart = formatDate(start);
  const formattedEnd = formatDate(end);
  return formattedStart === "-" || formattedEnd === "-" ? "-" : `${formattedStart} 至 ${formattedEnd}`;
}

function formatPercent(value?: unknown) {
  if (typeof value === "string" && value.trim().endsWith("%")) {
    const percent = Number(value.trim().slice(0, -1).replace(/,/g, ""));
    return Number.isFinite(percent) ? `${percent.toFixed(2)}%` : "-";
  }

  const rate = toNumber(value);
  if (rate === null) {
    return "-";
  }

  return `${(rate * 100).toFixed(2)}%`;
}

function formatKilometers(value?: unknown) {
  const kilometers = toNumber(value);
  return kilometers === null ? "-" : `${kilometers.toLocaleString("zh-CN")} km`;
}

function formatKwh(value?: unknown) {
  const kwh = toNumber(value);
  return kwh === null ? "-" : `${kwh.toLocaleString("zh-CN")} kWh`;
}

function formatEntitlementAmount(value: unknown, unit?: string | null) {
  const amount = toNumber(value);
  if (amount === null) {
    return "-";
  }
  const unitLabel = unit ? labelOf(ENTITLEMENT_UNIT_LABELS, unit) : "";
  return `${amount.toLocaleString("zh-CN")} ${unitLabel}`.trim();
}

function formatEntitlementPeriod(start?: string | null, end?: string | null) {
  const formattedStart = formatDate(start);
  const formattedEnd = formatDate(end);
  if (formattedStart === "-" && formattedEnd === "-") {
    return "-";
  }
  return `${formattedStart} 至 ${formattedEnd}`;
}

function todayBusinessDate() {
  return dayjs().startOf("day");
}

function formatOperationAction(action?: string | null) {
  const value = safeText(action);
  return value === "-" ? "-" : entitlementOperationActionLabels[value] ?? value;
}

function formatOperationCount(value?: unknown) {
  const count = toNumber(value);
  return count === null ? "-" : count.toLocaleString("zh-CN");
}

function normalizeEntitlementOperationItems(result?: { items?: EntitlementOperationItem[] } | EntitlementOperationItem | null) {
  if (!result) {
    return [];
  }
  if ("items" in result && Array.isArray(result.items) && result.items.length > 0) {
    return result.items;
  }
  if ("action" in result && result.action) {
    return [result];
  }
  return [];
}

function getRenewalResultText(result?: EntitlementRenewalResponse | null) {
  const item = normalizeEntitlementOperationItems(result)[0] ?? result;
  const action = safeText(item?.action);
  if (action === "GENERATED") {
    return "下一期权益已生成。";
  }
  if (action === "DRY_RUN_GENERATE") {
    return "可生成下一期权益。";
  }
  const reason = safeText(item?.reason);
  if (reason !== "-") {
    return reason;
  }
  return action === "-" ? "权益续发处理完成。" : formatOperationAction(action);
}

function getExpireResultText(result?: ExpireEntitlementsResponse | null) {
  const expiredCount = toNumber(result?.expiredCount) ?? 0;
  if (result?.dryRun) {
    return `当前为试算结果，预计将过期 ${expiredCount.toLocaleString("zh-CN")} 条权益，未修改任何权益状态。`;
  }
  return "过期权益处理完成。";
}

function getConsumeOccurredAtError(grant: OrderEntitlementGrant | null, occurredAt?: Dayjs | null) {
  if (!grant || !occurredAt || !grant.grantPeriodStart || !grant.grantPeriodEnd) {
    return null;
  }
  const occurredDate = occurredAt.startOf("day");
  const periodStart = dayjs(grant.grantPeriodStart).startOf("day");
  const periodEnd = dayjs(grant.grantPeriodEnd).startOf("day");
  if (!periodStart.isValid() || !periodEnd.isValid()) {
    return null;
  }
  if (occurredDate.isBefore(periodStart) || occurredDate.isAfter(periodEnd)) {
    return "消耗时间不在权益有效期内";
  }
  return null;
}

function isGrantPastEffectivePeriod(grant: OrderEntitlementGrant) {
  if (grant.status !== "ACTIVE" || !grant.grantPeriodEnd) {
    return false;
  }
  const periodEnd = dayjs(grant.grantPeriodEnd).endOf("day");
  return periodEnd.isValid() && periodEnd.isBefore(dayjs());
}

function entitlementProgressPercent(grant: OrderEntitlementGrant) {
  const totalAmount = toNumber(grant.totalAmount);
  const usedAmount = toNumber(grant.usedAmount) ?? 0;
  if (totalAmount === null || totalAmount <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, Number(((usedAmount / totalAmount) * 100).toFixed(1))));
}

function isTextEntitlement(grant: OrderEntitlementGrant) {
  return grant.unit === "TEXT";
}

function getEntitlementPlanText(account: OrderEntitlementAccount | null) {
  if (!account) {
    return "-";
  }
  const planNo = getSnapshotValue(account.snapshot, "packageSnapshot.subscriptionPlan.planNo", "sourceSnapshot.subscriptionPlan.planNo");
  const planName = getSnapshotValue(account.snapshot, "packageSnapshot.subscriptionPlan.planName", "sourceSnapshot.subscriptionPlan.planName");
  return joinText(planNo, planName, account.subscriptionPlanId);
}

function formatBatteryUsageType(type?: unknown, label?: unknown) {
  const labelText = safeText(label);
  if (labelText !== "-") {
    return labelText;
  }
  const typeText = safeText(type);
  return typeText === "-" ? "-" : labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, typeText);
}

function formatCount(value?: unknown) {
  const count = toNumber(value);
  return count === null ? "-" : `${count.toLocaleString("zh-CN")} 次`;
}

function formatMonths(value?: unknown) {
  const months = toNumber(value);
  return months === null ? "-" : `${months.toLocaleString("zh-CN")} 个月`;
}

function safeText(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    return "-";
  }
  return String(value);
}

function orderModelDisplay(order?: OrderDetail | null) {
  return safeText(
    order?.modelDisplayName ??
      order?.modelDisplayNameSnapshot ??
      order?.vehicle?.modelDisplayName ??
      order?.modelCodeSnapshot
  );
}

function parsePhotoUrls(value?: string) {
  if (!value) {
    return [];
  }
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function photoUrlsToText(value?: string[] | null) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function normalizePhotoUrls(value?: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function toNumber(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(/,/g, "").replace(/%$/, "");
    if (!normalized) {
      return null;
    }
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function toSnapshotRecord(value: unknown): SnapshotRecord | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return toSnapshotRecord(parsed);
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as SnapshotRecord;
  }
  return null;
}

function getSnapshotValue(snapshot: unknown, ...paths: string[]) {
  for (const path of paths) {
    const value = readSnapshotPath(snapshot, path);
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function readSnapshotPath(source: unknown, path: string) {
  let current: unknown = source;

  for (const key of path.split(".")) {
    const record = toSnapshotRecord(current);
    if (!record || !(key in record)) {
      return undefined;
    }
    current = record[key];
  }

  return current;
}

function joinText(...values: unknown[]) {
  const parts = values
    .map((value) => safeText(value))
    .filter((value, index, array) => value !== "-" && array.indexOf(value) === index);

  return parts.length > 0 ? parts.join(" / ") : "-";
}

function formatVehicleBaseFeeModeLabel(mode?: unknown, label?: unknown) {
  const explicitLabel = safeText(label);
  if (explicitLabel !== "-") {
    return explicitLabel;
  }
  const modeKey = safeText(mode);
  if (modeKey === "-") {
    return "-";
  }
  return VEHICLE_BASE_FEE_MODE_LABELS[modeKey] ?? modeKey;
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const text = error.message.trim();
    if (!text || text === "Internal Server Error" || text === "Bad Request") {
      return "操作失败，请稍后重试";
    }
    return text;
  }
  return "操作失败，请稍后重试";
}

function ReviewStatusTag({ value }: { value?: string }) {
  return value ? (
    <Tag color={reviewStatusColors[value]}>{labelOf(STATUS_LABELS, value)}</Tag>
  ) : (
    <Tag>-</Tag>
  );
}

function BooleanTag({ checked }: { checked?: boolean }) {
  return checked ? <Tag color="green">已确认</Tag> : <Tag>未确认</Tag>;
}

function DeliveryStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }

  const colors: Record<string, string> = {
    CANCELLED: "red",
    DELIVERED: "green",
    PENDING: "blue",
    READY: "orange"
  };

  return <Tag color={colors[value]}>{labelOf(DELIVERY_STATUS_LABELS, value)}</Tag>;
}

function ReturnStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }

  const colors: Record<string, string> = {
    CANCELLED: "red",
    CONFIRMED: "green",
    PENDING: "blue",
    READY: "orange"
  };

  return <Tag color={colors[value]}>{labelOf(VEHICLE_RETURN_STATUS_LABELS, value)}</Tag>;
}

function BillStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }

  return <Tag color={billStatusColors[value]}>{labelOf(BILL_STATUS_LABELS, value)}</Tag>;
}

function EntitlementAccountStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }
  return <Tag color={entitlementAccountStatusColors[value]}>{labelOf(ENTITLEMENT_ACCOUNT_STATUS_LABELS, value)}</Tag>;
}

function EntitlementGrantStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }
  return <Tag color={entitlementGrantStatusColors[value]}>{labelOf(ENTITLEMENT_GRANT_STATUS_LABELS, value)}</Tag>;
}

function EntitlementUsageStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }
  return <Tag color={entitlementUsageStatusColors[value]}>{labelOf(ENTITLEMENT_USAGE_STATUS_LABELS, value)}</Tag>;
}

function DamageStatusTag({ value }: { value?: string | null }) {
  if (!value) {
    return <Tag>-</Tag>;
  }

  const colors: Record<string, string> = {
    CONFIRMED: "green",
    RECORDED: "blue",
    SETTLED: "purple",
    WAIVED: "default"
  };

  return <Tag color={colors[value]}>{labelOf(VEHICLE_RETURN_DAMAGE_STATUS_LABELS, value)}</Tag>;
}

function canFinalizeOrder(order: OrderDetail) {
  return (
    ["PENDING_REVIEW", "PENDING_CUSTOMER_CONFIRMATION"].includes(order.orderStatus) &&
    order.creditReviewStatus === "APPROVED" &&
    order.productReviewStatus === "APPROVED" &&
    order.vehicleReviewStatus === "APPROVED" &&
    order.depositStatus === "CONFIRMED" &&
    order.finalDepositAmount !== null &&
    order.finalDepositAmount !== undefined
  );
}

function getGenerateEntitlementDisabledReason(order: OrderDetail | null, account: OrderEntitlementAccount | null) {
  if (!order) {
    return "数据加载完成后才能操作";
  }
  if (account?.accountStatus === "ACTIVE") {
    return "该订单已生成权益账户";
  }
  if (order.orderStatus !== "ACTIVE") {
    return "当前订单尚未起租，不能生成权益";
  }
  if (!order.actualDeliveryAt) {
    return "当前订单缺少实际交付时间，不能生成权益";
  }
  return null;
}

function getRenewMonthlyEntitlementDisabledReason(order: OrderDetail | null, account: OrderEntitlementAccount | null) {
  if (!order) {
    return "数据加载完成后才能操作";
  }
  if (order.orderStatus !== "ACTIVE") {
    return "当前订单不是在租状态，不能续发权益";
  }
  if (!order.actualDeliveryAt) {
    return "当前订单缺少实际交付时间，不能续发权益";
  }
  if (account?.accountStatus !== "ACTIVE") {
    return "请先生成订单权益账户";
  }
  return null;
}

function getConsumeEntitlementDisabledReason(
  order: OrderDetail,
  account: OrderEntitlementAccount | null,
  grant: OrderEntitlementGrant
) {
  if (grant.status === "EXPIRED") {
    return "权益已过期，不能消耗";
  }
  if (grant.status === "EXHAUSTED") {
    return "当前权益已用尽";
  }
  if (grant.status === "CANCELLED") {
    return "权益已取消，不能消耗";
  }
  if (order.orderStatus !== "ACTIVE") {
    return "当前订单不是在租状态";
  }
  if (account?.accountStatus !== "ACTIVE") {
    return "权益账户不是生效中";
  }
  if (grant.status !== "ACTIVE") {
    return "当前权益不可用";
  }
  if (isTextEntitlement(grant)) {
    return "文本型权益不支持消耗核销";
  }
  if ((toNumber(grant.remainingAmount) ?? 0) <= 0) {
    return "当前权益已用尽";
  }
  return null;
}

function ReviewPanel({
  canConfirmFinalPlan,
  canRejectOrder,
  canReviewCredit,
  canReviewProduct,
  canReviewVehicle,
  creditForm,
  onConfirmCustomer,
  onFinalizePlan,
  onRejectOrder,
  onReview,
  order
}: {
  canConfirmFinalPlan: boolean;
  canRejectOrder: boolean;
  canReviewCredit: boolean;
  canReviewProduct: boolean;
  canReviewVehicle: boolean;
  creditForm: ReturnType<typeof Form.useForm<{ customerGrade: string }>>[0];
  onConfirmCustomer: () => Promise<void>;
  onFinalizePlan: () => Promise<void>;
  onRejectOrder: () => Promise<void>;
  onReview: (type: "credit" | "product" | "vehicle", status: "APPROVED" | "NEED_MORE_INFO" | "REJECTED") => Promise<void>;
  order: OrderDetail;
}) {
  if (order.orderSource !== "CUSTOMER_SELF_SERVICE") {
    return null;
  }

  const canReviewPendingOrder = order.orderStatus === "PENDING_REVIEW";

  return (
    <Card title="订单申请审核">
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Descriptions
          bordered
          column={3}
          items={[
            { label: "订单来源", children: ORDER_SOURCE_LABELS[order.orderSource] ?? order.orderSource },
            { label: "客户资质审核", children: <ReviewStatusTag value={order.creditReviewStatus} /> },
            { label: "产品匹配审核", children: <ReviewStatusTag value={order.productReviewStatus} /> },
            { label: "车辆库存审核", children: <ReviewStatusTag value={order.vehicleReviewStatus} /> },
            { label: "押金状态", children: <ReviewStatusTag value={order.depositStatus} /> },
            { label: "最终押金", children: formatYuan(order.finalDepositAmount ?? order.depositAmount) },
            { label: "最终方案确认时间", children: formatTime(order.finalPlanConfirmedAt) },
            { label: "客户确认时间", children: formatTime(order.customerConfirmedAt) },
            { label: "车辆", children: order.vehicle ? joinText(order.vehicle.vehicleNo, order.vehicle.plateNo, order.vehicle.vin) : "-" }
          ]}
        />

        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          {canReviewCredit && canReviewPendingOrder ? (
            <Space wrap>
              <Typography.Text strong>客户资质审核</Typography.Text>
              <Form form={creditForm} initialValues={{ customerGrade: "A" }} layout="inline">
                <Form.Item name="customerGrade" rules={[{ required: true, message: "请选择客户等级" }]}>
                  <Select options={customerGradeOptions} style={{ width: 96 }} />
                </Form.Item>
              </Form>
              <Button onClick={() => onReview("credit", "APPROVED")} size="small" type="primary">
                通过
              </Button>
              <Button onClick={() => onReview("credit", "NEED_MORE_INFO")} size="small">
                补资料
              </Button>
              <Button danger onClick={() => onReview("credit", "REJECTED")} size="small">
                拒绝
              </Button>
            </Space>
          ) : null}

          {canReviewProduct && canReviewPendingOrder ? (
            <Space wrap>
              <Typography.Text strong>产品匹配审核</Typography.Text>
              <Button onClick={() => onReview("product", "APPROVED")} size="small" type="primary">
                通过
              </Button>
              <Button danger onClick={() => onReview("product", "REJECTED")} size="small">
                拒绝
              </Button>
            </Space>
          ) : null}

          {canReviewVehicle && canReviewPendingOrder ? (
            <Space wrap>
              <Typography.Text strong>车辆库存审核</Typography.Text>
              <Button onClick={() => onReview("vehicle", "APPROVED")} size="small" type="primary">
                通过
              </Button>
              <Button danger onClick={() => onReview("vehicle", "REJECTED")} size="small">
                拒绝
              </Button>
            </Space>
          ) : null}

          <Space wrap>
            <Typography.Text strong>最终方案确认</Typography.Text>
            {canConfirmFinalPlan && canFinalizeOrder(order) ? (
              <Button onClick={onFinalizePlan} size="small" type="primary">
                确认最终方案
              </Button>
            ) : null}
            {canConfirmFinalPlan && order.orderStatus === "PENDING_CUSTOMER_CONFIRMATION" ? (
              <Button onClick={onConfirmCustomer} size="small">
                后台代客户确认并进入签约
              </Button>
            ) : null}
            {canRejectOrder && ["PENDING_REVIEW", "PENDING_CUSTOMER_CONFIRMATION"].includes(order.orderStatus) ? (
              <Button danger onClick={onRejectOrder} size="small">
                拒绝订单
              </Button>
            ) : null}
          </Space>
        </Space>
      </Space>
    </Card>
  );
}

function QuoteSnapshotSection({ order }: { order: OrderDetail | null }) {
  if (!order) {
    return null;
  }

  const snapshot = toSnapshotRecord(order.quoteSnapshot);
  const quoteStatus = safeText(getSnapshotValue(snapshot, "status"));
  const vehicleSnapshot = getSnapshotValue(snapshot, "vehicleSnapshot", "vehicle");
  const packageSnapshot = getSnapshotValue(snapshot, "packageSnapshot");
  const depositRuleSnapshot = getSnapshotValue(snapshot, "depositRuleSnapshot");
  const riskSnapshot = getSnapshotValue(snapshot, "riskResult");

  const currentVehicleSalePrice = getSnapshotValue(
    snapshot,
    "vehicleSnapshot.currentSalePriceAmount",
    "vehicle.currentSalePriceAmount",
    "vehicleSalePriceAmount"
  );
  const vehiclePackageRate = getSnapshotValue(
    snapshot,
    "packageSnapshot.vehiclePackage.monthlyFeeRate",
    "monthlyFeeRate",
    "packageSnapshot.subscriptionPlan.monthlyFeeRate"
  );
  const vehicleBaseFeeMode = getSnapshotValue(
    snapshot,
    "vehicleBaseFeeMode",
    "packageSnapshot.pricing.vehicleBaseFeeMode",
    "packageSnapshot.vehicleBaseFeeMode",
    "packageSnapshot.subscriptionPlan.monthlyFeeMode"
  );
  const vehicleBaseFeeModeLabel = formatVehicleBaseFeeModeLabel(
    vehicleBaseFeeMode,
    getSnapshotValue(
      snapshot,
      "vehicleBaseFeeModeLabel",
      "packageSnapshot.pricing.vehicleBaseFeeModeLabel",
      "packageSnapshot.vehicleBaseFeeModeLabel",
      "packageSnapshot.subscriptionPlan.monthlyFeeModeLabel"
    )
  );
  const fixedRate =
    getSnapshotValue(snapshot, "fixedRate", "packageSnapshot.pricing.fixedRate") ??
    (vehicleBaseFeeMode === "RATE_FORMULA"
      ? getSnapshotValue(snapshot, "packageSnapshot.subscriptionPlan.monthlyFeeRate", "monthlyFeeRate")
      : undefined);

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Card title="报价基础信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "报价编号", children: safeText(getSnapshotValue(snapshot, "quoteNo") ?? order.quote?.quoteNo) },
            {
              label: "订阅套餐",
              children: joinText(
                getSnapshotValue(snapshot, "subscriptionPlan.planNo", "packageSnapshot.subscriptionPlan.planNo"),
                getSnapshotValue(snapshot, "subscriptionPlan.planName", "packageSnapshot.subscriptionPlan.planName")
              )
            },
            { label: "产品名称", children: safeText(getSnapshotValue(snapshot, "productVersion.product.name", "product.name")) },
            { label: "产品版本", children: safeText(getSnapshotValue(snapshot, "productVersion.versionNo", "productVersion.versionName")) },
            { label: "订阅周期", children: formatMonths(getSnapshotValue(snapshot, "periodMonths") ?? order.periodMonths) },
            {
              label: "报价状态",
              children: quoteStatus === "-" ? "-" : <Tag>{labelOf(STATUS_LABELS, quoteStatus)}</Tag>
            },
            { label: "创建时间", children: formatTime(getSnapshotValue(snapshot, "createdAt")) },
            { label: "确认时间", children: formatTime(getSnapshotValue(snapshot, "confirmedAt")) }
          ]}
        />
      </Card>

      <Card title="车辆信息快照">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "VIN", children: safeText(getSnapshotValue(vehicleSnapshot, "vin") ?? getSnapshotValue(snapshot, "vin")) },
            { label: "车牌号", children: safeText(getSnapshotValue(vehicleSnapshot, "plateNo") ?? getSnapshotValue(snapshot, "plateNo")) },
            { label: "品牌", children: safeText(getSnapshotValue(vehicleSnapshot, "brand") ?? getSnapshotValue(snapshot, "brand")) },
            { label: "车系", children: safeText(getSnapshotValue(vehicleSnapshot, "series") ?? getSnapshotValue(snapshot, "series")) },
            {
              label: "车型",
              children: orderModelDisplay(order)
            },
            {
              label: "电池容量",
              children: formatKwh(
                getSnapshotValue(vehicleSnapshot, "batteryCapacityKwh") ??
                  getSnapshotValue(snapshot, "batteryCapacityKwh")
              )
            },
            {
              label: "电池使用方式",
              children: formatBatteryUsageType(
                getSnapshotValue(vehicleSnapshot, "batteryUsageType") ??
                  getSnapshotValue(snapshot, "batteryUsageType"),
                getSnapshotValue(vehicleSnapshot, "batteryUsageTypeLabel") ??
                  getSnapshotValue(snapshot, "batteryUsageTypeLabel")
              )
            },
            { label: "当前车辆销售价", children: formatYuan(currentVehicleSalePrice) },
            {
              label: "当前里程",
              children: formatKilometers(getSnapshotValue(vehicleSnapshot, "currentMileageKm") ?? getSnapshotValue(snapshot, "currentMileageKm"))
            },
            {
              label: "资产位置",
              children: safeText(getSnapshotValue(vehicleSnapshot, "assetLocation") ?? getSnapshotValue(snapshot, "assetLocation"))
            }
          ]}
        />
      </Card>

      <Card title="套餐与价格明细">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "当前车辆销售价", children: formatYuan(currentVehicleSalePrice) },
            { label: "车辆基础月费模式", children: vehicleBaseFeeModeLabel },
            { label: "车型包系数", children: formatPercent(vehiclePackageRate) },
            { label: "固定费率", children: formatPercent(fixedRate) },
            {
              label: "车辆基础费上限",
              children: formatYuan(
                getSnapshotValue(snapshot, "vehicleBaseFeeCapAmount", "monthlyFeeCapAmount", "packageSnapshot.pricing.vehicleBaseFeeCapAmount")
              )
            },
            {
              label: "车辆基础费报价",
              children: formatYuan(getSnapshotValue(snapshot, "vehicleBaseFeeAmount", "packageSnapshot.pricing.vehicleBaseFeeAmount"))
            },
            {
              label: "里程包价格",
              children: formatYuan(
                getSnapshotValue(snapshot, "mileagePackagePriceAmount", "packageSnapshot.pricing.mileagePackagePriceAmount", "packageSnapshot.mileagePackage.priceAmount")
              )
            },
            {
              label: "补能包价格",
              children: formatYuan(
                getSnapshotValue(snapshot, "energyPackagePriceAmount", "packageSnapshot.pricing.energyPackagePriceAmount", "packageSnapshot.energyPackage.priceAmount")
              )
            },
            {
              label: "权益包价格",
              children: formatYuan(
                getSnapshotValue(snapshot, "benefitPackagePriceAmount", "packageSnapshot.pricing.benefitPackagePriceAmount", "packageSnapshot.benefitPackage.priceAmount")
              )
            },
            {
              label: "套餐月费合计",
              children: formatYuan(getSnapshotValue(snapshot, "monthlyFeeAmount", "packageSnapshot.pricing.monthlyFeeAmount") ?? order.monthlyFeeAmount)
            },
            {
              label: "押金金额",
              children: formatYuan(getSnapshotValue(snapshot, "depositAmount", "depositRuleSnapshot.depositAmount") ?? order.depositAmount)
            },
            {
              label: "违约率",
              children: formatPercent(getSnapshotValue(depositRuleSnapshot, "defaultRate") ?? getSnapshotValue(snapshot, "defaultRate"))
            }
          ]}
        />
        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          车辆基础费上限 = 当前车辆销售价 × 车型包系数。
        </Typography.Paragraph>
        <Typography.Text type="secondary">
          套餐月费合计 = 车辆基础费 + 里程包价格 + 补能包价格 + 权益包价格；车型包系数只约束车辆基础费，不约束套餐月费合计。
        </Typography.Text>
      </Card>

      <Card title="套餐组件快照">
        <Descriptions
          bordered
          column={2}
          items={[
            {
              label: "车型包名称",
              children: joinText(
                getSnapshotValue(packageSnapshot, "vehiclePackage.packageNo"),
                getSnapshotValue(packageSnapshot, "vehiclePackage.packageName")
              )
            },
            {
              label: "里程包名称",
              children: joinText(
                getSnapshotValue(packageSnapshot, "mileagePackage.packageNo"),
                getSnapshotValue(packageSnapshot, "mileagePackage.packageName")
              )
            },
            {
              label: "补能包名称",
              children: joinText(
                getSnapshotValue(packageSnapshot, "energyPackage.packageNo"),
                getSnapshotValue(packageSnapshot, "energyPackage.packageName")
              )
            },
            {
              label: "权益包名称",
              children: joinText(
                getSnapshotValue(packageSnapshot, "benefitPackage.packageNo"),
                getSnapshotValue(packageSnapshot, "benefitPackage.packageName")
              )
            },
            { label: "月里程额度", children: formatKilometers(getSnapshotValue(packageSnapshot, "mileagePackage.monthlyMileageKm") ?? order.mileageLimitKm) },
            { label: "超里程单价", children: formatYuan(getSnapshotValue(packageSnapshot, "mileagePackage.overMileageFeeAmount")) },
            { label: "月补能额度", children: formatKwh(getSnapshotValue(packageSnapshot, "energyPackage.monthlyEnergyKwh")) },
            { label: "月补能次数", children: formatCount(getSnapshotValue(packageSnapshot, "energyPackage.monthlyEnergyCount")) },
            { label: "权益说明", children: safeText(getSnapshotValue(packageSnapshot, "benefitPackage.description")) }
          ]}
        />
      </Card>

      <Card title="押金 / 风控快照">
        <Descriptions
          bordered
          column={2}
          items={[
            {
              label: "客户等级",
              children: safeText(
                getSnapshotValue(snapshot, "customer.grade") ??
                  getSnapshotValue(depositRuleSnapshot, "customerGrade", "grade")
              )
            },
            {
              label: "押金金额",
              children: formatYuan(getSnapshotValue(snapshot, "depositAmount", "depositRuleSnapshot.depositAmount") ?? order.depositAmount)
            },
            {
              label: "违约率",
              children: formatPercent(getSnapshotValue(depositRuleSnapshot, "defaultRate") ?? getSnapshotValue(snapshot, "defaultRate"))
            },
            {
              label: "风控评分",
              children: safeText(
                getSnapshotValue(riskSnapshot, "score", "riskScore") ??
                  getSnapshotValue(snapshot, "riskScore")
              )
            }
          ]}
        />
      </Card>

    </Space>
  );
}

function OrderInfoSections({
  customerLabel,
  customerMobile,
  currentVehicleSalePrice,
  order
}: {
  customerLabel: string;
  customerMobile?: string;
  currentVehicleSalePrice: number | null;
  order: OrderDetail;
}) {
  const snapshot = toSnapshotRecord(order.quoteSnapshot);
  const vehicleSnapshot = getSnapshotValue(snapshot, "vehicleSnapshot", "vehicle");

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Card title="订单基础信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "订单编号", children: safeText(order.orderNo) },
            { label: "订单状态", children: <Tag>{labelOf(ORDER_STATUS_LABELS, order.orderStatus)}</Tag> },
            { label: "订单来源", children: labelOf(ORDER_SOURCE_LABELS, order.orderSource) },
            { label: "订阅周期", children: formatMonths(order.periodMonths) },
            {
              label: "关联进件",
              children: order.application ? (
                <Link href={`/applications/${order.application.id}`}>{order.application.applicationNo}</Link>
              ) : "-"
            },
            {
              label: "关联报价",
              children: order.quote ? <Link href={`/quotes/${order.quote.id}`}>{order.quote.quoteNo}</Link> : "-"
            },
            { label: "创建时间", children: formatTime(order.createdAt) },
            { label: "最终方案确认时间", children: formatTime(order.finalPlanConfirmedAt) }
          ]}
        />
      </Card>

      <Card title="客户信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "客户姓名", children: safeText(customerLabel) },
            { label: "手机号", children: safeText(customerMobile) },
            { label: "客户确认时间", children: formatTime(order.customerConfirmedAt) },
            { label: "押金状态", children: order.depositStatus ? labelOf(STATUS_LABELS, order.depositStatus) : "-" },
            { label: "押金金额", children: formatYuan(order.finalDepositAmount ?? order.depositAmount) },
            { label: "客户资质审核", children: <ReviewStatusTag value={order.creditReviewStatus} /> }
          ]}
        />
      </Card>

      <Card title="车辆信息">
        <Descriptions
          bordered
          column={2}
          items={[
            { label: "车辆编号", children: safeText(order.vehicle?.vehicleNo ?? getSnapshotValue(vehicleSnapshot, "vehicleNo")) },
            { label: "VIN", children: safeText(order.vehicle?.vin ?? getSnapshotValue(vehicleSnapshot, "vin")) },
            { label: "车牌号", children: safeText(order.vehicle?.plateNo ?? getSnapshotValue(vehicleSnapshot, "plateNo")) },
            { label: "车型", children: orderModelDisplay(order) },
            { label: "电池容量", children: formatKwh(order.vehicle?.batteryCapacityKwh ?? getSnapshotValue(vehicleSnapshot, "batteryCapacityKwh")) },
            {
              label: "电池使用方式",
              children: formatBatteryUsageType(
                order.vehicle?.batteryUsageType ?? getSnapshotValue(vehicleSnapshot, "batteryUsageType"),
                order.vehicle?.batteryUsageTypeLabel ?? getSnapshotValue(vehicleSnapshot, "batteryUsageTypeLabel")
              )
            },
            { label: "车辆状态", children: safeText(order.vehicle?.status ?? getSnapshotValue(vehicleSnapshot, "status")) },
            { label: "当前车辆销售价", children: formatYuan(currentVehicleSalePrice) },
            { label: "当前里程", children: formatKilometers(order.vehicle?.currentMileageKm ?? getSnapshotValue(vehicleSnapshot, "currentMileageKm")) },
            { label: "车辆库存审核", children: <ReviewStatusTag value={order.vehicleReviewStatus} /> }
          ]}
        />
      </Card>

    </Space>
  );
}

function EntitlementPanel({
  customerLabel,
  customerMobile,
  entitlements,
  entitlementLoading,
  expiringEntitlements,
  generatingEntitlements,
  onGenerateEntitlements,
  onOpenExpireEntitlements,
  onOpenConsume,
  onOpenMonthlyRenewal,
  onUsagePageChange,
  order,
  permissions,
  renewingEntitlements,
  usageLoading,
  usagePage,
  usagePageSize,
  usageTotal,
  usages
}: {
  customerLabel: string;
  customerMobile?: string;
  entitlements: OrderEntitlementsResponse;
  entitlementLoading: boolean;
  expiringEntitlements: boolean;
  generatingEntitlements: boolean;
  onGenerateEntitlements: () => void;
  onOpenExpireEntitlements: () => void;
  onOpenConsume: (grant: OrderEntitlementGrant) => void;
  onOpenMonthlyRenewal: () => void;
  onUsagePageChange: (page: number, pageSize: number) => void;
  order: OrderDetail;
  permissions: ReadonlySet<string>;
  renewingEntitlements: boolean;
  usageLoading: boolean;
  usagePage: number;
  usagePageSize: number;
  usageTotal: number;
  usages: OrderEntitlementUsage[];
}) {
  const account = entitlements.account;
  const generateDisabledReason = getGenerateEntitlementDisabledReason(order, account);
  const generateAvailability = actionAvailability({
    allowed: generateDisabledReason === null,
    disabledReason: generateDisabledReason ?? "当前订单不能生成权益",
    noPermissionReason: "无生成权益权限",
    permission: "entitlement:generate",
    permissions
  });
  const renewDisabledReason = getRenewMonthlyEntitlementDisabledReason(order, account);
  const renewAvailability = actionAvailability({
    allowed: renewDisabledReason === null,
    disabledReason: renewDisabledReason ?? "当前订单不能续发权益",
    noPermissionReason: "无权益续发权限",
    permission: "entitlement:generate",
    permissions
  });
  const expireAvailability = actionAvailability({
    allowed: true,
    disabledReason: "当前不能处理过期权益",
    noPermissionReason: "无权益过期处理权限",
    permission: "entitlement:adjust",
    permissions
  });
  const hasPastActiveGrant = entitlements.grants.some(isGrantPastEffectivePeriod);
  const grantColumns: ColumnsType<OrderEntitlementGrant> = [
    { dataIndex: "grantNo", title: "权益编号", width: 180 },
    {
      dataIndex: "entitlementType",
      render: (value: string) => labelOf(ENTITLEMENT_TYPE_LABELS, value),
      title: "权益类型",
      width: 110
    },
    { dataIndex: "entitlementName", render: safeText, title: "权益名称", width: 180 },
    {
      dataIndex: "totalAmount",
      render: (value: unknown, record) => isTextEntitlement(record) ? "文本权益" : formatEntitlementAmount(value, record.unit),
      title: "总量",
      width: 120
    },
    {
      dataIndex: "usedAmount",
      render: (value: unknown, record) => isTextEntitlement(record) ? "-" : formatEntitlementAmount(value, record.unit),
      title: "已用",
      width: 120
    },
    {
      dataIndex: "remainingAmount",
      render: (value: unknown, record) => isTextEntitlement(record) ? "文本权益" : formatEntitlementAmount(value, record.unit),
      title: "剩余",
      width: 120
    },
    {
      dataIndex: "unit",
      render: (value: string) => labelOf(ENTITLEMENT_UNIT_LABELS, value),
      title: "单位",
      width: 100
    },
    {
      dataIndex: "status",
      render: (value: string) => <EntitlementGrantStatusTag value={value} />,
      title: "状态",
      width: 100
    },
    {
      dataIndex: "grantSource",
      render: (value: string) => labelOf(ENTITLEMENT_GRANT_SOURCE_LABELS, value),
      title: "来源",
      width: 110
    },
    {
      render: (_, record) => formatEntitlementPeriod(record.grantPeriodStart, record.grantPeriodEnd),
      title: "有效期",
      width: 180
    },
    { dataIndex: "remark", render: safeText, title: "备注", width: 160 },
    {
      render: (_, record) => {
        const disabledReason = getConsumeEntitlementDisabledReason(order, account, record);
        const availability = actionAvailability({
          allowed: disabledReason === null,
          disabledReason: disabledReason ?? "当前权益不能消耗",
          noPermissionReason: "无权益消耗权限",
          permission: "entitlement:consume",
          permissions
        });
        return (
          <ActionButton availability={availability} onClick={() => onOpenConsume(record)} size="small">
            消耗权益
          </ActionButton>
        );
      },
      title: "操作",
      width: 120
    }
  ];
  const usageColumns: ColumnsType<OrderEntitlementUsage> = [
    { dataIndex: "usageNo", title: "流水编号", width: 180 },
    {
      dataIndex: "entitlementType",
      render: (value: string) => labelOf(ENTITLEMENT_TYPE_LABELS, value),
      title: "权益类型",
      width: 110
    },
    { dataIndex: "entitlementName", render: safeText, title: "权益名称", width: 180 },
    {
      render: (_, record) => formatEntitlementAmount(record.usedAmount, record.unit),
      title: "消耗数量",
      width: 120
    },
    {
      dataIndex: "unit",
      render: (value: string) => labelOf(ENTITLEMENT_UNIT_LABELS, value),
      title: "单位",
      width: 100
    },
    {
      dataIndex: "usageStatus",
      render: (value: string) => <EntitlementUsageStatusTag value={value} />,
      title: "消耗状态",
      width: 110
    },
    {
      dataIndex: "usageSource",
      render: (value: string) => labelOf(ENTITLEMENT_USAGE_SOURCE_LABELS, value),
      title: "消耗来源",
      width: 110
    },
    { dataIndex: "occurredAt", render: formatTime, title: "发生时间", width: 160 },
    { dataIndex: "externalRefNo", render: safeText, title: "外部流水号", width: 180 },
    { dataIndex: "scenario", render: safeText, title: "使用场景", width: 180 },
    { dataIndex: "remark", render: safeText, title: "备注", width: 180 },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间", width: 160 }
  ];

  return (
    <Card
      extra={
        <Space wrap>
          <ActionButton
            availability={generateAvailability}
            loading={generatingEntitlements}
            onClick={onGenerateEntitlements}
            type="primary"
          >
            生成订单权益
          </ActionButton>
          <ActionButton
            availability={renewAvailability}
            icon={<ReloadOutlined />}
            loading={renewingEntitlements}
            onClick={onOpenMonthlyRenewal}
          >
            生成下一期权益
          </ActionButton>
          <ActionButton
            availability={expireAvailability}
            icon={<ClockCircleOutlined />}
            loading={expiringEntitlements}
            onClick={onOpenExpireEntitlements}
          >
            处理过期权益（全局）
          </ActionButton>
        </Space>
      }
      title="订阅权益"
    >
      <Spin spinning={entitlementLoading}>
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          {account ? (
            <Descriptions
              bordered
              column={3}
              items={[
                { label: "权益账户编号", children: safeText(account.accountNo) },
                { label: "账户状态", children: <EntitlementAccountStatusTag value={account.accountStatus} /> },
                { label: "订单编号", children: safeText(order.orderNo) },
                { label: "客户", children: joinText(customerLabel, customerMobile) },
                { label: "订阅套餐", children: getEntitlementPlanText(account) },
                { label: "权益周期开始", children: formatDate(account.periodStart) },
                { label: "权益周期结束", children: formatDate(account.periodEnd) },
                { label: "创建时间", children: formatTime(account.createdAt) }
              ]}
            />
          ) : (
            <Alert message="当前订单尚未生成权益账户" showIcon type="info" />
          )}

          {entitlements.grants.some(isTextEntitlement) ? (
            <Alert message="文本型权益仅展示说明，不支持消耗核销。" showIcon type="info" />
          ) : null}
          <Alert
            showIcon
            title="处理过期权益（全局）会处理所有已超过有效期的权益，不限于当前订单。"
            type="warning"
          />
          {hasPastActiveGrant ? (
            <Alert showIcon title="该订单存在已超过有效期但尚未处理的可用权益，建议先处理过期权益。" type="warning" />
          ) : null}

          <Table<OrderEntitlementGrant>
            columns={grantColumns}
            dataSource={entitlements.grants}
            expandable={{
              expandedRowRender: (record) => <EntitlementGrantBalance grant={record} />,
              rowExpandable: () => true
            }}
            pagination={false}
            rowKey="id"
            scroll={{ x: 1500 }}
          />

          <Typography.Title level={5} style={{ margin: 0 }}>
            权益消耗流水
          </Typography.Title>
          <Table<OrderEntitlementUsage>
            columns={usageColumns}
            dataSource={usages}
            loading={usageLoading}
            locale={{ emptyText: "暂无权益消耗记录" }}
            pagination={{
              current: usagePage,
              onChange: onUsagePageChange,
              pageSize: usagePageSize,
              showSizeChanger: true,
              total: usageTotal
            }}
            rowKey="id"
            scroll={{ x: 1600 }}
          />
        </Space>
      </Spin>
    </Card>
  );
}

function EntitlementGrantBalance({ grant }: { grant: OrderEntitlementGrant }) {
  if (isTextEntitlement(grant)) {
    return (
      <Typography.Text type="secondary">
        文本权益仅展示说明，不支持消耗核销。{safeText(grant.entitlementName)}
      </Typography.Text>
    );
  }

  const percent = entitlementProgressPercent(grant);
  return (
    <Space orientation="vertical" size={8} style={{ width: "100%" }}>
      <Typography.Text>
        {formatEntitlementAmount(grant.totalAmount, grant.unit)} / 已用 {formatEntitlementAmount(grant.usedAmount, grant.unit)} / 剩余{" "}
        {formatEntitlementAmount(grant.remainingAmount, grant.unit)}
      </Typography.Text>
      {percent === null ? null : <Progress percent={percent} size="small" />}
      <Typography.Text type="secondary">最近消耗：{formatTime(grant.latestUsageAt)}</Typography.Text>
    </Space>
  );
}

function EntitlementOperationResultView({
  result,
  type
}: {
  result: EntitlementRenewalResponse | ExpireEntitlementsResponse | null;
  type: "expire" | "renewal";
}) {
  if (!result) {
    return null;
  }

  const isRenewal = type === "renewal";
  const renewalResult = isRenewal ? (result as EntitlementRenewalResponse) : null;
  const expireResult = isRenewal ? null : (result as ExpireEntitlementsResponse);
  const items = normalizeEntitlementOperationItems(result);
  const firstAction = isRenewal ? safeText(items[0]?.action ?? renewalResult?.action) : safeText(items[0]?.action);
  const hasFailure = items.some((item) => safeText(item.action).includes("FAILED") || safeText(item.action) === "FAILED");
  const isSkipped = firstAction.startsWith("SKIPPED") || firstAction === "DRY_RUN_SKIP";
  const resultMessage = isRenewal ? getRenewalResultText(renewalResult) : getExpireResultText(expireResult);
  const alertType = hasFailure ? "error" : isSkipped ? "warning" : result.dryRun ? "info" : "success";
  const summaryItems = [
    { label: "执行模式", children: result.dryRun ? "试算" : "正式执行" },
    ...(renewalResult?.generatedCount !== undefined
      ? [{ label: "生成订单数", children: formatOperationCount(renewalResult.generatedCount) }]
      : []),
    ...(expireResult?.expiredCount !== undefined
      ? [{ label: "将过期 / 已过期", children: formatOperationCount(expireResult.expiredCount) }]
      : []),
    ...(result.skippedCount !== undefined
      ? [{ label: "跳过数量", children: formatOperationCount(result.skippedCount) }]
      : []),
    ...(renewalResult?.failedCount !== undefined
      ? [{ label: "失败数量", children: formatOperationCount(renewalResult.failedCount) }]
      : []),
    ...(renewalResult?.periodStart || renewalResult?.periodEnd
      ? [{ label: "账期", children: formatEntitlementPeriod(renewalResult.periodStart, renewalResult.periodEnd) }]
      : []),
    ...(renewalResult?.grantCount !== undefined
      ? [{ label: "权益数量", children: formatOperationCount(renewalResult.grantCount) }]
      : [])
  ];
  const previewGrants = renewalResult?.grants ?? [];
  const previewGrantRows = previewGrants.map((grant, index) => ({
    ...grant,
    rowKey: [
      safeText(grant.entitlementType),
      safeText(grant.entitlementName),
      safeText(grant.unit),
      safeText(grant.totalAmount),
      index
    ].join("-")
  }));
  const itemRows = items.map((item, index) => ({
    ...item,
    rowKey:
      safeText(item.grantId) !== "-"
        ? safeText(item.grantId)
        : [
            safeText(item.orderId),
            safeText(item.action),
            safeText(item.periodStart),
            safeText(item.periodEnd),
            index
          ].join("-")
  }));
  const previewColumns: ColumnsType<EntitlementRenewalGrantPreview> = [
    {
      dataIndex: "entitlementType",
      render: (value: string | null) => labelOf(ENTITLEMENT_TYPE_LABELS, safeText(value)),
      title: "权益类型",
      width: 120
    },
    { dataIndex: "entitlementName", render: safeText, title: "权益名称", width: 180 },
    {
      render: (_, record) => formatEntitlementAmount(record.totalAmount, record.unit),
      title: "总量",
      width: 120
    },
    {
      render: (_, record) => formatEntitlementAmount(record.usedAmount, record.unit),
      title: "已用",
      width: 120
    },
    {
      render: (_, record) => formatEntitlementAmount(record.remainingAmount, record.unit),
      title: "剩余",
      width: 120
    },
    {
      dataIndex: "unit",
      render: (value: string | null) => labelOf(ENTITLEMENT_UNIT_LABELS, safeText(value)),
      title: "单位",
      width: 100
    }
  ];
  const itemColumns: ColumnsType<EntitlementOperationItem> = [
    { dataIndex: "orderNo", render: safeText, title: "订单编号", width: 170 },
    { dataIndex: "grantNo", render: safeText, title: "权益编号", width: 170 },
    {
      dataIndex: "entitlementType",
      render: (value: string | null) => {
        const text = safeText(value);
        return text === "-" ? "-" : labelOf(ENTITLEMENT_TYPE_LABELS, text);
      },
      title: "权益类型",
      width: 120
    },
    { dataIndex: "entitlementName", render: safeText, title: "权益名称", width: 180 },
    {
      render: (_, record) => {
        const action = record.action ?? (isRenewal ? undefined : result.dryRun ? "DRY_RUN_EXPIRE" : "EXPIRED");
        return formatOperationAction(action);
      },
      title: "动作",
      width: 130
    },
    { dataIndex: "periodStart", render: formatDate, title: "账期开始", width: 120 },
    { dataIndex: "periodEnd", render: formatDate, title: "账期结束", width: 120 },
    {
      render: (_, record) => formatOperationCount(record.grantCount ?? (isRenewal ? undefined : 1)),
      title: "权益数量",
      width: 100
    },
    { dataIndex: "reason", render: safeText, title: "原因", width: 220 }
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Alert showIcon title={resultMessage} type={alertType} />
      <Descriptions bordered column={3} items={summaryItems} size="small" />
      {previewGrants.length > 0 ? (
        <Table<EntitlementRenewalGrantPreview>
          columns={previewColumns}
          dataSource={previewGrantRows}
          pagination={false}
          rowKey="rowKey"
          scroll={{ x: 760 }}
          size="small"
        />
      ) : null}
      {items.length > 0 ? (
        <Table<EntitlementOperationItem>
          columns={itemColumns}
          dataSource={itemRows}
          pagination={false}
          rowKey="rowKey"
          scroll={{ x: 1260 }}
          size="small"
        />
      ) : null}
    </Space>
  );
}

function FinancePanel({
  bills,
  financeLoading,
  generateAvailability,
  generateMonthlyRentAvailability,
  generatingBills,
  generatingMonthlyRentBill,
  onGenerateInitialBills,
  onGenerateNextMonthlyRentBill,
  onOpenPayment,
  paymentAvailability,
  summary
}: {
  bills: ReceivableBillRow[];
  financeLoading: boolean;
  generateAvailability: ReturnType<typeof actionAvailability>;
  generateMonthlyRentAvailability: ReturnType<typeof actionAvailability>;
  generatingBills: boolean;
  generatingMonthlyRentBill: boolean;
  onGenerateInitialBills: () => void;
  onGenerateNextMonthlyRentBill: () => void;
  onOpenPayment: () => void;
  paymentAvailability: ReturnType<typeof actionAvailability>;
  summary: FinanceSummary | null;
}) {
  const deliverySatisfied = isDeliveryPaymentSatisfied(summary);
  const registeredButUnallocated =
    !deliverySatisfied && numberOrZero(summary?.unallocatedReceiptAmount) > 0;
  const financeAlertMessage = deliverySatisfied
    ? "押金和首期月费已完成账单核销，满足交付付款条件"
    : registeredButUnallocated
      ? "已登记收款，待核销"
      : "押金或首期月费尚未完成收款核销";
  const monthlyRentBills = bills.filter(validMonthlyRentBill);
  const latestMonthlyRentBill = [...monthlyRentBills]
    .filter((bill) => bill.billPeriodStart)
    .sort((left, right) => String(right.billPeriodStart).localeCompare(String(left.billPeriodStart)))[0];
  const billColumns: ColumnsType<ReceivableBillRow> = [
    { dataIndex: "billNo", title: "账单编号" },
    {
      dataIndex: "billType",
      render: (value: string) => labelOf(BILL_TYPE_LABELS, value),
      title: "账单类型"
    },
    {
      dataIndex: "billStatus",
      render: (value: string) => <BillStatusTag value={value} />,
      title: "账单状态"
    },
    { dataIndex: "amount", render: formatYuan, title: "应收金额" },
    { dataIndex: "paidAmount", render: formatYuan, title: "已收金额" },
    { dataIndex: "remainingAmount", render: formatYuan, title: "剩余金额" },
    {
      render: (_, record) => formatBillPeriod(record.billPeriodStart, record.billPeriodEnd),
      title: "账期"
    },
    { dataIndex: "billPeriodStart", render: formatDate, title: "账期开始" },
    { dataIndex: "billPeriodEnd", render: formatDate, title: "账期结束" },
    { dataIndex: "dueDate", render: formatTime, title: "到期日" },
    { dataIndex: "paidAt", render: formatTime, title: "已收款时间" },
    { dataIndex: "remark", render: safeText, title: "备注" }
  ];

  return (
    <Card
      extra={
        <Space wrap>
          <ActionButton
            availability={generateAvailability}
            loading={generatingBills}
            onClick={onGenerateInitialBills}
            type="primary"
          >
            生成初始账单
          </ActionButton>
          <ActionButton
            availability={generateMonthlyRentAvailability}
            loading={generatingMonthlyRentBill}
            onClick={onGenerateNextMonthlyRentBill}
          >
            生成下一期月租账单
          </ActionButton>
          <ActionButton availability={paymentAvailability} onClick={onOpenPayment}>
            登记收款
          </ActionButton>
        </Space>
      }
      title="财务 / 收款核销"
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          description={
            registeredButUnallocated
              ? "已有收款记录，但应收账单仍未核销；请在登记收款时勾选“同时核销账单”，或对既有收款执行账单核销。"
              : undefined
          }
          message={financeAlertMessage}
          showIcon
          type={deliverySatisfied ? "success" : "warning"}
        />

        <Descriptions
          bordered
          column={2}
          title="财务概览"
          items={[
            { label: "押金应收", children: formatYuan(summary?.depositReceivableAmount) },
            { label: "押金已收", children: formatYuan(summary?.depositPaidAmount) },
            { label: "押金状态", children: <BillStatusTag value={summary?.depositStatus} /> },
            { label: "首期月费应收", children: formatYuan(summary?.firstMonthlyFeeReceivableAmount) },
            { label: "首期月费已收", children: formatYuan(summary?.firstMonthlyFeePaidAmount) },
            { label: "首期月费状态", children: <BillStatusTag value={summary?.firstMonthlyFeeStatus} /> },
            { label: "已登记收款", children: formatYuan(summary?.registeredReceiptAmount) },
            { label: "已核销金额", children: formatYuan(summary?.allocatedPaidAmount) },
            { label: "待核销收款", children: formatYuan(summary?.unallocatedReceiptAmount) },
            { label: "总应收", children: formatYuan(summary?.totalReceivableAmount) },
            { label: "总已收", children: formatYuan(summary?.totalPaidAmount) },
            { label: "交付付款条件", children: deliverySatisfied ? <Tag color="green">已满足</Tag> : <Tag color="orange">未满足</Tag> }
          ]}
        />

        <Descriptions
          bordered
          column={2}
          title="月租账单概览"
          items={[
            { label: "已生成月租账单数量", children: monthlyRentBills.length },
            { label: "月租账单待收金额", children: formatYuan(sumBillAmount(monthlyRentBills, "remainingAmount")) },
            { label: "月租账单已收金额", children: formatYuan(sumBillAmount(monthlyRentBills, "paidAmount")) },
            {
              label: "最近一期月租账期",
              children: latestMonthlyRentBill
                ? formatBillPeriod(latestMonthlyRentBill.billPeriodStart, latestMonthlyRentBill.billPeriodEnd)
                : "-"
            }
          ]}
        />

        <Table
          columns={billColumns}
          dataSource={bills}
          loading={financeLoading}
          locale={{ emptyText: "-" }}
          onRow={(bill) =>
            ({
              "data-workspace-record": bill.id
            }) as HTMLAttributes<HTMLTableRowElement>
          }
          pagination={false}
          rowKey="id"
          scroll={{ x: 1480 }}
          size="small"
          title={() => "应收账单"}
        />
      </Space>
    </Card>
  );
}

function Stage2HandoverWorkflowCell({
  actionLoading,
  canRecoverWorkflow,
  error,
  loading,
  mutationInFlight,
  onRecover,
  onRefresh,
  onStart,
  onVoid,
  status,
  workOrder
}: {
  actionLoading: string | null;
  canRecoverWorkflow: boolean;
  error?: string | null;
  loading: boolean;
  mutationInFlight: boolean;
  onRecover: (
    workOrderId: string,
    recovery: AdminStage2HandoverWorkflowRecovery
  ) => void;
  onRefresh: (id: string) => void;
  onStart: (id: string) => void;
  onVoid: (id: string) => void;
  status?: AdminStage2HandoverESignStatus;
  workOrder: HandoverWorkOrderSummary;
}) {
  const workflowStatus = status
    ? {
        ...status,
        workflowJobs: status.workflowJobs ?? workOrder.workflowJobs
      }
    : undefined;
  const display = getAdminStage2HandoverWorkflowDisplay(workflowStatus, {
    customerConfirmedAt: workOrder.customerConfirmedAt,
    pdfStatus: workOrder.stage2Pdf?.status,
    workflowJobs: workOrder.workflowJobs
  });
  const actionDisplay = status
    ? getAdminStage2HandoverESignDisplay(status)
    : null;
  const documentDownload = getAdminStage2HandoverDocumentDownload({
    archiveStatus: workOrder.stage2Pdf?.archiveStatus,
    handoverStatus: workOrder.stage2Pdf?.handoverStatus,
    signedArtifactAvailable: workOrder.stage2Pdf?.signedArtifactAvailable,
    sourceDownloadUrl: workOrder.stage2Pdf?.downloadUrl,
    workOrderId: workOrder.id
  });
  return (
    <Space
      orientation="vertical"
      size={6}
      style={{ minHeight: 188, minWidth: 280, width: "100%" }}
    >
      <Space align="center" size={6}>
        <Typography.Text strong>交接签署流程</Typography.Text>
        {loading ? <Spin size="small" /> : null}
      </Space>
      <Timeline
        items={display.steps.map((step) => ({
          content: (
            <Space orientation="vertical" size={0}>
              <Typography.Text
                style={{ color: step.state === "waiting" ? "#8c8c8c" : undefined }}
              >
                {step.label}
              </Typography.Text>
              {step.detail ? (
                <Typography.Text style={{ fontSize: 12 }} type="secondary">
                  {step.detail}
                </Typography.Text>
              ) : null}
            </Space>
          ),
          color:
            step.state === "complete"
              ? "green"
              : step.state === "error"
                ? "red"
                : step.state === "current"
                  ? "blue"
                  : "gray"
        }))}
        style={{ marginBottom: -16 }}
      />
      {workOrder.stage2Pdf?.status === "GENERATED" ? (
        <Space size={6} wrap>
          <Typography.Text
            ellipsis={{ tooltip: workOrder.stage2Pdf.documentNo || undefined }}
            style={{ maxWidth: 190 }}
            type="secondary"
          >
            {workOrder.stage2Pdf.documentNo || "交接确认单"}
          </Typography.Text>
          {documentDownload ? (
            <Button
              href={documentDownload.url}
              icon={<DownloadOutlined />}
              rel="noreferrer"
              size="small"
              target="_blank"
            >
              {documentDownload.label}
            </Button>
          ) : null}
        </Space>
      ) : null}
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <Space size={[6, 6]} wrap>
        {actionDisplay?.voidAvailable ? (
          <Button
            danger
            disabled={!canRecoverWorkflow || mutationInFlight}
            icon={<DeleteOutlined />}
            loading={actionLoading === `stage2-void:${workOrder.id}`}
            onClick={() => onVoid(workOrder.id)}
            size="small"
          >
            作废并重新发起
          </Button>
        ) : null}
        {actionDisplay?.startAvailable ? (
          <Button
            disabled={!canRecoverWorkflow || mutationInFlight}
            icon={<SendOutlined />}
            loading={actionLoading === `stage2-start:${workOrder.id}`}
            onClick={() => onStart(workOrder.id)}
            size="small"
            type="primary"
          >
            后台兜底发起签署
          </Button>
        ) : null}
        {display.recoveries.map((recovery) => (
          <Button
            disabled={!canRecoverWorkflow || mutationInFlight}
            key={recovery.jobId}
            loading={
              actionLoading ===
              `workflow-recovery:${workOrder.id}:${recovery.jobId}`
            }
            onClick={() => onRecover(workOrder.id, recovery)}
            size="small"
          >
            {recovery.label}
          </Button>
        ))}
        <Button
          aria-label="刷新交接签署流程"
          disabled={mutationInFlight}
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => onRefresh(workOrder.id)}
          size="small"
        />
      </Space>
    </Space>
  );
}

function Stage2HandoverReviewPanel({
  actionLoading,
  canAssignExternal,
  canHandleObjection,
  canRecoverWorkflow,
  createAvailability,
  esignErrors,
  esignLoading,
  esignStatuses,
  loading,
  loadState,
  mutationInFlight,
  onAcknowledge,
  onAssignExternal,
  onCreateWorkOrder,
  onRecoverWorkflow,
  onRefreshESign,
  onRequestResubmission,
  onSendCustomerReview,
  onStartESign,
  onVoidESign,
  onViewDetail,
  workOrders
}: {
  actionLoading: string | null;
  canAssignExternal: boolean;
  canHandleObjection: boolean;
  canRecoverWorkflow: boolean;
  createAvailability: ReturnType<typeof actionAvailability>;
  esignErrors: Record<string, string | undefined>;
  esignLoading: Record<string, boolean | undefined>;
  esignStatuses: Record<string, AdminStage2HandoverESignStatus | undefined>;
  loading: boolean;
  loadState: HandoverWorkOrdersLoadState;
  mutationInFlight: boolean;
  onAcknowledge: (id: string) => void;
  onAssignExternal: (id: string) => void;
  onCreateWorkOrder: () => void;
  onRecoverWorkflow: (
    workOrderId: string,
    recovery: AdminStage2HandoverWorkflowRecovery
  ) => void;
  onRefreshESign: (id: string) => void;
  onRequestResubmission: (id: string) => void;
  onSendCustomerReview: (id: string) => void;
  onStartESign: (id: string) => void;
  onVoidESign: (id: string) => void;
  onViewDetail: (id: string) => void;
  workOrders: HandoverWorkOrderSummary[];
}) {
  const hasActiveWorkOrder = workOrders.some(isActiveHandoverWorkOrder);
  const columns: ColumnsType<HandoverWorkOrderSummary> = [
    {
      dataIndex: "orderNo",
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong>{row.orderNo ?? "-"}</Typography.Text>
          <Typography.Text type="secondary">{formatHandoverType(row.handoverType)}</Typography.Text>
        </Space>
      ),
      title: "工单",
      width: 180
    },
    {
      dataIndex: "status",
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Tag>{formatHandoverWorkOrderStatus(row.status)}</Tag>
          <Typography.Text type="secondary">{formatAdminReviewStatus(row.adminReview?.status)}</Typography.Text>
        </Space>
      ),
      title: "状态",
      width: 150
    },
    {
      key: "stage2ESign",
      render: (_value, row) => (
        <Stage2HandoverWorkflowCell
          actionLoading={actionLoading}
          canRecoverWorkflow={canRecoverWorkflow}
          error={esignErrors[row.id]}
          loading={esignLoading[row.id] === true}
          mutationInFlight={mutationInFlight}
          onRecover={onRecoverWorkflow}
          onRefresh={onRefreshESign}
          onStart={onStartESign}
          onVoid={onVoidESign}
          status={esignStatuses[row.id]}
          workOrder={row}
        />
      ),
      title: "交接签署流程",
      width: 360
    },
    {
      dataIndex: "customer",
      render: (_value, row) => joinText(row.customer?.displayName, row.customer?.mobileMasked),
      title: "客户",
      width: 160
    },
    {
      dataIndex: "operator",
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text>{row.operator?.name || "尚未指派"}</Typography.Text>
          <Typography.Text type="secondary">{row.operator?.phone || "-"}</Typography.Text>
        </Space>
      ),
      title: "Field 人员",
      width: 244
    },
    {
      dataIndex: "fieldSubmittedAt",
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text>{formatTime(row.fieldSubmittedAt)}</Typography.Text>
          <Typography.Text type="secondary">{formatHandoverEvidenceProgress(row.evidenceProgress)}</Typography.Text>
        </Space>
      ),
      title: "现场资料",
      width: 180
    },
    {
      dataIndex: "objection",
      render: (_value, row) =>
        row.objection?.reason ? (
          <Space orientation="vertical" size={2}>
            <Typography.Text type="danger">{row.objection.reason}</Typography.Text>
            <Typography.Text type="secondary">{formatTime(row.objection.objectedAt)}</Typography.Text>
          </Space>
        ) : "-",
      title: "客户异议",
      width: 180
    },
    {
      key: "actions",
      render: (_value, row) => (
        <Stage2HandoverReviewActions
          actionLoading={actionLoading}
          canAssignExternal={canAssignExternal}
          canHandleObjection={canHandleObjection}
          onAcknowledge={onAcknowledge}
          onAssignExternal={onAssignExternal}
          onRequestResubmission={onRequestResubmission}
          onSendCustomerReview={onSendCustomerReview}
          onViewDetail={onViewDetail}
          workOrder={row}
        />
      ),
      title: "操作",
      width: 280
    }
  ];

  return (
    <Card
      extra={
        <Space>
          <Link href="/handover-review-queue">异议处理队列</Link>
          {!hasActiveWorkOrder ? (
            <ActionButton
              availability={createAvailability}
              icon={<PlusOutlined />}
              loading={actionLoading === "create"}
              onClick={onCreateWorkOrder}
              type="primary"
            >
              创建交付工单
            </ActionButton>
          ) : null}
        </Space>
      }
      title="Stage 2 现场交接 / 客户复核"
    >
      {loadState === "ERROR" ? (
        <Alert
          message="Stage 2 现场交接工单加载失败"
          description="当前无法确认交接签署状态，请刷新页面后重试。"
          showIcon
          style={{ marginBottom: 12 }}
          type="error"
        />
      ) : null}
      {loadState === "LOADED" && workOrders.length === 0 ? (
        <Alert
          message="暂无 Stage 2 现场交接工单"
          description="完成准备交付后，可在此创建交付工单并指派现场交付人员。"
          showIcon
          style={{ marginBottom: 12 }}
          type="info"
        />
      ) : null}
      <Table
        columns={columns}
        dataSource={workOrders}
        loading={loading}
        locale={{ emptyText: "暂无 Stage 2 现场交接记录" }}
        onRow={(workOrder) => {
          const recordIds = getOrderWorkspaceRecordIds(
            workOrder.id,
            esignStatuses[workOrder.id]?.handoverId,
            workOrder.handoverId
          );
          return {
            "data-workspace-record": workOrder.id,
            "data-workspace-record-alias": recordIds[1]
          } as HTMLAttributes<HTMLTableRowElement>;
        }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1734 }}
        size="small"
        tableLayout="fixed"
      />
    </Card>
  );
}

function Stage2HandoverReviewActions({
  actionLoading,
  canAssignExternal,
  canHandleObjection,
  onAcknowledge,
  onAssignExternal,
  onRequestResubmission,
  onSendCustomerReview,
  onViewDetail,
  workOrder
}: {
  actionLoading: string | null;
  canAssignExternal: boolean;
  canHandleObjection: boolean;
  onAcknowledge: (id: string) => void;
  onAssignExternal: (id: string) => void;
  onRequestResubmission: (id: string) => void;
  onSendCustomerReview: (id: string) => void;
  onViewDetail: (id: string) => void;
  workOrder: HandoverWorkOrderSummary;
}) {
  const hasObjection = workOrder.status === "CUSTOMER_OBJECTED" || Boolean(workOrder.customerObjectedAt);
  const canAcknowledge = workOrder.adminReview?.canAcknowledge === true;
  const canRequestResubmission = workOrder.adminReview?.canRequestResubmission === true;
  const canSendBack = workOrder.adminReview?.canSendBackToCustomerReview === true;
  const canAssign = canAssignExternal && ["DRAFT", "ASSIGNED"].includes(String(workOrder.status));
  return (
    <Space wrap>
      <Button
        loading={actionLoading === `detail:${workOrder.id}`}
        onClick={() => onViewDetail(workOrder.id)}
        size="small"
      >
        查看详情
      </Button>
      <Button
        disabled={!canAssign}
        icon={<UserAddOutlined />}
        onClick={() => onAssignExternal(workOrder.id)}
        size="small"
      >
        指派 Field
      </Button>
      <Button
        disabled={!canHandleObjection || !hasObjection || !canAcknowledge}
        loading={actionLoading === `acknowledge:${workOrder.id}`}
        onClick={() => onAcknowledge(workOrder.id)}
        size="small"
      >
        受理异议
      </Button>
      <Button
        disabled={!canHandleObjection || !hasObjection || !canRequestResubmission}
        loading={actionLoading === `request-resubmission:${workOrder.id}`}
        onClick={() => onRequestResubmission(workOrder.id)}
        size="small"
      >
        要求现场重提
      </Button>
      <Button
        disabled={!canHandleObjection || !canSendBack}
        loading={actionLoading === `send-customer-review:${workOrder.id}`}
        onClick={() => onSendCustomerReview(workOrder.id)}
        size="small"
        type="primary"
      >
        送回客户复核
      </Button>
    </Space>
  );
}

function Stage2HandoverReviewDetailModal({
  actionLoading,
  canAssignExternal,
  canHandleObjection,
  canRecoverWorkflow,
  detail,
  esignError,
  esignLoading,
  esignStatus,
  mutationInFlight,
  onAcknowledge,
  onAssignExternal,
  onClose,
  onRecoverWorkflow,
  onRefreshESign,
  onRequestResubmission,
  onSendCustomerReview,
  onStartESign,
  onVoidESign,
  open
}: {
  actionLoading: string | null;
  canAssignExternal: boolean;
  canHandleObjection: boolean;
  canRecoverWorkflow: boolean;
  detail: HandoverWorkOrderDetail | null;
  esignError?: string | null;
  esignLoading: boolean;
  esignStatus?: AdminStage2HandoverESignStatus;
  mutationInFlight: boolean;
  onAcknowledge: (id: string) => void;
  onAssignExternal: (id: string) => void;
  onClose: () => void;
  onRecoverWorkflow: (
    workOrderId: string,
    recovery: AdminStage2HandoverWorkflowRecovery
  ) => void;
  onRefreshESign: (id: string) => void;
  onRequestResubmission: (id: string) => void;
  onSendCustomerReview: (id: string) => void;
  onStartESign: (id: string) => void;
  onVoidESign: (id: string) => void;
  open: boolean;
}) {
  return (
    <Modal footer={null} onCancel={onClose} open={open} title="Stage 2 现场交接详情" width={920}>
      {detail ? (
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "工单状态", children: <Tag>{formatHandoverWorkOrderStatus(detail.status)}</Tag> },
              { label: "后台处理", children: formatAdminReviewStatus(detail.adminReview?.status) },
              { label: "现场提交时间", children: formatTime(detail.fieldSubmittedAt) },
              { label: "客户复核开始", children: formatTime(detail.customerReviewStartedAt) },
              { label: "客户确认时间", children: formatTime(detail.customerConfirmedAt) },
              { label: "客户异议时间", children: formatTime(detail.customerObjectedAt) }
            ]}
          />

          <Stage2HandoverWorkflowCell
            actionLoading={actionLoading}
            canRecoverWorkflow={canRecoverWorkflow}
            error={esignError}
            loading={esignLoading}
            mutationInFlight={mutationInFlight}
            onRecover={onRecoverWorkflow}
            onRefresh={onRefreshESign}
            onStart={onStartESign}
            onVoid={onVoidESign}
            status={esignStatus}
            workOrder={detail}
          />

          {detail.objection?.reason ? (
            <Alert
              description={detail.objection.details || undefined}
              message={`客户异议：${detail.objection.reason}`}
              showIcon
              type="warning"
            />
          ) : null}

          <Stage2HandoverReviewActions
            actionLoading={actionLoading}
            canAssignExternal={canAssignExternal}
            canHandleObjection={canHandleObjection}
            onAcknowledge={onAcknowledge}
            onAssignExternal={onAssignExternal}
            onRequestResubmission={onRequestResubmission}
            onSendCustomerReview={onSendCustomerReview}
            onViewDetail={() => undefined}
            workOrder={detail}
          />

          <List
            dataSource={detail.evidenceChecklist?.items ?? []}
            locale={{ emptyText: "暂无资料文件" }}
            renderItem={(item) => (
              <List.Item>
                <List.Item.Meta
                  description={
                    <Space direction="vertical" size={4}>
                      <Space size={[6, 6]} wrap>
                        <Tag>{item.isRequired ? "必传" : item.isConditional ? "条件必传" : "选填"}</Tag>
                        <Tag>{formatHandoverEvidenceStatus(item)}</Tag>
                        <Tag>{numberOrZero(item.fileCount)} 个文件</Tag>
                      </Space>
                      {(item.files ?? []).length > 0 ? (
                        <Space size={[8, 6]} wrap>
                          {(item.files ?? []).map((file) => {
                            const videoQualityText = formatFieldEvidenceVideoQuality(
                              file.mediaType,
                              file.metadata
                            );
                            return (
                              <Space
                                key={file.evidenceFileId || file.id || file.displayName || "file"}
                                size={4}
                                wrap
                              >
                                <Typography.Text type="secondary">
                                  {file.displayName ?? "资料文件"} / {formatEvidenceFileSize(file.sizeBytes)}
                                </Typography.Text>
                                {videoQualityText ? (
                                  <Typography.Text type="secondary">
                                    {videoQualityText}
                                  </Typography.Text>
                                ) : null}
                                {file.previewAvailable && file.previewUrl ? (
                                  <Typography.Link
                                    href={buildAdminHandoverFileUrl(file.previewUrl) ?? undefined}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    预览
                                  </Typography.Link>
                                ) : null}
                                {file.downloadUrl ? (
                                  <Typography.Link
                                    href={buildAdminHandoverFileUrl(file.downloadUrl) ?? undefined}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    下载/打开
                                  </Typography.Link>
                                ) : null}
                              </Space>
                            );
                          })}
                        </Space>
                      ) : null}
                      {item.rejectionReason ? <Typography.Text type="danger">{item.rejectionReason}</Typography.Text> : null}
                    </Space>
                  }
                  title={<Typography.Text strong>{item.title || item.evidenceType || "现场资料"}</Typography.Text>}
                />
              </List.Item>
            )}
          />

          <Table
            columns={[
              { dataIndex: "attemptNo", title: "轮次" },
              { dataIndex: "status", render: formatHandoverAttemptStatus, title: "状态" },
              { dataIndex: "adminStatus", render: formatAdminReviewStatus, title: "后台处理" },
              { dataIndex: "fieldSubmittedAt", render: formatTime, title: "现场提交" },
              { dataIndex: "customerObjectionReason", render: safeText, title: "异议原因" }
            ]}
            dataSource={detail.reviewAttempts ?? []}
            locale={{ emptyText: "暂无复核历史" }}
            pagination={false}
            rowKey={(row) => row.id || String(row.attemptNo)}
            size="small"
            title={() => "复核历史"}
          />

          <Table
            columns={[
              { dataIndex: "eventType", render: formatHandoverEventType, title: "事件" },
              { key: "actor", render: (_value, row: HandoverEvent) => formatHandoverEventActor(row), title: "操作人" },
              { dataIndex: "createdAt", render: formatTime, title: "时间" }
            ]}
            dataSource={detail.events ?? []}
            locale={{ emptyText: "暂无操作事件" }}
            pagination={false}
            rowKey={(row) => row.id || `${row.eventType}-${row.createdAt}`}
            size="small"
            title={() => "操作事件"}
          />
        </Space>
      ) : (
        <Empty description="请选择 Stage 2 现场交接记录" />
      )}
    </Modal>
  );
}

function DeliveryBlockerGuidance({ reason }: { reason: string }) {
  if (reason.includes("保险人工核验") || reason.includes("保险有效性尚未确认")) {
    return <Typography.Text type="secondary">请在准备交付弹窗中确认</Typography.Text>;
  }
  if (reason.includes("交强险") || reason.includes("商业险")) {
    return <Link href="/vehicle-insurance-policies">去保单管理</Link>;
  }
  if (reason.includes("押金") || reason.includes("首期月费")) {
    return <Typography.Text type="secondary">请在财务 / 收款核销中完成账单核销</Typography.Text>;
  }
  if (reason.includes("整备") || reason.includes("文件") || reason.includes("身份")) {
    return <Typography.Text type="secondary">请在准备交付弹窗中确认</Typography.Text>;
  }
  if (reason.includes("交付工单")) {
    return <Typography.Text type="secondary">请在 Stage 2 模块创建交付工单</Typography.Text>;
  }
  return null;
}

function DeliveryPanel({
  confirmAvailability,
  delivery,
  deliveryCheck,
  onOpenConfirm,
  onOpenPrepare,
  prepareAvailability
}: {
  confirmAvailability: ReturnType<typeof actionAvailability>;
  delivery: VehicleDelivery | null;
  deliveryCheck: DeliveryCheck | null;
  onOpenConfirm: () => void;
  onOpenPrepare: () => void;
  prepareAvailability: ReturnType<typeof actionAvailability>;
}) {
  const blockingReasons = deliveryCheck?.blockingReasons ?? [];
  const deliveryStatus = deliveryCheck?.deliveryStatus ?? delivery?.deliveryStatus ?? null;
  const alreadyDelivered = Boolean(
    deliveryCheck?.alreadyDelivered || deliveryStatus === "DELIVERED" || delivery?.deliveredAt
  );
  const readyForDelivery = !alreadyDelivered && deliveryStatus === "READY";
  const zeroDepositSatisfied = deliveryCheck?.depositRequired === false;
  const checklistItems: Array<{ help?: string; label: string; value?: boolean }> = [
    { label: "合同签署确认", value: delivery?.contractSignedConfirmed ?? deliveryCheck?.contractSigned },
    {
      help: zeroDepositSatisfied ? "0 元押金，自动满足" : undefined,
      label: "押金收取确认",
      value: zeroDepositSatisfied || delivery?.depositReceivedConfirmed
    },
    { label: "首期月费收取确认", value: delivery?.firstMonthlyFeeReceivedConfirmed },
    { label: "保险人工核验", value: delivery?.insuranceValidConfirmed },
    { label: "车辆整备完成确认", value: delivery?.vehiclePreparedConfirmed },
    { label: "车辆照片确认", value: delivery?.vehiclePhotosConfirmed },
    { label: "客户身份核验确认", value: delivery?.customerIdentityConfirmed },
    { label: "交付文件确认", value: delivery?.handoverDocumentsConfirmed }
  ];

  return (
    <Card
      extra={
        <Space wrap>
          <ActionButton availability={prepareAvailability} onClick={onOpenPrepare} type="primary">
            准备交付
          </ActionButton>
          <ActionButton availability={confirmAvailability} onClick={onOpenConfirm} type="primary">
            确认交付
          </ActionButton>
        </Space>
      }
      title="车辆交付"
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          description={
            alreadyDelivered ? (
              <Space orientation="vertical" size={4}>
                <Typography.Text>订单已进入在租状态</Typography.Text>
                <Typography.Text>
                  车辆状态：
                  {deliveryCheck?.vehicleStatus === "LEASED"
                    ? "已出租（LEASED）"
                    : deliveryCheck?.vehicleStatus
                      ? labelOf(STATUS_LABELS, deliveryCheck.vehicleStatus)
                      : "-"}
                </Typography.Text>
              </Space>
            ) : readyForDelivery ? (
              "交付准备已完成，待确认交付"
            ) : blockingReasons.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {blockingReasons.map((reason, index) => (
                  <li key={`${reason}-${index}`}>
                    <Space size={8} wrap>
                      <span>{reason}</span>
                      <DeliveryBlockerGuidance reason={reason} />
                    </Space>
                  </li>
                ))}
              </ul>
            ) : undefined
          }
          message={
            alreadyDelivered
              ? "交付已完成"
              : readyForDelivery
                ? "交付准备已完成，待确认交付"
                : blockingReasons.length > 0
                  ? "暂不可交付"
                  : "交付条件已满足"
          }
          showIcon
          type={alreadyDelivered || readyForDelivery || blockingReasons.length === 0 ? "success" : "warning"}
        />

        {!alreadyDelivered ? (
          <Typography.Text type="secondary">
            签约锁定（RESERVED）：车辆已被订单锁定，处于合同 / 付款 / 交付前流程中，不能被其他订单选择；交付完成后车辆进入已出租（LEASED）状态。
          </Typography.Text>
        ) : null}

        {!alreadyDelivered ? (
          <Descriptions
            bordered
            column={2}
            title="交付条件检查"
            items={[
              { label: "合同签署状态", children: <BooleanTag checked={deliveryCheck?.contractSigned} /> },
              {
                label: "押金确认状态",
                children: zeroDepositSatisfied ? (
                  <Tag color="green">0 元押金，自动满足</Tag>
                ) : (
                  <BooleanTag checked={deliveryCheck?.depositReceivedConfirmed} />
                )
              },
              { label: "首期月费确认状态", children: <BooleanTag checked={deliveryCheck?.firstMonthlyFeeReceivedConfirmed} /> },
              {
                label: "交强险期限覆盖",
                children: (
                  <BooleanTag
                    checked={deliveryCheck?.insuranceCoverage.compulsoryTrafficCovered}
                  />
                )
              },
              {
                label: "商业险期限覆盖",
                children: (
                  <BooleanTag checked={deliveryCheck?.insuranceCoverage.commercialCovered} />
                )
              },
              {
                label: "保险人工核验",
                children: <BooleanTag checked={delivery?.insuranceValidConfirmed} />
              },
              { label: "车辆整备状态", children: <BooleanTag checked={deliveryCheck?.vehiclePrepared} /> },
              {
                label: "车辆状态",
                children: deliveryCheck?.vehicleStatus ? labelOf(STATUS_LABELS, deliveryCheck.vehicleStatus) : "-"
              },
              {
                label: "车辆当前销售价初始化状态",
                children: <BooleanTag checked={deliveryCheck?.currentSalePriceInitialized} />
              },
              { label: "是否可准备交付", children: <BooleanTag checked={deliveryCheck?.canPrepareDelivery} /> },
              { label: "是否可确认交付", children: <BooleanTag checked={deliveryCheck?.canConfirmDelivery} /> }
            ]}
          />
        ) : null}

        <Descriptions
          bordered
          column={2}
          title="当前交付记录"
          items={[
            { label: "交付单号", children: safeText(delivery?.deliveryNo) },
            { label: "交付状态", children: <DeliveryStatusTag value={delivery?.deliveryStatus} /> },
            { label: "预约交付时间", children: formatTime(delivery?.scheduledAt) },
            { label: "交付地点", children: safeText(delivery?.deliveryLocation) },
            { label: "实际交付时间", children: formatTime(delivery?.deliveredAt) },
            { label: "交付里程", children: formatKilometers(delivery?.handoverMileageKm) },
            { label: "备注", children: safeText(delivery?.remark) }
          ]}
        />

        <Descriptions
          bordered
          column={4}
          title="交付检查项"
          items={checklistItems.map((item) => ({
            label: item.label,
            children: (
              <Space size={6}>
                <BooleanTag checked={item.value} />
                {item.help ? <Typography.Text type="secondary">{item.help}</Typography.Text> : null}
              </Space>
            )
          }))}
        />
      </Space>
    </Card>
  );
}

function ReturnPanel({
  confirmAvailability,
  onOpenConfirm,
  onOpenPrepare,
  order,
  prepareAvailability,
  returnCheck,
  vehicleReturn
}: {
  confirmAvailability: ReturnType<typeof actionAvailability>;
  onOpenConfirm: () => void;
  onOpenPrepare: () => void;
  order: OrderDetail;
  prepareAvailability: ReturnType<typeof actionAvailability>;
  returnCheck: ReturnCheck | null;
  vehicleReturn: VehicleReturn | null;
}) {
  const returnStatus = returnCheck?.returnStatus ?? vehicleReturn?.returnStatus ?? null;
  const alreadyReturned = Boolean(
    returnCheck?.alreadyReturned || order.actualReturnAt || returnStatus === "CONFIRMED" || vehicleReturn?.returnedAt
  );
  const readyForReturn = !alreadyReturned && returnStatus === "READY";
  const blockingReasons = alreadyReturned ? [] : returnCheck?.blockingReasons ?? [];
  const vehicleStatus = returnCheck?.vehicleStatus ?? order.vehicle?.status ?? null;
  const checklistItems = [
    { label: "钥匙已归还", value: vehicleReturn?.keysReturnedConfirmed },
    { label: "充电设备已归还", value: vehicleReturn?.chargingEquipmentReturnedConfirmed },
    { label: "车辆文件已归还", value: vehicleReturn?.vehicleDocumentsReturnedConfirmed },
    { label: "客户物品已清空", value: vehicleReturn?.customerItemsClearedConfirmed },
    { label: "外观已检查", value: vehicleReturn?.exteriorCheckedConfirmed },
    { label: "内饰已检查", value: vehicleReturn?.interiorCheckedConfirmed },
    { label: "电池已检查", value: vehicleReturn?.batteryCheckedConfirmed },
    { label: "里程已确认", value: vehicleReturn?.mileageConfirmed },
    { label: "违章已检查", value: vehicleReturn?.violationCheckedConfirmed },
    { label: "是否需要清洁", value: vehicleReturn?.cleaningRequired },
    { label: "是否需要维修", value: vehicleReturn?.maintenanceRequired },
    { label: "是否发现损伤", value: vehicleReturn?.damageFound }
  ];
  const damageColumns: ColumnsType<VehicleReturnDamage> = [
    {
      dataIndex: "damageType",
      render: (value: string) => labelOf(VEHICLE_DAMAGE_TYPE_LABELS, value),
      title: "损伤类型"
    },
    {
      dataIndex: "damageLevel",
      render: (value: string) => labelOf(VEHICLE_DAMAGE_LEVEL_LABELS, value),
      title: "损伤等级"
    },
    { dataIndex: "description", render: safeText, title: "损伤描述" },
    {
      dataIndex: "responsibleParty",
      render: (value?: string | null) => labelOf(VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS, value ?? "UNKNOWN"),
      title: "责任方"
    },
    {
      dataIndex: "estimatedRepairAmount",
      render: formatYuan,
      title: "预估维修金额"
    },
    {
      dataIndex: "photoUrls",
      render: (value?: string[] | null) => {
        const urls = normalizePhotoUrls(value);
        return urls.length > 0 ? (
          <Space direction="vertical" size={2}>
            {urls.map((url, index) => (
              <Typography.Link href={url} key={`${url}-${index}`} rel="noreferrer" target="_blank">
                照片 {index + 1}
              </Typography.Link>
            ))}
          </Space>
        ) : "-";
      },
      title: "照片"
    },
    {
      dataIndex: "status",
      render: (value: string) => <DamageStatusTag value={value} />,
      title: "状态"
    }
  ];

  return (
    <Card
      extra={
        alreadyReturned ? null : (
          <Space wrap>
            <ActionButton availability={prepareAvailability} onClick={onOpenPrepare} type="primary">
              准备退车
            </ActionButton>
            <ActionButton availability={confirmAvailability} onClick={onOpenConfirm} type="primary">
              确认退车
            </ActionButton>
          </Space>
        )
      }
      title="车辆退回 / 退车验收"
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          description={
            alreadyReturned ? (
              <Space orientation="vertical" size={4}>
                <Typography.Text>
                  {vehicleStatus === "MAINTENANCE" ? "车辆需维修" : vehicleStatus === "RETURNED" ? "车辆已退回" : "该订单已完成退车"}
                </Typography.Text>
                <Typography.Text>订单状态：{labelOf(ORDER_STATUS_LABELS, order.orderStatus)}</Typography.Text>
                <Typography.Text>
                  车辆状态：{vehicleStatus ? labelOf(STATUS_LABELS, vehicleStatus) : "-"}
                </Typography.Text>
                {vehicleStatus === "MAINTENANCE" ? (
                  <Typography.Text type="secondary">
                    车辆需完成整备并通过 RETURN_REINIT 重新初始化销售价后，才能再次入池。
                  </Typography.Text>
                ) : null}
              </Space>
            ) : readyForReturn ? (
              "退车准备已完成，待确认退车"
            ) : blockingReasons.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {blockingReasons.map((reason, index) => (
                  <li key={`${reason}-${index}`}>{reason}</li>
                ))}
              </ul>
            ) : undefined
          }
          message={
            alreadyReturned
              ? "该订单已完成退车"
              : readyForReturn
                ? "退车准备已完成，待确认退车"
                : blockingReasons.length > 0
                  ? "暂不可退车"
                  : "退车条件已满足"
          }
          showIcon
          type={alreadyReturned || readyForReturn || blockingReasons.length === 0 ? "success" : "warning"}
        />

        <Descriptions
          bordered
          column={2}
          title="退车条件检查"
          items={[
            { label: "订单状态", children: labelOf(ORDER_STATUS_LABELS, returnCheck?.orderStatus ?? order.orderStatus) },
            { label: "车辆状态", children: vehicleStatus ? labelOf(STATUS_LABELS, vehicleStatus) : "-" },
            { label: "是否已交付", children: <BooleanTag checked={Boolean(order.actualDeliveryAt)} /> },
            { label: "是否已退车", children: <BooleanTag checked={alreadyReturned} /> },
            { label: "是否可准备退车", children: <BooleanTag checked={returnCheck?.canPrepareReturn} /> },
            { label: "是否可确认退车", children: <BooleanTag checked={returnCheck?.canConfirmReturn} /> }
          ]}
        />

        <Descriptions
          bordered
          column={2}
          title="当前退车记录"
          items={[
            { label: "退车单号", children: safeText(vehicleReturn?.returnNo) },
            { label: "退车状态", children: <ReturnStatusTag value={vehicleReturn?.returnStatus} /> },
            {
              label: "退车类型",
              children: vehicleReturn?.returnType ? labelOf(VEHICLE_RETURN_TYPE_LABELS, vehicleReturn.returnType) : "-"
            },
            { label: "预约退车时间", children: formatTime(vehicleReturn?.scheduledAt) },
            { label: "退车地点", children: safeText(vehicleReturn?.returnLocation) },
            { label: "实际退车时间", children: formatTime(vehicleReturn?.returnedAt) },
            { label: "退车里程", children: formatKilometers(vehicleReturn?.returnMileageKm) },
            { label: "是否需清洁", children: <BooleanTag checked={vehicleReturn?.cleaningRequired} /> },
            { label: "是否需维修", children: <BooleanTag checked={vehicleReturn?.maintenanceRequired} /> },
            { label: "是否发现损伤", children: <BooleanTag checked={vehicleReturn?.damageFound} /> },
            { label: "备注", children: safeText(vehicleReturn?.remark) }
          ]}
        />

        <Descriptions
          bordered
          column={4}
          title="退车检查项"
          items={checklistItems.map((item) => ({
            label: item.label,
            children: <BooleanTag checked={item.value} />
          }))}
        />

        <Table
          columns={damageColumns}
          dataSource={vehicleReturn?.damages ?? []}
          locale={{ emptyText: "-" }}
          pagination={false}
          rowKey="id"
          size="small"
          title={() => "损伤记录"}
        />
      </Space>
    </Card>
  );
}

function VehicleReturnEntry({
  onOpenPrepare,
  prepareAvailability
}: {
  onOpenPrepare: () => void;
  prepareAvailability: ReturnType<typeof actionAvailability>;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <ActionButton
        availability={prepareAvailability}
        icon={<RollbackOutlined />}
        onClick={onOpenPrepare}
        type="primary"
      >
        车辆退回 / 退车验收
      </ActionButton>
    </div>
  );
}

function DepositSettlementPanel({
  customerLabel,
  customerMobile,
  deductAvailability,
  depositSettlementLoading,
  generateAvailability,
  generatingDamageFeeBill,
  onGenerateDamageFeeBill,
  onOpenDeduct,
  onOpenRefund,
  order,
  refundAvailability,
  settlement,
  settlementError
}: {
  customerLabel: string;
  customerMobile?: string;
  deductAvailability: ReturnType<typeof actionAvailability>;
  depositSettlementLoading: boolean;
  generateAvailability: ReturnType<typeof actionAvailability>;
  generatingDamageFeeBill: boolean;
  onGenerateDamageFeeBill: () => void;
  onOpenDeduct: () => void;
  onOpenRefund: () => void;
  order: OrderDetail;
  refundAvailability: ReturnType<typeof actionAvailability>;
  settlement: DepositSettlement | null;
  settlementError?: string | null;
}) {
  const alreadyReturned = isOrderReturned(order);
  const damageRows = settlement?.damages ?? [];
  const ledgerRows = settlement?.depositLedgers ?? [];
  const billNoById = new Map((settlement?.damageFeeBills ?? []).map((bill) => [bill.id, bill.billNo]));
  const damageColumns: ColumnsType<DepositSettlementDamage> = [
    {
      dataIndex: "damageType",
      render: (value: string) => labelOf(VEHICLE_DAMAGE_TYPE_LABELS, value),
      title: "损伤类型"
    },
    {
      dataIndex: "damageLevel",
      render: (value: string) => labelOf(VEHICLE_DAMAGE_LEVEL_LABELS, value),
      title: "损伤等级"
    },
    { dataIndex: "description", render: safeText, title: "描述" },
    {
      dataIndex: "responsibleParty",
      render: (value?: string | null) => labelOf(VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS, value ?? "UNKNOWN"),
      title: "责任方"
    },
    {
      dataIndex: "estimatedRepairAmount",
      render: formatYuan,
      title: "预估维修金额"
    },
    {
      dataIndex: "status",
      render: (value: string) => <DamageStatusTag value={value} />,
      title: "状态"
    },
    {
      dataIndex: "photoUrls",
      render: (value?: string[] | null) => {
        const urls = normalizePhotoUrls(value);
        return urls.length > 0 ? (
          <Space direction="vertical" size={2}>
            {urls.map((url, index) => (
              <Typography.Link href={url} key={`${url}-${index}`} rel="noreferrer" target="_blank">
                照片 {index + 1}
              </Typography.Link>
            ))}
          </Space>
        ) : "-";
      },
      title: "照片"
    }
  ];
  const ledgerColumns: ColumnsType<DepositLedgerRow> = [
    {
      dataIndex: "transactionType",
      render: (value: string) => labelOf(DEPOSIT_TRANSACTION_TYPE_LABELS, value),
      title: "交易类型"
    },
    {
      dataIndex: "transactionStatus",
      render: (value: string) => <Tag>{labelOf(DEPOSIT_TRANSACTION_STATUS_LABELS, value)}</Tag>,
      title: "交易状态"
    },
    { dataIndex: "amount", render: formatYuan, title: "金额" },
    { dataIndex: "balanceAfter", render: formatYuan, title: "交易后余额" },
    {
      dataIndex: "billId",
      render: (value?: string | null) => (value ? (billNoById.get(value) ?? value) : "-"),
      title: "关联账单"
    },
    { dataIndex: "occurredAt", render: formatTime, title: "发生时间" },
    { dataIndex: "remark", render: safeText, title: "备注" }
  ];

  return (
    <Card
      extra={
        <Space wrap>
          <ActionButton
            availability={generateAvailability}
            loading={generatingDamageFeeBill}
            onClick={onGenerateDamageFeeBill}
            type="primary"
          >
            生成损伤费用账单
          </ActionButton>
          <ActionButton availability={deductAvailability} onClick={onOpenDeduct}>
            保证金扣减
          </ActionButton>
          <ActionButton availability={refundAvailability} onClick={onOpenRefund}>
            保证金退款
          </ActionButton>
        </Space>
      }
      title="保证金结算"
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          message={
            alreadyReturned
              ? "本面板用于退车后的保证金结算。当前阶段支持损伤费用账单、保证金扣减和人工确认退款，不接入真实退款渠道。"
              : "订单尚未完成退车，暂不能进行保证金结算。"
          }
          showIcon
          type={alreadyReturned ? "info" : "warning"}
        />
        {settlementError ? <Alert message={settlementError} showIcon type="error" /> : null}

        <Descriptions
          bordered
          column={2}
          title="结算概览"
          items={[
            { label: "订单编号", children: safeText(settlement?.orderNo ?? order.orderNo) },
            {
              label: "客户",
              children: joinText(customerLabel, customerMobile)
            },
            { label: "保证金已收", children: formatYuan(settlement?.collectedAmount) },
            { label: "已扣减", children: formatYuan(settlement?.deductedAmount) },
            { label: "已退款", children: formatYuan(settlement?.refundedAmount) },
            { label: "当前可用余额", children: formatYuan(settlement?.availableDepositBalance ?? settlement?.availableBalance) },
            { label: "损伤费用账单", children: formatYuan(settlement?.damageFeeAmount) },
            { label: "已抵扣", children: formatYuan(settlement?.damageFeeDeductedAmount) },
            { label: "剩余未收", children: formatYuan(settlement?.damageFeeRemainingAmount) },
            { label: "建议扣减", children: formatYuan(settlement?.deductibleAmount) },
            { label: "建议退款", children: formatYuan(settlement?.refundableAmount) }
          ]}
        />

        <Table
          columns={damageColumns}
          dataSource={damageRows}
          loading={depositSettlementLoading}
          locale={{ emptyText: "-" }}
          pagination={false}
          rowKey="id"
          scroll={{ x: 980 }}
          size="small"
          title={() => "损伤明细"}
        />

        <Table
          columns={ledgerColumns}
          dataSource={ledgerRows}
          loading={depositSettlementLoading}
          locale={{ emptyText: "-" }}
          onRow={(ledger) =>
            ({
              "data-workspace-record": ledger.id
            }) as HTMLAttributes<HTMLTableRowElement>
          }
          pagination={false}
          rowKey="id"
          scroll={{ x: 1040 }}
          size="small"
          title={() => "保证金台账"}
        />
      </Space>
    </Card>
  );
}

function getPrepareDeliveryDisabledReason(
  order: OrderDetail | null,
  deliveryCheck: DeliveryCheck | null,
  delivery: VehicleDelivery | null,
  orderChangeLocked: boolean
) {
  if (!order) {
    return "数据加载完成后才可操作";
  }
  if (orderChangeLocked) {
    return "当前订单存在进行中的变更申请";
  }
  if (deliveryCheck?.alreadyDelivered || isOrderDelivered(order) || delivery?.deliveryStatus === "DELIVERED") {
    return "订单已交付，不能重新准备交付";
  }
  if (!DELIVERY_PREPARE_ORDER_STATUSES.has(order.orderStatus)) {
    return "当前订单状态不允许准备交付";
  }
  if (!(deliveryCheck?.contractSigned ?? isContractSigned(order.contract?.status))) {
    return "请先完成合同签署";
  }
  if ((deliveryCheck?.vehicleStatus ?? order.vehicle?.status) !== "RESERVED") {
    return "交付前车辆必须处于“签约锁定（RESERVED）”状态。";
  }
  if (deliveryCheck && !deliveryCheck.canPrepareDelivery) {
    return deliveryCheck.blockingReasons[0] ?? "当前订单不满足准备交付条件";
  }
  if (!deliveryCheck) {
    return "交付条件检查加载完成后才可操作";
  }
  return null;
}

function getConfirmDeliveryDisabledReason(
  order: OrderDetail | null,
  deliveryCheck: DeliveryCheck | null,
  delivery: VehicleDelivery | null,
  orderChangeLocked: boolean,
  stage2SigningComplete: boolean
) {
  if (!order) {
    return "数据加载完成后才可操作";
  }
  if (orderChangeLocked) {
    return "当前订单存在进行中的变更申请";
  }
  if (deliveryCheck?.alreadyDelivered || isOrderDelivered(order) || delivery?.deliveryStatus === "DELIVERED") {
    return "订单已交付，不能重复确认交付";
  }
  if (delivery?.deliveryStatus !== "READY") {
    return "请先完成准备交付";
  }
  if (!stage2SigningComplete) {
    return "客户签署与平台盖章完成后才可确认交付";
  }
  if ((deliveryCheck?.vehicleStatus ?? order.vehicle?.status) !== "RESERVED") {
    return "交付前车辆必须处于“签约锁定（RESERVED）”状态。";
  }
  if (!deliveryCheck) {
    return "交付条件检查加载完成后才可操作";
  }
  if (!deliveryCheck.canConfirmDelivery) {
    return "交付条件未全部满足";
  }
  return null;
}

function getPrepareReturnDisabledReason(
  order: OrderDetail | null,
  returnCheck: ReturnCheck | null,
  vehicleReturn: VehicleReturn | null,
  orderChangeLocked: boolean
) {
  if (!order) {
    return "数据加载完成后才可操作";
  }
  if (orderChangeLocked) {
    return "当前订单存在进行中的变更申请";
  }
  if (returnCheck?.alreadyReturned || isOrderReturned(order) || vehicleReturn?.returnStatus === "CONFIRMED") {
    return "该订单已完成退车";
  }
  if (order.orderStatus !== "ACTIVE" || !order.actualDeliveryAt) {
    return "订单尚未起租，不能退车";
  }
  if ((returnCheck?.vehicleStatus ?? order.vehicle?.status) !== "LEASED") {
    return "车辆状态不是已出租，不能退车";
  }
  if (returnCheck && !returnCheck.canPrepareReturn) {
    return returnCheck.blockingReasons[0] ?? "当前订单不满足准备退车条件";
  }
  if (!returnCheck) {
    return "退车条件检查加载完成后才可操作";
  }
  return null;
}

function getConfirmReturnDisabledReason(
  order: OrderDetail | null,
  returnCheck: ReturnCheck | null,
  vehicleReturn: VehicleReturn | null,
  orderChangeLocked: boolean
) {
  if (!order) {
    return "数据加载完成后才可操作";
  }
  if (orderChangeLocked) {
    return "当前订单存在进行中的变更申请";
  }
  if (returnCheck?.alreadyReturned || isOrderReturned(order) || vehicleReturn?.returnStatus === "CONFIRMED") {
    return "该订单已完成退车";
  }
  if (vehicleReturn?.returnStatus !== "READY") {
    return "请先准备退车";
  }
  if (order.orderStatus !== "ACTIVE" || !order.actualDeliveryAt) {
    return "当前订单尚未起租";
  }
  if ((returnCheck?.vehicleStatus ?? order.vehicle?.status) !== "LEASED") {
    return "当前车辆不是已出租状态";
  }
  if (!returnCheck) {
    return "退车条件检查加载完成后才可操作";
  }
  if (!returnCheck.canConfirmReturn) {
    return returnCheck.blockingReasons[0] ?? "退车条件未全部满足";
  }
  return null;
}

function isOrderDelivered(order: OrderDetail) {
  return Boolean(order.actualDeliveryAt || order.orderStatus === "ACTIVE");
}

function isOrderReturned(order: OrderDetail) {
  return Boolean(order.actualReturnAt || order.orderStatus === "COMPLETED" || order.orderStatus === "TERMINATED");
}

function isContractSigned(status?: string | null) {
  return status === "SIGNED" || status === "ARCHIVED";
}

function OverviewLifecycleSummary({ order }: { order: OrderDetail }) {
  return (
    <Descriptions
      bordered
      column={{ lg: 4, md: 2, sm: 1, xs: 1 }}
      items={[
        {
          children: <Tag color="blue">{labelOf(ORDER_STATUS_LABELS, order.orderStatus)}</Tag>,
          label: "当前生命周期"
        },
        {
          children: <ReviewStatusTag value={order.creditReviewStatus} />,
          label: "信用审核"
        },
        {
          children: <ReviewStatusTag value={order.productReviewStatus} />,
          label: "产品审核"
        },
        {
          children: <ReviewStatusTag value={order.vehicleReviewStatus} />,
          label: "车辆审核"
        }
      ]}
      size="small"
    />
  );
}

function RecentOrderActivity({
  items,
  onNavigate
}: {
  items: OrderWorkspaceActivity[];
  onNavigate: (target: { focus?: string; tab: OrderWorkspaceTabKey }) => void;
}) {
  return (
    <section aria-label="最近动态">
      <Typography.Title level={5} style={{ margin: "0 0 8px" }}>
        最近动态
      </Typography.Title>
      <List
        dataSource={items}
        locale={{ emptyText: "暂无最近动态" }}
        renderItem={(item) => (
          <List.Item
            actions={[
              <Button
                key="open"
                onClick={() =>
                  onNavigate({
                    ...(item.targetRecordId ? { focus: item.targetRecordId } : {}),
                    tab: item.targetTab
                  })
                }
                size="small"
                type="link"
              >
                查看
              </Button>
            ]}
            data-workspace-record={item.id}
          >
            <List.Item.Meta
              description={formatTime(item.occurredAt)}
              title={item.title}
            />
          </List.Item>
        )}
        size="small"
      />
    </section>
  );
}

function ServiceCasesPanel({
  items,
  loading,
  orderId
}: {
  items: PortalServiceCase[];
  loading: boolean;
  orderId: string;
}) {
  const columns: ColumnsType<PortalServiceCase> = [
    {
      dataIndex: "caseNo",
      render: (value: string, record) => (
        <Typography.Text data-workspace-record={record.id} strong>
          {value}
        </Typography.Text>
      ),
      title: "工单编号",
      width: 180
    },
    {
      dataIndex: "caseType",
      render: (value: string, record) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{labelOf(SERVICE_CASE_TYPE_LABELS, value)}</Typography.Text>
          <Typography.Text ellipsis style={{ maxWidth: 360 }} type="secondary">
            {record.title || record.description || "-"}
          </Typography.Text>
        </Space>
      ),
      title: "类型 / 标题"
    },
    {
      dataIndex: "caseStatus",
      render: (value: string) => (
        <Tag>{labelOf(SERVICE_CASE_STATUS_LABELS, value)}</Tag>
      ),
      title: "状态",
      width: 130
    },
    {
      dataIndex: "priority",
      title: "优先级",
      width: 100
    },
    {
      dataIndex: "updatedAt",
      render: (value: string | null, record) =>
        formatTime(value ?? record.createdAt),
      title: "更新时间",
      width: 180
    }
  ];

  return (
    <Card
      extra={
        <Link href={`/service-cases?orderId=${encodeURIComponent(orderId)}`}>
          进入服务工单列表
        </Link>
      }
      title="订单服务工单"
    >
      <Table
        columns={columns}
        dataSource={items}
        loading={loading}
        locale={{ emptyText: "当前订单暂无服务工单" }}
        onRow={(serviceCase) =>
          ({
            "data-workspace-record": serviceCase.id
          }) as HTMLAttributes<HTMLTableRowElement>
        }
        pagination={false}
        rowKey="id"
        scroll={{ x: 960 }}
        size="small"
      />
    </Card>
  );
}

function HandoverProgressRecords({
  resolvedRecordIds,
  summary
}: {
  resolvedRecordIds: readonly string[];
  summary: OrderWorkspaceSummary | null;
}) {
  const guidance = summary?.guidance.filter(
    (item) => item.category === "handover"
  ) ?? [];
  const targetIds = getOrderWorkspaceFallbackRecordIds(
    getOrderWorkspaceRecordIds(
      summary?.primaryAction?.targetTab === "handover"
        ? summary.primaryAction.targetRecordId
        : null,
      ...guidance.map((item) => item.targetRecordId)
    ),
    resolvedRecordIds
  );

  if (targetIds.length === 0) {
    return null;
  }

  return (
    <Card size="small" title="当前交接推进记录">
      <List
        dataSource={targetIds}
        renderItem={(targetId) => {
          const state = guidance.find(
            (item) => item.targetRecordId === targetId
          )?.state;
          return (
            <List.Item data-workspace-record={targetId}>
              <Space wrap>
                <Typography.Text strong>交接事项</Typography.Text>
                {state ? (
                  <Tag color={getWorkspaceStatePresentation(state).color}>
                    {getWorkspaceStatePresentation(state).label}
                  </Tag>
                ) : null}
                <Typography.Text type="secondary">
                  请在当前交接工作台继续查看和处理
                </Typography.Text>
              </Space>
            </List.Item>
          );
        }}
        size="small"
      />
    </Card>
  );
}

function FinanceProgressRecords({
  links,
  resolvedRecordIds,
  summary
}: {
  links: ReadonlyArray<{ href: string; label: string }>;
  resolvedRecordIds: readonly string[];
  summary: OrderWorkspaceSummary | null;
}) {
  const guidance = summary?.guidance.filter(
    (item) => item.category === "finance"
  ) ?? [];
  const targetIds = getOrderWorkspaceFallbackRecordIds(
    getOrderWorkspaceRecordIds(
      summary?.primaryAction?.targetTab === "finance"
        ? summary.primaryAction.targetRecordId
        : null,
      ...guidance.map((item) => item.targetRecordId)
    ),
    resolvedRecordIds
  );

  return (
    <Card
      extra={
        links.length > 0 ? (
          <Space wrap>
            {links.map((link) => (
              <Link href={link.href} key={link.href}>
                {link.label}
              </Link>
            ))}
          </Space>
        ) : null
      }
      size="small"
      title="当前财务推进记录"
    >
      {targetIds.length > 0 ? (
        <List
          dataSource={targetIds}
          renderItem={(targetId) => {
            const state = guidance.find(
              (item) => item.targetRecordId === targetId
            )?.state;
            return (
              <List.Item data-workspace-record={targetId}>
                <Space wrap>
                  <Typography.Text strong>财务事项</Typography.Text>
                  {state ? (
                    <Tag color={getWorkspaceStatePresentation(state).color}>
                      {getWorkspaceStatePresentation(state).label}
                    </Tag>
                  ) : null}
                  <Typography.Text type="secondary">
                    请在现有财务模块继续查看和处理
                  </Typography.Text>
                </Space>
              </List.Item>
            );
          }}
          size="small"
        />
      ) : (
        <Typography.Text type="secondary">
          当前没有需要定位的财务推进记录
        </Typography.Text>
      )}
    </Card>
  );
}

function OrderChangeSnapshots({ changes }: { changes: OrderChangeRow[] }) {
  const snapshotChanges = changes.filter(
    (change) => change.beforeSnapshot !== undefined || change.afterSnapshot !== undefined
  );

  return (
    <section aria-label="订单变更快照">
      <Typography.Title level={5} style={{ margin: "0 0 8px" }}>
        变更前后快照
      </Typography.Title>
      <List
        dataSource={snapshotChanges}
        locale={{ emptyText: "暂无变更快照" }}
        renderItem={(change) => (
          <List.Item data-workspace-record={change.id}>
            <Descriptions
              bordered
              column={2}
              items={[
                {
                  children: renderCompactSnapshot(change.beforeSnapshot),
                  label: "变更前"
                },
                {
                  children: renderCompactSnapshot(change.afterSnapshot),
                  label: "变更后"
                }
              ]}
              size="small"
              style={{ width: "100%" }}
              title={`${labelOf(ORDER_CHANGE_TYPE_LABELS, change.changeType)} / ${formatTime(change.createdAt)}`}
            />
          </List.Item>
        )}
        size="small"
      />
    </section>
  );
}

function renderCompactSnapshot(snapshot: unknown) {
  if (snapshot === null || snapshot === undefined) {
    return "-";
  }

  let value: string;
  try {
    value = JSON.stringify(snapshot, null, 2);
  } catch {
    value = String(snapshot);
  }

  return (
    <pre
      style={{
        margin: 0,
        maxHeight: 220,
        maxWidth: "100%",
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }}
    >
      {value}
    </pre>
  );
}

interface WorkspaceDomainLoadState {
  error: string | null;
  loaded: boolean;
  loading: boolean;
}

function createWorkspaceDomainLoadStates(): Record<
  OrderWorkspaceTabKey,
  WorkspaceDomainLoadState
> {
  return {
    change: { error: null, loaded: false, loading: false },
    contract: { error: null, loaded: false, loading: false },
    entitlement: { error: null, loaded: false, loading: false },
    finance: { error: null, loaded: false, loading: false },
    handover: { error: null, loaded: false, loading: false },
    overview: { error: null, loaded: false, loading: false },
    service: { error: null, loaded: false, loading: false }
  };
}

function OrderDetailPageContent({ orderId }: { orderId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceLocation = useMemo(
    () => parseOrderWorkspaceLocation(searchParams),
    [searchParams]
  );
  const { message, modal } = App.useApp();
  const modalConfirmRef = useRef(modal.confirm);
  modalConfirmRef.current = modal.confirm;
  const scopedConfirmRef = useRef<{
    confirm: typeof modal.confirm;
    destroy: () => void;
  } | null>(null);
  const scopedConfirm = useMemo<{ confirm: typeof modal.confirm }>(
    () => ({
      confirm(config) {
        const scope = scopedConfirmRef.current;
        if (scope) {
          return scope.confirm(config);
        }
        const handle = modalConfirmRef.current(config);
        handle.destroy();
        return handle;
      }
    }),
    []
  );
  useEffect(
    () => {
      const scope = createOrderWorkspaceConfirmScope(
        (config: Parameters<typeof modal.confirm>[0]) =>
          modalConfirmRef.current(config)
      );
      scopedConfirmRef.current = scope;
      return () => {
        scope.destroy();
        if (scopedConfirmRef.current === scope) {
          scopedConfirmRef.current = null;
        }
      };
    },
    []
  );
  const [changeForm] = Form.useForm<ChangeFormValues>();
  const [assignExternalHandoverForm] = Form.useForm<AssignExternalHandoverFormValues>();
  const [confirmDeliveryForm] = Form.useForm<ConfirmDeliveryFormValues>();
  const [confirmReturnForm] = Form.useForm<ConfirmReturnFormValues>();
  const [creditForm] = Form.useForm<{ customerGrade: string }>();
  const [deductDepositForm] = Form.useForm<DeductDepositFormValues>();
  const [consumeEntitlementForm] = Form.useForm<ConsumeEntitlementFormValues>();
  const [expireEntitlementForm] = Form.useForm<EntitlementOperationFormValues>();
  const [paymentForm] = Form.useForm<PaymentFormValues>();
  const [prepareDeliveryForm] = Form.useForm<PrepareDeliveryFormValues>();
  const [prepareReturnForm] = Form.useForm<PrepareReturnFormValues>();
  const [renewEntitlementForm] = Form.useForm<EntitlementOperationFormValues>();
  const [refundDepositForm] = Form.useForm<RefundDepositFormValues>();
  const [handoverResubmissionForm] = Form.useForm<HandoverResubmissionFormValues>();
  const [stage2FallbackForm] = Form.useForm<Stage2FallbackFormValues>();
  const [stage2VoidForm] = Form.useForm<Stage2VoidFormValues>();
  const stage2WorkflowRecoveryInFlightRef = useRef(false);
  const [assignExternalHandoverId, setAssignExternalHandoverId] = useState<string | null>(null);
  const [assignExternalHandoverOpen, setAssignExternalHandoverOpen] = useState(false);
  const [changeModalOpen, setChangeModalOpen] = useState(false);
  const [changes, setChanges] = useState<OrderChangeRow[]>([]);
  const [changesLoaded, setChangesLoaded] = useState(false);
  const [confirmDeliveryModalOpen, setConfirmDeliveryModalOpen] = useState(false);
  const [confirmReturnModalOpen, setConfirmReturnModalOpen] = useState(false);
  const [deductDepositModalOpen, setDeductDepositModalOpen] = useState(false);
  const [deductingDeposit, setDeductingDeposit] = useState(false);
  const [delivery, setDelivery] = useState<VehicleDelivery | null>(null);
  const [deliveryCheck, setDeliveryCheck] = useState<DeliveryCheck | null>(null);
  const [handoverWorkOrders, setHandoverWorkOrders] = useState<HandoverWorkOrderSummary[]>([]);
  const [handoverWorkOrdersLoading, setHandoverWorkOrdersLoading] = useState(false);
  const [handoverWorkOrdersLoadState, setHandoverWorkOrdersLoadState] =
    useState<HandoverWorkOrdersLoadState>("UNKNOWN");
  const [handoverWorkOrderDetail, setHandoverWorkOrderDetail] = useState<HandoverWorkOrderDetail | null>(null);
  const [handoverWorkOrderDetailOpen, setHandoverWorkOrderDetailOpen] = useState(false);
  const [handoverActionLoading, setHandoverActionLoading] = useState<string | null>(null);
  const [handoverESignErrors, setHandoverESignErrors] = useState<Record<string, string | undefined>>({});
  const [handoverESignLoading, setHandoverESignLoading] = useState<Record<string, boolean | undefined>>({});
  const [handoverESignStatuses, setHandoverESignStatuses] = useState<
    Record<string, AdminStage2HandoverESignStatus | undefined>
  >({});
  const [stage2WorkflowRecoveryInFlight, setStage2WorkflowRecoveryInFlight] =
    useState(false);
  const [stage2FallbackOpen, setStage2FallbackOpen] = useState(false);
  const [
    stage2FallbackSourceArtifact,
    setStage2FallbackSourceArtifact
  ] = useState<
    NonNullable<
      AdminStage2HandoverESignStatus["sourceArtifact"]
    > | null
  >(null);
  const [stage2FallbackWorkOrderId, setStage2FallbackWorkOrderId] =
    useState<string | null>(null);
  const [stage2VoidOpen, setStage2VoidOpen] = useState(false);
  const [stage2VoidWorkOrderId, setStage2VoidWorkOrderId] =
    useState<string | null>(null);
  const [handoverResubmissionDetail, setHandoverResubmissionDetail] = useState<HandoverWorkOrderDetail | null>(null);
  const [handoverResubmissionOpen, setHandoverResubmissionOpen] = useState(false);
  const [consumeEntitlementModalOpen, setConsumeEntitlementModalOpen] = useState(false);
  const [consumeEntitlementSubmitting, setConsumeEntitlementSubmitting] = useState(false);
  const [consumingGrant, setConsumingGrant] = useState<OrderEntitlementGrant | null>(null);
  const [depositSettlement, setDepositSettlement] = useState<DepositSettlement | null>(null);
  const [depositSettlementError, setDepositSettlementError] = useState<string | null>(null);
  const [depositSettlementLoading, setDepositSettlementLoading] = useState(false);
  const [entitlementLoading, setEntitlementLoading] = useState(false);
  const [entitlementUsageLoading, setEntitlementUsageLoading] = useState(false);
  const [entitlementUsagePage, setEntitlementUsagePage] = useState(1);
  const [entitlementUsagePageSize, setEntitlementUsagePageSize] = useState(10);
  const [entitlementUsageTotal, setEntitlementUsageTotal] = useState(0);
  const [entitlementUsages, setEntitlementUsages] = useState<OrderEntitlementUsage[]>([]);
  const [entitlements, setEntitlements] = useState<OrderEntitlementsResponse>({ account: null, grants: [] });
  const [expireEntitlementModalOpen, setExpireEntitlementModalOpen] = useState(false);
  const [expireEntitlementResult, setExpireEntitlementResult] = useState<ExpireEntitlementsResponse | null>(null);
  const [expiringEntitlements, setExpiringEntitlements] = useState(false);
  const [financeLoading, setFinanceLoading] = useState(false);
  const [financeSummary, setFinanceSummary] = useState<FinanceSummary | null>(null);
  const [generatingEntitlements, setGeneratingEntitlements] = useState(false);
  const [generatingDamageFeeBill, setGeneratingDamageFeeBill] = useState(false);
  const [generatingBills, setGeneratingBills] = useState(false);
  const [generatingMonthlyRentBill, setGeneratingMonthlyRentBill] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [domainLoadStates, setDomainLoadStates] = useState(
    createWorkspaceDomainLoadStates
  );
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [prepareDeliveryModalOpen, setPrepareDeliveryModalOpen] = useState(false);
  const [prepareReturnModalOpen, setPrepareReturnModalOpen] = useState(false);
  const [receivableBills, setReceivableBills] = useState<ReceivableBillRow[]>([]);
  const [refundDepositModalOpen, setRefundDepositModalOpen] = useState(false);
  const [refundingDeposit, setRefundingDeposit] = useState(false);
  const [renewEntitlementModalOpen, setRenewEntitlementModalOpen] = useState(false);
  const [renewEntitlementResult, setRenewEntitlementResult] = useState<EntitlementRenewalResponse | null>(null);
  const [renewingEntitlements, setRenewingEntitlements] = useState(false);
  const [returnCheck, setReturnCheck] = useState<ReturnCheck | null>(null);
  const [serviceCases, setServiceCases] = useState<PortalServiceCase[]>([]);
  const [serviceCasesLoading, setServiceCasesLoading] = useState(false);
  const [summary, setSummary] = useState<OrderWorkspaceSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [vehicleReturn, setVehicleReturn] = useState<VehicleReturn | null>(null);
  const [autoOpenChangeModalDone, setAutoOpenChangeModalDone] = useState(false);
  const createChangeRequested = searchParams.get("createChange") === "1";
  const autoOpenChangeRequestedRef = useRef(createChangeRequested);
  const loadedDomainsRef = useRef(new Set<OrderWorkspaceTabKey>());
  const loadedResourcesRef = useRef(new Set<string>());
  const resourcePromisesRef = useRef(new Map<string, Promise<void>>());
  const orderRef = useRef<OrderDetail | null>(null);
  const paymentAmountYuan = Form.useWatch("paymentAmountYuan", paymentForm);
  const writeOffEnabled = Form.useWatch("writeOffEnabled", paymentForm);
  const writeOffItems = Form.useWatch("writeOffItems", paymentForm);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);
  const stage2DeliveryVerifier = useMemo(
    () =>
      createAdminStage2DeliveryVerifier({
        loadESignStatus: loadAdminStage2HandoverESign,
        loadWorkOrders: (orderId) =>
          apiFetch<HandoverWorkOrderSummary[]>(
            `/orders/${encodeURIComponent(orderId)}/handover-work-orders`
          )
      }),
    []
  );
  const stage2DeliveryConfirmationController = useMemo(
    () =>
      createAdminStage2DeliveryConfirmationController({
        onBlocked: (verification) => {
          void message.warning(
            verification.reason === "LOAD_ERROR"
              ? "交接签署状态加载失败，请刷新后重试"
              : "客户签署与平台盖章完成后才可确认交付"
          );
        },
        verifier: stage2DeliveryVerifier
      }),
    [message, stage2DeliveryVerifier]
  );
  const roles = useMemo(() => new Set(me?.user.roles ?? []), [me]);
  const hasCustomerViewPermission = permissions.has("customer:view");
  const hasBillingViewPermission = permissions.has("billing:view");
  const hasPaymentWriteOffPermission = permissions.has("payment:write_off");
  const hasDeliveryViewPermission = permissions.has("delivery:view");
  const hasReturnViewPermission = permissions.has("vehicle_return:view");
  const hasDepositSettlementViewPermission = permissions.has("deposit_ledger:view");
  const hasEntitlementViewPermission = permissions.has("entitlement:view");
  const hasOrderChangeView = permissions.has("order_change:view");
  const visibleTabs = useMemo(
    () => getVisibleOrderWorkspaceTabs(permissions),
    [permissions]
  );
  const activeTab = visibleTabs.includes(workspaceLocation.tab)
    ? workspaceLocation.tab
    : "overview";
  const activeTabRef = useRef<OrderWorkspaceTabKey>(activeTab);
  activeTabRef.current = activeTab;
  const focus =
    activeTab === workspaceLocation.tab ? workspaceLocation.focus : undefined;
  const activeDomainState = domainLoadStates[activeTab];
  const activeDomainError = activeDomainState.error;
  const activeDomainLoading = activeDomainState.loading;
  const focusAttemptKey = getOrderWorkspaceFocusAttemptKey({
    activeTab,
    domainLoaded: activeDomainState.loaded,
    domainLoading: activeDomainLoading,
    focus,
    summaryAsOf: summary?.asOf ?? null
  });
  const customerPresentation = useMemo(
    () =>
      getOrderWorkspaceCustomerPresentation({
        canViewCustomer: hasCustomerViewPermission,
        customer: order?.customer,
        summaryLabel: summary?.header.customerLabel
      }),
    [
      hasCustomerViewPermission,
      order?.customer,
      summary?.header.customerLabel
    ]
  );
  const canRecordReturnDamage = permissions.has("vehicle_return:damage_record");
  const canCreateChange = permissions.has("order_change:create");
  const canRejectChange = permissions.has("order_change:reject") || permissions.has("order_change:approve");
  const isAdminOrOperator = roles.has("ADMIN") || roles.has("OP") || roles.has("GM");
  const hasOrderReviewPermission = permissions.has("order:review");
  const canReviewCredit = hasOrderReviewPermission && (isAdminOrOperator || roles.has("RC"));
  const canReviewProduct = hasOrderReviewPermission && isAdminOrOperator;
  const canReviewVehicle = hasOrderReviewPermission && (isAdminOrOperator || roles.has("AS"));
  const canConfirmFinalPlan = permissions.has("order:confirm_final_plan");
  const canRejectCustomerOrder = permissions.has("order:reject") || isAdminOrOperator;
  const currentVehicleSalePrice = toNumber(
    order?.vehicle?.currentSalePriceAmount ??
      getSnapshotValue(order?.quoteSnapshot, "vehicleSnapshot.currentSalePriceAmount", "vehicleSalePriceAmount")
  );
  const validInitialBills = useMemo(() => receivableBills.filter(validInitialBill), [receivableBills]);
  const hasDepositBill = validInitialBills.some((bill) => bill.billType === "DEPOSIT");
  const hasFirstMonthlyFeeBill = validInitialBills.some((bill) => bill.billType === "FIRST_MONTHLY_FEE");
  const unsettledBills = useMemo(
    () => receivableBills.filter((bill) => bill.billStatus !== "CANCELLED" && hasPositiveAmount(bill.remainingAmount)),
    [receivableBills]
  );
  const damageFeeBills = useMemo(
    () => getDamageFeeBills(depositSettlement, receivableBills),
    [depositSettlement, receivableBills]
  );
  const damageFeeBillOptions = useMemo(
    () =>
      damageFeeBills.map((bill) => ({
        label: `${labelOf(BILL_TYPE_LABELS, bill.billType)} / ${bill.billNo} / 剩余 ${formatYuan(bill.remainingAmount)}`,
        value: bill.id
      })),
    [damageFeeBills]
  );
  const damageFeeBillForDeduction =
    damageFeeBills.find((bill) => (toNumber(bill.remainingAmount) ?? 0) > 0) ?? null;
  const hasActiveDamageFeeBill = damageFeeBills.length > 0;
  const orderReturned = Boolean(order && isOrderReturned(order));
  const vehicleReturnWorkspaceState = getVehicleReturnWorkspaceState({
    actualDeliveryAt: order?.actualDeliveryAt,
    actualReturnAt: order?.actualReturnAt,
    deliveryAlreadyDelivered: deliveryCheck?.alreadyDelivered,
    deliveryStatus:
      deliveryCheck?.deliveryStatus ?? delivery?.deliveryStatus ?? null,
    hasReturnRecord: Boolean(vehicleReturn),
    returnAlreadyCompleted: returnCheck?.alreadyReturned,
    returnStatus:
      returnCheck?.returnStatus ?? vehicleReturn?.returnStatus ?? null
  });
  const availableDepositBalance = getDepositAvailableBalance(depositSettlement);
  const damageFeeRemainingAmount = getDamageFeeRemainingAmount(depositSettlement);
  const suggestedDeductibleAmount = getSuggestedDeductibleAmount(depositSettlement);
  const suggestedRefundableAmount = getSuggestedRefundableAmount(depositSettlement);
  const hasCustomerDamageFee = hasBillableCustomerDamage(depositSettlement);
  const initialDepositAmount = order
    ? pickNonNegativeValue(
        order.finalDepositAmount,
        order.depositAmount,
        getSnapshotValue(order.quoteSnapshot, "finalDepositAmount"),
        getSnapshotValue(order.quoteSnapshot, "depositAmount"),
        getSnapshotValue(order.quoteSnapshot, "pricing.depositAmount")
      )
    : undefined;
  const initialDepositRequired = hasPositiveAmount(initialDepositAmount);
  const depositInitialBillSatisfied = !initialDepositRequired || hasDepositBill;
  const hasAllInitialBills = depositInitialBillSatisfied && hasFirstMonthlyFeeBill;
  const initialMonthlyFeeAmount = order
    ? pickPositiveValue(
        order.monthlyFeeAmount,
        getSnapshotValue(order.quoteSnapshot, "monthlyFeeAmount"),
        getSnapshotValue(order.quoteSnapshot, "pricing.monthlyFeeAmount")
      )
    : undefined;
  const monthlyRentAmount = order
    ? pickPositiveValue(
        order.monthlyFeeAmount,
        getSnapshotValue(order.quoteSnapshot, "pricing.monthlyFeeAmount"),
        getSnapshotValue(order.quoteSnapshot, "monthlyFeeAmount")
      )
    : undefined;
  const orderHasInitialBillAmounts = Boolean(
    order && hasNonNegativeAmount(initialDepositAmount) && hasPositiveAmount(initialMonthlyFeeAmount)
  );
  const generateInitialBillsDisabledReason = !order
    ? "数据加载完成后才可操作"
    : FINANCE_FINAL_ORDER_STATUSES.has(order.orderStatus)
      ? "当前订单状态不允许生成账单"
      : !orderHasInitialBillAmounts
        ? "订单缺少押金或首期月费金额"
        : hasAllInitialBills
          ? "已存在有效初始账单"
          : null;
  const generateInitialBillsAvailability = actionAvailability({
    allowed: generateInitialBillsDisabledReason === null,
    disabledReason: generateInitialBillsDisabledReason ?? "当前订单状态不允许生成账单",
    noPermissionReason: "无生成账单权限",
    permission: "billing:generate",
    permissions
  });
  const generateMonthlyRentDisabledReason = !order
    ? "数据加载完成后才可操作"
    : order.orderStatus !== "ACTIVE"
      ? "当前订单状态不允许生成月租账单"
      : !order.actualDeliveryAt
        ? "当前订单尚未起租，不能生成月租账单"
        : !hasPositiveAmount(monthlyRentAmount)
          ? "订单缺少月租金额，无法生成月租账单"
          : null;
  const generateMonthlyRentAvailability = actionAvailability({
    allowed: generateMonthlyRentDisabledReason === null,
    disabledReason: generateMonthlyRentDisabledReason ?? "当前订单状态不允许生成月租账单",
    noPermissionReason: "无生成账单权限",
    permission: "billing:generate",
    permissions
  });
  const paymentDisabledReason = !order
    ? "数据加载完成后才可操作"
    : FINANCE_FINAL_ORDER_STATUSES.has(order.orderStatus)
      ? "当前订单已取消，不能登记收款"
      : null;
  const paymentAvailability = actionAvailability({
    allowed: paymentDisabledReason === null,
    disabledReason: paymentDisabledReason ?? "当前订单已取消，不能登记收款",
    noPermissionReason: "无登记收款权限",
    permission: "payment:create",
    permissions
  });
  const watchedPaymentAmount = yuanToCents(paymentAmountYuan) ?? 0;
  const watchedWriteOffTotalAmount = useMemo(
    () =>
      (writeOffItems ?? []).reduce((sum, item) => {
        const amount = yuanToCents(item?.writeOffAmountYuan);
        return sum + (amount && amount > 0 ? amount : 0);
      }, 0),
    [writeOffItems]
  );
  const writeOffDisabledReason = !hasPaymentWriteOffPermission
    ? "无核销权限"
    : unsettledBills.length === 0
      ? "没有可核销的未结清账单"
      : null;
  const writeOffTotalExceedsPayment = Boolean(
    writeOffEnabled && watchedWriteOffTotalAmount > 0 && watchedWriteOffTotalAmount > watchedPaymentAmount
  );
  const isCustomerSelfServiceOrder = order?.orderSource === "CUSTOMER_SELF_SERVICE";
  const returnToPlanHint = isCustomerSelfServiceOrder
    ? "客户需重新提交订单申请。"
    : "返回进件详情重新生成订阅报价和订阅订单。";
  const activeOrderChange = hasOrderChangeView
    ? changes.find(
        (change) =>
          !change.executedAt &&
          (change.status === "PENDING" || change.status === "APPROVED")
      )
    : undefined;
  const changeGuard = getOrderWorkspaceChangeGuard({
    changesLoaded,
    hasActiveChange: Boolean(activeOrderChange),
    hasOrderChangeView
  });
  const orderChangeLocked = changeGuard.locked;
  const canCancelActiveChange = Boolean(
    activeOrderChange &&
      activeOrderChange.status === "PENDING" &&
      (roles.has("ADMIN") || activeOrderChange.createdBy === me?.user.id)
  );
  const generateContractAvailability = changeGuard.waiting
    ? { allowed: false, reason: "订单变更状态加载完成后才可生成合同" }
    : orderChangeLocked
    ? { allowed: false, reason: "当前订单存在进行中的变更申请，请先处理后再生成合同" }
    : getGenerateContractAvailability(order, permissions);
  const applyChangeAvailability = actionAvailability({
    allowed: Boolean(
      order &&
        !changeGuard.waiting &&
        !orderChangeLocked &&
        PRE_CONTRACT_CHANGE_ORDER_STATUSES.has(order.orderStatus)
    ),
    disabledReason: changeGuard.waiting
      ? "订单变更状态加载完成后才可操作"
      : orderChangeLocked
        ? "该订单已有进行中的变更申请"
        : "当前订单状态不允许发起变更",
    noPermissionReason: "无创建订单变更权限",
    permission: "order_change:create",
    permissions
  });
  const cancelOrderAvailability = actionAvailability({
    allowed: Boolean(
      order &&
        !changeGuard.waiting &&
        ["PENDING_CONTRACT", "PENDING_SIGN", "PENDING_PAYMENT"].includes(order.orderStatus) &&
        !orderChangeLocked
    ),
    disabledReason: changeGuard.waiting
      ? "订单变更状态加载完成后才可操作"
      : orderChangeLocked
        ? "该订单已有进行中的变更申请"
        : "当前订单状态不允许取消",
    noPermissionReason: "无取消订单权限",
    permission: "order:cancel",
    permissions
  });
  const prepareDeliveryDisabledReason = changeGuard.waiting
    ? "订单变更状态加载完成后才可操作"
    : getPrepareDeliveryDisabledReason(order, deliveryCheck, delivery, orderChangeLocked);
  const prepareDeliveryAvailability = actionAvailability({
    allowed: prepareDeliveryDisabledReason === null,
    disabledReason: prepareDeliveryDisabledReason ?? "当前订单状态不允许准备交付",
    noPermissionReason: "无准备交付权限",
    permission: "delivery:prepare",
    permissions
  });
  const activeHandoverWorkOrders = handoverWorkOrders.filter(
    isActiveHandoverWorkOrder
  );
  const activeHandoverWorkOrder = activeHandoverWorkOrders[0];
  const stage2SigningComplete =
    handoverWorkOrdersLoadState === "LOADED" &&
    (
      activeHandoverWorkOrders.length === 0 ||
      (
        activeHandoverWorkOrders.length === 1 &&
        activeHandoverWorkOrder !== undefined &&
        getAdminStage2HandoverWorkflowDisplay(
          handoverESignStatuses[activeHandoverWorkOrder.id],
          {
            customerConfirmedAt: activeHandoverWorkOrder.customerConfirmedAt,
            pdfStatus: activeHandoverWorkOrder.stage2Pdf?.status,
            workflowJobs: activeHandoverWorkOrder.workflowJobs
          }
        ).deliveryConfirmationAvailable
      )
    );
  const confirmDeliveryDisabledReason = changeGuard.waiting
    ? "订单变更状态加载完成后才可操作"
    : getConfirmDeliveryDisabledReason(
        order,
        deliveryCheck,
        delivery,
        orderChangeLocked,
        stage2SigningComplete
      );
  const confirmDeliveryAvailability = actionAvailability({
    allowed: confirmDeliveryDisabledReason === null,
    disabledReason: confirmDeliveryDisabledReason ?? "当前订单状态不允许交付",
    noPermissionReason: "无确认交付权限",
    permission: "delivery:confirm",
    permissions
  });
  const createHandoverWorkOrderDisabledReason = !order
    ? "数据加载完成后才可操作"
    : changeGuard.waiting
      ? "订单变更状态加载完成后才可操作"
      : orderChangeLocked
      ? "当前订单存在进行中的变更申请"
      : activeHandoverWorkOrder
        ? "已存在进行中的交付工单"
        : !deliveryCheck
          ? "交付条件检查加载完成后才可操作"
          : !deliveryCheck.canPrepareDelivery
            ? deliveryCheck.blockingReasons[0] ?? "请先完成交付准备项"
            : delivery?.deliveryStatus !== "READY"
              ? "请先在车辆交付模块完成准备交付"
              : null;
  const createHandoverWorkOrderAvailability = actionAvailability({
    allowed: createHandoverWorkOrderDisabledReason === null,
    disabledReason: createHandoverWorkOrderDisabledReason ?? "请先完成交付准备项",
    noPermissionReason: "无准备交付权限",
    permission: "delivery:prepare",
    permissions
  });
  const prepareReturnDisabledReason = changeGuard.waiting
    ? "订单变更状态加载完成后才可操作"
    : getPrepareReturnDisabledReason(order, returnCheck, vehicleReturn, orderChangeLocked);
  const prepareReturnAvailability = actionAvailability({
    allowed: prepareReturnDisabledReason === null,
    disabledReason: prepareReturnDisabledReason ?? "当前订单状态不允许准备退车",
    noPermissionReason: "无准备退车权限",
    permission: "vehicle_return:prepare",
    permissions
  });
  const confirmReturnDisabledReason = changeGuard.waiting
    ? "订单变更状态加载完成后才可操作"
    : getConfirmReturnDisabledReason(order, returnCheck, vehicleReturn, orderChangeLocked);
  const confirmReturnAvailability = actionAvailability({
    allowed: confirmReturnDisabledReason === null,
    disabledReason: confirmReturnDisabledReason ?? "当前订单状态不允许确认退车",
    noPermissionReason: "无确认退车权限",
    permission: "vehicle_return:confirm",
    permissions
  });

  const generateDamageFeeBillDisabledReason = !order
    ? "数据加载完成后才可操作"
    : !orderReturned
      ? "订单尚未完成退车，不能生成损伤费用账单"
      : depositSettlementLoading
        ? "保证金结算信息加载完成后才可操作"
        : depositSettlementError
          ? depositSettlementError
          : hasActiveDamageFeeBill
            ? "该订单已存在损伤费用账单"
            : !hasCustomerDamageFee
              ? "当前订单无客户责任损伤费用"
              : null;
  const generateDamageFeeBillAvailability = actionAvailability({
    allowed: generateDamageFeeBillDisabledReason === null,
    disabledReason: generateDamageFeeBillDisabledReason ?? "当前订单不能生成损伤费用账单",
    noPermissionReason: "无生成账单权限",
    permission: "billing:generate",
    permissions
  });
  const deductDepositDisabledReason = !order
    ? "数据加载完成后才可操作"
    : !orderReturned
      ? "订单尚未完成退车，不能扣减保证金"
      : depositSettlementLoading
        ? "保证金结算信息加载完成后才可操作"
        : depositSettlementError
          ? depositSettlementError
          : !damageFeeBillForDeduction
            ? "没有可扣减的损伤费用账单"
            : damageFeeRemainingAmount <= 0
              ? "损伤费用已结清"
              : availableDepositBalance <= 0
                ? "当前可用保证金余额不足"
                : suggestedDeductibleAmount <= 0
                  ? "没有可扣减金额"
                  : null;
  const deductDepositAvailability = actionAvailability({
    allowed: deductDepositDisabledReason === null,
    disabledReason: deductDepositDisabledReason ?? "当前不能扣减保证金",
    noPermissionReason: "无保证金扣减权限",
    permission: "deposit_ledger:deduct",
    permissions
  });
  const refundDepositDisabledReason = !order
    ? "数据加载完成后才可操作"
    : !orderReturned
      ? "订单尚未完成退车，不能退款"
      : depositSettlementLoading
        ? "保证金结算信息加载完成后才可操作"
        : depositSettlementError
          ? depositSettlementError
          : availableDepositBalance <= 0
            ? "当前无可退款保证金"
            : damageFeeRemainingAmount > 0 && suggestedDeductibleAmount > 0
              ? "请先处理损伤费用"
              : suggestedRefundableAmount <= 0
                ? "当前无可退款保证金"
                : null;
  const refundDepositAvailability = actionAvailability({
    allowed: refundDepositDisabledReason === null,
    disabledReason: refundDepositDisabledReason ?? "当前不能退款",
    noPermissionReason: "无保证金退款权限",
    permission: "deposit_ledger:refund",
    permissions
  });

  const loadEntitlementUsages = useCallback(async (orderId: string, page: number, pageSize: number) => {
    setEntitlementUsageLoading(true);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      const result = await apiFetch<OrderEntitlementUsageResponse>(`/orders/${orderId}/entitlement-usages?${query}`);
      setEntitlementUsages(result.items);
      setEntitlementUsageTotal(result.total);
      setEntitlementUsagePage(result.page);
      setEntitlementUsagePageSize(result.pageSize);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setEntitlementUsageLoading(false);
    }
  }, [message]);

  const refreshStage2HandoverESignStatus = useCallback(async (id: string) => {
    setHandoverESignLoading((current) => ({ ...current, [id]: true }));
    setHandoverESignErrors((current) => ({ ...current, [id]: undefined }));
    try {
      const status = await loadAdminStage2HandoverESignWithInitialAssignmentPolling(id);
      setHandoverESignStatuses((current) => ({ ...current, [id]: status }));
    } catch (error) {
      setHandoverESignErrors((current) => ({
        ...current,
        [id]: getAdminStage2HandoverESignErrorMessage(error)
      }));
    } finally {
      setHandoverESignLoading((current) => ({ ...current, [id]: false }));
    }
  }, []);

  const navigateWorkspace = useCallback(
    (target: {
      createChange?: boolean;
      focus?: string;
      tab: OrderWorkspaceTabKey;
    }) => {
      const location = buildOrderWorkspaceLocation({
        ...(target.createChange ? { createChange: true } : {}),
        ...(target.focus ? { focus: target.focus } : {}),
        orderId,
        tab: target.tab
      });
      router.replace(location, { scroll: false });
    },
    [orderId, router]
  );

  const loadOrderDetail = useCallback(
    async (force = false) => {
      if (!force && loadedResourcesRef.current.has("order") && orderRef.current) {
        return;
      }
      const nextOrder = await apiFetch<OrderDetail>(
        `/orders/${orderId}/workspace/detail`
      );
      orderRef.current = nextOrder;
      setOrder(nextOrder);
      loadedResourcesRef.current.add("order");
    },
    [orderId]
  );

  const loadWorkspaceResource = useCallback(
    async (key: string, force: boolean, loader: () => Promise<void>) => {
      if (!force && loadedResourcesRef.current.has(key)) {
        return;
      }
      const inFlight = resourcePromisesRef.current.get(key);
      if (!force && inFlight) {
        await inFlight;
        return;
      }

      const promise = loader().then(() => {
        loadedResourcesRef.current.add(key);
      });
      resourcePromisesRef.current.set(key, promise);
      try {
        await promise;
      } finally {
        if (resourcePromisesRef.current.get(key) === promise) {
          resourcePromisesRef.current.delete(key);
        }
      }
    },
    []
  );

  const loadChangesDomain = useCallback(
    async (force: boolean) => {
      if (!hasOrderChangeView) {
        return;
      }
      await loadWorkspaceResource("changes", force, async () => {
        const nextChanges = await apiFetch<OrderChangeRow[]>(
          `/orders/${orderId}/changes`
        );
        setChanges(nextChanges);
        setChangesLoaded(true);
      });
    },
    [hasOrderChangeView, loadWorkspaceResource, orderId]
  );

  const loadDepositSettlementDomain = useCallback(
    async (force: boolean) => {
      if (!hasDepositSettlementViewPermission) {
        return;
      }
      setDepositSettlementLoading(true);
      setDepositSettlementError(null);
      try {
        await loadWorkspaceResource("deposit-settlement", force, async () => {
          const nextSettlement = await apiFetch<DepositSettlement>(
            `/orders/${orderId}/deposit-settlement`
          );
          setDepositSettlement(nextSettlement);
        });
      } catch (error) {
        setDepositSettlementError(getErrorMessage(error));
        throw error;
      } finally {
        setDepositSettlementLoading(false);
      }
    },
    [
      hasDepositSettlementViewPermission,
      loadWorkspaceResource,
      orderId
    ]
  );

  const loadHandoverDomain = useCallback(
    async (force: boolean) => {
      const loads: Promise<void>[] = [];

      if (hasOrderChangeView) {
        loads.push(loadChangesDomain(force));
      }

      if (hasDeliveryViewPermission) {
        loads.push(
          loadWorkspaceResource("delivery", force, async () => {
            const [nextDeliveryCheck, nextDelivery] = await Promise.all([
              apiFetch<DeliveryCheck>(`/orders/${orderId}/delivery-check`),
              apiFetch<VehicleDelivery | null>(`/orders/${orderId}/delivery`)
            ]);
            setDeliveryCheck(nextDeliveryCheck);
            setDelivery(nextDelivery);
          })
        );
        loads.push(
          loadWorkspaceResource("handover-work-orders", force, async () => {
            setHandoverWorkOrdersLoading(true);
            setHandoverWorkOrdersLoadState("LOADING");
            try {
              const nextWorkOrders = await apiFetch<HandoverWorkOrderSummary[]>(
                `/orders/${orderId}/handover-work-orders`
              );
              setHandoverWorkOrders(nextWorkOrders);
              setHandoverWorkOrdersLoadState("LOADED");
              await Promise.all(
                nextWorkOrders.map((workOrder) =>
                  refreshStage2HandoverESignStatus(workOrder.id)
                )
              );
            } catch (error) {
              setHandoverWorkOrdersLoadState("ERROR");
              throw error;
            } finally {
              setHandoverWorkOrdersLoading(false);
            }
          })
        );
      }

      if (
        hasReturnViewPermission &&
        vehicleReturnWorkspaceState !== "HIDDEN"
      ) {
        loads.push(
          loadWorkspaceResource("vehicle-return", force, async () => {
            const [nextReturnCheck, nextReturn] = await Promise.all([
              apiFetch<ReturnCheck>(`/orders/${orderId}/return-check`),
              apiFetch<VehicleReturn | null>(`/orders/${orderId}/return`)
            ]);
            setReturnCheck(nextReturnCheck);
            setVehicleReturn(nextReturn);
          })
        );
      }

      const results = await Promise.allSettled(loads);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure) {
        throw failure.reason;
      }
    },
    [
      hasDeliveryViewPermission,
      hasOrderChangeView,
      hasReturnViewPermission,
      loadChangesDomain,
      loadWorkspaceResource,
      orderId,
      refreshStage2HandoverESignStatus,
      vehicleReturnWorkspaceState
    ]
  );

  const loadEntitlementDomain = useCallback(
    async (force: boolean) => {
      if (!hasEntitlementViewPermission) {
        return;
      }
      setEntitlementLoading(true);
      setEntitlementUsageLoading(true);
      try {
        await loadWorkspaceResource("entitlement", force, async () => {
          const [nextEntitlements, nextUsages] = await Promise.all([
            apiFetch<OrderEntitlementsResponse>(
              `/orders/${orderId}/entitlements`
            ),
            apiFetch<OrderEntitlementUsageResponse>(
              `/orders/${orderId}/entitlement-usages?page=1&pageSize=10`
            )
          ]);
          setEntitlements(nextEntitlements);
          setEntitlementUsages(nextUsages.items);
          setEntitlementUsageTotal(nextUsages.total);
          setEntitlementUsagePage(nextUsages.page);
          setEntitlementUsagePageSize(nextUsages.pageSize);
        });
      } finally {
        setEntitlementLoading(false);
        setEntitlementUsageLoading(false);
      }
    },
    [
      hasEntitlementViewPermission,
      loadWorkspaceResource,
      orderId
    ]
  );

  const loadFinanceDomain = useCallback(
    async (force: boolean) => {
      const loads: Promise<void>[] = [];
      if (hasBillingViewPermission) {
        setFinanceLoading(true);
        loads.push(
          loadWorkspaceResource("finance", force, async () => {
            try {
              const [nextFinanceSummary, nextBills] = await Promise.all([
                apiFetch<FinanceSummary>(
                  `/orders/${orderId}/finance-summary`
                ),
                apiFetch<ReceivableBillRow[]>(`/orders/${orderId}/bills`)
              ]);
              setFinanceSummary(nextFinanceSummary);
              setReceivableBills(nextBills);
            } finally {
              setFinanceLoading(false);
            }
          })
        );
      }
      if (hasDepositSettlementViewPermission) {
        loads.push(loadDepositSettlementDomain(force));
      }

      const results = await Promise.allSettled(loads);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure) {
        throw failure.reason;
      }
    },
    [
      hasBillingViewPermission,
      hasDepositSettlementViewPermission,
      loadDepositSettlementDomain,
      loadWorkspaceResource,
      orderId
    ]
  );

  const loadServiceDomain = useCallback(
    async (force: boolean) => {
      if (!permissions.has("service_case:view")) {
        return;
      }
      setServiceCasesLoading(true);
      try {
        await loadWorkspaceResource("service-cases", force, async () => {
          const query = new URLSearchParams({
            orderId,
            pageSize: "20"
          });
          const result = await apiFetch<PortalPagedResponse<PortalServiceCase>>(
            `/service-cases?${query.toString()}`
          );
          let nextItems = result.items;
          if (
            focus &&
            !nextItems.some((serviceCase) => serviceCase.id === focus)
          ) {
            const focused = await apiFetch<PortalServiceCase>(
              `/orders/${encodeURIComponent(orderId)}/workspace/service-cases/${encodeURIComponent(focus)}`
            );
            nextItems = mergeOrderWorkspaceFocusedServiceCase({
              focus,
              focused,
              items: nextItems,
              orderId
            });
          }
          setServiceCases(nextItems);
        });
      } finally {
        setServiceCasesLoading(false);
      }
    },
    [focus, loadWorkspaceResource, orderId, permissions]
  );

  const loadActiveWorkspaceTab = useCallback(
    async (activeTab: OrderWorkspaceTabKey, force = false) => {
      if (!force && loadedDomainsRef.current.has(activeTab)) {
        return;
      }
      setDomainLoadStates((current) => ({
        ...current,
        [activeTab]: {
          ...current[activeTab],
          error: null,
          loading: true
        }
      }));

      try {
        await loadOrderDetail(force);
        switch (activeTab) {
          case "contract":
            if (hasOrderChangeView) {
              await loadChangesDomain(force);
            }
            break;
          case "handover":
            await loadHandoverDomain(force);
            break;
          case "entitlement":
            await loadEntitlementDomain(force);
            break;
          case "service":
            await loadServiceDomain(force);
            break;
          case "finance":
            await loadFinanceDomain(force);
            break;
          case "change":
            await loadChangesDomain(force);
            break;
          case "overview":
            break;
        }
        loadedDomainsRef.current.add(activeTab);
        setDomainLoadStates((current) => ({
          ...current,
          [activeTab]: {
            error: null,
            loaded: true,
            loading: false
          }
        }));
      } catch (error) {
        setDomainLoadStates((current) => ({
          ...current,
          [activeTab]: {
            ...current[activeTab],
            error: getErrorMessage(error),
            loading: false
          }
        }));
      }
    },
    [
      hasOrderChangeView,
      loadChangesDomain,
      loadEntitlementDomain,
      loadFinanceDomain,
      loadHandoverDomain,
      loadOrderDetail,
      loadServiceDomain
    ]
  );

  const loadWorkspaceSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const nextSummary = await apiFetch<OrderWorkspaceSummary>(
        `/orders/${orderId}/workspace/summary`
      );
      setSummary(nextSummary);
    } catch (error) {
      setSummaryError(getErrorMessage(error));
    } finally {
      setSummaryLoading(false);
    }
  }, [orderId]);

  const loadWorkspaceShell = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    const [authResult] = await Promise.allSettled([
      apiFetch<AuthMeResponse>("/auth/me"),
      loadWorkspaceSummary()
    ]);
    if (authResult.status === "fulfilled") {
      setMe(authResult.value);
    } else {
      setAuthError(getErrorMessage(authResult.reason));
    }
    setAuthLoading(false);
  }, [loadWorkspaceSummary]);

  const retryWorkspaceSummary = useCallback(() => {
    void loadWorkspaceSummary();
  }, [loadWorkspaceSummary]);

  const retryActiveWorkspaceTab = useCallback(() => {
    void loadActiveWorkspaceTab(activeTab, true);
  }, [activeTab, loadActiveWorkspaceTab]);

  const loadOrder = useCallback(async () => {
    await refreshActiveOrderWorkspaceTab({
      activeTabRef,
      refreshSummary: loadWorkspaceSummary,
      refreshTab: (tab) => loadActiveWorkspaceTab(tab, true)
    });
  }, [loadActiveWorkspaceTab, loadWorkspaceSummary]);

  useEffect(() => {
    loadedDomainsRef.current.clear();
    loadedResourcesRef.current.clear();
    resourcePromisesRef.current.clear();
    orderRef.current = null;
    setMe(null);
    setOrder(null);
    setSummary(null);
    setChangesLoaded(false);
    setDomainLoadStates(createWorkspaceDomainLoadStates());
    void loadWorkspaceShell();
  }, [loadWorkspaceShell]);

  useEffect(() => {
    if (authLoading || !me) {
      return;
    }
    if (!visibleTabs.includes(workspaceLocation.tab)) {
      navigateWorkspace({ tab: "overview" });
      return;
    }
    void loadActiveWorkspaceTab(activeTab);
  }, [
    activeTab,
    authLoading,
    loadActiveWorkspaceTab,
    me,
    navigateWorkspace,
    visibleTabs,
    workspaceLocation.tab
  ]);

  useEffect(() => {
    if (
      !shouldLoadOrderWorkspaceFocusedServiceCase({
        activeTab,
        domainLoaded: activeDomainState.loaded,
        focus,
        serviceCaseIds: serviceCases.map((serviceCase) => serviceCase.id)
      })
    ) {
      return;
    }
    void loadActiveWorkspaceTab("service", true);
  }, [
    activeDomainState.loaded,
    activeTab,
    focus,
    loadActiveWorkspaceTab,
    serviceCases
  ]);

  useEffect(() => {
    if (!focus || !focusAttemptKey) {
      return;
    }
    const record = document.querySelector<HTMLElement>(
      buildOrderWorkspaceRecordSelector(focus, CSS.escape)
    );
    if (!record) {
      return;
    }

    record.scrollIntoView({ behavior: "smooth", block: "center" });
    record.setAttribute("data-workspace-focus-highlight", "true");
    const previousBackground = record.style.backgroundColor;
    const previousBoxShadow = record.style.boxShadow;
    record.style.backgroundColor = "#e6f4ff";
    record.style.boxShadow = "inset 3px 0 #1677ff";
    const clearFocusHighlight = () => {
      record.removeAttribute("data-workspace-focus-highlight");
      record.style.backgroundColor = previousBackground;
      record.style.boxShadow = previousBoxShadow;
    };
    const timeout = window.setTimeout(clearFocusHighlight, 1800);

    return () => {
      window.clearTimeout(timeout);
      clearFocusHighlight();
    };
  }, [focus, focusAttemptKey]);

  async function viewHandoverWorkOrderDetail(id: string) {
    setHandoverActionLoading(`detail:${id}`);
    try {
      const detail = await apiFetch<HandoverWorkOrderDetail>(`/handover-work-orders/${encodeURIComponent(id)}`);
      setHandoverWorkOrderDetail(detail);
      setHandoverWorkOrderDetailOpen(true);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setHandoverActionLoading(null);
    }
  }

  async function createHandoverWorkOrder() {
    if (!order) {
      return;
    }
    setHandoverActionLoading("create");
    try {
      const created = await apiFetch<{ id: string }>(`/orders/${orderId}/handover-work-orders`, {
        body: JSON.stringify({ handoverType: "DELIVERY_OUTBOUND" }),
        method: "POST"
      });
      void message.success("交付工单已创建");
      await loadOrder();
      openAssignExternalHandover(created.id);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setHandoverActionLoading(null);
    }
  }

  async function runHandoverObjectionAction(
    id: string,
    action: "acknowledge" | "request-resubmission" | "send-customer-review",
    successMessage: string,
    body: Record<string, unknown> = {}
  ) {
    setHandoverActionLoading(`${action}:${id}`);
    try {
      await apiFetch<HandoverWorkOrderDetail>(`/handover-work-orders/${encodeURIComponent(id)}/objection/${action}`, {
        body: JSON.stringify(body),
        method: "POST"
      });
      void message.success(successMessage);
      await loadOrder();
      if (handoverWorkOrderDetail?.id === id) {
        const nextDetail = await apiFetch<HandoverWorkOrderDetail>(`/handover-work-orders/${encodeURIComponent(id)}`);
        setHandoverWorkOrderDetail(nextDetail);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setHandoverActionLoading(null);
    }
  }

  function acknowledgeCustomerObjection(id: string) {
    return runHandoverObjectionAction(id, "acknowledge", "已受理客户异议");
  }

  function requestCustomerObjectionResubmission(id: string) {
    setHandoverActionLoading(`request-resubmission:${id}`);
    void apiFetch<HandoverWorkOrderDetail>(`/handover-work-orders/${encodeURIComponent(id)}`)
      .then((detail) => {
        setHandoverResubmissionDetail(detail);
        handoverResubmissionForm.resetFields();
        setHandoverResubmissionOpen(true);
      })
      .catch((error) => void message.error(getErrorMessage(error)))
      .finally(() => setHandoverActionLoading(null));
  }

  function sendCustomerObjectionBackToReview(id: string) {
    return runHandoverObjectionAction(id, "send-customer-review", "已送回客户复核");
  }

  async function runStage2WorkflowRecovery(
    id: string,
    recovery: AdminStage2HandoverWorkflowRecovery
  ) {
    if (
      !permissions.has("delivery:confirm") ||
      stage2WorkflowRecoveryInFlightRef.current
    ) {
      return;
    }
    stage2WorkflowRecoveryInFlightRef.current = true;
    setStage2WorkflowRecoveryInFlight(true);
    setHandoverActionLoading(
      `workflow-recovery:${id}:${recovery.jobId}`
    );
    try {
      const executed = await runAdminStage2WorkflowRecovery({
        allowed: permissions.has("delivery:confirm"),
        execute: async (workOrderId, selectedRecovery) => {
          if (selectedRecovery.kind === "RECONCILE_CUSTOMER") {
            await reconcileAdminStage2CustomerSignature(workOrderId);
          } else {
            await retryAdminStage2WorkflowJob(
              workOrderId,
              selectedRecovery.jobId
            );
          }
        },
        recovery,
        workOrderId: id
      });
      if (!executed) {
        return;
      }
      setHandoverESignErrors((current) => ({ ...current, [id]: undefined }));
      void message.success("异常恢复任务已提交");
      await loadOrder();
      if (handoverWorkOrderDetail?.id === id) {
        const nextDetail = await apiFetch<HandoverWorkOrderDetail>(
          `/handover-work-orders/${encodeURIComponent(id)}`
        );
        setHandoverWorkOrderDetail(nextDetail);
      }
    } catch (error) {
      const safeError = getAdminStage2HandoverESignErrorMessage(error);
      setHandoverESignErrors((current) => ({ ...current, [id]: safeError }));
      void message.error(safeError);
    } finally {
      stage2WorkflowRecoveryInFlightRef.current = false;
      setStage2WorkflowRecoveryInFlight(false);
      setHandoverActionLoading(null);
    }
  }

  function confirmStage2WorkflowRecovery(
    id: string,
    recovery: AdminStage2HandoverWorkflowRecovery
  ) {
    if (!permissions.has("delivery:confirm")) {
      return;
    }
    scopedConfirm.confirm({
      cancelText: "取消",
      content: `仅重新提交“${recovery.label}”对应的异常任务。`,
      okText: "确认恢复",
      onOk: () => runStage2WorkflowRecovery(id, recovery),
      title: "确认执行异常恢复？"
    });
  }

  async function refreshAfterStage2Action(
    id: string,
    status: AdminStage2HandoverESignStatus
  ) {
    setHandoverESignStatuses((current) => ({ ...current, [id]: status }));
    setHandoverESignErrors((current) => ({ ...current, [id]: undefined }));
    await loadOrder();
    if (handoverWorkOrderDetail?.id === id) {
      const nextDetail = await apiFetch<HandoverWorkOrderDetail>(
        `/handover-work-orders/${encodeURIComponent(id)}`
      );
      setHandoverWorkOrderDetail(nextDetail);
    }
  }

  async function runAdminStage2Fallback(
    id: string,
    values: Stage2FallbackFormValues
  ) {
    if (
      !permissions.has("delivery:confirm") ||
      stage2WorkflowRecoveryInFlightRef.current
    ) {
      return;
    }
    const sourceArtifact = stage2FallbackSourceArtifact;
    if (!sourceArtifact || values.acknowledgement !== true) {
      void message.error("交接确认单状态已变化，请刷新后重试");
      return;
    }
    stage2WorkflowRecoveryInFlightRef.current = true;
    setStage2WorkflowRecoveryInFlight(true);
    setHandoverActionLoading(`stage2-start:${id}`);
    try {
      const status = await startAdminStage2HandoverESign(id, {
        acknowledgement: true,
        artifactVersion: sourceArtifact.artifactVersion,
        reason: values.reason,
        sourcePdfHash: sourceArtifact.sourcePdfHash
      });
      setStage2FallbackOpen(false);
      setStage2FallbackSourceArtifact(null);
      setStage2FallbackWorkOrderId(null);
      stage2FallbackForm.resetFields();
      await refreshAfterStage2Action(id, status);
      void message.success("后台已发起交接签署");
    } catch (error) {
      const safeError = getAdminStage2HandoverESignErrorMessage(error);
      setHandoverESignErrors((current) => ({ ...current, [id]: safeError }));
      void message.error(safeError);
    } finally {
      stage2WorkflowRecoveryInFlightRef.current = false;
      setStage2WorkflowRecoveryInFlight(false);
      setHandoverActionLoading(null);
    }
  }

  function confirmAdminStage2Fallback(id: string) {
    if (!permissions.has("delivery:confirm")) {
      return;
    }
    const status = handoverESignStatuses[id];
    if (
      !status?.canAdminInitiate ||
      !status.sourceArtifact
    ) {
      void message.warning("当前不满足后台兜底发起条件，请刷新状态");
      return;
    }
    stage2FallbackForm.setFieldsValue({
      acknowledgement: false,
      reason: ""
    });
    setStage2FallbackSourceArtifact({
      ...status.sourceArtifact
    });
    setStage2FallbackWorkOrderId(id);
    setStage2FallbackOpen(true);
  }

  function closeAdminStage2Fallback() {
    if (stage2WorkflowRecoveryInFlight) {
      return;
    }
    setStage2FallbackOpen(false);
    setStage2FallbackSourceArtifact(null);
    setStage2FallbackWorkOrderId(null);
    stage2FallbackForm.resetFields();
  }

  async function submitAdminStage2Fallback() {
    if (
      !stage2FallbackWorkOrderId ||
      !permissions.has("delivery:confirm") ||
      stage2WorkflowRecoveryInFlightRef.current
    ) {
      return;
    }
    const values = await stage2FallbackForm.validateFields();
    const validationError =
      validateAdminStage2HandoverFallbackReason(values.reason);
    if (validationError) {
      stage2FallbackForm.setFields([
        { errors: [validationError], name: "reason" }
      ]);
      return;
    }
    await runAdminStage2Fallback(
      stage2FallbackWorkOrderId,
      values
    );
  }

  function openAdminStage2Void(id: string) {
    if (!permissions.has("delivery:confirm")) {
      return;
    }
    stage2VoidForm.resetFields();
    setStage2VoidWorkOrderId(id);
    setStage2VoidOpen(true);
  }

  function closeAdminStage2Void() {
    if (stage2WorkflowRecoveryInFlight) {
      return;
    }
    setStage2VoidOpen(false);
    setStage2VoidWorkOrderId(null);
    stage2VoidForm.resetFields();
  }

  async function submitAdminStage2Void() {
    if (
      !stage2VoidWorkOrderId ||
      !permissions.has("delivery:confirm") ||
      stage2WorkflowRecoveryInFlightRef.current
    ) {
      return;
    }
    const values = await stage2VoidForm.validateFields();
    const validationError = validateAdminStage2HandoverVoidReason(
      values.reason
    );
    if (validationError) {
      stage2VoidForm.setFields([
        { errors: [validationError], name: "reason" }
      ]);
      return;
    }

    const id = stage2VoidWorkOrderId;
    stage2WorkflowRecoveryInFlightRef.current = true;
    setStage2WorkflowRecoveryInFlight(true);
    setHandoverActionLoading(`stage2-void:${id}`);
    try {
      const status = await voidAdminStage2HandoverESign(
        id,
        values.reason
      );
      setStage2VoidOpen(false);
      setStage2VoidWorkOrderId(null);
      stage2VoidForm.resetFields();
      await refreshAfterStage2Action(id, status);
      void message.success("签署任务已作废，可重新发起");
    } catch (error) {
      const safeError = getAdminStage2HandoverESignErrorMessage(error);
      setHandoverESignErrors((current) => ({ ...current, [id]: safeError }));
      void message.error(safeError);
    } finally {
      stage2WorkflowRecoveryInFlightRef.current = false;
      setStage2WorkflowRecoveryInFlight(false);
      setHandoverActionLoading(null);
    }
  }

  function openAssignExternalHandover(id: string) {
    setAssignExternalHandoverId(id);
    assignExternalHandoverForm.resetFields();
    assignExternalHandoverForm.setFieldValue("expiresAt", dayjs().add(7, "day"));
    setAssignExternalHandoverOpen(true);
  }

  async function assignExternalHandover(values: AssignExternalHandoverFormValues) {
    if (!assignExternalHandoverId) {
      return;
    }
    setHandoverActionLoading(`assign:${assignExternalHandoverId}`);
    try {
      await apiFetch(`/handover-work-orders/${encodeURIComponent(assignExternalHandoverId)}/assign-external`, {
        body: JSON.stringify({
          expiresAt: values.expiresAt?.toISOString(),
          name: values.name.trim(),
          organization: values.organization?.trim() || undefined,
          phone: values.phone.trim()
        }),
        method: "POST"
      });
      void message.success("Field 交付人员已指派");
      setAssignExternalHandoverOpen(false);
      setAssignExternalHandoverId(null);
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setHandoverActionLoading(null);
    }
  }

  async function submitHandoverResubmission(values: HandoverResubmissionFormValues) {
    const id = handoverResubmissionDetail?.id;
    if (!id) {
      return;
    }
    await runHandoverObjectionAction(
      id,
      "request-resubmission",
      "已要求现场重新提交资料",
      {
        note: values.note.trim(),
        targetEvidenceItemIds: values.targetEvidenceItemIds ?? [],
        targetFieldKeys: values.targetFieldKeys ?? []
      }
    );
    setHandoverResubmissionOpen(false);
    setHandoverResubmissionDetail(null);
  }

  const openChangeModal = useCallback(async () => {
    if (!order || !canCreateChange) {
      return;
    }
    if (orderChangeLocked) {
      void message.error("该订单已有进行中的变更申请，请先处理后再发起新的变更。");
      return;
    }
    changeForm.resetFields();
    setChangeModalOpen(true);
  }, [canCreateChange, changeForm, message, order, orderChangeLocked]);

  useEffect(() => {
    autoOpenChangeRequestedRef.current = createChangeRequested;
    setAutoOpenChangeModalDone(false);
  }, [createChangeRequested]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (
      autoOpenChangeRequestedRef.current &&
      !visibleTabs.includes("change")
    ) {
      autoOpenChangeRequestedRef.current = false;
      return;
    }
    if (
      autoOpenChangeRequestedRef.current &&
      activeTab !== "change" &&
      !autoOpenChangeModalDone
    ) {
      navigateWorkspace({ createChange: true, tab: "change" });
      return;
    }
    if (
      autoOpenChangeRequestedRef.current &&
      activeTab === "change" &&
      order &&
      changesLoaded &&
      canCreateChange &&
      !changeModalOpen &&
      !autoOpenChangeModalDone
    ) {
      autoOpenChangeRequestedRef.current = false;
      setAutoOpenChangeModalDone(true);
      void openChangeModal();
    }
  }, [
    activeTab,
    authLoading,
    autoOpenChangeModalDone,
    canCreateChange,
    changeModalOpen,
    changesLoaded,
    createChangeRequested,
    navigateWorkspace,
    openChangeModal,
    order,
    visibleTabs
  ]);

  function closeChangeModal() {
    setChangeModalOpen(false);
    changeForm.resetFields();
  }

  function openPrepareDeliveryModal() {
    prepareDeliveryForm.setFieldsValue({
      customerIdentityConfirmed: delivery?.customerIdentityConfirmed ?? false,
      deliveryLocation: delivery?.deliveryLocation ?? undefined,
      depositReceivedConfirmed: deliveryCheck?.depositRequired === false ? true : delivery?.depositReceivedConfirmed ?? false,
      firstMonthlyFeeReceivedConfirmed: delivery?.firstMonthlyFeeReceivedConfirmed ?? false,
      handoverDocumentsConfirmed: delivery?.handoverDocumentsConfirmed ?? false,
      insuranceValidConfirmed: delivery?.insuranceValidConfirmed ?? false,
      remark: delivery?.remark ?? undefined,
      scheduledAt: delivery?.scheduledAt ? dayjs(delivery.scheduledAt) : undefined,
      vehiclePhotosConfirmed: delivery?.vehiclePhotosConfirmed ?? false,
      vehiclePreparedConfirmed: delivery?.vehiclePreparedConfirmed ?? false
    });
    setPrepareDeliveryModalOpen(true);
  }

  function closePrepareDeliveryModal() {
    setPrepareDeliveryModalOpen(false);
    prepareDeliveryForm.resetFields();
  }

  async function openConfirmDeliveryModal() {
    if (!order) {
      return;
    }
    await stage2DeliveryConfirmationController.run({
      boundary: "MODAL_OPEN",
      onAllowed: () => {
        confirmDeliveryForm.setFieldsValue({
          deliveredAt: dayjs(),
          handoverMileageKm:
            order.vehicle?.currentMileageKm ?? undefined,
          remark: delivery?.remark ?? undefined
        });
        setConfirmDeliveryModalOpen(true);
      },
      orderId: order.id
    });
  }

  function closeConfirmDeliveryModal() {
    setConfirmDeliveryModalOpen(false);
    confirmDeliveryForm.resetFields();
  }

  function openPrepareReturnModal() {
    prepareReturnForm.setFieldsValue({
      remark: vehicleReturn?.remark ?? undefined,
      returnLocation: vehicleReturn?.returnLocation ?? undefined,
      returnType: vehicleReturn?.returnType ?? "NORMAL_RETURN",
      scheduledAt: vehicleReturn?.scheduledAt ? dayjs(vehicleReturn.scheduledAt) : undefined
    });
    setPrepareReturnModalOpen(true);
  }

  function closePrepareReturnModal() {
    setPrepareReturnModalOpen(false);
    prepareReturnForm.resetFields();
  }

  function openConfirmReturnModal() {
    confirmReturnForm.setFieldsValue({
      batteryCheckedConfirmed: vehicleReturn?.batteryCheckedConfirmed ?? false,
      chargingEquipmentReturnedConfirmed: vehicleReturn?.chargingEquipmentReturnedConfirmed ?? false,
      cleaningRequired: vehicleReturn?.cleaningRequired ?? false,
      customerItemsClearedConfirmed: vehicleReturn?.customerItemsClearedConfirmed ?? false,
      damageFound: vehicleReturn?.damageFound ?? false,
      damages: (vehicleReturn?.damages ?? []).map((damage) => ({
        damageLevel: damage.damageLevel,
        damageType: damage.damageType,
        description: damage.description ?? undefined,
        estimatedRepairAmount: centsToYuan(damage.estimatedRepairAmount),
        photoUrlsText: photoUrlsToText(damage.photoUrls),
        responsibleParty: damage.responsibleParty ?? "UNKNOWN"
      })),
      exteriorCheckedConfirmed: vehicleReturn?.exteriorCheckedConfirmed ?? false,
      interiorCheckedConfirmed: vehicleReturn?.interiorCheckedConfirmed ?? false,
      keysReturnedConfirmed: vehicleReturn?.keysReturnedConfirmed ?? false,
      maintenanceRequired: vehicleReturn?.maintenanceRequired ?? false,
      mileageConfirmed: vehicleReturn?.mileageConfirmed ?? false,
      remark: vehicleReturn?.remark ?? undefined,
      returnMileageKm: order?.vehicle?.currentMileageKm ?? undefined,
      returnType: vehicleReturn?.returnType ?? "NORMAL_RETURN",
      returnedAt: dayjs(),
      vehicleDocumentsReturnedConfirmed: vehicleReturn?.vehicleDocumentsReturnedConfirmed ?? false,
      violationCheckedConfirmed: vehicleReturn?.violationCheckedConfirmed ?? false
    });
    setConfirmReturnModalOpen(true);
  }

  function closeConfirmReturnModal() {
    setConfirmReturnModalOpen(false);
    confirmReturnForm.resetFields();
  }

  function openPaymentModal() {
    if (!order) {
      return;
    }
    paymentForm.setFieldsValue({
      paymentMethod: "BANK_TRANSFER",
      receivedAt: dayjs(),
      writeOffEnabled: hasPaymentWriteOffPermission && unsettledBills.length > 0,
      writeOffItems: unsettledBills.map((bill) => ({ billId: bill.id }))
    });
    setPaymentModalOpen(true);
  }

  function closePaymentModal() {
    setPaymentModalOpen(false);
    paymentForm.resetFields();
  }

  function openDeductDepositModal() {
    if (!damageFeeBillForDeduction) {
      void message.error("没有可扣减的损伤费用账单");
      return;
    }
    deductDepositForm.setFieldsValue({
      amountYuan: centsToYuan(suggestedDeductibleAmount),
      billId: damageFeeBillForDeduction.id,
      remark: "退车损伤费用抵扣"
    });
    setDeductDepositModalOpen(true);
  }

  function closeDeductDepositModal() {
    setDeductDepositModalOpen(false);
    deductDepositForm.resetFields();
  }

  function openRefundDepositModal() {
    refundDepositForm.setFieldsValue({
      amountYuan: centsToYuan(suggestedRefundableAmount),
      remark: "退车结算后人工确认退款"
    });
    setRefundDepositModalOpen(true);
  }

  function closeRefundDepositModal() {
    setRefundDepositModalOpen(false);
    refundDepositForm.resetFields();
  }

  async function refreshEntitlementData(page = entitlementUsagePage, pageSize = entitlementUsagePageSize) {
    if (!order || !hasEntitlementViewPermission) {
      return;
    }
    setEntitlementLoading(true);
    try {
      const nextEntitlements = await apiFetch<OrderEntitlementsResponse>(`/orders/${order.id}/entitlements`);
      setEntitlements(nextEntitlements);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setEntitlementLoading(false);
    }
    await loadEntitlementUsages(order.id, page, pageSize);
  }

  async function generateOrderEntitlements() {
    if (!order) {
      return;
    }
    const hadAccount = Boolean(entitlements.account);
    setGeneratingEntitlements(true);
    try {
      const nextEntitlements = await apiFetch<OrderEntitlementsResponse>(`/orders/${order.id}/entitlements/generate`, {
        method: "POST"
      });
      setEntitlements(nextEntitlements);
      void message.success(hadAccount ? "该订单已生成权益账户，已刷新权益信息。" : "订单权益已生成");
      await loadEntitlementUsages(order.id, entitlementUsagePage, entitlementUsagePageSize);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setGeneratingEntitlements(false);
    }
  }

  function openRenewEntitlementModal() {
    const disabledReason = getRenewMonthlyEntitlementDisabledReason(order, entitlements.account);
    if (disabledReason) {
      void message.error(disabledReason);
      return;
    }
    renewEntitlementForm.setFieldsValue({
      asOfDate: todayBusinessDate(),
      dryRun: true
    });
    setRenewEntitlementResult(null);
    setRenewEntitlementModalOpen(true);
  }

  function closeRenewEntitlementModal() {
    setRenewEntitlementModalOpen(false);
    setRenewEntitlementResult(null);
    renewEntitlementForm.resetFields();
  }

  async function executeRenewEntitlements(dryRun: boolean) {
    if (!order) {
      return;
    }
    let values: EntitlementOperationFormValues;
    try {
      values = await renewEntitlementForm.validateFields();
    } catch {
      return;
    }
    const asOfDate = (values.asOfDate ?? todayBusinessDate()).format("YYYY-MM-DD");
    renewEntitlementForm.setFieldsValue({ dryRun });
    setRenewingEntitlements(true);
    try {
      const result = await apiFetch<EntitlementRenewalResponse>(`/orders/${order.id}/entitlements/renew-monthly`, {
        body: JSON.stringify({ asOfDate, dryRun }),
        method: "POST"
      });
      setRenewEntitlementResult(result);
      const text = getRenewalResultText(result);
      if (dryRun) {
        void message.info(text);
        return;
      }
      if (result.action === "GENERATED") {
        void message.success("下一期权益已生成。");
      } else {
        void message.info(text);
      }
      await refreshEntitlementData(entitlementUsagePage, entitlementUsagePageSize);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setRenewingEntitlements(false);
    }
  }

  function submitRenewEntitlements(dryRun: boolean) {
    if (dryRun) {
      void executeRenewEntitlements(true);
      return;
    }
    scopedConfirm.confirm({
      content: "本操作将为该订单创建 MONTHLY_RENEWAL 权益发放记录。",
      okText: "确认生成",
      onOk: () => executeRenewEntitlements(false),
      title: "确认正式生成下一期权益？"
    });
  }

  function openExpireEntitlementModal() {
    if (!permissions.has("entitlement:adjust")) {
      void message.error("无权益过期处理权限");
      return;
    }
    expireEntitlementForm.setFieldsValue({
      asOfDate: todayBusinessDate(),
      dryRun: true
    });
    setExpireEntitlementResult(null);
    setExpireEntitlementModalOpen(true);
  }

  function closeExpireEntitlementModal() {
    setExpireEntitlementModalOpen(false);
    setExpireEntitlementResult(null);
    expireEntitlementForm.resetFields();
  }

  async function executeExpireEntitlements(dryRun: boolean) {
    let values: EntitlementOperationFormValues;
    try {
      values = await expireEntitlementForm.validateFields();
    } catch {
      return;
    }
    const asOfDate = (values.asOfDate ?? todayBusinessDate()).format("YYYY-MM-DD");
    expireEntitlementForm.setFieldsValue({ dryRun });
    setExpiringEntitlements(true);
    try {
      const result = await apiFetch<ExpireEntitlementsResponse>("/entitlements/expire", {
        body: JSON.stringify({ asOfDate, dryRun }),
        method: "POST"
      });
      setExpireEntitlementResult(result);
      if (dryRun) {
        void message.info(getExpireResultText(result));
        return;
      }
      void message.success("过期权益处理完成。");
      await refreshEntitlementData(entitlementUsagePage, entitlementUsagePageSize);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setExpiringEntitlements(false);
    }
  }

  function submitExpireEntitlements(dryRun: boolean) {
    if (dryRun) {
      void executeExpireEntitlements(true);
      return;
    }
    scopedConfirm.confirm({
      content: "本操作将把所有已超过有效期的可用权益标记为已过期。",
      okText: "确认处理",
      onOk: () => executeExpireEntitlements(false),
      title: "确认正式处理过期权益？"
    });
  }

  function openConsumeEntitlementModal(grant: OrderEntitlementGrant) {
    if (!order) {
      return;
    }
    const disabledReason = getConsumeEntitlementDisabledReason(order, entitlements.account, grant);
    if (disabledReason) {
      void message.error(disabledReason);
      return;
    }
    consumeEntitlementForm.setFieldsValue({
      occurredAt: dayjs(),
      usageSource: "MANUAL"
    });
    setConsumingGrant(grant);
    setConsumeEntitlementModalOpen(true);
  }

  function closeConsumeEntitlementModal() {
    setConsumeEntitlementModalOpen(false);
    setConsumingGrant(null);
    consumeEntitlementForm.resetFields();
  }

  async function submitConsumeEntitlement() {
    if (!order || !consumingGrant) {
      return;
    }
    const values = await consumeEntitlementForm.validateFields();
    const usedAmount = toNumber(values.usedAmount);
    const remainingAmount = toNumber(consumingGrant.remainingAmount) ?? 0;
    if (usedAmount === null || usedAmount <= 0) {
      void message.error("本次消耗数量必须大于 0");
      return;
    }
    if (usedAmount > remainingAmount) {
      void message.error("本次消耗数量不能超过当前剩余");
      return;
    }
    const occurredAtError = getConsumeOccurredAtError(consumingGrant, values.occurredAt);
    if (occurredAtError) {
      void message.error(occurredAtError);
      return;
    }
    setConsumeEntitlementSubmitting(true);
    try {
      await apiFetch(`/orders/${order.id}/entitlements/${consumingGrant.id}/consume`, {
        body: JSON.stringify({
          externalRefNo: values.externalRefNo,
          occurredAt: values.occurredAt?.toISOString(),
          remark: values.remark,
          scenario: values.scenario,
          usageSource: values.usageSource ?? "MANUAL",
          usedAmount
        }),
        method: "POST"
      });
      void message.success("权益消耗已记录");
      closeConsumeEntitlementModal();
      await refreshEntitlementData(entitlementUsagePage, entitlementUsagePageSize);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setConsumeEntitlementSubmitting(false);
    }
  }

  function handleEntitlementUsagePageChange(page: number, pageSize: number) {
    if (!order) {
      return;
    }
    void loadEntitlementUsages(order.id, page, pageSize);
  }

  async function generateInitialBills() {
    if (!order) {
      return;
    }
    setGeneratingBills(true);
    try {
      await apiFetch(`/orders/${order.id}/generate-initial-bills`, { method: "POST" });
      void message.success("初始账单已生成");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setGeneratingBills(false);
    }
  }

  async function generateNextMonthlyRentBill() {
    if (!order) {
      return;
    }
    setGeneratingMonthlyRentBill(true);
    try {
      const bill = await apiFetch<MonthlyRentBillResponse>(`/orders/${order.id}/generate-next-monthly-bill`, {
        method: "POST"
      });
      void message.success(
        bill.created === false ? "该账期月租账单已存在，已刷新账单列表" : "下一期月租账单已生成"
      );
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setGeneratingMonthlyRentBill(false);
    }
  }

  async function generateDamageFeeBill() {
    if (!order) {
      return;
    }
    setGeneratingDamageFeeBill(true);
    try {
      const bill = await apiFetch<DamageFeeBillResponse>(`/orders/${order.id}/generate-damage-fee-bill`, {
        method: "POST"
      });
      void message.success(
        bill.created === false ? "损伤费用账单已存在，已刷新结算信息。" : "损伤费用账单已生成"
      );
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setGeneratingDamageFeeBill(false);
    }
  }

  async function submitDeductDeposit() {
    if (!order) {
      return;
    }
    const values = await deductDepositForm.validateFields();
    const amount = yuanToCents(values.amountYuan);
    const bill = values.billId ? damageFeeBills.find((item) => item.id === values.billId) : null;
    const billRemainingAmount = toNumber(bill?.remainingAmount) ?? damageFeeRemainingAmount;

    if (!bill) {
      void message.error("必须存在 DAMAGE_FEE 账单");
      return;
    }
    if (!amount || amount <= 0) {
      void message.error("扣减金额必须大于 0");
      return;
    }
    if (amount > availableDepositBalance) {
      void message.error("扣减金额不能超过可用保证金余额");
      return;
    }
    if (amount > billRemainingAmount) {
      void message.error("扣减金额不能超过损伤费用剩余未收金额");
      return;
    }

    setDeductingDeposit(true);
    try {
      await apiFetch(`/orders/${order.id}/deduct-deposit`, {
        body: JSON.stringify({
          amount,
          billId: bill.id,
          remark: values.remark
        }),
        method: "POST"
      });
      void message.success("保证金扣减成功");
      closeDeductDepositModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setDeductingDeposit(false);
    }
  }

  async function submitRefundDeposit() {
    if (!order) {
      return;
    }
    const values = await refundDepositForm.validateFields();
    const amount = yuanToCents(values.amountYuan);

    if (!amount || amount <= 0) {
      void message.error("退款金额必须大于 0");
      return;
    }
    if (amount > availableDepositBalance) {
      void message.error("退款金额不能超过可用保证金余额");
      return;
    }
    if (damageFeeRemainingAmount > 0 && suggestedDeductibleAmount > 0) {
      void message.error("请先处理损伤费用");
      return;
    }

    setRefundingDeposit(true);
    try {
      await apiFetch(`/orders/${order.id}/refund-deposit`, {
        body: JSON.stringify({
          amount,
          remark: values.remark
        }),
        method: "POST"
      });
      void message.success("保证金退款已记录");
      closeRefundDepositModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setRefundingDeposit(false);
    }
  }

  async function submitPayment() {
    if (!order) {
      return;
    }
    const values = await paymentForm.validateFields();
    const paymentAmount = yuanToCents(values.paymentAmountYuan);

    if (!paymentAmount || paymentAmount <= 0) {
      void message.error("收款金额必须大于 0");
      return;
    }

    const writeOffItemsPayload: Array<{ billId: string; writeOffAmount: number }> = [];
    if (values.writeOffEnabled) {
      if (!hasPaymentWriteOffPermission) {
        void message.error("无核销权限");
        return;
      }
      if (unsettledBills.length === 0) {
        void message.error("没有可核销的未结清账单");
        return;
      }

      const billById = new Map(unsettledBills.map((bill) => [bill.id, bill]));
      for (const item of values.writeOffItems ?? []) {
        const writeOffAmount = yuanToCents(item.writeOffAmountYuan);
        if (!writeOffAmount || writeOffAmount <= 0) {
          continue;
        }
        const bill = item.billId ? billById.get(item.billId) : null;
        if (!bill) {
          continue;
        }
        const remainingAmount = toNumber(bill.remainingAmount) ?? 0;
        if (writeOffAmount > remainingAmount) {
          void message.error("核销金额不能超过账单剩余金额");
          return;
        }
        writeOffItemsPayload.push({ billId: bill.id, writeOffAmount });
      }

      if (writeOffItemsPayload.length === 0) {
        void message.error("至少选择一张账单才能提交核销");
        return;
      }

      const writeOffTotalAmount = writeOffItemsPayload.reduce((sum, item) => sum + item.writeOffAmount, 0);
      if (writeOffTotalAmount > paymentAmount) {
        void message.error("核销金额不能超过收款金额");
        return;
      }
    }

    setPaymentSubmitting(true);
    try {
      const payment = await apiFetch<PaymentRecordResponse>("/payments", {
        body: JSON.stringify({
          customerId: order.customerId,
          orderId: order.id,
          paymentAmount,
          paymentMethod: values.paymentMethod,
          paymentProofUrls: parsePhotoUrls(values.paymentProofUrlsText),
          payerAccount: values.payerAccount,
          payerName: values.payerName,
          receivedAt: values.receivedAt?.toISOString(),
          remark: values.remark
        }),
        method: "POST"
      });

      if (writeOffItemsPayload.length > 0) {
        await apiFetch(`/payments/${payment.id}/write-off`, {
          body: JSON.stringify({
            items: writeOffItemsPayload,
            remark: values.remark
          }),
          method: "POST"
        });
      }

      void message.success(writeOffItemsPayload.length > 0 ? "收款已登记并完成核销" : "收款已登记");
      closePaymentModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setPaymentSubmitting(false);
    }
  }

  async function generateContract() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/generate-contract`, { method: "POST" });
      void message.success("合同已生成");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function cancelOrder() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/cancel`, {
        body: JSON.stringify({ reason: "运营取消订单" }),
        method: "POST"
      });
      void message.success("订单已取消");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function prepareDelivery() {
    if (!order) {
      return;
    }
    const values = await prepareDeliveryForm.validateFields();
    try {
      await apiFetch(`/orders/${order.id}/prepare-delivery`, {
        body: JSON.stringify({
          customerIdentityConfirmed: Boolean(values.customerIdentityConfirmed),
          deliveryLocation: values.deliveryLocation,
          depositReceivedConfirmed: deliveryCheck?.depositRequired === false ? true : Boolean(values.depositReceivedConfirmed),
          firstMonthlyFeeReceivedConfirmed: Boolean(values.firstMonthlyFeeReceivedConfirmed),
          handoverDocumentsConfirmed: Boolean(values.handoverDocumentsConfirmed),
          insuranceValidConfirmed: Boolean(values.insuranceValidConfirmed),
          remark: values.remark,
          scheduledAt: values.scheduledAt?.toISOString(),
          vehiclePhotosConfirmed: Boolean(values.vehiclePhotosConfirmed),
          vehiclePreparedConfirmed: Boolean(values.vehiclePreparedConfirmed)
        }),
        method: "POST"
      });
      void message.success("交付准备信息已保存");
      closePrepareDeliveryModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function confirmDelivery() {
    if (!order) {
      return;
    }
    const values = await confirmDeliveryForm.validateFields();
    try {
      const submitted =
        await stage2DeliveryConfirmationController.run({
          boundary: "BEFORE_POST",
          onAllowed: () =>
            apiFetch(`/orders/${order.id}/confirm-delivery`, {
              body: JSON.stringify({
                deliveredAt: values.deliveredAt?.toISOString(),
                handoverMileageKm: values.handoverMileageKm,
                remark: values.remark
              }),
              method: "POST"
            }),
          orderId: order.id
        });
      if (!submitted) {
        return;
      }
      void message.success("车辆已确认交付");
      closeConfirmDeliveryModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function prepareReturn() {
    if (!order) {
      return;
    }
    const values = await prepareReturnForm.validateFields();
    try {
      await apiFetch(`/orders/${order.id}/prepare-return`, {
        body: JSON.stringify({
          remark: values.remark,
          returnLocation: values.returnLocation,
          returnType: values.returnType ?? "NORMAL_RETURN",
          scheduledAt: values.scheduledAt?.toISOString()
        }),
        method: "POST"
      });
      void message.success("退车准备信息已保存");
      closePrepareReturnModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function confirmReturn() {
    if (!order) {
      return;
    }
    const values = await confirmReturnForm.validateFields();
    const damageRows = canRecordReturnDamage ? values.damages ?? [] : [];
    const damages = damageRows
      .filter(
        (damage) =>
          Boolean(damage.damageType) ||
          Boolean(damage.damageLevel) ||
          Boolean(damage.description) ||
          damage.estimatedRepairAmount !== undefined
      )
      .map((damage) => ({
        damageLevel: damage.damageLevel,
        damageType: damage.damageType,
        description: damage.description,
        estimatedRepairAmount: yuanToCents(damage.estimatedRepairAmount),
        photoUrls: parsePhotoUrls(damage.photoUrlsText),
        responsibleParty: damage.responsibleParty ?? "UNKNOWN"
      }));

    try {
      await apiFetch(`/orders/${order.id}/confirm-return`, {
        body: JSON.stringify({
          batteryCheckedConfirmed: Boolean(values.batteryCheckedConfirmed),
          chargingEquipmentReturnedConfirmed: Boolean(values.chargingEquipmentReturnedConfirmed),
          cleaningRequired: Boolean(values.cleaningRequired),
          customerItemsClearedConfirmed: Boolean(values.customerItemsClearedConfirmed),
          damageFound: Boolean(values.damageFound) || damages.length > 0,
          damages,
          exteriorCheckedConfirmed: Boolean(values.exteriorCheckedConfirmed),
          interiorCheckedConfirmed: Boolean(values.interiorCheckedConfirmed),
          keysReturnedConfirmed: Boolean(values.keysReturnedConfirmed),
          maintenanceRequired: Boolean(values.maintenanceRequired),
          mileageConfirmed: Boolean(values.mileageConfirmed),
          remark: values.remark,
          returnMileageKm: values.returnMileageKm,
          returnType: values.returnType ?? vehicleReturn?.returnType ?? "NORMAL_RETURN",
          returnedAt: values.returnedAt?.toISOString(),
          vehicleDocumentsReturnedConfirmed: Boolean(values.vehicleDocumentsReturnedConfirmed),
          violationCheckedConfirmed: Boolean(values.violationCheckedConfirmed)
        }),
        method: "POST"
      });
      void message.success("退车验收已确认");
      closeConfirmReturnModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function reviewOrder(
    type: "credit" | "product" | "vehicle",
    status: "APPROVED" | "NEED_MORE_INFO" | "REJECTED"
  ) {
    if (!order) {
      return;
    }
    const body: Record<string, unknown> = { status };
    if (type === "credit" && status === "APPROVED") {
      const values = await creditForm.validateFields();
      body.customerGrade = values.customerGrade;
    }
    try {
      await apiFetch(`/orders/${order.id}/reviews/${type}`, {
        body: JSON.stringify(body),
        method: "POST"
      });
      void message.success("审核状态已更新");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function finalizePlan() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/finalize-plan`, { method: "POST" });
      void message.success("最终方案已确认");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function confirmCustomerOrder() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/customer-confirm`, { method: "POST" });
      void message.success("订单已进入合同签约");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function rejectCustomerOrder() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/reject`, {
        body: JSON.stringify({ remark: "后台审核拒绝", status: "REJECTED" }),
        method: "POST"
      });
      void message.success("订单已拒绝");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function createChange() {
    if (!order) {
      return;
    }
    const values = await changeForm.validateFields();
    try {
      await apiFetch(`/orders/${order.id}/changes`, {
        body: JSON.stringify({
          changeType: "PLAN_CHANGE",
          reason: values.reason
        }),
        method: "POST"
      });
      void message.success("退回重做方案申请已创建");
      closeChangeModal();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function reviewChange(changeId: string, action: "approve" | "reject") {
    try {
      await apiFetch(`/order-changes/${changeId}/${action}`, { method: "POST" });
      void message.success(action === "approve" ? "订单变更已通过" : "订单变更已拒绝");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function cancelChange(changeId: string) {
    try {
      await apiFetch(`/order-changes/${changeId}/cancel`, { method: "POST" });
      void message.success("订单变更申请已取消");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function returnChangeToPlan(changeId: string) {
    try {
      await apiFetch(`/order-changes/${changeId}/return-to-plan`, { method: "POST" });
      void message.success("当前订单已取消，已退回方案生成环节");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const changeColumns: ColumnsType<OrderChangeRow> = [
    { dataIndex: "changeType", render: (value: string) => labelOf(ORDER_CHANGE_TYPE_LABELS, value), title: "变更类型" },
    { dataIndex: "reason", title: "变更原因" },
    { dataIndex: "status", render: (value: string) => <Tag>{labelOf(STATUS_LABELS, value)}</Tag>, title: "状态" },
    { dataIndex: "creator", render: (value?: OrderChangeRow["creator"]) => value?.name ?? "-", title: "创建人" },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间" },
    {
      dataIndex: "executedAt",
      render: (value?: string | null) => value ? <Tag color="green">已退回 / {formatTime(value)}</Tag> : <Tag>未退回</Tag>,
      title: "退回状态"
    },
    {
      render: (_, record) => {
        const cancelChangeAvailability = actionAvailability({
          allowed: Boolean(record.status === "PENDING" && !record.executedAt && (roles.has("ADMIN") || record.createdBy === me?.user.id)),
          disabledReason: record.executedAt ? "该变更已执行" : "当前变更状态不允许取消",
          permissions
        });
        const approveChangeAvailability = actionAvailability({
          allowed: record.status === "PENDING",
          disabledReason: "当前变更状态不允许审批",
          noPermissionReason: "无审批订单变更权限",
          permission: "order_change:approve",
          permissions
        });
        const rejectChangeAvailability = canRejectChange
          ? actionAvailability({
              allowed: record.status === "PENDING",
              disabledReason: "当前变更状态不允许拒绝",
              permissions
            })
          : { allowed: false, reason: "无拒绝订单变更权限" };

        return (
          <Space>
            <ActionButton
              availability={cancelChangeAvailability}
              onClick={() => cancelChange(record.id)}
              size="small"
            >
              取消变更申请
            </ActionButton>
            <ActionButton
              availability={approveChangeAvailability}
              onClick={() => reviewChange(record.id, "approve")}
              size="small"
              type="primary"
            >
              同意变更
            </ActionButton>
            <ActionButton
              availability={rejectChangeAvailability}
              danger
              onClick={() => reviewChange(record.id, "reject")}
              size="small"
            >
              拒绝
            </ActionButton>
            <ActionButton
              availability={canExecuteOrderChange(record, order, permissions)}
              onClick={() => returnChangeToPlan(record.id)}
              size="small"
              type="primary"
            >
              取消当前订单并退回方案生成环节
            </ActionButton>
          </Space>
        );
      },
      title: "操作"
    }
  ];
  const visibleGuideSummary = summary
    ? {
        ...summary,
        guidance: summary.guidance.filter((item) =>
          visibleTabs.includes(item.targetTab)
        ),
        primaryAction:
          summary.primaryAction &&
          visibleTabs.includes(summary.primaryAction.targetTab)
            ? summary.primaryAction
            : null
      }
    : null;
  const workspaceHeader: OrderWorkspaceHeaderData = summary
    ? {
        ...summary.header,
        orderStatusLabel: labelOf(
          ORDER_STATUS_LABELS,
          summary.header.orderStatus
        )
      }
    : {
        currentVehicleLabel: null,
        customerLabel: authLoading ? "加载中" : "-",
        orderNo: order?.orderNo ?? "订单工作台",
        orderStatus: order?.orderStatus ?? "LOADING",
        orderStatusLabel: order
          ? labelOf(ORDER_STATUS_LABELS, order.orderStatus)
          : "加载中",
        ownerLabel: null
      };
  const workspaceOverflowActions: OrderWorkspaceHeaderAction[] = [];
  if (order) {
    workspaceOverflowActions.push({
      disabled: !applyChangeAvailability.allowed,
      key: "apply-change",
      label: "申请变更方案",
      onClick: () => {
        if (hasOrderChangeView) {
          navigateWorkspace({ tab: "change" });
          return;
        }
        void openChangeModal();
      }
    });
    workspaceOverflowActions.push({
      danger: true,
      disabled: !cancelOrderAvailability.allowed,
      key: "cancel-order",
      label: "取消订单",
      onClick: cancelOrder
    });
    if (
      order.orderStatus === "CANCELLED" &&
      order.application &&
      !isCustomerSelfServiceOrder
    ) {
      workspaceOverflowActions.push({
        key: "return-application",
        label: "返回进件重新生成方案",
        onClick: () =>
          router.push(`/applications/${order.application?.id}`)
      });
    }
  }

  function renderActiveWorkspaceTab() {
    let content: ReactNode;

    switch (activeTab) {
      case "overview":
        content = order ? (
          <>
            <OverviewLifecycleSummary order={order} />
            <ReviewPanel
              canConfirmFinalPlan={canConfirmFinalPlan}
              canRejectOrder={canRejectCustomerOrder}
              canReviewCredit={canReviewCredit}
              canReviewProduct={canReviewProduct}
              canReviewVehicle={canReviewVehicle}
              creditForm={creditForm}
              onConfirmCustomer={confirmCustomerOrder}
              onFinalizePlan={finalizePlan}
              onRejectOrder={rejectCustomerOrder}
              onReview={reviewOrder}
              order={order}
            />
            <OrderInfoSections
              customerLabel={customerPresentation.label}
              customerMobile={customerPresentation.mobile}
              currentVehicleSalePrice={currentVehicleSalePrice}
              order={order}
            />
            <RecentOrderActivity
              items={summary?.recentActivity ?? []}
              onNavigate={navigateWorkspace}
            />
          </>
        ) : null;
        break;
      case "contract":
        content = order ? (
          <>
            <div
              {...(order.contract
                ? { "data-workspace-record": order.contract.id }
                : {})}
            >
              <Card
                extra={
                  <Space wrap>
                    <ActionButton
                      availability={generateContractAvailability}
                      onClick={generateContract}
                      type="primary"
                    >
                      生成合同
                    </ActionButton>
                    {order.contract ? (
                      <Button
                        onClick={() =>
                          router.push(`/contracts/${order.contract?.id}`)
                        }
                      >
                        查看合同
                      </Button>
                    ) : null}
                  </Space>
                }
                title="主合同及订阅套餐"
              >
                <Descriptions
                  bordered
                  column={2}
                  items={[
                    {
                      children: order.contract?.contractNo ?? "-",
                      label: "主合同"
                    },
                    {
                      children: order.contract
                        ? labelOf(STATUS_LABELS, order.contract.status)
                        : "尚未生成",
                      label: "合同状态"
                    },
                    {
                      children: (
                        <ReviewStatusTag value={order.productReviewStatus} />
                      ),
                      label: "产品匹配审核"
                    },
                    {
                      children: order.quote?.quoteNo ?? "-",
                      label: "原始报价"
                    },
                    {
                      children: `${order.periodMonths} 个月 / ${formatYuan(order.monthlyFeeAmount)}`,
                      label: "签约套餐"
                    }
                  ]}
                  size="small"
                />
              </Card>
            </div>
            <Typography.Title level={5} style={{ margin: 0 }}>
              报价快照
            </Typography.Title>
            <QuoteSnapshotSection order={order} />
          </>
        ) : null;
        break;
      case "handover":
        content = order ? (
          <>
            <HandoverProgressRecords
              resolvedRecordIds={getOrderWorkspaceRecordIds(
                ...handoverWorkOrders.map((workOrder) => workOrder.id),
                ...handoverWorkOrders.map(
                  (workOrder) => workOrder.handoverId
                ),
                ...Object.values(handoverESignStatuses).map(
                  (status) => status?.handoverId
                )
              )}
              summary={summary}
            />
            {hasDeliveryViewPermission ? (
              <DeliveryPanel
                confirmAvailability={confirmDeliveryAvailability}
                delivery={delivery}
                deliveryCheck={deliveryCheck}
                onOpenConfirm={openConfirmDeliveryModal}
                onOpenPrepare={openPrepareDeliveryModal}
                prepareAvailability={prepareDeliveryAvailability}
              />
            ) : null}
            {hasDeliveryViewPermission ? (
              <Stage2HandoverReviewPanel
                actionLoading={handoverActionLoading}
                canAssignExternal={permissions.has("delivery:prepare")}
                canHandleObjection={permissions.has("delivery:confirm")}
                canRecoverWorkflow={permissions.has("delivery:confirm")}
                createAvailability={createHandoverWorkOrderAvailability}
                esignErrors={handoverESignErrors}
                esignLoading={handoverESignLoading}
                esignStatuses={handoverESignStatuses}
                loading={handoverWorkOrdersLoading}
                loadState={handoverWorkOrdersLoadState}
                mutationInFlight={stage2WorkflowRecoveryInFlight}
                onAcknowledge={acknowledgeCustomerObjection}
                onAssignExternal={openAssignExternalHandover}
                onCreateWorkOrder={createHandoverWorkOrder}
                onRecoverWorkflow={confirmStage2WorkflowRecovery}
                onRefreshESign={refreshStage2HandoverESignStatus}
                onRequestResubmission={requestCustomerObjectionResubmission}
                onSendCustomerReview={sendCustomerObjectionBackToReview}
                onStartESign={confirmAdminStage2Fallback}
                onVoidESign={openAdminStage2Void}
                onViewDetail={viewHandoverWorkOrderDetail}
                workOrders={handoverWorkOrders}
              />
            ) : null}
            {hasReturnViewPermission &&
            vehicleReturnWorkspaceState === "ENTRY" ? (
              <VehicleReturnEntry
                onOpenPrepare={openPrepareReturnModal}
                prepareAvailability={prepareReturnAvailability}
              />
            ) : null}
            {hasReturnViewPermission &&
            (
              vehicleReturnWorkspaceState === "WORKFLOW" ||
              vehicleReturnWorkspaceState === "COMPLETED"
            ) ? (
              <ReturnPanel
                confirmAvailability={confirmReturnAvailability}
                onOpenConfirm={openConfirmReturnModal}
                onOpenPrepare={openPrepareReturnModal}
                order={order}
                prepareAvailability={prepareReturnAvailability}
                returnCheck={returnCheck}
                vehicleReturn={vehicleReturn}
              />
            ) : null}
          </>
        ) : null;
        break;
      case "entitlement":
        content =
          order && hasEntitlementViewPermission ? (
            <div data-workspace-record={entitlements.account?.id}>
              <EntitlementPanel
                customerLabel={customerPresentation.label}
                customerMobile={customerPresentation.mobile}
                entitlements={entitlements}
                entitlementLoading={entitlementLoading}
                expiringEntitlements={expiringEntitlements}
                generatingEntitlements={generatingEntitlements}
                onGenerateEntitlements={generateOrderEntitlements}
                onOpenExpireEntitlements={openExpireEntitlementModal}
                onOpenConsume={openConsumeEntitlementModal}
                onOpenMonthlyRenewal={openRenewEntitlementModal}
                onUsagePageChange={handleEntitlementUsagePageChange}
                order={order}
                permissions={permissions}
                renewingEntitlements={renewingEntitlements}
                usageLoading={entitlementUsageLoading}
                usagePage={entitlementUsagePage}
                usagePageSize={entitlementUsagePageSize}
                usageTotal={entitlementUsageTotal}
                usages={entitlementUsages}
              />
            </div>
          ) : null;
        break;
      case "service":
        content = order ? (
          <ServiceCasesPanel
            items={serviceCases}
            loading={serviceCasesLoading}
            orderId={order.id}
          />
        ) : null;
        break;
      case "finance":
        content = order ? (
          <>
            <FinanceProgressRecords
              links={getOrderWorkspaceFinanceLinks(permissions)}
              resolvedRecordIds={getOrderWorkspaceRecordIds(
                ...receivableBills.map((bill) => bill.id),
                ...(depositSettlement?.depositLedgers ?? []).map(
                  (ledger) => ledger.id
                )
              )}
              summary={summary}
            />
            {hasBillingViewPermission ? (
              <FinancePanel
                bills={receivableBills}
                financeLoading={financeLoading}
                generateAvailability={generateInitialBillsAvailability}
                generateMonthlyRentAvailability={
                  generateMonthlyRentAvailability
                }
                generatingBills={generatingBills}
                generatingMonthlyRentBill={generatingMonthlyRentBill}
                onGenerateInitialBills={generateInitialBills}
                onGenerateNextMonthlyRentBill={generateNextMonthlyRentBill}
                onOpenPayment={openPaymentModal}
                paymentAvailability={paymentAvailability}
                summary={financeSummary}
              />
            ) : null}
            {hasDepositSettlementViewPermission ? (
              <DepositSettlementPanel
                customerLabel={customerPresentation.label}
                customerMobile={customerPresentation.mobile}
                deductAvailability={deductDepositAvailability}
                depositSettlementLoading={depositSettlementLoading}
                generateAvailability={generateDamageFeeBillAvailability}
                generatingDamageFeeBill={generatingDamageFeeBill}
                onGenerateDamageFeeBill={generateDamageFeeBill}
                onOpenDeduct={openDeductDepositModal}
                onOpenRefund={openRefundDepositModal}
                order={order}
                refundAvailability={refundDepositAvailability}
                settlement={depositSettlement}
                settlementError={depositSettlementError}
              />
            ) : null}
          </>
        ) : null;
        break;
      case "change":
        content = order ? (
          <>
            <Space style={{ justifyContent: "flex-end", width: "100%" }}>
              <ActionButton
                availability={applyChangeAvailability}
                onClick={openChangeModal}
                type="primary"
              >
                申请变更方案
              </ActionButton>
            </Space>
            {activeOrderChange ? (
              <Alert
                action={
                  <Space wrap>
                    <ActionButton
                      allowed={canCancelActiveChange}
                      disabledReason="当前变更不允许取消"
                      onClick={() => cancelChange(activeOrderChange.id)}
                      size="small"
                    >
                      取消变更申请
                    </ActionButton>
                    <ActionButton
                      allowed={activeOrderChange.status === "PENDING"}
                      disabledReason="当前变更状态不允许审批"
                      noPermissionReason="无审批订单变更权限"
                      onClick={() =>
                        reviewChange(activeOrderChange.id, "approve")
                      }
                      permission="order_change:approve"
                      permissions={permissions}
                      size="small"
                      type="primary"
                    >
                      同意变更
                    </ActionButton>
                    <ActionButton
                      availability={
                        canRejectChange
                          ? actionAvailability({
                              allowed:
                                activeOrderChange.status === "PENDING",
                              disabledReason:
                                "当前变更状态不允许拒绝",
                              permissions
                            })
                          : {
                              allowed: false,
                              reason: "无拒绝订单变更权限"
                            }
                      }
                      danger
                      onClick={() =>
                        reviewChange(activeOrderChange.id, "reject")
                      }
                      size="small"
                    >
                      拒绝变更
                    </ActionButton>
                    <ActionButton
                      availability={canExecuteOrderChange(
                        activeOrderChange,
                        order,
                        permissions
                      )}
                      onClick={() =>
                        returnChangeToPlan(activeOrderChange.id)
                      }
                      size="small"
                      type="primary"
                    >
                      取消当前订单并退回方案生成环节
                    </ActionButton>
                  </Space>
                }
                description={`状态：${labelOf(STATUS_LABELS, activeOrderChange.status)} / 创建时间：${formatTime(activeOrderChange.createdAt)}`}
                message="当前订单存在进行中的变更申请，暂不能继续后续操作。"
                showIcon
                type="warning"
              />
            ) : null}
            {order.orderStatus === "CANCELLED" ? (
              <Alert
                action={
                  !isCustomerSelfServiceOrder && order.application ? (
                    <Link href={`/applications/${order.application.id}`}>
                      返回进件重新生成方案
                    </Link>
                  ) : undefined
                }
                description={returnToPlanHint}
                message="方案变更已退回"
                showIcon
                type="info"
              />
            ) : null}
            <Card title="订单变更记录">
              <Table
                columns={changeColumns}
                dataSource={changes}
                onRow={(change) =>
                  ({
                    "data-workspace-record": change.id
                  }) as HTMLAttributes<HTMLTableRowElement>
                }
                pagination={false}
                rowKey="id"
                scroll={{ x: 1280 }}
                size="small"
              />
            </Card>
            <OrderChangeSnapshots changes={changes} />
          </>
        ) : null;
        break;
    }

    return (
      <Space
        data-workspace-domain={activeTab}
        orientation="vertical"
        size={16}
        style={{ width: "100%" }}
      >
        {authError ? (
          <Alert
            description={authError}
            message="权限信息加载失败"
            showIcon
            type="error"
          />
        ) : null}
        {activeDomainError ? (
          <Alert
            action={
              <Button onClick={retryActiveWorkspaceTab} size="small">
                重试当前页签
              </Button>
            }
            description="已保留工作台和成功加载的数据，可单独重试当前页签。"
            message={activeDomainError}
            showIcon
            type="error"
          />
        ) : null}
        {activeDomainLoading && !activeDomainState.loaded ? (
          <div style={{ minHeight: 180, paddingTop: 48, textAlign: "center" }}>
            <Spin />
          </div>
        ) : (
          content
        )}
      </Space>
    );
  }

  const stage2FallbackPdfDownloadUrl = stage2FallbackWorkOrderId
    ? buildAdminStage2HandoverPdfDownloadUrl(
        stage2FallbackWorkOrderId
      )
    : null;

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        <OrderWorkspaceHeader
          header={workspaceHeader}
          onBack={() => router.push("/orders")}
          onRefresh={() => void loadOrder()}
          overflowActions={workspaceOverflowActions}
          refreshing={summaryLoading || activeDomainLoading}
        />

        {summaryError ? (
          <Alert
            action={
              <Button onClick={retryWorkspaceSummary} size="small">
                重试摘要
              </Button>
            }
            description="订单摘要加载失败不会清空已加载的页签数据。"
            message={summaryError}
            showIcon
            type="error"
          />
        ) : null}

        {visibleGuideSummary ? (
          <OrderTransactionGuide
            onNavigate={navigateWorkspace}
            summary={visibleGuideSummary}
          />
        ) : (
          <section
            aria-label="订单推进指引"
            data-workspace-guide="true"
            style={{ minHeight: 116, padding: "36px 0", textAlign: "center" }}
          >
            {summaryLoading ? <Spin size="small" /> : null}
          </section>
        )}

        <OrderWorkspace
          activeTab={activeTab}
          onTabChange={(tab) => navigateWorkspace({ tab })}
          slots={{ [activeTab]: renderActiveWorkspaceTab() }}
          tabBadges={summary?.tabBadges}
          visibleTabs={visibleTabs}
        />

        <Stage2HandoverReviewDetailModal
          actionLoading={handoverActionLoading}
          canAssignExternal={permissions.has("delivery:prepare")}
          canHandleObjection={permissions.has("delivery:confirm")}
          canRecoverWorkflow={permissions.has("delivery:confirm")}
          detail={handoverWorkOrderDetail}
          esignError={handoverWorkOrderDetail ? handoverESignErrors[handoverWorkOrderDetail.id] : undefined}
          esignLoading={Boolean(handoverWorkOrderDetail && handoverESignLoading[handoverWorkOrderDetail.id])}
          esignStatus={handoverWorkOrderDetail ? handoverESignStatuses[handoverWorkOrderDetail.id] : undefined}
          mutationInFlight={stage2WorkflowRecoveryInFlight}
          onAcknowledge={acknowledgeCustomerObjection}
          onAssignExternal={openAssignExternalHandover}
          onClose={() => setHandoverWorkOrderDetailOpen(false)}
          onRecoverWorkflow={confirmStage2WorkflowRecovery}
          onRefreshESign={refreshStage2HandoverESignStatus}
          onRequestResubmission={requestCustomerObjectionResubmission}
          onSendCustomerReview={sendCustomerObjectionBackToReview}
          onStartESign={confirmAdminStage2Fallback}
          onVoidESign={openAdminStage2Void}
          open={handoverWorkOrderDetailOpen}
        />

        <Modal
          cancelButtonProps={{
            disabled: stage2WorkflowRecoveryInFlight
          }}
          confirmLoading={Boolean(
            stage2FallbackWorkOrderId &&
            handoverActionLoading ===
              `stage2-start:${stage2FallbackWorkOrderId}`
          )}
          destroyOnHidden
          okText="确认发起"
          onCancel={closeAdminStage2Fallback}
          onOk={submitAdminStage2Fallback}
          open={stage2FallbackOpen}
          title="确认后台兜底发起签署"
          width={680}
        >
          <Space
            orientation="vertical"
            size={12}
            style={{ width: "100%" }}
          >
            <Alert
              message="后台将以 ADMIN_FALLBACK 身份发起，不会代替 Field 经办人。"
              showIcon
              type="warning"
            />
            <Descriptions
              bordered
              column={1}
              items={[
                {
                  children:
                    stage2FallbackSourceArtifact
                      ?.artifactVersion ?? "-",
                  label: "PDF 版本"
                },
                {
                  children: stage2FallbackSourceArtifact ? (
                    <Typography.Text
                      code
                      copyable={{
                        text:
                          stage2FallbackSourceArtifact
                            .sourcePdfHash
                      }}
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {
                        stage2FallbackSourceArtifact
                          .sourcePdfHash
                      }
                    </Typography.Text>
                  ) : "-",
                  label: "SHA-256"
                }
              ]}
              size="small"
            />
            {stage2FallbackPdfDownloadUrl ? (
              <Button
                href={stage2FallbackPdfDownloadUrl}
                icon={<DownloadOutlined />}
                rel="noreferrer"
                target="_blank"
              >
                预览/下载 PDF
              </Button>
            ) : null}
            <Form<Stage2FallbackFormValues>
              form={stage2FallbackForm}
              layout="vertical"
            >
              <Form.Item
                name="acknowledgement"
                rules={[
                  {
                    validator: async (_, value) => {
                      if (value !== true) {
                        throw new Error(
                          "请先核对当前交接确认单"
                        );
                      }
                    }
                  }
                ]}
                valuePropName="checked"
              >
                <Checkbox>已核对当前交接确认单</Checkbox>
              </Form.Item>
              <Form.Item
                label="兜底发起原因"
                name="reason"
                rules={[
                  {
                    required: true,
                    message: "请填写兜底发起原因"
                  },
                  {
                    validator: async (_, value) => {
                      const validationError =
                        validateAdminStage2HandoverFallbackReason(
                          value ?? ""
                        );
                      if (validationError) {
                        throw new Error(validationError);
                      }
                    }
                  }
                ]}
              >
                <Input.TextArea
                  autoSize={{ maxRows: 6, minRows: 3 }}
                />
              </Form.Item>
            </Form>
          </Space>
        </Modal>

        <Modal
          cancelButtonProps={{ disabled: stage2WorkflowRecoveryInFlight }}
          confirmLoading={Boolean(
            stage2VoidWorkOrderId &&
            handoverActionLoading === `stage2-void:${stage2VoidWorkOrderId}`
          )}
          destroyOnHidden
          okText="确认作废"
          onCancel={closeAdminStage2Void}
          onOk={submitAdminStage2Void}
          open={stage2VoidOpen}
          title="作废并重新发起"
        >
          <Form<Stage2VoidFormValues>
            form={stage2VoidForm}
            layout="vertical"
          >
            <Form.Item
              label="作废原因"
              name="reason"
              rules={[
                { required: true, message: "请填写作废原因" },
                {
                  validator: async (_, value) => {
                    const validationError =
                      validateAdminStage2HandoverVoidReason(value ?? "");
                    if (validationError) {
                      throw new Error(validationError);
                    }
                  }
                }
              ]}
            >
              <Input.TextArea
                autoSize={{ maxRows: 6, minRows: 3 }}
                maxLength={500}
              />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          footer={null}
          onCancel={() => setAssignExternalHandoverOpen(false)}
          open={assignExternalHandoverOpen}
          title="指派 Field 交付人员"
        >
          <Form<AssignExternalHandoverFormValues>
            form={assignExternalHandoverForm}
            layout="vertical"
            onFinish={assignExternalHandover}
          >
            <Form.Item label="姓名" name="name" rules={[{ required: true, message: "请填写 Field 交付人员姓名" }]}>
              <Input maxLength={64} />
            </Form.Item>
            <Form.Item
              label="手机号"
              name="phone"
              rules={[
                { required: true, message: "请填写用于 Field 登录的手机号" },
                { pattern: /^1[3-9]\d{9}$/, message: "请输入正确的手机号" }
              ]}
            >
              <Input inputMode="tel" maxLength={11} />
            </Form.Item>
            <Form.Item label="所属机构" name="organization">
              <Input maxLength={128} />
            </Form.Item>
            <Form.Item label="访问有效期" name="expiresAt" rules={[{ required: true, message: "请选择访问有效期" }]}>
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Button
              block
              htmlType="submit"
              icon={<UserAddOutlined />}
              loading={Boolean(assignExternalHandoverId && handoverActionLoading === `assign:${assignExternalHandoverId}`)}
              type="primary"
            >
              确认指派
            </Button>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          footer={null}
          onCancel={() => setHandoverResubmissionOpen(false)}
          open={handoverResubmissionOpen}
          title="要求现场复检"
          width={620}
        >
          <Form<HandoverResubmissionFormValues>
            form={handoverResubmissionForm}
            layout="vertical"
            onFinish={submitHandoverResubmission}
          >
            <Form.Item
              label="复检说明"
              name="note"
              rules={[{ required: true, message: "请填写现场复检要求" }]}
            >
              <Input.TextArea autoSize={{ maxRows: 6, minRows: 3 }} maxLength={1000} />
            </Form.Item>
            <Form.Item label="需要复检的资料" name="targetEvidenceItemIds">
              <Select
                mode="multiple"
                options={(handoverResubmissionDetail?.evidenceChecklist?.items ?? [])
                  .filter((item) => Boolean(item.id))
                  .map((item) => ({
                    label: item.title || item.evidenceType || "现场资料",
                    value: item.id as string
                  }))}
                placeholder="不选择则允许复检全部资料"
              />
            </Form.Item>
            <Form.Item label="需要复检的现场信息" name="targetFieldKeys">
              <Select mode="multiple" options={handoverFieldFactOptions} placeholder="不选择则允许复检全部现场信息" />
            </Form.Item>
            <Button
              block
              htmlType="submit"
              loading={Boolean(
                handoverResubmissionDetail?.id &&
                handoverActionLoading === `request-resubmission:${handoverResubmissionDetail.id}`
              )}
              type="primary"
            >
              发送复检要求
            </Button>
          </Form>
        </Modal>

        <Modal
          confirmLoading={consumeEntitlementSubmitting}
          destroyOnHidden
          onCancel={closeConsumeEntitlementModal}
          onOk={submitConsumeEntitlement}
          open={consumeEntitlementModalOpen}
          title="消耗权益"
          width={640}
        >
          <Form form={consumeEntitlementForm} layout="vertical">
            <Form.Item label="权益名称">
              <Input disabled value={safeText(consumingGrant?.entitlementName)} />
            </Form.Item>
            <Form.Item label="当前剩余">
              <Input
                disabled
                value={
                  consumingGrant
                    ? formatEntitlementAmount(consumingGrant.remainingAmount, consumingGrant.unit)
                    : "-"
                }
              />
            </Form.Item>
            <Form.Item label="权益有效期">
              <Input
                disabled
                value={
                  consumingGrant
                    ? formatEntitlementPeriod(consumingGrant.grantPeriodStart, consumingGrant.grantPeriodEnd)
                    : "-"
                }
              />
            </Form.Item>
            {consumingGrant && isGrantPastEffectivePeriod(consumingGrant) ? (
              <Alert showIcon title="该权益已超过有效期，建议先处理过期权益。" type="warning" />
            ) : null}
            <Form.Item
              label="本次消耗数量"
              name="usedAmount"
              rules={[
                { required: true, message: "请输入本次消耗数量" },
                {
                  validator: async (_, value) => {
                    const usedAmount = toNumber(value);
                    const remainingAmount = toNumber(consumingGrant?.remainingAmount) ?? 0;
                    if (usedAmount === null || usedAmount <= 0) {
                      throw new Error("本次消耗数量必须大于 0");
                    }
                    if (usedAmount > remainingAmount) {
                      throw new Error("本次消耗数量不能超过当前剩余");
                    }
                  }
                }
              ]}
            >
              <InputNumber
                addonAfter={consumingGrant ? labelOf(ENTITLEMENT_UNIT_LABELS, consumingGrant.unit) : undefined}
                max={toNumber(consumingGrant?.remainingAmount) ?? undefined}
                min={0.01}
                precision={2}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label="发生时间"
              name="occurredAt"
              rules={[
                { required: true, message: "请选择发生时间" },
                {
                  validator: async (_, value: Dayjs | undefined) => {
                    const error = getConsumeOccurredAtError(consumingGrant, value);
                    if (error) {
                      throw new Error(error);
                    }
                  }
                }
              ]}
            >
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="消耗来源"
              name="usageSource"
              rules={[{ required: true, message: "请选择消耗来源" }]}
            >
              <Select options={entitlementUsageSourceOptions} />
            </Form.Item>
            <Form.Item label="外部流水号" name="externalRefNo">
              <Input placeholder="CHARGE-20260610-001" />
            </Form.Item>
            <Form.Item label="使用场景" name="scenario">
              <Input placeholder="客户补能核销" />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          footer={[
            <Button key="cancel" onClick={closeRenewEntitlementModal}>
              取消
            </Button>,
            <Button
              icon={<ReloadOutlined />}
              key="dryRun"
              loading={renewingEntitlements}
              onClick={() => submitRenewEntitlements(true)}
            >
              试算
            </Button>,
            <Button
              key="submit"
              loading={renewingEntitlements}
              onClick={() => submitRenewEntitlements(false)}
              type="primary"
            >
              正式生成
            </Button>
          ]}
          onCancel={closeRenewEntitlementModal}
          open={renewEntitlementModalOpen}
          title="生成下一期权益"
          width={900}
        >
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              showIcon
              title="试算模式不会写入数据库，仅展示该订单下一期权益是否可生成。正式生成会创建 MONTHLY_RENEWAL 权益发放记录，并写入审计日志。"
              type="info"
            />
            <Form form={renewEntitlementForm} layout="vertical">
              <Form.Item
                label="处理日期"
                name="asOfDate"
                rules={[{ required: true, message: "请选择处理日期" }]}
              >
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="dryRun" valuePropName="checked">
                <Checkbox>试算模式</Checkbox>
              </Form.Item>
            </Form>
            <EntitlementOperationResultView result={renewEntitlementResult} type="renewal" />
          </Space>
        </Modal>

        <Modal
          destroyOnHidden
          footer={[
            <Button key="cancel" onClick={closeExpireEntitlementModal}>
              取消
            </Button>,
            <Button
              icon={<ReloadOutlined />}
              key="dryRun"
              loading={expiringEntitlements}
              onClick={() => submitExpireEntitlements(true)}
            >
              试算
            </Button>,
            <Button
              key="submit"
              loading={expiringEntitlements}
              onClick={() => submitExpireEntitlements(false)}
              type="primary"
            >
              正式处理
            </Button>
          ]}
          onCancel={closeExpireEntitlementModal}
          open={expireEntitlementModalOpen}
          title="处理过期权益（全局）"
          width={900}
        >
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              showIcon
              title="该操作会处理所有已超过有效期的权益，不限于当前订单。"
              type="warning"
            />
            <Alert
              showIcon
              title="试算模式不会写入数据库，仅展示将被过期处理的权益。正式处理会将所有满足条件的 ACTIVE 权益改为 EXPIRED，并写入审计日志。"
              type="info"
            />
            <Form form={expireEntitlementForm} layout="vertical">
              <Form.Item
                label="处理日期"
                name="asOfDate"
                rules={[{ required: true, message: "请选择处理日期" }]}
              >
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="dryRun" valuePropName="checked">
                <Checkbox>试算模式</Checkbox>
              </Form.Item>
            </Form>
            <EntitlementOperationResultView result={expireEntitlementResult} type="expire" />
          </Space>
        </Modal>

        <Modal
          confirmLoading={paymentSubmitting}
          destroyOnHidden
          onCancel={closePaymentModal}
          onOk={submitPayment}
          open={paymentModalOpen}
          title="登记收款"
          width={860}
        >
          <Form form={paymentForm} layout="vertical">
            <Form.Item
              label="收款金额"
              name="paymentAmountYuan"
              rules={[{ required: true, message: "请填写收款金额" }]}
            >
              <InputNumber min={0.01} precision={2} addonAfter="元" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="收款方式"
              name="paymentMethod"
              rules={[{ required: true, message: "请选择收款方式" }]}
            >
              <Select options={paymentMethodOptions} />
            </Form.Item>
            <Form.Item
              label="收款时间"
              name="receivedAt"
              rules={[{ required: true, message: "请选择收款时间" }]}
            >
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="付款人" name="payerName">
              <Input placeholder="张三" />
            </Form.Item>
            <Form.Item label="付款账户" name="payerAccount">
              <Input placeholder="招商银行 6222****" />
            </Form.Item>
            <Form.Item label="付款凭证 URL" name="paymentProofUrlsText">
              <Input.TextArea placeholder="多个 URL 可用逗号或换行分隔" rows={2} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>

            <Form.Item name="writeOffEnabled" valuePropName="checked">
              <Checkbox disabled={Boolean(writeOffDisabledReason)}>同时核销账单</Checkbox>
            </Form.Item>
            {writeOffDisabledReason ? <Alert message={writeOffDisabledReason} showIcon type="info" /> : null}

            {writeOffEnabled ? (
              <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                <Alert
                  message={`本次核销合计：${formatYuan(watchedWriteOffTotalAmount)} / 收款金额：${formatYuan(watchedPaymentAmount)}`}
                  showIcon
                  type={writeOffTotalExceedsPayment ? "error" : "info"}
                />
                {writeOffTotalExceedsPayment ? (
                  <Alert message="核销金额不能超过收款金额" showIcon type="error" />
                ) : null}
                {unsettledBills.map((bill, index) => {
                  const remainingAmount = toNumber(bill.remainingAmount) ?? 0;

                  return (
                    <Card
                      key={bill.id}
                      size="small"
                      title={`${labelOf(BILL_TYPE_LABELS, bill.billType)} / ${bill.billNo}`}
                    >
                      <Descriptions
                        column={3}
                        size="small"
                        items={[
                          { label: "账单状态", children: <BillStatusTag value={bill.billStatus} /> },
                          { label: "应收金额", children: formatYuan(bill.amount) },
                          { label: "剩余金额", children: formatYuan(bill.remainingAmount) }
                        ]}
                      />
                      <Form.Item hidden name={["writeOffItems", index, "billId"]}>
                        <Input />
                      </Form.Item>
                      <Form.Item
                        label="本次核销金额"
                        name={["writeOffItems", index, "writeOffAmountYuan"]}
                        rules={[
                          {
                            validator: async (_, value) => {
                              const amount = yuanToCents(value);
                              if (!amount || amount <= 0) {
                                return;
                              }
                              if (amount > remainingAmount) {
                                throw new Error("核销金额不能超过账单剩余金额");
                              }
                            }
                          }
                        ]}
                      >
                        <InputNumber
                          min={0}
                          max={centsToYuan(remainingAmount)}
                          precision={2}
                          addonAfter="元"
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Card>
                  );
                })}
              </Space>
            ) : null}
          </Form>
        </Modal>

        <Modal
          confirmLoading={deductingDeposit}
          destroyOnHidden
          onCancel={closeDeductDepositModal}
          onOk={submitDeductDeposit}
          open={deductDepositModalOpen}
          title="保证金扣减"
          width={720}
        >
          <Form form={deductDepositForm} layout="vertical">
            <Form.Item
              label="损伤费用账单"
              name="billId"
              rules={[{ required: true, message: "请选择损伤费用账单" }]}
            >
              <Select options={damageFeeBillOptions} />
            </Form.Item>
            <Form.Item
              label="扣减金额"
              name="amountYuan"
              rules={[
                { required: true, message: "请填写扣减金额" },
                {
                  validator: async (_, value) => {
                    const amount = yuanToCents(value);
                    const billId = deductDepositForm.getFieldValue("billId");
                    const bill = billId ? damageFeeBills.find((item) => item.id === billId) : null;
                    const billRemainingAmount = toNumber(bill?.remainingAmount) ?? damageFeeRemainingAmount;

                    if (!amount || amount <= 0) {
                      throw new Error("扣减金额必须大于 0");
                    }
                    if (amount > availableDepositBalance) {
                      throw new Error("扣减金额不能超过可用保证金余额");
                    }
                    if (amount > billRemainingAmount) {
                      throw new Error("扣减金额不能超过损伤费用剩余未收金额");
                    }
                  }
                }
              ]}
            >
              <InputNumber
                addonAfter="元"
                max={centsToYuan(Math.min(availableDepositBalance, damageFeeRemainingAmount))}
                min={0.01}
                precision={2}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          confirmLoading={refundingDeposit}
          destroyOnHidden
          onCancel={closeRefundDepositModal}
          onOk={submitRefundDeposit}
          open={refundDepositModalOpen}
          title="保证金退款"
          width={640}
        >
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Alert
              message="当前为人工确认退款记录，不代表已通过银行或第三方支付渠道自动打款。"
              showIcon
              type="warning"
            />
            <Form form={refundDepositForm} layout="vertical">
              <Form.Item
                label="退款金额"
                name="amountYuan"
                rules={[
                  { required: true, message: "请填写退款金额" },
                  {
                    validator: async (_, value) => {
                      const amount = yuanToCents(value);
                      if (!amount || amount <= 0) {
                        throw new Error("退款金额必须大于 0");
                      }
                      if (amount > availableDepositBalance) {
                        throw new Error("退款金额不能超过可用保证金余额");
                      }
                      if (damageFeeRemainingAmount > 0 && suggestedDeductibleAmount > 0) {
                        throw new Error("请先处理损伤费用");
                      }
                    }
                  }
                ]}
              >
                <InputNumber
                  addonAfter="元"
                  max={centsToYuan(availableDepositBalance)}
                  min={0.01}
                  precision={2}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item label="备注" name="remark">
                <Input.TextArea rows={3} />
              </Form.Item>
            </Form>
          </Space>
        </Modal>

        <Modal
          destroyOnHidden
          onCancel={closePrepareDeliveryModal}
          onOk={prepareDelivery}
          open={prepareDeliveryModalOpen}
          title="准备交付"
        >
          <Form form={prepareDeliveryForm} layout="vertical">
            <Form.Item label="预约交付时间" name="scheduledAt">
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="交付地点" name="deliveryLocation">
              <Input placeholder="静安旺旺大厦" />
            </Form.Item>
            {deliveryCheck?.depositRequired === false ? (
              <Alert message="0 元押金，自动满足押金收取确认。" showIcon type="success" />
            ) : null}
            <Form.Item name="depositReceivedConfirmed" valuePropName="checked">
              <Checkbox disabled={deliveryCheck?.depositRequired === false}>押金收取确认</Checkbox>
            </Form.Item>
            <Form.Item name="firstMonthlyFeeReceivedConfirmed" valuePropName="checked">
              <Checkbox>首期月费收取确认</Checkbox>
            </Form.Item>
            <Form.Item name="insuranceValidConfirmed" valuePropName="checked">
              <Checkbox>保险人工核验</Checkbox>
            </Form.Item>
            <Form.Item name="vehiclePreparedConfirmed" valuePropName="checked">
              <Checkbox>车辆整备完成确认</Checkbox>
            </Form.Item>
            <Form.Item name="vehiclePhotosConfirmed" valuePropName="checked">
              <Checkbox>车辆照片确认</Checkbox>
            </Form.Item>
            <Form.Item name="customerIdentityConfirmed" valuePropName="checked">
              <Checkbox>客户身份核验确认</Checkbox>
            </Form.Item>
            <Form.Item name="handoverDocumentsConfirmed" valuePropName="checked">
              <Checkbox>交付文件确认</Checkbox>
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          onCancel={closeConfirmDeliveryModal}
          onOk={confirmDelivery}
          open={confirmDeliveryModalOpen}
          title="确认交付"
        >
          <Form form={confirmDeliveryForm} layout="vertical">
            <Form.Item label="实际交付时间" name="deliveredAt" rules={[{ required: true, message: "请选择实际交付时间" }]}>
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="交付里程" name="handoverMileageKm" rules={[{ required: true, message: "请填写交付里程" }]}>
              <InputNumber min={0} addonAfter="km" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          onCancel={closePrepareReturnModal}
          onOk={prepareReturn}
          open={prepareReturnModalOpen}
          title="准备退车"
        >
          <Form form={prepareReturnForm} layout="vertical">
            <Form.Item label="退车类型" name="returnType" rules={[{ required: true, message: "请选择退车类型" }]}>
              <Select options={returnTypeOptions} />
            </Form.Item>
            <Form.Item label="预约退车时间" name="scheduledAt">
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="退车地点" name="returnLocation">
              <Input placeholder="静安旺旺大厦" />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          onCancel={closeConfirmReturnModal}
          onOk={confirmReturn}
          open={confirmReturnModalOpen}
          title="确认退车"
          width={860}
        >
          <Form form={confirmReturnForm} layout="vertical">
            <Form.Item label="退车类型" name="returnType" rules={[{ required: true, message: "请选择退车类型" }]}>
              <Select options={returnTypeOptions} />
            </Form.Item>
            <Form.Item label="实际退车时间" name="returnedAt" rules={[{ required: true, message: "请选择实际退车时间" }]}>
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="退车里程" name="returnMileageKm" rules={[{ required: true, message: "请填写退车里程" }]}>
              <InputNumber min={0} precision={0} addonAfter="km" style={{ width: "100%" }} />
            </Form.Item>
            <Space orientation="vertical" size={0} style={{ width: "100%" }}>
              <Form.Item name="keysReturnedConfirmed" valuePropName="checked">
                <Checkbox>钥匙已归还</Checkbox>
              </Form.Item>
              <Form.Item name="chargingEquipmentReturnedConfirmed" valuePropName="checked">
                <Checkbox>充电设备已归还</Checkbox>
              </Form.Item>
              <Form.Item name="vehicleDocumentsReturnedConfirmed" valuePropName="checked">
                <Checkbox>车辆文件已归还</Checkbox>
              </Form.Item>
              <Form.Item name="customerItemsClearedConfirmed" valuePropName="checked">
                <Checkbox>客户物品已清空</Checkbox>
              </Form.Item>
              <Form.Item name="exteriorCheckedConfirmed" valuePropName="checked">
                <Checkbox>外观已检查</Checkbox>
              </Form.Item>
              <Form.Item name="interiorCheckedConfirmed" valuePropName="checked">
                <Checkbox>内饰已检查</Checkbox>
              </Form.Item>
              <Form.Item name="batteryCheckedConfirmed" valuePropName="checked">
                <Checkbox>电池已检查</Checkbox>
              </Form.Item>
              <Form.Item name="mileageConfirmed" valuePropName="checked">
                <Checkbox>里程已确认</Checkbox>
              </Form.Item>
              <Form.Item name="violationCheckedConfirmed" valuePropName="checked">
                <Checkbox>违章已检查</Checkbox>
              </Form.Item>
              <Form.Item name="cleaningRequired" valuePropName="checked">
                <Checkbox>是否需要清洁</Checkbox>
              </Form.Item>
              <Form.Item name="maintenanceRequired" valuePropName="checked">
                <Checkbox>是否需要维修</Checkbox>
              </Form.Item>
              <Form.Item name="damageFound" valuePropName="checked">
                <Checkbox>是否发现损伤</Checkbox>
              </Form.Item>
            </Space>

            <Form.List name="damages">
              {(fields, { add, remove }) => (
                <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                  <Space style={{ justifyContent: "space-between", width: "100%" }}>
                    <Typography.Text strong>损伤记录</Typography.Text>
                    <ActionButton
                      allowed={canRecordReturnDamage}
                      disabledReason="无损伤记录权限"
                      icon={<PlusOutlined />}
                      onClick={() => add({ responsibleParty: "UNKNOWN" })}
                    >
                      新增损伤
                    </ActionButton>
                  </Space>
                  {!canRecordReturnDamage ? (
                    <Alert message="无损伤记录权限，仅可提交退车检查项。" showIcon type="info" />
                  ) : null}
                  {fields.map((field, index) => (
                    <Card
                      extra={
                        <Button
                          aria-label="删除损伤记录"
                          icon={<DeleteOutlined />}
                          onClick={() => remove(field.name)}
                          size="small"
                        />
                      }
                      key={field.key}
                      size="small"
                      title={`损伤 ${index + 1}`}
                    >
                      <Form.Item
                        label="损伤类型"
                        name={[field.name, "damageType"]}
                        rules={[{ required: true, message: "请选择损伤类型" }]}
                      >
                        <Select options={damageTypeOptions} />
                      </Form.Item>
                      <Form.Item
                        label="损伤等级"
                        name={[field.name, "damageLevel"]}
                        rules={[{ required: true, message: "请选择损伤等级" }]}
                      >
                        <Select options={damageLevelOptions} />
                      </Form.Item>
                      <Form.Item
                        label="描述"
                        name={[field.name, "description"]}
                        rules={[{ required: true, message: "请填写损伤描述" }]}
                      >
                        <Input.TextArea rows={2} />
                      </Form.Item>
                      <Form.Item label="责任方" name={[field.name, "responsibleParty"]}>
                        <Select options={responsiblePartyOptions} />
                      </Form.Item>
                      <Form.Item label="预估维修金额" name={[field.name, "estimatedRepairAmount"]}>
                        <InputNumber min={0} precision={2} addonAfter="元" style={{ width: "100%" }} />
                      </Form.Item>
                      <Form.Item label="照片 URL" name={[field.name, "photoUrlsText"]}>
                        <Input.TextArea placeholder="多个 URL 可用逗号或换行分隔" rows={2} />
                      </Form.Item>
                    </Card>
                  ))}
                </Space>
              )}
            </Form.List>

            <Form.Item label="备注" name="remark" style={{ marginTop: 16 }}>
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          onCancel={closeChangeModal}
          onOk={createChange}
          open={changeModalOpen}
          title="申请变更方案 / 退回重做方案"
        >
          <Form form={changeForm} layout="vertical">
            <Form.Item label="变更类型">
              <Input disabled value="退回重做方案" />
            </Form.Item>
            <Space orientation="vertical" size={4} style={{ marginBottom: 12 }}>
              <Typography.Text strong>处理方式</Typography.Text>
              <Typography.Text>审批通过后，由运营取消当前订单、作废未签署合同并释放车辆。</Typography.Text>
              <Typography.Text>{returnToPlanHint}</Typography.Text>
              <Typography.Text strong>当前订单车辆</Typography.Text>
              <Typography.Text>
                车辆：{order?.vehicle ? joinText(order.vehicle.vehicleNo, order.vehicle.plateNo, order.vehicle.vin) : "-"}
              </Typography.Text>
              <Typography.Text>车辆状态：{order?.vehicle?.status ?? "-"}</Typography.Text>
              <Typography.Text>车型：{orderModelDisplay(order)}</Typography.Text>
              <Typography.Text>当前销售价：{formatYuan(currentVehicleSalePrice)}</Typography.Text>
            </Space>
            <Form.Item label="变更原因" name="reason" rules={[{ required: true, message: "请填写变更原因" }]}>
              <Input.TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </ProtectedShell>
  );
}

function OrderDetailPageRoute() {
  const { id: orderId } = useParams<{ id: string }>();

  return <OrderDetailPageContent key={orderId} orderId={orderId} />;
}

export default function OrderDetailPage() {
  return (
    <Suspense
      fallback={
        <ProtectedShell>
          <Spin />
        </ProtectedShell>
      }
    >
      <OrderDetailPageRoute />
    </Suspense>
  );
}
