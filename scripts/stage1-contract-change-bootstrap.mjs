import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyContractChangeBootstrapPlan,
  buildContractChangeBootstrapPlan,
  parseContractChangeBootstrapMode,
  validateContractChangeFeatureFlags
} from "./stage1-contract-change-bootstrap-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));

export async function executeContractChangeBootstrap({ environment, mode, prisma, records }) {
  const featureFlags = validateContractChangeFeatureFlags(environment);
  const plan = buildContractChangeBootstrapPlan(records);
  const applied =
    mode === "apply"
      ? await applyContractChangeBootstrapPlan(prisma, plan)
      : {
          baseSegments: { created: 0, existing: plan.baseSegments.summary.existing },
          extensionDetails: { created: 0, existing: plan.extensionDetails.existing }
        };
  return {
    applied: mode === "apply",
    featureFlags,
    mode,
    plan,
    writes: applied
  };
}

export function loadContractChangeBootstrapRecords(prisma) {
  return prisma.subscriptionOrder.findMany({
    include: {
      contract: true,
      contractSegments: {
        orderBy: { sequenceNo: "asc" },
        select: { id: true, segmentType: true, sequenceNo: true }
      },
      subscriptionChanges: {
        include: { extensionDetail: true },
        orderBy: { createdAt: "asc" }
      },
      subscriptionPeriods: {
        orderBy: { startedAt: "asc" },
        select: { endedAt: true, id: true, startedAt: true, vehicleId: true }
      }
    },
    orderBy: { orderNo: "asc" },
    where: { deletedAt: null, orderStatus: "ACTIVE" }
  });
}

async function main() {
  const mode = parseContractChangeBootstrapMode(process.argv.slice(2));
  const prisma = await createPrismaClient();
  try {
    const records = await loadContractChangeBootstrapRecords(prisma);
    const result = await executeContractChangeBootstrap({
      environment: process.env,
      mode,
      prisma,
      records
    });
    console.log(JSON.stringify(toReport(result), bigintReplacer, 2));
    process.exitCode =
      result.featureFlags.blockers.length > 0 || result.plan.exceptions.length > 0 ? 2 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

async function createPrismaClient() {
  const [{ PrismaPg }, { PrismaClient }, { config }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href),
    import(pathToFileURL(requireFromApi.resolve("dotenv")).href)
  ]);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("CONTRACT_CHANGE_BOOTSTRAP_DATABASE_URL_REQUIRED");
  return new PrismaClient({ adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl)) });
}

function toReport(result) {
  return {
    applied: result.applied,
    exceptions: result.plan.exceptions,
    featureFlags: result.featureFlags,
    mode: result.mode,
    summary: result.plan.summary,
    writes: result.writes
  };
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: "CONTRACT_CHANGE_BOOTSTRAP_FAILED",
        message: error instanceof Error ? error.message : "Unknown error"
      })
    );
    process.exitCode = 1;
  });
}
