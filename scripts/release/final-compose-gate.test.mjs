import assert from "node:assert/strict";
import test from "node:test";

import {
  API_DATABASE_SESSION_SQL,
  assertIndependentChainEvidence,
  assertLegalFinalComposeRetry,
  buildFinalComposeEvidence,
  executeFinalComposeGate,
  releaseImageReferences,
  runFinalComposeCli,
  verifyApiDatabaseSession
} from "./run-final-compose-gate.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const uuid = (character) =>
  `${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-8${character.repeat(3)}-${character.repeat(12)}`;

function buildProof(overrides = {}) {
  const sourceSha = "a".repeat(40);
  return {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      sourceSha,
      migrationCatalogDigest: digest("1"),
      repositoryContractDigest: digest("2"),
      images: {
        api: image("api", "3", sourceSha),
        web: image("web", "4", sourceSha),
        runner: image("runner", "5", sourceSha)
      },
      ...overrides
    },
    provenance: {
      generatedAt: "2026-09-03T00:00:00.000Z",
      ciRunRef: "github://runs/100/attempts/1",
      attestationRef: "github://attestations/build-100",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest("6") }],
      materials: [{ name: "builder", reference: "github://builder/1" }],
      registryResolutionEvidenceDigest: digest("7")
    }
  };
}

function image(name, character, sourceRevision) {
  return {
    name,
    registry: `ghcr.io/example/subscription-${name}`,
    platform: "linux/amd64",
    imageDigest: digest(character),
    sourceRevision
  };
}

function evidence(chain, character) {
  const proof = buildProof();
  return buildFinalComposeEvidence({
    chain,
    buildProof: proof,
    sourceGateEvidenceDigest: digest(chain === "fresh" ? "8" : "7"),
    manifestDigest: digest(character),
    manifestIdentityDigest: digest(character === "9" ? "a" : "b"),
    databaseIdentityFingerprint: digest(character === "9" ? "c" : "d"),
    operationId: uuid(character === "9" ? "a" : "b"),
    runId: uuid(character === "9" ? "c" : "d"),
    attemptId: uuid(character === "9" ? "e" : "f"),
    apiManifestId: `manifest-${chain}`,
    apiSessionNonce: `session-${chain}`,
    databaseTestManifestDigest: digest("e"),
    postgresImageDigest: digest("f"),
    snapshotMetadataDigest: chain === "snapshot" ? digest("0") : null,
    compose: {
      projectName: `release-${chain}`,
      configDigest: digest(chain === "fresh" ? "1" : "0"),
      playwrightImageDigest: digest("2"),
      playwrightVersion: "1.62.1"
    },
    executions:
      chain === "fresh"
        ? {
            migration: execution("3", uuid("1")),
            verify: execution("4", uuid("2")),
            databaseTests: execution("5", uuid("3"))
          }
        : {
            migration: execution("a", uuid("4")),
            verify: execution("b", uuid("5")),
            databaseTests: execution("c", uuid("6"))
          },
    databaseTests: {
      reportDigest: digest(chain === "fresh" ? "6" : "a"),
      counts: {
        collected: 10,
        selected: 10,
        executed: 10,
        passed: 10,
        failed: 0,
        skipped: 0,
        todo: 0,
        filtered: 0,
        cancelled: 0
      }
    },
    apiReadiness: {
      healthStatus: 200,
      catalogStatus: 200,
      applicationName: `subscription-api/manifest-${chain}/session-${chain}`,
      databaseOid: chain === "fresh" ? "100" : "200",
      runtimeRole: "subscription_runtime",
      tls: true,
      sessionState: "idle",
      evidenceDigest: digest(chain === "fresh" ? "7" : "b")
    },
    apiSessionRows: [
      {
        database_oid: chain === "fresh" ? "100" : "200",
        usename: "subscription_runtime",
        application_name: `subscription-api/manifest-${chain}/session-${chain}`,
        tls: true,
        state: "idle"
      }
    ],
    webClient: {
      webOrigin: "https://release-web.example.test",
      publicApiBase: "https://release-api.example.test/api",
      embeddedApiBase: "https://release-api.example.test/api",
      actualRequestUrl: "https://release-api.example.test/api/portal/catalog/model-definitions",
      corsAllowOrigin: "https://release-web.example.test",
      responseStatus: 200,
      bundleContainsEmbeddedApiBase: true,
      evidenceDigest: digest(chain === "fresh" ? "8" : "c")
    },
    custodyReceiptDigests:
      chain === "fresh" ? [digest("9"), digest("a")] : [digest("d"), digest("e")],
    priorFailureProofDigests: [],
    producedAt: "2026-09-03T01:00:00.000Z"
  });
}

