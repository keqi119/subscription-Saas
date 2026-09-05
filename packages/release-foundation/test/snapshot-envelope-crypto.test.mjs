import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs, { createReadStream } from "node:fs";
import {
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rm,
  stat,
  unlink as unlinkFile,
  writeFile
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  decryptSnapshotStream,
  encryptSnapshotStream,
  wipeKeyBuffer
} from "../src/snapshot/envelope-crypto.mjs";
import { validateSnapshotEncryptionEnvelope } from "../src/snapshot/producer-crypto-contracts.mjs";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function expectedAad(bytes) {
  return {
    repositoryId: "1253231368",
    sourceSha: "b".repeat(40),
    releaseAttemptId: "attempt-20260903-001",
    snapshotRunId: "9001",
    sanitizationContractDigest: `sha256:${"1".repeat(64)}`,
    expiresAt: "2026-10-03T00:00:00.000Z",
    snapshotAllocatedAt: "2026-09-03T00:00:00.000Z",
    snapshotDigest: digest(bytes)
  };
}

function replayableFile(path, { highWaterMark = 7 } = {}) {
  let opens = 0;
  return {
    source: {
      open() {
        opens += 1;
        return createReadStream(path, { highWaterMark });
      }
    },
    openCount: () => opens
  };
}

function wrappedKey() {
  return {
    kind: "kms-symmetric-data-key.v1",
    ciphertext: Buffer.alloc(64, 3),
    region: "cn-shanghai",
    keyId: "key-actual-001",
    keyAlias: "alias/stage1-snapshot-custody",
    aliasReadbackKeyId: "key-actual-001"
  };
}

async function encryptedFixture(directory, plaintext, { stem = "fixture" } = {}) {
  const inputPath = join(directory, `${stem}.sql`);
  const ciphertextPath = join(directory, `${stem}.enc`);
  await writeFile(inputPath, plaintext);
  const source = replayableFile(inputPath);
  const envelope = await encryptSnapshotStream({
    source: source.source,
    destination: ciphertextPath,
    aad: expectedAad(plaintext),
    kms: {
      async generateDataKey() {
        return { plaintext: Buffer.alloc(32, 7), wrapped: wrappedKey() };
      }
    }
  });
  return { aad: expectedAad(plaintext), ciphertextPath, envelope, inputPath };
}

function serializedSecretScan(value, forbidden) {
  const pending = [value];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === null || entry === undefined) continue;
    if (typeof entry === "string") {
      for (const secret of forbidden) assert.equal(entry.includes(secret), false);
      continue;
    }
    if (typeof entry !== "object") continue;
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(/plaintext.*dek|access.*key|secret/i.test(key), false);
      pending.push(child);
    }
  }
}

async function childProcessRoundtrip(value) {
  const child = spawn(
    process.execPath,
    ["-e", "process.once('message', (value) => process.send(value))"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] }
  );
  const message = once(child, "message");
  child.send(value);
  const [received] = await message;
  child.disconnect();
  await once(child, "exit");
  return received;
}

async function withFileHandleFailure(directory, method, action) {
  const probePath = join(directory, `file-handle-probe-${method}`);
  const probe = await openFile(probePath, "wx", 0o600);
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype[method];
  await probe.close();
  await unlinkFile(probePath);
  prototype[method] = function injectedFileHandleFailure() {
    throw Object.assign(new Error("SENTINEL_RAW_FS_SECRET"), {
      secret: "SENTINEL_RAW_FS_SECRET"
    });
  };
  try {
    return await action();
  } finally {
    prototype[method] = original;
  }
}

async function withTemporaryUnlinkFailures(destination, failureCount, action) {
  const originalUnlink = fs.promises.unlink;
  let injectedFailures = 0;
  fs.promises.unlink = async function injectedUnlink(path) {
    if (
      String(path).includes(".snapshot-tmp-") &&
      fs.existsSync(destination) &&
      injectedFailures < failureCount
    ) {
      injectedFailures += 1;
      throw Object.assign(new Error("SENTINEL_UNLINK_SECRET"), {
        secret: "SENTINEL_UNLINK_SECRET"
      });
    }
    return originalUnlink(path);
  };
  syncBuiltinESMExports();
  try {
    return await action(() => injectedFailures);
  } finally {
    fs.promises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
}

test("real streaming encryption roundtrips and clears both plaintext DEKs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.concat([
    Buffer.from("sanitized-snapshot\n"),
    Buffer.alloc(97, 0x5a),
    Buffer.from("\nend\n")
  ]);
  const inputPath = join(directory, "snapshot.sql");
  const ciphertextPath = join(directory, "snapshot.enc");
  const outputPath = join(directory, "restored.sql");
  await writeFile(inputPath, plaintext);

  const producerSource = replayableFile(inputPath, { highWaterMark: 5 });
  const producerDek = Buffer.alloc(32, 7);
  const generateRequests = [];
  const producerKms = {
    async generateDataKey(request) {
      generateRequests.push(structuredClone(request));
      return { plaintext: producerDek, wrapped: wrappedKey() };
    }
  };
  const aad = expectedAad(plaintext);

  const envelope = await encryptSnapshotStream({
    source: producerSource.source,
    destination: ciphertextPath,
    aad,
    kms: producerKms
  });

  assert.equal(producerSource.openCount(), 2);
  assert.deepEqual(producerDek, Buffer.alloc(32));
  assert.doesNotThrow(() => validateSnapshotEncryptionEnvelope(envelope));
  const ciphertext = await readFile(ciphertextPath);
  assert.notDeepEqual(ciphertext, plaintext);
  assert.equal(envelope.ciphertextSizeBytes, plaintext.byteLength);
  assert.equal(envelope.ciphertextDigest, digest(ciphertext));
  assert.equal((await stat(ciphertextPath)).mode & 0o777, 0o600);
  assert.deepEqual(generateRequests, [
    {
      keyAlias: "alias/stage1-snapshot-custody",
      keySpec: "AES_256",
      encryptionContext: {
        repositoryId: aad.repositoryId,
        sourceSha: aad.sourceSha,
        releaseAttemptId: aad.releaseAttemptId,
        snapshotRunId: aad.snapshotRunId,
        sanitizationContractDigest: aad.sanitizationContractDigest,
        expiresAt: aad.expiresAt
      }
    }
  ]);

  const consumerSource = replayableFile(ciphertextPath, { highWaterMark: 3 });
  const consumerDek = Buffer.alloc(32, 7);
  const decryptRequests = [];
  const consumerKms = {
    async decryptDataKey(request) {
      decryptRequests.push({
        wrapped: { ...request.wrapped, ciphertext: Buffer.from(request.wrapped.ciphertext) },
        encryptionContext: structuredClone(request.encryptionContext)
      });
      return consumerDek;
    }
  };
  await decryptSnapshotStream({
    source: consumerSource.source,
    destination: outputPath,
    envelope,
    aad,
    kms: consumerKms
  });

  assert.equal(consumerSource.openCount(), 2);
  assert.deepEqual(consumerDek, Buffer.alloc(32));
  assert.deepEqual(await readFile(outputPath), plaintext);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.deepEqual(decryptRequests, [
    {
      wrapped: wrappedKey(),
      encryptionContext: {
        repositoryId: aad.repositoryId,
        sourceSha: aad.sourceSha,
        releaseAttemptId: aad.releaseAttemptId,
        snapshotRunId: aad.snapshotRunId,
        sanitizationContractDigest: aad.sanitizationContractDigest,
        expiresAt: aad.expiresAt
      }
    }
  ]);
});

