// Passive, bounded startup evidence. These records never grant authority.
import { performance } from "node:perf_hooks";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const stages = new Set([
  "OWNER_SPEC",
  "IMPORT_SPEC",
  "IMPORT_SPEC_REOPEN",
  "IMPORT_SPEC_RECHECK",
  "IMPORT_PROFILE",
  "IMPORT_ARTIFACT_LIST",
  "IMPORT_ARTIFACT_ZIP",
  "IMPORT_ZIP_DECODE",
  "IMPORT_ADMISSION",
  "IMPORT_ADMISSION_RECHECK",
  "CALLER_ADMISSION",
  "NATIVE_HOSTED_IMPORT",
  "NATIVE_ADMISSION",
  "NATIVE_EVIDENCE_READY",
  "NATIVE_SESSION_OPEN",
  "NATIVE_LEASE_OPEN",
  "NATIVE_PRE_SIGN_CHECK",
  "NATIVE_GRAPH",
  "NATIVE_ATTEMPT_ALLOCATE",
  "NATIVE_REQUEST_PERSIST",
  "SIGN_OUTER_RECHECK",
  "SIGN_ACTIVE",
  "SIGN_REQUEST",
  "SIGN_HISTORY",
  "SIGN_CONTEXT",
  "SIGN_PERSIST"
]);
const MAX_RECORDS = 64;
const MAX_BYTES = 12288;
const MAX_LINE_BYTES = 1024;
let recordCount = 0;
let byteCount = 0;

function emit(operationRef, stage, event, durationMs) {
  try {
    if (!uuid.test(operationRef) || !stages.has(stage) || recordCount >= MAX_RECORDS) return;
    const line = `${JSON.stringify({
      brand: "R3_STARTUP_DETAIL_TIMING",
      operationRef,
      stage,
      event,
      at: new Date().toISOString(),
      durationMs
    })}\n`;
    const size = Buffer.byteLength(line);
    if (size > MAX_LINE_BYTES || size + byteCount > MAX_BYTES) return;
    recordCount++;
    byteCount += size;
    process.stderr.write(line);
  } catch {}
}

export function startR3StartupTiming(operationRef, stage) {
  const started = performance.now();
  const enabled = recordCount <= MAX_RECORDS - 2 && byteCount <= MAX_BYTES - 2 * MAX_LINE_BYTES;
  if (enabled) emit(operationRef, stage, "START", null);
  let ended = false;
  const end = (event) => {
    if (ended) return;
    ended = true;
    const durationMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, Math.floor(performance.now() - started))
    );
    if (enabled) emit(operationRef, stage, event, durationMs);
  };
  return Object.freeze({ succeeded: () => end("SUCCEEDED"), failed: () => end("FAILED") });
}

export async function runR3StartupTiming(operationRef, stage, action) {
  const timing = startR3StartupTiming(operationRef, stage);
  try {
    const result = await action();
    timing.succeeded();
    return result;
  } catch (error) {
    timing.failed();
    throw error;
  }
}
