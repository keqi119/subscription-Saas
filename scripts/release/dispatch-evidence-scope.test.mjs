import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  buildDispatchEvidenceRamPolicy,
  captureDispatchEvidenceScope
} from "./dispatch-evidence-scope.mjs";

const account = "1457643390906675";
const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const digest = (character) => `sha256:${character.repeat(64)}`;

function originals() {
  const state = {
    schemaVersion: "i0-revocation-state.v1",
    policyDigest: digest("a"),
    sequence: 3,
    revokedAuthorizationIds: [],
    revokedAuthorizationDigests: []
  };
  const authorization = {
    schemaVersion: "rc-dispatch-authorization.v1",
    authorizationId: "dispatch-001",
    executionPurpose: "release-candidate",
    releaseAttemptId: "attempt-001",
    sourceSha: "b".repeat(40),
    producerWorkflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: digest("c")
    },
    rcWorkflow: {
      path: ".github/workflows/release-candidate.yml",
      ref: "main",
      blobDigest: digest("d")
    },
    buildProofDigest: digest("e"),
    buildBundleDigest: digest("f"),
    repositoryContractDigest: digest("1"),
    adapterDigest: digest("2"),
    issuer: "stage1-owner",
    issuedAt: "2026-10-05T00:00:00.000Z",
    notAfter: "2026-10-05T00:10:00.000Z",
    revocationPolicyDigest: state.policyDigest
  };
  return [authorization, state].map((document) => ({
    originalBytes: Buffer.from(canonicalJson(document))
  }));
}

test("captures exactly canonical dispatch authorization and revocation state", () => {
  const source = originals();
  const captured = captureDispatchEvidenceScope({ originals: source });
  assert.deepEqual(captured.map(({ proofType }) => proofType).sort(), [
    "i0-revocation-state.v1",
    "rc-dispatch-authorization.v1"
  ]);
  assert.equal(captured.length, 2);
  for (const item of captured) {
    const parsed = JSON.parse(item.originalBytes.toString("utf8"));
    assert.equal(
      item.exactKey,
      `control-evidence/v1/${item.proofType}/${sha256Canonical(parsed).replace(":", "-")}`
    );
    assert.equal(item.contentDigest, sha256Bytes(item.originalBytes));
    assert.equal(item.contentSizeBytes, item.originalBytes.length);
  }
  source[0].originalBytes.fill(0);
  assert.doesNotThrow(() => JSON.parse(captured[0].originalBytes.toString("utf8")));
});

test("rejects noncanonical, mismatched, extra, and accessor-backed originals", () => {
  const noncanonical = originals();
  noncanonical[0].originalBytes = Buffer.from(` ${noncanonical[0].originalBytes.toString("utf8")}`);
  assert.throws(() => captureDispatchEvidenceScope({ originals: noncanonical }));

  const mismatched = originals();
  const state = JSON.parse(mismatched[1].originalBytes.toString("utf8"));
  state.policyDigest = digest("9");
  mismatched[1].originalBytes = Buffer.from(canonicalJson(state));
  assert.throws(() => captureDispatchEvidenceScope({ originals: mismatched }));

  assert.throws(() =>
    captureDispatchEvidenceScope({ originals: [...originals(), ...originals().slice(0, 1)] })
  );

  let called = false;
  const getterFrame = {};
  Object.defineProperty(getterFrame, "originals", {
    enumerable: true,
    get() {
      called = true;
      return originals();
    }
  });
  assert.throws(() => captureDispatchEvidenceScope(getterFrame));
  assert.equal(called, false);
});

test("compiles exact two-object writer and reader policies under 2048 bytes", () => {
  const source = originals();
  for (const profile of ["writer", "reader"]) {
    const policy = buildDispatchEvidenceRamPolicy({ profile, originals: source });
    assert.equal(policy.Version, "1");
    assert.ok(Buffer.byteLength(canonicalJson(policy), "utf8") <= 2048);
    assert.ok(
      policy.Statement.every(
        (statement) => statement.Condition.Bool["acs:SecureTransport"] === "true"
      )
    );
    const objectResources = policy.Statement.flatMap((statement) => statement.Resource).filter(
      (resource) => resource.includes("/control-evidence/")
    );
    assert.deepEqual(
      objectResources.sort(),
      [
        `acs:oss:*:${account}:${bucket}/control-evidence/v1/i0-revocation-state.v1/${sha256Canonical(JSON.parse(source[1].originalBytes.toString("utf8"))).replace(":", "-")}`,
        `acs:oss:*:${account}:${bucket}/control-evidence/v1/rc-dispatch-authorization.v1/${sha256Canonical(JSON.parse(source[0].originalBytes.toString("utf8"))).replace(":", "-")}`
      ].sort()
    );
    const actions = policy.Statement.flatMap((statement) => statement.Action);
    assert.deepEqual(
      actions.sort(),
      (profile === "writer"
        ? ["oss:PutObject"]
        : [
            "oss:GetObject",
            "oss:GetObjectAcl",
            "oss:GetBucketAcl",
            "oss:GetBucketWorm",
            "oss:GetBucketVersioning",
            "oss:GetBucketEncryption",
            "oss:GetBucketPolicyStatus",
            "oss:GetBucketPublicAccessBlock"
          ]
      ).sort()
    );
  }
});
