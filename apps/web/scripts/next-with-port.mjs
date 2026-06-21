import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadEnvFile(resolve(appRoot, ".env.local"));
loadEnvFile(resolve(appRoot, ".env"));

const [mode = "dev", ...args] = process.argv.slice(2);

if (!["dev", "start"].includes(mode)) {
  console.error(`Unsupported Next command: ${mode}`);
  process.exit(1);
}

const port = process.env.WEB_PORT ?? process.env.PORT ?? "3000";
const hasPortArg = args.some((arg) => arg === "--port" || arg === "-p" || arg.startsWith("--port="));
const nextBin = resolve(appRoot, "node_modules", "next", "dist", "bin", "next");
const nextArgs = hasPortArg ? [nextBin, mode, ...args] : [nextBin, mode, "--port", port, ...args];

const child = spawn(process.execPath, nextArgs, {
  cwd: appRoot,
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquote(trimmed.slice(separatorIndex + 1).trim());
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquote(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
