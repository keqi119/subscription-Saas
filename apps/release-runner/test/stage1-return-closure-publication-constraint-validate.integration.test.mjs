import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionProof,
  buildPostStateObservation,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";
import { commandApprovalMode, loadCommandRegistry } from "../src/command-registry.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const sourceSha = "a".repeat(40);
const manifestIdentityDigest = digest("1");
const manifestDigest = digest("2");
const databaseIdentityFingerprint = digest("3");
const dmlPlanDigest = digest("4");
const normalizedConstraintDefinition =
  "CHECK (stage = 'FINALIZED'::subscription_closure_settlement_stage AND published_at IS NOT NULL AND publication_snapshot IS NOT NULL OR stage <> 'FINALIZED'::subscription_closure_settlement_stage AND published_at IS NULL AND publication_snapshot IS NULL)";
const expectedConstraintDefinitionHash =
  "sha256:b5392a8226c41e0cff31766254e9e6d4d1fd1b03e8d35854548863768436f2e1";

test("registers the isolated publication constraint DDL handler", () => {
  const commandKey = "stage1.return-closure.publication-constraint.validate@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("requires an independent migrate approval policy for each supported environment", async () => {
  const registry = await loadCommandRegistry();
  const command = registry.commands.find(
    ({ commandId }) => commandId === "stage1.return-closure.publication-constraint.validate"
  );
  assert.equal(command.capabilityProfile, "migrate");
  assert.equal(command.dataImpact, "ddl");
  assert.equal(commandApprovalMode(command, "ci-fresh", "apply"), "ci-policy");
  assert.equal(commandApprovalMode(command, "ci-snapshot", "apply"), "ci-policy");
  assert.equal(commandApprovalMode(command, "staging", "apply"), "human");
  assert.equal(commandApprovalMode(command, "staging", "dry-run"), "none");
});

test("accepts only a matching, fully custodied DML apply and replay proof chain", async () => {
  const { verifyReturnClosureDmlProofDependencies } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const request = dependencyRequest(chain);
  const verified = verifyReturnClosureDmlProofDependencies({
    request,
    artifacts: chain
  });
  assert.deepEqual(verified, {
    applyExecutionProofDigest: sha256Canonical(chain.applyExecutionProof),
    applyPostStateObservationDigest: sha256Canonical(chain.applyPostStateObservation),
    replayExecutionProofDigest: sha256Canonical(chain.replayExecutionProof),
    dmlPlanDigest,
    dmlOperationId: chain.applyExecutionProof.operationId
  });

  const missingCustody = structuredClone(chain);
  delete missingCustody.custody.applyExecutionProof;
  assert.throws(
    () =>
      verifyReturnClosureDmlProofDependencies({
        request,
        artifacts: missingCustody
      }),
    { code: "RETURN_CLOSURE_DML_PROOF_CUSTODY_REQUIRED" }
  );
});

test("rejects a DDL input identity that is not the same release and database as the DML proof", async () => {
  const { verifyReturnClosureDmlProofDependencies } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const request = dependencyRequest(chain);
  request.input.sourceSha = "f".repeat(40);
  assert.throws(() => verifyReturnClosureDmlProofDependencies({ request, artifacts: chain }), {
    code: "RETURN_CLOSURE_DML_PROOF_CHAIN_INVALID"
  });
});

test("rejects an apply proof whose claimed output is not its custodied post-state observation", async () => {
  const { verifyReturnClosureDmlProofDependencies } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = structuredClone(dmlProofChain());
  chain.applyExecutionProof.outputDigest = digest("1");
  chain.replayExecutionProof.predecessorProofDigest = sha256Canonical(chain.applyExecutionProof);
  chain.custody.applyExecutionProof = receipt(
    chain.applyExecutionProof,
    "11111111-1111-4111-8111-111111111111"
  );
  chain.custody.replayExecutionProof = receipt(
    chain.replayExecutionProof,
    "33333333-3333-4333-8333-333333333333"
  );
  assert.throws(
    () =>
      verifyReturnClosureDmlProofDependencies({
        request: dependencyRequest(chain),
        artifacts: chain
      }),
    { code: "RETURN_CLOSURE_DML_PROOF_CHAIN_INVALID" }
  );
});

