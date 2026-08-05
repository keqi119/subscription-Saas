import { apiFetch } from "./api";

export type SubscriptionChangeStatus =
  | "DRAFT"
  | "QUOTED"
  | "CUSTOMER_CONFIRMED"
  | "SIGNING_OR_PAYMENT"
  | "SCHEDULED"
  | "EXECUTING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "MANUAL_TAKEOVER";

export type SubscriptionChangePricingMode =
  | "CURRENT_VERSION"
  | "ORIGINAL_PRICE"
  | "APPROVED_DISCOUNT";

export interface AdminSubscriptionChangeQuote {
  createdBy?: string | null;
  confirmedAt?: string | null;
  depositAmount?: string;
  id: string;
  mileageLimitKm?: number;
  monthlyFeeAmount: string;
  overMileageFeeAmount?: string;
  planSnapshot?: unknown;
  priceRuleSnapshot?: unknown;
  pricingMode: SubscriptionChangePricingMode;
  quoteNo: string;
  quoteSnapshot?: unknown;
  revision: number;
  status: string;
  subscriptionPlanId?: string | null;
  validUntil: string;
}

export interface AdminSubscriptionContractSegment {
  endDate: string;
  id: string;
  monthlyFeeAmount: string;
  segmentNo?: string;
  startDate: string;
  status?: string;
}

export interface AdminSubscriptionChangeContract {
  archivedAt?: string | null;
  contractNo: string;
  fileId?: string | null;
  id: string;
  signedAt?: string | null;
  status: string;
}

export interface AdminSubscriptionAutomationJob {
  attemptCount?: number;
  availableAt?: string;
  id: string;
  jobStatus: string;
  jobType: string;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  maxAttempts?: number;
}

export interface AdminRenewalReminder {
  errorCode?: string | null;
  errorMessage?: string | null;
  id: string;
  inAppStatus?: string | null;
  scheduledAt: string;
  slot: string;
  smsStatus?: string | null;
  status: string;
}

export interface AdminSubscriptionChange {
  automationJobs: AdminSubscriptionAutomationJob[];
  changeNo: string;
  changeType: "EXTENSION";
  completionDeadlineAt: string;
  confirmedQuote?: AdminSubscriptionChangeQuote | null;
  contract: AdminSubscriptionChangeContract | null;
  createdAt: string;
  currentQuote: AdminSubscriptionChangeQuote | null;
  customerConfirmationPublishedAt?: string | null;
  extensionMonths: number;
  failureCode?: string | null;
  failureMessage?: string | null;
  id: string;
  manualTakeoverReason?: string | null;
  order: {
    customer?: { id: string; name?: string | null; mobile?: string | null };
    id: string;
    orderNo: string;
    vehicle?: { plateNo?: string | null; vehicleNo?: string | null } | null;
  };
  orderId: string;
  priceOverrideApprovedAt: string | null;
  priceOverrideApprovedBy: string | null;
  priceOverrideReason: string | null;
  pricingMode: SubscriptionChangePricingMode;
  quotes: AdminSubscriptionChangeQuote[];
  renewalConsideration: {
    completionDeadlineAt?: string;
    id: string;
    reminders?: AdminRenewalReminder[];
    status: string;
  } | null;
  sourceSegment: AdminSubscriptionContractSegment;
  status: SubscriptionChangeStatus;
  targetEndDate: string;
  targetSegment: AdminSubscriptionContractSegment | null;
  targetStartDate: string;
  updatedAt: string;
  version: number;
}

export interface AdminRenewalConsideration {
  changeOrder: Pick<
    AdminSubscriptionChange,
    | "changeNo"
    | "completionDeadlineAt"
    | "id"
    | "pricingMode"
    | "status"
    | "targetEndDate"
    | "targetStartDate"
  > | null;
  completionDeadlineAt: string;
  considerationNo: string;
  decision?: string | null;
  id: string;
  order: AdminSubscriptionChange["order"];
  reminders: AdminRenewalReminder[];
  segment: AdminSubscriptionContractSegment;
  status: string;
}

