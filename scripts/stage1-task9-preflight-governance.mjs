import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { hashStage1CleanAcceptanceManifest } from "./stage1-clean-acceptance-baseline-core.mjs";
import { validateApprovedStage1AcceptanceWrapper } from "./stage1-clean-acceptance-cli-core.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const IEC_SIZE = /^(0|[1-9][0-9]*(?:\.[0-9]+)?)(B|KiB|MiB|GiB)$/;

export const TASK9_MIN_HOST_DISK_AVAILABLE_KB = 10 * 1024 * 1024;
export const TASK9_EXPECTED_API_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
export const TASK9_MIN_API_MEMORY_HEADROOM_BYTES = 128 * 1024 * 1024;
export const TASK9_EXPECTED_POSTGRES_MAX_CONNECTIONS = 30;
export const TASK9_MIN_POSTGRES_CONNECTION_HEADROOM = 10;

export function validateTask9DatabasePair(sourceText, targetText, hostname, owner, targetDb) {
  try {
    const source = new URL(sourceText);
    const target = new URL(targetText);
    if (source.pathname !== "/subscription_saas_staging")
      return { code: "SOURCE_DATABASE_INVALID" };
    if (target.hostname !== hostname || source.hostname !== hostname)
      return { code: "DATABASE_HOST_INVALID" };
    if (source.username !== owner || target.username !== owner)
      return { code: "DATABASE_OWNER_INVALID" };
    for (const key of ["protocol", "host", "port", "username", "password", "search", "hash"]) {
      if (source[key] !== target[key]) return { code: "DATABASE_URL_SEMANTICS_INVALID" };
    }
    if (target.pathname !== `/${targetDb}`) return { code: "TARGET_DATABASE_INVALID" };
    return { code: "OK" };
  } catch {
    return { code: "DATABASE_URL_INVALID" };
  }
}

export function validateTask9DiscoverySelection(report, vehicleId) {
  if (!UUID.test(vehicleId ?? "")) return { code: "VEHICLE_UUID_INVALID" };
  const matches = Array.isArray(report?.candidates)
    ? report.candidates.filter((candidate) => candidate?.id === vehicleId).length
    : 0;
  return matches === 1 ? { code: "OK" } : { code: "VEHICLE_SELECTION_INVALID" };
}

export function buildTask9ApprovalSummary(report) {
  try {
    const validated = validateApprovedStage1AcceptanceWrapper(
      report,
      report?.manifestSha256,
      hashStage1CleanAcceptanceManifest
    );
    return {
      safe: validated.safe,
      safeToApply: validated.manifest.safeToApply,
      exceptionsCount: validated.manifest.exceptions.length,
      forbiddenCounts: validated.targetCountEvidence.forbiddenCounts,
      manifestSha256: validated.manifestSha256
    };
  } catch (error) {
    return { code: error?.code ?? "APPROVED_MANIFEST_INVALID" };
  }
}

export function validateTask9DiskAvailableKb(value) {
  const availableKb = parseSafeInteger(value);
  if (availableKb === null) return { code: "DISK_STATE_INVALID" };
  if (availableKb < TASK9_MIN_HOST_DISK_AVAILABLE_KB) return { code: "DISK_HEADROOM_LOW" };
  return { availableKb, code: "OK" };
}

export function validateTask9ApiMemoryState(value) {
  const match = /^([^ ]+) \/ ([^ ]+)$/.exec(value ?? "");
  if (!match) return { code: "API_MEMORY_STATE_INVALID" };
  const usageBytes = parseIecBytes(match[1]);
  const limitBytes = parseIecBytes(match[2]);
  if (usageBytes === null || limitBytes === null || usageBytes > limitBytes)
    return { code: "API_MEMORY_STATE_INVALID" };
  if (limitBytes !== TASK9_EXPECTED_API_MEMORY_LIMIT_BYTES)
    return { code: "API_MEMORY_LIMIT_INVALID" };
  const headroomBytes = limitBytes - usageBytes;
  if (headroomBytes < TASK9_MIN_API_MEMORY_HEADROOM_BYTES)
    return { code: "API_MEMORY_HEADROOM_LOW" };
  return { code: "OK", headroomBytes, limitBytes, usageBytes };
}

