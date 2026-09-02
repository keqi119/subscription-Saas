import { sha256Canonical } from "@subscription-saas/release-foundation";

import {
  buildTask9ApprovalSummary,
  validateTask9ApiMemoryState,
  validateTask9DatabasePair,
  validateTask9DiscoverySelection,
  validateTask9DiskAvailableKb,
  validateTask9PostgresConnectionState
} from "../../../../scripts/stage1-task9-preflight-governance.mjs";
import { runnerError } from "../error-codes.mjs";
import { assertReadOnlyStatements } from "./db-schema-verify.mjs";

function requireOk(result) {
  if (result?.code !== "OK") throw runnerError(result?.code ?? "TASK9_PREFLIGHT_INVALID");
  return result;
}

function assertInput(context, input) {
  if (
    input?.ruleSetVersion !== "stage1-task9-rules.v1" ||
    typeof context?.readDatabasePair !== "function" ||
    !/^sha256:[0-9a-f]{64}$/.test(context.databaseIdentityFingerprint ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(input?.expectedDatabaseIdentityFingerprint ?? "")
  ) {
    throw runnerError("TASK9_PREFLIGHT_INPUT_INVALID");
  }
  if (context.databaseIdentityFingerprint !== input.expectedDatabaseIdentityFingerprint) {
    throw runnerError("TARGET_IDENTITY_MISMATCH");
  }
  if (
    typeof input.databasePair?.allowedHostname !== "string" ||
    typeof input.databasePair?.owner !== "string" ||
    typeof input.databasePair?.targetDatabase !== "string" ||
    typeof input.vehicleId !== "string" ||
    typeof input.discoveryReport !== "object" ||
    input.discoveryReport === null ||
    typeof input.approvalReport !== "object" ||
    input.approvalReport === null ||
    typeof input.resources?.diskAvailableKb !== "string" ||
    typeof input.resources?.apiMemoryState !== "string" ||
    typeof input.resources?.postgresConnectionState !== "string"
  ) {
    throw runnerError("TASK9_PREFLIGHT_INPUT_INVALID");
  }
}

export async function verifyTask9Preflight(context, input) {
  assertInput(context, input);
  const pair = await context.readDatabasePair();
  const pairResult = requireOk(
    validateTask9DatabasePair(
      pair.sourceUrl,
      pair.targetUrl,
      input.databasePair.allowedHostname,
      input.databasePair.owner,
      input.databasePair.targetDatabase
    )
  );
  const selection = requireOk(
    validateTask9DiscoverySelection(input.discoveryReport, input.vehicleId)
  );
  const approval = (context.buildApprovalSummary ?? buildTask9ApprovalSummary)(
    input.approvalReport
  );
  if (approval?.code) throw runnerError(approval.code);
  if (approval?.safe !== true || approval?.safeToApply !== true) {
    throw runnerError("FORBIDDEN_DOMAIN_NOT_EMPTY");
  }
  const resources = Object.freeze({
    disk: Object.freeze(requireOk(validateTask9DiskAvailableKb(input.resources.diskAvailableKb))),
    memory: Object.freeze(requireOk(validateTask9ApiMemoryState(input.resources.apiMemoryState))),
    postgresConnections: Object.freeze(
      requireOk(validateTask9PostgresConnectionState(input.resources.postgresConnectionState))
    )
  });
  assertReadOnlyStatements(context.statementLog ?? []);
  return Object.freeze({
    schemaVersion: "stage1-task9-preflight-verification.v1",
    safe: true,
    databasePair: Object.freeze({ code: pairResult.code }),
    selection: Object.freeze({ code: selection.code }),
    approval: Object.freeze({
      safe: approval.safe,
      safeToApply: approval.safeToApply,
      exceptionsCount: approval.exceptionsCount
    }),
    resources,
    databaseIdentityFingerprint: context.databaseIdentityFingerprint,
    statementLogDigest: sha256Canonical(context.statementLog ?? []),
    terminalStatus: "PASSED"
  });
}

export async function stage1Task9PreflightHandler({ baseline, request, database }) {
  const verification = await verifyTask9Preflight(database, request.input);
  return Object.freeze({ baseline, verification, terminalStatus: "PASSED" });
}
