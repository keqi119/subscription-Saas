#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

function attemptError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

export function createFinalAttemptHistory({
  chain,
  buildProof,
  sourceGateEvidence,
  finalComposeEvidence,
  snapshotMetadata = null
}) {
  try {
    validateContract("build-proof.v1", buildProof);
    validateContract("source-gate-evidence.v1", sourceGateEvidence);
    validateContract("final-compose-evidence.v1", finalComposeEvidence);
    if (chain === "snapshot") validateContract("snapshot-metadata.v1", snapshotMetadata);
  } catch (error) {
    throw attemptError("FINAL_ATTEMPT_INPUT_INVALID", { cause: error?.code });
  }
  if (
    !["fresh", "snapshot"].includes(chain) ||
    sourceGateEvidence.chain !== chain ||
    finalComposeEvidence.chain !== chain ||
    finalComposeEvidence.buildProofDigest !== sha256Canonical(buildProof) ||
    finalComposeEvidence.sourceGateEvidenceDigest !== sha256Canonical(sourceGateEvidence) ||
    finalComposeEvidence.contracts.snapshotMetadataDigest !==
      (chain === "snapshot" ? sha256Canonical(snapshotMetadata) : null)
  ) {
    throw attemptError("FINAL_ATTEMPT_INPUT_MISMATCH");
  }
  if (finalComposeEvidence.priorFailureProofDigests.length !== 0) {
    throw attemptError("FINAL_ATTEMPT_PRIOR_HISTORY_REQUIRED");
  }
  const inputIdentityDigest = sha256Canonical({
    buildProofDigest: sha256Canonical(buildProof),
    chain,
    sourceEvidenceDigest: sha256Canonical(sourceGateEvidence),
    snapshotMetadataDigest: chain === "snapshot" ? sha256Canonical(snapshotMetadata) : null
  });
  return Object.freeze({
    chain,
    attempts: Object.freeze([
      Object.freeze({
        runId: finalComposeEvidence.runId,
        attemptId: finalComposeEvidence.attemptId,
        operationId: finalComposeEvidence.operationId,
        terminalStatus: "PASSED",
        proofDigest: sha256Canonical(finalComposeEvidence),
        inputIdentityDigest,
        retained: true
      })
    ])
  });
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}

export async function runCreateFinalAttemptHistoryCli(argv) {
  const chain = argument(argv, "--chain");
  const required = [
    "--chain",
    "--build-proof-file",
    "--source-gate-evidence-file",
    "--final-evidence-file",
    "--output-file"
  ];
  const expectedLength = chain === "snapshot" ? 12 : 10;
  if (
    argv.length !== expectedLength ||
    required.some((flag) => !argument(argv, flag)) ||
    (chain === "snapshot" && !argument(argv, "--snapshot-metadata-file"))
  ) {
    throw attemptError("FINAL_ATTEMPT_ARGUMENT_INVALID");
  }
  const history = createFinalAttemptHistory({
    chain,
    buildProof: await readJson(argument(argv, "--build-proof-file")),
    sourceGateEvidence: await readJson(argument(argv, "--source-gate-evidence-file")),
    finalComposeEvidence: await readJson(argument(argv, "--final-evidence-file")),
    snapshotMetadata:
      chain === "snapshot" ? await readJson(argument(argv, "--snapshot-metadata-file")) : null
  });
  const outputFile = path.resolve(argument(argv, "--output-file"));
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, canonicalJson(history), { flag: "wx" });
  return history;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCreateFinalAttemptHistoryCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "FINAL_ATTEMPT_HISTORY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
