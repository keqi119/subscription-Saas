import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const HEX_64 = /^[0-9a-f]{64}$/;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CYCLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORBIDDEN_VERSION = /^stage1-acceptance-forbidden-domains\/v[1-9][0-9]*$/;
const RECONCILIATION_KEYS = [
  "blockedCount",
  "blockerCodes",
  "createdCount",
  "dryRun",
  "eligibleCount",
  "existingCount",
  "leaseActivationCount"
];
const ENQUEUE_KEYS = ["dueCount", "enqueuedCount"];
const DATABASE_IDENTITY_VERSION = "billing-maintenance-database-identity/v1";

const forbiddenDefinition = loadForbiddenDefinition();

export const BILLING_MAINTENANCE_FORBIDDEN_DOMAINS = Object.freeze(
  forbiddenDefinition.domains.map((domain) => Object.freeze({ ...domain }))
);
export const BILLING_MAINTENANCE_FORBIDDEN_KEYS = Object.freeze(
  BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.map(({ delegate }) => delegate)
);
export const BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION = forbiddenDefinition.version;
export const BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256 = hashBillingMaintenanceEvidenceValue({
  domains: BILLING_MAINTENANCE_FORBIDDEN_DOMAINS,
  version: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION
});

export class BillingMaintenanceCycleEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "BillingMaintenanceCycleEvidenceError";
    this.code = code;
  }
}

export function canonicalBillingMaintenanceEvidenceJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashBillingMaintenanceEvidenceValue(value) {
  return createHash("sha256")
    .update(canonicalBillingMaintenanceEvidenceJson(value), "utf8")
    .digest("hex");
}

export function hashBillingMaintenanceEvidenceDatabaseIdentity(identity) {
  if (
    !isPlainObject(identity) ||
    typeof identity.databaseName !== "string" ||
    identity.databaseName.length === 0 ||
    typeof identity.systemIdentifier !== "string" ||
    !/^[0-9]+$/.test(identity.systemIdentifier)
  ) {
    fail("BILLING_MAINTENANCE_DATABASE_IDENTITY_INVALID");
  }
  return hashBillingMaintenanceEvidenceValue({
    databaseName: identity.databaseName,
    systemIdentifier: identity.systemIdentifier,
    version: DATABASE_IDENTITY_VERSION
  });
}

export function validateBillingMaintenanceCycleEvidenceOptions(options) {
  if (
    !isPlainObject(options) ||
    !HEX_64.test(options.runId ?? "") ||
    !RELEASE_SHA.test(options.expectedReleaseSha ?? "") ||
    !IMAGE_DIGEST.test(options.expectedImageDigest ?? "") ||
    !HEX_64.test(options.expectedDatabaseIdentitySha256 ?? "") ||
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 900
  ) {
    fail("BILLING_MAINTENANCE_OPTIONS_INVALID");
  }
  const notBeforeMillis = parseApprovedUtc(options.notBefore);
  if (notBeforeMillis === null) fail("BILLING_MAINTENANCE_OPTIONS_INVALID");
  return {
    expectedDatabaseIdentitySha256: options.expectedDatabaseIdentitySha256,
    expectedImageDigest: options.expectedImageDigest,
    expectedReleaseSha: options.expectedReleaseSha,
    notBeforeMillis,
    notBeforeUtc: options.notBefore,
    runId: options.runId,
    timeoutSeconds: options.timeoutSeconds
  };
}

export function buildBillingMaintenanceCycleEvidence(facts, options) {
  const expected = normalizedOptions(options);
  const normalizedFacts = validateFacts(facts, expected, true);
  return {
    cycles: normalizedFacts.map((fact) => ({
      afterCounts: fact.afterCounts,
      afterCountsSha256: fact.afterCountsSha256,
      beforeCounts: fact.beforeCounts,
      beforeCountsSha256: fact.beforeCountsSha256,
      blockedCount: fact.blockedCount,
      completedAtUtc: fact.completedAt.toISOString(),
      cycleId: fact.id,
      cycleStartedAtUtc: fact.cycleStartedAt.toISOString(),
      enqueueCompletedAtUtc: fact.enqueueCompletedAt.toISOString(),
      enqueueSummary: fact.enqueueSummary,
      reconciliationCompletedAtUtc: fact.reconciliationCompletedAt.toISOString(),
      reconciliationSummary: fact.reconciliationSummary,
      sequence: fact.sequence,
      status: fact.status
    })),
    operation: "BILLING_MAINTENANCE_CYCLE_EVIDENCE",
    safe: true,
    schemaVersion: 1,
    source: {
      databaseIdentitySha256: expected.expectedDatabaseIdentitySha256,
      evidenceRunId: expected.runId,
      forbiddenDomainSetSha256: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
      forbiddenDomainSetVersion: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
      imageDigest: expected.expectedImageDigest,
      notBeforeUtc: expected.notBeforeUtc,
      releaseSha: expected.expectedReleaseSha
    }
  };
}

