import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { publishR3SnapshotFixture } from "../../packages/release-foundation/test/r3-snapshot-input-fixture.mjs";
import { buildH1CryptoUseProof } from "./snapshot-h1-data-proof.mjs";
import {
  buildH1SnapshotDestructionSubject,
  buildH1SnapshotPublisherUseSubject
} from "./snapshot-h1-publication.mjs";
import {
  buildH1FinalSnapshotCustody,
  buildH1SnapshotCompletion,
  buildH1SnapshotTerminalObservation
} from "./snapshot-h1-completion.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const observedAt = "2026-10-06T01:04:00.000Z";
const sourceSha = "b".repeat(40);
const workflowPath = ".github/workflows/sanitized-snapshot.yml";
const repository = "keqi119/subscription-Saas";

function completion() {
  return {
    schemaVersion: "snapshot-producer-completion.v1",
    snapshotAdmissionVerificationDigest: digest("a"),
    producerRun: { repository, runId: "12345", runAttempt: 1, workflowPath, sourceSha },
    dataJob: { id: "102", name: "snapshot-data" },
    dataExportDigest: digest("b"),
    scanReportDigest: digest("c"),
    encryptedObject: {
      objectDigest: digest("d"),
      objectVersion: "null-version-disabled",
      custodyReference: "oss://bucket/snapshot.enc?versionId=null-version-disabled"
    },
    cryptoUseProofDigest: digest("e"),
    publisherUseProofDigest: digest("f"),
    destructionReceiptDigest: digest("1"),
    dataCustodyReceiptDigest: digest("2")
  };
}

function github() {
  const selection = {
    repository: { id: "1253231368", name: repository },
    runId: "12345",
    runAttempt: 1,
    sourceSha,
    admissionJobId: "101",
    jobId: "102",
    custodyJobId: "103"
  };
  const run = {
    id: 12345,
    run_attempt: 1,
    head_sha: sourceSha,
    path: workflowPath,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: "main",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    updated_at: "2026-10-06T01:03:00.000Z"
  };
  const jobs = ["admission", "snapshot-data", "snapshot-custody"].map((name, index) => ({
    id: 101 + index,
    name,
    run_id: 12345,
    run_attempt: 1,
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
    completed_at: `2026-10-06T01:0${index}:00.000Z`
  }));
  return { selection, run, jobs, observedAt };
}

function input() {
  const value = completion();
  return {
    completion: value,
    githubTerminalReadback: github(),
    externalCompletionReadback: {
      reference: "control-evidence/v1/snapshot-producer-completion.v1/actual",
      bytes: Buffer.from(canonicalJson(value)),
      observedAt: "2026-10-06T01:05:00.000Z"
    }
  };
}

test("projects terminal from exact three-job GitHub read and independent canonical completion GET", () => {
  const facts = input();
  const value = buildH1SnapshotTerminalObservation(facts);
  assert.equal(value.snapshotProducerCompletionDigest, sha256Canonical(facts.completion));
  assert.deepEqual(
    value.requiredJobs.map(({ name }) => name),
    ["admission", "snapshot-data", "snapshot-custody"]
  );
  assert.deepEqual(value.githubApiReadback, {
    responseDigest: sha256Canonical({
      run: facts.githubTerminalReadback.run,
      jobs: facts.githubTerminalReadback.jobs
    }),
    observedAt
  });
  assert.equal(
    value.externalCustodyReadback.contentDigest,
    sha256Bytes(facts.externalCompletionReadback.bytes)
  );
});

test("rejects cross-run, altered proof bytes, provisional success assertion and impossible observation order", () => {
  const changes = [
    (value) => {
      value.githubTerminalReadback.selection.runId = "12346";
    },
    (value) => {
      value.githubTerminalReadback.jobs[1].id = 999;
    },
    (value) => {
      value.githubTerminalReadback.run.conclusion = "cancelled";
    },
    (value) => {
      value.githubTerminalReadback.success = true;
    },
    (value) => {
      value.externalCompletionReadback.bytes = Buffer.from(
        canonicalJson({ ...value.completion, cryptoUseProofDigest: digest("3") })
      );
    },
    (value) => {
      value.externalCompletionReadback.observedAt = "2026-10-06T01:02:00.000Z";
    }
  ];
  for (const change of changes) {
    const value = input();
    change(value);
    assert.throws(() => buildH1SnapshotTerminalObservation(value), {
      code: "H1_SNAPSHOT_COMPLETION_REJECTED"
    });
  }
});

