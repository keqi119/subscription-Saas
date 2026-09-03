import { canonicalJson } from "./canonical-json.mjs";
import { sha256Bytes } from "./digest.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const forbiddenKeyPattern =
  /^(?:password|passwd|secret|clientsecret|credential|apikey|token|accesstoken|refreshtoken|authorization|databaseurl|connectionstring|phone|mobile|customerid|idcard)$/i;
const receiptKeys = Object.freeze([
  "attestationRef",
  "contentDigest",
  "contentSizeBytes",
  "expiryDisposition",
  "owner",
  "readbackAt",
  "readbackDigest",
  "readers",
  "receiptId",
  "retainUntil",
  "schemaVersion",
  "storeRef",
  "uploadedAt"
]);
const forbiddenValuePatterns = [
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/i,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b1[3-9][0-9]{9}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b(?:sk|gh[oprsu])[-_][A-Za-z0-9_-]{16,}\b/
];

function custodyError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function assertPolicy(policy) {
  if (
    typeof policy?.owner !== "string" ||
    policy.owner.length === 0 ||
    !Array.isArray(policy.readers) ||
    policy.readers.length === 0 ||
    policy.readers.some((reader) => typeof reader !== "string" || reader.length === 0) ||
    new Set(policy.readers).size !== policy.readers.length ||
    policy.retentionDays !== 180 ||
    !["delete", "review", "retain-approved"].includes(policy.expiryDisposition) ||
    forbiddenValuePatterns.some(
      (pattern) =>
        pattern.test(policy.owner) || policy.readers.some((reader) => pattern.test(reader))
    )
  ) {
    throw custodyError("EVIDENCE_CUSTODY_POLICY_INVALID");
  }
}