function execution(character, operationId) {
  const proofCharacter = "0123456789abcdef"[(Number.parseInt(character, 16) + 4) % 16];
  return {
    operationId,
    postStateObservationDigest: digest(character),
    executionProofDigest: digest(proofCharacter)
  };
}

test("derives the exact immutable three-image bundle from the build proof", () => {
  assert.deepEqual(releaseImageReferences(buildProof()), {
    api: `ghcr.io/example/subscription-api@${digest("3")}`,
    runner: `ghcr.io/example/subscription-runner@${digest("5")}`,
    web: `ghcr.io/example/subscription-web@${digest("4")}`
  });
});

test("rejects a valid catalog response from the wrong same-schema database", () => {
  assert.throws(
    () =>
      verifyApiDatabaseSession({
        rows: [
          {
            database_oid: "999",
            usename: "subscription_runtime",
            application_name: "subscription-api/manifest-fresh/session-fresh",
            tls: true,
            state: "idle"
          }
        ],
        expected: {
          databaseOid: "100",
          runtimeRole: "subscription_runtime",
          applicationName: "subscription-api/manifest-fresh/session-fresh",
          tls: true
        }
      }),
    { code: "API_DATABASE_SESSION_IDENTITY_MISMATCH" }
  );
});

test("rejects zero or multiple matching API sessions", () => {
  const expected = {
    databaseOid: "100",
    runtimeRole: "subscription_runtime",
    applicationName: "subscription-api/manifest-fresh/session-fresh",
    tls: true
  };
  assert.throws(() => verifyApiDatabaseSession({ rows: [], expected }), {
    code: "API_DATABASE_SESSION_IDENTITY_MISMATCH"
  });
  const row = {
    database_oid: "100",
    usename: expected.runtimeRole,
    application_name: expected.applicationName,
    tls: true,
    state: "idle"
  };
  assert.throws(() => verifyApiDatabaseSession({ rows: [row, row], expected }), {
    code: "API_DATABASE_SESSION_IDENTITY_MISMATCH"
  });
});

test("uses a read-only PostgreSQL session identity query", () => {
  assert.match(API_DATABASE_SESSION_SQL, /pg_stat_activity/u);
  assert.match(API_DATABASE_SESSION_SQL, /pg_stat_ssl/u);
  assert.match(API_DATABASE_SESSION_SQL, /current_database\(\)/u);
  assert.match(API_DATABASE_SESSION_SQL, /application_name\s*=\s*\$1/u);
  assert.doesNotMatch(API_DATABASE_SESSION_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/iu);
});

test("requires independent identities for fresh and snapshot evidence", () => {
  const fresh = evidence("fresh", "9");
  const snapshot = evidence("snapshot", "0");
  assert.equal(assertIndependentChainEvidence(fresh, snapshot), true);
  assert.throws(() => assertIndependentChainEvidence(fresh, { ...snapshot, runId: fresh.runId }), {
    code: "FINAL_COMPOSE_CHAIN_IDENTITY_REUSED"
  });
  assert.throws(
    () =>
      assertIndependentChainEvidence(fresh, {
        ...snapshot,
        compose: { ...snapshot.compose, configDigest: fresh.compose.configDigest }
      }),
    { code: "FINAL_COMPOSE_CHAIN_IDENTITY_REUSED" }
  );
});

