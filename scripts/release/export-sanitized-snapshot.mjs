#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  exportSanitizedSnapshot,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

const requestPath = ".release-inputs/snapshot-export-request.v1.json";
const publicationDirectory = ".release-output/sanitized-snapshot";
const trustedAdapterUrl = pathToFileURL(
  "/opt/subscription-saas/snapshot-adapter/v1/index.mjs"
).href;
const requestKeys = Object.freeze([
  "environmentClass",
  "sourceSecretReference",
  "tokenizationSecretReference",
  "workflowRunRef"
]);
const publishedFiles = Object.freeze([
  "custody-receipt.v1.json",
  "sanitization-scan.v1.json",
  "sanitized-snapshot.dump",
  "snapshot-metadata.v1.json",
  "source-fingerprint.v1.json",
  "source-privilege-observation.v1.json"
]);

function commandError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function assertRequest(request) {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(requestKeys) ||
    request.environmentClass !== "staging" ||
    request.sourceSecretReference !== "secret://stage1-snapshot-export/source" ||
    request.tokenizationSecretReference !== "secret://stage1-snapshot-export/tokenization-key" ||
    !/^github:\/\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*$/.test(request.workflowRunRef ?? "")
  ) {
    throw commandError("SNAPSHOT_EXPORT_REQUEST_INVALID");
  }
  return Object.freeze({ ...request });
}

function assertAdapters(adapters) {
  if (
    adapters?.trustPolicy !== "protected-snapshot-adapters/v1" ||
    adapters.source?.trustPolicy !== "protected-snapshot-source/v1" ||
    adapters.workspace?.trustPolicy !== "isolated-sanitization-workspace/v1" ||
    adapters.publisher?.trustPolicy !== "snapshot-final-bundle/v1" ||
    typeof adapters.assertFinalPublication !== "function"
  ) {
    throw commandError("SNAPSHOT_TRUSTED_ADAPTERS_REQUIRED");
  }
}

export async function runProtectedSnapshotExport({ request, contract, adapters, now }) {
  const acceptedRequest = assertRequest(request);
  validateContract("sanitization-contract.v1", contract);
  assertAdapters(adapters);
  const metadata = await exportSanitizedSnapshot({
    contract,
    source: adapters.source,
    workspace: adapters.workspace,
    publisher: adapters.publisher,
    secretReference: acceptedRequest.sourceSecretReference,
    tokenizationSecretReference: acceptedRequest.tokenizationSecretReference,
    workflowRunRef: acceptedRequest.workflowRunRef,
    now
  });
  const publication = await adapters.assertFinalPublication({
    directory: publicationDirectory,
    allowedFileNames: publishedFiles,
    metadata
  });
  if (
    publication?.complete !== true ||
    JSON.stringify([...(publication.fileNames ?? [])].sort()) !== JSON.stringify(publishedFiles)
  ) {
    throw commandError("SNAPSHOT_PUBLICATION_INCOMPLETE_FORBIDDEN");
  }
  return metadata;
}

function assertedDescendant(root, child) {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(root, child);
  if (
    path.isAbsolute(child) ||
    resolvedChild === resolvedRoot ||
    !resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw commandError("SNAPSHOT_CLEANUP_TARGET_INVALID");
  }
  return resolvedChild;
}

export async function cleanupProtectedSnapshotWorkspace({ repoRoot, runnerTemp }) {
  const inputFile = assertedDescendant(repoRoot, requestPath);
  const outputDirectory = assertedDescendant(repoRoot, publicationDirectory);
  const rawWorkspace = assertedDescendant(runnerTemp, "stage1-snapshot-export");
  await Promise.all(
    [inputFile, outputDirectory, rawWorkspace].map((target) =>
      rm(target, { recursive: true, force: true })
    )
  );
}

async function loadTrustedAdapters(context) {
  let adapterModule;
  try {
    adapterModule = await import(trustedAdapterUrl);
  } catch (error) {
    throw commandError("SNAPSHOT_TRUSTED_ADAPTERS_REQUIRED", { cause: error?.code });
  }
  if (typeof adapterModule.createProtectedSnapshotAdapters !== "function") {
    throw commandError("SNAPSHOT_TRUSTED_ADAPTERS_REQUIRED");
  }
  return adapterModule.createProtectedSnapshotAdapters(context);
}

async function main() {
  const [mode] = process.argv.slice(2);
  if (mode === "--cleanup") {
    if (!process.env.RUNNER_TEMP) throw commandError("SNAPSHOT_RUNNER_TEMP_REQUIRED");
    await cleanupProtectedSnapshotWorkspace({
      repoRoot: process.cwd(),
      runnerTemp: process.env.RUNNER_TEMP
    });
    return;
  }
  if (mode !== "--export" || process.argv.length !== 3) {
    throw commandError("SNAPSHOT_EXPORT_USAGE_INVALID");
  }
  if (!process.env.RUNNER_TEMP) throw commandError("SNAPSHOT_RUNNER_TEMP_REQUIRED");
  const [request, contract] = await Promise.all([
    readFile(path.join(process.cwd(), requestPath), "utf8").then(JSON.parse),
    readFile(
      path.join(process.cwd(), "release/contracts/sanitization-contract.v1.json"),
      "utf8"
    ).then(JSON.parse)
  ]);
  const adapters = await loadTrustedAdapters({
    publicationDirectory: path.resolve(process.cwd(), publicationDirectory),
    workspaceDirectory: path.resolve(process.env.RUNNER_TEMP, "stage1-snapshot-export")
  });
  await runProtectedSnapshotExport({ request, contract, adapters });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "SNAPSHOT_EXPORT_FAILED"}\n`);
    process.exitCode = 1;
  });
}
