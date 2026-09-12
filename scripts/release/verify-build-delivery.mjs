#!/usr/bin/env node

import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import {
  canonicalJson,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { assertBuildIdentity } from "./verify-build-proof.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const RETENTION_MILLISECONDS = 90 * 86400000;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sourceShaPattern = /^[0-9a-f]{40}$/u;
const decimalIdPattern = /^[1-9][0-9]*$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const utcTimestampPattern =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z$/u;
const inputKeys = Object.freeze(["expected", "entries", "observedAt"]);
const expectedKeys = Object.freeze([
  "repository",
  "workflowRunId",
  "runAttempt",
  "sourceSha",
  "buildProofDigest"
]);
const entryKeys = Object.freeze([
  "kind",
  "artifactId",
  "name",
  "metadataBytes",
  "originalFiles",
  "readbackFiles"
]);
const fileKeys = Object.freeze(["path", "bytes"]);
const expectedFiles = Object.freeze({
  proof: Object.freeze(["build-proof.v1.json"]),
  "supporting-evidence": Object.freeze([
    "build-material-observation.v1.json",
    "build-proof-attestation-verification.json"
  ])
});
const utf8 = new TextDecoder("utf-8", { fatal: true });

function deliveryError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function hasExactDataProperties(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

function positiveDecimalId(value, code = "BUILD_DELIVERY_EXPECTED_INVALID") {
  if (typeof value !== "string" || !decimalIdPattern.test(value)) throw deliveryError(code);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw deliveryError(code);
  return numeric;
}

function parseJsonBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) throw deliveryError("BUILD_DELIVERY_INPUT_INVALID");
  if (bytes.length > MAX_FILE_BYTES) throw deliveryError("BUILD_DELIVERY_FILE_TOO_LARGE");
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    throw deliveryError("BUILD_DELIVERY_JSON_INVALID");
  }
}

function parseUtcTimestamp(value, code) {
  if (typeof value !== "string") throw deliveryError(code);
  const match = utcTimestampPattern.exec(value);
  if (!match) throw deliveryError(code);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw deliveryError(code);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw deliveryError(code);
  return milliseconds;
}

function assertExpected(expected) {
  if (!hasExactDataProperties(expected, expectedKeys)) {
    throw deliveryError("BUILD_DELIVERY_INPUT_INVALID");
  }
  const repositoryParts =
    typeof expected.repository === "string" ? expected.repository.split("/") : [];
  if (
    typeof expected.repository !== "string" ||
    !repositoryPattern.test(expected.repository) ||
    repositoryParts.some((part) => part === "." || part === "..") ||
    expected.runAttempt !== 1 ||
    typeof expected.sourceSha !== "string" ||
    !sourceShaPattern.test(expected.sourceSha) ||
    typeof expected.buildProofDigest !== "string" ||
    !digestPattern.test(expected.buildProofDigest)
  ) {
    throw deliveryError("BUILD_DELIVERY_EXPECTED_INVALID");
  }
  positiveDecimalId(expected.workflowRunId);
}

function assertFileArray(files, wantedPaths) {
  if (!Array.isArray(files) || files.length !== wantedPaths.length) {
    throw deliveryError("BUILD_DELIVERY_FILE_SET_INVALID");
  }
  const observedPaths = [];
  for (const candidate of files) {
    if (
      !hasExactDataProperties(candidate, fileKeys) ||
      typeof candidate.path !== "string" ||
      !Buffer.isBuffer(candidate.bytes)
    ) {
      throw deliveryError("BUILD_DELIVERY_INPUT_INVALID");
    }
    observedPaths.push(candidate.path);
  }
  observedPaths.sort();
  if (
    new Set(observedPaths).size !== wantedPaths.length ||
    observedPaths.some((pathname, index) => pathname !== [...wantedPaths].sort()[index])
  ) {
    throw deliveryError("BUILD_DELIVERY_FILE_SET_INVALID");
  }
}

function filesByPath(files) {
  return new Map(files.map((candidate) => [candidate.path, candidate.bytes]));
}

function assertReadback(candidate, wantedPaths) {
  assertFileArray(candidate.originalFiles, wantedPaths);
  assertFileArray(candidate.readbackFiles, wantedPaths);
  const original = filesByPath(candidate.originalFiles);
  const readback = filesByPath(candidate.readbackFiles);
  for (const pathname of wantedPaths) {
    const originalBytes = original.get(pathname);
    const readbackBytes = readback.get(pathname);
    if (originalBytes.length > MAX_FILE_BYTES || readbackBytes.length > MAX_FILE_BYTES) {
      throw deliveryError("BUILD_DELIVERY_FILE_TOO_LARGE");
    }
    if (!originalBytes.equals(readbackBytes)) {
      throw deliveryError("BUILD_DELIVERY_READBACK_MISMATCH", { path: pathname });
    }
  }
  return original;
}

