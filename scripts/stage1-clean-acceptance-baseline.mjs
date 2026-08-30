import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertStage1AcceptanceDatabasePair,
  hashStage1CleanAcceptanceManifest
} from "./stage1-clean-acceptance-baseline-core.mjs";
import { executeStage1CleanAcceptanceBaseline } from "./stage1-clean-acceptance-baseline-executor.mjs";
import { discoverStage1CleanAcceptanceVehicleCandidates } from "./stage1-clean-acceptance-baseline-snapshot.mjs";
import {
  assertControlledEvidencePath,
  buildPublicStage1AcceptanceSummary,
  createStage1AcceptancePrismaClient,
  isMainModule,
  parseStage1CleanAcceptanceArgs,
  publicStage1AcceptanceError,
  readApprovedStage1AcceptanceManifest,
  writeControlledJsonFile
} from "./stage1-clean-acceptance-cli-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELP_TEXT =
  [
    "Usage: stage1-clean-acceptance-baseline.mjs --dry-run|--apply|--replay --output <controlled-evidence-file> [options]",
    "Arguments:",
    "--dry-run: generate a baseline manifest without applying it.",
    "--apply: apply an approved baseline manifest.",
    "--replay: replay an approved baseline manifest.",
    "--discover-vehicles: dry-run vehicle candidate discovery only.",
    "--output <value>: controlled evidence output.",
    "--vehicle-id <uuid>: repeatable selected vehicle identifier.",
    "--approved-manifest <value>: approved manifest input.",
    "--approved-manifest-sha256 <sha256>: approved manifest digest.",
    "Constraints:",
    "CLI_MODE_REQUIRED: exactly one mode is required.",
    "EVIDENCE_OUTPUT_REQUIRED: --output is required.",
    "VEHICLE_SELECTION_REQUIRED: select vehicles or use dry-run discovery.",
    "APPROVED_MANIFEST_REQUIRED: apply and replay require approved manifest evidence.",
    "BASELINE_APPLY_CONFIRMATION_REQUIRED: apply requires explicit confirmation."
  ].join("\n") + "\n";