test("consumer refuses changed authenticated data before KMS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-aad-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  const ciphertextPath = join(directory, "snapshot.enc");
  await writeFile(inputPath, plaintext);
  const producerSource = replayableFile(inputPath);
  const envelope = await encryptSnapshotStream({
    source: producerSource.source,
    destination: ciphertextPath,
    aad: expectedAad(plaintext),
    kms: {
      async generateDataKey() {
        return { plaintext: Buffer.alloc(32, 7), wrapped: wrappedKey() };
      }
    }
  });
  let decryptCalls = 0;

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: replayableFile(ciphertextPath).source,
        destination: join(directory, "restored.sql"),
        envelope,
        aad: { ...expectedAad(plaintext), releaseAttemptId: "changed" },
        kms: {
          async decryptDataKey() {
            decryptCalls += 1;
            return Buffer.alloc(32, 7);
          }
        }
      }),
    { code: "SNAPSHOT_AAD_MISMATCH" }
  );
  assert.equal(decryptCalls, 0);
});

test("wipeKeyBuffer overwrites only mutable Buffer key material", () => {
  const key = Buffer.alloc(32, 9);
  assert.equal(wipeKeyBuffer(key), undefined);
  assert.deepEqual(key, Buffer.alloc(32));
  assert.throws(() => wipeKeyBuffer(new Uint8Array(32)), {
    code: "SNAPSHOT_KEY_BUFFER_INVALID"
  });
});

test("producer removes its private temp and wipes the DEK when replay fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("already scanned sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  const destination = join(directory, "snapshot.enc");
  await writeFile(inputPath, plaintext);
  let opens = 0;
  const producerDek = Buffer.alloc(32, 7);
  const source = {
    open() {
      opens += 1;
      if (opens === 1) return createReadStream(inputPath);
      return createReadStream(join(directory, "missing-second-pass.sql"));
    }
  };

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source,
        destination,
        aad: expectedAad(plaintext),
        kms: {
          async generateDataKey() {
            return { plaintext: producerDek, wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_ENCRYPTION_FAILED" }
  );

  assert.deepEqual(producerDek, Buffer.alloc(32));
  assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
});

test("producer requires the already-scanned digest before requesting a key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  const replay = replayableFile(inputPath);
  let kmsCalls = 0;
  const aad = { ...expectedAad(plaintext), snapshotDigest: `sha256:${"f".repeat(64)}` };

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: replay.source,
        destination: join(directory, "snapshot.enc"),
        aad,
        kms: {
          async generateDataKey() {
            kmsCalls += 1;
            return { plaintext: Buffer.alloc(32, 7), wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_DIGEST_MISMATCH" }
  );
  assert.equal(replay.openCount(), 1);
  assert.equal(kmsCalls, 0);
  assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
});

test("decrypt requires caller expected AAD before opening ciphertext or KMS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-required-aad-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const replay = replayableFile(fixture.ciphertextPath);
  let kmsCalls = 0;

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: replay.source,
        destination: join(directory, "restored.sql"),
        envelope: fixture.envelope,
        kms: {
          async decryptDataKey() {
            kmsCalls += 1;
            return Buffer.alloc(32, 7);
          }
        }
      }),
    { code: "SNAPSHOT_AAD_REQUIRED" }
  );
  assert.equal(replay.openCount(), 0);
  assert.equal(kmsCalls, 0);
});

test("producer rejects asymmetric, extra, and drifting wrapped-key metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-wrapped-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  const mutations = [
    (value) => (value.kind = "local-public-key.v1"),
    (value) => (value.publicKeyAlgorithm = "RSA-OAEP"),
    (value) => (value.keyAlias = "alias/drifted"),
    (value) => (value.aliasReadbackKeyId = "key-drifted"),
    (value) => (value.region = "cn-beijing")
  ];

  for (const [index, mutate] of mutations.entries()) {
    const plaintextDek = Buffer.alloc(32, 7);
    const wrapped = wrappedKey();
    mutate(wrapped);
    await assert.rejects(
      () =>
        encryptSnapshotStream({
          source: replayableFile(inputPath).source,
          destination: join(directory, `snapshot-${index}.enc`),
          aad: expectedAad(plaintext),
          kms: {
            async generateDataKey() {
              return { plaintext: plaintextDek, wrapped };
            }
          }
        }),
      { code: "SNAPSHOT_WRAPPED_KEY_INVALID" }
    );
    assert.deepEqual(plaintextDek, Buffer.alloc(32));
  }
  assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
});

