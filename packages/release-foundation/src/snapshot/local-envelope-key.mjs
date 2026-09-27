import {
  constants,
  createPublicKey,
  KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes
} from "node:crypto";

import { canonicalJson } from "../canonical-json.mjs";
import { sha256Bytes } from "../digest.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const KIND = "local-rsa-oaep-sha256.v1";
const INPUT = "LOCAL_SNAPSHOT_KEY_INPUT_INVALID";
const WRAPPED = "LOCAL_SNAPSHOT_WRAPPED_KEY_INVALID";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function closedInput(value, keys, code) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length
    )
      fail(code);
    const captured = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    fail(code);
  }
}

function checkKey(key, type, keyFingerprint, contextDigest) {
  try {
    if (
      typeof keyFingerprint !== "string" ||
      !DIGEST.test(keyFingerprint) ||
      typeof contextDigest !== "string" ||
      !DIGEST.test(contextDigest) ||
      !(key instanceof KeyObject) ||
      key.type !== type ||
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength !== 3072 ||
      key.asymmetricKeyDetails?.publicExponent !== 65537n
    )
      fail(INPUT);
    const publicKey = type === "private" ? createPublicKey(key) : key;
    const der = publicKey.export({ type: "spki", format: "der" });
    if (sha256Bytes(der) !== keyFingerprint) fail(INPUT);
    return Buffer.from(
      canonicalJson({
        domain: "stage1-snapshot-dek-v2",
        contextDigest,
        keyFingerprint
      }),
      "utf8"
    );
  } catch {
    fail(INPUT);
  }
}

// oaepHash fixes both OAEP and MGF1 to SHA-256. No algorithm is caller-selected.
function oaepOptions(key, label) {
  return {
    key,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
    oaepLabel: label
  };
}

// On success, the caller owns plaintext and must clear it in its finally block.
export function generateLocalSnapshotDataKey(input) {
  const { publicKey, keyFingerprint, contextDigest } = closedInput(
    input,
    ["publicKey", "keyFingerprint", "contextDigest"],
    INPUT
  );
  const label = checkKey(publicKey, "public", keyFingerprint, contextDigest);
  let plaintext;
  let returned = false;
  try {
    let ciphertext;
    try {
      plaintext = randomBytes(32);
      ciphertext = publicEncrypt(oaepOptions(publicKey, label), plaintext);
    } catch {
      fail("LOCAL_SNAPSHOT_KEY_WRAP_FAILED");
    }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length !== 384)
      fail("LOCAL_SNAPSHOT_KEY_WRAP_FAILED");
    const result = {
      plaintext,
      wrapped: { kind: KIND, keyFingerprint, contextDigest, ciphertext }
    };
    returned = true;
    return result;
  } finally {
    if (!returned) plaintext?.fill(0);
  }
}

// Only public key material is exported for fingerprint verification.
export function decryptLocalSnapshotDataKey(input) {
  const { privateKey, keyFingerprint, contextDigest, wrapped } = closedInput(
    input,
    ["privateKey", "keyFingerprint", "contextDigest", "wrapped"],
    INPUT
  );
  const label = checkKey(privateKey, "private", keyFingerprint, contextDigest);
  const value = closedInput(
    wrapped,
    ["kind", "keyFingerprint", "contextDigest", "ciphertext"],
    WRAPPED
  );
  if (
    value.kind !== KIND ||
    value.keyFingerprint !== keyFingerprint ||
    value.contextDigest !== contextDigest ||
    !Buffer.isBuffer(value.ciphertext) ||
    value.ciphertext.length !== 384
  )
    fail(WRAPPED);
  let plaintext;
  let returned = false;
  try {
    try {
      plaintext = privateDecrypt(oaepOptions(privateKey, label), value.ciphertext);
    } catch {
      fail("LOCAL_SNAPSHOT_KEY_UNWRAP_FAILED");
    }
    if (!Buffer.isBuffer(plaintext) || plaintext.length !== 32) fail("LOCAL_SNAPSHOT_DEK_INVALID");
    returned = true;
    return plaintext;
  } finally {
    if (!returned) plaintext?.fill(0);
  }
}
