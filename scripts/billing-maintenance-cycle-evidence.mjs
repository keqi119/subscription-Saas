import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BillingMaintenanceCycleEvidenceError,
  canonicalBillingMaintenanceEvidenceJson,
  pollBillingMaintenanceCycleEvidence,
  validateBillingMaintenanceCycleEvidenceOptions
} from "./billing-maintenance-cycle-evidence-core.mjs";
import { createStage1AcceptancePrismaClient } from "./stage1-clean-acceptance-cli-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELP_TEXT =
  "Usage: billing-maintenance-cycle-evidence.mjs --run-id <sha256> --expected-release-sha <sha> --expected-image-digest <sha256:digest> --expected-database-identity-sha256 <sha256> --not-before <UTC> --timeout-seconds <1..900>\n";

export async function main(argv = process.argv.slice(2), injected = {}) {
  const deps = {
    createPrismaClient: (databaseUrl) =>
      createStage1AcceptancePrismaClient(databaseUrl, "billing-maintenance-evidence", {
        repoRoot
      }),
    databaseUrl: process.env.DATABASE_URL,
    writeStderr: (value) => process.stderr.write(value),
    writeStdout: (value) => process.stdout.write(value),
    ...injected
  };
  if (argv.length === 1 && argv[0] === "--help") {
    deps.writeStdout(HELP_TEXT);
    return 0;
  }

  let options;
  try {
    options = validateBillingMaintenanceCycleEvidenceOptions(parseArguments(argv));
    if (typeof deps.databaseUrl !== "string" || deps.databaseUrl.length === 0) {
      throw new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_DATABASE_URL_REQUIRED");
    }
  } catch (error) {
    emitError(deps, publicErrorCode(error, "BILLING_MAINTENANCE_OPTIONS_INVALID"));
    return 2;
  }

  let prisma;
  try {
    prisma = await deps.createPrismaClient(normalizeLocalhostDatabaseUrl(deps.databaseUrl));
    const evidence = await pollBillingMaintenanceCycleEvidence({
      ...options,
      notBefore: options.notBeforeUtc,
      queryFacts: () => queryBillingMaintenanceCycleFacts(prisma, options.runId)
    });
    deps.writeStdout(`${canonicalBillingMaintenanceEvidenceJson(evidence)}\n`);
    return 0;
  } catch (error) {
    const code = publicErrorCode(error, "BILLING_MAINTENANCE_DATABASE_QUERY_FAILED");
    emitError(deps, code);
    return error instanceof BillingMaintenanceCycleEvidenceError ? 3 : 4;
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

export function parseBillingMaintenanceCycleEvidenceArguments(argv) {
  return validateBillingMaintenanceCycleEvidenceOptions(parseArguments(argv));
}

export function queryBillingMaintenanceCycleFacts(prisma, evidenceRunId) {
  return prisma.billingMaintenanceCycleFact.findMany({
    orderBy: { sequence: "asc" },
    select: {
      afterCounts: true,
      afterCountsSha256: true,
      beforeCounts: true,
      beforeCountsSha256: true,
      blockedCount: true,
      completedAt: true,
      cycleStartedAt: true,
      databaseIdentitySha256: true,
      enqueueCompletedAt: true,
      enqueueSummary: true,
      evidenceRunId: true,
      forbiddenDomainSetSha256: true,
      forbiddenDomainSetVersion: true,
      id: true,
      imageDigest: true,
      reconciliationCompletedAt: true,
      reconciliationSummary: true,
      releaseSha: true,
      sequence: true,
      status: true
    },
    where: { evidenceRunId }
  });
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) argumentFailure();
  const optionNames = new Map([
    ["--run-id", "runId"],
    ["--expected-release-sha", "expectedReleaseSha"],
    ["--expected-image-digest", "expectedImageDigest"],
    ["--expected-database-identity-sha256", "expectedDatabaseIdentitySha256"],
    ["--not-before", "notBefore"],
    ["--timeout-seconds", "timeoutSeconds"]
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    const key = optionNames.get(name);
    if (!key || typeof value !== "string" || value.length === 0 || Object.hasOwn(parsed, key)) {
      argumentFailure();
    }
    parsed[key] = key === "timeoutSeconds" ? parseTimeout(value) : value;
  }
  if (Object.keys(parsed).length !== optionNames.size) argumentFailure();
  return parsed;
}

function parseTimeout(value) {
  if (!/^[1-9][0-9]{0,2}$/.test(value)) argumentFailure();
  const timeout = Number(value);
  if (timeout > 900) argumentFailure();
  return timeout;
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function emitError(deps, code) {
  deps.writeStderr(`${JSON.stringify({ error: { code } })}\n`);
}

function publicErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^BILLING_MAINTENANCE_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : fallback;
}

function argumentFailure() {
  throw new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_OPTIONS_INVALID");
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  process.exitCode = await main();
}
