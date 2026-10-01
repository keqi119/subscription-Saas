import assert from "node:assert/strict";
import test from "node:test";

import { validateContract } from "../src/index.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-09-04T00:00:00.000Z";

const validIdentity = {
  schemaVersion: "environment-policy-identity.v1",
  repository: { id: "1", name: "keqi119/subscription-Saas" },
  environment: { id: "2", name: "snapshot-data" },
  requiredReviewerId: "3",
  branchPolicy: { protectedBranches: ["main"], tagRules: [] },
  canAdminsBypass: false,
  preventSelfReview: false,
  allowedActorId: "4",
  waitTimerSeconds: 0,
  workflowPath: ".github/workflows/sanitized-snapshot.yml",
  workflowBlobDigest: DIGEST,
  actionCommitAllowlist: [{ action: "actions/checkout", commit: "b".repeat(40) }],
  canonicalizationVersion: "RFC8785"
};

const validAdmission = {
  schemaVersion: "snapshot-admission.v1",
  dispatchAuthorizationDigest: DIGEST,
  releaseAttemptId: "attempt-1",
  executionPurpose: "qualification",
  producerRun: {
    repository: "keqi119/subscription-Saas",
    runId: "123",
    runAttempt: 1,
    workflowPath: ".github/workflows/sanitized-snapshot.yml",
    workflowRef: "main",
    workflowBlobDigest: DIGEST,
    sourceSha: "b".repeat(40)
  },
  route: { nonce: "c".repeat(32), label: `stage1-snapshot-export-123-${"c".repeat(32)}` },
  adapterDigest: DIGEST,
  environmentPolicyIdentityDigest: DIGEST
};

