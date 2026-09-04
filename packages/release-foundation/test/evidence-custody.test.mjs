import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  assertCustodyComplete,
  assertCustodyDeletionAllowed,
  canonicalJson,
  custodyEvidence,
  redactEvidence,
  sha256Bytes,
  validateContract
} from "../src/index.mjs";
import { verifyAuthoritativeCustodyObservation } from "../src/evidence-custody.mjs";

const fixedNow = new Date("2026-09-02T08:00:00.000Z");
const policy = {
  owner: "release-engineering",
  readers: ["release", "qa", "security", "audit"],
  retentionDays: 180,
  expiryDisposition: "review"
};

function memoryStore(overrides = {}) {
  const objects = new Map();
  const reads = [];
  return {
    trustPolicy: "immutable-content-addressed/v1",
    writerIdentity: "protected-ci-writer",
    auditReaderIdentity: "audit-reader",
    objects,
    reads,
    async createOnly({ key, bytes, requestedAt, retainUntil }) {
      if (objects.has(key)) {
        throw Object.assign(new Error("EVIDENCE_OVERWRITE_REFUSED"), {
          code: "EVIDENCE_OVERWRITE_REFUSED"
        });
      }
      objects.set(key, Buffer.from(bytes));
      return {
        storeRef: `memory://${key}`,
        created: true,
        contentSizeBytes: Buffer.byteLength(bytes),
        storedAt: requestedAt,
        retainUntil
      };
    },
    async read({ key, identity }) {
      reads.push({ key, identity });
      return objects.get(key);
    },
    ...overrides
  };
}

function fixture(overrides = {}) {
  return {
    value: {
      schemaVersion: "execution-proof.v1",
      operationId: "operation-1",
      terminalState: "SUCCEEDED"
    },
    policy,
    storage: memoryStore(),
    now: () => fixedNow,
    createReceiptId: () => "90d96a42-b007-4050-9c86-7d98a926a1d0",
    attestationRef: "attestation://release/operation-1",
    ...overrides
  };
}

test("rejects evidence containing raw credentials or customer identifiers", async () => {
  for (const value of [
    { url: "postgres://user:password@database.example/release" },
    { accessToken: "top-secret-token" },
    { phone: "18616570212" },
    { customerId: "customer-100" },
    { client_secret: "not-allowed" }
  ]) {
    await assert.rejects(custodyEvidence(fixture({ value })), {
      code: "EVIDENCE_SECRET_DETECTED"
    });
  }
});

test("redaction is a canonical-safe clone and never masks forbidden proof fields", () => {
  const value = { z: [1, true], a: { digest: `sha256:${"a".repeat(64)}` } };
  const accepted = redactEvidence(value, policy);
  assert.deepEqual(accepted, value);
  assert.notEqual(accepted, value);
  assert.throws(() => redactEvidence({ password: "masked-is-not-enough" }, policy), {
    code: "EVIDENCE_SECRET_DETECTED"
  });
});

test("uploads content by digest and verifies content and receipt through audit readback", async () => {
  const input = fixture();
  const receipt = await custodyEvidence(input);
  const contentBytes = Buffer.from(canonicalJson(input.value), "utf8");

  assert.equal(receipt.schemaVersion, "custody-receipt.v1");
  assert.equal(receipt.contentDigest, sha256Bytes(contentBytes));
  assert.equal(receipt.readbackDigest, receipt.contentDigest);
  assert.equal(receipt.readbackAt, fixedNow.toISOString());
  assert.equal(receipt.owner, policy.owner);
  assert.deepEqual(receipt.readers, policy.readers);
  assert.equal(receipt.retainUntil, "2027-03-01T08:00:00.000Z");
  assert.deepEqual(
    input.storage.reads.map(({ identity }) => identity),
    ["audit-reader", "audit-reader"]
  );
  assert.doesNotThrow(() => validateContract("custody-receipt.v1", receipt));
  assert.doesNotThrow(() => assertCustodyComplete(receipt, receipt.contentDigest));
});

