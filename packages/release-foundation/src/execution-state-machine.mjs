import { canonicalJson } from "./canonical-json.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function executionError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function immutable(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function assertIdentity(state, event) {
  if (event.operationId !== state.operationId) {
    throw executionError("EXECUTION_OPERATION_MISMATCH");
  }
  if (event.idempotencyKey !== state.idempotencyKey) {
    throw executionError("EXECUTION_IDEMPOTENCY_KEY_MISMATCH");
  }
}

function assertAttemptAvailable(state, attemptId) {
  if (!uuidPattern.test(attemptId ?? "") || state.attemptIds.includes(attemptId)) {
    throw executionError("EXECUTION_ATTEMPT_INVALID");
  }
}

function transitionAllowed(state, allowed) {
  if (!allowed.includes(state.status)) {
    throw executionError("EXECUTION_TRANSITION_INVALID", {
      status: state.status,
      allowed
    });
  }
}

export function createExecutionState({ operationId, idempotencyKey }) {
  if (
    !uuidPattern.test(operationId ?? "") ||
    typeof idempotencyKey !== "string" ||
    !idempotencyKey
  ) {
    throw executionError("EXECUTION_IDENTITY_INVALID");
  }
  return immutable({
    schemaVersion: "execution-state.v1",
    operationId,
    idempotencyKey,
    status: "READY",
    terminalClass: null,
    approvedPlanDigest: null,
    predecessorProofDigest: null,
    commitState: "not-started",
    activeAttempt: null,
    attemptIds: []
  });
}

export function assertApplyAllowed({
  state,
  operationId,
  idempotencyKey,
  approvedPlanDigest,
  recomputedPlanDigest
}) {
  if (state.status === "INTERRUPTED_UNKNOWN") {
    throw executionError("UNKNOWN_REQUIRES_RECONCILE");
  }
  assertIdentity(state, { operationId, idempotencyKey });
  if (state.status !== "DRY_RUN_SUCCEEDED") {
    throw executionError("APPLY_REQUIRES_APPROVED_DRY_RUN");
  }
  if (
    !digestPattern.test(approvedPlanDigest ?? "") ||
    approvedPlanDigest !== state.approvedPlanDigest ||
    recomputedPlanDigest !== approvedPlanDigest
  ) {
    throw executionError("PLAN_CHANGED_SINCE_APPROVAL");
  }
}

