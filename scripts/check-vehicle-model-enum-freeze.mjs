import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFile), "..");
const schemaPath = resolve(repoRoot, "apps/api/prisma/schema.prisma");

export const FROZEN_VEHICLE_MODEL_VALUES = Object.freeze([
  "ET5",
  "ET5T",
  "ET7",
  "ES6",
  "EC6",
  "ES8",
  "ET9",
  "ES9"
]);

export function extractVehicleModelValues(schemaText) {
  const schemaWithoutComments = stripPrismaComments(schemaText);
  const match = schemaWithoutComments.match(/\benum\s+VehicleModel\s*\{([\s\S]*?)\}/);

  if (!match) {
    throw new Error("VehicleModel enum was not found in apps/api/prisma/schema.prisma.");
  }

  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("@@"))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

export function compareVehicleModelValues(actualValues, frozenValues = FROZEN_VEHICLE_MODEL_VALUES) {
  const frozenSet = new Set(frozenValues);
  const actualSet = new Set(actualValues);
  const duplicateSet = new Set(actualValues.filter((value, index) => actualValues.indexOf(value) !== index));

  return {
    unexpectedValues: [...actualSet].filter((value) => !frozenSet.has(value)),
    missingValues: frozenValues.filter((value) => !actualSet.has(value)),
    duplicateValues: [...duplicateSet]
  };
}

function stripPrismaComments(schemaText) {
  return schemaText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function formatFailure(diff) {
  const lines = ["VehicleModel enum freeze check failed."];

  if (diff.unexpectedValues.length > 0) {
    lines.push(`Unexpected values: ${diff.unexpectedValues.join(", ")}`);
  }

  if (diff.missingValues.length > 0) {
    lines.push(`Missing values: ${diff.missingValues.join(", ")}`);
  }

  if (diff.duplicateValues.length > 0) {
    lines.push(`Duplicate values: ${diff.duplicateValues.join(", ")}`);
  }

  lines.push("");
  lines.push("VehicleModel is frozen. Add new vehicle models through VehicleModelDefinition instead of Prisma enum.");

  return lines.join("\n");
}

function main() {
  let actualValues;

  try {
    actualValues = extractVehicleModelValues(readFileSync(schemaPath, "utf8"));
  } catch (error) {
    console.error("VehicleModel enum freeze check failed.");
    console.error(error.message);
    console.error("");
    console.error("VehicleModel is frozen. Add new vehicle models through VehicleModelDefinition instead of Prisma enum.");
    process.exit(1);
  }

  const diff = compareVehicleModelValues(actualValues);

  if (diff.unexpectedValues.length > 0 || diff.missingValues.length > 0 || diff.duplicateValues.length > 0) {
    console.error(formatFailure(diff));
    process.exit(1);
  }

  console.log("VehicleModel enum freeze check passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  main();
}
