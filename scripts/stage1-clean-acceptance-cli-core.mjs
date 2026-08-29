import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as pathDefault from "node:path";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function parseStage1CleanAcceptanceArgs(argv) {
  const parsed = parseArgv(argv, new Set([
    "--dry-run", "--apply", "--replay", "--discover-vehicles", "--output",
    "--vehicle-id", "--approved-manifest", "--approved-manifest-sha256"
  ]));
  const modes = ["dry-run", "apply", "replay"].filter((mode) => parsed.flags.has(`--${mode}`));
  if (modes.length !== 1) cliFail("CLI_MODE_REQUIRED");
  const mode = modes[0];
  const outputPath = singleValue(parsed, "--output", "EVIDENCE_OUTPUT_REQUIRED");
  const vehicleIds = parsed.values.get("--vehicle-id") ?? [];
  if (vehicleIds.some((value) => !UUID.test(value.toLowerCase()))) cliFail("VEHICLE_ID_INVALID");
  const normalizedVehicleIds = [...new Set(vehicleIds.map((value) => value.toLowerCase()))].sort();
  const discoverVehicles = parsed.flags.has("--discover-vehicles");
  if (discoverVehicles && (mode !== "dry-run" || normalizedVehicleIds.length > 0)) {
    cliFail("VEHICLE_SELECTION_REQUIRED");
  }
  if (!discoverVehicles && normalizedVehicleIds.length === 0) cliFail("VEHICLE_SELECTION_REQUIRED");

  const approvedManifestPath = optionalSingleValue(parsed, "--approved-manifest");
  const approvedManifestSha256 = optionalSingleValue(parsed, "--approved-manifest-sha256");
  if (mode === "dry-run") {
    if (approvedManifestPath !== undefined || approvedManifestSha256 !== undefined) cliFail("CLI_ARGUMENT_INVALID");
  } else if (!approvedManifestPath || !SHA256.test(approvedManifestSha256 ?? "")) {
    cliFail("APPROVED_MANIFEST_REQUIRED");
  }
  return { approvedManifestPath, approvedManifestSha256, discoverVehicles, mode, outputPath, vehicleIds: normalizedVehicleIds };
}

export function parseStage1CleanAcceptanceTargetValidatorArgs(argv) {
  const parsed = parseArgv(argv, new Set(["--output", "--approved-manifest", "--approved-manifest-sha256"]));
  const outputPath = singleValue(parsed, "--output", "EVIDENCE_OUTPUT_REQUIRED");
  const approvedManifestPath = singleValue(parsed, "--approved-manifest", "APPROVED_MANIFEST_REQUIRED");
  const approvedManifestSha256 = singleValue(parsed, "--approved-manifest-sha256", "APPROVED_MANIFEST_REQUIRED");
  if (!SHA256.test(approvedManifestSha256)) cliFail("APPROVED_MANIFEST_REQUIRED");
  return { approvedManifestPath, approvedManifestSha256, outputPath };
}

export function assertControlledEvidencePath(outputPath, repoRoot, options = {}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) cliFail("EVIDENCE_OUTPUT_REQUIRED");
  const intent = options.intent ?? "create";
  if (!new Set(["create", "read"]).has(intent)) cliFail("EVIDENCE_INTENT_INVALID");
  const pathApi = options.pathApi ?? pathDefault;
  const fsSync = options.fsSync ?? { existsSync, lstatSync, realpathSync };
  const platform = options.platform ?? process.platform;
  const resolvedOutput = pathApi.resolve(outputPath);
  const resolvedRepo = pathApi.resolve(repoRoot);
  if (isWithin(resolvedOutput, resolvedRepo, pathApi, platform)) cliFail("EVIDENCE_PATH_INSIDE_REPOSITORY");
  const resolvedParent = pathApi.resolve(pathApi.dirname(resolvedOutput));
  if (!fsSync.existsSync(resolvedParent)) cliFail("EVIDENCE_PARENT_INVALID");
  const parentStat = fsSync.lstatSync(resolvedParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) cliFail("EVIDENCE_PARENT_INVALID");
  const actualParent = pathApi.resolve(fsSync.realpathSync(resolvedParent));
  if (!sameCanonicalSpelling(actualParent, resolvedParent, pathApi)) cliFail("EVIDENCE_PARENT_INVALID");
  if (isWithin(actualParent, resolvedRepo, pathApi, platform)) cliFail("EVIDENCE_PATH_INSIDE_REPOSITORY");
  assertControlledDirectory(actualParent, parentStat, platform, options.verifyWindowsAcl, pathApi);

  const canonicalOutput = pathApi.join(actualParent, pathApi.basename(resolvedOutput));
  const targetExists = fsSync.existsSync(canonicalOutput);
  if (intent === "create" && targetExists) cliFail("EVIDENCE_TARGET_EXISTS");
  if (intent === "read") {
    if (!targetExists) cliFail("EVIDENCE_TARGET_INVALID");
    const target = fsSync.lstatSync(canonicalOutput);
    if (target.isDirectory() || target.isSymbolicLink() || !target.isFile()) cliFail("EVIDENCE_TARGET_INVALID");
    const actualTarget = pathApi.resolve(fsSync.realpathSync(canonicalOutput));
    if (!sameCanonicalSpelling(actualTarget, canonicalOutput, pathApi)) cliFail("EVIDENCE_TARGET_INVALID");
  }
  return canonicalOutput;
}

