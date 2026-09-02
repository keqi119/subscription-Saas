import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/index.mjs";
import { createFinalApplicationAdapters } from "./final-compose-application-adapters.mjs";
import { createFinalComposeProductionAdapters } from "./final-compose-production-adapters.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const uuid = (character) =>
  `${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-8${character.repeat(3)}-${character.repeat(12)}`;

function fixture() {
  const sourceSha = "a".repeat(40);
  const buildProof = {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      sourceSha,
      migrationCatalogDigest: digest("1"),
      repositoryContractDigest: digest("2"),
      images: Object.fromEntries(
        ["api", "web", "runner"].map((name, index) => [
          name,
          {
            name,
            registry: `ghcr.io/example/${name}`,
            platform: "linux/amd64",
            imageDigest: digest(String(index + 3)),
            sourceRevision: sourceSha
          }
        ])
      )
    },
    provenance: {
      generatedAt: "2026-09-03T00:00:00.000Z",
      ciRunRef: "github://runs/1/attempts/1",
      attestationRef: "github://attestations/1",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest("6") }],
      materials: [{ name: "builder", reference: "github://builder/1" }],
      registryResolutionEvidenceDigest: digest("7")
    }
  };
  const manifest = {
    schemaVersion: "baseline-environment-manifest.v1",
    identity: {
      schemaVersion: "baseline-environment-manifest.identity.v1",
      environmentClass: "ci-fresh",
      buildProofDigest: sha256Canonical(buildProof),
      sourceSha,
      migrationCatalogDigest: digest("1"),
      repositoryContractDigest: digest("2"),
      targetPolicyRef: "release/contracts/target-policies.v1.json#ci-fresh",
      secretReferenceFingerprint: digest("8"),
      databaseIdentityFingerprint: digest("9"),
      databaseNameFingerprint: digest("a"),
      databaseRole: "s1r_runtime",
      databaseSchema: "public",
      postgresServerVersionNum: "170011",
      preMigrationHead: null,
      preSchemaDigest: digest("b"),
      configurationFingerprint: digest("c")
    },
    provenance: {
      generatedAt: "2026-09-03T00:00:00.000Z",
      launcherRef: "github://runs/1",
      launchAttestationDigest: digest("d"),
      toolVersion: "final-compose@1",
      runId: uuid("1")
    }
  };
  return {
    sourceSha,
    buildProof,
    manifest,
    operationId: uuid("2"),
    apiManifestId: "manifest-ab12",
    apiSessionNonce: "session-cd34",
    target: {
      databaseOid: "4242",
      runtimeRole: "s1r_runtime"
    }
  };
}

function runtimeFor(input, mutations = {}) {
  const applicationName = `subscription-api/${input.apiManifestId}/${input.apiSessionNonce}`;
  const expectedCatalogUrl = "http://127.0.0.1:33001/api/portal/catalog/model-definitions";
  return {
    async start() {
      return {
        api: {
          reference: `ghcr.io/example/api@${digest("3")}`,
          imageDigest: digest("3"),
          sourceRevision: input.sourceSha
        },
        web: {
          reference: `ghcr.io/example/web@${digest("4")}`,
          imageDigest: digest("4"),
          sourceRevision: input.sourceSha
        },
        apiBase: "http://127.0.0.1:33001/api",
        webBase: "http://127.0.0.1:33000",
        publicApiBase: "http://127.0.0.1:33001/api",
        embeddedApiBase: "http://127.0.0.1:33001/api"
      };
    },
    async request({ purpose }) {
      return purpose === "health"
        ? { status: 200, body: { ok: true }, headers: {} }
        : {
            status: 200,
            body: [],
            headers: { "access-control-allow-origin": "http://127.0.0.1:33000" }
          };
    },
    async queryApiSessions() {
      return [
        {
          database_oid: input.target.databaseOid,
          usename: input.target.runtimeRole,
          application_name: applicationName,
          tls: true,
          state: "idle"
        }
      ];
    },
    async runBrowser() {
      return {
        schemaVersion: "web-public-api-evidence.v1",
        operationId: input.operationId,
        buildProofDigest: sha256Canonical(input.buildProof),
        manifestDigest: sha256Canonical(input.manifest),
        webOrigin: "http://127.0.0.1:33000",
        publicApiBase: "http://127.0.0.1:33001/api",
        embeddedApiBase: "http://127.0.0.1:33001/api",
        actualRequestUrl: expectedCatalogUrl,
        corsAllowOrigin: "http://127.0.0.1:33000",
        responseStatus: 200,
        bundleContainsEmbeddedApiBase: true,
        mockedNetwork: false,
        traceDigest: digest("e"),
        observedAt: "2026-09-03T01:00:00.000Z"
      };
    },
    ...mutations
  };
}

async function createStarted(mutations) {
  const input = fixture();
  const adapters = createFinalApplicationAdapters({
    composeProject: "s1-final-fresh",
    chain: "fresh",
    manifest: input.manifest,
    buildProof: input.buildProof,
    operationId: input.operationId,
    apiManifestId: input.apiManifestId,
    apiSessionNonce: input.apiSessionNonce,
    runtime: runtimeFor(input, mutations)
  });
  const started = await adapters.startApplications({ prepareTarget: input.target });
  return { input, adapters, started };
}

