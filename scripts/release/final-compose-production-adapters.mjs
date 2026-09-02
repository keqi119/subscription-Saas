import { spawn as spawnProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  sha256Bytes,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";
import { createPostgresConnector } from "../../apps/release-runner/src/postgres-connector.mjs";

import {
  createFinalApplicationAdapters,
  createFinalApplicationProductionRuntime
} from "./final-compose-application-adapters.mjs";
import { createFinalDatabaseAdapters } from "./final-compose-database-adapters.mjs";
import {
  createFileCustodyUploader,
  createFinalCustodyAdapters
} from "./final-compose-custody-adapters.mjs";
import { buildFinalComposeEvidence } from "./run-final-compose-gate.mjs";

function productionError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function safeLaunchPath(root, relative) {
  if (
    typeof relative !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]+\.(?:json|secret)$/u.test(relative)
  ) {
    throw productionError("FINAL_COMPOSE_LAUNCH_REFERENCE_INVALID");
  }
  const absolute = path.resolve(root, ...relative.split("/"));
  const difference = path.relative(path.resolve(root), absolute);
  if (!difference || difference.startsWith("..") || path.isAbsolute(difference)) {
    throw productionError("FINAL_COMPOSE_LAUNCH_REFERENCE_FORBIDDEN");
  }
  return absolute;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw productionError("FINAL_COMPOSE_LAUNCH_ARTIFACT_INVALID", {
      file: path.basename(file),
      cause: error?.code
    });
  }
}

async function readBoundJson(root, reference, expectedDigest, contract) {
  const value = await readJson(safeLaunchPath(root, reference));
  if (sha256Canonical(value) !== expectedDigest) {
    throw productionError("FINAL_COMPOSE_LAUNCH_ARTIFACT_DIGEST_MISMATCH", { reference });
  }
  if (contract) validateContract(contract, value);
  return value;
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
    throw productionError(code, {
      exitCode: result?.exitCode,
      signal: result?.signal ?? null,
      diagnostic: String(result?.stderr ?? "")
        .trim()
        .slice(0, 500)
    });
  }
  return result.stdout;
}

function assertCredential(credential, { profile, role, fingerprint }) {
  if (
    credential?.capabilityProfile !== profile ||
    credential.username !== role ||
    typeof credential.password !== "string" ||
    credential.password.length < 16 ||
    sha256Bytes(Buffer.from(credential.password, "utf8")) !== fingerprint
  ) {
    throw productionError("FINAL_COMPOSE_CAPABILITY_CREDENTIAL_MISMATCH", { profile });
  }
}

function databaseUrl(target, credential) {
  const value = new URL("postgresql://release.invalid/");
  value.username = credential.username;
  value.password = credential.password;
  value.hostname = target.hostname;
  value.port = "5432";
  value.pathname = `/${target.databaseName}`;
  value.searchParams.set("sslmode", "require");
  return value.toString();
}

function composeEnvironment({ input, runtimeConfig, target, apiRuntimeCredential, launchRoot }) {
  const files = Object.fromEntries(
    Object.entries(runtimeConfig.composeSecretFiles).map(([name, reference]) => [
      name,
      safeLaunchPath(launchRoot, reference)
    ])
  );
  return Object.freeze({
    RELEASE_API_DATABASE_URL: databaseUrl(target, apiRuntimeCredential),
    RELEASE_API_IMAGE: input.releaseImages.api,
    RELEASE_WEB_IMAGE: input.releaseImages.web,
    RELEASE_RUNNER_IMAGE: input.releaseImages.runner,
    RELEASE_SOURCE_REVISION: input.buildProof.identity.sourceSha,
    RELEASE_MANIFEST_ID: runtimeConfig.apiManifestId,
    RELEASE_SESSION_NONCE: runtimeConfig.apiSessionNonce,
    RELEASE_GATE_API_BASE: runtimeConfig.apiBase,
    RELEASE_GATE_WEB_BASE: runtimeConfig.webBase,
    RELEASE_GATE_PUBLIC_API_BASE: runtimeConfig.publicApiBase,
    RELEASE_GATE_EMBEDDED_API_BASE: runtimeConfig.embeddedApiBase,
    RELEASE_GATE_API_PORT: new URL(runtimeConfig.apiBase).port,
    RELEASE_GATE_WEB_PORT: new URL(runtimeConfig.webBase).port,
    RELEASE_POSTGRES_PASSWORD_FILE: files.postgresPassword,
    RELEASE_MIGRATION_CREDENTIAL_FILE: files.migrationCredential,
    RELEASE_VERIFY_CREDENTIAL_FILE: files.verifyCredential,
    RELEASE_DATABASE_TEST_CREDENTIAL_FILE: files.databaseTestCredential,
    RELEASE_DATABASE_TEST_SOURCE_CREDENTIAL_FILE: files.databaseTestSourceCredential,
    RELEASE_RUNNER_LAUNCH_ENVELOPE_FILE: safeLaunchPath(launchRoot, "migration-dry-run.json")
  });
}

