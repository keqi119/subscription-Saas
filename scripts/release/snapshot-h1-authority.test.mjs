import assert from "node:assert/strict";
import test from "node:test";
import { runH1AttemptAuthority } from "./snapshot-h1-authority.mjs";
import { readH1SnapshotProductionInputs } from "./snapshot-h1-signing.mjs";

test("private authority rejects caller paths, sessions and operations before protected reads", async () => {
  for (const input of [
    { operation: "shell", request: {} },
    { operation: "jwt", request: { path: "/tmp/key.pem" } },
    { operation: "admit", request: { selection: {}, approvalSelection: {}, session: {} } },
    {
      operation: "recheck",
      request: { admission: {}, producerAuthorizationDigest: "x", deploymentId: "1", now: "2099" }
    }
  ])
    await assert.rejects(runH1AttemptAuthority(input), { code: "H1_ATTEMPT_AUTHORITY_REJECTED" });
  await assert.rejects(readH1SnapshotProductionInputs({ path: "/tmp/inputs.json" }), {
    code: "H1_SNAPSHOT_SIGNING_REJECTED"
  });
});

test("private authority does not evaluate caller getters", async () => {
  let invoked = false;
  await assert.rejects(
    runH1AttemptAuthority({
      get operation() {
        invoked = true;
        return "jwt";
      },
      request: {}
    }),
    { code: "H1_ATTEMPT_AUTHORITY_REJECTED" }
  );
  assert.equal(invoked, false);
});
