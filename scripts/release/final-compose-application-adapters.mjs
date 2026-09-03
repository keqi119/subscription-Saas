import { spawn as spawnProcess } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  sha256Bytes,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";
import { createPostgresConnector } from "../../apps/release-runner/src/postgres-connector.mjs";

import { API_DATABASE_SESSION_SQL, verifyApiDatabaseSession } from "./run-final-compose-gate.mjs";

function applicationError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function assertRuntime(runtime) {
  for (const method of ["start", "request", "queryApiSessions", "runBrowser"]) {
    if (typeof runtime?.[method] !== "function") {
      throw applicationError("FINAL_APPLICATION_RUNTIME_ADAPTER_MISSING", { method });
    }
  }
}

function expectedImage(buildProof, name) {
  const image = buildProof.identity.images[name];
  return Object.freeze({
    reference: `${image.registry}@${image.imageDigest}`,
    imageDigest: image.imageDigest,
    sourceRevision: buildProof.identity.sourceSha
  });
}

function assertImageObservation(actual, expected, service) {
  if (
    actual?.reference !== expected.reference ||
    actual?.imageDigest !== expected.imageDigest ||
    actual?.sourceRevision !== expected.sourceRevision
  ) {
    throw applicationError("FINAL_APPLICATION_IMAGE_IDENTITY_MISMATCH", { service });
  }
}

function expectedCatalogUrl(publicApiBase) {
  return new URL(
    "portal/catalog/model-definitions",
    `${publicApiBase.replace(/\/$/u, "")}/`
  ).toString();
}

function assertHttpResult(result, purpose) {
  if (
    result?.status !== 200 ||
    result.body === undefined ||
    result === null ||
    typeof result !== "object"
  ) {
    throw applicationError("FINAL_APPLICATION_HTTP_READINESS_FAILED", { purpose });
  }
}

function assertBrowserObservation(observation, expected) {
  if (
    !observation ||
    Object.hasOwn(observation, "terminalStatus") ||
    observation.schemaVersion !== "web-public-api-evidence.v1" ||
    observation.operationId !== expected.operationId ||
    observation.buildProofDigest !== expected.buildProofDigest ||
    observation.manifestDigest !== expected.manifestDigest ||
    observation.webOrigin !== expected.webOrigin ||
    observation.publicApiBase !== expected.publicApiBase ||
    observation.embeddedApiBase !== expected.publicApiBase ||
    observation.actualRequestUrl !== expected.catalogUrl ||
    observation.corsAllowOrigin !== expected.webOrigin ||
    observation.responseStatus !== 200 ||
    observation.bundleContainsEmbeddedApiBase !== true ||
    observation.mockedNetwork !== false ||
    !/^sha256:[0-9a-f]{64}$/u.test(observation.traceDigest ?? "") ||
    !Number.isFinite(Date.parse(observation.observedAt ?? ""))
  ) {
    throw applicationError("WEB_PUBLIC_API_IDENTITY_MISMATCH");
  }
}

