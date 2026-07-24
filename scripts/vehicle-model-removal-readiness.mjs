import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildVehicleModelRemovalReadinessReport,
  scanExternalEnumUsage
} from "./vehicle-model-removal-readiness-core.mjs";
import { assertVehicleModelEnumRemoved } from "./check-vehicle-model-no-enum.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputPath = path.join(repoRoot, ".tmp", "vehicle-model-removal-readiness-report.json");
const schemaPath = path.join(repoRoot, "apps", "api", "prisma", "schema.prisma");
const scanRoots = ["apps/api/src", "apps/web/src", "packages/shared/src", "scripts"];
const scanExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeEvents = args.runtimeEventsPath ? await readRuntimeEvents(args.runtimeEventsPath) : [];
  const files = await readScanFiles(scanRoots.map((root) => path.join(repoRoot, root)));
  const externalUsage = scanExternalEnumUsage(
    files.map((file) => ({
      content: file.content,
      path: path.relative(repoRoot, file.path)
    }))
  );
  const enumTypeRemoval = await inspectEnumTypeRemoval(files);
  const report = buildVehicleModelRemovalReadinessReport({ enumTypeRemoval, externalUsage, runtimeEvents });
  const outputPath = path.resolve(repoRoot, args.outputPath ?? defaultOutputPath);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`VehicleModel removal readiness report written: ${path.relative(repoRoot, outputPath)}`);
  console.log(
    JSON.stringify(
      {
        businessDecisionUsageCount: report.businessDecisionUsageCount,
        compatibilityFieldRetirementDecision: report.compatibilityFieldRetirement.decision,
        decision: report.decision,
        enumTypeRemovalDecision: report.enumTypeRemoval.decision,
        compatibilityFieldUsageCount: report.compatibilityFieldUsageCount,
        externalUsageCount: report.externalUsageCount,
        fallbackUsageCount: report.fallbackUsageCount,
        readinessScore: report.readinessScore
      },
      null,
      2
    )
  );

  if (report.enumTypeRemoval.decision !== "READY") {
    process.exitCode = 1;
  }
}

async function inspectEnumTypeRemoval(files) {
  try {
    assertVehicleModelEnumRemoved(
      await readFile(schemaPath, "utf8"),
      files.map((file) => ({
        content: file.content,
        path: path.relative(repoRoot, file.path)
      }))
    );
    return {
      decision: "READY",
      enforcement: "node scripts/check-vehicle-model-no-enum.mjs"
    };
  } catch (error) {
    return {
      decision: "NOT_READY",
      dependencies: error && typeof error === "object" && Array.isArray(error.dependencies) ? error.dependencies : [],
      enforcement: "node scripts/check-vehicle-model-no-enum.mjs"
    };
  }
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      result.outputPath = args[index + 1];
      index += 1;
    } else if (arg === "--runtime-events") {
      result.runtimeEventsPath = args[index + 1];
      index += 1;
    }
  }
  return result;
}

async function readRuntimeEvents(runtimeEventsPath) {
  const absolutePath = path.resolve(repoRoot, runtimeEventsPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.events ?? [];
}

async function readScanFiles(roots) {
  const files = [];
  for (const root of roots) {
    await collectFiles(root, files);
  }
  return files;
}

async function collectFiles(currentPath, files) {
  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const nextPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if ([".next", ".tmp", "coverage", "dist", "node_modules"].includes(entry.name)) {
        continue;
      }
      await collectFiles(nextPath, files);
      continue;
    }

    if (!scanExtensions.has(path.extname(entry.name)) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) {
      continue;
    }
    files.push({
      content: await readFile(nextPath, "utf8"),
      path: nextPath
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
