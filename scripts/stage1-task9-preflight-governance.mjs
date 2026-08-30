import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { hashStage1CleanAcceptanceManifest } from "./stage1-clean-acceptance-baseline-core.mjs";
import { STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES } from "./stage1-clean-acceptance-baseline-snapshot.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  const evidence = report?.targetCountEvidence;
  const forbidden = evidence?.forbiddenCounts;
  const expected = [...STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES].sort();
  const actual = forbidden && typeof forbidden === "object" ? Object.keys(forbidden).sort() : [];
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    return { code: "FORBIDDEN_COUNTS_INVALID" };
  if (
    !actual.every(
      (key) => Number.isSafeInteger(forbidden[key]) && forbidden[key] >= 0 && forbidden[key] === 0
    )
  )
    return { code: "FORBIDDEN_COUNTS_INVALID" };
  const manifest = report?.manifest;
  const manifestSha256 = report?.manifestSha256;
  if (
    report?.safe !== true ||
    manifest?.safeToApply !== true ||
    !Array.isArray(manifest?.exceptions) ||
    manifest.exceptions.length !== 0
  )
    return { code: "DRY_RUN_UNSAFE" };
  if (
    !/^[0-9a-f]{64}$/.test(manifestSha256 ?? "") ||
    hashStage1CleanAcceptanceManifest(manifest) !== manifestSha256
  )
    return { code: "MANIFEST_SHA_INVALID" };
  return {
    safe: true,
    safeToApply: true,
    exceptionsCount: 0,
    forbiddenCounts: forbidden,
    manifestSha256
  };
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
  const [command, reportPath, vehicleId] = process.argv.slice(2);
  try {
    if (command === "validate-selection") {
      const result = validateTask9DiscoverySelection(
        JSON.parse(await readFile(reportPath, "utf8")),
        vehicleId
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
