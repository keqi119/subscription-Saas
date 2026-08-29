import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertStage1AcceptanceDatabasePair,
  hashStage1CleanAcceptanceManifest
} from "./stage1-clean-acceptance-baseline-core.mjs";
import { validateStage1CleanAcceptanceTargetBaseline } from "./stage1-clean-acceptance-baseline-executor.mjs";
import {
  assertControlledEvidencePath,
  buildPublicStage1AcceptanceSummary,
  createStage1AcceptancePrismaClient,
  isMainModule,
  parseStage1CleanAcceptanceTargetValidatorArgs,
  publicStage1AcceptanceError,
  readApprovedStage1AcceptanceManifest,
  writeControlledJsonFile
} from "./stage1-clean-acceptance-cli-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function main(argv = process.argv.slice(2), injected = {}) {
  const deps = dependencies(injected);
  let targetPrisma;
  let removeSignalHandler = () => {};
  let interrupted = false;
  try {
    let args;
    let reportPath;
    let approvedManifest;
    try {
      args = parseStage1CleanAcceptanceTargetValidatorArgs(argv);
      reportPath = deps.assertEvidencePath(args.outputPath, deps.repoRoot);
      const approvedPath = deps.assertEvidencePath(args.approvedManifestPath, deps.repoRoot);
      if (!deps.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL || !deps.env.STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME) {
        throw Object.assign(new Error("DEDICATED_DATABASE_URL_REQUIRED"), { code: "DEDICATED_DATABASE_URL_REQUIRED" });
      }
      approvedManifest = readApprovedStage1AcceptanceManifest(
        await deps.readTextFile(approvedPath, "utf8"),
        args.approvedManifestSha256,
        deps.hashManifest
      );
      deps.assertTargetDatabase(deps.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL, deps.env.STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME);
    } catch (error) {
      emitError(deps, error);
      return 2;
    }

    try {
      targetPrisma = await deps.createPrismaClient(deps.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL, "target", { repoRoot: deps.repoRoot });
      removeSignalHandler = deps.installSignalHandler(() => { interrupted = true; });
      const result = await targetPrisma.$transaction(async (tx) => {
        await tx.$queryRaw`SET TRANSACTION READ ONLY`;
        return deps.validateTarget(tx, {
          approvedManifest,
          approvedManifestSha256: args.approvedManifestSha256
        });
      }, { isolationLevel: "RepeatableRead" });
      if (interrupted) throw Object.assign(new Error("STAGE1_ACCEPTANCE_INTERRUPTED"), { code: "STAGE1_ACCEPTANCE_INTERRUPTED" });
      const report = {
        approvedManifest,
        approvedManifestSha256: args.approvedManifestSha256,
        operation: "STAGE1_CLEAN_ACCEPTANCE_TARGET_VALIDATOR",
        result
      };
      try {
        await deps.writeJsonFile(reportPath, report);
      } catch (error) {
        emitError(deps, Object.assign(new Error("EVIDENCE_WRITE_FAILED"), { code: "EVIDENCE_WRITE_FAILED", cause: error }));
        return 5;
      }
      emitSummary(deps, { manifestSha256: result.manifestSha256, mode: "target-validator", reportPath, safe: result.safe === true });
      return result.safe === true ? 0 : 3;
    } catch (error) {
      emitError(deps, error);
      return isInvariantError(error) ? 3 : 4;
    }
  } finally {
    removeSignalHandler();
    await Promise.allSettled([targetPrisma?.$disconnect()].filter(Boolean));
  }
}

function dependencies(injected) {
  return {
    assertEvidencePath: assertControlledEvidencePath,
    assertTargetDatabase,
    createPrismaClient: createStage1AcceptancePrismaClient,
    env: process.env,
    hashManifest: hashStage1CleanAcceptanceManifest,
    installSignalHandler: (handler) => { process.once("SIGINT", handler); return () => process.off("SIGINT", handler); },
    readTextFile: readFile,
    repoRoot,
    validateTarget: validateStage1CleanAcceptanceTargetBaseline,
    writeJsonFile: writeControlledJsonFile,
    writeStderr: (value) => process.stderr.write(value),
    writeStdout: (value) => process.stdout.write(value),
    ...injected
  };
}

function assertTargetDatabase(targetUrl, allowedHostname) {
  const syntheticSource = new URL(targetUrl);
  syntheticSource.pathname = "/subscription_saas_staging";
  assertStage1AcceptanceDatabasePair(syntheticSource.toString(), targetUrl, { allowedHostname });
}

function isInvariantError(error) {
  return [
    "FORBIDDEN_DOMAIN_NOT_EMPTY", "MANIFEST_CLASSIFICATION_INVALID", "MANIFEST_STALE",
    "TARGET_NOT_EMPTY", "TARGET_SCHEMA_NOT_CANONICAL", "VEHICLE_NOT_ELIGIBLE",
    "WHITELIST_REFERENCE_NOT_CLOSED"
  ].includes(error?.code ?? error?.message);
}

function emitSummary(deps, value) {
  deps.writeStdout(`${JSON.stringify(buildPublicStage1AcceptanceSummary(value))}\n`);
}

function emitError(deps, error) {
  deps.writeStderr(`${JSON.stringify({ error: publicStage1AcceptanceError(error) })}\n`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}
