import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  discoverApiGovernanceSurface,
  verifyApiGovernanceInventory
} from "./generate-api-governance-inventory.mjs";

const repoRoot = new URL("../..", import.meta.url);

async function loadJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repoRoot), "utf8"));
}

test("inventory covers every API runtime governance file and executable in both directions", async () => {
  const [inventory, surface] = await Promise.all([
    loadJson("release/contracts/api-runtime-governance-inventory.v1.json"),
    discoverApiGovernanceSurface(repoRoot)
  ]);
  const result = verifyApiGovernanceInventory(inventory, surface);

  assert.deepEqual(
    inventory.files.map(({ repositorySource }) => repositorySource).sort(),
    surface.imageFiles.map(({ repositorySource }) => repositorySource).sort()
  );
  assert.deepEqual(
    inventory.commands.map(({ entrypoint }) => entrypoint).sort(),
    surface.entrypoints.map(({ entrypoint }) => entrypoint).sort()
  );
  assert.equal(result.fileCount, 25);
  assert.equal(result.unownedCallers.length, 0);
  assert.equal(result.unmappedDependencies.length, 0);
});

test("every discovered formal caller is owned and routed to one fixed Runner command", async () => {
  const [inventory, surface] = await Promise.all([
    loadJson("release/contracts/api-runtime-governance-inventory.v1.json"),
    discoverApiGovernanceSurface(repoRoot)
  ]);
  verifyApiGovernanceInventory(inventory, surface);

  const inventoriedCallers = new Set(
    inventory.commands.flatMap(({ callers }) => callers.map(({ callerId }) => callerId))
  );
  for (const caller of surface.callers) {
    assert.equal(inventoriedCallers.has(caller.callerId), true, caller.callerId);
  }
  for (const command of inventory.commands) {
    assert.match(command.runnerCommandId, /^[a-z][a-z0-9.-]+@[1-9][0-9]*$/);
    assert.equal(command.migrationOwner, "release-engineering");
    assert.equal(
      command.callers.some(({ callerType }) => callerType === "manual"),
      true
    );
    assert.equal(
      command.callers.some(({ callerType }) => callerType === "external"),
      true
    );
  }
});

test("source-only assets are non-executable and the target API allowlist rejects governance tools", async () => {
  const [inventory, allowlist, surface] = await Promise.all([
    loadJson("release/contracts/api-runtime-governance-inventory.v1.json"),
    loadJson("release/contracts/api-runtime-allowlist.v1.json"),
    discoverApiGovernanceSurface(repoRoot)
  ]);
  verifyApiGovernanceInventory(inventory, surface);

  const imageSources = new Set(surface.imageFiles.map(({ repositorySource }) => repositorySource));
  for (const file of inventory.files.filter(
    ({ disposition }) => disposition === "source-test-only"
  )) {
    assert.equal(imageSources.has(file.repositorySource), false, file.repositorySource);
  }
  assert.deepEqual(allowlist.forbiddenPaths, ["/app/scripts"]);
  assert.deepEqual(allowlist.forbiddenExecutables.sort(), ["prisma", "psql"]);
  assert.equal(allowlist.allowedCapabilities.includes("application-server"), true);
  assert.equal(allowlist.allowedCapabilities.includes("arbitrary-governance-script"), false);
});
