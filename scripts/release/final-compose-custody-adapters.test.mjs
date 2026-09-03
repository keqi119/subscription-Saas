import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Canonical } from "../../packages/release-foundation/src/index.mjs";
import { createFinalCustodyAdapters } from "./final-compose-custody-adapters.mjs";

function memoryUploader() {
  const values = new Map();
  return {
    trustPolicy: "immutable-content-addressed/v1",
    writerIdentity: "release-final-gate",
    auditReaderIdentity: "audit-reader",
    async createOnly({ key, bytes, requestedAt, retainUntil }) {
      if (values.has(key)) return { created: false };
      values.set(key, Buffer.from(bytes));
      return {
        created: true,
        storeRef: `memory-evidence://${key}`,
        contentSizeBytes: bytes.byteLength,
        storedAt: requestedAt,
        retainUntil
      };
    },
    async read({ key }) {
      return values.get(key);
    }
  };
}

const policy = Object.freeze({
  owner: "release-engineering",
  readers: ["release-auditor"],
  retentionDays: 180,
  expiryDisposition: "review"
});

test("stores canonical attempt evidence create-only and verifies custody readback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-custody-"));
  try {
    const adapters = createFinalCustodyAdapters({
      evidenceRoot: root,
      chain: "fresh",
      attemptId: randomUUID(),
      custodyPolicy: policy,
      uploader: memoryUploader(),
      attestationRef: "github://attestations/final-1",
      now: () => new Date("2026-09-03T00:00:00.000Z")
    });
    const result = await adapters.custody({
      buildEvidence: ({ custodyReceiptDigests }) => ({
        schemaVersion: "test-final-evidence.v1",
        custodyReceiptDigests
      }),
      stageEvidence: {
        database: { status: "PASSED", digest: `sha256:${"1".repeat(64)}` },
        api: { status: 200 },
        web: { responseStatus: 200 }
      }
    });
    assert.equal(result.receipts.length, 3);
    assert.equal(result.evidence.custodyReceiptDigests.length, 3);
    for (const receipt of result.receipts) {
      assert.equal(receipt.contentDigest, receipt.readbackDigest);
      assert.equal(await adapters.readback(receipt), true);
    }
    const local = JSON.parse(
      await readFile(path.join(root, "fresh", result.attemptId, "api.json"), "utf8")
    );
    assert.equal(local.status, 200);
    await assert.rejects(
      adapters.custody({
        buildEvidence: () => ({}),
        stageEvidence: { api: { status: 200 } }
      }),
      { code: "FINAL_EVIDENCE_STAGE_ALREADY_CUSTODIED" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not authorize cleanup before every custody receipt is read back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-custody-"));
  const uploader = memoryUploader();
  const originalRead = uploader.read;
  uploader.read = async (input) =>
    input.key.startsWith("receipts/") ? Buffer.from("tampered") : originalRead(input);
  try {
    const adapters = createFinalCustodyAdapters({
      evidenceRoot: root,
      chain: "snapshot",
      attemptId: randomUUID(),
      custodyPolicy: policy,
      uploader,
      attestationRef: "github://attestations/final-2"
    });
    await assert.rejects(
      adapters.custody({
        buildEvidence: ({ custodyReceiptDigests }) => ({ custodyReceiptDigests }),
        stageEvidence: { api: { status: 200 } }
      }),
      { code: "CUSTODY_RECEIPT_READBACK_DIGEST_MISMATCH" }
    );
    assert.equal(adapters.cleanupAuthorized(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records FAILED and INTERRUPTED_UNKNOWN attempts without overwriting history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-custody-"));
  try {
    const adapters = createFinalCustodyAdapters({
      evidenceRoot: root,
      chain: "fresh",
      attemptId: randomUUID(),
      custodyPolicy: policy,
      uploader: memoryUploader(),
      attestationRef: "github://attestations/final-3"
    });
    const first = await adapters.recordFailure({ terminalStatus: "FAILED", failedStage: "api" });
    assert.equal(first.terminalStatus, "FAILED");
    assert.match(first.failureProofDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(first.failureProofDigest, sha256Canonical(first.failure));
    await assert.rejects(
      adapters.recordFailure({ terminalStatus: "INTERRUPTED_UNKNOWN", failedStage: "api" }),
      { code: "FINAL_EVIDENCE_FAILURE_ALREADY_RECORDED" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
