import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isReadable, Transform, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

import { canonicalJson } from "../canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../digest.mjs";
import { validateSnapshotEncryptionEnvelope } from "./producer-crypto-contracts.mjs";

const KEY_ALIAS = "alias/stage1-snapshot-custody";
const KEY_SPEC = "AES_256";
const KMS_REGION = "cn-shanghai";
const WRAPPED_KEY_KIND = "kms-symmetric-data-key.v1";
const DAY_MS = 86_400_000;
const policy = JSON.parse(
  readFileSync(
    new URL(
      "../../../../release/contracts/policies/snapshot-object-addressing.v2.json",
      import.meta.url
    ),
    "utf8"
  )
);
const MAX_CIPHERTEXT_BYTES = policy.outputs.find(
  ({ filename }) => filename === "snapshot.enc"
).maxSizeBytes;
const MAX_ENVELOPE_BYTES = policy.outputs.find(
  ({ filename }) => filename === "encryption-envelope.json"
).maxSizeBytes;
const AAD_KEYS = Object.freeze([
  "expiresAt",
  "releaseAttemptId",
  "repositoryId",
  "sanitizationContractDigest",
  "snapshotAllocatedAt",
  "snapshotDigest",
  "snapshotRunId",
  "sourceSha"
]);
const WRAPPED_KEYS = Object.freeze([
  "aliasReadbackKeyId",
  "ciphertext",
  "keyAlias",
  "keyId",
  "kind",
  "region"
]);
const safeErrors = new WeakSet();

function snapshotError(code, details) {
  const error = Object.assign(new Error(code), { code });
  if (details !== undefined) error.details = Object.freeze({ ...details });
  safeErrors.add(error);
  return error;
}

function sameKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson(expected)
  );
}

