import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const candidateReasons = Object.freeze([
  "filename-pattern",
  "database-client-import",
  "database-environment-read",
  "explicit-database-label"
]);

function codeError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryPath(value) {
  return value.replaceAll("\\", "/");
}

function compilePatterns(values, field) {
  if (!Array.isArray(values) || values.length === 0) {
    throw codeError("DATABASE_TEST_DISCOVERY_RULE_INVALID", { field });
  }
  return values.map((value) => {
    try {
      return new RegExp(value, "m");
    } catch {
      throw codeError("DATABASE_TEST_DISCOVERY_RULE_INVALID", { field, value });
    }
  });
}

function matchesAny(patterns, value) {
  return patterns.some((pattern) => pattern.test(value));
}

export function trackedTestUniverse(paths) {
  return [...new Set(paths.map(repositoryPath))]
    .filter(
      (candidatePath) =>
        /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(candidatePath) ||
        /[.-](test|spec|integration|e2e(?:-spec)?|postgres|schema)\.[cm]?[jt]sx?$/.test(
          candidatePath
        )
    )
    .filter((candidatePath) => /\.[cm]?[jt]sx?$/.test(candidatePath))
    .sort(comparePaths);
}

async function trackedPaths(repoRoot) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }));
  } catch (error) {
    throw codeError("DATABASE_TEST_GIT_UNIVERSE_FAILED", { exitCode: error?.code });
  }
  return stdout.toString("utf8").split("\0").filter(Boolean).map(repositoryPath);
}

export async function discoverDatabaseTestCandidates(repoRoot, rules) {
  if (
    rules?.contractVersion !== "database-test-discovery.v1" ||
    typeof rules?.candidateRules !== "object" ||
    rules.candidateRules === null
  ) {
    throw codeError("DATABASE_TEST_DISCOVERY_RULE_INVALID");
  }
  const filenamePatterns = compilePatterns(
    rules.candidateRules.filenamePatterns,
    "filenamePatterns"
  );
  const databaseClientImports = compilePatterns(
    rules.candidateRules.databaseClientImports,
    "databaseClientImports"
  );
  const databaseEnvironmentReads = compilePatterns(
    rules.candidateRules.databaseEnvironmentReads,
    "databaseEnvironmentReads"
  );
  const explicitDatabaseLabels = compilePatterns(
    rules.candidateRules.explicitDatabaseLabels,
    "explicitDatabaseLabels"
  );

  const candidates = [];
  for (const relativePath of trackedTestUniverse(await trackedPaths(repoRoot))) {
    const content = await readFile(path.join(repoRoot, ...relativePath.split("/")), "utf8");
    const reasons = [];
    if (matchesAny(filenamePatterns, relativePath)) reasons.push("filename-pattern");
    if (matchesAny(databaseClientImports, content)) reasons.push("database-client-import");
    if (matchesAny(databaseEnvironmentReads, content)) reasons.push("database-environment-read");
    if (matchesAny(explicitDatabaseLabels, content)) reasons.push("explicit-database-label");
    if (reasons.length > 0) candidates.push({ path: relativePath, reasons });
  }
  return candidates;
}

function assertApplicability(value, suiteId, chain) {
  if (value?.status === "required" && Object.keys(value).length === 1) return;
  if (
    value?.status === "approved-na" &&
    ["owner", "reason", "approvalRef", "reviewDate"].every(
      (key) => typeof value[key] === "string" && value[key].length > 0
    ) &&
    Object.keys(value).every((key) =>
      ["status", "owner", "reason", "approvalRef", "reviewDate"].includes(key)
    )
  ) {
    return;
  }
  throw codeError("DATABASE_TEST_CHAIN_APPLICABILITY_INVALID", { suiteId, chain });
}