function finalReadback() {
  const releaseAttemptId = "11111111-2222-4333-8444-555555555555";
  const key = `snapshot-slots/v2/${releaseAttemptId}/12345/snapshot.enc`;
  const read = {
    key,
    version: "null-version-disabled",
    etag: '"etag-one"',
    digest: digest("a"),
    sizeBytes: 8192,
    lastModified: "2026-10-06T00:01:00.000Z"
  };
  return {
    status: "READBACK_VERIFIED",
    data: {
      data: {
        envelope: {
          releaseAttemptId,
          snapshotRunId: "12345",
          sourceSha,
          ciphertextDigest: digest("a"),
          ciphertextSizeBytes: 8192,
          expiresAt: "2026-11-05T00:00:00.000Z"
        }
      }
    },
    publication: { objects: [{ key, requestId: "actual-put" }] },
    observedAt: "2026-10-06T01:05:00.000Z",
    observations: [
      {
        get: { ...read },
        head: { ...read },
        expectedWriterArn: "snapshot-publisher-session",
        readerArn: "snapshot-reader-session",
        bucket: { acl: "private", worm: { id: "actual-worm", state: "Locked", retentionDays: 210 } }
      }
    ]
  };
}

test("derives final custody only from a later independent snapshot readback and terminal GitHub read", () => {
  const input = {
    expected: {
      releaseAttemptId: "11111111-2222-4333-8444-555555555555",
      snapshotRunId: "12345",
      sourceSha
    },
    githubTerminalReadback: github(),
    finalSnapshotReadback: finalReadback(),
    accessPolicyDigest: digest("4")
  };
  const result = buildH1FinalSnapshotCustody(input);
  assert.equal(result.provisional, false);
  assert.equal(result.terminalAt, observedAt);
  assert.equal(result.worm.readbackAt, input.finalSnapshotReadback.observedAt);
  assert.equal(result.authoritativeObservationDigest, sha256Canonical(input.finalSnapshotReadback));
  for (const change of [
    (value) => {
      value.finalSnapshotReadback.observedAt = "2026-10-06T01:02:00.000Z";
    },
    (value) => {
      value.expected.snapshotRunId = "12346";
    },
    (value) => {
      value.githubTerminalReadback.jobs[2].conclusion = "skipped";
    },
    (value) => {
      value.githubTerminalReadback.success = true;
    }
  ]) {
    const invalid = globalThis.structuredClone(input);
    change(invalid);
    assert.throws(() => buildH1FinalSnapshotCustody(invalid), {
      code: "H1_SNAPSHOT_COMPLETION_REJECTED"
    });
  }
});

