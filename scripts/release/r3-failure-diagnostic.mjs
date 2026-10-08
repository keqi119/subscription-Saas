// Diagnostic facts never grant execution, recovery, or success authority.
const stages = {
  H1_CALLER: ["INPUT", "ADMISSION", "LAUNCH", "DELIVERY", "CREATION", "EXECUTION", "CLEANUP"],
  HOSTED_CALLER: [
    "INPUT",
    "KEY",
    "DELIVERY",
    "CONTROL",
    "FORWARD",
    "CREATION",
    "EXECUTION",
    "CLEANUP"
  ],
  H1_CREATE: ["INPUT", "SESSION", "LEASE", "SOCKET", "SIGN", "CONSUME", "POST", "ACK", "ENGINE"],
  H1_CONSUME: [
    "SESSION",
    "REQUEST",
    "UNUSED",
    "ELIGIBILITY",
    "HISTORY",
    "CONTEXT",
    "AUTHORIZATION",
    "ISSUED",
    "ARCHIVE",
    "RECORD",
    "SLOT_CREATE",
    "JOURNAL",
    "READBACK",
    "EXECUTION",
    "FINAL_CONTEXT",
    "FINAL_AUTHORIZATION",
    "RECEIPT"
  ],
  HOSTED_CREATE: ["INPUT", "HEADERS", "BODY", "CURRENT_JOB", "ACK", "WORKSPACE", "ENGINE"],
  SSH_FORWARD: ["EXIT"]
};
const codes = new Set([
  "R3_SOURCE_FRESH_CALLER_INVALID",
  "R3_TARGET_CREATE_UNAVAILABLE",
  "R3_HOSTED_CREATION_CONTROL_INVALID",
  "R3_ENGINE_EXCHANGE_UNAVAILABLE",
  "R3_H1_FORWARD_LEASE_UNAVAILABLE",
  "R3_H1_EVIDENCE_DELIVERY_UNAVAILABLE",
  "R3_HOSTED_EVIDENCE_DELIVERY_UNAVAILABLE",
  "R3_OPERATION_INPUT_INVALID",
  "H1_INPUT_UNAVAILABLE",
  "MANUAL_SESSION_UNVERIFIED",
  "MANUAL_STORAGE_UNVERIFIED",
  "MANUAL_BINDING_MISMATCH",
  "MANUAL_EVIDENCE_BINDING_MISMATCH",
  "MANUAL_EVIDENCE_INPUT_REQUIRED",
  "MANUAL_AUTHORIZATION_CONSUMED",
  "R3_JOB_ADMISSION_UNAVAILABLE",
  "R3_HISTORY_CONTEXT_UNAVAILABLE",
  "MANUAL_TIME_INVALID",
  "MANUAL_SIGNATURE_INVALID",
  "MANUAL_REVOCATION_UNVERIFIED",
  "MANUAL_R3_INCIDENT_UNVERIFIED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "R3_CONNECTED_WINDOW_EXHAUSTED",
  "R3_CONNECTED_SOCKET_CLOSED",
  "R3_STARTUP_DEADLINE_INVALID",
  "R3_STARTUP_DEADLINE_EXCEEDED",
  "R3_STARTUP_CANCELLED",
  "R3_STARTUP_CHILD_CLOSE_UNAVAILABLE",
  "R3_STARTUP_CONNECTED_EVENT_MISSING",
  "ENOENT",
  "EACCES"
]);
const signals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SPAWN_ERROR"]);
const trusted = new WeakMap();
const transportCauses = new Set([
  "R3_POST_PRE_CLOSED",
  "R3_POST_TIMER",
  "R3_POST_REQUEST_ERROR",
  "R3_POST_RESPONSE_INCOMPLETE",
  "R3_CONNECTED_WINDOW_EXHAUSTED",
  "R3_CONNECTED_SOCKET_CLOSED"
]);
const trustedCause = new WeakMap();
const own = (value, key) => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
};
const code = (error) =>
  trustedCause.get(error) ?? (codes.has(own(error, "code")) ? own(error, "code") : "UNCLASSIFIED");

export function markR3FailureCause(error, causeCode) {
  if (!error || typeof error !== "object" || !transportCauses.has(causeCode))
    throw new TypeError("R3_DIAGNOSTIC_CAUSE_INVALID");
  if (!trustedCause.has(error)) trustedCause.set(error, causeCode);
  return error;
}

export function inheritR3FailureCause(error, cause) {
  const inherited = code(cause);
  if (inherited !== "UNCLASSIFIED" && !trustedCause.has(error)) trustedCause.set(error, inherited);
  return error;
}

export function getR3FailureDiagnostic(error) {
  return error && (typeof error === "object" || typeof error === "function")
    ? (trusted.get(error) ?? null)
    : null;
}

export async function closeR3FailureResources(tracker, primary, closers) {
  let cleanup = null;
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      cleanup ??= error;
    }
  }
  if (cleanup) {
    if (!primary) tracker.enter("CLEANUP");
    throw tracker.decorate(
      Object.assign(new Error("R3_SOURCE_FRESH_CALLER_INVALID"), {
        code: "R3_SOURCE_FRESH_CALLER_INVALID"
      }),
      primary ?? cleanup,
      cleanup
    );
  }
}

export function r3FailureTracker(component) {
  if (!Object.hasOwn(stages, component)) throw new TypeError("R3_DIAGNOSTIC_COMPONENT_INVALID");
  let stage = stages[component][0],
    completed = false;
  const tracker = {
    enter(next) {
      if (!stages[component].includes(next)) throw new TypeError("R3_DIAGNOSTIC_STAGE_INVALID");
      stage = next;
      completed = false;
    },
    complete() {
      completed = true;
    },
    async run(next, action) {
      tracker.enter(next);
      const value = await action();
      tracker.complete();
      return value;
    },
    decorate(error, cause, cleanup = null, ssh = null) {
      const nested = getR3FailureDiagnostic(cause);
      const exitCode = own(ssh, "code"),
        signal = own(ssh, "signal");
      const diagnostic = Object.freeze({
        ...(nested ?? {
          schemaVersion: "r3-failure-diagnostic.v1",
          component,
          stage,
          completed,
          causeCode: code(cause),
          cleanupCode: null,
          sshExitCode:
            Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
          sshSignal: signals.has(signal) ? signal : null
        }),
        ...(cleanup ? { cleanupCode: code(cleanup) } : {})
      });
      Object.defineProperty(error, "failureDiagnostic", {
        value: diagnostic,
        enumerable: true,
        configurable: true
      });
      trusted.set(error, diagnostic);
      return error;
    }
  };
  return tracker;
}
