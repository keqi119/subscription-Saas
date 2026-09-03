import { canonicalJson } from "./canonical-json.mjs";
import { sha256Canonical } from "./digest.mjs";
import {
  assertVerifiedRevocationSet,
  verifyTrustedArtifactAttestation
} from "./approval-revocations.mjs";
import { assertCustodyComplete } from "./evidence-custody.mjs";
import { validateContract } from "./schema-registry.mjs";

const verifiedDecisions = new WeakSet();

function approvalError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function epoch(value) {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw approvalError("APPROVAL_TIME_INVALID");
  }
  return parsed;
}

function same(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

export function assertApprovalDecision(value) {
  if (!verifiedDecisions.has(value)) throw approvalError("APPROVAL_DECISION_UNVERIFIED");
  return value;
}

export async function verifyApproval({
  record,
  policy,
  attestation,
  attestationVerifier,
  custodyReceipt,
  verifiedRevocations,
  expected,
  now = new Date()
}) {
  try {
    validateContract("approval-policy.v1", policy);
    validateContract("approval-record.v1", record);
  } catch (error) {
    throw approvalError("APPROVAL_CONTRACT_INVALID", { cause: error?.code });
  }
  const revocations = assertVerifiedRevocationSet(verifiedRevocations);
  const policyDigest = sha256Canonical(policy);
  const bindingMismatch = Object.entries(record.bindings).some(
    ([field, value]) => !same(value, expected?.[field])
  );
  if (bindingMismatch || record.bindings.approvalPolicyDigest !== policyDigest) {
    throw approvalError("APPROVAL_BINDING_MISMATCH");
  }
  if (expected.approvalMode !== undefined && record.approvalMode !== expected.approvalMode) {
    throw approvalError("APPROVAL_MODE_MISMATCH");
  }
  const authority = policy.authorities[record.approvalMode];
  const recordDigest = sha256Canonical(record);
  const verifiedAttestation = await verifyTrustedArtifactAttestation({
    envelope: attestation,
    verifier: attestationVerifier,
    subjectDigest: recordDigest
  });
  if (
    !policy.approvalModes.includes(record.approvalMode) ||
    !authority ||
    record.authority.issuer !== authority.issuer ||
    record.authority.repository !== policy.repository ||
    record.authority.workflowPath !== authority.workflowPath ||
    record.authority.workflowRef !== authority.workflowRef ||
    record.authority.environment !== authority.environment ||
    !authority.allowedSubjects.includes(record.authority.subject) ||
    verifiedAttestation.issuer !== authority.issuer ||
    verifiedAttestation.subject !== record.authority.subject ||
    verifiedAttestation.repository !== policy.repository ||
    verifiedAttestation.workflowPath !== authority.workflowPath ||
    verifiedAttestation.workflowRef !== authority.workflowRef ||
    verifiedAttestation.environment !== authority.environment
  ) {
    throw approvalError("APPROVAL_AUTHORITY_UNTRUSTED");
  }
  try {
    assertCustodyComplete(custodyReceipt, recordDigest);
    if (
      custodyReceipt.owner !== policy.custody.owner ||
      custodyReceipt.expiryDisposition !== policy.custody.expiryDisposition ||
      custodyReceipt.readers.length !== policy.custody.readers.length ||
      custodyReceipt.readers.some((reader, index) => reader !== policy.custody.readers[index])
    ) {
      throw approvalError("APPROVAL_CUSTODY_INVALID");
    }
  } catch (error) {
    if (error?.code === "APPROVAL_CUSTODY_INVALID") throw error;
    throw approvalError("APPROVAL_CUSTODY_INVALID", { cause: error?.code });
  }
  const permitted = policy.permittedOperations.some(
    (operation) =>
      operation.approvalMode === record.approvalMode &&
      operation.commandId === expected.commandId &&
      operation.commandVersion === expected.commandVersion &&
      operation.environmentClass === expected.environmentClass &&
      operation.dataImpact === expected.dataImpact
  );
  if (!permitted) throw approvalError("APPROVAL_OPERATION_NOT_PERMITTED");
  if (revocations.policyDigest !== policyDigest) {
    throw approvalError("APPROVAL_REVOCATIONS_POLICY_MISMATCH");
  }
  const nowEpoch = now instanceof Date ? now.getTime() : Number.NaN;
  const issuedAt = epoch(record.issuedAt);
  const notAfter = epoch(record.notAfter);
  if (
    !Number.isFinite(nowEpoch) ||
    nowEpoch < issuedAt ||
    nowEpoch >= notAfter ||
    notAfter - issuedAt > policy.maximumLifetimeSeconds * 1000
  ) {
    throw approvalError("APPROVAL_EXPIRED");
  }
  if (
    revocations.revokedApprovalIds.includes(record.approvalId) ||
    revocations.revokedRecordDigests.includes(recordDigest)
  ) {
    throw approvalError("APPROVAL_REVOKED");
  }
  const decision = Object.freeze({
    status: "verified",
    approvalRecordDigest: recordDigest,
    authority: record.authority.subject,
    expiresAt: record.notAfter
  });
  verifiedDecisions.add(decision);
  return decision;
}
