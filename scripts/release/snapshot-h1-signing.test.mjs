import assert from "node:assert/strict";
import test from "node:test";
import {
  challengeH1SnapshotSigningKey,
  verifyAndSignH1SnapshotAdmission
} from "./snapshot-h1-signing.mjs";

test("H1 signing entry rejects caller keys and paths without invoking getters", async () => {
  let invoked = false;
  await assert.rejects(
    verifyAndSignH1SnapshotAdmission({
      admission: {},
      dispatchVerification: {},
      githubObservations: {},
      rootPolicy: {},
      get privateKeyFd() {
        invoked = true;
        throw Error("must not run");
      }
    }),
    { code: "H1_SNAPSHOT_SIGNING_REJECTED" }
  );
  assert.equal(invoked, false);
  await assert.rejects(challengeH1SnapshotSigningKey({ path: "/tmp/key.pem" }), {
    code: "H1_SNAPSHOT_SIGNING_REJECTED"
  });
});

test("H1 signing entry rejects a different issuer before any private-key operation", async () => {
  await assert.rejects(
    verifyAndSignH1SnapshotAdmission({
      admission: {},
      dispatchVerification: {},
      githubObservations: {},
      rootPolicy: { rootSigner: { issuer: "caller", keyId: "arbitrary", publicKey: "arbitrary" } }
    }),
    { code: "H1_SNAPSHOT_SIGNING_REJECTED" }
  );
});
