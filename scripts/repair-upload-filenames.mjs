import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { executeFilenameRepair, parseFilenameRepairArgs } from "./repair-upload-filenames-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
const HELP_TEXT = `Usage:
  node scripts/repair-upload-filenames.mjs --dry-run [--output <path>]
  node scripts/repair-upload-filenames.mjs --apply [--output <path>]
  node scripts/repair-upload-filenames.mjs --rollback-batch <uuid> [--output <path>]

The command only updates persisted display filenames and audit rows. It never
renames object-storage keys. Run --dry-run and review its JSON report before
using --apply.`;

let prisma;

async function main() {
  const options = parseFilenameRepairArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const databaseUrl = await loadDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("FILENAME_REPAIR_DATABASE_URL_REQUIRED");
  }

  const batchId = randomUUID();
  prisma = await createPrismaClient(databaseUrl);
  const report = await executeFilenameRepair({
    batchId,
    mode: options.mode,
    prisma,
    rollbackBatchId: options.rollbackBatchId
  });
  const outputPath = resolveOutputPath(options.output, report);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify({
      report: relative(repoRoot, outputPath).replaceAll("\\", "/"),
      summary: report.summary
    })
  );
  if (report.summary.failed > 0) process.exitCode = 1;
}

async function loadDatabaseUrl() {
  const { config } = await import(pathToFileURL(requireFromApi.resolve("dotenv")).href);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
  return process.env.DATABASE_URL?.trim() || null;
}

async function createPrismaClient(databaseUrl) {
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  return new PrismaClient({
    adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
  });
}

function resolveOutputPath(output, report) {
  if (output) return isAbsolute(output) ? output : resolve(repoRoot, output);
  return resolve(
    repoRoot,
    "artifacts",
    "filename-repair",
    `filename-repair-${report.mode}-${report.batchId}.json`
  );
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : "FILENAME_REPAIR_UNKNOWN_ERROR"
      })
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