function createInfrastructure({
  input,
  target,
  manifest,
  verifyCredential,
  composeEnvironment: environment,
  connectDatabase,
  execute
}) {
  let prepared = false;
  return Object.freeze({
    async prepareTarget() {
      const database = await connectDatabase({
        credential: verifyCredential,
        target: {
          hostname: target.hostAccessHostname,
          port: target.port,
          databaseName: target.databaseName,
          tlsMode: target.tlsMode
        }
      });
      let identity;
      try {
        identity = await database.observeIdentity();
      } finally {
        await database.close?.();
      }
      const expectedRuntimeFingerprint = sha256Canonical({
        databaseName: target.databaseName,
        databaseOid: target.databaseOid,
        role: target.apiRuntimeRole,
        tls: true
      });
      if (
        identity.databaseName !== target.databaseName ||
        String(identity.databaseOid) !== target.databaseOid ||
        identity.role !== target.verifyRole ||
        identity.tls !== true ||
        expectedRuntimeFingerprint !== target.databaseIdentityFingerprint ||
        manifest.identity.databaseIdentityFingerprint !== target.databaseIdentityFingerprint
      ) {
        throw productionError("FINAL_DATABASE_TARGET_PREPARATION_INVALID");
      }
      prepared = true;
      return Object.freeze({
        chain: input.chain,
        buildProofDigest: input.buildProofDigest,
        operationId: input.operationId,
        target: Object.freeze({
          hostname: target.hostname,
          port: 5432,
          databaseName: target.databaseName,
          tlsMode: target.tlsMode
        }),
        databaseOid: target.databaseOid,
        databaseIdentityFingerprint: target.databaseIdentityFingerprint,
        runtimeRole: target.apiRuntimeRole,
        manifest
      });
    },
    async cleanupTarget() {
      if (!prepared) throw productionError("FINAL_DATABASE_TARGET_NOT_PREPARED");
      assertProcess(
        await execute(
          "docker",
          [
            "compose",
            "--project-name",
            input.compose.projectName,
            "--file",
            path.resolve(input.composeFile),
            "down",
            "--volumes",
            "--remove-orphans"
          ],
          { environment: { ...process.env, ...environment } }
        ),
        "FINAL_DATABASE_EXACT_CLEANUP_FAILED"
      );
      return Object.freeze({ terminalStatus: "PASSED", databaseOid: target.databaseOid });
    }
  });
}