test("malformed generated key bytes are wiped and never published", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-malformed-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  const malformedDek = new Uint8Array(31).fill(9);

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: replayableFile(inputPath).source,
        destination: join(directory, "snapshot.enc"),
        aad: expectedAad(plaintext),
        kms: {
          async generateDataKey() {
            return { plaintext: malformedDek, wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_KMS_RESULT_INVALID" }
  );
  assert.deepEqual(malformedDek, new Uint8Array(31));
  assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
});

test("ciphertext prevalidation rejects tampering before KMS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-ciphertext-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const ciphertext = await readFile(fixture.ciphertextPath);
  ciphertext[0] ^= 0xff;
  await writeFile(fixture.ciphertextPath, ciphertext);
  let kmsCalls = 0;

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: replayableFile(fixture.ciphertextPath).source,
        destination: join(directory, "restored.sql"),
        envelope: fixture.envelope,
        aad: fixture.aad,
        kms: {
          async decryptDataKey() {
            kmsCalls += 1;
            return Buffer.alloc(32, 7);
          }
        }
      }),
    { code: "SNAPSHOT_CIPHERTEXT_MISMATCH" }
  );
  assert.equal(kmsCalls, 0);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("authentication-tag tampering never publishes partial plaintext", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-tag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const envelope = structuredClone(fixture.envelope);
  const tag = Buffer.from(envelope.authenticationTagBase64, "base64");
  tag[0] ^= 0xff;
  envelope.authenticationTagBase64 = tag.toString("base64");
  const consumerDek = Buffer.alloc(32, 7);
  const outputPath = join(directory, "restored.sql");

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: replayableFile(fixture.ciphertextPath).source,
        destination: outputPath,
        envelope,
        aad: fixture.aad,
        kms: {
          async decryptDataKey() {
            return consumerDek;
          }
        }
      }),
    { code: "SNAPSHOT_AUTHENTICATION_FAILED" }
  );
  assert.deepEqual(consumerDek, Buffer.alloc(32));
  assert.equal((await readdir(directory)).includes("restored.sql"), false);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("producer detects source mutation between digest verification and encryption", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-mutation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = Buffer.from("sanitized snapshot A");
  const second = Buffer.from("sanitized snapshot B");
  const firstPath = join(directory, "first.sql");
  const secondPath = join(directory, "second.sql");
  await writeFile(firstPath, first);
  await writeFile(secondPath, second);
  let opens = 0;
  const plaintextDek = Buffer.alloc(32, 7);

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: {
          open() {
            opens += 1;
            return createReadStream(opens === 1 ? firstPath : secondPath);
          }
        },
        destination: join(directory, "snapshot.enc"),
        aad: expectedAad(first),
        kms: {
          async generateDataKey() {
            return { plaintext: plaintextDek, wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_SOURCE_CHANGED" }
  );
  assert.equal(opens, 2);
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.deepEqual((await readdir(directory)).sort(), ["first.sql", "second.sql"]);
});

test("existing and racing destinations are preserved byte-for-byte", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-destination-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  const existingPath = join(directory, "existing.enc");
  const racePath = join(directory, "race.enc");
  const sentinel = Buffer.from("do not overwrite");
  await writeFile(inputPath, plaintext);
  await writeFile(existingPath, sentinel);
  let opens = 0;
  let kmsCalls = 0;

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: {
          open() {
            opens += 1;
            return createReadStream(inputPath);
          }
        },
        destination: existingPath,
        aad: expectedAad(plaintext),
        kms: {
          async generateDataKey() {
            kmsCalls += 1;
            return { plaintext: Buffer.alloc(32, 7), wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_DESTINATION_EXISTS" }
  );
  assert.equal(opens, 0);
  assert.equal(kmsCalls, 0);
  assert.deepEqual(await readFile(existingPath), sentinel);

  const racingDek = Buffer.alloc(32, 7);
  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: {
          async open() {
            opens += 1;
            if (opens === 2) await writeFile(racePath, sentinel);
            return createReadStream(inputPath);
          }
        },
        destination: racePath,
        aad: expectedAad(plaintext),
        kms: {
          async generateDataKey() {
            kmsCalls += 1;
            return { plaintext: racingDek, wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_DESTINATION_EXISTS" }
  );
  assert.deepEqual(racingDek, Buffer.alloc(32));
  assert.deepEqual(await readFile(racePath), sentinel);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("downward byte caps enforce actual streamed bytes and reject upward overrides", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-limits-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("123456789");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  let kmsCalls = 0;

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: replayableFile(inputPath).source,
        destination: join(directory, "too-large.enc"),
        aad: expectedAad(plaintext),
        limits: { maxCiphertextBytes: 8 },
        kms: {
          async generateDataKey() {
            kmsCalls += 1;
            return { plaintext: Buffer.alloc(32, 7), wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_CIPHERTEXT_SIZE_LIMIT_EXCEEDED" }
  );
  assert.equal(kmsCalls, 0);

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: replayableFile(inputPath).source,
        destination: join(directory, "invalid-limit.enc"),
        aad: expectedAad(plaintext),
        limits: { maxCiphertextBytes: 1_073_741_825 },
        kms: { generateDataKey() {} }
      }),
    { code: "SNAPSHOT_LIMITS_INVALID" }
  );

  const envelopeLimitDek = Buffer.alloc(32, 7);
  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: replayableFile(inputPath).source,
        destination: join(directory, "envelope-too-large.enc"),
        aad: expectedAad(plaintext),
        limits: { maxCiphertextBytes: plaintext.byteLength, maxEnvelopeBytes: 1 },
        kms: {
          async generateDataKey() {
            return { plaintext: envelopeLimitDek, wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_ENVELOPE_SIZE_LIMIT_EXCEEDED" }
  );
  assert.deepEqual(envelopeLimitDek, Buffer.alloc(32));
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("pre-abort and first-pass abort do not open/request beyond the abort boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const pre = new AbortController();
  pre.abort();
  let opens = 0;
  let kmsCalls = 0;
  const source = {
    open() {
      opens += 1;
      return Readable.from([plaintext]);
    }
  };

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source,
        destination: join(directory, "pre-abort.enc"),
        aad: expectedAad(plaintext),
        kms: {
          generateDataKey() {
            kmsCalls += 1;
          }
        },
        signal: pre.signal
      }),
    (error) => {
      assert.equal(error.code, "SNAPSHOT_ABORTED");
      assert.equal(error.kmsOutcome, undefined);
      return true;
    }
  );
  assert.equal(opens, 0);
  assert.equal(kmsCalls, 0);

  const during = new AbortController();
  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: {
          open() {
            opens += 1;
            return Readable.from(
              (async function* () {
                yield plaintext.subarray(0, 3);
                during.abort();
                yield plaintext.subarray(3);
              })()
            );
          }
        },
        destination: join(directory, "during-scan.enc"),
        aad: expectedAad(plaintext),
        kms: {
          generateDataKey() {
            kmsCalls += 1;
          }
        },
        signal: during.signal
      }),
    { code: "SNAPSHOT_ABORTED" }
  );
  assert.equal(opens, 1);
  assert.equal(kmsCalls, 0);
});

test("abort while GenerateDataKey settles waits to wipe returned key material", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-kms-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  const controller = new AbortController();
  const plaintextDek = Buffer.alloc(32, 7);
  let releaseKms;
  let markStarted;
  const started = new Promise((resolve) => (markStarted = resolve));
  const kmsResult = new Promise((resolve) => (releaseKms = resolve));
  let kmsCalls = 0;
  const operation = encryptSnapshotStream({
    source: replayableFile(inputPath).source,
    destination: join(directory, "snapshot.enc"),
    aad: expectedAad(plaintext),
    signal: controller.signal,
    kms: {
      async generateDataKey() {
        kmsCalls += 1;
        markStarted();
        return kmsResult;
      }
    }
  });
  await started;
  assert.equal(kmsCalls, 1);
  controller.abort();
  releaseKms({ plaintext: plaintextDek, wrapped: wrappedKey() });

  await assert.rejects(operation, {
    code: "SNAPSHOT_ABORTED",
    kmsOutcome: "UNKNOWN"
  });
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
});