export function validateTask9PostgresConnectionState(value) {
  const match = /^([^|]+)\|([^|]+)$/.exec(value ?? "");
  if (!match) return { code: "POSTGRES_CONNECTION_STATE_INVALID" };
  const activeConnections = parseSafeInteger(match[1]);
  const maxConnections = parseSafeInteger(match[2]);
  if (activeConnections === null || maxConnections === null || activeConnections > maxConnections)
    return { code: "POSTGRES_CONNECTION_STATE_INVALID" };
  if (maxConnections !== TASK9_EXPECTED_POSTGRES_MAX_CONNECTIONS)
    return { code: "POSTGRES_MAX_CONNECTIONS_INVALID" };
  const headroomConnections = maxConnections - activeConnections;
  if (headroomConnections < TASK9_MIN_POSTGRES_CONNECTION_HEADROOM)
    return { code: "POSTGRES_CONNECTION_HEADROOM_LOW" };
  return { activeConnections, code: "OK", headroomConnections, maxConnections };
}

const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));

async function databaseServerIdentity(databaseUrl, expectedDatabase) {
  const { PrismaClient } = apiRequire("@prisma/client");
  const { PrismaPg } = apiRequire("@prisma/adapter-pg");
  const adapter = new PrismaPg({
    connectionString: databaseUrl
  });
  const prisma = new PrismaClient({ adapter });
  try {
    const [row] = await prisma.$queryRawUnsafe(
      "SELECT (pg_control_system()).system_identifier::text AS system_identifier, current_user AS role_name, current_database() AS database_name"
    );
    if (
      row?.database_name !== expectedDatabase ||
      row?.role_name !== process.env.STAGE1_ACCEPTANCE_DATABASE_OWNER
    )
      process.exitCode = 1;
    else
      process.stdout.write(
        `${createHash("sha256").update(String(row.system_identifier)).digest("hex")}\n`
      );
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const [command, reportPath, resourceThreshold] = process.argv.slice(2);
  try {
    if (command === "validate-selection") {
      const result = validateTask9DiscoverySelection(
        JSON.parse(await readFile(reportPath, "utf8")),
        process.env.APPROVED_VEHICLE_UUID
      );
      if (result.code !== "OK") process.exitCode = 1;
      return;
    }
    if (command === "validate-pair") {
      const result = validateTask9DatabasePair(
        process.env.STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL,
        process.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL,
        process.env.STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME,
        process.env.STAGE1_ACCEPTANCE_DATABASE_OWNER,
        process.env.TARGET_DB
      );
      if (result.code !== "OK") process.exitCode = 1;
      return;
    }
    if (command === "approval-summary") {
      const result = buildTask9ApprovalSummary(JSON.parse(await readFile(reportPath, "utf8")));
      if (result.code) process.exitCode = 1;
      else process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "resource-disk") {
      if (reportPath !== String(TASK9_MIN_HOST_DISK_AVAILABLE_KB)) {
        process.exitCode = 1;
        return;
      }
      writeResourceSummary(validateTask9DiskAvailableKb(process.env.TASK9_DISK_AVAILABLE_KB));
      return;
    }
    if (command === "resource-memory") {
      if (
        reportPath !== String(TASK9_EXPECTED_API_MEMORY_LIMIT_BYTES) ||
        resourceThreshold !== String(TASK9_MIN_API_MEMORY_HEADROOM_BYTES)
      ) {
        process.exitCode = 1;
        return;
      }
      writeResourceSummary(validateTask9ApiMemoryState(process.env.TASK9_API_MEMORY_STATE));
      return;
    }
    if (command === "resource-postgres-connections") {
      if (
        reportPath !== String(TASK9_EXPECTED_POSTGRES_MAX_CONNECTIONS) ||
        resourceThreshold !== String(TASK9_MIN_POSTGRES_CONNECTION_HEADROOM)
      ) {
        process.exitCode = 1;
        return;
      }
      writeResourceSummary(
        validateTask9PostgresConnectionState(process.env.TASK9_POSTGRES_CONNECTION_STATE)
      );
      return;
    }
    if (command === "source-server-identity") {
      await databaseServerIdentity(
        process.env.STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL,
        "subscription_saas_staging"
      );
      return;
    }
    if (command === "target-server-identity") {
      await databaseServerIdentity(
        process.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL,
        process.env.TARGET_DB
      );
      return;
    }
    process.exitCode = 2;
  } catch {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).pathname
)
  main();

function parseSafeInteger(value) {
  if (!DECIMAL_INTEGER.test(value ?? "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseIecBytes(value) {
  const match = IEC_SIZE.exec(value ?? "");
  if (!match) return null;
  const multipliers = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  const parsed = Number(match[1]) * multipliers[match[2]];
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function writeResourceSummary(result) {
  if (result.code !== "OK") {
    process.exitCode = 1;
    return;
  }
  const { code: _code, ...safeCounts } = result;
  process.stdout.write(`${JSON.stringify({ ...safeCounts, state: "ok" })}\n`);
}