function assertNoSensitiveValue(value, path = "$") {
  if (typeof value === "string") {
    if (forbiddenValuePatterns.some((pattern) => pattern.test(value))) {
      throw custodyError("EVIDENCE_SECRET_DETECTED", { path });
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveValue(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenKeyPattern.test(key.replaceAll(/[_-]/g, ""))) {
      throw custodyError("EVIDENCE_SECRET_DETECTED", { path: `${path}.${key}` });
    }
    assertNoSensitiveValue(entry, `${path}.${key}`);
  }
}

function asBytes(value, missingCode) {
  if (value === undefined || value === null) throw custodyError(missingCode);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw custodyError(missingCode);
}

function assertStorageResult(result, { expectedSize, expectedRetainUntil }) {
  if (result?.created !== true) throw custodyError("EVIDENCE_OVERWRITE_REFUSED");
  if (
    typeof result.storeRef !== "string" ||
    result.storeRef.length === 0 ||
    result.contentSizeBytes !== expectedSize ||
    !Number.isFinite(Date.parse(result.storedAt)) ||
    result.retainUntil !== expectedRetainUntil
  ) {
    throw custodyError("EVIDENCE_STORAGE_RECEIPT_INVALID");
  }
  if (forbiddenValuePatterns.some((pattern) => pattern.test(result.storeRef))) {
    throw custodyError("EVIDENCE_SECRET_DETECTED", { path: "$.storeRef" });
  }
  return result;
}

function addUtcDays(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function redactEvidence(value, policy) {
  assertPolicy(policy);
  assertNoSensitiveValue(value);
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    if (error?.code === "EVIDENCE_SECRET_DETECTED") throw error;
    throw custodyError("EVIDENCE_VALUE_INVALID");
  }
}

export async function custodyEvidence({
  value,
  policy,
  storage,
  now = () => new Date(),
  createReceiptId,
  attestationRef
}) {
  assertPolicy(policy);
  if (
    typeof storage?.createOnly !== "function" ||
    typeof storage?.read !== "function" ||
    storage.trustPolicy !== "immutable-content-addressed/v1" ||
    typeof storage.writerIdentity !== "string" ||
    storage.writerIdentity.length === 0 ||
    storage.auditReaderIdentity !== "audit-reader" ||
    typeof createReceiptId !== "function" ||
    typeof attestationRef !== "string" ||
    attestationRef.length === 0
  ) {
    throw custodyError("EVIDENCE_CUSTODY_INPUT_INVALID");
  }
  if (
    forbiddenValuePatterns.some(
      (pattern) => pattern.test(storage.writerIdentity) || pattern.test(attestationRef)
    )
  ) {
    throw custodyError("EVIDENCE_SECRET_DETECTED", { path: "$.custody-metadata" });
  }
  const accepted = redactEvidence(value, policy);
  const contentBytes = Buffer.from(canonicalJson(accepted), "utf8");
  const contentDigest = sha256Bytes(contentBytes);
  const contentKey = `evidence/${contentDigest.slice("sha256:".length)}.json`;
  const uploadStartedAt = now();
  if (!(uploadStartedAt instanceof Date) || Number.isNaN(uploadStartedAt.getTime())) {
    throw custodyError("EVIDENCE_CUSTODY_CLOCK_INVALID");
  }
  const retainUntil = addUtcDays(uploadStartedAt, policy.retentionDays).toISOString();
  const contentUpload = assertStorageResult(
    await storage.createOnly({
      key: contentKey,
      bytes: contentBytes,
      contentDigest,
      requestedAt: uploadStartedAt.toISOString(),
      retainUntil
    }),
    { expectedSize: contentBytes.byteLength, expectedRetainUntil: retainUntil }
  );
  const contentReadback = asBytes(
    await storage.read({ key: contentKey, identity: storage.auditReaderIdentity }),
    "EVIDENCE_READBACK_MISSING"
  );
  if (sha256Bytes(contentReadback) !== contentDigest) {
    throw custodyError("EVIDENCE_READBACK_DIGEST_MISMATCH");
  }
  const readbackAtDate = now();
  if (!(readbackAtDate instanceof Date) || Number.isNaN(readbackAtDate.getTime())) {
    throw custodyError("EVIDENCE_CUSTODY_CLOCK_INVALID");
  }

  const receiptId = createReceiptId();
  if (!uuidPattern.test(receiptId ?? "")) throw custodyError("CUSTODY_RECEIPT_ID_INVALID");
  const receipt = {
    schemaVersion: "custody-receipt.v1",
    receiptId,
    contentDigest,
    contentSizeBytes: contentBytes.byteLength,
    storeRef: contentUpload.storeRef,
    uploadedAt: contentUpload.storedAt,
    readbackAt: readbackAtDate.toISOString(),
    readbackDigest: contentDigest,
    owner: policy.owner,
    readers: [...policy.readers],
    retainUntil: contentUpload.retainUntil,
    expiryDisposition: policy.expiryDisposition,
    attestationRef
  };
  const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
  const receiptDigest = sha256Bytes(receiptBytes);
  const receiptKey = `receipts/${receiptId}.json`;
  assertStorageResult(
    await storage.createOnly({
      key: receiptKey,
      bytes: receiptBytes,
      contentDigest: receiptDigest,
      requestedAt: uploadStartedAt.toISOString(),
      retainUntil
    }),
    { expectedSize: receiptBytes.byteLength, expectedRetainUntil: retainUntil }
  );
  const receiptReadback = asBytes(
    await storage.read({ key: receiptKey, identity: storage.auditReaderIdentity }),
    "CUSTODY_RECEIPT_MISSING"
  );
  if (sha256Bytes(receiptReadback) !== receiptDigest) {
    throw custodyError("CUSTODY_RECEIPT_READBACK_DIGEST_MISMATCH");
  }
  let storedReceipt;
  try {
    storedReceipt = JSON.parse(receiptReadback.toString("utf8"));
  } catch {
    throw custodyError("CUSTODY_RECEIPT_READBACK_INVALID");
  }
  assertCustodyComplete(storedReceipt, contentDigest);
  return Object.freeze(storedReceipt);
}

export function assertCustodyComplete(receipt, expectedDigest) {
  const uploadedAt = Date.parse(receipt?.uploadedAt);
  const readbackAt = Date.parse(receipt?.readbackAt);
  const retainUntil = Date.parse(receipt?.retainUntil);
  const expectedRetainUntil = Number.isFinite(uploadedAt)
    ? addUtcDays(new Date(uploadedAt), 180).toISOString()
    : undefined;
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(receiptKeys) ||
    receipt?.schemaVersion !== "custody-receipt.v1" ||
    !uuidPattern.test(receipt.receiptId ?? "") ||
    !digestPattern.test(expectedDigest ?? "") ||
    receipt.contentDigest !== expectedDigest ||
    receipt.readbackDigest !== expectedDigest ||
    !Number.isInteger(receipt.contentSizeBytes) ||
    receipt.contentSizeBytes < 0 ||
    typeof receipt.storeRef !== "string" ||
    receipt.storeRef.length === 0 ||
    forbiddenValuePatterns.some((pattern) => pattern.test(receipt.storeRef)) ||
    !Number.isFinite(uploadedAt) ||
    new Date(uploadedAt).toISOString() !== receipt.uploadedAt ||
    !Number.isFinite(readbackAt) ||
    new Date(readbackAt).toISOString() !== receipt.readbackAt ||
    readbackAt < uploadedAt ||
    typeof receipt.owner !== "string" ||
    receipt.owner.length === 0 ||
    !Array.isArray(receipt.readers) ||
    receipt.readers.length === 0 ||
    receipt.readers.some((reader) => typeof reader !== "string" || reader.length === 0) ||
    new Set(receipt.readers).size !== receipt.readers.length ||
    !Number.isFinite(retainUntil) ||
    new Date(retainUntil).toISOString() !== receipt.retainUntil ||
    receipt.retainUntil !== expectedRetainUntil ||
    !["delete", "review", "retain-approved"].includes(receipt.expiryDisposition) ||
    typeof receipt.attestationRef !== "string" ||
    receipt.attestationRef.length === 0 ||
    forbiddenValuePatterns.some(
      (pattern) =>
        pattern.test(receipt.attestationRef) ||
        pattern.test(receipt.owner) ||
        receipt.readers.some((reader) => pattern.test(reader))
    )
  ) {
    throw custodyError("CUSTODY_RECEIPT_INCOMPLETE");
  }
  return receipt;
}

export function assertCustodyDeletionAllowed(receipt, at = new Date()) {
  assertCustodyComplete(receipt, receipt?.contentDigest);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw custodyError("EVIDENCE_CUSTODY_CLOCK_INVALID");
  }
  if (at.getTime() < Date.parse(receipt.retainUntil)) {
    throw custodyError("EVIDENCE_RETENTION_ACTIVE");
  }
  if (receipt.expiryDisposition !== "delete") {
    throw custodyError("EVIDENCE_DELETION_APPROVAL_REQUIRED");
  }
  return receipt;
}
