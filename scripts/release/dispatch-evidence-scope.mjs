import { Buffer } from "node:buffer";

import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";

const CODE = "DISPATCH_EVIDENCE_SCOPE_INVALID";
const ACCOUNT = "1457643390906675";
const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const AUTHORIZATION = "rc-dispatch-authorization.v1";
const REVOCATION_STATE = "i0-revocation-state.v1";
const PROOF_TYPES = Object.freeze([AUTHORIZATION, REVOCATION_STATE]);
const fail = (code = CODE) => {
  throw Object.assign(new Error(code), { code });
};

function inspectOriginal(originalBytes) {
  if (
    !Buffer.isBuffer(originalBytes) ||
    originalBytes.length === 0 ||
    originalBytes.length > 1_048_576
  ) {
    fail("DISPATCH_EVIDENCE_ORIGINAL_SIZE_INVALID");
  }
  const text = originalBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(originalBytes))
    fail("DISPATCH_EVIDENCE_ORIGINAL_UTF8_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("DISPATCH_EVIDENCE_ORIGINAL_JSON_INVALID");
  }
  const proofType = parsed?.schemaVersion;
  if (!PROOF_TYPES.includes(proofType)) fail("DISPATCH_EVIDENCE_PROOF_TYPE_INVALID");
  try {
    validateContract(proofType, parsed);
  } catch {
    fail("DISPATCH_EVIDENCE_SCHEMA_INVALID");
  }
  if (canonicalJson(parsed) !== text) fail("DISPATCH_EVIDENCE_NONCANONICAL");
  return { proofType, parsed };
}

export function captureDispatchEvidenceScope(input) {
  assertKernelFrame(input, ["originals"], CODE);
  const captured = snapshotKernelData(input, CODE);
  if (!Array.isArray(captured.originals) || captured.originals.length !== 2) {
    fail("DISPATCH_EVIDENCE_OBJECT_SET_INVALID");
  }
  const byType = new Map();
  for (const original of captured.originals) {
    assertKernelFrame(original, ["originalBytes"], CODE);
    const { proofType, parsed } = inspectOriginal(original.originalBytes);
    if (byType.has(proofType)) fail("DISPATCH_EVIDENCE_OBJECT_SET_INVALID");
    byType.set(proofType, { parsed, originalBytes: original.originalBytes });
  }
  if (PROOF_TYPES.some((type) => !byType.has(type))) fail("DISPATCH_EVIDENCE_OBJECT_SET_INVALID");
  const authorization = byType.get(AUTHORIZATION).parsed;
  const revocationState = byType.get(REVOCATION_STATE).parsed;
  if (authorization.revocationPolicyDigest !== revocationState.policyDigest) {
    fail("DISPATCH_EVIDENCE_POLICY_MISMATCH");
  }

  return snapshotKernelData(
    PROOF_TYPES.map((proofType) => {
      const { parsed, originalBytes } = byType.get(proofType);
      const canonicalDigest = sha256Canonical(parsed);
      return {
        proofType,
        exactKey: `control-evidence/v1/${proofType}/${canonicalDigest}`,
        contentDigest: sha256Bytes(originalBytes),
        contentSizeBytes: originalBytes.length,
        originalBytes
      };
    }),
    CODE
  );
}

function statement(actions, resources, extraCondition = {}) {
  return {
    Effect: "Allow",
    Action: actions,
    Resource: resources,
    Condition: { Bool: { "acs:SecureTransport": "true" }, ...extraCondition }
  };
}

export function buildDispatchEvidenceRamPolicy(input) {
  assertKernelFrame(input, ["profile", "originals"], CODE);
  const captured = snapshotKernelData(input, CODE);
  if (!["writer", "reader"].includes(captured.profile)) fail("DISPATCH_EVIDENCE_PROFILE_INVALID");
  const scope = captureDispatchEvidenceScope({ originals: captured.originals });
  const resources = scope.map(({ exactKey }) => `acs:oss:*:${ACCOUNT}:${BUCKET}/${exactKey}`);
  const policy =
    captured.profile === "writer"
      ? {
          Version: "1",
          Statement: [
            statement(["oss:PutObject"], resources, {
              StringEquals: { "oss:x-oss-object-acl": "private" }
            })
          ]
        }
      : {
          Version: "1",
          Statement: [
            statement(["oss:GetObject", "oss:GetObjectAcl"], resources),
            statement(
              [
                "oss:GetBucketAcl",
                "oss:GetBucketWorm",
                "oss:GetBucketVersioning",
                "oss:GetBucketEncryption",
                "oss:GetBucketPolicyStatus",
                "oss:GetBucketPublicAccessBlock"
              ],
              [`acs:oss:*:${ACCOUNT}:${BUCKET}`]
            )
          ]
        };
  if (Buffer.byteLength(canonicalJson(policy), "utf8") > 2048) {
    fail("DISPATCH_EVIDENCE_POLICY_TOO_LARGE");
  }
  return snapshotKernelData(policy, CODE);
}
