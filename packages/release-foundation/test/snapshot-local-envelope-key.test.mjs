import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt, publicEncrypt } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.mjs";
import { sha256Bytes } from "../src/digest.mjs";
import {
  decryptLocalSnapshotDataKey,
  generateLocalSnapshotDataKey
} from "../src/snapshot/local-envelope-key.mjs";

const pair = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
const keyFingerprint = sha256Bytes(pair.publicKey.export({ type: "spki", format: "der" }));
const contextDigest = "sha256:" + "c".repeat(64);
const otherContext = "sha256:" + "d".repeat(64);
const label = Buffer.from(
  canonicalJson({
    domain: "stage1-snapshot-dek-v2",
    contextDigest,
    keyFingerprint
  }),
  "utf8"
);
const generateInput = { publicKey: pair.publicKey, keyFingerprint, contextDigest };

function decryptInput(wrapped, overrides = {}) {
  return { privateKey: pair.privateKey, keyFingerprint, contextDigest, wrapped, ...overrides };
}

function rejects(work, code) {
  assert.throws(work, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(Object.keys(error), ["code"]);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("fresh DEKs roundtrip with independently specified native OAEP and label", () => {
  const first = generateLocalSnapshotDataKey(generateInput);
  const second = generateLocalSnapshotDataKey(generateInput);
  let recovered;
  let nativeRecovered;
  try {
    assert.equal(first.plaintext.length, 32);
    assert.equal(first.wrapped.ciphertext.length, 384);
    assert.notDeepEqual(first.plaintext, second.plaintext);
    assert.notDeepEqual(first.wrapped.ciphertext, second.wrapped.ciphertext);
    assert.deepEqual(Object.keys(first.wrapped).sort(), [
      "ciphertext",
      "contextDigest",
      "keyFingerprint",
      "kind"
    ]);
    assert.equal(first.wrapped.kind, "local-rsa-oaep-sha256.v1");
    nativeRecovered = privateDecrypt(
      {
        key: pair.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        oaepLabel: label
      },
      first.wrapped.ciphertext
    );
    assert.deepEqual(nativeRecovered, first.plaintext);
    recovered = decryptLocalSnapshotDataKey(decryptInput(first.wrapped));
    assert.deepEqual(recovered, first.plaintext);
  } finally {
    first.plaintext.fill(0);
    second.plaintext.fill(0);
    recovered?.fill(0);
    nativeRecovered?.fill(0);
  }
});

test("rejects an unapproved key, a changed context, and corrupt ciphertext", () => {
  const generated = generateLocalSnapshotDataKey(generateInput);
  try {
    rejects(
      () => generateLocalSnapshotDataKey({ ...generateInput, publicKey: otherPair.publicKey }),
      "LOCAL_SNAPSHOT_KEY_INPUT_INVALID"
    );
    rejects(
      () =>
        decryptLocalSnapshotDataKey(
          decryptInput(generated.wrapped, {
            privateKey: otherPair.privateKey
          })
        ),
      "LOCAL_SNAPSHOT_KEY_INPUT_INVALID"
    );
    rejects(
      () =>
        decryptLocalSnapshotDataKey(
          decryptInput(generated.wrapped, {
            contextDigest: otherContext
          })
        ),
      "LOCAL_SNAPSHOT_WRAPPED_KEY_INVALID"
    );
    const corrupt = { ...generated.wrapped, ciphertext: Buffer.alloc(384) };
    rejects(
      () => decryptLocalSnapshotDataKey(decryptInput(corrupt)),
      "LOCAL_SNAPSHOT_KEY_UNWRAP_FAILED"
    );
    const relabelled = { ...generated.wrapped, contextDigest: otherContext };
    rejects(
      () =>
        decryptLocalSnapshotDataKey(
          decryptInput(relabelled, {
            contextDigest: otherContext
          })
        ),
      "LOCAL_SNAPSHOT_KEY_UNWRAP_FAILED"
    );
  } finally {
    generated.plaintext.fill(0);
  }
});

test("accepts only the stated in-memory KeyObject kinds and strict digest inputs", () => {
  for (const changed of [
    { publicKey: pair.privateKey },
    { publicKey: "secret-key-path-or-PEM" },
    { keyFingerprint: "sha256:" + "A".repeat(64) },
    { contextDigest: "sha256:" + "c".repeat(63) },
    { contextDigest: "sha256:" + "c".repeat(64) + "\n" },
    { algorithm: "RSA-OAEP" }
  ]) {
    rejects(
      () => generateLocalSnapshotDataKey({ ...generateInput, ...changed }),
      "LOCAL_SNAPSHOT_KEY_INPUT_INVALID"
    );
  }
  rejects(() => generateLocalSnapshotDataKey(), "LOCAL_SNAPSHOT_KEY_INPUT_INVALID");
  const generated = generateLocalSnapshotDataKey(generateInput);
  try {
    rejects(
      () =>
        decryptLocalSnapshotDataKey(
          decryptInput(generated.wrapped, {
            privateKey: pair.publicKey
          })
        ),
      "LOCAL_SNAPSHOT_KEY_INPUT_INVALID"
    );
    rejects(
      () =>
        decryptLocalSnapshotDataKey(
          decryptInput(generated.wrapped, {
            privateKey: "secret-key-path-or-PEM"
          })
        ),
      "LOCAL_SNAPSHOT_KEY_INPUT_INVALID"
    );
  } finally {
    generated.plaintext.fill(0);
  }
});

test("rejects weak RSA, the wrong exponent, and non-RSA keys", () => {
  for (const keys of [
    generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 }),
    generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 3 }),
    generateKeyPairSync("ed25519")
  ]) {
    const fingerprint = sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" }));
    rejects(
      () =>
        generateLocalSnapshotDataKey({
          publicKey: keys.publicKey,
          keyFingerprint: fingerprint,
          contextDigest
        }),
      "LOCAL_SNAPSHOT_KEY_INPUT_INVALID"
    );
    rejects(
      () =>
        decryptLocalSnapshotDataKey({
          privateKey: keys.privateKey,
          keyFingerprint: fingerprint,
          contextDigest,
          wrapped: {
            kind: "local-rsa-oaep-sha256.v1",
            keyFingerprint: fingerprint,
            contextDigest,
            ciphertext: Buffer.alloc(384)
          }
        }),
      "LOCAL_SNAPSHOT_KEY_INPUT_INVALID"
    );
  }
});

