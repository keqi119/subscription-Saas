import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { archiveSessionFingerprint } from "./evidence-archive-operation.mjs";
import {
  challengeH1SnapshotSigningKey,
  verifyAndSignH1SnapshotAdmission,
  verifyH1SnapshotFinalReaderTerminal
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

test("final snapshot reader completion requires bound IO and actual process/session terminal", () => {
  const arn =
    "acs:ram::1457643390906675:assumed-role/subscription-saas-stage1-snapshot-consumer/final-reader";
  const identity = {
    AccountId: "1457643390906675",
    Arn: arn,
    IdentityType: "AssumedRoleUser",
    RequestId: "read-identity"
  };
  const session = {
    arn,
    issuedAt: "2026-10-06T00:00:00.000Z",
    expiresAt: "2026-10-06T00:15:00.000Z"
  };
  session.fingerprint = archiveSessionFingerprint(session, identity);
  const accessPolicyReadback = { fixture: "actual protected policy original" };
  const io = {
    status: "SNAPSHOT_FINAL_READBACK_OBSERVED",
    releaseAttemptId: "11111111-1111-4111-8111-111111111111",
    snapshotRunId: "123",
    session,
    githubTerminalReadback: {
      selection: { runId: "123" },
      observedAt: "2026-10-06T00:01:00.123456Z"
    },
    finalSnapshotReadback: {
      observedAt: "2026-10-06T00:02:00.000Z",
      readerIdentityOriginal: identity
    },
    storageOriginals: { observation: { observedAt: "2026-10-06T00:03:00.000Z" } },
    accessPolicyDigest: sha256Canonical(accessPolicyReadback),
    observedAt: "2026-10-06T00:04:00.000Z"
  };
  const terminal = {
    status: "SNAPSHOT_FINAL_READER_TERMINAL_OBSERVED",
    releaseAttemptId: io.releaseAttemptId,
    snapshotRunId: io.snapshotRunId,
    readbackDigest: sha256Canonical(io),
    session,
    ioObservedAt: io.observedAt,
    authority: {
      startedAt: "2026-10-06T00:00:01.000Z",
      finishedAt: "2026-10-06T00:04:01.000Z",
      exited: true,
      exitCode: 0
    },
    sessionDisposal: {
      path: "/var/lib/stage1-volumes/main/snapshot-authority/snapshot-final-reader-session.json",
      removed: true,
      removedAt: "2026-10-06T00:04:02.000Z",
      absent: true,
      expiresAt: session.expiresAt,
      observedAt: session.expiresAt
    }
  };
  const input = {
    io,
    terminal,
    now: "2026-10-06T00:16:00.000Z",
    accessPolicyReadback,
    configuration: {
      selection: io.githubTerminalReadback.selection,
      accessPolicyDigest: io.accessPolicyDigest
    }
  };
  assert.equal(verifyH1SnapshotFinalReaderTerminal(input), io);
  for (const alter of [
    (v) => {
      v.accessPolicyReadback = { changed: true };
    },
    (v) => {
      v.configuration.selection = { runId: "124" };
    },
    (v) => {
      v.terminal.authority.exited = false;
    },
    (v) => {
      v.terminal.sessionDisposal.observedAt = "2026-10-06T00:14:59.000Z";
    },
    (v) => {
      v.terminal.sessionDisposal.absent = false;
    },
    (v) => {
      v.io.accessPolicyDigest = "sha256:" + "b".repeat(64);
    },
    (v) => {
      v.io.githubTerminalReadback.observedAt = "2026-10-06T00:02:30.000Z";
      v.terminal.readbackDigest = sha256Canonical(v.io);
    }
  ]) {
    const bad = globalThis.structuredClone(input);
    alter(bad);
    assert.throws(() => verifyH1SnapshotFinalReaderTerminal(bad), {
      code: "H1_SNAPSHOT_SIGNING_REJECTED"
    });
  }
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
