#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { publishRevocationArtifact } from "../../packages/release-foundation/src/index.mjs";

function commandError(code) {
  return Object.assign(new Error(code), { code });
}

export async function publishApprovalRevocations(input) {
  return publishRevocationArtifact(input);
}

async function main() {
  throw commandError("APPROVAL_REVOCATIONS_TRUSTED_PUBLISHER_REQUIRED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "APPROVAL_REVOCATIONS_PUBLICATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