export async function pollBillingMaintenanceCycleEvidence(options) {
  const expected = validateBillingMaintenanceCycleEvidenceOptions(options);
  if (typeof options.queryFacts !== "function") fail("BILLING_MAINTENANCE_OPTIONS_INVALID");
  const now = options.now ?? Date.now;
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (
    typeof now !== "function" ||
    typeof wait !== "function" ||
    typeof setTimer !== "function" ||
    typeof clearTimer !== "function" ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 60_000
  ) {
    fail("BILLING_MAINTENANCE_OPTIONS_INVALID");
  }
  const startedAt = readMonotonicTime(now);
  const deadline = startedAt + expected.timeoutSeconds * 1_000;

  while (true) {
    const beforeQuery = readMonotonicTime(now);
    if (beforeQuery >= deadline) fail("BILLING_MAINTENANCE_EVIDENCE_TIMEOUT");
    const remainingMilliseconds = deadline - beforeQuery;
    const databaseQueryTimeoutMilliseconds = Math.max(
      1,
      Math.min(30_000, remainingMilliseconds - 100)
    );
    const facts = await settleBeforeDeadline(
      () =>
        options.queryFacts(expected.runId, databaseQueryTimeoutMilliseconds, remainingMilliseconds),
      remainingMilliseconds,
      setTimer,
      clearTimer
    );
    const current = readMonotonicTime(now);
    if (current >= deadline) fail("BILLING_MAINTENANCE_EVIDENCE_TIMEOUT");
    const normalized = validateFacts(facts, expected, false);
    if (normalized.length === 2) {
      return buildBillingMaintenanceCycleEvidence(normalized, expected);
    }
    await wait(Math.min(pollIntervalMs, deadline - current));
  }
}

function settleBeforeDeadline(operation, remainingMilliseconds, setTimer, clearTimer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timerHandle;
    const timeout = () => {
      if (settled) return;
      settled = true;
      reject(new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_EVIDENCE_TIMEOUT"));
    };
    try {
      timerHandle = setTimer(timeout, remainingMilliseconds);
    } catch {
      fail("BILLING_MAINTENANCE_OPTIONS_INVALID");
    }
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          try {
            clearTimer(timerHandle);
          } catch {
            reject(new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_OPTIONS_INVALID"));
            return;
          }
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          try {
            clearTimer(timerHandle);
          } catch {
            reject(new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_OPTIONS_INVALID"));
            return;
          }
          reject(error);
        }
      );
  });
}

function validateFacts(facts, expected, requireComplete) {
  if (!Array.isArray(facts)) fail("BILLING_MAINTENANCE_FACT_INVALID");
  if (facts.length > 2) fail("BILLING_MAINTENANCE_SEQUENCE_INVALID");
  if (requireComplete && facts.length !== 2) fail("BILLING_MAINTENANCE_FACTS_INCOMPLETE");
  const sorted = [...facts].sort((left, right) => Number(left?.sequence) - Number(right?.sequence));
  const normalized = sorted.map((fact) => validateFact(fact, expected));
  const expectedSequences = normalized.length === 0 ? [] : normalized.length === 1 ? [1] : [1, 2];
  if (
    normalized.some((fact, index) => fact.sequence !== expectedSequences[index]) ||
    new Set(normalized.map(({ id }) => id)).size !== normalized.length
  ) {
    fail("BILLING_MAINTENANCE_SEQUENCE_INVALID");
  }
  if (
    normalized.length === 2 &&
    normalized[0].completedAt.getTime() > normalized[1].cycleStartedAt.getTime()
  ) {
    fail("BILLING_MAINTENANCE_TIME_INVALID");
  }
  return normalized;
}

