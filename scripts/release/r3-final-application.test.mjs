import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createBuildProof } from "./create-build-proof.mjs";
import { createFinalApplicationAdapters } from "./final-compose-application-adapters.mjs";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { assertBuildWebClient } from "./verify-build-proof.mjs";
import test from "node:test";
import { buildR3ApplicationPlan, executeR3FinalApplication } from "./r3-final-application.mjs";

const op = "97c61d0d-fa2c-42bb-9ba7-66f8724bc29b";
const runId = "642bcd14-e4f2-42a6-afbc-61e941c66840";
const digest = (c) => `sha256:${c.repeat(64)}`;
const sourceSha = "a".repeat(40);

function fixture() {
  const ciRunRef = "github://keqi119/subscription-Saas/actions/runs/2801";
  const image = (name, c) => {
    const repository = `ghcr.io/keqi119/subscription-${name}`;
    const imageDigest = digest(c);
    return {
      name,
      image: repository,
      platform: "linux/amd64",
      digest: imageDigest,
      sourceRevision: sourceSha,
      baseImageDigests: [
        { image: "node:22-bookworm-slim", declaredDigest: digest("1"), digest: digest("2") }
      ],
      builderName: "https://mobyproject.org/buildkit@v1",
      buildAttestationRef: `oci://${repository}@${imageDigest}#provenance=${digest("3")}`,
      registrySubject: `${repository}@${imageDigest}`,
      buildRunRef: ciRunRef
    };
  };
  const buildMaterialObservation = {
    schemaVersion: "build-material-observation.v1",
    sourceSha,
    checkoutRef: sourceSha,
    ciRunRef,
    repositoryContractDigest: digest("4"),
    migrationCatalogDigest: digest("5"),
    policyDigest: digest("6"),
    promotionEligibility: "trusted-candidate",
    images: [image("api", "7"), image("web", "8"), image("runner", "9")],
    webClient: { imageDigest: digest("8"), apiBaseUrl: "https://api.example.test/api" },
    externalActions: [{ name: "actions/checkout", commitSha: "2".repeat(40) }],
    builder: {
      name: "https://mobyproject.org/buildkit@v1",
      provenanceRef: `build-material-attestations:${digest("a")}`
    },
    observedAt: "2026-09-02T16:00:00.000Z"
  };
  const buildProof = createBuildProof({
    sourceSha,
    images: buildMaterialObservation.images,
    migrationCatalog: { digest: buildMaterialObservation.migrationCatalogDigest },
    repositoryContract: { digest: buildMaterialObservation.repositoryContractDigest },
    provenance: {
      generatedAt: "2026-09-02T16:00:00.000Z",
      ciRunRef,
      attestationRef: buildMaterialObservation.builder.provenanceRef,
      checkoutRef: sourceSha,
      buildMaterialObservation
    }
  });
  const request = {
    schemaVersion: "manual-runner-request.v5",
    phase: "final",
    chain: "fresh",
    stage: "candidate-use",
    operationId: op,
    runId,
    sourceSha,
    sessionNonce: "abcdef0123456789abcdef0123456789",
    targetPolicyDigest: digest("d"),
    candidate: { buildProofDigest: sha256Canonical(buildProof) }
  };
  const record = {
    kind: "application",
    databaseName: "s1a_final",
    databaseOid: "4242",
    marker: "r3-application",
    roles: { migrate: "s1a_migrate", "api-runtime": "s1a_runtime", verify: "s1a_verify" },
    secretReferences: { "api-runtime": `r3/${op}/database-credentials/s1a_final-api-runtime.json` }
  };
  const postgres = {
    engineId: "engine-1",
    containerId: "c".repeat(64),
    postgres: {
      serverAddress: "172.28.0.2",
      serverVersionNum: 170011,
      systemIdentifier: "7340000000000000001"
    }
  };
  const migration = {
    status: "FINAL_MIGRATION_OBSERVED",
    promotionEligible: false,
    input: {
      operationId: op,
      runId,
      phase: "final",
      chain: "fresh",
      sourceSha,
      buildProofDigest: sha256Canonical(buildProof),
      creationEvidenceDigest: digest("c"),
      assignment: { kind: "application" },
      database: {
        databaseName: record.databaseName,
        databaseOid: record.databaseOid,
        migrationRole: record.roles.migrate,
        marker: "r3-application"
      },
      postgres: {
        engineId: postgres.engineId,
        containerId: postgres.containerId,
        systemIdentifier: postgres.postgres.systemIdentifier
      },
      expectedSchemaDigest: digest("e"),
      migrationCatalogDigest: buildProof.identity.migrationCatalogDigest
    },
    schema: { expectedSchemaDigest: digest("e") },
    originals: {
      channel: {
        results: [
          {
            baseline: {
              identity: {
                migrationHead: "20260901000000_init",
                schemaDigest: digest("b")
              }
            }
          }
        ]
      }
    }
  };
  return {
    request,
    buildProof,
    buildMaterialObservation,
    postgres,
    record,
    migration,
    creationEvidenceDigest: digest("c"),
    targetPolicyRef: `release/contracts/manual-stage1-r3-target-policy.v1.json@${digest("d")}`,
    observedAt: "2026-10-01T12:00:00.000Z"
  };
}