function validateSuite(suite) {
  const requiredStrings = ["suiteId", "runner", "databaseRole", "barrier", "owner"];
  if (
    !suite ||
    requiredStrings.some((key) => typeof suite[key] !== "string" || suite[key].length === 0) ||
    !Array.isArray(suite.files) ||
    suite.files.length === 0 ||
    !Number.isInteger(suite.timeoutMs) ||
    suite.timeoutMs <= 0 ||
    typeof suite.externalDependency !== "string" ||
    !suite.parallelism ||
    !["serial", "parallel"].includes(suite.parallelism.mode) ||
    !Number.isInteger(suite.parallelism.maxShards) ||
    suite.parallelism.maxShards < 1
  ) {
    throw codeError("DATABASE_TEST_SUITE_INVALID", { suiteId: suite?.suiteId });
  }
  if (new Set(suite.files).size !== suite.files.length) {
    throw codeError("DATABASE_TEST_SUITE_FILE_DUPLICATE", { suiteId: suite.suiteId });
  }
  assertApplicability(suite.chainApplicability?.fresh, suite.suiteId, "fresh");
  assertApplicability(suite.chainApplicability?.snapshot, suite.suiteId, "snapshot");
}

function validateException(exception) {
  if (
    !exception ||
    !["path", "owner", "reason", "scope", "reviewDate"].every(
      (key) => typeof exception[key] === "string" && exception[key].length > 0
    )
  ) {
    throw codeError("DATABASE_TEST_EXCEPTION_INVALID", { path: exception?.path });
  }
}

export function classifyDatabaseTests(
  candidates,
  manifest,
  exceptions,
  externalApplicability = []
) {
  const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
  if (candidatePaths.size !== candidates.length)
    throw codeError("DATABASE_TEST_CANDIDATE_DUPLICATE");

  const suiteIds = new Set();
  const manifestedByPath = new Map();
  for (const suite of manifest) {
    validateSuite(suite);
    if (suiteIds.has(suite.suiteId)) {
      throw codeError("DATABASE_TEST_SUITE_DUPLICATE", { suiteId: suite.suiteId });
    }
    suiteIds.add(suite.suiteId);
    for (const relativePath of suite.files) {
      if (manifestedByPath.has(relativePath)) {
        throw codeError("DATABASE_TEST_MANIFEST_FILE_DUPLICATE", { path: relativePath });
      }
      if (!candidatePaths.has(relativePath)) {
        throw codeError("DATABASE_TEST_MANIFEST_NOT_DISCOVERED", { path: relativePath });
      }
      manifestedByPath.set(relativePath, suite.suiteId);
    }
    if (
      suite.externalDependency !== "none" &&
      !externalApplicability.some(
        (entry) =>
          entry.relatedSuiteId === suite.suiteId &&
          ["must-automate", "must-external-verify", "must-human-verify", "not-applicable"].includes(
            entry.status
          ) &&
          typeof entry.owner === "string" &&
          entry.owner.length > 0
      )
    ) {
      throw codeError("DATABASE_TEST_EXTERNAL_APPLICABILITY_MISSING", {
        suiteId: suite.suiteId
      });
    }
  }

  const exceptionPaths = new Set();
  for (const exception of exceptions) {
    validateException(exception);
    if (exceptionPaths.has(exception.path)) {
      throw codeError("DATABASE_TEST_EXCEPTION_DUPLICATE", { path: exception.path });
    }
    if (!candidatePaths.has(exception.path)) {
      throw codeError("DATABASE_TEST_EXCEPTION_NOT_DISCOVERED", { path: exception.path });
    }
    if (manifestedByPath.has(exception.path)) {
      throw codeError("DATABASE_TEST_CLASSIFICATION_OVERLAP", { path: exception.path });
    }
    exceptionPaths.add(exception.path);
  }

  const unclassified = [...candidatePaths].filter(
    (relativePath) => !manifestedByPath.has(relativePath) && !exceptionPaths.has(relativePath)
  );
  if (unclassified.length > 0) {
    throw codeError("DATABASE_TEST_UNCLASSIFIED", { paths: unclassified.sort(comparePaths) });
  }
  return Object.freeze({
    candidateCount: candidates.length,
    manifested: Object.freeze([...manifestedByPath.keys()].sort(comparePaths)),
    excepted: Object.freeze([...exceptionPaths].sort(comparePaths)),
    unclassified: Object.freeze([])
  });
}
