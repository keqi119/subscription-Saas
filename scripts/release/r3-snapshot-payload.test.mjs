import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { encodeManualJson } from "../../packages/release-foundation/src/index.mjs";
import { fetchR3SnapshotCiphertext } from "./r3-snapshot-payload.mjs";
import {
  installR3SnapshotSdkFixture,
  r3SnapshotBootstrapFixture
} from "./r3-snapshot-payload-fixture.mjs";

const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const debug = createRequire(requireApi.resolve("ali-oss"))("debug");
const operationRef = "12345678-1234-4234-8234-123456789abc";
const role = "acs:ram::1457643390906675:role/subscription-saas-stage1-snapshot-consumer";
const arn = `${role}/s1r3-${operationRef}`;
const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const payload = Buffer.from("ciphertext bytes from the fixed object\n");
const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
const subject = Object.freeze({
  bucket,
  region: "oss-cn-shanghai",
  key: "snapshot-slots/v2/attempt-1/42/snapshot.enc",
  version: "null-version-disabled",
  etag: "aabbccdd",
  ciphertextDigest: digest,
  ciphertextSizeBytes: payload.length,
  lastModified: "2026-09-28T12:00:00.000Z",
  writerPrincipal: "acs:ram::1457643390906675:role/producer/run"
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r3-fetch-"));
  const credentialRoot = path.join(root, "credential");
  const ciphertext = path.join(credentialRoot, "r3", operationRef, "consumer", "ciphertext");
  await fs.mkdir(ciphertext, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(credentialRoot, "snapshot-reader"), { mode: 0o700 });
  const bootstrap = path.join(credentialRoot, "snapshot-reader", "bootstrap.json");
  await fs.writeFile(bootstrap, encodeManualJson(r3SnapshotBootstrapFixture), { mode: 0o600 });
  return {
    root,
    credentialRoot,
    ciphertext,
    bootstrap,
    profile: { storage: { credentialRoot } },
    async close() {
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

function mockNetwork(
  t,
  { identity = arn, headHeaders = {}, getHeaders = {}, body = payload, bucketAclXml = null } = {}
) {
  const fixture = installR3SnapshotSdkFixture(t, {
    operationRef,
    subject,
    bytes: body,
    identity,
    headHeaders,
    getHeaders,
    bucketAclXml
  });
  return {
    get calls() {
      return fixture.identityCalls;
    },
    get lastStream() {
      return fixture.lastStream;
    }
  };
}

test("fetches verified ciphertext into a private replayable file with safe frozen observations", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const network = mockNetwork(t);
  let checks = 0;
  const held = await fetchR3SnapshotCiphertext({
    profile: f.profile,
    operationRef,
    subject,
    recheck: async () => {
      checks++;
    },
    signal: new AbortController().signal
  });
  t.after(() => held.close());
  assert.equal(checks, 2);
  assert.equal(network.calls, 2);
  assert.equal(held.facts.path, path.join(f.ciphertext, "snapshot.enc"));
  assert.equal(held.facts.readerPrincipal, arn);
  assert.equal(held.facts.ciphertextDigest, digest);
  assert.equal((await fs.stat(held.facts.path)).mode & 0o777, 0o600);
  const replay = async () => {
    const chunks = [];
    for await (const chunk of await held.source.open()) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  assert.deepEqual(await replay(), payload);
  assert.deepEqual(await replay(), payload);
  assert.equal(Object.isFrozen(held.observations), true);
  assert.equal(JSON.stringify(held.observations).includes("sts-secret"), false);
  assert.equal(JSON.stringify(held.observations).includes("bootstrap-secret"), false);
  await held.recheck();
  assert.equal(checks, 2);
});

test("close destroys an owned replay and refuses future opens", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mockNetwork(t);
  const held = await fetchR3SnapshotCiphertext({
    profile: f.profile,
    operationRef,
    subject,
    recheck: async () => {},
    signal: new AbortController().signal
  });
  const replay = await held.source.open();
  await held.close();
  assert.equal(replay.destroyed, true);
  assert.equal(replay.read(), null);
  await assert.rejects(held.source.open(), { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" });
});

test("close waits for an in-flight replay open and refuses its result", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mockNetwork(t);
  const held = await fetchR3SnapshotCiphertext({
    profile: f.profile,
    operationRef,
    subject,
    recheck: async () => {},
    signal: new AbortController().signal
  });
  t.after(() => held.close());
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const originalOpen = fs.open;
  fs.open = async (file, ...args) => {
    if (file === held.facts.path) {
      entered.resolve();
      await release.promise;
    }
    return originalOpen(file, ...args);
  };
  t.after(() => {
    fs.open = originalOpen;
  });
  const opening = held.source.open();
  await entered.promise;
  const closing = held.close();
  release.resolve();
  await assert.rejects(opening, { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" });
  await closing;
});

test("rejects wrong current identity before reading object", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mockNetwork(t, { identity: "acs:ram::1457643390906675:role/wrong/session" });
  await assert.rejects(
    fetchR3SnapshotCiphertext({
      profile: f.profile,
      operationRef,
      subject,
      recheck: async () => {},
      signal: new AbortController().signal
    }),
    { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" }
  );
  assert.deepEqual(await fs.readdir(f.ciphertext), []);
});

test("rejects a mismatched GET header or digest without publishing", async (t) => {
  for (const change of [
    { getHeaders: { etag: '"different"' } },
    { body: Buffer.alloc(payload.length, 1) }
  ]) {
    const f = await fixture();
    const network = mockNetwork(t, change);
    await assert.rejects(
      fetchR3SnapshotCiphertext({
        profile: f.profile,
        operationRef,
        subject,
        recheck: async () => {},
        signal: new AbortController().signal
      }),
      { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" }
    );
    assert.deepEqual(await fs.readdir(f.ciphertext), []);
    if (change.getHeaders) assert.equal(network.lastStream.destroyed, true);
    await f.close();
  }
});

test("recheck rejects changed bootstrap or published ciphertext", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mockNetwork(t);
  const held = await fetchR3SnapshotCiphertext({
    profile: f.profile,
    operationRef,
    subject,
    recheck: async () => {},
    signal: new AbortController().signal
  });
  t.after(() => held.close());
  await fs.writeFile(
    f.bootstrap,
    encodeManualJson({ accessKeyId: "LTAIbootstrap", accessKeySecret: "changed-secret" }),
    { mode: 0o600 }
  );
  await assert.rejects(held.recheck(), { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" });
});

test("recheck rejects a replaced ciphertext path", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mockNetwork(t);
  const held = await fetchR3SnapshotCiphertext({
    profile: f.profile,
    operationRef,
    subject,
    recheck: async () => {},
    signal: new AbortController().signal
  });
  t.after(() => held.close());
  await fs.rename(held.facts.path, path.join(f.ciphertext, "old.enc"));
  await fs.writeFile(held.facts.path, payload, { mode: 0o600 });
  await assert.rejects(held.recheck(), { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" });
});

test("recheck rejects mutation of a pinned private ancestor", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mockNetwork(t);
  const held = await fetchR3SnapshotCiphertext({
    profile: f.profile,
    operationRef,
    subject,
    recheck: async () => {},
    signal: new AbortController().signal
  });
  t.after(() => held.close());
  await fs.mkdir(path.join(f.credentialRoot, "unexpected"), { mode: 0o700 });
  await assert.rejects(held.recheck(), { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" });
});

test("rejects public ACL in native XML", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mockNetwork(t, {
    bucketAclXml:
      "<AccessControlPolicy><Owner><ID>1457643390906675</ID><DisplayName>owner</DisplayName></Owner><AccessControlList><Grant>public-read</Grant></AccessControlList></AccessControlPolicy>"
  });
  await assert.rejects(
    fetchR3SnapshotCiphertext({
      profile: f.profile,
      operationRef,
      subject,
      recheck: async () => {},
      signal: new AbortController().signal
    }),
    { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" }
  );
  assert.deepEqual(await fs.readdir(f.ciphertext), []);
});

test("rejects a writer from the consumer role even with another session", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mockNetwork(t);
  await assert.rejects(
    fetchR3SnapshotCiphertext({
      profile: f.profile,
      operationRef,
      subject: Object.freeze({ ...subject, writerPrincipal: `${role}/another-session` }),
      recheck: async () => {},
      signal: new AbortController().signal
    }),
    { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" }
  );
  assert.deepEqual(await fs.readdir(f.ciphertext), []);
});

test("refuses unsafe OSS debug before opening bootstrap", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const original = debug.enabled;
  debug.enabled = () => true;
  t.after(() => {
    debug.enabled = original;
  });
  await assert.rejects(
    fetchR3SnapshotCiphertext({
      profile: f.profile,
      operationRef,
      subject,
      recheck: async () => {},
      signal: new AbortController().signal
    }),
    { code: "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE" }
  );
  assert.deepEqual(await fs.readdir(f.ciphertext), []);
});
