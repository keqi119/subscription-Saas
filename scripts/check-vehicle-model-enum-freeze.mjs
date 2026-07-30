import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertVehicleModelEnumRemoved } from "./check-vehicle-model-no-enum.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFile), "..");
const noEnumGuardPath = resolve(dirname(currentFile), "check-vehicle-model-no-enum.mjs");

export const assertVehicleModelStringCodeGovernance = assertVehicleModelEnumRemoved;

function main() {
  const result = spawnSync(process.execPath, [noEnumGuardPath], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }

  console.log("VehicleModel enum-freeze compatibility check passed (delegated to no-enum guard).");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