test("rejects count-equation failures and mixed release inputs", () => {
  const valid = evidence("fresh", "9");
  assert.throws(
    () =>
      assertIndependentChainEvidence(
        structuredClone({
          ...valid,
          databaseTests: {
            ...valid.databaseTests,
            counts: { ...valid.databaseTests.counts, executed: 9 }
          }
        }),
        evidence("snapshot", "0")
      ),
    { code: "FINAL_COMPOSE_TEST_COUNTS_INVALID" }
  );
  const snapshot = structuredClone(evidence("snapshot", "0"));
  snapshot.releaseImages.api = `ghcr.io/example/subscription-api@${digest("0")}`;
  assert.throws(() => assertIndependentChainEvidence(valid, snapshot), {
    code: "FINAL_COMPOSE_RELEASE_INPUT_MISMATCH"
  });
});

test("runs final stages in order and retains an infrastructure failure before legal retry", async () => {
  const calls = [];
  const failedProof = digest("f");
  const adapters = {
    verifyCompose: async () => calls.push("compose"),
    prepareTarget: async () => calls.push("prepare"),
    runMigration: async () => calls.push("migration"),
    runVerify: async () => calls.push("verify"),
    runDatabaseTests: async () => calls.push("database-tests"),
    startApplications: async () => calls.push("applications"),
    verifyApi: async () => calls.push("api"),
    verifyWebClient: async () => calls.push("web"),
    custody: async () => calls.push("custody"),
    cleanupTarget: async () => calls.push("cleanup"),
    recordFailure: async () => assert.fail("failure recorder must not run on success")
  };
  await executeFinalComposeGate(
    { chain: "fresh", priorFailureProofDigests: [failedProof] },
    adapters
  );
  assert.deepEqual(calls, [
    "compose",
    "prepare",
    "migration",
    "verify",
    "database-tests",
    "applications",
    "api",
    "web",
    "custody",
    "cleanup"
  ]);
});

test("records a pre-write infrastructure failure and permits only a full retry of the same bundle", async () => {
  const failureProofDigest = digest("f");
  const input = {
    chain: "fresh",
    operationId: uuid("1"),
    runId: uuid("2"),
    attemptId: uuid("3")
  };
  const adapters = {
    verifyCompose: async () => {
      throw Object.assign(new Error("registry unavailable"), { code: "REGISTRY_UNAVAILABLE" });
    },
    prepareTarget: async () => {},
    runMigration: async () => {},
    runVerify: async () => {},
    runDatabaseTests: async () => {},
    startApplications: async () => {},
    verifyApi: async () => {},
    verifyWebClient: async () => {},
    custody: async () => {},
    cleanupTarget: async () => {},
    recordFailure: async (failure) => ({ ...failure, failureProofDigest })
  };
  await assert.rejects(executeFinalComposeGate(input, adapters), (error) => {
    assert.equal(error.failureRecord.failureProofDigest, failureProofDigest);
    assert.equal(error.failureRecord.databaseWritesStarted, false);
    return true;
  });

  const current = structuredClone(evidence("fresh", "9"));
  current.priorFailureProofDigests = [failureProofDigest];
  const previous = {
    terminalStatus: "FAILED",
    databaseWritesStarted: false,
    failureProofDigest,
    buildProofDigest: current.buildProofDigest,
    releaseImages: current.releaseImages,
    contracts: current.contracts,
    sourceGateEvidenceDigest: current.sourceGateEvidenceDigest,
    operationId: input.operationId,
    runId: input.runId,
    attemptId: input.attemptId
  };
  assert.equal(assertLegalFinalComposeRetry(previous, current), true);
  assert.throws(
    () =>
      assertLegalFinalComposeRetry(previous, {
        ...current,
        buildProofDigest: digest("0")
      }),
    { code: "FINAL_COMPOSE_RETRY_INPUT_MISMATCH" }
  );
});

test("production CLI refuses a precomputed final evidence input", async () => {
  await assert.rejects(
    runFinalComposeCli(["--execute", "--evidence-input-file", "precomputed.json"]),
    { code: "FINAL_COMPOSE_EXECUTION_MODE_REQUIRED" }
  );
});
