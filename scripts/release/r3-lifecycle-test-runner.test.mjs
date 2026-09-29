import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("a lifecycle import failure terminates with originals while native handles remain open", async () => {
  const moduleUrl = new URL("./r3-lifecycle-test-runner.mjs", import.meta.url).href;
  // The intentionally incompatible execArgv causes Node's real test importer
  // to emit a failed placeholder with no file, before either fixed test runs.
  const source = `
    import { executeR3LifecycleSuite } from ${JSON.stringify(moduleUrl)};
    const abort = new AbortController();
    let expired = false;
    const nativeHandle = setInterval(() => {}, 1000);
    const deadline = setTimeout(() => { expired = true; abort.abort(); }, 2000);
    const names = ['provision','migrate','grantRuntimeAccess','runtimeRole','migrationOwnership','attemptRuntimeCreate','cleanup','countDatabase','siblingDatabase','countOwned'];
    const adapter = {runId:'fixture',target:{},policy:{},reservations:[],...Object.fromEntries(names.map(name=>[name,async()=>{throw new Error('must not run');}]))};
    executeR3LifecycleSuite({adapter,signal:abort.signal,recheck:async()=>{}}).then(
      () => {process.exitCode=2;},
      error => {process.stdout.write(JSON.stringify({code:error.code,expired,originals:error.originals})+'\\n');}
    ).finally(() => {clearInterval(nativeHandle); clearTimeout(deadline);});
  `;
  const result = await new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.NODE_OPTIONS;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: environment
    });
    let stdout = "",
      stderr = "";
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const failure = JSON.parse(result.stdout);
  assert.equal(failure.code, "R3_LIFECYCLE_SUITE_FAILED");
  assert.equal(failure.expired, false);
  assert.ok(
    failure.originals.testEvents.some(
      ({ type, data }) =>
        type === "test:fail" &&
        [data.details.error?.code, data.details.error?.cause?.code].includes(
          "ERR_INPUT_TYPE_NOT_ALLOWED"
        )
    )
  );
  assert.match(failure.originals.tap, /not ok/u);
});