test("rejects proof receipts outside the approved release evidence custody policy", async () => {
  const { verifyReturnClosureDmlProofDependencies } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = structuredClone(dmlProofChain());
  chain.custody.applyExecutionProof.owner = "untrusted-operator";
  assert.throws(
    () =>
      verifyReturnClosureDmlProofDependencies({
        request: dependencyRequest(chain),
        artifacts: chain
      }),
    { code: "RETURN_CLOSURE_DML_PROOF_CUSTODY_REQUIRED" }
  );
});

test("rejects failed, cross-release, cross-Manifest, cross-database and wrong-command proofs", async () => {
  const { verifyReturnClosureDmlProofDependencies } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const mutations = [
    (chain) => (chain.applyExecutionProof.status = "FAILED"),
    (chain) => (chain.replayExecutionProof.buildProofDigest = digest("f")),
    (chain) => (chain.replayExecutionProof.baselineManifestDigest = digest("f")),
    (chain) => (chain.replayExecutionProof.databaseIdentityFingerprint = digest("f")),
    (chain) => (chain.replayExecutionProof.command.id = "stage1.period.backfill")
  ];
  for (const mutate of mutations) {
    const chain = structuredClone(dmlProofChain());
    mutate(chain);
    chain.custody.applyExecutionProof = receipt(
      chain.applyExecutionProof,
      "11111111-1111-4111-8111-111111111111"
    );
    chain.custody.replayExecutionProof = receipt(
      chain.replayExecutionProof,
      "33333333-3333-4333-8333-333333333333"
    );
    assert.throws(
      () =>
        verifyReturnClosureDmlProofDependencies({
          request: dependencyRequest(chain),
          artifacts: chain
        }),
      { code: "RETURN_CLOSURE_DML_PROOF_CHAIN_INVALID" }
    );
  }
});

test("rejects a combined DML and DDL operation identity or bundled approval input", async () => {
  const { verifyReturnClosureDmlProofDependencies } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  for (const mutate of [
    (request) => {
      request.operationId = chain.applyExecutionProof.operationId;
      request.input.operationId = chain.applyExecutionProof.operationId;
    },
    (request) => (request.input.dmlApproval = { approvalId: "combined" })
  ]) {
    const request = dependencyRequest(chain);
    mutate(request);
    assert.throws(() => verifyReturnClosureDmlProofDependencies({ request, artifacts: chain }), {
      code: "RETURN_CLOSURE_DML_DDL_BATCHING_FORBIDDEN"
    });
  }
});

test("plans the exact unvalidated constraint only after the independent DML proof chain", async () => {
  const { planReturnClosurePublicationConstraintValidation } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const dependencies = dependencySummary(chain);
  const context = constraintContext();
  const plan = await planReturnClosurePublicationConstraintValidation(
    context,
    ddlInput(chain),
    dependencies
  );
  assert.deepEqual(plan.identity.constraint, {
    schema: "public",
    table: "subscription_closure_settlement_revision",
    tableOid: "16389",
    name: "subscription_closure_settlement_publication_check",
    constraintOid: "16394",
    definitionHash: expectedConstraintDefinitionHash,
    convalidated: false,
    violationCount: 0
  });
  assert.equal(plan.identity.action, "validate");
  assert.deepEqual(plan.identity.dmlProofDependencies, dependencies);
  assert.equal(context.calls[0], "observe");

  const violated = constraintContext({ violationCount: 1 });
  await assert.rejects(
    () => planReturnClosurePublicationConstraintValidation(violated, ddlInput(chain), dependencies),
    { code: "RETURN_CLOSURE_PUBLICATION_CONSTRAINT_VIOLATIONS" }
  );
});

