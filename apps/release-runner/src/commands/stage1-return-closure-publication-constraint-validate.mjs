import {
  assertCustodyComplete,
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical,
  validateContract
} from "@subscription-saas/release-foundation";

import { runnerError } from "../error-codes.mjs";

const DML_COMMAND_ID = "stage1.return-closure.backfill";
const DML_COMMAND_VERSION = "1";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OID = /^[1-9][0-9]*$/;
const CONSTRAINT_SCHEMA = "public";
const CONSTRAINT_TABLE = "subscription_closure_settlement_revision";
const CONSTRAINT_NAME = "subscription_closure_settlement_publication_check";
const EXPECTED_CONSTRAINT_DEFINITION =
  "CHECK (stage = 'FINALIZED'::subscription_closure_settlement_stage AND published_at IS NOT NULL AND publication_snapshot IS NOT NULL OR stage <> 'FINALIZED'::subscription_closure_settlement_stage AND published_at IS NULL AND publication_snapshot IS NULL)";
const EXPECTED_CONSTRAINT_DEFINITION_HASH =
  "sha256:b5392a8226c41e0cff31766254e9e6d4d1fd1b03e8d35854548863768436f2e1";
const VALIDATE_CONSTRAINT_SQL =
  'ALTER TABLE "public"."subscription_closure_settlement_revision" VALIDATE CONSTRAINT "subscription_closure_settlement_publication_check"';
const BUSINESS_DML = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/iu;
const DDL = /\b(?:ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|VACUUM|REINDEX|CLUSTER)\b/iu;
const READ_ONLY_OR_LOCK = /^(?:SELECT\b|WITH\b|SHOW\b|SET\s+LOCAL\b|LOCK\s+TABLE\b)/iu;
const DEFINITE_POSTGRES_TRANSACTION_FAILURES = new Set([
  "23514",
  "40001",
  "40P01",
  "42501",
  "55P03",
  "57014"
]);

function dependencyError(code = "RETURN_CLOSURE_DML_PROOF_CHAIN_INVALID", details) {
  throw runnerError(code, details);
}

function validateArtifact(schemaId, value) {
  try {
    validateContract(schemaId, value);
  } catch (error) {
    dependencyError("RETURN_CLOSURE_DML_PROOF_CHAIN_INVALID", {
      schemaId,
      cause: error?.code
    });
  }
}

function assertProofIdentity(proof, request, phases) {
  if (
    proof.status !== "SUCCEEDED" ||
    !phases.includes(proof.phase) ||
    proof.command.id !== DML_COMMAND_ID ||
    proof.command.version !== DML_COMMAND_VERSION ||
    proof.command.capability !== "repair" ||
    proof.buildProofDigest !== request.buildProofDigest ||
    proof.baselineManifestIdentityDigest !== request.baselineManifestIdentityDigest ||
    proof.baselineManifestDigest !== request.baselineManifestDigest ||
    proof.databaseIdentityFingerprint !== request.databaseIdentityDigest ||
    proof.postconditionsStatus !== "PASSED"
  ) {
    dependencyError();
  }
}

function assertReleaseCustody(receipt, expectedDigest) {
  assertCustodyComplete(receipt, expectedDigest);
  if (
    receipt.owner !== "release-engineering" ||
    receipt.expiryDisposition !== "review" ||
    JSON.stringify(receipt.readers) !== JSON.stringify(["release", "qa", "security", "audit"])
  ) {
    throw runnerError("RETURN_CLOSURE_DML_PROOF_CUSTODY_REQUIRED");
  }
}