test("collects API database identity and a real browser network observation", async () => {
  const { adapters, started } = await createStarted();
  const api = await adapters.verifyApi({ startApplications: started });
  const web = await adapters.verifyWebClient({ startApplications: started, verifyApi: api });
  assert.equal(api.apiReadiness.databaseOid, "4242");
  assert.equal(api.apiSessionRows.length, 1);
  assert.equal(web.mockedNetwork, false);
  assert.equal(web.actualRequestUrl, "http://127.0.0.1:33001/api/portal/catalog/model-definitions");
  assert.match(web.evidenceDigest, /^sha256:[0-9a-f]{64}$/u);
});

test("rejects a valid catalog response backed by the wrong database", async () => {
  const { adapters, started } = await createStarted({
    async queryApiSessions() {
      return [
        {
          database_oid: "9999",
          usename: "s1r_runtime",
          application_name: "subscription-api/manifest-ab12/session-cd34",
          tls: true,
          state: "idle"
        }
      ];
    }
  });
  await assert.rejects(adapters.verifyApi({ startApplications: started }), {
    code: "API_DATABASE_SESSION_IDENTITY_MISMATCH"
  });
});

test("rejects static-page-only, mocked, CORS-missing and caller-declared browser success", async () => {
  for (const patch of [
    { actualRequestUrl: "http://127.0.0.1:33000/portal/catalog" },
    { mockedNetwork: true },
    { corsAllowOrigin: "" },
    { terminalStatus: "PASSED" }
  ]) {
    const { adapters, started } = await createStarted({
      async runBrowser() {
        const value = await runtimeFor(fixture()).runBrowser();
        return { ...value, ...patch };
      }
    });
    const api = await adapters.verifyApi({ startApplications: started });
    await assert.rejects(adapters.verifyWebClient({ startApplications: started, verifyApi: api }), {
      code: "WEB_PUBLIC_API_IDENTITY_MISMATCH"
    });
  }
});

test("rejects an admitted image whose observed digest or source revision differs", async () => {
  const input = fixture();
  const runtime = runtimeFor(input);
  const originalStart = runtime.start;
  runtime.start = async () => {
    const observation = await originalStart();
    return {
      ...observation,
      api: { ...observation.api, sourceRevision: "f".repeat(40) }
    };
  };
  const adapters = createFinalApplicationAdapters({
    composeProject: "s1-final-fresh",
    chain: "fresh",
    manifest: input.manifest,
    buildProof: input.buildProof,
    operationId: input.operationId,
    apiManifestId: input.apiManifestId,
    apiSessionNonce: input.apiSessionNonce,
    runtime
  });
  await assert.rejects(adapters.startApplications({ prepareTarget: input.target }), {
    code: "FINAL_APPLICATION_IMAGE_IDENTITY_MISMATCH"
  });
});