export function transitionExecution(state, event) {
  if (state?.schemaVersion !== "execution-state.v1" || typeof event?.type !== "string") {
    throw executionError("EXECUTION_TRANSITION_INVALID");
  }
  switch (event.type) {
    case "PREFLIGHT_REJECTED": {
      transitionAllowed(state, ["READY"]);
      assertAttemptAvailable(state, event.attemptId);
      if (typeof event.phase !== "string" || typeof event.reasonCode !== "string") {
        throw executionError("EXECUTION_PREFLIGHT_RECORD_INVALID");
      }
      return immutable({
        ...state,
        status: "PREFLIGHT_REJECTED",
        terminalClass: "PREFLIGHT_REJECTED",
        commitState: "not-started",
        activeAttempt: {
          attemptId: event.attemptId,
          phase: event.phase,
          status: "PREFLIGHT_REJECTED",
          reasonCode: event.reasonCode
        },
        attemptIds: [...state.attemptIds, event.attemptId]
      });
    }
    case "DRY_RUN_SUCCEEDED": {
      transitionAllowed(state, ["READY"]);
      assertAttemptAvailable(state, event.attemptId);
      if (
        !digestPattern.test(event.planDigest ?? "") ||
        !digestPattern.test(event.proofDigest ?? "")
      ) {
        throw executionError("EXECUTION_PROOF_REFERENCE_INVALID");
      }
      return immutable({
        ...state,
        status: "DRY_RUN_SUCCEEDED",
        terminalClass: null,
        approvedPlanDigest: event.planDigest,
        predecessorProofDigest: event.proofDigest,
        commitState: "not-started",
        activeAttempt: {
          attemptId: event.attemptId,
          phase: "dry-run",
          status: "SUCCEEDED"
        },
        attemptIds: [...state.attemptIds, event.attemptId]
      });
    }
    case "APPLY_STARTED": {
      assertApplyAllowed({ state, ...event });
      assertAttemptAvailable(state, event.attemptId);
      return immutable({
        ...state,
        status: "APPLYING",
        terminalClass: null,
        commitState: "not-confirmed",
        activeAttempt: {
          attemptId: event.attemptId,
          phase: "apply",
          status: "RUNNING"
        },
        attemptIds: [...state.attemptIds, event.attemptId]
      });
    }
    case "APPLY_COMMITTED": {
      transitionAllowed(state, ["APPLYING"]);
      return immutable({
        ...state,
        status: "APPLY_COMMITTED_PENDING_PROOF",
        commitState: "committed",
        activeAttempt: { ...state.activeAttempt, status: "COMMITTED_PENDING_PROOF" }
      });
    }
    case "REPLAY_STARTED": {
      transitionAllowed(state, ["SUCCEEDED"]);
      assertIdentity(state, event);
      assertAttemptAvailable(state, event.attemptId);
      return immutable({
        ...state,
        status: "REPLAYING",
        terminalClass: null,
        commitState: "not-applicable",
        activeAttempt: {
          attemptId: event.attemptId,
          phase: "replay",
          status: "RUNNING"
        },
        attemptIds: [...state.attemptIds, event.attemptId]
      });
    }
    case "ATTEMPT_PROVED": {
      transitionAllowed(state, ["APPLY_COMMITTED_PENDING_PROOF", "REPLAYING"]);
      if (!digestPattern.test(event.proofDigest ?? "")) {
        throw executionError("EXECUTION_PROOF_REFERENCE_INVALID");
      }
      return immutable({
        ...state,
        status: "SUCCEEDED",
        terminalClass: "SUCCEEDED",
        predecessorProofDigest: event.proofDigest,
        commitState: state.activeAttempt.phase === "apply" ? "committed" : "not-applicable",
        activeAttempt: { ...state.activeAttempt, status: "SUCCEEDED" }
      });
    }
    case "PROCESS_LOST": {
      transitionAllowed(state, ["APPLYING", "APPLY_COMMITTED_PENDING_PROOF"]);
      if (event.commitState === "not-committed") {
        return immutable({
          ...state,
          status: "FAILED",
          terminalClass: "FAILED",
          commitState: "not-committed",
          activeAttempt: { ...state.activeAttempt, status: "FAILED" }
        });
      }
      if (!["unknown", "committed-result-unproved"].includes(event.commitState)) {
        throw executionError("EXECUTION_COMMIT_STATE_INVALID");
      }
      return immutable({
        ...state,
        status: "INTERRUPTED_UNKNOWN",
        terminalClass: "INTERRUPTED_UNKNOWN",
        commitState: event.commitState,
        activeAttempt: { ...state.activeAttempt, status: "INTERRUPTED_UNKNOWN" }
      });
    }
    case "RECONCILE_STARTED": {
      transitionAllowed(state, ["INTERRUPTED_UNKNOWN"]);
      assertIdentity(state, event);
      assertAttemptAvailable(state, event.attemptId);
      return immutable({
        ...state,
        status: "RECONCILING",
        terminalClass: null,
        activeAttempt: {
          attemptId: event.attemptId,
          phase: "reconcile",
          status: "RUNNING"
        },
        attemptIds: [...state.attemptIds, event.attemptId]
      });
    }
    case "RECONCILE_RESOLVED": {
      transitionAllowed(state, ["RECONCILING"]);
      if (
        !["committed", "not-committed"].includes(event.databaseOutcome) ||
        !digestPattern.test(event.proofDigest ?? "")
      ) {
        throw executionError("EXECUTION_RECONCILE_RESULT_INVALID");
      }
      const succeeded = event.databaseOutcome === "committed";
      return immutable({
        ...state,
        status: succeeded ? "SUCCEEDED" : "FAILED",
        terminalClass: succeeded ? "SUCCEEDED" : "FAILED",
        predecessorProofDigest: event.proofDigest,
        commitState: event.databaseOutcome,
        activeAttempt: {
          ...state.activeAttempt,
          status: succeeded ? "SUCCEEDED" : "FAILED"
        }
      });
    }
    case "ATTEMPT_FAILED": {
      transitionAllowed(state, ["APPLYING", "REPLAYING", "RECONCILING"]);
      if (state.commitState === "committed") {
        throw executionError("UNKNOWN_REQUIRES_RECONCILE");
      }
      return immutable({
        ...state,
        status: "FAILED",
        terminalClass: "FAILED",
        activeAttempt: { ...state.activeAttempt, status: "FAILED" }
      });
    }
    default:
      throw executionError("EXECUTION_TRANSITION_UNIMPLEMENTED", { event: event.type });
  }
}
