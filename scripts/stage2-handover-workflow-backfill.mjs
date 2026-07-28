import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseStage2HandoverWorkflowBackfillMode
} from "./stage2-handover-workflow-backfill-core.mjs";
import {
  executeStage2HandoverWorkflowBackfill
} from "./stage2-handover-workflow-backfill-executor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));

let prisma;

async function main() {
  const mode = parseStage2HandoverWorkflowBackfillMode(process.argv.slice(2));
  prisma = await createPrismaClient();
  const result = await executeStage2HandoverWorkflowBackfill({
    mode,
    prisma
  });
  console.log(JSON.stringify(result.report, null, 2));
  process.exitCode = result.exitCode;
}

async function createPrismaClient() {
  const [{ PrismaPg }, { PrismaClient }, { config }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href),
    import(pathToFileURL(requireFromApi.resolve("dotenv")).href)
  ]);

  config({
    path: resolve(repoRoot, ".env"),
    quiet: true
  });
  config({
    path: resolve(repoRoot, "apps/api/.env"),
    quiet: true
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("STAGE2_HANDOVER_WORKFLOW_BACKFILL_DATABASE_URL_REQUIRED");
  }
  return new PrismaClient({
    adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
  });
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

main()
  .catch(() => {
    console.error(
      JSON.stringify({
        error: "STAGE2_HANDOVER_WORKFLOW_BACKFILL_FAILED"
      })
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
