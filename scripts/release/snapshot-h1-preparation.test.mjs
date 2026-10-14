import assert from "node:assert/strict";
import test from "node:test";
import * as signing from "./prepare-h1-r3-snapshot-input.mjs";

test("fixed snapshot preparation accepts selectors only, before accessing H1", async () => {
  assert.equal(typeof signing.prepareH1R3SnapshotInputPackage, "function");
  const selector = {
    releaseAttemptId: "11111111-1111-4111-8111-111111111111",
    snapshotRunId: "123",
    operationRef: "22222222-2222-4222-8222-222222222222"
  };
  for (const field of [
    "signer",
    "expected",
    "profile",
    "phase",
    "destination",
    "job",
    "repoRoot",
    "clock",
    "readRaw",
    "sourceAuthority"
  ]) {
    let invoked = false;
    const invalid = { ...selector };
    Object.defineProperty(invalid, field, {
      enumerable: true,
      get() {
        invoked = true;
        throw Error("caller authority must not be evaluated");
      }
    });
    await assert.rejects(signing.prepareH1R3SnapshotInputPackage(invalid), {
      code: "H1_SNAPSHOT_PREPARATION_REJECTED"
    });
    assert.equal(invoked, false);
  }
  for (const invalid of [
    { ...selector, operationRef: "../other" },
    { ...selector, releaseAttemptId: "../other" },
    { ...selector, snapshotRunId: "0" }
  ])
    await assert.rejects(signing.prepareH1R3SnapshotInputPackage(invalid), {
      code: "H1_SNAPSHOT_PREPARATION_REJECTED"
    });
});
