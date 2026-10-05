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

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function proofTypeOf(parsed) {
  const proof = parsed?.proof;
  const receipt = parsed?.receipt;
  const looksLikeKnownWrapper =
    (proof?.schemaVersion === "producer-crypto-use-proof.v2" ||
      proof?.schemaVersion === "publisher-sts-use-proof.v1" ||
      receipt?.schemaVersion === "snapshot-destruction-receipt.v1") &&
    Object.hasOwn(parsed, "signature");
  if (!looksLikeKnownWrapper && parsed?.schemaVersion) return parsed.schemaVersion;
  const snapshotProof =
    exactKeys(parsed, ["proof", "dataResultDigest", "signature"]) &&
    proof?.schemaVersion === "producer-crypto-use-proof.v2";
  const publisherProof =
    exactKeys(parsed, ["proof", "signature"]) &&
    proof?.schemaVersion === "publisher-sts-use-proof.v1";
  const destructionProof =
    exactKeys(parsed, [
      "receipt",
      "dataResultDigest",
      "cryptoUseProofDigest",
      "publicationDigest",
      "publisherTerminalDigest",
      "signature"
    ]) && receipt?.schemaVersion === "snapshot-destruction-receipt.v1";
  if (!snapshotProof && !publisherProof && !destructionProof) return null;
  const digest = /^sha256:[0-9a-f]{64}$/u;
  const names = publisherProof
    ? []
    : snapshotProof
      ? ["dataResultDigest"]
      : [
          "dataResultDigest",
          "cryptoUseProofDigest",
          "publicationDigest",
          "publisherTerminalDigest"
        ];
  if (!names.every((name) => digest.test(parsed[name]))) return null;
  const signed = parsed.signature;
  const subject = { ...parsed };
  delete subject.signature;
  if (
    !exactKeys(signed, ["algorithm", "issuer", "keyId", "subjectDigest", "signature"]) ||
    signed.algorithm !== "Ed25519" ||
    typeof signed.issuer !== "string" ||
    signed.issuer.length < 1 ||
    signed.issuer.length > 2048 ||
    !digest.test(signed.keyId) ||
    signed.subjectDigest !== sha256Canonical(subject) ||
    typeof signed.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(signed.signature) ||
    Buffer.from(signed.signature, "base64").length !== 64
  )
    return null;
  return snapshotProof || publisherProof ? proof.schemaVersion : receipt.schemaVersion;
}

export function assertEvidenceArchiveOriginal(object, rawBytes) {
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
    proofTypeOf(parsed) !== object.proofType ||
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
    assertEvidenceArchiveOriginal(object, originalsByKey.get(object.exactKey));
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
            secureStatement(["oss:GetObjectAcl"], resources),
            secureStatement(
              ["oss:GetBucketAcl", "oss:GetBucketWorm", "oss:GetBucketVersioning"],
              [`acs:oss:*:${ACCOUNT}:${BUCKET}`]
            )
          ]
        };
  if (Buffer.byteLength(canonicalJson(policy), "utf8") > 2048) {
    fail("EVIDENCE_ARCHIVE_RAM_POLICY_TOO_LARGE");
  }
  return policy;
}
