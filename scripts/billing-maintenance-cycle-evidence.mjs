import { dirname, resolve } from "node:path";
import { writeSync } from "node:fs";
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
    clearTimer: clearTimeout,
    disconnectTimeoutMilliseconds: 1_000,
    setTimer: setTimeout,
    writeStderr: (value) => writeSync(2, value),
    writeStdout: (value) => writeSync(1, value),
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
    prisma = await deps.createPrismaClient(
      normalizeLocalhostDatabaseUrl(deps.databaseUrl, options.timeoutSeconds)
    );
    const evidence = await pollBillingMaintenanceCycleEvidence({
      ...options,
      clearTimer: deps.clearTimer,
      notBefore: options.notBeforeUtc,
      queryFacts: (runId, queryTimeoutMilliseconds) =>
        queryBillingMaintenanceCycleFacts(prisma, runId, queryTimeoutMilliseconds),
      setTimer: deps.setTimer
    });
    deps.writeStdout(`${canonicalBillingMaintenanceEvidenceJson(evidence)}\n`);
    return 0;
  } catch (error) {
    const code = publicErrorCode(error, "BILLING_MAINTENANCE_DATABASE_QUERY_FAILED");
    emitError(deps, code);
    return error instanceof BillingMaintenanceCycleEvidenceError ? 3 : 4;
  } finally {
    await disconnectWithin(
      prisma,
      deps.disconnectTimeoutMilliseconds,
      deps.setTimer,
      deps.clearTimer
    );
  }
}

export function parseBillingMaintenanceCycleEvidenceArguments(argv) {
  return validateBillingMaintenanceCycleEvidenceOptions(parseArguments(argv));
}

export async function queryBillingMaintenanceCycleFacts(
  prisma,
  evidenceRunId,
  queryTimeoutMilliseconds
) {
  if (
    !Number.isSafeInteger(queryTimeoutMilliseconds) ||
    queryTimeoutMilliseconds < 1 ||
    queryTimeoutMilliseconds > 30_000
  ) {
    throw new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_OPTIONS_INVALID");
  }
  const statementTimeoutMilliseconds = Math.max(1, queryTimeoutMilliseconds - 50);
  try {
    return await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe(
          "SELECT set_config('statement_timeout', $1, true)",
          String(statementTimeoutMilliseconds)
        );
        return transaction.billingMaintenanceCycleFact.findMany({
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
      },
      {
        maxWait: Math.min(1_000, queryTimeoutMilliseconds),
        timeout: queryTimeoutMilliseconds
      }
    );
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      throw new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_EVIDENCE_TIMEOUT");
    }
    throw error;
  }
}

function isDatabaseTimeoutError(error) {
  const seen = new Set();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || (typeof current !== "object" && typeof current !== "function")) continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const code = typeof current.code === "string" ? current.code : "";
    const message = typeof current.message === "string" ? current.message : "";
    if (code === "57014") return true;
    if (code === "P2028" && /(?:expired|time(?:d|)\s*out|timeout)/iu.test(message)) return true;
    if (/canceling statement due to statement timeout/iu.test(message)) return true;

    if (current.cause) pending.push(current.cause);
    if (current.meta) pending.push(current.meta);
  }
  return false;
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

function normalizeLocalhostDatabaseUrl(value, timeoutSeconds) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  url.searchParams.set("connect_timeout", String(Math.max(1, Math.min(10, timeoutSeconds - 1))));
  return url.toString();
}

async function disconnectWithin(prisma, timeoutMilliseconds, setTimer, clearTimer) {
  if (!prisma || typeof prisma.$disconnect !== "function") return;
  const boundedTimeout =
    Number.isSafeInteger(timeoutMilliseconds) &&
    timeoutMilliseconds >= 1 &&
    timeoutMilliseconds <= 5_000
      ? timeoutMilliseconds
      : 1_000;
  let timerHandle;
  const disconnected = Promise.resolve()
    .then(() => prisma.$disconnect())
    .catch(() => undefined);
  const timedOut = new Promise((resolve) => {
    timerHandle = setTimer(resolve, boundedTimeout);
  });
  await Promise.race([disconnected, timedOut]);
  try {
    clearTimer(timerHandle);
  } catch {}
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
  process.exit(await main());
}