test("abort during decryption removes unauthenticated plaintext and wipes the DEK", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-decrypt-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.alloc(64, 0x5a));
  const ciphertext = await readFile(fixture.ciphertextPath);
  const controller = new AbortController();
  let opens = 0;
  const plaintextDek = Buffer.alloc(32, 7);

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: {
          open() {
            opens += 1;
            if (opens === 1) return createReadStream(fixture.ciphertextPath);
            return Readable.from(
              (async function* () {
                yield ciphertext.subarray(0, 8);
                controller.abort();
                yield ciphertext.subarray(8);
              })()
            );
          }
        },
        destination: join(directory, "restored.sql"),
        envelope: fixture.envelope,
        aad: fixture.aad,
        signal: controller.signal,
        kms: {
          async decryptDataKey() {
            return plaintextDek;
          }
        }
      }),
    { code: "SNAPSHOT_ABORTED" }
  );
  assert.equal(opens, 2);
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.equal((await readdir(directory)).includes("restored.sql"), false);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("source, destination, and KMS failures are closed and provider errors are redacted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-failures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  let kmsCalls = 0;

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: {
          open() {
            throw new Error("source path secret");
          }
        },
        destination: join(directory, "source-failure.enc"),
        aad: expectedAad(plaintext),
        kms: {
          generateDataKey() {
            kmsCalls += 1;
          }
        }
      }),
    { code: "SNAPSHOT_SOURCE_OPEN_FAILED" }
  );
  assert.equal(kmsCalls, 0);

  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: replayableFile(inputPath).source,
        destination: join(directory, "missing-parent", "snapshot.enc"),
        aad: expectedAad(plaintext),
        kms: {
          async generateDataKey() {
            return { plaintext: Buffer.alloc(32, 7), wrapped: wrappedKey() };
          }
        }
      }),
    { code: "SNAPSHOT_DESTINATION_CREATE_FAILED" }
  );

  const rawProviderError = Object.assign(new Error("access-key-secret-value"), {
    accessKeyId: "provider-access-key",
    response: { plaintextDek: Buffer.alloc(32, 7) }
  });
  let caught;
  try {
    await encryptSnapshotStream({
      source: replayableFile(inputPath).source,
      destination: join(directory, "kms-failure.enc"),
      aad: expectedAad(plaintext),
      kms: {
        async generateDataKey() {
          throw rawProviderError;
        }
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, "SNAPSHOT_KMS_GENERATE_FAILED");
  assert.equal(caught.message, "SNAPSHOT_KMS_GENERATE_FAILED");
  assert.equal(caught.kmsOutcome, "UNKNOWN");
  assert.equal(caught.cause, undefined);
  assert.equal(caught.details, undefined);
  serializedSecretScan(
    { name: caught.name, message: caught.message, code: caught.code, details: caught.details },
    ["access-key-secret-value", "provider-access-key"]
  );
});

test("a forged safe-error marker cannot leak source secrets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-forged-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const secret = "source-private-value";
  const forged = Object.assign(new Error(secret), {
    code: "FORGED_PROVIDER_ERROR",
    details: { accessKeySecret: secret },
    snapshotCryptoSafe: true
  });
  let caught;

  try {
    await encryptSnapshotStream({
      source: {
        open() {
          return Readable.from(
            (async function* () {
              yield plaintext.subarray(0, 2);
              throw forged;
            })()
          );
        }
      },
      destination: join(directory, "snapshot.enc"),
      aad: expectedAad(plaintext),
      kms: {
        generateDataKey() {
          throw new Error("must not be called");
        }
      }
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught.code, "SNAPSHOT_SOURCE_READ_FAILED");
  assert.equal(caught.message, "SNAPSHOT_SOURCE_READ_FAILED");
  assert.equal(caught.details, undefined);
  assert.equal(JSON.stringify(caught).includes(secret), false);
});

test("returned and IPC-serialized envelope data contains no plaintext key material", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-serialization-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  const plaintextDek = Buffer.alloc(32, 0xa7);
  const rawBase64 = plaintextDek.toString("base64");
  const rawHex = plaintextDek.toString("hex");
  const envelope = await encryptSnapshotStream({
    source: replayableFile(inputPath).source,
    destination: join(directory, "snapshot.enc"),
    aad: expectedAad(plaintext),
    kms: {
      async generateDataKey() {
        return { plaintext: plaintextDek, wrapped: wrappedKey() };
      }
    }
  });

  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  const ipcEnvelope = await childProcessRoundtrip(envelope);
  for (const candidate of [envelope, structuredClone(envelope), ipcEnvelope]) {
    serializedSecretScan(candidate, [rawBase64, rawHex]);
    const serialized = JSON.stringify(candidate);
    assert.equal(serialized.includes(rawBase64), false);
    assert.equal(serialized.includes(rawHex), false);
  }
});

test("consumer rejects envelope context and alias drift before source or KMS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-envelope-drift-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const mutations = [
    (value) => (value.gcmAad.sourceSha = "c".repeat(40)),
    (value) => (value.kmsKeyReadback.alias = "alias/drifted"),
    (value) => (value.kmsKeyReadback.aliasReadbackKeyId = "key-drifted")
  ];

  for (const [index, mutate] of mutations.entries()) {
    const envelope = structuredClone(fixture.envelope);
    mutate(envelope);
    const replay = replayableFile(fixture.ciphertextPath);
    let kmsCalls = 0;
    await assert.rejects(
      () =>
        decryptSnapshotStream({
          source: replay.source,
          destination: join(directory, `restored-${index}.sql`),
          envelope,
          aad: fixture.aad,
          kms: {
            decryptDataKey() {
              kmsCalls += 1;
            }
          }
        }),
      { code: "SNAPSHOT_ENVELOPE_INVALID" }
    );
    assert.equal(replay.openCount(), 0);
    assert.equal(kmsCalls, 0);
  }
});