export function createFinalApplicationAdapters({
  composeProject,
  chain,
  manifest,
  buildProof,
  operationId,
  apiManifestId,
  apiSessionNonce,
  runtime
}) {
  if (
    !["fresh", "snapshot"].includes(chain) ||
    typeof composeProject !== "string" ||
    composeProject.length === 0 ||
    typeof operationId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,39}$/u.test(apiManifestId ?? "") ||
    !/^[a-z0-9][a-z0-9-]{1,39}$/u.test(apiSessionNonce ?? "")
  ) {
    throw applicationError("FINAL_APPLICATION_ADAPTER_INPUT_INVALID");
  }
  validateContract("build-proof.v1", buildProof);
  validateContract("baseline-environment-manifest.v1", manifest);
  if (
    manifest.identity.environmentClass !== `ci-${chain}` ||
    manifest.identity.buildProofDigest !== sha256Canonical(buildProof) ||
    manifest.identity.sourceSha !== buildProof.identity.sourceSha
  ) {
    throw applicationError("FINAL_APPLICATION_MANIFEST_MISMATCH");
  }
  assertRuntime(runtime);
  const buildProofDigest = sha256Canonical(buildProof);
  const manifestDigest = sha256Canonical(manifest);
  const applicationName = `subscription-api/${apiManifestId}/${apiSessionNonce}`;
  const expectedImages = Object.freeze({
    api: expectedImage(buildProof, "api"),
    web: expectedImage(buildProof, "web")
  });
  let started;

  return Object.freeze({
    async startApplications(context) {
      const target = context?.prepareTarget;
      if (
        !/^[1-9][0-9]*$/u.test(String(target?.databaseOid ?? "")) ||
        target.runtimeRole !== manifest.identity.databaseRole
      ) {
        throw applicationError("FINAL_APPLICATION_DATABASE_TARGET_MISMATCH");
      }
      const observation = await runtime.start({
        composeProject,
        chain,
        manifest,
        operationId,
        applicationName,
        apiManifestId,
        apiSessionNonce,
        expectedImages,
        target
      });
      assertImageObservation(observation?.api, expectedImages.api, "api");
      assertImageObservation(observation?.web, expectedImages.web, "web");
      for (const field of ["apiBase", "webBase", "publicApiBase", "embeddedApiBase"]) {
        try {
          new URL(observation[field]);
        } catch {
          throw applicationError("FINAL_APPLICATION_ENDPOINT_INVALID", { field });
        }
      }
      if (observation.publicApiBase !== observation.embeddedApiBase) {
        throw applicationError("WEB_PUBLIC_API_IDENTITY_MISMATCH");
      }
      started = Object.freeze({
        ...observation,
        applicationName,
        apiManifestId,
        buildProofDigest,
        manifestDigest,
        databaseOid: String(target.databaseOid),
        runtimeRole: target.runtimeRole
      });
      return started;
    },

    async verifyApi(context) {
      if (!started || context?.startApplications !== started) {
        throw applicationError("FINAL_APPLICATION_NOT_STARTED");
      }
      const health = await runtime.request({
        purpose: "health",
        url: `${started.apiBase.replace(/\/$/u, "")}/health`
      });
      assertHttpResult(health, "health");
      const catalogUrl = expectedCatalogUrl(started.publicApiBase);
      const catalog = await runtime.request({ purpose: "catalog", url: catalogUrl });
      assertHttpResult(catalog, "catalog");
      const rows = await runtime.queryApiSessions({
        applicationName,
        databaseOid: started.databaseOid,
        runtimeRole: started.runtimeRole
      });
      const session = verifyApiDatabaseSession({
        rows,
        expected: {
          databaseOid: started.databaseOid,
          runtimeRole: started.runtimeRole,
          applicationName,
          tls: true
        }
      });
      const apiReadiness = Object.freeze({
        healthStatus: health.status,
        catalogStatus: catalog.status,
        ...session,
        evidenceDigest: sha256Canonical({
          health: { status: health.status, body: health.body },
          catalog: { status: catalog.status, body: catalog.body },
          session
        })
      });
      return Object.freeze({
        apiReadiness,
        apiSessionRows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
        catalogUrl,
        catalogResponseDigest: sha256Canonical(catalog.body)
      });
    },

    async verifyWebClient(context) {
      if (!started || context?.startApplications !== started || !context?.verifyApi) {
        throw applicationError("FINAL_APPLICATION_API_NOT_VERIFIED");
      }
      const expected = Object.freeze({
        operationId,
        buildProofDigest,
        manifestDigest,
        webOrigin: new URL(started.webBase).origin,
        publicApiBase: started.publicApiBase,
        catalogUrl: expectedCatalogUrl(started.publicApiBase)
      });
      const observation = await runtime.runBrowser({
        ...expected,
        webBase: started.webBase,
        embeddedApiBase: started.embeddedApiBase,
        routingInterception: "disabled"
      });
      assertBrowserObservation(observation, expected);
      const accepted = JSON.parse(canonicalJson(observation));
      return Object.freeze({
        ...accepted,
        evidenceDigest: sha256Canonical(accepted)
      });
    }
  });
}

