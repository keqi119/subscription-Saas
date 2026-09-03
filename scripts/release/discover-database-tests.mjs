#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  classifyDatabaseTests,
  discoverDatabaseTestCandidates,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

function codeError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function parseArgs(argv) {
  const result = { mode: "verify", output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") result.mode = argv[++index];
    else if (argument === "--output") result.output = argv[++index];
    else throw codeError("DATABASE_TEST_DISCOVERY_ARGUMENT_INVALID", { argument });
  }
  if (!["report", "verify"].includes(result.mode)) {
    throw codeError("DATABASE_TEST_DISCOVERY_MODE_INVALID");
  }
  return result;
}

async function loadJson(repoRoot, relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, ...relativePath.split("/")), "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const discovery = await loadJson(repoRoot, "release/contracts/database-test-discovery.v1.json");
  const manifest = await loadJson(repoRoot, "release/contracts/database-test-manifest.v1.json");
  const exceptionDocument = await loadJson(
    repoRoot,
    "release/contracts/database-test-exceptions.v1.json"
  );
  const external = await loadJson(
    repoRoot,
    "release/contracts/external-validation-applicability.v1.json"
  );
  validateContract("database-test-manifest.v1", manifest, { repoRoot });
  validateContract("external-validation-applicability.v1", external, { repoRoot });

  const candidates = await discoverDatabaseTestCandidates(repoRoot, discovery);
  let classification;
  let unclassified = [];
  try {
    classification = classifyDatabaseTests(
      candidates,
      manifest.suites,
      exceptionDocument.exceptions,
      external.records
    );
  } catch (error) {
    if (error?.code !== "DATABASE_TEST_UNCLASSIFIED") throw error;
    unclassified = error.details.paths;
    const exceptedPaths = new Set(exceptionDocument.exceptions.map((entry) => entry.path));
    const manifestedPaths = new Set(manifest.suites.flatMap((suite) => suite.files));
    classification = {
      manifested: [...manifestedPaths],
      excepted: [...exceptedPaths]
    };
  }
  const report = {
    schemaVersion: "database-test-report.v1",
    discoveryDigest: sha256Canonical(discovery),
    manifestDigest: sha256Canonical(manifest),
    exceptionsDigest: sha256Canonical(exceptionDocument),
    candidateCount: candidates.length,
    manifestedCount: classification.manifested.length,
    exceptedCount: classification.excepted.length,
    unclassifiedCount: unclassified.length,
    candidates,
    unclassified
  };
  validateContract("database-test-report.v1", report, { repoRoot });
  if (options.output) {
    const outputPath = path.resolve(repoRoot, options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(
    `${JSON.stringify({
      candidateCount: report.candidateCount,
      manifestedCount: report.manifestedCount,
      exceptedCount: report.exceptedCount,
      unclassifiedCount: report.unclassifiedCount
    })}\n`
  );
  if (unclassified.length > 0) throw codeError("DATABASE_TEST_UNCLASSIFIED");
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "DATABASE_TEST_DISCOVERY_FAILED"}\n`);
  process.exitCode = 1;
});