test("opaque wrapped bytes are delegated once to trusted KMS and failures are redacted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-opaque-wrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const envelope = structuredClone(fixture.envelope);
  const opaqueInvalid = Buffer.alloc(64, 0xcc);
  envelope.wrappedDek.ciphertextBase64 = opaqueInvalid.toString("base64");
  envelope.wrappedDek.digest = digest(opaqueInvalid);
  let kmsCalls = 0;
  let caught;

  try {
    await decryptSnapshotStream({
      source: replayableFile(fixture.ciphertextPath).source,
      destination: join(directory, "restored.sql"),
      envelope,
      aad: fixture.aad,
      kms: {
        async decryptDataKey({ wrapped }) {
          kmsCalls += 1;
          assert.equal(wrapped.kind, "kms-symmetric-data-key.v1");
          assert.deepEqual(wrapped.ciphertext, opaqueInvalid);
          throw Object.assign(new Error("provider raw response secret"), {
            response: { accessKeySecret: "provider-secret" }
          });
        }
      }
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(kmsCalls, 1);
  assert.equal(caught.code, "SNAPSHOT_KMS_DECRYPT_FAILED");
  assert.equal(caught.message, "SNAPSHOT_KMS_DECRYPT_FAILED");
  assert.equal(caught.kmsOutcome, "UNKNOWN");
  assert.equal(caught.cause, undefined);
  assert.equal(JSON.stringify(caught).includes("provider-secret"), false);
  assert.equal((await readdir(directory)).includes("restored.sql"), false);
});

test("consumer detects ciphertext mutation after prevalidation and publishes no plaintext", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-consumer-mutation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const changedPath = join(directory, "changed.enc");
  const changed = await readFile(fixture.ciphertextPath);
  changed[changed.byteLength - 1] ^= 0xff;
  await writeFile(changedPath, changed);
  let opens = 0;
  const plaintextDek = Buffer.alloc(32, 7);

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: {
          open() {
            opens += 1;
            return createReadStream(opens === 1 ? fixture.ciphertextPath : changedPath);
          }
        },
        destination: join(directory, "restored.sql"),
        envelope: fixture.envelope,
        aad: fixture.aad,
        kms: {
          async decryptDataKey() {
            return plaintextDek;
          }
        }
      }),
    { code: "SNAPSHOT_AUTHENTICATION_FAILED" }
  );
  assert.equal(opens, 2);
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.equal((await readdir(directory)).includes("restored.sql"), false);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("consumer preserves a destination created during the decrypt race", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-consumer-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const destination = join(directory, "restored.sql");
  const sentinel = Buffer.from("existing race winner");
  let opens = 0;
  const plaintextDek = Buffer.alloc(32, 7);

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: {
          async open() {
            opens += 1;
            if (opens === 2) await writeFile(destination, sentinel);
            return createReadStream(fixture.ciphertextPath);
          }
        },
        destination,
        envelope: fixture.envelope,
        aad: fixture.aad,
        kms: {
          async decryptDataKey() {
            return plaintextDek;
          }
        }
      }),
    { code: "SNAPSHOT_DESTINATION_EXISTS" }
  );
  assert.deepEqual(await readFile(destination), sentinel);
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("malformed decrypted key bytes are wiped before any plaintext temp is created", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-malformed-decrypt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const malformedDek = new Uint8Array(31).fill(9);

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: replayableFile(fixture.ciphertextPath).source,
        destination: join(directory, "restored.sql"),
        envelope: fixture.envelope,
        aad: fixture.aad,
        kms: {
          async decryptDataKey() {
            return malformedDek;
          }
        }
      }),
    { code: "SNAPSHOT_KMS_RESULT_INVALID" }
  );
  assert.deepEqual(malformedDek, new Uint8Array(31));
  assert.equal((await readdir(directory)).includes("restored.sql"), false);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("abort while Decrypt settles waits to wipe returned key material", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-decrypt-kms-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  const controller = new AbortController();
  const plaintextDek = Buffer.alloc(32, 7);
  let releaseKms;
  let markStarted;
  const started = new Promise((resolve) => (markStarted = resolve));
  const kmsResult = new Promise((resolve) => (releaseKms = resolve));
  let kmsCalls = 0;
  const operation = decryptSnapshotStream({
    source: replayableFile(fixture.ciphertextPath).source,
    destination: join(directory, "restored.sql"),
    envelope: fixture.envelope,
    aad: fixture.aad,
    signal: controller.signal,
    kms: {
      async decryptDataKey() {
        kmsCalls += 1;
        markStarted();
        return kmsResult;
      }
    }
  });
  await started;
  assert.equal(kmsCalls, 1);
  controller.abort();
  releaseKms(plaintextDek);

  await assert.rejects(operation, {
    code: "SNAPSHOT_ABORTED",
    kmsOutcome: "UNKNOWN"
  });
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.equal((await readdir(directory)).includes("restored.sql"), false);
});