function validateFact(fact, expected) {
  if (!isPlainObject(fact) || !CYCLE_ID.test(fact.id ?? "")) {
    fail("BILLING_MAINTENANCE_SEQUENCE_INVALID");
  }
  if (
    fact.status !== "COMPLETED" ||
    fact.evidenceRunId !== expected.runId ||
    fact.releaseSha !== expected.expectedReleaseSha ||
    fact.imageDigest !== expected.expectedImageDigest ||
    fact.databaseIdentitySha256 !== expected.expectedDatabaseIdentitySha256 ||
    fact.forbiddenDomainSetVersion !== BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION ||
    fact.forbiddenDomainSetSha256 !== BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256
  ) {
    fail("BILLING_MAINTENANCE_SOURCE_BINDING_MISMATCH");
  }
  const cycleStartedAt = databaseDate(fact.cycleStartedAt);
  const reconciliationCompletedAt = databaseDate(fact.reconciliationCompletedAt);
  const enqueueCompletedAt = databaseDate(fact.enqueueCompletedAt);
  const completedAt = databaseDate(fact.completedAt);
  if (
    !cycleStartedAt ||
    !reconciliationCompletedAt ||
    !enqueueCompletedAt ||
    !completedAt ||
    cycleStartedAt.getTime() < expected.notBeforeMillis ||
    cycleStartedAt.getTime() > reconciliationCompletedAt.getTime() ||
    reconciliationCompletedAt.getTime() > enqueueCompletedAt.getTime() ||
    enqueueCompletedAt.getTime() > completedAt.getTime()
  ) {
    fail("BILLING_MAINTENANCE_TIME_INVALID");
  }
  if (!nonnegativeInteger(fact.blockedCount)) fail("BILLING_MAINTENANCE_SUMMARY_INVALID");
  const reconciliationSummary = validateReconciliationSummary(
    fact.reconciliationSummary,
    fact.blockedCount
  );
  const enqueueSummary = validateEnqueueSummary(fact.enqueueSummary);
  if (fact.blockedCount !== 0) fail("BILLING_MAINTENANCE_BLOCKED");
  const beforeCounts = validateCounts(fact.beforeCounts);
  const afterCounts = validateCounts(fact.afterCounts);
  if (
    !HEX_64.test(fact.beforeCountsSha256 ?? "") ||
    !HEX_64.test(fact.afterCountsSha256 ?? "") ||
    hashBillingMaintenanceEvidenceValue(beforeCounts) !== fact.beforeCountsSha256 ||
    hashBillingMaintenanceEvidenceValue(afterCounts) !== fact.afterCountsSha256 ||
    canonicalBillingMaintenanceEvidenceJson(beforeCounts) !==
      canonicalBillingMaintenanceEvidenceJson(afterCounts)
  ) {
    fail("BILLING_MAINTENANCE_COUNTS_INVALID");
  }
  return {
    afterCounts,
    afterCountsSha256: fact.afterCountsSha256,
    beforeCounts,
    beforeCountsSha256: fact.beforeCountsSha256,
    blockedCount: fact.blockedCount,
    completedAt,
    cycleStartedAt,
    databaseIdentitySha256: fact.databaseIdentitySha256,
    enqueueCompletedAt,
    enqueueSummary,
    evidenceRunId: fact.evidenceRunId,
    forbiddenDomainSetSha256: fact.forbiddenDomainSetSha256,
    forbiddenDomainSetVersion: fact.forbiddenDomainSetVersion,
    id: fact.id,
    imageDigest: fact.imageDigest,
    reconciliationCompletedAt,
    reconciliationSummary,
    releaseSha: fact.releaseSha,
    sequence: fact.sequence,
    status: fact.status
  };
}

function validateCounts(value) {
  if (!isPlainObject(value)) fail("BILLING_MAINTENANCE_COUNTS_INVALID");
  const keys = Object.keys(value);
  if (
    keys.length !== BILLING_MAINTENANCE_FORBIDDEN_KEYS.length ||
    BILLING_MAINTENANCE_FORBIDDEN_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !BILLING_MAINTENANCE_FORBIDDEN_KEYS.includes(key))
  ) {
    fail("BILLING_MAINTENANCE_COUNTS_INVALID");
  }
  const normalized = {};
  for (const key of BILLING_MAINTENANCE_FORBIDDEN_KEYS) {
    if (!nonnegativeInteger(value[key])) fail("BILLING_MAINTENANCE_COUNTS_INVALID");
    normalized[key] = value[key];
  }
  return normalized;
}

