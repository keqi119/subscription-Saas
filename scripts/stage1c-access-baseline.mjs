import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { executeStage1cAccessBaseline } from "./stage1c-access-baseline-executor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
let directPrisma;

export function assertStage1cAccessBaselineApplyConfirmation(mode, env) {
  if (mode === "apply" && env.STAGE1C_ACCESS_BASELINE_APPLY !== "SYNC_STAGE1C_ACCESS_BASELINE") {
    throw new Error("STAGE1C_ACCESS_BASELINE_APPLY_CONFIRMATION_REQUIRED");
  }
}

export function parseStage1cAccessBaselineArgs(args) {
  let mode = null;
  let output = null;
  let permissionsOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--apply") {
      if (mode !== null) throw new Error("STAGE1C_ACCESS_BASELINE_MODE_DUPLICATE");
      mode = argument.slice(2);
      continue;
    }
    if (argument === "--permissions-only") {
      if (permissionsOnly) throw new Error("STAGE1C_ACCESS_BASELINE_SCOPE_DUPLICATE");
      permissionsOnly = true;
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1];
      if (output !== null || !value || value.trim().length === 0 || value.startsWith("--")) {
        invalidOutput();
      }
      output = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      const value = argument.slice("--output=".length);
      if (output !== null || value.trim().length === 0 || value.startsWith("--")) {
        invalidOutput();
      }
      output = value;
      continue;
    }
    throw new Error("STAGE1C_ACCESS_BASELINE_ARGUMENT_INVALID");
  }
  if (mode === null) throw new Error("STAGE1C_ACCESS_BASELINE_MODE_REQUIRED");
  return { mode, output, permissionsOnly };
}

function invalidOutput() {
  throw new Error("STAGE1C_ACCESS_BASELINE_OUTPUT_INVALID");
}

export async function runStage1cAccessBaselineCli({
  args,
  createPrisma = createStage1cAccessBaselinePrisma,
  env = process.env,
  execute = executeStage1cAccessBaseline,
  writeOutput = writeStage1cAccessBaselineOutput,
  writeStdout = writeStage1cAccessBaselineStdout
}) {
  const { mode, output, permissionsOnly } = parseStage1cAccessBaselineArgs(args);
  assertStage1cAccessBaselineApplyConfirmation(mode, env);
  const prisma = await createPrisma();
  const result = await execute({ mode, permissionsOnly, prisma });
  const json = `${JSON.stringify(result.report, null, 2)}\n`;
  await writeStdout(json);
  if (output !== null) await writeOutput(output, json);
  return result.exitCode;
}

export function writeStage1cAccessBaselineStdout(contents, stdout = process.stdout) {
  return new Promise((resolveWrite, rejectWrite) => {
    let settled = false;
    const cleanup = () => stdout.removeListener("error", onError);
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectWrite(error);
    };
    const onError = (error) => {
      cleanup();
      rejectOnce(error);
    };

    stdout.once("error", onError);
    try {
      stdout.write(contents, (error) => {
        if (error) {
          rejectOnce(error);
          setImmediate(cleanup);
          return;
        }
        cleanup();
        if (settled) return;
        settled = true;
        resolveWrite();
      });
    } catch (error) {
      cleanup();
      rejectOnce(error);
    }
  });
}

export function stage1cAccessBaselinePublicError() {
  return { error: "STAGE1C_ACCESS_BASELINE_FAILED" };
}

export async function runStage1cAccessBaselineProcess({ disconnect, run, writeStderr }) {
  let exitCode = 0;
  let failed = false;
  try {
    exitCode = await run();
  } catch {
    failed = true;
    exitCode = 1;
  }
  try {
    await disconnect();
  } catch {
    failed = true;
    exitCode = 1;
  }
  if (failed) writeStderr(`${JSON.stringify(stage1cAccessBaselinePublicError())}\n`);
  return exitCode;
}

async function createStage1cAccessBaselinePrisma() {
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("STAGE1C_ACCESS_BASELINE_DATABASE_URL_REQUIRED");
  return new PrismaClient({ adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl)) });
}

async function loadEnvironment() {
  const { config } = await import(pathToFileURL(requireFromApi.resolve("dotenv")).href);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
}

async function writeStage1cAccessBaselineOutput(path, contents) {
  const absolutePath = resolve(process.cwd(), path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

async function main() {
  await loadEnvironment();
  return runStage1cAccessBaselineCli({
    args: process.argv.slice(2),
    createPrisma: async () => {
      directPrisma = await createStage1cAccessBaselinePrisma();
      return directPrisma;
    }
  });
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  runStage1cAccessBaselineProcess({
    disconnect: async () => directPrisma?.$disconnect(),
    run: main,
    writeStderr: (contents) => process.stderr.write(contents)
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
