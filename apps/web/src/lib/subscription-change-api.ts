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

export type SubscriptionChangeType =
  | "EXTENSION"
  | "VEHICLE_SWAP"
  | "EARLY_TERMINATION"
  | "MANAGED_OTHER";

export type SubscriptionChangeAllowedAction =
  | "CREATE_QUOTE"
  | "APPROVE"
  | "PUBLISH_CUSTOMER_CONFIRMATION"
  | "GENERATE_CONTRACT"
  | "START_ESIGN"
  | "EXECUTE"
  | "RETRY"
  | "CANCEL"
  | "MANUAL_TAKEOVER";

export interface SubscriptionChangeCapabilities {
  changeTypes: Record<SubscriptionChangeType, { enabled: boolean; flagName: string }>;
}

export interface AdminExtensionChangeDetail {
  extensionMonths: number;
  pricingMode: SubscriptionChangePricingMode;
  sourceSegment?: AdminSubscriptionContractSegment | null;
  sourceSegmentId: string;
  targetEndDate: string;
  targetStartDate: string;
}

export interface AdminVehicleSwapChangeDetail {
  actualSwapAt?: string | null;
  commercialSnapshot?: unknown;
  commercialSnapshotHash?: string;
  inboundWorkOrderId?: string | null;
  outboundWorkOrderId?: string | null;
  plannedSwapAt: string;
  sourceVehicleId: string;
  targetSubscriptionPlanId: string;
  targetVehicleId: string;
  targetVehiclePackageId: string;
}

export interface AdminEarlyTerminationChangeDetail {
  agreementContractId?: string | null;
  closureCaseId?: string | null;
  effectiveDate: string;
  estimatedSettlementRevision?: number | null;
  reasonSnapshot: unknown;
}

export interface AdminManagedOtherChangeDetail {
  afterSnapshot?: unknown | null;
  approvedOperationSnapshot: unknown;
  beforeSnapshot?: unknown;
  effectiveDate: string;
  evidenceSnapshot?: unknown;
  reason?: string;
  supplementContractId?: string | null;
}

export type AdminSubscriptionChangeDetail =
  | AdminExtensionChangeDetail
  | AdminVehicleSwapChangeDetail
  | AdminEarlyTerminationChangeDetail
  | AdminManagedOtherChangeDetail;

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
  allowedActions?: SubscriptionChangeAllowedAction[];
  automationJobs: AdminSubscriptionAutomationJob[];
  changeNo: string;
  changeType: SubscriptionChangeType;
  completionDeadlineAt: string;
  confirmedQuote?: AdminSubscriptionChangeQuote | null;
  contract: AdminSubscriptionChangeContract | null;
  createdAt: string;
  currentQuote: AdminSubscriptionChangeQuote | null;
  customerConfirmationPublishedAt?: string | null;
  detail?: AdminSubscriptionChangeDetail;
  extensionMonths?: number | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  featureAvailability?: { enabled: boolean; flagName: string };
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
  pricingMode?: SubscriptionChangePricingMode | null;
  quotes: AdminSubscriptionChangeQuote[];
  renewalConsideration: {
    completionDeadlineAt?: string;
    id: string;
    reminders?: AdminRenewalReminder[];
    status: string;
  } | null;
  sourceSegment?: AdminSubscriptionContractSegment | null;
  status: SubscriptionChangeStatus;
  targetEndDate?: string | null;
  targetSegment: AdminSubscriptionContractSegment | null;
  targetStartDate?: string | null;
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

