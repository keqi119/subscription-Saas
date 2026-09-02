#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  sha256Canonical,
  sha256Text,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

import { readComposeConfig, verifyComposeConfig } from "./verify-compose-policy.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const chainNames = Object.freeze(["fresh", "snapshot"]);

export const API_DATABASE_SESSION_SQL = `
SELECT d.oid::text AS database_oid,
       a.usename,
       a.application_name,
       COALESCE(s.ssl, false) AS tls,
       a.state
FROM pg_stat_activity AS a
JOIN pg_database AS d ON d.datname = a.datname
LEFT JOIN pg_stat_ssl AS s ON s.pid = a.pid
WHERE a.datname = current_database()
  AND a.application_name = $1
  AND a.backend_type = 'client backend'
ORDER BY a.pid
`.trim();

function gateError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

export function releaseImageReferences(buildProof) {
  validateContract("build-proof.v1", buildProof);
  const images = buildProof.identity.images;
  const references = {};
  for (const name of ["api", "runner", "web"]) {
    const image = images[name];
    if (
      image.name !== name ||
      image.platform !== "linux/amd64" ||
      image.sourceRevision !== buildProof.identity.sourceSha ||
      !digestPattern.test(image.imageDigest)
    ) {
      throw gateError("FINAL_COMPOSE_RELEASE_INPUT_MISMATCH", { image: name });
    }
    references[name] = `${image.registry}@${image.imageDigest}`;
  }
  return deepFreeze(references);
}

export function verifyApiDatabaseSession({ rows, expected }) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw gateError("API_DATABASE_SESSION_IDENTITY_MISMATCH", { matches: rows?.length ?? 0 });
  }
  const row = rows[0];
  if (
    String(row.database_oid) !== String(expected.databaseOid) ||
    row.usename !== expected.runtimeRole ||
    row.application_name !== expected.applicationName ||
    row.tls !== expected.tls ||
    !["active", "idle", "idle in transaction"].includes(row.state)
  ) {
    throw gateError("API_DATABASE_SESSION_IDENTITY_MISMATCH");
  }
  return deepFreeze({
    applicationName: row.application_name,
    databaseOid: String(row.database_oid),
    runtimeRole: row.usename,
    tls: row.tls,
    sessionState: row.state
  });
}

function assertTestCounts(counts) {
  if (
    !counts ||
    counts.collected !== counts.selected ||
    counts.selected !== counts.executed ||
    counts.executed !== counts.passed + counts.failed ||
    ["failed", "skipped", "todo", "filtered", "cancelled"].some((field) => counts[field] !== 0)
  ) {
    throw gateError("FINAL_COMPOSE_TEST_COUNTS_INVALID");
  }
}

function assertWebClient(input) {
  const expectedRequest = new URL(
    "portal/catalog/model-definitions",
    `${input.publicApiBase.replace(/\/$/u, "")}/`
  ).toString();
  if (
    input.publicApiBase !== input.embeddedApiBase ||
    input.actualRequestUrl !== expectedRequest ||
    input.corsAllowOrigin !== input.webOrigin ||
    input.responseStatus !== 200 ||
    input.bundleContainsEmbeddedApiBase !== true
  ) {
    throw gateError("WEB_PUBLIC_API_IDENTITY_MISMATCH");
  }
}