function runProcess(command, args, { environment = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function assertProcess(result, code) {
  if (result?.exitCode !== 0 || result?.signal) {
    throw applicationError(code, {
      exitCode: result?.exitCode,
      signal: result?.signal ?? null,
      diagnostic: String(result?.stderr ?? "")
        .trim()
        .slice(0, 500)
    });
  }
  return result.stdout;
}

async function findFiles(root, name) {
  const entries = await readdir(root, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...(await findFiles(file, name)));
    else if (entry.isFile() && entry.name === name) matches.push(file);
  }
  return matches;
}

export function createFinalApplicationProductionRuntime({
  composeFile,
  composeEnvironment,
  verifyCredential,
  databaseTarget,
  evidenceRoot,
  execute = runProcess,
  request = globalThis.fetch,
  connectDatabase = createPostgresConnector(),
  playwrightExecutable = "pnpm"
}) {
  if (
    typeof composeFile !== "string" ||
    typeof evidenceRoot !== "string" ||
    typeof execute !== "function" ||
    typeof request !== "function" ||
    typeof connectDatabase !== "function" ||
    verifyCredential?.capabilityProfile !== "verify" ||
    databaseTarget?.tlsMode !== "require"
  ) {
    throw applicationError("FINAL_APPLICATION_PRODUCTION_INPUT_INVALID");
  }

  async function dockerCompose(project, args) {
    return execute(
      "docker",
      ["compose", "--project-name", project, "--file", path.resolve(composeFile), ...args],
      { environment: { ...process.env, ...composeEnvironment } }
    );
  }

  async function observeContainer(project, service, expected) {
    const id = String(
      assertProcess(
        await dockerCompose(project, ["ps", "--quiet", service]),
        "FINAL_APPLICATION_CONTAINER_INSPECTION_FAILED"
      )
    ).trim();
    if (!/^[0-9a-f]{12,64}$/u.test(id)) {
      throw applicationError("FINAL_APPLICATION_CONTAINER_INSPECTION_FAILED", { service });
    }
    const [containerText, imageText] = await Promise.all([
      execute("docker", ["inspect", id]),
      execute("docker", ["image", "inspect", expected.reference])
    ]);
    let container;
    let image;
    try {
      [container] = JSON.parse(
        assertProcess(containerText, "FINAL_APPLICATION_CONTAINER_INSPECTION_FAILED")
      );
      [image] = JSON.parse(
        assertProcess(imageText, "FINAL_APPLICATION_CONTAINER_INSPECTION_FAILED")
      );
    } catch {
      throw applicationError("FINAL_APPLICATION_CONTAINER_INSPECTION_FAILED", { service });
    }
    if (
      container?.Config?.Image !== expected.reference ||
      container?.Image !== image?.Id ||
      container?.State?.Running !== true ||
      !image?.RepoDigests?.includes(expected.reference)
    ) {
      throw applicationError("FINAL_APPLICATION_IMAGE_IDENTITY_MISMATCH", { service });
    }
    return Object.freeze({
      reference: expected.reference,
      imageDigest: expected.imageDigest,
      sourceRevision: image.Config?.Labels?.["org.opencontainers.image.revision"] ?? null
    });
  }

  return Object.freeze({
    async start({ composeProject, expectedImages }) {
      assertProcess(
        await dockerCompose(composeProject, [
          "--profile",
          "api",
          "--profile",
          "web",
          "up",
          "--detach",
          "--no-build",
          "api",
          "web"
        ]),
        "FINAL_APPLICATION_START_FAILED"
      );
      const [api, web] = await Promise.all([
        observeContainer(composeProject, "api", expectedImages.api),
        observeContainer(composeProject, "web", expectedImages.web)
      ]);
      return Object.freeze({
        api,
        web,
        apiBase: composeEnvironment.RELEASE_GATE_API_BASE,
        webBase: composeEnvironment.RELEASE_GATE_WEB_BASE,
        publicApiBase: composeEnvironment.RELEASE_GATE_PUBLIC_API_BASE,
        embeddedApiBase: composeEnvironment.RELEASE_GATE_EMBEDDED_API_BASE
      });
    },

    async request({ url }) {
      let response;
      let lastError;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          response = await request(url, {
            headers: { Origin: composeEnvironment.RELEASE_GATE_WEB_BASE },
            signal: AbortSignal.timeout(2_000)
          });
          if (response.status === 200) break;
          lastError = applicationError("FINAL_APPLICATION_HTTP_STATUS_NOT_READY", {
            status: response.status
          });
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!response || response.status !== 200) {
        throw applicationError("FINAL_APPLICATION_HTTP_READINESS_FAILED", {
          cause: lastError?.code ?? lastError?.name
        });
      }
      const text = await response.text();
      let body = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // The status plus a content digest remains evidence for a non-JSON health response.
      }
      return Object.freeze({
        status: response.status,
        body,
        headers: Object.fromEntries(response.headers.entries())
      });
    },

    async queryApiSessions({ applicationName }) {
      const database = await connectDatabase({
        credential: verifyCredential,
        target: databaseTarget
      });
      try {
        return database.query(API_DATABASE_SESSION_SQL, [applicationName]);
      } finally {
        await database.close?.();
      }
    },

    async runBrowser(input) {
      if (input.routingInterception !== "disabled") {
        throw applicationError("FINAL_APPLICATION_BROWSER_INTERCEPTION_FORBIDDEN");
      }
      const attemptRoot = path.resolve(evidenceRoot, "browser");
      const observationFile = path.join(attemptRoot, "web-public-api-observation.json");
      const outputDirectory = path.join(attemptRoot, "playwright-output");
      await rm(attemptRoot, { recursive: true, force: true });
      await mkdir(attemptRoot, { recursive: true });
      const result = await execute(
        playwrightExecutable,
        [
          "exec",
          "playwright",
          "test",
          "--config",
          "playwright.release.config.ts",
          "tests/release/web-public-api.spec.ts"
        ],
        {
          environment: {
            ...process.env,
            RELEASE_GATE_WEB_BASE: input.webBase,
            RELEASE_GATE_PUBLIC_API_BASE: input.publicApiBase,
            RELEASE_GATE_EMBEDDED_API_BASE: input.embeddedApiBase,
            RELEASE_GATE_OPERATION_ID: input.operationId,
            RELEASE_GATE_BUILD_PROOF_DIGEST: input.buildProofDigest,
            RELEASE_GATE_MANIFEST_DIGEST: input.manifestDigest,
            RELEASE_GATE_WEB_EVIDENCE_FILE: observationFile,
            RELEASE_GATE_PLAYWRIGHT_OUTPUT_DIR: outputDirectory
          },
          timeoutMs: 120_000
        }
      );
      assertProcess(result, "FINAL_APPLICATION_BROWSER_FAILED");
      const traces = await findFiles(outputDirectory, "trace.zip");
      if (traces.length !== 1) {
        throw applicationError("FINAL_APPLICATION_BROWSER_TRACE_INVALID", {
          count: traces.length
        });
      }
      const observation = JSON.parse(await readFile(observationFile, "utf8"));
      return Object.freeze({
        ...observation,
        traceDigest: sha256Bytes(await readFile(traces[0]))
      });
    }
  });
}