test("builds a pinned final application plan from the actual migration and Web material", () => {
  const f = fixture();
  assert.deepEqual(
    assertBuildWebClient({
      proof: f.buildProof,
      buildMaterialObservation: f.buildMaterialObservation
    }),
    f.buildMaterialObservation.webClient
  );
  const plan = buildR3ApplicationPlan(f);
  assert.equal(plan.apiBaseUrl, f.buildMaterialObservation.webClient.apiBaseUrl);
  assert.equal(plan.identity.api.imageReference, `ghcr.io/keqi119/subscription-api@${digest("7")}`);
  assert.equal(plan.identity.apiManifestId, `r3-${op.replaceAll("-", "").slice(0, 18)}`);
  assert.equal(plan.identity.apiSessionNonce, f.request.sessionNonce.slice(0, 24));
  assert.deepEqual(plan.target, {
    databaseName: "s1a_final",
    databaseOid: "4242",
    runtimeRole: "s1a_runtime"
  });
  assert.equal(plan.manifest.identity.preMigrationHead, "20260901000000_init");
  assert.equal(plan.migrationObservationDigest, sha256Canonical(f.migration));
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.manifest.identity));
  f.migration.originals.channel.results[0].baseline.identity.migrationHead = null;
  assert.equal(buildR3ApplicationPlan(f).manifest.identity.preMigrationHead, null);
});

test("rejects mismatched build material, database, and migration assignment", () => {
  for (const mutate of [
    (f) => {
      f.buildMaterialObservation.webClient.apiBaseUrl = "https://foreign.example.test/api";
    },
    (f) => {
      f.migration.input.database.databaseOid = "4243";
    },
    (f) => {
      f.migration.input.assignment.kind = "suite";
    }
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => buildR3ApplicationPlan(f), { code: "R3_FINAL_APPLICATION_INVALID" });
  }
});

