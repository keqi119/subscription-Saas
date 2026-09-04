import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import { verifyAndSignSnapshotAdmission } from "../src/snapshot/snapshot-admission-verification.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SHA = "b".repeat(40);
const nonce = "c".repeat(32);

function signer(issuer) {
  const keys = generateKeyPairSync("ed25519");
  const policy = {
    issuer,
    keyId: `${issuer}-key`,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" })
  };
  return {
    policy,
    sign: (value, domain, name) => ({
      algorithm: "Ed25519",
      issuer,
      keyId: policy.keyId,
      subjectDigest: sha256Canonical(value),
      signature: sign(
        null,
        Buffer.from(canonicalJson({ domain, [name]: value })),
        keys.privateKey
      ).toString("base64")
    })
  };
}

// Minimal real Task2V frame: signatures, online revocation read and immutable custody are all
// verified by the production verifier; no test-only decision or verifier substitute exists.
function validDispatch(workflowDigest, calls) {
  const dispatch = signer("dispatch");
  const observer = signer("observer");
  const revoker = signer("revoker");
  const authorization = {
    schemaVersion: "rc-dispatch-authorization.v1",
    authorizationId: "authorization-1",
    executionPurpose: "qualification",
    releaseAttemptId: "attempt-1",
    sourceSha: SHA,
    producerWorkflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: workflowDigest
    },
    rcWorkflow: {
      path: ".github/workflows/release-candidate-gate.yml",
      ref: "main",
      blobDigest: DIGEST
    },
    buildProofDigest: DIGEST,
    buildBundleDigest: DIGEST,
    repositoryContractDigest: DIGEST,
    adapterDigest: DIGEST,
    issuer: "dispatch",
    issuedAt: "2026-09-03T00:00:00.000Z",
    notAfter: "2026-09-03T00:10:00.000Z",
    revocationPolicyDigest: DIGEST
  };
  const archive = {
    reference: "authorization/test",
    objectKey: "authorization/test",
    objectVersion: "v1",
    terminalAt: "2026-09-03T00:00:00.000Z",
    snapshotExpiresAt: null,
    downstreamRetainUntil: "2027-03-03T00:00:00.000Z",
    legalHoldUntil: null
  };
  const custody = {
    signer: observer.policy,
    writerIdentity: "writer",
    readerIdentity: "reader",
    storeRef: "store",
    owner: "owner",
    readers: ["audit"]
  };
  const expected = {
    executionPurpose: authorization.executionPurpose,
    releaseAttemptId: authorization.releaseAttemptId,
    sourceSha: SHA,
    producerWorkflow: authorization.producerWorkflow,
    rcWorkflow: authorization.rcWorkflow,
    buildProofDigest: DIGEST,
    buildBundleDigest: DIGEST,
    repositoryContractDigest: DIGEST,
    adapterDigest: DIGEST,
    revocationPolicyDigest: DIGEST,
    authorizationCustody: archive
  };
  let state = {
    schemaVersion: "i0-revocation-state.v1",
    policyDigest: DIGEST,
    sequence: 1,
    revokedAuthorizationIds: [],
    revokedAuthorizationDigests: []
  };
  let checkpoint = { sequence: 1, headDigest: sha256Canonical(state) };
  const signature = dispatch.sign(authorization, "rc-dispatch-authorization.v1", "authorization");
  const evidence = (body, detached, location) => {
    const originalBytes = Buffer.from(canonicalJson(body));
    const contentDigest = sha256Bytes(originalBytes);
    const receipt = {
      schemaVersion: "custody-receipt.v1",
      receiptId: "90d96a42-b007-4050-9c86-7d98a926a1d0",
      contentDigest,
      contentSizeBytes: originalBytes.length,
      storeRef: "store",
      uploadedAt: "2026-09-03T00:00:00.000Z",
      readbackAt: "2026-09-03T00:01:00.000Z",
      readbackDigest: contentDigest,
      owner: "owner",
      readers: ["audit"],
      retainUntil: "2027-03-04T00:00:00.000Z",
      expiryDisposition: "review",
      attestationRef: "attestation"
    };
    const observation = {
      schemaVersion: "authoritative-custody-observation.v1",
      issuer: "observer",
      keyId: "observer-key",
      objectKey: location.objectKey,
      objectVersion: location.objectVersion,
      contentDigest,
      contentSizeBytes: originalBytes.length,
      receiptDigest: sha256Canonical(receipt),
      storeRef: "store",
      writerIdentity: "writer",
      readerIdentity: "reader",
      conditionalCreate: "created",
      headDigest: contentDigest,
      getDigest: contentDigest,
      acl: "private",
      lastModified: receipt.uploadedAt,
      readbackAt: receipt.readbackAt,
      terminalAt: location.terminalAt,
      snapshotExpiresAt: null,
      downstreamRetainUntil: location.downstreamRetainUntil,
      legalHoldUntil: null,
      worm: { id: "worm", state: "Locked", retentionDays: 365, retainUntil: receipt.retainUntil }
    };
    return {
      originalBytes,
      signature: detached,
      receipt,
      observation,
      observationSignature: observer.sign(
        observation,
        "authoritative-custody-observation.v1",
        "observation"
      )
    };
  };
  return {
    authorization,
    input: {
      authorization,
      expected,
      signature,
      trustPolicy: {
        repository: { id: "1253231368", name: "keqi119/subscription-Saas" },
        actorId: "275060624",
        dispatchSigner: dispatch.policy,
        workflow: {
          executionPurpose: "qualification",
          producerWorkflow: authorization.producerWorkflow,
          rcWorkflow: authorization.rcWorkflow
        },
        maxAuthorizationLifetimeMs: 3600000,
        custody,
        revocation: {
          policyDigest: DIGEST,
          signer: revoker.policy,
          reader: { identity: "reader", endpoint: "file" },
          initialCheckpoint: checkpoint,
          timeoutMs: 30000,
          maxAgeMs: 120000
        }
      },
      clock: { now: () => "2026-09-03T00:01:00.000Z" },
      revocationJournal: {
        readCheckpoint: () => checkpoint,
        recordVerifiedHead: (next) => {
          checkpoint = { sequence: next.sequence, headDigest: next.headDigest };
        }
      },
      evidenceSource: {
        identity: "reader",
        endpoint: "file",
        async readRevocationHead(request) {
          calls.dispatch += 1;
          const response = {
            schemaVersion: "i0-revocation-read.v1",
            issuer: "revoker",
            keyId: "revoker-key",
            policyDigest: DIGEST,
            nonce: request.nonce,
            authorizationDigest: sha256Canonical(authorization),
            sequence: state.sequence,
            headDigest: sha256Canonical(state),
            issuedAt: "2026-09-03T00:01:00.000Z",
            notAfter: "2026-09-03T00:03:00.000Z",
            revokedAuthorizationIds: state.revokedAuthorizationIds,
            revokedAuthorizationDigests: state.revokedAuthorizationDigests,
            archive: { ...archive, reference: "head/test", objectKey: "head/test" }
          };
          return {
            response,
            signature: revoker.sign(response, "i0-revocation-read.v1", "response")
          };
        },
        async readExact({ reference }) {
          return evidence(
            reference === "authorization/test" ? authorization : state,
            reference === "authorization/test"
              ? signature
              : revoker.sign(state, "i0-revocation-state.v1", "state"),
            reference === "authorization/test"
              ? archive
              : { ...archive, reference: "head/test", objectKey: "head/test" }
          );
        }
      }
    },
    revoke() {
      state = { ...state, sequence: 2, revokedAuthorizationIds: [authorization.authorizationId] };
    }
  };
}