test("assembles completion from signed H1 originals and rejects wrapper tampering or a different data job", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "h1-completion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await publishR3SnapshotFixture({
    root,
    profile: { ownerId: "fixture-owner", storage: { archiveRoot: join(root, "archive") } }
  });
  const { metadata, scan, producerAuthorization: authorization, envelope } = fixture.s;
  const releaseAttemptId = "11111111-2222-4333-8444-555555555555";
  authorization.releaseAttemptId = envelope.releaseAttemptId = releaseAttemptId;
  authorization.localKey.context.releaseAttemptId = envelope.context.releaseAttemptId =
    releaseAttemptId;
  authorization.localKey.contextDigest = envelope.contextDigest = sha256Canonical(envelope.context);
  envelope.slotObjectKey = `snapshot-slots/v2/${releaseAttemptId}/${envelope.snapshotRunId}/snapshot.enc`;
  const aad = { ...envelope.gcmAad };
  delete aad.digest;
  aad.releaseAttemptId = releaseAttemptId;
  aad.contextDigest = envelope.contextDigest;
  envelope.gcmAad = { ...aad, digest: sha256Canonical(aad) };
  envelope.authorizationDigest = sha256Canonical(authorization);
  const before = "2026-09-03T00:01:00.000Z";
  const after = "2026-09-03T00:02:00.000Z";
  const expired = "2026-09-03T00:10:00.000Z";
  const expected = {
    releaseAttemptId,
    snapshotRunId: authorization.snapshotRunId,
    sourceSha: authorization.sourceSha,
    dispatchAuthorizationDigest: authorization.bindings.dispatchAuthorizationDigest
  };
  const runningJobObservation = {
    run: { id: expected.snapshotRunId, runAttempt: 1, sourceSha: expected.sourceSha },
    job: { id: "102", name: "snapshot-data" }
  };
  const memory = (time) => ({
    observedAt: time,
    hostSwapDisabled: true,
    coreDumpDisabled: true,
    swapTableDigest: sha256Canonical([]),
    corePatternDigest: sha256Canonical("|/bin/false"),
    coreLimit: [0, 0]
  });
  const observation = {
    attemptId: releaseAttemptId,
    snapshotRunId: expected.snapshotRunId,
    authorizationDigest: sha256Canonical(authorization),
    workerBundleDigest: authorization.bindings.cryptoExecutableDigest,
    issuedAt: before,
    expiresAt: expired,
    memoryBefore: memory(before),
    memoryAfter: memory(after),
    processExit: {
      workerId: "a".repeat(64),
      image:
        "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0",
      startedAt: before,
      finishedAt: after,
      observedAt: after,
      exitCode: 0,
      signal: null,
      oomKilled: false,
      stdoutClosed: true,
      toolExitCode: 0
    }
  };
  const cleanup = Object.fromEntries(
    [
      "runnerStopped",
      "controlStopped",
      "producerStopped",
      "runnerNotRoutable",
      "githubTokenRevoked",
      "volumeDestroyed"
    ].map((name) => [name, true])
  );
  const volume = {
    attemptId: releaseAttemptId,
    destroyed: true,
    keyslotsBefore: [0],
    keyslotsAfter: [],
    oldKeyRejected: true,
    luksUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    destroyedAt: after
  };
  const base = `/var/lib/subscription-saas/snapshot-volumes/${releaseAttemptId}`;
  const disposal = {
    producerCleanup: {
      observedAt: after,
      workerContainerRemoved: true,
      targetContainerRemoved: true,
      accessReferencesCleared: true,
      sourceReader: {
        databaseOid: "16384",
        systemIdentifier: "7661173341297905697",
        readerOid: "85641",
        login: false,
        authenticationPresent: false,
        sessions: 0
      }
    },
    residualScan: {
      performedAt: after,
      plaintextArtifactsFound: 0,
      pathsChecked: [
        `${base}.mnt`,
        `${base}.luks`,
        `/dev/mapper/subscription-s1-${releaseAttemptId}`,
        `/var/lib/subscription-saas/snapshot-output/${releaseAttemptId}`
      ]
    }
  };
  const terminalObservation = {
    observedAt: after,
    disposalObservationDigest: sha256Canonical(disposal),
    cleanupFactsDigest: sha256Canonical(cleanup),
    volumeObservationDigest: sha256Canonical(volume),
    runningJobObservationDigest: sha256Canonical(runningJobObservation)
  };
  const data = {
    status: "COMPLETE",
    metadata,
    scan,
    envelope,
    ciphertextPath: "/fixture/snapshot.enc",
    privilegeObservation: {},
    fingerprintObservation: {},
    cryptoOperation: {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      action: "local:GenerateAndWrapDataKey",
      callCount: 1,
      outcome: "SUCCESS",
      startedAt: before,
      finishedAt: after,
      envelopeDigest: sha256Canonical(envelope),
      keyBufferClear: "BEST_EFFORT_COMPLETED"
    },
    keyCleanup: {
      tokenizationKeyBufferCleared: true,
      workspaceKeyBufferCleared: true,
      observedAt: after
    }
  };
  const proof = buildH1CryptoUseProof({
    authorization,
    data,
    observation,
    terminal: terminalObservation,
    cleanup,
    volume,
    disposal
  });
  const keys = generateKeyPairSync("ed25519");
  const signer = {
    issuer: authorization.issuer.issuerId,
    keyId: sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" })),
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" })
  };
  const signature = (domain, subject) => ({
    algorithm: "Ed25519",
    issuer: signer.issuer,
    keyId: signer.keyId,
    subjectDigest: sha256Canonical(subject),
    signature: sign(
      null,
      Buffer.from(canonicalJson({ domain, subject })),
      keys.privateKey
    ).toString("base64")
  });
  const admission = {
    schemaVersion: "snapshot-admission.v1",
    releaseAttemptId,
    dispatchAuthorizationDigest: expected.dispatchAuthorizationDigest,
    executionPurpose: "qualification",
    producerRun: {
      repository,
      runId: expected.snapshotRunId,
      runAttempt: 1,
      workflowPath,
      workflowRef: "main",
      workflowBlobDigest: digest("5"),
      sourceSha: expected.sourceSha
    },
    route: {
      nonce: "a".repeat(32),
      label: `stage1-snapshot-export-${expected.snapshotRunId}-${"a".repeat(32)}`
    },
    adapterDigest: authorization.bindings.adapterExecutableDigest,
    environmentPolicyIdentityDigest: digest("6")
  };
  const admissionUnsigned = {
    schemaVersion: "snapshot-admission-verification.v1",
    snapshotAdmissionDigest: sha256Canonical(admission),
    environmentPolicyIdentityDigest: admission.environmentPolicyIdentityDigest,
    githubApiResponseDigest: digest("7"),
    workflowBlobDigest: admission.producerRun.workflowBlobDigest,
    rootSigner: { issuer: signer.issuer, keyId: signer.keyId, algorithm: "Ed25519" }
  };
  const admissionVerification = {
    ...admissionUnsigned,
    signature: sign(
      null,
      Buffer.from(
        canonicalJson({
          domain: "snapshot-admission-verification.v1",
          verification: admissionUnsigned
        })
      ),
      keys.privateKey
    ).toString("base64")
  };
  const result = {
    status: "DATA_PREPARED",
    cryptoAuthorization: authorization,
    admission,
    admissionVerification,
    runningJobObservation,
    data,
    executionObservation: observation,
    terminalObservation,
    cleanup,
    volumeObservation: volume,
    disposalObservation: disposal
  };
  const dataResultBytes = Buffer.from(canonicalJson(result));
  const sealedSubject = { proof, dataResultDigest: sha256Bytes(dataResultBytes) };
  const sealed = {
    ...sealedSubject,
    signature: signature("h1-snapshot-data-proof.v1", sealedSubject)
  };
  const proofBytes = Buffer.from(canonicalJson(sealed));
  const prefix = `snapshot-slots/v2/${releaseAttemptId}/${expected.snapshotRunId}/`;
  const writerArn = `acs:ram::1457643390906675:role/subscription-saas-stage1-snapshot-publisher/stage1-publisher-${expected.snapshotRunId}-attempt-1`;
  const assumedWriterArn = writerArn.replace(":role/", ":assumed-role/");
  const objects = [
    ["snapshot.enc", envelope.ciphertextDigest, envelope.ciphertextSizeBytes],
    [
      "encryption-envelope.json",
      sha256Canonical(envelope),
      Buffer.byteLength(canonicalJson(envelope))
    ],
    ["snapshot-proof.json", sha256Bytes(proofBytes), proofBytes.length],
    ["data-result.json", sha256Bytes(dataResultBytes), dataResultBytes.length]
  ].map(([name, contentDigest, sizeBytes]) => {
    const key = prefix + name;
    return {
      key,
      digest: contentDigest,
      sizeBytes,
      requestId: "fixture-put",
      etag: '"fixture-etag"',
      putObservation: {
        record: {
          recordVersion: "r3-snapshot-oss-response.v1",
          operation: "PutObject",
          bucket: "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai",
          objectKey: key,
          principal: assumedWriterArn,
          observedAt: after,
          requestHeaders: { "x-oss-forbid-overwrite": "true" },
          response: {
            status: 200,
            headers: {
              date: new Date(after).toUTCString(),
              "x-oss-request-id": "fixture-put",
              etag: '"fixture-etag"'
            },
            body: { digest: sha256Bytes(Buffer.alloc(0)), bytes: 0 }
          }
        },
        bodyBase64: ""
      }
    };
  });
  const publication = {
    ...expected,
    writerArn,
    writerIdentityOriginal: {
      AccountId: "1457643390906675",
      Arn: assumedWriterArn,
      IdentityType: "AssumedRoleUser",
      RequestId: "fixture-identity"
    },
    writerIssuedAt: after,
    writerExpiresAt: expired,
    cryptoExitedAt: after,
    publishedAt: after,
    objects
  };
  const publicationBytes = Buffer.from(
    canonicalJson({
      publication,
      signature: signature("h1-snapshot-publication.v1", publication)
    })
  );
  const markerKey = prefix + "diagnostics.redacted.json";
  const marker = globalThis.structuredClone(objects[0]);
  marker.key = marker.putObservation.record.objectKey = markerKey;
  marker.digest = sha256Bytes(publicationBytes);
  marker.sizeBytes = publicationBytes.length;
  const publisherTerminal = {
    status: "PUBLISHER_TERMINAL_OBSERVED",
    releaseAttemptId,
    snapshotRunId: expected.snapshotRunId,
    publicationDigest: sha256Bytes(publicationBytes),
    objects: [...objects, marker],
    writer: { arn: writerArn, issuedAt: after, expiresAt: expired },
    publishedAt: after,
    authority: { startedAt: after, finishedAt: after, exited: true, exitCode: 0 },
    publisherSession: {
      path: "/var/lib/stage1-volumes/main/snapshot-authority/publisher-session.json",
      removed: true,
      removedAt: after,
      absent: true,
      expiresAt: expired,
      observedAt: expired
    }
  };
  const terminalBytes = Buffer.from(canonicalJson(publisherTerminal));
  const destructionInput = {
    dataResultBytes,
    proofBytes,
    publicationBytes,
    terminalBytes,
    expected,
    signer,
    issuedAt: expired
  };
  const destruction = buildH1SnapshotDestructionSubject(destructionInput);
  const destructionBytes = Buffer.from(
    canonicalJson({
      ...destruction,
      signature: signature("h1-snapshot-destruction.v1", destruction)
    })
  );
  const publisher = buildH1SnapshotPublisherUseSubject(destructionInput);
  const publisherUseBytes = Buffer.from(
    canonicalJson({
      ...publisher,
      signature: signature("h1-snapshot-publisher-use.v1", publisher)
    })
  );
  const githubTerminalReadback = github();
  githubTerminalReadback.selection.runId = expected.snapshotRunId;
  githubTerminalReadback.run.id = Number(expected.snapshotRunId);
  githubTerminalReadback.jobs.forEach((job) => {
    job.run_id = Number(expected.snapshotRunId);
  });
  githubTerminalReadback.observedAt = "2026-09-03T00:12:00.000Z";
  githubTerminalReadback.run.updated_at = "2026-09-03T00:11:00.000Z";
  githubTerminalReadback.jobs.forEach((job, index) => {
    job.completed_at = `2026-09-03T00:0${index + 3}:00.000Z`;
  });
  const read = {
    key: envelope.slotObjectKey,
    version: "null-version-disabled",
    etag: '"fixture-etag"',
    digest: envelope.ciphertextDigest,
    sizeBytes: envelope.ciphertextSizeBytes,
    lastModified: "2026-09-03T00:03:00.000Z"
  };
  const finalSnapshotReadback = {
    status: "READBACK_VERIFIED",
    publication,
    data: result,
    proof: sealed,
    observedAt: "2026-09-03T00:13:00.000Z",
    observations: [
      {
        get: { ...read },
        head: { ...read },
        expectedWriterArn: assumedWriterArn,
        readerArn: "acs:ram::1457643390906675:assumed-role/snapshot-consumer/fixture",
        bucket: {
          acl: "private",
          worm: { id: "fixture-worm", state: "Locked", retentionDays: 210 }
        }
      }
    ]
  };
  const input = {
    expected,
    signer,
    dataResultBytes,
    proofBytes,
    publicationBytes,
    terminalBytes,
    destructionBytes,
    publisherUseBytes,
    githubTerminalReadback,
    finalSnapshotReadback,
    accessPolicyDigest: digest("8")
  };
  const assembled = buildH1SnapshotCompletion(input);
  assert.equal(assembled.completion.dataJob.id, "102");
  assert.equal(assembled.completion.cryptoUseProofDigest, sha256Canonical(proof));
  assert.equal(assembled.completion.publisherUseProofDigest, sha256Canonical(publisher.proof));
  assert.equal(assembled.completion.destructionReceiptDigest, sha256Canonical(destruction.receipt));
  assert.equal(
    assembled.completion.dataCustodyReceiptDigest,
    sha256Canonical(assembled.finalCustody)
  );
  const alteredProof = globalThis.structuredClone(publisher);
  alteredProof.proof.cryptoUseProofDigest = digest("9");
  assert.throws(
    () =>
      buildH1SnapshotCompletion({
        ...input,
        publisherUseBytes: Buffer.from(
          canonicalJson({
            ...alteredProof,
            signature: signature("h1-snapshot-publisher-use.v1", alteredProof)
          })
        )
      }),
    { code: "H1_SNAPSHOT_COMPLETION_REJECTED" }
  );
  const changedJob = globalThis.structuredClone(githubTerminalReadback);
  changedJob.selection.jobId = "999";
  changedJob.jobs[1].id = 999;
  assert.throws(() => buildH1SnapshotCompletion({ ...input, githubTerminalReadback: changedJob }), {
    code: "H1_SNAPSHOT_COMPLETION_REJECTED"
  });
});
