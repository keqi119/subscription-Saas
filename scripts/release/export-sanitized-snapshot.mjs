#!/usr/bin/env node

import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { encryptSnapshotStream } from "../../packages/release-foundation/src/snapshot/envelope-crypto.mjs";
import {
  exportSanitizedSnapshot,
  prepareSanitizedSnapshotBundle
} from "../../packages/release-foundation/src/snapshot/export-sanitized.mjs";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateProducerCryptoAuthorization } from "../../packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs";

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

export async function runProtectedSnapshotExport({
  request,
  contract,
  ownershipMap,
  adapters,
  now
}) {
  const acceptedRequest = assertRequest(request);
  validateContract("sanitization-contract.v1", contract);
  validateContract("ownership-map.v1", ownershipMap);
  assertAdapters(adapters);
  const metadata = await exportSanitizedSnapshot({
    contract,
    ownershipMap,
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

// Internal v2 producer seam. Host, source, key-readback and authorization authority
// remain with the caller; this only binds an already admitted private bundle to encryption.
export async function runProtectedSnapshotEncryption({
  request,
  contract,
  ownershipMap,
  adapters,
  authorization,
  publicKey,
  workspaceDirectory
}) {
  const acceptedRequest = assertRequest(request);
  let acceptedAuthorization;
  let acceptedContract;
  let acceptedOwnershipMap;
  try {
    // Own these JSON facts before the first await; caller mutation cannot retarget a run.
    acceptedAuthorization = JSON.parse(JSON.stringify(authorization));
    acceptedContract = JSON.parse(JSON.stringify(contract));
    acceptedOwnershipMap = JSON.parse(JSON.stringify(ownershipMap));
    if (acceptedAuthorization?.schemaVersion !== "producer-crypto-run-authorization.v2") {
      throw new Error();
    }
    validateProducerCryptoAuthorization(acceptedAuthorization);
    validateContract("sanitization-contract.v1", acceptedContract);
    validateContract("ownership-map.v1", acceptedOwnershipMap);
  } catch {
    throw commandError("SNAPSHOT_ENCRYPTION_ADMISSION_INVALID");
  }
  const contractDigest = sha256Canonical(acceptedContract);
  const allocatedAt = Date.parse(acceptedAuthorization.snapshotAllocatedAt);
  const expiresAt = acceptedAuthorization.localKey.context.expiresAt;
  const now = Date.now();
  if (
    adapters?.trustPolicy !== "protected-snapshot-adapters/v1" ||
    adapters.source?.trustPolicy !== "protected-snapshot-source/v1" ||
    adapters.workspace?.trustPolicy !== "isolated-sanitization-workspace/v1" ||
    acceptedRequest.workflowRunRef !==
      `github://${acceptedAuthorization.repository.name}/actions/runs/${acceptedAuthorization.snapshotRunId}` ||
    acceptedAuthorization.localKey.context.sanitizationContractDigest !== contractDigest ||
    now < allocatedAt ||
    now >= Date.parse(expiresAt) ||
    now < Date.parse(acceptedAuthorization.notBefore) ||
    now >= Date.parse(acceptedAuthorization.notAfter)
  )
    throw commandError("SNAPSHOT_ENCRYPTION_ADMISSION_INVALID");
  if (
    process.platform !== "linux" ||
    typeof workspaceDirectory !== "string" ||
    !path.isAbsolute(workspaceDirectory) ||
    path.resolve(workspaceDirectory) !== workspaceDirectory
  )
    throw commandError("SNAPSHOT_ENCRYPTION_WORKSPACE_INVALID");
  try {
    const stat = await lstat(workspaceDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o700 ||
      (await realpath(workspaceDirectory)) !== workspaceDirectory
    )
      throw new Error();
  } catch {
    throw commandError("SNAPSHOT_ENCRYPTION_WORKSPACE_INVALID");
  }
  const ciphertextPath = path.join(workspaceDirectory, "snapshot.enc");
  let bundle;
  try {
    bundle = await prepareSanitizedSnapshotBundle({
      contract: acceptedContract,
      ownershipMap: acceptedOwnershipMap,
      source: adapters.source,
      workspace: adapters.workspace,
      secretReference: acceptedRequest.sourceSecretReference,
      tokenizationSecretReference: acceptedRequest.tokenizationSecretReference,
      workflowRunRef: acceptedRequest.workflowRunRef,
      // V2 allocatedAt fixes only this snapshot's lifecycle. Source/scan observations
      // in the shared preparation retain their actual operation clock.
      snapshotAllocatedAt: acceptedAuthorization.snapshotAllocatedAt
    });
    if (
      bundle.metadata.sanitizationContractDigest !== contractDigest ||
      bundle.metadata.workflowRunRef !== acceptedRequest.workflowRunRef ||
      bundle.metadata.expiresAt !== expiresAt
    )
      throw commandError("SNAPSHOT_ENCRYPTION_ADMISSION_INVALID");
    const aad = {
      repositoryId: acceptedAuthorization.repository.id,
      sourceSha: acceptedAuthorization.sourceSha,
      releaseAttemptId: acceptedAuthorization.releaseAttemptId,
      snapshotRunId: acceptedAuthorization.snapshotRunId,
      snapshotAllocatedAt: acceptedAuthorization.snapshotAllocatedAt,
      expiresAt,
      sanitizationContractDigest: contractDigest,
      snapshotDigest: bundle.metadata.dumpDigest
    };
    const operation = { requestId: randomUUID(), startedAt: new Date().toISOString() };
    const envelope = await encryptSnapshotStream({
      source: { open: () => Readable.from([bundle.dump]) },
      destination: ciphertextPath,
      aad,
      authorization: acceptedAuthorization,
      publicKey
    });
    if (
      envelope.expiresAt !== bundle.metadata.expiresAt ||
      envelope.snapshotDigest !== bundle.metadata.dumpDigest
    )
      throw commandError("SNAPSHOT_ENCRYPTION_ADMISSION_INVALID");
    return Object.freeze({
      metadata: bundle.metadata,
      privilegeObservation: bundle.privilegeObservation,
      fingerprintObservation: bundle.fingerprintObservation,
      scan: bundle.scan,
      envelope,
      // The one fixed encryption call returned after its key-clearing finally
      // block. This records best-effort mutable-buffer clearing, not erasure of
      // runtime copies or an independently observed process exit.
      cryptoOperation: Object.freeze({
        ...operation,
        action: "local:GenerateAndWrapDataKey",
        callCount: 1,
        outcome: "SUCCESS",
        finishedAt: new Date().toISOString(),
        envelopeDigest: sha256Canonical(envelope),
        keyBufferClear: "BEST_EFFORT_COMPLETED"
      }),
      ciphertextPath
    });
  } finally {
    // Best effort for the Buffer owned by this function; JS/runtime copies are not claimed erased.
    bundle?.dump?.fill(0);
  }
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
  const [request, contract, ownershipMap] = await Promise.all([
    readFile(path.join(process.cwd(), requestPath), "utf8").then(JSON.parse),
    readFile(
      path.join(process.cwd(), "release/contracts/sanitization-contract.v1.json"),
      "utf8"
    ).then(JSON.parse),
    readFile(
      path.join(process.cwd(), "release/contracts/snapshot-ownership-map.v1.json"),
      "utf8"
    ).then(JSON.parse)
  ]);
  const adapters = await loadTrustedAdapters({
    publicationDirectory: path.resolve(process.cwd(), publicationDirectory),
    workspaceDirectory: path.resolve(process.env.RUNNER_TEMP, "stage1-snapshot-export")
  });
  await runProtectedSnapshotExport({ request, contract, ownershipMap, adapters });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "SNAPSHOT_EXPORT_FAILED"}\n`);
    process.exitCode = 1;
  });
}
