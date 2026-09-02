import {
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import {
  applySubscriptionSegmentBootstrapPlan,
  buildSubscriptionSegmentBootstrapPlan,
  hashSubscriptionSegmentBootstrapCandidate,
  hashSubscriptionSegmentBootstrapPlan
} from "../../../../scripts/subscription-segment-bootstrap-core.mjs";
import { loadSubscriptionSegmentBootstrapRecords } from "../../../../scripts/subscription-segment-bootstrap.mjs";
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
    typeof (context?.loadRecords ?? loadSubscriptionSegmentBootstrapRecords) !== "function" ||
    typeof (context?.applyPlan ?? applySubscriptionSegmentBootstrapPlan) !== "function" ||
    typeof prisma(context)?.$transaction !== "function" ||
    !DIGEST.test(context?.databaseIdentityFingerprint ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (context.databaseIdentityFingerprint !== input?.databaseIdentityFingerprint) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
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

async function loadPlan(context) {
  const records = await (context.loadRecords ?? loadSubscriptionSegmentBootstrapRecords)(
    prisma(context)
  );
  return buildSubscriptionSegmentBootstrapPlan(records);
}

function candidateIdentities(plan) {
  return [...plan.candidates]
    .map((candidate) => ({
      orderId: candidate.orderId,
      orderNo: candidate.orderNo,
      candidateDigest: hashSubscriptionSegmentBootstrapCandidate(candidate)
    }))
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
}

function exceptionIdentities(plan) {
  return [...plan.exceptions]
    .map(({ code, missingFacts, orderId, orderNo }) => ({
      code,
      missingFacts: [...missingFacts],
      orderId,
      orderNo
    }))
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
}

export async function planSubscriptionSegmentBootstrap(context, input) {
  assertContext(context, input);
  const sourcePlan = await loadPlan(context);
  const candidates = candidateIdentities(sourcePlan);
  const exceptions = exceptionIdentities(sourcePlan);
  return deepFreeze({
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "subscription-segment-bootstrap-plan.v1",
      commandKey: "subscription.segment.bootstrap@1",
      inputDigest: sha256Canonical(input),
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      sourcePlanDigest: hashSubscriptionSegmentBootstrapPlan(sourcePlan),
      candidates,
      exceptions,
      ignored: sourcePlan.ignored,
      existing: sourcePlan.summary.existing,
      expectedWrites: {
        segmentsCreated: candidates.length,
        auditsCreated: candidates.length
      }
    },
    provenance: {
      planner: "subscription.segment.bootstrap@1",
      generatedAt: input.generatedAt
    }
  });
}

function assertApprovedPlan(plan, planDigest) {
  if (
    plan?.schemaVersion !== "deterministic-plan.v1" ||
    plan?.identity?.commandKey !== "subscription.segment.bootstrap@1" ||
    deterministicPlanDigest(plan) !== planDigest
  ) {
    throw runnerError("APPROVED_PLAN_INVALID");
  }
}

function candidateDigestMap(plan) {
  return Object.fromEntries(
    plan.identity.candidates.map(({ orderId, candidateDigest }) => [orderId, candidateDigest])
  );
}

function reconciledCandidates(plan, sourcePlan) {
  const expected = plan.identity.candidates.map(({ orderId }) => orderId).sort();
  const outstanding = new Set(sourcePlan.candidates.map(({ orderId }) => orderId));
  const refused = new Set(sourcePlan.exceptions.map(({ orderId }) => orderId));
  const actual = expected
    .filter((orderId) => !outstanding.has(orderId) && !refused.has(orderId))
    .sort();
  return {
    expected,
    actual,
    complete: JSON.stringify(expected) === JSON.stringify(actual)
  };
}

function postCommitUnknown(error) {
  const cause = error instanceof Error ? error : new Error("SEGMENT_BOOTSTRAP_POST_STATE_UNKNOWN");
  cause.outcomeUnknown = true;
  cause.commitState = "committed-result-unproved";
  return cause;
}

export async function applySubscriptionSegmentBootstrap(context, approved) {
  const currentPlan = await planSubscriptionSegmentBootstrap(context, approved.input);
  const currentPlanDigest = deterministicPlanDigest(currentPlan);
  if (currentPlanDigest !== approved.planDigest) throw runnerError("PLAN_CHANGED_SINCE_APPROVAL");

  const sourcePlan = await loadPlan(context);
  if (hashSubscriptionSegmentBootstrapPlan(sourcePlan) !== currentPlan.identity.sourcePlanDigest) {
    throw runnerError("PLAN_CHANGED_SINCE_APPROVAL");
  }

  let applied;
  try {
    applied = await (context.applyPlan ?? applySubscriptionSegmentBootstrapPlan)(
      prisma(context),
      sourcePlan,
      { expectedCandidateDigests: candidateDigestMap(currentPlan) }
    );
  } catch (error) {
    throw postCommitUnknown(error);
  }

  let postPlan;
  try {
    postPlan = await loadPlan(context);
  } catch (error) {
    throw postCommitUnknown(error);
  }
  const reconciled = reconciledCandidates(currentPlan, postPlan);
  const expected = currentPlan.identity.expectedWrites;
  const postconditions = [
    postcondition(
      "approved-candidate-set-recomputed-before-apply",
      approved.planDigest,
      currentPlanDigest
    ),
    postcondition(
      "approved-candidate-recomputed-under-lock",
      currentPlan.identity.candidates.length,
      applied?.created
    ),
    postcondition("expected-base-segments-present", reconciled.expected, reconciled.actual),
    postcondition("expected-base-segments-created", expected.segmentsCreated, applied?.created),
    postcondition("expected-audits-created", expected.auditsCreated, applied?.created),
    postcondition("no-duplicate-base-segment", true, reconciled.complete)
  ];
  if (postconditions.some(({ status }) => status !== "PASSED")) {
    throw postCommitUnknown(runnerError("SEGMENT_BOOTSTRAP_POSTCONDITION_FAILED"));
  }
  return buildPostStateObservation({
    operationId: approved.input.operationId,
    attemptId: approved.input.attemptId,
    runId: approved.input.runId,
    baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
    baselineManifestDigest: approved.input.baselineManifestDigest,
    commandId: "subscription.segment.bootstrap",
    commandVersion: "1",
    planDigest: approved.planDigest,
    databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
    postMigrationHead: approved.input.postMigrationHead,
    postSchemaDigest: approved.input.expectedSchemaDigest,
    configurationFingerprint: sha256Canonical({
      sourcePlanDigest: currentPlan.identity.sourcePlanDigest,
      writes: { created: applied.created, existing: applied.existing }
    }),
    postconditions,
    observedAt: (context.now?.() ?? new Date()).toISOString()
  });
}

export async function reconcileSubscriptionSegmentBootstrap(context, prior) {
  assertContext(context, prior.input);
  assertApprovedPlan(prior.approvedPlan, prior.planDigest);
  const sourcePlan = await loadPlan(context);
  const reconciled = reconciledCandidates(prior.approvedPlan, sourcePlan);
  if (!reconciled.complete) throw runnerError("SEGMENT_BOOTSTRAP_RECONCILE_INCOMPLETE");
  return deepFreeze({
    schemaVersion: "subscription-segment-bootstrap-reconcile-result.v1",
    planDigest: prior.planDigest,
    postconditions: [
      postcondition("replay-has-no-duplicate-side-effects", reconciled.expected, reconciled.actual)
    ],
    terminalStatus: "PASSED"
  });
}

export async function subscriptionSegmentBootstrapHandler({ baseline, request, database }) {
  if (request.phase === "dry-run") {
    const plan = await planSubscriptionSegmentBootstrap(database, request.input);
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applySubscriptionSegmentBootstrap(database, {
      input: request.input,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const reconciliation = await reconcileSubscriptionSegmentBootstrap(database, {
      input: request.input,
      planDigest: request.planDigest,
      approvedPlan: request.approvedPlan
    });
    return Object.freeze({ baseline, reconciliation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
