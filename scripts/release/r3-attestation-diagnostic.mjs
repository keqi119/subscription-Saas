import { performance } from "node:perf_hooks";

const kinds = new Set(["proof", "receipt", "current-admission", "historical-admission"]);
const childCodes = new Set([
  "ENOENT",
  "EACCES",
  "ETIMEDOUT",
  "ABORT_ERR",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
]);
const childSignals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function ownValue(value, name) {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, name)?.value;
  } catch {
    return undefined;
  }
}

function validateBinding(binding, action) {
  if (
    !binding ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    Reflect.ownKeys(binding).length !== 3 ||
    !["kind", "inputRawDigest", "operationRef"].every((key) => Object.hasOwn(binding, key)) ||
    typeof action !== "function"
  )
    throw new TypeError("R3_ATTESTATION_DIAGNOSTIC_INPUT_INVALID");
  const kind = ownValue(binding, "kind");
  const inputRawDigest = ownValue(binding, "inputRawDigest");
  const operationRef = ownValue(binding, "operationRef");
  if (
    !kinds.has(kind) ||
    typeof inputRawDigest !== "string" ||
    !digestPattern.test(inputRawDigest) ||
    !(
      operationRef === null ||
      (typeof operationRef === "string" && uuidPattern.test(operationRef))
    ) ||
    (kind.endsWith("admission") && operationRef === null)
  )
    throw new TypeError("R3_ATTESTATION_DIAGNOSTIC_INPUT_INVALID");
  return { kind, inputRawDigest, operationRef };
}

function safeChildCode(error) {
  const code = ownValue(error, "code");
  return (Number.isInteger(code) && code >= 0 && code <= 255) || childCodes.has(code) ? code : null;
}

function safeChildSignal(error) {
  const signal = ownValue(error, "signal");
  return childSignals.has(signal) ? signal : null;
}

export async function withR3AttestationDiagnostic(binding, action) {
  const safe = validateBinding(binding, action);
  const started = performance.now();
  try {
    return await action();
  } catch (error) {
    const diagnostic = {
      schemaVersion: "r3-attestation-failure.v1",
      kind: safe.kind,
      inputRawDigest: safe.inputRawDigest,
      operationRef: safe.operationRef,
      monotonicElapsedMs: Math.min(3600000, Math.max(0, Math.floor(performance.now() - started))),
      childCode: safeChildCode(error),
      childSignal: safeChildSignal(error)
    };
    try {
      process.stderr.write(`${JSON.stringify({ brand: "R3_ATTESTATION_FAILURE", diagnostic })}\n`);
    } catch {
      // Diagnostic output may fail; the original attestation error remains authoritative.
    }
    throw error;
  }
}