function immutableJson(value) {
  const clone = JSON.parse(canonicalJson(value));
  const freeze = (entry) => {
    if (entry && typeof entry === "object" && !Object.isFrozen(entry)) {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(clone);
}

function assertSignal(signal) {
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw snapshotError("SNAPSHOT_ABORT_SIGNAL_INVALID");
  }
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw snapshotError("SNAPSHOT_ABORTED");
}

function captureLimits(limits) {
  if (limits === undefined) {
    return Object.freeze({
      maxCiphertextBytes: MAX_CIPHERTEXT_BYTES,
      maxEnvelopeBytes: MAX_ENVELOPE_BYTES
    });
  }
  if (
    limits === null ||
    typeof limits !== "object" ||
    Array.isArray(limits) ||
    Object.getPrototypeOf(limits) !== Object.prototype ||
    Object.keys(limits).some((key) => !["maxCiphertextBytes", "maxEnvelopeBytes"].includes(key))
  ) {
    throw snapshotError("SNAPSHOT_LIMITS_INVALID");
  }
  const maxCiphertextBytes = limits.maxCiphertextBytes ?? MAX_CIPHERTEXT_BYTES;
  const maxEnvelopeBytes = limits.maxEnvelopeBytes ?? MAX_ENVELOPE_BYTES;
  if (
    !Number.isSafeInteger(maxCiphertextBytes) ||
    maxCiphertextBytes < 1 ||
    maxCiphertextBytes > MAX_CIPHERTEXT_BYTES ||
    !Number.isSafeInteger(maxEnvelopeBytes) ||
    maxEnvelopeBytes < 1 ||
    maxEnvelopeBytes > MAX_ENVELOPE_BYTES
  ) {
    throw snapshotError("SNAPSHOT_LIMITS_INVALID");
  }
  return Object.freeze({ maxCiphertextBytes, maxEnvelopeBytes });
}

function captureAad(aad, { required = false } = {}) {
  if (aad === undefined && required) throw snapshotError("SNAPSHOT_AAD_REQUIRED");
  if (!sameKeys(aad, AAD_KEYS) || Object.values(aad).some((value) => typeof value !== "string")) {
    throw snapshotError("SNAPSHOT_AAD_INVALID");
  }
  const allocatedAt = Date.parse(aad.snapshotAllocatedAt);
  const expiresAt = Date.parse(aad.expiresAt);
  if (
    aad.repositoryId !== "1253231368" ||
    !/^[0-9a-f]{40}$/.test(aad.sourceSha) ||
    !/^[A-Za-z0-9._:@/-]{1,256}$/.test(aad.releaseAttemptId) ||
    !/^[1-9][0-9]*$/.test(aad.snapshotRunId) ||
    !/^sha256:[0-9a-f]{64}$/.test(aad.sanitizationContractDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(aad.snapshotDigest) ||
    !Number.isFinite(allocatedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - allocatedAt !== 30 * DAY_MS
  ) {
    throw snapshotError("SNAPSHOT_AAD_INVALID");
  }
  return immutableJson(aad);
}

function kmsContext(aad) {
  return Object.freeze({
    repositoryId: aad.repositoryId,
    sourceSha: aad.sourceSha,
    releaseAttemptId: aad.releaseAttemptId,
    snapshotRunId: aad.snapshotRunId,
    sanitizationContractDigest: aad.sanitizationContractDigest,
    expiresAt: aad.expiresAt
  });
}

function authenticatedData(aad) {
  const context = kmsContext(aad);
  const kmsContextDigest = sha256Canonical(context);
  const value = Object.freeze({
    ...context,
    snapshotDigest: aad.snapshotDigest,
    kmsContextDigest
  });
  return Object.freeze({
    context,
    kmsContextDigest,
    value,
    bytes: Buffer.from(canonicalJson(value), "utf8"),
    digest: sha256Canonical(value)
  });
}

function captureSource(source) {
  if (!sameKeys(source, ["open"]) || typeof source.open !== "function") {
    throw snapshotError("SNAPSHOT_SOURCE_REPLAY_REQUIRED");
  }
  return source.open.bind(source);
}

function captureDestination(destination) {
  if (typeof destination !== "string" || destination.length === 0 || destination.includes("\0")) {
    throw snapshotError("SNAPSHOT_DESTINATION_INVALID");
  }
  return resolve(destination);
}

function captureKms(kms, method) {
  if (kms === null || typeof kms !== "object" || typeof kms[method] !== "function") {
    throw snapshotError("SNAPSHOT_KMS_INTERFACE_INVALID");
  }
  return kms[method].bind(kms);
}

async function ensureDestinationAbsent(destination) {
  try {
    await lstat(destination);
    throw snapshotError("SNAPSHOT_DESTINATION_EXISTS");
  } catch (error) {
    if (safeErrors.has(error)) throw error;
    if (error?.code !== "ENOENT") throw snapshotError("SNAPSHOT_DESTINATION_CHECK_FAILED");
  }
}

async function openOwnedSource(openSource, signal) {
  let stream;
  try {
    stream = await openSource();
  } catch {
    throw snapshotError("SNAPSHOT_SOURCE_OPEN_FAILED");
  }
  if (!isReadable(stream)) {
    if (typeof stream?.destroy === "function") stream.destroy();
    throw snapshotError("SNAPSHOT_SOURCE_STREAM_INVALID");
  }
  if (signal?.aborted) {
    stream.destroy();
    await finished(stream).catch(() => {});
    throw snapshotError("SNAPSHOT_ABORTED");
  }
  return stream;
}

async function closeSource(stream) {
  if (!stream || stream.destroyed) return;
  stream.destroy();
  await finished(stream).catch(() => {});
}

function byteMonitor(maxBytes) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let digested = false;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxBytes) {
        callback(snapshotError("SNAPSHOT_CIPHERTEXT_SIZE_LIMIT_EXCEEDED"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  return {
    stream,
    result() {
      if (digested) throw snapshotError("SNAPSHOT_DIGEST_ALREADY_FINALIZED");
      digested = true;
      return Object.freeze({
        sizeBytes,
        digest: `sha256:${hash.digest("hex")}`
      });
    }
  };
}

async function inspectSource(openReplay, { signal, maxBytes }) {
  const source = await openOwnedSource(openReplay, signal);
  const monitor = byteMonitor(maxBytes);
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  try {
    await pipeline(source, monitor.stream, sink, { signal });
    return monitor.result();
  } catch (error) {
    if (safeErrors.has(error)) throw error;
    if (signal?.aborted || error?.name === "AbortError") throw snapshotError("SNAPSHOT_ABORTED");
    throw snapshotError("SNAPSHOT_SOURCE_READ_FAILED");
  } finally {
    await closeSource(source);
  }
}

async function createPrivateTemp(destination) {
  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.snapshot-tmp-${randomBytes(16).toString("hex")}`
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    return { handle, path: temporaryPath };
  } catch {
    throw snapshotError("SNAPSHOT_DESTINATION_CREATE_FAILED");
  }
}

async function removeOwnedTemp(temporaryPath) {
  if (!temporaryPath) return;
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw snapshotError("SNAPSHOT_TEMP_CLEANUP_FAILED");
  }
}

async function publishTemp(temporaryPath, destination, signal) {
  assertNotAborted(signal);
  try {
    await link(temporaryPath, destination);
  } catch (error) {
    if (error?.code === "EEXIST") throw snapshotError("SNAPSHOT_DESTINATION_EXISTS");
    throw snapshotError("SNAPSHOT_DESTINATION_PUBLISH_FAILED");
  }
  try {
    await unlink(temporaryPath);
  } catch {
    throw snapshotError("SNAPSHOT_TEMP_CLEANUP_FAILED", { outputCommitted: true });
  }
}

function validateWrappedKey(wrapped, plaintext) {
  if (
    !sameKeys(wrapped, WRAPPED_KEYS) ||
    wrapped.kind !== WRAPPED_KEY_KIND ||
    !Buffer.isBuffer(wrapped.ciphertext) ||
    wrapped.ciphertext.byteLength === 0 ||
    wrapped.region !== KMS_REGION ||
    wrapped.keyAlias !== KEY_ALIAS ||
    typeof wrapped.keyId !== "string" ||
    wrapped.keyId.length === 0 ||
    wrapped.keyId !== wrapped.aliasReadbackKeyId
  ) {
    throw snapshotError("SNAPSHOT_WRAPPED_KEY_INVALID");
  }
  if (
    Buffer.isBuffer(plaintext) &&
    wrapped.ciphertext.buffer === plaintext.buffer &&
    wrapped.ciphertext.byteOffset < plaintext.byteOffset + plaintext.byteLength &&
    plaintext.byteOffset < wrapped.ciphertext.byteOffset + wrapped.ciphertext.byteLength
  ) {
    throw snapshotError("SNAPSHOT_WRAPPED_KEY_INVALID");
  }
  return Object.freeze({
    kind: wrapped.kind,
    ciphertext: Buffer.from(wrapped.ciphertext),
    region: wrapped.region,
    keyId: wrapped.keyId,
    keyAlias: wrapped.keyAlias,
    aliasReadbackKeyId: wrapped.aliasReadbackKeyId
  });
}

function validateGeneratedKey(result) {
  const plaintext = result?.plaintext;
  if (
    !sameKeys(result, ["plaintext", "wrapped"]) ||
    !Buffer.isBuffer(plaintext) ||
    plaintext.byteLength !== 32
  ) {
    throw snapshotError("SNAPSHOT_KMS_RESULT_INVALID");
  }
  return Object.freeze({ plaintext, wrapped: validateWrappedKey(result.wrapped, plaintext) });
}

function validateDecryptedKey(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
    throw snapshotError("SNAPSHOT_KMS_RESULT_INVALID");
  }
  return value;
}

function wipePossibleKey(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
}

function safePipelineError(error, signal, fallback) {
  if (safeErrors.has(error)) return error;
  if (signal?.aborted || error?.name === "AbortError") return snapshotError("SNAPSHOT_ABORTED");
  return snapshotError(fallback);
}

function assertEnvelopeSize(envelope, maxEnvelopeBytes) {
  if (Buffer.byteLength(canonicalJson(envelope), "utf8") > maxEnvelopeBytes) {
    throw snapshotError("SNAPSHOT_ENVELOPE_SIZE_LIMIT_EXCEEDED");
  }
}

function buildEnvelope({ aad, auth, nonce, tag, ciphertext, wrapped }) {
  return immutableJson({
    schemaVersion: "snapshot-encryption-envelope.v1",
    algorithm: "AES-256-GCM",
    releaseAttemptId: aad.releaseAttemptId,
    snapshotRunId: aad.snapshotRunId,
    sourceSha: aad.sourceSha,
    snapshotDigest: aad.snapshotDigest,
    sanitizationContractDigest: aad.sanitizationContractDigest,
    slotObjectKey: `snapshot-slots/v2/${aad.releaseAttemptId}/${aad.snapshotRunId}/snapshot.enc`,
    nonceBase64: nonce.toString("base64"),
    authenticationTagBase64: tag.toString("base64"),
    ciphertextDigest: ciphertext.digest,
    ciphertextSizeBytes: ciphertext.sizeBytes,
    wrappedDek: {
      ciphertextBase64: wrapped.ciphertext.toString("base64"),
      digest: sha256Bytes(wrapped.ciphertext)
    },
    kmsKeyReadback: {
      region: wrapped.region,
      keyId: wrapped.keyId,
      alias: wrapped.keyAlias,
      aliasReadbackKeyId: wrapped.aliasReadbackKeyId
    },
    kmsContext: auth.context,
    kmsContextDigest: auth.kmsContextDigest,
    gcmAad: { ...auth.value, digest: auth.digest },
    snapshotAllocatedAt: aad.snapshotAllocatedAt,
    expiresAt: aad.expiresAt
  });
}

function captureEnvelope(envelope, maxEnvelopeBytes) {
  let captured;
  try {
    captured = immutableJson(envelope);
    assertEnvelopeSize(captured, maxEnvelopeBytes);
    validateSnapshotEncryptionEnvelope(captured);
  } catch (error) {
    if (safeErrors.has(error)) throw error;
    throw snapshotError("SNAPSHOT_ENVELOPE_INVALID");
  }
  return captured;
}

function assertExpectedAad(envelope, aad, auth) {
  const expectedGcmAad = { ...auth.value, digest: auth.digest };
  if (
    canonicalJson(envelope.kmsContext) !== canonicalJson(auth.context) ||
    envelope.kmsContextDigest !== auth.kmsContextDigest ||
    canonicalJson(envelope.gcmAad) !== canonicalJson(expectedGcmAad) ||
    envelope.snapshotAllocatedAt !== aad.snapshotAllocatedAt ||
    envelope.snapshotDigest !== aad.snapshotDigest ||
    envelope.releaseAttemptId !== aad.releaseAttemptId ||
    envelope.snapshotRunId !== aad.snapshotRunId ||
    envelope.sourceSha !== aad.sourceSha ||
    envelope.sanitizationContractDigest !== aad.sanitizationContractDigest ||
    envelope.expiresAt !== aad.expiresAt
  ) {
    throw snapshotError("SNAPSHOT_AAD_MISMATCH");
  }
}

function wrappedFromEnvelope(envelope) {
  return Object.freeze({
    kind: WRAPPED_KEY_KIND,
    ciphertext: Buffer.from(envelope.wrappedDek.ciphertextBase64, "base64"),
    region: envelope.kmsKeyReadback.region,
    keyId: envelope.kmsKeyReadback.keyId,
    keyAlias: envelope.kmsKeyReadback.alias,
    aliasReadbackKeyId: envelope.kmsKeyReadback.aliasReadbackKeyId
  });
}

export function wipeKeyBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw snapshotError("SNAPSHOT_KEY_BUFFER_INVALID");
  // Best effort only: JavaScript runtimes may retain copies outside this Buffer.
  buffer.fill(0);
}

export async function encryptSnapshotStream({
  source,
  destination,
  aad,
  kms,
  signal,
  limits,
  ...forbidden
} = {}) {
  if (Reflect.ownKeys(forbidden).length > 0) {
    throw snapshotError("SNAPSHOT_CRYPTO_OPTIONS_INVALID");
  }
  assertSignal(signal);
  assertNotAborted(signal);
  const openReplay = captureSource(source);
  const outputPath = captureDestination(destination);
  const expected = captureAad(aad);
  const effectiveLimits = captureLimits(limits);
  const generateDataKey = captureKms(kms, "generateDataKey");
  const auth = authenticatedData(expected);
  await ensureDestinationAbsent(outputPath);
  assertNotAborted(signal);

  const firstPass = await inspectSource(openReplay, {
    signal,
    maxBytes: effectiveLimits.maxCiphertextBytes
  });
  if (firstPass.sizeBytes < 1 || firstPass.digest !== expected.snapshotDigest) {
    throw snapshotError("SNAPSHOT_DIGEST_MISMATCH");
  }
  assertNotAborted(signal);

  let keyMaterial;
  let temporary;
  let envelope;
  let committed = false;
  try {
    try {
      let generated;
      try {
        generated = await generateDataKey({
          keyAlias: KEY_ALIAS,
          keySpec: KEY_SPEC,
          encryptionContext: auth.context
        });
      } catch {
        if (signal?.aborted) throw snapshotError("SNAPSHOT_ABORTED");
        throw snapshotError("SNAPSHOT_KMS_GENERATE_FAILED");
      }
      keyMaterial = generated?.plaintext;
      assertNotAborted(signal);
      const key = validateGeneratedKey(generated);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key.plaintext, nonce, {
        authTagLength: 16
      });
      cipher.setAAD(auth.bytes);

      temporary = await createPrivateTemp(outputPath);
      const replay = await openOwnedSource(openReplay, signal);
      const plaintextMonitor = byteMonitor(effectiveLimits.maxCiphertextBytes);
      const ciphertextMonitor = byteMonitor(effectiveLimits.maxCiphertextBytes);
      await temporary.handle.chmod(0o600);
      const output = temporary.handle.createWriteStream({ autoClose: true, flush: true });
      try {
        await pipeline(replay, plaintextMonitor.stream, cipher, ciphertextMonitor.stream, output, {
          signal
        });
      } catch (error) {
        throw safePipelineError(error, signal, "SNAPSHOT_ENCRYPTION_FAILED");
      } finally {
        await closeSource(replay);
      }
      temporary.handle = undefined;
      const secondPass = plaintextMonitor.result();
      const ciphertext = ciphertextMonitor.result();
      if (
        secondPass.sizeBytes !== firstPass.sizeBytes ||
        secondPass.digest !== firstPass.digest ||
        secondPass.digest !== expected.snapshotDigest
      ) {
        throw snapshotError("SNAPSHOT_SOURCE_CHANGED");
      }
      const tag = cipher.getAuthTag();
      envelope = buildEnvelope({
        aad: expected,
        auth,
        nonce,
        tag,
        ciphertext,
        wrapped: key.wrapped
      });
      try {
        validateSnapshotEncryptionEnvelope(envelope);
      } catch {
        throw snapshotError("SNAPSHOT_ENVELOPE_INVALID");
      }
      assertEnvelopeSize(envelope, effectiveLimits.maxEnvelopeBytes);
    } finally {
      wipePossibleKey(keyMaterial);
    }
    await publishTemp(temporary.path, outputPath, signal);
    committed = true;
    return envelope;
  } finally {
    if (temporary?.handle) await temporary.handle.close().catch(() => {});
    if (!committed) await removeOwnedTemp(temporary?.path);
  }
}

export async function decryptSnapshotStream({
  source,
  destination,
  envelope,
  aad,
  kms,
  signal,
  limits,
  ...forbidden
} = {}) {
  if (Reflect.ownKeys(forbidden).length > 0) {
    throw snapshotError("SNAPSHOT_CRYPTO_OPTIONS_INVALID");
  }
  assertSignal(signal);
  assertNotAborted(signal);
  const openReplay = captureSource(source);
  const outputPath = captureDestination(destination);
  const expected = captureAad(aad, { required: true });
  const effectiveLimits = captureLimits(limits);
  const decryptDataKey = captureKms(kms, "decryptDataKey");
  const capturedEnvelope = captureEnvelope(envelope, effectiveLimits.maxEnvelopeBytes);
  const auth = authenticatedData(expected);
  assertExpectedAad(capturedEnvelope, expected, auth);
  await ensureDestinationAbsent(outputPath);
  assertNotAborted(signal);

  const firstPass = await inspectSource(openReplay, {
    signal,
    maxBytes: effectiveLimits.maxCiphertextBytes
  });
  if (
    firstPass.sizeBytes !== capturedEnvelope.ciphertextSizeBytes ||
    firstPass.digest !== capturedEnvelope.ciphertextDigest
  ) {
    throw snapshotError("SNAPSHOT_CIPHERTEXT_MISMATCH");
  }
  assertNotAborted(signal);

  const wrapped = wrappedFromEnvelope(capturedEnvelope);
  let keyMaterial;
  let temporary;
  let committed = false;
  try {
    try {
      try {
        keyMaterial = await decryptDataKey({
          wrapped,
          encryptionContext: auth.context
        });
      } catch {
        if (signal?.aborted) throw snapshotError("SNAPSHOT_ABORTED");
        throw snapshotError("SNAPSHOT_KMS_DECRYPT_FAILED");
      }
      assertNotAborted(signal);
      const key = validateDecryptedKey(keyMaterial);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(capturedEnvelope.nonceBase64, "base64"),
        { authTagLength: 16 }
      );
      decipher.setAAD(auth.bytes);
      decipher.setAuthTag(Buffer.from(capturedEnvelope.authenticationTagBase64, "base64"));

      temporary = await createPrivateTemp(outputPath);
      const replay = await openOwnedSource(openReplay, signal);
      const ciphertextMonitor = byteMonitor(effectiveLimits.maxCiphertextBytes);
      const plaintextMonitor = byteMonitor(effectiveLimits.maxCiphertextBytes);
      await temporary.handle.chmod(0o600);
      const output = temporary.handle.createWriteStream({ autoClose: true, flush: true });
      try {
        await pipeline(
          replay,
          ciphertextMonitor.stream,
          decipher,
          plaintextMonitor.stream,
          output,
          { signal }
        );
      } catch (error) {
        throw safePipelineError(error, signal, "SNAPSHOT_AUTHENTICATION_FAILED");
      } finally {
        await closeSource(replay);
      }
      temporary.handle = undefined;
      const secondCiphertext = ciphertextMonitor.result();
      const plaintext = plaintextMonitor.result();
      if (
        secondCiphertext.sizeBytes !== firstPass.sizeBytes ||
        secondCiphertext.digest !== firstPass.digest ||
        secondCiphertext.sizeBytes !== capturedEnvelope.ciphertextSizeBytes ||
        secondCiphertext.digest !== capturedEnvelope.ciphertextDigest
      ) {
        throw snapshotError("SNAPSHOT_SOURCE_CHANGED");
      }
      if (plaintext.digest !== expected.snapshotDigest) {
        throw snapshotError("SNAPSHOT_DIGEST_MISMATCH");
      }
    } finally {
      wipePossibleKey(keyMaterial);
    }
    await publishTemp(temporary.path, outputPath, signal);
    committed = true;
  } finally {
    if (temporary?.handle) await temporary.handle.close().catch(() => {});
    if (!committed) await removeOwnedTemp(temporary?.path);
  }
}