export async function createFinalComposeProductionAdapters(
  input,
  {
    execute = runProcess,
    connectDatabase = createPostgresConnector(),
    createApplicationRuntime = createFinalApplicationProductionRuntime,
    createUploader = createFileCustodyUploader
  } = {}
) {
  const launchRoot = path.resolve(input.workspace.launchRoot);
  const runtimeConfig = await readJson(path.join(launchRoot, "final-compose-runtime.v1.json"));
  validateContract("final-compose-runtime.v1", runtimeConfig);
  if (runtimeConfig.chain !== input.chain) {
    throw productionError("FINAL_COMPOSE_CHAIN_IDENTITY_MISMATCH");
  }
  const [manifest, target, custodyPolicy, apiRuntimeCredential, verifyCredential] =
    await Promise.all([
      readBoundJson(
        launchRoot,
        runtimeConfig.manifestReference,
        runtimeConfig.manifestDigest,
        "baseline-environment-manifest.v1"
      ),
      readBoundJson(
        launchRoot,
        runtimeConfig.targetReference,
        runtimeConfig.targetDigest,
        "final-compose-target.v1"
      ),
      readBoundJson(
        launchRoot,
        runtimeConfig.custodyPolicyReference,
        runtimeConfig.custodyPolicyDigest
      ),
      readJson(safeLaunchPath(launchRoot, runtimeConfig.apiRuntimeCredentialReference)),
      readJson(safeLaunchPath(launchRoot, runtimeConfig.verifyCredentialReference))
    ]);
  if (
    target.chain !== input.chain ||
    manifest.identity.buildProofDigest !== input.buildProofDigest ||
    manifest.identity.sourceSha !== input.buildProof.identity.sourceSha ||
    manifest.identity.environmentClass !== `ci-${input.chain}`
  ) {
    throw productionError("FINAL_COMPOSE_RUNTIME_IDENTITY_MISMATCH");
  }
  if (target.apiRuntimeRole === target.testRuntimeRole) {
    throw productionError("FINAL_COMPOSE_CAPABILITY_CREDENTIAL_MISMATCH", {
      profile: "application-runtime"
    });
  }
  assertCredential(apiRuntimeCredential, {
    profile: "application-runtime",
    role: target.apiRuntimeRole,
    fingerprint: target.apiRuntimeCredentialFingerprint
  });
  assertCredential(verifyCredential, {
    profile: "verify",
    role: target.verifyRole,
    fingerprint: target.verifyCredentialFingerprint
  });
  const environment = composeEnvironment({
    input,
    runtimeConfig,
    target,
    apiRuntimeCredential,
    launchRoot
  });
  const custodyAdapters = createFinalCustodyAdapters({
    evidenceRoot: input.workspace.evidenceRoot,
    chain: input.chain,
    attemptId: input.attemptId,
    custodyPolicy,
    uploader: createUploader({ root: path.join(input.workspace.evidenceRoot, "custody") }),
    attestationRef: runtimeConfig.attestationRef
  });
  const infrastructure = createInfrastructure({
    input,
    target,
    manifest,
    verifyCredential,
    composeEnvironment: environment,
    connectDatabase,
    execute
  });
  const databaseAdapters = createFinalDatabaseAdapters({
    chain: input.chain,
    buildProof: input.buildProof,
    sourceEvidence: input.sourceEvidence,
    snapshot: input.snapshotMetadata,
    workspace: input.workspace,
    composeFile: input.composeFile,
    composeProject: input.compose.projectName,
    infrastructure,
    custodyDatabaseProofs: async (value) => {
      const receipt = await custodyAdapters.custodyComponent("database-runner", value);
      return Object.freeze({ receiptDigest: sha256Canonical(receipt) });
    }
  });
  const applicationRuntime = createApplicationRuntime({
    composeFile: input.composeFile,
    composeEnvironment: environment,
    verifyCredential,
    databaseTarget: {
      hostname: target.hostAccessHostname,
      port: target.port,
      databaseName: target.databaseName,
      tlsMode: target.tlsMode
    },
    evidenceRoot: path.join(input.workspace.evidenceRoot, input.attemptId),
    execute,
    connectDatabase
  });
  const applicationAdapters = createFinalApplicationAdapters({
    composeProject: input.compose.projectName,
    chain: input.chain,
    manifest,
    buildProof: input.buildProof,
    operationId: input.operationId,
    apiManifestId: runtimeConfig.apiManifestId,
    apiSessionNonce: runtimeConfig.apiSessionNonce,
    runtime: applicationRuntime
  });

  return Object.freeze({
    async verifyCompose() {
      return Object.freeze({ ...input.compose });
    },
    ...databaseAdapters,
    ...applicationAdapters,
    async custody(context) {
      return custodyAdapters.custody({
        stageEvidence: {
          applications: context.startApplications,
          api: context.verifyApi,
          migration: context.runMigration,
          verify: context.runVerify,
          web: context.verifyWebClient
        },
        buildEvidence: ({ custodyReceiptDigests }) =>
          buildFinalComposeEvidence({
            chain: input.chain,
            buildProof: input.buildProof,
            sourceGateEvidenceDigest: input.sourceGateEvidenceDigest,
            manifestDigest: sha256Canonical(manifest),
            manifestIdentityDigest: sha256Canonical(manifest.identity),
            databaseIdentityFingerprint: target.databaseIdentityFingerprint,
            operationId: input.operationId,
            runId: input.runId,
            attemptId: input.attemptId,
            apiManifestId: runtimeConfig.apiManifestId,
            apiSessionNonce: runtimeConfig.apiSessionNonce,
            databaseTestManifestDigest: input.databaseTestManifestDigest,
            postgresImageDigest: input.postgresImageDigest,
            snapshotMetadataDigest: input.snapshotMetadataDigest,
            compose: input.compose,
            executions: {
              migration: executionReference(context.runMigration),
              verify: executionReference(context.runVerify),
              databaseTests: executionReference(context.runDatabaseTests)
            },
            databaseTests: {
              reportDigest: context.runDatabaseTests.reportDigest,
              counts: context.runDatabaseTests.counts
            },
            apiReadiness: context.verifyApi.apiReadiness,
            apiSessionRows: context.verifyApi.apiSessionRows,
            webClient: context.verifyWebClient,
            custodyReceiptDigests,
            priorFailureProofDigests: input.priorFailureProofDigests,
            producedAt: new Date().toISOString()
          })
      });
    },
    recordFailure: (failure) => custodyAdapters.recordFailure(failure)
  });
}

function executionReference(value) {
  return Object.freeze({
    operationId: value.operationId,
    postStateObservationDigest: value.postStateObservationDigest,
    executionProofDigest: value.executionProofDigest
  });
}
