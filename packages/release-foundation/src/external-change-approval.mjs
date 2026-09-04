import { verify } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";
import { sha256Canonical } from "./digest.mjs";
import { validateContract } from "./schema-registry.mjs";

function coded(code) {
  return Object.assign(new Error(code), { code });
}
function time(value) {
  const result = Date.parse(value ?? "");
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value)
    throw coded("EXTERNAL_CHANGE_APPROVAL_TIME_INVALID");
  return result;
}
function unsigned(value) {
  const { protected: protectedHeader, ...body } = value;
  const { signature, ...protectedFields } = protectedHeader ?? {};
  return { ...body, protected: protectedFields };
}

export async function verifyExternalChangeApproval({
  approval,
  expected,
  trust,
  revocationClient,
  custodyClient,
  previouslyObservedRevocation,
  now = new Date()
}) {
  try {
    validateContract("external-change-approval.v1", approval);
  } catch {
    throw coded("EXTERNAL_CHANGE_APPROVAL_CONTRACT_INVALID");
  }
  if (
    !trust ||
    approval.protected.issuer !== trust.issuer ||
    approval.protected.keyId !== trust.keyId ||
    approval.revocationPolicyDigest !== trust.revocationPolicyDigest ||
    approval.approver.immutableId === expected?.planAuthorId ||
    approval.approver.immutableId === expected?.workflowActorId
  )
    throw coded("EXTERNAL_CHANGE_APPROVAL_UNTRUSTED");
  const signature = Buffer.from(approval.protected.signature, "base64");
  if (!verify(null, Buffer.from(canonicalJson(unsigned(approval))), trust.publicKey, signature))
    throw coded("EXTERNAL_CHANGE_APPROVAL_SIGNATURE_INVALID");
  for (const key of ["operationId", "target", "planDigest", "expectedPreStateDigest"])
    if (canonicalJson(approval[key]) !== canonicalJson(expected?.[key]))
      throw coded("EXTERNAL_CHANGE_APPROVAL_BINDING_MISMATCH");
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  const issued = time(approval.issuedAt);
  const notAfter = time(approval.notAfter);
  if (!Number.isFinite(nowMs) || nowMs < issued || nowMs >= notAfter)
    throw coded("EXTERNAL_CHANGE_APPROVAL_EXPIRED");
  if (
    typeof revocationClient?.readCurrent !== "function" ||
    typeof custodyClient?.read !== "function"
  )
    throw coded("EXTERNAL_CHANGE_APPROVAL_UNAVAILABLE");
  let revocation;
  try {
    revocation = await revocationClient.readCurrent({
      policyDigest: approval.revocationPolicyDigest
    });
  } catch {
    throw coded("EXTERNAL_CHANGE_APPROVAL_UNAVAILABLE");
  }
  if (
    !revocation ||
    !Number.isInteger(revocation.sequence) ||
    revocation.sequence < 1 ||
    (previouslyObservedRevocation && revocation.sequence < previouslyObservedRevocation.sequence) ||
    revocation.policyDigest !== approval.revocationPolicyDigest ||
    !Array.isArray(revocation.revokedOperationIds) ||
    revocation.revokedOperationIds.includes(approval.operationId)
  )
    throw coded("EXTERNAL_CHANGE_APPROVAL_REVOKED");
  const revocationIssuedAt = time(revocation.issuedAt);
  const revocationNotAfter = time(revocation.notAfter);
  if (nowMs < revocationIssuedAt || nowMs >= revocationNotAfter) {
    throw coded("EXTERNAL_CHANGE_APPROVAL_REVOCATION_EXPIRED");
  }
  const { signature: revocationSignature, ...unsignedRevocation } = revocation;
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(unsignedRevocation)),
      trust.revocationPublicKey,
      Buffer.from(revocationSignature ?? "", "base64")
    )
  )
    throw coded("EXTERNAL_CHANGE_APPROVAL_REVOCATION_INVALID");
  let custody;
  try {
    custody = await custodyClient.read({ reference: approval.custodyReference });
  } catch {
    throw coded("EXTERNAL_CHANGE_APPROVAL_CUSTODY_UNAVAILABLE");
  }
  if (
    !custody ||
    custody.reference !== approval.custodyReference ||
    custody.contentDigest !== sha256Canonical(approval) ||
    custody.immutable !== true
  )
    throw coded("EXTERNAL_CHANGE_APPROVAL_CUSTODY_INVALID");
  return Object.freeze({
    status: "verified",
    approvalDigest: sha256Canonical(approval),
    revocationSequence: revocation.sequence
  });
}
