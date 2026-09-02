import {
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import {
  applicableStage1ReturnClassification,
  classifyStage1ReturnClosureBackfill,
  executeStage1ReturnClosureBackfill,
  hashStage1ReturnClosureClassification,
  paymentWriteOffAuthorityFingerprint
} from "../../../../scripts/stage1-return-closure-backfill-core.mjs";
import {
  applyClassification,
  loadSnapshot
} from "../../../../scripts/stage1-return-closure-backfill.mjs";
import { runnerError } from "../error-codes.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DDL = /\b(?:ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|TRUNCATE|VACUUM|REINDEX|CLUSTER)\b/i;
const DML = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z0-9_]+)"?/i;
const ALLOWED_DML_TABLES = new Set([
  "contract_charge_clause_snapshot",
  "file_object",
  "subscription_closure_case",
  "vehicle_return_evidence_link"
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function client(context) {
  return context?.prisma ?? context;
}

function assertContext(context, input) {
  const grantedProfiles = context?.grantedCapabilityProfiles;
  if (
    typeof client(context)?.$transaction !== "function" ||
    typeof (context?.loadSnapshot ?? loadSnapshot) !== "function" ||
    typeof (context?.applyClassification ?? applyClassification) !== "function" ||
    !DIGEST.test(context?.databaseIdentityFingerprint ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (
    !Array.isArray(grantedProfiles) ||
    grantedProfiles.length !== 1 ||
    grantedProfiles[0] !== "repair"
  ) {
    throw runnerError("RUNNER_CAPABILITY_CREDENTIAL_MISMATCH");
  }
  if (context.databaseIdentityFingerprint !== input?.databaseIdentityFingerprint) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
}

function sqlText(statement) {
  if (typeof statement === "string") return statement;
  if (typeof statement?.sql === "string") return statement.sql;
  throw runnerError("RETURN_CLOSURE_STATEMENT_EVIDENCE_INVALID");
}

export function assertReturnClosureDmlStatements(statements) {
  if (!Array.isArray(statements)) {
    throw runnerError("RETURN_CLOSURE_STATEMENT_LOG_MISSING");
  }
  for (const statement of statements) {
    const sql = sqlText(statement);
    if (DDL.test(sql)) throw runnerError("RETURN_CLOSURE_DDL_STATEMENT_FORBIDDEN");
    const mutation = DML.exec(sql);
    if (mutation && !ALLOWED_DML_TABLES.has(mutation[1].toLowerCase())) {
      throw runnerError("RETURN_CLOSURE_DML_TARGET_FORBIDDEN", { table: mutation[1] });
    }
  }
}

async function readSnapshot(context) {
  if (context.loadSnapshot) return context.loadSnapshot();
  return client(context).$transaction((tx) => loadSnapshot(tx), {
    isolationLevel: "RepeatableRead",
    timeout: 120_000
  });
}

function writeIdentities(classification) {
  const applicable = applicableStage1ReturnClassification(classification);
  return Object.freeze({
    clauseSnapshots: applicable.clauseSnapshots
      .filter(({ disposition }) => disposition === "CREATE")
      .map(({ clauseCode, clauseVersion, compilationHash, contractId }) => ({
        clauseCode,
        clauseVersion,
        compilationHash,
        contractId
      })),
    fileAuthorities: applicable.fileAuthorityUpdates
      .filter(({ disposition }) => disposition === "UPDATE")
      .map(({ closureCaseId, contractId, expectedContentSha256, fileId, toContentSha256 }) => ({
        closureCaseId,
        contractId,
        expectedContentSha256,
        fileId,
        toContentSha256
      })),
    financial: applicable.financialUpdates
      .filter(({ disposition }) => disposition === "UPDATE")
      .map(({ authorityFingerprint, closureCaseId, expectedVersion, from, orderId, to }) => ({
        authorityFingerprint,
        closureCaseId,
        expectedVersion,
        from,
        orderId,
        to
      })),
    legacyLinks: applicable.legacyEvidenceLinks
      .filter(({ disposition }) => disposition === "CREATE")
      .map(
        ({
          closureCaseId,
          damageId,
          legacyExternalReference,
          sourceId,
          sourceKey,
          sourceType
        }) => ({
          closureCaseId,
          damageId,
          legacyExternalReferenceDigest: sha256Canonical(legacyExternalReference),
          sourceId,
          sourceKey,
          sourceType
        })
      )
  });
}

function expectedWriteCounts(writes) {
  return Object.freeze({
    clauses: writes.clauseSnapshots.length,
    fileAuthorities: writes.fileAuthorities.length,
    financial: writes.financial.length,
    legacyLinks: writes.legacyLinks.length,
    auditEvents: 0
  });
}

function manualReviewIdentities(classification) {
  return classification.manualReview.map(({ closureCaseId, code, orderId }) => ({
    closureCaseId,
    code,
    orderId
  }));
}

async function classifyContext(context) {
  const snapshot = await readSnapshot(context);
  return {
    snapshot,
    classification: classifyStage1ReturnClosureBackfill(snapshot)
  };
}

export async function planReturnClosureBackfill(context, input) {
  assertContext(context, input);
  const { snapshot, classification } = await classifyContext(context);
  const writes = writeIdentities(classification);
  return deepFreeze({
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "stage1-return-closure-backfill-plan.v1",
      commandKey: "stage1.return-closure.backfill@1",
      inputDigest: sha256Canonical(input),
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      classificationDigest: hashStage1ReturnClosureClassification(classification),
      paymentWriteOffAuthorityFingerprint: paymentWriteOffAuthorityFingerprint(
        snapshot.paymentRecords,
        snapshot.paymentWriteOffs
      ),
      unsafeToApply: classification.counters.clauseConflicts > 0,
      blocked: classification.counters.manualReview > 0,
      quarantinedClosureIds: [...classification.quarantinedClosureIds],
      manualReview: manualReviewIdentities(classification),
      writes,
      expectedWrites: expectedWriteCounts(writes)
    },
    provenance: {
      planner: "stage1.return-closure.backfill@1",
      generatedAt: input.generatedAt
    }
  });
}

function assertApprovedPlan(plan, planDigest) {
  if (
    plan?.schemaVersion !== "deterministic-plan.v1" ||
    plan?.identity?.commandKey !== "stage1.return-closure.backfill@1" ||
    deterministicPlanDigest(plan) !== planDigest
  ) {
    throw runnerError("APPROVED_PLAN_INVALID");
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

function postCommitUnknown(error) {
  const cause = error instanceof Error ? error : new Error("RETURN_CLOSURE_POST_STATE_UNKNOWN");
  cause.outcomeUnknown = true;
  cause.commitState = "committed-result-unproved";
  return cause;
}

function reconciliationState(approvedPlan, snapshot, classification) {
  const writes = approvedPlan.identity.writes;
  const clauseKeys = new Set(
    classification.clauseSnapshots
      .filter(({ disposition }) => disposition === "UNCHANGED")
      .map(
        ({ clauseCode, clauseVersion, contractId }) =>
          `${contractId}:${clauseCode}:${clauseVersion}`
      )
  );
  const linkKeys = new Set(
    classification.legacyEvidenceLinks
      .filter(({ disposition }) => disposition === "UNCHANGED")
      .map(({ sourceKey }) => sourceKey)
  );
  const financial = new Map(
    classification.financialUpdates.map((item) => [item.closureCaseId, item])
  );
  const files = new Map((snapshot.files ?? []).map((item) => [item.id, item.contentSha256]));
  const expected = {
    clauses: writes.clauseSnapshots
      .map(
        ({ clauseCode, clauseVersion, contractId }) =>
          `${contractId}:${clauseCode}:${clauseVersion}`
      )
      .sort(),
    fileAuthorities: writes.fileAuthorities.map(({ fileId }) => fileId).sort(),
    financial: writes.financial.map(({ closureCaseId }) => closureCaseId).sort(),
    legacyLinks: writes.legacyLinks.map(({ sourceKey }) => sourceKey).sort()
  };
  const actual = {
    clauses: expected.clauses.filter((key) => clauseKeys.has(key)),
    fileAuthorities: writes.fileAuthorities
      .filter(({ fileId, toContentSha256 }) => files.get(fileId) === toContentSha256)
      .map(({ fileId }) => fileId)
      .sort(),
    financial: writes.financial
      .filter(({ authorityFingerprint, closureCaseId, to }) => {
        const item = financial.get(closureCaseId);
        return (
          item?.disposition === "UNCHANGED" &&
          item.to === to &&
          item.authorityFingerprint === authorityFingerprint
        );
      })
      .map(({ closureCaseId }) => closureCaseId)
      .sort(),
    legacyLinks: expected.legacyLinks.filter((key) => linkKeys.has(key))
  };
  return {
    expected,
    actual,
    complete: sha256Canonical(expected) === sha256Canonical(actual),
    paymentWriteOffAuthorityFingerprint: paymentWriteOffAuthorityFingerprint(
      snapshot.paymentRecords,
      snapshot.paymentWriteOffs
    )
  };
}

export async function applyReturnClosureBackfill(context, approved) {
  const currentPlan = await planReturnClosureBackfill(context, approved.input);
  const currentPlanDigest = deterministicPlanDigest(currentPlan);
  if (currentPlanDigest !== approved.planDigest) throw runnerError("PLAN_CHANGED_SINCE_APPROVAL");
  if (currentPlan.identity.unsafeToApply) throw runnerError("RETURN_CLOSURE_BACKFILL_CONFLICT");

  const statementsBefore = Array.isArray(context.statementLog) ? context.statementLog.length : null;
  let outcome;
  try {
    outcome = await executeStage1ReturnClosureBackfill({
      apply: (classification) =>
        (context.applyClassification ?? applyClassification)(client(context), classification),
      expectedClassificationDigest: currentPlan.identity.classificationDigest,
      generatedAt: approved.input.generatedAt,
      load: () => readSnapshot(context),
      mode: "apply"
    });
  } catch (error) {
    if (error?.code === "STAGE1_RETURN_CLOSURE_BACKFILL_PLAN_CHANGED") {
      throw runnerError("PLAN_CHANGED_SINCE_APPROVAL");
    }
    throw postCommitUnknown(error);
  }

  let post;
  let operationStatements;
  try {
    if (statementsBefore === null || !Array.isArray(context.statementLog)) {
      throw runnerError("RETURN_CLOSURE_STATEMENT_LOG_MISSING");
    }
    operationStatements = context.statementLog.slice(statementsBefore);
    assertReturnClosureDmlStatements(operationStatements);
    post = await classifyContext(context);
  } catch (error) {
    throw postCommitUnknown(error);
  }
  const reconciled = reconciliationState(currentPlan, post.snapshot, post.classification);
  const expected = currentPlan.identity.expectedWrites;
  const applied = outcome?.report?.applied ?? {};
  const actual = {
    clauses: applied.clauses,
    fileAuthorities: applied.fileAuthorities,
    financial: applied.financial,
    legacyLinks: applied.legacyLinks,
    auditEvents: 0
  };
  const postconditions = [
    postcondition(
      "approved-classification-recomputed-before-write",
      approved.planDigest,
      currentPlanDigest
    ),
    postcondition("exact-dml-effects-applied", expected, actual),
    postcondition(
      "financial-authority-fingerprints-preserved",
      reconciled.expected.financial,
      reconciled.actual.financial
    ),
    postcondition(
      "payment-writeoff-authority-unchanged",
      currentPlan.identity.paymentWriteOffAuthorityFingerprint,
      reconciled.paymentWriteOffAuthorityFingerprint
    ),
    postcondition("return-closure-candidates-reconciled", reconciled.expected, reconciled.actual),
    postcondition("statement-log-has-no-ddl", true, true)
  ];
  if (!reconciled.complete || postconditions.some(({ status }) => status !== "PASSED")) {
    throw postCommitUnknown(runnerError("RETURN_CLOSURE_POSTCONDITION_FAILED"));
  }
  return buildPostStateObservation({
    operationId: approved.input.operationId,
    attemptId: approved.input.attemptId,
    runId: approved.input.runId,
    baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
    baselineManifestDigest: approved.input.baselineManifestDigest,
    commandId: "stage1.return-closure.backfill",
    commandVersion: "1",
    planDigest: approved.planDigest,
    databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
    postMigrationHead: approved.input.postMigrationHead,
    postSchemaDigest: approved.input.expectedSchemaDigest,
    configurationFingerprint: sha256Canonical({
      classificationDigest: currentPlan.identity.classificationDigest,
      statementLogDigest: sha256Canonical(operationStatements),
      writes: actual
    }),
    postconditions,
    observedAt: (context.now?.() ?? new Date()).toISOString()
  });
}

export async function reconcileReturnClosureBackfill(context, prior) {
  assertContext(context, prior.input);
  assertApprovedPlan(prior.approvedPlan, prior.planDigest);
  const { snapshot, classification } = await classifyContext(context);
  const reconciled = reconciliationState(prior.approvedPlan, snapshot, classification);
  assertReturnClosureDmlStatements(context.statementLog ?? []);
  if (
    !reconciled.complete ||
    reconciled.paymentWriteOffAuthorityFingerprint !==
      prior.approvedPlan.identity.paymentWriteOffAuthorityFingerprint
  ) {
    throw runnerError("RETURN_CLOSURE_RECONCILE_INCOMPLETE");
  }
  return deepFreeze({
    schemaVersion: "stage1-return-closure-backfill-reconcile-result.v1",
    planDigest: prior.planDigest,
    postconditions: [
      postcondition("replay-has-no-duplicate-side-effects", reconciled.expected, reconciled.actual),
      postcondition(
        "payment-writeoff-authority-unchanged",
        prior.approvedPlan.identity.paymentWriteOffAuthorityFingerprint,
        reconciled.paymentWriteOffAuthorityFingerprint
      )
    ],
    terminalStatus: "PASSED"
  });
}

export async function stage1ReturnClosureBackfillHandler({ baseline, request, database }) {
  if (request.phase === "dry-run") {
    const plan = await planReturnClosureBackfill(database, request.input);
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applyReturnClosureBackfill(database, {
      input: request.input,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const reconciliation = await reconcileReturnClosureBackfill(database, {
      input: request.input,
      planDigest: request.planDigest,
      approvedPlan: request.approvedPlan
    });
    return Object.freeze({ baseline, reconciliation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
