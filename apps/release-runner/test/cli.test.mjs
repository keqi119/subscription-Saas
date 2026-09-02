import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

for (const argv of [["sh"], ["execute", "scripts/foo.mjs"], ["sql", "select 1"]]) {
  test(`rejects unsupported invocation ${argv.join(" ")}`, async () => {
    await assert.rejects(() => runCli(argv), { code: "RUNNER_COMMAND_NOT_REGISTERED" });
  });
}

test("accepts only execute command@version with a request file", async () => {
  const calls = [];
  const result = await runCli(["execute", "release.verify@1", "--request-file", "request.json"], {
    execute: async (input) => {
      calls.push(input);
      return { terminalStatus: "PASSED" };
    }
  });
  assert.equal(calls[0].commandKey, "release.verify@1");
  assert.equal(calls[0].requestFile, "request.json");
  assert.equal(result.terminalStatus, "PASSED");
});
