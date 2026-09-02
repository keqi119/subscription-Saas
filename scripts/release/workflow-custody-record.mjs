#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertCustodyComplete,
  canonicalJson,
  sha256Bytes,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

function custodyError(code) {
  return Object.assign(new Error(code), { code });
}

function addDays(value, days) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export async function createWorkflowCustodyRecord({
  originalFile,
  readbackFile,
  workflowRunRef,
  storeRef,
  attestationRef,
  now = () => new Date(),
  createId = randomUUID
}) {
  if (
    !/^github:\/\/keqi119\/subscription-Saas\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(
      workflowRunRef ?? ""
    ) ||
    typeof storeRef !== "string" ||
    storeRef.length === 0 ||
    typeof attestationRef !== "string" ||
    attestationRef.length === 0
  ) {
    throw custodyError("WORKFLOW_CUSTODY_INPUT_INVALID");
  }
  const [original, readback] = await Promise.all([
    readFile(path.resolve(originalFile)),
    readFile(path.resolve(readbackFile))
  ]);
  if (sha256Bytes(original) !== sha256Bytes(readback)) {
    throw custodyError("WORKFLOW_CUSTODY_READBACK_MISMATCH");
  }
  let content;
  try {
    content = JSON.parse(original.toString("utf8"));
  } catch {
    throw custodyError("WORKFLOW_CUSTODY_CONTENT_INVALID");
  }
  const canonicalBytes = Buffer.from(canonicalJson(content), "utf8");
  if (sha256Bytes(canonicalBytes) !== sha256Bytes(original)) {
    throw custodyError("WORKFLOW_CUSTODY_CONTENT_NOT_CANONICAL");
  }
  const uploadedAt = now();
  if (!(uploadedAt instanceof Date) || Number.isNaN(uploadedAt.getTime())) {
    throw custodyError("WORKFLOW_CUSTODY_CLOCK_INVALID");
  }
  const contentDigest = sha256Bytes(canonicalBytes);
  const receipt = {
    schemaVersion: "custody-receipt.v1",
    receiptId: createId(),
    contentDigest,
    contentSizeBytes: canonicalBytes.byteLength,
    storeRef,
    uploadedAt: uploadedAt.toISOString(),
    readbackAt: uploadedAt.toISOString(),
    readbackDigest: contentDigest,
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    retainUntil: addDays(uploadedAt, 180).toISOString(),
    expiryDisposition: "review",
    attestationRef
  };
  validateContract("custody-receipt.v1", receipt);
  assertCustodyComplete(receipt, contentDigest);
  return Object.freeze({ workflowRunRef, content, receipt: Object.freeze(receipt) });
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runWorkflowCustodyCli(argv) {
  const expected = [
    "--original-file",
    "--readback-file",
    "--workflow-run-ref",
    "--store-ref",
    "--attestation-ref",
    "--output-file"
  ];
  if (
    argv.length !== expected.length * 2 ||
    expected.some((flag, index) => argv[index * 2] !== flag)
  ) {
    throw custodyError("WORKFLOW_CUSTODY_ARGUMENT_INVALID");
  }
  const record = await createWorkflowCustodyRecord({
    originalFile: argument(argv, "--original-file"),
    readbackFile: argument(argv, "--readback-file"),
    workflowRunRef: argument(argv, "--workflow-run-ref"),
    storeRef: argument(argv, "--store-ref"),
    attestationRef: argument(argv, "--attestation-ref")
  });
  const outputFile = path.resolve(argument(argv, "--output-file"));
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, canonicalJson(record), { flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ receiptDigest: sha256Bytes(Buffer.from(canonicalJson(record.receipt))) })}\n`
  );
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runWorkflowCustodyCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "WORKFLOW_CUSTODY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
