import assert from "node:assert/strict";
import test from "node:test";

import { runCustodyEvidence } from "./custody-evidence.mjs";

const now = new Date("2026-09-02T08:00:00.000Z");
const policy = {
  owner: "release-engineering",
  readers: ["release", "qa", "security", "audit"],
  retentionDays: 180,
  expiryDisposition: "review"
};
const request = {
  evidence: { schemaVersion: "source-gate-evidence.v1", result: "SUCCEEDED" },
  policy,
  attestationRef: "attestation://ci/source-gate-1"
};

function storageFixture({ mutateRead, omitReceipt } = {}) {
  const objects = new Map();
  let readCount = 0;
  return {
    trustPolicy: "immutable-content-addressed/v1",
    writerIdentity: "protected-ci-writer",
    auditReaderIdentity: "audit-reader",
    async createOnly({ key, bytes, requestedAt, retainUntil }) {
      if (objects.has(key)) {
        throw Object.assign(new Error("EVIDENCE_OVERWRITE_REFUSED"), {
          code: "EVIDENCE_OVERWRITE_REFUSED"
        });
      }
      objects.set(key, Buffer.from(bytes));
      return {
        created: true,
        storeRef: `artifact://release/${key}`,
        contentSizeBytes: Buffer.byteLength(bytes),
        storedAt: requestedAt,
        retainUntil
      };
    },
    async read({ key, identity }) {
      assert.equal(identity, "audit-reader");
      readCount += 1;
      if (omitReceipt && readCount === 2) return undefined;
      const stored = objects.get(key);
      return mutateRead ? mutateRead({ key, stored, readCount }) : stored;
    }
  };
}

function execute(storage, receiptId = "3ba3126f-f212-455b-b308-2f1d11f73b31") {
  return runCustodyEvidence({
    request,
    storage,
    now: () => now,
    createReceiptId: () => receiptId
  });
}

test("command adapter uploads and reads back content and receipt", async () => {
  const receipt = await execute(storageFixture());
  assert.equal(receipt.contentDigest, receipt.readbackDigest);
  assert.equal(receipt.retainUntil, "2027-03-01T08:00:00.000Z");
});

test("command adapter refuses an overwrite", async () => {
  const storage = storageFixture();
  await execute(storage);
  await assert.rejects(execute(storage, "86445f1c-c7a9-447b-a289-63a312eff1f9"), {
    code: "EVIDENCE_OVERWRITE_REFUSED"
  });
});

test("command adapter rejects content readback drift", async () => {
  const storage = storageFixture({
    mutateRead: ({ stored, readCount }) =>
      readCount === 1 ? Buffer.from("tampered", "utf8") : stored
  });
  await assert.rejects(execute(storage), {
    code: "EVIDENCE_READBACK_DIGEST_MISMATCH"
  });
});

test("command adapter rejects a missing custody receipt", async () => {
  await assert.rejects(execute(storageFixture({ omitReceipt: true })), {
    code: "CUSTODY_RECEIPT_MISSING"
  });
});

test("command adapter rejects raw database credentials before storage", async () => {
  const storage = storageFixture();
  await assert.rejects(
    runCustodyEvidence({
      request: {
        ...request,
        evidence: { databaseUrl: "postgres://user:password@database.example/release" }
      },
      storage,
      now: () => now,
      createReceiptId: () => "e99b8337-d0f0-41a2-b289-1a18cc241774"
    }),
    { code: "EVIDENCE_SECRET_DETECTED" }
  );
});
