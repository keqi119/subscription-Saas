#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { restoreSanitizedSnapshot } from "../../packages/release-foundation/src/index.mjs";

function commandError(code) {
  return Object.assign(new Error(code), { code });
}

export async function runTrustedSnapshotRestore(input) {
  if (
    input?.launcherTrustPolicy !== "trusted-snapshot-restore-launcher/v1" ||
    input.adapters?.trustPolicy !== "snapshot-restore-adapters/v1"
  ) {
    throw commandError("SNAPSHOT_RESTORE_TRUSTED_LAUNCH_REQUIRED");
  }
  return restoreSanitizedSnapshot({
    artifact: input.artifact,
    contract: input.contract,
    ownershipMap: input.ownershipMap,
    target: input.target,
    restoreIdentity: input.restoreIdentity,
    adapters: input.adapters,
    now: input.now
  });
}

async function main() {
  throw commandError("SNAPSHOT_RESTORE_TRUSTED_LAUNCH_ADAPTERS_REQUIRED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "SNAPSHOT_RESTORE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