export async function main(argv = process.argv.slice(2), injected = {}) {
  const deps = dependencies(injected);
  if (isHelpRequest(argv)) {
    deps.writeStdout(HELP_TEXT);
    return 0;
  }
  let args;
  let reportPath;
  let approvedPath;
  let sourcePrisma;
  let targetPrisma;
  let interrupted = false;
  let removeSignalHandler = () => {};
  try {
    try {
      args = parseStage1CleanAcceptanceArgs(argv);
      reportPath = deps.assertEvidencePath(args.outputPath, deps.repoRoot, {
        ...deps.evidenceSecurity,
        intent: "create"
      });
      requireEnvironment(deps.env, args.mode);
    } catch (error) {
      emitError(deps, error);
      return 2;
    }

    let approvedManifest;
    if (args.mode !== "dry-run") {
      try {
        approvedPath = deps.assertEvidencePath(args.approvedManifestPath, deps.repoRoot, {
          ...deps.evidenceSecurity,
          intent: "read"
        });
        if (sameCanonicalPath(reportPath, approvedPath, deps.platform)) {
          throw Object.assign(new Error("EVIDENCE_PATH_COLLISION"), {
            code: "EVIDENCE_PATH_COLLISION"
          });
        }
        approvedManifest = readApprovedStage1AcceptanceManifest(
          await deps.readTextFile(approvedPath, "utf8"),
          args.approvedManifestSha256,
          deps.hashManifest
        );
      } catch (error) {
        emitError(deps, error);
        return 2;
      }
    }

    try {
      deps.assertDatabasePair(
        deps.env.STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL,
        deps.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL,
        { allowedHostname: deps.env.STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME }
      );
      sourcePrisma = await deps.createPrismaClient(
        deps.env.STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL,
        "source",
        { repoRoot: deps.repoRoot }
      );
      targetPrisma = await deps.createPrismaClient(
        deps.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL,
        "target",
        { repoRoot: deps.repoRoot }
      );
      removeSignalHandler = deps.installSignalHandler(() => {
        interrupted = true;
      });

      if (args.discoverVehicles) {
        const generatedAt = deps.now().toISOString();
        const salt = deps.randomBytes(32).toString("hex");
        const candidates = await sourcePrisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SET TRANSACTION READ ONLY`;
            return deps.discoverCandidates(tx, { asOf: new Date(generatedAt) });
          },
          { isolationLevel: "RepeatableRead" }
        );
        if (interrupted) throw cliExecutionError("STAGE1_ACCEPTANCE_INTERRUPTED");
        const candidateDigest = digest(`${salt}:${JSON.stringify(candidates)}`);
        const report = {
          candidateCount: candidates.length,
          candidateDigest,
          candidates,
          error: { code: "VEHICLE_SELECTION_REQUIRED" },
          generatedAt,
          operation: "STAGE1_CLEAN_ACCEPTANCE_VEHICLE_DISCOVERY",
          safe: false
        };
        if (!(await writeReport(deps, reportPath, report))) return 5;
        emitSummary(deps, {
          candidateCount: candidates.length,
          candidateDigest,
          errorCode: "VEHICLE_SELECTION_REQUIRED",
          mode: "dry-run",
          reportPath,
          safe: false
        });
        return 3;
      }

      const generatedAt = approvedManifest?.generatedAt ?? deps.now().toISOString();
      const hashSalt = approvedManifest?.hashSalt ?? deps.randomBytes(32).toString("hex");
      const result = await deps.executeBaseline({
        approvedManifest,
        approvedManifestSha256: args.approvedManifestSha256,
        generatedAt,
        gitSha: deps.env.STAGE1_ACCEPTANCE_GIT_SHA,
        hashSalt,
        imageRef: deps.env.STAGE1_ACCEPTANCE_IMAGE_REF,
        mode: args.mode,
        selection: {
          adminUsername: "keqi_119",
          customerPhone: "18616570212",
          vehicleIds: args.vehicleIds
        },
        sourcePrisma,
        targetPrisma
      });
      if (interrupted) throw cliExecutionError("STAGE1_ACCEPTANCE_INTERRUPTED");
      const manifest = result.manifest ?? approvedManifest;
      const report = {
        manifest,
        manifestSha256: result.manifestSha256,
        mode: args.mode,
        operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
        safe: result.safe === true,
        ...(args.mode === "dry-run" ? { targetCountEvidence: result.targetCountEvidence } : {}),
        ...(args.mode === "dry-run" ? {} : writeCounts(result))
      };
      if (!(await writeReport(deps, reportPath, report))) return 5;
      emitSummary(deps, {
        errorCode:
          result.safe === true
            ? undefined
            : (result.manifest?.exceptions?.[0]?.code ?? "MANIFEST_CLASSIFICATION_INVALID"),
        manifestSha256: result.manifestSha256,
        mode: args.mode,
        reportPath,
        safe: result.safe === true,
        ...(args.mode === "dry-run" ? {} : writeCounts(result))
      });
      return result.safe === true ? 0 : 3;
    } catch (error) {
      emitError(deps, error);
      return isGateError(error) ? 3 : 4;
    }
  } finally {
    removeSignalHandler();
    await Promise.allSettled(
      [sourcePrisma?.$disconnect(), targetPrisma?.$disconnect()].filter(Boolean)
    );
  }
}

function isHelpRequest(argv) {
  return Array.isArray(argv) && argv.length === 1 && argv[0] === "--help";
}

function dependencies(injected) {
  const deps = {
    assertDatabasePair: assertStage1AcceptanceDatabasePair,
    assertEvidencePath: assertControlledEvidencePath,
    createPrismaClient: createStage1AcceptancePrismaClient,
    discoverCandidates: discoverStage1CleanAcceptanceVehicleCandidates,
    evidenceSecurity: {},
    env: process.env,
    executeBaseline: executeStage1CleanAcceptanceBaseline,
    hashManifest: hashStage1CleanAcceptanceManifest,
    installSignalHandler: (handler) => {
      process.once("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
    now: () => new Date(),
    platform: process.platform,
    randomBytes,
    readTextFile: readFile,
    repoRoot,
    writeStderr: (value) => process.stderr.write(value),
    writeStdout: (value) => process.stdout.write(value),
    ...injected
  };
  deps.writeJsonFile ??= (path, value) =>
    writeControlledJsonFile(path, value, undefined, {
      ...deps.evidenceSecurity,
      platform: deps.platform,
      repoRoot: deps.repoRoot
    });
  return deps;
}

function requireEnvironment(env, mode) {
  if (
    !env.STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL ||
    !env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL ||
    !env.STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME
  ) {
    throw Object.assign(new Error("DEDICATED_DATABASE_URL_REQUIRED"), {
      code: "DEDICATED_DATABASE_URL_REQUIRED"
    });
  }
  if (
    !/^[0-9a-f]{40}$/.test(env.STAGE1_ACCEPTANCE_GIT_SHA ?? "") ||
    !/^.+@sha256:[0-9a-f]{64}$/.test(env.STAGE1_ACCEPTANCE_IMAGE_REF ?? "")
  ) {
    throw Object.assign(new Error("MANIFEST_CONTEXT_INVALID"), {
      code: "MANIFEST_CONTEXT_INVALID"
    });
  }
  if (mode !== "dry-run" && env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY !== "1") {
    throw Object.assign(new Error("BASELINE_APPLY_CONFIRMATION_REQUIRED"), {
      code: "BASELINE_APPLY_CONFIRMATION_REQUIRED"
    });
  }
}

async function writeReport(deps, path, value) {
  try {
    await deps.writeJsonFile(path, value);
    return true;
  } catch (error) {
    emitError(
      deps,
      Object.assign(new Error("EVIDENCE_WRITE_FAILED"), {
        code: "EVIDENCE_WRITE_FAILED",
        cause: error
      })
    );
    return false;
  }
}

function emitSummary(deps, value) {
  deps.writeStdout(`${JSON.stringify(buildPublicStage1AcceptanceSummary(value))}\n`);
}

function emitError(deps, error) {
  deps.writeStderr(`${JSON.stringify({ error: publicStage1AcceptanceError(error) })}\n`);
}

function cliExecutionError(code) {
  return Object.assign(new Error(code), { code });
}

function isGateError(error) {
  return new Set([
    "ADMIN_AMBIGUOUS",
    "ADMIN_NOT_FOUND",
    "ADMIN_ROLE_INCOMPLETE",
    "CATALOG_ACTIVE_SET_EMPTY",
    "CATALOG_REFERENCE_NOT_CLOSED",
    "CONTRACT_TEMPLATE_AMBIGUOUS",
    "CONTRACT_TEMPLATE_FILE_INVALID",
    "CONTRACT_TEMPLATE_REQUIRED",
    "CUSTOMER_AMBIGUOUS",
    "CUSTOMER_ESIGN_BINDING_INVALID",
    "CUSTOMER_NOT_FOUND",
    "FORBIDDEN_DOMAIN_NOT_EMPTY",
    "MANIFEST_CLASSIFICATION_INVALID",
    "MANIFEST_STALE",
    "NOTIFICATION_TEMPLATE_REQUIRED",
    "TARGET_COUNT_EVIDENCE_INVALID",
    "TARGET_NOT_EMPTY",
    "TARGET_SCHEMA_NOT_CANONICAL",
    "VEHICLE_NOT_ELIGIBLE",
    "VEHICLE_REFERENCE_NOT_CLOSED",
    "VEHICLE_SELECTION_REQUIRED",
    "WHITELIST_REFERENCE_NOT_CLOSED"
  ]).has(error?.code ?? error?.message);
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function writeCounts(result) {
  const counts = Object.fromEntries(
    ["auditCreated", "deleted", "inserted", "updated"].map((key) => [key, result[key]])
  );
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw cliExecutionError("BASELINE_WRITE_COUNTS_INVALID");
  }
  return counts;
}

function sameCanonicalPath(left, right, platform) {
  const normalize = (value) =>
    platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
  return normalize(left) === normalize(right);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}
