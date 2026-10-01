// Held native final-application orchestration. The caller owns admission,
// no-swap custody, Engine registry observation, and credential scope.
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { sha256Canonical, validateContract } from "../../packages/release-foundation/src/index.mjs";
import {
  applicationContainerSpecs,
  withR3ApplicationContainers
} from "./r3-application-containers.mjs";
import { createR3ApplicationTls } from "./r3-application-tls.mjs";
import { loadR3BrowserPackages } from "./r3-browser-packages.mjs";
import { withR3BrowserSession } from "./r3-browser-runtime.mjs";
import { createFinalApplicationAdapters } from "./final-compose-application-adapters.mjs";
import { assertBuildWebClient } from "./verify-build-proof.mjs";

const CODE = "R3_FINAL_APPLICATION_INVALID";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
const same = (left, right) => sha256Canonical(left) === sha256Canonical(right);
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function iso(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function buildR3ApplicationPlan({
  request,
  buildProof,
  buildMaterialObservation,
  postgres,
  record,
  migration,
  creationEvidenceDigest,
  targetPolicyRef,
  observedAt
}) {
  try {
    const webClient = assertBuildWebClient({ proof: buildProof, buildMaterialObservation });
    need(
      request?.schemaVersion === "manual-runner-request.v5" &&
        request.stage === "candidate-use" &&
        request.phase === "final" &&
        ["fresh", "snapshot"].includes(request.chain) &&
        UUID.test(request.operationId) &&
        UUID.test(request.runId) &&
        /^[a-z0-9]{24,}$/u.test(request.sessionNonce) &&
        request.sourceSha === buildProof.identity.sourceSha &&
        request.candidate?.buildProofDigest === sha256Canonical(buildProof) &&
        DIGEST.test(request.targetPolicyDigest) &&
        targetPolicyRef ===
          `release/contracts/manual-stage1-r3-target-policy.v1.json@${request.targetPolicyDigest}` &&
        DIGEST.test(creationEvidenceDigest) &&
        iso(observedAt)
    );
    need(
      record?.kind === "application" &&
        /^[a-z][a-z0-9_]{0,62}$/u.test(record.databaseName) &&
        /^[1-9][0-9]*$/u.test(record.databaseOid) &&
        /^[a-z][a-z0-9_]{0,62}$/u.test(record.roles?.migrate) &&
        /^[a-z][a-z0-9_]{0,62}$/u.test(record.roles?.["api-runtime"]) &&
        record.secretReferences?.["api-runtime"] ===
          `r3/${request.operationId}/database-credentials/${record.databaseName}-api-runtime.json` &&
        migration?.status === "FINAL_MIGRATION_OBSERVED" &&
        migration.promotionEligible === false &&
        migration.input?.operationId === request.operationId &&
        migration.input?.runId === request.runId &&
        migration.input?.phase === "final" &&
        migration.input?.chain === request.chain &&
        migration.input?.sourceSha === request.sourceSha &&
        migration.input?.buildProofDigest === request.candidate.buildProofDigest &&
        migration.input?.creationEvidenceDigest === creationEvidenceDigest &&
        same(migration.input?.assignment, { kind: "application" }) &&
        migration.input?.database?.databaseName === record.databaseName &&
        migration.input?.database?.databaseOid === record.databaseOid &&
        migration.input?.database?.marker === record.marker &&
        migration.input?.database?.migrationRole === record.roles.migrate &&
        migration.input?.postgres?.engineId === postgres.engineId &&
        migration.input?.postgres?.containerId === postgres.containerId &&
        migration.input?.postgres?.systemIdentifier === postgres.postgres.systemIdentifier &&
        migration.input?.migrationCatalogDigest === buildProof.identity.migrationCatalogDigest &&
        DIGEST.test(migration.input?.expectedSchemaDigest) &&
        migration.schema?.expectedSchemaDigest === migration.input.expectedSchemaDigest &&
        Number.isSafeInteger(postgres?.postgres?.serverVersionNum) &&
        postgres.postgres.serverVersionNum >= 170000 &&
        postgres.postgres.serverVersionNum < 180000
    );
    const baseline = migration.originals?.channel?.results?.[0]?.baseline?.identity;
    need(
      (baseline?.migrationHead === null || /^\d{14}_[a-z0-9_]+$/u.test(baseline?.migrationHead)) &&
        DIGEST.test(baseline?.schemaDigest) &&
        (!migration.schema?.baselineManifestIdentityDigest ||
          migration.schema.baselineManifestIdentityDigest === sha256Canonical(baseline))
    );
    const apiManifestId = `r3-${request.operationId.replaceAll("-", "").slice(0, 18)}`;
    const apiSessionNonce = request.sessionNonce.slice(0, 24);
    const api = buildProof.identity.images.api;
    const web = buildProof.identity.images.web;
    need(
      api.registry === "ghcr.io/keqi119/subscription-api" &&
        web.registry === "ghcr.io/keqi119/subscription-web" &&
        api.sourceRevision === request.sourceSha &&
        web.sourceRevision === request.sourceSha &&
        api.platform === "linux/amd64" &&
        web.platform === "linux/amd64"
    );
    const identity = {
      operationRef: request.operationId,
      sourceSha: request.sourceSha,
      postgresAddress: postgres.containerAddress ?? postgres.postgres.serverAddress,
      api: { imageDigest: api.imageDigest, imageReference: `${api.registry}@${api.imageDigest}` },
      web: { imageDigest: web.imageDigest, imageReference: `${web.registry}@${web.imageDigest}` },
      apiManifestId,
      apiSessionNonce,
      databaseName: record.databaseName,
      runtimeRole: record.roles["api-runtime"]
    };
    const specs = applicationContainerSpecs(identity);
    const target = {
      databaseName: record.databaseName,
      databaseOid: record.databaseOid,
      runtimeRole: identity.runtimeRole
    };
    const manifest = {
      schemaVersion: "baseline-environment-manifest.v1",
      identity: {
        schemaVersion: "baseline-environment-manifest.identity.v1",
        environmentClass: `ci-${request.chain}`,
        buildProofDigest: sha256Canonical(buildProof),
        sourceSha: request.sourceSha,
        migrationCatalogDigest: buildProof.identity.migrationCatalogDigest,
        repositoryContractDigest: buildProof.identity.repositoryContractDigest,
        targetPolicyRef,
        secretReferenceFingerprint: sha256Canonical({
          secretReference: record.secretReferences["api-runtime"]
        }),
        databaseIdentityFingerprint: sha256Canonical({
          databaseName: record.databaseName,
          databaseOid: record.databaseOid,
          role: identity.runtimeRole,
          tls: true
        }),
        databaseNameFingerprint: sha256Canonical(record.databaseName),
        databaseRole: identity.runtimeRole,
        databaseSchema: "public",
        postgresServerVersionNum: String(postgres.postgres.serverVersionNum),
        preMigrationHead: baseline.migrationHead,
        preSchemaDigest: baseline.schemaDigest,
        configurationFingerprint: sha256Canonical(specs)
      },
      provenance: {
        generatedAt: observedAt,
        launcherRef: `native-r3://${request.operationId}`,
        launchAttestationDigest: creationEvidenceDigest,
        toolVersion: "r3-final-application@1",
        runId: request.runId
      }
    };
    validateContract("baseline-environment-manifest.v1", manifest);
    return freeze({
      schemaVersion: "r3-final-application-plan.v1",
      operationRef: request.operationId,
      chain: request.chain,
      runId: request.runId,
      sourceSha: request.sourceSha,
      apiBaseUrl: webClient.apiBaseUrl,
      identity,
      target,
      manifest,
      migrationObservationDigest: sha256Canonical(migration)
    });
  } catch {
    fail();
  }
}

function checkPlan(plan, buildProof) {
  validateContract("build-proof.v1", buildProof);
  validateContract("baseline-environment-manifest.v1", plan?.manifest);
  need(
    plan?.schemaVersion === "r3-final-application-plan.v1" &&
      UUID.test(plan.operationRef) &&
      UUID.test(plan.runId) &&
      ["fresh", "snapshot"].includes(plan.chain) &&
      plan.sourceSha === buildProof.identity.sourceSha &&
      DIGEST.test(plan.migrationObservationDigest) &&
      plan.identity?.operationRef === plan.operationRef &&
      plan.identity?.sourceSha === plan.sourceSha &&
      plan.identity?.api?.imageReference ===
        `${buildProof.identity.images.api.registry}@${buildProof.identity.images.api.imageDigest}` &&
      plan.identity?.web?.imageReference ===
        `${buildProof.identity.images.web.registry}@${buildProof.identity.images.web.imageDigest}` &&
      plan.target?.databaseName === plan.identity.databaseName &&
      plan.target?.runtimeRole === plan.identity.runtimeRole &&
      /^[1-9][0-9]*$/u.test(plan.target?.databaseOid) &&
      plan.manifest.identity.environmentClass === `ci-${plan.chain}` &&
      plan.manifest.identity.buildProofDigest === sha256Canonical(buildProof) &&
      plan.manifest.identity.sourceSha === plan.sourceSha &&
      plan.manifest.identity.databaseRole === plan.target.runtimeRole &&
      plan.manifest.identity.databaseIdentityFingerprint ===
        sha256Canonical({
          databaseName: plan.target.databaseName,
          databaseOid: plan.target.databaseOid,
          role: plan.target.runtimeRole,
          tls: true
        }) &&
      plan.manifest.identity.configurationFingerprint ===
        sha256Canonical(applicationContainerSpecs(plan.identity)) &&
      plan.manifest.provenance.runId === plan.runId &&
      plan.manifest.provenance.launcherRef === `native-r3://${plan.operationRef}`
  );
  const url = new URL(plan.apiBaseUrl);
  need(
    url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      plan.apiBaseUrl === `${url.origin}/api`
  );
}

export async function executeR3FinalApplication({
  plan,
  buildProof,
  repoRoot,
  tlsDirectory,
  signal,
  engineCall,
  recheck,
  observe,
  readCredential,
  queryApiSessions,
  internals = {}
}) {
  try {
    checkPlan(plan, buildProof);
    need(
      typeof repoRoot === "string" &&
        repoRoot.length > 0 &&
        typeof tlsDirectory === "string" &&
        tlsDirectory.length > 0 &&
        signal?.addEventListener &&
        !signal.aborted &&
        [engineCall, recheck, observe, readCredential, queryApiSessions].every(
          (fn) => typeof fn === "function"
        )
    );
  } catch {
    fail();
  }
  const createTls = internals.createTls ?? createR3ApplicationTls;
  const loadPackages = internals.loadPackages ?? loadR3BrowserPackages;
  const withContainers = internals.withContainers ?? withR3ApplicationContainers;
  const withBrowser = internals.withBrowser ?? withR3BrowserSession;
  const createAdapters = internals.createAdapters ?? createFinalApplicationAdapters;
  const httpOriginals = [];
  let tls, packages, ownedOriginals, browserOriginal, apiSessionRows, observed;
  let tlsCleaned = false;
  let failureCause;
  try {
    await recheck();
    need(!signal.aborted);
    tls = await createTls({
      directory: tlsDirectory,
      operationRef: plan.operationRef,
      apiBaseUrl: plan.apiBaseUrl,
      signal,
      recheck
    });
    await recheck();
    packages = await loadPackages({ repoRoot, signal });
    await recheck();
    need(
      Array.isArray(packages) &&
        packages.length === 3 &&
        packages.every(
          (item, index) =>
            item.name === ["@playwright/test", "playwright", "playwright-core"][index] &&
            item.version === "1.62.1" &&
            typeof item.name === "string" &&
            typeof item.integrity === "string" &&
            /^[0-9a-f]{64}$/u.test(item.digest) &&
            Buffer.isBuffer(item.bytes)
        )
    );
    const owned = await withContainers({
      identity: plan.identity,
      signal,
      engineCall,
      recheck,
      observe,
      readCredential,
      execute: async ({ api, web, browser, signal: heldSignal, assertRunning }) => {
        await assertRunning();
        return withBrowser({
          attached: browser.attached,
          signal: heldSignal,
          recheck: async () => {
            await recheck();
            await assertRunning();
          },
          repoRoot,
          identity: {
            operationId: plan.operationRef,
            apiBaseUrl: plan.apiBaseUrl,
            apiAddress: api.address,
            webAddress: web.address,
            buildProofDigest: sha256Canonical(buildProof),
            manifestDigest: sha256Canonical(plan.manifest)
          },
          tls,
          packages,
          execute: async (browserChannel) => {
            const apiBase = `http://${api.address}:3001/api`;
            const webBase = "http://web:3000";
            const applicationName = `subscription-api/${plan.identity.apiManifestId}/${plan.identity.apiSessionNonce}`;
            const runtime = {
              async start() {
                await assertRunning();
                return {
                  api: {
                    reference: plan.identity.api.imageReference,
                    imageDigest: plan.identity.api.imageDigest,
                    sourceRevision: plan.sourceSha
                  },
                  web: {
                    reference: plan.identity.web.imageReference,
                    imageDigest: plan.identity.web.imageDigest,
                    sourceRevision: plan.sourceSha
                  },
                  apiBase,
                  webBase,
                  publicApiBase: plan.apiBaseUrl,
                  embeddedApiBase: plan.apiBaseUrl
                };
              },
              async request({ purpose, url }) {
                need(
                  (purpose === "health" && url === `${apiBase}/health`) ||
                    (purpose === "catalog" &&
                      url ===
                        new URL(
                          "portal/catalog/model-definitions",
                          `${plan.apiBaseUrl}/`
                        ).toString())
                );
                const response = await browserChannel.request({ purpose });
                need(
                  Number.isSafeInteger(response?.status) &&
                    response.status >= 100 &&
                    response.status <= 599 &&
                    response.body !== undefined &&
                    Buffer.byteLength(JSON.stringify(response.body)) <= 1048576
                );
                httpOriginals.push(
                  globalThis.structuredClone({
                    purpose,
                    url,
                    status: response.status,
                    body: response.body
                  })
                );
                return response;
              },
              async queryApiSessions({ applicationName: actualName, databaseOid, runtimeRole }) {
                need(
                  actualName === applicationName &&
                    databaseOid === plan.target.databaseOid &&
                    runtimeRole === plan.target.runtimeRole
                );
                const rows = await queryApiSessions({
                  applicationName: actualName,
                  databaseOid,
                  runtimeRole
                });
                need(
                  Array.isArray(rows) &&
                    rows.length > 0 &&
                    rows.length <= 16 &&
                    Buffer.byteLength(JSON.stringify(rows)) <= 65536
                );
                apiSessionRows = globalThis.structuredClone(rows);
                return rows;
              },
              runBrowser: () => browserChannel.runBrowser()
            };
            const adapters = createAdapters({
              composeProject: `s1r3app_${plan.operationRef.replaceAll("-", "")}`,
              chain: plan.chain,
              manifest: plan.manifest,
              buildProof,
              operationId: plan.operationRef,
              apiManifestId: plan.identity.apiManifestId,
              apiSessionNonce: plan.identity.apiSessionNonce,
              runtime
            });
            const startApplications = await adapters.startApplications({
              prepareTarget: {
                databaseOid: plan.target.databaseOid,
                runtimeRole: plan.target.runtimeRole
              }
            });
            const verifyApi = await adapters.verifyApi({ startApplications });
            const verifyWebClient = await adapters.verifyWebClient({
              startApplications,
              verifyApi
            });
            await assertRunning();
            return { startApplications, verifyApi, verifyWebClient };
          }
        });
      }
    });
    need(owned?.cleaned === true && owned.originals?.cleaned === true);
    ownedOriginals = owned.originals;
    need(owned.value?.original && owned.value?.value);
    browserOriginal = owned.value.original;
    observed = owned.value.value;
    need(
      Buffer.isBuffer(tls.files["ca.pem"]) &&
        Buffer.isBuffer(tls.files["server.pem"]) &&
        Buffer.isBuffer(browserOriginal.trace) &&
        browserOriginal.trace.length > 0 &&
        browserOriginal.trace.length <= 8388608
    );
    await recheck();
  } catch (error) {
    failureCause = error;
    ownedOriginals ??= error?.originals;
  } finally {
    if (tls) {
      try {
        await tls.close();
        tlsCleaned = true;
      } catch {
        failureCause ??= new Error(CODE);
      }
    }
  }
  if (failureCause || !tlsCleaned) {
    const error = Object.assign(new Error(CODE), { code: CODE });
    error.originals = {
      containers: ownedOriginals ?? null,
      httpOriginals,
      apiSessionRows: apiSessionRows ?? null,
      browserOriginal: browserOriginal
        ? {
            evidence: browserOriginal.evidence,
            traceDigest: browserOriginal.traceDigest,
            proxyConnectCount: browserOriginal.proxyConnectCount,
            overlayDigest: browserOriginal.overlayDigest,
            sourceDigests: browserOriginal.sourceDigests
          }
        : null,
      tls: tls?.metadata ?? null,
      tlsCleaned
    };
    throw error;
  }
  const { trace, ...browserPublic } = browserOriginal;
  return {
    schemaVersion: "r3-final-application-observation.v1",
    plan,
    observations: observed,
    httpOriginals,
    apiSessionRows,
    browserOriginal: {
      ...browserPublic,
      traceBase64: trace.toString("base64")
    },
    tls: {
      metadata: tls.metadata,
      caPemBase64: tls.files["ca.pem"].toString("base64"),
      serverPemBase64: tls.files["server.pem"].toString("base64")
    },
    packages: packages.map(({ name, version, integrity, digest }) => ({
      name,
      version,
      integrity,
      digest
    })),
    containers: ownedOriginals,
    tlsCleaned: true,
    promotionEligible: false
  };
}
