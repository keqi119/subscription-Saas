// Internal to the admitted R3 holder. Its caller owns authority, adapter callbacks,
// and private custody of the original test output.
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { fileURLToPath } from "node:url";

import { installR3LifecycleAdapter } from "../../packages/release-foundation/test/r3-lifecycle-adapter-slot.mjs";

const lifecycleFile = fileURLToPath(
  new URL(
    "../../packages/release-foundation/test/database-lifecycle.postgres.test.mjs",
    import.meta.url
  )
);
const expectedNames = [
  "provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
  "uses the platform package-manager entrypoint for lifecycle migrations"
];
const CODE = "R3_LIFECYCLE_SUITE_FAILED";
let invoked = false;

function failure(originals) {
  const error = Object.assign(new Error(CODE), { code: CODE });
  // Raw TAP and test events can include database diagnostics. The native holder
  // must archive these privately and keep the fixed error code in public logs.
  Object.defineProperty(error, "originals", { value: originals });
  return error;
}

function textOrNull(value) {
  return typeof value === "string" ? Buffer.from(value, "utf8").toString("utf8") : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorResult(error, depth = 0) {
  if (!error || typeof error !== "object") return null;
  return {
    name: textOrNull(error.name),
    code: textOrNull(error.code),
    message: textOrNull(error.message),
    stack: textOrNull(error.stack),
    cause: depth < 2 ? errorResult(error.cause, depth + 1) : null
  };
}

function testResult(type, data) {
  return {
    type,
    data: {
      name: textOrNull(data?.name),
      nesting: numberOrNull(data?.nesting),
      testNumber: numberOrNull(data?.testNumber),
      file: textOrNull(data?.file),
      line: numberOrNull(data?.line),
      column: numberOrNull(data?.column),
      details: {
        duration_ms: numberOrNull(data?.details?.duration_ms),
        type: textOrNull(data?.details?.type),
        error: errorResult(data?.details?.error)
      }
    }
  };
}

function summaryResult(data) {
  const counts = data?.counts;
  return {
    success: data?.success === true,
    duration_ms: numberOrNull(data?.duration_ms),
    counts: counts
      ? Object.fromEntries(
          ["tests", "failed", "passed", "cancelled", "skipped", "todo", "topLevel", "suites"].map(
            (key) => [key, numberOrNull(counts[key])]
          )
        )
      : null
  };
}

function exactResults(originals) {
  const counts = originals.counts;
  const results = originals.testEvents.filter(
    (event) => event.type === "test:pass" || event.type === "test:fail"
  );
  return (
    originals.summaries.length === 1 &&
    originals.summaries[0].success === true &&
    counts?.tests === 2 &&
    counts?.passed === 2 &&
    counts?.failed === 0 &&
    counts?.skipped === 0 &&
    counts?.cancelled === 0 &&
    counts?.todo === 0 &&
    counts?.topLevel === 2 &&
    counts?.suites === 0 &&
    results.length === 2 &&
    results.every(
      (event, index) =>
        event.type === "test:pass" &&
        event.data.name === expectedNames[index] &&
        event.data.file === lifecycleFile
    )
  );
}

export async function executeR3LifecycleSuite({ adapter, signal, recheck } = {}) {
  if (invoked) throw failure(undefined);
  invoked = true;

  const originals = { tap: "", counts: null, testEvents: [], summaries: [] };
  let revoke;
  let unlinkAbort;
  try {
    if (
      !signal ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function" ||
      signal.aborted ||
      typeof recheck !== "function"
    ) {
      throw failure(originals);
    }
    await recheck();
    if (signal.aborted) throw failure(originals);
    revoke = installR3LifecycleAdapter(adapter);

    // With in-process isolation, Node 22 defers the test summary until
    // beforeExit. The admitted holder keeps native sockets open. End the
    // runner after both fixed top-level tests have actually terminated; Node
    // then emits its own plan, summary and complete TAP while those sockets live.
    const runAbort = new AbortController();
    const forwardAbort = () => runAbort.abort();
    signal.addEventListener("abort", forwardAbort, { once: true });
    unlinkAbort = () => signal.removeEventListener("abort", forwardAbort);
    if (signal.aborted) runAbort.abort();

    const stream = run({
      files: [lifecycleFile],
      isolation: "none",
      concurrency: 1,
      signal: runAbort.signal
    });
    let terminalTopLevel = 0;
    for (const type of ["test:pass", "test:fail", "test:skip", "test:cancel"]) {
      stream.on(type, (data) => {
        originals.testEvents.push(testResult(type, data));
        if (data?.nesting === 0 && data?.file === lifecycleFile && ++terminalTopLevel === 2)
          runAbort.abort();
      });
    }
    stream.on("test:summary", (data) => {
      const summary = summaryResult(data);
      originals.summaries.push(summary);
      originals.counts = summary.counts;
    });
    for await (const chunk of stream.compose(tap)) originals.tap += chunk;

    await recheck();
    if (signal.aborted || !exactResults(originals)) throw failure(originals);
    return originals;
  } catch {
    throw failure(originals);
  } finally {
    unlinkAbort?.();
    revoke?.();
  }
}
