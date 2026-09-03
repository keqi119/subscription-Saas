#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateContract } from "../../packages/release-foundation/src/index.mjs";
import {
  discoverApiGovernanceSurface,
  verifyApiGovernanceInventory
} from "./generate-api-governance-inventory.mjs";

async function main() {
  const repoRoot = process.cwd();
  const inventory = JSON.parse(
    await readFile(
      path.join(repoRoot, "release/contracts/api-runtime-governance-inventory.v1.json"),
      "utf8"
    )
  );
  validateContract("api-runtime-governance-inventory.v1", inventory, { repoRoot });
  const result = verifyApiGovernanceInventory(
    inventory,
    await discoverApiGovernanceSurface(repoRoot)
  );
  process.stdout.write(`${JSON.stringify({ status: "verified", ...result })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "API_GOVERNANCE_INVENTORY_VERIFY_FAILED"}\n`);
  process.exitCode = 1;
});