test("rejects storage overwrite and content readback drift", async () => {
  const overwrite = fixture();
  const first = await custodyEvidence(overwrite);
  await assert.rejects(custodyEvidence(overwrite), {
    code: "EVIDENCE_OVERWRITE_REFUSED"
  });
  assertCustodyComplete(first, first.contentDigest);

  const mismatch = fixture({
    storage: memoryStore({
      async read() {
        return Buffer.from("changed", "utf8");
      }
    })
  });
  await assert.rejects(custodyEvidence(mismatch), {
    code: "EVIDENCE_READBACK_DIGEST_MISMATCH"
  });
});

test("rejects an invalid storage receipt", async () => {
  const storage = memoryStore();
  const createOnly = storage.createOnly;
  storage.createOnly = async (input) => ({
    ...(await createOnly(input)),
    contentSizeBytes: input.bytes.length + 1
  });
  await assert.rejects(custodyEvidence(fixture({ storage })), {
    code: "EVIDENCE_STORAGE_RECEIPT_INVALID"
  });
});

test("requires receipt readback before custody is complete", async () => {
  let reads = 0;
  const storage = memoryStore({
    async read({ key }) {
      reads += 1;
      if (reads === 2) return undefined;
      return storage.objects.get(key);
    }
  });
  await assert.rejects(custodyEvidence(fixture({ storage })), {
    code: "CUSTODY_RECEIPT_MISSING"
  });
});

test("successful, failed, and unknown evidence share one retention policy", async () => {
  for (const terminalState of ["SUCCEEDED", "FAILED", "INTERRUPTED_UNKNOWN"]) {
    const input = fixture({
      value: { schemaVersion: "execution-proof.v1", operationId: terminalState, terminalState },
      storage: memoryStore(),
      createReceiptId: () =>
        ({
          SUCCEEDED: "6094e005-6a37-48c4-8ad9-99149fc75205",
          FAILED: "6a46924c-611b-4712-8714-c6039c6bd58b",
          INTERRUPTED_UNKNOWN: "52146491-47ab-4f3f-b36c-e33e5769600f"
        })[terminalState]
    });
    const receipt = await custodyEvidence(input);
    assert.equal(receipt.owner, policy.owner);
    assert.deepEqual(receipt.readers, policy.readers);
    assert.equal(receipt.retainUntil, "2027-03-01T08:00:00.000Z");
    assert.equal(receipt.expiryDisposition, "review");
    assert.throws(() => assertCustodyDeletionAllowed(receipt, fixedNow), {
      code: "EVIDENCE_RETENTION_ACTIVE"
    });
  }
});

test("expiry still requires the registered disposition", async () => {
  const reviewReceipt = await custodyEvidence(fixture({ storage: memoryStore() }));
  assert.throws(
    () => assertCustodyDeletionAllowed(reviewReceipt, new Date("2027-03-02T08:00:00.000Z")),
    { code: "EVIDENCE_DELETION_APPROVAL_REQUIRED" }
  );

  const deleteReceipt = await custodyEvidence(
    fixture({
      policy: { ...policy, expiryDisposition: "delete" },
      storage: memoryStore(),
      createReceiptId: () => "28612402-8f94-475f-976a-0850d3059863"
    })
  );
  assert.doesNotThrow(() =>
    assertCustodyDeletionAllowed(deleteReceipt, new Date("2027-03-02T08:00:00.000Z"))
  );
});