test("recomputes the approved DDL plan under the fixed lock order and validates exactly once", async () => {
  const {
    applyReturnClosurePublicationConstraintValidation,
    planReturnClosurePublicationConstraintValidation
  } = await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const dependencies = dependencySummary(chain);
  const input = ddlInput(chain);
  const context = constraintContext();
  const plan = await planReturnClosurePublicationConstraintValidation(context, input, dependencies);
  context.calls.splice(0);
  const postState = await applyReturnClosurePublicationConstraintValidation(context, {
    input,
    dependencies,
    planDigest: sha256Canonical({
      schemaVersion: "deterministic-plan-digest.v1",
      identity: plan.identity
    })
  });
  assert.deepEqual(context.calls, [
    "lock:database-migration-advisory-lock",
    "timeout:5000:300000",
    "table-lock:public.subscription_closure_settlement_revision:SHARE UPDATE EXCLUSIVE",
    "observe",
    'ddl:ALTER TABLE "public"."subscription_closure_settlement_revision" VALIDATE CONSTRAINT "subscription_closure_settlement_publication_check"',
    "observe"
  ]);
  assert.equal(
    postState.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
  assert.equal(context.state.convalidated, true);
});

test("treats an already validated exact constraint as a read-only replay no-op", async () => {
  const {
    applyReturnClosurePublicationConstraintValidation,
    planReturnClosurePublicationConstraintValidation
  } = await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const dependencies = dependencySummary(chain);
  const input = ddlInput(chain);
  const context = constraintContext({ convalidated: true });
  const plan = await planReturnClosurePublicationConstraintValidation(context, input, dependencies);
  assert.equal(plan.identity.action, "noop");
  context.calls.splice(0);
  await applyReturnClosurePublicationConstraintValidation(context, {
    input,
    dependencies,
    planDigest: planDigest(plan)
  });
  assert.equal(
    context.calls.some((call) => call.startsWith("ddl:")),
    false
  );
  assert.deepEqual(context.statementLog, []);
});

test("marks a lost validation result UNKNOWN and reconciles by exact catalog state without DDL", async () => {
  const {
    applyReturnClosurePublicationConstraintValidation,
    planReturnClosurePublicationConstraintValidation,
    reconcileReturnClosurePublicationConstraintValidation
  } = await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const dependencies = dependencySummary(chain);
  const input = ddlInput(chain);
  const context = constraintContext();
  const plan = await planReturnClosurePublicationConstraintValidation(context, input, dependencies);
  const digestValue = planDigest(plan);
  context.executePublicationConstraintValidation = async function ({ sql }) {
    this.calls.push(`ddl:${sql}`);
    this.statementLog.push(sql);
    this.state.convalidated = true;
    throw Object.assign(new Error("connection-lost"), { code: "CONNECTION_LOST" });
  };
  await assert.rejects(
    () =>
      applyReturnClosurePublicationConstraintValidation(context, {
        input,
        dependencies,
        planDigest: digestValue
      }),
    (error) =>
      error.code === "CONNECTION_LOST" &&
      error.outcomeUnknown === true &&
      error.commitState === "committed-result-unproved"
  );
  const callsBeforeReconcile = context.calls.length;
  context.statementLog.splice(0);
  const reconciled = await reconcileReturnClosurePublicationConstraintValidation(context, {
    input,
    dependencies,
    approvedPlan: plan,
    planDigest: digestValue
  });
  assert.equal(reconciled.terminalStatus, "PASSED");
  assert.equal(
    context.calls.slice(callsBeforeReconcile).some((call) => call.startsWith("ddl:")),
    false
  );
});

test("keeps a definite PostgreSQL validation failure separate from the proven DML operation", async () => {
  const {
    applyReturnClosurePublicationConstraintValidation,
    planReturnClosurePublicationConstraintValidation
  } = await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const dependencies = dependencySummary(chain);
  const input = ddlInput(chain);
  const context = constraintContext();
  const plan = await planReturnClosurePublicationConstraintValidation(context, input, dependencies);
  context.executePublicationConstraintValidation = async () => {
    throw Object.assign(new Error("check violation"), { code: "23514" });
  };
  await assert.rejects(
    () =>
      applyReturnClosurePublicationConstraintValidation(context, {
        input,
        dependencies,
        planDigest: planDigest(plan)
      }),
    (error) => error.code === "23514" && error.outcomeUnknown !== true
  );
  assert.equal(context.state.convalidated, false);
  assert.deepEqual(dependencies, dependencySummary(chain));
});

test("dispatches dry-run with the pre-credential verified DML dependency summary", async () => {
  const chain = dmlProofChain();
  const dependencies = dependencySummary(chain);
  const context = constraintContext();
  const handler = commandHandlers.get("stage1.return-closure.publication-constraint.validate@1");
  const result = await handler({
    baseline: { databaseName: "s1ci_task23b" },
    request: { phase: "dry-run", input: ddlInput(chain) },
    database: context,
    commandDependencies: dependencies
  });
  assert.equal(result.terminalStatus, "PASSED");
  assert.equal(result.plan.identity.action, "validate");
  assert.equal(result.planDigest, planDigest(result.plan));
});

test("uses the migration Prisma identity for exact catalog reads, locks, timeouts and validation", async () => {
  const {
    applyReturnClosurePublicationConstraintValidation,
    planReturnClosurePublicationConstraintValidation
  } = await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const dependencies = dependencySummary(chain);
  const input = ddlInput(chain);
  const context = prismaConstraintContext();
  const plan = await planReturnClosurePublicationConstraintValidation(context, input, dependencies);
  await applyReturnClosurePublicationConstraintValidation(context, {
    input,
    dependencies,
    planDigest: planDigest(plan)
  });
  assert.deepEqual(
    context.calls.filter(({ type }) => type !== "query"),
    [
      { type: "transaction" },
      { type: "execute", sql: "SET LOCAL lock_timeout = '5s'" },
      { type: "execute", sql: "SET LOCAL statement_timeout = '300s'" },
      {
        type: "execute",
        sql: 'LOCK TABLE "public"."subscription_closure_settlement_revision" IN SHARE UPDATE EXCLUSIVE MODE'
      },
      {
        type: "execute",
        sql: 'ALTER TABLE "public"."subscription_closure_settlement_revision" VALIDATE CONSTRAINT "subscription_closure_settlement_publication_check"'
      }
    ]
  );
  assert.equal(context.state.convalidated, true);
});

test("rejects wrong or combined capability identities before catalog reads", async () => {
  const { planReturnClosurePublicationConstraintValidation } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  for (const profiles of [["repair"], ["migrate", "repair"]]) {
    const context = constraintContext();
    context.grantedCapabilityProfiles = profiles;
    await assert.rejects(
      () =>
        planReturnClosurePublicationConstraintValidation(
          context,
          ddlInput(chain),
          dependencySummary(chain)
        ),
      { code: "RUNNER_CAPABILITY_CREDENTIAL_MISMATCH" }
    );
    assert.deepEqual(context.calls, []);
  }
});

test("rejects business DML and any DDL other than the exact validation statement", async () => {
  const { assertReturnClosureConstraintDdlStatements } =
    await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  assert.throws(
    () =>
      assertReturnClosureConstraintDdlStatements(
        ['UPDATE "subscription_closure_case" SET "financial_status" = $1'],
        "noop"
      ),
    { code: "RETURN_CLOSURE_CONSTRAINT_BUSINESS_DML_FORBIDDEN" }
  );
  assert.throws(
    () =>
      assertReturnClosureConstraintDdlStatements(
        ['ALTER TABLE "public"."subscription_closure_case" VALIDATE CONSTRAINT "other"'],
        "validate"
      ),
    { code: "RETURN_CLOSURE_CONSTRAINT_DDL_STATEMENT_FORBIDDEN" }
  );
});

test("rejects constraint identity drift under lock before issuing DDL", async () => {
  const {
    applyReturnClosurePublicationConstraintValidation,
    planReturnClosurePublicationConstraintValidation
  } = await import("../src/commands/stage1-return-closure-publication-constraint-validate.mjs");
  const chain = dmlProofChain();
  const dependencies = dependencySummary(chain);
  const input = ddlInput(chain);
  const context = constraintContext();
  const plan = await planReturnClosurePublicationConstraintValidation(context, input, dependencies);
  context.withPublicationConstraintLock = async (_options, callback) => {
    context.state.constraintOid = "17394";
    return callback();
  };
  await assert.rejects(
    () =>
      applyReturnClosurePublicationConstraintValidation(context, {
        input,
        dependencies,
        planDigest: planDigest(plan)
      }),
    { code: "PLAN_CHANGED_SINCE_APPROVAL" }
  );
  assert.equal(
    context.calls.some((call) => call.startsWith("ddl:")),
    false
  );
});

function planDigest(plan) {
  return sha256Canonical({
    schemaVersion: "deterministic-plan-digest.v1",
    identity: plan.identity
  });
}

function buildProof() {
  const image = (name, character) => ({
    name,
    registry: `ghcr.io/example/${name}`,
    platform: "linux/amd64",
    imageDigest: digest(character),
    sourceRevision: sourceSha
  });
  return {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      images: {
        api: image("api", "5"),
        web: image("web", "6"),
        runner: image("runner", "7")
      },
      sourceSha,
      migrationCatalogDigest: digest("8"),
      repositoryContractDigest: digest("9")
    },
    provenance: {
      generatedAt: "2026-09-02T09:00:00.000Z",
      ciRunRef: "ci://release/23b",
      attestationRef: "attestation://release/23b",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest("b") }],
      materials: [{ name: "repository", reference: sourceSha }],
      registryResolutionEvidenceDigest: digest("c")
    }
  };
}

