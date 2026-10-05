import { Buffer } from "node:buffer";

import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { validateEvidenceArchiveAuthorization } from "../../packages/release-foundation/src/snapshot/custody-contracts.mjs";

const CODE = "EVIDENCE_ARCHIVE_RAM_POLICY_INVALID";
const ACCOUNT = "1457643390906675";
const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const WRITER = `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-archive-writer`;
const READER = `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-archive-reader`;
const fail = (code = CODE) => {
  throw Object.assign(new Error(code), { code });
};

function assertRawOriginal(object, rawBytes) {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length === 0 || rawBytes.length > 1_048_576) {
    fail("EVIDENCE_ARCHIVE_ORIGINAL_SIZE_INVALID");
  }
  if (
    sha256Bytes(rawBytes) !== object.contentDigest ||
    rawBytes.length !== object.contentSizeBytes
  ) {
    fail("EVIDENCE_ARCHIVE_ORIGINAL_CONTENT_MISMATCH");
  }
  const text = rawBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(rawBytes)) fail("EVIDENCE_ARCHIVE_ORIGINAL_UTF8_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("EVIDENCE_ARCHIVE_ORIGINAL_JSON_INVALID");
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== object.proofType ||
    sha256Canonical(parsed) !== object.canonicalDigest
  ) {
    fail("EVIDENCE_ARCHIVE_ORIGINAL_CANONICAL_MISMATCH");
  }
}

function objectResource(key) {
  return `acs:oss:*:${ACCOUNT}:${BUCKET}/${key}`;
}

function secureStatement(action, resources, extraCondition = {}) {
  return {
    Effect: "Allow",
    Action: action,
    Resource: resources,
    Condition: {
      Bool: { "acs:SecureTransport": "true" },
      ...extraCondition
    }
  };
}

// This only compiles policy scope. It does not establish conditional create,
// custody, approval, live resource state, or authorization validity over time.
// The fixed OSS transport must enforce forbid-overwrite and Locked WORM separately.
export function buildEvidenceArchiveRamPolicy(input) {
  assertKernelFrame(input, ["authorization", "originals"], CODE);
  const captured = snapshotKernelData(input, CODE);
  const { authorization, originals } = captured;
  validateEvidenceArchiveAuthorization(authorization);
  if (
    authorization.resource.region !== "oss-cn-shanghai" ||
    authorization.resource.bucket !== BUCKET ||
    authorization.identities.writer !== WRITER ||
    authorization.identities.reader !== READER ||
    !Array.isArray(originals) ||
    originals.length !== authorization.objects.length
  ) {
    fail("EVIDENCE_ARCHIVE_RAM_POLICY_SCOPE_INVALID");
  }

  const originalsByKey = new Map();
  for (const original of originals) {
    assertKernelFrame(original, ["exactKey", "originalBytes"], CODE);
    if (originalsByKey.has(original.exactKey)) fail("EVIDENCE_ARCHIVE_ORIGINAL_DUPLICATE");
    originalsByKey.set(original.exactKey, original.originalBytes);
  }
  for (const object of authorization.objects) {
    if (!originalsByKey.has(object.exactKey)) fail("EVIDENCE_ARCHIVE_ORIGINAL_SET_MISMATCH");
    assertRawOriginal(object, originalsByKey.get(object.exactKey));
  }
  if (originalsByKey.size !== authorization.objects.length) {
    fail("EVIDENCE_ARCHIVE_ORIGINAL_SET_MISMATCH");
  }

  const resources = authorization.objects.map(({ exactKey }) => objectResource(exactKey));
  const policy =
    authorization.profile === "archive-create-only-writer"
      ? {
          Version: "1",
          Statement: [
            secureStatement(["oss:PutObject"], resources, {
              StringEquals: { "oss:x-oss-object-acl": "private" }
            })
          ]
        }
      : {
          Version: "1",
          Statement: [
            secureStatement(["oss:GetObject"], resources),
            secureStatement(
              ["oss:GetBucketAcl", "oss:GetBucketWorm"],
              [`acs:oss:*:${ACCOUNT}:${BUCKET}`]
            )
          ]
        };
  if (Buffer.byteLength(canonicalJson(policy), "utf8") > 2048) {
    fail("EVIDENCE_ARCHIVE_RAM_POLICY_TOO_LARGE");
  }
  return policy;
}
