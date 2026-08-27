import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStage1ActiveSourceFactsRepairArgs } from "./stage1-active-source-facts-repair-core.mjs";
import { executeStage1ActiveSourceFactsRepair } from "./stage1-active-source-facts-repair-executor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
let directPrisma;

export function assertStage1ActiveSourceFactsRepairApplyConfirmation(mode, env) {
  if (mode === "apply" && env.STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY !== "1") {
    throw new Error("STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY_CONFIRMATION_REQUIRED");
  }
}

export async function runStage1ActiveSourceFactsRepairCli({
  args,
  createPrisma = createStage1ActiveSourceFactsRepairPrisma,
  env = process.env,
  execute = executeStage1ActiveSourceFactsRepair,
  writeOutput = writeStage1ActiveSourceFactsRepairOutput,
  writeStdout = writeStage1ActiveSourceFactsRepairStdout
}) {
  const { mode, output } = parseStage1ActiveSourceFactsRepairArgs(args);
  assertStage1ActiveSourceFactsRepairApplyConfirmation(mode, env);
  const prisma = await createPrisma();
  const result = await execute({ mode, prisma });
  const json = `${JSON.stringify(result.report, null, 2)}\n`;
  await writeStdout(json);
  if (output !== null) await writeOutput(output, json);
  return result.exitCode;
}

export function writeStage1ActiveSourceFactsRepairStdout(contents, stdout = process.stdout) {
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

export function stage1ActiveSourceFactsRepairPublicError() {
  return { error: "STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_FAILED" };
}

export async function runStage1ActiveSourceFactsRepairProcess({ disconnect, run, writeStderr }) {
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
  if (failed) {
    writeStderr(`${JSON.stringify(stage1ActiveSourceFactsRepairPublicError())}\n`);
  }
  return exitCode;
}

async function createStage1ActiveSourceFactsRepairPrisma() {
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_DATABASE_URL_REQUIRED");
  }
  return new PrismaClient({
    adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
  });
}

async function loadEnvironment() {
  const { config } = await import(pathToFileURL(requireFromApi.resolve("dotenv")).href);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
}

async function writeStage1ActiveSourceFactsRepairOutput(path, contents) {
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
  return runStage1ActiveSourceFactsRepairCli({
    args: process.argv.slice(2),
    createPrisma: async () => {
      directPrisma = await createStage1ActiveSourceFactsRepairPrisma();
      return directPrisma;
    }
  });
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  runStage1ActiveSourceFactsRepairProcess({
    disconnect: async () => directPrisma?.$disconnect(),
    run: main,
    writeStderr: (contents) => process.stderr.write(contents)
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