export function verifyReturnClosureDmlProofDependencies({ request, artifacts }) {
  const applyProof = artifacts?.applyExecutionProof;
  const applyObservation = artifacts?.applyPostStateObservation;
  const replayProof = artifacts?.replayExecutionProof;
  validateArtifact("build-proof.v1", artifacts?.buildProof);
  validateArtifact("execution-proof.v1", applyProof);
  validateArtifact("post-state-observation.v1", applyObservation);
  validateArtifact("execution-proof.v1", replayProof);
  if (
    sha256Canonical(artifacts.buildProof) !== request?.buildProofDigest ||
    sha256Canonical(request?.buildProof) !== request?.buildProofDigest ||
    request?.input?.buildProofDigest !== request?.buildProofDigest ||
    request?.input?.sourceSha !== artifacts.buildProof.identity.sourceSha ||
    request?.input?.migrationCatalogDigest !==
      artifacts.buildProof.identity.migrationCatalogDigest ||
    request?.input?.repositoryContractDigest !==
      artifacts.buildProof.identity.repositoryContractDigest ||
    request?.input?.baselineManifestIdentityDigest !== request?.baselineManifestIdentityDigest ||
    request?.input?.baselineManifestDigest !== request?.baselineManifestDigest ||
    request?.input?.databaseIdentityFingerprint !== request?.databaseIdentityDigest ||
    request?.input?.operationId !== request?.operationId ||
    sha256Canonical(applyProof) !== request?.input?.dmlApplyExecutionProofDigest ||
    sha256Canonical(applyObservation) !== request?.input?.dmlApplyPostStateObservationDigest ||
    sha256Canonical(replayProof) !== request?.input?.dmlReplayExecutionProofDigest
  ) {
    dependencyError();
  }
  assertProofIdentity(applyProof, request, ["apply"]);
  assertProofIdentity(replayProof, request, ["replay", "reconcile"]);
  if (
    applyProof.operationId !== applyObservation.operationId ||
    applyProof.attemptId !== applyObservation.attemptId ||
    applyProof.postStateObservationDigest !== sha256Canonical(applyObservation) ||
    applyProof.outputDigest !== sha256Canonical(applyObservation) ||
    replayProof.operationId !== applyProof.operationId ||
    replayProof.planDigest !== applyProof.planDigest ||
    replayProof.predecessorProofDigest !== sha256Canonical(applyProof)
  ) {
    dependencyError();
  }
  if (
    request.input.operationId === applyProof.operationId ||
    Object.hasOwn(request.input, "dmlPlan") ||
    Object.hasOwn(request.input, "dmlApproval")
  ) {
    dependencyError("RETURN_CLOSURE_DML_DDL_BATCHING_FORBIDDEN");
  }
  try {
    assertReleaseCustody(artifacts?.custody?.applyExecutionProof, sha256Canonical(applyProof));
    assertReleaseCustody(
      artifacts?.custody?.applyPostStateObservation,
      sha256Canonical(applyObservation)
    );
    assertReleaseCustody(artifacts?.custody?.replayExecutionProof, sha256Canonical(replayProof));
  } catch (error) {
    dependencyError("RETURN_CLOSURE_DML_PROOF_CUSTODY_REQUIRED", {
      cause: error?.code
    });
  }
  return Object.freeze({
    applyExecutionProofDigest: sha256Canonical(applyProof),
    applyPostStateObservationDigest: sha256Canonical(applyObservation),
    replayExecutionProofDigest: sha256Canonical(replayProof),
    dmlPlanDigest: applyProof.planDigest,
    dmlOperationId: applyProof.operationId
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function normalizeConstraintDefinition(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+NOT\s+VALID$/iu, "")
    .replace(/\s+/gu, " ");
}

function assertCommandContext(context, input) {
  const prisma = context?.prisma ?? context;
  if (
    (typeof context?.observePublicationConstraint !== "function" &&
      typeof prisma?.$queryRawUnsafe !== "function") ||
    !DIGEST.test(context?.databaseIdentityFingerprint ?? "")
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
  if (
    !Array.isArray(context.grantedCapabilityProfiles) ||
    context.grantedCapabilityProfiles.length !== 1 ||
    context.grantedCapabilityProfiles[0] !== "migrate"
  ) {
    throw runnerError("RUNNER_CAPABILITY_CREDENTIAL_MISMATCH");
  }
  if (context.databaseIdentityFingerprint !== input?.databaseIdentityFingerprint) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
}

const CONSTRAINT_CATALOG_SQL = `
SELECT
  n.nspname AS "schema",
  c.relname AS "table",
  c.oid::text AS "tableOid",
  con.conname AS "name",
  con.oid::text AS "constraintOid",
  pg_get_constraintdef(con.oid, true) AS "definition",
  con.convalidated AS "convalidated"
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND con.conname = $3 AND con.contype = 'c'
`.trim();
const CONSTRAINT_VIOLATION_SQL = `
SELECT COUNT(*)::int AS "violationCount"
FROM "public"."subscription_closure_settlement_revision"
WHERE NOT (
  ("stage" = 'FINALIZED' AND "published_at" IS NOT NULL AND "publication_snapshot" IS NOT NULL)
  OR ("stage" <> 'FINALIZED' AND "published_at" IS NULL AND "publication_snapshot" IS NULL)
)
`.trim();

async function observePublicationConstraint(context) {
  if (typeof context?.observePublicationConstraint === "function") {
    return context.observePublicationConstraint();
  }
  const prisma = context?.prisma ?? context;
  context.statementLog?.push(CONSTRAINT_CATALOG_SQL, CONSTRAINT_VIOLATION_SQL);
  const [constraints, violations] = await Promise.all([
    prisma.$queryRawUnsafe(
      CONSTRAINT_CATALOG_SQL,
      CONSTRAINT_SCHEMA,
      CONSTRAINT_TABLE,
      CONSTRAINT_NAME
    ),
    prisma.$queryRawUnsafe(CONSTRAINT_VIOLATION_SQL)
  ]);
  if (constraints?.length !== 1 || violations?.length !== 1) {
    throw runnerError("RETURN_CLOSURE_PUBLICATION_CONSTRAINT_OBSERVATION_INVALID");
  }
  return { ...constraints[0], violationCount: violations[0].violationCount };
}

function assertDependencyBinding(input, dependencies) {
  if (
    !dependencies ||
    input?.operationId === dependencies.dmlOperationId ||
    input?.dmlApplyExecutionProofDigest !== dependencies.applyExecutionProofDigest ||
    input?.dmlApplyPostStateObservationDigest !== dependencies.applyPostStateObservationDigest ||
    input?.dmlReplayExecutionProofDigest !== dependencies.replayExecutionProofDigest ||
    !DIGEST.test(dependencies.dmlPlanDigest ?? "")
  ) {
    throw runnerError("RETURN_CLOSURE_DML_PROOF_CHAIN_INVALID");
  }
}

function constraintIdentity(observed) {
  const normalizedDefinition = normalizeConstraintDefinition(observed?.definition);
  const definitionHash = sha256Canonical(normalizedDefinition);
  if (
    observed?.schema !== CONSTRAINT_SCHEMA ||
    observed?.table !== CONSTRAINT_TABLE ||
    observed?.name !== CONSTRAINT_NAME ||
    !OID.test(observed?.tableOid ?? "") ||
    !OID.test(observed?.constraintOid ?? "") ||
    normalizedDefinition !== EXPECTED_CONSTRAINT_DEFINITION ||
    definitionHash !== EXPECTED_CONSTRAINT_DEFINITION_HASH
  ) {
    throw runnerError("RETURN_CLOSURE_PUBLICATION_CONSTRAINT_IDENTITY_MISMATCH");
  }
  if (!Number.isSafeInteger(observed?.violationCount) || observed.violationCount < 0) {
    throw runnerError("RETURN_CLOSURE_PUBLICATION_CONSTRAINT_OBSERVATION_INVALID");
  }
  if (observed.violationCount !== 0) {
    throw runnerError("RETURN_CLOSURE_PUBLICATION_CONSTRAINT_VIOLATIONS", {
      violationCount: observed.violationCount
    });
  }
  return deepFreeze({
    schema: CONSTRAINT_SCHEMA,
    table: CONSTRAINT_TABLE,
    tableOid: observed.tableOid,
    name: CONSTRAINT_NAME,
    constraintOid: observed.constraintOid,
    definitionHash,
    convalidated: observed.convalidated === true,
    violationCount: observed.violationCount
  });
}

export async function planReturnClosurePublicationConstraintValidation(
  context,
  input,
  dependencies
) {
  assertCommandContext(context, input);
  assertDependencyBinding(input, dependencies);
  const observed = constraintIdentity(await observePublicationConstraint(context));
  return deepFreeze({
    schemaVersion: "deterministic-plan.v1",
    identity: {
      planType: "stage1-return-closure-publication-constraint-plan.v1",
      commandKey: "stage1.return-closure.publication-constraint.validate@1",
      inputDigest: sha256Canonical(input),
      buildProofDigest: input.buildProofDigest,
      sourceSha: input.sourceSha,
      migrationCatalogDigest: input.migrationCatalogDigest,
      repositoryContractDigest: input.repositoryContractDigest,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      dmlProofDependencies: { ...dependencies },
      action: observed.convalidated ? "noop" : "validate",
      constraint: observed,
      lock: {
        advisoryKey: "database-migration-advisory-lock",
        tableLockMode: "SHARE UPDATE EXCLUSIVE",
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 300_000
      }
    },
    provenance: {
      planner: "stage1.return-closure.publication-constraint.validate@1",
      generatedAt: input.generatedAt
    }
  });
}

function statementText(statement) {
  if (typeof statement === "string") return statement.trim().replace(/;$/u, "");
  if (typeof statement?.sql === "string") return statement.sql.trim().replace(/;$/u, "");
  throw runnerError("RETURN_CLOSURE_CONSTRAINT_STATEMENT_EVIDENCE_INVALID");
}

export function assertReturnClosureConstraintDdlStatements(statements, expectedAction) {
  if (!Array.isArray(statements)) {
    throw runnerError("RETURN_CLOSURE_CONSTRAINT_STATEMENT_LOG_MISSING");
  }
  const normalized = statements.map(statementText);
  if (normalized.some((sql) => BUSINESS_DML.test(sql))) {
    throw runnerError("RETURN_CLOSURE_CONSTRAINT_BUSINESS_DML_FORBIDDEN");
  }
  const expected = expectedAction === "validate" ? [VALIDATE_CONSTRAINT_SQL] : [];
  const ddlStatements = normalized.filter((sql) => DDL.test(sql));
  if (
    normalized.some((sql) => !DDL.test(sql) && !READ_ONLY_OR_LOCK.test(sql)) ||
    ddlStatements.length !== expected.length ||
    ddlStatements.some((sql, index) => sql !== expected[index])
  ) {
    throw runnerError("RETURN_CLOSURE_CONSTRAINT_DDL_STATEMENT_FORBIDDEN");
  }
  return ddlStatements;
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

function postDdlUnknown(error) {
  const cause =
    error instanceof Error ? error : new Error("RETURN_CLOSURE_CONSTRAINT_POST_STATE_UNKNOWN");
  cause.outcomeUnknown = true;
  cause.commitState = "committed-result-unproved";
  return cause;
}

function assertApplyContext(context) {
  const prisma = context?.prisma ?? context;
  if (
    (typeof context?.withPublicationConstraintLock !== "function" &&
      typeof prisma?.$transaction !== "function") ||
    (typeof context?.executePublicationConstraintValidation !== "function" &&
      typeof prisma?.$executeRawUnsafe !== "function") ||
    !Array.isArray(context?.statementLog)
  ) {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING");
  }
}

async function withPublicationConstraintLock(context, options, callback) {
  if (typeof context.withPublicationConstraintLock === "function") {
    return context.withPublicationConstraintLock(options, (lockedContext) =>
      callback(lockedContext ?? context)
    );
  }
  const prisma = context.prisma ?? context;
  return prisma.$transaction(
    async (tx) => {
      const lockedContext = { ...context, prisma: tx };
      const lockTimeoutSql = "SET LOCAL lock_timeout = '5s'";
      const statementTimeoutSql = "SET LOCAL statement_timeout = '300s'";
      const tableLockSql =
        'LOCK TABLE "public"."subscription_closure_settlement_revision" IN SHARE UPDATE EXCLUSIVE MODE';
      await tx.$executeRawUnsafe(lockTimeoutSql);
      context.statementLog.push(lockTimeoutSql);
      await tx.$executeRawUnsafe(statementTimeoutSql);
      context.statementLog.push(statementTimeoutSql);
      const advisorySql = "SELECT TRUE AS locked FROM pg_advisory_xact_lock(hashtext($1))";
      await tx.$queryRawUnsafe(advisorySql, options.advisoryKey);
      context.statementLog.push(advisorySql);
      await tx.$executeRawUnsafe(tableLockSql);
      context.statementLog.push(tableLockSql);
      return callback(lockedContext);
    },
    { timeout: options.statementTimeoutMs + options.lockTimeoutMs }
  );
}

async function executePublicationConstraintValidation(context) {
  if (typeof context.executePublicationConstraintValidation === "function") {
    return context.executePublicationConstraintValidation({
      sql: VALIDATE_CONSTRAINT_SQL,
      timeoutMs: 300_000
    });
  }
  const prisma = context.prisma ?? context;
  const result = await prisma.$executeRawUnsafe(VALIDATE_CONSTRAINT_SQL);
  context.statementLog.push(VALIDATE_CONSTRAINT_SQL);
  return result;
}

export async function applyReturnClosurePublicationConstraintValidation(context, approved) {
  assertCommandContext(context, approved?.input);
  assertApplyContext(context);
  assertDependencyBinding(approved.input, approved.dependencies);
  return withPublicationConstraintLock(
    context,
    {
      advisoryKey: "database-migration-advisory-lock",
      schema: CONSTRAINT_SCHEMA,
      table: CONSTRAINT_TABLE,
      tableLockMode: "SHARE UPDATE EXCLUSIVE",
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 300_000
    },
    async (lockedContext) => {
      const currentPlan = await planReturnClosurePublicationConstraintValidation(
        lockedContext,
        approved.input,
        approved.dependencies
      );
      const currentPlanDigest = deterministicPlanDigest(currentPlan);
      if (currentPlanDigest !== approved.planDigest) {
        throw runnerError("PLAN_CHANGED_SINCE_APPROVAL", {
          approvedPlanDigest: approved.planDigest,
          currentPlanDigest
        });
      }
      const statementsBefore = lockedContext.statementLog.length;
      if (currentPlan.identity.action === "validate") {
        try {
          await executePublicationConstraintValidation(lockedContext);
        } catch (error) {
          if (DEFINITE_POSTGRES_TRANSACTION_FAILURES.has(error?.code)) throw error;
          throw postDdlUnknown(error);
        }
      }
      let postConstraint;
      let operationStatements;
      try {
        operationStatements = lockedContext.statementLog.slice(statementsBefore);
        assertReturnClosureConstraintDdlStatements(
          operationStatements,
          currentPlan.identity.action
        );
        postConstraint = constraintIdentity(await observePublicationConstraint(lockedContext));
      } catch (error) {
        if (currentPlan.identity.action === "validate") throw postDdlUnknown(error);
        throw error;
      }
      const expectedPostConstraint = {
        ...currentPlan.identity.constraint,
        convalidated: true
      };
      const postconditions = [
        postcondition(
          "approved-constraint-identity-recomputed-under-lock",
          approved.planDigest,
          currentPlanDigest
        ),
        postcondition("constraint-violation-count-zero", 0, postConstraint.violationCount),
        postcondition("constraint-validated", expectedPostConstraint, postConstraint),
        postcondition(
          "statement-log-has-one-allowed-ddl-and-no-business-dml",
          currentPlan.identity.action === "validate" ? [VALIDATE_CONSTRAINT_SQL] : [],
          assertReturnClosureConstraintDdlStatements(
            operationStatements,
            currentPlan.identity.action
          )
        )
      ];
      if (postconditions.some(({ status }) => status !== "PASSED")) {
        if (currentPlan.identity.action === "validate") {
          throw postDdlUnknown(runnerError("RETURN_CLOSURE_CONSTRAINT_POSTCONDITION_FAILED"));
        }
        throw runnerError("RETURN_CLOSURE_CONSTRAINT_POSTCONDITION_FAILED");
      }
      return buildPostStateObservation({
        operationId: approved.input.operationId,
        attemptId: approved.input.attemptId,
        runId: approved.input.runId,
        baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
        baselineManifestDigest: approved.input.baselineManifestDigest,
        commandId: "stage1.return-closure.publication-constraint.validate",
        commandVersion: "1",
        planDigest: approved.planDigest,
        databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
        postMigrationHead: approved.input.postMigrationHead,
        postSchemaDigest: approved.input.expectedSchemaDigest,
        configurationFingerprint: sha256Canonical({
          constraint: postConstraint,
          dmlProofDependencies: approved.dependencies,
          statementLogDigest: sha256Canonical(operationStatements.map(statementText))
        }),
        postconditions,
        observedAt: (lockedContext.now?.() ?? new Date()).toISOString()
      });
    }
  );
}

export async function reconcileReturnClosurePublicationConstraintValidation(context, prior) {
  assertCommandContext(context, prior?.input);
  assertDependencyBinding(prior.input, prior.dependencies);
  if (
    prior?.approvedPlan?.schemaVersion !== "deterministic-plan.v1" ||
    prior.approvedPlan?.identity?.commandKey !==
      "stage1.return-closure.publication-constraint.validate@1" ||
    deterministicPlanDigest(prior.approvedPlan) !== prior.planDigest
  ) {
    throw runnerError("APPROVED_PLAN_INVALID");
  }
  const statementsBefore = Array.isArray(context.statementLog) ? context.statementLog.length : null;
  const observed = constraintIdentity(await observePublicationConstraint(context));
  if (statementsBefore === null || !Array.isArray(context.statementLog)) {
    throw runnerError("RETURN_CLOSURE_CONSTRAINT_STATEMENT_LOG_MISSING");
  }
  const operationStatements = context.statementLog.slice(statementsBefore);
  const ddlStatements = assertReturnClosureConstraintDdlStatements(operationStatements, "noop");
  const expected = {
    ...prior.approvedPlan.identity.constraint,
    convalidated: true
  };
  if (sha256Canonical(observed) !== sha256Canonical(expected)) {
    throw runnerError("RETURN_CLOSURE_CONSTRAINT_RECONCILE_INCOMPLETE");
  }
  return deepFreeze({
    schemaVersion: "stage1-return-closure-publication-constraint-reconcile-result.v1",
    planDigest: prior.planDigest,
    constraint: observed,
    postconditions: [
      postcondition("constraint-validated", expected, observed),
      postcondition("reconcile-is-read-only", [], ddlStatements)
    ],
    terminalStatus: "PASSED"
  });
}

export async function stage1ReturnClosurePublicationConstraintValidateHandler({
  baseline,
  request,
  database,
  commandDependencies
}) {
  if (request.phase === "dry-run") {
    const plan = await planReturnClosurePublicationConstraintValidation(
      database,
      request.input,
      commandDependencies
    );
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applyReturnClosurePublicationConstraintValidation(database, {
      input: request.input,
      dependencies: commandDependencies,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const reconciliation = await reconcileReturnClosurePublicationConstraintValidation(database, {
      input: request.input,
      dependencies: commandDependencies,
      approvedPlan: request.approvedPlan,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, reconciliation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
