import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildProductPriceRuleConstraintReadinessReport } from "./product-price-rule-constraint-readiness-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repoRoot, ".tmp/product-price-rule-constraint-readiness-report.json");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
const [{ PrismaPg }, { PrismaClient }, { config }] = await Promise.all([
  import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
  import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href),
  import(pathToFileURL(requireFromApi.resolve("dotenv")).href)
]);

config({ path: resolve(repoRoot, ".env") });
config({ path: resolve(repoRoot, "apps/api/.env") });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for ProductPriceRule constraint readiness.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
});

async function main() {
  const rules = await prisma.productPriceRule.findMany({
    select: {
      id: true,
      modelDefinition: {
        select: {
          id: true,
          legacyVehicleModel: true,
          modelCode: true
        }
      },
      modelDefinitionId: true,
      productVersionId: true,
      vehicleModel: true
    },
    where: {
      deletedAt: null
    }
  });
  const report = {
    generatedAt: new Date().toISOString(),
    ...buildProductPriceRuleConstraintReadinessReport({ rules })
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`ProductPriceRule constraint readiness report written: ${relativeOutputPath()}`);
  console.log(JSON.stringify({ ready: report.ready, summary: report.summary }, null, 2));

  if (!report.ready) {
    process.exitCode = 1;
  }
}

function normalizeLocalhostDatabaseUrl(value) {
  if (value.includes("127.0.0.1") || value.includes("localhost")) {
    return value;
  }

  return value.replace("@db:", "@127.0.0.1:");
}

function relativeOutputPath() {
  return outputPath.replace(`${repoRoot}\\`, "").replace(`${repoRoot}/`, "");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