export type CreateSubscriptionChangeInput =
  | {
      changeType: "EXTENSION";
      detail: {
        discountedMonthlyFeeAmount?: string;
        extensionMonths: number;
        priceOverrideReason?: string;
        pricingMode: SubscriptionChangePricingMode;
        requestedVehicleBaseFeeAmount?: string;
        subscriptionPlanId?: string;
      };
      orderId: string;
    }
  | {
      changeType: "VEHICLE_SWAP";
      detail: {
        plannedSwapAt: string;
        targetSubscriptionPlanId: string;
        targetVehicleId: string;
        targetVehiclePackageId?: string;
      };
      orderId: string;
    }
  | {
      changeType: "EARLY_TERMINATION";
      detail: { effectiveDate: string; reason: string };
      orderId: string;
    }
  | {
      changeType: "MANAGED_OTHER";
      detail: {
        beforeSnapshot: Record<string, unknown>;
        effectiveDate: string;
        evidence: Array<Record<string, unknown>>;
        operation: string;
        operationPayload: Record<string, unknown>;
        reason: string;
      };
      orderId: string;
    };

const commandStates = new Map<string, { idempotencyKey: string; inFlight?: Promise<unknown> }>();

function runIdempotentCommand<T>(
  operation: string,
  input: unknown,
  request: (idempotencyKey: string) => Promise<T>
): Promise<T> {
  const identity = `${operation}:${stableCommandJson(input)}`;
  const existing = commandStates.get(identity);
  if (existing?.inFlight) return existing.inFlight as Promise<T>;
  const state = existing ?? { idempotencyKey: crypto.randomUUID() };
  const inFlight = request(state.idempotencyKey)
    .then((result) => {
      commandStates.delete(identity);
      return result;
    })
    .catch((error) => {
      state.inFlight = undefined;
      commandStates.set(identity, state);
      throw error;
    });
  state.inFlight = inFlight;
  commandStates.set(identity, state);
  return inFlight;
}

function commandHeaders(idempotencyKey: string) {
  return { "Idempotency-Key": idempotencyKey };
}

function stableCommandJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableCommandJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableCommandJson(item)}`)
    .join(",")}}`;
}

export function createSubscriptionChange(input: CreateSubscriptionChangeInput) {
  return runIdempotentCommand("CREATE_SUBSCRIPTION_CHANGE", input, (idempotencyKey) =>
    apiFetch<AdminSubscriptionChange>("/subscription-changes", {
      body: JSON.stringify(input),
      headers: commandHeaders(idempotencyKey),
      method: "POST"
    })
  );
}

