#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertCustodyComplete,
  canonicalJson,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

import {
  assertIndependentChainEvidence,
  releaseImageReferences,
  validateFinalComposeEvidence
} from "./run-final-compose-gate.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function aggregateError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function validateAs(schemaId, value, code) {
  try {
    validateContract(schemaId, value);
  } catch (error) {
    throw aggregateError(code, { cause: error?.code });
  }
}

function assertCountEquation(counts) {
  if (
    counts?.collected !== counts?.selected ||
    counts?.selected !== counts?.executed ||
    counts?.executed !== counts?.passed + counts?.failed ||
    counts?.failed !== 0 ||
    counts?.skipped !== 0 ||
    counts?.todo !== 0 ||
    counts?.filtered !== 0 ||
    counts?.cancelled !== 0
  ) {
    throw aggregateError("RELEASE_TEST_COUNT_EQUATION_FAILED");
  }
}

function workflowRunRef(workflowRun) {
  return `github://${workflowRun.repository}/actions/runs/${workflowRun.runId}/attempts/${workflowRun.runAttempt}`;
}

function assertWorkflowRun(workflowRun, sourceSha) {
  if (
    workflowRun?.repository !== "keqi119/subscription-Saas" ||
    workflowRun.workflowPath !== ".github/workflows/release-candidate-gate.yml" ||
    !/^[1-9][0-9]*$/u.test(workflowRun.runId ?? "") ||
    !Number.isInteger(workflowRun.runAttempt) ||
    workflowRun.runAttempt < 1 ||
    workflowRun.sourceSha !== sourceSha
  ) {
    throw aggregateError("RELEASE_WORKFLOW_RUN_INVALID");
  }
}

function assertSourceEvidence({ source, chain, proof, expectedWorkflowRunRef }) {
  validateAs("source-gate-evidence.v1", source, "RELEASE_SOURCE_GATE_INVALID");
  assertCountEquation(source.counts);
  if (source.provenance.ciRunRef !== expectedWorkflowRunRef) {
    throw aggregateError("RELEASE_WORKFLOW_RUN_MISMATCH", { chain });
  }
  if (
    source.chain !== chain ||
    source.terminalStatus !== "PASSED" ||
    source.sourceSha !== proof.identity.sourceSha
  ) {
    throw aggregateError("RELEASE_SOURCE_IDENTITY_MISMATCH", { chain });
  }
  if (
    source.migrationCatalogDigest !== proof.identity.migrationCatalogDigest ||
    source.repositoryContractDigest !== proof.identity.repositoryContractDigest
  ) {
    throw aggregateError("RELEASE_CONTRACT_IDENTITY_MISMATCH", { chain });
  }
}

function assertFinalEvidence({ evidence, chain, proof, source, snapshotMetadataDigest }) {
  try {
    validateFinalComposeEvidence(evidence);
  } catch (error) {
    throw aggregateError("RELEASE_FINAL_COMPOSE_INVALID", { chain, cause: error?.code });
  }
  if (
    evidence.chain !== chain ||
    evidence.buildProofDigest !== sha256Canonical(proof) ||
    evidence.sourceSha !== proof.identity.sourceSha
  ) {
    throw aggregateError("RELEASE_SOURCE_IDENTITY_MISMATCH", { chain });
  }
  if (sha256Canonical(evidence.releaseImages) !== sha256Canonical(releaseImageReferences(proof))) {
    throw aggregateError("RELEASE_IMAGE_BUNDLE_MISMATCH", { chain });
  }
  if (
    evidence.contracts.migrationCatalogDigest !== source.migrationCatalogDigest ||
    evidence.contracts.repositoryContractDigest !== source.repositoryContractDigest
  ) {
    throw aggregateError("RELEASE_CONTRACT_IDENTITY_MISMATCH", { chain });
  }
  if (evidence.contracts.databaseTestManifestDigest !== source.databaseTestManifestDigest) {
    throw aggregateError("RELEASE_TEST_MANIFEST_MISMATCH", { chain });
  }
  if (
    evidence.contracts.postgresImageDigest !== source.postgres.imageDigest ||
    evidence.contracts.snapshotMetadataDigest !== snapshotMetadataDigest ||
    evidence.sourceGateEvidenceDigest !== sha256Canonical(source)
  ) {
    throw aggregateError("RELEASE_CHAIN_EVIDENCE_MISMATCH", { chain });
  }
  assertCountEquation(evidence.databaseTests.counts);
}

function assertCustodyRecord(record, content, expectedWorkflowRunRef) {
  const contentDigest = sha256Canonical(content);
  if (
    record?.workflowRunRef !== expectedWorkflowRunRef ||
    sha256Canonical(record?.content) !== contentDigest
  ) {
    throw aggregateError("RELEASE_CUSTODY_INCOMPLETE", { contentDigest });
  }
  try {
    validateContract("custody-receipt.v1", record.receipt);
    assertCustodyComplete(record.receipt, contentDigest);
  } catch (error) {
    throw aggregateError("RELEASE_CUSTODY_INCOMPLETE", {
      contentDigest,
      cause: error?.code
    });
  }
}

