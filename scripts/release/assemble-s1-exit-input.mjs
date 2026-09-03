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

const repository = "keqi119/subscription-Saas";
const workflowPath = ".github/workflows/release-candidate-gate.yml";

function exitAssemblyError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function workflowRunRef(workflowRun) {
  return `github://${workflowRun.repository}/actions/runs/${workflowRun.runId}/attempts/${workflowRun.runAttempt}`;
}

function assertCurrentWorkflow(aggregateProof, environment) {
  if (
    environment.GITHUB_REPOSITORY !== repository ||
    environment.GITHUB_WORKFLOW_REF !== `${repository}/${workflowPath}@refs/heads/main` ||
    environment.GITHUB_SHA !== aggregateProof.sourceSha ||
    environment.GITHUB_RUN_ID !== aggregateProof.workflowRun.runId ||
    Number(environment.GITHUB_RUN_ATTEMPT) !== aggregateProof.workflowRun.runAttempt
  ) {
    throw exitAssemblyError("S1_EXIT_WORKFLOW_IDENTITY_MISMATCH");
  }
}

export async function assembleS1ExitInput({
  aggregateProof,
  aggregateCustodyRecord,
  ownerAttestations,
  environment = process.env,
  now = () => new Date()
}) {
  try {
    validateContract("release-aggregate-proof.v1", aggregateProof);
    validateContract("custody-receipt.v1", aggregateCustodyRecord?.receipt);
    assertCustodyComplete(aggregateCustodyRecord.receipt, sha256Canonical(aggregateProof));
  } catch (error) {
    throw exitAssemblyError("S1_EXIT_AGGREGATE_CUSTODY_MISMATCH", {
      cause: error?.code
    });
  }
  assertCurrentWorkflow(aggregateProof, environment);
  if (
    aggregateCustodyRecord.workflowRunRef !== workflowRunRef(aggregateProof.workflowRun) ||
    sha256Canonical(aggregateCustodyRecord.content) !== sha256Canonical(aggregateProof)
  ) {
    throw exitAssemblyError("S1_EXIT_AGGREGATE_CUSTODY_MISMATCH");
  }
  try {
    validateContract("s1-owner-attestations.v1", ownerAttestations);
  } catch (error) {
    throw exitAssemblyError("S1_EXIT_OWNER_ATTESTATIONS_INVALID");
  }
  const instant = now();
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw exitAssemblyError("S1_EXIT_CLOCK_INVALID");
  }
  return Object.freeze({
    aggregateProof,
    repositoryObservations: [
      {
        schemaVersion: "s1-repository-observation.v1",
        observationId: "scope-and-inventory",
        sourceSha: aggregateProof.sourceSha,
        repositoryContractDigest: aggregateProof.contracts.repositoryContractDigest,
        status: "EVIDENCED",
        evidenceDigests: [aggregateProof.buildProofDigest],
        observedAt: instant.toISOString()
      }
    ],
    ownerAttestations: ownerAttestations.records,
    findings: {
      p0: [],
      p1: [],
      p2: ["Task30 independent exit audit pending"]
    },
    producedAt: instant.toISOString()
  });
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}

export async function runAssembleS1ExitInputCli(argv) {
  const expected = [
    "--aggregate-file",
    "--aggregate-custody-file",
    "--owner-attestations-file",
    "--output-file"
  ];
  if (
    argv.length !== expected.length * 2 ||
    expected.some((flag, index) => argv[index * 2] !== flag)
  ) {
    throw exitAssemblyError("S1_EXIT_ARGUMENT_INVALID");
  }
  const input = await assembleS1ExitInput({
    aggregateProof: await readJson(argument(argv, "--aggregate-file")),
    aggregateCustodyRecord: await readJson(argument(argv, "--aggregate-custody-file")),
    ownerAttestations: await readJson(argument(argv, "--owner-attestations-file"))
  });
  const outputFile = path.resolve(argument(argv, "--output-file"));
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, canonicalJson(input), { flag: "wx" });
  return input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runAssembleS1ExitInputCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "S1_EXIT_ASSEMBLY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