export function listRenewalConsiderations(
  input: {
    page?: number;
    pageSize?: number;
    smsFailed?: boolean;
    status?: string;
  } = {}
) {
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

export function getSubscriptionChangeCapabilities() {
  return apiFetch<SubscriptionChangeCapabilities>("/subscription-changes/capabilities");
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
  return runIdempotentCommand("CREATE_SUBSCRIPTION_CHANGE_QUOTE", { id, input }, (idempotencyKey) =>
    apiFetch<AdminSubscriptionChangeQuote>(
      `/subscription-changes/${encodeURIComponent(id)}/quotes`,
      { body: JSON.stringify(input), headers: commandHeaders(idempotencyKey), method: "POST" }
    )
  );
}

export function approveSubscriptionChangePrice(id: string, version: number, reason: string) {
  const input = { id, reason, version };
  return runIdempotentCommand("APPROVE_SUBSCRIPTION_CHANGE_PRICE", input, (idempotencyKey) =>
    apiFetch<AdminSubscriptionChange>(
      `/subscription-changes/${encodeURIComponent(id)}/price-override/approve`,
      {
        body: JSON.stringify({ reason, version }),
        headers: commandHeaders(idempotencyKey),
        method: "POST"
      }
    )
  );
}

export function publishSubscriptionChangeQuote(id: string, version: number) {
  return runIdempotentCommand(
    "PUBLISH_SUBSCRIPTION_CHANGE_QUOTE",
    { id, version },
    (idempotencyKey) =>
      apiFetch<AdminSubscriptionChange>(
        `/subscription-changes/${encodeURIComponent(id)}/submit-customer-confirmation`,
        {
          body: JSON.stringify({ version }),
          headers: commandHeaders(idempotencyKey),
          method: "POST"
        }
      )
  );
}

export function generateSubscriptionChangeContract(id: string, version: number) {
  return runIdempotentCommand(
    "GENERATE_SUBSCRIPTION_CHANGE_CONTRACT",
    { id, version },
    (idempotencyKey) =>
      apiFetch<AdminSubscriptionChangeContract>(
        `/subscription-changes/${encodeURIComponent(id)}/contracts`,
        {
          body: JSON.stringify({ version }),
          headers: commandHeaders(idempotencyKey),
          method: "POST"
        }
      )
  );
}

export function startSubscriptionChangeESign(changeId: string, version: number, retry = false) {
  return runIdempotentCommand(
    "START_SUBSCRIPTION_CHANGE_ESIGN",
    { changeId, retry, version },
    (idempotencyKey) =>
      apiFetch<AdminContractESignTask>(
        `/subscription-changes/${encodeURIComponent(changeId)}/esign/${retry ? "retry" : "start"}`,
        {
          body: JSON.stringify({ version }),
          headers: commandHeaders(idempotencyKey),
          method: "POST"
        }
      )
  );
}

export function retrySubscriptionChangeJob(changeId: string, jobId: string, version: number) {
  return runIdempotentCommand(
    "RETRY_SUBSCRIPTION_CHANGE_JOB",
    { changeId, jobId, version },
    (idempotencyKey) =>
      apiFetch<AdminSubscriptionChange>(
        `/subscription-changes/${encodeURIComponent(changeId)}/jobs/${encodeURIComponent(jobId)}/retry`,
        {
          body: JSON.stringify({ version }),
          headers: commandHeaders(idempotencyKey),
          method: "POST"
        }
      )
  );
}

export function retryRenewalReminder(considerationId: string, slot: string) {
  return apiFetch<AdminRenewalReminder>(
    `/renewal-considerations/${encodeURIComponent(considerationId)}/reminders/${encodeURIComponent(slot)}/retry`,
    { method: "POST" }
  );
}

export function takeOverSubscriptionChange(id: string, version: number, reason: string) {
  return runIdempotentCommand(
    "TAKE_OVER_SUBSCRIPTION_CHANGE",
    { id, reason, version },
    (idempotencyKey) =>
      apiFetch<AdminSubscriptionChange>(
        `/subscription-changes/${encodeURIComponent(id)}/manual-takeover`,
        {
          body: JSON.stringify({ reason, version }),
          headers: commandHeaders(idempotencyKey),
          method: "POST"
        }
      )
  );
}

export function cancelSubscriptionChange(id: string, version: number, reason: string) {
  return runIdempotentCommand(
    "CANCEL_SUBSCRIPTION_CHANGE",
    { id, reason, version },
    (idempotencyKey) =>
      apiFetch<AdminSubscriptionChange>(`/subscription-changes/${encodeURIComponent(id)}/cancel`, {
        body: JSON.stringify({ reason, version }),
        headers: commandHeaders(idempotencyKey),
        method: "POST"
      })
  );
}

export function approveManagedOtherChange(
  id: string,
  input: {
    approvalReason: string;
    approvalReference: string;
    version: number;
  }
) {
  return runIdempotentCommand("APPROVE_MANAGED_OTHER_CHANGE", { id, input }, (idempotencyKey) =>
    apiFetch<AdminSubscriptionChange>(
      `/subscription-changes/${encodeURIComponent(id)}/managed-other/approve`,
      { body: JSON.stringify(input), headers: commandHeaders(idempotencyKey), method: "POST" }
    )
  );
}

export function executeManagedOtherChange(
  id: string,
  input: { executionNote: string; version: number }
) {
  return runIdempotentCommand("EXECUTE_MANAGED_OTHER_CHANGE", { id, input }, (idempotencyKey) =>
    apiFetch<AdminSubscriptionChange>(
      `/subscription-changes/${encodeURIComponent(id)}/managed-other/execute`,
      { body: JSON.stringify(input), headers: commandHeaders(idempotencyKey), method: "POST" }
    )
  );
}
