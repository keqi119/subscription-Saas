import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDedicatedLocalDatabase,
  parseStage1P0ClosureAccessArgs
} from "./stage1-p0-closure-access.mjs";

test("accepts exactly one dry-run/apply/cleanup mode", () => {
  assert.equal(parseStage1P0ClosureAccessArgs(["--dry-run"]), "dry-run");
  assert.equal(parseStage1P0ClosureAccessArgs(["--apply"]), "apply");
  assert.equal(parseStage1P0ClosureAccessArgs(["--cleanup"]), "cleanup");
  assert.throws(() => parseStage1P0ClosureAccessArgs([]));
  assert.throws(() => parseStage1P0ClosureAccessArgs(["--apply", "--cleanup"]));
});

test("fails closed outside a confirmed dedicated Local database", () => {
  assert.doesNotThrow(() =>
    assertDedicatedLocalDatabase(
      "postgresql://u:p@127.0.0.1:55432/subscription_saas_codex",
      "dry-run",
      {}
    )
  );
  assert.doesNotThrow(() =>
    assertDedicatedLocalDatabase(
      "postgresql://u:p@localhost:55432/subscription_saas_test",
      "apply",
      { STAGE1_P0_CLOSURE_ACCESS_CONFIRM: "SYNC_DEDICATED_LOCAL" }
    )
  );
  assert.throws(() =>
    assertDedicatedLocalDatabase("postgresql://u:p@db.prod.internal/prod", "dry-run", {})
  );
  assert.throws(() =>
    assertDedicatedLocalDatabase("postgresql://u:p@127.0.0.1/app", "dry-run", {})
  );
  assert.throws(() =>
    assertDedicatedLocalDatabase("postgresql://u:p@127.0.0.1/test", "cleanup", {})
  );
});
