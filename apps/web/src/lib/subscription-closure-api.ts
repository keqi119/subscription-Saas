import { ApiError, apiFetch } from "./api";
import { portalApiFetch } from "./portal-api";
import {
  buildAdminSubscriptionClosureView,
  buildCustomerSubscriptionClosureView
} from "./subscription-closure-view-model";

export async function loadAdminSubscriptionClosureByOrder(
  orderId: string,
  permissions: ReadonlySet<string>
) {
  try {
    const value = await apiFetch<unknown>(
      `/subscription-closures/by-order/${encodeURIComponent(orderId)}`
    );
    return buildAdminSubscriptionClosureView(value, permissions);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function loadPortalSubscriptionClosureByOrder(orderId: string) {
  const value = await portalApiFetch<unknown>(
    `/portal/orders/${encodeURIComponent(orderId)}/subscription-closure`
  );
  return value === null ? null : buildCustomerSubscriptionClosureView(value);
}

export function captureSubscriptionReturnChecklist(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/return-checklists`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function cancelSubscriptionReturnManifestSigning(
  closureCaseId: string,
  input: { idempotencyKey: string; reason: string }
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/return-manifest-signing/cancel`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function uploadSubscriptionReturnEvidence(
  closureCaseId: string,
  input: {
    capturedAt: string;
    evidenceType: "PHOTO" | "VIDEO" | "DOCUMENT";
    file: File;
    idempotencyKey: string;
    supersedesEvidenceId?: string;
    targetId: string;
    targetType: "CHECKLIST_ITEM" | "DAMAGE" | "CASE_ATTESTATION";
    visibility: "CUSTOMER_VISIBLE" | "INTERNAL_ONLY";
  },
  signal?: AbortSignal
) {
  const body = new FormData();
  body.append("capturedAt", input.capturedAt);
  body.append("evidenceType", input.evidenceType);
  body.append("idempotencyKey", input.idempotencyKey);
  body.append("targetId", input.targetId);
  body.append("targetType", input.targetType);
  body.append("visibility", input.visibility);
  if (input.supersedesEvidenceId) body.append("supersedesEvidenceId", input.supersedesEvidenceId);
  body.append("file", input.file, input.file.name);
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/return-evidence/upload`,
    { body, method: "POST", signal, timeoutMs: 60_000 }
  );
}

export function uploadSubscriptionClosureFinancialProof(
  closureCaseId: string,
  file: File
) {
  const body = new FormData();
  body.append("file", file, file.name);
  return apiFetch<{ fileId: string }>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/financial-proofs/upload`,
    { body, method: "POST", timeoutMs: 60_000 }
  );
}

export function generateSubscriptionReturnDelta(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/return-deltas`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function confirmSubscriptionReturnDelta(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/return-deltas/confirm`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function confirmSubscriptionClosurePhysicalReceipt(
  orderId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/orders/${encodeURIComponent(orderId)}/physical-receipt`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function confirmSubscriptionClosureInspection(
  closureCaseId: string,
  reconditioningRequired: boolean
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/inspection`,
    {
      body: JSON.stringify({
        accepted: true,
        costs: [],
        evidence: [],
        occurredAt: new Date().toISOString(),
        reconditioningRequired
      }),
      method: "POST"
    }
  );
}

export function createSubscriptionClosurePricing(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>[]>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/pricing`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function requestSubscriptionClosureApproval(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/approval-requests`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function decideSubscriptionClosureApproval(
  closureCaseId: string,
  approvalId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function advanceSubscriptionClosureSettlement(
  closureCaseId: string,
  action: "propose" | "finalize" | "settle"
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/settlements/${action}`,
    {
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        occurredAt: new Date().toISOString()
      }),
      method: "POST"
    }
  );
}

export function recordSubscriptionClosureDisposition(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/receivable-dispositions`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function recordSubscriptionClosureNoResponse(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/customer-no-response`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function decideSubscriptionClosureDispute(
  closureCaseId: string,
  disputeId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/disputes/${encodeURIComponent(disputeId)}/decision`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function transferSubscriptionClosureLegalCollection(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/legal-collection`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function recordSubscriptionClosureLegalEvent(
  closureCaseId: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/legal-collection/events`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function releaseSubscriptionClosureInventory(closureCaseId: string) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/inventory-release`,
    {
      body: JSON.stringify({
        occurredAt: new Date().toISOString(),
        releaseReason: "退车检查已完成，解除闭环库存限制并按车况进入可用库存。"
      }),
      method: "POST"
    }
  );
}

export function completeSubscriptionClosureOperations(closureCaseId: string) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/operational-completion`,
    {
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        occurredAt: new Date().toISOString()
      }),
      method: "POST"
    }
  );
}

export function exportSubscriptionClosureEvidencePackage(closureCaseId: string) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-closures/${encodeURIComponent(closureCaseId)}/evidence-packages`,
    { method: "POST" }
  );
}

export function respondToPortalSubscriptionClosure(
  orderId: string,
  input: Record<string, unknown>
) {
  return portalApiFetch<Record<string, unknown>>(
    `/portal/orders/${encodeURIComponent(orderId)}/subscription-closure/responses`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function uploadPortalSubscriptionClosureDisputeEvidence(
  orderId: string,
  input: { capturedAt: string; chargeLineId: string; file: File; idempotencyKey: string }
) {
  const body = new FormData();
  body.append("capturedAt", input.capturedAt);
  body.append("chargeLineId", input.chargeLineId);
  body.append("idempotencyKey", input.idempotencyKey);
  body.append("file", input.file, input.file.name);
  return portalApiFetch<{ evidenceId: string; linkId: string }>(
    `/portal/orders/${encodeURIComponent(orderId)}/subscription-closure/dispute-evidence`,
    { body, method: "POST" }
  );
}

export function mockSignPortalReturnManifest(orderId: string, taskId: string) {
  return portalApiFetch(
    `/portal/orders/${encodeURIComponent(orderId)}/subscription-closure/return-manifest-signing/${encodeURIComponent(taskId)}/mock-sign`,
    { method: "POST" }
  );
}
