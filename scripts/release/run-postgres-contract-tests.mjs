#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function contractError(code) {
  return Object.assign(new Error(code), { code });
}

async function main(argv) {
  const suiteIndex = argv.indexOf("--suite");
  if (suiteIndex < 0 || argv[suiteIndex + 1] !== "database-lifecycle" || argv.length !== 2) {
    throw contractError("POSTGRES_CONTRACT_SUITE_INVALID");
  }
  const testFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../packages/release-foundation/test/database-lifecycle.postgres.test.mjs"
  );
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", testFile], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(contractError("POSTGRES_CONTRACT_INTERRUPTED"));
        return;
      }
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw contractError("POSTGRES_CONTRACT_FAILED");
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error?.code ?? "POSTGRES_CONTRACT_FAILED"}\n`);
  process.exitCode = 1;
});