function authoritativeFixture() {
  const keys = generateKeyPairSync("ed25519");
  const originalBytes = Buffer.from('{"proof":"terminal"}');
  const contentDigest = sha256Bytes(originalBytes);
  const receipt = {
    schemaVersion: "custody-receipt.v1",
    receiptId: "90d96a42-b007-4050-9c86-7d98a926a1d0",
    contentDigest,
    contentSizeBytes: originalBytes.length,
    storeRef: "private-store",
    uploadedAt: "2026-09-02T07:00:00.000Z",
    readbackAt: "2026-09-02T08:00:00.000Z",
    readbackDigest: contentDigest,
    owner: "release-engineering",
    readers: ["audit"],
    retainUntil: "2027-03-02T07:00:00.000Z",
    expiryDisposition: "review",
    attestationRef: "test-attestation"
  };
  const expected = {
    contentDigest,
    storeRef: "private-store",
    objectKey: "proof/test",
    objectVersion: "version-1",
    terminalAt: "2026-09-02T07:30:00.000Z",
    snapshotExpiresAt: null,
    downstreamRetainUntil: "2027-03-01T07:30:00.000Z",
    legalHoldUntil: null
  };
  const observation = {
    schemaVersion: "authoritative-custody-observation.v1",
    issuer: "test-observer",
    keyId: "test-observer-key",
    ...expected,
    contentSizeBytes: originalBytes.length,
    receiptDigest: sha256Bytes(Buffer.from(canonicalJson(receipt))),
    writerIdentity: "archive-writer",
    readerIdentity: "independent-audit-reader",
    conditionalCreate: "created",
    headDigest: contentDigest,
    getDigest: contentDigest,
    acl: "private",
    lastModified: receipt.uploadedAt,
    readbackAt: receipt.readbackAt,
    worm: { id: "worm-1", state: "Locked", retentionDays: 181, retainUntil: receipt.retainUntil }
  };
  const input = {
    originalBytes,
    receipt,
    observation,
    expected,
    trustPolicy: {
      signer: {
        issuer: "test-observer",
        keyId: "test-observer-key",
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" })
      },
      writerIdentity: "archive-writer",
      readerIdentity: "independent-audit-reader",
      storeRef: "private-store",
      owner: "release-engineering",
      readers: ["audit"]
    },
    now: fixedNow.toISOString()
  };
  const resign = () => {
    input.signature = {
      algorithm: "Ed25519",
      issuer: observation.issuer,
      keyId: observation.keyId,
      subjectDigest: sha256Bytes(Buffer.from(canonicalJson(observation))),
      signature: sign(
        null,
        Buffer.from(
          canonicalJson({
            domain: "authoritative-custody-observation.v1",
            observation
          })
        ),
        keys.privateKey
      ).toString("base64")
    };
  };
  resign();
  return { input, resign };
}

test("authoritative custody verifies independently signed original bytes and actual WORM", () => {
  const { input } = authoritativeFixture();
  const verified = verifyAuthoritativeCustodyObservation(input);
  assert.equal(verified.contentDigest, input.expected.contentDigest);
  assert.equal(verified.requiredRetainUntil, "2027-03-01T07:30:00.000Z");
  assert.ok(Object.isFrozen(verified));
  validateContract("authoritative-custody-observation.v1", input.observation);
});

test("authoritative custody rejects missing authenticity and tampered original bytes", () => {
  for (const mutate of [
    (v) => {
      v.signature = undefined;
    },
    (v) => {
      v.signature.issuer = "writer";
    },
    (v) => {
      v.signature.keyId = "wrong";
    },
    (v) => {
      v.signature.signature = "A".repeat(88);
    },
    (v) => {
      v.originalBytes = Buffer.from("tampered");
    },
    (v) => {
      v.receipt.immutable = true;
    },
    (v) => {
      v.observation.objectVersion = "substituted";
    },
    (v) => {
      v.trustPolicy.signer.publicKey = generateKeyPairSync("ed25519").publicKey.export({
        type: "spki",
        format: "pem"
      });
    }
  ]) {
    const { input } = authoritativeFixture();
    mutate(input);
    assert.throws(() => verifyAuthoritativeCustodyObservation(input), {
      code: "AUTHORITATIVE_CUSTODY_INVALID"
    });
  }
});

