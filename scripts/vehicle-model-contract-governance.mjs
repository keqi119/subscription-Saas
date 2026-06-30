import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  scanExternalEnumUsage,
  validateExternalConsumerRegistry
} from "./vehicle-model-removal-readiness-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRegistryPath = path.join(repoRoot, "docs", "vehicle-model-external-contract-consumer-register.json");
const defaultOutputPath = path.join(repoRoot, ".tmp", "vehicle-model-contract-governance-report.json");
const scanRoots = ["apps/api/src", "apps/web/src", "packages/shared/src", "scripts"];
const scanExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = await readRegistry(args.registryPath ?? defaultRegistryPath);
  const files = await readScanFiles(scanRoots.map((root) => path.join(repoRoot, root)));
  const externalUsage = scanExternalEnumUsage(
    files.map((file) => ({
      content: file.content,
      path: path.relative(repoRoot, file.path)
    }))
  );
  const validation = validateExternalConsumerRegistry({
    consumers: registry.consumers,
    externalUsage
  });
  const report = {
    generatedAt: new Date().toISOString(),
    registryPath: path.relative(repoRoot, args.registryPath ?? defaultRegistryPath),
    registrySchemaVersion: registry.schemaVersion ?? "unknown",
    validation
  };
  const outputPath = path.resolve(repoRoot, args.outputPath ?? defaultOutputPath);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`VehicleModel contract governance report written: ${path.relative(repoRoot, outputPath)}`);
  console.log(
    JSON.stringify(
      {
        blockingConsumers: validation.blockingConsumers.length,
        hardRemovalReady: validation.hardRemovalReady,
        missingReferences: validation.missingReferences.length,
        registeredReferences: validation.registeredReferences,
        totalExternalReferences: validation.totalExternalReferences,
        warningModeReady: validation.warningModeReady
      },
      null,
      2
    )
  );

  if (validation.missingReferences.length > 0 || validation.blockingConsumers.length > 0) {
    console.error("VehicleModel external contract governance check failed.");
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--registry") {
      result.registryPath = path.resolve(repoRoot, args[index + 1]);
      index += 1;
    } else if (arg === "--output") {
      result.outputPath = args[index + 1];
      index += 1;
    }
  }
  return result;
}

async function readRegistry(registryPath) {
  const raw = await readFile(registryPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.consumers)) {
    throw new Error("VehicleModel contract consumer registry must contain a consumers array.");
  }
  return parsed;
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
