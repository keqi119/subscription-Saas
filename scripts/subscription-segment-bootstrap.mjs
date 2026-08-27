import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applySubscriptionSegmentBootstrapPlan,
  buildSubscriptionSegmentBootstrapPlan,
  parseSubscriptionSegmentBootstrapMode
} from "./subscription-segment-bootstrap-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));

export function assertSubscriptionSegmentBootstrapApplyConfirmation(mode, env) {
  if (mode === "apply" && env.SUBSCRIPTION_SEGMENT_BOOTSTRAP_APPLY !== "1") {
    throw new Error("SUBSCRIPTION_SEGMENT_BOOTSTRAP_APPLY_CONFIRMATION_REQUIRED");
  }
}

export async function executeSubscriptionSegmentBootstrap({ mode, prisma, records }) {
  const plan = buildSubscriptionSegmentBootstrapPlan(records);
  const applied =
    mode === "apply"
      ? await applySubscriptionSegmentBootstrapPlan(prisma, plan)
      : { created: 0, existing: plan.summary.existing };
  return {
    ...applied,
    exceptions: plan.exceptions.length,
    mode,
    plan
  };
}

export async function loadSubscriptionSegmentBootstrapRecords(prisma) {
  return prisma.subscriptionOrder.findMany({
    include: {
      contract: true,
      contractSegments: {
        orderBy: { sequenceNo: "asc" },
        select: { id: true, segmentType: true, sequenceNo: true }
      }
    },
    orderBy: { orderNo: "asc" },
    where: {
      deletedAt: null,
      orderStatus: { in: ["ACTIVE", "PENDING_RETURN"] }
    }
  });
}

async function main() {
  const mode = parseSubscriptionSegmentBootstrapMode(process.argv.slice(2));
  assertSubscriptionSegmentBootstrapApplyConfirmation(mode, process.env);
  const prisma = await createPrismaClient();
  try {
    const records = await loadSubscriptionSegmentBootstrapRecords(prisma);
    const result = await executeSubscriptionSegmentBootstrap({ mode, prisma, records });
    console.log(JSON.stringify(toReport(result), bigintReplacer, 2));
    process.exitCode = result.exceptions > 0 ? 2 : 0;
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
  if (!databaseUrl) throw new Error("SUBSCRIPTION_SEGMENT_BOOTSTRAP_DATABASE_URL_REQUIRED");
  return new PrismaClient({ adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl)) });
}

function toReport(result) {
  return {
    applied: { created: result.created, existing: result.existing },
    exceptions: result.plan.exceptions,
    ignored: result.plan.ignored,
    mode: result.mode,
    summary: result.plan.summary
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
        error: "SUBSCRIPTION_SEGMENT_BOOTSTRAP_FAILED",
        message: error instanceof Error ? error.message : "Unknown error"
      })
    );
    process.exitCode = 1;
  });
}