test("even signed custody rejects public, writer-read, preterminal and fabricated retention facts", () => {
  for (const mutate of [
    (v) => {
      v.acl = "public";
    },
    (v) => {
      v.storeRef = "actions-artifact";
    },
    (v) => {
      v.readerIdentity = "archive-writer";
    },
    (v) => {
      v.conditionalCreate = "overwritten";
    },
    (v) => {
      v.worm.state = "Unlocked";
    },
    (v) => {
      v.worm.id = "";
    },
    (v) => {
      v.worm.retentionDays = 180;
    },
    (v) => {
      v.worm.retainUntil = "2027-03-01T07:00:00.000Z";
    },
    (v) => {
      v.terminalAt = null;
    },
    (v) => {
      v.terminalAt = "2026-09-02T09:00:00.000Z";
    },
    (v) => {
      v.lastModified = "2026-02-30T00:00:00.000Z";
    },
    (v) => {
      v.readbackAt = "Infinity";
    },
    (v) => {
      v.headDigest = `sha256:${"b".repeat(64)}`;
    },
    (v) => {
      v.objectKey = "wrong-object";
    },
    (v) => {
      v.futureRunId = "not-allowed";
    }
  ]) {
    const { input, resign } = authoritativeFixture();
    mutate(input.observation);
    resign();
    assert.throws(() => verifyAuthoritativeCustodyObservation(input), {
      code: "AUTHORITATIVE_CUSTODY_INVALID"
    });
  }
});

test("custody retention includes snapshot expiry, downstream use and legal hold", () => {
  for (const field of ["snapshotExpiresAt", "downstreamRetainUntil", "legalHoldUntil"]) {
    const { input, resign } = authoritativeFixture();
    input.expected[field] = input.observation[field] = "2027-09-01T00:00:00.000Z";
    resign();
    assert.throws(() => verifyAuthoritativeCustodyObservation(input), {
      code: "AUTHORITATIVE_CUSTODY_INVALID"
    });
  }
});

test("custody schema closes every frame and enforces finite calendar timestamps", () => {
  const { input } = authoritativeFixture();
  for (const mutate of [
    (v) => {
      v.unknown = true;
    },
    (v) => {
      v.worm.unknown = true;
    },
    ...[
      "lastModified",
      "readbackAt",
      "terminalAt",
      "snapshotExpiresAt",
      "downstreamRetainUntil",
      "legalHoldUntil"
    ].flatMap((field) =>
      ["Infinity", "2026-02-30T00:00:00.000Z", "2026-09-02T24:00:00.000Z"].map((value) => (v) => {
        v[field] = value;
      })
    )
  ]) {
    const observation = structuredClone(input.observation);
    mutate(observation);
    assert.throws(() => validateContract("authoritative-custody-observation.v1", observation), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

test("custody rejects accessor metadata and extra input fields without executing getters", () => {
  for (const target of ["observation", "expected", "trustPolicy"]) {
    const { input } = authoritativeFixture();
    let reads = 0;
    const key = target === "trustPolicy" ? "owner" : "terminalAt";
    const value = input[target][key];
    Object.defineProperty(input[target], key, {
      enumerable: true,
      get() {
        reads++;
        return value;
      }
    });
    assert.throws(() => verifyAuthoritativeCustodyObservation(input), {
      code: "AUTHORITATIVE_CUSTODY_INVALID"
    });
    assert.equal(reads, 0);
  }
  const { input } = authoritativeFixture();
  assert.throws(() => verifyAuthoritativeCustodyObservation({ ...input, verified: true }), {
    code: "AUTHORITATIVE_CUSTODY_INVALID"
  });
});

test("reported effective custody retention cannot exceed authenticated bucket WORM duration", () => {
  const { input, resign } = authoritativeFixture();
  input.observation.worm.retainUntil = "2028-01-01T00:00:00.000Z";
  resign();
  assert.equal(
    verifyAuthoritativeCustodyObservation(input).retainUntil,
    "2027-03-02T07:00:00.000Z"
  );
});

test("custody accepts schema-valid UTC timestamps without rewriting signed observations", () => {
  for (const now of ["2026-09-02T08:00:00Z", "2026-09-02T08:00:00.123456Z"]) {
    const { input, resign } = authoritativeFixture();
    input.now = now;
    input.expected.terminalAt = input.observation.terminalAt = "2026-09-02T07:30:00Z";
    input.observation.lastModified = "2026-09-02T07:00:00Z";
    resign();
    assert.equal(
      verifyAuthoritativeCustodyObservation(input).requiredRetainUntil,
      "2027-03-01T07:30:00.000Z"
    );
    assert.equal(input.observation.terminalAt, "2026-09-02T07:30:00Z");
  }
});
