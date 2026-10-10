import { assertCustodyComplete, sha256Canonical } from "@subscription-saas/release-foundation";

import {
  assertPublicBillingMaintenanceCycleEvidence,
  BillingMaintenanceCycleEvidenceError,
  canonicalBillingMaintenanceEvidenceJson,
  pollBillingMaintenanceCycleEvidence,
  validateBillingMaintenanceCycleEvidenceOptions
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

function assertAdapterShape(context) {
  if (
    typeof context?.queryBillingMaintenanceFacts !== "function" ||
    typeof context?.custodyEvidence !== "function" ||
    !Array.isArray(context.statementLog)
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
}

function assertContext(context, input) {
  assertAdapterShape(context);
  if (!HEX_64.test(context.databaseIdentitySha256 ?? "")) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (context.databaseIdentitySha256 !== input?.expectedDatabaseIdentitySha256) {
    throw runnerError("BILLING_MAINTENANCE_DATABASE_IDENTITY_MISMATCH");
  }
}

export async function collectBillingMaintenanceEvidence(context, input) {
  validateBillingMaintenanceCycleEvidenceOptions(input);
  assertAdapterShape(context);
  const productionIdentity = typeof context.observeBillingMaintenanceIdentity === "function";
  const numericNow =
    productionIdentity && typeof context.now === "function" && typeof context.now() === "number"
      ? context.now
      : Date.now;
  const billingContext = productionIdentity ? { ...context, now: numericNow } : context;
  if (!productionIdentity) assertContext(billingContext, input);
  let identityChecked = !productionIdentity;
  const budgetStartedAt = productionIdentity ? numericNow() : null;
  const evidence = await pollBillingMaintenanceCycleEvidence({
    ...input,
    clearTimer: billingContext.clearTimer,
    now: billingContext.now,
    pollIntervalMs: billingContext.pollIntervalMs,
    queryFacts: async (runId, queryTimeoutMilliseconds, remainingMilliseconds) => {
      if (!identityChecked) {
        const beforeIdentity = numericNow();
        if (!Number.isFinite(beforeIdentity) || beforeIdentity < 0) {
          throw new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_OPTIONS_INVALID");
        }
        const observed = await context.observeBillingMaintenanceIdentity(
          Math.min(5_000, queryTimeoutMilliseconds)
        );
        const afterIdentity = numericNow();
        if (!Number.isFinite(afterIdentity) || afterIdentity < beforeIdentity) {
          throw new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_OPTIONS_INVALID");
        }
        remainingMilliseconds = Math.floor(
          Math.min(
            remainingMilliseconds - Math.ceil(afterIdentity - beforeIdentity),
            input.timeoutSeconds * 1_000 - (afterIdentity - budgetStartedAt)
          )
        );
        if (remainingMilliseconds <= 100) {
          throw new BillingMaintenanceCycleEvidenceError("BILLING_MAINTENANCE_EVIDENCE_TIMEOUT");
        }
        billingContext.databaseIdentitySha256 = observed;
        assertContext(billingContext, input);
        identityChecked = true;
        queryTimeoutMilliseconds = Math.floor(
          Math.min(queryTimeoutMilliseconds, remainingMilliseconds - 100)
        );
      }
      return billingContext.queryBillingMaintenanceFacts({
        runId,
        queryTimeoutMilliseconds,
        remainingMilliseconds
      });
    },
    setTimer: billingContext.setTimer,
    wait: billingContext.wait
  });

  if (billingContext.statementLog.length === 0) {
    throw runnerError("BILLING_MAINTENANCE_STATEMENT_LOG_MISSING");
  }
  assertReadOnlyStatements(billingContext.statementLog);
  assertPublicBillingMaintenanceCycleEvidence(evidence);
  const publicEvidence = deepFreeze(JSON.parse(canonicalBillingMaintenanceEvidenceJson(evidence)));
  const evidenceDigest = sha256Canonical(publicEvidence);
  const custodyReceipt = await billingContext.custodyEvidence({
    value: publicEvidence,
    contentDigest: evidenceDigest
  });
  assertCustodyComplete(custodyReceipt, evidenceDigest);

  return deepFreeze({
    schemaVersion: "stage1-billing-maintenance-evidence-result.v1",
    evidence: publicEvidence,
    evidenceDigest,
    custodyReceipt,
    databaseIdentitySha256: billingContext.databaseIdentitySha256,
    statementLogDigest: sha256Canonical(billingContext.statementLog),
    terminalStatus: "PASSED"
  });
}

export async function stage1BillingMaintenanceEvidenceHandler({ baseline, request, database }) {
  const result = await collectBillingMaintenanceEvidence(database, request.input);
  return Object.freeze({ baseline, result, terminalStatus: "PASSED" });
}