function retryIdentity(input, chain) {
  return sha256Canonical({
    buildProofDigest: sha256Canonical(input.buildProof),
    chain,
    sourceEvidenceDigest: sha256Canonical(input.sourceGateEvidence[chain]),
    snapshotMetadataDigest: chain === "snapshot" ? sha256Canonical(input.snapshotMetadata) : null
  });
}

function assertAttemptHistory(input) {
  const allProofDigests = new Set();
  for (const history of Object.values(input.attemptHistory ?? {})) {
    if (!Array.isArray(history)) continue;
    for (const { proofDigest } of history) {
      if (allProofDigests.has(proofDigest)) {
        throw aggregateError("RELEASE_ATTEMPT_PROOF_OVERWRITTEN");
      }
      allProofDigests.add(proofDigest);
    }
  }
  allProofDigests.clear();
  for (const chain of ["fresh", "snapshot"]) {
    const history = input.attemptHistory?.[chain];
    const selected = input.finalComposeEvidence[chain];
    const expectedIdentity = retryIdentity(input, chain);
    if (!Array.isArray(history) || history.length === 0) {
      throw aggregateError("RELEASE_ATTEMPT_HISTORY_INCOMPLETE", { chain });
    }
    const prior = history.filter(({ terminalStatus }) => terminalStatus !== "PASSED");
    const expectedPrior = new Set(selected.priorFailureProofDigests);
    if (
      prior.length !== expectedPrior.size ||
      prior.some(({ proofDigest }) => !expectedPrior.has(proofDigest))
    ) {
      throw aggregateError("RELEASE_ATTEMPT_HISTORY_INCOMPLETE", { chain });
    }
    const selectedEntries = history.filter(({ terminalStatus }) => terminalStatus === "PASSED");
    if (
      selectedEntries.length !== 1 ||
      selectedEntries[0].proofDigest !== sha256Canonical(selected) ||
      selectedEntries[0].runId !== selected.runId ||
      selectedEntries[0].attemptId !== selected.attemptId ||
      selectedEntries[0].operationId !== selected.operationId
    ) {
      throw aggregateError("RELEASE_SELECTED_ATTEMPT_MISMATCH", { chain });
    }
    for (const attempt of history) {
      if (
        !uuidPattern.test(attempt?.runId ?? "") ||
        !uuidPattern.test(attempt?.attemptId ?? "") ||
        !uuidPattern.test(attempt?.operationId ?? "") ||
        !["PASSED", "FAILED", "INTERRUPTED_UNKNOWN"].includes(attempt?.terminalStatus) ||
        !digestPattern.test(attempt?.proofDigest ?? "") ||
        attempt?.retained !== true
      ) {
        throw aggregateError("RELEASE_ATTEMPT_HISTORY_INVALID", { chain });
      }
      if (attempt.inputIdentityDigest !== expectedIdentity) {
        throw aggregateError("RELEASE_RETRY_INPUT_MISMATCH", { chain });
      }
      if (allProofDigests.has(attempt.proofDigest)) {
        throw aggregateError("RELEASE_ATTEMPT_PROOF_OVERWRITTEN", { chain });
      }
      allProofDigests.add(attempt.proofDigest);
    }
  }
}

function executionSummary(evidence) {
  return Object.freeze({
    manifestDigest: evidence.manifestDigest,
    manifestIdentityDigest: evidence.manifestIdentityDigest,
    postStateObservationDigest: evidence.executions.databaseTests.postStateObservationDigest,
    executionProofDigest: evidence.executions.databaseTests.executionProofDigest
  });
}