export function buildFinalComposeEvidence(input) {
  if (!chainNames.includes(input.chain)) throw gateError("FINAL_COMPOSE_CHAIN_INVALID");
  const releaseImages = releaseImageReferences(input.buildProof);
  assertTestCounts(input.databaseTests?.counts);
  assertWebClient(input.webClient);
  const expectedApplicationName = `subscription-api/${input.apiManifestId}/${input.apiSessionNonce}`;
  if (input.apiReadiness?.applicationName !== expectedApplicationName) {
    throw gateError("API_DATABASE_SESSION_IDENTITY_MISMATCH");
  }
  const verifiedApiSession = verifyApiDatabaseSession({
    rows: input.apiSessionRows,
    expected: {
      databaseOid: input.apiReadiness.databaseOid,
      runtimeRole: input.apiReadiness.runtimeRole,
      applicationName: expectedApplicationName,
      tls: true
    }
  });
  if (
    (input.chain === "fresh" && input.snapshotMetadataDigest !== null) ||
    (input.chain === "snapshot" && !digestPattern.test(input.snapshotMetadataDigest ?? ""))
  ) {
    throw gateError("FINAL_COMPOSE_SNAPSHOT_CONTRACT_INVALID");
  }
  const evidence = {
    schemaVersion: "final-compose-evidence.v1",
    chain: input.chain,
    terminalStatus: "PASSED",
    buildProofDigest: sha256Canonical(input.buildProof),
    sourceSha: input.buildProof.identity.sourceSha,
    releaseImages,
    sourceGateEvidenceDigest: input.sourceGateEvidenceDigest,
    manifestDigest: input.manifestDigest,
    manifestIdentityDigest: input.manifestIdentityDigest,
    databaseIdentityFingerprint: input.databaseIdentityFingerprint,
    operationId: input.operationId,
    runId: input.runId,
    attemptId: input.attemptId,
    apiSessionNonceDigest: `sha256:${sha256Text(input.apiSessionNonce)}`,
    contracts: {
      migrationCatalogDigest: input.buildProof.identity.migrationCatalogDigest,
      repositoryContractDigest: input.buildProof.identity.repositoryContractDigest,
      databaseTestManifestDigest: input.databaseTestManifestDigest,
      postgresImageDigest: input.postgresImageDigest,
      snapshotMetadataDigest: input.snapshotMetadataDigest
    },
    compose: input.compose,
    executions: input.executions,
    databaseTests: input.databaseTests,
    apiReadiness: { ...input.apiReadiness, ...verifiedApiSession },
    webClient: input.webClient,
    custodyReceiptDigests: input.custodyReceiptDigests,
    priorFailureProofDigests: input.priorFailureProofDigests ?? [],
    producedAt: input.producedAt
  };
  validateContract("final-compose-evidence.v1", evidence);
  return deepFreeze(canonicalClone(evidence));
}

export function validateFinalComposeEvidence(evidence) {
  validateContract("final-compose-evidence.v1", evidence);
  assertTestCounts(evidence.databaseTests.counts);
  assertWebClient(evidence.webClient);
  return true;
}

export function assertIndependentChainEvidence(fresh, snapshot) {
  validateFinalComposeEvidence(fresh);
  validateFinalComposeEvidence(snapshot);
  if (fresh.chain !== "fresh" || snapshot.chain !== "snapshot") {
    throw gateError("FINAL_COMPOSE_CHAIN_INVALID");
  }
  const shared = ["buildProofDigest", "sourceSha"];
  if (
    shared.some((field) => fresh[field] !== snapshot[field]) ||
    sha256Canonical(fresh.releaseImages) !== sha256Canonical(snapshot.releaseImages) ||
    fresh.contracts.migrationCatalogDigest !== snapshot.contracts.migrationCatalogDigest ||
    fresh.contracts.repositoryContractDigest !== snapshot.contracts.repositoryContractDigest ||
    fresh.contracts.databaseTestManifestDigest !== snapshot.contracts.databaseTestManifestDigest ||
    fresh.contracts.postgresImageDigest !== snapshot.contracts.postgresImageDigest
  ) {
    throw gateError("FINAL_COMPOSE_RELEASE_INPUT_MISMATCH");
  }
  const independent = [
    "sourceGateEvidenceDigest",
    "manifestDigest",
    "manifestIdentityDigest",
    "databaseIdentityFingerprint",
    "operationId",
    "runId",
    "attemptId",
    "apiSessionNonceDigest"
  ];
  if (independent.some((field) => fresh[field] === snapshot[field])) {
    throw gateError("FINAL_COMPOSE_CHAIN_IDENTITY_REUSED");
  }
  const proofDigests = (value) =>
    Object.values(value.executions).flatMap((execution) => [
      execution.operationId,
      execution.postStateObservationDigest,
      execution.executionProofDigest
    ]);
  if (proofDigests(fresh).some((value) => proofDigests(snapshot).includes(value))) {
    throw gateError("FINAL_COMPOSE_CHAIN_IDENTITY_REUSED");
  }
  if (
    fresh.compose.configDigest === snapshot.compose.configDigest ||
    fresh.databaseTests.reportDigest === snapshot.databaseTests.reportDigest ||
    fresh.apiReadiness.databaseOid === snapshot.apiReadiness.databaseOid ||
    fresh.apiReadiness.applicationName === snapshot.apiReadiness.applicationName ||
    fresh.apiReadiness.evidenceDigest === snapshot.apiReadiness.evidenceDigest ||
    fresh.webClient.evidenceDigest === snapshot.webClient.evidenceDigest ||
    fresh.custodyReceiptDigests.some((digest) => snapshot.custodyReceiptDigests.includes(digest))
  ) {
    throw gateError("FINAL_COMPOSE_CHAIN_IDENTITY_REUSED");
  }
  return true;
}

