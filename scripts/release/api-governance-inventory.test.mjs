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

test("inventory preserves the migrated surface while API runtime governance is empty", async () => {
  const [inventory, surface] = await Promise.all([
    loadJson("release/contracts/api-runtime-governance-inventory.v1.json"),
    discoverApiGovernanceSurface(repoRoot)
  ]);
  const result = verifyApiGovernanceInventory(inventory, surface);

  assert.deepEqual(surface.imageFiles, []);
  assert.deepEqual(surface.entrypoints, []);
  assert.equal(result.fileCount, 25);
  assert.equal(result.commandCount, 11);
  assert.equal(result.runtimeFileCount, 0);
  assert.equal(result.runtimeCommandCount, 0);
  assert.equal(result.unownedCallers.length, 0);
  assert.equal(result.activeLegacyCallers.length, 0);
  assert.equal(result.unmappedDependencies.length, 0);
});

test("every discovered formal caller is owned and routed to fixed Runner commands", async () => {
  const [inventory, surface] = await Promise.all([
    loadJson("release/contracts/api-runtime-governance-inventory.v1.json"),
    discoverApiGovernanceSurface(repoRoot)
  ]);
  verifyApiGovernanceInventory(inventory, surface);

  assert.deepEqual(surface.callers, []);
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
    assert.equal(
      command.callers.every(({ migrationStatus }) => migrationStatus === "runner-cutover-complete"),
      true
    );
  }
  assert.equal(
    inventory.commands.find(({ runnerCommandId }) => runnerCommandId === "db.schema.verify@1")
      ?.runnerRegistrationStatus,
    "registered"
  );
  assert.deepEqual(
    inventory.commands.find(
      ({ entrypoint }) => entrypoint === "scripts/stage1-return-closure-backfill.mjs"
    )?.additionalRunnerCommands,
    [
      {
        runnerCommandId: "stage1.return-closure.publication-constraint.validate@1",
        runnerRegistrationStatus: "registered",
        capabilityProfile: "migrate"
      }
    ]
  );
});

test("source-only assets are non-executable and the target API allowlist rejects governance tools", async () => {
  const [inventory, allowlist, surface] = await Promise.all([
    loadJson("release/contracts/api-runtime-governance-inventory.v1.json"),
    loadJson("release/contracts/api-runtime-allowlist.v1.json"),
    discoverApiGovernanceSurface(repoRoot)
  ]);
  verifyApiGovernanceInventory(inventory, surface);

  const imageSources = new Set(surface.imageFiles.map(({ repositorySource }) => repositorySource));
  for (const file of inventory.files) {
    assert.equal(imageSources.has(file.repositorySource), false, file.repositorySource);
    assert.equal(["runner-only", "source-test-only"].includes(file.disposition), true);
  }
  assert.deepEqual(allowlist.forbiddenPaths, ["/app/scripts"]);
  assert.deepEqual(allowlist.forbiddenExecutables.sort(), ["docker", "podman", "prisma", "psql"]);
  assert.equal(allowlist.allowedCapabilities.includes("application-server"), true);
  assert.equal(allowlist.allowedCapabilities.includes("arbitrary-governance-script"), false);
});