test("executes adapters in order, retains bounded originals, and closes TLS after containers", async () => {
  const f = fixture();
  const plan = buildR3ApplicationPlan(f);
  const calls = [];
  const tls = {
    metadata: { operationRef: op, apiBaseUrl: plan.apiBaseUrl, caCertificateDigest: digest("e") },
    files: {
      "ca.pem": Buffer.from("ca"),
      "server.pem": Buffer.from("server"),
      "server.key": Buffer.from("private")
    },
    close: async () => {
      calls.push("tls.close");
      tls.files["server.key"].fill(0);
    }
  };
  const internals = {
    createTls: async () => {
      calls.push("tls.create");
      return tls;
    },
    loadPackages: async () => {
      calls.push("packages.load");
      return ["@playwright/test", "playwright", "playwright-core"].map((name) => ({
        name,
        version: "1.62.1",
        integrity: "sha512-test",
        digest: "1".repeat(64),
        bytes: Buffer.from("a")
      }));
    },
    withContainers: async ({ execute }) => {
      calls.push("containers.start");
      const value = await execute({
        api: { containerId: "a".repeat(64), address: "172.28.0.3" },
        web: { containerId: "b".repeat(64), address: "172.28.0.4" },
        browser: { containerId: "c".repeat(64), address: "172.28.0.5", attached: { stdout: {} } },
        signal: new globalThis.AbortController().signal,
        assertRunning: async () => {
          calls.push("containers.check");
        }
      });
      calls.push("containers.cleanup");
      return { value, originals: { cleaned: true, images: [], containers: [] }, cleaned: true };
    },
    withBrowser: async ({ execute, identity }) => {
      calls.push("browser.init");
      const evidence = {
        schemaVersion: "web-public-api-evidence.v1",
        operationId: op,
        buildProofDigest: identity.buildProofDigest,
        manifestDigest: identity.manifestDigest,
        webOrigin: "http://web:3000",
        publicApiBase: plan.apiBaseUrl,
        embeddedApiBase: plan.apiBaseUrl,
        actualRequestUrl: `${plan.apiBaseUrl}/portal/catalog/model-definitions`,
        corsAllowOrigin: "http://web:3000",
        responseStatus: 200,
        bundleContainsEmbeddedApiBase: true,
        mockedNetwork: false,
        traceDigest: digest("f"),
        observedAt: f.observedAt
      };
      const value = await execute({
        request: async ({ purpose }) => {
          calls.push(`browser.${purpose}`);
          return { status: 200, body: purpose === "health" ? { ok: true } : [] };
        },
        runBrowser: async () => {
          calls.push("browser.run");
          return evidence;
        }
      });
      calls.push("browser.close");
      return {
        value,
        original: {
          evidence,
          trace: Buffer.from("trace"),
          traceDigest: digest("f"),
          proxyConnectCount: 1,
          overlayDigest: digest("a"),
          sourceDigests: {}
        }
      };
    },
    createAdapters: (input) => {
      const actual = createFinalApplicationAdapters(input);
      return {
        startApplications: async ({ prepareTarget }) => {
          calls.push("adapter.start");
          assert.deepEqual(prepareTarget, { databaseOid: "4242", runtimeRole: "s1a_runtime" });
          return actual.startApplications({ prepareTarget });
        },
        verifyApi: async (context) => {
          calls.push("adapter.api");
          return actual.verifyApi(context);
        },
        verifyWebClient: async (context) => {
          calls.push("adapter.web");
          return actual.verifyWebClient(context);
        }
      };
    }
  };
  const observed = await executeR3FinalApplication({
    plan,
    buildProof: f.buildProof,
    repoRoot: "D:/repo",
    tlsDirectory: "D:/tls",
    signal: new globalThis.AbortController().signal,
    engineCall: async () => {},
    recheck: async () => {},
    observe: async () => {},
    readCredential: async () => {},
    queryApiSessions: async () => [
      {
        database_oid: "4242",
        usename: "s1a_runtime",
        application_name: `subscription-api/${plan.identity.apiManifestId}/${plan.identity.apiSessionNonce}`,
        tls: true,
        state: "idle"
      }
    ],
    internals
  });
  assert.deepEqual(
    calls.filter((value) => value.startsWith("adapter.")),
    ["adapter.start", "adapter.api", "adapter.web"]
  );
  assert.ok(calls.indexOf("containers.cleanup") < calls.indexOf("tls.close"));
  assert.equal(observed.tlsCleaned, true);
  assert.equal(observed.httpOriginals.length, 2);
  assert.equal(observed.browserOriginal.traceBase64, Buffer.from("trace").toString("base64"));
  assert.deepEqual(
    observed.packages.map(({ name }) => name),
    ["@playwright/test", "playwright", "playwright-core"]
  );
  assert.equal(observed.promotionEligible, false);
});

test("container failure preserves its cleanup originals and still closes private TLS", async () => {
  const f = fixture();
  const plan = buildR3ApplicationPlan(f);
  let closed = 0;
  const containerOriginals = { cleaned: true, containers: [{ role: "browser", deleted: true }] };
  const internals = {
    createTls: async () => ({
      metadata: { operationRef: op, apiBaseUrl: plan.apiBaseUrl },
      files: { "server.key": Buffer.from("secret") },
      close: async () => {
        closed++;
      }
    }),
    loadPackages: async () =>
      ["@playwright/test", "playwright", "playwright-core"].map((name) => ({
        name,
        version: "1.62.1",
        integrity: "sha512-test",
        digest: "1".repeat(64),
        bytes: Buffer.from("package")
      })),
    withContainers: async () => {
      const error = new Error("adapter failed");
      error.originals = containerOriginals;
      throw error;
    }
  };
  await assert.rejects(
    executeR3FinalApplication({
      plan,
      buildProof: f.buildProof,
      repoRoot: "D:/repo",
      tlsDirectory: "D:/tls",
      signal: new globalThis.AbortController().signal,
      engineCall: async () => {},
      recheck: async () => {},
      observe: async () => {},
      readCredential: async () => {},
      queryApiSessions: async () => [],
      internals
    }),
    (error) => {
      assert.equal(error.code, "R3_FINAL_APPLICATION_INVALID");
      assert.equal(error.originals.containers, containerOriginals);
      assert.equal(error.originals.tlsCleaned, true);
      assert.ok(!JSON.stringify(error.originals).includes("secret"));
      return true;
    }
  );
  assert.equal(closed, 1);
});