export function aggregateReleaseProof(input) {
  validateAs("build-proof.v1", input?.buildProof, "RELEASE_BUILD_PROOF_INVALID");
  validateAs("snapshot-metadata.v1", input?.snapshotMetadata, "RELEASE_SNAPSHOT_INVALID");
  assertWorkflowRun(input.workflowRun, input.buildProof.identity.sourceSha);
  const expectedWorkflowRunRef = workflowRunRef(input.workflowRun);
  if (Date.parse(input.snapshotMetadata.expiresAt) <= Date.parse(input.aggregatedAt)) {
    throw aggregateError("RELEASE_SNAPSHOT_EXPIRED");
  }

  for (const chain of ["fresh", "snapshot"]) {
    assertSourceEvidence({
      source: input.sourceGateEvidence?.[chain],
      chain,
      proof: input.buildProof,
      expectedWorkflowRunRef
    });
  }
  if (
    input.sourceGateEvidence.fresh.databaseTestManifestDigest !==
    input.sourceGateEvidence.snapshot.databaseTestManifestDigest
  ) {
    throw aggregateError("RELEASE_TEST_MANIFEST_MISMATCH");
  }
  if (
    input.sourceGateEvidence.fresh.databaseTestDiscoveryDigest !==
      input.sourceGateEvidence.snapshot.databaseTestDiscoveryDigest ||
    input.sourceGateEvidence.fresh.postgres.imageDigest !==
      input.sourceGateEvidence.snapshot.postgres.imageDigest
  ) {
    throw aggregateError("RELEASE_CHAIN_CONTRACT_MISMATCH");
  }
  const snapshotMetadataDigest = sha256Canonical(input.snapshotMetadata);
  if (
    input.sourceGateEvidence.snapshot.snapshot?.snapshotMetadataDigest !== snapshotMetadataDigest
  ) {
    throw aggregateError("RELEASE_SNAPSHOT_IDENTITY_MISMATCH");
  }

  assertFinalEvidence({
    evidence: input.finalComposeEvidence?.fresh,
    chain: "fresh",
    proof: input.buildProof,
    source: input.sourceGateEvidence.fresh,
    snapshotMetadataDigest: null
  });
  assertFinalEvidence({
    evidence: input.finalComposeEvidence?.snapshot,
    chain: "snapshot",
    proof: input.buildProof,
    source: input.sourceGateEvidence.snapshot,
    snapshotMetadataDigest
  });
  try {
    assertIndependentChainEvidence(
      input.finalComposeEvidence.fresh,
      input.finalComposeEvidence.snapshot
    );
  } catch (error) {
    throw aggregateError("RELEASE_CHAIN_EVIDENCE_MISMATCH", { cause: error?.code });
  }

  const custodyContents = {
    buildProof: input.buildProof,
    snapshotMetadata: input.snapshotMetadata,
    sourceFresh: input.sourceGateEvidence.fresh,
    sourceSnapshot: input.sourceGateEvidence.snapshot,
    finalFresh: input.finalComposeEvidence.fresh,
    finalSnapshot: input.finalComposeEvidence.snapshot
  };
  for (const [key, content] of Object.entries(custodyContents)) {
    assertCustodyRecord(input.custodyRecords?.[key], content, expectedWorkflowRunRef);
  }
  assertAttemptHistory(input);

  const proof = {
    schemaVersion: "release-aggregate-proof.v1",
    sourceSha: input.buildProof.identity.sourceSha,
    workflowRun: { ...input.workflowRun },
    buildProofDigest: sha256Canonical(input.buildProof),
    releaseImages: releaseImageReferences(input.buildProof),
    contracts: {
      migrationCatalogDigest: input.buildProof.identity.migrationCatalogDigest,
      repositoryContractDigest: input.buildProof.identity.repositoryContractDigest,
      databaseTestManifestDigest: input.sourceGateEvidence.fresh.databaseTestManifestDigest,
      databaseTestDiscoveryDigest: input.sourceGateEvidence.fresh.databaseTestDiscoveryDigest,
      postgresImageDigest: input.sourceGateEvidence.fresh.postgres.imageDigest,
      snapshotMetadataDigest
    },
    sourceGateEvidence: {
      fresh: sha256Canonical(input.sourceGateEvidence.fresh),
      snapshot: sha256Canonical(input.sourceGateEvidence.snapshot)
    },
    finalComposeEvidence: {
      fresh: sha256Canonical(input.finalComposeEvidence.fresh),
      snapshot: sha256Canonical(input.finalComposeEvidence.snapshot)
    },
    finalArtifactExecutions: {
      fresh: executionSummary(input.finalComposeEvidence.fresh),
      snapshot: executionSummary(input.finalComposeEvidence.snapshot)
    },
    composeEvidenceDigest: sha256Canonical({
      fresh: input.finalComposeEvidence.fresh.compose,
      snapshot: input.finalComposeEvidence.snapshot.compose
    }),
    apiReadinessEvidenceDigest: sha256Canonical({
      fresh: input.finalComposeEvidence.fresh.apiReadiness,
      snapshot: input.finalComposeEvidence.snapshot.apiReadiness
    }),
    webClientEvidenceDigest: sha256Canonical({
      fresh: input.finalComposeEvidence.fresh.webClient,
      snapshot: input.finalComposeEvidence.snapshot.webClient
    }),
    custodyReceiptDigests: Object.fromEntries(
      Object.entries(input.custodyRecords).map(([key, record]) => [
        key,
        sha256Canonical(record.receipt)
      ])
    ),
    attemptHistoryDigest: sha256Canonical(input.attemptHistory),
    aggregatedAt: input.aggregatedAt
  };
  validateAs("release-aggregate-proof.v1", proof, "RELEASE_AGGREGATE_CONTRACT_INVALID");
  return Object.freeze(JSON.parse(canonicalJson(proof)));
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}

export async function runAggregateCli(argv) {
  const inputFile = argument(argv, "--input-file");
  const outputFile = argument(argv, "--output-file");
  if (argv.length !== 4 || !inputFile || !outputFile) {
    throw aggregateError("RELEASE_AGGREGATE_ARGUMENT_REQUIRED");
  }
  const proof = aggregateReleaseProof(await readJson(inputFile));
  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await writeFile(path.resolve(outputFile), canonicalJson(proof), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ proofDigest: sha256Canonical(proof) })}\n`);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runAggregateCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "RELEASE_AGGREGATE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