function fixture() {
  const pair = generateKeyPairSync("ed25519");
  const workflowBytes = Buffer.from(
    `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@${"d".repeat(40)}\n`
  );
  const workflowDigest = sha256Bytes(workflowBytes);
  const rootPolicy = {
    repository: { id: "1253231368", name: "keqi119/subscription-Saas" },
    actorId: "275060624",
    environment: { id: "44", name: "stage1-snapshot-export" },
    workflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: workflowDigest,
      actionCommits: [{ action: "actions/checkout", commit: "d".repeat(40) }]
    },
    environmentPolicyIdentity: {
      schemaVersion: "environment-policy-identity.v1",
      repository: { id: "1253231368", name: "keqi119/subscription-Saas" },
      environment: { id: "44", name: "stage1-snapshot-export" },
      requiredReviewerId: "275060624",
      branchPolicy: { protectedBranches: ["main"], tagRules: [] },
      canAdminsBypass: false,
      preventSelfReview: false,
      allowedActorId: "275060624",
      waitTimerSeconds: 0,
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      workflowBlobDigest: workflowDigest,
      actionCommitAllowlist: [{ action: "actions/checkout", commit: "d".repeat(40) }],
      canonicalizationVersion: "RFC8785"
    },
    rootSigner: {
      issuer: "root-test",
      keyId: "root-test-key",
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" })
    }
  };
  const calls = { github: 0, dispatch: 0, key: 0, jit: 0 };
  const valid = validDispatch(workflowDigest, calls);
  const authorization = valid.authorization;
  const admission = {
    schemaVersion: "snapshot-admission.v1",
    dispatchAuthorizationDigest: sha256Canonical(authorization),
    releaseAttemptId: "attempt-1",
    executionPurpose: "qualification",
    producerRun: {
      repository: "keqi119/subscription-Saas",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      workflowRef: "main",
      workflowBlobDigest: workflowDigest,
      sourceSha: SHA
    },
    route: { nonce, label: `stage1-snapshot-export-123-${nonce}` },
    adapterDigest: DIGEST,
    environmentPolicyIdentityDigest: sha256Canonical(rootPolicy.environmentPolicyIdentity)
  };
  const dispatchVerification = valid.input;
  const producerRun = {
    repository: "keqi119/subscription-Saas",
    runId: "123",
    runAttempt: 1,
    workflowPath: ".github/workflows/sanitized-snapshot.yml",
    workflowRef: "main",
    workflowBlobDigest: workflowDigest,
    sourceSha: SHA,
    event: "workflow_dispatch",
    queuedLabels: ["self-hosted", "linux", "x64", "stage1-snapshot-export"]
  };
  const githubObservations = {
    async readExact() {
      calls.github += 1;
      return {
        repository: rootPolicy.repository,
        producerRun,
        workflowBytes,
        environmentPolicy: {
          environment: {
            id: "44",
            name: "stage1-snapshot-export",
            canAdminsBypass: false,
            preventSelfReview: false,
            waitTimerSeconds: 0,
            requiredReviewerIds: ["275060624"],
            branchRules: ["main"],
            tagRules: []
          },
          workflow: rootPolicy.workflow
        },
        queuedLabels: producerRun.queuedLabels,
        admissionBytes: Buffer.from(canonicalJson(admission))
      };
    }
  };
  const privateKeyFd = {
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
    readPrivateKey() {
      calls.key += 1;
      return pair.privateKey;
    }
  };
  return {
    pair,
    rootPolicy,
    admission,
    calls,
    dispatchVerification,
    githubObservations,
    privateKeyFd,
    revoke: valid.revoke
  };
}

