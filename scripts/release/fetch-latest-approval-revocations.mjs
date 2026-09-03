#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { fetchLatestTrustedRevocations } from "../../packages/release-foundation/src/index.mjs";

function commandError(code) {
  return Object.assign(new Error(code), { code });
}

export async function fetchLatestApprovalRevocations(input) {
  return fetchLatestTrustedRevocations(input);
}

async function main() {
  throw commandError("APPROVAL_REVOCATIONS_TRUSTED_GITHUB_CLIENT_REQUIRED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "APPROVAL_REVOCATIONS_FETCH_FAILED"}\n`);
    process.exitCode = 1;
  });
}
