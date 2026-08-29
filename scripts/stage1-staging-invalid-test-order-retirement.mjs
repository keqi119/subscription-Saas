import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStage1StagingInvalidTestOrderRetirementArgs } from "./stage1-staging-invalid-test-order-retirement-core.mjs";
import { executeStage1StagingInvalidTestOrderRetirement } from "./stage1-staging-invalid-test-order-retirement-executor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING_DATABASE_NAME = "subscription_saas_staging";
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
let directPrisma;

export function assertStage1StagingInvalidTestOrderRetirementApplyEnvironment(mode, env) {
  if (mode !== "apply") return;
  const environments = [env.DEPLOYMENT_ENV, env.APP_ENV]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "")
    .map((value) => String(value).trim().toLowerCase());
  if (environments.length === 0 || environments.some((value) => value !== "staging")) {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_STAGING_REQUIRED");
  }
  if (env.STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY !== "1") {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY_CONFIRMATION_REQUIRED");
  }
}

export function assertStage1StagingInvalidTestOrderRetirementDatabaseIdentity(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.databaseName !== STAGING_DATABASE_NAME
  ) {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_DATABASE_IDENTITY_MISMATCH");
  }
}

export async function runStage1StagingInvalidTestOrderRetirementCli({
  args,
  createPrisma = createStage1StagingInvalidTestOrderRetirementPrisma,
  env = process.env,
  execute = executeStage1StagingInvalidTestOrderRetirement,
  writeOutput = writeStage1StagingInvalidTestOrderRetirementOutput,
  writeStdout = writeStage1StagingInvalidTestOrderRetirementStdout
}) {
  const { expectedEvidenceDigest, mode, operatorId, output } =
    parseStage1StagingInvalidTestOrderRetirementArgs(args);
  assertStage1StagingInvalidTestOrderRetirementApplyEnvironment(mode, env);
  const prisma = await createPrisma();
  if (mode === "apply") {
    const identity = await prisma.$queryRawUnsafe('SELECT current_database() AS "databaseName"');
    assertStage1StagingInvalidTestOrderRetirementDatabaseIdentity(identity);
  }
  const result = await execute({ expectedEvidenceDigest, mode, operatorId, prisma });
  const json = `${JSON.stringify(result.report, null, 2)}\n`;
  await writeStdout(json);
  if (output !== null) await writeOutput(output, json);
  return result.exitCode;
}

export function writeStage1StagingInvalidTestOrderRetirementStdout(
  contents,
  stdout = process.stdout
) {
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

export function stage1StagingInvalidTestOrderRetirementPublicError() {
  return { error: "STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_FAILED" };
}

export async function runStage1StagingInvalidTestOrderRetirementProcess({
  disconnect,
  run,
  writeStderr
}) {
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
    writeStderr(`${JSON.stringify(stage1StagingInvalidTestOrderRetirementPublicError())}\n`);
  }
  return exitCode;
}

async function createStage1StagingInvalidTestOrderRetirementPrisma() {
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_DATABASE_URL_REQUIRED");
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

async function writeStage1StagingInvalidTestOrderRetirementOutput(path, contents) {
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
  return runStage1StagingInvalidTestOrderRetirementCli({
    args: process.argv.slice(2),
    createPrisma: async () => {
      directPrisma = await createStage1StagingInvalidTestOrderRetirementPrisma();
      return directPrisma;
    }
  });
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  const exitCode = await runStage1StagingInvalidTestOrderRetirementProcess({
    disconnect: async () => directPrisma?.$disconnect(),
    run: main,
    writeStderr: (contents) => process.stderr.write(contents)
  });
  process.exitCode = exitCode;
}
