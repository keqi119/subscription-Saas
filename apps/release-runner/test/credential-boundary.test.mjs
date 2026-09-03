import assert from "node:assert/strict";
import test from "node:test";

import { createReadOnceCredentialReader } from "../src/credential-file.mjs";

test("reads a credential reference once and removes it before returning", async () => {
  const events = [];
  const reader = createReadOnceCredentialReader({
    allowedRoot: "C:/runner-secrets",
    readFile: async () => '{"username":"verify","password":"secret"}',
    unlink: async () => events.push("unlinked")
  });
  const credential = await reader("C:/runner-secrets/verify.json");
  assert.deepEqual(credential, { username: "verify", password: "secret" });
  assert.deepEqual(events, ["unlinked"]);
  await assert.rejects(() => reader("C:/runner-secrets/verify.json"), {
    code: "RUNNER_CREDENTIAL_ALREADY_READ"
  });
});

test("rejects credential references outside the launcher-owned root", async () => {
  const reader = createReadOnceCredentialReader({ allowedRoot: "C:/runner-secrets" });
  await assert.rejects(() => reader("C:/other/verify.json"), {
    code: "RUNNER_CREDENTIAL_REFERENCE_FORBIDDEN"
  });
});