test("rejects open or malformed wrapped metadata before unwrapping", () => {
  const generated = generateLocalSnapshotDataKey(generateInput);
  try {
    const accessor = { ...generated.wrapped };
    Object.defineProperty(accessor, "ciphertext", {
      enumerable: true,
      get() {
        throw new Error("sensitive accessor must not execute");
      }
    });
    for (const wrapped of [
      { ...generated.wrapped, kind: "kms-symmetric-data-key.v1" },
      { ...generated.wrapped, keyFingerprint: "sha256:" + "e".repeat(64) },
      { ...generated.wrapped, extra: true },
      { ...generated.wrapped, ciphertext: Buffer.alloc(383) },
      { ...generated.wrapped, ciphertext: new Uint8Array(384) },
      accessor,
      null
    ]) {
      rejects(
        () => decryptLocalSnapshotDataKey(decryptInput(wrapped)),
        "LOCAL_SNAPSHOT_WRAPPED_KEY_INVALID"
      );
    }
  } finally {
    generated.plaintext.fill(0);
  }
});

test("rejects a real OAEP plaintext with a non-DEK length", () => {
  const notDek = Buffer.alloc(31, 7);
  try {
    const ciphertext = publicEncrypt(
      {
        key: pair.publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        oaepLabel: label
      },
      notDek
    );
    rejects(
      () =>
        decryptLocalSnapshotDataKey(
          decryptInput({
            kind: "local-rsa-oaep-sha256.v1",
            keyFingerprint,
            contextDigest,
            ciphertext
          })
        ),
      "LOCAL_SNAPSHOT_DEK_INVALID"
    );
  } finally {
    notDek.fill(0);
  }
});
