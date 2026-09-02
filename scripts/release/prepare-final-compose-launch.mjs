#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

const trustedAdapterUrl = pathToFileURL(
  "/opt/subscription-saas/release-candidate-adapter/v1/index.mjs"
).href;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function preparationError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function safeRelativeFile(root, relative, expected) {
  if (relative !== expected) throw preparationError("FINAL_PREPARATION_FILE_SET_INVALID");
  const absolute = path.resolve(root, relative);
  const difference = path.relative(path.resolve(root), absolute);
  if (!difference || difference.startsWith("..") || path.isAbsolute(difference)) {
    throw preparationError("FINAL_PREPARATION_FILE_PATH_FORBIDDEN");
  }
  return absolute;
}

function safeReferencedFile(root, relative) {
  if (
    typeof relative !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]+\.(?:json|secret)$/u.test(relative)
  ) {
    throw preparationError("FINAL_PREPARATION_FILE_PATH_FORBIDDEN");
  }
  const absolute = path.resolve(root, ...relative.split("/"));
  const difference = path.relative(path.resolve(root), absolute);
  if (!difference || difference.startsWith("..") || path.isAbsolute(difference)) {
    throw preparationError("FINAL_PREPARATION_FILE_PATH_FORBIDDEN");
  }
  return absolute;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw preparationError("FINAL_PREPARATION_ARTIFACT_INVALID", {
      file: path.basename(file),
      cause: error?.code
    });
  }
}

export function assertPreparedLaunchBindings({
  runtime,
  target,
  manifest,
  custodyPolicy,
  envelope,
  input
}) {
  const buildProofDigest = sha256Canonical(input.buildProof);
  const environmentClass = `ci-${input.chain}`;
  if (
    runtime.chain !== input.chain ||
    target.chain !== input.chain ||
    runtime.manifestDigest !== sha256Canonical(manifest) ||
    runtime.targetDigest !== sha256Canonical(target) ||
    runtime.custodyPolicyDigest !== sha256Canonical(custodyPolicy) ||
    envelope.commandKey !== "db.migrate.deploy@1" ||
    envelope.buildProofDigest !== buildProofDigest ||
    envelope.actualRunnerDigest !== input.buildProof.identity.images.runner.imageDigest ||
    envelope.custodyPolicyDigest !== runtime.custodyPolicyDigest ||
    envelope.request?.phase !== "dry-run" ||
    envelope.request?.buildProofDigest !== buildProofDigest ||
    envelope.request?.baselineManifestDigest !== runtime.manifestDigest ||
    envelope.request?.databaseIdentityDigest !== target.databaseIdentityFingerprint ||
    envelope.request?.environmentClass !== environmentClass ||
    manifest.identity?.buildProofDigest !== buildProofDigest ||
    manifest.identity?.sourceSha !== input.buildProof.identity.sourceSha ||
    manifest.identity?.migrationCatalogDigest !== input.sourceGateEvidence.migrationCatalogDigest ||
    manifest.identity?.repositoryContractDigest !==
      input.sourceGateEvidence.repositoryContractDigest ||
    manifest.identity?.databaseIdentityFingerprint !== target.databaseIdentityFingerprint ||
    manifest.identity?.environmentClass !== environmentClass
  ) {
    throw preparationError("FINAL_PREPARATION_BINDING_MISMATCH");
  }
  return true;
}

async function inspectPreparationArtifacts(result, input) {
  const root = path.resolve(input.launchRoot);
  if (result.phase === "prepare") {
    const runtime = await readJson(
      safeRelativeFile(root, result.files.runtime, "final-compose-runtime.v1.json")
    );
    const target = await readJson(
      safeRelativeFile(root, result.files.target, "final-compose-target.v1.json")
    );
    const envelope = await readJson(
      safeRelativeFile(root, result.files.dryRunEnvelope, "migration-dry-run.json")
    );
    const [manifest, custodyPolicy] = await Promise.all([
      readJson(safeReferencedFile(root, runtime.manifestReference)),
      readJson(safeReferencedFile(root, runtime.custodyPolicyReference))
    ]);
    validateContract("final-compose-runtime.v1", runtime);
    validateContract("final-compose-target.v1", target);
    validateContract("baseline-environment-manifest.v1", manifest);
    validateContract("runner-launch-envelope.v1", envelope);
    assertPreparedLaunchBindings({
      runtime,
      target,
      manifest,
      custodyPolicy,
      envelope,
      input
    });
    return;
  }
  const expected = {
    applyEnvelope: "migration-apply.json",
    replayEnvelope: "migration-replay.json",
    verifyEnvelope: "schema-verify.json",
    databaseTestsEnvelope: "database-tests.json"
  };
  for (const [key, fileName] of Object.entries(expected)) {
    const envelope = await readJson(safeRelativeFile(root, result.files[key], fileName));
    validateContract(
      key === "databaseTestsEnvelope"
        ? "database-test-launch-envelope.v1"
        : "runner-launch-envelope.v1",
      envelope
    );
    if (envelope.buildProofDigest !== sha256Canonical(input.buildProof)) {
      throw preparationError("FINAL_PREPARATION_IDENTITY_MISMATCH");
    }
  }
}

