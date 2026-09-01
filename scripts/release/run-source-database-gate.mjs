#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runLauncherCli } from "./database-test-launcher-runtime.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLauncherCli("source-gate", process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "DATABASE_LAUNCHER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
