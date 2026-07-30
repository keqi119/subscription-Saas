import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFile), "..");
const schemaPath = resolve(repoRoot, "apps/api/prisma/schema.prisma");
const runtimeRoots = ["apps/api/src", "apps/web/src", "packages/shared/src", "scripts"];
const runtimeExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);
const compatibilityCategories = new Map([
  ["vehicleModel", "VEHICLE_MODEL_COMPATIBILITY_IDENTIFIER"],
  ["legacyVehicleModel", "LEGACY_VEHICLE_MODEL_IDENTIFIER"],
  ["legacyVehicleModelSnapshot", "LEGACY_VEHICLE_MODEL_SNAPSHOT_IDENTIFIER"],
  [
    "legacyVehicleModelCodeSnapshot",
    "LEGACY_VEHICLE_MODEL_CODE_SNAPSHOT_IDENTIFIER"
  ]
]);

export function assertNoVehicleModelCompatibility({ schemaText, runtimeFiles }) {
  const violations = [
    ...findSchemaViolations(schemaText),
    ...findRuntimeViolations(runtimeFiles)
  ];

  return {
    violations: uniqueViolations(violations)
  };
}

function findSchemaViolations(schemaText) {
  const schema = stripPrismaComments(schemaText);
  const violations = [];

  for (const [pattern, category] of [
    [/^\s*vehicleModel\s+(?:String|VehicleModel)(?:\?|\[\])?(?:\s|$)/m, "SCHEMA_VEHICLE_MODEL_FIELD"],
    [/^\s*legacyVehicleModel\s+/m, "SCHEMA_LEGACY_VEHICLE_MODEL_FIELD"],
    [
      /^\s*legacyVehicleModelSnapshot\s+/m,
      "SCHEMA_LEGACY_VEHICLE_MODEL_SNAPSHOT_FIELD"
    ],
    [
      /^\s*legacyVehicleModelCodeSnapshot\s+/m,
      "SCHEMA_LEGACY_VEHICLE_MODEL_CODE_SNAPSHOT_FIELD"
    ],
    [/\benum\s+VehicleModel\s*\{/, "SCHEMA_VEHICLE_MODEL_ENUM"]
  ]) {
    if (pattern.test(schema)) {
      violations.push({ category, path: "apps/api/prisma/schema.prisma" });
    }
  }

  return violations;
}

function findRuntimeViolations(runtimeFiles) {
  const violations = [];

  for (const file of runtimeFiles) {
    const sourceFile = ts.createSourceFile(
      resolve(repoRoot, file.path),
      file.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(file.path)
    );

    function visit(node) {
      if (ts.isIdentifier(node)) {
        const category =
          node.text === "VehicleModel"
            ? "RUNTIME_VEHICLE_MODEL_TYPE"
            : compatibilityCategories.get(node.text);

        if (category) {
          violations.push({ category, path: file.path });
        }
      }

      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        compatibilityCategories.has(node.text)
      ) {
        violations.push({
          category: compatibilityCategories.get(node.text),
          path: file.path
        });
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations;
}

function stripPrismaComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function uniqueViolations(violations) {
  const unique = new Map(
    violations.map((violation) => [
      `${violation.path}\0${violation.category}`,
      violation
    ])
  );

  return [...unique.values()].sort((left, right) =>
    left.path === right.path
      ? left.category.localeCompare(right.category)
      : left.path.localeCompare(right.path)
  );
}

function getScriptKind(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function readRuntimeFiles() {
  const files = [];

  for (const root of runtimeRoots) {
    collectRuntimeFiles(resolve(repoRoot, root), files);
  }

  collectSeedFiles(files);
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

    addRuntimeFile(nextPath, files);
  }
}

function collectSeedFiles(files) {
  const prismaDirectory = resolve(repoRoot, "apps/api/prisma");

  if (!existsSync(prismaDirectory)) {
    return;
  }

  for (const entry of readdirSync(prismaDirectory, { withFileTypes: true })) {
    if (entry.isFile() && /^seed.*\.mjs$/.test(entry.name)) {
      addRuntimeFile(resolve(prismaDirectory, entry.name), files);
    }
  }
}

function addRuntimeFile(filePath, files) {
  const pathFromRoot = relative(repoRoot, filePath).replaceAll("\\", "/");

  if (
    !runtimeExtensions.has(extname(filePath)) ||
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(pathFromRoot) ||
    pathFromRoot === "scripts/check-vehicle-model-no-compatibility.mjs"
  ) {
    return;
  }

  files.push({
    content: readFileSync(filePath, "utf8"),
    path: pathFromRoot
  });
}

function main() {
  const report = assertNoVehicleModelCompatibility({
    runtimeFiles: readRuntimeFiles(),
    schemaText: readFileSync(schemaPath, "utf8")
  });

  for (const violation of report.violations) {
    console.error(`${violation.path}\t${violation.category}`);
  }

  if (report.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
