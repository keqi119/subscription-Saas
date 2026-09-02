import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Canonical } from "../../packages/release-foundation/src/index.mjs";

import { createWorkflowCustodyRecord } from "./workflow-custody-record.mjs";

test("binds a same-run immutable artifact readback to its content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "s1-custody-"));
  try {
    const content = { schemaVersion: "example.v1", status: "PASSED" };
    const original = path.join(root, "original.json");
    const readback = path.join(root, "readback.json");
    await writeFile(original, JSON.stringify(content));
    await writeFile(readback, JSON.stringify(content));
    const record = await createWorkflowCustodyRecord({
      originalFile: original,
      readbackFile: readback,
      workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/901/attempts/1",
      storeRef: "github-artifact://runs/901/example",
      attestationRef: "github-attestation://runs/901/example",
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      createId: () => "11111111-1111-4111-8111-111111111111"
    });
    assert.equal(record.receipt.contentDigest, sha256Canonical(content));
    assert.deepEqual(record.content, content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a changed artifact readback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "s1-custody-"));
  try {
    const original = path.join(root, "original.json");
    const readback = path.join(root, "readback.json");
    await writeFile(original, JSON.stringify({ value: 1 }));
    await writeFile(readback, JSON.stringify({ value: 2 }));
    await assert.rejects(
      createWorkflowCustodyRecord({
        originalFile: original,
        readbackFile: readback,
        workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/901/attempts/1",
        storeRef: "github-artifact://runs/901/example",
        attestationRef: "github-attestation://runs/901/example"
      }),
      { code: "WORKFLOW_CUSTODY_READBACK_MISMATCH" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
