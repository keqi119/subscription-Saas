import { assertCustodyComplete, sha256Canonical } from "@subscription-saas/release-foundation";

import {
  assertPublicBillingMaintenanceCycleEvidence,
  canonicalBillingMaintenanceEvidenceJson,
  pollBillingMaintenanceCycleEvidence
} from "../../../../scripts/billing-maintenance-cycle-evidence-core.mjs";
import { runnerError } from "../error-codes.mjs";
import { assertReadOnlyStatements } from "./db-schema-verify.mjs";

const HEX_64 = /^[0-9a-f]{64}$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertContext(context, input) {
  if (
    typeof context?.queryBillingMaintenanceFacts !== "function" ||
    typeof context?.custodyEvidence !== "function" ||
    !Array.isArray(context.statementLog) ||
    !HEX_64.test(context.databaseIdentitySha256 ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (context.databaseIdentitySha256 !== input?.expectedDatabaseIdentitySha256) {
    throw runnerError("BILLING_MAINTENANCE_DATABASE_IDENTITY_MISMATCH");
  }
}

export async function collectBillingMaintenanceEvidence(context, input) {
  assertContext(context, input);
  const evidence = await pollBillingMaintenanceCycleEvidence({
    ...input,
    clearTimer: context.clearTimer,
    now: context.now,
    pollIntervalMs: context.pollIntervalMs,
    queryFacts: (runId, queryTimeoutMilliseconds, remainingMilliseconds) =>
      context.queryBillingMaintenanceFacts({
        runId,
        queryTimeoutMilliseconds,
        remainingMilliseconds
      }),
    setTimer: context.setTimer,
    wait: context.wait
  });

  if (context.statementLog.length === 0) {
    throw runnerError("BILLING_MAINTENANCE_STATEMENT_LOG_MISSING");
  }
  assertReadOnlyStatements(context.statementLog);
  assertPublicBillingMaintenanceCycleEvidence(evidence);
  const publicEvidence = deepFreeze(JSON.parse(canonicalBillingMaintenanceEvidenceJson(evidence)));
  const evidenceDigest = sha256Canonical(publicEvidence);
  const custodyReceipt = await context.custodyEvidence({
    value: publicEvidence,
    contentDigest: evidenceDigest
  });
  assertCustodyComplete(custodyReceipt, evidenceDigest);

  return deepFreeze({
    schemaVersion: "stage1-billing-maintenance-evidence-result.v1",
    evidence: publicEvidence,
    evidenceDigest,
    custodyReceipt,
    databaseIdentitySha256: context.databaseIdentitySha256,
    statementLogDigest: sha256Canonical(context.statementLog),
    terminalStatus: "PASSED"
  });
}

export async function stage1BillingMaintenanceEvidenceHandler({ baseline, request, database }) {
  const result = await collectBillingMaintenanceEvidence(database, request.input);
  return Object.freeze({ baseline, result, terminalStatus: "PASSED" });
}
