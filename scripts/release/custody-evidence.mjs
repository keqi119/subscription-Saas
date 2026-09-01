#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { custodyEvidence } from "../../packages/release-foundation/src/index.mjs";

function commandError(code) {
  return Object.assign(new Error(code), { code });
}

export function parseCustodyRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["evidence", "policy", "attestationRef"].includes(key)) ||
    !("evidence" in value) ||
    typeof value.attestationRef !== "string"
  ) {
    throw commandError("CUSTODY_REQUEST_INVALID");
  }
  return value;
}

export async function runCustodyEvidence({
  request,
  storage,
  now = () => new Date(),
  createReceiptId = randomUUID
}) {
  const parsed = parseCustodyRequest(request);
  return custodyEvidence({
    value: parsed.evidence,
    policy: parsed.policy,
    attestationRef: parsed.attestationRef,
    storage,
    now,
    createReceiptId
  });
}

async function main() {
  throw commandError("CUSTODY_TRUSTED_STORAGE_ADAPTER_REQUIRED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "CUSTODY_COMMAND_FAILED"}\n`);
    process.exitCode = 1;
  });
}