function validateReconciliationSummary(value, blockedCount) {
  if (!exactObjectKeys(value, RECONCILIATION_KEYS)) {
    fail("BILLING_MAINTENANCE_SUMMARY_INVALID");
  }
  for (const key of [
    "blockedCount",
    "createdCount",
    "eligibleCount",
    "existingCount",
    "leaseActivationCount"
  ]) {
    if (!nonnegativeInteger(value[key])) fail("BILLING_MAINTENANCE_SUMMARY_INVALID");
  }
  if (
    value.blockedCount !== blockedCount ||
    value.dryRun !== false ||
    !Array.isArray(value.blockerCodes) ||
    value.blockerCodes.some(
      (code) => typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ) ||
    new Set(value.blockerCodes).size !== value.blockerCodes.length ||
    [...value.blockerCodes].sort().some((code, index) => code !== value.blockerCodes[index]) ||
    value.blockerCodes.length > blockedCount
  ) {
    fail("BILLING_MAINTENANCE_SUMMARY_INVALID");
  }
  return {
    blockedCount: value.blockedCount,
    blockerCodes: [...value.blockerCodes],
    createdCount: value.createdCount,
    dryRun: false,
    eligibleCount: value.eligibleCount,
    existingCount: value.existingCount,
    leaseActivationCount: value.leaseActivationCount
  };
}

function validateEnqueueSummary(value) {
  if (
    !exactObjectKeys(value, ENQUEUE_KEYS) ||
    !nonnegativeInteger(value.dueCount) ||
    !nonnegativeInteger(value.enqueuedCount)
  ) {
    fail("BILLING_MAINTENANCE_SUMMARY_INVALID");
  }
  return { dueCount: value.dueCount, enqueuedCount: value.enqueuedCount };
}

function normalizedOptions(options) {
  if (
    isPlainObject(options) &&
    Number.isFinite(options.notBeforeMillis) &&
    typeof options.notBeforeUtc === "string"
  ) {
    return options;
  }
  return validateBillingMaintenanceCycleEvidenceOptions(options);
}

function parseApprovedUtc(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return null;
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  const canonical = new Date(millis).toISOString();
  return canonical === value || canonical.replace(".000Z", "Z") === value ? millis : null;
}

function databaseDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? new Date(value.getTime())
    : null;
}

function readMonotonicTime(now) {
  const value = now();
  if (!Number.isFinite(value) || value < 0) fail("BILLING_MAINTENANCE_OPTIONS_INVALID");
  return value;
}

function exactObjectKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function loadForbiddenDefinition() {
  const candidates = [
    new URL(
      "../apps/api/src/billing-automation/stage1-acceptance-forbidden-domains.json",
      import.meta.url
    ),
    new URL(
      "../apps/api/dist/src/billing-automation/stage1-acceptance-forbidden-domains.json",
      import.meta.url
    )
  ];
  let parsed;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(readFileSync(candidate, "utf8"));
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (
    !isPlainObject(parsed) ||
    !FORBIDDEN_VERSION.test(parsed.version ?? "") ||
    !Array.isArray(parsed.domains) ||
    parsed.domains.length === 0
  ) {
    throw new Error("BILLING_MAINTENANCE_FORBIDDEN_DEFINITION_INVALID");
  }
  const delegates = new Set();
  const tables = new Set();
  for (const domain of parsed.domains) {
    if (
      !isPlainObject(domain) ||
      typeof domain.delegate !== "string" ||
      !/^[A-Za-z][A-Za-z0-9]*$/.test(domain.delegate) ||
      typeof domain.table !== "string" ||
      !/^[a-z][a-z0-9_]*$/.test(domain.table) ||
      delegates.has(domain.delegate) ||
      tables.has(domain.table)
    ) {
      throw new Error("BILLING_MAINTENANCE_FORBIDDEN_DEFINITION_INVALID");
    }
    delegates.add(domain.delegate);
    tables.add(domain.table);
  }
  return parsed;
}

function fail(code) {
  throw new BillingMaintenanceCycleEvidenceError(code);
}
