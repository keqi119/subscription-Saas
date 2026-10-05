import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import { verifyAndSignSnapshotAdmission } from "../src/snapshot/snapshot-admission-verification.mjs";
import { verifyDispatchAuthorization } from "../src/dispatch-authorization.mjs";
import {
  buildSnapshotAdmission,
  createUntrustedSnapshotAdmissionInput
} from "../src/snapshot/snapshot-admission.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SHA = "b".repeat(40);
const nonce = "c".repeat(32);
const { structuredClone } = globalThis;

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
function validDispatch(workflowDigest, calls, authorizationPatch = {}) {
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
    revocationPolicyDigest: DIGEST,
    ...authorizationPatch
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

const uploadStep = `      - uses: actions/upload-artifact@${"e".repeat(40)}\n        with:\n          name: snapshot-admission\n          path: .release-output/snapshot-admission.v1.json\n          overwrite: false\n          if-no-files-found: error\n`;

function fixture(workflowSource, authorizationPatch) {
  const pair = generateKeyPairSync("ed25519");
  const workflowBytes = Buffer.from(
    workflowSource ??
      `jobs:\n  admission:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${"d".repeat(40)}\n${uploadStep}  snapshot-data:\n    needs: admission\n    runs-on: \u0024{{ needs.admission.outputs.labels }}\n    steps:\n      - run: /usr/local/bin/stage1-snapshot-export\n  snapshot-custody:\n    needs: snapshot-data\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${"d".repeat(40)}\n`
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
      actionCommits: [
        { action: "actions/checkout", commit: "d".repeat(40) },
        { action: "actions/upload-artifact", commit: "e".repeat(40) }
      ]
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
      actionCommitAllowlist: [
        { action: "actions/checkout", commit: "d".repeat(40) },
        { action: "actions/upload-artifact", commit: "e".repeat(40) }
      ],
      canonicalizationVersion: "RFC8785"
    },
    rootSigner: {
      issuer: "root-test",
      keyId: "root-test-key",
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" })
    }
  };
  const calls = { github: 0, dispatch: 0, key: 0, jit: 0 };
  const valid = validDispatch(workflowDigest, calls, authorizationPatch);
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
    actorId: "275060624"
  };
  const selection = {
    repository: { id: "1253231368", name: "keqi119/subscription-Saas" },
    runId: "123",
    runAttempt: 1,
    sourceSha: SHA,
    admissionJobId: "98",
    jobId: "99",
    artifactId: "77",
    artifactName: "snapshot-admission"
  };
  const facts = {
    repository: structuredClone(rootPolicy.repository),
    producerRun,
    admissionJob: {
      repository: "keqi119/subscription-Saas",
      runId: "123",
      runAttempt: 1,
      id: "98",
      name: "admission",
      status: "completed",
      conclusion: "success",
      sourceSha: SHA,
      startedAt: "2026-09-03T00:00:10Z",
      completedAt: "2026-09-03T00:00:30Z"
    },
    workflow: {
      repositoryId: "1253231368",
      path: ".github/workflows/sanitized-snapshot.yml",
      sourceSha: SHA,
      bytes: workflowBytes
    },
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
      workflow: structuredClone(rootPolicy.workflow)
    },
    artifact: {
      id: "77",
      name: "snapshot-admission",
      repositoryId: "1253231368",
      runId: "123",
      sourceSha: SHA,
      createdAt: "2026-09-03T00:00:20Z",
      bytes: Buffer.from(canonicalJson(admission))
    },
    queuedJobs: [
      {
        repository: "keqi119/subscription-Saas",
        runId: "123",
        runAttempt: 1,
        id: "99",
        name: "snapshot-data",
        status: "waiting",
        labels: ["self-hosted", "linux", "x64", "stage1-snapshot-export", admission.route.label]
      }
    ],
    usedRouteNonces: []
  };
  const githubObservations = {
    selection,
    async readExact(request) {
      calls.github += 1;
      assert.deepEqual(request, selection);
      return facts;
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
    revoke: valid.revoke,
    facts,
    selection
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

const signFixture = (f) =>
  verifyAndSignSnapshotAdmission({
    admission: f.admission,
    dispatchVerification: f.dispatchVerification,
    githubObservations: f.githubObservations,
    rootPolicy: f.rootPolicy,
    privateKeyFd: f.privateKeyFd
  });
const noPrivilege = (f) => {
  assert.equal(f.calls.key, 0);
  assert.equal(f.calls.jit, 0);
};

test("real artifact metadata binds through the unique declared uploader without invented job fields", async () => {
  const f = fixture();
  assert.equal(Object.hasOwn(f.facts.artifact, "jobId"), false);
  assert.equal(Object.hasOwn(f.facts.artifact, "runAttempt"), false);
  const verified = await signFixture(f);
  assert.equal(verified.snapshotAdmissionDigest, sha256Canonical(f.admission));
  assert.equal(f.calls.key, 1);
});

test("artifact must be created inside the actual completed admission job window", async () => {
  for (const mutate of [
    (f) => {
      f.facts.artifact.createdAt = "2026-09-03T00:00:09Z";
    },
    (f) => {
      f.facts.artifact.createdAt = "2026-09-03T00:00:31Z";
    },
    (f) => {
      f.facts.admissionJob.startedAt = "2026-09-03T00:00:31Z";
    },
    (f) => {
      f.facts.artifact.createdAt = "2026-02-30T00:00:20Z";
    }
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(signFixture(f), { code: "SNAPSHOT_ADMISSION_OBSERVATION_INVALID" });
    noPrivilege(f);
  }
});

test("protected workflow bytes must declare one immutable admission uploader in the three-job chain", async () => {
  const source = fixture().facts.workflow.bytes.toString();
  for (const altered of [
    source.replace(uploadStep, ""),
    source.replace(uploadStep, uploadStep + uploadStep),
    source.replace(uploadStep, "") + uploadStep,
    source.replace("name: snapshot-admission", "name: ${{ inputs.artifact }}"),
    source.replace("overwrite: false", "overwrite: true"),
    source.replace("    needs: snapshot-data", "    needs: admission"),
    source.replace(
      "  admission:\n",
      "  admission:\n    strategy:\n      matrix:\n        os: ubuntu-latest\n"
    )
  ]) {
    const f = fixture(altered);
    await assert.rejects(signFixture(f), { code: "SNAPSHOT_ADMISSION_WORKFLOW_INVALID" });
    noPrivilege(f);
  }
});

test("independent selection denies wrong actor, job, artifact and workflow provenance", async () => {
  for (const mutate of [
    (f) => {
      f.facts.producerRun.actorId = "1";
    },
    (f) => {
      f.facts.artifact.runId = "124";
    },
    (f) => {
      f.facts.artifact.runAttempt = 2;
    },
    (f) => {
      f.facts.artifact.id = "78";
    },
    (f) => {
      f.facts.artifact.jobId = "100";
    },
    (f) => {
      f.facts.artifact.jobId = "99";
    },
    (f) => {
      f.facts.admissionJob.status = "in_progress";
    },
    (f) => {
      f.facts.admissionJob.conclusion = "failure";
    },
    (f) => {
      f.facts.admissionJob.sourceSha = "e".repeat(40);
    },
    (f) => {
      f.facts.artifact.sourceSha = "e".repeat(40);
    },
    (f) => {
      f.facts.workflow.sourceSha = "e".repeat(40);
    },
    (f) => {
      f.facts.workflow.repositoryId = "2";
    },
    (f) => {
      f.selection.runId = "124";
    }
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(signFixture(f), { code: "SNAPSHOT_ADMISSION_OBSERVATION_INVALID" });
    noPrivilege(f);
  }
});

test("queued selection requires the exact five labels and a single unused run-bound nonce", async () => {
  for (const mutate of [
    (f) => {
      f.facts.queuedJobs[0].labels.pop();
    },
    (f) => {
      f.facts.queuedJobs[0].labels.push(f.admission.route.label);
    },
    (f) => {
      f.facts.queuedJobs.push({ ...structuredClone(f.facts.queuedJobs[0]), id: "100" });
    },
    (f) => {
      f.facts.queuedJobs[0].runId = "124";
    },
    (f) => {
      f.facts.queuedJobs[0].status = "in_progress";
    },
    (f) => {
      f.facts.usedRouteNonces.push(nonce);
    },
    (f) => {
      f.admission.route.nonce = "d".repeat(32);
      f.admission.route.label = `stage1-snapshot-export-123-${"d".repeat(32)}`;
      f.facts.artifact.bytes = Buffer.from(canonicalJson(f.admission));
    }
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(signFixture(f), { code: "SNAPSHOT_ROUTE_IDENTITY_INVALID" });
    noPrivilege(f);
  }
});

test("trusted reconstruction succeeds with a real branded decision and denies actual mutated run facts", async () => {
  const f = fixture();
  const decision = await verifyDispatchAuthorization(f.dispatchVerification);
  const input = {
    verifiedDispatch: decision,
    rootPolicy: f.rootPolicy,
    routeNonce: nonce,
    now: "2026-09-03T00:01:00Z",
    producerRunObservation: {
      ...f.facts.producerRun,
      jobId: "99",
      queuedJobs: f.facts.queuedJobs,
      usedRouteNonces: []
    }
  };
  assert.equal(canonicalJson(buildSnapshotAdmission(input)), canonicalJson(f.admission));
  for (const [field, value] of [
    ["runAttempt", 2],
    ["workflowRef", "tag"],
    ["event", "push"],
    ["actorId", "2"]
  ]) {
    assert.throws(
      () =>
        buildSnapshotAdmission({
          ...input,
          producerRunObservation: { ...input.producerRunObservation, [field]: value }
        }),
      { code: "SNAPSHOT_ADMISSION_INVALID" }
    );
  }
  assert.throws(() => buildSnapshotAdmission({ ...input, now: "2026-09-03T00:11:00Z" }), {
    code: "DISPATCH_EVIDENCE_EXPIRED"
  });
  noPrivilege(f);
});

test("changed admission bindings, self-signature and observation provenance fail before key", async () => {
  for (const mutate of [
    (a) => {
      a.dispatchAuthorizationDigest = `sha256:${"f".repeat(64)}`;
    },
    (a) => {
      a.releaseAttemptId = "other";
    },
    (a) => {
      a.executionPurpose = "release-candidate";
    },
    (a) => {
      a.signature = "forged";
    },
    (a) => {
      a.observation = {};
    },
    (a) => {
      a.producerRun.workflowBlobDigest = DIGEST;
    }
  ]) {
    const f = fixture();
    mutate(f.admission);
    f.facts.artifact.bytes = Buffer.from(canonicalJson(f.admission));
    await assert.rejects(signFixture(f), { code: "SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH" });
    noPrivilege(f);
  }
});

test("revocation after untrusted preparation and expired authorization fail before key", async () => {
  const f = fixture();
  const prepared = createUntrustedSnapshotAdmissionInput({
    authorization: f.dispatchVerification.authorization,
    producerRunObservation: {
      ...f.admission.producerRun,
      event: "workflow_dispatch",
      queuedLabels: ["self-hosted", "linux", "x64", "stage1-snapshot-export"]
    },
    route: { nonce, environmentPolicyIdentityDigest: f.admission.environmentPolicyIdentityDigest }
  });
  assert.equal(canonicalJson(prepared), canonicalJson(f.admission));
  f.revoke();
  await assert.rejects(signFixture(f), { code: "DISPATCH_REVOKED" });
  noPrivilege(f);
  const expired = fixture();
  expired.dispatchVerification.clock.now = () => "2026-09-03T00:11:00Z";
  await assert.rejects(signFixture(expired), { code: "DISPATCH_EVIDENCE_EXPIRED" });
  noPrivilege(expired);
});

test("validly signed wrong purpose and legacy purpose never reach signing", async () => {
  const wrong = fixture(undefined, { executionPurpose: "release-candidate" });
  await assert.rejects(signFixture(wrong), { code: "DISPATCH_BINDING_MISMATCH" });
  noPrivilege(wrong);
  const legacy = fixture(undefined, { executionPurpose: "snapshot" });
  await assert.rejects(signFixture(legacy), { code: "DISPATCH_SIGNATURE_INVALID" });
  noPrivilege(legacy);
});

test("artifact byte accessors are rejected without evaluation", async () => {
  const f = fixture();
  let getters = 0;
  Object.defineProperty(f.facts.artifact.bytes, "length", {
    get() {
      getters++;
      return 0;
    }
  });
  await assert.rejects(signFixture(f), { code: "SNAPSHOT_ADMISSION_OBSERVATION_INVALID" });
  assert.equal(getters, 0);
  noPrivilege(f);
});

test("unsupported YAML structures cannot hide actions even with matching protected byte digest", async () => {
  const action = `actions/checkout@${"d".repeat(40)}`;
  for (const source of [
    `jobs:\n  test:\n    steps:\n      - uses: ${action}\n      - "uses": other/action@main\n`,
    `jobs:\n  test:\n    steps:\n      - {uses: ${action}}\n`,
    `jobs:\n  test:\n    steps: &steps\n      - uses: ${action}\n`,
    `jobs:\n  test:\n    steps:\n      - run: |\n          uses: ${action}\n`,
    `jobs:\n  test:\n    steps:\n      - uses: \u0024{{ inputs.action }}\n`,
    `jobs:\n  test:\n    runs-on: \u0024{{ inputs.labels }} uses: other/action@main\n    steps:\n      - uses: ${action}\n`,
    `jobs:\n  test:\n    steps:\n      - uses: other/action@${"e".repeat(40)}\n`
  ]) {
    const f = fixture(source);
    await assert.rejects(signFixture(f), { code: "SNAPSHOT_ADMISSION_WORKFLOW_INVALID" });
    noPrivilege(f);
  }
});

test("closed workflow grammar accepts ordinary route expressions without treating script text as actions", async () => {
  const f = fixture(
    `name: Snapshot\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  admission:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${"d".repeat(40)}\n        with:\n          ref: \u0024{{ github.sha }}\n      - run: node scripts/uses-helper.mjs\n${uploadStep}  snapshot-data:\n    needs: admission\n    runs-on: \u0024{{ needs.admission.outputs.labels }}\n    steps:\n      - run: /usr/local/bin/stage1-snapshot-export\n  snapshot-custody:\n    needs: snapshot-data\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${"d".repeat(40)}\n`
  );
  const result = await signFixture(f);
  assert.equal(result.workflowBlobDigest, f.rootPolicy.workflow.blobDigest);
  assert.equal(f.calls.key, 1);
});

test("workflow jobs may reuse an approved action but never introduce a different commit", async () => {
  const f = fixture();
  const result = await signFixture(f);
  assert.equal(result.snapshotAdmissionDigest, sha256Canonical(f.admission));
  const source = f.facts.workflow.bytes.toString().replace(/d{40}(?![\s\S]*d{40})/, "e".repeat(40));
  const drift = fixture(source);
  await assert.rejects(signFixture(drift), { code: "SNAPSHOT_ADMISSION_WORKFLOW_INVALID" });
  noPrivilege(drift);
  const duplicatePolicy = fixture();
  duplicatePolicy.rootPolicy.workflow.actionCommits.push({
    ...duplicatePolicy.rootPolicy.workflow.actionCommits[0]
  });
  await assert.rejects(signFixture(duplicatePolicy), { code: "ENVIRONMENT_POLICY_INVALID" });
  noPrivilege(duplicatePolicy);
});

test("input snapshots isolate async mutation and captured capabilities", async () => {
  const f = fixture();
  const originalDigest = sha256Canonical(f.admission);
  const read = f.dispatchVerification.evidenceSource.readRevocationHead;
  f.dispatchVerification.evidenceSource.readRevocationHead = async (request) => {
    f.rootPolicy.rootSigner.issuer = "changed";
    f.admission.route.nonce = "f".repeat(32);
    f.facts.artifact.bytes.fill(0);
    f.facts.queuedJobs[0].labels.length = 0;
    f.privateKeyFd.readPrivateKey = () => {
      throw new Error("late replacement");
    };
    return read(request);
  };
  const result = await signFixture(f);
  assert.equal(result.snapshotAdmissionDigest, originalDigest);
  assert.equal(result.rootSigner.issuer, "root-test");
  assert.throws(() => {
    result.rootSigner.issuer = "changed";
  }, TypeError);
});

test("accessors and invalid signer identity are rejected without key or getter effects", async () => {
  const f = fixture();
  let getters = 0;
  Object.defineProperty(f.admission.route, "nonce", {
    enumerable: true,
    get() {
      getters++;
      return nonce;
    }
  });
  await assert.rejects(signFixture(f), { code: "SNAPSHOT_ADMISSION_INVALID" });
  assert.equal(getters, 0);
  noPrivilege(f);
  const invalid = fixture();
  invalid.rootPolicy.rootSigner.issuer = "";
  await assert.rejects(signFixture(invalid), { code: "SNAPSHOT_ADMISSION_POLICY_INVALID" });
  noPrivilege(invalid);
  const wrong = fixture();
  wrong.rootPolicy.rootSigner.publicKey = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "pem"
  });
  await assert.rejects(signFixture(wrong), { code: "SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID" });
  noPrivilege(wrong);
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

test("noncanonical and duplicate-key original admission bytes fail before key", async () => {
  for (const change of [
    (bytes) => Buffer.concat([bytes, Buffer.from(" ")]),
    (bytes) => Buffer.from(bytes.toString().replace("{", '{"executionPurpose":"evil",'))
  ]) {
    const f = fixture();
    f.facts.artifact.bytes = change(f.facts.artifact.bytes);
    await assert.rejects(signFixture(f), { code: "SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH" });
    noPrivilege(f);
  }
});