test("root re-fetches, freshly verifies and signs the reconstructed canonical verification", async () => {
  const f = fixture();
  const verification = await verifyAndSignSnapshotAdmission({
    admission: f.admission,
    dispatchVerification: f.dispatchVerification,
    githubObservations: f.githubObservations,
    rootPolicy: f.rootPolicy,
    privateKeyFd: f.privateKeyFd
  });
  const { signature, ...unsigned } = verification;
  assert.equal(f.calls.github, 1);
  assert.equal(f.calls.key, 1);
  assert.ok(
    verify(
      null,
      Buffer.from(
        canonicalJson({ domain: "snapshot-admission-verification.v1", verification: unsigned })
      ),
      f.pair.publicKey,
      Buffer.from(signature, "base64")
    )
  );
});

test("forged input, changed artifact route and wrong root signer never read a signing key", async () => {
  for (const mutate of [
    (f) => {
      f.admission.executionPurpose = "release-candidate";
    },
    (f) => {
      f.githubObservations.readExact = async () => ({
        repository: f.rootPolicy.repository,
        producerRun: { ...f.admission.producerRun, event: "workflow_dispatch", queuedLabels: [] },
        workflow: f.rootPolicy.workflow,
        environmentPolicy: { environment: {}, workflow: f.rootPolicy.workflow },
        queuedLabels: [],
        admissionBytes: Buffer.from(
          canonicalJson({ ...f.admission, route: { ...f.admission.route, nonce: "d".repeat(32) } })
        )
      });
    },
    (f) => {
      f.rootPolicy.rootSigner.publicKey = generateKeyPairSync("ed25519").publicKey.export({
        type: "spki",
        format: "pem"
      });
    }
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      verifyAndSignSnapshotAdmission({
        admission: f.admission,
        dispatchVerification: f.dispatchVerification,
        githubObservations: f.githubObservations,
        rootPolicy: f.rootPolicy,
        privateKeyFd: f.privateKeyFd
      }),
      /(?:SNAPSHOT_ADMISSION_|DISPATCH_)/
    );
    assert.equal(f.calls.key, 0);
  }
});

test("independent re-fetch happens before dispatch verification and unavailable read has zero privileged calls", async () => {
  const f = fixture();
  f.githubObservations.readExact = async () => {
    f.calls.github += 1;
    throw new Error("offline");
  };
  await assert.rejects(
    verifyAndSignSnapshotAdmission({
      admission: f.admission,
      dispatchVerification: f.dispatchVerification,
      githubObservations: f.githubObservations,
      rootPolicy: f.rootPolicy,
      privateKeyFd: f.privateKeyFd
    }),
    { code: "SNAPSHOT_ADMISSION_OBSERVATION_UNAVAILABLE" }
  );
  assert.deepEqual(f.calls, { github: 1, dispatch: 0, key: 0, jit: 0 });
});