const purposeDispatch = {
  schemaVersion: "rc-dispatch-authorization.v1",
  authorizationId: "authorization-purpose-test",
  executionPurpose: "qualification",
  releaseAttemptId: validAdmission.releaseAttemptId,
  sourceSha: validAdmission.producerRun.sourceSha,
  producerWorkflow: {
    path: ".github/workflows/sanitized-snapshot.yml",
    ref: "main",
    blobDigest: DIGEST
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
  issuer: "unit-test-only",
  issuedAt: NOW,
  notAfter: "2026-09-04T01:00:00.000Z",
  revocationPolicyDigest: DIGEST
};

function assertSchemaInvalidAdditionalProperties(schemaId, value) {
  assert.throws(
    () => validateContract(schemaId, value),
    (error) =>
      error?.code === "CONTRACT_SCHEMA_INVALID" &&
      error.details?.errors?.some(({ keyword }) => keyword === "additionalProperties")
  );
}

test("environment identity cannot contain observation time", () => {
  validateContract("environment-policy-identity.v1", validIdentity);
  assertSchemaInvalidAdditionalProperties("environment-policy-identity.v1", {
    ...validIdentity,
    observedAt: NOW
  });
});

test("environment identity permits the approved self-review exception", () => {
  assert.doesNotThrow(() => validateContract("environment-policy-identity.v1", validIdentity));
});

test("environment identity rejects the unapproved true self-review value", () => {
  assert.throws(
    () =>
      validateContract("environment-policy-identity.v1", {
        ...validIdentity,
        preventSelfReview: true
      }),
    { code: "CONTRACT_SCHEMA_INVALID" }
  );
});

test("environment identity rejects missing and non-boolean self-review values", () => {
  const { preventSelfReview: _removed, ...identityWithoutPreventSelfReview } = validIdentity;
  for (const candidate of [
    identityWithoutPreventSelfReview,
    ...[null, 0, "false", [], {}].map((preventSelfReview) => ({
      ...validIdentity,
      preventSelfReview
    }))
  ]) {
    assert.throws(() => validateContract("environment-policy-identity.v1", candidate), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  }
});

test("admission cannot reference a future observation", () => {
  validateContract("snapshot-admission.v1", validAdmission);
  assertSchemaInvalidAdditionalProperties("snapshot-admission.v1", {
    ...validAdmission,
    environmentPolicyObservationDigest: DIGEST
  });
});

test("dispatch and admission share the approved closed purpose vocabulary", () => {
  for (const value of [purposeDispatch, validAdmission]) {
    for (const executionPurpose of ["qualification", "release-candidate"]) {
      validateContract(value.schemaVersion, { ...value, executionPurpose });
    }
    for (const executionPurpose of ["stage1-qualification", "", "production"]) {
      assert.throws(() => validateContract(value.schemaVersion, { ...value, executionPurpose }), {
        code: "CONTRACT_SCHEMA_INVALID"
      });
    }
  }
});

test("producer completion rejects self-reported future workflow terminal state", () => {
  const completion = {
    schemaVersion: "snapshot-producer-completion.v1",
    snapshotAdmissionVerificationDigest: DIGEST,
    producerRun: {
      repository: "keqi119/subscription-Saas",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      sourceSha: "b".repeat(40)
    },
    dataJob: { id: "4", name: "snapshot-data" },
    dataExportDigest: DIGEST,
    scanReportDigest: DIGEST,
    encryptedObject: {
      objectDigest: DIGEST,
      objectVersion: "v1",
      custodyReference: "custody://object"
    },
    cryptoUseProofDigest: DIGEST,
    publisherUseProofDigest: DIGEST,
    destructionReceiptDigest: DIGEST,
    dataCustodyReceiptDigest: DIGEST
  };
  validateContract("snapshot-producer-completion.v1", completion);
  for (const field of [
    "runTerminalState",
    "custodyJobTerminalState",
    "producerTerminalObservationDigest"
  ]) {
    assertSchemaInvalidAdditionalProperties("snapshot-producer-completion.v1", {
      ...completion,
      [field]: DIGEST
    });
  }
});

test("terminal observation rejects non-success runs and required job conclusions", () => {
  const observation = {
    schemaVersion: "producer-terminal-observation.v1",
    snapshotProducerCompletionDigest: DIGEST,
    producerRun: {
      repository: "keqi119/subscription-Saas",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      sourceSha: "b".repeat(40),
      status: "completed",
      conclusion: "success"
    },
    requiredJobs: [
      { id: "1", name: "snapshot-admission", status: "completed", conclusion: "success" },
      { id: "2", name: "snapshot-data", status: "completed", conclusion: "success" },
      { id: "3", name: "snapshot-custody", status: "completed", conclusion: "success" }
    ],
    githubApiReadback: { responseDigest: DIGEST, observedAt: NOW },
    externalCustodyReadback: {
      reference: "custody://object",
      contentDigest: DIGEST,
      observedAt: NOW
    }
  };
  validateContract("producer-terminal-observation.v1", observation);
  for (const [name, mutate] of [
    [
      "PRODUCER_RUN_NOT_TERMINAL_SUCCESS",
      (v) => {
        v.producerRun.status = "in_progress";
      }
    ],
    [
      "cancelled run",
      (v) => {
        v.producerRun.conclusion = "cancelled";
      }
    ],
    [
      "rerun attempt",
      (v) => {
        v.producerRun.runAttempt = 2;
      }
    ],
    [
      "missing required job",
      (v) => {
        v.requiredJobs.pop();
      }
    ],
    [
      "extra required job",
      (v) => {
        v.requiredJobs.push(v.requiredJobs[0]);
      }
    ],
    [
      "wrong required job set",
      (v) => {
        v.requiredJobs[2].name = "unrelated-job";
      }
    ],
    [
      "caller success without independent API metadata",
      (v) => {
        delete v.githubApiReadback;
      }
    ],
    [
      "missing API digest",
      (v) => {
        delete v.githubApiReadback.responseDigest;
      }
    ],
    [
      "missing API time",
      (v) => {
        delete v.githubApiReadback.observedAt;
      }
    ],
    [
      "missing external custody",
      (v) => {
        delete v.externalCustodyReadback;
      }
    ],
    ...[1, 2].flatMap((job) =>
      ["skipped", "cancelled", "UNKNOWN"].map((conclusion) => [
        `job ${job} ${conclusion}`,
        (v) => {
          v.requiredJobs[job].conclusion = conclusion;
        }
      ])
    )
  ]) {
    const invalid = structuredClone(observation);
    mutate(invalid);
    assert.throws(
      () => validateContract("producer-terminal-observation.v1", invalid),
      { code: "CONTRACT_SCHEMA_INVALID" },
      name
    );
  }
});

const validObservation = {
  schemaVersion: "environment-policy-observation.v1",
  environmentPolicyIdentityDigest: DIGEST,
  phase: "approved-queued",
  observedAt: NOW,
  apiResponseDigest: DIGEST,
  deployment: { id: "1", state: "approved" },
  run: {
    repository: "keqi119/subscription-Saas",
    runId: "123",
    runAttempt: 1,
    workflowPath: ".github/workflows/sanitized-snapshot.yml",
    workflowRef: "main",
    sourceSha: "b".repeat(40)
  },
  job: { id: "2", name: "snapshot-data", status: "queued", labels: [validAdmission.route.label] },
  review: { reviewerId: "3", state: "approved" }
};

test("observation phases reject inconsistent deployment, review, job and missing labels", () => {
  for (const phase of ["pending", "approved-queued"]) {
    const valid = structuredClone(validObservation);
    valid.phase = phase;
    valid.deployment.state = valid.review.state = phase === "pending" ? "pending" : "approved";
    validateContract(valid.schemaVersion, valid);
    for (const mutate of [
      (v) => {
        v.deployment.state = phase === "pending" ? "approved" : "pending";
      },
      (v) => {
        v.review.state = phase === "pending" ? "approved" : "pending";
      },
      (v) => {
        v.job.status = "in_progress";
      },
      (v) => {
        v.job.labels = [];
      },
      (v) => {
        v.run.runAttempt = 2;
      }
    ]) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      assert.throws(() => validateContract(valid.schemaVersion, invalid), {
        code: "CONTRACT_SCHEMA_INVALID"
      });
    }
  }
});

test("new observation timestamps reject nonfinite and impossible calendar values", () => {
  validateContract(validObservation.schemaVersion, validObservation);
  for (const observedAt of [
    "2026-99-99TgarbageZ",
    "2026-02-30T00:00:00.000Z",
    "2026-09-04T24:00:00.000Z",
    "2026-09-04T00:00:60.000Z",
    "Infinity"
  ]) {
    assert.throws(
      () => validateContract(validObservation.schemaVersion, { ...validObservation, observedAt }),
      { code: "CONTRACT_SCHEMA_INVALID" },
      observedAt
    );
  }
});

test("all newly introduced timestamp fields enforce finite RFC3339 without tightening published v1", async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  // Exercise the exact production timestamp definitions in small valid schemas.
  for (const id of [
    "environment-policy-observation.v1",
    "producer-terminal-observation.v1",
    "snapshot-jit-launch-proof.v1",
    "rc-dispatch-authorization.v1",
    "infrastructure-change.v1",
    "external-change-approval.v1"
  ]) {
    const schema = JSON.parse(
      await readFile(
        new URL(`../../../release/contracts/schemas/${id}.schema.json`, import.meta.url),
        "utf8"
      )
    );
    const timestamp = schema.$defs?.timestamp ?? schema.properties.createdAt;
    const root = await mkdtemp(path.join(tmpdir(), "routing-time-"));
    try {
      const directory = path.join(root, "release/contracts/schemas");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "timestamp-test.v1.schema.json"),
        JSON.stringify({ $id: "timestamp-test.v1", ...timestamp })
      );
      validateContract("timestamp-test.v1", NOW, { repoRoot: root });
      for (const invalid of [
        "2026-99-99TgarbageZ",
        "2026-02-30T00:00:00.000Z",
        "2026-09-04T24:00:00.000Z"
      ]) {
        assert.throws(
          () => validateContract("timestamp-test.v1", invalid, { repoRoot: root }),
          { code: "CONTRACT_SCHEMA_INVALID" },
          id
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