test("public package index exposes only the three Task5 crypto functions", async () => {
  const packageExports = await import("../src/index.mjs");
  assert.equal(packageExports.encryptSnapshotStream, encryptSnapshotStream);
  assert.equal(packageExports.decryptSnapshotStream, decryptSnapshotStream);
  assert.equal(packageExports.wipeKeyBuffer, wipeKeyBuffer);
});

test("unknown options cannot inject a nonce or public-key recovery path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-options-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  let opens = 0;
  let kmsCalls = 0;
  const source = {
    open() {
      opens += 1;
      return Readable.from([plaintext]);
    }
  };

  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source,
        destination: join(directory, "snapshot.enc"),
        aad: expectedAad(plaintext),
        kms: {
          generateDataKey() {
            kmsCalls += 1;
          }
        },
        nonce: Buffer.alloc(12)
      }),
    { code: "SNAPSHOT_CRYPTO_OPTIONS_INVALID" }
  );
  assert.equal(opens, 0);
  assert.equal(kmsCalls, 0);

  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source,
        destination: join(directory, "restored.sql"),
        envelope: {},
        aad: expectedAad(plaintext),
        kms: {
          decryptDataKey() {
            kmsCalls += 1;
          }
        },
        privateKey: Buffer.alloc(32)
      }),
    { code: "SNAPSHOT_CRYPTO_OPTIONS_INVALID" }
  );
  assert.equal(opens, 0);
  assert.equal(kmsCalls, 0);
});

test("nonce and declared-size tampering fail at the earliest safe boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-envelope-tamper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));

  const wrongSize = structuredClone(fixture.envelope);
  wrongSize.ciphertextSizeBytes -= 1;
  let sizeKmsCalls = 0;
  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: replayableFile(fixture.ciphertextPath).source,
        destination: join(directory, "wrong-size.sql"),
        envelope: wrongSize,
        aad: fixture.aad,
        kms: {
          decryptDataKey() {
            sizeKmsCalls += 1;
          }
        }
      }),
    { code: "SNAPSHOT_CIPHERTEXT_MISMATCH" }
  );
  assert.equal(sizeKmsCalls, 0);

  const wrongNonce = structuredClone(fixture.envelope);
  const nonce = Buffer.from(wrongNonce.nonceBase64, "base64");
  nonce[0] ^= 0xff;
  wrongNonce.nonceBase64 = nonce.toString("base64");
  const nonceDek = Buffer.alloc(32, 7);
  await assert.rejects(
    () =>
      decryptSnapshotStream({
        source: replayableFile(fixture.ciphertextPath).source,
        destination: join(directory, "wrong-nonce.sql"),
        envelope: wrongNonce,
        aad: fixture.aad,
        kms: {
          async decryptDataKey() {
            return nonceDek;
          }
        }
      }),
    { code: "SNAPSHOT_AUTHENTICATION_FAILED" }
  );
  assert.deepEqual(nonceDek, Buffer.alloc(32));
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("review fix: copied or encoded plaintext DEKs cannot enter wrapped output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-key-copy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  const cases = [
    (key) => Buffer.from(key),
    (key) => Buffer.from(key.toString("hex"), "utf8"),
    (key) => Buffer.from(key.toString("base64"), "utf8"),
    (key, wrapped) => {
      wrapped.keyId = key.toString("hex");
      wrapped.aliasReadbackKeyId = wrapped.keyId;
      return wrapped.ciphertext;
    },
    (key, wrapped) => {
      wrapped.keyId = key.toString("utf8");
      wrapped.aliasReadbackKeyId = wrapped.keyId;
      return wrapped.ciphertext;
    }
  ];

  for (const [index, copiedCiphertext] of cases.entries()) {
    const plaintextDek =
      index === cases.length - 1
        ? Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
        : Buffer.alloc(32, 0xa7);
    const wrapped = wrappedKey();
    wrapped.ciphertext = copiedCiphertext(plaintextDek, wrapped);
    const destination = join(directory, `copied-${index}.enc`);
    let caught;
    try {
      await encryptSnapshotStream({
        source: replayableFile(inputPath).source,
        destination,
        aad: expectedAad(plaintext),
        kms: {
          async generateDataKey() {
            return { plaintext: plaintextDek, wrapped };
          }
        }
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught?.code, "SNAPSHOT_KEY_MATERIAL_EXPOSED");
    assert.equal(caught?.message, "SNAPSHOT_KEY_MATERIAL_EXPOSED");
    assert.equal(caught?.cause, undefined);
    assert.equal(caught?.details, undefined);
    assert.deepEqual(plaintextDek, Buffer.alloc(32));
    assert.equal(fs.existsSync(destination), false);
  }
});