function observation({ attemptId, observedAt }) {
  return buildPostStateObservation({
    operationId: "25d422be-1036-470c-a844-fe24735222cf",
    attemptId,
    runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
    baselineManifestIdentityDigest: manifestIdentityDigest,
    baselineManifestDigest: manifestDigest,
    commandId: "stage1.return-closure.backfill",
    commandVersion: "1",
    planDigest: dmlPlanDigest,
    databaseIdentityFingerprint,
    postMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
    postSchemaDigest: digest("d"),
    configurationFingerprint: digest("e"),
    postconditions: [
      {
        id: "return-closure-candidates-reconciled",
        status: "PASSED",
        expectedDigest: digest("f"),
        actualDigest: digest("f")
      }
    ],
    observedAt
  });
}

function executionProof({ phase, attemptId, predecessorProofDigest, postStateObservation }) {
  const proof = buildProof();
  return buildExecutionProof({
    postStateObservation,
    operationId: postStateObservation.operationId,
    attemptId,
    phase,
    predecessorProofDigest,
    status: "SUCCEEDED",
    buildProofDigest: sha256Canonical(proof),
    baselineManifestIdentityDigest: manifestIdentityDigest,
    baselineManifestDigest: manifestDigest,
    executionScope: "repair",
    command: {
      id: "stage1.return-closure.backfill",
      version: "1",
      capability: "repair",
      approvalMode: "ci-policy"
    },
    databaseIdentityFingerprint,
    inputDigest: digest("0"),
    planDigest: dmlPlanDigest,
    outputDigest: sha256Canonical(postStateObservation),
    postconditionsStatus: "PASSED",
    timing: {
      startedAt: "2026-09-02T09:30:00.000Z",
      completedAt: postStateObservation.observedAt
    },
    toolVersion: "release-runner/0.1.0",
    error: null,
    references: {
      launcher: "launcher://trusted/23b",
      policy: "policy://s1-release-operations",
      approval: "approval://task23a"
    }
  });
}

