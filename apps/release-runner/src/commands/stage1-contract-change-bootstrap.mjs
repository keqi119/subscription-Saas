import {
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import {
  applyContractChangeBootstrapPlan,
  buildContractChangeBootstrapPlan,
  hashContractChangeBootstrapPlan,
  validateContractChangeFeatureFlags
} from "../../../../scripts/stage1-contract-change-bootstrap-core.mjs";
import { loadContractChangeBootstrapRecords } from "../../../../scripts/stage1-contract-change-bootstrap.mjs";
import { hashSubscriptionSegmentBootstrapCandidate } from "../../../../scripts/subscription-segment-bootstrap-core.mjs";
import { runnerError } from "../error-codes.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ALLOWED_ENVIRONMENTS = new Set(["ci-fresh", "ci-snapshot"]);
const DDL = /\b(?:ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|VACUUM|REINDEX|CLUSTER)\b/iu;
const FLAG_KEYS = Object.freeze({
  earlyTermination: "SUBSCRIPTION_EARLY_TERMINATION_ENABLED",
  extension: "SUBSCRIPTION_EXTENSION_ENABLED",
  managedOther: "SUBSCRIPTION_MANAGED_OTHER_ENABLED",
  vehicleSwap: "SUBSCRIPTION_VEHICLE_SWAP_ENABLED"
});

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

function assertEnvironment(environmentClass) {
  if (!ALLOWED_ENVIRONMENTS.has(environmentClass)) {
    throw runnerError("RUNNER_ENVIRONMENT_PROHIBITED", { environmentClass });
  }
}

function featureFlagEnvironment(input) {
  const environment = { DEPLOYMENT_ENV: input.environmentClass };
  for (const [name, key] of Object.entries(FLAG_KEYS)) {
    const value = input?.featureFlags?.[name];
    environment[key] = typeof value === "boolean" ? String(value) : "invalid";
  }
  return environment;
}

function assertContext(context, input) {
  assertEnvironment(input?.environmentClass);
  if (
    typeof (context?.loadRecords ?? loadContractChangeBootstrapRecords) !== "function" ||
    typeof (context?.applyPlan ?? applyContractChangeBootstrapPlan) !== "function" ||
    typeof prisma(context)?.$transaction !== "function" ||
    !Array.isArray(context?.statementLog) ||
    !DIGEST.test(context?.databaseIdentityFingerprint ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (context.databaseIdentityFingerprint !== input?.databaseIdentityFingerprint) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
}

async function loadSource(context) {
  const records = await (context.loadRecords ?? loadContractChangeBootstrapRecords)(
    prisma(context)
  );
  if (!Array.isArray(records)) throw runnerError("CONTRACT_CHANGE_BOOTSTRAP_SOURCE_INVALID");
  const plan = buildContractChangeBootstrapPlan(records);
  return { records, plan };
}

function expectedWrites(plan) {
  return Object.freeze({
    baseSegmentsCreated: plan.baseSegments.candidates.length,
    baseSegmentAuditsCreated: plan.baseSegments.candidates.length,
    extensionDetailsCreated: plan.extensionDetails.candidates.length
  });
}

function candidateIdentities(plan) {
  return Object.freeze({
    baseSegments: plan.baseSegments.candidates.map((candidate) => ({
      orderId: candidate.orderId,
      candidateDigest: hashSubscriptionSegmentBootstrapCandidate(candidate)
    })),
    extensionDetails: plan.extensionDetails.candidates.map((candidate) => ({
      changeOrderId: candidate.changeOrderId,
      orderId: candidate.orderId,
      sourceFingerprint: candidate.sourceFingerprint,
      dataDigest: hashContractChangeBootstrapPlan({ data: candidate.data })
    }))
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

export async function planContractChangeBootstrap(context, input) {
  assertContext(context, input);
  const featureFlags = validateContractChangeFeatureFlags(featureFlagEnvironment(input));
  const source = await loadSource(context);
  const safeToApply = featureFlags.blockers.length === 0 && source.plan.exceptions.length === 0;
  return deepFreeze({
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "stage1-contract-change-bootstrap-plan.v1",
      commandKey: "stage1.contract-change.bootstrap@1",
      inputDigest: sha256Canonical(input),
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      environmentClass: input.environmentClass,
      featureFlags: featureFlags.flags,
      featureFlagBlockers: featureFlags.blockers,
      sourcePlanDigest: hashContractChangeBootstrapPlan(source.plan),
      candidates: candidateIdentities(source.plan),
      exceptions: source.plan.exceptions,
      expectedWrites: expectedWrites(source.plan),
      safeToApply
    },
    provenance: {
      planner: "stage1.contract-change.bootstrap@1",
      generatedAt: input.generatedAt
    }
  });
}

function assertApprovedPlan(plan, planDigest) {
  if (
    plan?.schemaVersion !== "deterministic-plan.v1" ||
    plan?.identity?.commandKey !== "stage1.contract-change.bootstrap@1" ||
    deterministicPlanDigest(plan) !== planDigest
  ) {
    throw runnerError("APPROVED_PLAN_INVALID");
  }
}

function statementLoggingPrisma(target, statementLog) {
  return new Proxy(target, {
    get(prismaTarget, property, receiver) {
      if (property !== "$transaction") return Reflect.get(prismaTarget, property, receiver);
      return (work, options) =>
        prismaTarget.$transaction(
          (tx) => work(statementLoggingTransaction(tx, statementLog)),
          options
        );
    }
  });
}

function statementLoggingTransaction(tx, statementLog) {
  const writeMethods = new Map([
    ["auditLog.create", 'INSERT INTO "audit_log"'],
    ["subscriptionContractSegment.createMany", 'INSERT INTO "subscription_contract_segment"'],
    [
      "subscriptionExtensionChangeDetail.create",
      'INSERT INTO "subscription_extension_change_detail"'
    ]
  ]);
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === "$queryRawUnsafe") {
        return async (sql, ...params) => {
          statementLog.push(String(sql));
          return target.$queryRawUnsafe(sql, ...params);
        };
      }
      const model = Reflect.get(target, property, receiver);
      if (!model || typeof model !== "object") return model;
      return new Proxy(model, {
        get(modelTarget, method, modelReceiver) {
          const value = Reflect.get(modelTarget, method, modelReceiver);
          const statement = writeMethods.get(`${String(property)}.${String(method)}`);
          if (!statement || typeof value !== "function") return value;
          return async (...args) => {
            statementLog.push(statement);
            return value.apply(modelTarget, args);
          };
        }
      });
    }
  });
}

function assertNoDdl(statements) {
  const offending = statements.filter((statement) => DDL.test(String(statement)));
  if (offending.length > 0) {
    throw runnerError("CONTRACT_CHANGE_BOOTSTRAP_DDL_FORBIDDEN", {
      statementDigests: offending.map((statement) => sha256Canonical(String(statement)))
    });
  }
}

function expectedCandidateDigests(plan) {
  return Object.fromEntries(
    plan.identity.candidates.baseSegments.map(({ orderId, candidateDigest }) => [
      orderId,
      candidateDigest
    ])
  );
}

function reconciledCandidates(records, approvedPlan) {
  const orders = new Map(records.map((order) => [order.id, order]));
  const baseSegments = approvedPlan.identity.candidates.baseSegments.map(({ orderId }) => {
    const matches = (orders.get(orderId)?.contractSegments ?? []).filter(
      ({ segmentType, sequenceNo }) => segmentType === "BASE" && sequenceNo === 1
    );
    return { orderId, count: matches.length };
  });
  const extensionDetails = approvedPlan.identity.candidates.extensionDetails.map(
    ({ changeOrderId, orderId }) => {
      const change = (orders.get(orderId)?.subscriptionChanges ?? []).find(
        ({ id }) => id === changeOrderId
      );
      return { changeOrderId, present: Boolean(change?.extensionDetail) };
    }
  );
  return {
    baseSegments,
    extensionDetails,
    complete:
      baseSegments.every(({ count }) => count === 1) &&
      extensionDetails.every(({ present }) => present)
  };
}

function postCommitUnknown(error) {
  const cause =
    error instanceof Error ? error : new Error("CONTRACT_CHANGE_BOOTSTRAP_POST_STATE_UNKNOWN");
  cause.outcomeUnknown = true;
  cause.commitState = "committed-result-unproved";
  return cause;
}

export async function applyContractChangeBootstrap(context, approved) {
  assertEnvironment(approved?.input?.environmentClass);
  const currentPlan = await planContractChangeBootstrap(context, approved.input);
  const currentPlanDigest = deterministicPlanDigest(currentPlan);
  if (currentPlanDigest !== approved.planDigest) {
    throw runnerError("PLAN_CHANGED_SINCE_APPROVAL", {
      approvedPlanDigest: approved.planDigest,
      currentPlanDigest
    });
  }
  if (currentPlan.identity.safeToApply !== true) {
    throw runnerError("CONTRACT_CHANGE_BOOTSTRAP_BLOCKED");
  }
  const statementsBefore = context.statementLog.length;
  const applyPlan = context.applyPlan ?? applyContractChangeBootstrapPlan;
  let writes;
  try {
    writes = await applyPlan(
      statementLoggingPrisma(prisma(context), context.statementLog),
      buildContractChangeBootstrapPlan((await loadSource(context)).records),
      { expectedBaseSegmentCandidateDigests: expectedCandidateDigests(currentPlan) }
    );
  } catch (error) {
    throw postCommitUnknown(error);
  }
  const operationStatements = context.statementLog.slice(statementsBefore);
  try {
    assertNoDdl(operationStatements);
  } catch (error) {
    throw postCommitUnknown(error);
  }
  let postSource;
  try {
    postSource = await loadSource(context);
  } catch (error) {
    throw postCommitUnknown(error);
  }
  const reconciled = reconciledCandidates(postSource.records, currentPlan);
  const actualWrites = {
    baseSegmentsCreated: writes?.baseSegments?.created,
    baseSegmentAuditsCreated: writes?.baseSegments?.created,
    extensionDetailsCreated: writes?.extensionDetails?.created
  };
  const postconditions = [
    postcondition(
      "approved-source-plan-recomputed-before-apply",
      approved.planDigest,
      currentPlanDigest
    ),
    postcondition("approved-candidates-recomputed-under-lock", true, reconciled.complete),
    postcondition(
      "expected-base-segments-and-audits-created",
      {
        baseSegmentsCreated: currentPlan.identity.expectedWrites.baseSegmentsCreated,
        baseSegmentAuditsCreated: currentPlan.identity.expectedWrites.baseSegmentAuditsCreated
      },
      {
        baseSegmentsCreated: actualWrites.baseSegmentsCreated,
        baseSegmentAuditsCreated: actualWrites.baseSegmentAuditsCreated
      }
    ),
    postcondition(
      "expected-extension-details-created",
      currentPlan.identity.expectedWrites.extensionDetailsCreated,
      actualWrites.extensionDetailsCreated
    ),
    postcondition(
      "statement-log-has-no-ddl",
      [],
      operationStatements.filter((sql) => DDL.test(String(sql)))
    ),
    postcondition("all-approved-candidates-present", true, reconciled.complete)
  ];
  if (postconditions.some(({ status }) => status !== "PASSED")) {
    throw postCommitUnknown(runnerError("CONTRACT_CHANGE_BOOTSTRAP_POSTCONDITION_FAILED"));
  }
  return buildPostStateObservation({
    operationId: approved.input.operationId,
    attemptId: approved.input.attemptId,
    runId: approved.input.runId,
    baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
    baselineManifestDigest: approved.input.baselineManifestDigest,
    commandId: "stage1.contract-change.bootstrap",
    commandVersion: "1",
    planDigest: approved.planDigest,
    databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
    postMigrationHead: approved.input.postMigrationHead,
    postSchemaDigest: approved.input.expectedSchemaDigest,
    configurationFingerprint: sha256Canonical({
      featureFlags: currentPlan.identity.featureFlags,
      sourcePlanDigest: currentPlan.identity.sourcePlanDigest,
      statementLogDigest: sha256Canonical(operationStatements),
      writes: actualWrites
    }),
    postconditions,
    observedAt: (context.now?.() ?? new Date()).toISOString()
  });
}

export async function reconcileContractChangeBootstrap(context, prior) {
  assertContext(context, prior.input);
  assertApprovedPlan(prior.approvedPlan, prior.planDigest);
  const statementsBefore = context.statementLog.length;
  const source = await loadSource(context);
  assertNoDdl(context.statementLog.slice(statementsBefore));
  const reconciled = reconciledCandidates(source.records, prior.approvedPlan);
  if (!reconciled.complete) throw runnerError("CONTRACT_CHANGE_BOOTSTRAP_RECONCILE_INCOMPLETE");
  return deepFreeze({
    schemaVersion: "stage1-contract-change-bootstrap-reconcile-result.v1",
    planDigest: prior.planDigest,
    postconditions: [postcondition("replay-has-no-duplicate-side-effects", true, true)],
    terminalStatus: "PASSED"
  });
}

export async function stage1ContractChangeBootstrapHandler({
  baseline,
  request,
  database,
  decision
}) {
  if (decision?.targetIntent && request.input?.environmentClass !== request.environmentClass) {
    throw runnerError("RUNNER_ENVIRONMENT_MISMATCH");
  }
  if (request.phase === "dry-run") {
    const plan = await planContractChangeBootstrap(database, request.input);
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applyContractChangeBootstrap(database, {
      input: request.input,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const reconciliation = await reconcileContractChangeBootstrap(database, {
      input: request.input,
      planDigest: request.planDigest,
      approvedPlan: request.approvedPlan
    });
    return Object.freeze({ baseline, reconciliation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