export async function writeControlledJsonFile(outputPath, value, fsApi = fsPromises, security = {}) {
  if (!security.repoRoot) cliFail("EVIDENCE_SECURITY_CONTEXT_REQUIRED");
  const canonicalOutput = assertControlledEvidencePath(outputPath, security.repoRoot, {
    ...security,
    intent: "create"
  });
  const tempPath = resolve(dirname(canonicalOutput), `.${basename(canonicalOutput)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsApi.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, jsonReplacer, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertControlledEvidencePath(canonicalOutput, security.repoRoot, {
      ...security,
      intent: "create"
    });
    if (typeof fsApi.link !== "function") cliFail("EVIDENCE_NO_REPLACE_UNSUPPORTED");
    await fsApi.link(tempPath, canonicalOutput);
    await fsApi.unlink(tempPath);
  } catch (cause) {
    try { await handle?.close(); } catch {}
    try { await fsApi.unlink(tempPath); } catch {}
    const error = new Error("EVIDENCE_WRITE_FAILED", { cause });
    error.code = "EVIDENCE_WRITE_FAILED";
    throw error;
  }
}

export function buildPublicStage1AcceptanceSummary(result = {}) {
  return Object.fromEntries([
    "candidateCount", "candidateDigest", "errorCode", "manifestSha256", "mode", "reportPath", "safe"
  ].filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
}

export async function createStage1AcceptancePrismaClient(databaseUrl, _label, options = {}) {
  const requireFromApi = createRequire(resolve(options.repoRoot, "apps/api/package.json"));
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  return new PrismaClient({ adapter: new PrismaPg(databaseUrl) });
}

export function readApprovedStage1AcceptanceManifest(text, approvedSha256, hashManifest) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    cliFail("APPROVED_MANIFEST_INVALID");
  }
  const wrapped = Object.hasOwn(report ?? {}, "manifest");
  if (wrapped && !validApprovedWrapperShape(report, approvedSha256)) cliFail("APPROVED_MANIFEST_INVALID");
  const manifest = wrapped ? report.manifest : report;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) cliFail("APPROVED_MANIFEST_INVALID");
  if (hashManifest(manifest) !== approvedSha256) cliFail("APPROVED_MANIFEST_SHA_MISMATCH");
  if (!validApprovedManifestShape(manifest)) cliFail("APPROVED_MANIFEST_INVALID");
  return manifest;
}

export function publicStage1AcceptanceError(error) {
  const code = typeof error?.code === "string"
    ? error.code
    : /^[A-Z0-9_]+$/.test(error?.message ?? "")
      ? error.message
      : "STAGE1_ACCEPTANCE_ERROR";
  const result = { code };
  if (typeof error?.domain === "string") result.domain = error.domain;
  if (SHA256.test(error?.subjectDigest ?? "")) result.subjectDigest = error.subjectDigest;
  return result;
}

export function isMainModule(importMetaUrl, argvPath) {
  return Boolean(argvPath) && importMetaUrl === pathToFileURL(resolve(argvPath)).href;
}

export function cliFail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseArgv(argv, allowed) {
  if (!Array.isArray(argv)) cliFail("CLI_ARGUMENT_INVALID");
  const flags = new Set();
  const values = new Map();
  const booleanFlags = new Set(["--dry-run", "--apply", "--replay", "--discover-vehicles"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) cliFail("CLI_ARGUMENT_UNKNOWN");
    if (booleanFlags.has(argument)) {
      if (flags.has(argument)) cliFail("CLI_ARGUMENT_INVALID");
      flags.add(argument);
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) cliFail("CLI_ARGUMENT_INVALID");
    index += 1;
    const existing = values.get(argument) ?? [];
    if (argument !== "--vehicle-id" && existing.length > 0) cliFail("CLI_ARGUMENT_INVALID");
    existing.push(value);
    values.set(argument, existing);
  }
  return { flags, values };
}

function singleValue(parsed, name, missingCode) {
  const value = optionalSingleValue(parsed, name);
  if (!value) cliFail(missingCode);
  return value;
}

function optionalSingleValue(parsed, name) {
  return parsed.values.get(name)?.[0];
}

function isWithin(candidate, root, pathApi, platform) {
  const normalizedCandidate = normalizePath(candidate, platform);
  const normalizedRoot = normalizePath(root, platform);
  const pathFromRoot = pathApi.relative(normalizedRoot, normalizedCandidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !pathApi.isAbsolute(pathFromRoot));
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function validApprovedManifestShape(manifest) {
  const domains = ["access", "catalog", "customer", "templates", "vehicle"];
  const topLevelKeys = [
    "counts", "exceptions", "generatedAt", "gitSha", "hashSalt", "imageRef", "operation",
    "rowDigests", "safeToApply", "schemaVersion", "selection", "source", "target"
  ];
  const exactDomains = (value, predicate) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === domains.join("|") &&
    domains.every((domain) => predicate(value[domain]));
  const digestContext = (value) =>
    value &&
    Object.keys(value).sort().join("|") === "databaseDigest|migrationCatalogDigest|schemaDigest" &&
    Object.values(value).every((digestValue) => SHA256.test(digestValue));
  const generatedAt = manifest.generatedAt;
  const vehicleDigests = manifest.selection?.vehicleDigests;
  return (
    exactKeys(manifest, topLevelKeys) &&
    manifest.schemaVersion === 1 &&
    manifest.operation === "STAGE1_CLEAN_ACCEPTANCE_BASELINE" &&
    /^[0-9a-f]{40}$/.test(manifest.gitSha ?? "") &&
    /^.+@sha256:[0-9a-f]{64}$/.test(manifest.imageRef ?? "") &&
    typeof generatedAt === "string" &&
    Number.isFinite(Date.parse(generatedAt)) &&
    new Date(generatedAt).toISOString() === generatedAt &&
    SHA256.test(manifest.hashSalt ?? "") &&
    digestContext(manifest.source) &&
    digestContext(manifest.target) &&
    manifest.selection &&
    exactKeys(manifest.selection, ["adminDigest", "customerDigest", "vehicleDigests"]) &&
    SHA256.test(manifest.selection.adminDigest ?? "") &&
    SHA256.test(manifest.selection.customerDigest ?? "") &&
    Array.isArray(vehicleDigests) &&
    vehicleDigests.length > 0 &&
    vehicleDigests.every((value) => SHA256.test(value)) &&
    new Set(vehicleDigests).size === vehicleDigests.length &&
    vehicleDigests.every((value, index) => index === 0 || vehicleDigests[index - 1] < value) &&
    exactDomains(manifest.counts, (value) => Number.isSafeInteger(value) && value >= 0) &&
    exactDomains(manifest.rowDigests, (value) => SHA256.test(value)) &&
    Array.isArray(manifest.exceptions) &&
    manifest.exceptions.length === 0 &&
    manifest.safeToApply === true
  );
}

function validApprovedWrapperShape(report, approvedSha256) {
  return (
    exactKeys(report, ["manifest", "manifestSha256", "mode", "operation", "safe"]) &&
    report.manifestSha256 === approvedSha256 &&
    report.mode === "dry-run" &&
    report.operation === "STAGE1_CLEAN_ACCEPTANCE_BASELINE" &&
    report.safe === true
  );
}

function exactKeys(value, expected) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function assertControlledDirectory(parent, stat, platform, verifyWindowsAcl, pathApi) {
  if (platform === "win32") {
    const proof = typeof verifyWindowsAcl === "function" ? verifyWindowsAcl(parent, stat) : undefined;
    if (!proof || proof.safe !== true || typeof proof.canonicalPath !== "string") {
      cliFail("EVIDENCE_DIRECTORY_NOT_CONTROLLED");
    }
    if (!sameCanonicalSpelling(pathApi.resolve(proof.canonicalPath), parent, pathApi)) {
      cliFail("EVIDENCE_PARENT_INVALID");
    }
    return;
  }
  if (stat.uid !== 0 || (stat.mode & 0o777) !== 0o700) cliFail("EVIDENCE_DIRECTORY_NOT_CONTROLLED");
}

function sameCanonicalSpelling(left, right, pathApi) {
  return pathApi.normalize(left) === pathApi.normalize(right);
}

function normalizePath(value, platform) {
  const normalized = String(value).replaceAll("/", platform === "win32" ? "\\" : "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