function receipt(value, receiptId) {
  const contentDigest = sha256Canonical(value);
  const uploadedAt = "2026-09-02T10:00:00.000Z";
  return {
    schemaVersion: "custody-receipt.v1",
    receiptId,
    contentDigest,
    contentSizeBytes: 1,
    storeRef: `evidence/${contentDigest.slice(7)}.json`,
    uploadedAt,
    readbackAt: "2026-09-02T10:00:01.000Z",
    readbackDigest: contentDigest,
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    retainUntil: new Date(Date.parse(uploadedAt) + 180 * 86_400_000).toISOString(),
    expiryDisposition: "review",
    attestationRef: "attestation://custody/23a"
  };
}

function dmlProofChain() {
  const applyPostStateObservation = observation({
    attemptId: "49101a87-aece-4c51-9be0-30233466510b",
    observedAt: "2026-09-02T09:31:00.000Z"
  });
  const applyExecutionProof = executionProof({
    phase: "apply",
    attemptId: applyPostStateObservation.attemptId,
    predecessorProofDigest: digest("a"),
    postStateObservation: applyPostStateObservation
  });
  const replayPostStateObservation = observation({
    attemptId: "5e1d7ea7-caf4-4ef1-9b14-b694c1ba753b",
    observedAt: "2026-09-02T09:32:00.000Z"
  });
  const replayExecutionProof = executionProof({
    phase: "replay",
    attemptId: replayPostStateObservation.attemptId,
    predecessorProofDigest: sha256Canonical(applyExecutionProof),
    postStateObservation: replayPostStateObservation
  });
  return {
    buildProof: buildProof(),
    applyExecutionProof,
    applyPostStateObservation,
    replayExecutionProof,
    custody: {
      applyExecutionProof: receipt(applyExecutionProof, "11111111-1111-4111-8111-111111111111"),
      applyPostStateObservation: receipt(
        applyPostStateObservation,
        "22222222-2222-4222-8222-222222222222"
      ),
      replayExecutionProof: receipt(replayExecutionProof, "33333333-3333-4333-8333-333333333333")
    }
  };
}

function dependencyRequest(chain) {
  return {
    buildProof: chain.buildProof,
    buildProofDigest: sha256Canonical(chain.buildProof),
    baselineManifestIdentityDigest: manifestIdentityDigest,
    baselineManifestDigest: manifestDigest,
    databaseIdentityDigest: databaseIdentityFingerprint,
    operationId: "658d8171-c0b7-41af-b012-859e423d37fd",
    input: ddlInput(chain)
  };
}