export function assertLegalFinalComposeRetry(previous, current) {
  validateFinalComposeEvidence(current);
  if (
    !previous ||
    previous.terminalStatus !== "FAILED" ||
    previous.databaseWritesStarted !== false ||
    !digestPattern.test(previous.failureProofDigest ?? "") ||
    !current.priorFailureProofDigests.includes(previous.failureProofDigest)
  ) {
    throw gateError("FINAL_COMPOSE_RETRY_NOT_ALLOWED");
  }
  if (
    previous.buildProofDigest !== current.buildProofDigest ||
    sha256Canonical(previous.releaseImages) !== sha256Canonical(current.releaseImages) ||
    sha256Canonical(previous.contracts) !== sha256Canonical(current.contracts) ||
    previous.sourceGateEvidenceDigest !== current.sourceGateEvidenceDigest
  ) {
    throw gateError("FINAL_COMPOSE_RETRY_INPUT_MISMATCH");
  }
  if (
    previous.operationId === current.operationId ||
    previous.runId === current.runId ||
    previous.attemptId === current.attemptId
  ) {
    throw gateError("FINAL_COMPOSE_RETRY_IDENTITY_REUSED");
  }
  return true;
}

export async function executeFinalComposeGate(input, adapters) {
  if (!chainNames.includes(input.chain)) throw gateError("FINAL_COMPOSE_CHAIN_INVALID");
  const stages = [
    "verifyCompose",
    "prepareTarget",
    "runMigration",
    "runVerify",
    "runDatabaseTests",
    "startApplications",
    "verifyApi",
    "verifyWebClient",
    "custody"
  ];
  for (const stage of stages) {
    if (typeof adapters?.[stage] !== "function") {
      throw gateError("FINAL_COMPOSE_TRUSTED_ADAPTER_MISSING", { stage });
    }
  }
  if (typeof adapters.recordFailure !== "function") {
    throw gateError("FINAL_COMPOSE_TRUSTED_ADAPTER_MISSING", { stage: "recordFailure" });
  }
  const context = { ...input };
  for (const [index, stage] of stages.entries()) {
    try {
      context[stage] = await adapters[stage](deepFreeze({ ...context }));
    } catch (error) {
      const failureRecord = await adapters.recordFailure(
        deepFreeze({
          schemaVersion: "final-compose-failure.v1",
          chain: input.chain,
          operationId: input.operationId,
          runId: input.runId,
          attemptId: input.attemptId,
          terminalStatus: error?.outcomeUnknown === true ? "INTERRUPTED_UNKNOWN" : "FAILED",
          failedStage: stage,
          failureCode: error?.code ?? "FINAL_COMPOSE_STAGE_FAILED",
          databaseWritesStarted: index > 0,
          buildProofDigest: input.buildProofDigest,
          releaseImages: input.releaseImages,
          contracts: input.contracts,
          sourceGateEvidenceDigest: input.sourceGateEvidenceDigest
        })
      );
      error.failureRecord = failureRecord;
      throw error;
    }
  }
  return deepFreeze(context);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const chain = argument("--chain");
  const buildProofFile = argument("--build-proof-file");
  const evidenceInputFile =
    argument("--evidence-input-file") ?? `.release-inputs/${chain}-final-compose-input.json`;
  const sourceGateEvidenceFile =
    argument("--source-gate-evidence-file") ?? `.release-inputs/${chain}-source-gate-evidence.json`;
  const outputFile =
    argument("--output-file") ?? `.release-evidence/${chain}/final-compose-evidence.v1.json`;
  const snapshotMetadataFile =
    argument("--snapshot-metadata-file") ?? ".release-inputs/snapshot-metadata.json";
  const composeFile = argument("--compose-file") ?? "docker-compose.release-gate.yml";
  if (!chain || !buildProofFile) {
    throw gateError("FINAL_COMPOSE_ARGUMENT_REQUIRED");
  }
  const [buildProof, evidenceInput, sourceGateEvidence] = await Promise.all([
    readFile(path.resolve(buildProofFile), "utf8").then(JSON.parse),
    readFile(path.resolve(evidenceInputFile), "utf8").then(JSON.parse),
    readFile(path.resolve(sourceGateEvidenceFile), "utf8").then(JSON.parse)
  ]);
  validateContract("source-gate-evidence.v1", sourceGateEvidence);
  const expectedImages = releaseImageReferences(buildProof);
  const composeConfig = readComposeConfig(composeFile);
  const composePolicy = verifyComposeConfig(composeConfig, {
    expectedImages,
    expectedSourceSha: buildProof.identity.sourceSha
  });
  if (
    sourceGateEvidence.chain !== chain ||
    sourceGateEvidence.terminalStatus !== "PASSED" ||
    sourceGateEvidence.sourceSha !== buildProof.identity.sourceSha ||
    sourceGateEvidence.migrationCatalogDigest !== buildProof.identity.migrationCatalogDigest ||
    sourceGateEvidence.repositoryContractDigest !== buildProof.identity.repositoryContractDigest
  ) {
    throw gateError("FINAL_COMPOSE_SOURCE_GATE_MISMATCH");
  }
  let snapshotMetadataDigest = null;
  if (chain === "snapshot") {
    const snapshotMetadata = JSON.parse(await readFile(path.resolve(snapshotMetadataFile), "utf8"));
    validateContract("snapshot-metadata.v1", snapshotMetadata);
    snapshotMetadataDigest = sha256Canonical(snapshotMetadata);
    if (sourceGateEvidence.snapshot?.snapshotMetadataDigest !== snapshotMetadataDigest) {
      throw gateError("FINAL_COMPOSE_SNAPSHOT_CONTRACT_INVALID");
    }
  }
  const composeConfigDigest = sha256Canonical(composeConfig);
  if (
    evidenceInput.compose?.configDigest &&
    evidenceInput.compose.configDigest !== composeConfigDigest
  ) {
    throw gateError("FINAL_COMPOSE_CONFIG_DIGEST_MISMATCH");
  }
  const evidence = buildFinalComposeEvidence({
    ...evidenceInput,
    chain,
    buildProof,
    sourceGateEvidenceDigest: sha256Canonical(sourceGateEvidence),
    databaseTestManifestDigest: sourceGateEvidence.databaseTestManifestDigest,
    postgresImageDigest: sourceGateEvidence.postgres.imageDigest,
    snapshotMetadataDigest,
    compose: {
      ...evidenceInput.compose,
      configDigest: composeConfigDigest
    }
  });
  if (composePolicy.serviceCount < 1) throw gateError("FINAL_COMPOSE_POLICY_EMPTY");
  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await writeFile(path.resolve(outputFile), canonicalJson(evidence), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ evidenceDigest: sha256Canonical(evidence) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "FINAL_COMPOSE_GATE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
