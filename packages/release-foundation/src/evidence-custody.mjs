import { createPublicKey, verify } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";
import { sha256Bytes } from "./digest.mjs";
import { validateContract } from "./schema-registry.mjs";

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

// This read-only verifier deliberately does not use the legacy uploadedAt+180 receipt
// assertion. Only authenticated independent Head/Get/ACL/GetBucketWorm facts decide
// actual retention. Existing receipt producers and their raw v1 format are unchanged.
export function verifyAuthoritativeCustodyObservation(input) {
  try {
    const closed = (value, keys) => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).length !== keys.length ||
        keys.some(
          (key) =>
            !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
            !("value" in Object.getOwnPropertyDescriptor(value, key))
        )
      )
        throw new Error();
    };
    const copy = (value, seen = new WeakSet()) => {
      if (value === null || ["string", "boolean"].includes(typeof value)) return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (!value || typeof value !== "object" || seen.has(value)) throw new Error();
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error();
          return Array.from({ length: value.length }, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
            return copy(descriptor.value, seen);
          });
        }
        if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
        const result = {};
        for (const key of Reflect.ownKeys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
            throw new Error();
          Object.defineProperty(result, key, {
            value: copy(descriptor.value, seen),
            enumerable: true
          });
        }
        return result;
      } finally {
        seen.delete(value);
      }
    };
    closed(input, [
      "originalBytes",
      "receipt",
      "observation",
      "signature",
      "expected",
      "trustPolicy",
      "now"
    ]);
    if (!(input.originalBytes instanceof Uint8Array) || input.originalBytes.byteLength > 1048576)
      throw new Error();
    const originalBytes = Buffer.from(input.originalBytes);
    const { receipt, observation, signature, expected, trustPolicy, now } = copy({
      receipt: input.receipt,
      observation: input.observation,
      signature: input.signature,
      expected: input.expected,
      trustPolicy: input.trustPolicy,
      now: input.now
    });
    const instant = (value) => {
      if (typeof value !== "string") throw new Error();
      const ms = Date.parse(value);
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
        !Number.isFinite(ms) ||
        new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)
      )
        throw new Error();
      return ms;
    };
    const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 2048;
    closed(trustPolicy, [
      "signer",
      "writerIdentity",
      "readerIdentity",
      "storeRef",
      "owner",
      "readers"
    ]);
    closed(trustPolicy.signer, ["issuer", "keyId", "publicKey"]);
    closed(expected, [
      "contentDigest",
      "storeRef",
      "objectKey",
      "objectVersion",
      "terminalAt",
      "snapshotExpiresAt",
      "downstreamRetainUntil",
      "legalHoldUntil"
    ]);
    closed(signature, ["algorithm", "issuer", "keyId", "subjectDigest", "signature"]);
    closed(receipt, receiptKeys);
    if (
      ![
        trustPolicy.writerIdentity,
        trustPolicy.readerIdentity,
        trustPolicy.storeRef,
        trustPolicy.owner,
        ...Object.values(trustPolicy.signer)
      ].every(text) ||
      trustPolicy.writerIdentity === trustPolicy.readerIdentity ||
      !Array.isArray(trustPolicy.readers) ||
      !trustPolicy.readers.length ||
      !trustPolicy.readers.every(text) ||
      new Set(trustPolicy.readers).size !== trustPolicy.readers.length ||
      ![expected.storeRef, expected.objectKey, expected.objectVersion].every(text) ||
      !digestPattern.test(expected.contentDigest) ||
      !(originalBytes instanceof Uint8Array) ||
      originalBytes.byteLength > 1048576
    )
      throw new Error();
    validateContract("authoritative-custody-observation.v1", observation);
    validateContract("custody-receipt.v1", receipt);
    const digest = sha256Bytes(originalBytes);
    const observationBytes = Buffer.from(canonicalJson(observation));
    const key = createPublicKey(trustPolicy.signer.publicKey);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      signature.algorithm !== "Ed25519" ||
      signature.issuer !== trustPolicy.signer.issuer ||
      signature.keyId !== trustPolicy.signer.keyId ||
      observation.issuer !== signature.issuer ||
      observation.keyId !== signature.keyId ||
      signature.subjectDigest !== sha256Bytes(observationBytes) ||
      typeof signature.signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature.signature) ||
      Buffer.from(signature.signature, "base64").toString("base64") !== signature.signature ||
      !verify(
        null,
        Buffer.from(canonicalJson({ domain: "authoritative-custody-observation.v1", observation })),
        key,
        Buffer.from(signature.signature, "base64")
      )
    )
      throw new Error();
    for (const [field, value] of Object.entries(expected)) {
      if (observation[field] !== value) throw new Error();
    }
    if (
      digest !== expected.contentDigest ||
      receipt.contentDigest !== digest ||
      receipt.readbackDigest !== digest ||
      observation.headDigest !== digest ||
      observation.getDigest !== digest ||
      observation.receiptDigest !== sha256Bytes(Buffer.from(canonicalJson(receipt))) ||
      observation.contentSizeBytes !== originalBytes.byteLength ||
      receipt.contentSizeBytes !== originalBytes.byteLength ||
      observation.storeRef !== trustPolicy.storeRef ||
      receipt.storeRef !== trustPolicy.storeRef ||
      observation.writerIdentity !== trustPolicy.writerIdentity ||
      observation.readerIdentity !== trustPolicy.readerIdentity ||
      receipt.owner !== trustPolicy.owner ||
      canonicalJson(receipt.readers) !== canonicalJson(trustPolicy.readers)
    )
      throw new Error();
    const at = instant(now);
    const terminal = instant(observation.terminalAt);
    const modified = instant(observation.lastModified);
    const readback = instant(observation.readbackAt);
    const uploaded = instant(receipt.uploadedAt);
    const receiptReadback = instant(receipt.readbackAt);
    const required = Math.max(
      terminal + 180 * 86400000,
      observation.snapshotExpiresAt === null
        ? 0
        : instant(observation.snapshotExpiresAt) + 180 * 86400000,
      instant(observation.downstreamRetainUntil),
      observation.legalHoldUntil === null ? 0 : instant(observation.legalHoldUntil)
    );
    const retain = instant(observation.worm.retainUntil);
    if (
      terminal > at ||
      modified > readback ||
      terminal > readback ||
      readback > at ||
      uploaded !== modified ||
      receiptReadback < modified ||
      receiptReadback > readback ||
      retain < required ||
      modified + observation.worm.retentionDays * 86400000 < required ||
      instant(receipt.retainUntil) < required
    )
      throw new Error();
    return Object.freeze({
      contentDigest: digest,
      objectVersion: observation.objectVersion,
      observationDigest: signature.subjectDigest,
      requiredRetainUntil: new Date(required).toISOString(),
      retainUntil: new Date(
        Math.min(retain, modified + observation.worm.retentionDays * 86400000)
      ).toISOString()
    });
  } catch {
    throw custodyError("AUTHORITATIVE_CUSTODY_INVALID");
  }
}
