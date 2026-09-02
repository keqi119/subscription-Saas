import {
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import { hashStage1ActiveSourceFactsRepairClassification } from "../../../../scripts/stage1-active-source-facts-repair-core.mjs";
import { executeStage1ActiveSourceFactsRepair } from "../../../../scripts/stage1-active-source-facts-repair-executor.mjs";
import { runnerError } from "../error-codes.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function prisma(context) {
  return context?.prisma ?? context;
}

function assertContext(context, input) {
  if (
    typeof (context?.executeRepair ?? executeStage1ActiveSourceFactsRepair) !== "function" ||
    typeof prisma(context)?.$transaction !== "function" ||
    !DIGEST.test(context?.databaseIdentityFingerprint ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (context.databaseIdentityFingerprint !== input?.databaseIdentityFingerprint) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
}

function writeTotals(classification) {
  const candidates = classification.candidates ?? [];
  return Object.freeze({
    contractsUpdated: candidates.filter(({ actions }) => actions.includes("ARCHIVE_CONTRACT"))
      .length,
    ordersUpdated: candidates.filter(({ actions }) =>
      actions.some((action) => ["BIND_CONTRACT", "SET_ORDER_DATES"].includes(action))
    ).length,
    audits: candidates.reduce(
      (count, { actions }) =>
        count +
        Number(actions.includes("ARCHIVE_CONTRACT")) +
        Number(actions.some((action) => ["BIND_CONTRACT", "SET_ORDER_DATES"].includes(action))),
      0
    )
  });
}

function postcondition(id, expected, actual) {
  const expectedDigest = sha256Canonical(expected);
  const actualDigest = sha256Canonical(actual);
  return Object.freeze({
    id,
    status: expectedDigest === actualDigest ? "PASSED" : "FAILED",
    expectedDigest,
    actualDigest
  });
}

export async function planActiveSourceFactsRepair(context, input) {
  assertContext(context, input);
  const executeRepair = context.executeRepair ?? executeStage1ActiveSourceFactsRepair;
  const outcome = await executeRepair({
    mode: "dry-run",
    generatedAt: input.generatedAt,
    prisma: prisma(context)
  });
  const classification = outcome?.report?.classification;
  if (
    outcome?.report?.mode !== "dry-run" ||
    !classification ||
    !Array.isArray(classification.candidates) ||
    !Array.isArray(classification.exceptions) ||
    !Array.isArray(classification.unchanged)
  ) {
    throw runnerError("ACTIVE_SOURCE_FACTS_PLAN_INVALID");
  }
  return deepFreeze({
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "stage1-active-source-facts-repair-plan.v1",
      commandKey: "stage1.active-source-facts.repair@1",
      inputDigest: sha256Canonical(input),
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      classificationDigest: hashStage1ActiveSourceFactsRepairClassification(classification),
      safeToApply: outcome.report.safeToApply === true,
      candidates: classification.candidates.map((candidate) => ({
        orderId: candidate.orderId,
        contractId: candidate.contractId,
        evidenceDigest: candidate.evidenceDigest,
        actions: [...candidate.actions],
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        archivedAt: candidate.archivedAt
      })),
      expectedWrites: writeTotals(classification)
    },
    provenance: {
      planner: "stage1.active-source-facts.repair@1",
      generatedAt: input.generatedAt
    }
  });
}

function assertApprovedPlan(plan, planDigest) {
  if (
    plan?.schemaVersion !== "deterministic-plan.v1" ||
    plan?.identity?.commandKey !== "stage1.active-source-facts.repair@1" ||
    deterministicPlanDigest(plan) !== planDigest
  ) {
    throw runnerError("APPROVED_PLAN_INVALID");
  }
}

function reconciledIdentities(classification, candidates) {
  const expected = candidates.map(({ orderId, contractId }) => `${orderId}:${contractId}`).sort();
  const actual = (classification?.unchanged ?? [])
    .map(({ orderId, contractId }) => `${orderId}:${contractId}`)
    .filter((identity) => expected.includes(identity))
    .sort();
  return {
    expected,
    actual,
    complete:
      Array.isArray(classification?.candidates) &&
      classification.candidates.length === 0 &&
      Array.isArray(classification?.exceptions) &&
      classification.exceptions.length === 0 &&
      JSON.stringify(actual) === JSON.stringify(expected)
  };
}

function postCommitUnknown(error) {
  const cause =
    error instanceof Error ? error : new Error("ACTIVE_SOURCE_FACTS_POST_STATE_UNKNOWN");
  cause.outcomeUnknown = true;
  cause.commitState = "committed-result-unproved";
  return cause;
}

export async function applyActiveSourceFactsRepair(context, approved) {
  const currentPlan = await planActiveSourceFactsRepair(context, approved.input);
  const currentPlanDigest = deterministicPlanDigest(currentPlan);
  if (currentPlanDigest !== approved.planDigest) {
    throw runnerError("PLAN_CHANGED_SINCE_APPROVAL", {
      approvedPlanDigest: approved.planDigest,
      currentPlanDigest
    });
  }
  if (currentPlan.identity.safeToApply !== true) {
    throw runnerError("ACTIVE_SOURCE_FACTS_REPAIR_BLOCKED");
  }
  const executeRepair = context.executeRepair ?? executeStage1ActiveSourceFactsRepair;
  let outcome;
  try {
    outcome = await executeRepair({
      mode: "apply",
      generatedAt: approved.input.generatedAt,
      prisma: prisma(context),
      expectedClassificationDigest: currentPlan.identity.classificationDigest
    });
  } catch (error) {
    if (error?.code === "STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_PLAN_CHANGED") {
      throw runnerError("PLAN_CHANGED_SINCE_APPROVAL");
    }
    throw error;
  }
  const actualWrites = outcome?.report?.applied;
  const expectedWrites = currentPlan.identity.expectedWrites;
  const normalizedWrites = {
    contractsUpdated: actualWrites?.contractsUpdated,
    ordersUpdated: actualWrites?.ordersUpdated,
    audits: actualWrites?.audits
  };
  let afterApply;
  try {
    afterApply = await executeRepair({
      mode: "dry-run",
      generatedAt: approved.input.generatedAt,
      prisma: prisma(context)
    });
  } catch (error) {
    throw postCommitUnknown(error);
  }
  const reconciled = reconciledIdentities(
    afterApply?.report?.classification,
    currentPlan.identity.candidates
  );
  if (!reconciled.complete) throw postCommitUnknown();
  const postconditions = [
    postcondition(
      "approved-candidate-set-recomputed-under-lock",
      true,
      outcome?.report?.safeToApply
    ),
    postcondition(
      "expected-contract-updates-applied",
      expectedWrites.contractsUpdated,
      actualWrites?.contractsUpdated
    ),
    postcondition(
      "expected-order-updates-applied",
      expectedWrites.ordersUpdated,
      actualWrites?.ordersUpdated
    ),
    postcondition("expected-audits-created", expectedWrites.audits, actualWrites?.audits),
    postcondition("candidate-set-clean-after-apply", reconciled.expected, reconciled.actual)
  ];
  if (postconditions.some(({ status }) => status !== "PASSED")) {
    throw runnerError("ACTIVE_SOURCE_FACTS_POSTCONDITION_FAILED");
  }
  return buildPostStateObservation({
    operationId: approved.input.operationId,
    attemptId: approved.input.attemptId,
    runId: approved.input.runId,
    baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
    baselineManifestDigest: approved.input.baselineManifestDigest,
    commandId: "stage1.active-source-facts.repair",
    commandVersion: "1",
    planDigest: approved.planDigest,
    databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
    postMigrationHead: approved.input.postMigrationHead,
    postSchemaDigest: approved.input.expectedSchemaDigest,
    configurationFingerprint: sha256Canonical({
      classificationDigest: currentPlan.identity.classificationDigest,
      writes: normalizedWrites
    }),
    postconditions,
    observedAt: (context.now?.() ?? new Date()).toISOString()
  });
}

export async function reconcileActiveSourceFactsRepair(context, prior) {
  assertContext(context, prior.input);
  assertApprovedPlan(prior.approvedPlan, prior.planDigest);
  const executeRepair = context.executeRepair ?? executeStage1ActiveSourceFactsRepair;
  const outcome = await executeRepair({
    mode: "dry-run",
    generatedAt: prior.input.generatedAt,
    prisma: prisma(context)
  });
  const classification = outcome?.report?.classification;
  const reconciled = reconciledIdentities(classification, prior.approvedPlan.identity.candidates);
  if (!reconciled.complete) {
    throw runnerError("ACTIVE_SOURCE_FACTS_RECONCILE_INCOMPLETE");
  }
  return deepFreeze({
    schemaVersion: "stage1-active-source-facts-reconcile-result.v1",
    planDigest: prior.planDigest,
    candidateCount: reconciled.expected.length,
    postconditions: [
      postcondition("replay-has-no-duplicate-side-effects", reconciled.expected, reconciled.actual)
    ],
    terminalStatus: "PASSED"
  });
}

export async function stage1ActiveSourceFactsRepairHandler({ baseline, request, database }) {
  if (request.phase === "dry-run") {
    const plan = await planActiveSourceFactsRepair(database, request.input);
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applyActiveSourceFactsRepair(database, {
      input: request.input,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const reconciliation = await reconcileActiveSourceFactsRepair(database, {
      input: request.input,
      planDigest: request.planDigest,
      approvedPlan: request.approvedPlan
    });
    return Object.freeze({ baseline, reconciliation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