function assertMetadata(candidate, expected, observedAt, expectedName) {
  const artifactId = positiveDecimalId(candidate.artifactId, "BUILD_DELIVERY_ARTIFACT_ID_INVALID");
  const metadata = parseJsonBytes(candidate.metadataBytes);
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw deliveryError("BUILD_DELIVERY_JSON_INVALID");
  }
  if (!Number.isSafeInteger(metadata.id) || metadata.id <= 0) {
    throw deliveryError("BUILD_DELIVERY_ARTIFACT_ID_INVALID");
  }
  if (metadata.id !== artifactId) {
    throw deliveryError("BUILD_DELIVERY_ARTIFACT_ID_MISMATCH");
  }
  if (candidate.name !== expectedName || metadata.name !== expectedName) {
    throw deliveryError("BUILD_DELIVERY_ARTIFACT_NAME_MISMATCH");
  }
  const apiUrl = `https://api.github.com/repos/${expected.repository}/actions/artifacts/${artifactId}`;
  if (metadata.url !== apiUrl || metadata.archive_download_url !== `${apiUrl}/zip`) {
    throw deliveryError("BUILD_DELIVERY_REPOSITORY_MISMATCH");
  }
  const metadataRunId = metadata.workflow_run?.id;
  if (
    !Number.isSafeInteger(metadataRunId) ||
    metadataRunId <= 0 ||
    metadataRunId !== positiveDecimalId(expected.workflowRunId)
  ) {
    throw deliveryError("BUILD_DELIVERY_RUN_MISMATCH");
  }
  if (metadata.workflow_run?.head_sha !== expected.sourceSha) {
    throw deliveryError("BUILD_DELIVERY_SOURCE_MISMATCH");
  }
  if (metadata.expired !== false) throw deliveryError("BUILD_DELIVERY_EXPIRED");
  const created = parseUtcTimestamp(metadata.created_at, "BUILD_DELIVERY_RETENTION_INVALID");
  const expires = parseUtcTimestamp(metadata.expires_at, "BUILD_DELIVERY_RETENTION_INVALID");
  const minimumExpires = created + RETENTION_MILLISECONDS;
  if (!Number.isFinite(minimumExpires) || expires < minimumExpires) {
    throw deliveryError("BUILD_DELIVERY_RETENTION_INVALID");
  }
  if (observedAt < created || observedAt >= expires) {
    throw deliveryError("BUILD_DELIVERY_OBSERVED_AT_INVALID");
  }
  return {
    artifactId,
    metadata,
    metadataDigest: sha256Bytes(candidate.metadataBytes)
  };
}