function assertInput(input) {
  validateContract("build-proof.v1", input?.buildProof);
  validateContract("source-gate-evidence.v1", input?.sourceGateEvidence);
  if (
    !["prepare", "finalize"].includes(input.phase) ||
    !["fresh", "snapshot"].includes(input.chain) ||
    input.sourceGateEvidence.chain !== input.chain ||
    input.sourceGateEvidence.sourceSha !== input.buildProof.identity.sourceSha ||
    input.sourceGateEvidence.postSchemaDigest === undefined ||
    input.launchRoot !== `.release-local/launch/${input.chain}` ||
    input.composeFile !== "docker-compose.release-gate.yml" ||
    !/^github:\/\/keqi119\/subscription-Saas\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(
      input.workflowRunRef ?? ""
    )
  ) {
    throw preparationError("FINAL_PREPARATION_INPUT_INVALID");
  }
  if (input.chain === "snapshot") validateContract("snapshot-metadata.v1", input.snapshotMetadata);
  if (input.phase === "finalize") {
    if (
      input.planResult?.terminalStatus !== "PASSED" ||
      !digestPattern.test(input.planResult?.planDigest ?? "")
    ) {
      throw preparationError("FINAL_PREPARATION_PLAN_RESULT_INVALID");
    }
  } else if (input.planResult !== undefined) {
    throw preparationError("FINAL_PREPARATION_PLAN_RESULT_FORBIDDEN");
  }
}

function assertResult(result, input) {
  if (
    result?.finalComposeEvidence !== undefined ||
    result?.executionProof !== undefined ||
    result?.postStateObservation !== undefined
  ) {
    throw preparationError("FINAL_PREPARATION_RESULT_EVIDENCE_FORBIDDEN");
  }
  const expectedStatus = input.phase === "prepare" ? "PREPARED" : "FINALIZED";
  const expectedFileKeys =
    input.phase === "prepare"
      ? ["dryRunEnvelope", "runtime", "target"]
      : ["applyEnvelope", "databaseTestsEnvelope", "replayEnvelope", "verifyEnvelope"];
  if (
    result?.schemaVersion !== "final-compose-preparation.v1" ||
    result.phase !== input.phase ||
    result.chain !== input.chain ||
    result.terminalStatus !== expectedStatus ||
    result.launchRoot !== input.launchRoot ||
    result.composeProject !== `s1-final-${input.chain}` ||
    canonicalJson(Object.keys(result.files ?? {}).sort()) !== canonicalJson(expectedFileKeys) ||
    (input.phase === "finalize" && result.planDigest !== input.planResult.planDigest)
  ) {
    throw preparationError("FINAL_PREPARATION_RESULT_INVALID");
  }
}

export async function prepareFinalComposeLaunch(
  input,
  { adapter, inspectPreparation = inspectPreparationArtifacts } = {}
) {
  assertInput(input);
  if (
    adapter?.trustPolicy !== "protected-final-compose-preparation/v1" ||
    typeof adapter[input.phase === "prepare" ? "prepare" : "finalizePlan"] !== "function"
  ) {
    throw preparationError("FINAL_PREPARATION_TRUSTED_ADAPTER_REQUIRED");
  }
  const method = input.phase === "prepare" ? adapter.prepare : adapter.finalizePlan;
  const result = await method({ ...input });
  assertResult(result, input);
  await inspectPreparation(result, input);
  return Object.freeze(JSON.parse(canonicalJson(result)));
}

async function loadProductionAdapter(context) {
  let module;
  try {
    module = await import(trustedAdapterUrl);
  } catch (error) {
    throw preparationError("FINAL_PREPARATION_TRUSTED_ADAPTER_REQUIRED", {
      cause: error?.code
    });
  }
  if (typeof module.createProtectedFinalComposePreparation !== "function") {
    throw preparationError("FINAL_PREPARATION_TRUSTED_ADAPTER_REQUIRED");
  }
  return module.createProtectedFinalComposePreparation(context);
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runPreparationCli(argv) {
  const phase = argument(argv, "--phase");
  const chain = argument(argv, "--chain");
  const buildProofFile = argument(argv, "--build-proof-file");
  const sourceFile = argument(argv, "--source-gate-evidence-file");
  const snapshotFile = argument(argv, "--snapshot-metadata-file");
  const snapshotDirectory = argument(argv, "--snapshot-directory");
  const planResultFile = argument(argv, "--plan-result-file");
  const launchRoot = argument(argv, "--launch-root");
  const composeFile = argument(argv, "--compose-file");
  const outputFile = argument(argv, "--output-file");
  const workflowRunRef = argument(argv, "--workflow-run-ref");
  if (
    !phase ||
    !chain ||
    !buildProofFile ||
    !sourceFile ||
    !launchRoot ||
    !composeFile ||
    !outputFile ||
    !workflowRunRef ||
    (chain === "snapshot" && (!snapshotFile || !snapshotDirectory)) ||
    (phase === "finalize" && !planResultFile)
  ) {
    throw preparationError("FINAL_PREPARATION_ARGUMENT_REQUIRED");
  }
  const [buildProof, sourceGateEvidence, snapshotMetadata, planResult] = await Promise.all([
    readJson(path.resolve(buildProofFile)),
    readJson(path.resolve(sourceFile)),
    snapshotFile ? readJson(path.resolve(snapshotFile)) : undefined,
    planResultFile ? readJson(path.resolve(planResultFile)) : undefined
  ]);
  const input = {
    phase,
    chain,
    buildProof,
    sourceGateEvidence,
    ...(snapshotMetadata ? { snapshotMetadata, snapshotDirectory } : {}),
    ...(planResult ? { planResult } : {}),
    launchRoot,
    composeFile,
    workflowRunRef
  };
  const adapter = await loadProductionAdapter({
    repositoryRoot: process.cwd(),
    launchRoot: path.resolve(launchRoot),
    composeFile: path.resolve(composeFile),
    snapshotDirectory: snapshotDirectory ? path.resolve(snapshotDirectory) : undefined
  });
  const result = await prepareFinalComposeLaunch(input, { adapter });
  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await writeFile(path.resolve(outputFile), canonicalJson(result), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ terminalStatus: result.terminalStatus })}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPreparationCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "FINAL_PREPARATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