function dependencySummary(chain) {
  return {
    applyExecutionProofDigest: sha256Canonical(chain.applyExecutionProof),
    applyPostStateObservationDigest: sha256Canonical(chain.applyPostStateObservation),
    replayExecutionProofDigest: sha256Canonical(chain.replayExecutionProof),
    dmlPlanDigest,
    dmlOperationId: chain.applyExecutionProof.operationId
  };
}

function ddlInput(chain) {
  return {
    operationId: "658d8171-c0b7-41af-b012-859e423d37fd",
    attemptId: "7cf4f606-292c-41c6-9ab8-f02d9c61797a",
    runId: "38571b77-6332-44dc-b46a-80f90e0036cb",
    buildProofDigest: sha256Canonical(chain.buildProof),
    sourceSha,
    migrationCatalogDigest: chain.buildProof.identity.migrationCatalogDigest,
    repositoryContractDigest: chain.buildProof.identity.repositoryContractDigest,
    baselineManifestIdentityDigest: manifestIdentityDigest,
    baselineManifestDigest: manifestDigest,
    databaseIdentityFingerprint,
    postMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
    expectedSchemaDigest: digest("d"),
    dmlApplyExecutionProofDigest: sha256Canonical(chain.applyExecutionProof),
    dmlApplyPostStateObservationDigest: sha256Canonical(chain.applyPostStateObservation),
    dmlReplayExecutionProofDigest: sha256Canonical(chain.replayExecutionProof),
    generatedAt: "2026-09-02T10:15:00.000Z"
  };
}

function constraintContext(overrides = {}) {
  const calls = [];
  const state = {
    schema: "public",
    table: "subscription_closure_settlement_revision",
    tableOid: "16389",
    name: "subscription_closure_settlement_publication_check",
    constraintOid: "16394",
    definition: `${normalizedConstraintDefinition} NOT VALID`,
    convalidated: false,
    violationCount: 0,
    ...overrides
  };
  return {
    calls,
    state,
    statementLog: [],
    databaseIdentityFingerprint,
    grantedCapabilityProfiles: ["migrate"],
    async observePublicationConstraint() {
      calls.push("observe");
      return structuredClone(state);
    },
    async withPublicationConstraintLock(options, callback) {
      calls.push(`lock:${options.advisoryKey}`);
      calls.push(`timeout:${options.lockTimeoutMs}:${options.statementTimeoutMs}`);
      calls.push(`table-lock:${options.schema}.${options.table}:${options.tableLockMode}`);
      return callback();
    },
    async executePublicationConstraintValidation({ sql }) {
      calls.push(`ddl:${sql}`);
      this.statementLog.push(sql);
      state.convalidated = true;
    }
  };
}

function prismaConstraintContext() {
  const calls = [];
  const state = {
    tableOid: "16389",
    constraintOid: "16394",
    definition: `${normalizedConstraintDefinition} NOT VALID`,
    convalidated: false,
    violationCount: 0
  };
  const prisma = {
    async $transaction(callback) {
      calls.push({ type: "transaction" });
      return callback(prisma);
    },
    async $queryRawUnsafe(sql, ...parameters) {
      calls.push({ type: "query", sql, parameters });
      if (sql.includes("FROM pg_constraint")) {
        return [
          {
            schema: "public",
            table: "subscription_closure_settlement_revision",
            tableOid: state.tableOid,
            name: "subscription_closure_settlement_publication_check",
            constraintOid: state.constraintOid,
            definition: state.definition,
            convalidated: state.convalidated
          }
        ];
      }
      if (sql.includes('AS "violationCount"')) {
        return [{ violationCount: state.violationCount }];
      }
      if (sql.includes("pg_advisory_xact_lock")) return [{ locked: true }];
      assert.fail(`unexpected query: ${sql}`);
    },
    async $executeRawUnsafe(sql) {
      calls.push({ type: "execute", sql });
      if (sql.includes("VALIDATE CONSTRAINT")) {
        state.convalidated = true;
        state.definition = normalizedConstraintDefinition;
      }
      return 0;
    }
  };
  return {
    calls,
    state,
    prisma,
    statementLog: [],
    databaseIdentityFingerprint,
    grantedCapabilityProfiles: ["migrate"],
    now: () => new Date("2026-09-02T10:30:00.000Z")
  };
}
