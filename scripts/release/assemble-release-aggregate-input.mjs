#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "../../packages/release-foundation/src/index.mjs";

const workflowPath = ".github/workflows/release-candidate-gate.yml";
const repository = "keqi119/subscription-Saas";
const requiredFiles = Object.freeze([
  "build-proof.v1.json",
  "snapshot-metadata.v1.json",
  "source-gate-fresh.v1.json",
  "source-gate-snapshot.v1.json",
  "final-compose-fresh.v1.json",
  "final-compose-snapshot.v1.json",
  "build-proof-custody-record.v1.json",
  "snapshot-metadata-custody-record.v1.json",
  "source-gate-fresh-custody-record.v1.json",
  "source-gate-snapshot-custody-record.v1.json",
  "final-compose-fresh-custody-record.v1.json",
  "final-compose-snapshot-custody-record.v1.json",
  "final-attempt-history-fresh.v1.json",
  "final-attempt-history-snapshot.v1.json"
]);

function assemblyError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

async function discoverFiles(root, directory = root, result = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await discoverFiles(root, absolute, result);
    else if (entry.isFile() && requiredFiles.includes(entry.name)) {
      if (result.has(entry.name)) {
        throw assemblyError("RELEASE_DAG_ARTIFACT_DUPLICATE", { name: entry.name });
      }
      result.set(entry.name, absolute);
    }
  }
  return result;
}

function trustedWorkflowRun(environment) {
  const expectedRef = `${repository}/${workflowPath}@refs/heads/main`;
  if (
    environment.GITHUB_REPOSITORY !== repository ||
    environment.GITHUB_WORKFLOW_REF !== expectedRef ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    !/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA ?? "") ||
    !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? "") ||
    !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ATTEMPT ?? "")
  ) {
    throw assemblyError("RELEASE_DAG_WORKFLOW_IDENTITY_INVALID");
  }
  return Object.freeze({
    repository,
    workflowPath,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    sourceSha: environment.GITHUB_SHA
  });
}

async function readRequired(files, name) {
  const file = files.get(name);
  if (!file) throw assemblyError("RELEASE_DAG_ARTIFACT_MISSING", { name });
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw assemblyError("RELEASE_DAG_ARTIFACT_INVALID", { name, cause: error?.code });
  }
}

export async function assembleReleaseAggregateInput({
  inputRoot,
  environment = process.env,
  now = () => new Date()
}) {
  const files = await discoverFiles(path.resolve(inputRoot));
  const values = Object.fromEntries(
    await Promise.all(requiredFiles.map(async (name) => [name, await readRequired(files, name)]))
  );
  const workflowRun = trustedWorkflowRun(environment);
  if (values["build-proof.v1.json"]?.identity?.sourceSha !== workflowRun.sourceSha) {
    throw assemblyError("RELEASE_DAG_SOURCE_IDENTITY_MISMATCH");
  }
  const freshHistory = values["final-attempt-history-fresh.v1.json"];
  const snapshotHistory = values["final-attempt-history-snapshot.v1.json"];
  if (freshHistory?.chain !== "fresh" || snapshotHistory?.chain !== "snapshot") {
    throw assemblyError("RELEASE_DAG_ATTEMPT_HISTORY_INVALID");
  }
  const instant = now();
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw assemblyError("RELEASE_DAG_CLOCK_INVALID");
  }
  return Object.freeze({
    workflowRun,
    buildProof: values["build-proof.v1.json"],
    snapshotMetadata: values["snapshot-metadata.v1.json"],
    sourceGateEvidence: {
      fresh: values["source-gate-fresh.v1.json"],
      snapshot: values["source-gate-snapshot.v1.json"]
    },
    finalComposeEvidence: {
      fresh: values["final-compose-fresh.v1.json"],
      snapshot: values["final-compose-snapshot.v1.json"]
    },
    custodyRecords: {
      buildProof: values["build-proof-custody-record.v1.json"],
      snapshotMetadata: values["snapshot-metadata-custody-record.v1.json"],
      sourceFresh: values["source-gate-fresh-custody-record.v1.json"],
      sourceSnapshot: values["source-gate-snapshot-custody-record.v1.json"],
      finalFresh: values["final-compose-fresh-custody-record.v1.json"],
      finalSnapshot: values["final-compose-snapshot-custody-record.v1.json"]
    },
    attemptHistory: {
      fresh: freshHistory.attempts,
      snapshot: snapshotHistory.attempts
    },
    aggregatedAt: instant.toISOString()
  });
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runAssembleReleaseAggregateInputCli(argv) {
  if (argv.length !== 4 || argv[0] !== "--input-root" || argv[2] !== "--output-file") {
    throw assemblyError("RELEASE_DAG_ARGUMENT_INVALID");
  }
  const input = await assembleReleaseAggregateInput({ inputRoot: argument(argv, "--input-root") });
  const outputFile = path.resolve(argument(argv, "--output-file"));
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, canonicalJson(input), { flag: "wx" });
  return input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runAssembleReleaseAggregateInputCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "RELEASE_DAG_ASSEMBLY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