test("review fix: producer output-setup failure is redacted before replay acquisition", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-setup-producer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  let opens = 0;
  let secondStream;
  const plaintextDek = Buffer.alloc(32, 7);
  let caught;

  await withFileHandleFailure(directory, "createWriteStream", async () => {
    try {
      await encryptSnapshotStream({
        source: {
          open() {
            opens += 1;
            const stream = createReadStream(inputPath);
            if (opens === 2) secondStream = stream;
            return stream;
          }
        },
        destination: join(directory, "snapshot.enc"),
        aad: expectedAad(plaintext),
        kms: {
          async generateDataKey() {
            return { plaintext: plaintextDek, wrapped: wrappedKey() };
          }
        }
      });
    } catch (error) {
      caught = error;
    }
  });

  assert.equal(caught?.code, "SNAPSHOT_DESTINATION_SETUP_FAILED");
  assert.equal(caught?.message, "SNAPSHOT_DESTINATION_SETUP_FAILED");
  assert.equal(caught?.secret, undefined);
  assert.equal(caught?.cause, undefined);
  assert.equal(opens, 1);
  assert.equal(secondStream, undefined);
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
});

test("review fix: consumer output-setup failure is redacted before replay acquisition", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-setup-consumer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await encryptedFixture(directory, Buffer.from("sanitized snapshot"));
  let opens = 0;
  let secondStream;
  const plaintextDek = Buffer.alloc(32, 7);
  let caught;

  await withFileHandleFailure(directory, "chmod", async () => {
    try {
      await decryptSnapshotStream({
        source: {
          open() {
            opens += 1;
            const stream = createReadStream(fixture.ciphertextPath);
            if (opens === 2) secondStream = stream;
            return stream;
          }
        },
        destination: join(directory, "restored.sql"),
        envelope: fixture.envelope,
        aad: fixture.aad,
        kms: {
          async decryptDataKey() {
            return plaintextDek;
          }
        }
      });
    } catch (error) {
      caught = error;
    }
  });

  assert.equal(caught?.code, "SNAPSHOT_DESTINATION_SETUP_FAILED");
  assert.equal(caught?.message, "SNAPSHOT_DESTINATION_SETUP_FAILED");
  assert.equal(caught?.secret, undefined);
  assert.equal(caught?.cause, undefined);
  assert.equal(opens, 1);
  assert.equal(secondStream, undefined);
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.equal(fs.existsSync(join(directory, "restored.sql")), false);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes("snapshot-tmp")),
    false
  );
});

test("review fix: schema-invalid deterministic facts fail before source or KMS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const base = expectedAad(plaintext);
  const fixedSlotLength =
    "snapshot-slots/v2/".length + base.releaseAttemptId.length + 1 + "/snapshot.enc".length;
  const boundaryRunId = `1${"0".repeat(1024 - fixedSlotLength - 1)}`;
  const candidates = [
    {
      ...base,
      snapshotAllocatedAt: "September 3, 2026 00:00:00 GMT",
      expiresAt: "October 3, 2026 00:00:00 GMT"
    },
    { ...base, releaseAttemptId: "attempt/subpath" },
    { ...base, snapshotRunId: `${boundaryRunId}0` }
  ];

  for (const [index, aad] of candidates.entries()) {
    let opens = 0;
    let kmsCalls = 0;
    await assert.rejects(
      () =>
        encryptSnapshotStream({
          source: {
            open() {
              opens += 1;
              return Readable.from([plaintext]);
            }
          },
          destination: join(directory, `invalid-${index}.enc`),
          aad,
          kms: {
            generateDataKey() {
              kmsCalls += 1;
            }
          }
        }),
      { code: "SNAPSHOT_AAD_INVALID" }
    );
    assert.equal(opens, 0);
    assert.equal(kmsCalls, 0);
  }

  const boundaryPath = join(directory, "boundary.sql");
  await writeFile(boundaryPath, plaintext);
  const validBoundary = await encryptSnapshotStream({
    source: replayableFile(boundaryPath).source,
    destination: join(directory, "boundary.enc"),
    aad: { ...base, snapshotRunId: boundaryRunId },
    kms: {
      async generateDataKey() {
        return { plaintext: Buffer.alloc(32, 7), wrapped: wrappedKey() };
      }
    }
  });
  assert.equal(validBoundary.slotObjectKey.length, 1024);
  assert.doesNotThrow(() => validateSnapshotEncryptionEnvelope(validBoundary));
});

test("review fix: producer transient and persistent cleanup keep committed status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-commit-producer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);

  for (const [kind, failureCount] of [
    ["transient", 1],
    ["persistent", Number.POSITIVE_INFINITY]
  ]) {
    const destination = join(directory, `${kind}.enc`);
    const plaintextDek = Buffer.alloc(32, 7);
    let caught;
    await withTemporaryUnlinkFailures(destination, failureCount, async (attempts) => {
      try {
        await encryptSnapshotStream({
          source: replayableFile(inputPath).source,
          destination,
          aad: expectedAad(plaintext),
          kms: {
            async generateDataKey() {
              return { plaintext: plaintextDek, wrapped: wrappedKey() };
            }
          }
        });
      } catch (error) {
        caught = error;
      }
      assert.equal(attempts() >= 1, true);
    });
    assert.equal(caught?.code, "SNAPSHOT_TEMP_CLEANUP_FAILED");
    assert.deepEqual(caught?.details, { outputCommitted: true });
    assert.equal(caught?.message.includes("SENTINEL_UNLINK_SECRET"), false);
    assert.deepEqual(plaintextDek, Buffer.alloc(32));
    assert.equal(fs.existsSync(destination), true);
    assert.notDeepEqual(await readFile(destination), plaintext);
  }
});

