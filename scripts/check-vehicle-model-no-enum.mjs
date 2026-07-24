import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFile), "..");
const schemaPath = resolve(repoRoot, "apps/api/prisma/schema.prisma");
const runtimeRoots = ["apps/api/src", "apps/web/src", "packages/shared/src", "scripts"];
const runtimeExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

export function assertVehicleModelEnumRemoved(schemaText, runtimeFiles) {
  const dependencies = findVehicleModelEnumDependencies(schemaText, runtimeFiles);

  if (dependencies.length > 0) {
    const error = new Error("VehicleModel enum dependencies remain.");
    error.dependencies = dependencies;
    throw error;
  }
}

export function findVehicleModelEnumDependencies(schemaText, runtimeFiles) {
  const dependencies = [];
  const uncommentedSchema = stripPrismaComments(schemaText);

  if (/\benum\s+VehicleModel\s*\{/.test(uncommentedSchema)) {
    dependencies.push({ category: "SCHEMA_ENUM_BLOCK", path: "apps/api/prisma/schema.prisma" });
  }

  if (/^(?!\s*enum\s)\s*\w+\s+VehicleModel\??(?:\s|$)/m.test(uncommentedSchema)) {
    dependencies.push({ category: "SCHEMA_ENUM_FIELD", path: "apps/api/prisma/schema.prisma" });
  }

  for (const file of runtimeFiles) {
    if (hasPrismaVehicleModelImport(file.content)) {
      dependencies.push({ category: "PRISMA_VEHICLE_MODEL_IMPORT", path: file.path });
    }

    if (hasPrismaVehicleModelNamespaceUsage(file.content)) {
      dependencies.push({ category: "PRISMA_VEHICLE_MODEL_NAMESPACE", path: file.path });
    }
  }

  return dependencies.sort((left, right) =>
    left.path === right.path ? left.category.localeCompare(right.category) : left.path.localeCompare(right.path)
  );
}

function stripPrismaComments(schemaText) {
  return schemaText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function hasPrismaVehicleModelImport(source) {
  const imports = source.matchAll(/\bimport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s*["']@prisma\/client["']/g);

  for (const entry of imports) {
    if (/\b(?:type\s+)?VehicleModel\b/.test(entry[1])) {
      return true;
    }
  }

  return false;
}

function hasPrismaVehicleModelNamespaceUsage(source) {
  const namespaceImports = source.matchAll(
    /\bimport\s+\*\s+as\s+(\w+)\s+from\s*["']@prisma\/client["']/g
  );

  for (const entry of namespaceImports) {
    if (new RegExp(`\\b${entry[1]}\\.VehicleModel\\b`).test(source)) {
      return true;
    }
  }

  return false;
}

function readRuntimeFiles() {
  const files = [];

  for (const root of runtimeRoots) {
    collectRuntimeFiles(resolve(repoRoot, root), files);
  }

  return files;
}

function collectRuntimeFiles(currentPath, files) {
  if (!existsSync(currentPath)) {
    return;
  }

  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    const nextPath = resolve(currentPath, entry.name);

    if (entry.isDirectory()) {
      if ([".next", ".tmp", "coverage", "dist", "node_modules"].includes(entry.name)) {
        continue;
      }
      collectRuntimeFiles(nextPath, files);
      continue;
    }

    const pathFromRoot = relative(repoRoot, nextPath).replaceAll("\\", "/");
    if (!runtimeExtensions.has(extname(entry.name)) || isExcludedRuntimeFile(pathFromRoot)) {
      continue;
    }

    files.push({ content: readFileSync(nextPath, "utf8"), path: pathFromRoot });
  }
}

function isExcludedRuntimeFile(pathFromRoot) {
  return (
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(pathFromRoot) ||
    pathFromRoot === "scripts/check-vehicle-model-no-enum.mjs" ||
    pathFromRoot.startsWith("scripts/model-definition-backfill") ||
    pathFromRoot.startsWith("scripts/quote-order-model-snapshot-backfill") ||
    pathFromRoot.startsWith("scripts/quote-order-model-code-snapshot-backfill")
  );
}

function main() {
  try {
    assertVehicleModelEnumRemoved(readFileSync(schemaPath, "utf8"), readRuntimeFiles());
  } catch (error) {
    if (error && typeof error === "object" && Array.isArray(error.dependencies)) {
      for (const dependency of error.dependencies) {
        console.error(`${dependency.path}\t${dependency.category}`);
      }
      process.exitCode = 1;
      return;
    }

    console.error("apps/api/prisma/schema.prisma\tSCAN_ERROR");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