export function verifyBuildDelivery(input) {
  if (!hasExactDataProperties(input, inputKeys)) {
    throw deliveryError("BUILD_DELIVERY_INPUT_INVALID");
  }
  assertExpected(input.expected);
  const observedAt = parseUtcTimestamp(input.observedAt, "BUILD_DELIVERY_OBSERVED_AT_INVALID");
  if (!Array.isArray(input.entries) || input.entries.length !== 2) {
    throw deliveryError("BUILD_DELIVERY_ARTIFACT_SET_INVALID");
  }
  for (const candidate of input.entries) {
    if (!hasExactDataProperties(candidate, entryKeys)) {
      throw deliveryError("BUILD_DELIVERY_INPUT_INVALID");
    }
  }
  const kinds = input.entries.map(({ kind }) => kind);
  if (
    new Set(kinds).size !== 2 ||
    !kinds.includes("proof") ||
    !kinds.includes("supporting-evidence")
  ) {
    throw deliveryError("BUILD_DELIVERY_ARTIFACT_SET_INVALID");
  }
  for (const candidate of input.entries) {
    positiveDecimalId(candidate.artifactId, "BUILD_DELIVERY_ARTIFACT_ID_INVALID");
  }
  if (new Set(input.entries.map(({ artifactId }) => artifactId)).size !== 2) {
    throw deliveryError("BUILD_DELIVERY_ARTIFACT_SET_INVALID");
  }

  const byKind = new Map(input.entries.map((candidate) => [candidate.kind, candidate]));
  const proofEntry = byKind.get("proof");
  const supportingEntry = byKind.get("supporting-evidence");
  const proofFiles = assertReadback(proofEntry, expectedFiles.proof);
  const supportingFiles = assertReadback(supportingEntry, expectedFiles["supporting-evidence"]);
  const proofBytes = proofFiles.get("build-proof.v1.json");
  const materialBytes = supportingFiles.get("build-material-observation.v1.json");
  const attestationBytes = supportingFiles.get("build-proof-attestation-verification.json");
  const proof = parseJsonBytes(proofBytes);
  const buildMaterialObservation = parseJsonBytes(materialBytes);
  assertBuildIdentity({ proof, buildMaterialObservation });
  const attestationEvidence = parseJsonBytes(attestationBytes);
  if (!Array.isArray(attestationEvidence) || attestationEvidence.length === 0) {
    throw deliveryError("BUILD_DELIVERY_JSON_INVALID");
  }
  if (!proofBytes.equals(Buffer.from(canonicalJson(proof)))) {
    throw deliveryError("BUILD_DELIVERY_PROOF_BYTES_INVALID");
  }
  if (!materialBytes.equals(Buffer.from(`${canonicalJson(buildMaterialObservation)}\n`))) {
    throw deliveryError("BUILD_DELIVERY_MATERIAL_BYTES_INVALID");
  }
  const proofDigest = sha256Canonical(proof);
  if (proofDigest !== input.expected.buildProofDigest) {
    throw deliveryError("BUILD_DELIVERY_PROOF_DIGEST_MISMATCH");
  }
  const expectedRunRef = `github://${input.expected.repository}/actions/runs/${input.expected.workflowRunId}`;
  if (
    proof.provenance.ciRunRef !== expectedRunRef ||
    buildMaterialObservation.ciRunRef !== expectedRunRef
  ) {
    throw deliveryError("BUILD_DELIVERY_RUN_MISMATCH");
  }
  if (
    proof.identity.sourceSha !== input.expected.sourceSha ||
    proof.provenance.checkoutRef !== input.expected.sourceSha ||
    buildMaterialObservation.sourceSha !== input.expected.sourceSha ||
    buildMaterialObservation.checkoutRef !== input.expected.sourceSha
  ) {
    throw deliveryError("BUILD_DELIVERY_SOURCE_MISMATCH");
  }

  const digestHex = proofDigest.slice("sha256:".length);
  const artifactResults = [];
  for (const [kind, candidate] of [
    ["proof", proofEntry],
    ["supporting-evidence", supportingEntry]
  ]) {
    const expectedName =
      kind === "proof" ? `build-proof-${digestHex}` : `build-proof-evidence-${digestHex}`;
    const metadataResult = assertMetadata(candidate, input.expected, observedAt, expectedName);
    const originals = filesByPath(candidate.originalFiles);
    artifactResults.push({
      artifactId: metadataResult.artifactId,
      name: expectedName,
      createdAt: metadataResult.metadata.created_at,
      expiresAt: metadataResult.metadata.expires_at,
      metadataDigest: metadataResult.metadataDigest,
      files: expectedFiles[kind].map((pathname) => ({
        path: pathname,
        rawDigest: sha256Bytes(originals.get(pathname)),
        sizeBytes: originals.get(pathname).length
      }))
    });
  }

  return deepFreeze({
    status: "delivery-verified",
    buildProofDigest: proofDigest,
    sourceSha: input.expected.sourceSha,
    workflowRunId: input.expected.workflowRunId,
    runAttempt: input.expected.runAttempt,
    promotionEligible: false,
    authorityCustody: "INPUT_REQUIRED",
    artifacts: artifactResults
  });
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function assertRegularPath(root, ...segments) {
  await assertUnaliased(root, "directory");
  let current = root;
  let info;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    info = await assertUnaliased(current, index === segments.length - 1 ? "file" : "directory");
  }
  if (!Number.isSafeInteger(info.size) || info.size > MAX_FILE_BYTES) {
    throw deliveryError("BUILD_DELIVERY_FILE_TOO_LARGE");
  }
  let handle;
  try {
    handle = await open(current, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || !Number.isSafeInteger(opened.size) || opened.size > MAX_FILE_BYTES) {
      throw deliveryError("BUILD_DELIVERY_FILE_TOO_LARGE");
    }
    const bounded = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < bounded.length) {
      const { bytesRead } = await handle.read(bounded, total, bounded.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) throw deliveryError("BUILD_DELIVERY_FILE_TOO_LARGE");
    return Buffer.from(bounded.subarray(0, total));
  } catch (error) {
    if (error?.code?.startsWith("BUILD_DELIVERY_")) throw error;
    throw deliveryError("BUILD_DELIVERY_FILE_INVALID");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function assertUnaliased(candidate, kind) {
  let info;
  let resolved;
  try {
    info = await lstat(candidate);
    resolved = await realpath(candidate);
  } catch {
    throw deliveryError("BUILD_DELIVERY_FILE_INVALID");
  }
  if (info.isSymbolicLink() || !samePath(resolved, path.resolve(candidate))) {
    throw deliveryError("BUILD_DELIVERY_PATH_INVALID");
  }
  if ((kind === "directory" && !info.isDirectory()) || (kind === "file" && !info.isFile())) {
    throw deliveryError("BUILD_DELIVERY_FILE_INVALID");
  }
  return info;
}

async function assertExactDirectory(directory, expectedNames) {
  await assertUnaliased(directory, "directory");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw deliveryError("BUILD_DELIVERY_FILE_INVALID");
  }
  const names = entries.map(({ name }) => name).sort();
  const expected = [...expectedNames].sort();
  if (entries.some((candidate) => candidate.isSymbolicLink())) {
    throw deliveryError("BUILD_DELIVERY_PATH_INVALID");
  }
  if (expected.some((name) => !names.includes(name))) {
    throw deliveryError("BUILD_DELIVERY_FILE_INVALID");
  }
  if (entries.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw deliveryError("BUILD_DELIVERY_FILE_SET_INVALID");
  }
}

async function main() {
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--directory" ||
    typeof process.argv[3] !== "string" ||
    process.argv[3].length === 0
  ) {
    throw deliveryError("BUILD_DELIVERY_ARGUMENT_INVALID");
  }
  const workspace = process.cwd();
  const outputRoot = path.resolve(workspace, process.argv[3]);
  const fixedOutputRoot = path.join(workspace, ".release-output");
  if (!samePath(outputRoot, fixedOutputRoot)) {
    throw deliveryError("BUILD_DELIVERY_ARGUMENT_INVALID");
  }
  const readbackRoot = path.join(workspace, ".release-readback");
  await assertExactDirectory(readbackRoot, ["proof", "evidence"]);
  await assertExactDirectory(path.join(readbackRoot, "proof"), expectedFiles.proof);
  await assertExactDirectory(
    path.join(readbackRoot, "evidence"),
    expectedFiles["supporting-evidence"]
  );
  const [
    proofBytes,
    materialBytes,
    attestationBytes,
    proofMetadataBytes,
    evidenceMetadataBytes,
    proofReadbackBytes,
    materialReadbackBytes,
    attestationReadbackBytes
  ] = await Promise.all([
    assertRegularPath(outputRoot, "build-proof.v1.json"),
    assertRegularPath(outputRoot, "build-material-observation.v1.json"),
    assertRegularPath(outputRoot, "build-proof-attestation-verification.json"),
    assertRegularPath(outputRoot, "build-proof-artifact-metadata.json"),
    assertRegularPath(outputRoot, "build-evidence-artifact-metadata.json"),
    assertRegularPath(readbackRoot, "proof", "build-proof.v1.json"),
    assertRegularPath(readbackRoot, "evidence", "build-material-observation.v1.json"),
    assertRegularPath(readbackRoot, "evidence", "build-proof-attestation-verification.json")
  ]);
  const result = verifyBuildDelivery({
    expected: {
      repository: process.env.GITHUB_REPOSITORY,
      workflowRunId: process.env.GITHUB_RUN_ID,
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      sourceSha: process.env.SOURCE_SHA,
      buildProofDigest: process.env.PROOF_DIGEST
    },
    entries: [
      {
        kind: "proof",
        artifactId: process.env.PROOF_ARTIFACT_ID,
        name: `build-proof-${String(process.env.PROOF_DIGEST ?? "").slice(7)}`,
        metadataBytes: proofMetadataBytes,
        originalFiles: [{ path: "build-proof.v1.json", bytes: proofBytes }],
        readbackFiles: [{ path: "build-proof.v1.json", bytes: proofReadbackBytes }]
      },
      {
        kind: "supporting-evidence",
        artifactId: process.env.EVIDENCE_ARTIFACT_ID,
        name: `build-proof-evidence-${String(process.env.PROOF_DIGEST ?? "").slice(7)}`,
        metadataBytes: evidenceMetadataBytes,
        originalFiles: [
          { path: "build-material-observation.v1.json", bytes: materialBytes },
          { path: "build-proof-attestation-verification.json", bytes: attestationBytes }
        ],
        readbackFiles: [
          { path: "build-material-observation.v1.json", bytes: materialReadbackBytes },
          { path: "build-proof-attestation-verification.json", bytes: attestationReadbackBytes }
        ]
      }
    ],
    observedAt: new Date().toISOString()
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "BUILD_DELIVERY_VERIFY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