test("review fix: consumer transient and persistent cleanup keep committed status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-commit-consumer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const fixture = await encryptedFixture(directory, plaintext);

  for (const [kind, failureCount] of [
    ["transient", 1],
    ["persistent", Number.POSITIVE_INFINITY]
  ]) {
    const destination = join(directory, `${kind}.sql`);
    let caught;
    await withTemporaryUnlinkFailures(destination, failureCount, async (attempts) => {
      try {
        await decryptSnapshotStream({
          source: replayableFile(fixture.ciphertextPath).source,
          destination,
          envelope: fixture.envelope,
          aad: fixture.aad,
          kms: {
            async decryptDataKey() {
              return Buffer.alloc(32, 7);
            }
          }
        });
      } catch (error) {
        caught = error;
      }
      assert.equal(attempts() >= 1, true);
    });
    assert.equal(caught?.code, "SNAPSHOT_TEMP_CLEANUP_FAILED");
    assert.deepEqual(caught?.details, { outputCommitted: true });
    assert.equal(caught?.message.includes("SENTINEL_UNLINK_SECRET"), false);
    assert.deepEqual(await readFile(destination), plaintext);
  }
});

test("review fix: nested option shapes reject hidden own keys", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-own-keys-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);

  const nonEnumerableAad = expectedAad(plaintext);
  Object.defineProperty(nonEnumerableAad, "snapshotDigest", { enumerable: false });
  let nonEnumerableOpens = 0;
  let nonEnumerableKmsCalls = 0;
  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: {
          open() {
            nonEnumerableOpens += 1;
            return createReadStream(inputPath);
          }
        },
        destination: join(directory, "non-enumerable-required.enc"),
        aad: nonEnumerableAad,
        kms: {
          generateDataKey() {
            nonEnumerableKmsCalls += 1;
          }
        }
      }),
    { code: "SNAPSHOT_AAD_INVALID" }
  );
  assert.equal(nonEnumerableOpens, 0);
  assert.equal(nonEnumerableKmsCalls, 0);

  const hiddenCases = [
    {
      code: "SNAPSHOT_SOURCE_REPLAY_REQUIRED",
      make() {
        const source = replayableFile(inputPath).source;
        source[Symbol("hidden")] = true;
        return { source, aad: expectedAad(plaintext) };
      }
    },
    {
      code: "SNAPSHOT_AAD_INVALID",
      make() {
        const aad = expectedAad(plaintext);
        Object.defineProperty(aad, "hidden", { value: true });
        return { source: replayableFile(inputPath).source, aad };
      }
    },
    {
      code: "SNAPSHOT_LIMITS_INVALID",
      make() {
        const limits = {};
        Object.defineProperty(limits, "hidden", { value: true });
        return { source: replayableFile(inputPath).source, aad: expectedAad(plaintext), limits };
      }
    }
  ];

  for (const [index, { code, make }] of hiddenCases.entries()) {
    let kmsCalls = 0;
    await assert.rejects(
      () =>
        encryptSnapshotStream({
          ...make(),
          destination: join(directory, `hidden-${index}.enc`),
          kms: {
            generateDataKey() {
              kmsCalls += 1;
            }
          }
        }),
      { code }
    );
    assert.equal(kmsCalls, 0);
  }

  const plaintextDek = Buffer.alloc(32, 7);
  const wrapped = wrappedKey();
  wrapped[Symbol("hidden")] = true;
  await assert.rejects(
    () =>
      encryptSnapshotStream({
        source: replayableFile(inputPath).source,
        destination: join(directory, "hidden-wrapped.enc"),
        aad: expectedAad(plaintext),
        kms: {
          async generateDataKey() {
            return { plaintext: plaintextDek, wrapped };
          }
        }
      }),
    { code: "SNAPSHOT_WRAPPED_KEY_INVALID" }
  );
  assert.deepEqual(plaintextDek, Buffer.alloc(32));
  assert.equal(fs.existsSync(join(directory, "hidden-wrapped.enc")), false);
});

test("review fix: in-flight KMS failures carry only conservative UNKNOWN", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-envelope-crypto-kms-unknown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plaintext = Buffer.from("sanitized snapshot");
  const inputPath = join(directory, "snapshot.sql");
  await writeFile(inputPath, plaintext);
  let generateCalls = 0;
  let generateError;

  try {
    await encryptSnapshotStream({
      source: replayableFile(inputPath).source,
      destination: join(directory, "unknown-generate.enc"),
      aad: expectedAad(plaintext),
      kms: {
        async generateDataKey() {
          generateCalls += 1;
          throw Object.assign(new Error("SENTINEL_KMS_SECRET"), {
            kmsOutcome: "SUCCEEDED",
            details: { secret: "SENTINEL_KMS_SECRET" }
          });
        }
      }
    });
  } catch (error) {
    generateError = error;
  }
  assert.equal(generateCalls, 1);
  assert.equal(generateError?.code, "SNAPSHOT_KMS_GENERATE_FAILED");
  assert.equal(generateError?.kmsOutcome, "UNKNOWN");
  assert.equal(generateError?.details, undefined);
  assert.equal(JSON.stringify(generateError).includes("SENTINEL_KMS_SECRET"), false);
  assert.equal(fs.existsSync(join(directory, "unknown-generate.enc")), false);

  const fixture = await encryptedFixture(directory, plaintext);
  let decryptCalls = 0;
  let decryptError;
  try {
    await decryptSnapshotStream({
      source: replayableFile(fixture.ciphertextPath).source,
      destination: join(directory, "unknown-decrypt.sql"),
      envelope: fixture.envelope,
      aad: fixture.aad,
      kms: {
        async decryptDataKey() {
          decryptCalls += 1;
          throw Object.assign(new Error("SENTINEL_KMS_SECRET"), {
            kmsOutcome: "SUCCEEDED"
          });
        }
      }
    });
  } catch (error) {
    decryptError = error;
  }
  assert.equal(decryptCalls, 1);
  assert.equal(decryptError?.code, "SNAPSHOT_KMS_DECRYPT_FAILED");
  assert.equal(decryptError?.kmsOutcome, "UNKNOWN");
  assert.equal(decryptError?.details, undefined);
  assert.equal(JSON.stringify(decryptError).includes("SENTINEL_KMS_SECRET"), false);
  assert.equal(fs.existsSync(join(directory, "unknown-decrypt.sql")), false);
});