test("production composition binds the frozen Manifest, target and capability credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-production-"));
  try {
    const input = fixture();
    const suffix = "a".repeat(24);
    const runtimeRole = `s1a_${suffix}`;
    const testRuntimeRole = `s1r_${suffix}`;
    const verifyRole = `s1v_${suffix}`;
    const databaseName = `s1ci_${suffix}`;
    const databaseOid = "4242";
    const runtimeCredential = {
      capabilityProfile: "application-runtime",
      username: runtimeRole,
      password: "runtime-password-123456"
    };
    const verifyCredential = {
      capabilityProfile: "verify",
      username: verifyRole,
      password: "verify-password-1234567"
    };
    const databaseIdentityFingerprint = sha256Canonical({
      databaseName,
      databaseOid,
      role: runtimeRole,
      tls: true
    });
    const manifest = structuredClone(input.manifest);
    manifest.identity.databaseRole = runtimeRole;
    manifest.identity.databaseIdentityFingerprint = databaseIdentityFingerprint;
    const target = {
      schemaVersion: "final-compose-target.v1",
      chain: "fresh",
      hostname: "postgres",
      hostAccessHostname: "127.0.0.1",
      port: 35432,
      databaseName,
      databaseOid,
      databaseIdentityFingerprint,
      apiRuntimeRole: runtimeRole,
      testRuntimeRole,
      migrationRole: `s1m_${suffix}`,
      verifyRole,
      apiRuntimeCredentialFingerprint: sha256Bytes(Buffer.from(runtimeCredential.password)),
      testRuntimeCredentialFingerprint: digest("f"),
      verifyCredentialFingerprint: sha256Bytes(Buffer.from(verifyCredential.password)),
      marker: `subscription-s1-ephemeral/v1:${uuid("3")}`,
      tlsMode: "require"
    };
    const custodyPolicy = {
      owner: "release-engineering",
      readers: ["release-auditor"],
      retentionDays: 180,
      expiryDisposition: "review"
    };
    const files = {
      "manifest.json": manifest,
      "target.json": target,
      "runtime.json": runtimeCredential,
      "verify.json": verifyCredential,
      "custody-policy.json": custodyPolicy
    };
    await Promise.all(
      Object.entries(files).map(([name, value]) =>
        writeFile(path.join(root, name), JSON.stringify(value))
      )
    );
    const runtimeConfig = {
      schemaVersion: "final-compose-runtime.v1",
      chain: "fresh",
      manifestReference: "manifest.json",
      manifestDigest: sha256Canonical(manifest),
      targetReference: "target.json",
      targetDigest: sha256Canonical(target),
      apiRuntimeCredentialReference: "runtime.json",
      verifyCredentialReference: "verify.json",
      custodyPolicyReference: "custody-policy.json",
      custodyPolicyDigest: sha256Canonical(custodyPolicy),
      attestationRef: "github://attestations/final-compose-1",
      apiManifestId: input.apiManifestId,
      apiSessionNonce: input.apiSessionNonce,
      apiBase: "http://127.0.0.1:33001/api",
      webBase: "http://127.0.0.1:33000",
      publicApiBase: "http://127.0.0.1:33001/api",
      embeddedApiBase: "http://127.0.0.1:33001/api",
      composeSecretFiles: {
        postgresPassword: "secrets/postgres.json",
        migrationCredential: "secrets/migrate.json",
        verifyCredential: "secrets/verify.json",
        databaseTestCredential: "secrets/runtime.json",
        databaseTestSourceCredential: "secrets/source-runtime.json"
      }
    };
    await writeFile(
      path.join(root, "final-compose-runtime.v1.json"),
      JSON.stringify(runtimeConfig)
    );
    const finalInput = {
      chain: "fresh",
      buildProof: input.buildProof,
      buildProofDigest: sha256Canonical(input.buildProof),
      sourceEvidence: sourceEvidence(input.buildProof),
      sourceGateEvidenceDigest: digest("e"),
      releaseImages: {
        api: `ghcr.io/example/api@${digest("3")}`,
        web: `ghcr.io/example/web@${digest("4")}`,
        runner: `ghcr.io/example/runner@${digest("5")}`
      },
      databaseTestManifestDigest: digest("8"),
      postgresImageDigest: digest("9"),
      snapshotMetadata: null,
      snapshotMetadataDigest: null,
      operationId: input.operationId,
      runId: uuid("4"),
      attemptId: uuid("5"),
      compose: {
        projectName: "s1-final-fresh",
        configDigest: digest("a"),
        playwrightImageDigest: digest("b"),
        playwrightVersion: "1.62.1"
      },
      composeFile: "docker-compose.release-gate.yml",
      workspace: { launchRoot: root, evidenceRoot: path.join(root, "evidence") },
      priorFailureProofDigests: []
    };
    const adapters = await createFinalComposeProductionAdapters(finalInput, {
      connectDatabase: async ({ credential }) => ({
        async observeIdentity() {
          return {
            databaseName,
            databaseOid,
            role: credential.username,
            tls: true
          };
        },
        async close() {}
      }),
      createApplicationRuntime: () =>
        runtimeFor({
          ...input,
          manifest,
          target: { databaseOid, runtimeRole }
        }),
      createUploader: memoryUploader,
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" })
    });
    const prepared = await adapters.prepareTarget();
    assert.equal(prepared.databaseOid, databaseOid);
    assert.equal(prepared.runtimeRole, runtimeRole);
    assert.equal(prepared.databaseIdentityFingerprint, databaseIdentityFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sourceEvidence(proof) {
  return {
    schemaVersion: "source-gate-evidence.v1",
    sourceSha: proof.identity.sourceSha,
    migrationCatalogDigest: proof.identity.migrationCatalogDigest,
    repositoryContractDigest: proof.identity.repositoryContractDigest,
    databaseTestManifestDigest: digest("8"),
    databaseTestDiscoveryDigest: digest("9"),
    postgres: { imageDigest: digest("9"), serverVersionNum: "170011" },
    chain: "fresh",
    counts: {
      collected: 1,
      selected: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      todo: 0,
      filtered: 0,
      cancelled: 0
    },
    terminalStatus: "PASSED",
    schemaDiffDigest: digest("a"),
    migrationStatusDigest: digest("b"),
    sanitizedLogDigest: digest("c"),
    provenance: {
      generatedAt: "2026-09-03T00:00:00.000Z",
      ciRunRef: "github://runs/1/attempts/1",
      executorVersion: "source-gate@1"
    }
  };
}

function memoryUploader() {
  const values = new Map();
  return Object.freeze({
    trustPolicy: "immutable-content-addressed/v1",
    writerIdentity: "release-final-gate",
    auditReaderIdentity: "audit-reader",
    async createOnly({ key, bytes, requestedAt, retainUntil }) {
      if (values.has(key)) return { created: false };
      values.set(key, Buffer.from(bytes));
      return {
        created: true,
        storeRef: `memory-evidence://${key}`,
        contentSizeBytes: bytes.byteLength,
        storedAt: requestedAt,
        retainUntil
      };
    },
    async read({ key }) {
      return values.get(key);
    }
  });
}
