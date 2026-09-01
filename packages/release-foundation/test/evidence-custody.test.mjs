import assert from "node:assert/strict";
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
    async createOnly({ key, bytes, retainUntil }) {
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
        storedAt: fixedNow.toISOString(),
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