export interface AdminRenewalConsiderationPage {
  items: AdminRenewalConsideration[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminSubscriptionChangeTimelineItem {
  action: string;
  createdAt: string;
  entityId: string;
  entityType: string;
  id: string;
  operatorId?: string | null;
}

export interface AdminContractESignTask {
  completedAt?: string | null;
  errorSnapshot?: unknown;
  failedAt?: string | null;
  id: string;
  signingStage: string;
  taskNo: string;
  taskStatus: string;
}

export interface FormalQuoteInput {
  discountedMonthlyFeeAmount?: string;
  requestedVehicleBaseFeeAmount?: string;
  subscriptionPlanId?: string;
  version: number;
}

function commandHeaders() {
  return { "Idempotency-Key": crypto.randomUUID() };
}

export function listRenewalConsiderations(input: {
  page?: number;
  pageSize?: number;
  smsFailed?: boolean;
  status?: string;
} = {}) {
  const query = new URLSearchParams();
  if (input.page) query.set("page", String(input.page));
  if (input.pageSize) query.set("pageSize", String(input.pageSize));
  if (input.smsFailed !== undefined) query.set("smsFailed", String(input.smsFailed));
  if (input.status) query.set("status", input.status);
  return apiFetch<AdminRenewalConsiderationPage>(
    `/renewal-considerations${query.size ? `?${query.toString()}` : ""}`
  );
}

export function getSubscriptionChange(id: string) {
  return apiFetch<AdminSubscriptionChange>(`/subscription-changes/${encodeURIComponent(id)}`);
}

export function listSubscriptionChangesForOrder(orderId: string) {
  return apiFetch<AdminSubscriptionChange[]>(
    `/subscription-changes/orders/${encodeURIComponent(orderId)}`
  );
}

export function getSubscriptionChangeTimeline(id: string) {
  return apiFetch<AdminSubscriptionChangeTimelineItem[]>(
    `/subscription-changes/${encodeURIComponent(id)}/timeline`
  );
}

export function listSubscriptionChangeESignTasks(contractId: string) {
  return apiFetch<AdminContractESignTask[]>(
    `/contracts/${encodeURIComponent(contractId)}/esign-tasks`
  );
}

export function createSubscriptionChangeQuote(id: string, input: FormalQuoteInput) {
  return apiFetch<AdminSubscriptionChangeQuote>(
    `/subscription-changes/${encodeURIComponent(id)}/quotes`,
    { body: JSON.stringify(input), headers: commandHeaders(), method: "POST" }
  );
}

export function approveSubscriptionChangePrice(id: string, version: number, reason: string) {
  return apiFetch<AdminSubscriptionChange>(
    `/subscription-changes/${encodeURIComponent(id)}/price-override/approve`,
    {
      body: JSON.stringify({ reason, version }),
      headers: commandHeaders(),
      method: "POST"
    }
  );
}

export function publishSubscriptionChangeQuote(id: string, version: number) {
  return apiFetch<AdminSubscriptionChange>(
    `/subscription-changes/${encodeURIComponent(id)}/submit-customer-confirmation`,
    {
      body: JSON.stringify({ version }),
      headers: commandHeaders(),
      method: "POST"
    }
  );
}

export function generateSubscriptionChangeContract(id: string) {
  return apiFetch<AdminSubscriptionChangeContract>(
    `/subscription-changes/${encodeURIComponent(id)}/contracts`,
    { method: "POST" }
  );
}

export function startSubscriptionChangeESign(changeId: string, version: number, retry = false) {
  return apiFetch<AdminContractESignTask>(
    `/subscription-changes/${encodeURIComponent(changeId)}/esign/${retry ? "retry" : "start"}`,
    {
      body: JSON.stringify({ version }),
      headers: commandHeaders(),
      method: "POST"
    }
  );
}

export function retrySubscriptionChangeJob(changeId: string, jobId: string, version: number) {
  return apiFetch<AdminSubscriptionChange>(
    `/subscription-changes/${encodeURIComponent(changeId)}/jobs/${encodeURIComponent(jobId)}/retry`,
    {
      body: JSON.stringify({ version }),
      headers: commandHeaders(),
      method: "POST"
    }
  );
}

export function retryRenewalReminder(considerationId: string, slot: string) {
  return apiFetch<AdminRenewalReminder>(
    `/renewal-considerations/${encodeURIComponent(considerationId)}/reminders/${encodeURIComponent(slot)}/retry`,
    { method: "POST" }
  );
}

export function takeOverSubscriptionChange(id: string, version: number, reason: string) {
  return apiFetch<AdminSubscriptionChange>(
    `/subscription-changes/${encodeURIComponent(id)}/manual-takeover`,
    {
      body: JSON.stringify({ reason, version }),
      headers: commandHeaders(),
      method: "POST"
    }
  );
}

export function cancelSubscriptionChange(id: string, version: number, reason: string) {
  return apiFetch<AdminSubscriptionChange>(
    `/subscription-changes/${encodeURIComponent(id)}/cancel`,
    {
      body: JSON.stringify({ reason, version }),
      headers: commandHeaders(),
      method: "POST"
    }
  );
}
